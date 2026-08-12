import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  isWorkspacePinned,
  parseWorkspacePins,
  serializeWorkspacePins,
  setWorkspacePinned,
  workspacePinKey,
} from "./workspacePins";

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

const linkedWorktree: NonNullable<Workspace["worktree"]> = {
  repo_key: "/repo/.git",
  repo_name: "repo",
  repo_root: "/repo",
  checkout_path: "/repo-worktrees/feature/",
  is_linked_worktree: true,
  gui_settings_key: "local:/repo/.git",
};

describe("workspace pins", () => {
  test("uses stable checkout identity only for linked worktrees", () => {
    expect(workspacePinKey(workspace("w1"))).toBe("workspace:w1");
    expect(workspacePinKey(workspace("w:1"))).toBe("workspace:w%3A1");
    expect(workspacePinKey(workspace("w2", linkedWorktree))).toBe(
      "worktree:local%3A%2Frepo%2F.git:%2Frepo-worktrees%2Ffeature",
    );
    expect(workspacePinKey(workspace("w99", linkedWorktree))).toBe(
      workspacePinKey(workspace("w2", linkedWorktree)),
    );
    expect(
      workspacePinKey(
        workspace("w100", {
          ...linkedWorktree,
          checkout_path: " /repo-worktrees/feature// ",
        }),
      ),
    ).toBe(workspacePinKey(workspace("w2", linkedWorktree)));
    expect(
      workspacePinKey(
        workspace("w3", { ...linkedWorktree, gui_settings_key: undefined }),
      ),
    ).toBe("worktree:%2Frepo%2F.git:%2Frepo-worktrees%2Ffeature");

    const mainCheckout = {
      ...linkedWorktree,
      checkout_path: "/repo",
      is_linked_worktree: false,
    };
    expect(workspacePinKey(workspace("w2", mainCheckout))).toBe("workspace:w2");
    expect(workspacePinKey(workspace("w99", mainCheckout))).toBe(
      "workspace:w99",
    );
  });

  test("parses only bounded, unique workspace and worktree keys", () => {
    const pins = parseWorkspacePins(
      JSON.stringify([
        "workspace:w1",
        "workspace:w1",
        "worktree:repo:%2Fpath",
        "other:value",
        42,
        `workspace:${"x".repeat(3000)}`,
      ]),
    );

    expect(pins).toEqual(["workspace:w1", "worktree:repo:%2Fpath"]);
    expect(parseWorkspacePins("bad json")).toEqual([]);
    expect(parseWorkspacePins("{}" as string)).toEqual([]);
    expect(JSON.parse(serializeWorkspacePins(pins))).toEqual(pins);
  });

  test("pins, unpins, and recognizes exact workspace identities", () => {
    const target = workspace("w2", linkedWorktree);
    const pinned = setWorkspacePinned(["workspace:w1"], target, true);

    expect(isWorkspacePinned(new Set(pinned), target)).toBe(true);
    expect(pinned).toHaveLength(2);
    expect(setWorkspacePinned(pinned, target, true)).toEqual(pinned);
    expect(setWorkspacePinned(pinned, target, false)).toEqual(["workspace:w1"]);
  });
});
