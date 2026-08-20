export function isAllowedWebSocketOrigin(
  request: Request,
  allowedOrigins?: ReadonlySet<string>,
): boolean {
  const origin = request.headers.get("origin");
  // Non-browser clients do not send Origin. Authentication and the local OS
  // boundary continue to govern those clients.
  if (origin === null) return true;

  try {
    const originUrl = new URL(origin);
    if (
      (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
      origin !== originUrl.origin
    ) {
      return false;
    }
    // Reverse proxies that terminate TLS and forward to an internal address
    // rewrite the Host header, so the browser origin no longer matches the
    // request host. Deployments behind such proxies list their public origin
    // explicitly (env HERDR_GUI_ALLOWED_ORIGINS / --allowed-origins).
    if (allowedOrigins?.has(origin)) return true;
    const requestUrl = new URL(request.url);
    return originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}

/**
 * Normalizes a comma-separated allowlist into a set of exact origins
 * (scheme + host + optional port). Entries without a scheme match both http
 * and https on that host. Invalid entries are skipped.
 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  if (!raw) return allowed;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      if (trimmed.includes("://")) {
        const url = new URL(trimmed);
        if (
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.origin !== "null"
        ) {
          allowed.add(url.origin);
        }
      } else {
        const url = new URL(`https://${trimmed}`);
        if (url.host) {
          allowed.add(`https://${url.host}`);
          allowed.add(`http://${url.host}`);
        }
      }
    } catch {
      // Skip malformed entries; the allowlist stays fail-closed.
    }
  }
  return allowed;
}
