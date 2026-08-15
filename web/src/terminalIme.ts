const EAST_ASIAN_PUNCTUATION_RE =
  /^(?:\p{P}|[\uff04\uff0b\uff1c-\uff1e\uff3e\uff40\uff5c\uff5e\uffe0-\uffe6])+$/u;
const RECENT_OUTPUT_LEAD_MS = 16;
const RECENT_OUTPUT_MAX_AGE_MS = 80;
const PENDING_XTERM_OUTPUT_MAX_AGE_MS = 24;

type ImeInputEvent = Pick<InputEvent, "data" | "inputType" | "isComposing">;

type TimedText = {
  text: string;
  at: number;
};

type PendingInput = TimedText & {
  id: number;
};

function isEastAsianPunctuation(text: string): boolean {
  const characters = Array.from(text);
  return (
    characters.length > 0 &&
    characters.length <= 8 &&
    characters.every((character) => (character.codePointAt(0) ?? 0) > 0x7f) &&
    EAST_ASIAN_PUNCTUATION_RE.test(text)
  );
}

/**
 * Returns only punctuation committed by an IME outside an active composition.
 * Chinese text and normal ASCII keys stay entirely under xterm's control.
 */
export function terminalImeFallbackText(input: ImeInputEvent): string | null {
  if (input.isComposing || !input.data) return null;
  if (
    input.inputType &&
    input.inputType !== "insertText" &&
    input.inputType !== "insertCompositionText" &&
    input.inputType !== "insertFromComposition"
  ) {
    return null;
  }

  return isEastAsianPunctuation(input.data) ? input.data : null;
}

/**
 * Returns append-only text committed to xterm's helper textarea. Replacement
 * and deletion remain under xterm's control because replaying them here could
 * race its own keyCode 229 fallback and duplicate destructive input.
 */
export function terminalImeTextareaDelta(
	before: string,
	after: string,
): string | null {
	if (after === before || !after.startsWith(before)) return null;
	return after.slice(before.length) || null;
}

/**
 * Tracks one iOS keyCode 229 cycle and subtracts any prefix xterm already
 * emitted. A synchronous flush catches short-lived keyup/input mutations; an
 * unchanged cycle stays pending for one final timer fallback.
 */
export type TerminalImeTextareaFlushResult =
	| { status: "pending" }
	| { status: "unhandled" }
	| { status: "handled"; text: string | null };

export class TerminalImeTextareaFallbackTracker {
	private pending: { textareaValue: string; xtermData: string } | null = null;
	private suppressXtermData = "";

	begin(textareaValue: string): void {
		this.pending ??= { textareaValue, xtermData: "" };
	}

	recordXtermData(text: string): string | null {
		if (this.pending) this.pending.xtermData += text;
		if (!this.suppressXtermData) return text;

		if (this.suppressXtermData.startsWith(text)) {
			this.suppressXtermData = this.suppressXtermData.slice(text.length);
			return null;
		}
		if (text.startsWith(this.suppressXtermData)) {
			const unsuppressedText = text.slice(this.suppressXtermData.length);
			this.suppressXtermData = "";
			return unsuppressedText || null;
		}

		this.suppressXtermData = "";
		return text;
	}

	flush(textareaValue: string, final = false): TerminalImeTextareaFlushResult {
		const pending = this.pending;
		if (!pending) return { status: "unhandled" };
		const committedText = terminalImeTextareaDelta(
			pending.textareaValue,
			textareaValue,
		);
		if (!committedText) {
			if (final || textareaValue !== pending.textareaValue) {
				this.pending = null;
				return { status: "unhandled" };
			}
			return { status: "pending" };
		}

		this.pending = null;
		if (!committedText.startsWith(pending.xtermData)) {
			return { status: "unhandled" };
		}
		this.suppressXtermData = committedText;
		return {
			status: "handled",
			text: committedText.slice(pending.xtermData.length) || null,
		};
	}

	hasPending(): boolean {
		return this.pending !== null;
	}

	cancelPending(): void {
		this.pending = null;
	}

	complete(): void {
		this.pending = null;
		this.suppressXtermData = "";
	}

	cancel(): void {
		this.complete();
	}
}

/**
 * DOM event timestamps share performance.now()'s clock in modern browsers.
 * Fall back to observation time for older Safari timestamps that used epoch
 * milliseconds, as those cannot be compared with xterm's performance time.
 */
export function terminalImeEventTime(
  event: Pick<Event, "timeStamp">,
  observedAt: number,
): number {
  const eventAt = event.timeStamp;
  return Number.isFinite(eventAt) &&
    eventAt >= 0 &&
    eventAt <= observedAt + 1_000 &&
    observedAt - eventAt <= 60_000
    ? eventAt
    : observedAt;
}

/**
 * Routes missing IME punctuation immediately, then suppresses a matching
 * asynchronous xterm emission. Consumable records keep repeated punctuation
 * independent and preserve input order during rapid typing.
 */
export class TerminalImeFallbackTracker {
  private nextId = 1;
  private readonly pendingXtermOutput = new Map<number, PendingInput>();
  private readonly recentOutput: TimedText[] = [];

  recordInput(text: string, eventAt: number, observedAt = eventAt): boolean {
    this.prune(observedAt);
    const outputIndex = this.recentOutput.findIndex(
      (output) =>
        output.text === text &&
        output.at >= eventAt &&
        output.at <= observedAt &&
        output.at - eventAt <= RECENT_OUTPUT_LEAD_MS,
    );
    if (outputIndex >= 0) {
      this.recentOutput.splice(outputIndex, 1);
      return false;
    }

    const id = this.nextId++;
    this.pendingXtermOutput.set(id, { id, text, at: eventAt });
    return true;
  }

  recordXtermData(text: string, at: number): boolean {
    this.prune(at);
    const pending = Array.from(this.pendingXtermOutput.values()).find(
      (input) =>
        input.text === text &&
        input.at <= at &&
        at - input.at <= PENDING_XTERM_OUTPUT_MAX_AGE_MS,
    );
    if (pending) {
      this.pendingXtermOutput.delete(pending.id);
      return false;
    }
    this.recentOutput.push({ text, at });
    return true;
  }

  dispose(): void {
    this.pendingXtermOutput.clear();
    this.recentOutput.length = 0;
  }

  private prune(now: number): void {
    while (
      this.recentOutput[0] &&
      now - this.recentOutput[0].at > RECENT_OUTPUT_MAX_AGE_MS
    ) {
      this.recentOutput.shift();
    }
    for (const [id, input] of this.pendingXtermOutput) {
      if (now - input.at > PENDING_XTERM_OUTPUT_MAX_AGE_MS) {
        this.pendingXtermOutput.delete(id);
      }
    }
  }
}
