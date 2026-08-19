import type {
  ConnectionId,
  ConnectionIdentity,
  ConnectionState,
  ConnectionStatus,
} from "./types";

export interface ConnectionRuntime {
  identity: ConnectionIdentity;
  startTransport(): Promise<void>;
  startBackground(): void | Promise<void>;
  stop(): Promise<void>;
}

export type ConnectionRuntimeContext = {
  generation: number;
  isCurrent(): boolean;
  reportError(error: unknown, options?: { reconnecting?: boolean }): void;
};

export type ConnectionRuntimeFactory<Runtime extends ConnectionRuntime> = (
  context: ConnectionRuntimeContext,
) => Runtime;

export type ReadyRuntimeLease<Runtime extends ConnectionRuntime> = {
  connectionId: ConnectionId;
  generation: number;
  runtime: Runtime;
  isCurrent(): boolean;
};

type ConnectionEntry<Runtime extends ConnectionRuntime> = {
  identity: ConnectionIdentity;
  createRuntime: ConnectionRuntimeFactory<Runtime>;
  generation: number;
  state: ConnectionState;
  error?: { message: string };
  runtime: Runtime | null;
  startToken: symbol | null;
  startTask: Promise<void> | null;
  stopTask: Promise<void> | null;
};

const MAX_STATUS_ERROR_LENGTH = 300;

function reportConnectionManagerError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function deferredTask<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((taskResolve, taskReject) => {
    resolve = taskResolve;
    reject = taskReject;
  });
  return { promise, resolve, reject };
}

export function sanitizeConnectionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^@\s/]+)@/gi, "$1***@")
    .replace(
      /\b((?:proxy-)?authorization)\s*:\s*(bearer|basic)\s+[^\s,;]+/gi,
      "$1: $2 ***",
    )
    .replace(
      /(["']?)(access[_-]?token|refresh[_-]?token|api[_-]?key|password|passphrase|token|secret)\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
      "$1$2$1$3***",
    )
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_STATUS_ERROR_LENGTH);
}

export class ConnectionManager<
  Runtime extends ConnectionRuntime = ConnectionRuntime,
