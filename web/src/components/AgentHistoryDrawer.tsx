import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Copy, Download, Eye, RefreshCw, X } from "lucide-react";
import { useStoreSelector } from "../store";
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
} from "./agentSession";

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

// Cards are memoized because the timeline can hold hundreds of them and the
// drawer's minimap viewport tracking re-renders on every scroll boundary.
const AgentHistoryMessageCard = memo(function AgentHistoryMessageCard({
  entry,
  index,
  highlighted = false,
  onExpand,
}: {
  entry: AgentHistoryEntry;
  index: number;
  highlighted?: boolean;
  onExpand: (entry: AgentHistoryEntry) => void;
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
    <article
      className={`agent-history-card is-${entry.role} ${
        highlighted ? "is-minimap-target" : ""
      }`}
      data-sequence={index}
    >
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
        onClick={() => onExpand(entry)}
        aria-label={`View ${roleAriaLabel} message ${index}`}
      >
        <pre ref={contentRef}>{entry.text}</pre>
        {truncated ? <span>View full message</span> : null}
      </button>
    </article>
  );
});

type MessageMinimapVisibleRange = { start: number; end: number };

function minimapPrefersReducedMotion() {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

// The minimap keeps its bars in a uniform-width flex row, so a pointer
// position maps to a message index from the strip geometry alone.
function AgentHistoryMinimap({
  entries,
  visibleRange,
  indicatorRef,
  onSelect,
}: {
  entries: { message: AgentHistoryEntry; sequence: number }[];
  visibleRange: MessageMinimapVisibleRange | null;
  indicatorRef: RefObject<HTMLDivElement>;
  onSelect: (sequence: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const visibleRangeRef = useRef<MessageMinimapVisibleRange | null>(null);
  visibleRangeRef.current = visibleRange;

  // With more messages than the strip can fit, the bars overflow and the
  // strip scrolls horizontally; keep the raised wave inside the strip's own
  // viewport instead of letting it drift out of sight. Suppressed while the
  // user is scrubbing so the strip never moves under their finger.
  const centerWave = useCallback(() => {
    const strip = stripRef.current;
    const range = visibleRangeRef.current;
    if (!strip || !range || scrubbingRef.current) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const startBar = strip.children[range.start - 1];
    const endBar = strip.children[range.end - 1];
    if (!(startBar instanceof HTMLElement) || !(endBar instanceof HTMLElement))
      return;
    const stripRect = strip.getBoundingClientRect();
    const waveLeft =
      startBar.getBoundingClientRect().left - stripRect.left + strip.scrollLeft;
    const waveRight =
      endBar.getBoundingClientRect().right - stripRect.left + strip.scrollLeft;
    const target = Math.max(
      0,
      Math.min(
        strip.scrollWidth - strip.clientWidth,
        (waveLeft + waveRight - strip.clientWidth) / 2,
      ),
    );
    strip.scrollTo({
      left: target,
      behavior: minimapPrefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  useEffect(() => {
    centerWave();
  }, [centerWave, visibleRange]);

  const sequenceAtClientX = useCallback(
    (clientX: number) => {
      const strip = stripRef.current;
      const firstBar = strip?.firstElementChild;
      if (!strip || !(firstBar instanceof HTMLElement)) return null;
      const count = entries.length;
      if (count === 0) return null;
      // Derive the stride (bar width + gap) from the first two bars'
      // geometry so the mapping stays correct whatever gap the CSS uses.
      const firstLeft = firstBar.getBoundingClientRect().left;
      const secondBar = firstBar.nextElementSibling;
      const stride =
        secondBar instanceof HTMLElement
          ? secondBar.getBoundingClientRect().left - firstLeft
          : firstBar.offsetWidth;
      if (stride <= 0) return null;
      const stripRect = strip.getBoundingClientRect();
      const barsLeft = firstLeft - stripRect.left + strip.scrollLeft;
      const contentX = clientX - stripRect.left + strip.scrollLeft - barsLeft;
      const index = Math.max(
        0,
        Math.min(count - 1, Math.floor(contentX / stride)),
      );
      return entries[index]?.sequence ?? null;
    },
    [entries],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Capture so a drag keeps scrubbing even off the strip.
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubbingRef.current = true;
    const sequence = sequenceAtClientX(event.clientX);
    if (sequence !== null) onSelect(sequence);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Only scrub for drags that started on the strip; pointer capture keeps
    // routing those here until pointerup/pointercancel clears the ref. (No
    // event.buttons check: some touch implementations report buttons = 0
    // mid-drag, which would silently break scrubbing.)
    if (!scrubbingRef.current) return;
    const sequence = sequenceAtClientX(event.clientX);
    if (sequence !== null) onSelect(sequence);
  };
  const handlePointerEnd = () => {
    scrubbingRef.current = false;
    centerWave();
  };
  // The strip is a single slider-like control: one tab stop, with arrow-key
  // navigation across messages. The bars themselves stay non-focusable.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = entries.length;
    if (count === 0) return;
    const range = visibleRangeRef.current;
    const current = range?.start ?? 1;
    const span = range ? range.end - range.start + 1 : 1;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - 1;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + 1;
        break;
      case "PageUp":
        next = current - span;
        break;
      case "PageDown":
        next = current + span;
        break;
      case "Home":
        next = 1;
        break;
      case "End":
        next = count;
        break;
      default:
        return;
    }
    event.preventDefault();
    onSelect(Math.max(1, Math.min(count, next)));
  };

  const currentSequence = visibleRange?.start ?? 1;
  const currentEntry = entries[currentSequence - 1];
  const currentValueText = currentEntry
    ? `#${currentSequence} ${currentEntry.message.role === "assistant" ? "assistant" : "user"}`
    : undefined;

  return (
    <div className="agent-history-minimap-wrap">
      <div
        ref={stripRef}
        className="agent-history-minimap"
        role="slider"
        tabIndex={0}
        aria-label="Jump to message"
        aria-orientation="horizontal"
        aria-valuemin={1}
        aria-valuemax={entries.length}
        aria-valuenow={currentSequence}
        aria-valuetext={currentValueText}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {entries.map(({ message, sequence }) => {
          const roleLabel = message.role === "assistant" ? "assistant" : "user";
          const inView =
            visibleRange !== null &&
            sequence >= visibleRange.start &&
            sequence <= visibleRange.end;
          return (
            <div
              key={message.id}
              className={
                `agent-history-minimap-bar is-${message.role}` +
                (inView ? " is-in-view" : "")
              }
              title={`#${sequence} ${roleLabel}`}
            />
          );
        })}
      </div>
      <div className="agent-history-minimap-scrollbar" aria-hidden="true">
        <div
          ref={indicatorRef}
          className="agent-history-minimap-scrollbar-thumb"
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}

export function AgentHistoryDrawer({
  pane,
  open,
  embedded = false,
  onOpenChange,
}: {
  pane: Pane;
  open: boolean;
  embedded?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const workspaceLabel =
    workspaces.find((workspace) => workspace.workspace_id === pane.workspace_id)
      ?.label ?? pane.workspace_id;
  const [history, setHistory] = useState<AgentHistory | null>(null);
  const [session, setSession] = useState<AgentSessionSummary | null>(null);
  const [drawerTab, setDrawerTab] = useState<"messages" | "details">(
    "messages",
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
  const [highlightedSequence, setHighlightedSequence] = useState<number | null>(
    null,
  );
  const [visibleRange, setVisibleRange] =
    useState<MessageMinimapVisibleRange | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const minimapIndicatorRef = useRef<HTMLDivElement>(null);
  const visibleRangeKeyRef = useRef("");
  const highlightTimerRef = useRef<number | null>(null);
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
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedSequence(null);
    visibleRangeKeyRef.current = "";
    setVisibleRange(null);
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
  }, [connectionClient, pane.agent, pane.pane_id, pane.workspace_id]);

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

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    [],
  );

  const messagesKey = history?.messages;

  // Track which messages the timeline viewport contains so the minimap can
  // raise their bars as a moving "wave" while scrolling. Geometry-based
  // instead of IntersectionObserver: it updates every scroll frame and does
  // not depend on observer delivery timing, which mobile browsers throttle
  // aggressively during momentum scrolling.
  useEffect(() => {
    const root = contentRef.current;
    const timeline = timelineRef.current;
    if (drawerTab !== "messages" || !root || !timeline) {
      visibleRangeKeyRef.current = "";
      setVisibleRange(null);
      return;
    }
    const publish = (range: MessageMinimapVisibleRange | null) => {
      const key = range ? `${range.start}:${range.end}` : "";
      // Scrolling crosses card boundaries constantly; skip no-op publishes so
      // the drawer only re-renders when the visible range actually changes.
      if (key === visibleRangeKeyRef.current) return;
      visibleRangeKeyRef.current = key;
      setVisibleRange(range);
    };
    let frame = 0;
    const recompute = () => {
      frame = 0;
      const rootRect = root.getBoundingClientRect();
      // A hidden container (e.g. the inspector showing another view) has an
      // empty rect; skip the scan so background scrolls stay O(1) here.
      if (rootRect.width === 0 || rootRect.height === 0) {
        publish(null);
        return;
      }
      // Clip the viewport rect to the visible screen as well. Normally the
      // content container clips the timeline itself, but if an ancestor ends
      // up being the scroller (mobile viewport quirks) the container's rect
      // spans every card and would mark all bars in-view.
      const viewTop = Math.max(rootRect.top, 0);
      const viewBottom = Math.min(rootRect.bottom, window.innerHeight);
      const cards = timeline.children;
      const count = cards.length;
      // Seed the scan near the expected first visible card (scroll fraction
      // × count) instead of scanning from the top, then back up to the true
      // boundary. Heights vary so the seed is approximate, but the walk is
      // bounded by the estimation error instead of the full history, which
      // matters for long sessions and for frames with a dirty layout (each
      // rect read can otherwise force a layout of the whole timeline).
      let start = 0;
      if (count > 0 && root.scrollHeight > 0) {
        const scrollViewTop = root.scrollTop + (viewTop - rootRect.top);
        start = Math.min(
          count - 1,
          Math.max(0, Math.floor((scrollViewTop / root.scrollHeight) * count)),
        );
        while (start > 0) {
          const prev = cards[start - 1].getBoundingClientRect();
          if (prev.bottom <= viewTop) break;
          start--;
        }
      }
      let min = Infinity;
      let max = -Infinity;
      for (let i = start; i < count; i++) {
        const card = cards[i];
        const rect = card.getBoundingClientRect();
        // Cards stack vertically in DOM order, so once one starts below the
        // viewport every later card is below it too.
        if (rect.top >= viewBottom) break;
        if (rect.bottom <= viewTop) continue;
        const sequence = Number((card as HTMLElement).dataset.sequence);
        if (!Number.isFinite(sequence)) continue;
        min = Math.min(min, sequence);
        max = Math.max(max, sequence);
      }
      publish(min <= max ? { start: min, end: max } : null);
      // Move the minimap indicator like a real scrollbar: a continuous,
      // per-frame linear mapping of the timeline's scroll geometry (the same
      // math native scrollbars use), applied imperatively so it glides with
      // the scroll instead of stepping with the wave state.
      const thumb = minimapIndicatorRef.current;
      const track = thumb?.parentElement;
      if (thumb && track) {
        const maxScroll = root.scrollHeight - root.clientHeight;
        if (maxScroll <= 1) {
          thumb.style.display = "none";
        } else {
          const trackWidth = track.clientWidth;
          const thumbWidth = Math.max(
            (root.clientHeight / root.scrollHeight) * trackWidth,
            12,
          );
          thumb.style.display = "block";
          thumb.style.width = `${thumbWidth}px`;
          thumb.style.transform = `translateX(${(root.scrollTop / maxScroll) * (trackWidth - thumbWidth)}px)`;
        }
      }
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(recompute);
    };
    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
    // Scroll events do not bubble, but capture listeners on window fire for
    // scrolls on any descendant, so this covers the content container and
    // any ancestor that ends up scrolling instead. Filter out scrolls that
    // cannot move the timeline so unrelated views never wake this up.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        target === document ||
        (target instanceof Node &&
          (root.contains(target) || target.contains(root)))
      ) {
        schedule();
      }
    };
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
    };
  }, [drawerTab, messagesKey]);

  // Stable identity so the message dialog's focus effect only re-runs when the
  // message itself changes, not on every drawer re-render.
  const closeExpandedMessage = useCallback(() => setExpandedMessage(null), []);

  const scrollToMessage = useCallback((sequence: number) => {
    const card = timelineRef.current?.querySelector(
      `[data-sequence="${sequence}"]`,
    );
    if (!(card instanceof HTMLElement)) return;
    const reduceMotion = minimapPrefersReducedMotion();
    card.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    setHighlightedSequence(sequence);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightedSequence(null);
    }, 1200);
  }, []);

  const usage = tokenUsage(session);
  const messages = history?.messages ?? [];
  const messageEntries = messages.map((message, index) => ({
    message,
    sequence: index + 1,
  }));
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
        className={`agent-history-drawer ${open ? "is-open" : ""} ${
          embedded ? "is-embedded" : ""
        }`}
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
            {!embedded ? (
              <button
                type="button"
                className="agent-history-icon"
                onClick={() => onOpenChange(false)}
                aria-label="Close session"
                title="Close"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        </div>

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
                <button
                  type="button"
                  role="tab"
                  aria-selected={drawerTab === "messages"}
                  className={drawerTab === "messages" ? "is-active" : ""}
                  onClick={() => setDrawerTab("messages")}
                >
                  Messages
                  {messageEntries.length > 0 ? (
                    <span>{messageEntries.length}</span>
                  ) : null}
                </button>
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
              <div className="agent-history-messages" role="tabpanel">
                {messageEntries.length > 1 ? (
                  <AgentHistoryMinimap
                    entries={messageEntries}
                    visibleRange={visibleRange}
                    indicatorRef={minimapIndicatorRef}
                    onSelect={scrollToMessage}
                  />
                ) : null}
                <div className="agent-history-content" ref={contentRef}>
                  {loading && messages.length === 0 ? (
                    <div className="agent-history-state">
                      <span className="terminal-loading-dot" />
                      Loading messages
                    </div>
                  ) : messageEntries.length === 0 ? (
                    <div className="agent-history-state">
                      No conversation messages were found in this session.
                    </div>
                  ) : (
                    <div className="agent-history-timeline" ref={timelineRef}>
                      {messageEntries.map(({ message, sequence }) => (
                        <AgentHistoryMessageCard
                          entry={message}
                          index={sequence}
                          key={message.id}
                          highlighted={highlightedSequence === sequence}
                          onExpand={setExpandedMessage}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="agent-history-details" role="tabpanel">
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
                        title={
                          updatedAt ? formatHistoryTime(updatedAt) : undefined
                        }
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
                  Open transcript
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
