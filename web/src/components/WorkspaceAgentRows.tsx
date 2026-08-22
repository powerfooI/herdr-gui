import { useEffect, useRef } from "react";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
} from "./treeKeyboard";
import { store } from "../store";
import type { Pane } from "../types";
import { agentClass, basename, shortId } from "../utils";
import { shouldShowAgentStatusLabel } from "./agentSession";
import { AgentStatusIcon } from "./AgentStatusIcon";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

export interface AgentMenuState {
  pane: Pane;
  x: number;
  y: number;
}

export function AgentRow({
  pane,
  selected,
  depth = 0,
  showPaneId,
  variant = "nested",
  workspaceLabel,
  onSelect,
  onOpenMenu,
}: {
  pane: Pane;
  selected: boolean;
  depth?: number;
  showPaneId: boolean;
  variant?: "nested" | "standalone";
  workspaceLabel?: string;
  onSelect?: (pane: Pane) => void;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);

  const clearLongPressTimer = () => {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => clearLongPressTimer, []);

  const openMenu = (x: number, y: number) => {
    onOpenMenu(x, y);
  };
  const showStatus = shouldShowAgentStatusLabel(pane.agent_status);
  const nested = variant === "nested";

  return (
    <div
      className={`agent-row ${nested ? "is-nested" : "is-standalone"} ${
        selected ? "is-selected" : ""
      } ${pane.focused ? "is-focused" : ""}`}
      style={nested ? { marginLeft: 12 + depth * 12 } : undefined}
      role={nested ? "treeitem" : "button"}
      tabIndex={nested ? (selected ? 0 : -1) : 0}
      aria-level={nested ? depth + 1 : undefined}
      aria-selected={nested ? selected : undefined}
      aria-pressed={nested ? undefined : selected}
      onClick={(e) => {
        if (longPressTriggered.current) {
          longPressTriggered.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        void store.focusPane(pane.pane_id);
        onSelect?.(pane);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const action = treeKeyboardAction(event.key, event.shiftKey);
        if (!action) return;
        if (
          nested &&
          (action === "next" ||
            action === "previous" ||
            action === "first" ||
            action === "last")
        ) {
          event.preventDefault();
          focusTreeItem(event.currentTarget, action);
          return;
        }
        if (nested && (action === "expand" || action === "collapse")) {
          event.preventDefault();
          focusTreeItem(
            event.currentTarget,
            action === "expand" ? "next" : "previous",
          );
          return;
        }
        if (action !== "activate" && action !== "context-menu") return;
        event.preventDefault();
        event.stopPropagation();
        if (action === "activate") {
          void store.focusPane(pane.pane_id);
          onSelect?.(pane);
        } else {
          const point = keyboardContextMenuPoint(event.currentTarget);
          openMenu(point.x, point.y);
        }
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        longPressTriggered.current = false;
        longPressStart.current = { x: e.clientX, y: e.clientY };
        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
          longPressTriggered.current = true;
          openMenu(e.clientX, e.clientY);
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(e) => {
        const start = longPressStart.current;
        if (!start) return;
        const dx = Math.abs(e.clientX - start.x);
        const dy = Math.abs(e.clientY - start.y);
        if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
          clearLongPressTimer();
          longPressStart.current = null;
        }
      }}
      onPointerUp={() => {
        clearLongPressTimer();
        longPressStart.current = null;
      }}
      onPointerCancel={() => {
        clearLongPressTimer();
        longPressStart.current = null;
      }}
      onPointerLeave={() => {
        clearLongPressTimer();
        longPressStart.current = null;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      title={[pane.pane_id, pane.cwd].filter(Boolean).join(" · ")}
      aria-label={`${pane.agent ?? "Agent"} pane, status ${pane.agent_status}`}
    >
      <AgentStatusIcon agent={pane.agent} status={pane.agent_status} />
      <div className="agent-info">
        <div className="agent-title">
          <span className="agent-title-label">
            {nested
              ? (pane.agent ?? "Agent")
              : (workspaceLabel ?? pane.workspace_id)}
            {showPaneId ? (
              <span className="muted"> · {shortId(pane.pane_id)}</span>
            ) : null}
          </span>
          {showStatus ? (
            <span
              className={`${agentClass(pane.agent_status)} agent-row-status`}
            >
              {pane.agent_status}
            </span>
          ) : null}
        </div>
        {!nested ? (
          <div className="agent-sub muted">
            {pane.agent ?? "Agent"}
            {pane.cwd ? ` · ${basename(pane.cwd)}` : ""}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AgentContextMenu({
  state,
  onClose,
  onFocus,
  onBrowseFiles,
  onReviewChanges,
  onViewHistory,
  onExportSession,
  onClosePane,
}: {
  state: AgentMenuState | null;
  onClose: () => void;
  onFocus: (pane: Pane) => void;
  onBrowseFiles?: (pane: Pane) => void;
  onReviewChanges?: (pane: Pane) => void;
  onViewHistory?: (pane: Pane) => void;
  onExportSession: (pane: Pane) => void;
  onClosePane: (pane: Pane) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onClose, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  const items = [
    { label: "Open Terminal", action: () => onFocus(state.pane) },
    {
      label: "Browse Files at Agent CWD",
      action: () => onBrowseFiles?.(state.pane),
    },
    {
      label: "Review Workspace Changes",
      action: () => onReviewChanges?.(state.pane),
    },
    {
      label: "View Agent History",
      action: () => onViewHistory?.(state.pane),
    },
    { label: "Export session", action: () => onExportSession(state.pane) },
    {
      label: "Close pane",
      danger: true,
      action: () => onClosePane(state.pane),
    },
  ];
  const menuMargin = 8;
  const menuWidth = 200;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(
      menuMargin,
      Math.min(state.x, window.innerWidth - menuWidth - menuMargin),
    ),
    top: Math.max(
      menuMargin,
      Math.min(state.y, window.innerHeight - items.length * 34 - menuMargin),
    ),
    zIndex: 1000,
  };

  return (
    <div ref={ref} className="context-menu" style={style}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
