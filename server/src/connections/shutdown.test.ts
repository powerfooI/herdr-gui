import { expect, test } from "bun:test";
import { createShutdownController } from "./shutdown";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("shutdown waits for one shared manager drain before exiting", async () => {
  const drain = deferred();
  const exits: number[] = [];
  let stops = 0;
  let cancelCalls = 0;
  const controller = createShutdownController({
    stop: () => {
      stops += 1;
      return drain.promise;
    },
    exit: (code) => exits.push(code),
    scheduleForceExit: () => () => {
      cancelCalls += 1;
    },
  });

  const first = controller.request(130);
  const second = controller.request(143);
  expect(first).toBe(second);
  expect(stops).toBe(1);
  expect(exits).toEqual([]);

  drain.resolve();
  await first;
  expect(exits).toEqual([130]);
  expect(cancelCalls).toBe(1);
});

test("shutdown forces one exit when the manager drain stalls", async () => {
  const drain = deferred();
  const exits: number[] = [];
  let forceExit!: () => void;
  const controller = createShutdownController({
    stop: () => drain.promise,
    exit: (code) => exits.push(code),
    scheduleForceExit: (callback) => {
      forceExit = callback;
      return () => undefined;
    },
  });

  const task = controller.request(1);
  forceExit();
  expect(exits).toEqual([1]);
  drain.resolve();
  await task;
  expect(exits).toEqual([1]);
});

test("shutdown reports drain failure and still exits", async () => {
  const errors: string[] = [];
  const exits: number[] = [];
  const controller = createShutdownController({
    stop: () => Promise.reject(new Error("drain failed")),
    exit: (code) => exits.push(code),
    onStopError: (error) => errors.push((error as Error).message),
    scheduleForceExit: () => () => undefined,
  });

  await controller.request(143);
  expect(errors).toEqual(["drain failed"]);
  expect(exits).toEqual([143]);
});
