import { describe, expect, test } from "bun:test";
import { repoSettingsKey, type GuiSettings } from "../config/gui-settings";
import { attachWorktreeParents } from "./parents";

function settings(path: string, parentWorkspaceId: string): GuiSettings {
  return {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {
      worktree_parent_by_checkout: {
        [repoSettingsKey(path)]: parentWorkspaceId,
      },
    },
  };
}

describe("worktree parent metadata", () => {
  const mainWorktree = {
    repo_key: "/repo/.git",
    repo_root: "/repo",
    checkout_path: "/repo",
    is_linked_worktree: false,
  };

  test("attaches the persisted source when a repo has several workspaces", () => {
    const linkedPath = "/worktrees/feature";
    const result = attachWorktreeParents(
      {
        workspaces: [
          { workspace_id: "w1", worktree: mainWorktree },
          { workspace_id: "w2", worktree: mainWorktree },
          {
            workspace_id: "w3",
            worktree: {
              ...mainWorktree,
              checkout_path: linkedPath,
              is_linked_worktree: true,
            },
          },
        ],
      },
      settings(linkedPath, "w1"),
    );

    expect(result.workspaces[2].worktree.parent_workspace_id).toBe("w1");
  });

  test("ignores a stale or incompatible parent record", () => {
    const linkedPath = "/worktrees/feature";
    const input = {
      workspaces: [
        {
          workspace_id: "w1",
          worktree: { ...mainWorktree, repo_key: "/other/.git" },
        },
        {
          workspace_id: "w2",
          worktree: {
            ...mainWorktree,
            checkout_path: linkedPath,
            is_linked_worktree: true,
          },
        },
      ],
    };

    expect(attachWorktreeParents(input, settings(linkedPath, "w1"))).toEqual(
      input,
    );
  });

  test("does not trust an unverified parent workspace", () => {
    const linkedPath = "/worktrees/feature";
    const input = {
      workspaces: [
        { workspace_id: "w1", label: "ordinary workspace" },
        {
          workspace_id: "w2",
          worktree: {
            ...mainWorktree,
            checkout_path: linkedPath,
            is_linked_worktree: true,
          },
        },
      ],
    };

    expect(attachWorktreeParents(input, settings(linkedPath, "w1"))).toEqual(
      input,
    );
  });
});