> {
  private readonly entries = new Map<ConnectionId, ConnectionEntry<Runtime>>();
  private readonly removing = new Set<ConnectionId>();
  private stopAllTask: Promise<void> | null = null;

  constructor(
    private defaultConnectionId: ConnectionId,
    private readonly onStatus?: (status: ConnectionStatus) => void,
  ) {}

  register(args: {
    identity: ConnectionIdentity;
    createRuntime: ConnectionRuntimeFactory<Runtime>;
  }): void {
    if (this.stopAllTask) throw new Error("connection manager is stopping");
    if (this.entries.has(args.identity.id)) {
      throw new Error(`connection already registered: ${args.identity.id}`);
    }
    this.entries.set(args.identity.id, {
      identity: { ...args.identity },
      createRuntime: args.createRuntime,
      generation: 0,
      state: "disconnected",
      runtime: null,
      startToken: null,
      startTask: null,
      stopTask: null,
    });
    this.publish(this.requireEntry(args.identity.id));
  }

  defaultId(): ConnectionId {
    return this.defaultConnectionId;
  }

  setDefault(connectionId: ConnectionId): void {
    if (this.stopAllTask) throw new Error("connection manager is stopping");
    if (!this.entries.has(connectionId) || this.removing.has(connectionId)) {
      throw new Error(`unknown connection: ${connectionId}`);
    }
    if (this.defaultConnectionId === connectionId) return;
    const previous = this.entries.get(this.defaultConnectionId);
    this.defaultConnectionId = connectionId;
    if (previous) this.publish(previous);
    this.publish(this.requireEntry(connectionId));
  }

  async unregister(connectionId: ConnectionId): Promise<void> {
    const entry = this.requireEntry(connectionId);
    if (this.stopAllTask) throw new Error("connection manager is stopping");
    if (connectionId === this.defaultConnectionId) {
      throw new Error("cannot remove the default connection");
    }
    if (this.removing.has(connectionId)) {
      throw new Error(`connection is already being removed: ${connectionId}`);
    }
    this.removing.add(connectionId);
    try {
      let cleanupError: unknown;
      try {
        await this.stop(connectionId);
      } catch (error) {
        cleanupError = error;
      }
      if (this.entries.get(connectionId) !== entry) {
        throw new Error(
          `connection changed while being removed: ${connectionId}`,
        );
      }
      // Unregister is an administrative removal operation. Once stop has
      // invalidated the lease, remove the factory even if best-effort runtime
      // cleanup reported an error so the profile can never be reconnected.
      this.entries.delete(connectionId);
      if (cleanupError) {
        reportConnectionManagerError(
          `[bridge] connection unregister cleanup failed id=${connectionId}: ${sanitizeConnectionError(cleanupError)}`,
        );
      }
    } finally {
      this.removing.delete(connectionId);
    }
  }

  has(connectionId: ConnectionId): boolean {
    return this.entries.has(connectionId);
  }

  status(connectionId: ConnectionId): ConnectionStatus {
    return this.toStatus(this.requireEntry(connectionId));
  }

  markReconnecting(connectionId: ConnectionId, error: unknown): boolean {
    const entry = this.requireEntry(connectionId);
    if (
      this.stopAllTask ||
      this.removing.has(connectionId) ||
      (entry.state !== "error" && entry.state !== "reconnecting")
    ) {
      return false;
    }
    entry.state = "reconnecting";
    entry.error = { message: sanitizeConnectionError(error) };
    this.publish(entry);
    return true;
  }

  retireFailedRuntime(connectionId: ConnectionId): Promise<void> {
    const entry = this.requireEntry(connectionId);
    if (entry.state !== "error" && entry.state !== "reconnecting") {
      return Promise.resolve();
    }
    if (entry.stopTask) return entry.stopTask;
    const runtime = entry.runtime;
    if (!runtime) return Promise.resolve();
    const startTask = entry.startTask;
    const failedGeneration = entry.generation;
    const failedState = entry.state;
    const failedError = entry.error;
    const task = (async () => {
      let runtimeStop: Promise<void>;
      try {
        runtimeStop = runtime.stop();
      } catch (error) {
        runtimeStop = Promise.reject(error);
      }
      const results = await Promise.allSettled([
        runtimeStop,
        startTask?.catch(() => undefined) ?? Promise.resolve(),
      ]);
      if (entry.runtime === runtime) entry.runtime = null;
      const cleanupFailure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (cleanupFailure) {
        reportConnectionManagerError(
          `[bridge] failed runtime cleanup id=${entry.identity.id}: ${sanitizeConnectionError(cleanupFailure.reason)}`,
        );
      }
      if (
        entry.generation === failedGeneration &&
        (entry.state === "error" || entry.state === "reconnecting")
      ) {
        entry.state = failedState;
        entry.error = failedError;
        this.publish(entry);
      }
    })();
    entry.stopTask = task;
    void task.finally(() => {
      if (entry.stopTask === task) entry.stopTask = null;
    });
    return task;
  }

  list(): ConnectionStatus[] {
    return Array.from(this.entries.values(), (entry) => this.toStatus(entry));
  }

  currentRuntime(connectionId: ConnectionId): Runtime | null {
    return this.requireEntry(connectionId).runtime;
  }

  defaultRuntime(): Runtime | null {
    return this.currentRuntime(this.defaultConnectionId);
  }

  readyRuntimeLease(
    connectionId: ConnectionId,
  ): ReadyRuntimeLease<Runtime> | null {
    const entry = this.requireEntry(connectionId);
    const runtime = entry.runtime;
    if (entry.state !== "ready" || !runtime) return null;
    const generation = entry.generation;
    return {
      connectionId,
      generation,
      runtime,
      isCurrent: () =>
        entry.state === "ready" && this.isCurrent(entry, generation, runtime),
    };
  }

  readyRuntime(connectionId: ConnectionId): Runtime | null {
    return this.readyRuntimeLease(connectionId)?.runtime ?? null;
  }

  defaultReadyRuntime(): Runtime | null {
    return this.readyRuntime(this.defaultConnectionId);
  }

  currentRuntimes(): Runtime[] {
    return Array.from(this.entries.values(), (entry) => entry.runtime).filter(
      (runtime): runtime is Runtime => runtime !== null,
    );
  }

  forEachCurrentRuntime(callback: (runtime: Runtime) => void): void {
    for (const runtime of this.currentRuntimes()) {
      try {
        callback(runtime);
      } catch (error) {
        reportConnectionManagerError(
          `[bridge] connection runtime callback failed id=${runtime.identity.id}: ${sanitizeConnectionError(error)}`,
        );
      }
    }
  }

  startDefault(): Promise<void> {
    return this.start(this.defaultConnectionId);
  }

  start(connectionId: ConnectionId): Promise<void> {
    const entry = this.requireEntry(connectionId);
    if (this.removing.has(connectionId)) {
      return Promise.reject(
        new Error(`connection is being removed: ${connectionId}`),
      );
    }
    if (this.stopAllTask) {
      return Promise.reject(new Error("connection manager is stopping"));
    }
    if (entry.state === "ready") return Promise.resolve();
    if (entry.stopTask) {
      return entry.stopTask.then(() => this.start(connectionId));
    }
    if (entry.startTask) return entry.startTask;

    const startToken = Symbol(connectionId);
    entry.startToken = startToken;
    const begin = async () => {
      if (entry.runtime) {
        this.invalidate(entry, "stopping");
        const retired = entry.runtime;
        try {
          await retired.stop();
        } catch (error) {
          entry.state = "error";
          entry.error = { message: sanitizeConnectionError(error) };
          this.publish(entry);
          throw error;
        }
        if (entry.runtime === retired) entry.runtime = null;
        if (entry.startToken !== startToken) return;
      }

      const generation = entry.generation + 1;
      entry.generation = generation;
      entry.state = "connecting";
      entry.error = undefined;
      let runtime!: Runtime;
      const context: ConnectionRuntimeContext = {
        generation,
        isCurrent: () => this.isCurrent(entry, generation, runtime),
        reportError: (error, options) => {
          if (!this.isCurrent(entry, generation, runtime)) return;
          entry.generation += 1;
          entry.state = options?.reconnecting ? "reconnecting" : "error";
          entry.error = { message: sanitizeConnectionError(error) };
          this.publish(entry);
        },
      };

      try {
        runtime = entry.createRuntime(context);
        entry.runtime = runtime;
        if (runtime.identity.id !== entry.identity.id) {
          throw new Error(
            `runtime identity mismatch: expected ${entry.identity.id}, received ${runtime.identity.id}`,
          );
        }
        this.publish(entry);
        await runtime.startTransport();
        if (!this.isCurrent(entry, generation, runtime)) {
          if (!entry.stopTask) {
            try {
              await runtime.stop();
            } finally {
              if (entry.runtime === runtime) entry.runtime = null;
            }
          }
          return;
        }
        await runtime.startBackground();
        if (!this.isCurrent(entry, generation, runtime)) {
          if (!entry.stopTask) {
            try {
              await runtime.stop();
            } finally {
              if (entry.runtime === runtime) entry.runtime = null;
            }
          }
          return;
        }
        entry.state = "ready";
        entry.error = undefined;
        this.publish(entry);
      } catch (error) {
        if (runtime && this.isCurrent(entry, generation, runtime)) {
          entry.generation += 1;
          entry.state = "error";
          entry.error = { message: sanitizeConnectionError(error) };
          this.publish(entry);
          try {
            await runtime.stop();
          } catch (cleanupError) {
            reportConnectionManagerError(
              `[bridge] failed runtime cleanup failed id=${entry.identity.id}: ${sanitizeConnectionError(cleanupError)}`,
            );
          } finally {
            if (entry.runtime === runtime) entry.runtime = null;
          }
        } else if (!runtime && entry.generation === generation) {
          entry.state = "error";
          entry.error = { message: sanitizeConnectionError(error) };
          this.publish(entry);
        }
        throw error;
      }
    };

    // Publish no lifecycle state until the task is installed. Status observers
    // are synchronous and may reenter start/stop while handling a transition.
    const deferred = deferredTask();
    const task = deferred.promise;
    entry.startTask = task;
    void begin().then(deferred.resolve, deferred.reject);
    void task
      .finally(() => {
        if (entry.startTask === task) entry.startTask = null;
        if (entry.startToken === startToken) entry.startToken = null;
      })
      .catch(() => undefined);
    return task;
  }

  stop(connectionId: ConnectionId): Promise<void> {
    const entry = this.requireEntry(connectionId);
    if (entry.stopTask) {
      if (entry.state === "error" || entry.state === "reconnecting") {
        return entry.stopTask.then(() => this.stop(connectionId));
      }
      return entry.stopTask;
    }
    if (!entry.runtime && !entry.startTask) {
      if (entry.state !== "disconnected") {
        entry.state = "disconnected";
        entry.error = undefined;
        this.publish(entry);
      }
      return Promise.resolve();
    }

    const runtime = entry.runtime;
    const startTask = entry.startTask;
    entry.startToken = null;
    const deferred = deferredTask();
    const task = deferred.promise;
    entry.stopTask = task;
    const begin = async () => {
      // Install stopTask before this publish so a synchronous observer can only
      // queue a restart behind this cleanup.
      this.invalidate(entry, "stopping");
      let runtimeStop: Promise<void>;
      try {
        runtimeStop = runtime?.stop() ?? Promise.resolve();
      } catch (error) {
        runtimeStop = Promise.reject(error);
      }
      const results = await Promise.allSettled([
        runtimeStop,
        startTask?.catch(() => undefined) ?? Promise.resolve(),
      ]);
      if (entry.runtime === runtime) entry.runtime = null;
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        entry.state = "error";
        entry.error = {
          message: sanitizeConnectionError(failure.reason),
        };
        this.publish(entry);
        throw failure.reason;
      }
      entry.state = "disconnected";
      entry.error = undefined;
      this.publish(entry);
    };
    void begin().then(deferred.resolve, deferred.reject);
    void task
      .finally(() => {
        if (entry.stopTask === task) entry.stopTask = null;
      })
      .catch(() => undefined);
    return task;
  }

  async replace(args: {
    identity: ConnectionIdentity;
    createRuntime: ConnectionRuntimeFactory<Runtime>;
  }): Promise<void> {
    const entry = this.requireEntry(args.identity.id);
    if (this.stopAllTask) throw new Error("connection manager is stopping");
    if (this.removing.has(args.identity.id)) {
      throw new Error(`connection is being removed: ${args.identity.id}`);
    }

    // Install the replacement factory before awaiting an existing stop. Any
    // start already queued behind that stop must construct the replacement,
    // never another instance of the retired runtime.
    entry.startToken = null;
    entry.generation += 1;
    entry.identity = { ...args.identity };
    entry.createRuntime = args.createRuntime;
    entry.error = undefined;
    await this.stop(entry.identity.id);
    this.publish(entry);
  }

  stopAll(): Promise<void> {
    if (this.stopAllTask) return this.stopAllTask;
    // Set the manager-wide marker before stop() publishes any synchronous
    // transition, otherwise an observer can start a peer during shutdown.
    const deferred = deferredTask();
    const task = deferred.promise;
    this.stopAllTask = task;
    void Promise.all(
      Array.from(this.entries.keys(), (connectionId) =>
        this.stop(connectionId).catch((error) => {
          reportConnectionManagerError(
            `[bridge] connection stop failed id=${connectionId}: ${sanitizeConnectionError(error)}`,
          );
        }),
      ),
    ).then(() => deferred.resolve(), deferred.reject);
    return task;
  }

  private invalidate(
    entry: ConnectionEntry<Runtime>,
    state: ConnectionState,
  ): void {
    entry.generation += 1;
    entry.state = state;
    entry.error = undefined;
    this.publish(entry);
  }

  private isCurrent(
    entry: ConnectionEntry<Runtime>,
    generation: number,
    runtime: Runtime,
  ): boolean {
    return (
      this.entries.get(entry.identity.id) === entry &&
      entry.generation === generation &&
      entry.runtime === runtime
    );
  }

  private requireEntry(connectionId: ConnectionId): ConnectionEntry<Runtime> {
    const entry = this.entries.get(connectionId);
    if (!entry) throw new Error(`unknown connection: ${connectionId}`);
    return entry;
  }

  private toStatus(entry: ConnectionEntry<Runtime>): ConnectionStatus {
    const status: ConnectionStatus = {
      id: entry.identity.id,
      label: entry.identity.label,
      source: entry.identity.source,
      is_default: entry.identity.id === this.defaultConnectionId,
      state: entry.state,
      generation: entry.generation,
    };
    if (entry.error) status.error = { ...entry.error };
    return status;
  }

  private publish(entry: ConnectionEntry<Runtime>): void {
    try {
      this.onStatus?.(this.toStatus(entry));
    } catch (error) {
      reportConnectionManagerError(
        `[bridge] connection status observer failed id=${entry.identity.id}: ${sanitizeConnectionError(error)}`,
      );
    }
  }
}
