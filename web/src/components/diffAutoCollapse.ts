import type { GitDiffEntry, GitDiffFile } from "../types";

export const LARGE_DIFF_CHANGED_LINES = 1000;

export type DiffAutoCollapseInfo = {
  reason: "generated" | "large" | "truncated";
  label: string;
};

export function diffChangedLineCount(entry: GitDiffEntry) {
  return (entry.additions ?? 0) + (entry.deletions ?? 0);
}

export function diffAutoCollapseInfo(
  entry: GitDiffEntry,
  file?: GitDiffFile | null,
): DiffAutoCollapseInfo | null {
  if (entry.generated) {
    return { reason: "generated", label: "generated file" };
  }
  if (file?.truncated) {
    return { reason: "truncated", label: "large diff" };
  }
  const changedLines = diffChangedLineCount(entry);
  if (changedLines >= LARGE_DIFF_CHANGED_LINES) {
    return {
      reason: "large",
      label: `${changedLines.toLocaleString("en-US")} changed lines`,
    };
  }
  return null;
}
