import { useEffect } from "react";
import changelog from "../../../CHANGELOG.md?raw";

export function ChangelogDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal changelog-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Changelog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Changelog</h2>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        </div>
        <pre className="changelog-content">{changelog}</pre>
      </div>
    </div>
  );
}
