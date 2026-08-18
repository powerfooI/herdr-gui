export const WS_BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;

interface WebSocketSendTarget {
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
  send(payload: string): number;
}

interface WebSocketSendOptions {
  cleanup: () => void;
  context?: string;
  warn?: (message: string) => void;
}

interface WebSocketSendContext {
  cleanup: () => void;
  context: string;
  warn: (message: string) => void;
}

interface WebSocketCloseOptions {
  code?: number;
  context: string;
  reason?: string;
  warn: (message: string) => void;
}

export class WebSocketCleanupTracker<Socket extends object, Snapshot> {
  private readonly snapshots = new WeakMap<Socket, Snapshot>();

  constructor(
    private readonly performCleanup: (socket: Socket) => Snapshot,
  ) {}

  cleanup(socket: Socket): Snapshot {
    if (this.snapshots.has(socket)) {
      return this.snapshots.get(socket) as Snapshot;
    }
    const snapshot = this.performCleanup(socket);
    this.snapshots.set(socket, snapshot);
    return snapshot;
  }

  complete(socket: Socket): Snapshot {
    const snapshot = this.cleanup(socket);
    this.snapshots.delete(socket);
    return snapshot;
  }
}

function closeWebSocket(
  ws: Pick<WebSocketSendTarget, "close">,
  { code, context, reason, warn }: WebSocketCloseOptions,
): void {
  try {
    if (code === undefined) ws.close();
    else ws.close(code, reason);
  } catch (error) {
    warn(
      `[bridge] websocket close failed during ${context}: ${(error as Error).message}`,
    );
  }
}

function closeSlowWebSocket(
  ws: WebSocketSendTarget,
  { cleanup, context, warn }: WebSocketSendContext,
): boolean {
  const bufferedAmount = ws.getBufferedAmount();
  if (
    !Number.isFinite(bufferedAmount) ||
    bufferedAmount <= WS_BACKPRESSURE_LIMIT_BYTES
  ) {
    return false;
  }

  warn(
    `[bridge] closing slow websocket during ${context}: ${bufferedAmount}B buffered`,
  );
  cleanup();
  closeWebSocket(ws, {
    code: 1013,
    context,
    reason: "client too slow",
    warn,
  });
  return true;
}

export function sendWebSocketMessage(
  ws: WebSocketSendTarget,
  payload: string,
  {
    cleanup,
    context = "message",
    warn = (message) => console.warn(message),
  }: WebSocketSendOptions,
): boolean {
  const sendContext = { cleanup, context, warn };
  try {
    if (closeSlowWebSocket(ws, sendContext)) return false;

    const result = ws.send(payload);
    if (result === 0) {
      cleanup();
      warn(`[bridge] websocket send dropped during ${context}`);
      closeWebSocket(ws, { context, warn });
      return false;
    }
    if (result === -1 && closeSlowWebSocket(ws, sendContext)) return false;
    return true;
  } catch (error) {
    cleanup();
    warn(
      `[bridge] websocket send failed during ${context}: ${(error as Error).message}`,
    );
    closeWebSocket(ws, { context, warn });
    return false;
  }
}
