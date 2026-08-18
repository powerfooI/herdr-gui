import { describe, expect, test } from "bun:test";
import {
  terminalImeEventTime,
  terminalImeFallbackText,
  TerminalImeFallbackTracker,
  TerminalImeTextareaFallbackTracker,
  terminalImeTextareaDelta,
} from "./terminalIme";

function inputEvent(
  data: string,
  overrides: Partial<Parameters<typeof terminalImeFallbackText>[0]> = {},
): Parameters<typeof terminalImeFallbackText>[0] {
  return {
    data,
    inputType: "insertText",
    isComposing: false,
    ...overrides,
  };
}

describe("terminal IME punctuation detection", () => {
  test("accepts common full-width punctuation", () => {
    for (const text of [
      "，",
      "。",
      "？",
      "！",
      "：",
      "；",
      "（）",
      "“”",
      "、",
      "～",
      "￥",
    ]) {
      expect(terminalImeFallbackText(inputEvent(text))).toBe(text);
    }
  });

  test("leaves text, ASCII keys, paste, and active composition to xterm", () => {
    expect(terminalImeFallbackText(inputEvent("中文"))).toBeNull();
    expect(terminalImeFallbackText(inputEvent(","))).toBeNull();
    expect(
      terminalImeFallbackText(inputEvent("，", { isComposing: true })),
    ).toBeNull();
    expect(
      terminalImeFallbackText(
        inputEvent("，", { inputType: "insertFromPaste" }),
      ),
    ).toBeNull();
  });

  test("uses comparable DOM timestamps and rejects legacy epoch timestamps", () => {
    expect(terminalImeEventTime({ timeStamp: 95 }, 100)).toBe(95);
    expect(terminalImeEventTime({ timeStamp: 1_800_000_000_000 }, 100)).toBe(
      100,
    );
  });
});

describe("terminal IME textarea fallback", () => {
  test("extracts append-only ASCII, Chinese, and emoji text", () => {
    expect(terminalImeTextareaDelta("", "hello")).toBe("hello");
    expect(terminalImeTextareaDelta("已有", "已有中文")).toBe("中文");
    expect(terminalImeTextareaDelta("a", "a😀")).toBe("😀");
  });

  test("leaves replacement and deletion changes to xterm", () => {
    expect(terminalImeTextareaDelta("same", "same")).toBeNull();
    expect(terminalImeTextareaDelta("abc", "axc")).toBeNull();
    expect(terminalImeTextareaDelta("abc", "ab")).toBeNull();
  });

  test("flushes a short-lived mutation synchronously", () => {
    const tracker = new TerminalImeTextareaFallbackTracker();
    tracker.begin("");
    expect(tracker.flush("中文输入")).toEqual({
      status: "handled",
      text: "中文输入",
    });
    expect(tracker.hasPending()).toBe(false);
  });

  test("keeps an unchanged keyup pending for the timer fallback", () => {
    const tracker = new TerminalImeTextareaFallbackTracker();
    tracker.begin("");
    expect(tracker.flush("")).toEqual({ status: "pending" });
    expect(tracker.hasPending()).toBe(true);
    expect(tracker.flush("稍后写入", true)).toEqual({
      status: "handled",
      text: "稍后写入",
    });
  });

  test("distinguishes xterm-handled input from an unhandled cycle", () => {
    const tracker = new TerminalImeTextareaFallbackTracker();
    tracker.begin("hello");
    expect(tracker.recordXtermData(" world")).toBe(" world");
    expect(tracker.flush("hello world")).toEqual({
      status: "handled",
      text: null,
    });
    expect(tracker.flush("hello world", true)).toEqual({
      status: "unhandled",
    });
  });

  test("subtracts text xterm already emitted", () => {
    const tracker = new TerminalImeTextareaFallbackTracker();
    tracker.begin("hello");
    expect(tracker.recordXtermData(" ")).toBe(" ");
    expect(tracker.flush("hello world")).toEqual({
      status: "handled",
      text: "world",
    });

    tracker.complete();
    tracker.begin("a");
    expect(tracker.recordXtermData("😀b")).toBe("😀b");
    expect(tracker.flush("a😀b")).toEqual({
      status: "handled",
      text: null,
    });
  });

  test("suppresses partial or delayed xterm output after a synchronous flush", () => {
    const tracker = new TerminalImeTextareaFallbackTracker();
    tracker.begin("");
    expect(tracker.flush("中文")).toEqual({
      status: "handled",
      text: "中文",
    });
    expect(tracker.recordXtermData("中")).toBeNull();
    expect(tracker.recordXtermData("文")).toBeNull();

    tracker.complete();
    tracker.begin("");
    expect(tracker.flush("abc")).toEqual({
      status: "handled",
      text: "abc",
    });
    expect(tracker.recordXtermData("abc-extra")).toBe("-extra");
    tracker.complete();
    expect(tracker.recordXtermData("abc")).toBe("abc");
  });

  test("cancels an abandoned cycle without clearing duplicate suppression", () => {
    const tracker = new TerminalImeTextareaFallbackTracker();
    tracker.begin("");
    tracker.cancelPending();
    expect(tracker.recordXtermData("a")).toBe("a");
    expect(tracker.flush("abc", true)).toEqual({ status: "unhandled" });

    tracker.begin("");
    expect(tracker.flush("中文")).toEqual({
      status: "handled",
      text: "中文",
    });
    tracker.cancelPending();
    expect(tracker.recordXtermData("中")).toBeNull();
  });

  test("keeps the earliest repeated baseline and supports cancel", () => {
    const tracker = new TerminalImeTextareaFallbackTracker();
    tracker.begin("");
    tracker.begin("中");
    expect(tracker.flush("中文")).toEqual({
      status: "handled",
      text: "中文",
    });

    tracker.begin("中文");
    tracker.cancel();
    expect(tracker.flush("中文输入", true)).toEqual({
      status: "unhandled",
    });
  });
});

