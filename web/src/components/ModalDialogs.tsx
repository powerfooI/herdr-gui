import { useEffect, useRef, useState } from "react";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import { dialogKeyAction } from "./dialogKeyboard";

export function TextInputDialog({
  open,
  title,
  label,
  initialValue = "",
  placeholder,
  submitLabel = "Save",
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    const cancelFocus = focusDialogElement(inputRef.current, { select: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey);
    };
  }, [initialValue, open]);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(value);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <label className="form-field">
          <span>{label}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder={placeholder}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onConfirmRef = useRef(onConfirm);
  const onCloseRef = useRef(onClose);

  onConfirmRef.current = onConfirm;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      const isInsideDialog = !!target && !!dialogRef.current?.contains(target);
      const action = dialogKeyAction(e.key, isInsideDialog);
      if (action === "close") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (action === "contain") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <p className="modal-body-text">{message}</p>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "danger" : ""}
            onClick={() => {
              onConfirmRef.current();
              onCloseRef.current();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MessageDialog({
  open,
  title,
  message,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      const isInsideDialog = !!target && !!dialogRef.current?.contains(target);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (!isInsideDialog) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal compact-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <p className="modal-body-text">{message}</p>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
