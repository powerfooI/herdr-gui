import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import { sourceCheckoutPath as workspaceSourceCheckoutPath } from "../workspace/utils";

export type GuiRepoSettings = {
  worktree_hooks_enabled?: boolean;
  custom?: Record<string, unknown>;
};

export type WorkspaceAutoSyncStatus =
  | "updated"
  | "up_to_date"
  | "skipped"
  | "failed";

export type GuiWorkspaceAutoSyncSettings = {
  enabled: boolean;
  interval_minutes: number;
  checkout_path?: string;
  host?: string;
  last_run_at?: string;
  last_status?: WorkspaceAutoSyncStatus;
  last_message?: string;
  last_branch?: string;
};

export type GuiSettings = {
  version: 1;
  repositories: Record<string, GuiRepoSettings>;
  workspace_auto_sync: Record<string, GuiWorkspaceAutoSyncSettings>;
  custom: Record<string, unknown>;
};

export const DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES = 10;

let cachedGuiSettings: GuiSettings | null = null;
let settingsMutationQueue: Promise<void> = Promise.resolve();
let temporaryFileSequence = 0;

export function guiSettingsPath(): string {
  return join(homedir(), ".config", "herdr-gui", "settings.json");
}

function defaultGuiSettings(): GuiSettings {
  return {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {},
  };
}

function normalizeGuiSettings(raw: unknown): GuiSettings {
  const obj = raw && typeof raw === "object" ? (raw as any) : {};
  const repositories =
    obj.repositories && typeof obj.repositories === "object"
      ? obj.repositories
      : {};
  const normalizedRepos: Record<string, GuiRepoSettings> = {};
  for (const [key, value] of Object.entries(repositories)) {
    if (!value || typeof value !== "object") continue;
    const repo = value as any;
    normalizedRepos[key] = {
      worktree_hooks_enabled:
        typeof repo.worktree_hooks_enabled === "boolean"
          ? repo.worktree_hooks_enabled
          : undefined,
      custom:
        repo.custom && typeof repo.custom === "object"
          ? (repo.custom as Record<string, unknown>)
          : undefined,
    };
  }
  const workspaceAutoSync =
    obj.workspace_auto_sync && typeof obj.workspace_auto_sync === "object"
      ? obj.workspace_auto_sync
      : {};
  const normalizedWorkspaceAutoSync: Record<
    string,
    GuiWorkspaceAutoSyncSettings
  > = {};
  for (const [key, value] of Object.entries(workspaceAutoSync)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as any;
    const lastStatus = ["updated", "up_to_date", "skipped", "failed"].includes(
      entry.last_status,
    )
      ? (entry.last_status as WorkspaceAutoSyncStatus)
      : undefined;
    normalizedWorkspaceAutoSync[key] = {
      enabled: entry.enabled === true,
      interval_minutes:
        typeof entry.interval_minutes === "number" &&
        Number.isFinite(entry.interval_minutes) &&
        entry.interval_minutes >= 1
          ? Math.round(entry.interval_minutes)
          : DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
      checkout_path:
        typeof entry.checkout_path === "string"
          ? entry.checkout_path
          : undefined,
      host: typeof entry.host === "string" ? entry.host : undefined,
      last_run_at:
        typeof entry.last_run_at === "string" ? entry.last_run_at : undefined,
      last_status: lastStatus,
      last_message:
        typeof entry.last_message === "string" ? entry.last_message : undefined,
      last_branch:
        typeof entry.last_branch === "string" ? entry.last_branch : undefined,
    };
  }
  return {
    version: 1,
    repositories: normalizedRepos,
    workspace_auto_sync: normalizedWorkspaceAutoSync,
    custom:
      obj.custom && typeof obj.custom === "object"
        ? (obj.custom as Record<string, unknown>)
        : {},
  };
}

export async function readGuiSettings(): Promise<GuiSettings> {
  if (cachedGuiSettings) return cachedGuiSettings;
  const file = Bun.file(guiSettingsPath());
  if (!(await file.exists())) {
    cachedGuiSettings = defaultGuiSettings();
    return cachedGuiSettings;
  }
  try {
    cachedGuiSettings = normalizeGuiSettings(JSON.parse(await file.text()));
  } catch (e) {
    console.warn(
      `[bridge] ignoring invalid herdr-gui settings: ${(e as Error).message}`,
    );
    cachedGuiSettings = defaultGuiSettings();
  }
  return cachedGuiSettings;
}

async function persistGuiSettings(
  settings: GuiSettings,
  shouldCommit: () => boolean,
): Promise<GuiSettings> {
  const path = guiSettingsPath();
  const temporaryPath = `${path}.${process.pid}.${++temporaryFileSequence}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  const normalized = normalizeGuiSettings(settings);
  try {
    if (!shouldCommit()) throw new Error("settings update cancelled");
    await Bun.write(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`);
    if (!shouldCommit()) throw new Error("settings update cancelled");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  cachedGuiSettings = normalized;
  return normalized;
}

function enqueueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsMutationQueue.then(operation);
  settingsMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Read and persist under one queue slot so background status updates cannot
// overwrite a toggle changed by an RPC that completed at the same time.
export function updateGuiSettings(
  update: (current: GuiSettings) => GuiSettings | Promise<GuiSettings>,
  shouldCommit: () => boolean = () => true,
): Promise<GuiSettings> {
  return enqueueSettingsMutation(async () => {
    const current = await readGuiSettings();
    if (!shouldCommit()) throw new Error("settings update cancelled");
    const next = await update(current);
    if (!shouldCommit()) throw new Error("settings update cancelled");
    return persistGuiSettings(next, shouldCommit);
  });
}

export function connectionSettingsPrefix(connectionId?: string | null): string {
  return connectionId && connectionId !== LEGACY_DEFAULT_CONNECTION_ID
    ? `connection:${encodeURIComponent(connectionId)}:`
    : "";
}

export function repoSettingsKey(
  rawRepoKey: string,
  host?: string | null,
  connectionId?: string | null,
): string {
  return `${connectionSettingsPrefix(connectionId)}${host ? `ssh:${host}` : "local"}:${rawRepoKey}`;
}

export function workspaceRepoSettingsKey(
  workspace: any,
  host?: string | null,
  connectionId?: string | null,
): string | null {
  const raw =
    (typeof workspace?.worktree?.repo_key === "string" &&
      workspace.worktree.repo_key) ||
    (typeof workspace?.worktree?.repo_root === "string" &&
      workspace.worktree.repo_root) ||
    workspaceSourceCheckoutPath(workspace);
  return raw ? repoSettingsKey(raw, host, connectionId) : null;
}

export function workspaceAutoSyncSettingsKey(
  checkoutPath: string,
  host?: string | null,
  connectionId?: string | null,
): string | null {
  const path = checkoutPath.trim();
  return path ? repoSettingsKey(path, host, connectionId) : null;
}

export async function repoWorktreeHooksEnabled(
  repoKey?: string | null,
): Promise<boolean> {
  if (!repoKey) return true;
  const settings = await readGuiSettings();
  return settings.repositories[repoKey]?.worktree_hooks_enabled !== false;
}
