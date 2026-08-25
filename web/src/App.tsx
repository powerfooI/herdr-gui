import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileDiff,
  FolderTree,
  History,
  Info,
  LoaderCircle,
  MoreHorizontal,
  PanelTop,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import packageJson from "../package.json";
import {
  type AccentColor,
  normalizeAccentColor,
  normalizeThemePreference,
  type ResolvedTheme,
  resolveSystemTheme,
  SYSTEM_THEME_QUERY,
  type ThemePreference,
} from "./appearance";
import { AgentIcon } from "./components/AgentIcon";
import { paneHasAgentHistory } from "./components/agentSession";
import { CloseButton } from "./components/CloseButton";
import { clearDiffContentResourceState } from "./components/diffContentState";
import { CommandCombobox } from "./components/CommandCombobox";
import { CONFIG_MENU_ID, ConfigMenu } from "./components/ConfigMenu";
import { ConnectionSwitcher } from "./components/ConnectionSwitcher";
import {
  type ActiveDiffSelection,
  clearDiffViewerResourceCache,
  prefetchDiffViewerWorkspace,
} from "./components/DiffViewerPanel";
import {
  clearFileExplorerResourceCache,
  prefetchFileExplorerWorkspace,
  requestFilePreview,
} from "./components/FileExplorerDialog";
import { type ActiveFilePreviewSelection } from "./components/FilePreviewContent";
import { GlobalTooltip } from "./components/GlobalTooltip";
import { requestCloseTab, TabBar } from "./components/TabBar";
import { WorkspaceInspectorHost } from "./components/WorkspaceInspectorHost";
import { WorkspaceTree } from "./components/WorkspaceTree";
import type { TerminalWorkspaceFileRequest } from "./components/TerminalView";
import {
  LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
  parseMobileTerminalShortcutRows,
  parseMobileTerminalSideShortcuts,
  serializeMobileTerminalShortcutRows,
  serializeMobileTerminalSideShortcuts,
} from "./mobileTerminalShortcuts";
import {
  activePaneIdForSnapshot,
  type PaneJumpEntry,
  paneJumpEntries,
  paneJumpTargetId,
} from "./paneJump";
import {
  isTaskNotificationTarget,
  type Notice,
  noticeAutoDismissDelay,
  shallowEqual,
  store,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  type TaskNotificationTarget,
  taskNotificationTargetFromNotice,
  useStoreSelector,
  WORKTREE_REMOVED_EVENT,
  type WorktreeRemovedTarget,
} from "./store";
import { adjacentTabId, tabShortcutAction } from "./tabShortcuts";
import { copyTextFromUserGesture } from "./terminalClipboard";
import { terminalMountKey } from "./terminalConnection";
import type { FileExplorerEntry, Pane } from "./types";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "./useConnectionClient";
import {
  inspectorMaximumSize,
  isWorkspaceInspectorShortcut,
  INSPECTOR_MIN_BOTTOM,
  INSPECTOR_MIN_RIGHT,
  readInspectorPreferences,
  readResourceFileSelection,
  relativePathWithinCheckout,
  resourceOwnerKey,
  resourceScopeForWorkspace,
  resourceStateKey,
  resolveWorkspaceForScope,
  sameResourceOwner,
  writeInspectorPreferences,
  writeResourceFileSelection,
  type InspectorDock,
  type InspectorView,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
  type WorkspaceInspectorRequest,
  type WorkspaceInspectorState,
} from "./workspaceResource";
import { agentClass } from "./utils";

const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 560;
const DEFAULT_SIDEBAR = 284;
const THEME_KEY = "theme";
const ACCENT_COLOR_KEY = "accentColor";
const LazyTerminalView = lazy(() =>
  import("./components/TerminalView").then((module) => ({
    default: module.TerminalView,
  })),
);

type TerminalViewProps = {
  paneId?: string;
  showMobileKeys?: boolean;
  mobileShortcuts?: MobileTerminalShortcutRows;
  mobileSideShortcuts?: MobileTerminalSideShortcuts;
  agentHistoryOpen?: boolean;
  onAgentHistoryOpenChange?: (open: boolean) => void;
  onOpenWorkspaceFile?: (request: TerminalWorkspaceFileRequest) => void;
};

function TerminalLoadingFallback() {
  return (
    <div className="terminal-loading">
      <span className="terminal-loading-dot" />
      Loading terminal
    </div>
  );
}

function TerminalView(props: TerminalViewProps) {
  return (
    <Suspense fallback={<TerminalLoadingFallback />}>
      <LazyTerminalView {...props} />
    </Suspense>
  );
}

function NoticeDetail({ notice }: { notice: Notice }) {
  if (!notice.detail) return null;
  if (notice.detailMode === "output") {
    return (
      <div className="toast-output">
        {notice.detailTitle ? (
          <div className="toast-output-title">{notice.detailTitle}</div>
        ) : null}
        <pre>{notice.detail}</pre>
      </div>
    );
  }
  return <p>{notice.detail}</p>;
}

function ToastMark({
  kind,
  loading = false,
}: {
  kind: Notice["kind"];
  loading?: boolean;
}) {
  const Mark = loading
    ? LoaderCircle
    : kind === "success"
      ? CheckCircle2
      : kind === "error"
        ? CircleAlert
        : Info;

  return (
    <span className="toast-mark" aria-hidden="true">
      <Mark size={16} strokeWidth={2.1} />
    </span>
  );
}

export type Theme = ThemePreference;
type MobileView = "workspaces" | "session" | InspectorView;
type OpenInspectorOptions = {
  entry?: FileExplorerEntry;
  path?: string;
  initialDirectory?: string;
  originPaneId?: string;
  focusInspector?: boolean;
};

function normalizeSidebarWidth(value: number): number {
  return Number.isFinite(value) && value >= MIN_SIDEBAR && value <= MAX_SIDEBAR
    ? value
    : DEFAULT_SIDEBAR;
}

function loadSidebarWidth(): number {
  return normalizeSidebarWidth(Number(localStorage.getItem("sidebarWidth")));
}

function loadTheme(): Theme {
  return normalizeThemePreference(localStorage.getItem(THEME_KEY));
}

function loadSystemTheme(): ResolvedTheme {
  return resolveSystemTheme(window.matchMedia(SYSTEM_THEME_QUERY));
}

function loadAccentColor(): AccentColor {
  return normalizeAccentColor(localStorage.getItem(ACCENT_COLOR_KEY));
}

function loadMobileTerminalShortcuts(): MobileTerminalShortcutRows {
  const current = localStorage.getItem(MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY);
  if (current !== null) return parseMobileTerminalShortcutRows(current);
  const legacy = localStorage.getItem(
    LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  );
  const migrated = parseMobileTerminalShortcutRows(legacy);
  if (legacy !== null) {
    localStorage.setItem(
      MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
      serializeMobileTerminalShortcutRows(migrated),
    );
  }
  return migrated;
}

function loadMobileTerminalSideShortcuts(): MobileTerminalSideShortcuts {
  return parseMobileTerminalSideShortcuts(
    localStorage.getItem(MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY),
  );
}

function emptyActiveDiffSelection(): ActiveDiffSelection {
  return {
    entry: null,
    file: null,
    loading: false,
    error: null,
    entries: [],
    files: {},
    fileErrors: {},
    summaryLoading: false,
  };
}

function emptyActiveFilePreviewSelection(): ActiveFilePreviewSelection {
  return {
    entry: null,
    preview: null,
    loading: false,
    error: null,
  };
}

function useMobileLayout() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 768px)").matches
      : false,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 768px)");
    const onChange = () => setMobile(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return mobile;
}

function useVisualViewportCssVars() {
  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const keyboardInset = Math.max(
        0,
        window.innerHeight - height - offsetTop,
      );
      const keyboardOpen = keyboardInset > 24;
      root.style.setProperty(
        "--app-viewport-height",
        `${Math.round(height)}px`,
      );
      root.style.setProperty(
        "--app-height",
        keyboardOpen
          ? `${Math.round(height)}px`
          : `calc(${Math.round(height)}px + env(safe-area-inset-bottom, 0px))`,
      );
      root.style.setProperty(
        "--app-viewport-offset-top",
        `${Math.round(offsetTop)}px`,
      );
      root.style.setProperty(
        "--keyboard-inset-bottom",
        `${Math.round(keyboardInset)}px`,
      );
    };

    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-viewport-offset-top");
      root.style.removeProperty("--keyboard-inset-bottom");
    };
  }, []);
}

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  if (target.closest(".file-preview-code .cm-editor")) return false;
  return target.isContentEditable;
}

function tabShortcutIndex(e: KeyboardEvent) {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (/^[1-9]$/.test(e.key)) return Number(e.key) - 1;
  const match = /^Digit([1-9])$/.exec(e.code);
  return match ? Number(match[1]) - 1 : null;
}

// Herdr reports pane rectangles in terminal-cell coordinates. The GUI maps
// those rectangles into CSS percentages so panes scale with the browser.
function rectPercent(value: number, start: number, size: number) {
  if (size <= 0) return 0;
  return ((value - start) / size) * 100;
}

