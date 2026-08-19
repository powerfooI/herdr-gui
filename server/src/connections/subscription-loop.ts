export type EventSubscription = {
  ready: Promise<void>;
  closed: Promise<void>;
  close: () => void;
};

export type EventSubscriptionLoop = {
  start: () => void;
  stop: () => Promise<void>;
  isRunning: () => boolean;
};

type Generation = {
  id: number;
  cancelled: Promise<void>;
  cancel: () => void;
};

type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: Error }
  | { status: "cancelled" };

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createEventSubscriptionLoop(args: {
  subscribe: () => EventSubscription;
  retryDelayMs?: number;
  onReady?: () => void;
  onSubscribeError?: (error: Error) => void;
  onSubscriptionClosed?: () => void;
}): EventSubscriptionLoop {
  const retryDelayMs = args.retryDelayMs ?? 2000;
  let generationSequence = 0;
  let generation: Generation | null = null;
  let running = false;
  let active: EventSubscription | null = null;
  let loopTask: Promise<void> | null = null;
  let stopTask: Promise<void> | null = null;
  let wakeRetry: (() => void) | null = null;

  function newGeneration(): Generation {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    return { id: ++generationSequence, cancelled, cancel };
  }

  function current(expected: Generation) {
    return running && generation === expected;
  }

  function reportError(error: unknown) {
    try {
      args.onSubscribeError?.(errorFrom(error));
    } catch {
      // Lifecycle observers must not be able to stop reconnect processing.
    }
  }

  function notify(callback: (() => void) | undefined) {
    try {
      callback?.();
    } catch {
      // Lifecycle observers must not be able to stop reconnect processing.
    }
  }

  function closeSubscription(
    subscription: EventSubscription,
    reportCloseError = true,
  ) {
    try {
      subscription.close();
    } catch (error) {
      if (reportCloseError) reportError(error);
    }
  }

  function settle<T>(
    promise: Promise<T>,
    expected: Generation,
  ): Promise<Settled<T>> {
    const settled = promise
      .then<Settled<T>>((value) => ({ status: "fulfilled", value }))
      .catch<Settled<T>>((error) => ({
        status: "rejected",
        error: errorFrom(error),
      }));
    return Promise.race([
      settled,
      expected.cancelled.then<Settled<T>>(() => ({ status: "cancelled" })),
    ]);
  }

  function waitForRetry(expected: Generation): Promise<void> {
    if (!current(expected) || retryDelayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, retryDelayMs);
      function finish() {
        clearTimeout(timer);
        if (wakeRetry === finish) wakeRetry = null;
        resolve();
      }
      wakeRetry = finish;
      void expected.cancelled.then(finish);
    });
  }

  async function run(expected: Generation) {
    while (current(expected)) {
      let subscription: EventSubscription;
      try {
        subscription = args.subscribe();
      } catch (error) {
        if (!current(expected)) return;
        reportError(error);
        await waitForRetry(expected);
        continue;
      }

      active = subscription;
      const ready = await settle(subscription.ready, expected);
      if (ready.status !== "fulfilled") {
        if (active === subscription) {
          active = null;
          closeSubscription(subscription);
        }
        if (!current(expected) || ready.status === "cancelled") return;
        reportError(ready.error);
        await waitForRetry(expected);
        continue;
      }

      if (!current(expected)) {
        closeSubscription(subscription, false);
        return;
      }
      notify(args.onReady);

      const closed = await settle(subscription.closed, expected);
      if (active === subscription) active = null;
      if (!current(expected) || closed.status === "cancelled") return;
      if (closed.status === "rejected") {
        closeSubscription(subscription);
        reportError(closed.error);
      } else {
        notify(args.onSubscriptionClosed);
      }
      await waitForRetry(expected);
    }
  }

  function start() {
    if (running || loopTask) return;
    running = true;
    stopTask = null;
    const expected = newGeneration();
    generation = expected;
    const task = run(expected).catch(reportError);
    loopTask = task.finally(() => {
      if (generation === expected) {
        running = false;
        generation = null;
        loopTask = null;
      }
    });
  }

  function stop() {
    if (stopTask) return stopTask;
    if (!running && !loopTask) return Promise.resolve();
    running = false;
    const expected = generation;
    generation = null;
    expected?.cancel();
    const subscription = active;
    active = null;
    if (subscription) closeSubscription(subscription, false);
    wakeRetry?.();
    wakeRetry = null;
    const task = loopTask ?? Promise.resolve();
    stopTask = task.finally(() => {
      loopTask = null;
    });
    return stopTask;
  }

  return { start, stop, isRunning: () => running };
}
