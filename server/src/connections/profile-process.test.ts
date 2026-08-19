import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinReader, BinWriter, encodeFrame } from "../bridge/bincode";
import type { LocalConnectionProfile } from "./profiles";

const roots: string[] = [];
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const controlCalls = new Map<string, string[]>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  controlCalls.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function listen(server: net.Server, path: string): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

async function fakeHerdr(
  root: string,
  id: string,
): Promise<LocalConnectionProfile> {
  const controlPath = join(root, `${id}-control.sock`);
  const renderPath = join(root, `${id}-render.sock`);
  await listen(
    net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline));
        const calls = controlCalls.get(id) ?? [];
        calls.push(request.method);
        controlCalls.set(id, calls);
        const result =
          request.method === "ping"
            ? { version: `fake-${id}`, protocol: 14 }
            : request.method === "workspace.list"
              ? {
                  workspaces: [
                    {
                      workspace_id: "shared-workspace",
                      name: `from-${id}`,
                    },
                  ],
                }
              : {};
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method !== "events.subscribe") socket.end();
      });
    }),
    controlPath,
  );
  await listen(
    net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let input = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        input = Buffer.concat([input, Buffer.from(chunk)]);
        if (input.length < 4) return;
        const length = input.readUInt32LE(0);
        if (input.length < length + 4) return;
        const reader = new BinReader(input.subarray(4, length + 4));
        expect(reader.variant()).toBe(0);
        const protocol = reader.varint();
        const writer = new BinWriter();
        writer.variant(0);
        writer.varint(protocol);
        writer.varint(1);
        writer.option<string>(undefined, (value) => writer.string(value));
        socket.write(encodeFrame(writer.toBuffer()));
      });
    }),
    renderPath,
  );
  return {
    id,
    label: id.toUpperCase(),
    type: "local",
    control_socket_path: controlPath,
    client_socket_path: renderPath,
    auto_connect: false,
  };
}

function bridgeListeningPort(stream: ReadableStream<Uint8Array>) {
  let settled = false;
  let resolvePort!: (port: number) => void;
  let rejectPort!: (error: Error) => void;
  const port = new Promise<number>((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        const match = output.match(
          /\[bridge\] listening on http:\/\/.*:(\d+)\s+\(ws \/ws\)/,
        );
        if (match && !settled) {
          settled = true;
          resolvePort(Number(match[1]));
        }
        if (output.length > 16_384) output = output.slice(-8_192);
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectPort(error as Error);
      }
    } finally {
      reader.releaseLock();
      if (!settled) {
        settled = true;
        rejectPort(new Error("bridge exited before reporting its port"));
      }
    }
  })();
  return port;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // Process may still be binding.
    }
    await Bun.sleep(25);
  }
  throw new Error("profile process fixture did not become healthy");
}

