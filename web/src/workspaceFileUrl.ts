import type { ConnectionClient } from "./api";
import { connectionHttpPath } from "./connectionHttp";

type FileUrlClient = Pick<
  ConnectionClient,
  "connectionId" | "serverRuntimeGeneration"
>;

export function workspaceFileUrl(
  client: FileUrlClient,
  workspaceId: string,
  path: string,
  options: { inline?: boolean; revision?: number } = {},
) {
  const url = new URL(
    connectionHttpPath(
      client.connectionId,
      "/file/download",
      client.serverRuntimeGeneration,
    ),
    "http://herdr.local",
  );
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("path", path);
  if (options.inline) url.searchParams.set("inline", "1");
  if (options.revision !== undefined) {
    url.searchParams.set("resource_revision", String(options.revision));
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Resolve a Markdown image reference against its workspace-relative document.
 * Undefined means the source is not workspace-local; null means it attempted to
 * address a local path but could not be resolved inside the workspace root.
 */
export function resolveWorkspaceMarkdownImagePath(
  source: string,
  markdownPath: string,
): string | null | undefined {
  const trimmed = source.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;

  const encodedPath = trimmed.split(/[?#]/, 1)[0] ?? "";
  let resourcePath: string;
  try {
    resourcePath = decodeURIComponent(encodedPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
  if (!resourcePath) return null;

  const parts = resourcePath.startsWith("/")
    ? []
    : markdownPath.replace(/\\/g, "/").split("/").slice(0, -1);
  for (const part of resourcePath.split("/")) {
    if (!part || part === ".") continue;
    if (part.includes("\0")) return null;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

export function resolveWorkspaceMarkdownImageUrl(
  source: string,
  markdownPath: string,
  client: FileUrlClient,
  workspaceId: string,
  revision?: number,
) {
  const path = resolveWorkspaceMarkdownImagePath(source, markdownPath);
  if (path === undefined) return source;
  if (path === null) return null;
  return workspaceFileUrl(client, workspaceId, path, {
    inline: true,
    revision,
  });
}
