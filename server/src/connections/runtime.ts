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
import {
  createLastStepBaselineStore,
  type LastStepBaselineStore,
} from "../workspace/git-diff";
import { createLastStepTurnTracker } from "../workspace/last-step-turns";
import { runBinaryProcessWithTimeout } from "../workspace/process";
import { createStatusEnricher } from "../workspace/status";
import { createWorktreeHookRunner } from "../worktree/worktree-hooks";
import { createWorktreeParentStore } from "../worktree/parents";
import {
  createWorktreeRemovalCoordinator,
  createWorktreeRemovalRuntime,
} from "../worktree/remove";
import { createAgentStatusSubscriptionLoop } from "./agent-status-subscription";
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
  /** Test seam for deterministic shutdown coverage. */
  lastStepBaselines?: LastStepBaselineStore;
  resolveLastStepWorkspaceGitRoot?: (workspaceId: string) => Promise<string>;
  lastStepTransitionDebounceMs?: number;
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
  const lastStepBaselines =
    args.lastStepBaselines ??
    createLastStepBaselineStore({
      host: sshHost(),
      runProcessWithCodeTimeout,
      shQuote,
    });
  const files = createFileHandlers({
    herdr,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
    lastStepBaselines,
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

  const lastStepTurns = createLastStepTurnTracker({
    captureWorkspaceBaseline: async (workspaceId) => {
      await lastStepBaselines.captureWorkspace(workspaceId, async () => {
        if (args.resolveLastStepWorkspaceGitRoot) {
          return args.resolveLastStepWorkspaceGitRoot(workspaceId);
        }
        const { root } = await files.resolveWorkspaceGitRoot({
          workspace_id: workspaceId,
        });
        return root;
      });
    },
    completeWorkspaceStep: async (workspaceId) => {
      const published = await lastStepBaselines.completeWorkspace(workspaceId);
      if (!published || disposed) return;
      args.onEvent(
        {
          event: "workspace.last_step_completed",
          data: {
            type: "workspace.last_step_completed",
            workspace_id: workspaceId,
          },
        },
        identity,
      );
    },
    onCaptureError: (error, workspaceId) =>
      console.error(
        `[bridge] last-step baseline failed connection=${identity.id} workspace=${workspaceId}:`,
        sanitizeConnectionError(error),
      ),
    onCompleteError: (error, workspaceId) =>
      console.error(
        `[bridge] last-step completion failed connection=${identity.id} workspace=${workspaceId}:`,
        sanitizeConnectionError(error),
      ),
    transitionDebounceMs: args.lastStepTransitionDebounceMs ?? 150,
  });
  const agentStatusSubscriptions = createAgentStatusSubscriptionLoop({
    herdr,
    connectionId: identity.id,
    onSubscribeError: (error) =>
      console.error(
        `[bridge] agent status subscribe failed connection=${identity.id}:`,
        sanitizeConnectionError(error),
        "- retrying",
      ),
    onListError: (error) =>
      console.error(
        `[bridge] agent status pane list failed connection=${identity.id}:`,
        sanitizeConnectionError(error),
      ),
    onPaneListStart: lastStepTurns.beginPaneList,
    onPaneList: lastStepTurns.reconcilePaneList,
    log: (message) => console.log(`[bridge] ${message}`),
  });

  const onHerdrEvent = (event: unknown) => {
    lastStepTurns.handleHerdrEvent(event);
    agentStatusSubscriptions.handleHerdrEvent(event);
    args.onEvent(event, identity);
  };
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
    agentStatusSubscriptions.start();
  }

  function stop() {
    if (stopTask) return stopTask;
    if (disposed) return Promise.resolve();
    disposed = true;
    backgroundStarted = false;
    herdr.off("event", onHerdrEvent);
    herdr.off("error", onHerdrError);
    const autoSyncStop = workspaceAutoSync.stop();
    terminalBridge.dispose();
    const subscriptionStop = subscriptionLoop.stop();
    const agentStatusStop = agentStatusSubscriptions.stop();
    const lastStepStop = lastStepTurns
      .stop()
      .then(() => lastStepBaselines.dispose());
    const transportCleanup = sshTunnel.cleanupAutoSshTunnel();
    const transportStop =
      transportStart?.catch(() => undefined) ?? Promise.resolve();
    stopTask = Promise.all([
      autoSyncStop,
      subscriptionStop,
      agentStatusStop,
      lastStepStop,
      transportCleanup,
      transportStop,
    ]).then(() => undefined);
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
