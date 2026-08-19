import { expect, test } from "bun:test";
import { bindListenerBeforeConnectionStart } from "./startup";

test("listener remains available when downstream startup rejects", async () => {
  const events: string[] = [];
  let rejectStart!: (error: Error) => void;
  const start = new Promise<void>((_resolve, reject) => {
    rejectStart = reject;
  });
  let observedError = "";

  const listener = bindListenerBeforeConnectionStart({
    bindListener: () => {
      events.push("listener-bound");
      return {
        health: () => ({ ok: true }),
        bridgePing: () => ({ ok: true }),
      };
    },
    startConnection: () => {
      events.push("connection-started");
      return start;
    },
    onConnectionError: (error) => {
      observedError = (error as Error).message;
    },
  });

  expect(events).toEqual(["listener-bound", "connection-started"]);
  expect(listener.health()).toEqual({ ok: true });
  expect(listener.bridgePing()).toEqual({ ok: true });

  rejectStart(new Error("downstream unavailable"));
  await Promise.resolve();
  await Promise.resolve();
  expect(observedError).toBe("downstream unavailable");
  expect(listener.health()).toEqual({ ok: true });
});
