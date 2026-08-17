import { useEffect, useRef, useState } from "react";
import { Copy, X } from "lucide-react";
import { focusDialogElement } from "./dialogFocus";
import { MarkdownPreview } from "./markdown";

type AgentMessage = {
  role: "user" | "assistant";
  text: string;
  sent_at: string;
};

function formatMessageTime(sentAt: string) {
  const time = new Date(sentAt);
  if (Number.isNaN(time.getTime())) return sentAt;
  return time.toLocaleString([], {
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
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");
  const [viewModeMessage, setViewModeMessage] = useState(message);

  if (message !== viewModeMessage) {
    // Reset the view for each newly opened message during render so the stale
    // mode never flashes. Assistant messages are usually markdown; user
    // messages are usually prose.
    setViewModeMessage(message);
    setViewMode(message?.role === "assistant" ? "rendered" : "raw");
  }

  useEffect(() => {
    if (!message) return;
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
  }, [message, onClose]);

  if (!message) return null;
  const roleLabel = message.role === "assistant" ? "Assistant" : "User";

  return (
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
          </div>
          <div className="agent-message-modal-actions">
            <button
              type="button"
              className="agent-message-mode-toggle"
              onClick={() =>
                setViewMode((mode) => (mode === "rendered" ? "raw" : "rendered"))
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
            <button
              type="button"
              className="agent-history-icon"
              onClick={() => void navigator.clipboard?.writeText(message.text)}
              aria-label="Copy message"
              title="Copy"
            >
              <Copy size={15} />
            </button>
            <button
              type="button"
              className="agent-history-icon"
              onClick={onClose}
              aria-label="Close message"
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
        </div>
        {viewMode === "rendered" ? (
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
    </div>
  );
}
