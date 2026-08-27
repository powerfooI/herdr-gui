const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function lastStepCompletionKey(
  connectionId: string,
  workspaceId: string | undefined,
) {
  return `${connectionId}\u0000${workspaceId ?? ""}`;
}

export function publishLastStepCompletion(
  connectionId: string,
  workspaceId: string,
) {
  const key = lastStepCompletionKey(connectionId, workspaceId);
  const current = listeners.get(key);
  if (!current) return;
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  for (const listener of current) listener();
}

export function readLastStepCompletion(key: string) {
  return revisions.get(key) ?? 0;
}

export function subscribeLastStepCompletion(key: string, listener: () => void) {
  const current = listeners.get(key) ?? new Set<() => void>();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(key);
      revisions.delete(key);
    }
  };
}
