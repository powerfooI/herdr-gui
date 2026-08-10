import type { ServerWebSocket } from "bun";
import { HerdrClient } from "./bridge/herdr-client";
import { createAuthHandlers } from "./http/auth";
import { createImageUploadHandler } from "./http/image-upload";
import {
  runProcess,
  runProcessWithCode,
  runProcessWithCodeTimeout,
  shQuote,
} from "./utils/process-utils";
import { runBinaryProcessWithTimeout } from "./workspace/process";
import {
  browserUrlFor,
  getLanIPs,
  isAnyHost,
  loadServerConfig,
  openBrowser,
  withLoginToken,
} from "./config/server-config";
import { createSettingsRpcHandler } from "./bridge/settings-rpc";
import { serveStatic } from "./http/static-files";
import { createSshTunnelManager } from "./bridge/ssh-tunnel";
import { createTerminalBridge } from "./bridge/terminal-bridge";
import {
  createUpdateHandlers,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./http/update";
import { createHerdrInfoHandler } from "./http/herdr-info";
import {
  downloadAgentSessionAtif,
  downloadAgentSessionFile,
  readAgentMessageHistory,
  readAgentSessionSummary,
} from "./agent/agent-sessions";
import { createAgentSessionFileAccess } from "./agent/session-file-access";
import { createFileHandlers } from "./workspace/files";
import { createWorkspaceAutoSync } from "./workspace/auto-sync";
import { createStatusEnricher } from "./workspace/status";
import { createWorktreeHookRunner } from "./worktree/worktree-hooks";
import { syncWorktreeBase } from "./worktree/create";
import { createWorktreeParentStore } from "./worktree/parents";
import {
  createWorktreeRemovalCoordinator,
  createWorktreeRemovalRuntime,
  removeWorktreeWithRecovery,
  WORKTREE_REMOVE_TIMEOUT_MS,
} from "./worktree/remove";
import { runServiceCommand } from "./config/service-manager";
import packageJson from "../../package.json";

const APP_VERSION = packageJson.version;
const serviceCommandExitCode = runServiceCommand(process.argv.slice(2));
if (serviceCommandExitCode !== null) process.exit(serviceCommandExitCode);
const config = loadServerConfig(APP_VERSION);
const { isAuthed, handleTokenLogin, handleLogin, loginPage } =
  createAuthHandlers({
    authRequired: config.authRequired,
    password: config.password,
    urlLoginToken: config.generatedAuthToken,
  });

const DEFAULT_EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
];

function sshHost(): string | undefined {
  return config.sshHost;
}

interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

const WS_BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;

const socketPath = config.socketPath;
const clientSocketPath = config.clientSocketPath;
const herdr = new HerdrClient(socketPath);
const agentSessionFiles = createAgentSessionFileAccess({
  sshHost: config.sshHost,
  runBinaryProcessWithTimeout,
  shQuote,
});
const worktreeParents = createWorktreeParentStore({ herdr, sshHost });
const { handleUpdateCheck, handleUpdateInstall } = createUpdateHandlers({
  appVersion: APP_VERSION,
  runProcessWithCodeTimeout,
  shQuote,
});
const { handleHerdrInfo } = createHerdrInfoHandler({
  ping: () => herdr.ping(),
});
const {
  listWorkspaceFiles,
  resolveWorkspaceFiles,
  readWorkspaceFile,
  downloadWorkspaceFile,
  uploadWorkspaceFile,
  deleteWorkspaceFile,
  readGitDiffSummary,
  readGitDiffFile,
  runGitPull,
  resolveWorkspaceGitRoot,
} = createFileHandlers({
  herdr,
  sshHost,
  runProcessWithCodeTimeout,
  shQuote,
});
const { enrichWorkspacesWithGitStatus, invalidateGitStatus } =
  createStatusEnricher({
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
  });
