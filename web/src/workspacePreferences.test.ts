import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  MAX_WORKSPACE_PREFERENCES,
  parseWorkspacePreferenceKeys,
  pruneClosedWorkspacePreferenceKeys,
  serializeWorkspacePreferenceKeys,
  setWorkspacePreferenceKey,
} from "./workspacePreferences";

describe("workspace preference keys", () => {
  test("parses only bounded, canonical, unique keys", () => {
    const keys = parseWorkspacePreferenceKeys(
      JSON.stringify([
        "workspace:w1",
        "workspace:w1",
        "worktree:local%3A%2Frepo:%2Fcheckout",
        "worktree:legacy:path:with:ambiguous:separators",
        "worktree:bad%ZZ:%2Fcheckout",
        "worktree:raw slash:%2Fcheckout",
        "workspace:raw slash",
        "workspace:",
        "other:value",
        42,
        `workspace:${"x".repeat(3000)}`,
      ]),
    );

    expect(keys).toEqual([
      "workspace:w1",
      "worktree:local%3A%2Frepo:%2Fcheckout",
    ]);
    expect(parseWorkspacePreferenceKeys("bad json")).toEqual([]);
    expect(parseWorkspacePreferenceKeys("{}" as string)).toEqual([]);
    expect(JSON.parse(serializeWorkspacePreferenceKeys(keys))).toEqual(keys);
  });

  test("keeps the newest explicit preference when storage is full", () => {
    const full = Array.from(
      { length: MAX_WORKSPACE_PREFERENCES },
      (_, index) => `workspace:w${index}`,
    );
    const next = setWorkspacePreferenceKey(full, "workspace:newest", true);

    expect(next).toHaveLength(MAX_WORKSPACE_PREFERENCES);
    expect(next[0]).toBe("workspace:w1");
    expect(next[next.length - 1]).toBe("workspace:newest");
  });

  test("moves an existing enabled preference to the newest position", () => {
    expect(
      setWorkspacePreferenceKey(
        ["workspace:w1", "workspace:w2"],
        "workspace:w1",
        true,
      ),
    ).toEqual(["workspace:w2", "workspace:w1"]);
    expect(
      setWorkspacePreferenceKey(
        ["workspace:w1", "workspace:w2"],
        "workspace:w1",
        false,
      ),
    ).toEqual(["workspace:w2"]);
  });

  test("prunes closed ephemeral workspaces but keeps durable worktrees", () => {
    const workspace = {
      workspace_id: "w1",
      number: 1,
      label: "one",
      focused: false,
      pane_count: 1,
      tab_count: 1,
      agent_status: "unknown",
    } satisfies Workspace;

    expect(
      pruneClosedWorkspacePreferenceKeys(
        ["workspace:w1", "workspace:w2", "worktree:repo:%2Fcheckout"],
        [workspace],
      ),
    ).toEqual(["workspace:w1", "worktree:repo:%2Fcheckout"]);
  });
});
