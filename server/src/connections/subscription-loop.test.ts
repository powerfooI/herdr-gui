import { describe, expect, test } from "bun:test";
import {
  createEventSubscriptionLoop,
  type EventSubscription,
} from "./subscription-loop";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controllableSubscription() {
  const ready = deferred<void>();
  const closed = deferred<void>();
  let closeCount = 0;
  let acknowledged = false;
  let didClose = false;
  const subscription: EventSubscription = {
    ready: ready.promise,
    closed: closed.promise,
    close: () => {
      closeCount += 1;
      if (didClose) return;
      didClose = true;
      if (!acknowledged) ready.reject(new Error("closed before ready"));
      closed.resolve();
    },
  };
  return {
    subscription,
    acknowledge: () => {
      acknowledged = true;
      ready.resolve();
    },
    rejectReady: (error: Error) => ready.reject(error),
    resolveClosed: () => {
      didClose = true;
      closed.resolve();
    },
    rejectClosed: (error: Error) => {
      didClose = true;
      closed.reject(error);
    },
    closeCount: () => closeCount,
  };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await Bun.sleep(1);
  }
}

describe("event subscription loop", () => {
  test("retries after subscribe throws synchronously", async () => {
    const next = controllableSubscription();
    const errors: string[] = [];
    let attempts = 0;
    const loop = createEventSubscriptionLoop({
      subscribe: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("sync unavailable");
        return next.subscription;
      },
      retryDelayMs: 0,
      onSubscribeError: (error) => errors.push(error.message),
    });

    loop.start();
    await waitUntil(() => attempts === 2);
    await loop.stop();

    expect(errors).toEqual(["sync unavailable"]);
    expect(next.closeCount()).toBe(1);
  });

  test("stop before ready closes once and suppresses callbacks and reconnect", async () => {
    const subscriptions: ReturnType<typeof controllableSubscription>[] = [];
    let readyCallbacks = 0;
    let closedCallbacks = 0;
    let errorCallbacks = 0;
    const loop = createEventSubscriptionLoop({
      subscribe: () => {
        const next = controllableSubscription();
        subscriptions.push(next);
        return next.subscription;
      },
      retryDelayMs: 0,
      onReady: () => {
        readyCallbacks += 1;
      },
      onSubscriptionClosed: () => {
        closedCallbacks += 1;
      },
      onSubscribeError: () => {
        errorCallbacks += 1;
      },
    });

    loop.start();
    const stopped = loop.stop();
    subscriptions[0].acknowledge();
    subscriptions[0].resolveClosed();
    await stopped;
    await Bun.sleep(0);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].closeCount()).toBe(1);
    expect(readyCallbacks).toBe(0);
    expect(closedCallbacks).toBe(0);
    expect(errorCallbacks).toBe(0);
    expect(loop.isRunning()).toBe(false);
  });

  test("stop during retry wakes immediately and prevents another attempt", async () => {
    const sawError = deferred<void>();
    let attempts = 0;
    const loop = createEventSubscriptionLoop({
      subscribe: () => {
        attempts += 1;
        throw new Error("unavailable");
      },
      retryDelayMs: 60_000,
      onSubscribeError: () => sawError.resolve(),
    });

    loop.start();
    await sawError.promise;
    await loop.stop();
    await Bun.sleep(0);

    expect(attempts).toBe(1);
    expect(loop.isRunning()).toBe(false);
  });

  test("repeated stop shares the same drain and remains idempotent", async () => {
    const next = controllableSubscription();
    const loop = createEventSubscriptionLoop({
      subscribe: () => next.subscription,
    });

    loop.start();
    const first = loop.stop();
    const second = loop.stop();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await loop.stop();

    expect(next.closeCount()).toBe(1);
  });

  test("retries after ready and closed rejections even when callbacks throw", async () => {
    const subscriptions: ReturnType<typeof controllableSubscription>[] = [];
    const errors: string[] = [];
    let readyCallbacks = 0;
    const loop = createEventSubscriptionLoop({
      subscribe: () => {
        const next = controllableSubscription();
        subscriptions.push(next);
        return next.subscription;
      },
      retryDelayMs: 0,
      onReady: () => {
        readyCallbacks += 1;
        throw new Error("observer ready failure");
      },
      onSubscribeError: (error) => {
        errors.push(error.message);
        if (errors.length === 1) throw new Error("observer error failure");
      },
      onSubscriptionClosed: () => {
        throw new Error("observer close failure");
      },
    });

    loop.start();
    subscriptions[0].rejectReady(new Error("ready failed"));
    await waitUntil(() => subscriptions.length === 2);
    subscriptions[1].acknowledge();
    subscriptions[1].rejectClosed(new Error("closed failed"));
    await waitUntil(() => subscriptions.length === 3);
    subscriptions[2].acknowledge();
    subscriptions[2].resolveClosed();
    await waitUntil(() => subscriptions.length === 4);
    await loop.stop();

    expect(errors).toEqual(["ready failed", "closed failed"]);
    expect(readyCallbacks).toBe(2);
    expect(subscriptions[1].closeCount()).toBe(1);
    expect(subscriptions[3].closeCount()).toBe(1);
  });
});
