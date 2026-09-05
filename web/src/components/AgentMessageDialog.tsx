import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy } from "lucide-react";
import { UI_LOCALE } from "../uiLocale";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import { MarkdownPreview } from "./markdown";

type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  kind?: "message" | "tool_call" | "tool_result" | "error";
  tool_name?: string;
  source_call_id?: string;
  is_error?: boolean;
  text: string;
  sent_at: string;
};

function formatMessageTime(sentAt: string) {
  const time = new Date(sentAt);
  if (Number.isNaN(time.getTime())) return sentAt;
  return time.toLocaleString(UI_LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AgentMessageDialog({
  message,
  onClose,
}: {
  message: AgentMessage | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const messageId = message?.id ?? null;
  const [viewMode, setViewMode] = useState<"rendered" | "raw">(
    message?.role === "assistant" ? "rendered" : "raw",
  );
  const [viewModeMessageId, setViewModeMessageId] = useState(messageId);

  if (messageId !== viewModeMessageId) {
    // A refreshed snapshot replaces objects, not the user's selected message.
    // Reset only when opening another entry or closing/reopening the dialog.
    setViewModeMessageId(messageId);
    setViewMode(message?.role === "assistant" ? "rendered" : "raw");
  }

  useEffect(() => {
    if (messageId === null) return;
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [messageId, onClose]);

  if (!message) return null;
  const isTool = message.role === "tool";
  const roleLabel = isTool
    ? `${message.kind === "tool_call" ? "Tool arguments" : message.is_error ? "Tool error" : "Tool output"}: ${message.tool_name ?? "tool"}`
    : message.role === "assistant"
      ? "Assistant"
      : "User";

  // Render at the document root: on mobile the transformed .app box becomes
  // the containing block for fixed elements, and the inspector slot's stacking
  // context (z-index 3) would leave the topbar (z-index 120) painted over the
  // dialog. A body-level backdrop escapes both.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal agent-message-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Full ${roleLabel.toLowerCase()} message`}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head agent-message-modal-head">
          <div>
            <h3>{roleLabel} Message</h3>
            <time>{formatMessageTime(message.sent_at)}</time>
            {message.source_call_id ? (
              <p>Call ID: {message.source_call_id}</p>
            ) : null}
          </div>
          <div className="agent-message-modal-actions">
            {!isTool ? (
              <button
                type="button"
                className="agent-message-mode-toggle"
                onClick={() =>
                  setViewMode((mode) =>
                    mode === "rendered" ? "raw" : "rendered",
                  )
                }
                aria-label={
                  viewMode === "rendered"
                    ? "Show raw markdown"
                    : "Show rendered markdown"
                }
                title={viewMode === "rendered" ? "Show raw" : "Show rendered"}
              >
                {viewMode === "rendered" ? "Raw" : "Rendered"}
              </button>
            ) : null}
            <button
              type="button"
              className="agent-history-icon"
              onClick={() => void navigator.clipboard?.writeText(message.text)}
              aria-label="Copy message"
              title="Copy"
            >
              <Copy size={15} />
            </button>
            <CloseButton label="Close message" onClick={onClose} />
          </div>
        </div>
        {!isTool && viewMode === "rendered" ? (
          <div className="agent-message-modal-content is-rendered">
            <MarkdownPreview
              text={message.text}
              className="agent-message-markdown"
              breaks
            />
          </div>
        ) : (
          <pre className="agent-message-modal-content">{message.text}</pre>
        )}
      </div>
    </div>,
    document.body,
  );
}
