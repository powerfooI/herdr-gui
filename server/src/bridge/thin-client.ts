import { EventEmitter } from "node:events";
import * as net from "node:net";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import { assertSupportedHerdrProtocol } from "./protocol-compat";

const HANDSHAKE_TIMEOUT_MS = 8_000;

// ClientMessage variant indices (must match wire.rs enum order).
const CM = {
  Hello: 0,
  Input: 1,
  Resize: 3,
  AttachTerminal: 5,
  AttachScroll: 6,
} as const;

// ServerMessage variant indices.
const SM = {
  Welcome: 0,
  Frame: 1,
  Terminal: 2,
  ServerShutdown: 4,
  Clipboard: 6,
  MouseCapture: 9,
} as const;

export interface CellData {
  symbol: string;
  fg: number;
  bg: number;
  modifier: number;
  skip: boolean;
  hyperlink: number | null;
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  shape: number;
}

export interface FrameData {
  cells: CellData[];
  width: number;
  height: number;
  cursor: CursorState | null;
  hyperlinks: string[];
}

/**
 * One thin-client connection to herdr-client.sock. After `connect` (which sends
 * the Hello handshake), call `attach(terminalId)` to render a single pane
 * terminal at the requested cols×rows; rendered frames arrive as `frame`
 * events. Call `resize` whenever the display size changes.
 */
