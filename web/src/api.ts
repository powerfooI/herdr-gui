export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface HerdrEventMsg {
  event: string;
  data: { type: string; [k: string]: unknown };
}

export interface TerminalPush {
  terminal_id?: string | null;
  width: number;
  height: number;
  full: boolean;
  /** base64-encoded ANSI bytes */
  bytes: string;
}

export interface TerminalClipboardPush {
  terminal_id: string;
  /** Standard base64 text emitted by Herdr's Clipboard server message. */
  data: string;
}

export interface BridgeControlMsg {
  type: "pause_connection";
  reason?: string;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const RPC_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 8000;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 6000;
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/**
 * Client for the local herdr-gui bridge (WebSocket).
 *
 * Outbound RPC:  { id, method, params }
 * RPC response:  { id, result } | { id, error }
 * Pushed event:  { event, data }
 */
export class Bridge {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private eventHandlers = new Set<(e: HerdrEventMsg) => void>();
  private terminalHandlers = new Set<(t: TerminalPush) => void>();
  private terminalClipboardHandlers = new Set<
    (clipboard: TerminalClipboardPush) => void
  >();
  private statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private controlHandlers = new Set<(c: BridgeControlMsg) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
  private reconnectEnabled = true;
  private _status: ConnectionStatus = "disconnected";

  constructor(
    private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS,
    private readonly reconnectDelayMs = 1500,
  ) {}

  get status() {
    return this._status;
  }

  private setStatus(s: ConnectionStatus) {
    if (this._status === s) return;
    this._status = s;
    this.statusHandlers.forEach((h) => h(s));
  }

  connect() {
    this.reconnectEnabled = true;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.handleDisconnect(null, "bridge connection could not be opened");
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      this.forceReconnect("bridge connection timed out");
    }, this.connectTimeoutMs);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      this.setStatus("connected");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.onMessage(ev.data);
    };
    ws.onerror = () => {
      // onclose will handle reconnect.
    };
    ws.onclose = () => this.handleDisconnect(ws, "bridge disconnected");
  }

  disconnect(reason = "bridge connection paused") {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.rejectPending(reason);
    if (ws) {
      try {
        ws.close(1000, reason.slice(0, 120));
      } catch {
        // Ignore close errors; the socket is already considered inactive.
      }
    }
    this.setStatus("disconnected");
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatInFlight) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.heartbeatInFlight = true;
      this.call("bridge.ping", {}, HEARTBEAT_TIMEOUT_MS).then(
        () => {
          this.heartbeatInFlight = false;
        },
        () => {
          this.heartbeatInFlight = false;
          this.forceReconnect("bridge heartbeat timed out");
        },
      );
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  private clearConnectTimer() {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private rejectPending(message: string) {
    for (const [id, p] of this.pending) {
      if (p.timer !== null) clearTimeout(p.timer);
      p.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private handleDisconnect(ws: WebSocket | null, reason: string) {
    if (ws && this.ws !== ws) return;
    this.ws = null;
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.setStatus("disconnected");
    this.rejectPending(reason);
    if (this.reconnectEnabled && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelayMs);
    }
  }

  private forceReconnect(reason: string) {
    const ws = this.ws;
    if (ws) {
      try {
        ws.close(4000, reason.slice(0, 120));
      } catch {
        // Some browsers throw if the close reason is not accepted.
      }
    }
    this.handleDisconnect(ws, reason);
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (p.timer !== null) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? String(msg.error)));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.event) {
      this.eventHandlers.forEach((h) => h(msg as HerdrEventMsg));
    }
    if (msg.terminal) {
      this.terminalHandlers.forEach((h) => h(msg.terminal as TerminalPush));
    }
    if (msg.terminal_clipboard) {
      this.terminalClipboardHandlers.forEach((h) =>
        h(msg.terminal_clipboard as TerminalClipboardPush),
      );
    }
    if (msg.control) {
      this.controlHandlers.forEach((h) => h(msg.control as BridgeControlMsg));
    }
    // { hello: true, ... } is the initial greeting; ignore.
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number | null = RPC_TIMEOUT_MS,
  ): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected to bridge"));
    }
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      this.forceReconnect("bridge send buffer is full");
      return Promise.reject(new Error("bridge send buffer is full"));
    }
    const id = `c${++this.seq}_${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(new Error(`timeout: ${method}`));
              }
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        if (timer !== null) clearTimeout(timer);
        this.pending.delete(id);
        this.forceReconnect("bridge send failed");
        reject(e as Error);
      }
    });
  }

  onEvent(cb: (e: HerdrEventMsg) => void): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  onTerminal(cb: (t: TerminalPush) => void): () => void {
    this.terminalHandlers.add(cb);
    return () => this.terminalHandlers.delete(cb);
  }

  onTerminalClipboard(
    cb: (clipboard: TerminalClipboardPush) => void,
  ): () => void {
    this.terminalClipboardHandlers.add(cb);
    return () => this.terminalClipboardHandlers.delete(cb);
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    cb(this._status);
    return () => this.statusHandlers.delete(cb);
  }

  onControl(cb: (c: BridgeControlMsg) => void): () => void {
    this.controlHandlers.add(cb);
    return () => this.controlHandlers.delete(cb);
  }
}

export const bridge = new Bridge();
