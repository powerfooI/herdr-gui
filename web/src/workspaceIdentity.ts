import type { Workspace } from "./types";

const WORKSPACE_KEY_PREFIX = "workspace:";
const WORKTREE_KEY_PREFIX = "worktree:";

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

// A workspace is a live Herdr object, while a linked worktree represents a
// durable checkout that can be closed and reopened under a new workspace id.
// Keep those identities separate: main-checkout workspaces may legitimately
// share a path, so only linked worktrees use repository + checkout identity.
export function workspacePreferenceKey(workspace: Workspace): string {
  const worktree = workspace.worktree;
  const repository =
    worktree?.gui_settings_key?.trim() || worktree?.repo_key.trim();
  const checkoutPath = worktree
    ? normalizedPath(worktree.checkout_path.trim())
    : "";
  if (worktree?.is_linked_worktree === true && repository && checkoutPath) {
    return `${WORKTREE_KEY_PREFIX}${encodeURIComponent(repository)}:${encodeURIComponent(checkoutPath)}`;
  }
  return `${WORKSPACE_KEY_PREFIX}${encodeURIComponent(workspace.workspace_id)}`;
}

function isCanonicalEncodedValue(value: string): boolean {
  if (!value) return false;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && encodeURIComponent(decoded) === value;
  } catch {
    return false;
  }
}

export function isWorkspacePreferenceKey(value: string): boolean {
  if (value.startsWith(WORKSPACE_KEY_PREFIX)) {
    return isCanonicalEncodedValue(value.slice(WORKSPACE_KEY_PREFIX.length));
  }
  if (!value.startsWith(WORKTREE_KEY_PREFIX)) return false;

  const encoded = value.slice(WORKTREE_KEY_PREFIX.length);
  const separator = encoded.indexOf(":");
  return (
    separator > 0 &&
    separator === encoded.lastIndexOf(":") &&
    isCanonicalEncodedValue(encoded.slice(0, separator)) &&
    isCanonicalEncodedValue(encoded.slice(separator + 1))
  );
}
