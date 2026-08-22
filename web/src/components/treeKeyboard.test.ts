import { describe, expect, test } from "bun:test";
import { treeKeyboardAction, workspaceTreeItemIsTabStop } from "./treeKeyboard";

describe("tree row keyboard actions", () => {
  test("recognizes activation, navigation, and context-menu keys", () => {
    expect(treeKeyboardAction("Enter")).toBe("activate");
    expect(treeKeyboardAction(" ")).toBe("activate");
    expect(treeKeyboardAction("ArrowDown")).toBe("next");
    expect(treeKeyboardAction("ArrowLeft")).toBe("collapse");
    expect(treeKeyboardAction("ContextMenu")).toBe("context-menu");
    expect(treeKeyboardAction("F10", true)).toBe("context-menu");
    expect(treeKeyboardAction("F10", false)).toBeNull();
  });

  test("keeps a collapsed ancestor tabbable when it hides the active item", () => {
    expect(
      workspaceTreeItemIsTabStop({
        workspaceFocused: false,
        directAgentActive: false,
        collapsed: true,
        hiddenDescendantActive: true,
      }),
    ).toBe(true);
    expect(
      workspaceTreeItemIsTabStop({
        workspaceFocused: true,
        directAgentActive: true,
        collapsed: false,
        hiddenDescendantActive: false,
      }),
    ).toBe(false);
    expect(
      workspaceTreeItemIsTabStop({
        workspaceFocused: true,
        directAgentActive: false,
        collapsed: false,
        hiddenDescendantActive: false,
      }),
    ).toBe(true);
  });
});
