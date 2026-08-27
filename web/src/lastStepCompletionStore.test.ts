import { expect, test } from "bun:test";
import {
  lastStepCompletionKey,
  publishLastStepCompletion,
  readLastStepCompletion,
  subscribeLastStepCompletion,
} from "./lastStepCompletionStore";

test("publishes non-collapsible workspace completion revisions", () => {
  const key = lastStepCompletionKey("local", "workspace");
  const otherKey = lastStepCompletionKey("remote", "workspace");
  let notifications = 0;
  const unsubscribe = subscribeLastStepCompletion(key, () => {
    notifications += 1;
  });

  publishLastStepCompletion("local", "workspace");
  publishLastStepCompletion("local", "workspace");

  expect(readLastStepCompletion(key)).toBe(2);
  expect(readLastStepCompletion(otherKey)).toBe(0);
  expect(notifications).toBe(2);
  unsubscribe();
  expect(readLastStepCompletion(key)).toBe(0);

  publishLastStepCompletion("local", "workspace");
  expect(readLastStepCompletion(key)).toBe(0);
});