function paneTitle(
  paneId: string,
  panes: ReturnType<typeof store.get>["panes"],
) {
  const pane = panes.find((p) => p.pane_id === paneId);
  if (pane?.agent) return pane.agent;
  const cwd = pane?.foreground_cwd ?? pane?.cwd;
  const name = cwd?.split(/[\\/]/).filter(Boolean).pop();
  return name || paneId;
}

function PaneJumpOverlay({
  entries,
  selectedIndex,
  onSelectIndex,
  onCommit,
}: {
  entries: PaneJumpEntry[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onCommit: (index: number) => void;
}) {
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const selectedPaneId = entries[selectedIndex]?.paneId;

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, selectedPaneId]);

  if (entries.length === 0) return null;
  return (
    <div className="pane-jump-backdrop">
      <div
        className="pane-jump-popover"
        role="listbox"
        aria-label="Recent panes"
      >
        <div className="pane-jump-head">
          <strong>Switch Pane</strong>
          <span>Hold Ctrl, use Tab / Up / Down, release Ctrl</span>
        </div>
        <div className="pane-jump-list">
          {entries.map((entry, index) => (
            <button
              key={entry.paneId}
              ref={index === selectedIndex ? selectedItemRef : undefined}
              type="button"
              className={`pane-jump-item ${
                index === selectedIndex ? "is-selected" : ""
              } ${entry.current ? "is-current" : ""}`}
              role="option"
              aria-selected={index === selectedIndex}
              onPointerEnter={() => onSelectIndex(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onCommit(index)}
            >
              {entry.agent ? (
                <span className="pane-jump-agent-identity">
                  <AgentIcon agent={entry.agent} compact />
                  <span
                    className={`pane-jump-status status-${entry.agentStatus ?? "unknown"}`}
                  />
                </span>
              ) : null}
              <span className="pane-jump-text">
                <span className="pane-jump-title-line">
                  <strong>{entry.title}</strong>
                  {entry.current ? (
                    <span className="pane-jump-current-badge">Current</span>
                  ) : null}
                  {entry.agentStatus ? (
                    <span
                      className={`${agentClass(entry.agentStatus)} pane-jump-agent-status`}
                    >
                      {entry.agentStatus}
                    </span>
                  ) : null}
                </span>
                <span className="pane-jump-subtitle">
                  {entry.agent ? (
                    <>
                      <span className="pane-jump-agent-name">
                        {entry.agent}
                      </span>
                      {entry.subtitle ? " · " : ""}
                    </>
                  ) : null}
                  {entry.subtitle}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type PaneLayoutSnapshot = NonNullable<ReturnType<typeof store.get>["layout"]>;
type PaneLayoutPaneSnapshot = PaneLayoutSnapshot["panes"][number];
type PaneLayoutSplitSnapshot = PaneLayoutSnapshot["splits"][number];
type PaneResizeDirection = "left" | "right" | "up" | "down";

function overlapLength(
  aStart: number,
  aSize: number,
  bStart: number,
  bSize: number,
) {
  return Math.max(
    0,
    Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart),
  );
}

function bestPaneNearSplit(
  panes: PaneLayoutPaneSnapshot[],
  split: PaneLayoutSplitSnapshot,
  side: "before" | "after",
  pointerPerpendicular: number,
) {
  const boundary =
    split.direction === "right"
      ? split.rect.x + split.rect.width * split.ratio
      : split.rect.y + split.rect.height * split.ratio;
  const edgeTolerance = 6;
  const containsPointer = (pane: PaneLayoutPaneSnapshot) =>
    split.direction === "right"
      ? pointerPerpendicular >= pane.rect.y &&
        pointerPerpendicular <= pane.rect.y + pane.rect.height
      : pointerPerpendicular >= pane.rect.x &&
        pointerPerpendicular <= pane.rect.x + pane.rect.width;
  const candidates = panes
    .map((pane) => {
      const edge =
        split.direction === "right"
          ? side === "before"
            ? pane.rect.x + pane.rect.width
            : pane.rect.x
          : side === "before"
            ? pane.rect.y + pane.rect.height
            : pane.rect.y;
      const perpendicularOverlap =
        split.direction === "right"
          ? overlapLength(
              pane.rect.y,
              pane.rect.height,
              split.rect.y,
              split.rect.height,
            )
          : overlapLength(
              pane.rect.x,
              pane.rect.width,
              split.rect.x,
              split.rect.width,
            );
      return {
        pane,
        edgeDistance: Math.abs(edge - boundary),
        perpendicularOverlap,
      };
    })
    .filter(
      ({ pane, edgeDistance, perpendicularOverlap }) =>
        edgeDistance <= edgeTolerance &&
        perpendicularOverlap > 0 &&
        containsPointer(pane),
    )
    .sort((a, b) => b.perpendicularOverlap - a.perpendicularOverlap);
  return candidates[0]?.pane ?? null;
}

function splitBoundaryFromPaneRects(
  panes: PaneLayoutPaneSnapshot[],
  split: PaneLayoutSplitSnapshot,
) {
  const ratioBoundary =
    split.direction === "right"
      ? split.rect.x + split.rect.width * split.ratio
      : split.rect.y + split.rect.height * split.ratio;
  const before = bestPaneNearSplit(
    panes,
    split,
    "before",
    split.direction === "right"
      ? split.rect.y + split.rect.height / 2
      : split.rect.x + split.rect.width / 2,
  );
  const after = bestPaneNearSplit(
    panes,
    split,
    "after",
    split.direction === "right"
      ? split.rect.y + split.rect.height / 2
      : split.rect.x + split.rect.width / 2,
  );
  if (!before || !after) return ratioBoundary;
  const beforeEdge =
    split.direction === "right"
      ? before.rect.x + before.rect.width
      : before.rect.y + before.rect.height;
  const afterEdge = split.direction === "right" ? after.rect.x : after.rect.y;
  return (beforeEdge + afterEdge) / 2;
}

function resizeTargetForSplit(
  layout: PaneLayoutSnapshot,
  split: PaneLayoutSplitSnapshot,
  dragSign: 1 | -1,
  pointerPerpendicular: number,
): { paneId: string; direction: PaneResizeDirection } | null {
  if (split.direction === "right") {
    const side = dragSign > 0 ? "before" : "after";
    const pane = bestPaneNearSplit(
      layout.panes,
      split,
      side,
      pointerPerpendicular,
    );
    return pane
      ? { paneId: pane.pane_id, direction: dragSign > 0 ? "right" : "left" }
      : null;
  }
  const side = dragSign > 0 ? "before" : "after";
  const pane = bestPaneNearSplit(
    layout.panes,
    split,
    side,
    pointerPerpendicular,
  );
  return pane
    ? { paneId: pane.pane_id, direction: dragSign > 0 ? "down" : "up" }
    : null;
}

// Render the active tab's Herdr pane layout; single-pane and zoomed tabs keep
// the old full terminal view.
function TerminalPaneLayout({
  mobileShortcuts,
  mobileSideShortcuts,
  agentHistoryOpen,
  onAgentHistoryOpenChange,
  onOpenWorkspaceFile,
}: {
  mobileShortcuts: MobileTerminalShortcutRows;
  mobileSideShortcuts: MobileTerminalSideShortcuts;
  agentHistoryOpen: boolean;
  onAgentHistoryOpenChange: (open: boolean) => void;
  onOpenWorkspaceFile: (request: TerminalWorkspaceFileRequest) => void;
}) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
    }),
    shallowEqual,
  );
  const mobile = useMobileLayout();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const layout = s.layout;
  const visiblePanes =
    layout?.panes.filter((lp) =>
      s.panes.some((pane) => pane.pane_id === lp.pane_id),
    ) ?? [];
  const fallbackPaneId = visiblePanes[0]?.pane_id ?? null;
  const activePaneId =
    visiblePanes.find((lp) => lp.pane_id === s.selectedPaneId)?.pane_id ??
    visiblePanes.find((lp) => lp.pane_id === layout?.focused_pane_id)
      ?.pane_id ??
    fallbackPaneId;
  const mountKeyForPane = (paneId: string | null) => {
    const terminalId =
      s.panes.find((pane) => pane.pane_id === paneId)?.terminal_id ?? null;
    return terminalMountKey(
      {
        connectionId: s.activeConnectionId,
        generation: s.connectionGeneration,
      },
      paneId,
      terminalId,
    );
  };

  if (!layout || layout.zoomed || visiblePanes.length <= 1) {
    return (
      <TerminalView
        key={mountKeyForPane(activePaneId)}
        mobileShortcuts={mobileShortcuts}
        mobileSideShortcuts={mobileSideShortcuts}
        agentHistoryOpen={agentHistoryOpen}
        onAgentHistoryOpenChange={onAgentHistoryOpenChange}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    );
  }

  if (mobile && activePaneId) {
    const activeIndex = Math.max(
      0,
      visiblePanes.findIndex((lp) => lp.pane_id === activePaneId),
    );
    const previousPane =
      visiblePanes[
        (activeIndex - 1 + visiblePanes.length) % visiblePanes.length
      ];
    const nextPane = visiblePanes[(activeIndex + 1) % visiblePanes.length];
    const blurActiveInput = () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    };

    return (
      <div className="pane-switcher-layout" aria-label="Terminal pane switcher">
        <div className="pane-switcher">
          <button
            type="button"
            className="pane-switcher-button"
            aria-label="Previous pane"
            tabIndex={-1}
            onPointerDown={blurActiveInput}
            onClick={() => void store.focusPane(previousPane.pane_id)}
          >
            <ChevronLeft size={15} />
          </button>
          <div className="pane-switcher-label">
            <strong>
              Pane {activeIndex + 1} / {visiblePanes.length}
            </strong>
            <span>{paneTitle(activePaneId, s.panes)}</span>
          </div>
          <button
            type="button"
            className="pane-switcher-button"
            aria-label="Next pane"
            tabIndex={-1}
            onPointerDown={blurActiveInput}
            onClick={() => void store.focusPane(nextPane.pane_id)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <TerminalView
          key={mountKeyForPane(activePaneId)}
          paneId={activePaneId}
          mobileShortcuts={mobileShortcuts}
          mobileSideShortcuts={mobileSideShortcuts}
          agentHistoryOpen={agentHistoryOpen}
          onAgentHistoryOpenChange={onAgentHistoryOpenChange}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      </div>
    );
  }

  const area = layout.area;
  const areaWidth = Math.max(1, area.width);
  const areaHeight = Math.max(1, area.height);
  const startPaneResize = (
    e: React.PointerEvent<HTMLDivElement>,
    split: PaneLayoutSplitSnapshot,
  ) => {
    if (e.button !== 0) return;
    const container = layoutRef.current;
    if (!container) return;
    e.preventDefault();
    e.stopPropagation();

    const bounds = container.getBoundingClientRect();
    const horizontal = split.direction === "right";
    const startAxis = horizontal ? e.clientX : e.clientY;
    const pointerPerpendicular = horizontal
      ? area.y +
        ((e.clientY - bounds.top) / Math.max(1, bounds.height)) * areaHeight
      : area.x +
        ((e.clientX - bounds.left) / Math.max(1, bounds.width)) * areaWidth;
    const splitPixelSize = horizontal
      ? (split.rect.width / areaWidth) * bounds.width
      : (split.rect.height / areaHeight) * bounds.height;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    // Capture the pointer so pointerup still reaches the window (and restores
    // cursor/user-select) even when released outside the browser window.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; window listeners still apply.
    }

    const finish = (event: PointerEvent) => {
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;

      const endAxis = horizontal ? event.clientX : event.clientY;
      const deltaPx = endAxis - startAxis;
      if (Math.abs(deltaPx) < 4) return;
      const dragSign = deltaPx > 0 ? 1 : -1;
      const target = resizeTargetForSplit(
        layout,
        split,
        dragSign,
        pointerPerpendicular,
      );
      if (!target) return;
      const amount = Math.min(
        0.5,
        Math.abs(deltaPx) / Math.max(1, splitPixelSize),
      );
      void store.resizePane(target.paneId, target.direction, amount);
    };
    const cancel = () => {
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
  };

  return (
    <div ref={layoutRef} className="pane-layout" aria-label="Terminal panes">
      {visiblePanes.map((layoutPane) => {
        const rect = layoutPane.rect;
        const isActive = layoutPane.pane_id === activePaneId;
        return (
          <div
            key={mountKeyForPane(layoutPane.pane_id)}
            className={`pane-layout-cell ${isActive ? "is-active" : ""}`}
            style={{
              left: `${rectPercent(rect.x, area.x, areaWidth)}%`,
              top: `${rectPercent(rect.y, area.y, areaHeight)}%`,
              width: `${(rect.width / areaWidth) * 100}%`,
              height: `${(rect.height / areaHeight) * 100}%`,
            }}
            onPointerDownCapture={() => {
              if (!isActive) void store.focusPane(layoutPane.pane_id);
            }}
          >
            <TerminalView
              key={mountKeyForPane(layoutPane.pane_id)}
              paneId={layoutPane.pane_id}
              showMobileKeys={isActive}
              mobileShortcuts={mobileShortcuts}
              mobileSideShortcuts={mobileSideShortcuts}
              agentHistoryOpen={isActive ? agentHistoryOpen : false}
              onAgentHistoryOpenChange={onAgentHistoryOpenChange}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          </div>
        );
      })}
      {layout.splits.map((split) => {
        const horizontal = split.direction === "right";
        const boundary = splitBoundaryFromPaneRects(layout.panes, split);
        return (
          <div
            key={split.id}
            className={`pane-resize-handle ${horizontal ? "is-vertical" : "is-horizontal"}`}
            style={
              horizontal
                ? {
                    left: `${rectPercent(boundary, area.x, areaWidth)}%`,
                    top: `${rectPercent(split.rect.y, area.y, areaHeight)}%`,
                    height: `${(split.rect.height / areaHeight) * 100}%`,
                  }
                : {
                    top: `${rectPercent(boundary, area.y, areaHeight)}%`,
                    left: `${rectPercent(split.rect.x, area.x, areaWidth)}%`,
                    width: `${(split.rect.width / areaWidth) * 100}%`,
                  }
            }
            onPointerDown={(event) => startPaneResize(event, split)}
            role="separator"
            aria-orientation={horizontal ? "vertical" : "horizontal"}
          />
        );
      })}
    </div>
  );
}

