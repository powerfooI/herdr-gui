import { describe, expect, test } from "bun:test";
import {
  prepareTerminalPasteText,
  terminalPasteInputText,
  terminalPasteRequest,
  type TerminalPasteTextareaSnapshot,
} from "./terminalPaste";

function snapshot(
  value: string,
  selectionStart = value.length,
  selectionEnd = selectionStart,
): TerminalPasteTextareaSnapshot {
  return { value, selectionStart, selectionEnd };
}

describe("terminal paste", () => {
  test("recovers full native paste text from xterm's helper textarea", () => {
    const text = `${"中英文😀".repeat(300)}\nsecond line`;
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: false },
        snapshot(""),
        text,
      ),
    ).toBe(text);
    expect(terminalPasteRequest("p7", text).params.text).toBe(
      text.replace("\n", "\r"),
    );
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: false },
        snapshot("previous"),
        "previouspasted",
      ),
    ).toBe("pasted");
  });

  test("extracts selection replacement without replaying surviving text", () => {
    const paste = { inputType: "insertFromPaste", isComposing: false };
    expect(terminalPasteInputText(paste, snapshot("abc", 1, 2), "aXc")).toBe(
      "X",
    );
    expect(terminalPasteInputText(paste, snapshot("abc", 0, 3), "XYZ")).toBe(
      "XYZ",
    );
    expect(terminalPasteInputText(paste, snapshot("abc", 1, 2), "abc")).toBe(
      "b",
    );
    expect(
      terminalPasteInputText(paste, snapshot("abc", 1, 1), "axc"),
    ).toBeNull();
  });

  test("ignores composing, unchanged collapsed, and non-paste input", () => {
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: true },
        snapshot(""),
        "text",
      ),
    ).toBeNull();
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: false },
        snapshot(""),
        "",
      ),
    ).toBeNull();
    expect(
      terminalPasteInputText(
        { inputType: "insertText", isComposing: false },
        snapshot(""),
        "text",
      ),
    ).toBeNull();
  });

  test("normalizes browser line endings like xterm", () => {
    expect(prepareTerminalPasteText("one\ntwo\r\nthree\rfour")).toBe(
      "one\rtwo\rthree\rfour",
    );
  });

  test("routes text through Herdr's mode-aware pane input API", () => {
    expect(terminalPasteRequest("p7", "if true\n  echo ok")).toEqual({
      method: "pane.send_input",
      params: {
        pane_id: "p7",
        text: "if true\r  echo ok",
        keys: [],
      },
    });
  });
});