const workspaceAutoSync = createWorkspaceAutoSync({
  herdr,
  sshHost,
  runProcessWithCodeTimeout,
  shQuote,
  invalidateGitStatus,
  resolveWorkspaceGitRoot: async (workspaceId) =>
    resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
});
const {
  readPaseoWorktreeHooks,
  runPaseoWorktreeHook,
  worktreeRemoveHookContext,
  runWorktreeRemovedHook,
  runWorktreeOpenedHook,
  sourceWorkspaceForWorktreeCreate,
  runWorktreeSetupHook,
} = createWorktreeHookRunner({
  herdr,
  sshHost,
  runProcess,
  runProcessWithCode,
  shQuote,
});
const worktreeRemovalCoordinator = createWorktreeRemovalCoordinator();
const worktreeRemovalRuntime = createWorktreeRemovalRuntime({
  host: sshHost(),
  runProcessWithCodeTimeout,
  shQuote,
});
const handleImageUpload = createImageUploadHandler({ sshHost });
const { startAutoSshTunnel, cleanupAutoSshTunnel } = createSshTunnelManager({
  config,
  runProcess,
});
const handleSettingsRpc = createSettingsRpcHandler({
  herdr,
  sshHost,
  readPaseoWorktreeHooks,
  resolveWorkspaceGitRoot: async (workspaceId) =>
    resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
  workspaceAutoSyncIsRunning: workspaceAutoSync.isRunning,
  onWorkspaceAutoSyncSettingsChanged: workspaceAutoSync.settingsChanged,
  safeSend,
  markRpcError,
});
process.on("exit", () => {
  workspaceAutoSync.stop();
  cleanupAutoSshTunnel();
});
process.on("SIGINT", () => {
  workspaceAutoSync.stop();
  cleanupAutoSshTunnel();
  process.exit(130);
});
process.on("SIGTERM", () => {
  workspaceAutoSync.stop();
  cleanupAutoSshTunnel();
  process.exit(143);
});
const clients = new Set<ServerWebSocket<unknown>>();
const clientIds = new WeakMap<ServerWebSocket<unknown>, number>();
let nextClientId = 1;

const rpcOutcomes = new Map<string, { status: "error"; detail?: string }>();

const IMPORTANT_RPC_METHODS = new Set([
  "bridge.pause_others",
  "agent_history.get",
  "agent_session.get",
  "file.read",
  "git.diff_file",
  "git.pull",
  "settings.update_repo",
  "settings.workspace_auto_sync.get",
  "settings.workspace_auto_sync.list",
  "settings.workspace_auto_sync.update",
  "settings.workspace_auto_sync.update_key",
  "settings.worktree_hooks.get",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
]);
const SLOW_RPC_LOG_MS = 750;

function clientLabel(ws: ServerWebSocket<unknown>): string {
  const id = clientIds.get(ws);
  return id ? `c${id}` : "unknown";
}

function assignClientId(ws: ServerWebSocket<unknown>): string {
  clientIds.set(ws, nextClientId++);
  return clientLabel(ws);
}

function logDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function parseRpcMeta(raw: string): { id: string | null; method: string | null } {
  try {
    const msg = JSON.parse(raw);
    return {
      id: typeof msg?.id === "string" ? msg.id : null,
      method: typeof msg?.method === "string" ? msg.method : null,
    };
  } catch {
    return { id: null, method: null };
  }
}

function rpcOutcomeKey(ws: ServerWebSocket<unknown>, id: string) {
  return `${clientLabel(ws)}\0${id}`;
}

function markRpcError(
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) {
  if (!id) return;
  rpcOutcomes.set(rpcOutcomeKey(ws, id), { status: "error", detail });
}

function takeRpcOutcome(ws: ServerWebSocket<unknown>, id: string | null) {
  if (!id) return null;
  const key = rpcOutcomeKey(ws, id);
  const outcome = rpcOutcomes.get(key) ?? null;
  rpcOutcomes.delete(key);
  return outcome;
}

