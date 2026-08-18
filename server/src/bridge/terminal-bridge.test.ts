import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import { createTerminalBridge } from "./terminal-bridge";

const servers: net.Server[] = [];
const serverConnections = new Set<net.Socket>();

afterEach(async () => {
  for (const connection of serverConnections) connection.destroy();
  serverConnections.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function terminalFrame(width = 100, height = 30) {
  const writer = new BinWriter();
  writer.variant(2);
  writer.varint(1);
  writer.varint(width);
  writer.varint(height);
  writer.bool(true);
  writer.bytes(Buffer.from("frame"));
  return encodeFrame(writer.toBuffer());
}

function clipboardFrame(data: string) {
  const writer = new BinWriter();
  writer.variant(6);
  writer.string(data);
  return encodeFrame(writer.toBuffer());
}

async function startThinServer(
  options: {
    clipboardData?: string;
    appWelcomeDelayMs?: number;
    appWelcomeError?: string;
    skipAppWelcome?: boolean;
    directClipboardOnResize?: string;
    directFrameDelayMs?: number;
    tracker?: {
      appConnects: number;
      appCloses: number;
      appSizes: string[];
      events: string[];
    };
  } = {},
) {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-terminal-bridge-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  let appSocket: net.Socket | null = null;
  const server = net.createServer((socket) => {
    serverConnections.add(socket);
    let input = Buffer.alloc(0);
    let isAppSocket = false;
    let socketCols = 100;
    let socketRows = 30;
    socket.on("close", () => {
      serverConnections.delete(socket);
      if (appSocket === socket) appSocket = null;
      if (isAppSocket && options.tracker) options.tracker.appCloses += 1;
    });
    socket.on("data", (chunk) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      while (input.length >= 4) {
        const length = input.readUInt32LE(0);
        if (input.length < length + 4) return;
        const reader = new BinReader(input.subarray(4, length + 4));
        input = input.subarray(length + 4);
        const variant = reader.variant();
        if (variant === 0) {
          const protocol = reader.varint();
          const helloCols = reader.varint();
          const helloRows = reader.varint();
          reader.varint(); // cell width
          reader.varint(); // cell height
          reader.varint(); // encoding
          reader.varint(); // keybindings
          const launchMode = reader.varint();
          socketCols = helloCols;
          socketRows = helloRows;
          if (launchMode === 0 && options.tracker) {
            isAppSocket = true;
            options.tracker.appConnects += 1;
            options.tracker.appSizes.push(`${helloCols}x${helloRows}`);
            options.tracker.events.push("appHello");
          }
          const writer = new BinWriter();
          writer.variant(0);
          writer.varint(protocol);
          writer.varint(1);
          writer.option<string>(
            launchMode === 0 ? options.appWelcomeError : undefined,
            (value) => writer.string(value),
          );
          const sendWelcome = () => {
            if (socket.destroyed) return;
            if (launchMode === 0 && options.skipAppWelcome) return;
            if (launchMode === 0) appSocket = socket;
            socket.write(encodeFrame(writer.toBuffer()));
            if (launchMode === 0) {
              socket.write(terminalFrame(socketCols, socketRows));
            }
          };
          if (launchMode === 0 && (options.appWelcomeDelayMs ?? 0) > 0) {
            setTimeout(sendWelcome, options.appWelcomeDelayMs);
          } else {
            sendWelcome();
          }
        } else if (variant === 1) {
          if (options.clipboardData) {
            appSocket?.write(clipboardFrame(options.clipboardData));
          }
        } else if (variant === 3 || variant === 5) {
          if (variant === 3) {
            const resizeCols = reader.varint();
            const resizeRows = reader.varint();
            socketCols = resizeCols;
            socketRows = resizeRows;
            if (isAppSocket && options.tracker) {
              options.tracker.appSizes.push(`${resizeCols}x${resizeRows}`);
            }
          } else if (options.tracker) {
            options.tracker.events.push("attach");
            options.tracker.events.push("terminalFrame");
          }
          const sendTerminalFrame = () => {
            if (!socket.destroyed) {
              socket.write(terminalFrame(socketCols, socketRows));
            }
          };
          if (variant === 5 && (options.directFrameDelayMs ?? 0) > 0) {
            setTimeout(sendTerminalFrame, options.directFrameDelayMs);
          } else {
            sendTerminalFrame();
          }
          if (variant === 3 && options.directClipboardOnResize) {
            socket.write(clipboardFrame(options.directClipboardOnResize));
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

async function waitForTerminalFrame(messages: string[]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = messages
      .map((message) => JSON.parse(message))
      .find((message) => message.terminal);
    if (frame) return frame.terminal;
    await Bun.sleep(2);
  }
  throw new Error("timed out waiting for terminal frame");
}

describe("terminal bridge sharing", () => {
  test("refreshes a reused terminal for a newly attached browser", async () => {
    const socketPath = await startThinServer();
    const firstBrowser = {} as ServerWebSocket<unknown>;
    const secondBrowser = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [firstBrowser, []],
      [secondBrowser, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: (ws) => (ws === firstBrowser ? "first" : "second"),
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      firstBrowser,
      "first-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await waitForTerminalFrame(messages.get(firstBrowser)!);

    await bridge.handleTerminalRpc(
      secondBrowser,
      "second-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    const reusedFrame = await waitForTerminalFrame(
      messages.get(secondBrowser)!,
    );

    expect(reusedFrame).toMatchObject({
      terminal_id: "term_1",
      full: true,
      width: 100,
      height: 30,
    });

    const frameCount = messages
      .get(secondBrowser)!
      .map((message) => JSON.parse(message))
      .filter((message) => message.terminal).length;
    await bridge.handleTerminalRpc(
      secondBrowser,
      "duplicate-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await Bun.sleep(5);
    expect(
      messages
        .get(secondBrowser)!
        .map((message) => JSON.parse(message))
        .filter((message) => message.terminal),
    ).toHaveLength(frameCount);

    bridge.cleanupWs(firstBrowser);
    bridge.cleanupWs(secondBrowser);
  });

  test("routes Herdr clipboard messages from the app relay to the input owner", async () => {
    const clipboardData = "cmVtb3RlIGNvcHk=";
    const socketPath = await startThinServer({
      clipboardData,
      appWelcomeDelayMs: 30,
    });
    const browser = {} as ServerWebSocket<unknown>;
    const observer = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [browser, []],
      [observer, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: (ws) => (ws === browser ? "browser" : "observer"),
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await bridge.handleTerminalRpc(observer, "observe", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await bridge.handleTerminalRpc(browser, "input", "terminal.input", {
      terminal_id: "term_1",
      data: Buffer.from("copy").toString("base64"),
    });
    await Bun.sleep(5);

    expect(
      messages
        .get(browser)!
        .map((message) => JSON.parse(message))
        .find((message) => message.terminal_clipboard)?.terminal_clipboard,
    ).toEqual({ terminal_id: "term_1", data: clipboardData });
    expect(
      messages
        .get(observer)!
        .some((message) => JSON.parse(message).terminal_clipboard),
    ).toBe(false);

    messages.get(browser)!.length = 0;
    messages.get(observer)!.length = 0;
    await bridge.handleTerminalRpc(observer, "input-2", "terminal.input", {
      terminal_id: "term_1",
      data: Buffer.from("copy again").toString("base64"),
    });
    await Bun.sleep(5);
    expect(
      messages
        .get(observer)!
        .map((message) => JSON.parse(message))
        .find((message) => message.terminal_clipboard)?.terminal_clipboard,
    ).toEqual({ terminal_id: "term_1", data: clipboardData });
    expect(
      messages
        .get(browser)!
        .some((message) => JSON.parse(message).terminal_clipboard),
    ).toBe(false);
    bridge.cleanupWs(browser);
    bridge.cleanupWs(observer);
  });

  test("does not broadcast clipboard events without a matching input owner", async () => {
    const socketPath = await startThinServer({
      directClipboardOnResize: "bm8gb3duZXI=",
    });
    const firstBrowser = {} as ServerWebSocket<unknown>;
    const secondBrowser = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [firstBrowser, []],
      [secondBrowser, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      firstBrowser,
      "attach-1",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await bridge.handleTerminalRpc(
      secondBrowser,
      "attach-2",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await Bun.sleep(5);

    for (const sent of messages.values()) {
      expect(
        sent.some((message) => JSON.parse(message).terminal_clipboard),
      ).toBe(false);
    }
    bridge.cleanupWs(firstBrowser);
    bridge.cleanupWs(secondBrowser);
  });

  test("keeps terminal attach usable when the optional relay is rejected", async () => {
    const socketPath = await startThinServer({
      appWelcomeError: "app clients disabled",
    });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });

    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "attach")?.result,
    ).toEqual({ ok: true });
    bridge.cleanupWs(browser);
  });

  test("does not leave terminal attach waiting on a stalled relay", async () => {
    const socketPath = await startThinServer({ skipAppWelcome: true });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    const startedAt = performance.now();
    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });

    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "attach")?.result,
    ).toEqual({ ok: true });
    bridge.cleanupWs(browser);
  });

  test("keeps the clipboard relay alive across terminal detaches", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const socketPath = await startThinServer({ tracker });
    const browser = {} as ServerWebSocket<unknown>;
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: () => true,
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach-1", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    expect(tracker.appConnects).toBe(1);
    // The first terminal frame proves that Herdr processed AttachTerminal and
    // installed its resize lock before the app relay becomes foreground.
    expect(tracker.events.indexOf("terminalFrame")).toBeGreaterThanOrEqual(0);
    expect(tracker.events.indexOf("terminalFrame")).toBeLessThan(
      tracker.events.indexOf("appHello"),
    );

    // Detaching the last viewer must not tear down the relay: its reconnect
    // churn is what reflows background pane runtimes on every tab switch.
    await bridge.handleTerminalRpc(browser, "detach-1", "terminal.detach", {
      terminal_id: "term_1",
    });
    expect(tracker.appCloses).toBe(0);

    await bridge.handleTerminalRpc(browser, "attach-2", "terminal.attach", {
      terminal_id: "term_2",
      cols: 100,
      rows: 30,
    });
    expect(tracker.appConnects).toBe(1);

    // The relay follows the latest viewer size so the server's shared pane
    // geometry stays pinned to the visible window.
    await bridge.handleTerminalRpc(browser, "resize-1", "terminal.resize", {
      terminal_id: "term_2",
      cols: 120,
      rows: 40,
    });
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("120x40");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toContain("120x40");

    // Once no browser is connected the relay has no consumer and closes.
    bridge.browserClientCountChanged(0);
    for (
      let attempt = 0;
      attempt < 50 && tracker.appCloses === 0;
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appCloses).toBe(1);

    bridge.browserClientCountChanged(1);
    await bridge.handleTerminalRpc(browser, "attach-3", "terminal.attach", {
      terminal_id: "term_3",
      cols: 100,
      rows: 30,
    });
    expect(tracker.appConnects).toBe(2);
    bridge.cleanupWs(browser);
  });

  test("sizes the relay only from the active split pane viewport", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const socketPath = await startThinServer({ tracker });
    const browser = {} as ServerWebSocket<unknown>;
    const confirmedRelaySizes: Array<{
      cols: number;
      rows: number;
      paneId: string | null;
    }> = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: () => true,
      clientLabel: () => "browser",
      markRpcError: () => undefined,
      confirmRelayResize: async (request) => {
        confirmedRelaySizes.push(request);
        return true;
      },
    });

    await bridge.handleTerminalRpc(browser, "inactive", "terminal.attach", {
      terminal_id: "term_inactive",
      cols: 70,
      rows: 44,
      relay_active: false,
    });
    expect(tracker.appConnects).toBe(0);

    await bridge.handleTerminalRpc(browser, "active", "terminal.attach", {
      terminal_id: "term_active",
      cols: 70,
      rows: 44,
      relay_active: true,
      relay_cols: 168,
      relay_rows: 45,
    });
    expect(tracker.appConnects).toBe(1);
    expect(tracker.appSizes).toEqual(["168x45"]);

    await bridge.handleTerminalRpc(
      browser,
      "relay-resize",
      "terminal.relay_resize",
      { cols: 170, rows: 46, pane_id: "pane_active" },
    );
    expect(confirmedRelaySizes).toEqual([
      { cols: 170, rows: 46, paneId: "pane_active" },
    ]);
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("170x46");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toEqual(["168x45", "170x46"]);

    await bridge.handleTerminalRpc(
      browser,
      "inactive-resize",
      "terminal.resize",
      {
        terminal_id: "term_inactive",
        cols: 72,
        rows: 44,
        relay_active: false,
      },
    );
    await Bun.sleep(5);
    expect(tracker.appSizes).toEqual(["168x45", "170x46"]);

    await bridge.handleTerminalRpc(
      browser,
      "active-resize",
      "terminal.resize",
      {
        terminal_id: "term_active",
        cols: 72,
        rows: 44,
        relay_active: true,
        relay_cols: 172,
        relay_rows: 45,
      },
    );
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("172x45");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toEqual(["168x45", "170x46", "172x45"]);
    bridge.cleanupWs(browser);
  });

  test("does not let a delayed attach overwrite a newer relay target", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const socketPath = await startThinServer({
      tracker,
      directFrameDelayMs: 25,
    });
    const browser = {} as ServerWebSocket<unknown>;
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: () => true,
      clientLabel: () => "browser",
      markRpcError: () => undefined,
      confirmRelayResize: async () => true,
    });

    await bridge.handleTerminalRpc(browser, "initial", "terminal.attach", {
      terminal_id: "term_initial",
      cols: 100,
      rows: 30,
      relay_cols: 100,
      relay_rows: 30,
    });
    const delayedAttach = bridge.handleTerminalRpc(
      browser,
      "delayed",
      "terminal.attach",
      {
        terminal_id: "term_delayed",
        cols: 120,
        rows: 40,
        relay_cols: 120,
        relay_rows: 40,
      },
    );
    await Bun.sleep(5);
    await bridge.handleTerminalRpc(
      browser,
      "new-target",
      "terminal.relay_resize",
      { cols: 140, rows: 50, pane_id: "pane_target" },
    );
    await delayedAttach;
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("140x50");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toContain("140x50");
    expect(tracker.appSizes).not.toContain("120x40");
    bridge.cleanupWs(browser);
  });

  test("rejects input for terminals the browser does not view", async () => {
    const socketPath = await startThinServer();
    const owner = {} as ServerWebSocket<unknown>;
    const stranger = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [owner, []],
      [stranger, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });
    await bridge.handleTerminalRpc(owner, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });

    await bridge.handleTerminalRpc(stranger, "input", "terminal.input", {
      terminal_id: "term_1",
      data: Buffer.from("steal clipboard").toString("base64"),
    });

    expect(
      messages
        .get(stranger)!
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "input")?.error.message,
    ).toBe("no terminal attached");
    bridge.cleanupWs(owner);
    bridge.cleanupWs(stranger);
  });
});
