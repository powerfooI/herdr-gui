import { describe, expect, test } from "bun:test";
import type { GitStatusSummary, Workspace } from "./types";
import {
  showWorkspaceBranchBadge,
  workspaceDisplayName,
} from "./workspaceTreeBadges";

function workspace({
  label,
  branch,
  linked = true,
}: {
  label: string;
  branch?: string;
  linked?: boolean;
}): Workspace {
  const gitStatus: GitStatusSummary = {
    branch,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    dirty: false,
  };
  return {
    workspace_id: "w1",
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
    worktree: {
      repo_key: "/repo/.git",
      repo_name: "repo",
      repo_root: "/repo",
      checkout_path: linked ? "/repo-worktree" : "/repo",
      is_linked_worktree: linked,
      git_status: gitStatus,
    },
  };
}

describe("workspace tree badges", () => {
  test("hides a redundant branch badge for matching linked worktree names", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "feature", branch: "feature" }),
      ),
    ).toBe(false);
  });

  test("normalizes incidental whitespace before comparing names", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "feature ", branch: " feature" }),
      ),
    ).toBe(false);
  });

  test("keeps branch badges when the visible name differs", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "Feature workspace", branch: "feature" }),
      ),
    ).toBe(true);
  });

  test("keeps branch badges for main checkouts and missing branch names", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "main", branch: "main", linked: false }),
      ),
    ).toBe(true);
    expect(showWorkspaceBranchBadge(workspace({ label: "feature" }))).toBe(
      true,
    );
  });

  test("falls back to the workspace id for the visible name", () => {
    const target = workspace({ label: "", branch: "w1" });
    expect(workspaceDisplayName(target)).toBe("w1");
    expect(showWorkspaceBranchBadge(target)).toBe(false);
  });
});
