import type { HerdrClient } from "../bridge/herdr-client";

/**
 * Herdr emits `pane.agent_status_changed` only through parameterized per-pane
 * subscriptions, so the static event subscription never sees agent status
 * transitions. This loop tracks panes that currently host an agent and keeps a
 * dedicated subscription socket open for their status events. Membership is
 * seeded from `pane.list`, refreshed when membership events arrive, and
 * re-polled periodically as a fallback. Status events themselves reach the
 * shared HerdrClient `event` emitter like every other subscription message.
 */

export type AgentStatusSubscriptionLoop = {
  start: () => void;
  stop: () => Promise<void>;
  /** Feed shared HerdrClient `event` emissions so membership changes rebuild. */
  handleHerdrEvent: (event: unknown) => void;
  isRunning: () => boolean;
};

type Subscription = {
  close: () => void;
  ready: Promise<void>;
  closed: Promise<void>;
};

type Generation = {
  id: number;
  cancelled: Promise<void>;
  cancel: () => void;
};

/** Herdr events that can change the set of panes hosting an agent. */
const MEMBERSHIP_EVENT_TYPES = new Set([
  "pane_agent_detected",
  "pane_closed",
  "tab_closed",
  "workspace_closed",
]);

function herdrEventName(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const envelope = event as {
    event?: unknown;
    data?: unknown;
  };
  if (typeof envelope.event === "string" && envelope.event) {
    return envelope.event;
  }
  const data = envelope.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const type = (data as { type?: unknown }).type;
    if (typeof type === "string" && type) return type;
  }
  return null;
}

export function agentPaneIdsFromPaneList(result: unknown): string[] {
  const panes = (result as { panes?: unknown } | null)?.panes;
  if (!Array.isArray(panes)) return [];
  const ids = new Set<string>();
  for (const pane of panes) {
    if (!pane || typeof pane !== "object" || Array.isArray(pane)) continue;
    const record = pane as { pane_id?: unknown; agent?: unknown };
    if (
      typeof record.pane_id === "string" &&
      record.pane_id.length > 0 &&
      typeof record.agent === "string" &&
      record.agent.length > 0
    ) {
      ids.add(record.pane_id);
    }
  }
  return Array.from(ids).sort();
}

