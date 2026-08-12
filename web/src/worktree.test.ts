import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  buildWorkspaceHierarchy,
  canCreateWorktree,
  resolveWorktreeOpenSource,
  worktreeCreationSource,
} from "./worktree";
import { workspacePinKey } from "./workspacePins";

function workspace(worktree?: Workspace["worktree"]): Workspace {
  return {
    workspace_id: "w1",
    number: 1,
    label: "repo",
    focused: true,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
    worktree,
  };
}

describe("worktree creation eligibility", () => {
  test("allows a workspace when Herdr omits worktree metadata", () => {
    expect(canCreateWorktree(workspace())).toBe(true);
  });

  test("allows a main checkout and excludes a linked worktree", () => {
    const base = {
      repo_key: "/repo/.git",
      repo_name: "repo",
      repo_root: "/repo",
      checkout_path: "/repo",
    };
    expect(
      canCreateWorktree(workspace({ ...base, is_linked_worktree: false })),
    ).toBe(true);
    expect(
      canCreateWorktree(workspace({ ...base, is_linked_worktree: true })),
    ).toBe(false);
  });
});

describe("worktree open source", () => {
  const list = {
    type: "worktree_list" as const,
    source: {
      repo_key: "/repo/.git",
      repo_name: "repo",
      repo_root: "/repo",
      source_checkout_path: "/repo",
      source_workspace_id: "main-workspace",
    },
    worktrees: [],
  };

  test("uses the repository parent returned when listing from a linked workspace", () => {
    expect(resolveWorktreeOpenSource(list)).toEqual({
      workspaceId: "main-workspace",
    });
  });

  test("uses the repository root when the main workspace is closed", () => {
    expect(
      resolveWorktreeOpenSource({
        ...list,
        source: { ...list.source, source_workspace_id: undefined },
      }),
    ).toEqual({ cwd: "/repo" });
  });

  test("does not guess that the listing workspace is a valid open source", () => {
    expect(resolveWorktreeOpenSource(null)).toBeNull();
  });

  test("allows a caller to provide a verified source before listing", () => {
    expect(resolveWorktreeOpenSource(null, "workspace-1")).toEqual({
      workspaceId: "workspace-1",
    });
  });
});

