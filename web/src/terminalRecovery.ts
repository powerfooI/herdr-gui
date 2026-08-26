/**
 * Last-resort recovery for terminals that cannot restore themselves after a
 * mobile foreground resume (lock screen, app switch). The OS can freeze the
 * page mid-session, leaving a wedged socket, stream, or compositor that
 * in-place recovery cannot fix; a page reload is the only way out, and it is
 * what users otherwise have to do by hand.
 */

/**
 * Only a failure shortly after a foreground resume qualifies for an
 * automatic reload. General attach failures (flaky networks, busy servers)
 * surface an error instead of reloading the app.
 */
export const TERMINAL_RECOVERY_RESUME_WINDOW_MS = 90_000;

/**
 * Minimum spacing between automatic reloads so a genuinely dead backend can
 * never trap the app in a reload loop.
 */
export const TERMINAL_RECOVERY_RELOAD_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * Minimum measured hidden duration before a resume may arm the last-resort
 * reload. Desktop tab switches also fire visibilitychange; only a hidden
 * period long enough to have suspended the page (mobile lock screen, app
 * backgrounding) should arm an automatic reload.
 */
export const TERMINAL_RECOVERY_MIN_HIDDEN_MS = 30_000;

/**
 * Decides whether a hidden-to-visible transition arms the last-resort
 * reload. A measured short tab switch never arms it. An unmeasured
 * transition (hiddenAt null) does: some platforms freeze the page without
 * dispatching the hidden event, so the lock-screen case must stay armed.
 */
export function shouldArmTerminalRecoveryResume(args: {
  now: number;
  hiddenAt: number | null;
}): boolean {
  if (args.hiddenAt === null) return true;
  return args.now - args.hiddenAt >= TERMINAL_RECOVERY_MIN_HIDDEN_MS;
}

export function shouldReloadTerminalAfterResume(args: {
  now: number;
  resumedAt: number | null;
  lastReloadAt: number | null;
}): boolean {
  if (args.resumedAt === null) return false;
  if (args.now - args.resumedAt > TERMINAL_RECOVERY_RESUME_WINDOW_MS) {
    return false;
  }
  if (
    args.lastReloadAt !== null &&
    args.now - args.lastReloadAt < TERMINAL_RECOVERY_RELOAD_MIN_INTERVAL_MS
  ) {
    return false;
  }
  return true;
}

const STORAGE_KEY = "terminalRecovery.lastReloadAt";

type RecoveryStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): RecoveryStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readTerminalRecoveryReloadAt(
  storage: RecoveryStorage | null = defaultStorage(),
): number | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeTerminalRecoveryReloadAt(
  now: number,
  storage: RecoveryStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, String(now));
  } catch {
    // Storage may be unavailable; skipping the write only weakens the
    // cross-reload rate limit, never the in-place recovery path.
  }
}
