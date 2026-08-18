import { useEffect, useRef } from "react";
import { focusDialogElement } from "./dialogFocus";

type ShortcutGroup = {
  title: string;
  shortcuts: Array<{
    keys: string;
    description: string;
  }>;
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Global",
    shortcuts: [
      { keys: "Cmd/Ctrl+K", description: "Open or close the command menu" },
      {
        keys: "Alt/Option+1 ... Alt/Option+9 in menu",
        description: "Run a numbered command menu action",
      },
      { keys: "Cmd+B", description: "Toggle the sidebar on desktop" },
      {
        keys: "Ctrl+Tab / Ctrl+Shift+Tab",
        description: "Open the recent pane switcher",
      },
      { keys: "Cmd+T", description: "Create a tab in the focused workspace" },
      { keys: "Cmd+W", description: "Close the focused tab" },
      {
        keys: "Cmd+Option+Left / Right",
        description: "Switch tabs in the focused workspace",
      },
      { keys: "Ctrl+Shift+W", description: "Open Workspaces" },
      {
        keys: "Cmd/Ctrl + Shift + E",
        description: "Toggle the file explorer",
      },
      { keys: "Ctrl+Shift+G", description: "Open Diff Viewer" },
      {
        keys: "Ctrl+1 ... Ctrl+9",
        description: "Switch tabs in the focused workspace",
      },
      {
        keys: "Esc",
        description:
          "Dismiss toast notifications, update banners, menus, or dialogs",
      },
    ],
  },
  {
    title: "Terminal",
    shortcuts: [
      {
        keys: "PageUp / PageDown",
        description: "Scroll terminal history by one page",
      },
      {
        keys: "Alt/Option+PageUp / PageDown",
        description: "Scroll terminal history by half a page",
      },
      {
        keys: "Shift+Enter",
        description: "Send a multiline Enter sequence to the agent",
      },
      { keys: "Alt+Enter", description: "Send an Alt-modified Enter sequence" },
      {
        keys: "Cmd+Left / Cmd+Up",
        description: "Move to the beginning of the current input line",
      },
      {
        keys: "Cmd+Right / Cmd+Down",
        description: "Move to the end of the current input line",
      },
      {
        keys: "Cmd+Backspace",
        description: "Delete from cursor to the beginning of the line",
      },
      { keys: "Cmd+V", description: "Paste text or images on Apple platforms" },
      {
        keys: "Ctrl+V",
        description: "Paste text or images on non-Apple platforms",
      },
      { keys: "Cmd/Ctrl+Click link", description: "Open HTTP and HTTPS links" },
      {
        keys: "Cmd/Ctrl+Click /path",
        description: "Preview workspace file paths from terminal output",
      },
      {
        keys: "Cmd/Ctrl + Shift + H",
        description: "Toggle agent message history for the active terminal",
      },
    ],
  },
  {
    title: "Preview & Diff",
    shortcuts: [
      {
        keys: "Cmd/Ctrl+F",
        description: "Search in the visible file preview or Diff Viewer",
      },
    ],
  },
  {
    title: "Mobile Terminal",
    shortcuts: [
      {
        keys: "Shortcut panel",
        description:
          "Send configured terminal keys from up to two aligned rows",
      },
      {
        keys: "PgUp / PgDn",
        description: "Scroll terminal history by one page",
      },
      {
        keys: "A-PgUp / A-PgDn",
        description: "Scroll terminal history by half a page",
      },
      {
        keys: "Side buttons",
        description: "Run up to four configured actions at the terminal edge",
      },
      {
        keys: "Menu",
        description: "Customize the 2-by-8 panel and four side buttons",
      },
    ],
  },
];

export function ShortcutLookupDialog({
  open,
  onClose,
}: {
  open: boolean;
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
        className="modal shortcut-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Shortcut lookup"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Shortcut Lookup</h2>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        <div className="shortcut-list">
          {SHORTCUT_GROUPS.map((group) => (
            <section className="shortcut-section" key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.shortcuts.map((shortcut) => (
                  <div
                    className="shortcut-row"
                    key={`${group.title}-${shortcut.keys}`}
                  >
                    <dt>
                      <kbd>{shortcut.keys}</kbd>
                    </dt>
                    <dd>{shortcut.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
