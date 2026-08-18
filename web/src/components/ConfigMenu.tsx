import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Download,
  GitBranch,
  Keyboard,
  Moon,
  Palette,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Server,
  Sun,
  Users,
  Wifi,
} from "lucide-react";
import packageJson from "../../package.json";
import type { Theme } from "../App";
import { ACCENT_OPTIONS, type AccentColor } from "../appearance";
import { store, useStore } from "../store";
import {
  mobileTerminalShortcutCount,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import { AutoSyncRepositoriesDialog } from "./AutoSyncRepositoriesDialog";
import { ChangelogDialog } from "./ChangelogDialog";
import { ShortcutLookupDialog } from "./ShortcutLookupDialog";
import { MobileTerminalShortcutsDialog } from "./MobileTerminalShortcutsDialog";

const APP_VERSION = packageJson.version;
export const CONFIG_MENU_ID = "herdr-config-menu";

export function reloadApplicationPage(
  target: Pick<Location, "reload"> = window.location,
) {
  target.reload();
}

type HealthInfo = {
  socket?: string;
};

type HerdrInfo = {
  version: string;
  protocol: number;
};

type ConfigMenuProps = {
  theme: Theme;
  accentColor: AccentColor;
  mobileTerminalShortcuts: MobileTerminalShortcutRows;
  mobileTerminalSideShortcuts: MobileTerminalSideShortcuts;
  onThemeChange: (theme: Theme) => void;
  onAccentColorChange: (accentColor: AccentColor) => void;
  onMobileTerminalShortcutsChange: (rows: MobileTerminalShortcutRows) => void;
  onMobileTerminalSideShortcutsChange: (
    shortcuts: MobileTerminalSideShortcuts,
  ) => void;
};

export function ConfigMenu({
  theme,
  accentColor,
  mobileTerminalShortcuts,
  mobileTerminalSideShortcuts,
  onThemeChange,
  onAccentColorChange,
  onMobileTerminalShortcutsChange,
  onMobileTerminalSideShortcutsChange,
}: ConfigMenuProps) {
  const s = useStore();
  const updateAvailable = !!s.updateInfo?.update_available;
  const canInstallUpdate = updateAvailable && s.updateInfo?.can_auto_update;
  const updateVersion = s.updateInfo?.latest_version;
  const clientCount =
    !s.connectionPaused && s.status === "connected"
      ? s.bridgeStatus?.clients
      : null;
  const otherClientCount =
    typeof clientCount === "number" ? Math.max(0, clientCount - 1) : 0;
  const taskNotificationValue = taskNotificationStatus(
    s.taskNotificationsEnabled,
    s.taskNotificationPermission,
  );
  const [open, setOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileShortcutsOpen, setMobileShortcutsOpen] = useState(false);
  const [autoSyncOpen, setAutoSyncOpen] = useState(false);
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [herdrInfo, setHerdrInfo] = useState<HerdrInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHealth(null);
    setHerdrInfo(null);

    fetch("/api/health", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((healthInfo) => {
        if (!cancelled) setHealth(healthInfo);
      });

    fetch("/api/herdr-info", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((info) => {
        if (!cancelled) setHerdrInfo(info);
      });

    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelled = true;
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  return (
    <>
      <div className="config-menu" ref={ref}>
        <button
          ref={triggerRef}
          className={`topbar-button menu-button ${open ? "is-active" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-label={updateAvailable ? "Menu, update available" : "Menu"}
          aria-controls={open ? CONFIG_MENU_ID : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          Menu
          {updateAvailable ? <span className="menu-update-dot" /> : null}
        </button>

        {open ? (
          <div
            id={CONFIG_MENU_ID}
            className="config-dropdown"
            role="dialog"
            aria-label="Application menu"
          >
            <div className="config-summary">
              <div>
                <strong>herdr-gui</strong>
                <span>Version {APP_VERSION}</span>
              </div>
              <span
                className={`config-connection-summary status-${s.connectionPaused ? "paused" : s.status}`}
              >
                <span className="status-dot" />
                {s.connectionPaused ? "Paused" : s.status}
                {typeof clientCount === "number"
                  ? ` · ${clientCount} client${clientCount === 1 ? "" : "s"}`
                  : ""}
              </span>
            </div>

            <div className="config-section">
              <div className="config-title">Preferences</div>
              <div className="config-preference-row">
                <span className="config-item-icon">
                  {theme === "light" ? <Sun size={15} /> : <Moon size={15} />}
                </span>
                <div className="config-item-copy">
                  <strong>Theme</strong>
                  <span>Application appearance</span>
                </div>
                <div className="config-theme-control" aria-label="Theme">
                  <button
                    type="button"
                    aria-label="Use light theme"
                    aria-pressed={theme === "light"}
                    className={theme === "light" ? "is-active" : ""}
                    onClick={() => onThemeChange("light")}
                  >
                    <Sun size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="Use dark theme"
                    aria-pressed={theme === "dark"}
                    className={theme === "dark" ? "is-active" : ""}
                    onClick={() => onThemeChange("dark")}
                  >
                    <Moon size={14} />
                  </button>
                </div>
              </div>
              <div className="config-preference-row">
                <span className="config-item-icon">
                  <Palette size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Accent color</strong>
                  <span>
                    {
                      ACCENT_OPTIONS.find(
                        (option) => option.value === accentColor,
                      )?.label
                    }
                  </span>
                </div>
                <div
                  className="config-accent-control"
                  role="radiogroup"
                  aria-label="Accent color"
                >
                  {ACCENT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      data-accent={option.value}
                      title={option.label}
                      aria-label={option.label}
                      aria-checked={accentColor === option.value}
                      tabIndex={accentColor === option.value ? 0 : -1}
                      className={
                        accentColor === option.value ? "is-active" : ""
                      }
                      onClick={() => onAccentColorChange(option.value)}
                      onKeyDown={(event) => {
                        const direction =
                          event.key === "ArrowRight" ||
                          event.key === "ArrowDown"
                            ? 1
                            : event.key === "ArrowLeft" ||
                                event.key === "ArrowUp"
                              ? -1
                              : 0;
                        if (direction === 0) return;
                        event.preventDefault();
                        const nextIndex =
                          (ACCENT_OPTIONS.indexOf(option) +
                            direction +
                            ACCENT_OPTIONS.length) %
                          ACCENT_OPTIONS.length;
                        const next = ACCENT_OPTIONS[nextIndex];
                        onAccentColorChange(next.value);
                        const buttons =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            '[role="radio"]',
                          );
                        buttons?.[nextIndex]?.focus();
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="config-preference-row">
                <span className="config-item-icon">
                  <Bell size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Task notifications</strong>
                  <span>{taskNotificationValue}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Task notifications"
                  aria-checked={s.taskNotificationsEnabled}
                  className={
                    "settings-switch" +
                    (s.taskNotificationsEnabled ? " is-on" : "")
                  }
                  onClick={() => {
                    void store.setTaskNotificationsEnabled(
                      !s.taskNotificationsEnabled,
                    );
                  }}
                >
                  <span />
                </button>
              </div>
              <ConfigMenuItem
                icon={<Keyboard size={15} />}
                label="Mobile terminal shortcuts"
                description={`${mobileTerminalShortcutCount(
                  mobileTerminalShortcuts,
                )} panel · ${mobileTerminalSideShortcuts.filter(Boolean).length} side`}
                onClick={() => {
                  setOpen(false);
                  setMobileShortcutsOpen(true);
                }}
              />
              <ConfigMenuItem
                icon={<GitBranch size={15} />}
                label="Automatic branch updates"
                description="Configure repository sync"
                onClick={() => {
                  setOpen(false);
                  setAutoSyncOpen(true);
                }}
              />
            </div>

            <div className="config-section">
              <div className="config-title">Help & updates</div>
              <ConfigMenuItem
                icon={<ScrollText size={15} />}
                label="Changelog"
                description="Recent changes"
                onClick={() => {
                  setOpen(false);
                  setChangelogOpen(true);
                }}
              />
              <ConfigMenuItem
                icon={<Keyboard size={15} />}
                label="Keyboard shortcuts"
                description="View shortcut lookup"
                onClick={() => {
                  setOpen(false);
                  setShortcutsOpen(true);
                }}
              />
              <ConfigMenuItem
                icon={<RefreshCw size={15} />}
                label="Reload page"
                description="Refresh the application"
                onClick={() => {
                  setOpen(false);
                  reloadApplicationPage();
                }}
              />
              <ConfigMenuItem
                icon={<Download size={15} />}
                label={
                  canInstallUpdate
                    ? s.updateInstalling
                      ? "Updating..."
                      : `Update to ${updateVersion}`
                    : updateAvailable
                      ? `Version ${updateVersion} available`
                      : "Check for updates"
                }
                description={
                  canInstallUpdate
                    ? "Install and restart"
                    : updateAvailable
                      ? "Automatic install unavailable"
                      : "Check the release server"
                }
                primary={canInstallUpdate}
                onClick={() => {
                  setOpen(false);
                  void store.updateOrCheck();
                }}
                disabled={s.updateInstalling}
              />
            </div>

            <div className="config-section">
              <div className="config-title">Runtime</div>
              <div className="config-runtime-row">
                <span className="config-item-icon">
                  <Server size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>Herdr server</strong>
                  <span>
                    {herdrInfo?.version
                      ? `Version ${herdrInfo.version}`
                      : "Loading server information"}
                  </span>
                </div>
                <code>
                  {typeof herdrInfo?.protocol === "number"
                    ? `Protocol ${herdrInfo.protocol}`
                    : "-"}
                </code>
              </div>
              <button
                type="button"
                className="config-details-toggle"
                aria-expanded={connectionDetailsOpen}
                onClick={() => setConnectionDetailsOpen((value) => !value)}
              >
                <span className="config-item-icon">
                  <Wifi size={15} />
                </span>
                <span>Connection details</span>
                {connectionDetailsOpen ? (
                  <ChevronDown size={15} />
                ) : (
                  <ChevronRight size={15} />
                )}
              </button>
              {connectionDetailsOpen ? (
                <div className="config-details">
                  <ConfigRow label="URL" value={location.origin} />
                  <ConfigRow label="Socket" value={health?.socket ?? "-"} />
                </div>
              ) : null}
              <div className="config-inline-actions">
                <button
                  type="button"
                  className={s.connectionPaused ? "is-primary" : ""}
                  onClick={() => {
                    setOpen(false);
                    if (s.connectionPaused) {
                      store.resumeConnection();
                    } else {
                      store.pauseConnection();
                    }
                  }}
                >
                  {s.connectionPaused ? (
                    <Play size={14} />
                  ) : (
                    <Pause size={14} />
                  )}
                  {s.connectionPaused ? "Resume client" : "Pause client"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void store.pauseOtherClients();
                  }}
                  disabled={s.connectionPaused || otherClientCount === 0}
                >
                  <Users size={14} />
                  Pause others
                  {otherClientCount > 0 ? ` (${otherClientCount})` : ""}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <ChangelogDialog
        open={changelogOpen}
        onClose={() => setChangelogOpen(false)}
      />
      <ShortcutLookupDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <MobileTerminalShortcutsDialog
        open={mobileShortcutsOpen}
        rows={mobileTerminalShortcuts}
        sideShortcuts={mobileTerminalSideShortcuts}
        onChange={onMobileTerminalShortcutsChange}
        onSideChange={onMobileTerminalSideShortcutsChange}
        onClose={() => setMobileShortcutsOpen(false)}
      />
      <AutoSyncRepositoriesDialog
        open={autoSyncOpen}
        onClose={() => setAutoSyncOpen(false)}
      />
    </>
  );
}

function ConfigMenuItem({
  icon,
  label,
  description,
  onClick,
  disabled = false,
  primary = false,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`config-menu-item ${primary ? "is-primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="config-item-icon">{icon}</span>
      <span className="config-item-copy">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="config-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}

function taskNotificationStatus(
  enabled: boolean,
  permission: NotificationPermission | "unsupported",
) {
  if (permission === "unsupported") return "Unsupported";
  if (enabled && permission === "granted") return "On";
  if (permission === "denied") return "Blocked";
  return "Off";
}
