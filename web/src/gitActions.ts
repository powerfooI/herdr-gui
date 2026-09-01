import type { GitDiffEntry } from "./types";

export type GitFileAction =
  | "stage"
  | "unstage"
  | "discard_unstaged"
  | "delete_untracked";

export type GitRepoAction =
  | "stage_all"
  | "unstage_all"
  | "discard_all_unstaged"
  | "delete_all_untracked";

export type GitFileMenuItem = {
  action: GitFileAction;
  label: string;
  danger?: boolean;
  destructive?: boolean;
};

export type GitRepoMenuItem = {
  action: GitRepoAction;
  label: string;
  count: number;
  danger?: boolean;
  destructive?: boolean;
};

export type GitWorkingCounts = {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
};

// Builds the Git menu for one changed file from every summary entry sharing
// its path, so combined states (staged + unstaged) get the matching actions.
export function buildGitFileMenuItems(
  entries: Pick<GitDiffEntry, "kind">[],
): GitFileMenuItem[] {
  const kinds = new Set(entries.map((entry) => entry.kind));
  const items: GitFileMenuItem[] = [];
  if (kinds.has("untracked")) {
    items.push({ action: "stage", label: "Stage file" });
  } else if (kinds.has("conflicted")) {
    items.push({ action: "stage", label: "Mark resolved" });
  } else if (kinds.has("unstaged")) {
    items.push({ action: "stage", label: "Stage changes" });
  }
  if (kinds.has("staged")) {
    items.push({ action: "unstage", label: "Unstage changes" });
  }
  if (kinds.has("unstaged")) {
    items.push({
      action: "discard_unstaged",
      label: "Discard unstaged changes…",
      danger: true,
      destructive: true,
    });
  }
  if (kinds.has("untracked")) {
    items.push({
      action: "delete_untracked",
      label: "Delete untracked file…",
      danger: true,
      destructive: true,
    });
  }
  return items;
}

export function countWorkingEntries(entries: GitDiffEntry[]): GitWorkingCounts {
  const counts: GitWorkingCounts = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
  for (const entry of entries) {
    if (
      entry.kind === "staged" ||
      entry.kind === "unstaged" ||
      entry.kind === "untracked" ||
      entry.kind === "conflicted"
    ) {
      counts[entry.kind] += 1;
    }
  }
  return counts;
}

export function buildGitRepoMenuItems(
  counts: GitWorkingCounts,
): GitRepoMenuItem[] {
  return [
    {
      action: "stage_all",
      label: "Stage All Changes",
      count: counts.unstaged + counts.untracked + counts.conflicted,
    },
    {
      action: "unstage_all",
      label: "Unstage All Changes",
      count: counts.staged,
    },
    {
      action: "discard_all_unstaged",
      label: "Discard All Unstaged Changes…",
      count: counts.unstaged,
      danger: true,
      destructive: true,
    },
    {
      action: "delete_all_untracked",
      label: "Delete All Untracked Files…",
      count: counts.untracked,
      danger: true,
      destructive: true,
    },
  ];
}

export function gitFileActionSuccessMessage(action: GitFileAction) {
  switch (action) {
    case "stage":
      return "File staged";
    case "unstage":
      return "Changes unstaged";
    case "discard_unstaged":
      return "Unstaged changes discarded";
    case "delete_untracked":
      return "Untracked file deleted";
  }
}

export function gitRepoActionSuccessMessage(action: GitRepoAction) {
  switch (action) {
    case "stage_all":
      return "All changes staged";
    case "unstage_all":
      return "All changes unstaged";
    case "discard_all_unstaged":
      return "All unstaged changes discarded";
    case "delete_all_untracked":
      return "All untracked files deleted";
  }
}

export function gitFileActionLabel(action: GitFileAction) {
  switch (action) {
    case "stage":
      return "Stage";
    case "unstage":
      return "Unstage";
    case "discard_unstaged":
      return "Discard unstaged changes";
    case "delete_untracked":
      return "Delete untracked file";
  }
}

export function gitFileConfirmCopy(action: GitFileAction, path: string) {
  switch (action) {
    case "discard_unstaged":
      return {
        title: "Discard Changes",
        message: `Discard unstaged changes to "${path}"? Any staged version is kept. This cannot be undone.`,
        confirmLabel: "Discard",
      };
    case "delete_untracked":
      return {
        title: "Delete Untracked File",
        message: `Delete untracked file "${path}"? This cannot be undone.`,
        confirmLabel: "Delete",
      };
    default:
      return null;
  }
}

export function gitRepoConfirmCopy(action: GitRepoAction, count: number) {
  const files = count === 1 ? "1 file" : `${count} files`;
  switch (action) {
    case "discard_all_unstaged":
      return {
        title: "Discard All Unstaged Changes",
        message: `Discard unstaged changes in ${files}? Staged changes are kept. This cannot be undone.`,
        confirmLabel: "Discard All",
      };
    case "delete_all_untracked":
      return {
        title: "Delete All Untracked Files",
        message: `Delete ${files} not tracked by Git? Ignored files are kept. This cannot be undone.`,
        confirmLabel: "Delete All",
      };
    default:
      return null;
  }
}
