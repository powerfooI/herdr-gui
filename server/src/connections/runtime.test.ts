import { expect, test } from "bun:test";
import { createLegacyConnectionRuntime } from "./runtime";

test("legacy runtime exposes and reports its configured connection identity", async () => {
  const events: Array<{ event: unknown; connectionId: string }> = [];
  const errors: Array<{ error: unknown; connectionId: string }> = [];
  const runtime = createLegacyConnectionRuntime({
    identity: { id: "remote-dev", label: "Remote Dev", source: "test" },
    config: {
      socketPath: "/tmp/m3-runtime-control.sock",
      clientSocketPath: "/tmp/m3-runtime-client.sock",
      sshHost: undefined,
      session: undefined,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    safeSend: () => true,
    clientLabel: () => "browser",
    markRpcError: () => undefined,
    onEvent: (event, identity) => {
      events.push({ event, connectionId: identity.id });
    },
    onError: (error, identity) => {
      errors.push({ error, connectionId: identity.id });
    },
  });

  const event = { event: "workspace.updated", data: { workspace_id: "same" } };
  const error = new Error("downstream failed");
  runtime.herdr.emit("event", event);
  runtime.herdr.emit("error", error);

  expect(runtime.identity).toEqual({
    id: "remote-dev",
    label: "Remote Dev",
    source: "test",
  });
  expect(events).toEqual([{ event, connectionId: "remote-dev" }]);
  expect(errors).toEqual([{ error, connectionId: "remote-dev" }]);
  await runtime.stop();
});