describe("workspace worktree hierarchy", () => {
  const mainWorktree = {
    repo_key: "/repo/.git",
    repo_name: "repo",
    repo_root: "/repo",
    checkout_path: "/repo",
    is_linked_worktree: false,
  };

  test("uses the explicit source when a repo has multiple main workspaces", () => {
    const first = { ...workspace(mainWorktree), workspace_id: "w1", number: 1 };
    const second = {
      ...workspace(mainWorktree),
      workspace_id: "w2",
      number: 2,
    };
    const linked = {
      ...workspace({
        ...mainWorktree,
        checkout_path: "/repo-worktree",
        is_linked_worktree: true,
        parent_workspace_id: "w1",
      }),
      workspace_id: "w3",
      number: 3,
    };

    const hierarchy = buildWorkspaceHierarchy([first, second, linked]);
    expect(hierarchy.childrenByParent.get("w1")).toEqual([linked]);
    expect(hierarchy.childrenByParent.has("w2")).toBe(false);
    expect(worktreeCreationSource([first, second, linked], linked)).toBe(first);
  });

  test("does not guess a parent for ambiguous legacy data", () => {
    const first = { ...workspace(mainWorktree), workspace_id: "w1", number: 1 };
    const second = {
      ...workspace(mainWorktree),
      workspace_id: "w2",
      number: 2,
    };
    const linked = {
      ...workspace({
        ...mainWorktree,
        checkout_path: "/repo-worktree",
        is_linked_worktree: true,
      }),
      workspace_id: "w3",
      number: 3,
    };

    const hierarchy = buildWorkspaceHierarchy([first, second, linked]);
    expect(hierarchy.topLevel).toEqual([first, second, linked]);
    expect(hierarchy.childrenByParent.size).toBe(0);
    expect(
      worktreeCreationSource([first, second, linked], linked),
    ).toBeUndefined();
  });

  test("ignores an explicit parent without matching Git metadata", () => {
    const ordinary = { ...workspace(), workspace_id: "w1", number: 1 };
    const linked = {
      ...workspace({
        ...mainWorktree,
        checkout_path: "/repo-worktree",
        is_linked_worktree: true,
        parent_workspace_id: "w1",
      }),
      workspace_id: "w2",
      number: 2,
    };

    expect(worktreeCreationSource([ordinary, linked], linked)).toBeUndefined();
    expect(buildWorkspaceHierarchy([ordinary, linked]).topLevel).toEqual([
      ordinary,
      linked,
    ]);
  });

  test("keeps the repo-key fallback when only one parent exists", () => {
    const main = { ...workspace(mainWorktree), workspace_id: "w1", number: 1 };
    const linked = {
      ...workspace({
        ...mainWorktree,
        checkout_path: "/repo-worktree",
        is_linked_worktree: true,
      }),
      workspace_id: "w2",
      number: 2,
    };

    const hierarchy = buildWorkspaceHierarchy([main, linked]);
    expect(hierarchy.topLevel).toEqual([main]);
    expect(hierarchy.childrenByParent.get("w1")).toEqual([linked]);
    expect(worktreeCreationSource([main, linked], linked)).toBe(main);
  });

  test("sorts explicitly pinned workspaces before ordinary workspace numbers", () => {
    const first = { ...workspace(), workspace_id: "w1", number: 1 };
    const second = { ...workspace(), workspace_id: "w2", number: 2 };
    const third = { ...workspace(), workspace_id: "w3", number: 3 };
    const pins = new Set([workspacePinKey(third)]);

    expect(
      buildWorkspaceHierarchy([first, second, third], pins).topLevel,
    ).toEqual([third, first, second]);
  });

  test("pins only the selected main-checkout workspace", () => {
    const first = {
      ...workspace(mainWorktree),
      workspace_id: "w1",
      number: 1,
    };
    const second = {
      ...workspace(mainWorktree),
      workspace_id: "w2",
      number: 2,
    };
    const pins = new Set([workspacePinKey(second)]);

    expect(buildWorkspaceHierarchy([first, second], pins).topLevel).toEqual([
      second,
      first,
    ]);
  });

  test("lifts a pinned linked worktree out of its parent group", () => {
    const ordinary = { ...workspace(), workspace_id: "w1", number: 1 };
    const main = { ...workspace(mainWorktree), workspace_id: "w2", number: 2 };
    const firstLinked = {
      ...workspace({
        ...mainWorktree,
        checkout_path: "/repo-worktree-a",
        is_linked_worktree: true,
        parent_workspace_id: "w2",
      }),
      workspace_id: "w3",
      number: 3,
    };
    const pinnedLinked = {
      ...workspace({
        ...mainWorktree,
        checkout_path: "/repo-worktree-b",
        is_linked_worktree: true,
        parent_workspace_id: "w2",
      }),
      workspace_id: "w4",
      number: 4,
    };
    const pins = new Set([workspacePinKey(pinnedLinked)]);
    const hierarchy = buildWorkspaceHierarchy(
      [ordinary, main, firstLinked, pinnedLinked],
      pins,
    );

    expect(hierarchy.topLevel).toEqual([pinnedLinked, ordinary, main]);
    expect(hierarchy.childrenByParent.get("w2")).toEqual([firstLinked]);
  });

  test("returns an unpinned linked worktree to its parent group", () => {
    const main = { ...workspace(mainWorktree), workspace_id: "w1", number: 1 };
    const linked = {
      ...workspace({
        ...mainWorktree,
        checkout_path: "/repo-worktree",
        is_linked_worktree: true,
        parent_workspace_id: "w1",
      }),
      workspace_id: "w2",
      number: 2,
    };

    const pinnedHierarchy = buildWorkspaceHierarchy(
      [main, linked],
      new Set([workspacePinKey(linked)]),
    );
    expect(pinnedHierarchy.topLevel).toEqual([linked, main]);
    expect(pinnedHierarchy.childrenByParent.size).toBe(0);

    const unpinnedHierarchy = buildWorkspaceHierarchy([main, linked]);
    expect(unpinnedHierarchy.topLevel).toEqual([main]);
    expect(unpinnedHierarchy.childrenByParent.get("w1")).toEqual([linked]);
  });
});
