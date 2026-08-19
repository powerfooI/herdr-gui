export function isAllowedWebSocketOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Non-browser clients do not send Origin. Authentication and the local OS
  // boundary continue to govern those clients.
  if (origin === null) return true;

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    return (
      (originUrl.protocol === "http:" || originUrl.protocol === "https:") &&
      origin === originUrl.origin &&
      originUrl.host === requestUrl.host
    );
  } catch {
    return false;
  }
}
