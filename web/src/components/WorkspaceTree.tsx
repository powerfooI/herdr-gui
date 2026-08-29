import { shallowEqual, store, useStoreSelector } from "../store";
import type { GitStatusSummary, Pane, Workspace } from "../types";
import { shortId } from "../utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { buildWorkspaceHierarchy, worktreeCreationSource } from "../worktree";
import { ChevronDown, ChevronRight, GitBranch, Pin } from "lucide-react";
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
import {
  WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
  type WorkspaceAgentLayout,
  parseWorkspaceAgentLayout,
} from "../workspaceAgentLayout";
import { useConnectionClient } from "../useConnectionClient";
import { activePaneIdForSnapshot } from "../paneJump";
import { ConfirmDialog } from "./ModalDialogs";
import {
  AgentContextMenu,
  type AgentMenuState,
  AgentRow,
} from "./WorkspaceAgentRows";
import {
  exportSessionForConnection,
  groupAgentPanesByWorkspace,
  paneHasAgentHistory,
} from "./agentSession";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
  workspaceTreeItemIsTabStop,
} from "./treeKeyboard";
import { TREE_DEPTH_INDENT } from "./treeIndent";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const EMPTY_AGENT_PANES_BY_WORKSPACE = new Map<string, Pane[]>();

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