test("production dispatcher isolates two local profiles and profile CRUD", async () => {
  if (process.platform === "win32") return;
  const root = join(
    tmpdir(),
    `herdr-gui-profile-process-${crypto.randomUUID()}`,
  );
  roots.push(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const alpha = await fakeHerdr(root, "alpha");
  const beta = await fakeHerdr(root, "beta");
  const registryPath = join(root, "connections.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      default_connection_id: "alpha",
      profiles: [alpha, beta],
    }),
    { mode: 0o600 },
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "0",
    HERDR_GUI_CONNECTIONS_PATH: registryPath,
  };
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_CLIENT_SOCKET_PATH;
  delete env.HERDR_SSH_HOST;
  delete env.HERDR_SESSION;
  const repositoryRoot = join(import.meta.dir, "../../..");
  const child = Bun.spawn(["bun", "server/src/index.ts"], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  let wsA: WebSocket | null = null;
  let wsB: WebSocket | null = null;
  try {
    const port = await bridgeListeningPort(child.stdout);
    await waitForHealth(port);
    const openBrowser = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("websocket open failed"));
      });
      return socket;
    };
    wsA = await openBrowser();
    wsB = await openBrowser();
    const rpcFor = (socket: WebSocket, prefix: string) => {
      let sequence = 0;
      const pending = new Map<string, (message: any) => void>();
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (typeof message.id === "string") pending.get(message.id)?.(message);
      };
      const raw = async (
        method: string,
        params: Record<string, unknown> = {},
        connectionId?: string,
        connectionGeneration?: number,
      ) => {
        const id = `${prefix}${++sequence}`;
        let timer!: ReturnType<typeof setTimeout>;
        const reply = new Promise<any>((resolve, reject) => {
          pending.set(id, resolve);
          timer = setTimeout(
            () => reject(new Error(`RPC timeout: ${method}`)),
            5_000,
          );
        });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(connectionId ? { connection_id: connectionId } : {}),
            ...(connectionGeneration === undefined
              ? {}
              : { connection_generation: connectionGeneration }),
          }),
        );
        const message = await reply.finally(() => clearTimeout(timer));
        pending.delete(id);
        return message;
      };
      const rpc = async (
        method: string,
        params: Record<string, unknown> = {},
        connectionId?: string,
        connectionGeneration?: number,
      ) => {
        const message = await raw(
          method,
          params,
          connectionId,
          connectionGeneration,
        );
        if (message.error) throw new Error(message.error.message);
        return message.result;
      };
      return { raw, rpc };
    };
    const browserA = rpcFor(wsA, "a");
    const browserB = rpcFor(wsB, "b");
    const rpc = browserA.rpc;

    const catalog = await rpc("connections.list");
    expect(catalog.default_connection_id).toBe("alpha");
    expect(catalog.connections.map(({ id }: { id: string }) => id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect((await rpc("bridge.status")).connections[0]).toMatchObject({
      id: "alpha",
      type: "local",
      read_only: false,
      auto_connect: false,
      control_socket_path: alpha.control_socket_path,
      client_socket_path: alpha.client_socket_path,
    });
    const oldAlphaGeneration = catalog.connections.find(
      ({ id }: { id: string }) => id === "alpha",
    ).generation as number;
    const browserBCatalog = await browserB.rpc("connections.list");
    expect(
      browserBCatalog.connections.find(
        ({ id }: { id: string }) => id === "alpha",
      ).generation,
    ).toBe(oldAlphaGeneration);
    const initialAlpha = await browserA.raw(
      "workspace.list",
      {},
      "alpha",
      oldAlphaGeneration,
    );
    expect(initialAlpha.connection_generation).toBe(oldAlphaGeneration);
    expect(initialAlpha.result.workspaces[0].name).toBe("from-alpha");
    expect((await rpc("connections.test", { id: "beta" })).version).toBe(
      "fake-beta",
    );
    await rpc("connections.connect", { id: "beta" });
    const connectedCatalog = await rpc("connections.list");
    const betaGeneration = connectedCatalog.connections.find(
      ({ id }: { id: string }) => id === "beta",
    ).generation as number;
    expect(
      (await rpc("workspace.list", {}, "beta", betaGeneration)).workspaces[0]
        .name,
    ).toBe("from-beta");

    const replacementAlpha = {
      ...beta,
      id: "alpha",
      label: "ALPHA on beta server",
      auto_connect: false,
    };
    await browserB.rpc("connections.update", {
      id: "alpha",
      profile: replacementAlpha,
    });
    const replacedCatalog = await browserB.rpc("connections.list");
    const newAlphaGeneration = replacedCatalog.connections.find(
      ({ id }: { id: string }) => id === "alpha",
    ).generation as number;
    expect(newAlphaGeneration).not.toBe(oldAlphaGeneration);

    const betaPaneCloseCalls = () =>
      (controlCalls.get("beta") ?? []).filter(
        (method) => method === "pane.close",
      ).length;
    const beforeStalePaneClose = betaPaneCloseCalls();
    const staleAction = await browserA.raw(
      "pane.close",
      { pane_id: "shared-pane" },
      "alpha",
      oldAlphaGeneration,
    );
    expect(staleAction).toMatchObject({
      connection_id: "alpha",
      connection_generation: oldAlphaGeneration,
      error: { message: "connection generation changed: alpha" },
    });
    expect(betaPaneCloseCalls()).toBe(beforeStalePaneClose);

    const betaPingCalls = () =>
      (controlCalls.get("beta") ?? []).filter((method) => method === "ping")
        .length;
    const beforeStaleHttp = betaPingCalls();
    const staleHttp = await fetch(
      `http://127.0.0.1:${port}/api/connections/alpha/herdr-info?connection_generation=${oldAlphaGeneration}`,
    );
    expect(staleHttp.status).toBe(409);
    expect(staleHttp.headers.get("X-Herdr-Connection-Id")).toBe("alpha");
    expect(staleHttp.headers.get("X-Herdr-Connection-Generation")).toBe(
      String(oldAlphaGeneration),
    );
    expect(betaPingCalls()).toBe(beforeStaleHttp);

    // Explicitly retain old-client compatibility for both RPC and HTTP while
    // proving generation-bound current requests reach only the replacement.
    expect(
      (await browserA.rpc("workspace.list", {}, "alpha")).workspaces[0].name,
    ).toBe("from-beta");
    const legacyHttp = await fetch(
      `http://127.0.0.1:${port}/api/connections/alpha/herdr-info`,
    );
    expect(legacyHttp.status).toBe(200);
    expect(legacyHttp.headers.get("X-Herdr-Connection-Generation")).toBe(
      String(newAlphaGeneration),
    );
    expect(await legacyHttp.json()).toMatchObject({ version: "fake-beta" });
    expect(betaPingCalls()).toBe(beforeStaleHttp + 1);
    const currentAlpha = await browserB.raw(
      "workspace.list",
      {},
      "alpha",
      newAlphaGeneration,
    );
    expect(currentAlpha.connection_generation).toBe(newAlphaGeneration);
    expect(currentAlpha.result.workspaces[0].name).toBe("from-beta");

    const gamma = {
      ...alpha,
      id: "gamma",
      label: "GAMMA",
      auto_connect: false,
    };
    await rpc("connections.create", { profile: gamma });
    await rpc("connections.update", {
      id: "gamma",
      profile: { ...gamma, label: "Gamma edited" },
    });
    await rpc("connections.remove", { id: "gamma" });

    await rpc("connections.disconnect", { id: "alpha" });
    await rpc("connections.set_default", { id: "beta" });
    expect((await rpc("workspace.list")).workspaces[0].name).toBe("from-beta");
    await rpc("connections.remove", { id: "alpha" });
    const finalCatalog = await rpc("connections.list");
    expect(finalCatalog.default_connection_id).toBe("beta");
    expect(
      finalCatalog.connections.map(({ id }: { id: string }) => id),
    ).toEqual(["beta"]);
  } finally {
    wsA?.close();
    wsB?.close();
    child.kill("SIGTERM");
    await child.exited;
  }
}, 20_000);
