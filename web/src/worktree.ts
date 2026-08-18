import type { WorktreeList, Workspace } from "./types";
import { isWorkspacePinned } from "./workspacePins";

const EMPTY_WORKSPACE_PINS = new Set<string>();

export type WorktreeOpenSource =
  | { workspaceId: string; cwd?: never }
  | { workspaceId?: never; cwd: string };

// worktree.list accepts a linked checkout and resolves its repository parent,
// while worktree.open rejects that same linked workspace as a source. Use the
// canonical source returned by the list response instead of the current focus.
export function resolveWorktreeOpenSource(
  list: WorktreeList | null,
  explicitWorkspaceId?: string | null,
  explicitCwd?: string | null,
): WorktreeOpenSource | null {
  const listedWorkspaceId = list?.source.source_workspace_id?.trim();
  if (listedWorkspaceId) return { workspaceId: listedWorkspaceId };

  const listedRepoRoot = list?.source.repo_root.trim();
  if (listedRepoRoot) return { cwd: listedRepoRoot };

  const fallbackWorkspaceId = explicitWorkspaceId?.trim();
  if (fallbackWorkspaceId) return { workspaceId: fallbackWorkspaceId };

  const fallbackCwd = explicitCwd?.trim();
  return fallbackCwd ? { cwd: fallbackCwd } : null;
}

// Herdr can resolve a Git repository from the workspace's active pane even
// when workspace.list omits worktree metadata. Only a confirmed linked
// worktree should be excluded from the main-checkout creation action.
export function canCreateWorktree(workspace: Workspace): boolean {
  return workspace.worktree?.is_linked_worktree !== true;
}

// Herdr requires creation to start from a repo's non-linked workspace. Resolve
// that source for linked children so UI actions can still follow the user's
// current context without exposing Herdr's parent-workspace restriction.
export function worktreeCreationSource(
  workspaces: Workspace[],
  workspace: Workspace,
): Workspace | undefined {
  if (!workspace.worktree?.is_linked_worktree) return workspace;

  const explicitParentId = workspace.worktree.parent_workspace_id;
  const explicitParent = explicitParentId
    ? workspaces.find(
        (candidate) => candidate.workspace_id === explicitParentId,
      )
    : undefined;
  if (
    explicitParent &&
    explicitParent.worktree?.is_linked_worktree === false &&
    explicitParent.worktree.repo_key === workspace.worktree.repo_key
  ) {
    return explicitParent;
  }

  const candidates = workspaces.filter(
    (candidate) =>
      candidate.worktree?.is_linked_worktree === false &&
      candidate.worktree.repo_key === workspace.worktree?.repo_key,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export type WorkspaceHierarchy = {
  topLevel: Workspace[];
  childrenByParent: Map<string, Workspace[]>;
};

// A repository can have several ordinary workspaces, so repo_key alone does
// not identify the workspace that created a linked worktree. Prefer the
// bridge's explicit association and only use repo_key when it is unambiguous.
export function buildWorkspaceHierarchy(
  workspaces: Workspace[],
  pinnedWorkspaceKeys: ReadonlySet<string> = EMPTY_WORKSPACE_PINS,
): WorkspaceHierarchy {
  const childrenByParent = new Map<string, Workspace[]>();
  const topLevel: Workspace[] = [];
  const pinned = (workspace: Workspace) =>
    isWorkspacePinned(pinnedWorkspaceKeys, workspace);
  for (const workspace of workspaces) {
    if (!workspace.worktree?.is_linked_worktree || pinned(workspace)) {
      topLevel.push(workspace);
      continue;
    }

    const parent = worktreeCreationSource(workspaces, workspace);

    if (!parent) {
      topLevel.push(workspace);
      continue;
    }
    const children = childrenByParent.get(parent.workspace_id) ?? [];
    children.push(workspace);
    childrenByParent.set(parent.workspace_id, children);
  }

  topLevel.sort(
    (a, b) => Number(pinned(b)) - Number(pinned(a)) || a.number - b.number,
  );
  childrenByParent.forEach((children) =>
    children.sort((a, b) => a.number - b.number),
  );
  return { topLevel, childrenByParent };
}