function AgentLayoutControl({
  value,
  onChange,
}: {
  value: WorkspaceAgentLayout;
  onChange: (value: WorkspaceAgentLayout) => void;
}) {
  return (
    <div className="workspace-agent-layout-control">
      <span>Agents</span>
      <div role="group" aria-label="Agent list layout">
        <button
          type="button"
          className={value === "nested" ? "is-active" : ""}
          aria-pressed={value === "nested"}
          onClick={() => onChange("nested")}
        >
          Nested
        </button>
        <button
          type="button"
          className={value === "separate" ? "is-active" : ""}
          aria-pressed={value === "separate"}
          onClick={() => onChange("separate")}
        >
          Separate
        </button>
      </div>
    </div>
  );
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

export function WorkspaceTree({
  onSelect,
  onBrowseFiles,
  onReviewChanges,
  onSelectAgent,
  onBrowseFilesForAgent,
  onReviewChangesForAgent,
  onViewAgentHistory,
}: {
  onSelect?: (workspace: Workspace) => void;
  onBrowseFiles?: (workspace: Workspace) => void;
  onReviewChanges?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onBrowseFilesForAgent?: (pane: Pane) => void;
  onReviewChangesForAgent?: (pane: Pane) => void;
  onViewAgentHistory?: (pane: Pane) => void;
}) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      lastRefresh: state.lastRefresh,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const connectionClient = useConnectionClient();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [agentMenu, setAgentMenu] = useState<AgentMenuState | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<Pane | null>(null);
  const [agentLayout, setAgentLayout] = useState<WorkspaceAgentLayout>(() =>
    parseWorkspaceAgentLayout(
      localStorage.getItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY),
    ),
  );
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
  const activePaneId = activePaneIdForSnapshot(s) ?? null;
  const agentsByWorkspace = useMemo(
    () => groupAgentPanesByWorkspace(s.panes),
    [s.panes],
  );
  const agentPanes = useMemo(() => {
    const workspaceNumbers = new Map(
      s.workspaces.map((workspace) => [
        workspace.workspace_id,
        workspace.number,
      ]),
    );
    return s.panes.filter(paneHasAgentHistory).sort((left, right) => {
      const workspaceOrder =
        (workspaceNumbers.get(left.workspace_id) ?? 0) -
        (workspaceNumbers.get(right.workspace_id) ?? 0);
      return workspaceOrder || left.pane_id.localeCompare(right.pane_id);
    });
  }, [s.panes, s.workspaces]);

  useEffect(() => {
    setMenu(null);
    setAgentMenu(null);
    setPendingClosePane(null);
  }, [connectionClient]);
  useEffect(() => {
    localStorage.setItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, agentLayout);
  }, [agentLayout]);
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
      } else if (event.key === WORKSPACE_AGENT_LAYOUT_STORAGE_KEY) {
        setAgentLayout(parseWorkspaceAgentLayout(event.newValue));
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
        <div className="panel tree workspace-tree-panel" tabIndex={-1}>
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
          <div className="workspace-tree-content">
            <p className="muted">
              {s.status === "connected"
                ? "No workspaces."
                : "Connect to the bridge to load workspaces."}
            </p>
          </div>
          <AgentLayoutControl value={agentLayout} onChange={setAgentLayout} />
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
      <div className="panel tree workspace-tree-panel" tabIndex={-1}>
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
        <div
          className="workspace-tree-content"
          role="tree"
          aria-label="Workspaces and agents"
        >
          {topLevel.map((w) => (
            <WorkspaceRow
              key={w.workspace_id}
              w={w}
              depth={0}
              childrenByParent={childrenByParent}
              agentsByWorkspace={
                agentLayout === "nested"
                  ? agentsByWorkspace
                  : EMPTY_AGENT_PANES_BY_WORKSPACE
              }
              activePaneId={activePaneId}
              pinnedWorkspaceKeys={pinnedWorkspaceSet}
              collapsedWorktreeGroupKeys={collapsedWorktreeGroupSet}
              onCollapsedChange={updateCollapsedWorktreeGroup}
              onSelect={onSelect}
              onSelectAgent={onSelectAgent}
              onAgentContextMenu={(pane, x, y) => setAgentMenu({ pane, x, y })}
              onContextMenu={(w, x, y) => setMenu({ workspace: w, x, y })}
            />
          ))}
        </div>
        <AgentLayoutControl value={agentLayout} onChange={setAgentLayout} />
      </div>
      {agentLayout === "separate" ? (
        <div className="panel agents-panel">
          <h2>Agents</h2>
          <div className="agents-list">
            {agentPanes.length > 0 ? (
              agentPanes.map((pane) => {
                const workspace = s.workspaces.find(
                  (candidate) => candidate.workspace_id === pane.workspace_id,
                );
                return (
                  <AgentRow
                    key={pane.pane_id}
                    pane={pane}
                    selected={
                      pane.pane_id === activePaneId ||
                      (!activePaneId && pane.focused)
                    }
                    showPaneId
                    variant="standalone"
                    workspaceLabel={
                      workspace
                        ? workspaceDisplayName(workspace)
                        : pane.workspace_id
                    }
                    onSelect={onSelectAgent}
                    onOpenMenu={(x, y) => setAgentMenu({ pane, x, y })}
                  />
                );
              })
            ) : (
              <p className="muted">No agent sessions.</p>
            )}
          </div>
        </div>
      ) : null}
      <ContextMenu
        state={menu}
        pinnedWorkspaceKeys={pinnedWorkspaceSet}
        onPinnedChange={updatePinnedWorkspace}
        onBrowseFiles={onBrowseFiles}
        onReviewChanges={onReviewChanges}
        onClose={() => setMenu(null)}
      />
      <AgentContextMenu
        state={agentMenu}
        onClose={() => setAgentMenu(null)}
        onFocus={(pane) => {
          void store.focusPane(pane.pane_id);
          onSelectAgent?.(pane);
        }}
        onBrowseFiles={onBrowseFilesForAgent}
        onReviewChanges={onReviewChangesForAgent}
        onViewHistory={onViewAgentHistory}
        onExportSession={(pane) =>
          exportSessionForConnection(pane, connectionClient)
        }
        onClosePane={setPendingClosePane}
      />
      <ConfirmDialog
        open={!!pendingClosePane}
        title="Close Agent Pane"
        message={
          pendingClosePane
            ? `Close pane "${shortId(pendingClosePane.pane_id)}"?`
            : "Close this pane?"
        }
        confirmLabel="Close"
        danger
        onClose={() => setPendingClosePane(null)}
        onConfirm={() => {
          if (pendingClosePane) store.closePane(pendingClosePane.pane_id);
        }}
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

function workspaceSubtreeContainsActiveItem(
  workspace: Workspace,
  childrenByParent: ReadonlyMap<string, Workspace[]>,
  agentsByWorkspace: ReadonlyMap<string, Pane[]>,
  activePaneId: string | null,
): boolean {
  if (workspace.focused) return true;
  const agents = agentsByWorkspace.get(workspace.workspace_id) ?? [];
  if (
    agents.some(
      (pane) =>
        pane.pane_id === activePaneId || (!activePaneId && pane.focused),
    )
  ) {
    return true;
  }
  return (childrenByParent.get(workspace.workspace_id) ?? []).some((child) =>
    workspaceSubtreeContainsActiveItem(
      child,
      childrenByParent,
      agentsByWorkspace,
      activePaneId,
    ),
  );
}

function WorkspaceRow({
  w,
  depth,
  childrenByParent,
  agentsByWorkspace,
  activePaneId,
  pinnedWorkspaceKeys,
  collapsedWorktreeGroupKeys,
  onCollapsedChange,
  onSelect,
  onSelectAgent,
  onAgentContextMenu,
  onContextMenu,
}: {
  w: Workspace;
  depth: number;
  childrenByParent: Map<string, Workspace[]>;
  agentsByWorkspace: ReadonlyMap<string, Pane[]>;
  activePaneId: string | null;
  pinnedWorkspaceKeys: ReadonlySet<string>;
  collapsedWorktreeGroupKeys: ReadonlySet<string>;
  onCollapsedChange: (workspace: Workspace, collapsed: boolean) => void;
  onSelect?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onAgentContextMenu: (pane: Pane, x: number, y: number) => void;
  onContextMenu: (w: Workspace, x: number, y: number) => void;
}) {
  const children = childrenByParent.get(w.workspace_id) ?? [];
  const agents = agentsByWorkspace.get(w.workspace_id) ?? [];
  const s = useStoreSelector(
    (state) => ({
      pendingFocusWorkspaceId: state.pendingFocusWorkspaceId,
    }),
    shallowEqual,
  );
  const isChild = depth > 0;
  const hasChildren = children.length > 0;
  const hasNestedItems = hasChildren || agents.length > 0;
  const hasActiveAgent = agents.some(
    (pane) => pane.pane_id === activePaneId || (!activePaneId && pane.focused),
  );
  const hiddenDescendantActive = children.some((child) =>
    workspaceSubtreeContainsActiveItem(
      child,
      childrenByParent,
      agentsByWorkspace,
      activePaneId,
    ),
  );
  const collapsed =
    hasNestedItems && isWorktreeGroupCollapsed(collapsedWorktreeGroupKeys, w);
  const pinned = isWorkspacePinned(pinnedWorkspaceKeys, w);
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
  const selectWorkspace = () => {
    store.focusWorkspace(w.workspace_id);
    onSelect?.(w);
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
          hasActiveAgent ? "has-active-agent" : ""
        } ${isChild ? "is-child" : ""} ${pinned ? "is-pinned" : ""} ${
          isPendingFocus ? "is-loading" : ""
        }`}
        style={{ paddingLeft: 6 + depth * TREE_DEPTH_INDENT }}
        role="treeitem"
        tabIndex={
          workspaceTreeItemIsTabStop({
            workspaceFocused: w.focused,
            directAgentActive: hasActiveAgent,
            collapsed,
            hiddenDescendantActive,
          })
            ? 0
            : -1
        }
        aria-level={depth + 1}
        aria-selected={w.focused}
        aria-expanded={hasNestedItems ? !collapsed : undefined}
        onClick={(e) => {
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          selectWorkspace();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const action = treeKeyboardAction(event.key, event.shiftKey);
          if (!action) return;
          if (
            action === "next" ||
            action === "previous" ||
            action === "first" ||
            action === "last"
          ) {
            event.preventDefault();
            focusTreeItem(event.currentTarget, action);
            return;
          }
          if (action === "expand") {
            event.preventDefault();
            if (hasNestedItems && collapsed) {
              onCollapsedChange(w, false);
            } else {
              focusTreeItem(event.currentTarget, "next");
            }
            return;
          }
          if (action === "collapse") {
            event.preventDefault();
            if (hasNestedItems && !collapsed) {
              onCollapsedChange(w, true);
            } else {
              focusTreeItem(event.currentTarget, "previous");
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (action === "activate") {
            selectWorkspace();
          } else {
            const point = keyboardContextMenuPoint(event.currentTarget);
            openMenu(point.x, point.y);
          }
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
        {hasNestedItems ? (
          <button
            type="button"
            className="workspace-group-toggle"
            tabIndex={-1}
            title={collapsed ? "Expand workspace" : "Collapse workspace"}
            aria-label={collapsed ? "Expand workspace" : "Collapse workspace"}
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
          <span className="twisty" aria-hidden="true" />
        )}
        <strong className="ws-label">{workspaceDisplayName(w)}</strong>
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
      </div>
      {!collapsed ? (
        <>
          {agents.map((pane) => (
            <AgentRow
              key={pane.pane_id}
              pane={pane}
              depth={depth + 1}
              showPaneId={agents.length > 1}
              selected={
                pane.pane_id === activePaneId || (!activePaneId && pane.focused)
              }
              onSelect={onSelectAgent}
              onOpenMenu={(x, y) => onAgentContextMenu(pane, x, y)}
            />
          ))}
          {children.map((child) => (
            <WorkspaceRow
              key={child.workspace_id}
              w={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              agentsByWorkspace={agentsByWorkspace}
              activePaneId={activePaneId}
              pinnedWorkspaceKeys={pinnedWorkspaceKeys}
              collapsedWorktreeGroupKeys={collapsedWorktreeGroupKeys}
              onCollapsedChange={onCollapsedChange}
              onSelect={onSelect}
              onSelectAgent={onSelectAgent}
              onAgentContextMenu={onAgentContextMenu}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
