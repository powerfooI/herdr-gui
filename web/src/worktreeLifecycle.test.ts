import { describe, expect, test } from "bun:test";
import type { Workspace, WorktreeList } from "./types";
import {
  buildWorktreeLifecycleRows,
  lifecycleActionError,
  lifecycleActionWarning,
  lifecycleAutoSyncLabel,
  lifecycleGitChangeCount,
  lifecycleOpenedWorkspaceId,
} from "./worktreeLifecycle";

const list: WorktreeList = {
  type: "worktree_list",
  source: {
    repo_key: "/repo/.git",
    repo_name: "repo",
    repo_root: "/repo",
    source_checkout_path: "/repo",
    source_workspace_id: "w1",
  },
  worktrees: [
    {
      path: "/repo/",
      branch: "main",
      is_bare: false,
      is_detached: false,
      is_prunable: false,
      is_linked_worktree: false,
      open_workspace_id: "w1",
      label: "repo",
    },
    {
      path: "/worktrees/feature",
      branch: "feature",
      is_bare: false,
      is_detached: false,
      is_prunable: false,
      is_linked_worktree: true,
      label: "feature",
    },
  ],
};

function workspace(
  id: string,
  path: string,
  linked: boolean,
  focused = false,
): Workspace {
  return {
    workspace_id: id,
    number: Number(id.slice(1)),
    label: id,
    focused,
    pane_count: 1,
    tab_count: 1,
    agent_status: "idle",
    worktree: {
      repo_key: "/repo/.git",
      repo_name: "repo",
      repo_root: "/repo",
      checkout_path: path,
      is_linked_worktree: linked,
      git_status: {
        branch: linked ? "feature" : "main",
        ahead: 0,
        behind: linked ? 2 : 0,
        staged: 1,
        unstaged: 2,
        untracked: 3,
        conflicted: 0,
        dirty: true,
      },
    },
  };
}

describe("worktree lifecycle rows", () => {
  test("joins open workspaces by normalized checkout path", () => {
    const rows = buildWorktreeLifecycleRows(list, [
      workspace("w1", "/repo", false),
      workspace("w2", "/worktrees/feature/", true),
    ]);

    expect(rows.map((row) => row.workspace?.workspace_id)).toEqual([
      "w1",
      "w2",
    ]);
    expect(rows[1].worktree.open_workspace_id).toBe("w2");
    expect(rows[1].gitStatus?.behind).toBe(2);
  });

  test("prefers the focused workspace when a checkout is open twice", () => {
    const rows = buildWorktreeLifecycleRows(list, [
      workspace("w1", "/repo", false),
      workspace("w2", "/repo", false, true),
    ]);

    expect(rows[0].workspace?.workspace_id).toBe("w2");
    expect(rows[0].worktree.open_workspace_id).toBe("w2");
  });

  test("retains an open checkout missing from a stale worktree list", () => {
    const rows = buildWorktreeLifecycleRows(
      { ...list, worktrees: list.worktrees.slice(0, 1) },
      [
        workspace("w1", "/repo", false),
        workspace("w3", "/worktrees/late", true),
      ],
    );

    expect(rows).toHaveLength(2);
    expect(rows[1].worktree.path).toBe("/worktrees/late");
    expect(rows[1].worktree.open_workspace_id).toBe("w3");
  });

  test("counts all user-visible git changes", () => {
    expect(
      lifecycleGitChangeCount(
        workspace("w1", "/repo", false).worktree?.git_status,
      ),
    ).toBe(6);
  });

  test("separates lifecycle failures from successful cleanup warnings", () => {
    expect(
      lifecycleActionError({
        skipped_remove: true,
        before_remove_hook: { status: "failed", stderr: "teardown failed" },
      }),
    ).toBe("teardown failed");
    expect(
      lifecycleActionWarning({
        cleanup: { warning: "checkout still present" },
      }),
    ).toBe("checkout still present");
    expect(
      lifecycleActionError({ cleanup: { warning: "checkout still present" } }),
    ).toBeUndefined();
    expect(lifecycleActionError({ type: "worktree_created" })).toBeUndefined();
  });

  test("extracts the workspace created while opening a closed checkout", () => {
    expect(
      lifecycleOpenedWorkspaceId({ workspace: { workspace_id: "w42" } }),
    ).toBe("w42");
    expect(lifecycleOpenedWorkspaceId({ workspace: {} })).toBeUndefined();
    expect(lifecycleOpenedWorkspaceId(null)).toBeUndefined();
  });

  test("describes automatic main synchronization explicitly", () => {
    expect(lifecycleAutoSyncLabel()).toBe("Main auto-sync off");
    expect(
      lifecycleAutoSyncLabel({
        workspace_id: "w1",
        enabled: true,
        interval_minutes: 15,
        running: false,
      }),
    ).toBe("Sync origin/main every 15 min");
  });
});
