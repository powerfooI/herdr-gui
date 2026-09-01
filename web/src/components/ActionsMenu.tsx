import { useEffect, useLayoutEffect, useRef } from "react";
import { observeClampedContextMenu } from "./contextMenuPosition";

export type ActionsMenuItem = {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  detail?: string;
  action: () => void;
};

export type ActionsMenuGroup = {
  label: string;
  items: ActionsMenuItem[];
  danger?: boolean;
};

// Shared anchored popup menu (right-click, long-press, keyboard, toolbar).
// Mirrors the file explorer menu behavior: outside click / Escape / scroll
// closes, arrows navigate, focus returns to the trigger on close.
export function ActionsMenu({
  x,
  y,
  header,
  groups,
  onClose,
}: {
  x: number;
  y: number;
  header?: { title: string; subtitle?: string };
  groups: ActionsMenuGroup[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']:not(:disabled)",
        ) ?? [],
      );
      const currentIndex = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (!buttons.length || currentIndex < 0) return;
      e.preventDefault();
      const nextIndex =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : e.key === "ArrowDown"
              ? (currentIndex + 1) % buttons.length
              : (currentIndex - 1 + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", close, true);
      ref.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")
        ?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    return observeClampedContextMenu(menu, { left: x, top: y });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className={`context-menu ${header ? "context-menu--grouped" : ""}`}
      style={{ position: "fixed", left: x, top: y, zIndex: 1000 }}
      role="menu"
    >
      {header ? (
        <div className="context-menu-header">
          <strong title={header.title}>{header.title}</strong>
          {header.subtitle ? <small>{header.subtitle}</small> : null}
        </div>
      ) : null}
      {groups.map((group) => (
        <div
          key={group.label}
          className={`context-menu-group ${group.danger ? "is-danger" : ""}`}
        >
          {groups.length > 1 ? (
            <div className="context-menu-group-title">{group.label}</div>
          ) : null}
          {group.items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.action();
              }}
            >
              <span className="context-menu-item-label">{item.label}</span>
              {item.detail ? (
                <span className="context-menu-item-detail">{item.detail}</span>
              ) : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