function shouldLogRpc(method: string | null, elapsedMs: number, failed: boolean) {
  if (!method) return failed;
  if (failed) return true;
  if (method === "bridge.ping" || method === "bridge.status") return false;
  if (method === "terminal.input" || method === "terminal.scroll") return false;
  if (method === "terminal.resize" && elapsedMs < SLOW_RPC_LOG_MS) return false;
  return IMPORTANT_RPC_METHODS.has(method) || elapsedMs >= SLOW_RPC_LOG_MS;
}

function logRpc(
  ws: ServerWebSocket<unknown>,
  method: string | null,
  startedAt: number,
  status: "ok" | "error",
  detail?: string,
) {
  const elapsedMs = Date.now() - startedAt;
  const failed = status === "error";
  if (!shouldLogRpc(method, elapsedMs, failed)) return;
  const parts = [
    `[bridge] rpc ${status}`,
    `client=${clientLabel(ws)}`,
    `method=${method ?? "unknown"}`,
    `duration=${elapsedMs}ms`,
  ];
  if (detail) parts.push(`detail=${logDetail(detail)}`);
  console.log(parts.join(" "));
}

function summarizeHerdrEvent(event: any): string {
  const type = String(event?.event ?? event?.type ?? "unknown");
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const ids = [
    "workspace_id",
    "tab_id",
    "pane_id",
    "agent_id",
    "terminal_id",
  ]
    .map((key) => {
      const value = data[key] ?? event?.[key];
      return typeof value === "string" && value ? `${key}=${value}` : "";
    })
    .filter(Boolean);
  return [`type=${type}`, ...ids].join(" ");
}

const terminalBridge = createTerminalBridge({
  clientSocketPath,
  herdrProtocol: async () => Number((await herdr.ping()).protocol),
  safeSend,
  clientLabel,
  markRpcError,
  confirmRelayResize: async ({ cols, rows, paneId }) => {
    if (!paneId) return false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const result = await herdr.call("pane.layout", { pane_id: paneId });
        const area = result?.layout?.area;
        if (
          area &&
          Number(area.x) + Number(area.width) === cols &&
          Number(area.y) + Number(area.height) === rows
        ) {
          return true;
        }
      } catch {
        return false;
      }
      await Bun.sleep(50);
    }
    return false;
  },
});

function cleanupWs(ws: ServerWebSocket<unknown>) {
  clients.delete(ws);
  terminalBridge.cleanupWs(ws);
  terminalBridge.browserClientCountChanged(clients.size);
}

function safeSend(
  ws: ServerWebSocket<unknown>,
  payload: string,
  context = "message",
): boolean {
  const bufferedAmount = Number((ws as any).bufferedAmount ?? 0);
  if (Number.isFinite(bufferedAmount) && bufferedAmount > WS_BACKPRESSURE_LIMIT_BYTES) {
    console.warn(
      `[bridge] closing slow websocket during ${context}: ${bufferedAmount}B buffered`,
    );
    cleanupWs(ws);
    try {
      ws.close(1013, "client too slow");
    } catch {}
    return false;
  }
  try {
    const result = ws.send(payload);
    if (result === -1) {
      cleanupWs(ws);
      try {
        ws.close();
      } catch {}
      return false;
    }
    return true;
  } catch (e) {
    cleanupWs(ws);
    console.warn(
      `[bridge] websocket send failed during ${context}: ${(e as Error).message}`,
    );
    try {
      ws.close();
    } catch {}
    return false;
  }
}

// Broadcast pushed Herdr events to every connected browser.
herdr.on("event", (e) => {
  console.log("[bridge] herdr event", summarizeHerdrEvent(e));
  const line = JSON.stringify({ event: e });
  for (const ws of clients) {
    safeSend(ws, line, "event");
  }
});
herdr.on("error", (e) => console.error("[herdr]", (e as Error).message ?? e));

/**
 * Keep a long-lived `events.subscribe` connection open while the Herdr server
 * is reachable. If the server isn't up yet (or goes away), retry with backoff
 * so events start flowing automatically once it appears.
 */
