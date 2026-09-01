import { describe, expect, test } from "bun:test";
import {
  buildGitFileMenuItems,
  buildGitRepoMenuItems,
  countWorkingEntries,
  gitFileConfirmCopy,
  gitRepoConfirmCopy,
} from "./gitActions";
import type { GitDiffEntry } from "./types";

function entry(kind: GitDiffEntry["kind"]): GitDiffEntry {
  return { path: "src/a.ts", kind, status: kind };
}

describe("buildGitFileMenuItems", () => {
  test("untracked files get stage and delete", () => {
    expect(buildGitFileMenuItems([entry("untracked")])).toEqual([
      { action: "stage", label: "Stage file" },
      {
        action: "delete_untracked",
        label: "Delete untracked file…",
        danger: true,
        destructive: true,
      },
    ]);
  });

  test("unstaged files get stage and discard", () => {
    expect(buildGitFileMenuItems([entry("unstaged")])).toEqual([
      { action: "stage", label: "Stage changes" },
      {
        action: "discard_unstaged",
        label: "Discard unstaged changes…",
        danger: true,
        destructive: true,
      },
    ]);
  });

  test("staged files get unstage only", () => {
    expect(buildGitFileMenuItems([entry("staged")])).toEqual([
      { action: "unstage", label: "Unstage changes" },
    ]);
  });

  test("staged + unstaged files get both parts covered", () => {
    expect(buildGitFileMenuItems([entry("staged"), entry("unstaged")])).toEqual(
      [
        { action: "stage", label: "Stage changes" },
        { action: "unstage", label: "Unstage changes" },
        {
          action: "discard_unstaged",
          label: "Discard unstaged changes…",
          danger: true,
          destructive: true,
        },
      ],
    );
  });

  test("conflicted files get mark resolved", () => {
    expect(buildGitFileMenuItems([entry("conflicted")])).toEqual([
      { action: "stage", label: "Mark resolved" },
    ]);
  });
});

describe("countWorkingEntries", () => {
  test("counts only working-tree kinds", () => {
    expect(
      countWorkingEntries([
        entry("staged"),
        entry("unstaged"),
        entry("unstaged"),
        entry("untracked"),
        entry("conflicted"),
        entry("branch"),
        entry("last-step"),
      ]),
    ).toEqual({ staged: 1, unstaged: 2, untracked: 1, conflicted: 1 });
  });
});

describe("buildGitRepoMenuItems", () => {
  test("derives affected counts per action", () => {
    const items = buildGitRepoMenuItems({
      staged: 2,
      unstaged: 3,
      untracked: 4,
      conflicted: 1,
    });
    expect(items.map((item) => [item.action, item.count])).toEqual([
      ["stage_all", 8],
      ["unstage_all", 2],
      ["discard_all_unstaged", 3],
      ["delete_all_untracked", 4],
    ]);
    expect(items[2]).toMatchObject({ danger: true, destructive: true });
    expect(items[3]).toMatchObject({ danger: true, destructive: true });
  });
});

describe("confirm copy", () => {
  test("only destructive file actions confirm", () => {
    expect(gitFileConfirmCopy("stage", "a.ts")).toBeNull();
    expect(gitFileConfirmCopy("discard_unstaged", "a.ts")).toMatchObject({
      confirmLabel: "Discard",
    });
    expect(gitFileConfirmCopy("delete_untracked", "a.ts")).toMatchObject({
      confirmLabel: "Delete",
    });
  });

  test("repo confirmations mention kept work", () => {
    expect(gitRepoConfirmCopy("stage_all", 3)).toBeNull();
    expect(gitRepoConfirmCopy("discard_all_unstaged", 2)?.message).toContain(
      "Staged changes are kept",
    );
    expect(gitRepoConfirmCopy("delete_all_untracked", 1)?.message).toContain(
      "1 file",
    );
  });
});
