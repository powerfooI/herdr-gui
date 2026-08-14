/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  commandFilter,
  commandNumberedActions,
  commandNumberShortcutIndex,
  commandNumberShortcutTarget,
  commandPathQuery,
  normalizeSearchText,
  runCommandNumberShortcut,
} from "./CommandCombobox";

describe("command combobox search helpers", () => {
  test("normalizes punctuation and spacing", () => {
    expect(normalizeSearchText("Open-Diff_Viewer:/Repo")).toBe(
      "open diff viewer repo",
    );
  });

  test("uses keywords to rank synonym searches", () => {
    const workspaceScore = commandFilter(
      "Create workspace Open a new Herdr workspace",
      "new workspace",
      ["new workspace", "add workspace"],
    );
    const tabScore = commandFilter("Create tab current repo", "new workspace", [
      "new tab",
    ]);
    expect(workspaceScore).toBeGreaterThan(tabScore);
    expect(workspaceScore).toBeGreaterThan(0);
  });

  test("detects direct file path queries without treating words as paths", () => {
    expect(commandPathQuery("docs/guides/runtime.md")).toBe(
      "docs/guides/runtime.md",
    );
    expect(commandPathQuery("./README.md")).toBe("README.md");
    expect(commandPathQuery("new workspace")).toBe("");
    expect(commandPathQuery("README")).toBe("");
  });

  test("maps Command-number-row shortcuts across keyboard layouts", () => {
    const event = {
      altKey: false,
      code: "Digit4",
      ctrlKey: false,
      key: "4",
      metaKey: true,
      shiftKey: false,
    };
    expect(commandNumberShortcutIndex(event)).toBe(3);
    expect(
      commandNumberShortcutIndex({ ...event, code: "Digit1", key: "&" }),
    ).toBe(0);
    expect(commandNumberShortcutIndex({ ...event, metaKey: false })).toBeNull();
    expect(commandNumberShortcutIndex({ ...event, ctrlKey: true })).toBeNull();
    expect(commandNumberShortcutIndex({ ...event, altKey: true })).toBeNull();
    expect(commandNumberShortcutIndex({ ...event, shiftKey: true })).toBeNull();
    expect(
      commandNumberShortcutIndex({ ...event, code: "Digit0", key: "0" }),
    ).toBeNull();
  });

  test("numbers the first nine actions in visible group order", () => {
    const groups = [
      { actions: ["top-1", "top-2"] },
      {
        actions: Array.from({ length: 10 }, (_, index) => `group-${index + 1}`),
      },
    ];
    expect(commandNumberedActions(groups)).toEqual([
      "top-1",
      "top-2",
      "group-1",
      "group-2",
      "group-3",
      "group-4",
      "group-5",
      "group-6",
      "group-7",
    ]);
  });

  test("selects the matching displayed action without wrapping", () => {
    const event = {
      altKey: false,
      code: "Digit2",
      ctrlKey: false,
      key: "2",
      metaKey: true,
      shiftKey: false,
    };
    expect(commandNumberShortcutTarget(event, ["first", "second"])).toBe(
      "second",
    );
    expect(
      commandNumberShortcutTarget({ ...event, code: "Digit3", key: "3" }, [
        "first",
        "second",
      ]),
    ).toBeNull();
  });

  test("runs a recognized shortcut once and consumes only that event", () => {
    let preventDefaultCalls = 0;
    let stopPropagationCalls = 0;
    const runs: string[] = [];
    const event = {
      altKey: false,
      code: "Digit2",
      ctrlKey: false,
      key: "é",
      metaKey: true,
      preventDefault: () => {
        preventDefaultCalls += 1;
      },
      repeat: false,
      shiftKey: false,
      stopPropagation: () => {
        stopPropagationCalls += 1;
      },
    };

    expect(
      runCommandNumberShortcut(event, ["first", "second"], (action) =>
        runs.push(action),
      ),
    ).toBe(true);
    expect(runs).toEqual(["second"]);
    expect(preventDefaultCalls).toBe(1);
    expect(stopPropagationCalls).toBe(1);

    expect(
      runCommandNumberShortcut(
        { ...event, code: "Digit1", repeat: true },
        ["first"],
        (action) => runs.push(action),
      ),
    ).toBe(false);
    expect(
      runCommandNumberShortcut(
        { ...event, code: "Digit3", key: "3" },
        ["first", "second"],
        (action) => runs.push(action),
      ),
    ).toBe(false);
    expect(runs).toEqual(["second"]);
    expect(preventDefaultCalls).toBe(1);
    expect(stopPropagationCalls).toBe(1);
  });
});
