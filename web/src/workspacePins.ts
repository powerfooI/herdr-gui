import type { Workspace } from "./types";
import { workspacePreferenceKey } from "./workspaceIdentity";
import {
  parseWorkspacePreferenceKeys,
  serializeWorkspacePreferenceKeys,
  setWorkspacePreferenceKey,
} from "./workspacePreferences";

export const WORKSPACE_PINS_STORAGE_KEY = "workspacePins.v1";

export const workspacePinKey = workspacePreferenceKey;
export const parseWorkspacePins = parseWorkspacePreferenceKeys;
export const serializeWorkspacePins = serializeWorkspacePreferenceKeys;

export function isWorkspacePinned(
  pins: ReadonlySet<string>,
  workspace: Workspace,
): boolean {
  return pins.has(workspacePinKey(workspace));
}

export function setWorkspacePinned(
  pins: readonly string[],
  workspace: Workspace,
  pinned: boolean,
): string[] {
  return setWorkspacePreferenceKey(pins, workspacePinKey(workspace), pinned);
}
