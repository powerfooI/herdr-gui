import { useStore, store } from "../store";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Tab } from "../types";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const REQUEST_CLOSE_TAB_EVENT = "herdr-gui:request-close-tab";

interface TabMenuState {
  tab: Tab;
  x: number;
  y: number;
}

function tabName(tab?: Tab) {
  if (!tab) return "";
  return tab.label && tab.label !== String(tab.number)
    ? tab.label
    : `Tab ${tab.number}`;
}

/**
 * Routes non-TabBar close controls through the same confirmation dialog used
 * by the tab strip, so keyboard shortcuts cannot bypass destructive-action UX.
 */
export function requestCloseTab(tabId: string) {
  window.dispatchEvent(
    new CustomEvent(REQUEST_CLOSE_TAB_EVENT, { detail: { tabId } }),
  );
}

/**
 * Tab strip for the focused workspace, with create (+) and close (×) controls.
 * Desktop keeps the strip visible even with one tab, while mobile hides it when
 * there is no real tab choice to save vertical terminal space.
 */
export function TabBar({ mobile = false }: { mobile?: boolean }) {
  const s = useStore();
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );
  const [pendingRenameTab, setPendingRenameTab] = useState<Tab | null>(null);
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const focusedWs = s.workspaces.find((w) => w.focused);
  const tabs = s.tabs
    .filter((t) => t.workspace_id === focusedWs?.workspace_id)
    .sort((a, b) => a.number - b.number);
  const pendingCloseTab = s.tabs.find((t) => t.tab_id === pendingCloseTabId);
  const pendingCloseTabName = tabName(pendingCloseTab);
  const showTabStrip = !!focusedWs && (!mobile || tabs.length > 1);

  useEffect(() => {
    const onRequestClose = (event: Event) => {
      const tabId = (event as CustomEvent<{ tabId?: unknown }>).detail?.tabId;
      if (typeof tabId === "string" && tabId) setPendingCloseTabId(tabId);
    };
    window.addEventListener(REQUEST_CLOSE_TAB_EVENT, onRequestClose);
    return () =>
      window.removeEventListener(REQUEST_CLOSE_TAB_EVENT, onRequestClose);
  }, []);

  if (!focusedWs) return null;

  const overlays = (
    <>
      <TabContextMenu
        state={menu}
        onClose={() => setMenu(null)}
        onFocus={(tab) => store.focusTab(tab.tab_id)}
        onRename={(tab) => setPendingRenameTab(tab)}
        onCloseTab={(tab) => setPendingCloseTabId(tab.tab_id)}
        onCreateTab={() => store.createTab(focusedWs.workspace_id)}
      />
      <ConfirmDialog
        open={!!pendingCloseTabId}
        title="Close Tab"
        message={
          pendingCloseTabName
            ? `Close "${pendingCloseTabName}"?`
            : "Close this tab?"
        }
        confirmLabel="Close"
        danger
        onClose={() => setPendingCloseTabId(null)}
        onConfirm={() => {
          if (pendingCloseTabId) store.closeTab(pendingCloseTabId);
        }}
      />
      <TextInputDialog
        open={!!pendingRenameTab}
        title="Rename Tab"
        label="Name"
        initialValue={tabName(pendingRenameTab ?? undefined)}
        submitLabel="Rename"
        onClose={() => setPendingRenameTab(null)}
        onSubmit={(label) => {
          const value = label.trim();
          if (pendingRenameTab && value) {
            store.renameTab(pendingRenameTab.tab_id, value);
          }
          setPendingRenameTab(null);
        }}
      />
    </>
  );

  return (
    <>
      {showTabStrip ? (
        <div className="tabbar">
          {tabs.map((t) => {
            const name =
              t.label && t.label !== String(t.number)
                ? t.label
                : `Tab ${t.number}`;
            return (
              <div
                key={t.tab_id}
                className={`tabbar-tab ${t.focused ? "is-active" : ""}`}
                onClick={() => store.focusTab(t.tab_id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ tab: t, x: e.clientX, y: e.clientY });
                }}
                title={t.tab_id}
              >
                <TabLongPressTarget
                  tab={t}
                  onOpenMenu={(x, y) => setMenu({ tab: t, x, y })}
                >
                  <span className="tabbar-name">{name}</span>
                </TabLongPressTarget>
                <button
                  className="tabbar-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingCloseTabId(t.tab_id);
                  }}
                  title="关闭 tab"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            className="tabbar-add"
            onClick={() => store.createTab(focusedWs.workspace_id)}
            title="新建 tab"
          >
            +
          </button>
        </div>
      ) : null}
      {createPortal(overlays, document.body)}
    </>
  );
}

function TabLongPressTarget({
  tab,
  children,
  onOpenMenu,
}: {
  tab: Tab;
  children: React.ReactNode;
  onOpenMenu: (x: number, y: number) => void;
}) {
  // Touch long-press opens the same menu as desktop right-click.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);

  const clearLongPressTimer = () => {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => clearLongPressTimer, []);

  return (
    <span
      className="tabbar-name-hit"
      onClick={(e) => {
        if (!longPressTriggered.current) return;
        longPressTriggered.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        longPressTriggered.current = false;
        longPressStart.current = { x: e.clientX, y: e.clientY };
        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
          longPressTriggered.current = true;
          onOpenMenu(e.clientX, e.clientY);
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
      onPointerUp={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      title={tab.tab_id}
    >
      {children}
    </span>
  );
}

function TabContextMenu({
  state,
  onClose,
  onFocus,
  onRename,
  onCloseTab,
  onCreateTab,
}: {
  state: TabMenuState | null;
  onClose: () => void;
  onFocus: (tab: Tab) => void;
  onRename: (tab: Tab) => void;
  onCloseTab: (tab: Tab) => void;
  onCreateTab: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Keep the floating menu tied to the current interaction.
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
    { label: "Focus tab", action: () => onFocus(state.tab) },
    { label: "Rename tab...", action: () => onRename(state.tab) },
    { label: "Create tab", action: onCreateTab },
    {
      label: "Close tab",
      danger: true,
      action: () => onCloseTab(state.tab),
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
