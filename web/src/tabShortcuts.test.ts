import { describe, expect, test } from "bun:test";
import {
  adjacentTabId,
  closeShortcutTarget,
  tabShortcutAction,
} from "./tabShortcuts";

function keyEvent(
  overrides: Partial<Parameters<typeof tabShortcutAction>[0]> = {},
): Parameters<typeof tabShortcutAction>[0] {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("tab shortcuts", () => {
  test("recognizes the macOS tab management shortcuts", () => {
    expect(tabShortcutAction(keyEvent({ key: "t", metaKey: true }))).toBe(
      "create",
    );
    expect(tabShortcutAction(keyEvent({ key: "W", metaKey: true }))).toBe(
      "close",
    );
    expect(
      tabShortcutAction(
        keyEvent({ key: "ArrowLeft", metaKey: true, altKey: true }),
      ),
    ).toBe("previous");
    expect(
      tabShortcutAction(
        keyEvent({ key: "ArrowRight", metaKey: true, altKey: true }),
      ),
    ).toBe("next");
  });

  test("rejects extra or non-Command modifiers", () => {
    expect(
      tabShortcutAction(keyEvent({ key: "t", metaKey: true, shiftKey: true })),
    ).toBeNull();
    expect(tabShortcutAction(keyEvent({ key: "w", ctrlKey: true }))).toBeNull();
    expect(
      tabShortcutAction(
        keyEvent({ key: "ArrowLeft", metaKey: true, ctrlKey: true }),
      ),
    ).toBeNull();
  });
});

describe("close shortcut target", () => {
  const panes = [
    { pane_id: "one", tab_id: "split", focused: true },
    { pane_id: "two", tab_id: "split", focused: false },
    { pane_id: "other", tab_id: "single", focused: true },
  ];

  test("closes the selected pane rather than its split tab", () => {
    expect(closeShortcutTarget("split", panes, "two")).toEqual({
      type: "pane",
      id: "two",
    });
  });

  test("ignores stale selection from another tab and uses local focus", () => {
    expect(closeShortcutTarget("split", panes, "other")).toEqual({
      type: "pane",
      id: "one",
    });
    expect(closeShortcutTarget("split", panes, undefined)).toEqual({
      type: "pane",
      id: "one",
    });
  });

  test("falls back to a tab-local pane when focus is missing", () => {
    expect(
      closeShortcutTarget(
        "split",
        panes.map((pane) => ({ ...pane, focused: false })),
        undefined,
      ),
    ).toEqual({ type: "pane", id: "one" });
  });

  test("closes the tab when it has at most one pane", () => {
    expect(closeShortcutTarget("single", panes, "other")).toEqual({
      type: "tab",
      id: "single",
    });
    expect(closeShortcutTarget("empty", panes, undefined)).toEqual({
      type: "tab",
      id: "empty",
    });
  });

  test("does nothing without an active tab", () => {
    expect(closeShortcutTarget(undefined, panes, "one")).toBeNull();
  });
});

describe("adjacent tab selection", () => {
  const tabs = [
    { tab_id: "third", number: 3 },
    { tab_id: "first", number: 1 },
    { tab_id: "second", number: 2 },
  ];

  test("switches in tab number order and wraps", () => {
    expect(adjacentTabId(tabs, "first", "next")).toBe("second");
    expect(adjacentTabId(tabs, "third", "next")).toBe("first");
    expect(adjacentTabId(tabs, "first", "previous")).toBe("third");
  });

  test("uses a deterministic edge when the active tab is unknown", () => {
    expect(adjacentTabId(tabs, undefined, "next")).toBe("first");
    expect(adjacentTabId(tabs, "missing", "previous")).toBe("third");
    expect(adjacentTabId([], undefined, "next")).toBeNull();
  });
});
