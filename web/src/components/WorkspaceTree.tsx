import { useStore, store } from "../store";
import type { GitStatusSummary, Workspace } from "../types";
import { agentClass } from "../utils";
import { useEffect, useRef, useState } from "react";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { buildWorkspaceHierarchy, worktreeCreationSource } from "../worktree";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitFork,
  Pin,
} from "lucide-react";
import { WorktreeLifecycleDialog } from "./WorktreeLifecycleDialog";
import {
  WORKSPACE_PINS_STORAGE_KEY,
  isWorkspacePinned,
  parseWorkspacePins,
  serializeWorkspacePins,
  setWorkspacePinned,
} from "../workspacePins";
import {
  COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  isWorktreeGroupCollapsed,
  parseCollapsedWorktreeGroups,
  serializeCollapsedWorktreeGroups,
  setWorktreeGroupCollapsed,
} from "../workspaceTreeCollapse";
import {
  showWorkspaceBranchBadge,
  workspaceDisplayName,
} from "../workspaceTreeBadges";
import { pruneClosedWorkspacePreferenceKeys } from "../workspacePreferences";
import { connectionStorageKey } from "../connectionStorage";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function gitChangedCount(status: GitStatusSummary) {
  return status.staged + status.unstaged + status.untracked + status.conflicted;
}

