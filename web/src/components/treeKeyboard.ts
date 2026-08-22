export type TreeKeyboardAction =
  | "activate"
  | "context-menu"
  | "next"
  | "previous"
  | "first"
  | "last"
  | "expand"
  | "collapse"
  | null;

export function treeKeyboardAction(
  key: string,
  shiftKey = false,
): TreeKeyboardAction {
  if (key === "Enter" || key === " ") return "activate";
  if (key === "ContextMenu" || (shiftKey && key === "F10")) {
    return "context-menu";
  }
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (key === "ArrowRight") return "expand";
  if (key === "ArrowLeft") return "collapse";
  return null;
}

export function workspaceTreeItemIsTabStop({
  workspaceFocused,
  directAgentActive,
  collapsed,
  hiddenDescendantActive,
}: {
  workspaceFocused: boolean;
  directAgentActive: boolean;
  collapsed: boolean;
  hiddenDescendantActive: boolean;
}): boolean {
  if (collapsed) {
    return workspaceFocused || directAgentActive || hiddenDescendantActive;
  }
  return workspaceFocused && !directAgentActive;
}

export function focusTreeItem(
  current: HTMLElement,
  action: "next" | "previous" | "first" | "last",
): boolean {
  const tree = current.closest<HTMLElement>("[role='tree']");
  if (!tree) return false;
  const items = Array.from(
    tree.querySelectorAll<HTMLElement>("[role='treeitem']"),
  ).filter((item) => item.getAttribute("aria-hidden") !== "true");
  const index = items.indexOf(current);
  if (index < 0 || items.length === 0) return false;
  let targetIndex = index;
  switch (action) {
    case "first":
      targetIndex = 0;
      break;
    case "last":
      targetIndex = items.length - 1;
      break;
    case "next":
      targetIndex = Math.min(items.length - 1, index + 1);
      break;
    case "previous":
      targetIndex = Math.max(0, index - 1);
      break;
  }
  const target = items[targetIndex];
  if (!target || target === current) return false;
  current.tabIndex = -1;
  target.tabIndex = 0;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest" });
  return true;
}

export function keyboardContextMenuPoint(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.min(rect.right, rect.left + 28),
    y: rect.top + rect.height / 2,
  };
}
