import { useMemo } from "react";
import { bridge, type ConnectionClient } from "./api";
import { useStore } from "./store";

/** Captures the active browser routing lease for component-owned work. */
export function useConnectionClient(): ConnectionClient {
  const state = useStore();
  const { activeConnectionId, connectionGeneration, connections } = state;
  const runtimeGeneration =
    connections.find((connection) => connection.id === activeConnectionId)
      ?.generation ?? null;
  return useMemo(() => {
    // A same-ID runtime replacement must capture a fresh Bridge generation.
    void connectionGeneration;
    return bridge.connection(activeConnectionId, runtimeGeneration);
  }, [activeConnectionId, connectionGeneration, runtimeGeneration]);
}

export function connectionClientScopeKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  ...parts: unknown[]
): string {
  return JSON.stringify([client.connectionId, client.generation, ...parts]);
}
