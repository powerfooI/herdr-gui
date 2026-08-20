import { afterEach, expect, test } from "bun:test";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { HerdrClient } from "../bridge/herdr-client";
import {
  agentPaneIdsFromPaneList,
  createAgentStatusSubscriptionLoop,
  samePaneIds,
} from "./agent-status-subscription";

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const paths: string[] = [];

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
  for (const path of paths.splice(0)) {
    try {
      await import("node:fs").then((fs) => fs.unlinkSync(path));
    } catch {
      // The socket path is already gone.
    }
  }
});

type SubscribeCall = {
  subscriptions: Array<{ type: string; pane_id?: string }>;
  socket: net.Socket;
  suppressAck?: boolean;
};

function fakeHerdr(options: {
  panes: () => unknown[];
  ackSubscribe?: (call: SubscribeCall) => void;
  deferLists?: () => boolean;
}) {
  const path = join(
    tmpdir(),
    `agent-status-test-${randomBytes(4).toString("hex")}.sock`,
  );
  paths.push(path);
  const subscribeCalls: SubscribeCall[] = [];
  const deferredLists: Array<() => void> = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      if (request.method === "pane.list") {
        const respond = () => {
          socket.write(
            `${JSON.stringify({ id: request.id, result: { panes: options.panes() } })}\n`,
          );
          socket.end();
        };
        if (options.deferLists?.()) {
          deferredLists.push(respond);
          return;
        }
        respond();
        return;
      }
      if (request.method === "events.subscribe") {
        const call: SubscribeCall = {
          subscriptions: request.params?.subscriptions ?? [],
          socket,
        };
        subscribeCalls.push(call);
        options.ackSubscribe?.(call);
        if (!call.suppressAck) {
          socket.write(
            `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
          );
        }
        return;
      }
      socket.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      socket.end();
    });
  });
  servers.push(server);
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, ready, subscribeCalls, deferredLists };
}

function pushStatusEvent(call: SubscribeCall, paneId: string, status: string) {
  call.socket.write(
    `${JSON.stringify({
      event: "pane.agent_status_changed",
      data: {
        pane_id: paneId,
        workspace_id: "w1",
        agent_status: status,
        agent: "pi",
      },
    })}\n`,
  );
}

function agentPane(paneId: string, agent = "pi") {
  return { pane_id: paneId, agent, agent_status: "idle" };
}

function plainPane(paneId: string) {
  return { pane_id: paneId, agent_status: "unknown" };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met before the timeout");
}

test("collects sorted pane ids that currently host an agent", () => {
  expect(
    agentPaneIdsFromPaneList({
      panes: [
        agentPane("w1:p2"),
        plainPane("w1:p1"),
        agentPane("w1:p1", ""),
        agentPane("w1:p3", "pi"),
        { pane_id: 7, agent: "pi" },
        "junk",
        agentPane("w1:p2", "pi"),
      ],
    }),
  ).toEqual(["w1:p2", "w1:p3"]);
  expect(agentPaneIdsFromPaneList({})).toEqual([]);
  expect(agentPaneIdsFromPaneList(null)).toEqual([]);
  expect(samePaneIds(["a", "b"], ["a", "b"])).toBe(true);
  expect(samePaneIds(["a", "b"], ["b", "a"])).toBe(false);
  expect(samePaneIds(["a"], ["a", "b"])).toBe(false);
});

test("subscribes per agent pane and forwards status events", async () => {
  const herdr = fakeHerdr({
    panes: () => [agentPane("w1:p1"), plainPane("w1:p2")],
  });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const events: unknown[] = [];
  client.on("event", (event) => events.push(event));
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 50,
  });

  loop.start();
  await waitFor(() => herdr.subscribeCalls.length === 1);
  expect(herdr.subscribeCalls[0]?.subscriptions).toEqual([
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
  ]);

  pushStatusEvent(herdr.subscribeCalls[0]!, "w1:p1", "working");
  await waitFor(() => events.length === 1);
  expect(events[0]).toMatchObject({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", agent_status: "working" },
  });

  await loop.stop();
  expect(loop.isRunning()).toBe(false);
});

test("rebuilds the subscription when a membership event changes the pane set", async () => {
  let panes = [agentPane("w1:p1")];
  const herdr = fakeHerdr({ panes: () => panes });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 10_000,
  });

  loop.start();
  await waitFor(() => herdr.subscribeCalls.length === 1);

  panes = [agentPane("w1:p1"), agentPane("w1:p2")];
  loop.handleHerdrEvent({
    event: "pane_agent_detected",
    data: { type: "pane_agent_detected" },
  });
  await waitFor(() => herdr.subscribeCalls.length === 2);
  expect(herdr.subscribeCalls[1]?.subscriptions).toEqual([
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    { type: "pane.agent_status_changed", pane_id: "w1:p2" },
  ]);

  panes = [agentPane("w1:p2")];
  loop.handleHerdrEvent({
    event: "workspace_closed",
    data: { type: "workspace_closed" },
  });
  await waitFor(() => herdr.subscribeCalls.length === 3);
  expect(herdr.subscribeCalls[2]?.subscriptions).toEqual([
    { type: "pane.agent_status_changed", pane_id: "w1:p2" },
  ]);

  await loop.stop();
});

test("ignores unrelated events and membership events that do not change the set", async () => {
  const herdr = fakeHerdr({ panes: () => [agentPane("w1:p1")] });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 10_000,
  });

  loop.start();
  await waitFor(() => herdr.subscribeCalls.length === 1);

  loop.handleHerdrEvent({
    event: "pane_focused",
    data: { type: "pane_focused" },
  });
  loop.handleHerdrEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1" },
  });
  loop.handleHerdrEvent({
    event: "pane_closed",
    data: { type: "pane_closed", pane_id: "w1:p9" },
  });
  await Bun.sleep(100);
  expect(herdr.subscribeCalls.length).toBe(1);

  await loop.stop();
});

test("retries with a fresh listing when herdr rejects the subscription", async () => {
  const herdr = fakeHerdr({
    panes: () => [agentPane("w1:p1")],
    ackSubscribe: (call) => {
      if (herdr.subscribeCalls.length === 1) {
        call.suppressAck = true;
        call.socket.write(
          `${JSON.stringify({ id: "sub", error: { message: "pane not found" } })}\n`,
        );
        call.socket.end();
      }
    },
  });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const errors: string[] = [];
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    onSubscribeError: (error) => errors.push(error.message),
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 10_000,
  });

  loop.start();
  await waitFor(() => herdr.subscribeCalls.length === 2);
  expect(errors).toEqual(["pane not found"]);

  await loop.stop();
});

test("waits for an agent pane before subscribing", async () => {
  let panes: unknown[] = [plainPane("w1:p1")];
  const herdr = fakeHerdr({ panes: () => panes });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 10_000,
  });

  loop.start();
  await Bun.sleep(50);
  expect(herdr.subscribeCalls.length).toBe(0);

  panes = [agentPane("w1:p1")];
  loop.handleHerdrEvent({
    event: "pane_agent_detected",
    data: { type: "pane_agent_detected" },
  });
  await waitFor(() => herdr.subscribeCalls.length === 1);

  await loop.stop();
});

test("resubscribes when the subscription socket closes", async () => {
  const herdr = fakeHerdr({ panes: () => [agentPane("w1:p1")] });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 10_000,
  });

  loop.start();
  await waitFor(() => herdr.subscribeCalls.length === 1);
  herdr.subscribeCalls[0]?.socket.destroy();
  await waitFor(() => herdr.subscribeCalls.length === 2);

  await loop.stop();
});

test("honors a rebuild requested while a listing was in flight", async () => {
  let panes: unknown[] = [];
  let defer = true;
  const herdr = fakeHerdr({ panes: () => panes, deferLists: () => defer });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    retryDelayMs: 10,
    rebuildDebounceMs: 0,
    membershipPollMs: 10_000,
  });

  loop.start();
  // The first listing is now in flight and held by the fake server. The
  // membership event's debounce wake fires while no waiter is registered.
  await waitFor(() => herdr.deferredLists.length === 1);
  loop.handleHerdrEvent({
    event: "pane_agent_detected",
    data: { type: "pane_agent_detected" },
  });
  await Bun.sleep(20);
  // The listing snapshot predates the agent, but the rebuild request must not
  // stall until the fallback poll: the loop must re-list immediately.
  defer = false;
  herdr.deferredLists.shift()?.();
  panes = [agentPane("w1:p1")];
  await waitFor(() => herdr.subscribeCalls.length === 1);
  expect(herdr.subscribeCalls[0]?.subscriptions).toEqual([
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
  ]);

  await loop.stop();
});

test("recovers when subscribe throws synchronously", async () => {
  const herdr = fakeHerdr({ panes: () => [agentPane("w1:p1")] });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  let thrown = false;
  const flaky = {
    call: (method: string, params: Record<string, unknown>, timeout?: number) =>
      client.call(method, params, timeout),
    subscribe: (
      types: Parameters<HerdrClient["subscribe"]>[0],
      ackTimeoutMs?: number,
    ) => {
      if (!thrown) {
        thrown = true;
        throw new Error("boom");
      }
      return client.subscribe(types, ackTimeoutMs);
    },
  } as unknown as HerdrClient;
  const errors: string[] = [];
  const loop = createAgentStatusSubscriptionLoop({
    herdr: flaky,
    connectionId: "test",
    onSubscribeError: (error) => errors.push(error.message),
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 10_000,
  });

  loop.start();
  await waitFor(() => herdr.subscribeCalls.length === 1);
  expect(errors).toEqual(["boom"]);
  expect(loop.isRunning()).toBe(true);

  await loop.stop();
});

test("stop is idempotent and closes the active subscription", async () => {
  const herdr = fakeHerdr({ panes: () => [agentPane("w1:p1")] });
  await herdr.ready;
  const client = new HerdrClient(herdr.path);
  const loop = createAgentStatusSubscriptionLoop({
    herdr: client,
    connectionId: "test",
    retryDelayMs: 10,
    rebuildDebounceMs: 5,
    membershipPollMs: 10_000,
  });

  loop.start();
  await waitFor(() => herdr.subscribeCalls.length === 1);
  const activeSocket = herdr.subscribeCalls[0]?.socket;
  let activeClosed = false;
  activeSocket?.on("close", () => {
    activeClosed = true;
  });
  await Promise.all([loop.stop(), loop.stop()]);
  expect(loop.isRunning()).toBe(false);
  await waitFor(() => activeClosed);

  const calls = herdr.subscribeCalls.length;
  await Bun.sleep(50);
  expect(herdr.subscribeCalls.length).toBe(calls);
});
