import { describe, expect, test } from "bun:test";
import {
  disposeTerminalConnection,
  registerTerminalConnectionDisposer,
  terminalMountKey,
  terminalPushMatches,
} from "./terminalConnection";

describe("terminal connection lifecycle", () => {
  test("dispatches old-connection detach before a switch but skips replacement detach", () => {
    const calls: boolean[] = [];
    const alpha = { connectionId: "alpha", generation: 1 };
    registerTerminalConnectionDisposer(alpha, (sendRemote) => {
      calls.push(sendRemote);
    });
    disposeTerminalConnection(alpha, true);
    expect(calls).toEqual([true]);

    const replacement = { connectionId: "alpha", generation: 2 };
    registerTerminalConnectionDisposer(replacement, (sendRemote) => {
      calls.push(sendRemote);
    });
    disposeTerminalConnection(replacement, false);
    expect(calls).toEqual([true, false]);
    disposeTerminalConnection(replacement, true);
    expect(calls).toEqual([true, false]);
  });

  test("isolates disposer failures so every mounted terminal is cleaned up", () => {
    const calls: string[] = [];
    const identity = { connectionId: "alpha", generation: 3 };
    registerTerminalConnectionDisposer(identity, () => {
      calls.push("first");
      throw new Error("broken disposer");
    });
    registerTerminalConnectionDisposer(identity, () => {
      calls.push("second");
    });

    expect(() => disposeTerminalConnection(identity, true)).not.toThrow();
    expect(calls).toEqual(["first", "second"]);
  });

  test("uses an injective mount key for IDs containing separators", () => {
    const identity = { connectionId: "alpha", generation: 1 };
    expect(terminalMountKey(identity, "pane:x", "terminal:y")).not.toBe(
      terminalMountKey(identity, "pane", "x:terminal:y"),
    );
  });

  test("drops colliding terminal pushes from inactive connections and stale clients", () => {
    let current = true;
    const identity = { connectionId: "beta", generation: 4 };
    const client = {
      generation: 4,
      isCurrent: () => current,
      acceptsServerGeneration: (value: unknown) =>
        value === undefined || value === 9,
    };
    expect(
      terminalPushMatches(identity, client, "same", {
        connection_id: "alpha",
        terminal_id: "same",
      }),
    ).toBe(false);
    expect(
      terminalPushMatches(identity, client, "same", {
        connection_id: "beta",
        terminal_id: "other",
      }),
    ).toBe(false);
    expect(
      terminalPushMatches(identity, client, "same", {
        connection_id: "beta",
      }),
    ).toBe(false);
    expect(
      terminalPushMatches(identity, client, "same", {
        connection_id: "beta",
        connection_generation: 8,
        terminal_id: "same",
      }),
    ).toBe(false);
    expect(
      terminalPushMatches(identity, client, "same", {
        connection_id: "beta",
        connection_generation: 9,
        terminal_id: "same",
      }),
    ).toBe(true);
    current = false;
    expect(
      terminalPushMatches(identity, client, "same", {
        connection_id: "beta",
        terminal_id: "same",
      }),
    ).toBe(false);
  });
});