export class ThinClient extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private closed = false;
  private protocolVersion: number | null = null;
  private attachedTerminalId: string | null = null;
  private pendingWelcome:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(
    private socketPath: string,
    private resolveProtocol: () => Promise<number>,
  ) {
    super();
  }

  // Exposed so the bridge can reuse a live client across terminal switches and
  // reconnect only after the socket actually closes.
  get isClosed() {
    return this.closed;
  }

  async connect(
    cols: number,
    rows: number,
    opts: { launchMode?: number; encoding?: number } = {},
  ): Promise<void> {
    if (this.sock) throw new Error("thin client is already connected");
    const protocolVersion = await this.resolveProtocol();
    assertSupportedHerdrProtocol(protocolVersion);
    this.protocolVersion = protocolVersion;
    this.closed = false;
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ path: this.socketPath });
      this.sock = sock;
      const timer = setTimeout(() => {
        this.rejectWelcome(
          new Error(
            `timed out waiting for Herdr protocol ${protocolVersion} handshake`,
          ),
        );
        this.close();
      }, HANDSHAKE_TIMEOUT_MS);
      this.pendingWelcome = { resolve, reject, timer };
      sock.once("connect", () => {
        this.sendHello(
          cols,
          rows,
          opts.launchMode ?? 0,
          opts.encoding ?? 0,
          protocolVersion,
        );
      });
      sock.on("data", (c) =>
        this.onData(Buffer.isBuffer(c) ? c : Buffer.from(c)),
      );
      sock.on("error", (e) => {
        this.rejectWelcome(e);
        this.emit("error", e);
      });
      sock.on("close", () => {
        this.closed = true;
        this.rejectWelcome(
          new Error("thin client connection closed during handshake"),
        );
        this.emit("close");
      });
    });
  }

  private resolveWelcome() {
    const pending = this.pendingWelcome;
    if (!pending) return;
    this.pendingWelcome = undefined;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectWelcome(error: Error) {
    const pending = this.pendingWelcome;
    if (!pending) return;
    this.pendingWelcome = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > 32 * 1024 * 1024) {
        this.emit("error", new Error(`oversized frame: ${len}`));
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.handlePayload(payload);
    }
  }

  private handlePayload(payload: Buffer) {
    try {
      const r = new BinReader(payload);
      const variant = r.variant();
      if (variant === SM.Welcome) {
        const version = r.varint();
        const encoding = r.varint();
        const error = r.option(() => r.string());
        this.emit("welcome", { version, encoding, error });
        if (error) {
          this.rejectWelcome(
            new Error(
              `Herdr rejected thin-client protocol ${this.protocolVersion}: ${error}`,
            ),
          );
          this.close();
        } else if (version !== this.protocolVersion) {
          this.rejectWelcome(
            new Error(
              `Herdr welcomed protocol ${version}, expected ${this.protocolVersion}`,
            ),
          );
          this.close();
        } else {
          this.resolveWelcome();
        }
      } else if (variant === SM.Frame) {
        this.emit("frame", readFrameData(r));
      } else if (variant === SM.Terminal) {
        const seq = r.varint();
        const width = r.varint();
        const height = r.varint();
        const full = r.bool();
        const bytes = r.bytes();
        this.emit("terminal", { seq, width, height, full, bytes });
      } else if (variant === SM.ServerShutdown) {
        const reason = r.option(() => r.string());
        this.emit(
          "error",
          new Error(reason || "Herdr closed the thin-client connection"),
        );
        this.close();
      } else if (variant === SM.Clipboard) {
        this.emit("clipboard", { data: r.string() });
      } else if (variant === SM.MouseCapture) {
        this.emit("mouse_capture", r.bool());
      }
      // Graphics / Notify / WindowTitle are ignored for now.
    } catch (e) {
      this.emit("error", new Error(`decode: ${(e as Error).message}`));
    }
  }

  private write(msg: Buffer) {
    if (this.sock && !this.closed) this.sock.write(encodeFrame(msg));
  }

  private sendHello(
    cols: number,
    rows: number,
    launchMode: number,
    encoding: number,
    protocolVersion: number,
  ) {
    const w = new BinWriter();
    w.variant(CM.Hello);
    w.varint(protocolVersion);
    w.varint(cols);
    w.varint(rows);
    w.varint(0); // cell_width_px (no client-side kitty graphics)
    w.varint(0); // cell_height_px
    w.varint(encoding); // requested_encoding: 0=SemanticFrame, 1=TerminalAnsi
    w.varint(0); // keybindings = Server
    w.varint(launchMode); // launch_mode: 0=App, 1=TerminalAttach
    this.write(w.toBuffer());
  }

  attach(terminalId: string, takeover = false) {
    // Herdr 0.7.4 treats AttachTerminal as a one-time connection transition.
    // Keep retries for the same terminal local instead of making the server
    // reject and close an otherwise healthy direct-attach connection.
    if (this.attachedTerminalId === terminalId) return;
    if (this.attachedTerminalId) {
      throw new Error(
        `thin client is already attached to ${this.attachedTerminalId}`,
      );
    }
    const w = new BinWriter();
    w.variant(CM.AttachTerminal);
    w.string(terminalId);
    w.bool(takeover);
    this.write(w.toBuffer());
    this.attachedTerminalId = terminalId;
  }

  resize(cols: number, rows: number) {
    const w = new BinWriter();
    w.variant(CM.Resize);
    w.varint(cols);
    w.varint(rows);
    w.varint(0);
    w.varint(0);
    this.write(w.toBuffer());
  }

  scroll(
    direction: "up" | "down",
    lines: number,
    column?: number | null,
    row?: number | null,
    source: "wheel" | "page-key" = "wheel",
  ) {
    const w = new BinWriter();
    w.variant(CM.AttachScroll);
    if (source === "page-key") {
      w.variant(1); // AttachScrollSource::PageKey
      w.bytes(
        direction === "up"
          ? Buffer.from([0x1b, 0x5b, 0x35, 0x7e]) // PageUp: ESC [ 5 ~
          : Buffer.from([0x1b, 0x5b, 0x36, 0x7e]), // PageDown: ESC [ 6 ~
      );
    } else {
      w.variant(0); // AttachScrollSource::Wheel
    }
    w.variant(direction === "up" ? 0 : 1); // AttachScrollDirection
    w.varint(Math.max(1, Math.min(0xffff, Math.floor(lines))));
    w.option(column, (v) => w.varint(v));
    w.option(row, (v) => w.varint(v));
    w.u8(0); // crossterm KeyModifiers bits
    this.write(w.toBuffer());
  }

  input(data: Uint8Array) {
    const w = new BinWriter();
    w.variant(CM.Input);
    w.bytes(data);
    this.write(w.toBuffer());
  }

  close() {
    this.closed = true;
    this.rejectWelcome(new Error("thin client closed during handshake"));
    this.sock?.destroy();
  }
}

function readFrameData(r: BinReader): FrameData {
  const cellCount = r.varint();
  const cells: CellData[] = new Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    cells[i] = {
      symbol: r.string(),
      fg: r.varint(),
      bg: r.varint(),
      modifier: r.varint(),
      skip: r.bool(),
      hyperlink: r.option(() => r.varint()),
    };
  }
  const width = r.varint();
  const height = r.varint();
  const cursor = r.option(
    (): CursorState => ({
      x: r.varint(),
      y: r.varint(),
      visible: r.bool(),
      shape: r.u8(),
    }),
  );
  const linkCount = r.varint();
  const hyperlinks: string[] = new Array(linkCount);
  for (let i = 0; i < linkCount; i++) hyperlinks[i] = r.string();
  r.bytes(); // graphics (ignored)
  return { cells, width, height, cursor, hyperlinks };
}