describe("terminal IME punctuation fallback tracking", () => {
  test("consumes xterm output emitted immediately before the input listener", () => {
    const tracker = new TerminalImeFallbackTracker();
    expect(tracker.recordXtermData("，", 105)).toBe(true);
    expect(tracker.recordInput("，", 100, 106)).toBe(false);
  });

  test("does not consume output from the preceding keyboard event", () => {
    const tracker = new TerminalImeFallbackTracker();
    tracker.recordXtermData("，", 100);
    expect(tracker.recordInput("，", 104, 106)).toBe(true);
  });

  test("suppresses delayed xterm output after an immediate fallback", () => {
    const tracker = new TerminalImeFallbackTracker();
    expect(tracker.recordInput("。", 100)).toBe(true);
    expect(tracker.recordXtermData("。", 102)).toBe(false);
  });

  test("keeps every rapid repeated input while suppressing delayed duplicates", () => {
    const tracker = new TerminalImeFallbackTracker();
    expect(tracker.recordInput("，", 100)).toBe(true);
    expect(tracker.recordInput("，", 104)).toBe(true);
    expect(tracker.recordXtermData("，", 106)).toBe(false);
    expect(tracker.recordXtermData("，", 108)).toBe(false);
  });

  test("does not let different rapid punctuation suppress each other", () => {
    const tracker = new TerminalImeFallbackTracker();
    expect(tracker.recordInput("，", 100)).toBe(true);
    expect(tracker.recordInput("。", 103)).toBe(true);
    expect(tracker.recordXtermData("。", 105)).toBe(false);
    expect(tracker.recordXtermData("，", 106)).toBe(false);
  });

  test("does not suppress unrelated xterm data after the duplicate window", () => {
    const tracker = new TerminalImeFallbackTracker();
    expect(tracker.recordInput("，", 100)).toBe(true);
    expect(tracker.recordXtermData("，", 130)).toBe(true);
  });

  test("preserves order when xterm drops or delays part of a rapid sequence", () => {
    const tracker = new TerminalImeFallbackTracker();
    const sent: string[] = [];
    const input = (
      text: string,
      eventAt: number,
      mode: "before" | "after" | "missing",
    ) => {
      if (mode === "before" && tracker.recordXtermData(text, eventAt + 1)) {
        sent.push(text);
      }
      if (tracker.recordInput(text, eventAt, eventAt + 2)) sent.push(text);
      if (mode === "after" && tracker.recordXtermData(text, eventAt + 3)) {
        sent.push(text);
      }
    };

    input("，", 100, "missing");
    input("。", 110, "before");
    input("？", 120, "after");
    input("！", 130, "missing");

    expect(sent.join("")).toBe("，。？！");
  });
});
