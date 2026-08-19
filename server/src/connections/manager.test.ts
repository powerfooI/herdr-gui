import { describe, expect, test } from "bun:test";
import {
  ConnectionManager,
  type ConnectionRuntime,
  type ConnectionRuntimeContext,
  sanitizeConnectionError,
} from "./manager";
import type { ConnectionIdentity, ConnectionStatus } from "./types";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function identity(id: string): ConnectionIdentity {
  return { id, label: id, source: "test" };
}

type FakeRuntime = ConnectionRuntime & {
  starts: number;
  backgrounds: number;
  stops: number;
  context: ConnectionRuntimeContext;
};

function fakeFactory(
  id: string,
  options: {
    transport?: Promise<void>;
    stop?: Promise<void>;
    backgroundError?: Error;
    onCreate?: (runtime: FakeRuntime) => void;
  } = {},
) {
  return (context: ConnectionRuntimeContext): FakeRuntime => {
    const runtime: FakeRuntime = {
      identity: identity(id),
      starts: 0,
      backgrounds: 0,
      stops: 0,
      context,
      async startTransport() {
        runtime.starts += 1;
        await options.transport;
      },
      startBackground() {
        runtime.backgrounds += 1;
        if (options.backgroundError) throw options.backgroundError;
      },
      async stop() {
        runtime.stops += 1;
        await options.stop;
      },
    };
    options.onCreate?.(runtime);
    return runtime;
  };
}

