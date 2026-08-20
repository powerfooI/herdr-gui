import {
  mobileTerminalShortcutBytes,
  mobileTerminalShortcutClipboard,
  mobileTerminalShortcutScroll,
  type MobileTerminalShortcutAction,
} from "./mobileTerminalShortcuts";

export type MobileTerminalShortcutExecution =
  | {
      type: "input";
      bytes: number[];
    }
  | {
      type: "scroll";
      direction: "up" | "down";
      amount: "full" | "half";
    }
  | {
      type: "paste";
    };

export function mobileTerminalShortcutExecution(
  action: MobileTerminalShortcutAction,
): MobileTerminalShortcutExecution | null {
  if (mobileTerminalShortcutClipboard(action) === "paste") {
    return { type: "paste" };
  }
  const scroll = mobileTerminalShortcutScroll(action);
  if (scroll) return { type: "scroll", ...scroll };
  const bytes = mobileTerminalShortcutBytes(action);
  return bytes.length > 0 ? { type: "input", bytes } : null;
}
