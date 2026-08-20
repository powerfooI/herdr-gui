import { useEffect, useRef, useState } from "react";
import { luckyWorkspaceName } from "../luckyName";
import { store } from "../store";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";

export function CreateWorkspaceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  const labelRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setLabel(luckyWorkspaceName());
    setCwd("");
    const cancelFocus = focusDialogElement(labelRef.current, { select: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    store.createWorkspace(label.trim() || undefined, cwd.trim() || undefined);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create workspace"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Create Workspace</h2>
          <CloseButton onClick={onClose} />
        </div>

        <label className="form-field">
          <span>Name</span>
          <input
            ref={labelRef}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder="Optional"
          />
        </label>

        <label className="form-field">
          <span>CWD</span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.currentTarget.value)}
            placeholder="Optional path"
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">Create</button>
        </div>
      </form>
    </div>
  );
}
