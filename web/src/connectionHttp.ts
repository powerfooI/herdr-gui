export function connectionHttpPath(
  connectionId: string,
  endpoint: string,
  connectionGeneration?: number | null,
): string {
  if (!connectionId) throw new Error("invalid connection_id");
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const path = `/api/connections/${encodeURIComponent(connectionId)}${suffix}`;
  if (connectionGeneration === undefined || connectionGeneration === null) {
    return path;
  }
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0) {
    throw new Error("invalid connection_generation");
  }
  return `${path}?connection_generation=${connectionGeneration}`;
}
