type TerminalPasteInputEvent = Pick<InputEvent, "inputType" | "isComposing">;

export type TerminalPasteTextareaSnapshot = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

/**
 * Recovers text inserted by WebKit's native paste path from xterm's helper
 * textarea. Selection-aware prefix/suffix matching avoids replaying text that
 * merely survived a replacement paste.
 */
export function terminalPasteInputText(
  input: TerminalPasteInputEvent,
  before: TerminalPasteTextareaSnapshot,
  textareaValue: string,
): string | null {
  if (input.isComposing || input.inputType !== "insertFromPaste") return null;
  if (
    before.selectionStart < 0 ||
    before.selectionEnd < before.selectionStart ||
    before.selectionEnd > before.value.length
  ) {
    return null;
  }
  if (
    before.selectionStart === before.selectionEnd &&
    textareaValue === before.value
  ) {
    return null;
  }

  const prefix = before.value.slice(0, before.selectionStart);
  const suffix = before.value.slice(before.selectionEnd);
  if (!textareaValue.startsWith(prefix) || !textareaValue.endsWith(suffix)) {
    return null;
  }
  const insertedEnd = textareaValue.length - suffix.length;
  if (insertedEnd < prefix.length) return null;
  return textareaValue.slice(prefix.length, insertedEnd) || null;
}

export function prepareTerminalPasteText(text: string) {
  // Match xterm's paste normalization while letting Herdr apply bracketed
  // paste from the authoritative PTY mode instead of the browser's stale copy.
  return text.replace(/\r?\n/g, "\r");
}

export function terminalPasteRequest(paneId: string, text: string) {
  return {
    method: "pane.send_input" as const,
    params: {
      pane_id: paneId,
      text: prepareTerminalPasteText(text),
      keys: [] as string[],
    },
  };
}
