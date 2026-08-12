import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  isWorktreeGroupCollapsed,
  parseCollapsedWorktreeGroups,
  serializeCollapsedWorktreeGroups,
  setWorktreeGroupCollapsed,
  worktreeGroupKey,
} from "./workspaceTreeCollapse";

function workspace(
  workspaceId: string,
  worktree?: Workspace["worktree"],
): Workspace {
  return {
    workspace_id: workspaceId,
    number: Number(workspaceId.replace(/\D/g, "")) || 1,
    label: workspaceId,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
    worktree,
  };
}

const mainWorktree: NonNullable<Workspace["worktree"]> = {
  repo_key: "/repo/.git",
  repo_name: "repo",
  repo_root: "/repo",
  checkout_path: "/repo/",
  is_linked_worktree: false,
  gui_settings_key: "local:/repo/.git",
};

describe("collapsed worktree groups", () => {
  test("uses stable workspace preference identity", () => {
    expect(worktreeGroupKey(workspace("w1"))).toBe("workspace:w1");
    expect(worktreeGroupKey(workspace("w2", mainWorktree))).toBe(
      "workspace:w2",
    );
    expect(worktreeGroupKey(workspace("w99", mainWorktree))).toBe(
      "workspace:w99",
    );
  });

  test("parses only bounded, unique workspace and worktree keys", () => {
    const groups = parseCollapsedWorktreeGroups(
      JSON.stringify([
        "workspace:w1",
        "workspace:w1",
        "worktree:repo:%2Fpath",
        "other:value",
        42,
        `workspace:${"x".repeat(3000)}`,
      ]),
    );

    expect(groups).toEqual(["workspace:w1", "worktree:repo:%2Fpath"]);
    expect(parseCollapsedWorktreeGroups("bad json")).toEqual([]);
    expect(parseCollapsedWorktreeGroups("{}" as string)).toEqual([]);
    expect(JSON.parse(serializeCollapsedWorktreeGroups(groups))).toEqual(
      groups,
    );
  });

  test("collapses, expands, and recognizes exact group identities", () => {
    const target = workspace("w2", mainWorktree);
    const collapsed = setWorktreeGroupCollapsed(["workspace:w1"], target, true);

    expect(isWorktreeGroupCollapsed(new Set(collapsed), target)).toBe(true);
    expect(collapsed).toHaveLength(2);
    expect(setWorktreeGroupCollapsed(collapsed, target, true)).toEqual(
      collapsed,
    );
    expect(setWorktreeGroupCollapsed(collapsed, target, false)).toEqual([
      "workspace:w1",
    ]);
  });
});
