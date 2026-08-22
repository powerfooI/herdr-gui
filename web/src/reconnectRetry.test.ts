import { describe, expect, test } from "bun:test";
import { isReconnectRetryableError } from "./reconnectRetry";

describe("isReconnectRetryableError", () => {
  test("matches errors raised before the call reached the server", () => {
    const retryable = [
      "not connected to bridge",
      "bridge hello is unavailable",
      "connection runtime generation is unavailable",
      "connection changed during request",
      "bridge disconnected",
      "bridge connection timed out",
      "bridge hello timed out",
    ];
    for (const message of retryable) {
      expect(isReconnectRetryableError(new Error(message))).toBe(true);
    }
  });

  test("rejects server-side and unrelated failures", () => {
    const notRetryable = [
      "",
      "workspace not found",
      "timeout: workspace.focus",
      "connection is not ready: local",
      "fatal: not a git repository (or any of the parent directories): .git",
    ];
    for (const message of notRetryable) {
      expect(isReconnectRetryableError(new Error(message))).toBe(false);
    }
  });
});
