import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, store } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import type { Pane } from "../types";
import { agentClass, basename, shortId } from "../utils";
import { ConfirmDialog } from "./ModalDialogs";
import { AgentIcon } from "./AgentIcon";
import { AgentSessionPreviewDialog } from "./AgentSessionPreviewDialog";
import {
  type AgentSessionSummary,
  exportSessionForConnection,
} from "./agentSession";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

interface AgentMenuState {
  pane: Pane;
  x: number;
  y: number;
}

function stateDotClass(status?: string): string {
  switch ((status ?? "unknown").toLowerCase()) {
    case "working":
      return "agent-dot agent-dot-working";
    case "blocked":
      return "agent-dot agent-dot-blocked";
    case "done":
      return "agent-dot agent-dot-done";
    case "idle":
      return "agent-dot agent-dot-idle";
    default:
      return "agent-dot";
  }
}

export function AgentPanel({ onSelect }: { onSelect?: () => void }) {
  const s = useStore();
  const connectionClient = useConnectionClient();
  const previewRequest = useRef(0);
  const [menu, setMenu] = useState<AgentMenuState | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<Pane | null>(null);
  const [previewPane, setPreviewPane] = useState<Pane | null>(null);
  const [previewSummary, setPreviewSummary] =
    useState<AgentSessionSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    previewRequest.current += 1;
    setMenu(null);
    setPendingClosePane(null);
    setPreviewPane(null);
    setPreviewSummary(null);
    setPreviewLoading(false);
    setPreviewError("");
  }, [connectionClient]);

  const wsLabel = (id: string) =>
    s.workspaces.find((w) => w.workspace_id === id)?.label ?? id;
  const activePaneId = s.selectedPaneId ?? s.layout?.focused_pane_id ?? null;

  const agents = useMemo(
    () =>
      s.panes
        .filter((p) => p.agent && p.agent_status !== "unknown")
        .map((p) => ({ pane: p }))
        .sort((a, b) => {
          const wa = s.workspaces.find(
            (w) => w.workspace_id === a.pane.workspace_id,
          );
          const wb = s.workspaces.find(
            (w) => w.workspace_id === b.pane.workspace_id,
          );
          return (wa?.number ?? 0) - (wb?.number ?? 0);
        }),
    [s.panes, s.workspaces],
  );

  const openSessionPreview = (pane: Pane) => {
    if (!connectionClient.isCurrent()) return;
    const requestId = ++previewRequest.current;
    setPreviewPane(pane);
    setPreviewSummary(null);
    setPreviewError("");
    setPreviewLoading(true);
    connectionClient
      .call("agent_session.get", {
        pane_id: pane.pane_id,
        agent: pane.agent,
        include_text: true,
        include_trajectory: true,
        preview_limit: 1024 * 1024,
      })
      .then((result) => {
        if (
          connectionClient.isCurrent() &&
          previewRequest.current === requestId
        ) {
          setPreviewSummary(result as AgentSessionSummary);
        }
      })
      .catch((e) => {
        if (
          connectionClient.isCurrent() &&
          previewRequest.current === requestId
        ) {
          setPreviewError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (
          connectionClient.isCurrent() &&
          previewRequest.current === requestId
        ) {
          setPreviewLoading(false);
        }
      });
  };

  return (
    <>
      <div className="panel agents-panel">
        <h2>Agents</h2>
        {agents.length === 0 ? (
          <p className="muted">No agents running.</p>
        ) : (
          agents.map(({ pane }) => {
            const selected =
              pane.pane_id === activePaneId || (!activePaneId && pane.focused);
            return (
              <AgentRow
                key={pane.pane_id}
                pane={pane}
                selected={selected}
                workspaceLabel={wsLabel(pane.workspace_id)}
                onSelect={onSelect}
                onOpenMenu={(x, y) => setMenu({ pane, x, y })}
              />
            );
          })
        )}
      </div>
      <AgentContextMenu
        state={menu}
        onClose={() => setMenu(null)}
        onFocus={(pane) => {
          void store.focusPane(pane.pane_id);
          onSelect?.();
        }}
        onPreviewSession={openSessionPreview}
        onExportSession={(pane) =>
          exportSessionForConnection(pane, connectionClient)
        }
        onClosePane={(pane) => setPendingClosePane(pane)}
      />
      <AgentSessionPreviewDialog
        pane={previewPane}
        summary={previewSummary}
        loading={previewLoading}
        error={previewError}
        onClose={() => {
          previewRequest.current += 1;
          setPreviewPane(null);
          setPreviewSummary(null);
          setPreviewError("");
        }}
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
    </>
  );
}

function AgentRow({
  pane,
  selected,
  workspaceLabel,
  onSelect,
  onOpenMenu,
}: {
  pane: Pane;
  selected: boolean;
  workspaceLabel: string;
  onSelect?: () => void;
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

  return (
    <div
      className={`agent-row ${selected ? "is-selected" : ""} ${
        pane.focused ? "is-focused" : ""
      }`}
      onClick={(e) => {
        if (longPressTriggered.current) {
          longPressTriggered.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        void store.focusPane(pane.pane_id);
        onSelect?.();
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
      title={`${pane.pane_id} · ${pane.cwd ?? ""}`}
    >
      <span className="agent-icon-wrap">
        <AgentIcon agent={pane.agent} />
        <span className={stateDotClass(pane.agent_status)} />
      </span>
      <div className="agent-info">
        <div className="agent-title">
          <span className="agent-title-label">
            {workspaceLabel}
            <span className="muted"> · {shortId(pane.pane_id)}</span>
          </span>
          <span className={`${agentClass(pane.agent_status)} agent-row-status`}>
            {pane.agent_status}
          </span>
        </div>
        <div className="agent-sub muted">
          {pane.agent}
          {pane.cwd ? ` · ${basename(pane.cwd)}` : ""}
        </div>
      </div>
    </div>
  );
}

function AgentContextMenu({
  state,
  onClose,
  onFocus,
  onPreviewSession,
  onExportSession,
  onClosePane,
}: {
  state: AgentMenuState | null;
  onClose: () => void;
  onFocus: (pane: Pane) => void;
  onPreviewSession: (pane: Pane) => void;
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
    { label: "Focus agent", action: () => onFocus(state.pane) },
    { label: "Preview session", action: () => onPreviewSession(state.pane) },
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
