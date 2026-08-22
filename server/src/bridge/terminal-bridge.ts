import type { ServerWebSocket } from "bun";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  serializeConnectionEnvelope,
} from "../connections/protocol";
import { ThinClient } from "./thin-client";

type TerminalSession = {
  terminalId: string | null;
  cols: number;
  rows: number;
};

type SharedTerminalSession = {
  thin: ThinClient;
  connecting: Promise<void> | null;
  firstFrame: Promise<boolean>;
  resolveFirstFrame: ((seen: boolean) => void) | null;
  terminalId: string;
  cols: number;
  rows: number;
  viewers: Set<ServerWebSocket<unknown>>;
  frames: number;
  bytes: number;
  firstFrameLogged: boolean;
  lastFrameLogAt: number;
};

type ClipboardTarget = {
  ws: ServerWebSocket<unknown>;
  terminalId: string;
  inputAt: number;
};

const CLIPBOARD_INPUT_WINDOW_MS = 30_000;
const CLIPBOARD_RELAY_READY_WAIT_MS = 500;
const TERMINAL_FIRST_FRAME_WAIT_MS = 20_000;
// Herdr rejects OSC 52 bodies above 256 KiB before emitting Clipboard.
const MAX_TERMINAL_CLIPBOARD_BASE64_CHARS = 256 * 1024;
const STANDARD_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function createTerminalBridge(args: {
  connectionId?: string;
  connectionGeneration?: number;
  formatError?: (error: unknown) => string;
  clientSocketPath: string;
  herdrProtocol: () => Promise<number>;
  safeSend: (
    ws: ServerWebSocket<unknown>,
    payload: string,
    context?: string,
  ) => boolean;
  clientLabel: (ws: ServerWebSocket<unknown>) => string;
  markRpcError: (
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) => void;
  confirmRelayResize?: (request: {
    cols: number;
    rows: number;
    paneId: string | null;
  }) => Promise<boolean>;
}) {
  const terminals = new Map<ServerWebSocket<unknown>, TerminalSession>();
  const terminalViewers = new Map<ServerWebSocket<unknown>, Set<string>>();
  const sharedTerminals = new Map<string, SharedTerminalSession>();
  let clipboardRelay: ThinClient | null = null;
  let clipboardRelayConnecting: Promise<void> | null = null;
  let clipboardTarget: ClipboardTarget | null = null;
  let clipboardRelaySize: { cols: number; rows: number } | null = null;
  let clipboardRelayRevision = 0;
  let lifecycleRevision = 0;
  let disposed = false;

  const serialize = (message: Record<string, unknown>) =>
    args.connectionId
      ? serializeConnectionEnvelope(
          args.connectionId,
          message,
          args.connectionGeneration,
        )
      : JSON.stringify(message);
  const connectionDetail = `connection=${args.connectionId ?? "legacy-default"}`;
  const formatError =
    args.formatError ??
    ((error: unknown) =>
      (error instanceof Error ? error.message : String(error))
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
        .trim()
        .slice(0, 300));

  function isCurrent(revision: number) {
    return !disposed && lifecycleRevision === revision;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
  }

  function forwardClipboard(data: string, terminalId?: string) {
    if (disposed) return;
    if (
      !data ||
      data.length > MAX_TERMINAL_CLIPBOARD_BASE64_CHARS ||
      !STANDARD_BASE64_RE.test(data)
    ) {
      console.warn(
        "[bridge] dropped invalid terminal clipboard payload",
        connectionDetail,
      );
      return;
    }

    const now = Date.now();
    const recentTarget =
      clipboardTarget &&
      now - clipboardTarget.inputAt <= CLIPBOARD_INPUT_WINDOW_MS &&
      terminalViewers
        .get(clipboardTarget.ws)
        ?.has(clipboardTarget.terminalId) &&
      (!terminalId || clipboardTarget.terminalId === terminalId)
        ? clipboardTarget
        : null;
    if (!recentTarget) {
      console.warn(
        "[bridge] dropped terminal clipboard without matching recent input",
        connectionDetail,
        ...(terminalId ? [`terminal=${terminalId}`] : []),
      );
      return;
    }
    const targetTerminalId = recentTarget.terminalId;
    const target = recentTarget.ws;

    const payload = serialize({
      terminal_clipboard: {
        terminal_id: targetTerminalId,
        data,
      },
    });
    console.log(
      "[bridge] terminal clipboard",
      connectionDetail,
      `terminal=${targetTerminalId}`,
      `payload=${formatBytes(data.length)}`,
      `target=${args.clientLabel(target)}`,
    );
    args.safeSend(target, payload, "terminal-clipboard");
  }

  function closeClipboardRelay() {
    clipboardTarget = null;
    clipboardRelay?.close();
    clipboardRelay = null;
    clipboardRelayConnecting = null;
    clipboardRelaySize = null;
    clipboardRelayRevision += 1;
  }

  // The clipboard relay doubles as the server's foreground app client, whose
  // size drives the shared pane-runtime resize cascade for every background
  // tab. Keep it pinned to the active tab's projected full-layout viewport so
  // individual split panes cannot drag the shared geometry to their own size.
  function syncClipboardRelaySize(cols: number, rows: number) {
    if (!clipboardRelay || clipboardRelay.isClosed) return false;
    if (
      clipboardRelaySize?.cols === cols &&
      clipboardRelaySize?.rows === rows
    ) {
      return false;
    }
    clipboardRelaySize = { cols, rows };
    clipboardRelay.resize(cols, rows);
    return true;
  }

  async function resizeClipboardRelayAndConfirm(
    cols: number,
    rows: number,
    paneId: string | null,
  ) {
    if (!clipboardRelay || clipboardRelay.isClosed) return false;
    syncClipboardRelaySize(cols, rows);
    return args.confirmRelayResize
      ? args.confirmRelayResize({ cols, rows, paneId })
      : false;
  }

  function relaySizeFromParams(
    params: Record<string, unknown>,
    fallback: { cols: number; rows: number },
  ): { cols: number; rows: number } | null {
    // New clients explicitly mark inactive split panes so a single app relay
    // is sized only by the browser's active pane. Missing flags retain
    // compatibility with older embedded frontends.
    if (params.relay_active === false) return null;
    const cols = Number(params.relay_cols);
    const rows = Number(params.relay_rows);
    if (
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      rows > 0 &&
      cols <= 65_535 &&
      rows <= 65_535
    ) {
      return { cols, rows };
    }
    return fallback;
  }

  function browserClientCountChanged(count: number) {
    if (disposed) return;
    // The relay outlives individual terminal attaches on purpose: reconnecting
    // it on every tab switch makes it flap the server's foreground client,
    // which reflows every pane runtime through the UI pane geometry (sidebar
    // and tab bar inset) and shows up as visible width jumps. Once no browser
    // is connected the relay has no consumer and can go away.
    if (count === 0) closeClipboardRelay();
  }

  function ensureClipboardRelay(cols: number, rows: number) {
    if (disposed) throw new Error("terminal bridge disposed");
    if (clipboardRelay && !clipboardRelay.isClosed) {
      return clipboardRelayConnecting ?? Promise.resolve();
    }

    const relay = new ThinClient(args.clientSocketPath, args.herdrProtocol);
    clipboardRelay = relay;
    clipboardRelaySize = { cols, rows };
    relay.on("clipboard", ({ data }) => forwardClipboard(data));
    relay.on("error", (error) =>
      console.error("[clipboard-relay]", connectionDetail, formatError(error)),
    );
    relay.on("close", () => {
      if (clipboardRelay !== relay) return;
      clipboardRelay = null;
      clipboardRelayConnecting = null;
      clipboardRelaySize = null;
    });

    // Herdr routes client-local side effects such as OSC 52 only to its
    // foreground app client. Direct terminal attachments intentionally cannot
    // receive them, so keep one lightweight app connection while terminals are
    // being viewed and route its clipboard messages back to the input owner.
    const connecting = relay
      .connect(cols, rows, { launchMode: "app", encoding: 1 })
      .then(() => {
        if (disposed) {
          relay.close();
          return;
        }
        console.log("[bridge] clipboard relay connected", connectionDetail);
      })
      .catch((error) => {
        if (clipboardRelay === relay) {
          clipboardRelay = null;
          clipboardRelaySize = null;
        }
        if (!disposed && sharedTerminals.size > 0) {
          console.error(
            "[clipboard-relay] connect failed:",
            connectionDetail,
            formatError(error),
          );
        }
      })
      .finally(() => {
        if (clipboardRelay === relay) clipboardRelayConnecting = null;
      });
    clipboardRelayConnecting = connecting;
    return connecting;
  }

  async function waitForClipboardRelay(
    cols: number,
    rows: number,
    revision?: number,
  ) {
    const connecting = ensureClipboardRelay(cols, rows);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    await Promise.race([
      connecting,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, CLIPBOARD_RELAY_READY_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (disposed) return false;
    if (timedOut) {
      console.warn(
        "[clipboard-relay] still connecting; terminal attach will continue",
        connectionDetail,
      );
      return false;
    }
    if (!clipboardRelay || clipboardRelay.isClosed) return false;
    if (revision !== undefined && revision !== clipboardRelayRevision) {
      return false;
    }
    // A concurrent active viewer may have requested a newer viewport while
    // this relay was connecting. Apply the latest requested size once ready.
    syncClipboardRelaySize(cols, rows);
    return true;
  }

  async function waitForTerminalFirstFrame(
    shared: SharedTerminalSession,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const seen = await Promise.race([
      shared.firstFrame,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(false);
        }, TERMINAL_FIRST_FRAME_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      console.warn(
        "[bridge] terminal first frame still pending; clipboard relay deferred",
        connectionDetail,
        `terminal=${shared.terminalId}`,
      );
    }
    return seen;
  }

  async function syncClipboardRelayAfterAttach(
    shared: SharedTerminalSession,
    size: { cols: number; rows: number },
    revision: number,
  ) {
    // The first direct terminal frame is the protocol-level evidence that
    // Herdr processed AttachTerminal and installed its resize lock. Only then
    // may the app-mode relay become foreground or resize the shared layout.
    if (!(await waitForTerminalFirstFrame(shared)) || disposed) return;
    // A newer tab switch/resize owns the relay now; never let this delayed
    // attach move it back to a stale tab's viewport.
    if (revision !== clipboardRelayRevision) return;
    if (clipboardRelay && !clipboardRelay.isClosed) {
      syncClipboardRelaySize(size.cols, size.rows);
      return;
    }
    await waitForClipboardRelay(size.cols, size.rows, revision);
  }

  function detachTerminalViewer(
    ws: ServerWebSocket<unknown>,
    terminalId?: string | null,
  ) {
    const current = terminals.get(ws);
    const viewed = terminalViewers.get(ws);
    const terminalIds = terminalId
      ? [terminalId]
      : Array.from(viewed ?? (current?.terminalId ? [current.terminalId] : []));
    for (const id of terminalIds) {
      const shared = sharedTerminals.get(id);
      shared?.viewers.delete(ws);
      if (shared && shared.viewers.size === 0) {
        shared.thin.close();
        sharedTerminals.delete(id);
      }
      viewed?.delete(id);
    }
    if (!viewed || viewed.size === 0) {
      terminalViewers.delete(ws);
      terminals.delete(ws);
      if (clipboardTarget?.ws === ws) clipboardTarget = null;
      return;
    }
    if (current?.terminalId && !viewed.has(current.terminalId)) {
      terminals.set(ws, {
        terminalId: Array.from(viewed)[viewed.size - 1] ?? null,
        cols: current.cols,
        rows: current.rows,
      });
    }
  }

  function getSharedTerminal(
    terminalId: string,
    cols: number,
    rows: number,
  ): SharedTerminalSession {
    if (disposed) throw new Error("terminal bridge disposed");
    const creationRevision = lifecycleRevision;
    const existing = sharedTerminals.get(terminalId);
    if (existing && !existing.thin.isClosed) return existing;
    if (existing) {
      existing.thin.close();
      sharedTerminals.delete(terminalId);
    }

    const thin = new ThinClient(args.clientSocketPath, args.herdrProtocol);
    let resolveFirstFrame!: (seen: boolean) => void;
    const firstFrame = new Promise<boolean>((resolve) => {
      resolveFirstFrame = resolve;
    });
    const shared: SharedTerminalSession = {
      thin,
      connecting: null,
      firstFrame,
      resolveFirstFrame,
      terminalId,
      cols,
      rows,
      viewers: new Set(),
      frames: 0,
      bytes: 0,
      firstFrameLogged: false,
      lastFrameLogAt: 0,
    };
    sharedTerminals.set(terminalId, shared);
    console.log(
      "[bridge] thin connecting",
      connectionDetail,
      `terminal=${terminalId}`,
      `size=${cols}x${rows}`,
      `socket=${args.clientSocketPath}`,
    );

    thin.on("terminal", (t) => {
      const resolve = shared.resolveFirstFrame;
      if (resolve) {
        shared.resolveFirstFrame = null;
        resolve(true);
      }
      if (!isCurrent(creationRevision)) return;
      shared.frames += 1;
      shared.bytes += t.bytes.length;
      const now = Date.now();
      if (!shared.firstFrameLogged || now - shared.lastFrameLogAt >= 30_000) {
        console.log(
          "[bridge] thin frame",
          connectionDetail,
          `terminal=${terminalId}`,
          `size=${t.width}x${t.height}`,
          `full=${t.full}`,
          `frames=${shared.frames}`,
          `bytes=${formatBytes(shared.bytes)}`,
          `viewers=${shared.viewers.size}`,
        );
        shared.firstFrameLogged = true;
        shared.lastFrameLogAt = now;
      }
      const payload = serialize({
        terminal: {
          terminal_id: terminalId,
          width: t.width,
          height: t.height,
          full: t.full,
          bytes: Buffer.from(t.bytes).toString("base64"),
        },
      });
      for (const viewer of Array.from(shared.viewers)) {
        if (!terminalViewers.get(viewer)?.has(terminalId)) {
          shared.viewers.delete(viewer);
          continue;
        }
        args.safeSend(viewer, payload, "terminal-frame");
      }
    });
    // Keep compatibility with a future Herdr version that may route clipboard
    // side effects directly to the terminal attachment.
    thin.on("clipboard", ({ data }) => forwardClipboard(data, terminalId));
    thin.on("welcome", (w) => {
      const parts = [
        "[bridge] thin welcome",
        connectionDetail,
        `terminal=${terminalId}`,
        `version=${w.version}`,
        `encoding=${w.encoding}`,
      ];
      if (w.error) parts.push(`error=${formatError(w.error)}`);
      console.log(...parts);
    });
    thin.on("error", (error) =>
      console.error(
        "[thin]",
        connectionDetail,
        formatError(terminalId),
        formatError(error),
      ),
    );
    thin.on("close", () => {
      const resolve = shared.resolveFirstFrame;
      if (resolve) {
        shared.resolveFirstFrame = null;
        resolve(false);
      }
      console.log(
        "[bridge] thin closed",
        connectionDetail,
        `terminal=${terminalId}`,
        `frames=${shared.frames}`,
        `bytes=${formatBytes(shared.bytes)}`,
      );
      if (sharedTerminals.get(terminalId)?.thin === thin) {
        sharedTerminals.delete(terminalId);
      }
    });
    const terminalReady = thin
      .connect(cols, rows, { launchMode: "terminal-attach", encoding: 1 })
      .then(() => {
        if (!isCurrent(creationRevision)) {
          thin.close();
          throw new Error("terminal bridge disposed");
        }
        thin.attach(terminalId, true);
      });
    shared.connecting = terminalReady
      .then(() => undefined)
      .catch((e) => {
        if (sharedTerminals.get(terminalId)?.thin === thin) {
          sharedTerminals.delete(terminalId);
        }
        throw e;
      })
      .finally(() => {
        if (sharedTerminals.get(terminalId)?.thin === thin) {
          const current = sharedTerminals.get(terminalId);
          if (current) current.connecting = null;
        }
      });
    return shared;
  }

  async function handleTerminalRpc(
    ws: ServerWebSocket<unknown>,
    id: string,
    method: string,
    params: Record<string, unknown>,
    requestIsCurrent: () => boolean = () => true,
  ) {
    const fail = (message: string) => {
      const effectiveMessage = requestIsCurrent()
        ? message
        : CONNECTION_CHANGED_DURING_REQUEST;
      args.markRpcError(ws, id, effectiveMessage);
      return args.safeSend(
        ws,
        serialize({ id, error: { message: effectiveMessage } }),
        `${method}-error`,
      );
    };
    const reply = (result: unknown) =>
      requestIsCurrent()
        ? args.safeSend(ws, serialize({ id, result }), method)
        : fail(CONNECTION_CHANGED_DURING_REQUEST);
    try {
      if (!requestIsCurrent()) return fail(CONNECTION_CHANGED_DURING_REQUEST);
      if (disposed) return fail("terminal bridge disposed");
      const operationRevision = lifecycleRevision;
      if (method === "terminal.attach") {
        const terminalId = String(params.terminal_id ?? "");
        const cols = Number(params.cols ?? 100);
        const rows = Number(params.rows ?? 30);
        if (!terminalId) return fail("terminal_id required");
        const relaySize = relaySizeFromParams(params, { cols, rows });
        const relayRevision = relaySize ? ++clipboardRelayRevision : null;

        const existingShared = sharedTerminals.get(terminalId);
        const sharedMode =
          existingShared && !existingShared.thin.isClosed ? "reused" : "new";
        const viewed = terminalViewers.get(ws) ?? new Set<string>();
        const refreshReusedTerminal =
          sharedMode === "reused" &&
          !existingShared?.connecting &&
          !viewed.has(terminalId) &&
          existingShared?.cols === cols &&
          existingShared.rows === rows;
        terminals.set(ws, { terminalId, cols, rows });
        viewed.add(terminalId);
        terminalViewers.set(ws, viewed);
        const shared = getSharedTerminal(terminalId, cols, rows);
        shared.viewers.add(ws);
        try {
          await shared.connecting;
        } catch (e) {
          detachTerminalViewer(ws, terminalId);
          throw e;
        }
        if (
          !isCurrent(operationRevision) ||
          sharedTerminals.get(terminalId) !== shared
        ) {
          detachTerminalViewer(ws, terminalId);
          shared.thin.close();
          throw new Error("terminal bridge disposed");
        }
        if (
          shared.cols !== cols ||
          shared.rows !== rows ||
          refreshReusedTerminal
        ) {
          // Herdr resets its ANSI baseline on Resize, including a same-size
          // resize. Refresh a reused stream so a newly attached browser gets a
          // complete frame even when the terminal is otherwise idle.
          shared.thin.resize(cols, rows);
          shared.cols = cols;
          shared.rows = rows;
          console.log(
            refreshReusedTerminal
              ? "[bridge] terminal refreshed"
              : "[bridge] terminal resized",
            connectionDetail,
            `client=${args.clientLabel(ws)}`,
            `terminal=${terminalId}`,
            `size=${cols}x${rows}`,
          );
        }
        if (relaySize && relayRevision !== null) {
          await syncClipboardRelayAfterAttach(shared, relaySize, relayRevision);
        }
        if (!isCurrent(operationRevision)) {
          detachTerminalViewer(ws, terminalId);
          shared.thin.close();
          throw new Error("terminal bridge disposed");
        }
        console.log(
          "[bridge] terminal attached",
          connectionDetail,
          `client=${args.clientLabel(ws)}`,
          `terminal=${terminalId}`,
          `viewers=${shared.viewers.size}`,
          `size=${cols}x${rows}`,
          `shared=${sharedMode}`,
        );
        return reply({ ok: true });
      }

      if (method === "terminal.relay_resize") {
        const cols = Number(params.cols);
        const rows = Number(params.rows);
        if (
          !Number.isInteger(cols) ||
          !Number.isInteger(rows) ||
          cols <= 0 ||
          rows <= 0 ||
          cols > 65_535 ||
          rows > 65_535
        ) {
          return fail("valid relay cols and rows required");
        }
        const paneId =
          typeof params.pane_id === "string" && params.pane_id
            ? params.pane_id
            : null;
        clipboardRelayRevision += 1;
        const confirmed = await resizeClipboardRelayAndConfirm(
          cols,
          rows,
          paneId,
        );
        if (!isCurrent(operationRevision)) {
          return fail("terminal bridge disposed");
        }
        return reply({ ok: true, confirmed });
      }

      const session = terminals.get(ws);
      const requestedTerminalId =
        typeof params.terminal_id === "string" && params.terminal_id
          ? params.terminal_id
          : session?.terminalId;
      const ownsRequestedTerminal = requestedTerminalId
        ? terminalViewers.get(ws)?.has(requestedTerminalId) === true
        : false;
      const shared =
        requestedTerminalId && ownsRequestedTerminal
          ? sharedTerminals.get(requestedTerminalId)
          : null;
      const thin = shared?.thin;
      if (method === "terminal.detach") {
        detachTerminalViewer(ws, requestedTerminalId ?? null);
        console.log(
          "[bridge] terminal detached",
          connectionDetail,
          `client=${args.clientLabel(ws)}`,
          `terminal=${requestedTerminalId ?? "none"}`,
          requestedTerminalId && sharedTerminals.has(requestedTerminalId)
            ? `viewers=${sharedTerminals.get(requestedTerminalId)?.viewers.size}`
            : "viewers=0",
        );
        return reply({ ok: true });
      }
      if (method === "terminal.input") {
        if (!thin || !requestedTerminalId) return fail("no terminal attached");
        const b64 = String(params.data ?? "");
        if (!b64 || !STANDARD_BASE64_RE.test(b64)) {
          return fail("invalid terminal input");
        }
        const input = Buffer.from(b64, "base64");
        if (input.length === 0) return fail("terminal input required");
        clipboardTarget = {
          ws,
          terminalId: requestedTerminalId,
          inputAt: Date.now(),
        };
        thin.input(input);
        return reply({ ok: true });
      }
      if (method === "terminal.resize") {
        if (!thin || !shared) return fail("no terminal attached");
        const cols = Number(params.cols ?? 100);
        const rows = Number(params.rows ?? 30);
        const relaySize = relaySizeFromParams(params, { cols, rows });
        thin.resize(cols, rows);
        shared.cols = cols;
        shared.rows = rows;
        if (relaySize) {
          clipboardRelayRevision += 1;
          syncClipboardRelaySize(relaySize.cols, relaySize.rows);
        }
        console.log(
          "[bridge] terminal resized",
          connectionDetail,
          `client=${args.clientLabel(ws)}`,
          `terminal=${requestedTerminalId ?? "none"}`,
          `size=${cols}x${rows}`,
        );
        return reply({ ok: true });
      }
      if (method === "terminal.scroll") {
        if (!thin) return fail("no terminal attached");
        const direction = params.direction === "up" ? "up" : "down";
        const lines = Number(params.lines ?? 3);
        const column =
          typeof params.column === "number" ? Number(params.column) : null;
        const row = typeof params.row === "number" ? Number(params.row) : null;
        const source = params.source === "page-key" ? "page-key" : "wheel";
        thin.scroll(direction, lines, column, row, source);
        return reply({ ok: true });
      }
      return fail(`unknown terminal method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  function cleanupWs(ws: ServerWebSocket<unknown>) {
    detachTerminalViewer(ws);
  }

  function viewedTerminals(ws: ServerWebSocket<unknown>): string[] {
    return Array.from(terminalViewers.get(ws) ?? []);
  }

  function statusTerminals() {
    return Array.from(sharedTerminals.values()).map((session) => ({
      terminal_id: session.terminalId,
      viewers: session.viewers.size,
    }));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    lifecycleRevision += 1;
    closeClipboardRelay();
    for (const shared of sharedTerminals.values()) shared.thin.close();
    sharedTerminals.clear();
    terminalViewers.clear();
    terminals.clear();
  }

  return {
    handleTerminalRpc,
    cleanupWs,
    viewedTerminals,
    statusTerminals,
    browserClientCountChanged,
    dispose,
  };
}
