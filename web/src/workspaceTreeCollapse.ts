import type { Workspace } from "./types";
import { workspacePreferenceKey } from "./workspaceIdentity";
import {
  parseWorkspacePreferenceKeys,
  serializeWorkspacePreferenceKeys,
  setWorkspacePreferenceKey,
} from "./workspacePreferences";

export const COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY =
  "collapsedWorktreeGroups.v1";

export const worktreeGroupKey = workspacePreferenceKey;
export const parseCollapsedWorktreeGroups = parseWorkspacePreferenceKeys;
export const serializeCollapsedWorktreeGroups =
  serializeWorkspacePreferenceKeys;

export function isWorktreeGroupCollapsed(
  groups: ReadonlySet<string>,
  workspace: Workspace,
): boolean {
  return groups.has(worktreeGroupKey(workspace));
}

export function setWorktreeGroupCollapsed(
  groups: readonly string[],
  workspace: Workspace,
  collapsed: boolean,
): string[] {
  return setWorkspacePreferenceKey(
    groups,
    worktreeGroupKey(workspace),
    collapsed,
  );
}
