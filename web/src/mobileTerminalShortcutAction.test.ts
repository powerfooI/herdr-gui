import { describe, expect, test } from "bun:test";
import { mobileTerminalShortcutExecution } from "./mobileTerminalShortcutAction";

describe("mobile terminal shortcut execution", () => {
  test("sends ordinary configured keys as terminal input", () => {
    expect(mobileTerminalShortcutExecution("ctrl-c")).toEqual({
      type: "input",
      bytes: [0x03],
    });
    expect(mobileTerminalShortcutExecution("alt-up")).toEqual({
      type: "input",
      bytes: [0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41],
    });
  });

  test("routes page actions to full or half scrollback", () => {
    expect(mobileTerminalShortcutExecution("page-up")).toEqual({
      type: "scroll",
      direction: "up",
      amount: "full",
    });
    expect(mobileTerminalShortcutExecution("page-down")).toEqual({
      type: "scroll",
      direction: "down",
      amount: "full",
    });
    expect(mobileTerminalShortcutExecution("alt-page-up")).toEqual({
      type: "scroll",
      direction: "up",
      amount: "half",
    });
    expect(mobileTerminalShortcutExecution("alt-page-down")).toEqual({
      type: "scroll",
      direction: "down",
      amount: "half",
    });
  });
});
