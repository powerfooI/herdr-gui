import { useSyncExternalStore } from "react";
import { bridge, type ConnectionStatus } from "./api";
import {
  clearTerminalRelayViewports,
  forgetTerminalRelayViewportsExcept,
  terminalRelayViewportForTab,
} from "./terminalResize";
import type { Pane, PaneLayout, Tab, Workspace } from "./types";

export interface State {
  status: ConnectionStatus;
  connectionPaused: boolean;
  bridgeStatus: BridgeStatus | null;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  layout: PaneLayout | null;
  /** Latest visible text of each pane currently shown in the layout. */
  paneContents: Record<string, string>;
  selectedPaneId: string | null;
  recentPaneIds: string[];
  error: string | null;
  notice: Notice | null;
  taskNotificationsEnabled: boolean;
  taskNotificationPermission: NotificationPermission | "unsupported";
  updateInfo: UpdateInfo | null;
  updateInstalling: boolean;
  pendingRestartVersion: string | null;
  dismissedUpdateVersion: string | null;
  pendingFocusWorkspaceId: string | null;
  terminalAttachEpoch: number;
  lastRefresh: number;
}

export interface Notice {
  kind: "info" | "success" | "error";
  message: string;
  detail?: string;
  detailMode?: "text" | "output";
  detailTitle?: string;
  loading?: boolean;
  autoDismissMs?: number;
  actionLabel?: string;
  actionWorkspaceId?: string;
  actionPaneId?: string;
  actionClipboardText?: string;
  id?: number;
}

export interface UpdateInfo {
  current_version: string;
  latest_version?: string;
  update_available: boolean;
  can_auto_update: boolean;
  reason?: string;
  platform: string;
  source_url?: string;
  metadata_url?: string;
}

export interface BridgeStatus {
  clients: number;
  terminals: Array<{
    terminal_id: string;
    viewers: number;
  }>;
}

type WorktreeHookEvent =
  | "worktree.created"
  | "worktree.opened"
  | "worktree.before_remove"
  | "worktree.removed";

type WorktreeHookRunResult = {
  event: WorktreeHookEvent;
  status: "skipped" | "succeeded" | "failed";
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type WorktreeRemovalCleanup = {
  terminated_processes?: number;
  recovered_stale_checkout?: boolean;
  preserved_path?: string;
  warning?: string;
};

const TASK_NOTIFICATIONS_KEY = "taskNotificationsEnabled";
const PENDING_UPDATE_RELOAD_KEY = "pendingUpdateReloadVersion";
export const DEFAULT_NOTICE_AUTO_DISMISS_MS = 15 * 1000;
const TASK_COMPLETED_TOAST_DISMISS_MS = DEFAULT_NOTICE_AUTO_DISMISS_MS;
const UPDATE_RESTART_VERIFY_TIMEOUT_MS = 90 * 1000;
const UPDATE_RESTART_VERIFY_INTERVAL_MS = 750;
const RECENT_PANE_LIMIT = 12;

export const TASK_NOTIFICATION_ACTIVATE_EVENT =
  "herdr:task-notification-activate";

export function noticeAutoDismissDelay(notice: Notice): number | null {
  if (notice.loading) return null;
  return notice.autoDismissMs ?? DEFAULT_NOTICE_AUTO_DISMISS_MS;
}

export interface TaskNotificationTarget {
  workspaceId: string;
  paneId: string;
}

type ClickableNotification = Pick<Notification, "close" | "onclick">;

export function isTaskNotificationTarget(
  value: unknown,
): value is TaskNotificationTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<TaskNotificationTarget>;
  return (
    typeof target.workspaceId === "string" &&
    target.workspaceId.length > 0 &&
    typeof target.paneId === "string" &&
    target.paneId.length > 0
  );
}

/** Connect a system notification click to the in-app pane navigation path. */
export function bindTaskNotificationActivation(
  notification: ClickableNotification,
  target: TaskNotificationTarget,
  activate: (target: TaskNotificationTarget) => void = (nextTarget) => {
    window.dispatchEvent(
      new CustomEvent<TaskNotificationTarget>(
        TASK_NOTIFICATION_ACTIVATE_EVENT,
        {
          detail: nextTarget,
        },
      ),
    );
  },
  focusWindow: () => void = () => window.focus(),
) {
  notification.onclick = () => {
    try {
      notification.close();
    } catch {
      // Notification cleanup must not block navigation.
    }
    try {
      focusWindow();
    } catch {
      // Browsers may deny focus even for a notification click.
    }
    activate(target);
  };
}

function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

function storedTaskNotificationsEnabled() {
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem(TASK_NOTIFICATIONS_KEY) === "true"
  );
}

function storedPendingRestartVersion(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    return sessionStorage.getItem(PENDING_UPDATE_RELOAD_KEY);
  } catch {
    return null;
  }
}

function storePendingRestartVersion(version: string | null) {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (version) {
      sessionStorage.setItem(PENDING_UPDATE_RELOAD_KEY, version);
    } else {
      sessionStorage.removeItem(PENDING_UPDATE_RELOAD_KEY);
    }
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
}

export function healthMatchesUpdateVersion(
  health: unknown,
  expectedVersion: string,
): boolean {
  return (
    typeof health === "object" &&
    health !== null &&
    "version" in health &&
    (health as { version?: unknown }).version === expectedVersion
  );
}

const initial: State = {
  status: "disconnected",
  connectionPaused:
    typeof localStorage !== "undefined" &&
    localStorage.getItem("connectionPaused") === "true",
  bridgeStatus: null,
  workspaces: [],
  tabs: [],
  panes: [],
  layout: null,
  paneContents: {},
  selectedPaneId: null,
  recentPaneIds: [],
  error: null,
  notice: null,
  taskNotificationsEnabled: storedTaskNotificationsEnabled(),
  taskNotificationPermission: notificationPermission(),
  updateInfo: null,
  updateInstalling: false,
  pendingRestartVersion: storedPendingRestartVersion(),
  dismissedUpdateVersion: null,
  pendingFocusWorkspaceId: null,
  terminalAttachEpoch: 0,
  lastRefresh: 0,
};

