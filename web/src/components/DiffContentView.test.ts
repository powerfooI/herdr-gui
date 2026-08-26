import { describe, expect, test } from "bun:test";
import type { GitDiffEntry, GitDiffFile } from "../types";
import {
  diffContentEntries,
  diffHunkTargets,
  diffSearchGroups,
  nextDiffHunkIndex,
} from "./DiffContentView";

const entries: GitDiffEntry[] = [
  { path: "src/one.ts", kind: "unstaged", status: "M" },
  { path: "src/two.ts", kind: "unstaged", status: "M" },
  { path: "asset.png", kind: "unstaged", status: "M" },
];

function diffFile(path: string, diff: string): GitDiffFile {
  return {
    workspace_id: "workspace",
    root: "/tmp/workspace",
    path,
    kind: "unstaged",
    diff,
    truncated: false,
  };
}

describe("diffContentEntries", () => {
  test("keeps every summary entry even when only one diff is loaded", () => {
    expect(diffContentEntries(entries, entries[0])).toBe(entries);
  });

  test("falls back to the selected entry before a summary is available", () => {
    expect(diffContentEntries([], entries[0])).toEqual([entries[0]]);
    expect(diffContentEntries([], null)).toEqual([]);
  });
});

describe("diffHunkTargets", () => {
  test("starts navigation at the first or last hunk", () => {
    expect(nextDiffHunkIndex(-1, 1, 3)).toBe(0);
    expect(nextDiffHunkIndex(-1, -1, 3)).toBe(2);
    expect(nextDiffHunkIndex(2, 1, 3)).toBe(0);
    expect(nextDiffHunkIndex(0, -1, 3)).toBe(2);
    expect(nextDiffHunkIndex(0, 1, 0)).toBe(-1);
  });

  test("locates the first changed lines in each patch hunk", () => {
    expect(
      diffHunkTargets(
        [
          "@@ -3,4 +3,5 @@",
          " context",
          "-before",
          "+after",
          "+added",
          "@@ -20,2 +21,0 @@",
          "-removed",
        ].join("\n"),
      ),
    ).toEqual([
      { oldLine: 4, newLine: 4 },
      { oldLine: 20, newLine: null },
    ]);
  });
});

describe("diffSearchGroups", () => {
  test("finds loaded files case-insensitively without double-counting lines", () => {
    const result = diffSearchGroups(
      entries,
      {
        "unstaged:src/one.ts": diffFile(
          "src/one.ts",
          "diff --git a/src/one.ts b/src/one.ts\n+Needle needle\n",
        ),
        "unstaged:src/two.ts": diffFile(
          "src/two.ts",
          "diff --git a/src/two.ts b/src/two.ts\n-needle\n",
        ),
      },
      "needle",
    );

    expect(result).toEqual({
      groups: [{ key: "unstaged:src/one.ts" }, { key: "unstaged:src/two.ts" }],
      count: 2,
    });
  });

  test("ignores unloaded and binary diffs", () => {
    const result = diffSearchGroups(
      entries,
      {
        "unstaged:asset.png": diffFile(
          "asset.png",
          "Binary files contain needle",
        ),
      },
      "needle",
    );

    expect(result).toEqual({ groups: [], count: 0 });
  });
});
