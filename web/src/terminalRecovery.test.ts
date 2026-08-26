import { describe, expect, test } from "bun:test";
import {
  readTerminalRecoveryReloadAt,
  shouldArmTerminalRecoveryResume,
  shouldReloadTerminalAfterResume,
  TERMINAL_RECOVERY_MIN_HIDDEN_MS,
  TERMINAL_RECOVERY_RELOAD_MIN_INTERVAL_MS,
  TERMINAL_RECOVERY_RESUME_WINDOW_MS,
  writeTerminalRecoveryReloadAt,
} from "./terminalRecovery";

describe("shouldReloadTerminalAfterResume", () => {
  test("never reloads when the page was not resumed from hidden", () => {
    expect(
      shouldReloadTerminalAfterResume({
        now: 100_000,
        resumedAt: null,
        lastReloadAt: null,
      }),
    ).toBe(false);
  });

  test("reloads when the failure follows a recent resume", () => {
    expect(
      shouldReloadTerminalAfterResume({
        now: 100_000,
        resumedAt: 100_000 - TERMINAL_RECOVERY_RESUME_WINDOW_MS,
        lastReloadAt: null,
      }),
    ).toBe(true);
  });

  test("does not reload long after the resume", () => {
    expect(
      shouldReloadTerminalAfterResume({
        now: 100_000,
        resumedAt: 100_000 - TERMINAL_RECOVERY_RESUME_WINDOW_MS - 1,
        lastReloadAt: null,
      }),
    ).toBe(false);
  });

  test("rate-limits consecutive automatic reloads", () => {
    expect(
      shouldReloadTerminalAfterResume({
        now: 100_000,
        resumedAt: 90_000,
        lastReloadAt:
          100_000 - TERMINAL_RECOVERY_RELOAD_MIN_INTERVAL_MS + 1_000,
      }),
    ).toBe(false);
    expect(
      shouldReloadTerminalAfterResume({
        now: 100_000,
        resumedAt: 90_000,
        lastReloadAt: 100_000 - TERMINAL_RECOVERY_RELOAD_MIN_INTERVAL_MS,
      }),
    ).toBe(true);
  });
});

describe("shouldArmTerminalRecoveryResume", () => {
  test("arms when the hidden event was never observed", () => {
    // Some platforms freeze the page without dispatching visibilitychange;
    // the lock-screen resume must stay armed in that case.
    expect(
      shouldArmTerminalRecoveryResume({ now: 100_000, hiddenAt: null }),
    ).toBe(true);
  });

  test("does not arm after a measured short tab switch", () => {
    expect(
      shouldArmTerminalRecoveryResume({
        now: 100_000,
        hiddenAt: 100_000 - TERMINAL_RECOVERY_MIN_HIDDEN_MS + 1_000,
      }),
    ).toBe(false);
  });

  test("arms once the hidden period reaches the suspension threshold", () => {
    expect(
      shouldArmTerminalRecoveryResume({
        now: 100_000,
        hiddenAt: 100_000 - TERMINAL_RECOVERY_MIN_HIDDEN_MS,
      }),
    ).toBe(true);
  });
});

describe("terminal recovery reload timestamp storage", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
  }

  test("round-trips the reload timestamp", () => {
    const storage = memoryStorage();
    expect(readTerminalRecoveryReloadAt(storage)).toBe(null);
    writeTerminalRecoveryReloadAt(123_456, storage);
    expect(readTerminalRecoveryReloadAt(storage)).toBe(123_456);
  });

  test("ignores malformed stored values", () => {
    const storage = memoryStorage({
      "terminalRecovery.lastReloadAt": "not-a-number",
    });
    expect(readTerminalRecoveryReloadAt(storage)).toBe(null);
  });

  test("tolerates unavailable storage", () => {
    expect(readTerminalRecoveryReloadAt(null)).toBe(null);
    expect(() => writeTerminalRecoveryReloadAt(1, null)).not.toThrow();
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readTerminalRecoveryReloadAt(throwing)).toBe(null);
    expect(() => writeTerminalRecoveryReloadAt(1, throwing)).not.toThrow();
  });
});
