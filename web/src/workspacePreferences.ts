import type { Workspace } from "./types";
import {
  isWorkspacePreferenceKey,
  workspacePreferenceKey,
} from "./workspaceIdentity";

export const MAX_WORKSPACE_PREFERENCES = 256;
export const MAX_WORKSPACE_PREFERENCE_KEY_LENGTH = 2048;

export function parseWorkspacePreferenceKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
      if (keys.length >= MAX_WORKSPACE_PREFERENCES) break;
      if (
        typeof candidate !== "string" ||
        candidate.length > MAX_WORKSPACE_PREFERENCE_KEY_LENGTH ||
        !isWorkspacePreferenceKey(candidate) ||
        seen.has(candidate)
      ) {
        continue;
      }
      seen.add(candidate);
      keys.push(candidate);
    }
    return keys;
  } catch {
    return [];
  }
}

export function serializeWorkspacePreferenceKeys(
  keys: readonly string[],
): string {
  return JSON.stringify(parseWorkspacePreferenceKeys(JSON.stringify(keys)));
}

export function setWorkspacePreferenceKey(
  keys: readonly string[],
  key: string,
  enabled: boolean,
): string[] {
  const normalized = parseWorkspacePreferenceKeys(JSON.stringify(keys));
  const withoutKey = normalized.filter((candidate) => candidate !== key);
  if (!enabled) return withoutKey;
  // Preferences are insertion ordered. Discard the oldest item at capacity so
  // a user's newest explicit action always takes effect.
  return [...withoutKey, key].slice(-MAX_WORKSPACE_PREFERENCES);
}

export function pruneClosedWorkspacePreferenceKeys(
  keys: readonly string[],
  workspaces: readonly Workspace[],
): string[] {
  const liveWorkspaceKeys = new Set(
    workspaces
      .map(workspacePreferenceKey)
      .filter((key) => key.startsWith("workspace:")),
  );
  return parseWorkspacePreferenceKeys(JSON.stringify(keys)).filter(
    (key) => key.startsWith("worktree:") || liveWorkspaceKeys.has(key),
  );
}