export function samePaneIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function createAgentStatusSubscriptionLoop(args: {
  herdr: HerdrClient;
  connectionId: string;
  onSubscribeError?: (error: Error) => void;
  onListError?: (error: Error) => void;
  log?: (message: string) => void;
  retryDelayMs?: number;
  rebuildDebounceMs?: number;
  membershipPollMs?: number;
}): AgentStatusSubscriptionLoop {
  const retryDelayMs = args.retryDelayMs ?? 2000;
  const rebuildDebounceMs = args.rebuildDebounceMs ?? 300;
  const membershipPollMs = args.membershipPollMs ?? 30000;

  let running = false;
  let generation: Generation | null = null;
  let loopTask: Promise<void> | null = null;
  let stopTask: Promise<void> | null = null;
  let active: Subscription | null = null;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let rebuildRequested = false;
  let rebuildWaiters: Array<() => void> = [];

  function newGeneration(): Generation {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    return { id: (generation?.id ?? 0) + 1, cancelled, cancel };
  }

  function current(expected: Generation): boolean {
    return running && generation === expected;
  }

  function report(
    callback: ((error: Error) => void) | undefined,
    error: unknown,
  ) {
    if (!callback) return;
    try {
      callback(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Observers must not break the subscription loop.
    }
  }

  function log(message: string) {
    try {
      args.log?.(message);
    } catch {
      // Observers must not break the subscription loop.
    }
  }

  function wakeRebuild() {
    const waiters = rebuildWaiters;
    rebuildWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves on timeout, cancellation, or a rebuild wake, whichever first. */
  function wait(
    ms: number,
    expected: Generation,
    wakeOnRebuild: boolean,
  ): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        if (wakeOnRebuild) {
          rebuildWaiters = rebuildWaiters.filter((waiter) => waiter !== finish);
        }
        resolve();
      }
      if (wakeOnRebuild) rebuildWaiters.push(finish);
      void expected.cancelled.then(finish);
    });
  }

  function closeSubscription(subscription: Subscription) {
    try {
      subscription.close();
    } catch {
      // The socket is already considered closed.
    }
  }

  async function listAgentPaneIds(): Promise<string[] | null> {
    try {
      // Bounded so a hung downstream cannot hold runtime stop hostage.
      const result = await args.herdr.call("pane.list", {}, 5000);
      return agentPaneIdsFromPaneList(result);
    } catch (error) {
      report(args.onListError, error);
      return null;
    }
  }

  function requestRebuild() {
    if (!running) return;
    rebuildRequested = true;
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      wakeRebuild();
    }, rebuildDebounceMs);
  }

  /**
   * Holds the subscription until it closes or the pane set changes. Returns
   * "closed" (socket lost), "rebuild" (membership changed), or "cancelled".
   */
  async function holdSubscription(
    subscription: Subscription,
    paneIds: string[],
    expected: Generation,
  ): Promise<"closed" | "rebuild" | "cancelled"> {
    for (;;) {
      // Check the flag before sleeping: a rebuild wake that fired while no
      // waiter was registered (e.g. mid-RPC) must not be lost, otherwise the
      // rebuild would stall until the fallback poll.
      if (rebuildRequested) {
        rebuildRequested = false;
        const latest = await listAgentPaneIds();
        if (!current(expected)) return "cancelled";
        if (latest === null) {
          await wait(retryDelayMs, expected, true);
          if (!current(expected)) return "cancelled";
          continue;
        }
        if (!samePaneIds(latest, paneIds)) return "rebuild";
        continue;
      }
      const closed = await Promise.race([
        subscription.closed.then(() => true as const),
        wait(membershipPollMs, expected, true).then(() => false as const),
      ]);
      if (!current(expected)) return "cancelled";
      if (closed) return "closed";
      // Woken by a membership wake or the fallback poll: verify the set.
      rebuildRequested = false;
      const latest = await listAgentPaneIds();
      if (!current(expected)) return "cancelled";
      if (latest === null) {
        await wait(retryDelayMs, expected, true);
        if (!current(expected)) return "cancelled";
        continue;
      }
      if (!samePaneIds(latest, paneIds)) return "rebuild";
      // Set unchanged: keep holding the current subscription.
    }
  }

  async function run(expected: Generation) {
    while (current(expected)) {
      const paneIds = await listAgentPaneIds();
      if (!current(expected)) return;
      if (paneIds === null) {
        await wait(retryDelayMs, expected, false);
        continue;
      }
      if (paneIds.length === 0) {
        // Nothing to subscribe to yet; sleep until a membership event or the
        // fallback poll wakes the loop. A rebuild requested while the listing
        // was in flight skips the sleep so it is honored immediately.
        if (!rebuildRequested) {
          await wait(membershipPollMs, expected, true);
        }
        rebuildRequested = false;
        continue;
      }

      let subscription: Subscription;
      try {
        subscription = args.herdr.subscribe(
          paneIds.map((paneId) => ({
            type: "pane.agent_status_changed",
            pane_id: paneId,
          })),
        );
      } catch (error) {
        // A synchronous subscribe failure is transient like an ack failure;
        // it must never kill the loop.
        report(args.onSubscribeError, error);
        await wait(retryDelayMs, expected, false);
        continue;
      }
      active = subscription;
      const readyFailure = await Promise.race([
        subscription.ready.then(
          () => null as null,
          (error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
        ),
        expected.cancelled.then(() => new Error("cancelled")),
      ]);
      if (!current(expected)) {
        if (active === subscription) active = null;
        closeSubscription(subscription);
        return;
      }
      if (readyFailure) {
        if (active === subscription) active = null;
        closeSubscription(subscription);
        report(args.onSubscribeError, readyFailure);
        // The pane set raced us (e.g. a pane closed mid-subscribe). The loop
        // re-lists panes before the next attempt.
        await wait(retryDelayMs, expected, false);
        continue;
      }

      // Do not clear rebuildRequested here: a membership event that arrived
      // while the subscribe was in flight must survive into holdSubscription's
      // first check instead of stalling until the fallback poll.
      log(
        `subscribed to agent status events connection=${args.connectionId} panes=${paneIds.length}`,
      );
      const outcome = await holdSubscription(subscription, paneIds, expected);
      if (active === subscription) active = null;
      closeSubscription(subscription);
      if (outcome === "cancelled") return;
      if (outcome === "closed") {
        await wait(retryDelayMs, expected, false);
      }
      // "rebuild" loops immediately with a fresh listing.
    }
  }

  return {
    start() {
      if (running || loopTask) return;
      running = true;
      stopTask = null;
      const expected = newGeneration();
      generation = expected;
      const task = run(expected).catch((error) =>
        report(args.onSubscribeError, error),
      );
      loopTask = task.finally(() => {
        if (generation === expected) {
          running = false;
          generation = null;
          loopTask = null;
        }
      });
    },

    stop() {
      if (stopTask) return stopTask;
      if (!running && !loopTask) return Promise.resolve();
      running = false;
      const expected = generation;
      generation = null;
      expected?.cancel();
      rebuildRequested = false;
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
      const subscription = active;
      active = null;
      if (subscription) closeSubscription(subscription);
      wakeRebuild();
      const task = loopTask ?? Promise.resolve();
      stopTask = task.finally(() => {
        loopTask = null;
      });
      return stopTask;
    },

    handleHerdrEvent(event: unknown) {
      const name = herdrEventName(event);
      if (name && MEMBERSHIP_EVENT_TYPES.has(name)) requestRebuild();
    },

    isRunning: () => running,
  };
}
