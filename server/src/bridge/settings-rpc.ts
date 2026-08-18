import type { ServerWebSocket } from "bun";
import type { HerdrClient } from "./herdr-client";
import {
  DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
  type GuiRepoSettings,
  guiSettingsPath,
  readGuiSettings,
  repoWorktreeHooksEnabled,
  updateGuiSettings,
  workspaceAutoSyncSettingsKey,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";
import {
  checkoutPath as workspaceCheckoutPath,
  sourceCheckoutPath as workspaceSourceCheckoutPath,
} from "../workspace/utils";

type ReadPaseoWorktreeHooks = (
  checkoutPath: string,
  sourceCheckoutPath?: string,
) => Promise<{
  path: string;
  config: {
    setup?: string;
    opened?: string;
    teardown?: string;
    removed?: string;
  };
} | null>;

export function createSettingsRpcHandler(args: {
  herdr: HerdrClient;
  sshHost: () => string | undefined;
  readPaseoWorktreeHooks: ReadPaseoWorktreeHooks;
  resolveWorkspaceGitRoot: (workspaceId: string) => Promise<{
    workspace: any;
    root: string;
  }>;
  workspaceAutoSyncIsRunning: (key: string) => boolean;
  onWorkspaceAutoSyncSettingsChanged: (key: string, enabled: boolean) => void;
  safeSend: (
    ws: ServerWebSocket<unknown>,
    payload: string,
    context?: string,
  ) => boolean;
  markRpcError: (
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) => void;
}) {
  function repoSettingsKey(workspace: any): string | null {
    return workspaceRepoSettingsKey(workspace, args.sshHost());
  }

  return async function handleSettingsRpc(
    ws: ServerWebSocket<unknown>,
    id: string,
    method: string,
    params: Record<string, unknown>,
  ) {
    const reply = (result: unknown) =>
      args.safeSend(ws, JSON.stringify({ id, result }), method);
    const fail = (message: string) => {
      args.markRpcError(ws, id, message);
      return args.safeSend(
        ws,
        JSON.stringify({ id, error: { message } }),
        `${method}-error`,
      );
    };
    try {
      if (method === "settings.get") {
        const settings = await readGuiSettings();
        return reply({ settings, path: guiSettingsPath() });
      }
      if (method === "settings.worktree_hooks.get") {
        const workspaceId = String(params.workspace_id ?? "");
        if (!workspaceId) {
          return fail("settings.worktree_hooks.get requires workspace_id");
        }
        const workspaceResult = await args.herdr.call("workspace.get", {
          workspace_id: workspaceId,
        });
        const workspace = workspaceResult?.workspace;
        if (!workspace?.worktree) {
          return reply({
            workspace_id: workspaceId,
            key: null,
            enabled: true,
            hooks: {},
            paseo_path: null,
            error: "workspace has no worktree metadata",
          });
        }
        const key = repoSettingsKey(workspace);
        const checkoutPath = workspaceCheckoutPath(workspace);
        const sourceCheckoutPath = workspaceSourceCheckoutPath(workspace);
        let paseo: Awaited<ReturnType<ReadPaseoWorktreeHooks>> = null;
        let readError: string | undefined;
        try {
          paseo = await args.readPaseoWorktreeHooks(
            checkoutPath,
            sourceCheckoutPath,
          );
        } catch (e) {
          readError = (e as Error).message;
        }
        return reply({
          workspace_id: workspaceId,
          key,
          enabled: await repoWorktreeHooksEnabled(key),
          repo_name: workspace.worktree.repo_name,
          repo_root: workspace.worktree.repo_root,
          checkout_path: checkoutPath,
          source_checkout_path: sourceCheckoutPath,
          paseo_path: paseo?.path ?? null,
          hooks: paseo?.config ?? {},
          error: readError,
        });
      }
      if (method === "settings.workspace_auto_sync.get") {
        const workspaceId = String(params.workspace_id ?? "");
        if (!workspaceId) {
          return fail("settings.workspace_auto_sync.get requires workspace_id");
        }
        const { workspace, root } =
          await args.resolveWorkspaceGitRoot(workspaceId);
        const key = workspaceAutoSyncSettingsKey(root, args.sshHost());
        if (!key) {
          return fail("workspace has no checkout path");
        }
        const settings = await readGuiSettings();
        const entry = settings.workspace_auto_sync[key];
        return reply({
          workspace_id: workspaceId,
          workspace_label: workspace?.label,
          checkout_path: root,
          key,
          enabled: entry?.enabled === true,
          interval_minutes:
            entry?.interval_minutes ??
            DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
          last_run_at: entry?.last_run_at,
          last_status: entry?.last_status,
          last_message: entry?.last_message,
          last_branch: entry?.last_branch,
          running: args.workspaceAutoSyncIsRunning(key),
        });
      }
      if (method === "settings.workspace_auto_sync.list") {
        const settings = await readGuiSettings();
        return reply({
          configs: Object.entries(settings.workspace_auto_sync)
            .map(([key, entry]) => ({
              key,
              ...entry,
              running: args.workspaceAutoSyncIsRunning(key),
            }))
            .sort((a, b) => a.key.localeCompare(b.key)),
          path: guiSettingsPath(),
        });
      }
      if (method === "settings.workspace_auto_sync.update_key") {
        const key = String(params.key ?? "");
        if (!key) {
          return fail("settings.workspace_auto_sync.update_key requires key");
        }
        if (typeof params.enabled !== "boolean") {
          return fail(
            "settings.workspace_auto_sync.update_key requires enabled",
          );
        }
        const enabled = params.enabled;
        const updated = await updateGuiSettings((current) => {
          const existing = current.workspace_auto_sync[key];
          if (!existing) {
            throw new Error(`unknown workspace auto-sync config: ${key}`);
          }
          const entry = { ...existing, enabled };
          return {
            ...current,
            workspace_auto_sync: {
              ...current.workspace_auto_sync,
              [key]: entry,
            },
          };
        });
        const entry = updated.workspace_auto_sync[key];
        args.onWorkspaceAutoSyncSettingsChanged(key, enabled);
        return reply({ key, ...entry });
      }
      if (method === "settings.workspace_auto_sync.update") {
        const workspaceId = String(params.workspace_id ?? "");
        if (!workspaceId) {
          return fail(
            "settings.workspace_auto_sync.update requires workspace_id",
          );
        }
        if (typeof params.enabled !== "boolean") {
          return fail("settings.workspace_auto_sync.update requires enabled");
        }
        const enabled = params.enabled;
        const { workspace, root } =
          await args.resolveWorkspaceGitRoot(workspaceId);
        const key = workspaceAutoSyncSettingsKey(root, args.sshHost());
        if (!key) {
          return fail("workspace has no checkout path");
        }
        const updated = await updateGuiSettings((current) => {
          const existing = current.workspace_auto_sync[key];
          const entry = {
            enabled,
            interval_minutes:
              existing?.interval_minutes ??
              DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES,
            checkout_path: root,
            host: args.sshHost(),
            last_run_at: existing?.last_run_at,
            last_status: existing?.last_status,
            last_message: existing?.last_message,
            last_branch: existing?.last_branch,
          };
          return {
            ...current,
            workspace_auto_sync: {
              ...current.workspace_auto_sync,
              [key]: entry,
            },
          };
        });
        const entry = updated.workspace_auto_sync[key];
        args.onWorkspaceAutoSyncSettingsChanged(key, enabled);
        return reply({
          workspace_id: workspaceId,
          workspace_label: workspace?.label,
          key,
          ...entry,
          running: args.workspaceAutoSyncIsRunning(key),
        });
      }
      if (method === "settings.update_repo") {
        const key = String(params.key ?? "");
        if (!key) return fail("settings.update_repo requires key");
        const patch =
          params.settings && typeof params.settings === "object"
            ? (params.settings as Partial<GuiRepoSettings>)
            : {};
        const settings = await updateGuiSettings((current) => {
          const existing = current.repositories[key] ?? {};
          const next: GuiRepoSettings = { ...existing };
          if (typeof patch.worktree_hooks_enabled === "boolean") {
            next.worktree_hooks_enabled = patch.worktree_hooks_enabled;
          }
          if (patch.custom && typeof patch.custom === "object") {
            next.custom = { ...(existing.custom ?? {}), ...patch.custom };
          }
          return {
            ...current,
            repositories: {
              ...current.repositories,
              [key]: next,
            },
          };
        });
        const next = settings.repositories[key];
        return reply({ settings, repo: next, key });
      }
      return fail(`unknown settings method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}
