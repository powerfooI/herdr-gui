import type { GitDiffEntry } from "./types";

export type GitDiffCode = "U" | "A" | "M" | "D" | "C";

export function gitDiffCode(
  entry: Pick<GitDiffEntry, "kind" | "status">,
): GitDiffCode {
  if (entry.kind === "conflicted") return "C";
  if (entry.kind === "untracked") return "U";

  switch (entry.status.toLowerCase()) {
    case "a":
    case "added":
      return "A";
    case "d":
    case "deleted":
      return "D";
    default:
      return "M";
  }
}

export function gitDiffCodeLabel(code: GitDiffCode): string {
  switch (code) {
    case "U":
      return "Untracked";
    case "C":
      return "Conflict";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "M":
      return "Modified";
    default:
      return "Unknown";
  }
}
