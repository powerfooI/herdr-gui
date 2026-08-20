import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Copy, Download, Eye, RefreshCw, X } from "lucide-react";
import { useStore } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import type { Pane } from "../types";
import { formatUiRelativeTime, UI_LOCALE } from "../uiLocale";
import { shortId } from "../utils";
import { AgentIcon } from "./AgentIcon";
import { AgentMessageDialog } from "./AgentMessageDialog";
import { AgentSessionPreviewDialog } from "./AgentSessionPreviewDialog";
import {
  type AgentSessionSummary,
  downloadSession,
  formatBytes,
  formatCount,
  formatOptionalCompact,
  formatTokenTotal,
  tokenUsage,
  visibleSessionMessages,
} from "./agentSession";

const SHOW_ASSISTANT_MESSAGES_KEY = "sessionInspectShowAssistantMessages";

type AgentHistoryEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sent_at: string;
};

type AgentHistory = {
  status?: "ok" | "missing_session" | "missing_file";
  detail?: string;
  command?: string;
  agent: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  updated_at: string;
  messages: AgentHistoryEntry[];
  path: string;
};

function formatHistoryTime(sentAt: string) {
  const time = new Date(sentAt);
  if (Number.isNaN(time.getTime())) return sentAt;
  return time.toLocaleString(UI_LOCALE, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(timestamp: string) {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return "Unknown";
  const seconds = Math.round((time.getTime() - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 60) return formatUiRelativeTime(seconds, "second");
  if (absoluteSeconds < 3600)
    return formatUiRelativeTime(Math.round(seconds / 60), "minute");
  if (absoluteSeconds < 86400)
    return formatUiRelativeTime(Math.round(seconds / 3600), "hour");
  return formatUiRelativeTime(Math.round(seconds / 86400), "day");
}

function messageSummary(text: string) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return null;
  return `${lines.length} lines`;
}

function initialShowAssistantMessages() {
  try {
    return (
      typeof localStorage === "undefined" ||
      localStorage.getItem(SHOW_ASSISTANT_MESSAGES_KEY) !== "false"
    );
  } catch {
    return true;
  }
}

function persistShowAssistantMessages(value: boolean) {
  try {
    localStorage.setItem(SHOW_ASSISTANT_MESSAGES_KEY, String(value));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function AgentHistoryMessageCard({
  entry,
  index,
  onExpand,
}: {
  entry: AgentHistoryEntry;
  index: number;
  onExpand: () => void;
}) {
  const contentRef = useRef<HTMLPreElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    // Wrapping changes as the drawer resizes, so truncation must follow the
    // rendered height instead of relying on message length.
    const update = () => {
      setTruncated(content.scrollHeight > content.clientHeight + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [entry.text]);

  const summary = messageSummary(entry.text);
  const roleLabel = entry.role === "assistant" ? "Assistant" : "You";
  const roleAriaLabel = entry.role === "assistant" ? "assistant" : "user";
  return (
    <article className={`agent-history-card is-${entry.role}`}>
      <div className="agent-history-card-meta">
        <strong className="agent-history-card-role">{roleLabel}</strong>
        <small>#{index}</small>
        <time title={formatHistoryTime(entry.sent_at)}>
          {formatRelativeTime(entry.sent_at)}
        </time>
        {summary ? <span>{summary}</span> : <span />}
        <button
          type="button"
          className="agent-history-copy"
          onClick={() => void navigator.clipboard?.writeText(entry.text)}
          aria-label={`Copy message ${index}`}
          title="Copy"
        >
          <Copy size={13} />
        </button>
      </div>
      <button
        type="button"
        className={`agent-history-card-open ${truncated ? "is-truncated" : ""}`}
        onClick={onExpand}
        aria-label={`View ${roleAriaLabel} message ${index}`}
      >
        <pre ref={contentRef}>{entry.text}</pre>
        {truncated ? <span>View full message</span> : null}
      </button>
    </article>
  );
}

export function AgentHistoryDrawer({
  pane,
  open,
  onOpenChange,
}: {
  pane: Pane;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appState = useStore();
  const connectionClient = useConnectionClient();
  const workspaceLabel =
    appState.workspaces.find(
      (workspace) => workspace.workspace_id === pane.workspace_id,
    )?.label ?? pane.workspace_id;
  const [history, setHistory] = useState<AgentHistory | null>(null);
  const [session, setSession] = useState<AgentSessionSummary | null>(null);
  const [drawerTab, setDrawerTab] = useState<"messages" | "details">(
    "messages",
  );
  const [showAssistantMessages, setShowAssistantMessages] = useState(
    initialShowAssistantMessages,
  );
  const [previewPane, setPreviewPane] = useState<Pane | null>(null);
  const [previewSummary, setPreviewSummary] =
    useState<AgentSessionSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [expandedMessage, setExpandedMessage] =
    useState<AgentHistoryEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loadSeqRef = useRef(0);
  const previewSeqRef = useRef(0);

  const loadHistory = useCallback(() => {
    if (!pane.agent) return;
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setLoading(true);
    setError("");
    const params = {
      pane_id: pane.pane_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      agent: pane.agent,
      agent_status: pane.agent_status,
    };
    Promise.allSettled([
      connectionClient.call("agent_history.get", params),
      connectionClient.call("agent_session.get", {
        pane_id: pane.pane_id,
        agent: pane.agent,
      }),
    ])
      .then(([historyResult, sessionResult]) => {
        if (!connectionClient.isCurrent() || loadSeqRef.current !== seq) return;
        setHistory(
          historyResult.status === "fulfilled"
            ? (historyResult.value as AgentHistory)
            : null,
        );
        setSession(
          sessionResult.status === "fulfilled"
            ? (sessionResult.value as AgentSessionSummary)
            : null,
        );
        const errors = [historyResult, sessionResult]
          .filter((result) => result.status === "rejected")
          .map((result) =>
            result.status === "rejected"
              ? result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
              : "",
          )
          .filter(Boolean);
        setError(errors.join("\n"));
      })
      .finally(() => {
        if (connectionClient.isCurrent() && loadSeqRef.current === seq) {
          setLoading(false);
        }
      });
  }, [
    connectionClient,
    pane.agent,
    pane.agent_status,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);

  useEffect(() => {
    // Resource-derived state belongs to one pane and one connection lease.
    // Invalidate old continuations before loading a colliding pane ID from a
    // switched connection or replacement runtime.
    loadSeqRef.current += 1;
    previewSeqRef.current += 1;
    setHistory(null);
    setSession(null);
    setDrawerTab("messages");
    setExpandedMessage(null);
    setPreviewPane(null);
    setPreviewSummary(null);
    setPreviewLoading(false);
    setPreviewError("");
    setLoading(false);
    setError("");
  }, [connectionClient, pane.pane_id]);

  useEffect(() => {
    if (open) loadHistory();
  }, [loadHistory, open]);

  useEffect(() => {
    if (!open) {
      setExpandedMessage(null);
      setPreviewPane(null);
      setPreviewSummary(null);
      setPreviewError("");
    }
  }, [open]);

  const openSessionPreview = useCallback(() => {
    if (
      !pane.agent ||
      session?.status !== "ok" ||
      !connectionClient.isCurrent()
    ) {
      return;
    }
    const seq = ++previewSeqRef.current;
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
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewSummary(result as AgentSessionSummary);
        }
      })
      .catch((value) => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewError(
            value instanceof Error ? value.message : String(value),
          );
        }
      })
      .finally(() => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewLoading(false);
        }
      });
  }, [connectionClient, pane, session?.status]);

  const closeSessionPreview = useCallback(() => {
    previewSeqRef.current += 1;
    setPreviewPane(null);
    setPreviewSummary(null);
    setPreviewError("");
  }, []);

  // Stable identity so the message dialog's focus effect only re-runs when the
  // message itself changes, not on every drawer re-render.
  const closeExpandedMessage = useCallback(() => setExpandedMessage(null), []);

  const usage = tokenUsage(session);
  const messages = history?.messages ?? [];
  const visibleMessages = visibleSessionMessages(
    messages,
    showAssistantMessages,
  );
  const sessionReady = session?.status === "ok";
  const historyReady = history?.status === "ok" || messages.length > 0;
  const hasSessionData = sessionReady || historyReady;
  const unavailable = !loading && !hasSessionData;
  const unavailableDetail =
    session?.detail ||
    history?.detail ||
    error ||
    "No readable session transcript was reported for this agent.";
  const unavailableCommand = session?.command || history?.command;
  const updatedAt = sessionReady
    ? session.updated_at
    : historyReady
      ? history?.updated_at
      : undefined;

  return (
    <>
      <aside
        className={`agent-history-drawer ${open ? "is-open" : ""}`}
        aria-label="Agent session"
        aria-hidden={!open}
      >
        <div className="agent-history-drawer-head">
          <div className="agent-history-identity">
            <AgentIcon agent={pane.agent} />
            <div className="agent-history-title">
              <strong>Session</strong>
              <span title={workspaceLabel}>
                {workspaceLabel} · {pane.agent ?? "Agent"} ·{" "}
                {shortId(pane.pane_id)}
              </span>
            </div>
          </div>
          <span
            className={`agent-history-status is-${pane.agent_status.toLowerCase()}`}
          >
            {pane.agent_status}
          </span>
          <div className="agent-history-actions">
            <button
              type="button"
              className={`agent-history-icon ${loading ? "is-loading" : ""}`}
              onClick={loadHistory}
              aria-label="Refresh session"
              title="Refresh"
              disabled={loading}
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              className="agent-history-icon"
              onClick={() => onOpenChange(false)}
              aria-label="Close session"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {sessionReady ? (
          <section
            className="agent-history-overview"
            aria-label="Session overview"
          >
            <div>
              <strong>{formatCount(session.stats.turns)}</strong>
              <span>Turns</span>
            </div>
            <div>
              <strong>{formatTokenTotal(session)}</strong>
              <span>Tokens</span>
            </div>
            <div>
              <strong
                title={updatedAt ? formatHistoryTime(updatedAt) : undefined}
              >
                {updatedAt ? formatRelativeTime(updatedAt) : "-"}
              </strong>
              <span>Updated</span>
            </div>
            <p>
              Input {formatOptionalCompact(usage?.input_tokens)}
              <span>·</span>
              Cached {formatOptionalCompact(usage?.cached_input_tokens)}
              <span>·</span>
              Output {formatOptionalCompact(usage?.output_tokens)}
            </p>
          </section>
        ) : null}

        {unavailable ? (
          <div className="agent-history-unavailable" role="status">
            <strong>Session unavailable</strong>
            <p>{unavailableDetail}</p>
            {unavailableCommand ? (
              <div className="agent-history-command-row">
                <code>{unavailableCommand}</code>
                <button
                  type="button"
                  className="agent-history-icon"
                  onClick={() =>
                    void navigator.clipboard?.writeText(unavailableCommand)
                  }
                  aria-label="Copy integration command"
                  title="Copy command"
                >
                  <Copy size={13} />
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="secondary-btn"
              onClick={loadHistory}
            >
              <RefreshCw size={13} />
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="agent-history-tabs">
              <div
                className="agent-history-tab-list"
                role="tablist"
                aria-label="Session drawer view"
              >
                <div
                  className={
                    "agent-history-message-tab" +
                    (drawerTab === "messages" ? " is-active" : "")
                  }
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={drawerTab === "messages"}
                    onClick={() => setDrawerTab("messages")}
                  >
                    Messages
                    {visibleMessages.length > 0 ? (
                      <span>{visibleMessages.length}</span>
                    ) : null}
                  </button>
                  {drawerTab === "messages" ? (
                    <div
                      className="agent-history-assistant-filter"
                      title="Show assistant messages"
                    >
                      <Bot size={12} aria-hidden="true" />
                      <button
                        type="button"
                        role="switch"
                        aria-label="Show assistant messages"
                        aria-checked={showAssistantMessages}
                        className={
                          "agent-history-assistant-switch" +
                          (showAssistantMessages ? " is-on" : "")
                        }
                        onClick={() => {
                          const next = !showAssistantMessages;
                          setShowAssistantMessages(next);
                          persistShowAssistantMessages(next);
                        }}
                      >
                        <span />
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  role="tab"
                  aria-selected={drawerTab === "details"}
                  className={drawerTab === "details" ? "is-active" : ""}
                  onClick={() => setDrawerTab("details")}
                >
                  Details
                </button>
              </div>
            </div>

            {error ? <div className="agent-history-error">{error}</div> : null}
            {drawerTab === "messages" ? (
              <div className="agent-history-content" role="tabpanel">
                {loading && messages.length === 0 ? (
                  <div className="agent-history-state">
                    <span className="terminal-loading-dot" />
                    Loading messages
                  </div>
                ) : visibleMessages.length === 0 ? (
                  <div className="agent-history-state">
                    {messages.length > 0
                      ? "No user messages were found in this session."
                      : "No conversation messages were found in this session."}
                  </div>
                ) : (
                  <div className="agent-history-timeline">
                    {visibleMessages.map(({ message, sequence }) => (
                      <AgentHistoryMessageCard
                        entry={message}
                        index={sequence}
                        key={message.id}
                        onExpand={() => setExpandedMessage(message)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="agent-history-details" role="tabpanel">
                <DetailRow label="Workspace" value={workspaceLabel} />
                <DetailRow label="Agent" value={pane.agent ?? "-"} />
                <DetailRow label="Pane" value={shortId(pane.pane_id)} />
                <DetailRow
                  label="Session ID"
                  value={session?.session?.value || "-"}
                  copyable={!!session?.session?.value}
                />
                <DetailRow
                  label="Session file"
                  value={session?.path || history?.path || "-"}
                  copyable={!!(session?.path || history?.path)}
                />
                <DetailRow
                  label="Records"
                  value={
                    sessionReady ? formatCount(session.stats.records) : "-"
                  }
                />
                <DetailRow
                  label="File size"
                  value={sessionReady ? formatBytes(session.file?.size) : "-"}
                />
                <DetailRow
                  label="Reasoning"
                  value={formatOptionalCompact(usage?.reasoning_output_tokens)}
                />
                <DetailRow
                  label="Updated"
                  value={updatedAt ? formatHistoryTime(updatedAt) : "-"}
                />
              </div>
            )}

            {sessionReady ? (
              <div className="agent-history-footer">
                <button
                  type="button"
                  className="primary-btn"
                  onClick={openSessionPreview}
                >
                  <Eye size={14} />
                  Open Inspector
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => downloadSession(pane, connectionClient)}
                >
                  <Download size={14} />
                  Export raw
                </button>
              </div>
            ) : null}
          </>
        )}
      </aside>
      <AgentMessageDialog
        message={expandedMessage}
        onClose={closeExpandedMessage}
      />
      <AgentSessionPreviewDialog
        pane={previewPane}
        summary={previewSummary}
        loading={previewLoading}
        error={previewError}
        onClose={closeSessionPreview}
      />
    </>
  );
}

function DetailRow({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="agent-history-detail-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
      {copyable ? (
        <button
          type="button"
          className="agent-history-icon"
          onClick={() => void navigator.clipboard?.writeText(value)}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
        >
          <Copy size={13} />
        </button>
      ) : null}
    </div>
  );
}