let state = initial;
const listeners = new Set<() => void>();
let noticeSeq = 0;
let updateReloadVerification: {
  version: string;
  promise: Promise<void>;
} | null = null;
function emit() {
  listeners.forEach((l) => l());
}

export function nextRecentPaneIds(
  selectedPaneId: string | null | undefined,
  recentPaneIds: string[],
  panes: Array<Pick<Pane, "pane_id">>,
) {
  const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
  const pruned = recentPaneIds.filter((paneId) => livePaneIds.has(paneId));
  if (!selectedPaneId || !livePaneIds.has(selectedPaneId)) {
    return pruned.slice(0, RECENT_PANE_LIMIT);
  }
  return [
    selectedPaneId,
    ...pruned.filter((paneId) => paneId !== selectedPaneId),
  ].slice(0, RECENT_PANE_LIMIT);
}

function set(patch: Partial<State>) {
  if (patch.notice) {
    patch = { ...patch, notice: { ...patch.notice, id: ++noticeSeq } };
  }
  if (
    patch.selectedPaneId !== undefined ||
    patch.panes !== undefined ||
    patch.layout !== undefined
  ) {
    const selectedForHistory =
      patch.selectedPaneId !== undefined
        ? patch.selectedPaneId
        : state.selectedPaneId;
    const layoutForHistory =
      patch.layout !== undefined ? patch.layout : state.layout;
    patch = {
      ...patch,
      recentPaneIds: nextRecentPaneIds(
        selectedForHistory ?? layoutForHistory?.focused_pane_id,
        patch.recentPaneIds ?? state.recentPaneIds,
        patch.panes ?? state.panes,
      ),
    };
  }
  state = { ...state, ...patch };
  emit();
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Keep the old frontend alive until the supervisor starts the updated process
 * and it serves the expected version. The session marker survives a manual
 * reload during the restart window and is cleared before the automatic reload.
 */
function reloadWhenUpdatedServerIsReady(
  expectedVersion: string,
): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (updateReloadVerification?.version === expectedVersion) {
    return updateReloadVerification.promise;
  }

  const promise = (async () => {
    const deadline = Date.now() + UPDATE_RESTART_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`/api/health?t=${Date.now()}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status === 401) {
          storePendingRestartVersion(null);
          set({ pendingRestartVersion: null });
          window.location.href = "/login";
          return;
        }
        if (response.ok) {
          const health = await response.json().catch(() => null);
          if (healthMatchesUpdateVersion(health, expectedVersion)) {
            storePendingRestartVersion(null);
            set({
              pendingRestartVersion: null,
              notice: {
                kind: "success",
                message: `herdr-gui ${expectedVersion} is running`,
                detail:
                  "Reloading the application to use the updated frontend.",
                loading: true,
              },
            });
            window.location.reload();
            return;
          }
        }
      } catch {
        // The bridge is expected to be briefly unavailable during replacement.
      }
      await wait(UPDATE_RESTART_VERIFY_INTERVAL_MS);
    }

    storePendingRestartVersion(null);
    set({
      pendingRestartVersion: null,
      notice: {
        kind: "error",
        message: "Updated server did not become ready",
        detail: `Could not verify herdr-gui ${expectedVersion}. Reload the page after checking the server process.`,
      },
    });
  })().finally(() => {
    if (updateReloadVerification?.promise === promise) {
      updateReloadVerification = null;
    }
  });
  updateReloadVerification = { version: expectedVersion, promise };
  return promise;
}

function pickActiveTabId(s: State): string | undefined {
  const focusedWs = s.workspaces.find((w) => w.focused);
  if (focusedWs?.active_tab_id) return focusedWs.active_tab_id;
  const focusedTab = s.tabs.find((t) => t.focused);
  return focusedTab?.tab_id ?? s.tabs[0]?.tab_id;
}

interface NumberedTabRename {
  tabId: string;
  label: string;
}

/** Builds a stable GUI label from Herdr's authoritative created-tab number. */
export function numberedCreatedTabRename(
  result: unknown,
): NumberedTabRename | null {
  if (!result || typeof result !== "object") return null;
  const response = result as { type?: unknown; tab?: unknown };
  if (response.type !== "tab_created" || !response.tab) return null;
  if (typeof response.tab !== "object") return null;

  const { tab_id: tabId, number } = response.tab as {
    tab_id?: unknown;
    number?: unknown;
  };
  if (
    typeof tabId !== "string" ||
    !tabId ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 1
  ) {
    return null;
  }
  return { tabId, label: `Tab ${number}` };
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
let queued = false;
let initialized = false;
let focusActionChain: Promise<unknown> = Promise.resolve();
let paneStatusSnapshotReady = false;
const paneStatusById = new Map<string, string>();

function taskNotificationBody(
  pane: Pane,
  workspaces: Workspace[],
  tabs: Tab[],
) {
  const workspace = workspaces.find(
    (w) => w.workspace_id === pane.workspace_id,
  );
  const tab = tabs.find((t) => t.tab_id === pane.tab_id);
  const parts = [
    pane.agent ?? "Agent",
    workspace?.label ? `workspace ${workspace.label}` : null,
    tab?.label ? `tab ${tab.label}` : null,
  ].filter((part): part is string => !!part);
  return parts.join(" · ");
}

function maybeShowBrowserTaskNotification(
  title: string,
  body: string,
  tag: string,
  target: TaskNotificationTarget,
) {
  if (!state.taskNotificationsEnabled) return;
  if (notificationPermission() !== "granted") return;
  try {
    const notification = new Notification(title, {
      body,
      tag,
    });
    bindTaskNotificationActivation(notification, target);
  } catch {
    // Browser notification support varies by browser and deployment context.
  }
}

function notifyTaskCompleted(pane: Pane, workspaces: Workspace[], tabs: Tab[]) {
  if (!state.taskNotificationsEnabled) return;
  const body = taskNotificationBody(pane, workspaces, tabs);
  const title = "Herdr task completed";
  maybeShowBrowserTaskNotification(title, body, `herdr-task-${pane.pane_id}`, {
    workspaceId: pane.workspace_id,
    paneId: pane.pane_id,
  });
  set({
    notice: {
      kind: "success",
      message: "Task completed",
      detail: body,
      actionLabel: pane.agent ? "Open agent" : "Open workspace",
      actionWorkspaceId: pane.workspace_id,
      actionPaneId: pane.pane_id,
      autoDismissMs: TASK_COMPLETED_TOAST_DISMISS_MS,
    },
  });
}

function activePaneIdForTaskNotifications(snapshot: State) {
  const layoutPaneIds = new Set(
    snapshot.layout?.panes.map((pane) => pane.pane_id) ?? [],
  );
  if (snapshot.selectedPaneId && layoutPaneIds.has(snapshot.selectedPaneId)) {
    return snapshot.selectedPaneId;
  }
  return (
    snapshot.layout?.focused_pane_id ??
    snapshot.panes.find((pane) => pane.focused)?.pane_id ??
    null
  );
}

function trackTaskCompletions(panes: Pane[]) {
  const livePaneIds = new Set<string>();
  const completed: Pane[] = [];
  for (const pane of panes) {
    livePaneIds.add(pane.pane_id);
    const nextStatus = pane.agent_status;
    const previousStatus = paneStatusById.get(pane.pane_id);
    if (
      paneStatusSnapshotReady &&
      previousStatus === "working" &&
      (nextStatus === "done" || nextStatus === "idle")
    ) {
      completed.push(pane);
    }
    paneStatusById.set(pane.pane_id, nextStatus);
  }
  for (const paneId of paneStatusById.keys()) {
    if (!livePaneIds.has(paneId)) paneStatusById.delete(paneId);
  }
  paneStatusSnapshotReady = true;
  return completed;
}

function notifyCompletedTasks(
  completed: Pane[],
  workspaces: Workspace[],
  tabs: Tab[],
) {
  const activePaneId = activePaneIdForTaskNotifications(state);
  for (const pane of completed) {
    if (pane.pane_id === activePaneId) continue;
    notifyTaskCompleted(pane, workspaces, tabs);
  }
}

function enqueueFocusAction<T>(fn: () => Promise<T>): Promise<T> {
  const task = focusActionChain.then(fn, fn);
  focusActionChain = task.catch(() => undefined);
  return task;
}

async function refreshNow() {
  if (state.connectionPaused || state.status !== "connected") return;
  if (refreshing) {
    queued = true;
    return;
  }
  refreshing = true;
  try {
    const [wsRes, tabRes, paneRes] = await Promise.all([
      bridge.call("workspace.list"),
      bridge.call("tab.list"),
      bridge.call("pane.list"),
    ]);
    const workspaces: Workspace[] = wsRes?.workspaces ?? [];
    const tabs: Tab[] = tabRes?.tabs ?? [];
    const panes: Pane[] = paneRes?.panes ?? [];
    forgetTerminalRelayViewportsExcept(new Set(tabs.map((tab) => tab.tab_id)));
    const completedPanes = trackTaskCompletions(panes);

    const next: Partial<State> = {
      workspaces,
      tabs,
      panes,
      error: null,
      lastRefresh: Date.now(),
    };
    if (
      state.pendingFocusWorkspaceId &&
      workspaces.some(
        (w) => w.workspace_id === state.pendingFocusWorkspaceId && w.focused,
      )
    ) {
      next.pendingFocusWorkspaceId = null;
    }

    // Keep selection valid globally. Layout-scoped validation runs after the
    // active tab layout is fetched below, because a pane can exist while no
    // longer belonging to the visible terminal.
    if (
      state.selectedPaneId &&
      !panes.some((p) => p.pane_id === state.selectedPaneId)
    ) {
      next.selectedPaneId = null;
    }

    // Fetch layout for the active tab (needs a pane_id in that tab).
    const merged = { ...state, ...next } as State;
    const activeTabId = pickActiveTabId(merged);
    const aPane =
      panes.find((p) => p.tab_id === activeTabId && p.focused) ??
      panes.find((p) => p.tab_id === activeTabId);
    if (aPane) {
      try {
        const lr = await bridge.call("pane.layout", {
          pane_id: aPane.pane_id,
        });
        const layout = (lr?.layout ?? null) as PaneLayout | null;
        next.layout = layout;
        if (
          layout &&
          state.selectedPaneId &&
          !layout.panes.some((p) => p.pane_id === state.selectedPaneId)
        ) {
          next.selectedPaneId = null;
        }
      } catch {
        next.layout = null;
      }
    } else {
      next.layout = null;
    }

    if (state.connectionPaused) return;
    set(next);
    notifyCompletedTasks(completedPanes, workspaces, tabs);
    // Fetch the visible text for every pane in the layout right away.
    refreshContents();
  } catch (e) {
    if (!state.connectionPaused) set({ error: (e as Error).message });
  } finally {
    refreshing = false;
    if (queued) {
      queued = false;
      refreshNow();
    }
  }
}

function scheduleRefresh() {
  if (state.connectionPaused) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshNow();
  }, 80);
}

async function refreshBridgeStatus() {
  if (state.connectionPaused || state.status !== "connected") return;
  try {
    const r = await bridge.call("bridge.status");
    if (state.connectionPaused || state.status !== "connected") return;
    set({
      bridgeStatus: {
        clients: Number(r?.clients ?? 0),
        terminals: Array.isArray(r?.terminals) ? r.terminals : [],
      },
    });
  } catch {
    // Keep the last good count; status polling should never interrupt the UI.
  }
}

/** Read recent scrollback of every pane in the current layout. */
async function refreshContents() {
  if (state.connectionPaused || state.status !== "connected") return;
  const layout = state.layout;
  if (!layout || layout.panes.length === 0) return;
  const next: Record<string, string> = { ...state.paneContents };
  await Promise.all(
    layout.panes.map(async (lp) => {
      try {
        const r = await bridge.call("pane.read", {
          pane_id: lp.pane_id,
          source: "visible",
          lines: 200,
          format: "ansi",
        });
        next[lp.pane_id] = (r?.read?.text ?? "") as string;
      } catch {
        // keep last good content for this pane
      }
    }),
  );
  if (state.connectionPaused) return;
  set({ paneContents: next });
}

let contentTimer: ReturnType<typeof setInterval> | null = null;
let metadataTimer: ReturnType<typeof setInterval> | null = null;
let updateTimer: ReturnType<typeof setInterval> | null = null;
function startContentPolling() {
  if (contentTimer) return;
  contentTimer = setInterval(() => {
    if (state.status === "connected" && state.layout) refreshContents();
  }, 1500);
}

function startMetadataPolling() {
  if (metadataTimer) return;
  metadataTimer = setInterval(() => {
    if (state.status === "connected") {
      scheduleRefresh();
      void refreshBridgeStatus();
    }
  }, 1000);
}

async function checkForUpdate(showErrors = false) {
  if (state.connectionPaused) {
    if (showErrors) {
      set({
        notice: {
          kind: "info",
          message: "Connection is paused",
          detail: "Resume the connection before checking for updates.",
        },
      });
    }
    return;
  }
  try {
    const r = await fetch("/api/update/check", {
      credentials: "same-origin",
      headers: { "x-herdr-gui-update": "1" },
    });
    if (!r.ok) {
      if (showErrors) {
        const body = await r.json().catch(() => null);
        set({
          notice: {
            kind: "error",
            message: "Update check failed",
            detail: body?.error ?? r.statusText,
          },
        });
      }
      return;
    }
    const info = (await r.json()) as UpdateInfo;
    if (
      info.update_available &&
      info.latest_version &&
      (showErrors || state.dismissedUpdateVersion !== info.latest_version)
    ) {
      set({ updateInfo: info });
    } else if (!info.update_available) {
      set({
        updateInfo: null,
        notice: showErrors
          ? {
              kind: "success",
              message: "herdr-gui is up to date",
              detail: info.latest_version
                ? `Current version: ${info.current_version}`
                : undefined,
            }
          : state.notice,
      });
    }
  } catch (e) {
    if (showErrors) {
      set({
        notice: {
          kind: "error",
          message: "Update check failed",
          detail: (e as Error).message,
        },
      });
    }
  }
}

function startUpdatePolling() {
  if (updateTimer) return;
  void checkForUpdate(false);
  updateTimer = setInterval(
    () => {
      void checkForUpdate(false);
    },
    30 * 60 * 1000,
  );
}

function stopPolling() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (contentTimer) {
    clearInterval(contentTimer);
    contentTimer = null;
  }
  if (metadataTimer) {
    clearInterval(metadataTimer);
    metadataTimer = null;
  }
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  queued = false;
}

function startPolling() {
  startContentPolling();
  startMetadataPolling();
  startUpdatePolling();
}

async function action<T>(
  fn: () => Promise<T>,
  options: {
    refresh?: "scheduled" | "immediate" | "none";
    pendingFocusWorkspaceId?: string;
    failureNotice?: (error: Error) => Notice;
  } = {},
): Promise<T | undefined> {
  if (state.connectionPaused) {
    set({
      notice: {
        kind: "info",
        message: "Connection is paused",
        detail: "Resume the connection before sending actions to Herdr.",
      },
    });
    return undefined;
  }
  try {
    const r = await fn();
    if (options.refresh === "immediate") {
      void refreshNow();
    } else if (options.refresh !== "none") {
      scheduleRefresh();
    }
    return r;
  } catch (e) {
    const error = e as Error;
    set({
      error: error.message,
      notice: options.failureNotice?.(error) ?? state.notice,
      pendingFocusWorkspaceId:
        options.pendingFocusWorkspaceId &&
        state.pendingFocusWorkspaceId === options.pendingFocusWorkspaceId
          ? null
          : state.pendingFocusWorkspaceId,
    });
    return undefined;
  }
}

function hookEventLabel(event: WorktreeHookEvent): string {
  switch (event) {
    case "worktree.before_remove":
      return "Worktree teardown hook";
    case "worktree.opened":
      return "Worktree opened hook";
    case "worktree.removed":
      return "Worktree removed hook";
    case "worktree.created":
      return "Worktree setup hook";
  }
}

function hookOutput(
  result: Pick<WorktreeHookRunResult, "stdout" | "stderr" | "error">,
) {
  return [result.stderr, result.stdout, result.error]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .join("\n")
    .trim();
}

export function summarizeDirectHookResult(
  result: WorktreeHookRunResult,
): Notice | null {
  if (result.status === "skipped") return null;
  const output = hookOutput(result);
  const exitSuffix =
    typeof result.exit_code === "number" ? ` (exit ${result.exit_code})` : "";
  return {
    kind: result.status === "succeeded" ? "success" : "error",
    message:
      result.status === "succeeded"
        ? `${hookEventLabel(result.event)} completed`
        : `${hookEventLabel(result.event)} failed${exitSuffix}`,
    detail: output ? output.slice(0, 1400) : undefined,
    detailMode: output ? "output" : undefined,
    detailTitle: output ? `${hookEventLabel(result.event)} output` : undefined,
    ...(result.status === "succeeded"
      ? { autoDismissMs: DEFAULT_NOTICE_AUTO_DISMISS_MS }
      : {}),
  };
}

export function worktreeRemovalCompletionNotice(
  cleanup: WorktreeRemovalCleanup | undefined,
  removedHookNotice: Notice | null,
): Notice | null {
  if (!cleanup?.recovered_stale_checkout && !cleanup?.warning) {
    return removedHookNotice;
  }

  const stopped = Number(cleanup.terminated_processes ?? 0);
  const recoveryDetails = [
    stopped > 0
      ? `Stopped ${stopped} process${stopped === 1 ? "" : "es"} still using the checkout.`
      : "",
    cleanup.preserved_path
      ? `Stale files were preserved at ${cleanup.preserved_path}.`
      : cleanup.recovered_stale_checkout
        ? "The checkout was already absent; stale Herdr state was reconciled."
        : "",
    cleanup.warning ?? "",
  ].filter(Boolean);

  if (removedHookNotice) {
    const cleanupWarning = Boolean(cleanup.warning);
    return {
      ...removedHookNotice,
      kind: cleanupWarning ? "error" : removedHookNotice.kind,
      message:
        cleanupWarning && removedHookNotice.kind !== "error"
          ? "Worktree removed with cleanup warning"
          : removedHookNotice.message,
      detail: [
        cleanupWarning && removedHookNotice.kind !== "error"
          ? removedHookNotice.message
          : "",
        removedHookNotice.detail,
        ...recoveryDetails,
      ]
        .filter(Boolean)
        .join("\n"),
      detailTitle:
        removedHookNotice.detail || cleanupWarning
          ? "Worktree removal details"
          : undefined,
    };
  }

  return {
    kind: cleanup.warning ? "error" : "success",
    message: cleanup.warning
      ? "Worktree removed with cleanup warning"
      : "Worktree removed",
    detail: recoveryDetails.join("\n"),
  };
}

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  init() {
    if (initialized) return;
    initialized = true;
    bridge.onStatus((s) => {
      if (s === "disconnected") clearTerminalRelayViewports();
      const resumed =
        s === "connected" &&
        !state.connectionPaused &&
        state.notice?.loading &&
        state.notice.message === "Resuming connection";
      set(
        resumed
          ? {
              status: s,
              notice: {
                kind: "success",
                message: "Connection resumed",
                autoDismissMs: 5000,
              },
            }
          : {
              status: s,
              bridgeStatus: s === "connected" ? state.bridgeStatus : null,
            },
      );
      if (s === "connected" && !state.connectionPaused) {
        refreshNow();
        void refreshBridgeStatus();
        if (state.pendingRestartVersion) {
          void reloadWhenUpdatedServerIsReady(state.pendingRestartVersion);
        }
      }
    });
    bridge.onEvent(() => {
      if (!state.connectionPaused) scheduleRefresh();
    });
    bridge.onControl((control) => {
      if (control.type === "pause_connection") {
        store.pauseConnection(
          control.reason ??
            "Another herdr-gui client paused this connection. Resume when you want this browser to sync again.",
        );
      }
    });
    // If the server requires a password and the session is missing/expired,
    // bounce to the login page instead of spinning on a failing socket.
    fetch("/api/health", {
      credentials: "same-origin",
      cache: "no-store",
    }).then((r) => {
      if (r.status === 401) {
        location.href = "/login";
        return;
      }
      if (state.pendingRestartVersion) {
        void reloadWhenUpdatedServerIsReady(state.pendingRestartVersion);
      }
      if (!state.connectionPaused) {
        bridge.connect();
        startPolling();
      }
    });
  },

  refresh: refreshNow,

  pauseConnection(
    detail = "This browser will stop syncing until you resume it.",
  ) {
    localStorage.setItem("connectionPaused", "true");
    stopPolling();
    bridge.disconnect();
    set({
      connectionPaused: true,
      status: "disconnected",
      bridgeStatus: null,
      terminalAttachEpoch: state.terminalAttachEpoch + 1,
      notice: {
        kind: "info",
        message: "Connection paused",
        detail,
      },
    });
  },

  pauseOtherClients() {
    return action(async () => {
      const result = await bridge.call("bridge.pause_others");
      const pausedClients = Number(result?.paused_clients ?? 0);
      set({
        notice: {
          kind: pausedClients > 0 ? "success" : "info",
          message:
            pausedClients === 1
              ? "Paused 1 other client"
              : `Paused ${pausedClients} other clients`,
          autoDismissMs: 5000,
        },
      });
      void refreshBridgeStatus();
      return result;
    });
  },

  resumeConnection() {
    localStorage.setItem("connectionPaused", "false");
    set({
      connectionPaused: false,
      error: null,
      notice: {
        kind: "info",
        message: "Resuming connection",
        loading: true,
      },
    });
    bridge.connect();
    startPolling();
  },

  selectPane(paneId: string) {
    set({
      selectedPaneId: paneId,
      error: null,
    });
  },

  focusTab(tabId: string) {
    const workspaceId = state.tabs.find(
      (t) => t.tab_id === tabId,
    )?.workspace_id;
    const targetPane =
      state.panes.find((pane) => pane.tab_id === tabId && pane.focused) ??
      state.panes.find((pane) => pane.tab_id === tabId);
    if (workspaceId) set({ pendingFocusWorkspaceId: workspaceId });
    return action(
      () =>
        enqueueFocusAction(async () => {
          const relaySize = terminalRelayViewportForTab(tabId);
          if (relaySize) {
            // Pre-size background runtimes for the target tab while the current
            // tab's direct attachments are still locked. The bridge confirms the
            // projected viewport through pane.layout before focus proceeds, so
            // the target is stable before it becomes visible.
            await bridge
              .call("terminal.relay_resize", {
                cols: relaySize.cols,
                rows: relaySize.rows,
                ...(targetPane ? { pane_id: targetPane.pane_id } : {}),
              })
              .catch(() => null);
          }
          if (workspaceId) {
            await bridge.call("workspace.focus", { workspace_id: workspaceId });
          }
          return bridge.call("tab.focus", { tab_id: tabId });
        }),
      { refresh: "immediate", pendingFocusWorkspaceId: workspaceId },
    );
  },

  createTab(workspaceId: string, options: { numberedLabel?: boolean } = {}) {
    return action(async () => {
      const result: unknown = await bridge.call("tab.create", {
        workspace_id: workspaceId,
        focus: true,
      });
      if (!options.numberedLabel) return result;

      const rename = numberedCreatedTabRename(result);
      if (!rename) return result;
      try {
        await bridge.call("tab.rename", {
          tab_id: rename.tabId,
          label: rename.label,
        });
      } catch (error) {
        // The tab already exists, so keep the successful create visible while
        // surfacing the non-fatal naming failure to the user.
        set({
          notice: {
            kind: "error",
            message: "Tab created, but naming failed",
            detail: (error as Error).message,
          },
        });
      }
      return result;
    });
  },

  closeTab(tabId: string) {
    return action(() => bridge.call("tab.close", { tab_id: tabId }));
  },

  renameTab(tabId: string, label: string) {
    return action(() => bridge.call("tab.rename", { tab_id: tabId, label }));
  },

  focusWorkspace(workspaceId: string) {
    set({ pendingFocusWorkspaceId: workspaceId });
    return action(
      () =>
        enqueueFocusAction(() =>
          bridge.call("workspace.focus", { workspace_id: workspaceId }),
        ),
      { refresh: "immediate", pendingFocusWorkspaceId: workspaceId },
    );
  },

  focusTaskNotificationTarget(target: TaskNotificationTarget) {
    set({ pendingFocusWorkspaceId: target.workspaceId });
    return action(
      () =>
        enqueueFocusAction(async () => {
          let pane: Pane | null = null;
          try {
            const result = await bridge.call("pane.get", {
              pane_id: target.paneId,
            });
            pane = (result?.pane ?? null) as Pane | null;
          } catch {
            // The pane may have closed after the notification was shown.
          }

          const workspaceId = pane?.workspace_id ?? target.workspaceId;
          await bridge.call("workspace.focus", { workspace_id: workspaceId });
          if (!pane) return null;

          try {
            await bridge.call("tab.focus", { tab_id: pane.tab_id });
          } catch {
            // The pane or tab can close between pane.get and tab.focus.
            return null;
          }
          set({ selectedPaneId: pane.pane_id });
          return pane;
        }),
      {
        refresh: "immediate",
        pendingFocusWorkspaceId: target.workspaceId,
      },
    );
  },

  createWorkspace(label?: string, cwd?: string) {
    return action(() =>
      bridge.call("workspace.create", { label, cwd, focus: true }),
    );
  },

  renameWorkspace(workspaceId: string, label: string) {
    return action(() =>
      bridge.call("workspace.rename", { workspace_id: workspaceId, label }),
    );
  },

  closeWorkspace(workspaceId: string) {
    return action(() =>
      bridge.call("workspace.close", { workspace_id: workspaceId }),
    );
  },

  gitPullWorkspace(workspaceId: string) {
    return action(
      async () => {
        set({
          notice: {
            kind: "info",
            message: "Running git pull",
            detail: "git pull --ff-only",
            detailMode: "output",
            detailTitle: "Command",
            loading: true,
          },
        });
        const result = await bridge.call("git.pull", {
          workspace_id: workspaceId,
        });
        const output = [result?.stdout, result?.stderr]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
          .join("\n")
          .trim();
        set({
          notice: {
            kind: "success",
            message: "Git pull completed",
            detail: output ? output.slice(0, 1400) : "Already up to date.",
            detailMode: output ? "output" : "text",
            detailTitle: output ? "git pull --ff-only" : undefined,
          },
        });
        return result;
      },
      {
        refresh: "immediate",
        failureNotice: (error) => ({
          kind: "error",
          message: "Git pull failed",
          detail: error.message,
          detailMode: "output",
          detailTitle: "git pull --ff-only",
        }),
      },
    );
  },

  createWorktree(workspaceId: string, branch: string) {
    return action(
      async () => {
        set({
          notice: {
            kind: "info",
            message: "Creating worktree",
            detail: `Updating origin/main before creating ${branch}.`,
            detailMode: "output",
            detailTitle: "git fetch origin main",
            loading: true,
          },
        });
        const result = await bridge.call("worktree.create", {
          workspace_id: workspaceId,
          branch,
          focus: true,
        });
        const setupHook = result?.setup_hook as
          | WorktreeHookRunResult
          | undefined;
        const setupNotice = setupHook
          ? summarizeDirectHookResult(setupHook)
          : null;
        if (setupNotice) {
          set({ notice: setupNotice });
        } else {
          const commit = String(result?.base_sync?.commit ?? "").slice(0, 12);
          set({
            notice: {
              kind: "success",
              message: "Worktree created",
              detail: commit
                ? `${branch} starts from origin/main at ${commit}.`
                : `${branch} starts from the latest origin/main.`,
              autoDismissMs: 5000,
            },
          });
        }
        return result;
      },
      {
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to create worktree",
          detail: error.message,
        }),
      },
    );
  },

  openWorktree(workspaceId: string, target: string, focus = true) {
    const trimmed = target.trim();
    const locator = trimmed.startsWith("/")
      ? { path: trimmed }
      : { branch: trimmed };
    return action(async () => {
      const result = await bridge.call("worktree.open", {
        workspace_id: workspaceId,
        ...locator,
        focus,
      });
      const openedHook = result?.opened_hook as
        | WorktreeHookRunResult
        | undefined;
      const openedNotice = openedHook
        ? summarizeDirectHookResult(openedHook)
        : null;
      if (openedNotice) set({ notice: openedNotice });
      return result;
    });
  },

  // A linked checkout can remain open after its main workspace is closed.
  // Herdr accepts the repository root as the source in that state, allowing
  // the GUI to reopen main without inventing or guessing a workspace ID.
  openWorktreeFromCwd(cwd: string, target: string, focus = true) {
    const trimmed = target.trim();
    const locator = trimmed.startsWith("/")
      ? { path: trimmed }
      : { branch: trimmed };
    return action(async () => {
      const result = await bridge.call("worktree.open", {
        cwd,
        ...locator,
        focus,
      });
      const openedHook = result?.opened_hook as
        | WorktreeHookRunResult
        | undefined;
      const openedNotice = openedHook
        ? summarizeDirectHookResult(openedHook)
        : null;
      if (openedNotice) set({ notice: openedNotice });
      return result;
    });
  },

  removeWorktree(workspaceId: string, force = false) {
    return action(
      async () => {
        set({
          notice: {
            kind: "info",
            message: "Removing worktree",
            detail: "Running teardown hook if configured.",
            loading: true,
          },
        });
        const result = await bridge.call(
          "worktree.remove",
          {
            workspace_id: workspaceId,
            force,
          },
          // Hooks are part of this RPC and can legitimately run longer than
          // Herdr's own bounded remove call. Let disconnects end the browser
          // wait instead of reporting a timeout while deletion continues.
          null,
        );
        const beforeRemoveHook = result?.before_remove_hook as
          | WorktreeHookRunResult
          | undefined;
        const beforeRemoveNotice = beforeRemoveHook
          ? summarizeDirectHookResult(beforeRemoveHook)
          : null;
        if (beforeRemoveNotice) set({ notice: beforeRemoveNotice });
        if (result?.skipped_remove) {
          if (!beforeRemoveNotice) set({ notice: null });
          return result;
        }

        await refreshNow();
        await bridge.call("terminal.detach").catch(() => null);
        set({ terminalAttachEpoch: state.terminalAttachEpoch + 1 });
        const removedHook = result?.removed_hook as
          | WorktreeHookRunResult
          | undefined;
        const removedNotice = removedHook
          ? summarizeDirectHookResult(removedHook)
          : null;
        const cleanup = result?.cleanup as WorktreeRemovalCleanup | undefined;
        const completionNotice = worktreeRemovalCompletionNotice(
          cleanup,
          removedNotice,
        );
        if (completionNotice) {
          set({ notice: completionNotice });
        } else if (!beforeRemoveNotice) {
          set({
            notice: {
              kind: "success",
              message: "Worktree removed",
            },
          });
        }
        return result;
      },
      {
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to remove worktree",
          detail: error.message,
        }),
      },
    );
  },

  setRepoWorktreeHooksEnabled(key: string, enabled: boolean) {
    return action(async () => {
      const result = await bridge.call("settings.update_repo", {
        key,
        settings: { worktree_hooks_enabled: enabled },
      });
      await refreshNow();
      return result;
    });
  },

  setWorkspaceAutoSyncEnabled(workspaceId: string, enabled: boolean) {
    return action(
      async () => {
        const result = await bridge.call(
          "settings.workspace_auto_sync.update",
          {
            workspace_id: workspaceId,
            enabled,
          },
        );
        set({
          notice: {
            kind: "success",
            message: enabled
              ? "Automatic branch updates enabled"
              : "Automatic branch updates disabled",
            detail: enabled
              ? "A sync will run now, then every 10 minutes while this workspace remains open."
              : undefined,
            autoDismissMs: 5000,
          },
        });
        return result;
      },
      {
        refresh: "none",
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to update automatic sync settings",
          detail: error.message,
        }),
      },
    );
  },

  setWorkspaceAutoSyncConfigEnabled(key: string, enabled: boolean) {
    return action(
      async () => {
        const result = await bridge.call(
          "settings.workspace_auto_sync.update_key",
          { key, enabled },
        );
        set({
          notice: {
            kind: "success",
            message: enabled
              ? "Automatic branch updates enabled"
              : "Automatic branch updates disabled",
            detail: key,
            autoDismissMs: 5000,
          },
        });
        return result;
      },
      {
        refresh: "none",
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to update automatic sync settings",
          detail: error.message,
        }),
      },
    );
  },

  clearNotice() {
    set({ notice: null });
  },

  notify(notice: Notice) {
    set({ notice });
  },

  async setTaskNotificationsEnabled(enabled: boolean) {
    if (!enabled) {
      localStorage.setItem(TASK_NOTIFICATIONS_KEY, "false");
      set({
        taskNotificationsEnabled: false,
        taskNotificationPermission: notificationPermission(),
        notice: {
          kind: "info",
          message: "Task notifications disabled",
          autoDismissMs: 5000,
        },
      });
      return;
    }

    if (notificationPermission() === "unsupported") {
      localStorage.setItem(TASK_NOTIFICATIONS_KEY, "false");
      set({
        taskNotificationsEnabled: false,
        taskNotificationPermission: "unsupported",
        notice: {
          kind: "error",
          message: "Browser notifications are not supported",
          detail:
            "This browser or deployment context does not expose the Notification API.",
        },
      });
      return;
    }

    let permission = Notification.permission;
    try {
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }
    } catch (e) {
      localStorage.setItem(TASK_NOTIFICATIONS_KEY, "false");
      set({
        taskNotificationsEnabled: false,
        taskNotificationPermission: notificationPermission(),
        notice: {
          kind: "error",
          message: "Notification permission failed",
          detail: (e as Error).message,
        },
      });
      return;
    }

    const granted = permission === "granted";
    localStorage.setItem(TASK_NOTIFICATIONS_KEY, granted ? "true" : "false");
    set({
      taskNotificationsEnabled: granted,
      taskNotificationPermission: permission,
      notice: granted
        ? {
            kind: "success",
            message: "Task notifications enabled",
            detail: "Herdr GUI will notify you when an agent task completes.",
            autoDismissMs: 5000,
          }
        : {
            kind: "error",
            message: "Notification permission was not granted",
            detail:
              "Enable notifications for this site in the browser settings, then try again.",
          },
    });
  },

  checkForUpdate() {
    return checkForUpdate(true);
  },

  updateOrCheck() {
    if (
      state.updateInfo?.update_available &&
      state.updateInfo.can_auto_update
    ) {
      return this.installUpdate();
    }
    return checkForUpdate(true);
  },

  dismissUpdate() {
    set({
      dismissedUpdateVersion: state.updateInfo?.latest_version ?? null,
      updateInfo: null,
    });
  },

  async installUpdate() {
    if (state.connectionPaused) {
      set({
        notice: {
          kind: "info",
          message: "Connection is paused",
          detail: "Resume the connection before installing updates.",
        },
      });
      return;
    }
    const latestVersion = state.updateInfo?.latest_version;
    if (!latestVersion || state.updateInstalling) return;
    set({ updateInstalling: true });
    try {
      const r = await fetch("/api/update/install", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-herdr-gui-update": "1" },
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error(body?.error ?? r.statusText);
      }
      if (body?.installed) {
        const installedVersion = body.installed_version ?? latestVersion;
        if (body.restart_scheduled) {
          storePendingRestartVersion(installedVersion);
          set({
            updateInfo: null,
            updateInstalling: false,
            pendingRestartVersion: installedVersion,
            dismissedUpdateVersion: latestVersion,
            notice: {
              kind: "info",
              message: "Restarting herdr-gui",
              detail:
                "The binary was updated. Waiting for the external process supervisor to start the new version.",
              loading: true,
            },
          });
          void reloadWhenUpdatedServerIsReady(installedVersion);
          return;
        }
        set({
          updateInfo: null,
          updateInstalling: false,
          dismissedUpdateVersion: latestVersion,
          notice: {
            kind: "success",
            message: `herdr-gui ${installedVersion} installed`,
            detail: "Restart herdr-gui to use the new version.",
          },
        });
        return;
      }
      set({
        updateInfo: null,
        updateInstalling: false,
        dismissedUpdateVersion: latestVersion,
        notice: {
          kind: "success",
          message: "herdr-gui is already up to date",
        },
      });
    } catch (e) {
      set({
        updateInstalling: false,
        notice: {
          kind: "error",
          message: "Update install failed",
          detail: (e as Error).message,
        },
      });
    }
  },

  sendText(paneId: string, text: string) {
    return action(() =>
      bridge.call("pane.send_text", { pane_id: paneId, text }),
    );
  },

  sendKeys(paneId: string, keys: string) {
    // Herdr expects `keys` to be a sequence of key-combo strings.
    return action(() =>
      bridge.call("pane.send_keys", { pane_id: paneId, keys: [keys] }),
    );
  },

  focusPane(paneId: string) {
    const pane = state.panes.find((p) => p.pane_id === paneId);
    if (pane?.workspace_id) set({ pendingFocusWorkspaceId: pane.workspace_id });
    return action(
      () =>
        enqueueFocusAction(async () => {
          if (pane?.workspace_id) {
            await bridge.call("workspace.focus", {
              workspace_id: pane.workspace_id,
            });
          }
          if (pane) await bridge.call("tab.focus", { tab_id: pane.tab_id });
          set({ selectedPaneId: paneId });
          return pane;
        }),
      { refresh: "immediate", pendingFocusWorkspaceId: pane?.workspace_id },
    );
  },

  splitPane(paneId: string, direction: "right" | "down") {
    return action(async () => {
      const result = await bridge.call("pane.split", {
        target_pane_id: paneId,
        direction,
        focus: true,
      });
      const nextPaneId =
        typeof result?.pane?.pane_id === "string" ? result.pane.pane_id : null;
      if (nextPaneId) set({ selectedPaneId: nextPaneId });
      return result;
    });
  },

  zoomPane(paneId: string) {
    return action(() => bridge.call("pane.zoom", { pane_id: paneId }));
  },

  resizePane(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
    amount: number,
  ) {
    return action(async () => {
      const result = await bridge.call("pane.resize", {
        pane_id: paneId,
        direction,
        amount,
      });
      const layout = result?.resize?.layout;
      if (layout) set({ layout });
      return result;
    });
  },

  focusPaneDirection(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
  ) {
    return action(async () => {
      const result = await bridge.call("pane.focus_direction", {
        pane_id: paneId,
        direction,
      });
      const focus = result?.focus ?? result?.focus_direction ?? result;
      const focusedPaneId =
        typeof focus?.focused_pane_id === "string"
          ? focus.focused_pane_id
          : null;
      if (focusedPaneId) set({ selectedPaneId: focusedPaneId });
      if (focus?.layout) set({ layout: focus.layout as PaneLayout });
      await refreshNow();
      return result;
    });
  },

  closePane(paneId: string) {
    return action(() => bridge.call("pane.close", { pane_id: paneId }));
  },
};

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.get);
}