function startSubscriptionLoop() {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const sub = herdr.subscribe(DEFAULT_EVENTS);
      try {
        await sub.ready;
      } catch (e) {
        console.error(
          "[bridge] subscribe failed:",
          (e as Error).message,
          "- retrying in 2s",
        );
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.log("[bridge] subscribed to herdr events");
      await new Promise<void>((res) =>
        herdr.once("subscription_closed", () => res()),
      );
      console.log("[bridge] subscription closed, reconnecting in 2s...");
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  loop();
  return () => {
    stopped = true;
  };
}

async function handleRpc(ws: ServerWebSocket<unknown>, raw: string) {
  let req: RpcRequest;
  try {
    req = JSON.parse(raw);
  } catch {
    safeSend(ws, JSON.stringify({ error: { message: "bad json" } }), "bad-json");
    return;
  }
  const { id, method, params } = req;
  if (!id || !method) {
    markRpcError(ws, id, "missing id/method");
    safeSend(
      ws,
      JSON.stringify({ id, error: { message: "missing id/method" } }),
      "missing-id-method",
    );
    return;
  }
  const sendError = (context: string, error: unknown) => {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    safeSend(
      ws,
      JSON.stringify({ id, error: { message } }),
      context,
    );
  };
  if (method === "bridge.ping") {
    safeSend(ws, JSON.stringify({ id, result: { ok: true } }), "bridge-ping");
    return;
  }
  if (method === "bridge.status") {
    safeSend(
      ws,
      JSON.stringify({
        id,
        result: {
          clients: clients.size,
          terminals: terminalBridge.statusTerminals(),
        },
      }),
      "bridge-status",
    );
    return;
  }
  if (method === "bridge.pause_others") {
    const targets = Array.from(clients).filter((client) => client !== ws);
    let pausedClients = 0;
    for (const client of targets) {
      const ok = safeSend(
        client,
        JSON.stringify({
          control: {
            type: "pause_connection",
            reason:
              "Another herdr-gui client paused this connection. Resume when you want this browser to sync again.",
          },
        }),
        "pause-other-client",
      );
      if (ok) pausedClients += 1;
    }
    safeSend(
      ws,
      JSON.stringify({
        id,
        result: {
          ok: true,
          paused_clients: pausedClients,
          clients: clients.size,
        },
      }),
      "bridge-pause-others",
    );
    return;
  }
  if (method === "agent_history.get") {
    try {
      const result = await readAgentMessageHistory(params ?? {}, (name, callParams) =>
        herdr.call(name, callParams),
        agentSessionFiles,
      );
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "agent-history-get",
      );
    } catch (e) {
      sendError("agent-history-get-error", e);
    }
    return;
  }
  if (method === "agent_session.get") {
    try {
      const result = await readAgentSessionSummary(params ?? {}, (name, callParams) =>
        herdr.call(name, callParams),
        agentSessionFiles,
      );
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "agent-session-get",
      );
    } catch (e) {
      sendError("agent-session-get-error", e);
    }
    return;
  }
  if (method === "file.list") {
    try {
      const result = await listWorkspaceFiles(params ?? {});
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "file-list",
      );
    } catch (e) {
      sendError("file-list-error", e);
    }
    return;
  }
  if (method === "file.resolve") {
    try {
      const result = await resolveWorkspaceFiles(params ?? {});
      safeSend(ws, JSON.stringify({ id, result }), "file-resolve");
    } catch (e) {
      sendError("file-resolve-error", e);
    }
    return;
  }
  if (method === "file.read") {
    try {
      const result = await readWorkspaceFile(params ?? {});
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "file-read",
      );
    } catch (e) {
      sendError("file-read-error", e);
    }
    return;
  }
  if (method === "git.diff_summary") {
    try {
      const result = await readGitDiffSummary(params ?? {});
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "git-diff-summary",
      );
    } catch (e) {
      sendError("git-diff-summary-error", e);
    }
    return;
  }
  if (method === "git.diff_file") {
    try {
      const result = await readGitDiffFile(params ?? {});
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "git-diff-file",
      );
    } catch (e) {
      sendError("git-diff-file-error", e);
    }
    return;
  }
  if (method === "git.pull") {
    try {
      const result = await runGitPull(params ?? {});
      invalidateGitStatus(result.root);
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "git-pull",
      );
    } catch (e) {
      sendError("git-pull-error", e);
    }
    return;
  }
  if (method.startsWith("terminal.")) {
    return terminalBridge.handleTerminalRpc(ws, id, method, params ?? {});
  }
  if (method.startsWith("settings.")) {
    return handleSettingsRpc(ws, id, method, params ?? {});
  }
  if (method === "worktree.create") {
    try {
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const workspaceId = String(params?.workspace_id ?? "");
      const baseSync = await syncWorktreeBase({
        workspaceId,
        resolveGitRoot: async (id) =>
          resolveWorkspaceGitRoot({ workspace_id: id }),
        host: sshHost(),
        shQuote,
        runProcessWithCodeTimeout,
      });
      const result = await herdr.call(method, {
        ...(params ?? {}),
        base: baseSync.base,
      });
      // Herdr identifies the repository but not which of several workspaces
      // for that repository initiated creation. Keep that GUI relationship.
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId)
        .catch((error) =>
          console.warn(
            `[bridge] unable to persist worktree parent: ${(error as Error).message}`,
          ),
        );
      const hookSourceWorkspace = sourceWorkspace
        ? {
            ...sourceWorkspace,
            cwd:
              sourceWorkspace?.worktree?.checkout_path ||
              sourceWorkspace?.cwd ||
              baseSync.root,
          }
        : { cwd: baseSync.root };
      const setupHook = await runWorktreeSetupHook(
        result,
        hookSourceWorkspace,
      );
      safeSend(
        ws,
        JSON.stringify({
          id,
          result: {
            ...result,
            base_sync: baseSync,
            setup_hook: setupHook,
          },
        }),
        "worktree-create",
      );
    } catch (e) {
      sendError("worktree-create-error", e);
    }
    return;
  }
  if (method === "worktree.open") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const result = await herdr.call(method, params ?? {});
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId)
        .catch((error) =>
          console.warn(
            `[bridge] unable to persist opened worktree parent: ${(error as Error).message}`,
          ),
        );
      const openedHook = await runWorktreeOpenedHook(result, sourceWorkspace);
      safeSend(
        ws,
        JSON.stringify({
          id,
          result: { ...result, opened_hook: openedHook },
        }),
        "worktree-open",
      );
    } catch (e) {
      sendError("worktree-open-error", e);
    }
    return;
  }
  if (method === "worktree.remove") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const result = await worktreeRemovalCoordinator.run(
        workspaceId,
        async () => {
          const removeHookContext = await worktreeRemoveHookContext(params ?? {});
          const checkoutState = removeHookContext
            ? await worktreeRemovalRuntime
                .inspectCheckout(removeHookContext.checkoutPath)
                .catch(() => "unknown" as const)
            : "unknown";
          const beforeRemoveHook =
            removeHookContext && checkoutState !== "missing"
              ? await runPaseoWorktreeHook({
                  hook: "teardown",
                  checkoutPath: removeHookContext.checkoutPath,
                  sourceCheckoutPath: removeHookContext.sourceCheckoutPath,
                  repoSettingsKey: removeHookContext.repoSettingsKey,
                })
              : ({ event: "worktree.before_remove", status: "skipped" } as const);
          if (beforeRemoveHook.status === "failed") {
            markRpcError(
              ws,
              id,
              beforeRemoveHook.error || "before-remove hook failed",
            );
            return {
              ok: false,
              skipped_remove: true,
              before_remove_hook: beforeRemoveHook,
            };
          }

          const removal = await removeWorktreeWithRecovery({
            call: (name, callParams) =>
              herdr.call(name, callParams, WORKTREE_REMOVE_TIMEOUT_MS),
            params: params ?? {},
            checkoutPath: removeHookContext?.checkoutPath,
            runtime: worktreeRemovalRuntime,
          });
          if (removal.cleanup?.preserved_path) {
            console.warn(
              `[bridge] preserved stale worktree files at ${removal.cleanup.preserved_path}`,
            );
          }
          if (removeHookContext?.checkoutPath) {
            await worktreeParents
              .forgetWorktree(removeHookContext.checkoutPath)
              .catch((error) =>
                console.warn(
                  `[bridge] unable to remove worktree parent: ${(error as Error).message}`,
                ),
              );
          }
          const removedHook = await runWorktreeRemovedHook(removeHookContext);
          return {
            ...removal.result,
            ...(removal.cleanup ? { cleanup: removal.cleanup } : {}),
            before_remove_hook: beforeRemoveHook,
            removed_hook: removedHook,
          };
        },
      );
      safeSend(
        ws,
        JSON.stringify({ id, result }),
        "worktree-remove",
      );
    } catch (e) {
      sendError("worktree-remove-error", e);
    }
    return;
  }
  try {
    const rawResult = await herdr.call(method, params ?? {});
    let result = rawResult;
    if (method === "workspace.list") {
      result = await worktreeParents.enrichWorkspaceList(result);
      result = await enrichWorkspacesWithGitStatus(result);
    }
    safeSend(ws, JSON.stringify({ id, result }), method);
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

async function main() {
  await startAutoSshTunnel();
  Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(req, server) {
      const url = new URL(req.url);

      const tokenLoginResponse = handleTokenLogin(req);
      if (tokenLoginResponse) return tokenLoginResponse;

      if (url.pathname === "/health" || url.pathname === "/healthz") {
        return new Response("Ok", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      // Auth endpoints are always reachable.
      if (url.pathname === "/api/login" && req.method === "POST") {
        return handleLogin(req);
      }
      if (url.pathname === "/login") {
        return loginPage();
      }

      // Everything else requires auth when bound to a non-localhost address.
      if (!isAuthed(req)) {
        const accept = req.headers.get("accept") ?? "";
        if (req.method === "GET" && accept.includes("text/html")) {
          return Response.redirect(new URL("/login", req.url).toString(), 302);
        }
        return new Response("unauthorized", { status: 401 });
      }

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/health") {
        return Response.json({
          ok: true,
          version: APP_VERSION,
          socket: socketPath,
        });
      }
      if (url.pathname === "/api/update/check" && req.method === "GET") {
        server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
        return handleUpdateCheck(req);
      }
      if (url.pathname === "/api/update/install" && req.method === "POST") {
        // Binary download and verification can exceed Bun's default ten-second
        // request timeout. Keep the larger budget scoped to update requests.
        server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
        return handleUpdateInstall(req);
      }
      if (url.pathname === "/api/herdr-info" && req.method === "GET") {
        return handleHerdrInfo();
      }
      if (url.pathname === "/api/upload-image" && req.method === "POST") {
        return handleImageUpload(req);
      }
      if (url.pathname === "/api/agent-session/download" && req.method === "GET") {
        return downloadAgentSessionFile(
          {
            pane_id: url.searchParams.get("pane_id"),
            agent: url.searchParams.get("agent"),
          },
          (name, callParams) => herdr.call(name, callParams),
          agentSessionFiles,
        );
      }
      if (url.pathname === "/api/agent-session/atif" && req.method === "GET") {
        return downloadAgentSessionAtif(
          {
            pane_id: url.searchParams.get("pane_id"),
            agent: url.searchParams.get("agent"),
          },
          (name, callParams) => herdr.call(name, callParams),
          agentSessionFiles,
        );
      }
      if (url.pathname === "/api/file/download" && req.method === "GET") {
        try {
          return await downloadWorkspaceFile({
            workspace_id: url.searchParams.get("workspace_id"),
            path: url.searchParams.get("path"),
          });
        } catch (e) {
          return new Response((e as Error).message, { status: 400 });
        }
      }
      if (url.pathname === "/api/file/upload" && req.method === "POST") {
        try {
          const result = await uploadWorkspaceFile(
            {
              workspace_id: url.searchParams.get("workspace_id"),
              directory: url.searchParams.get("directory"),
              filename: url.searchParams.get("filename"),
            },
            req,
          );
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      }
      if (url.pathname === "/api/file/delete" && req.method === "POST") {
        try {
          const result = await deleteWorkspaceFile({
            workspace_id: url.searchParams.get("workspace_id"),
            path: url.searchParams.get("path"),
          });
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      }
      // Everything else: serve the built frontend (embedded or on-disk).
      return serveStatic(req, config.publicDir);
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        const label = assignClientId(ws);
        console.log(
          "[bridge] client connected",
          `client=${label}`,
          `clients=${clients.size}`,
        );
        terminalBridge.browserClientCountChanged(clients.size);
        safeSend(ws, JSON.stringify({ hello: true, socket: socketPath }), "hello");
      },
      message(ws, message) {
        const text = typeof message === "string" ? message : message.toString();
        const { id, method } = parseRpcMeta(text);
        const startedAt = Date.now();
        handleRpc(ws, text)
          .then(() => {
            const outcome = takeRpcOutcome(ws, id);
            logRpc(
              ws,
              method,
              startedAt,
              outcome?.status ?? "ok",
              outcome?.detail,
            );
          })
          .catch((e) => {
            logRpc(ws, method, startedAt, "error", (e as Error).message);
            safeSend(
              ws,
              JSON.stringify({ error: { message: (e as Error).message } }),
              "message-error",
            );
          });
      },
      close(ws) {
        const viewed = terminalBridge.viewedTerminals(ws);
        console.log(
          "[bridge] client disconnected",
          `client=${clientLabel(ws)}`,
          `clients=${Math.max(0, clients.size - 1)}`,
          viewed.length ? `terminals=${viewed.join(",")}` : "terminals=none",
        );
        cleanupWs(ws);
      },
    },
  });
  // Start background Git work only after the HTTP listener is bound. A failed
  // startup must never mutate repositories as a side effect.
  workspaceAutoSync.start();
  console.log(`[bridge] listening on http://${config.host}:${config.port}  (ws /ws)`);
  if (config.authRequired) {
    if (config.generatedAuthTokenPath) {
      console.log(
        `[bridge] auth required (generated token stored at ${config.generatedAuthTokenPath})`,
      );
    } else {
      console.log("[bridge] auth required (password login enabled)");
    }
  }
  console.log(`[bridge] herdr socket: ${socketPath}`);
  console.log(`[bridge] herdr client socket: ${clientSocketPath}`);
  console.log(`[bridge] public dir: ${config.publicDir}`);

  const browserUrl = withLoginToken(
    browserUrlFor(config.host, config.port),
    config.generatedAuthToken,
  );
  console.log(`[bridge] browser URL: ${browserUrl}`);
  if (isAnyHost(config.host)) {
    const lanUrls = getLanIPs().map((ip) =>
      withLoginToken(
        `http://${ip}:${config.port}`,
        config.generatedAuthToken,
      ),
    );
    if (lanUrls.length > 0) {
      console.log("[bridge] accessible from your LAN at:");
      for (const url of lanUrls) console.log(`[bridge]   ${url}`);
    } else {
      console.log(
        `[bridge] listening on all interfaces; no LAN IPv4 address was detected.`,
      );
    }
  }
  openBrowser(config, browserUrl);

  // Best-effort: verify connectivity and start the event fan-out.
  herdr
    .ping()
    .then((p) =>
      console.log(
        `[bridge] herdr ${p.version} (protocol ${p.protocol}) reachable`,
      ),
    )
    .catch((e) =>
      console.error(
        `[bridge] herdr not reachable yet (${(e as Error).message}); ` +
          `start a server with \`herdr server\`. RPCs will retry per request.`,
      ),
    );
  startSubscriptionLoop();
}

main().catch((e) => {
  console.error(`[bridge] FATAL: ${(e as Error).message}`);
  workspaceAutoSync.stop();
  cleanupAutoSshTunnel();
  process.exit(1);
});
