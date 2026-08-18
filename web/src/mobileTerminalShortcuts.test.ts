import { describe, expect, test } from "bun:test";
import {
  MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW,
  defaultMobileTerminalShortcutRows,
  defaultMobileTerminalSideShortcuts,
  mobileTerminalShortcutBytes,
  mobileTerminalShortcutCount,
  mobileTerminalShortcutScroll,
  normalizeMobileTerminalShortcutRows,
  parseMobileTerminalShortcutRows,
  parseMobileTerminalSideShortcuts,
  serializeMobileTerminalShortcutRows,
  serializeMobileTerminalSideShortcuts,
} from "./mobileTerminalShortcuts";

describe("mobile terminal shortcuts", () => {
  test("uses the terminal controls across at most two aligned default rows", () => {
    const rows = defaultMobileTerminalShortcutRows();

    expect(rows).toHaveLength(2);
    expect(MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW).toBe(8);
    expect(
      rows.map((row) => row.map((shortcut) => shortcut?.action ?? null)),
    ).toEqual([
      ["ctrl-c", "ctrl-d", "ctrl-r", "escape", "page-up", null, null, null],
      ["tab", "enter", "alt-up", "page-down", null, null, null, null],
    ]);
    expect(
      rows.every((row) => row.length <= MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW),
    ).toBe(true);
  });

  test("normalizes untrusted stored rows, labels, actions, and ids", () => {
    const rows = normalizeMobileTerminalShortcutRows([
      [
        { id: "same", label: "  Interrupt  ", action: "ctrl-c" },
        { id: "same", label: "😀😀😀😀😀😀😀😀😀😀😀", action: "enter" },
        { id: "bad id", label: "Ignored", action: "not-a-key" },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `extra-${index}`,
          label: "Esc",
          action: "escape",
        })),
      ],
      [{ id: "up", label: "", action: "arrow-up" }],
      [{ id: "third", label: "Third", action: "tab" }],
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW);
    expect(rows[0][0]).toEqual({
      id: "same",
      label: "Interrupt",
      action: "ctrl-c",
    });
    expect(rows[0][1]?.id).toBe("same-2");
    expect(Array.from(rows[0][1]?.label ?? "")).toHaveLength(10);
    expect(rows[1]).toEqual([
      { id: "up", label: "Up", action: "arrow-up" },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("migrates legacy compact rows past invalid entries", () => {
    const rows = normalizeMobileTerminalShortcutRows([
      [
        { id: "first", label: "First", action: "ctrl-a" },
        { id: "invalid", label: "Invalid", action: "unknown" },
        { id: "second", label: "Second", action: "ctrl-b" },
      ],
      [],
    ]);

    expect(rows[0][0]?.id).toBe("first");
    expect(rows[0][1]?.id).toBe("second");
    expect(rows[0][2]).toBeNull();
  });

  test("preserves empty slots instead of compacting later buttons", () => {
    const rows = normalizeMobileTerminalShortcutRows([
      [null, null, { id: "third", label: "Home", action: "home" }],
      [null, { id: "second", label: "End", action: "end" }],
    ]);

    expect(rows[0][0]).toBeNull();
    expect(rows[0][2]?.action).toBe("home");
    expect(rows[1][1]?.action).toBe("end");
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(rows),
      ),
    ).toEqual(rows);
  });

  test("preserves four optional side shortcut slots", () => {
    const shortcuts = parseMobileTerminalSideShortcuts(
      JSON.stringify([
        null,
        { id: "side-two", label: " Half ", action: "alt-page-up" },
        { id: "invalid", label: "No", action: "unknown" },
        { id: "side-four", label: "End", action: "end" },
        { id: "ignored", label: "Esc", action: "escape" },
      ]),
    );

    expect(defaultMobileTerminalSideShortcuts()).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(shortcuts).toEqual([
      null,
      { id: "side-two", label: "Half", action: "alt-page-up" },
      null,
      { id: "side-four", label: "End", action: "end" },
    ]);
    expect(
      parseMobileTerminalSideShortcuts(
        serializeMobileTerminalSideShortcuts(shortcuts),
      ),
    ).toEqual(shortcuts);
    expect(parseMobileTerminalSideShortcuts("bad json")).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("allows users to clear all panel slots", () => {
    const empty = normalizeMobileTerminalShortcutRows([[], []]);

    expect(mobileTerminalShortcutCount(empty)).toBe(0);
    expect(
      parseMobileTerminalShortcutRows(
        serializeMobileTerminalShortcutRows(empty),
      ),
    ).toEqual(empty);
  });

  test("falls back safely for missing or malformed storage", () => {
    const expected = defaultMobileTerminalShortcutRows();

    expect(parseMobileTerminalShortcutRows(null)).toEqual(expected);
    expect(parseMobileTerminalShortcutRows("not json")).toEqual(expected);
  });

  test("round-trips normalized rows without sharing mutable defaults", () => {
    const first = defaultMobileTerminalShortcutRows();
    first[0][0]!.label = "Changed";
    expect(defaultMobileTerminalShortcutRows()[0][0]?.label).toBe("C-c");

    const encoded = serializeMobileTerminalShortcutRows(first);
    const parsed = parseMobileTerminalShortcutRows(encoded);
    expect(parsed[0][0]?.label).toBe("Changed");
    expect(mobileTerminalShortcutCount(parsed)).toBe(9);
  });

  test("encodes control, navigation, and modified keys", () => {
    expect(mobileTerminalShortcutBytes("ctrl-c")).toEqual([0x03]);
    expect(mobileTerminalShortcutBytes("page-up")).toEqual([]);
    expect(mobileTerminalShortcutBytes("page-down")).toEqual([]);
    expect(mobileTerminalShortcutBytes("alt-up")).toEqual([
      0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41,
    ]);
    expect(mobileTerminalShortcutBytes("alt-page-up")).toEqual([]);
    expect(mobileTerminalShortcutBytes("alt-page-down")).toEqual([]);
    expect(mobileTerminalShortcutBytes("shift-enter")).toEqual([
      0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75,
    ]);
  });

  test("routes page actions to scrollback instead of terminal input", () => {
    expect(mobileTerminalShortcutScroll("page-up")).toEqual({
      direction: "up",
      amount: "full",
    });
    expect(mobileTerminalShortcutScroll("page-down")).toEqual({
      direction: "down",
      amount: "full",
    });
    expect(mobileTerminalShortcutScroll("alt-page-up")).toEqual({
      direction: "up",
      amount: "half",
    });
    expect(mobileTerminalShortcutScroll("alt-page-down")).toEqual({
      direction: "down",
      amount: "half",
    });
    expect(mobileTerminalShortcutScroll("arrow-up")).toBeNull();
  });
});
