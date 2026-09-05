import type { Pane, Tab } from "./types";

export type TabShortcutAction = "create" | "close" | "previous" | "next";

type TabShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** Maps exact macOS tab shortcuts without consuming extra modifier variants. */
export function tabShortcutAction(
  event: TabShortcutEvent,
): TabShortcutAction | null {
  if (!event.metaKey || event.ctrlKey || event.shiftKey) return null;

  const key = event.key.toLowerCase();
  if (!event.altKey && key === "t") return "create";
  if (!event.altKey && key === "w") return "close";
  if (event.altKey && event.key === "ArrowLeft") return "previous";
  if (event.altKey && event.key === "ArrowRight") return "next";
  return null;
}

/** Closes only the active pane in split tabs, otherwise the tab itself. */
export function closeShortcutTarget(
  tabId: string | undefined,
  panes: Pick<Pane, "pane_id" | "tab_id" | "focused">[],
  activePaneId: string | undefined,
): { type: "pane" | "tab"; id: string } | null {
  if (!tabId) return null;
  const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
  if (tabPanes.length <= 1) return { type: "tab", id: tabId };
  const pane =
    tabPanes.find((pane) => pane.pane_id === activePaneId) ??
    tabPanes.find((pane) => pane.focused) ??
    tabPanes[0];
  return { type: "pane", id: pane.pane_id };
}

/** Selects the adjacent tab in stable tab-number order, wrapping at each end. */
export function adjacentTabId(
  tabs: Pick<Tab, "tab_id" | "number">[],
  currentTabId: string | undefined,
  direction: "previous" | "next",
): string | null {
  if (tabs.length === 0) return null;

  const orderedTabs = [...tabs].sort((a, b) => a.number - b.number);
  const currentIndex = orderedTabs.findIndex(
    (tab) => tab.tab_id === currentTabId,
  );
  if (currentIndex < 0) {
    return direction === "previous"
      ? orderedTabs[orderedTabs.length - 1].tab_id
      : orderedTabs[0].tab_id;
  }

  const offset = direction === "previous" ? -1 : 1;
  const nextIndex =
    (currentIndex + offset + orderedTabs.length) % orderedTabs.length;
  return orderedTabs[nextIndex].tab_id;
}
