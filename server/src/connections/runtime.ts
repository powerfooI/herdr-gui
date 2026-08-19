import type { ServerWebSocket } from "bun";
import { createAgentSessionHandlers } from "../agent/agent-sessions";
import { createAgentSessionFileAccess } from "../agent/session-file-access";
import { HerdrClient } from "../bridge/herdr-client";
import { createSettingsRpcHandler } from "../bridge/settings-rpc";
import {
  createSshTunnelManager,
  type SshTunnelConfig,
  type SshTunnelError,
} from "../bridge/ssh-tunnel";
import { createTerminalBridge } from "../bridge/terminal-bridge";
import { createHerdrInfoHandler } from "../http/herdr-info";
import { createImageUploadHandler } from "../http/image-upload";
import {
  runProcess,
  runProcessWithCode,
  runProcessWithCodeTimeout,
  shQuote,
} from "../utils/process-utils";
import { createWorkspaceAutoSync } from "../workspace/auto-sync";
import { createFileHandlers } from "../workspace/files";
import { runBinaryProcessWithTimeout } from "../workspace/process";
import { createStatusEnricher } from "../workspace/status";
import { createWorktreeHookRunner } from "../worktree/worktree-hooks";
import { createWorktreeParentStore } from "../worktree/parents";
import {
  createWorktreeRemovalCoordinator,
  createWorktreeRemovalRuntime,
} from "../worktree/remove";
import { sanitizeConnectionError } from "./manager";
import { createEventSubscriptionLoop } from "./subscription-loop";
import { type ConnectionIdentity, LEGACY_DEFAULT_CONNECTION } from "./types";

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

type SafeSend = (
  ws: ServerWebSocket<unknown>,
  payload: string,
  context?: string,
) => boolean;

type MarkRpcError = (
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) => void;

export function createLegacyConnectionRuntime(args: {
  identity?: ConnectionIdentity;
  connectionGeneration?: number;
  config: SshTunnelConfig;
  safeSend: SafeSend;
  clientLabel: (ws: ServerWebSocket<unknown>) => string;
  markRpcError: MarkRpcError;
  onEvent: (event: unknown, identity: ConnectionIdentity) => void;
  onError?: (error: unknown, identity: ConnectionIdentity) => void;
  onTransportExit?: (error: SshTunnelError) => void;
}) {
  const { config } = args;
  const identity = { ...(args.identity ?? LEGACY_DEFAULT_CONNECTION) };
  const socketPath = config.socketPath;
  const clientSocketPath = config.clientSocketPath;
  const sshHost = () => config.sshHost;
  const herdr = new HerdrClient(socketPath);
  const agentSessionFiles = createAgentSessionFileAccess({
    sshHost: config.sshHost,
    runBinaryProcessWithTimeout,
    shQuote,
  });
  const agentSessions = createAgentSessionHandlers({
    herdrCall: (method, params) => herdr.call(method, params),
    files: agentSessionFiles,
  });
  const worktreeParents = createWorktreeParentStore({
    connectionId: identity.id,
    herdr,
    sshHost,
  });
  const { handleHerdrInfo } = createHerdrInfoHandler({
    ping: () => herdr.ping(),
  });
  const files = createFileHandlers({
    herdr,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
  });
  const status = createStatusEnricher({
    connectionId: identity.id,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
  });
  const workspaceAutoSync = createWorkspaceAutoSync({
    connectionId: identity.id,
    formatError: sanitizeConnectionError,
    herdr,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
    invalidateGitStatus: status.invalidateGitStatus,
    resolveWorkspaceGitRoot: async (workspaceId) =>
      files.resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
  });
  const worktreeHooks = createWorktreeHookRunner({
    connectionId: identity.id,
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
  const sshTunnel = createSshTunnelManager({
    connectionId: identity.id,
    formatError: sanitizeConnectionError,
    config,
    runProcess,
    onUnexpectedExit: args.onTransportExit,
  });
  const handleSettingsRpc = createSettingsRpcHandler({
    connectionId: identity.id,
    connectionGeneration: args.connectionGeneration,
    herdr,
    sshHost,
    readPaseoWorktreeHooks: worktreeHooks.readPaseoWorktreeHooks,
    resolveWorkspaceGitRoot: async (workspaceId) =>
      files.resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
    workspaceAutoSyncIsRunning: workspaceAutoSync.isRunning,
    onWorkspaceAutoSyncSettingsChanged: workspaceAutoSync.settingsChanged,
    safeSend: args.safeSend,
    markRpcError: args.markRpcError,
  });
  const terminalBridge = createTerminalBridge({
    connectionId: identity.id,
    connectionGeneration: args.connectionGeneration,
    formatError: sanitizeConnectionError,
    clientSocketPath,
    herdrProtocol: async () => Number((await herdr.ping()).protocol),
    safeSend: args.safeSend,
    clientLabel: args.clientLabel,
    markRpcError: args.markRpcError,
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

  const onHerdrEvent = (event: unknown) => args.onEvent(event, identity);
  const onHerdrError = (error: unknown) => args.onError?.(error, identity);
  herdr.on("event", onHerdrEvent);
  herdr.on("error", onHerdrError);

  const subscriptionLoop = createEventSubscriptionLoop({
    subscribe: () => herdr.subscribe(DEFAULT_EVENTS),
    onReady: () =>
      console.log(
        `[bridge] subscribed to herdr events connection=${identity.id}`,
      ),
    onSubscribeError: (error) =>
      console.error(
        `[bridge] subscribe failed connection=${identity.id}:`,
        sanitizeConnectionError(error),
        "- retrying in 2s",
      ),
    onSubscriptionClosed: () =>
      console.log(
        `[bridge] subscription closed connection=${identity.id}, reconnecting in 2s...`,
      ),
  });

  let transportStart: Promise<void> | null = null;
  let transportStarted = false;
  let backgroundStarted = false;
  let disposed = false;
  let stopTask: Promise<void> | null = null;

  async function startTransport() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (transportStarted) return;
    if (transportStart) return transportStart;
    transportStart = sshTunnel
      .startAutoSshTunnel()
      .then(() => {
        if (!disposed) transportStarted = true;
      })
      .finally(() => {
        transportStart = null;
      });
    return transportStart;
  }

  function startBackground() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (backgroundStarted) return;
    backgroundStarted = true;
    workspaceAutoSync.start();
    subscriptionLoop.start();
  }

  function stop() {
    if (stopTask) return stopTask;
    if (disposed) return Promise.resolve();
    disposed = true;
    backgroundStarted = false;
    const autoSyncStop = workspaceAutoSync.stop();
    terminalBridge.dispose();
    const subscriptionStop = subscriptionLoop.stop();
    const transportCleanup = sshTunnel.cleanupAutoSshTunnel();
    const transportStop =
      transportStart?.catch(() => undefined) ?? Promise.resolve();
    stopTask = Promise.all([
      autoSyncStop,
      subscriptionStop,
      transportCleanup,
      transportStop,
    ])
      .then(() => undefined)
      .finally(() => {
        herdr.off("event", onHerdrEvent);
        herdr.off("error", onHerdrError);
      });
    return stopTask;
  }

  return {
    identity,
    socketPath,
    clientSocketPath,
    sshHost,
    herdr,
    worktreeParents,
    handleHerdrInfo,
    handleImageUpload,
    handleSettingsRpc,
    files,
    status,
    workspaceAutoSync,
    worktreeHooks,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
    agentSessions,
    startTransport,
    startBackground,
    stop,
  };
}

export type LegacyConnectionRuntime = ReturnType<
  typeof createLegacyConnectionRuntime
>;