function gitStatusTitle(status?: GitStatusSummary) {
  if (!status) return "";
  if (status.error) return `git status unavailable: ${status.error}`;
  const parts = [
    status.branch ? `branch: ${status.branch}` : null,
    status.upstream ? `upstream: ${status.upstream}` : null,
    status.ahead ? `ahead: ${status.ahead}` : null,
    status.behind ? `behind: ${status.behind}` : null,
    status.staged ? `staged: ${status.staged}` : null,
    status.unstaged ? `unstaged: ${status.unstaged}` : null,
    status.untracked ? `untracked: ${status.untracked}` : null,
    status.conflicted ? `conflicted: ${status.conflicted}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function GitStatusBadges({
  status,
  showBranch = true,
}: {
  status?: GitStatusSummary;
  showBranch?: boolean;
}) {
  if (!status) return null;
  if (status.error) {
    return (
      <span
        className="git-badge git-badge-error"
        title={gitStatusTitle(status)}
      >
        git?
      </span>
    );
  }

  const changed = gitChangedCount(status);
  const branch = status.branch || "git";
  const hasVisibleBadge =
    showBranch || changed > 0 || status.ahead > 0 || status.behind > 0;
  if (!hasVisibleBadge) return null;
  return (
    <span className="git-status" title={gitStatusTitle(status)}>
      {showBranch ? (
        <span className="git-badge git-branch">{branch}</span>
      ) : null}
      {changed > 0 ? (
        <span className="git-badge git-dirty">Δ{changed}</span>
      ) : null}
      {status.ahead > 0 ? (
        <span className="git-badge git-ahead">↑{status.ahead}</span>
      ) : null}
      {status.behind > 0 ? (
        <span className="git-badge git-behind">↓{status.behind}</span>
      ) : null}
    </span>
  );
}

export function WorkspaceTree({ onSelect }: { onSelect?: () => void }) {
  const s = useStore();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState<
    string | null
  >(null);
  const lastPrunedWorkspaceRefresh = useRef(0);
  const pinsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    WORKSPACE_PINS_STORAGE_KEY,
  );
  const collapsedGroupsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  );
  const [pinnedWorkspaceKeys, setPinnedWorkspaceKeys] = useState<string[]>(() =>
    parseWorkspacePins(localStorage.getItem(pinsStorageKey)),
  );
  const [collapsedWorktreeGroupKeys, setCollapsedWorktreeGroupKeys] = useState<
    string[]
  >(() =>
    parseCollapsedWorktreeGroups(
      localStorage.getItem(collapsedGroupsStorageKey),
    ),
  );
  const pinnedWorkspaceSet = new Set(pinnedWorkspaceKeys);
  const collapsedWorktreeGroupSet = new Set(collapsedWorktreeGroupKeys);

  useEffect(() => {
    localStorage.setItem(
      pinsStorageKey,
      serializeWorkspacePins(pinnedWorkspaceKeys),
    );
  }, [pinnedWorkspaceKeys, pinsStorageKey]);
  useEffect(() => {
    localStorage.setItem(
      collapsedGroupsStorageKey,
      serializeCollapsedWorktreeGroups(collapsedWorktreeGroupKeys),
    );
  }, [collapsedGroupsStorageKey, collapsedWorktreeGroupKeys]);
  useEffect(() => {
    if (
      s.status !== "connected" ||
      s.lastRefresh === 0 ||
      s.lastRefresh <= lastPrunedWorkspaceRefresh.current
    ) {
      return;
    }
    lastPrunedWorkspaceRefresh.current = s.lastRefresh;
    setPinnedWorkspaceKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
    setCollapsedWorktreeGroupKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
  }, [s.lastRefresh, s.status, s.workspaces]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === pinsStorageKey) {
        setPinnedWorkspaceKeys(parseWorkspacePins(event.newValue));
      } else if (event.key === collapsedGroupsStorageKey) {
        setCollapsedWorktreeGroupKeys(
          parseCollapsedWorktreeGroups(event.newValue),
        );
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [collapsedGroupsStorageKey, pinsStorageKey]);

  const updatePinnedWorkspace = (workspace: Workspace, pinned: boolean) => {
    setPinnedWorkspaceKeys((current) =>
      setWorkspacePinned(current, workspace, pinned),
    );
    if (!pinned && workspace.worktree?.is_linked_worktree) {
      const parent = worktreeCreationSource(s.workspaces, workspace);
      if (parent) {
        setCollapsedWorktreeGroupKeys((current) =>
          setWorktreeGroupCollapsed(current, parent, false),
        );
      }
    }
  };
  const updateCollapsedWorktreeGroup = (
    workspace: Workspace,
    collapsed: boolean,
  ) => {
    setCollapsedWorktreeGroupKeys((current) =>
      setWorktreeGroupCollapsed(current, workspace, collapsed),
    );
  };

  if (s.workspaces.length === 0) {
    return (
      <>
        <div className="panel">
          <div className="panel-head">
            <h2>Workspaces</h2>
            <button
              className="panel-add"
              title="New workspace"
              onClick={() => setCreateOpen(true)}
            >
              +
            </button>
          </div>
          <p className="muted">
            {s.status === "connected"
              ? "No workspaces."
              : "Connect to the bridge to load workspaces."}
          </p>
        </div>
        <CreateWorkspaceDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      </>
    );
  }

  const { topLevel, childrenByParent } = buildWorkspaceHierarchy(
    s.workspaces,
    pinnedWorkspaceSet,
  );
  const focusedRepoWorkspace = s.workspaces.find(
    (workspace) => workspace.focused && workspace.worktree,
  );

  return (
    <>
      <div className="panel tree">
        <div className="panel-head">
          <h2>Workspaces</h2>
          <div className="panel-actions">
            {focusedRepoWorkspace ? (
              <button
                type="button"
                className="panel-add panel-action-icon"
                title="Worktree lifecycle"
                aria-label="Open worktree lifecycle"
                onClick={() =>
                  setLifecycleWorkspaceId(focusedRepoWorkspace.workspace_id)
                }
              >
                <GitBranch size={14} />
              </button>
            ) : null}
            <button
              className="panel-add"
              title="New workspace"
              onClick={() => setCreateOpen(true)}
            >
              +
            </button>
          </div>
        </div>
        {topLevel.map((w) => (
          <WorkspaceRow
            key={w.workspace_id}
            w={w}
            depth={0}
            childrenByParent={childrenByParent}
            pinnedWorkspaceKeys={pinnedWorkspaceSet}
            collapsedWorktreeGroupKeys={collapsedWorktreeGroupSet}
            onCollapsedChange={updateCollapsedWorktreeGroup}
            onSelect={onSelect}
            onContextMenu={(w, x, y) => setMenu({ workspace: w, x, y })}
          />
        ))}
      </div>
      <ContextMenu
        state={menu}
        pinnedWorkspaceKeys={pinnedWorkspaceSet}
        onPinnedChange={updatePinnedWorkspace}
        onClose={() => setMenu(null)}
      />
      <CreateWorkspaceDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <WorktreeLifecycleDialog
        open={!!lifecycleWorkspaceId}
        workspaceId={lifecycleWorkspaceId}
        onClose={() => setLifecycleWorkspaceId(null)}
      />
    </>
  );
}

function WorkspaceRow({
  w,
  depth,
  childrenByParent,
  pinnedWorkspaceKeys,
  collapsedWorktreeGroupKeys,
  onCollapsedChange,
  onSelect,
  onContextMenu,
}: {
  w: Workspace;
  depth: number;
  childrenByParent: Map<string, Workspace[]>;
  pinnedWorkspaceKeys: ReadonlySet<string>;
  collapsedWorktreeGroupKeys: ReadonlySet<string>;
  onCollapsedChange: (workspace: Workspace, collapsed: boolean) => void;
  onSelect?: () => void;
  onContextMenu: (w: Workspace, x: number, y: number) => void;
}) {
  const children = childrenByParent.get(w.workspace_id) ?? [];
  const s = useStore();
  const isChild = depth > 0;
  const hasChildren = children.length > 0;
  const collapsed =
    hasChildren && isWorktreeGroupCollapsed(collapsedWorktreeGroupKeys, w);
  const pinned = isWorkspacePinned(pinnedWorkspaceKeys, w);
  const worktreeMarkerRepoName =
    w.worktree?.is_linked_worktree === true ? w.worktree.repo_name : null;
  const compactWorktreeMarker = isChild && !pinned;
  const isPendingFocus =
    s.pendingFocusWorkspaceId === w.workspace_id && !w.focused;
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);

  const clearLongPressTimer = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => clearLongPressTimer, []);

  const openMenu = (x: number, y: number) => {
    onContextMenu(w, x, y);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    longPressTriggered.current = false;
    longPressStart.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      openMenu(e.clientX, e.clientY);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = longPressStart.current;
    if (!start) return;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
      longPressStart.current = null;
    }
  };

  const onPointerEnd = () => {
    clearLongPressTimer();
    longPressStart.current = null;
  };

  return (
    <>
      <div
        className={`tree-row clickable-row ${w.focused ? "is-focused" : ""} ${
          isChild ? "is-child" : ""
        } ${pinned ? "is-pinned" : ""} ${isPendingFocus ? "is-loading" : ""}`}
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={(e) => {
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          store.focusWorkspace(w.workspace_id);
          onSelect?.();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={onPointerEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
        title={
          w.worktree
            ? [
                `${w.worktree.repo_name} · ${w.worktree.checkout_path}`,
                gitStatusTitle(w.worktree.git_status),
              ]
                .filter(Boolean)
                .join("\n")
            : w.workspace_id
        }
      >
        {hasChildren ? (
          <button
            type="button"
            className="workspace-group-toggle"
            title={
              collapsed
                ? "Expand linked worktrees"
                : "Collapse linked worktrees"
            }
            aria-label={
              collapsed
                ? "Expand linked worktrees"
                : "Collapse linked worktrees"
            }
            aria-expanded={!collapsed}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openMenu(event.clientX, event.clientY);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCollapsedChange(w, !collapsed);
            }}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span className="twisty">{isChild ? "⌞" : " "}</span>
        )}
        <strong className="ws-label">{workspaceDisplayName(w)}</strong>
        {worktreeMarkerRepoName ? (
          <span
            className={`workspace-worktree-marker ${
              compactWorktreeMarker ? "is-compact" : ""
            }`}
            title={`Linked worktree · ${worktreeMarkerRepoName}`}
            aria-label={`Linked worktree in ${worktreeMarkerRepoName}`}
          >
            <GitFork size={11} aria-hidden="true" />
            {!compactWorktreeMarker ? <span aria-hidden="true">WT</span> : null}
          </span>
        ) : null}
        {pinned ? (
          <Pin
            className="workspace-pin"
            size={11}
            fill="currentColor"
            aria-label="Pinned"
          />
        ) : null}
        {isPendingFocus ? (
          <span className="row-spinner" aria-label="Loading workspace" />
        ) : null}
        {w.worktree ? (
          <GitStatusBadges
            status={w.worktree.git_status}
            showBranch={showWorkspaceBranchBadge(w)}
          />
        ) : null}
        {w.agent_status !== "unknown" ? (
          <span className={agentClass(w.agent_status)}>{w.agent_status}</span>
        ) : null}
      </div>
      {!collapsed
        ? children.map((child) => (
            <WorkspaceRow
              key={child.workspace_id}
              w={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              pinnedWorkspaceKeys={pinnedWorkspaceKeys}
              collapsedWorktreeGroupKeys={collapsedWorktreeGroupKeys}
              onCollapsedChange={onCollapsedChange}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </>
  );
}