describe("connection manager", () => {
  test("resolves one stable default without constructing it during registration", () => {
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default"),
    });
    manager.register({
      identity: identity("other"),
      createRuntime: fakeFactory("other"),
    });

    expect(manager.defaultId()).toBe("default");
    expect(manager.defaultRuntime()).toBeNull();
    expect(manager.list()).toEqual([
      {
        id: "default",
        label: "default",
        source: "test",
        is_default: true,
        state: "disconnected",
        generation: 0,
      },
      {
        id: "other",
        label: "other",
        source: "test",
        is_default: false,
        state: "disconnected",
        generation: 0,
      },
    ]);
  });

  test("changes default only to a registered non-removing connection", async () => {
    const states: Array<{ id: string; isDefault: boolean }> = [];
    const manager = new ConnectionManager<FakeRuntime>("default", (status) => {
      states.push({ id: status.id, isDefault: status.is_default });
    });
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default"),
    });
    manager.register({
      identity: identity("other"),
      createRuntime: fakeFactory("other"),
    });

    manager.setDefault("other");
    expect(manager.defaultId()).toBe("other");
    expect(manager.status("default").is_default).toBeFalse();
    expect(manager.status("other").is_default).toBeTrue();
    expect(() => manager.setDefault("missing")).toThrow("unknown connection");
    expect(states.slice(-2)).toEqual([
      { id: "default", isDefault: false },
      { id: "other", isDefault: true },
    ]);
  });

  test("unregister drains a non-default runtime and prevents racing restarts", async () => {
    const stop = deferred();
    let runtime: FakeRuntime | undefined;
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default"),
    });
    manager.register({
      identity: identity("other"),
      createRuntime: fakeFactory("other", {
        stop: stop.promise,
        onCreate: (created) => {
          runtime = created;
        },
      }),
    });
    await manager.start("other");

    const removing = manager.unregister("other");
    await expect(manager.start("other")).rejects.toThrow("being removed");
    expect(runtime?.stops).toBe(1);
    stop.resolve();
    await removing;
    expect(manager.has("other")).toBeFalse();
    expect(() => manager.status("other")).toThrow("unknown connection");
    await expect(manager.unregister("default")).rejects.toThrow(
      "cannot remove the default connection",
    );
  });

  test("unregister removes a factory even when runtime cleanup fails", async () => {
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default"),
    });
    manager.register({
      identity: identity("other"),
      createRuntime: fakeFactory("other", {
        stop: Promise.reject(new Error("cleanup failed")),
      }),
    });
    await manager.start("other");

    await expect(manager.unregister("other")).resolves.toBeUndefined();
    expect(manager.has("other")).toBeFalse();
    expect(() => manager.start("other")).toThrow("unknown connection");
  });

  test("shares concurrent starts and begins background work after transport", async () => {
    const transport = deferred();
    const runtimes: FakeRuntime[] = [];
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        transport: transport.promise,
        onCreate: (runtime) => runtimes.push(runtime),
      }),
    });

    const first = manager.startDefault();
    const second = manager.startDefault();
    expect(first).toBe(second);
    expect(manager.status("default").state).toBe("connecting");
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.backgrounds).toBe(0);
    expect(manager.defaultReadyRuntime()).toBeNull();

    transport.resolve();
    await first;
    expect(runtimes[0]?.starts).toBe(1);
    expect(runtimes[0]?.backgrounds).toBe(1);
    expect(manager.defaultReadyRuntime()).toBe(runtimes[0]);
    expect(manager.status("default")).toMatchObject({
      state: "ready",
      generation: 1,
    });
  });

  test("invalidates ready-runtime leases across same-id replacement", async () => {
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default"),
    });
    await manager.startDefault();
    const lease = manager.readyRuntimeLease("default");
    expect(lease).not.toBeNull();
    expect(lease?.isCurrent()).toBe(true);

    await manager.replace({
      identity: identity("default"),
      createRuntime: fakeFactory("default"),
    });
    expect(lease?.isCurrent()).toBe(false);
  });

  test("isolates a failed connection and exposes only sanitized status errors", async () => {
    const manager = new ConnectionManager<FakeRuntime>("good");
    manager.register({
      identity: identity("good"),
      createRuntime: fakeFactory("good"),
    });
    manager.register({
      identity: identity("bad"),
      createRuntime: fakeFactory("bad", {
        transport: Promise.reject(
          new Error("token=secret https://user:pass@example.test failed"),
        ),
      }),
    });

    const [good, bad] = await Promise.allSettled([
      manager.start("good"),
      manager.start("bad"),
    ]);
    expect(good.status).toBe("fulfilled");
    expect(bad.status).toBe("rejected");
    expect(manager.status("good").state).toBe("ready");
    expect(manager.status("bad")).toMatchObject({
      state: "error",
      error: {
        message: "token=*** https://***@example.test failed",
      },
    });
  });

  test("redacts common credential forms and bounds public errors", () => {
    expect(
      sanitizeConnectionError(
        'Authorization: Bearer bearer-secret password: colon-secret {"token":"json-secret"} api_key=key-secret',
      ),
    ).toBe('Authorization: Bearer *** password: *** {"token":***} api_key=***');
    expect(
      sanitizeConnectionError(
        "https://user:pass@example.test refresh-token='refresh-secret' failed",
      ),
    ).toBe("https://***@example.test refresh-token=*** failed");
    expect(sanitizeConnectionError("bad\u001b[31m\nvalue\0")).toBe("bad value");
    expect(sanitizeConnectionError("x".repeat(400))).toHaveLength(300);
  });

  test("cleans runtimes whose transport or background startup fails", async () => {
    for (const failurePoint of ["transport", "background"] as const) {
      let runtime: FakeRuntime | undefined;
      const manager = new ConnectionManager<FakeRuntime>("default");
      manager.register({
        identity: identity("default"),
        createRuntime: fakeFactory("default", {
          ...(failurePoint === "transport"
            ? { transport: Promise.reject(new Error("transport failed")) }
            : { backgroundError: new Error("background failed") }),
          onCreate: (created) => {
            runtime = created;
          },
        }),
      });

      await expect(manager.startDefault()).rejects.toThrow(
        `${failurePoint} failed`,
      );
      expect(runtime?.stops).toBe(1);
      expect(manager.defaultRuntime()).toBeNull();
      expect(manager.defaultReadyRuntime()).toBeNull();
      expect(manager.status("default")).toMatchObject({
        state: "error",
        error: { message: `${failurePoint} failed` },
      });
    }
  });

  test("cleans a runtime whose identity does not match its entry", async () => {
    let runtime: FakeRuntime | undefined;
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("wrong", {
        onCreate: (created) => {
          runtime = created;
        },
      }),
    });

    await expect(manager.startDefault()).rejects.toThrow(
      "runtime identity mismatch: expected default, received wrong",
    );
    expect(runtime?.stops).toBe(1);
    expect(manager.defaultRuntime()).toBeNull();
    expect(manager.status("default").state).toBe("error");
  });

  test("publishes deterministic lifecycle transitions", async () => {
    const states: string[] = [];
    const manager = new ConnectionManager<FakeRuntime>("default", (status) => {
      states.push(status.state);
    });
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default"),
    });

    await manager.startDefault();
    await manager.stop("default");
    expect(states).toEqual([
      "disconnected",
      "connecting",
      "ready",
      "stopping",
      "disconnected",
    ]);
  });

  test("serializes a reentrant stop requested by the connecting observer", async () => {
    const runtimes: FakeRuntime[] = [];
    let stopping: Promise<void> | null = null;
    function stopWhenConnecting(status: ConnectionStatus) {
      if (status.state === "connecting" && !stopping) {
        stopping = manager.stop("default");
      }
    }
    const manager = new ConnectionManager<FakeRuntime>(
      "default",
      stopWhenConnecting,
    );
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        onCreate: (runtime) => runtimes.push(runtime),
      }),
    });

    await manager.startDefault();
    await stopping;

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].starts).toBe(1);
    expect(runtimes[0].backgrounds).toBe(0);
    expect(runtimes[0].stops).toBe(1);
    expect(manager.defaultRuntime()).toBeNull();
    expect(manager.status("default").state).toBe("disconnected");
  });

  test("queues a reentrant start requested by the stopping observer", async () => {
    const oldStop = deferred();
    const runtimes: FakeRuntime[] = [];
    let restarting: Promise<void> | null = null;
    function restartWhenStopping(status: ConnectionStatus) {
      if (status.state === "stopping" && !restarting) {
        restarting = manager.start("default");
      }
    }
    const manager = new ConnectionManager<FakeRuntime>(
      "default",
      restartWhenStopping,
    );
    manager.register({
      identity: identity("default"),
      createRuntime: (context) =>
        fakeFactory("default", {
          ...(runtimes.length === 0 ? { stop: oldStop.promise } : {}),
          onCreate: (runtime) => runtimes.push(runtime),
        })(context),
    });
    await manager.startDefault();

    const stopping = manager.stop("default");
    expect(restarting).not.toBeNull();
    oldStop.resolve();
    await stopping;
    await restarting;

    expect(runtimes).toHaveLength(2);
    expect(runtimes[0].stops).toBe(1);
    expect(manager.defaultReadyRuntime()).toBe(runtimes[1]);
    expect(manager.status("default").state).toBe("ready");
  });

  test("shares concurrent stop tasks and drains the runtime once", async () => {
    const stop = deferred();
    let runtime: FakeRuntime | undefined;
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        stop: stop.promise,
        onCreate: (created) => {
          runtime = created;
        },
      }),
    });
    await manager.startDefault();

    const first = manager.stop("default");
    const second = manager.stop("default");
    expect(first).toBe(second);
    expect(manager.status("default").state).toBe("stopping");
    expect(runtime?.stops).toBe(1);
    stop.resolve();
    await first;
    expect(manager.status("default").state).toBe("disconnected");
    expect(manager.defaultRuntime()).toBeNull();
  });

  test("queues a restart behind stop while initial transport is pending", async () => {
    const transport = deferred();
    const runtimes: FakeRuntime[] = [];
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        transport: transport.promise,
        onCreate: (runtime) => runtimes.push(runtime),
      }),
    });

    const initialStart = manager.startDefault();
    const stopping = manager.stop("default");
    const restarting = manager.startDefault();
    expect(restarting).not.toBe(initialStart);
    transport.resolve();
    await Promise.all([initialStart, stopping, restarting]);

    expect(runtimes).toHaveLength(2);
    expect(runtimes[0].stops).toBe(1);
    expect(manager.defaultRuntime()).toBe(runtimes[1]);
    expect(manager.defaultReadyRuntime()).toBe(runtimes[1]);
    expect(manager.status("default").state).toBe("ready");
  });

  test("runtime failure immediately invalidates its generation and reports reconnecting", async () => {
    const runtimes: FakeRuntime[] = [];
    const statuses: ConnectionStatus[] = [];
    const manager = new ConnectionManager<FakeRuntime>("default", (status) =>
      statuses.push(status),
    );
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        onCreate: (runtime) => runtimes.push(runtime),
      }),
    });
    await manager.startDefault();
    const lease = manager.readyRuntimeLease("default")!;
    const readyGeneration = lease.generation;

    runtimes[0].context.reportError(new Error("tunnel exited"), {
      reconnecting: true,
    });

    expect(lease.isCurrent()).toBeFalse();
    expect(runtimes[0].context.isCurrent()).toBeFalse();
    expect(manager.status("default")).toMatchObject({
      state: "reconnecting",
      generation: readyGeneration + 1,
      error: { message: "tunnel exited" },
    });
    expect(manager.markReconnecting("default", new Error("retry queued"))).toBe(
      true,
    );
    expect(statuses.at(-1)).toMatchObject({
      state: "reconnecting",
      error: { message: "retry queued" },
    });
    await manager.retireFailedRuntime("default");
    expect(runtimes[0].stops).toBe(1);
    expect(manager.currentRuntime("default")).toBeNull();
    expect(manager.status("default").state).toBe("reconnecting");
  });

  test("does not resurrect a runtime when stop cancels a reconnect", async () => {
    const stop = deferred();
    const runtimes: FakeRuntime[] = [];
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        stop: stop.promise,
        onCreate: (runtime) => runtimes.push(runtime),
      }),
    });
    await manager.startDefault();
    runtimes[0]?.context.reportError(new Error("retry requested"));
    expect(manager.defaultReadyRuntime()).toBeNull();

    const reconnect = manager.startDefault();
    const stopping = manager.stop("default");
    stop.resolve();
    await Promise.all([reconnect, stopping]);

    expect(runtimes).toHaveLength(1);
    expect(manager.defaultRuntime()).toBeNull();
    expect(manager.status("default").state).toBe("disconnected");
  });

  test("a queued restart constructs the replacement factory", async () => {
    const oldStop = deferred();
    const oldRuntimes: FakeRuntime[] = [];
    const replacementRuntimes: FakeRuntime[] = [];
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        stop: oldStop.promise,
        onCreate: (runtime) => oldRuntimes.push(runtime),
      }),
    });
    await manager.startDefault();

    const stopping = manager.stop("default");
    const restarting = manager.startDefault();
    const replacing = manager.replace({
      identity: { ...identity("default"), label: "replacement" },
      createRuntime: fakeFactory("default", {
        onCreate: (runtime) => replacementRuntimes.push(runtime),
      }),
    });
    oldStop.resolve();
    await Promise.all([stopping, restarting, replacing]);

    expect(oldRuntimes).toHaveLength(1);
    expect(replacementRuntimes).toHaveLength(1);
    expect(manager.defaultRuntime()).toBe(replacementRuntimes[0]);
    expect(manager.defaultReadyRuntime()).toBe(replacementRuntimes[0]);
    expect(manager.status("default")).toMatchObject({
      label: "replacement",
      state: "ready",
    });
  });

  test("suppresses stale generation reports across replacement", async () => {
    let retired: FakeRuntime | undefined;
    let replacement: FakeRuntime | undefined;
    const manager = new ConnectionManager<FakeRuntime>("default");
    manager.register({
      identity: identity("default"),
      createRuntime: fakeFactory("default", {
        onCreate: (runtime) => {
          retired = runtime;
        },
      }),
    });
    await manager.startDefault();
    expect(retired?.context.isCurrent()).toBeTrue();

    await manager.replace({
      identity: { ...identity("default"), label: "replacement" },
      createRuntime: fakeFactory("default", {
        onCreate: (runtime) => {
          replacement = runtime;
        },
      }),
    });
    retired?.context.reportError(new Error("stale secret"));
    expect(retired?.context.isCurrent()).toBeFalse();
    expect(manager.status("default")).toMatchObject({
      label: "replacement",
      state: "disconnected",
    });
    expect(manager.status("default").error).toBeUndefined();

    await manager.startDefault();
    expect(replacement?.context.isCurrent()).toBeTrue();
    retired?.context.reportError(new Error("still stale"));
    expect(manager.status("default").state).toBe("ready");
  });

  test("records synchronous runtime stop failures without blocking peers", async () => {
    let secondStops = 0;
    const manager = new ConnectionManager<ConnectionRuntime>("first");
    manager.register({
      identity: identity("first"),
      createRuntime: () => ({
        identity: identity("first"),
        async startTransport() {},
        startBackground() {},
        stop() {
          throw new Error("synchronous stop failure");
        },
      }),
    });
    manager.register({
      identity: identity("second"),
      createRuntime: () => ({
        identity: identity("second"),
        async startTransport() {},
        startBackground() {},
        async stop() {
          secondStops += 1;
        },
      }),
    });
    await Promise.all([manager.start("first"), manager.start("second")]);

    await manager.stopAll();
    expect(secondStops).toBe(1);
    expect(manager.currentRuntimes()).toEqual([]);
    expect(manager.status("first")).toMatchObject({
      state: "error",
      error: { message: "synchronous stop failure" },
    });
    expect(manager.status("second").state).toBe("disconnected");
  });

  test("rejects reentrant starts before shutdown publishes stopping", async () => {
    let reentrantStart: Promise<void> | null = null;
    function startPeerWhenStopping(status: ConnectionStatus) {
      if (status.id === "first" && status.state === "stopping") {
        reentrantStart = manager.start("second");
      }
    }
    const manager = new ConnectionManager<FakeRuntime>(
      "first",
      startPeerWhenStopping,
    );
    for (const id of ["first", "second"]) {
      manager.register({
        identity: identity(id),
        createRuntime: fakeFactory(id),
      });
      await manager.start(id);
    }

    await manager.stopAll();

    expect(reentrantStart).not.toBeNull();
    await expect(reentrantStart!).rejects.toThrow(
      "connection manager is stopping",
    );
    expect(manager.currentRuntimes()).toEqual([]);
  });

  test("stops every current runtime exactly once during manager shutdown", async () => {
    const runtimes: FakeRuntime[] = [];
    const manager = new ConnectionManager<FakeRuntime>("first");
    for (const id of ["first", "second"]) {
      manager.register({
        identity: identity(id),
        createRuntime: fakeFactory(id, {
          onCreate: (runtime) => runtimes.push(runtime),
        }),
      });
      await manager.start(id);
    }

    const first = manager.stopAll();
    const second = manager.stopAll();
    expect(first).toBe(second);
    await first;
    expect(runtimes.map((runtime) => runtime.stops)).toEqual([1, 1]);
    expect(manager.currentRuntimes()).toEqual([]);
    expect(manager.list().map((status) => status.state)).toEqual([
      "disconnected",
      "disconnected",
    ]);
    expect(() =>
      manager.register({
        identity: identity("late"),
        createRuntime: fakeFactory("late"),
      }),
    ).toThrow("connection manager is stopping");
  });
});
