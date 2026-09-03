export type PaneShortcutDirection = "left" | "right" | "up" | "down";

export type PaneShortcutAction =
  | { type: "focus"; direction: PaneShortcutDirection }
  | { type: "split"; direction: "right" | "down" };

type PaneShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const ARROW_DIRECTIONS: Record<string, PaneShortcutDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * Maps macOS pane shortcuts without consuming extra modifier variants.
 * Cmd+Ctrl+Arrows focus neighboring panes (Cmd+Option+Arrows stay with tab
 * switching and are also swallowed by some PWA hosts), Cmd+D splits the
 * active pane right, and Cmd+Shift+D splits it down.
 */
export function paneShortcutAction(
  event: PaneShortcutEvent,
): PaneShortcutAction | null {
  if (!event.metaKey || event.altKey) return null;

  if (event.ctrlKey && !event.shiftKey) {
    const direction = ARROW_DIRECTIONS[event.key];
    return direction ? { type: "focus", direction } : null;
  }

  if (!event.ctrlKey && event.key.toLowerCase() === "d") {
    return { type: "split", direction: event.shiftKey ? "down" : "right" };
  }
  return null;
}
