import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import {
  assertSupportedHerdrProtocol,
  isSupportedHerdrProtocol,
} from "./protocol-compat";
import { ThinClient } from "./thin-client";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function startHandshakeServer(
  welcome: (protocol: number) => { version: number; error?: string },
  onConnection: () => void = () => undefined,
) {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-thin-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const server = net.createServer((socket) => {
    onConnection();
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      if (input.length < 4) return;
      const length = input.readUInt32LE(0);
      if (input.length < length + 4) return;
      const reader = new BinReader(input.subarray(4, length + 4));
      expect(reader.variant()).toBe(0);
      const protocol = reader.varint();
      const response = welcome(protocol);
      const writer = new BinWriter();
      writer.variant(0);
      writer.varint(response.version);
      writer.varint(1);
      writer.option(response.error, (value) => writer.string(value));
      socket.write(encodeFrame(writer.toBuffer()));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

async function startMessageServer(
  onVariant: (variant: number, socket: net.Socket, reader: BinReader) => void,
) {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-thin-messages-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0);
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
        onVariant(variant, socket, reader);
        if (variant !== 0) continue;
        const protocol = reader.varint();
        const writer = new BinWriter();
        writer.variant(0);
        writer.varint(protocol);
        writer.varint(1);
        writer.option<string>(undefined, (value) => writer.string(value));
        socket.write(encodeFrame(writer.toBuffer()));
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

describe("Herdr thin-client protocol compatibility", () => {
  test("supports the compatible floor and future protocol versions", () => {
    expect([14, 15, 16, 17, 18, 999].map(isSupportedHerdrProtocol)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(isSupportedHerdrProtocol(13)).toBe(false);
    expect(() => assertSupportedHerdrProtocol(13)).toThrow(
      "requires protocol 14 or newer",
    );
    expect(() => assertSupportedHerdrProtocol(17.5)).toThrow(
      "invalid protocol version",
    );
    expect(() => assertSupportedHerdrProtocol(0x1_0000_0000)).toThrow(
      "invalid protocol version",
    );
  });

  for (const protocol of [14, 15, 16, 17, 18]) {
    test(`waits for a successful protocol ${protocol} welcome`, async () => {
      const seen: number[] = [];
      const socketPath = await startHandshakeServer((requestedProtocol) => {
        seen.push(requestedProtocol);
        return { version: requestedProtocol };
      });
      const client = new ThinClient(socketPath, async () => protocol);

      await client.connect(100, 30, { launchMode: 1, encoding: 1 });

      expect(seen).toEqual([protocol]);
      client.close();
    });
  }

  test("rejects a welcome error instead of treating the socket as attached", async () => {
    const socketPath = await startHandshakeServer((protocol) => ({
      version: 16,
      error: `client version ${protocol} is older than server version 16`,
    }));
    const client = new ThinClient(socketPath, async () => 14);

    await expect(client.connect(100, 30)).rejects.toThrow(
      "Herdr rejected thin-client protocol 14",
    );
  });

  test("rejects unsupported protocols before opening a thin socket", async () => {
    const client = new ThinClient("/missing.sock", async () => 13);

    await expect(client.connect(100, 30)).rejects.toThrow(
      "Herdr protocol 13 is not supported",
    );
  });

  test("does not open a socket when closed during protocol resolution", async () => {
    let resolveProtocol!: (protocol: number) => void;
    const protocol = new Promise<number>((resolve) => {
      resolveProtocol = resolve;
    });
    let connections = 0;
    const socketPath = await startHandshakeServer(
      (requestedProtocol) => ({ version: requestedProtocol }),
      () => {
        connections += 1;
      },
    );
    const client = new ThinClient(socketPath, () => protocol);

    const connecting = client.connect(100, 30);
    client.close();
    resolveProtocol(17);

    await expect(connecting).rejects.toThrow("thin client is closed");
    await Bun.sleep(10);
    expect(connections).toBe(0);
  });

  test("sends the one-time terminal attach transition only once", async () => {
    const variants: number[] = [];
    const socketPath = await startMessageServer((variant, socket) => {
      variants.push(variant);
      if (variant === 5 && variants.filter((value) => value === 5).length > 1) {
        const writer = new BinWriter();
        writer.variant(4);
        writer.option("client is no longer pending terminal mode", (value) =>
          writer.string(value),
        );
        socket.write(encodeFrame(writer.toBuffer()));
      }
    });
    const client = new ThinClient(socketPath, async () => 16);

    await client.connect(100, 30, { launchMode: 1, encoding: 1 });
    client.attach("term_1", true);
    client.attach("term_1", true);
    await Bun.sleep(10);

    expect(variants).toEqual([0, 5]);
    expect(() => client.attach("term_2", true)).toThrow(
      "already attached to term_1",
    );
    client.close();
  });

  test("encodes both physical page keys with the PageKey source", async () => {
    const scrolls: Array<{
      source: number;
      bytes: Buffer;
      direction: number;
      lines: number;
    }> = [];
    let resolveScrolls!: () => void;
    const receivedScrolls = new Promise<void>((resolve) => {
      resolveScrolls = resolve;
    });
    const socketPath = await startMessageServer((variant, _socket, reader) => {
      if (variant !== 6) return;
      const source = reader.variant();
      const bytes = source === 1 ? reader.bytes() : Buffer.alloc(0);
      const direction = reader.variant();
      const lines = reader.varint();
      expect(reader.option(() => reader.varint())).toBeNull();
      expect(reader.option(() => reader.varint())).toBeNull();
      expect(reader.u8()).toBe(0);
      scrolls.push({ source, bytes, direction, lines });
      if (scrolls.length === 2) resolveScrolls();
    });
    const client = new ThinClient(socketPath, async () => 17);

    await client.connect(100, 30, { launchMode: 1, encoding: 1 });
    client.scroll("up", 28, null, null, "page-key");
    client.scroll("down", 17, null, null, "page-key");
    await receivedScrolls;

    expect(scrolls).toEqual([
      {
        source: 1,
        bytes: Buffer.from([0x1b, 0x5b, 0x35, 0x7e]),
        direction: 0,
        lines: 28,
      },
      {
        source: 1,
        bytes: Buffer.from([0x1b, 0x5b, 0x36, 0x7e]),
        direction: 1,
        lines: 17,
      },
    ]);
    client.close();
  });

  test("decodes Herdr clipboard messages separately from terminal frames", async () => {
    const clipboardData = "cmVtb3RlIGNvcHk=";
    const socketPath = await startMessageServer((variant, socket) => {
      if (variant !== 5) return;
      const writer = new BinWriter();
      writer.variant(6);
      writer.string(clipboardData);
      socket.write(encodeFrame(writer.toBuffer()));
    });
    const client = new ThinClient(socketPath, async () => 17);
    const clipboard = new Promise<{ data: string }>((resolve) =>
      client.once("clipboard", resolve),
    );

    await client.connect(100, 30, { launchMode: 1, encoding: 1 });
    client.attach("term_1", true);

    expect(await clipboard).toEqual({ data: clipboardData });
    client.close();
  });
});
