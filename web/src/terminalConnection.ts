import type { ConnectionClient } from "./api";

export interface TerminalConnectionIdentity {
  connectionId: string;
  generation: number;
}

type TerminalConnectionDisposer = (sendRemoteDetach: boolean) => void;

const disposersByIdentity = new Map<string, Set<TerminalConnectionDisposer>>();

export function terminalConnectionKey(
  identity: TerminalConnectionIdentity,
): string {
  return `${identity.connectionId}\0${identity.generation}`;
}

export function terminalMountKey(
  identity: TerminalConnectionIdentity,
  paneId: string | null,
  terminalId: string | null,
): string {
  return JSON.stringify([
    identity.connectionId,
    identity.generation,
    paneId,
    terminalId,
  ]);
}

export function registerTerminalConnectionDisposer(
  identity: TerminalConnectionIdentity,
  disposer: TerminalConnectionDisposer,
): () => void {
  const key = terminalConnectionKey(identity);
  const disposers = disposersByIdentity.get(key) ?? new Set();
  disposers.add(disposer);
  disposersByIdentity.set(key, disposers);
  return () => {
    disposers.delete(disposer);
    if (disposers.size === 0) disposersByIdentity.delete(key);
  };
}

/**
 * Dispose mounted terminals before the browser routing lease advances.
 * Same-ID runtime replacement must skip remote detach because the server has
 * already installed the replacement runtime under that ID.
 */
export function disposeTerminalConnection(
  identity: TerminalConnectionIdentity,
  sendRemoteDetach: boolean,
): void {
  const key = terminalConnectionKey(identity);
  const disposers = disposersByIdentity.get(key);
  if (!disposers) return;
  disposersByIdentity.delete(key);
  for (const dispose of disposers) {
    try {
      dispose(sendRemoteDetach);
    } catch {
      // One broken mount must not prevent sibling terminals from detaching.
    }
  }
}

export function terminalPushMatches(
  identity: TerminalConnectionIdentity,
  client: Pick<
    ConnectionClient,
    "generation" | "isCurrent" | "acceptsServerGeneration"
  >,
  desiredTerminalId: string | null,
  push: {
    connection_id: string;
    connection_generation?: number;
    terminal_id?: string | null;
  },
): boolean {
  if (
    push.connection_id !== identity.connectionId ||
    client.generation !== identity.generation ||
    !client.isCurrent() ||
    !client.acceptsServerGeneration(push.connection_generation) ||
    !desiredTerminalId
  ) {
    return false;
  }
  return push.terminal_id === desiredTerminalId;
}
