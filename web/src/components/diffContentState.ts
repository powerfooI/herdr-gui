const diffCollapseStateCache = new Map<string, ReadonlyMap<string, boolean>>();

export function readDiffCollapseState(resourceKey: string) {
  return diffCollapseStateCache.get(resourceKey);
}

export function writeDiffCollapseState(
  resourceKey: string,
  state: ReadonlyMap<string, boolean>,
) {
  diffCollapseStateCache.set(resourceKey, state);
}

export function clearDiffContentResourceState(resourceKey: string) {
  diffCollapseStateCache.delete(resourceKey);
}