export default function App() {
  const s = useStoreSelector(
    (state) => ({
      lastRefresh: state.lastRefresh,
      layout: state.layout,
      notice: state.notice,
      panes: state.panes,
      pendingFocusWorkspaceId: state.pendingFocusWorkspaceId,
      recentPaneIds: state.recentPaneIds,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      tabs: state.tabs,
      updateInfo: state.updateInfo,
      updateInstalling: state.updateInstalling,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const connectionClient = useConnectionClient();
  useVisualViewportCssVars();
  const mobile = useMobileLayout();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [mobileView, setMobileView] = useState<MobileView>("session");
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    loadSystemTheme(),
  );
  const [accentColor, setAccentColor] = useState<AccentColor>(() =>
    loadAccentColor(),
  );
  const [mobileTerminalShortcuts, setMobileTerminalShortcuts] =
    useState<MobileTerminalShortcutRows>(loadMobileTerminalShortcuts);
  const [mobileTerminalSideShortcuts, setMobileTerminalSideShortcuts] =
    useState<MobileTerminalSideShortcuts>(loadMobileTerminalSideShortcuts);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [mobileControlsCollapsed, setMobileControlsCollapsed] = useState(false);
  const [paneJumpOpen, setPaneJumpOpen] = useState(false);
  const [paneJumpIndex, setPaneJumpIndex] = useState(0);
  const paneJumpCtrlDownRef = useRef(false);
  const paneJumpIndexRef = useRef(0);
  const [inspectorState, setInspectorState] =
    useState<WorkspaceInspectorState | null>(null);
  const inspectorStateRef = useRef<WorkspaceInspectorState | null>(null);
  const inspectorReturnFocusRef = useRef<HTMLElement | null>(null);
  const pendingInspectorRequestRef = useRef<WorkspaceInspectorRequest | null>(
    null,
  );
  const inspectorStageRef = useRef<HTMLDivElement | null>(null);
  const inspectorResizeFrameRef = useRef<number | null>(null);
  const [activeDiff, setActiveDiff] = useState<ActiveDiffSelection>(
    emptyActiveDiffSelection,
  );
  const [activeFilePreview, setActiveFilePreview] =
    useState<ActiveFilePreviewSelection>(emptyActiveFilePreviewSelection);
  const fileQuickOpenRequestRef = useRef(0);
  const resourceUiKey = connectionClientScopeKey(
    connectionClient,
    "resource-ui",
  );
  const resourceRuntimeKeyRef = useRef(resourceUiKey);
  const focusedWorkspace = s.workspaces.find((w) => w.focused);
  const activePaneId = activePaneIdForSnapshot(s);
  const activePane = activePaneId
    ? s.panes.find((pane) => pane.pane_id === activePaneId)
    : undefined;
  const paneJumpOptions = useMemo(
    () =>
      paneJumpEntries(
        {
          layout: s.layout,
          panes: s.panes,
          recentPaneIds: s.recentPaneIds,
          tabs: s.tabs,
          workspaces: s.workspaces,
        },
        activePaneId,
      ),
    [activePaneId, s.layout, s.panes, s.recentPaneIds, s.tabs, s.workspaces],
  );
  const activePaneHasAgent = paneHasAgentHistory(activePane);
  const historyInspectorOpen =
    inspectorState?.open === true && inspectorState.view === "history";
  const agentHistoryOpen =
    historyInspectorOpen &&
    (!inspectorState.originPaneId ||
      inspectorState.originPaneId === activePane?.pane_id);
  const inspectorOriginPane = inspectorState?.originPaneId
    ? s.panes.find((pane) => pane.pane_id === inspectorState.originPaneId)
    : undefined;
  const inspectorHistoryPaneCandidate =
    inspectorOriginPane ??
    (inspectorState?.view === "history" && inspectorState.originPaneId
      ? undefined
      : activePane);
  const inspectorWorkspace = inspectorState
    ? resolveWorkspaceForScope(inspectorState.scope, s.workspaces)
    : undefined;
  const inspectorHistoryPane =
    inspectorHistoryPaneCandidate?.workspace_id ===
    inspectorWorkspace?.workspace_id
      ? inspectorHistoryPaneCandidate
      : undefined;
  const inspectorResourceStateKey = inspectorState
    ? resourceStateKey(inspectorState.scope)
    : null;

  const commitInspectorState = useCallback(
    (next: WorkspaceInspectorState | null) => {
      inspectorStateRef.current = next;
      setInspectorState(next);
    },
    [],
  );
  const updateInspectorState = useCallback(
    (
      update: (
        current: WorkspaceInspectorState | null,
      ) => WorkspaceInspectorState | null,
    ) => {
      const next = update(inspectorStateRef.current);
      inspectorStateRef.current = next;
      setInspectorState(next);
    },
    [],
  );
  const activateTerminalSurface = useCallback(() => {
    updateInspectorState((current) =>
      current ? { ...current, open: false, expanded: false } : current,
    );
    setMobileView("session");
    if (!mobile) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            ".pane-layout-cell.is-active .xterm-helper-textarea, .pane-switcher-layout .xterm-helper-textarea, .workspace-terminal-surface > .terminal-shell .xterm-helper-textarea",
          )
          ?.focus();
      });
    }
  }, [mobile, updateInspectorState]);
  const toggleSidebar = () => {
    setMobileView("session");
    setSidebarHidden((value) => !value);
  };
  const openWorkspaces = useCallback(() => {
    setSidebarHidden(false);
    if (mobile) {
      setMobileView("workspaces");
      return;
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".workspace-tree-panel")?.focus();
    });
  }, [mobile]);
  const loadInspectorFilePreview = useCallback(
    (workspaceId: string, entry: FileExplorerEntry) => {
      const requestId = fileQuickOpenRequestRef.current + 1;
      fileQuickOpenRequestRef.current = requestId;
      setActiveFilePreview({
        entry,
        preview: null,
        loading: true,
        error: null,
      });
      void requestFilePreview(workspaceId, entry.path, {
        client: connectionClient,
        refresh: true,
      })
        .then((preview) => {
          if (
            !connectionClient.isCurrent() ||
            fileQuickOpenRequestRef.current !== requestId
          ) {
            return;
          }
          setActiveFilePreview({
            entry,
            preview,
            loading: false,
            error: null,
          });
        })
        .catch((error) => {
          if (
            !connectionClient.isCurrent() ||
            fileQuickOpenRequestRef.current !== requestId
          ) {
            return;
          }
          setActiveFilePreview({
            entry,
            preview: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [connectionClient],
  );
  const openInspector = useCallback(
    (
      view: InspectorView,
      workspaceId?: string,
      options: OpenInspectorOptions = {},
    ) => {
      const snapshot = store.get();
      const workspace = workspaceId
        ? snapshot.workspaces.find(
            (candidate) => candidate.workspace_id === workspaceId,
          )
        : snapshot.workspaces.find((candidate) => candidate.focused);
      if (!workspace) {
        store.notify({
          kind: "error",
          message: `Cannot open ${
            view === "files"
              ? "Files"
              : view === "changes"
                ? "Changes"
                : "History"
          }`,
          detail: "The target workspace is no longer open.",
        });
        return;
      }

      const focusInspector = options.focusInspector ?? true;
      inspectorReturnFocusRef.current =
        focusInspector && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const scope = resourceScopeForWorkspace(
        connectionClient.connectionId,
        workspace,
      );
      const current = inspectorStateRef.current;
      const sameOwner = !!current && sameResourceOwner(current.scope, scope);
      const stageWidth = inspectorStageRef.current?.clientWidth ?? 0;
      const preferences = readInspectorPreferences(localStorage, scope, {
        rightSize: stageWidth > 0 ? stageWidth * 0.42 : undefined,
      });
      const dock = sameOwner ? current.dock : preferences.dock;
      const preferredSize = sameOwner
        ? current.size
        : dock === "right"
          ? preferences.rightSize
          : preferences.bottomSize;
      const stageHeight = inspectorStageRef.current?.clientHeight ?? 0;
      const clampToDock =
        (dock === "right" && stageWidth >= 1000) ||
        (dock === "bottom" && stageHeight > 0);
      const size = clampToDock
        ? Math.min(
            preferredSize,
            inspectorMaximumSize(dock, stageWidth, stageHeight),
          )
        : preferredSize;
      const originPane = options.originPaneId
        ? snapshot.panes.find((pane) => pane.pane_id === options.originPaneId)
        : snapshot.panes.find(
            (pane) =>
              pane.workspace_id === workspace.workspace_id && pane.focused,
          );
      const returnTabId =
        originPane?.tab_id ?? workspace.active_tab_id ?? current?.returnTabId;
      const nextState: WorkspaceInspectorState = {
        scope,
        open: true,
        view,
        dock,
        size,
        expanded: sameOwner ? current.expanded : false,
        returnTabId,
        originPaneId: options.originPaneId,
        initialDirectory: options.initialDirectory,
      };

      if (!workspace.focused) void store.focusWorkspace(workspace.workspace_id);
      if (!sameOwner) {
        fileQuickOpenRequestRef.current += 1;
        setActiveDiff(emptyActiveDiffSelection());
        setActiveFilePreview(emptyActiveFilePreviewSelection());
      }
      commitInspectorState(nextState);
      writeInspectorPreferences(localStorage, nextState);
      setSidebarHidden(false);
      if (mobile) setMobileView(view);
      if (focusInspector) {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              '.workspace-inspector-tabs [role="tab"][aria-selected="true"]',
            )
            ?.focus();
        });
      }

      const selectedPath =
        options.path ??
        (view === "files" && options.initialDirectory === undefined
          ? readResourceFileSelection(localStorage, scope)
          : undefined);
      if (view === "files" && !selectedPath) {
        setActiveFilePreview(emptyActiveFilePreviewSelection());
      }
      if (view !== "files" || !selectedPath) return;
      const entry =
        options.entry ??
        ({
          name: selectedPath.split("/").filter(Boolean).pop() ?? selectedPath,
          path: selectedPath,
          type: "file",
          size: 0,
          mtime_ms: 0,
          hidden:
            selectedPath.split("/").filter(Boolean).pop()?.startsWith(".") ??
            false,
        } satisfies FileExplorerEntry);
      loadInspectorFilePreview(workspace.workspace_id, entry);
    },
    [
      commitInspectorState,
      connectionClient.connectionId,
      loadInspectorFilePreview,
      mobile,
    ],
  );
  const openFileExplorer = useCallback(
    (workspaceId?: string, focusInspector = true) =>
      openInspector("files", workspaceId, { focusInspector }),
    [openInspector],
  );
  const openFileExplorerFile = useCallback(
    (workspaceId: string, entry: FileExplorerEntry, originPaneId?: string) =>
      openInspector("files", workspaceId, {
        entry,
        path: entry.path,
        originPaneId,
      }),
    [openInspector],
  );
  const openDiffViewer = useCallback(
    (workspaceId?: string, focusInspector = true) =>
      openInspector("changes", workspaceId, { focusInspector }),
    [openInspector],
  );
  const closeInspector = useCallback(() => {
    const current = inspectorStateRef.current;
    if (!current) return;
    const returnFocus = inspectorReturnFocusRef.current;
    inspectorReturnFocusRef.current = null;
    commitInspectorState({ ...current, open: false, expanded: false });
    setMobileView("session");
    const snapshot = store.get();
    const returnTab = current.returnTabId
      ? snapshot.tabs.find((tab) => tab.tab_id === current.returnTabId)
      : undefined;
    const workspace = resolveWorkspaceForScope(
      current.scope,
      snapshot.workspaces,
    );
    const tabId = returnTab?.tab_id ?? workspace?.active_tab_id;
    const restoreControlFocus = () => {
      if (!returnFocus?.isConnected) return;
      requestAnimationFrame(() => returnFocus.focus());
    };
    if (tabId) {
      void Promise.resolve(store.focusTab(tabId)).finally(restoreControlFocus);
    } else {
      restoreControlFocus();
    }
  }, [commitInspectorState]);
  const setAgentHistoryInspectorOpen = useCallback(
    (open: boolean, pane?: Pane) => {
      const current = inspectorStateRef.current;
      if (!open) {
        if (current?.open && current.view === "history") closeInspector();
        return;
      }
      const snapshot = store.get();
      const paneId = pane?.pane_id ?? activePaneIdForSnapshot(snapshot);
      const targetPane = paneId
        ? snapshot.panes.find((candidate) => candidate.pane_id === paneId)
        : undefined;
      if (
        !paneHasAgentHistory(targetPane) ||
        !snapshot.workspaces.some(
          (workspace) => workspace.workspace_id === targetPane.workspace_id,
        )
      ) {
        store.notify({
          kind: "error",
          message: "Cannot open History",
          detail: "Select an active agent pane first.",
        });
        return;
      }
      openInspector("history", targetPane.workspace_id, {
        originPaneId: targetPane.pane_id,
      });
    },
    [closeInspector, openInspector],
  );
  const toggleWorkspaceInspector = useCallback(() => {
    const current = inspectorStateRef.current;
    if (current?.open) {
      closeInspector();
      return;
    }
    const snapshot = store.get();
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.focused,
    );
    if (!workspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    const sameOwner = !!current && sameResourceOwner(current.scope, scope);
    const view = sameOwner
      ? current.view
      : readInspectorPreferences(localStorage, scope).view;
    const historyPaneId =
      sameOwner && current.originPaneId
        ? current.originPaneId
        : activePaneIdForSnapshot(snapshot);
    const historyPane = historyPaneId
      ? snapshot.panes.find((pane) => pane.pane_id === historyPaneId)
      : undefined;
    if (
      view === "history" &&
      (!paneHasAgentHistory(historyPane) ||
        historyPane?.workspace_id !== workspace.workspace_id)
    ) {
      openInspector("files", workspace.workspace_id);
      return;
    }
    openInspector(view, workspace.workspace_id, {
      originPaneId: view === "history" ? historyPane?.pane_id : undefined,
    });
  }, [closeInspector, connectionClient.connectionId, openInspector]);
  const keepInspectorForWorkspace = useCallback(
    (workspaceId: string, originPane?: Pane) => {
      const current = inspectorStateRef.current;
      if (!current?.open) {
        activateTerminalSurface();
        return;
      }
      const snapshot = store.get();
      const explicitPane = originPane
        ? snapshot.panes.find(
            (candidate) => candidate.pane_id === originPane.pane_id,
          )
        : undefined;
      const activePaneId = activePaneIdForSnapshot(snapshot);
      const workspacePanes = snapshot.panes.filter(
        (pane) => pane.workspace_id === workspaceId,
      );
      const routedPane =
        explicitPane ??
        workspacePanes.find((pane) => pane.pane_id === activePaneId) ??
        workspacePanes.find((pane) => pane.focused);
      const historyPane = paneHasAgentHistory(routedPane)
        ? routedPane
        : workspacePanes.find(paneHasAgentHistory);
      const view =
        current.view === "history" && !historyPane ? "files" : current.view;
      openInspector(view, workspaceId, {
        focusInspector: false,
        originPaneId:
          explicitPane?.pane_id ??
          (view === "history" ? historyPane?.pane_id : undefined),
      });
    },
    [activateTerminalSurface, openInspector],
  );
  const toggleFileExplorer = useCallback(() => {
    const snapshot = store.get();
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.focused,
    );
    if (!workspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    const current = inspectorStateRef.current;
    if (
      current?.open &&
      current.view === "files" &&
      sameResourceOwner(current.scope, scope)
    ) {
      closeInspector();
      return;
    }
    openFileExplorer(workspace.workspace_id, false);
  }, [closeInspector, connectionClient.connectionId, openFileExplorer]);
  const toggleDiffViewer = useCallback(() => {
    const snapshot = store.get();
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.focused,
    );
    if (!workspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    const current = inspectorStateRef.current;
    if (
      current?.open &&
      current.view === "changes" &&
      sameResourceOwner(current.scope, scope)
    ) {
      closeInspector();
      return;
    }
    openDiffViewer(workspace.workspace_id, false);
  }, [closeInspector, connectionClient.connectionId, openDiffViewer]);
  const handleDiffSelectionChange = useCallback(
    (stateKey: string, selection: ActiveDiffSelection) => {
      const current = inspectorStateRef.current;
      if (!current || resourceStateKey(current.scope) !== stateKey) return;
      setActiveDiff(selection);
    },
    [],
  );
  const handleFilePreviewChange = useCallback(
    (stateKey: string, selection: ActiveFilePreviewSelection) => {
      const current = inspectorStateRef.current;
      if (!current || resourceStateKey(current.scope) !== stateKey) return;
      setActiveFilePreview(selection);
    },
    [],
  );
  const openDiffFileInExplorer = useCallback(
    (entry: ActiveDiffSelection["entry"]) => {
      const current = inspectorStateRef.current;
      if (!entry || !current) return;
      const workspace = resolveWorkspaceForScope(
        current.scope,
        store.get().workspaces,
      );
      if (!workspace) return;
      const name = entry.path.split("/").filter(Boolean).pop() ?? entry.path;
      openFileExplorerFile(workspace.workspace_id, {
        name,
        path: entry.path,
        type: "file",
        size: 0,
        mtime_ms: 0,
        hidden: name.startsWith("."),
      });
    },
    [openFileExplorerFile],
  );
  const browseFilesForPane = useCallback(
    (pane: Pane) => {
      const workspace = store
        .get()
        .workspaces.find(
          (candidate) => candidate.workspace_id === pane.workspace_id,
        );
      if (!workspace) return;
      const root = workspace.worktree?.checkout_path ?? workspace.cwd;
      const initialDirectory = root
        ? relativePathWithinCheckout(root, pane.foreground_cwd ?? pane.cwd)
        : undefined;
      openInspector("files", workspace.workspace_id, {
        originPaneId: pane.pane_id,
        initialDirectory,
      });
    },
    [openInspector],
  );
  const reviewChangesForPane = useCallback(
    (pane: Pane) =>
      openInspector("changes", pane.workspace_id, {
        originPaneId: pane.pane_id,
      }),
    [openInspector],
  );
  const handleTerminalWorkspaceFile = useCallback(
    (request: TerminalWorkspaceFileRequest) => {
      if (
        request.connectionId !== connectionClient.connectionId ||
        request.connectionGeneration !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      const name =
        request.path.split("/").filter(Boolean).pop() ?? request.path;
      openFileExplorerFile(
        request.workspaceId,
        {
          name,
          path: request.path,
          type: "file",
          size: 0,
          mtime_ms: 0,
          hidden: name.startsWith("."),
        },
        request.paneId,
      );
    },
    [connectionClient, openFileExplorerFile],
  );
  const openNotificationTarget = useCallback(
    (target: TaskNotificationTarget) => {
      if (!inspectorStateRef.current?.open) activateTerminalSurface();
      setSidebarHidden(false);
      void store.focusTaskNotificationTarget(target);
    },
    [activateTerminalSurface],
  );
  const handleNoticeAction = useCallback(
    (notice: Notice) => {
      if (notice.actionClipboardText !== undefined) {
        const text = notice.actionClipboardText;
        store.clearNotice();
        void copyTextFromUserGesture(text).then(
          () =>
            store.notify({
              kind: "success",
              message: "Copied to clipboard",
              autoDismissMs: 5000,
            }),
          (error) =>
            store.notify({
              kind: "error",
              message: "Terminal copy failed",
              detail: error instanceof Error ? error.message : String(error),
            }),
        );
        return;
      }
      const target = taskNotificationTargetFromNotice(notice);
      store.clearNotice();
      if (target) openNotificationTarget(target);
    },
    [openNotificationTarget],
  );
  useEffect(() => {
    const handleSystemNotification = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail;
      if (!isTaskNotificationTarget(target)) return;
      openNotificationTarget(target);
      const notice = store.get().notice;
      if (
        notice?.actionConnectionId === target.connectionId &&
        notice.actionRuntimeGeneration === target.runtimeGeneration &&
        notice.actionPaneId === target.paneId
      ) {
        store.clearNotice();
      }
    };
    window.addEventListener(
      TASK_NOTIFICATION_ACTIVATE_EVENT,
      handleSystemNotification,
    );
    return () =>
      window.removeEventListener(
        TASK_NOTIFICATION_ACTIVATE_EVENT,
        handleSystemNotification,
      );
  }, [openNotificationTarget]);
  useEffect(() => {
    const handleInspectorRequest = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceInspectorRequest>).detail;
      if (
        !detail ||
        detail.connectionId !== connectionClient.connectionId ||
        detail.generation !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      const workspaceOpen = store
        .get()
        .workspaces.some(
          (workspace) => workspace.workspace_id === detail.workspaceId,
        );
      if (!workspaceOpen) {
        pendingInspectorRequestRef.current = detail;
        return;
      }
      pendingInspectorRequestRef.current = null;
      openInspector(detail.view, detail.workspaceId);
    };
    window.addEventListener(
      WORKSPACE_INSPECTOR_REQUEST_EVENT,
      handleInspectorRequest,
    );
    return () =>
      window.removeEventListener(
        WORKSPACE_INSPECTOR_REQUEST_EVENT,
        handleInspectorRequest,
      );
  }, [connectionClient, openInspector]);
  useEffect(() => {
    const pending = pendingInspectorRequestRef.current;
    if (!pending) return;
    if (
      pending.connectionId !== connectionClient.connectionId ||
      pending.generation !== connectionClient.generation
    ) {
      pendingInspectorRequestRef.current = null;
      return;
    }
    if (
      !s.workspaces.some(
        (workspace) => workspace.workspace_id === pending.workspaceId,
      )
    ) {
      return;
    }
    pendingInspectorRequestRef.current = null;
    openInspector(pending.view, pending.workspaceId);
  }, [connectionClient, openInspector, s.workspaces]);
  useEffect(() => {
    const handleWorktreeRemoved = (event: Event) => {
      const detail = (event as CustomEvent<WorktreeRemovedTarget>).detail;
      if (
        !detail ||
        detail.connectionId !== connectionClient.connectionId ||
        detail.generation !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      const scope = resourceScopeForWorkspace(
        detail.connectionId,
        detail.workspace,
      );
      const resourceKey = resourceOwnerKey(scope);
      clearFileExplorerResourceCache(
        connectionClient,
        resourceKey,
        localStorage,
      );
      clearDiffContentResourceState(resourceStateKey(scope));
      clearDiffViewerResourceCache(connectionClient, resourceKey, localStorage);
      writeResourceFileSelection(localStorage, scope, null);
      const current = inspectorStateRef.current;
      if (!current || !sameResourceOwner(current.scope, scope)) return;
      fileQuickOpenRequestRef.current += 1;
      inspectorReturnFocusRef.current = null;
      commitInspectorState(null);
      setActiveDiff(emptyActiveDiffSelection());
      setActiveFilePreview(emptyActiveFilePreviewSelection());
      setMobileView("session");
    };
    window.addEventListener(WORKTREE_REMOVED_EVENT, handleWorktreeRemoved);
    return () =>
      window.removeEventListener(WORKTREE_REMOVED_EVENT, handleWorktreeRemoved);
  }, [commitInspectorState, connectionClient]);
  const closePaneJump = useCallback(() => {
    paneJumpCtrlDownRef.current = false;
    setPaneJumpOpen(false);
  }, []);
  const selectPaneJumpIndex = useCallback(
    (index: number) => {
      const length = paneJumpOptions.length;
      const next = length > 0 ? ((index % length) + length) % length : 0;
      paneJumpIndexRef.current = next;
      setPaneJumpIndex(next);
    },
    [paneJumpOptions.length],
  );
  const commitPaneJump = useCallback(
    (index = paneJumpIndexRef.current) => {
      const targetPaneId = paneJumpTargetId(paneJumpOptions, index);
      closePaneJump();
      if (!targetPaneId) return;
      if (!inspectorStateRef.current?.open) setMobileView("session");
      void store.focusPane(targetPaneId);
    },
    [closePaneJump, paneJumpOptions],
  );
  const movePaneJumpSelection = useCallback(
    (delta: number) => {
      selectPaneJumpIndex(paneJumpIndexRef.current + delta);
    },
    [selectPaneJumpIndex],
  );
  const defaultPaneJumpIndex = useCallback(() => {
    const previousPaneIndex = paneJumpOptions.findIndex(
      (entry) => !entry.current,
    );
    return previousPaneIndex >= 0 ? previousPaneIndex : 0;
  }, [paneJumpOptions]);

  useLayoutEffect(() => {
    if (resourceRuntimeKeyRef.current === resourceUiKey) return;
    resourceRuntimeKeyRef.current = resourceUiKey;
    fileQuickOpenRequestRef.current += 1;
    pendingInspectorRequestRef.current = null;
    inspectorReturnFocusRef.current = null;
    commitInspectorState(null);
    setActiveDiff(emptyActiveDiffSelection());
    setActiveFilePreview(emptyActiveFilePreviewSelection());
    setPaneJumpOpen(false);
    setPaneJumpIndex(0);
    setMobileView("session");
  }, [commitInspectorState, resourceUiKey]);

  useEffect(() => {
    store.init();
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const current = inspectorStateRef.current;
    setMobileView(current?.open ? current.view : "session");
  }, [mobile]);
  useLayoutEffect(() => {
    const current = inspectorStateRef.current;
    if (!current?.open || !focusedWorkspace || s.pendingFocusWorkspaceId) {
      return;
    }
    const routedWorkspace = resolveWorkspaceForScope(
      current.scope,
      s.workspaces,
    );
    if (routedWorkspace?.workspace_id === focusedWorkspace.workspace_id) return;
    keepInspectorForWorkspace(focusedWorkspace.workspace_id);
  }, [
    focusedWorkspace,
    keepInspectorForWorkspace,
    s.pendingFocusWorkspaceId,
    s.workspaces,
  ]);
  useEffect(() => {
    if (paneJumpOpen && paneJumpOptions.length === 0) closePaneJump();
    if (paneJumpIndexRef.current >= paneJumpOptions.length) {
      selectPaneJumpIndex(paneJumpOptions.length - 1);
    }
  }, [
    closePaneJump,
    paneJumpOpen,
    paneJumpOptions.length,
    selectPaneJumpIndex,
  ]);
  useLayoutEffect(() => {
    const current = inspectorStateRef.current;
    if (!current) return;
    const workspace = resolveWorkspaceForScope(current.scope, s.workspaces);
    if (!workspace) {
      if (s.status === "connected" && s.lastRefresh > 0) {
        fileQuickOpenRequestRef.current += 1;
        inspectorReturnFocusRef.current = null;
        commitInspectorState(null);
        setActiveDiff(emptyActiveDiffSelection());
        setActiveFilePreview(emptyActiveFilePreviewSelection());
        setMobileView("session");
      }
      return;
    }
    if (workspace.workspace_id === current.scope.workspaceId) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    commitInspectorState({ ...current, scope });
    if (current.view === "files" && activeFilePreview.entry) {
      loadInspectorFilePreview(workspace.workspace_id, activeFilePreview.entry);
    }
  }, [
    activeFilePreview.entry,
    commitInspectorState,
    connectionClient,
    loadInspectorFilePreview,
    s.lastRefresh,
    s.status,
    s.workspaces,
  ]);
  useEffect(() => {
    const current = inspectorStateRef.current;
    if (!current || !activeFilePreview.entry?.path) return;
    writeResourceFileSelection(
      localStorage,
      current.scope,
      activeFilePreview.entry.path,
    );
  }, [activeFilePreview.entry?.path, inspectorResourceStateKey]);
  useEffect(() => {
    if (!focusedWorkspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      focusedWorkspace,
    );
    const resourceKey = resourceOwnerKey(scope);
    if (
      !inspectorState?.open ||
      !sameResourceOwner(inspectorState.scope, scope)
    ) {
      void prefetchFileExplorerWorkspace(
        focusedWorkspace.workspace_id,
        connectionClient,
        resourceKey,
      );
    }
    if (
      !inspectorState?.open ||
      !sameResourceOwner(inspectorState.scope, scope)
    ) {
      void prefetchDiffViewerWorkspace(
        focusedWorkspace.workspace_id,
        connectionClient,
        resourceKey,
      );
    }
  }, [connectionClient, focusedWorkspace, inspectorState]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paneJumpOpen) {
        const paneJumpNavigationKey =
          e.key === "Tab" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Enter" ||
          e.key === "Escape";
        if (paneJumpNavigationKey) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Tab") {
            movePaneJumpSelection(e.shiftKey ? -1 : 1);
          } else if (e.key === "ArrowDown") {
            movePaneJumpSelection(1);
          } else if (e.key === "ArrowUp") {
            movePaneJumpSelection(-1);
          } else if (e.key === "Enter") {
            commitPaneJump();
          } else if (e.key === "Escape") {
            closePaneJump();
          }
          return;
        }
        if (e.key !== "Control" && e.key !== "Shift") {
          closePaneJump();
        }
      }
      const paneJumpShortcut =
        e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab";
      if (paneJumpShortcut) {
        if (isEditableElement(e.target)) return;
        if (paneJumpOptions.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (!paneJumpCtrlDownRef.current) {
          paneJumpCtrlDownRef.current = true;
          selectPaneJumpIndex(defaultPaneJumpIndex());
          setPaneJumpOpen(true);
        }
        return;
      }
      if (e.key === "Escape") {
        if (
          document.getElementById(CONFIG_MENU_ID) ||
          document.querySelector(
            ".context-menu, .command-popover, .modal-backdrop",
          )
        ) {
          return;
        }
        const current = store.get();
        const canDismissUpdate =
          current.updateInfo?.update_available && !current.updateInstalling;
        if (current.notice || canDismissUpdate) {
          e.preventDefault();
          e.stopPropagation();
          if (current.notice) store.clearNotice();
          if (canDismissUpdate) store.dismissUpdate();
          return;
        }
        const inspector = inspectorStateRef.current;
        if (inspector?.expanded) {
          e.preventDefault();
          e.stopPropagation();
          const next = { ...inspector, expanded: false };
          commitInspectorState(next);
          writeInspectorPreferences(localStorage, next);
          return;
        }
        if (inspector?.open) {
          e.preventDefault();
          e.stopPropagation();
          closeInspector();
        }
        return;
      }
      const tabAction = tabShortcutAction(e);
      if (tabAction) {
        // Browser-level Cmd+T/Cmd+W may still be reserved by the host browser,
        // but standalone/webview clients can route them through this handler.
        e.preventDefault();
        e.stopPropagation();
        if (
          isEditableElement(e.target) ||
          document.querySelector(".modal-backdrop")
        ) {
          return;
        }
        if (e.repeat && (tabAction === "create" || tabAction === "close")) {
          return;
        }

        const current = store.get();
        const focusedWorkspace = current.workspaces.find(
          (workspace) => workspace.focused,
        );
        if (!focusedWorkspace) return;
        if (tabAction === "create") {
          void store.createTab(focusedWorkspace.workspace_id, {
            numberedLabel: true,
          });
          return;
        }

        const tabs = current.tabs
          .filter((tab) => tab.workspace_id === focusedWorkspace.workspace_id)
          .sort((a, b) => a.number - b.number);
        const tabIds = new Set(tabs.map((tab) => tab.tab_id));
        const activeTabId = [
          focusedWorkspace.active_tab_id,
          current.layout?.tab_id,
          tabs.find((tab) => tab.focused)?.tab_id,
        ].find((tabId): tabId is string => !!tabId && tabIds.has(tabId));
        if (tabAction === "close") {
          if (activeTabId) requestCloseTab(activeTabId);
          return;
        }

        const targetTabId = adjacentTabId(tabs, activeTabId, tabAction);
        if (!targetTabId || targetTabId === activeTabId) return;
        store.focusTab(targetTabId);
        return;
      }
      const tabIndex = tabShortcutIndex(e);
      if (tabIndex !== null) {
        if (isEditableElement(e.target)) return;
        const current = store.get();
        const focusedWorkspace = current.workspaces.find((w) => w.focused);
        const tabs = current.tabs
          .filter((tab) => tab.workspace_id === focusedWorkspace?.workspace_id)
          .sort((a, b) => a.number - b.number);
        const targetTab = tabs[tabIndex];
        if (!targetTab) return;
        e.preventDefault();
        e.stopPropagation();
        store.focusTab(targetTab.tab_id);
        return;
      }
      if (isWorkspaceInspectorShortcut(e)) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleWorkspaceInspector();
        return;
      }
      const fileExplorerShortcut =
        e.key.toLowerCase() === "e" &&
        e.shiftKey &&
        !e.altKey &&
        (e.metaKey || e.ctrlKey);
      if (fileExplorerShortcut) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleFileExplorer();
        return;
      }
      const workspacesShortcut =
        e.key.toLowerCase() === "w" &&
        e.ctrlKey &&
        !e.metaKey &&
        e.shiftKey &&
        !e.altKey;
      if (workspacesShortcut) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        openWorkspaces();
        return;
      }
      const diffViewerShortcut =
        e.key.toLowerCase() === "g" &&
        e.shiftKey &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey;
      if (diffViewerShortcut) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleDiffViewer();
        return;
      }
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "b" || isEditableElement(e.target)) return;
      e.preventDefault();
      toggleSidebar();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!paneJumpOpen) {
        if (!e.ctrlKey) paneJumpCtrlDownRef.current = false;
        return;
      }
      if (e.key === "Control" || !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        commitPaneJump();
      }
    };
    const onBlur = () => {
      if (paneJumpOpen) closePaneJump();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, [
    activateTerminalSurface,
    closeInspector,
    closePaneJump,
    commitInspectorState,
    commitPaneJump,
    defaultPaneJumpIndex,
    movePaneJumpSelection,
    openWorkspaces,
    paneJumpOpen,
    paneJumpOptions.length,
    selectPaneJumpIndex,
    toggleDiffViewer,
    toggleFileExplorer,
    toggleWorkspaceInspector,
  ]);
  useEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setSystemTheme(resolveSystemTheme(event));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useLayoutEffect(() => {
    const resolvedTheme = theme === "system" ? systemTheme : theme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.accent = accentColor;
    localStorage.setItem(ACCENT_COLOR_KEY, accentColor);
  }, [accentColor, systemTheme, theme]);
  useEffect(() => {
    localStorage.setItem(
      MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
      serializeMobileTerminalShortcutRows(mobileTerminalShortcuts),
    );
  }, [mobileTerminalShortcuts]);
  useEffect(() => {
    localStorage.setItem(
      MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY,
      serializeMobileTerminalSideShortcuts(mobileTerminalSideShortcuts),
    );
  }, [mobileTerminalSideShortcuts]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY) {
        setMobileTerminalShortcuts(
          parseMobileTerminalShortcutRows(event.newValue),
        );
      } else if (event.key === MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY) {
        setMobileTerminalSideShortcuts(
          parseMobileTerminalSideShortcuts(event.newValue),
        );
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const notice = s.notice;
  useEffect(() => {
    if (!notice) return;
    const dismissDelay = noticeAutoDismissDelay(notice);
    if (dismissDelay === null) return;
    const noticeId = notice.id;
    const timer = window.setTimeout(() => {
      if (store.get().notice?.id === noticeId) store.clearNotice();
    }, dismissDelay);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const normalizedWidth = normalizeSidebarWidth(sidebarWidth);
    if (normalizedWidth !== sidebarWidth) {
      setSidebarWidth(normalizedWidth);
      return;
    }
    localStorage.setItem("sidebarWidth", String(normalizedWidth));
  }, [sidebarWidth]);

  const setInspectorView = (view: InspectorView) => {
    const current = inspectorStateRef.current;
    if (!current) return;
    if (view === "history" && !paneHasAgentHistory(inspectorHistoryPane)) {
      return;
    }
    const next = {
      ...current,
      open: true,
      view,
      originPaneId:
        view === "history"
          ? inspectorHistoryPane?.pane_id
          : current.originPaneId,
    };
    commitInspectorState(next);
    writeInspectorPreferences(localStorage, next);
    if (mobile) setMobileView(view);
  };
  const setInspectorDock = (dock: InspectorDock) => {
    const current = inspectorStateRef.current;
    if (!current || current.dock === dock) return;
    const preferences = readInspectorPreferences(localStorage, current.scope);
    const next = {
      ...current,
      dock,
      size: dock === "right" ? preferences.rightSize : preferences.bottomSize,
      expanded: false,
    };
    commitInspectorState(next);
    writeInspectorPreferences(localStorage, next);
  };
  const setInspectorExpanded = (expanded: boolean) => {
    const current = inspectorStateRef.current;
    if (!current) return;
    const next = { ...current, expanded };
    commitInspectorState(next);
    writeInspectorPreferences(localStorage, next);
  };
  const clearInspectorDetail = () => {
    const current = inspectorStateRef.current;
    if (current?.view === "files") {
      setActiveFilePreview(emptyActiveFilePreviewSelection());
    } else {
      setActiveDiff(emptyActiveDiffSelection());
    }
  };
  const resizeInspectorWithKeyboard = (e: React.KeyboardEvent) => {
    const current = inspectorStateRef.current;
    const stage = inspectorStageRef.current;
    if (!current || !stage || current.expanded) return;
    const increase =
      current.dock === "right" ? e.key === "ArrowLeft" : e.key === "ArrowUp";
    const decrease =
      current.dock === "right" ? e.key === "ArrowRight" : e.key === "ArrowDown";
    if (!increase && !decrease) return;
    e.preventDefault();
    const bounds = stage.getBoundingClientRect();
    const minimum =
      current.dock === "right" ? INSPECTOR_MIN_RIGHT : INSPECTOR_MIN_BOTTOM;
    const maximum = inspectorMaximumSize(
      current.dock,
      bounds.width,
      bounds.height,
    );
    const next = {
      ...current,
      size: Math.min(
        maximum,
        Math.max(minimum, current.size + (increase ? 24 : -24)),
      ),
    };
    commitInspectorState(next);
    writeInspectorPreferences(localStorage, next);
  };
  const startInspectorResize = (e: React.PointerEvent) => {
    const current = inspectorStateRef.current;
    const stage = inspectorStageRef.current;
    if (!current || !stage || current.expanded) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = current.size;
    const dock = current.dock;
    const bounds = stage.getBoundingClientRect();
    const maxSize = inspectorMaximumSize(dock, bounds.width, bounds.height);
    let finalSize = startSize;
    const onMove = (event: PointerEvent) => {
      finalSize = Math.min(
        maxSize,
        Math.max(
          dock === "right" ? INSPECTOR_MIN_RIGHT : INSPECTOR_MIN_BOTTOM,
          startSize +
            (dock === "right"
              ? startX - event.clientX
              : startY - event.clientY),
        ),
      );
      if (inspectorResizeFrameRef.current !== null) return;
      inspectorResizeFrameRef.current = requestAnimationFrame(() => {
        inspectorResizeFrameRef.current = null;
        updateInspectorState((value) =>
          value ? { ...value, size: finalSize } : value,
        );
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (inspectorResizeFrameRef.current !== null) {
        cancelAnimationFrame(inspectorResizeFrameRef.current);
        inspectorResizeFrameRef.current = null;
      }
      const latest = inspectorStateRef.current;
      if (!latest) return;
      const next = { ...latest, size: finalSize };
      commitInspectorState(next);
      writeInspectorPreferences(localStorage, next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(
        MAX_SIDEBAR,
        Math.max(MIN_SIDEBAR, startW + (ev.clientX - startX)),
      );
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <div
      className={`app ${sidebarHidden ? "sidebar-hidden" : ""} ${
        mobileControlsCollapsed ? "mobile-controls-collapsed" : ""
      }`}
    >
      <header className="topbar">
        <div className="topbar-start">
          <div className="brand">
            <img className="logo" src="/herdr-icon.png" alt="" />
            <span className="brand-title">herdr-gui</span>
            <span className="brand-version">v{packageJson.version}</span>
          </div>
          <ConnectionSwitcher />
        </div>
        <div className="topbar-actions">
          <div className="topbar-command-group">
            <CommandCombobox
              key={`${resourceUiKey}:commands`}
              onOpenFileExplorer={openFileExplorer}
              onOpenFile={openFileExplorerFile}
              onOpenDiffViewer={openDiffViewer}
            />
            <ConfigMenu
              key={`${resourceUiKey}:config`}
              theme={theme}
              accentColor={accentColor}
              mobileTerminalShortcuts={mobileTerminalShortcuts}
              mobileTerminalSideShortcuts={mobileTerminalSideShortcuts}
              onThemeChange={setTheme}
              onAccentColorChange={setAccentColor}
              onMobileTerminalShortcutsChange={setMobileTerminalShortcuts}
              onMobileTerminalSideShortcutsChange={
                setMobileTerminalSideShortcuts
              }
            />
          </div>
        </div>
      </header>

      <nav
        className="mobile-nav"
        aria-label="Workspace view switcher"
        aria-hidden={mobileControlsCollapsed}
      >
        <button
          type="button"
          className={
            mobileView === "session" && !agentHistoryOpen ? "active" : ""
          }
          title="Session"
          aria-label="Show terminal session"
          tabIndex={mobileControlsCollapsed ? -1 : 0}
          onClick={activateTerminalSurface}
        >
          <SquareTerminal size={16} />
          <span className="mobile-nav-label">Session</span>
        </button>
        <button
          type="button"
          className={mobileView === "files" ? "active" : ""}
          title="Files"
          aria-label="Show workspace files"
          tabIndex={mobileControlsCollapsed ? -1 : 0}
          onClick={() => openFileExplorer()}
        >
          <FolderTree size={16} />
          <span className="mobile-nav-label">Files</span>
        </button>
        <button
          type="button"
          className={mobileView === "changes" ? "active" : ""}
          title="Changes"
          aria-label="Show workspace changes"
          tabIndex={mobileControlsCollapsed ? -1 : 0}
          onClick={() => openDiffViewer()}
        >
          <FileDiff size={16} />
          <span className="mobile-nav-label">Changes</span>
        </button>
        <button
          type="button"
          className={mobileView === "history" ? "active" : ""}
          title={
            activePaneHasAgent || historyInspectorOpen
              ? "History"
              : "Select an agent pane to view History"
          }
          aria-label="Show agent message history"
          aria-pressed={historyInspectorOpen}
          tabIndex={mobileControlsCollapsed ? -1 : 0}
          disabled={!activePaneHasAgent && !historyInspectorOpen}
          onClick={() => setAgentHistoryInspectorOpen(!historyInspectorOpen)}
        >
          <History size={16} />
          <span className="mobile-nav-label">History</span>
        </button>
      </nav>
      <button
        type="button"
        className={`mobile-workspace-shortcut ${
          mobileView === "workspaces" ? "is-active" : ""
        }`}
        title="Workspaces"
        aria-label="Show workspaces"
        aria-pressed={mobileView === "workspaces"}
        aria-hidden={mobileControlsCollapsed}
        tabIndex={mobileControlsCollapsed ? -1 : 0}
        onClick={openWorkspaces}
      >
        <PanelTop size={17} />
      </button>
      <button
        type="button"
        className="mobile-controls-toggle"
        aria-label={
          mobileControlsCollapsed
            ? "Show mobile controls"
            : "Hide mobile controls"
        }
        title={
          mobileControlsCollapsed
            ? "Show mobile controls"
            : "Hide mobile controls"
        }
        aria-pressed={mobileControlsCollapsed}
        onClick={() => setMobileControlsCollapsed((value) => !value)}
      >
        {mobileControlsCollapsed ? (
          <MoreHorizontal size={17} />
        ) : (
          <X size={17} />
        )}
      </button>

      {s.updateInfo?.update_available || s.notice ? (
        <div className="toast-viewport" aria-live="polite">
          {s.updateInfo?.update_available ? (
            <div
              className={`toast toast-info ${
                s.updateInstalling ? "toast-loading" : ""
              }`}
              role="status"
            >
              <ToastMark kind="info" loading={s.updateInstalling} />
              <div className="toast-content">
                <strong>
                  herdr-gui {s.updateInfo.latest_version} is available
                </strong>
                <p>
                  Current {s.updateInfo.current_version}
                  {s.updateInfo.can_auto_update
                    ? " · ready to update and restart"
                    : s.updateInfo.reason
                      ? ` · ${s.updateInfo.reason}`
                      : ""}
                </p>
                <div className="toast-actions">
                  {s.updateInfo.can_auto_update ? (
                    <button
                      type="button"
                      className="toast-action primary"
                      onClick={() => store.installUpdate()}
                      disabled={s.updateInstalling}
                    >
                      {s.updateInstalling ? "Updating..." : "Update & restart"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="toast-action"
                    onClick={() => store.dismissUpdate()}
                    disabled={s.updateInstalling}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <CloseButton
                variant="toast"
                label="Dismiss update notification"
                onClick={() => store.dismissUpdate()}
                disabled={s.updateInstalling}
              />
            </div>
          ) : null}
          {s.notice ? (
            <div
              className={`toast toast-${s.notice.kind} ${
                s.notice.loading ? "toast-loading" : ""
              }`}
              role={s.notice.kind === "error" ? "alert" : "status"}
            >
              <ToastMark kind={s.notice.kind} loading={s.notice.loading} />
              <div className="toast-content">
                <strong>{s.notice.message}</strong>
                <NoticeDetail notice={s.notice} />
                {s.notice.actionLabel &&
                (s.notice.actionPaneId ||
                  s.notice.actionWorkspaceId ||
                  s.notice.actionClipboardText !== undefined) ? (
                  <div className="toast-actions">
                    <button
                      type="button"
                      className="toast-action primary"
                      onClick={() => handleNoticeAction(s.notice!)}
                    >
                      {s.notice.actionLabel}
                    </button>
                  </div>
                ) : null}
              </div>
              <CloseButton
                variant="toast"
                label="Dismiss notification"
                onClick={() => store.clearNotice()}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className={`body mobile-view-${mobileView}`}
        style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}
      >
        <div className="sidebar">
          <div className="sidebar-content">
            <WorkspaceTree
              key={`${resourceUiKey}:workspaces`}
              onSelect={(workspace) =>
                keepInspectorForWorkspace(workspace.workspace_id)
              }
              onBrowseFiles={(workspace) =>
                openFileExplorer(workspace.workspace_id)
              }
              onReviewChanges={(workspace) =>
                openDiffViewer(workspace.workspace_id)
              }
              onSelectAgent={(pane) =>
                keepInspectorForWorkspace(pane.workspace_id, pane)
              }
              onBrowseFilesForAgent={browseFilesForPane}
              onReviewChangesForAgent={reviewChangesForPane}
              onViewAgentHistory={(pane) =>
                setAgentHistoryInspectorOpen(true, pane)
              }
            />
          </div>
        </div>
        <div
          className="resizer"
          onPointerDown={startResize}
          title="Drag to resize sidebar"
        />
        <main className="main">
          <TabBar
            key={`${resourceUiKey}:tabs`}
            mobile={mobile}
            inspectorOpen={inspectorState?.open === true}
            onToggleInspector={toggleWorkspaceInspector}
          />
          <div
            ref={inspectorStageRef}
            className={`workspace-stage ${
              inspectorState?.open
                ? `has-inspector inspector-dock-${inspectorState.dock}`
                : ""
            } ${inspectorState?.expanded ? "is-inspector-expanded" : ""}`}
          >
            <div className="workspace-terminal-surface">
              <TerminalPaneLayout
                mobileShortcuts={mobileTerminalShortcuts}
                mobileSideShortcuts={mobileTerminalSideShortcuts}
                agentHistoryOpen={agentHistoryOpen}
                onAgentHistoryOpenChange={setAgentHistoryInspectorOpen}
                onOpenWorkspaceFile={handleTerminalWorkspaceFile}
              />
            </div>
            {inspectorState?.open && !inspectorState.expanded ? (
              <div
                className="workspace-inspector-resizer"
                role="separator"
                aria-label={`Resize ${inspectorState.dock} Inspector`}
                aria-orientation={
                  inspectorState.dock === "right" ? "vertical" : "horizontal"
                }
                tabIndex={0}
                onKeyDown={resizeInspectorWithKeyboard}
                onPointerDown={startInspectorResize}
              />
            ) : null}
            {inspectorState ? (
              <div
                className={`workspace-inspector-slot ${
                  inspectorState.open ? "" : "is-closed"
                }`}
                style={
                  inspectorState.expanded
                    ? undefined
                    : inspectorState.dock === "right"
                      ? { width: inspectorState.size }
                      : { height: inspectorState.size }
                }
              >
                <WorkspaceInspectorHost
                  key={`${resourceUiKey}:${resourceOwnerKey(inspectorState.scope)}`}
                  state={inspectorState}
                  workspace={inspectorWorkspace}
                  historyPane={inspectorHistoryPane}
                  fileSelection={activeFilePreview}
                  diffSelection={activeDiff}
                  connectionClient={connectionClient}
                  onFileSelectionChange={(selection) =>
                    handleFilePreviewChange(
                      resourceStateKey(inspectorState.scope),
                      selection,
                    )
                  }
                  onDiffSelectionChange={(selection) =>
                    handleDiffSelectionChange(
                      resourceStateKey(inspectorState.scope),
                      selection,
                    )
                  }
                  onOpenDiffFile={openDiffFileInExplorer}
                  onViewChange={setInspectorView}
                  onDockChange={setInspectorDock}
                  onExpandedChange={setInspectorExpanded}
                  onClose={closeInspector}
                  onBack={clearInspectorDetail}
                />
              </div>
            ) : null}
          </div>
        </main>
      </div>
      <GlobalTooltip />
      {paneJumpOpen ? (
        <PaneJumpOverlay
          entries={paneJumpOptions}
          selectedIndex={paneJumpIndex}
          onSelectIndex={selectPaneJumpIndex}
          onCommit={commitPaneJump}
        />
      ) : null}
    </div>
  );
}
