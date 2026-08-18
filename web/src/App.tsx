import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  store,
  isTaskNotificationTarget,
  noticeAutoDismissDelay,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  useStore,
  type Notice,
  type TaskNotificationTarget,
} from "./store";
import { copyTextFromUserGesture } from "./terminalClipboard";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { AgentPanel } from "./components/AgentPanel";
import { AgentIcon } from "./components/AgentIcon";
import { requestCloseTab, TabBar } from "./components/TabBar";
import { CONFIG_MENU_ID, ConfigMenu } from "./components/ConfigMenu";
import { CommandCombobox } from "./components/CommandCombobox";
import { GlobalTooltip } from "./components/GlobalTooltip";
import {
  ChevronLeft,
  ChevronRight,
  FileDiff,
  FileText,
  FolderTree,
  History,
  PanelTop,
  Plug,
  SquareTerminal,
  MoreHorizontal,
  X,
} from "lucide-react";
import {
  FileExplorerPanel,
  prefetchFileExplorerWorkspace,
  requestFilePreview,
} from "./components/FileExplorerDialog";
import {
  FilePreviewContent,
  type ActiveFilePreviewSelection,
  type FilePreviewSelectionMeta,
} from "./components/FilePreviewContent";
import {
  DiffViewerPanel,
  prefetchDiffViewerWorkspace,
  type ActiveDiffSelection,
  type DiffSelectionMeta,
} from "./components/DiffViewerPanel";
import { DiffContentView } from "./components/DiffContentView";
import type { FileExplorerEntry } from "./types";
import {
  paneJumpEntries,
  paneJumpTargetId,
  type PaneJumpEntry,
} from "./paneJump";
import { adjacentTabId, tabShortcutAction } from "./tabShortcuts";
import { normalizeAccentColor, type AccentColor } from "./appearance";
import {
  LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY,
  parseMobileTerminalShortcutRows,
  parseMobileTerminalSideShortcuts,
  serializeMobileTerminalShortcutRows,
  serializeMobileTerminalSideShortcuts,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "./mobileTerminalShortcuts";
import { agentClass } from "./utils";
import packageJson from "../package.json";

const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 560;
const DEFAULT_SIDEBAR = 284;
const THEME_KEY = "theme";
const ACCENT_COLOR_KEY = "accentColor";
const SIDEBAR_ACTIVITY_KEY = "sidebarActivity";
const FILE_EXPLORER_WORKSPACE_KEY = "fileExplorerWorkspaceId";
const FILE_PREVIEW_KEY = "filePreview";
const DIFF_VIEWER_WORKSPACE_KEY = "diffViewerWorkspaceId";

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

export type Theme = "dark" | "light";
type SidebarActivity = "workspaces" | "files" | "diff";
type MobileView = "workspaces" | "session";

function SidebarViewSwitcher({
  className,
  activity,
  active,
  onOpenWorkspaces,
  onOpenFiles,
  onOpenDiff,
}: {
  className: string;
  activity: SidebarActivity;
  active: boolean;
  onOpenWorkspaces: () => void;
  onOpenFiles: () => void;
  onOpenDiff: () => void;
}) {
  return (
    <nav
      className={`view-switcher ${className}`}
      aria-label="Application views"
    >
      <button
        type="button"
        className={active && activity === "workspaces" ? "is-active" : ""}
        title="Workspaces (Ctrl+Shift+W)"
        aria-label="Show workspaces"
        onClick={onOpenWorkspaces}
      >
        <PanelTop size={16} />
      </button>
      <button
        type="button"
        className={active && activity === "files" ? "is-active" : ""}
        title="Files (Cmd/Ctrl+Shift+E)"
        aria-label="Show file explorer"
        onClick={onOpenFiles}
      >
        <FolderTree size={16} />
      </button>
      <button
        type="button"
        className={active && activity === "diff" ? "is-active" : ""}
        title="Diff Viewer (Ctrl+Shift+G)"
        aria-label="Show Diff Viewer"
        onClick={onOpenDiff}
      >
        <FileDiff size={16} />
      </button>
    </nav>
  );
}

function normalizeSidebarWidth(value: number): number {
  return Number.isFinite(value) && value >= MIN_SIDEBAR && value <= MAX_SIDEBAR
    ? value
    : DEFAULT_SIDEBAR;
}

function loadSidebarWidth(): number {
  return normalizeSidebarWidth(Number(localStorage.getItem("sidebarWidth")));
}

function loadTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
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

function loadSidebarActivity(): SidebarActivity {
  const value = localStorage.getItem(SIDEBAR_ACTIVITY_KEY);
  return value === "files" || value === "diff" ? value : "workspaces";
}

function loadOptionalString(key: string) {
  return localStorage.getItem(key) || undefined;
}

function loadStoredFilePreview(): {
  workspaceId: string;
  path: string;
  name: string;
} | null {
  try {
    const raw = localStorage.getItem(FILE_PREVIEW_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as {
      workspaceId?: unknown;
      path?: unknown;
      name?: unknown;
    };
    if (typeof value.workspaceId !== "string") return null;
    if (typeof value.path !== "string") return null;
    return {
      workspaceId: value.workspaceId,
      path: value.path,
      name:
        typeof value.name === "string" && value.name
          ? value.name
          : (value.path.split("/").filter(Boolean).pop() ?? value.path),
    };
  } catch {
    return null;
  }
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

function StatusDot() {
  const s = useStore();
  const label = s.connectionPaused ? "paused" : s.status;
  const clientCount =
    !s.connectionPaused && s.status === "connected"
      ? s.bridgeStatus?.clients
      : null;
  const clientLabel =
    typeof clientCount === "number"
      ? ` · ${clientCount} ${clientCount === 1 ? "client" : "clients"}`
      : "";
  return (
    <span className={`status status-${label}`}>
      <span className="status-dot" />
      {label}
      {clientLabel}
    </span>
  );
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
}: {
  mobileShortcuts: MobileTerminalShortcutRows;
  mobileSideShortcuts: MobileTerminalSideShortcuts;
  agentHistoryOpen: boolean;
  onAgentHistoryOpenChange: (open: boolean) => void;
}) {
  const s = useStore();
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

  if (!layout || layout.zoomed || visiblePanes.length <= 1) {
    return (
      <TerminalView
        mobileShortcuts={mobileShortcuts}
        mobileSideShortcuts={mobileSideShortcuts}
        agentHistoryOpen={agentHistoryOpen}
        onAgentHistoryOpenChange={onAgentHistoryOpenChange}
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
          paneId={activePaneId}
          mobileShortcuts={mobileShortcuts}
          mobileSideShortcuts={mobileSideShortcuts}
          agentHistoryOpen={agentHistoryOpen}
          onAgentHistoryOpenChange={onAgentHistoryOpenChange}
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
            key={layoutPane.pane_id}
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
              paneId={layoutPane.pane_id}
              showMobileKeys={isActive}
              mobileShortcuts={mobileShortcuts}
              mobileSideShortcuts={mobileSideShortcuts}
              agentHistoryOpen={isActive ? agentHistoryOpen : false}
              onAgentHistoryOpenChange={onAgentHistoryOpenChange}
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
  const s = useStore();
  useVisualViewportCssVars();
  const mobile = useMobileLayout();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [mobileView, setMobileView] = useState<MobileView>("session");
  const mobileViewByActivityRef = useRef<Record<SidebarActivity, MobileView>>({
    workspaces: "session",
    files: "workspaces",
    diff: "workspaces",
  });
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [accentColor, setAccentColor] = useState<AccentColor>(() =>
    loadAccentColor(),
  );
  const [mobileTerminalShortcuts, setMobileTerminalShortcuts] =
    useState<MobileTerminalShortcutRows>(loadMobileTerminalShortcuts);
  const [mobileTerminalSideShortcuts, setMobileTerminalSideShortcuts] =
    useState<MobileTerminalSideShortcuts>(loadMobileTerminalSideShortcuts);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [mobileControlsCollapsed, setMobileControlsCollapsed] = useState(false);
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const [paneJumpOpen, setPaneJumpOpen] = useState(false);
  const [paneJumpIndex, setPaneJumpIndex] = useState(0);
  const paneJumpCtrlDownRef = useRef(false);
  const paneJumpIndexRef = useRef(0);
  const [sidebarActivity, setSidebarActivity] = useState<SidebarActivity>(() =>
    loadSidebarActivity(),
  );
  const [fileExplorerWorkspaceId, setFileExplorerWorkspaceId] = useState<
    string | undefined
  >(() => loadOptionalString(FILE_EXPLORER_WORKSPACE_KEY));
  const [diffViewerWorkspaceId, setDiffViewerWorkspaceId] = useState<
    string | undefined
  >(() => loadOptionalString(DIFF_VIEWER_WORKSPACE_KEY));
  const [activeDiff, setActiveDiff] = useState<ActiveDiffSelection>({
    entry: null,
    file: null,
    loading: false,
    error: null,
    entries: [],
    files: {},
    fileErrors: {},
    summaryLoading: false,
  });
  const [activeFilePreview, setActiveFilePreview] =
    useState<ActiveFilePreviewSelection>({
      entry: null,
      preview: null,
      loading: false,
      error: null,
    });
  const fileQuickOpenRequestRef = useRef(0);
  const restoredFilePreviewKeyRef = useRef<string | null>(null);
  const focusedWorkspaceId = s.workspaces.find((w) => w.focused)?.workspace_id;
  const activePaneId =
    s.selectedPaneId &&
    s.layout?.panes.some((p) => p.pane_id === s.selectedPaneId)
      ? s.selectedPaneId
      : s.layout?.focused_pane_id;
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
  const activePaneHasAgent =
    !!activePane?.agent && activePane.agent_status !== "unknown";
  const mobileListLabel =
    sidebarActivity === "files"
      ? "Files"
      : sidebarActivity === "diff"
        ? "Files"
        : "Workspaces";
  const mobileContentLabel =
    sidebarActivity === "diff"
      ? "Diff"
      : sidebarActivity === "files"
        ? "Preview"
        : "Session";

  const toggleSidebar = () => {
    setMobileView("session");
    setSidebarHidden((value) => !value);
  };
  const restoreMobileViewForActivity = useCallback(
    (activity: SidebarActivity, fallback: MobileView = "workspaces") => {
      if (!mobile) return;
      setMobileView(mobileViewByActivityRef.current[activity] ?? fallback);
    },
    [mobile],
  );
  const openFileExplorer = useCallback(
    (workspaceId?: string) => {
      const focusedWorkspaceId = store
        .get()
        .workspaces.find((w) => w.focused)?.workspace_id;
      const targetWorkspaceId = workspaceId ?? focusedWorkspaceId;
      if (targetWorkspaceId !== fileExplorerWorkspaceId) {
        localStorage.removeItem(FILE_PREVIEW_KEY);
        restoredFilePreviewKeyRef.current = null;
        setActiveFilePreview({
          entry: null,
          preview: null,
          loading: false,
          error: null,
        });
      }
      setFileExplorerWorkspaceId(targetWorkspaceId);
      setSidebarActivity("files");
      setSidebarHidden(false);
      restoreMobileViewForActivity("files");
    },
    [fileExplorerWorkspaceId, restoreMobileViewForActivity],
  );
  const openFileExplorerFile = useCallback(
    (workspaceId: string, entry: FileExplorerEntry) => {
      const requestId = fileQuickOpenRequestRef.current + 1;
      fileQuickOpenRequestRef.current = requestId;
      setFileExplorerWorkspaceId(workspaceId);
      setSidebarActivity("files");
      setSidebarHidden(false);
      setActiveFilePreview({
        entry,
        preview: null,
        loading: true,
        error: null,
      });
      if (mobile) setMobileView("session");
      void requestFilePreview(workspaceId, entry.path)
        .then((preview) => {
          if (fileQuickOpenRequestRef.current !== requestId) return;
          setActiveFilePreview({
            entry,
            preview,
            loading: false,
            error: null,
          });
        })
        .catch((e) => {
          if (fileQuickOpenRequestRef.current !== requestId) return;
          setActiveFilePreview({
            entry,
            preview: null,
            loading: false,
            error: (e as Error).message,
          });
        });
    },
    [mobile],
  );
  const openDiffViewer = useCallback(
    (workspaceId?: string) => {
      const focusedWorkspaceId = store
        .get()
        .workspaces.find((w) => w.focused)?.workspace_id;
      setDiffViewerWorkspaceId(workspaceId ?? focusedWorkspaceId);
      setSidebarActivity("diff");
      setSidebarHidden(false);
      restoreMobileViewForActivity("diff");
    },
    [restoreMobileViewForActivity],
  );
  const openWorkspaces = useCallback(() => {
    setSidebarActivity("workspaces");
    setSidebarHidden(false);
    restoreMobileViewForActivity("workspaces", "session");
  }, [restoreMobileViewForActivity]);
  const toggleFileExplorer = useCallback(() => {
    const showingFiles = sidebarActivity === "files" && !sidebarHidden;
    if (showingFiles) {
      openWorkspaces();
      return;
    }
    const focusedWorkspaceId = store
      .get()
      .workspaces.find((w) => w.focused)?.workspace_id;
    if (focusedWorkspaceId !== fileExplorerWorkspaceId) {
      localStorage.removeItem(FILE_PREVIEW_KEY);
      restoredFilePreviewKeyRef.current = null;
      setActiveFilePreview({
        entry: null,
        preview: null,
        loading: false,
        error: null,
      });
    }
    setFileExplorerWorkspaceId(focusedWorkspaceId);
    setSidebarActivity("files");
    setSidebarHidden(false);
    restoreMobileViewForActivity("files");
  }, [
    fileExplorerWorkspaceId,
    openWorkspaces,
    restoreMobileViewForActivity,
    sidebarActivity,
    sidebarHidden,
  ]);
  const handleDiffSelectionChange = useCallback(
    (selection: ActiveDiffSelection, meta?: DiffSelectionMeta) => {
      setActiveDiff(selection);
      if (mobile && selection.entry && meta?.userInitiated) {
        setMobileView("session");
      }
    },
    [mobile],
  );
  const openDiffFileInExplorer = useCallback(
    (entry: ActiveDiffSelection["entry"]) => {
      if (!entry) return;
      const diffKey = `${entry.kind}:${entry.path}`;
      const workspaceId =
        activeDiff.files[diffKey]?.workspace_id ??
        activeDiff.file?.workspace_id ??
        diffViewerWorkspaceId ??
        store.get().workspaces.find((workspace) => workspace.focused)
          ?.workspace_id;
      if (!workspaceId) return;
      const name = entry.path.split("/").filter(Boolean).pop() ?? entry.path;
      openFileExplorerFile(workspaceId, {
        name,
        path: entry.path,
        type: "file",
        size: 0,
        mtime_ms: 0,
        hidden: name.startsWith("."),
      });
    },
    [
      activeDiff.file?.workspace_id,
      activeDiff.files,
      diffViewerWorkspaceId,
      openFileExplorerFile,
    ],
  );
  const handleFilePreviewChange = useCallback(
    (
      selection: ActiveFilePreviewSelection,
      meta?: FilePreviewSelectionMeta,
    ) => {
      setActiveFilePreview(selection);
      if (mobile && selection.entry && meta?.userInitiated) {
        setMobileView("session");
      }
    },
    [mobile],
  );
  const openNotificationTarget = useCallback(
    (target: TaskNotificationTarget) => {
      setSidebarActivity("workspaces");
      setSidebarHidden(false);
      setMobileView("session");
      void store.focusTaskNotificationTarget(target);
    },
    [],
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
      const target = {
        paneId: notice.actionPaneId,
        workspaceId: notice.actionWorkspaceId,
      };
      store.clearNotice();
      if (isTaskNotificationTarget(target)) openNotificationTarget(target);
    },
    [openNotificationTarget],
  );
  useEffect(() => {
    const handleSystemNotification = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail;
      if (!isTaskNotificationTarget(target)) return;
      openNotificationTarget(target);
      const notice = store.get().notice;
      if (notice?.actionPaneId === target.paneId) store.clearNotice();
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
      setMobileView("session");
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

  useEffect(() => {
    store.init();
  }, []);
  useEffect(() => {
    mobileViewByActivityRef.current[sidebarActivity] = mobileView;
  }, [mobileView, sidebarActivity]);
  useEffect(() => {
    if (!activePaneHasAgent && agentHistoryOpen) setAgentHistoryOpen(false);
  }, [activePaneHasAgent, agentHistoryOpen]);
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
  useEffect(() => {
    if (sidebarActivity === "files") {
      setFileExplorerWorkspaceId((current) => current ?? focusedWorkspaceId);
    }
    if (sidebarActivity === "diff") {
      setDiffViewerWorkspaceId(focusedWorkspaceId);
      setActiveDiff({
        entry: null,
        file: null,
        loading: false,
        error: null,
        entries: [],
        files: {},
        fileErrors: {},
        summaryLoading: false,
      });
    }
    // Follow focus only when the focus target actually changes; this preserves
    // context-menu opens for a non-focused workspace until the user switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedWorkspaceId]);
  useEffect(() => {
    if (sidebarActivity !== "files") return;
    const stored = loadStoredFilePreview();
    if (!stored) return;
    if (
      fileExplorerWorkspaceId &&
      fileExplorerWorkspaceId !== stored.workspaceId
    ) {
      return;
    }
    if (
      !s.workspaces.some(
        (workspace) => workspace.workspace_id === stored.workspaceId,
      )
    ) {
      return;
    }
    const restoreKey = `${stored.workspaceId}:${stored.path}`;
    if (restoredFilePreviewKeyRef.current === restoreKey) return;
    restoredFilePreviewKeyRef.current = restoreKey;
    openFileExplorerFile(stored.workspaceId, {
      name: stored.name,
      path: stored.path,
      type: "file",
      size: 0,
      mtime_ms: 0,
      hidden: stored.name.startsWith("."),
    });
  }, [
    fileExplorerWorkspaceId,
    openFileExplorerFile,
    s.workspaces,
    sidebarActivity,
  ]);
  useEffect(() => {
    if (!focusedWorkspaceId) return;
    if (sidebarActivity !== "files") {
      void prefetchFileExplorerWorkspace(focusedWorkspaceId);
    }
    if (sidebarActivity !== "diff") {
      void prefetchDiffViewerWorkspace(focusedWorkspaceId);
    }
  }, [focusedWorkspaceId, sidebarActivity]);
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
        if (document.getElementById(CONFIG_MENU_ID)) return;
        const current = store.get();
        const canDismissUpdate =
          current.updateInfo?.update_available && !current.updateInstalling;
        if (current.notice || canDismissUpdate) {
          e.preventDefault();
          e.stopPropagation();
          if (current.notice) store.clearNotice();
          if (canDismissUpdate) store.dismissUpdate();
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
        setMobileView("session");
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
        setMobileView("session");
        store.focusTab(targetTab.tab_id);
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
        openDiffViewer();
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
    closePaneJump,
    commitPaneJump,
    defaultPaneJumpIndex,
    movePaneJumpSelection,
    openDiffViewer,
    openWorkspaces,
    paneJumpOpen,
    paneJumpOptions.length,
    selectPaneJumpIndex,
    toggleFileExplorer,
  ]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.accent = accentColor;
    localStorage.setItem(ACCENT_COLOR_KEY, accentColor);
  }, [accentColor, theme]);
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
  useEffect(() => {
    localStorage.setItem(SIDEBAR_ACTIVITY_KEY, sidebarActivity);
  }, [sidebarActivity]);
  useEffect(() => {
    if (fileExplorerWorkspaceId) {
      localStorage.setItem(
        FILE_EXPLORER_WORKSPACE_KEY,
        fileExplorerWorkspaceId,
      );
    } else {
      localStorage.removeItem(FILE_EXPLORER_WORKSPACE_KEY);
    }
  }, [fileExplorerWorkspaceId]);
  useEffect(() => {
    const entry = activeFilePreview.entry;
    const workspaceId =
      activeFilePreview.preview?.workspace_id ?? fileExplorerWorkspaceId;
    if (entry?.path && workspaceId) {
      localStorage.setItem(
        FILE_PREVIEW_KEY,
        JSON.stringify({
          workspaceId,
          path: entry.path,
          name: entry.name,
        }),
      );
    }
  }, [
    activeFilePreview.entry,
    activeFilePreview.preview?.workspace_id,
    fileExplorerWorkspaceId,
  ]);
  useEffect(() => {
    if (diffViewerWorkspaceId) {
      localStorage.setItem(DIFF_VIEWER_WORKSPACE_KEY, diffViewerWorkspaceId);
    } else {
      localStorage.removeItem(DIFF_VIEWER_WORKSPACE_KEY);
    }
  }, [diffViewerWorkspaceId]);
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
          <StatusDot />
        </div>
        <SidebarViewSwitcher
          className="topbar-view-switcher"
          activity={sidebarActivity}
          active={!sidebarHidden}
          onOpenWorkspaces={openWorkspaces}
          onOpenFiles={() => openFileExplorer()}
          onOpenDiff={() => openDiffViewer()}
        />
        <div className="topbar-actions">
          {s.connectionPaused || s.status === "disconnected" ? (
            <button
              type="button"
              className="topbar-button icon-button connection-toggle-button is-paused"
              onClick={() => store.resumeConnection()}
              title={
                s.connectionPaused
                  ? "Resume this client"
                  : "Reconnect this client"
              }
            >
              <Plug size={15} />
            </button>
          ) : null}
          <div className="topbar-command-group">
            <CommandCombobox
              onOpenFileExplorer={openFileExplorer}
              onOpenFile={openFileExplorerFile}
              onOpenDiffViewer={openDiffViewer}
            />
            <ConfigMenu
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

      <SidebarViewSwitcher
        className="mobile-sidebar-view-switcher"
        activity={sidebarActivity}
        active={!sidebarHidden}
        onOpenWorkspaces={openWorkspaces}
        onOpenFiles={() => openFileExplorer()}
        onOpenDiff={() => openDiffViewer()}
      />

      <nav className="mobile-nav" aria-label="Mobile view switcher">
        <button
          type="button"
          className={mobileView === "workspaces" ? "active" : ""}
          title={mobileListLabel}
          aria-label={`Show ${mobileListLabel.toLowerCase()}`}
          onClick={() => {
            setAgentHistoryOpen(false);
            setMobileView("workspaces");
          }}
        >
          {sidebarActivity === "files" || sidebarActivity === "diff" ? (
            <FolderTree size={16} />
          ) : (
            <PanelTop size={16} />
          )}
          <span className="mobile-nav-label">{mobileListLabel}</span>
        </button>
        <button
          type="button"
          className={
            mobileView === "session" && !agentHistoryOpen ? "active" : ""
          }
          title={mobileContentLabel}
          aria-label={`Show ${mobileContentLabel.toLowerCase()}`}
          onClick={() => {
            setAgentHistoryOpen(false);
            setMobileView("session");
          }}
        >
          {sidebarActivity === "diff" ? (
            <FileDiff size={16} />
          ) : sidebarActivity === "files" ? (
            <FileText size={16} />
          ) : (
            <SquareTerminal size={16} />
          )}
          <span className="mobile-nav-label">{mobileContentLabel}</span>
        </button>
        {activePaneHasAgent ? (
          <button
            type="button"
            className={
              mobileView === "session" && agentHistoryOpen ? "active" : ""
            }
            title="History"
            aria-label="Show agent message history"
            aria-pressed={agentHistoryOpen}
            onClick={() => {
              setMobileView("session");
              setAgentHistoryOpen((value) => !value);
            }}
          >
            <History size={16} />
            <span className="mobile-nav-label">History</span>
          </button>
        ) : null}
      </nav>
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
              <span className="toast-mark" />
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
              <button
                type="button"
                className="toast-close"
                onClick={() => store.dismissUpdate()}
                aria-label="Dismiss update notification"
                disabled={s.updateInstalling}
              >
                x
              </button>
            </div>
          ) : null}
          {s.notice ? (
            <div
              className={`toast toast-${s.notice.kind} ${
                s.notice.loading ? "toast-loading" : ""
              }`}
              role={s.notice.kind === "error" ? "alert" : "status"}
            >
              <span className="toast-mark" />
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
              <button
                type="button"
                className="toast-close"
                onClick={() => store.clearNotice()}
                aria-label="Dismiss notification"
              >
                x
              </button>
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
            {sidebarActivity === "workspaces" ? (
              <>
                <WorkspaceTree onSelect={() => setMobileView("session")} />
                <AgentPanel onSelect={() => setMobileView("session")} />
              </>
            ) : sidebarActivity === "files" ? (
              <FileExplorerPanel
                open
                workspaceId={fileExplorerWorkspaceId}
                activePath={activeFilePreview.entry?.path}
                onClose={() => setSidebarActivity("workspaces")}
                onPreviewChange={handleFilePreviewChange}
              />
            ) : (
              <DiffViewerPanel
                workspaceId={diffViewerWorkspaceId}
                onSelectionChange={handleDiffSelectionChange}
              />
            )}
          </div>
        </div>
        <div
          className="resizer"
          onPointerDown={startResize}
          title="拖动调整宽度"
        />
        <main
          className={`main ${
            sidebarActivity === "diff" || sidebarActivity === "files"
              ? "main-diff-mode"
              : ""
          }`}
        >
          <div
            className={`main-view main-view-terminal ${
              sidebarActivity === "diff" || sidebarActivity === "files"
                ? "is-hidden"
                : ""
            }`}
          >
            <TabBar mobile={mobile} />
            <TerminalPaneLayout
              mobileShortcuts={mobileTerminalShortcuts}
              mobileSideShortcuts={mobileTerminalSideShortcuts}
              agentHistoryOpen={agentHistoryOpen}
              onAgentHistoryOpenChange={setAgentHistoryOpen}
            />
          </div>
          <div
            className={`main-view ${
              sidebarActivity === "diff" ? "" : "is-hidden"
            }`}
          >
            <DiffContentView
              entry={activeDiff.entry}
              file={activeDiff.file}
              loading={activeDiff.loading}
              error={activeDiff.error}
              entries={activeDiff.entries}
              files={activeDiff.files}
              fileErrors={activeDiff.fileErrors}
              summaryLoading={activeDiff.summaryLoading}
              mobile={mobile}
              onOpenFile={openDiffFileInExplorer}
            />
          </div>
          <div
            className={`main-view ${
              sidebarActivity === "files" ? "" : "is-hidden"
            }`}
          >
            <FilePreviewContent
              entry={activeFilePreview.entry}
              preview={activeFilePreview.preview}
              loading={activeFilePreview.loading}
              error={activeFilePreview.error}
            />
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
