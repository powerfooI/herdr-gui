import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import type { ConnectionClient } from "../api";
import { connectionHttpPath } from "../connectionHttp";
import { connectionStorageKey } from "../connectionStorage";
import { downloadFileFromUrl } from "../downloadFile";
import { gitDiffCode, type GitDiffCode } from "../gitDiffStatus";
import {
  refreshGitDiffSummary,
  retireGitDiffSummaryResource,
  useGitDiffSummaryState,
} from "../gitDiffSummaryStore";
import { store, useStoreSelector } from "../store";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import type {
  FileExplorerEntry,
  FileExplorerList,
  FilePreview,
  GitDiffEntry,
  GitDiffKind,
  GitDiffSummary,
} from "../types";
import { CloseButton } from "./CloseButton";
import { ConfirmDialog } from "./ModalDialogs";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
} from "./treeKeyboard";
import {
  FilePreviewContent,
  type ActiveFilePreviewSelection,
  type FilePreviewSelectionMeta,
} from "./FilePreviewContent";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

function workspaceName(workspace?: { label?: string; workspace_id?: string }) {
  return workspace?.label || workspace?.workspace_id || "";
}

function displaySize(entry: FileExplorerEntry) {
  if (entry.type === "directory") return "";
  if (entry.size < 1024) return `${entry.size} B`;
  if (entry.size < 1024 * 1024) return `${Math.round(entry.size / 1024)} KB`;
  return `${(entry.size / 1024 / 1024).toFixed(1)} MB`;
}

function absolutePath(root: string, entry: FileExplorerEntry) {
  return `${root.replace(/\/+$/, "")}/${entry.path}`;
}

function initialWorkspacePath(workspace?: {
  worktree?: { checkout_path: string };
  cwd?: string;
}) {
  return workspace?.worktree?.checkout_path ?? workspace?.cwd ?? "";
}

type FileExplorerCache = {
  search: string;
  rootInfo: FileExplorerList | null;
  children: Record<string, FileExplorerEntry[]>;
  expanded: Set<string>;
  error: string | null;
};

type FileGitStatus = {
  label: string;
  title: string;
  tone: string;
  priority: number;
  count?: number;
  entry?: GitDiffEntry;
  entries?: GitDiffEntry[];
  codes: GitDiffCode[];
};

const explorerCache = new Map<string, FileExplorerCache>();
const explorerCacheRevisions = new Map<string, number>();
const explorerPrefetches = new Map<string, Promise<void>>();
const previewCache = new Map<string, FilePreview>();
const previewRequests = new Map<string, Promise<FilePreview>>();
const previewRequestRevisions = new Map<string, number>();
const MAX_PREVIEW_CACHE_BYTES = 16 * 1024 * 1024;
let previewCacheBytes = 0;
let previewResourceRevision = 0;
const FILE_TREE_INDENT = 10;
const FILE_TREE_BASE_INDENT = 6;
const FILE_SHOW_HIDDEN_PREFIX = "fileExplorerShowHidden:";

export function explorerRuntimeContextKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId?: string,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "explorer-runtime",
    resourceKey ?? "focused",
    workspaceId ?? "missing",
  );
}

export function explorerCacheKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId?: string,
  showHidden = false,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "explorer",
    resourceKey ?? "focused",
    showHidden,
  );
}

function explorerCacheRevision(key: string): number {
  return explorerCacheRevisions.get(key) ?? 0;
}

function advanceExplorerCacheRevision(key: string): number {
  const next = explorerCacheRevision(key) + 1;
  explorerCacheRevisions.set(key, next);
  explorerPrefetches.delete(key);
  return next;
}

function retireExplorerCache(key: string) {
  advanceExplorerCacheRevision(key);
  explorerCache.delete(key);
}

export function clearFileExplorerResourceCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  resourceKey: string,
  storage: Pick<Storage, "removeItem"> = localStorage,
) {
  for (const showHidden of [false, true]) {
    const key = explorerCacheKey(client, undefined, showHidden, resourceKey);
    retireExplorerCache(key);
  }
  retireGitDiffSummaryResource(client, resourceKey);
  storage.removeItem(
    connectionStorageKey(
      client.connectionId,
      `${FILE_SHOW_HIDDEN_PREFIX}${resourceKey}`,
    ),
  );
}

function emptyExplorerCache(): FileExplorerCache {
  return {
    search: "",
    rootInfo: null,
    children: {},
    expanded: new Set([""]),
    error: null,
  };
}

function readExplorerCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId?: string,
  showHidden = false,
  resourceKey = workspaceId,
) {
  const key = explorerCacheKey(client, workspaceId, showHidden, resourceKey);
  const cached = explorerCache.get(key);
  if (cached) {
    return {
      ...cached,
      children: { ...cached.children },
      expanded: new Set(cached.expanded),
    };
  }
  const next = emptyExplorerCache();
  explorerCache.set(key, {
    ...next,
    children: { ...next.children },
    expanded: new Set(next.expanded),
  });
  return next;
}

function writeExplorerCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  showHidden: boolean,
  patch: Partial<FileExplorerCache>,
  resourceKey = workspaceId,
) {
  const key = explorerCacheKey(client, workspaceId, showHidden, resourceKey);
  const current = explorerCache.get(key) ?? emptyExplorerCache();
  explorerCache.set(key, {
    ...current,
    ...patch,
    children: patch.children ? { ...patch.children } : { ...current.children },
    expanded: patch.expanded
      ? new Set(patch.expanded)
      : new Set(current.expanded),
  });
}

export function filePreviewCacheKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  path: string,
) {
  return connectionClientScopeKey(
    client,
    "preview",
    workspaceId ?? "focused",
    path,
  );
}

function estimatedPreviewBytes(preview: FilePreview) {
  return (
    ((preview.text?.length ?? 0) + (preview.image_data_url?.length ?? 0)) * 2 +
    256
  );
}

function readCachedPreview(key: string) {
  const preview = previewCache.get(key);
  if (!preview) return undefined;
  previewCache.delete(key);
  previewCache.set(key, preview);
  return preview;
}

function removeCachedPreview(key: string, retireRequest = false) {
  const existing = previewCache.get(key);
  if (existing) {
    previewCacheBytes = Math.max(
      0,
      previewCacheBytes - estimatedPreviewBytes(existing),
    );
  }
  previewCache.delete(key);
  if (retireRequest) {
    const running = previewRequests.has(key);
    previewRequests.delete(key);
    if (running) {
      previewRequestRevisions.set(
        key,
        (previewRequestRevisions.get(key) ?? 0) + 1,
      );
    } else {
      previewRequestRevisions.delete(key);
    }
  } else if (!previewRequests.has(key)) {
    previewRequestRevisions.delete(key);
  }
}

function previewCacheKeyParts(key: string) {
  try {
    const parts = JSON.parse(key) as unknown[];
    if (
      typeof parts[0] !== "string" ||
      typeof parts[1] !== "number" ||
      parts[2] !== "preview" ||
      typeof parts[3] !== "string" ||
      typeof parts[4] !== "string"
    ) {
      return null;
    }
    return {
      connectionId: parts[0],
      generation: parts[1],
      workspaceId: parts[3],
      path: parts[4],
    };
  } catch {
    return null;
  }
}

export function invalidateFilePreviewCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  path: string,
  recursive = false,
) {
  const keys = new Set([...previewCache.keys(), ...previewRequests.keys()]);
  for (const key of keys) {
    const parts = previewCacheKeyParts(key);
    if (
      !parts ||
      parts.connectionId !== client.connectionId ||
      parts.generation !== client.generation ||
      parts.workspaceId !== workspaceId
    ) {
      continue;
    }
    if (
      parts.path === path ||
      (recursive && parts.path.startsWith(`${path}/`))
    ) {
      removeCachedPreview(key, true);
    }
  }
}

function writeCachedPreview(key: string, preview: FilePreview) {
  removeCachedPreview(key);
  previewCache.set(key, preview);
  previewCacheBytes += estimatedPreviewBytes(preview);

  while (previewCacheBytes > MAX_PREVIEW_CACHE_BYTES && previewCache.size > 1) {
    const oldestKey = previewCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    removeCachedPreview(oldestKey);
  }
}

function parentDirectoryPaths(path: string) {
  const parts = path.split("/").filter(Boolean);
  const directories: string[] = [""];
  for (let i = 1; i < parts.length; i += 1) {
    directories.push(parts.slice(0, i).join("/"));
  }
  return directories;
}

function parentDirectoryPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function directoryPaths(path: string) {
  const parts = path.split("/").filter(Boolean);
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

function isWorkspaceRelativePath(path: string) {
  return Boolean(path) && !path.startsWith("/");
}

function normalizeDisplayPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relativeDisplayPath(from: string, to: string) {
  const base = normalizeDisplayPath(from);
  const target = normalizeDisplayPath(to);
  if (!base || !target) return null;
  if (base === target) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

function mapGitPathToExplorerPath(
  gitRoot: string,
  explorerRoot: string,
  gitPath: string,
) {
  const normalizedGitPath = normalizeDisplayPath(gitPath).replace(/^\/+/, "");
  const explorerWithinGit = relativeDisplayPath(gitRoot, explorerRoot);
  if (explorerWithinGit !== null) {
    if (!explorerWithinGit) return normalizedGitPath;
    return normalizedGitPath === explorerWithinGit ||
      normalizedGitPath.startsWith(`${explorerWithinGit}/`)
      ? normalizedGitPath.slice(explorerWithinGit.length).replace(/^\/+/, "")
      : null;
  }
  const gitWithinExplorer = relativeDisplayPath(explorerRoot, gitRoot);
  if (gitWithinExplorer !== null) {
    return gitWithinExplorer
      ? `${gitWithinExplorer}/${normalizedGitPath}`
      : normalizedGitPath;
  }
  return normalizedGitPath;
}

function gitStatusTone(entry: Pick<GitDiffEntry, "kind" | "status">) {
  if (entry.kind === "conflicted") return "conflict";
  if (entry.kind === "untracked") return "untracked";
  switch (entry.status) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
    case "copied":
      return "added";
    case "type changed":
      return "modified";
    default:
      return entry.kind === "staged" ? "staged" : "modified";
  }
}

function gitStatusLabel(entry: Pick<GitDiffEntry, "kind" | "status">) {
  if (entry.kind === "conflicted") return "Conflict";
  if (entry.kind === "untracked") return "Untracked";
  switch (entry.status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "type changed":
      return "Type changed";
    case "modified":
    default:
      return "Modified";
  }
}

function gitStatusPriority(entry: Pick<GitDiffEntry, "kind" | "status">) {
  if (entry.kind === "conflicted") return 100;
  if (entry.status === "deleted") return 90;
  if (entry.kind === "untracked") return 80;
  if (entry.status === "added") return 70;
  if (entry.kind === "staged") return 60;
  return 50;
}

function gitKindLabel(kind: GitDiffKind) {
  switch (kind) {
    case "staged":
      return "staged";
    case "unstaged":
      return "unstaged";
    case "untracked":
      return "untracked";
    case "conflicted":
      return "conflicted";
    case "branch":
      return "branch";
    default:
      return kind;
  }
}

export function buildGitStatusMaps(
  summary: GitDiffSummary | null,
  explorerRoot?: string,
) {
  const fileStatuses = new Map<string, FileGitStatus>();
  const directoryChangedFiles = new Map<string, Set<string>>();
  const directoryCodes = new Map<string, Set<GitDiffCode>>();
  if (!summary || !explorerRoot)
    return {
      fileStatuses,
      directoryStatuses: new Map<string, FileGitStatus>(),
    };

  const descriptions = new Map<string, string[]>();
  for (const entry of summary.entries) {
    const mappedPath = mapGitPathToExplorerPath(
      summary.root,
      explorerRoot,
      entry.path,
    );
    if (!mappedPath) continue;
    const existing = fileStatuses.get(mappedPath);
    const codes = Array.from(
      new Set([...(existing?.codes ?? []), gitDiffCode(entry)]),
    ).sort();
    const entries = [...(existing?.entries ?? []), entry];
    const next: FileGitStatus = {
      label: gitStatusLabel(entry),
      title: `${gitKindLabel(entry.kind)} ${entry.status}`,
      tone: gitStatusTone(entry),
      priority: gitStatusPriority(entry),
      entry,
      entries,
      codes,
    };
    const currentDescriptions = descriptions.get(mappedPath) ?? [];
    currentDescriptions.push(next.title);
    descriptions.set(mappedPath, currentDescriptions);
    const preferred =
      !existing || next.priority > existing.priority ? next : existing;
    const orderedEntries = [
      ...entries.filter((candidate) => candidate !== preferred.entry),
      ...(preferred.entry ? [preferred.entry] : []),
    ];
    if (preferred === next) {
      fileStatuses.set(mappedPath, { ...next, entries: orderedEntries });
    } else if (existing) {
      existing.codes = codes;
      existing.entries = orderedEntries;
    }

    const parts = mappedPath.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const directory = parts.slice(0, i + 1).join("/");
      const changedFiles =
        directoryChangedFiles.get(directory) ?? new Set<string>();
      changedFiles.add(mappedPath);
      directoryChangedFiles.set(directory, changedFiles);
      const codesBelow =
        directoryCodes.get(directory) ?? new Set<GitDiffCode>();
      codesBelow.add(gitDiffCode(entry));
      directoryCodes.set(directory, codesBelow);
    }
  }

  for (const [path, status] of fileStatuses) {
    const statusDescriptions = descriptions.get(path);
    if (statusDescriptions?.length) {
      status.title = Array.from(new Set(statusDescriptions)).join(", ");
    }
  }

  const directoryStatuses = new Map<string, FileGitStatus>();
  for (const [path, changedFiles] of directoryChangedFiles) {
    const count = changedFiles.size;
    directoryStatuses.set(path, {
      label: `${count} ${count === 1 ? "change" : "changes"}`,
      title: `${count} changed ${count === 1 ? "file" : "files"} below this directory`,
      tone: "directory",
      priority: 10,
      count,
      codes: Array.from(directoryCodes.get(path) ?? []).sort(),
    });
  }

  return { fileStatuses, directoryStatuses };
}

export function requestFilePreview(
  workspaceId: string,
  path: string,
  options: { refresh?: boolean; client: ConnectionClient },
) {
  const client = options.client;
  if (!client.isCurrent()) {
    return Promise.reject(new Error("connection changed during file preview"));
  }
  const key = filePreviewCacheKey(client, workspaceId, path);
  const cached = readCachedPreview(key);
  if (cached && !options.refresh) return Promise.resolve(cached);
  const running = previewRequests.get(key);
  if (running) return running;

  const revision = (previewRequestRevisions.get(key) ?? 0) + 1;
  previewRequestRevisions.set(key, revision);
  const task = client.call("file.read", {
    workspace_id: workspaceId,
    path,
  }) as Promise<FilePreview>;
  const scopedTask = task
    .then((preview) => {
      if (!client.isCurrent()) {
        throw new Error("connection changed during file preview");
      }
      if (previewRequestRevisions.get(key) !== revision) {
        throw new Error("file preview request superseded");
      }
      previewResourceRevision += 1;
      const versionedPreview = {
        ...preview,
        resource_revision: previewResourceRevision,
      };
      writeCachedPreview(key, versionedPreview);
      return versionedPreview;
    })
    .finally(() => {
      if (previewRequests.get(key) === scopedTask) {
        previewRequests.delete(key);
      }
      if (!previewCache.has(key) && !previewRequests.has(key)) {
        previewRequestRevisions.delete(key);
      }
    });
  previewRequests.set(key, scopedTask);
  return scopedTask;
}

async function uploadExplorerFile(
  client: ConnectionClient,
  workspaceId: string,
  directory: string,
  file: File,
) {
  if (!client.isCurrent()) throw new Error("connection changed during upload");
  const url = new URL(
    connectionHttpPath(
      client.connectionId,
      "/file/upload",
      client.serverRuntimeGeneration,
    ),
    window.location.origin,
  );
  if (url.origin !== window.location.origin)
    throw new Error("invalid upload origin");
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("directory", directory);
  url.searchParams.set("filename", file.name);
  const response = await fetch(url, {
    method: "POST",
    body: file,
  });
  const text = await response.text();
  if (!client.isCurrent()) throw new Error("connection changed during upload");
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok) {
    throw new Error(
      payload?.error || text || `upload failed ${response.status}`,
    );
  }
  return payload as {
    path: string;
    size: number;
    overwritten: boolean;
  };
}

async function deleteExplorerEntry(
  client: ConnectionClient,
  workspaceId: string,
  path: string,
) {
  if (!client.isCurrent()) throw new Error("connection changed during delete");
  const url = new URL(
    connectionHttpPath(
      client.connectionId,
      "/file/delete",
      client.serverRuntimeGeneration,
    ),
    window.location.origin,
  );
  if (url.origin !== window.location.origin)
    throw new Error("invalid delete origin");
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("path", path);
  const response = await fetch(url, { method: "POST" });
  const text = await response.text();
  if (!client.isCurrent()) throw new Error("connection changed during delete");
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok) {
    throw new Error(
      payload?.error || text || `delete failed ${response.status}`,
    );
  }
  return payload as {
    path: string;
    type: FileExplorerEntry["type"];
  };
}

export function prefetchFileExplorerWorkspace(
  workspaceId: string | undefined,
  client: ConnectionClient,
  resourceKey = workspaceId,
) {
  if (!workspaceId || !client.isCurrent()) return Promise.resolve();
  const showHidden = false;
  const key = explorerCacheKey(client, workspaceId, showHidden, resourceKey);
  const running = explorerPrefetches.get(key);
  if (running) return running;
  const revision = explorerCacheRevision(key);

  const task = (async () => {
    const cached = readExplorerCache(
      client,
      workspaceId,
      showHidden,
      resourceKey,
    );
    const paths = Array.from(cached.expanded);
    if (!paths.includes("")) paths.unshift("");

    for (const path of paths) {
      const list = (await client.call("file.list", {
        workspace_id: workspaceId,
        path,
        show_hidden: showHidden,
      })) as FileExplorerList;
      if (!client.isCurrent() || explorerCacheRevision(key) !== revision) {
        return;
      }
      const latest = readExplorerCache(
        client,
        workspaceId,
        showHidden,
        resourceKey,
      );
      writeExplorerCache(
        client,
        workspaceId,
        showHidden,
        {
          rootInfo: list,
          children: { ...latest.children, [path]: list.entries },
          expanded: latest.expanded,
          error: null,
        },
        resourceKey,
      );
    }
  })()
    .catch(() => {
      // Background warmups should never surface transient bridge errors.
    })
    .finally(() => {
      if (explorerPrefetches.get(key) === task) {
        explorerPrefetches.delete(key);
      }
    });

  explorerPrefetches.set(key, task);
  return task;
}

export function FileExplorerDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal file-explorer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="File Explorer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <FileExplorerContent
          open={open}
          workspaceId={workspaceId}
          onClose={onClose}
          showCloseButton
        />
      </div>
    </div>
  );
}

export function FileExplorerPanel({
  open,
  workspaceId,
  resourceKey,
  initialDirectory,
  activePath,
  keyboardActive = false,
  onClose,
  onPreviewChange,
  onActiveDiffEntriesChange,
}: {
  open: boolean;
  workspaceId?: string;
  resourceKey?: string;
  initialDirectory?: string;
  activePath?: string;
  keyboardActive?: boolean;
  onClose: () => void;
  onPreviewChange?: (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => void;
  onActiveDiffEntriesChange?: (entries: GitDiffEntry[]) => void;
}) {
  if (!open) return null;

  return (
    <aside className="file-explorer-side" aria-label="File Explorer">
      <FileExplorerContent
        open={open}
        workspaceId={workspaceId}
        resourceKey={resourceKey}
        initialDirectory={initialDirectory}
        onClose={onClose}
        showCloseButton={false}
        previewPlacement="external"
        activePath={activePath}
        keyboardActive={keyboardActive}
        onPreviewChange={onPreviewChange}
        onActiveDiffEntriesChange={onActiveDiffEntriesChange}
      />
    </aside>
  );
}

type FileExplorerEntryMenuState = {
  x: number;
  y: number;
  entry: FileExplorerEntry;
};

function FileExplorerEntryMenu({
  state,
  onClose,
  onDownload,
  onCopy,
  onDelete,
}: {
  state: FileExplorerEntryMenuState | null;
  onClose: () => void;
  onDownload: (entry: FileExplorerEntry) => void;
  onCopy: (entry: FileExplorerEntry) => void;
  onDelete: (entry: FileExplorerEntry) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!state) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ??
          [],
      );
      const currentIndex = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (!buttons.length || currentIndex < 0) return;
      e.preventDefault();
      const nextIndex =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : e.key === "ArrowDown"
              ? (currentIndex + 1) % buttons.length
              : (currentIndex - 1 + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", close, true);
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [state]);

  if (!state) return null;

  const { entry } = state;
  const isDirectory = entry.type === "directory";
  const items = [
    {
      label: isDirectory ? "Download directory" : "Download file",
      action: () => onDownload(entry),
    },
    {
      label: "Copy absolute path",
      action: () => onCopy(entry),
    },
    {
      label: isDirectory ? "Delete directory" : "Delete file",
      danger: true,
      action: () => onDelete(entry),
    },
  ];
  const menuMargin = 8;
  const menuWidth = 220;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(
      menuMargin,
      Math.min(state.x, window.innerWidth - menuWidth - menuMargin),
    ),
    top: Math.max(
      menuMargin,
      Math.min(state.y, window.innerHeight - items.length * 34 - menuMargin),
    ),
    zIndex: 1000,
  };

  return (
    <div ref={ref} className="context-menu" style={style} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
          role="menuitem"
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function FileExplorerContent({
  open,
  workspaceId,
  resourceKey,
  initialDirectory,
  onClose,
  showCloseButton,
  previewPlacement = "inline",
  activePath,
  keyboardActive = false,
  onPreviewChange,
  onActiveDiffEntriesChange,
}: {
  open: boolean;
  workspaceId?: string;
  resourceKey?: string;
  initialDirectory?: string;
  onClose: () => void;
  showCloseButton: boolean;
  previewPlacement?: "inline" | "external";
  activePath?: string;
  keyboardActive?: boolean;
  onPreviewChange?: (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => void;
  onActiveDiffEntriesChange?: (entries: GitDiffEntry[]) => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const focusedWorkspace = workspaces.find((w) => w.focused);
  const workspace = workspaceId
    ? workspaces.find((w) => w.workspace_id === workspaceId)
    : focusedWorkspace;
  const cacheWorkspaceId = workspace?.workspace_id;
  const cacheResourceKey = resourceKey ?? cacheWorkspaceId;
  const showHiddenStorageKey = connectionStorageKey(
    connectionClient.connectionId,
    `${FILE_SHOW_HIDDEN_PREFIX}${cacheResourceKey ?? "focused"}`,
  );
  const [showHidden, setShowHidden] = useState(
    () => localStorage.getItem(showHiddenStorageKey) === "true",
  );
  const [cache, setCache] = useState<FileExplorerCache>(() =>
    readExplorerCache(
      connectionClient,
      cacheWorkspaceId,
      showHidden,
      cacheResourceKey,
    ),
  );
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [uploadingPaths, setUploadingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [entryMenu, setEntryMenu] = useState<FileExplorerEntryMenuState | null>(
    null,
  );
  const [pendingDeleteEntry, setPendingDeleteEntry] =
    useState<FileExplorerEntry | null>(null);
  const [previewEntry, setPreviewEntry] = useState<FileExplorerEntry | null>(
    null,
  );
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(
    activePath ?? null,
  );
  const [treeHasFocus, setTreeHasFocus] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);
  const previewRequestKeyRef = useRef<string | null>(null);
  const previewRequestSequenceRef = useRef(0);
  const previousCacheResourceKeyRef = useRef<string | undefined>(undefined);
  const fileTreeRef = useRef<HTMLDivElement | null>(null);
  const treeAutoFocusAppliedRef = useRef(false);
  const runtimeContext = explorerRuntimeContextKey(
    connectionClient,
    cacheWorkspaceId,
    cacheResourceKey,
  );
  const runtimeContextRef = useRef(runtimeContext);
  runtimeContextRef.current = runtimeContext;
  const { search, rootInfo, children, expanded, error } = cache;
  const gitSummaryState = useGitDiffSummaryState(
    connectionClient,
    cacheWorkspaceId,
    "working",
    cacheResourceKey,
  );
  const gitStatusMaps = useMemo(
    () => buildGitStatusMaps(gitSummaryState.summary, rootInfo?.root),
    [gitSummaryState.summary, rootInfo?.root],
  );
  const activeDiffEntries = useMemo(
    () =>
      activePath
        ? (gitStatusMaps.fileStatuses.get(activePath)?.entries ?? [])
        : [],
    [activePath, gitStatusMaps],
  );
  const emitPreviewChange = (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => {
    onPreviewChange?.(selection, meta);
  };
  const runtimeContextIsCurrent = (context: string) =>
    connectionClient.isCurrent() && runtimeContextRef.current === context;

  useEffect(() => {
    localStorage.setItem(showHiddenStorageKey, String(showHidden));
  }, [showHidden, showHiddenStorageKey]);

  useEffect(() => {
    onActiveDiffEntriesChange?.(activeDiffEntries);
  }, [activeDiffEntries, onActiveDiffEntriesChange]);

  const updateCache = (patch: Partial<FileExplorerCache>) => {
    setCache((current) => {
      const next = {
        ...current,
        ...patch,
        children: patch.children
          ? { ...patch.children }
          : { ...current.children },
        expanded: patch.expanded
          ? new Set(patch.expanded)
          : new Set(current.expanded),
      };
      writeExplorerCache(
        connectionClient,
        cacheWorkspaceId,
        showHidden,
        next,
        cacheResourceKey,
      );
      return next;
    });
  };

  const clearLongPressTimer = () => {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const loadDirectory = async (path: string, force = false) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const requestContext = runtimeContext;
    if (!force && children[path]) return;
    setLoadingPaths((current) => new Set(current).add(path));
    updateCache({ error: null });
    try {
      const list = (await connectionClient.call("file.list", {
        workspace_id: workspace.workspace_id,
        path,
        show_hidden: showHidden,
      })) as FileExplorerList;
      if (
        !connectionClient.isCurrent() ||
        runtimeContextRef.current !== requestContext
      ) {
        return;
      }
      setCache((current) => {
        const next = {
          ...current,
          rootInfo: list,
          children: { ...current.children, [path]: list.entries },
          expanded: new Set(current.expanded),
          error: null,
        };
        writeExplorerCache(
          connectionClient,
          cacheWorkspaceId,
          showHidden,
          next,
          cacheResourceKey,
        );
        return next;
      });
    } catch (e) {
      if (
        connectionClient.isCurrent() &&
        runtimeContextRef.current === requestContext
      ) {
        updateCache({ error: (e as Error).message });
      }
    } finally {
      if (
        connectionClient.isCurrent() &&
        runtimeContextRef.current === requestContext
      ) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  };

  const loadGitStatus = async (afterCurrent = false) => {
    if (!connectionClient.isCurrent() || !workspace?.workspace_id) return;
    try {
      await refreshGitDiffSummary(
        connectionClient,
        workspace.workspace_id,
        "working",
        cacheResourceKey,
        { afterCurrent },
      );
    } catch {
      // Git status is supplementary; keep the file explorer usable on failure.
    }
  };

  useEffect(() => {
    if (!open) return;
    const resourceChanged =
      previousCacheResourceKeyRef.current !== cacheResourceKey;
    previousCacheResourceKeyRef.current = cacheResourceKey;
    advanceExplorerCacheRevision(
      explorerCacheKey(
        connectionClient,
        cacheWorkspaceId,
        showHidden,
        cacheResourceKey,
      ),
    );
    const cached = readExplorerCache(
      connectionClient,
      cacheWorkspaceId,
      showHidden,
      cacheResourceKey,
    );
    const initialPaths =
      initialDirectory && isWorkspaceRelativePath(initialDirectory)
        ? directoryPaths(initialDirectory)
        : [];
    const initialExpanded = new Set(cached.expanded);
    for (const path of initialPaths) initialExpanded.add(path);
    const initialCache = { ...cached, expanded: initialExpanded };
    writeExplorerCache(
      connectionClient,
      cacheWorkspaceId,
      showHidden,
      initialCache,
      cacheResourceKey,
    );
    setCache(initialCache);
    setLoadingPaths(new Set());
    setUploadingPaths(new Set());
    setDeletingPaths(new Set());
    setDropTargetPath(null);
    setEntryMenu(null);
    setPendingDeleteEntry(null);
    if (resourceChanged && !activePath) {
      setPreviewEntry(null);
      setPreview(null);
      setPreviewLoading(false);
      setPreviewError(null);
      emitPreviewChange({
        entry: null,
        preview: null,
        loading: false,
        error: null,
      });
    }
    previewRequestKeyRef.current = null;
    const pathsToRefresh = Array.from(initialCache.expanded);
    if (!pathsToRefresh.includes("")) pathsToRefresh.unshift("");
    for (const path of pathsToRefresh) {
      void loadDirectory(path, true);
    }
    void loadGitStatus();
    let removeKeyHandler = () => {};
    if (showCloseButton) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      removeKeyHandler = () => window.removeEventListener("keydown", onKey);
    }
    return () => {
      clearLongPressTimer();
      removeKeyHandler();
    };
    // Reopen against a fresh workspace/show-hidden snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cacheResourceKey,
    cacheWorkspaceId,
    connectionClient,
    initialDirectory,
    open,
    showHidden,
    showCloseButton,
  ]);

  useEffect(() => {
    if (
      !open ||
      !workspace?.workspace_id ||
      !activePath ||
      !isWorkspaceRelativePath(activePath)
    ) {
      return;
    }
    let cancelled = false;
    const workspaceId = workspace.workspace_id;
    const entryName = activePath.split("/").filter(Boolean).pop() ?? activePath;
    setPreviewEntry((current) =>
      current?.path === activePath
        ? current
        : {
            name: entryName,
            path: activePath,
            type: "file",
            size: 0,
            mtime_ms: 0,
            hidden: entryName.startsWith("."),
          },
    );

    const expandActivePath = async () => {
      const parentPaths = parentDirectoryPaths(activePath);
      let latest = readExplorerCache(
        connectionClient,
        workspaceId,
        showHidden,
        cacheResourceKey,
      );
      const nextExpanded = new Set(latest.expanded);
      for (const path of parentPaths) nextExpanded.add(path);
      writeExplorerCache(
        connectionClient,
        workspaceId,
        showHidden,
        { expanded: nextExpanded },
        cacheResourceKey,
      );
      if (!cancelled) {
        setCache((current) => ({
          ...current,
          expanded: new Set(nextExpanded),
        }));
      }

      for (const path of parentPaths) {
        if (cancelled || !connectionClient.isCurrent()) return;
        latest = readExplorerCache(
          connectionClient,
          workspaceId,
          showHidden,
          cacheResourceKey,
        );
        if (latest.children[path]) continue;
        setLoadingPaths((current) => new Set(current).add(path));
        try {
          const list = (await connectionClient.call("file.list", {
            workspace_id: workspaceId,
            path,
            show_hidden: showHidden,
          })) as FileExplorerList;
          if (!connectionClient.isCurrent() || cancelled) return;
          latest = readExplorerCache(
            connectionClient,
            workspaceId,
            showHidden,
            cacheResourceKey,
          );
          const expandedWithPath = new Set(latest.expanded);
          for (const parentPath of parentPaths)
            expandedWithPath.add(parentPath);
          writeExplorerCache(
            connectionClient,
            workspaceId,
            showHidden,
            {
              rootInfo: list,
              children: { ...latest.children, [path]: list.entries },
              expanded: expandedWithPath,
              error: null,
            },
            cacheResourceKey,
          );
          if (!cancelled) {
            setCache((current) => ({
              ...current,
              rootInfo: list,
              children: { ...current.children, [path]: list.entries },
              expanded: new Set(expandedWithPath),
              error: null,
            }));
          }
        } catch (e) {
          if (!cancelled && connectionClient.isCurrent()) {
            setCache((current) => ({
              ...current,
              error: (e as Error).message,
            }));
          }
        } finally {
          if (!cancelled && connectionClient.isCurrent()) {
            setLoadingPaths((current) => {
              const next = new Set(current);
              next.delete(path);
              return next;
            });
          }
        }
      }
    };

    void expandActivePath();
    return () => {
      cancelled = true;
    };
  }, [
    activePath,
    cacheResourceKey,
    cacheWorkspaceId,
    connectionClient,
    open,
    showHidden,
    workspace?.workspace_id,
  ]);

  const query = search.trim().toLowerCase();
  const loadedEntries = useMemo(
    () =>
      Object.values(children)
        .flat()
        .filter((entry, index, all) => {
          const firstIndex = all.findIndex(
            (candidate) => candidate.path === entry.path,
          );
          return firstIndex === index;
        }),
    [children],
  );
  const searchEntries = useMemo(
    () =>
      query
        ? loadedEntries.filter((entry) =>
            [entry.name, entry.path].some((value) =>
              value.toLowerCase().includes(query),
            ),
          )
        : [],
    [loadedEntries, query],
  );

  useEffect(() => {
    if (!activePath || !isWorkspaceRelativePath(activePath)) return;
    setFocusedTreePath(activePath);
  }, [activePath]);

  useEffect(() => {
    if (!activePath || !isWorkspaceRelativePath(activePath)) return;
    const tree = fileTreeRef.current;
    if (!tree) return;
    const row = Array.from(
      tree.querySelectorAll<HTMLElement>(".file-row[data-file-path]"),
    ).find((candidate) => candidate.dataset.filePath === activePath);
    row?.scrollIntoView({ block: "nearest" });
  }, [activePath, children, expanded, query]);

  useEffect(() => {
    const items = Array.from(
      fileTreeRef.current?.querySelectorAll<HTMLElement>(
        ".file-row[role='treeitem']",
      ) ?? [],
    );
    if (!items.length) {
      if (focusedTreePath !== null) setFocusedTreePath(null);
      return;
    }
    if (
      focusedTreePath &&
      items.some((item) => item.dataset.filePath === focusedTreePath)
    ) {
      return;
    }
    const next =
      items.find((item) => item.dataset.filePath === activePath) ?? items[0];
    setFocusedTreePath(next?.dataset.filePath ?? null);
  }, [activePath, children, expanded, focusedTreePath, query, searchEntries]);

  useEffect(() => {
    if (!keyboardActive) {
      treeAutoFocusAppliedRef.current = false;
      return;
    }
    if (treeAutoFocusAppliedRef.current) return;
    const tree = fileTreeRef.current;
    const items = Array.from(
      tree?.querySelectorAll<HTMLElement>(".file-row[role='treeitem']") ?? [],
    );
    if (!tree || !items.length) return;
    const focusedElement = document.activeElement as HTMLElement | null;
    const content = tree.closest(".file-explorer-content");
    if (
      focusedElement &&
      (content?.contains(focusedElement) ||
        focusedElement.closest("[role='tab']"))
    ) {
      treeAutoFocusAppliedRef.current = true;
      return;
    }
    const target =
      items.find((item) => item.dataset.filePath === focusedTreePath) ??
      items.find((item) => item.dataset.filePath === activePath) ??
      items[0];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
    treeAutoFocusAppliedRef.current = true;
  }, [activePath, children, focusedTreePath, keyboardActive]);

  const toggleDirectory = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      void loadDirectory(path);
    }
    updateCache({ expanded: next });
  };

  const loadPreview = async (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id || entry.type === "directory") return;
    onActiveDiffEntriesChange?.(
      gitStatusMaps.fileStatuses.get(entry.path)?.entries ?? [],
    );
    const workspaceId = workspace.workspace_id;
    const key = filePreviewCacheKey(connectionClient, workspaceId, entry.path);
    const requestKey = `${key}:${++previewRequestSequenceRef.current}`;
    previewRequestKeyRef.current = requestKey;
    setPreviewEntry(entry);
    setPreviewError(null);
    const cached = readCachedPreview(key);
    if (cached) {
      setPreview(cached);
      setPreviewLoading(false);
      emitPreviewChange(
        { entry, preview: cached, loading: false, error: null },
        { userInitiated: true },
      );
    } else {
      setPreview(null);
      setPreviewLoading(true);
      emitPreviewChange(
        { entry, preview: null, loading: true, error: null },
        { userInitiated: true },
      );
    }
    try {
      const next = await requestFilePreview(workspaceId, entry.path, {
        refresh: Boolean(cached),
        client: connectionClient,
      });
      if (
        connectionClient.isCurrent() &&
        previewRequestKeyRef.current === requestKey
      ) {
        setPreview(next);
        emitPreviewChange(
          { entry, preview: next, loading: false, error: null },
          { userInitiated: true },
        );
      }
    } catch (e) {
      if (
        connectionClient.isCurrent() &&
        previewRequestKeyRef.current === requestKey &&
        !cached
      ) {
        const message = (e as Error).message;
        setPreviewError(message);
        emitPreviewChange(
          { entry, preview: null, loading: false, error: message },
          { userInitiated: true },
        );
      }
    } finally {
      if (
        connectionClient.isCurrent() &&
        previewRequestKeyRef.current === requestKey
      ) {
        setPreviewLoading(false);
      }
    }
  };

  const copyEntryPath = async (entry: FileExplorerEntry) => {
    const root = rootInfo?.root || initialWorkspacePath(workspace);
    const value = root ? absolutePath(root, entry) : entry.path;
    try {
      await navigator.clipboard.writeText(value);
      if (!connectionClient.isCurrent()) return;
      store.notify({
        kind: "success",
        message: "Path copied",
        detail: value,
        autoDismissMs: 5000,
      });
    } catch (e) {
      if (!connectionClient.isCurrent()) return;
      store.notify({
        kind: "error",
        message: "Failed to copy path",
        detail: (e as Error).message,
      });
    }
  };

  const downloadEntry = (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id) return;
    if (!connectionClient.isCurrent()) return;
    const url = new URL(
      connectionHttpPath(
        connectionClient.connectionId,
        "/file/download",
        connectionClient.serverRuntimeGeneration,
      ),
      window.location.origin,
    );
    url.searchParams.set("workspace_id", workspace.workspace_id);
    url.searchParams.set("path", entry.path);
    const filename =
      entry.type === "directory"
        ? `${entry.name || "download"}.tar.gz`
        : entry.name || "download";
    void downloadFileFromUrl({ url: url.toString(), filename }).then(
      (result) => {
        if (result === "shared" || !connectionClient.isCurrent()) return;
        store.notify({
          kind: "info",
          message: "Download started",
          detail: entry.path,
          autoDismissMs: 5000,
        });
      },
    );
  };

  const markDeletePath = (path: string, deleting: boolean) => {
    setDeletingPaths((current) => {
      const next = new Set(current);
      if (deleting) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const removeEntryFromCache = (entry: FileExplorerEntry) => {
    setCache((current) => {
      const parent = parentDirectoryPath(entry.path);
      const nextChildren = { ...current.children };
      nextChildren[parent] = (nextChildren[parent] ?? []).filter(
        (candidate) => candidate.path !== entry.path,
      );
      if (entry.type === "directory") {
        for (const path of Object.keys(nextChildren)) {
          if (path === entry.path || path.startsWith(`${entry.path}/`)) {
            delete nextChildren[path];
          }
        }
      }
      const nextExpanded = new Set(current.expanded);
      for (const path of nextExpanded) {
        if (path === entry.path || path.startsWith(`${entry.path}/`)) {
          nextExpanded.delete(path);
        }
      }
      const next = {
        ...current,
        children: nextChildren,
        expanded: nextExpanded,
        error: null,
      };
      writeExplorerCache(
        connectionClient,
        cacheWorkspaceId,
        showHidden,
        next,
        cacheResourceKey,
      );
      return next;
    });
  };

  const clearDeletedPreview = (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id) return;
    const selectedPath = previewEntry?.path;
    const deletedSelection =
      selectedPath === entry.path ||
      (entry.type === "directory" &&
        selectedPath?.startsWith(`${entry.path}/`));
    invalidateFilePreviewCache(
      connectionClient,
      workspace.workspace_id,
      entry.path,
      entry.type === "directory",
    );
    if (!deletedSelection) return;
    setPreviewEntry(null);
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
    emitPreviewChange(
      { entry: null, preview: null, loading: false, error: null },
      { userInitiated: true },
    );
  };

  const deleteEntry = async (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const requestContext = runtimeContext;
    markDeletePath(entry.path, true);
    updateCache({ error: null });
    try {
      await deleteExplorerEntry(
        connectionClient,
        workspace.workspace_id,
        entry.path,
      );
      if (!runtimeContextIsCurrent(requestContext)) return;
      removeEntryFromCache(entry);
      clearDeletedPreview(entry);
      await loadDirectory(parentDirectoryPath(entry.path), true);
      if (!runtimeContextIsCurrent(requestContext)) return;
      void loadGitStatus(true);
      store.notify({
        kind: "success",
        message:
          entry.type === "directory" ? "Directory deleted" : "File deleted",
        detail: entry.path,
        autoDismissMs: 5000,
      });
    } catch (e) {
      if (!runtimeContextIsCurrent(requestContext)) return;
      store.notify({
        kind: "error",
        message: "Delete failed",
        detail: (e as Error).message,
      });
    } finally {
      if (runtimeContextIsCurrent(requestContext)) {
        markDeletePath(entry.path, false);
      }
    }
  };

  const invalidateUploadedPreviews = (paths: string[]) => {
    if (!workspace?.workspace_id || !paths.length) return;
    for (const path of paths) {
      invalidateFilePreviewCache(
        connectionClient,
        workspace.workspace_id,
        path,
      );
    }
    if (previewEntry && paths.includes(previewEntry.path)) {
      void loadPreview(previewEntry);
    }
  };

  const isFileDrag = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const markUploadPath = (path: string, uploading: boolean) => {
    setUploadingPaths((current) => {
      const next = new Set(current);
      if (uploading) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const uploadDroppedFiles = async (directory: string, files: FileList) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const requestContext = runtimeContext;
    const uploadFiles = Array.from(files).filter((file) => file.name);
    if (!uploadFiles.length) return;
    markUploadPath(directory, true);
    updateCache({ error: null });
    try {
      const results = await Promise.allSettled(
        uploadFiles.map((file) =>
          uploadExplorerFile(
            connectionClient,
            workspace.workspace_id,
            directory,
            file,
          ),
        ),
      );
      if (!runtimeContextIsCurrent(requestContext)) return;
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) throw failed.reason;
      if (directory) {
        updateCache({ expanded: new Set(expanded).add(directory) });
      }
      await loadDirectory(directory, true);
      if (!runtimeContextIsCurrent(requestContext)) return;
      invalidateUploadedPreviews(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.path] : [],
        ),
      );
      void loadGitStatus(true);
      const uploaded = results.length;
      store.notify({
        kind: "success",
        message: uploaded === 1 ? "File uploaded" : "Files uploaded",
        detail:
          uploaded === 1
            ? uploadFiles[0]?.name
            : `${uploaded} files uploaded to ${directory || "/"}`,
        autoDismissMs: 5000,
      });
    } catch (e) {
      if (!runtimeContextIsCurrent(requestContext)) return;
      store.notify({
        kind: "error",
        message: "Upload failed",
        detail: (e as Error).message,
      });
    } finally {
      if (runtimeContextIsCurrent(requestContext)) {
        markUploadPath(directory, false);
        setDropTargetPath(null);
      }
    }
  };

  const handleDirectoryDragOver = (
    event: DragEvent<HTMLElement>,
    directory: string,
  ) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath(directory);
  };

  const handleDirectoryDrop = (
    event: DragEvent<HTMLElement>,
    directory: string,
  ) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadDroppedFiles(directory, event.dataTransfer.files);
  };

  const handleRootDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    if ((event.target as HTMLElement | null)?.closest(".file-row")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath("");
  };

  const handleRootDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    if ((event.target as HTMLElement | null)?.closest(".file-row")) return;
    event.preventDefault();
    void uploadDroppedFiles("", event.dataTransfer.files);
  };

  const openEntryMenu = (entry: FileExplorerEntry, x: number, y: number) => {
    setEntryMenu({ entry, x, y });
  };

  const handleEntryPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    entry: FileExplorerEntry,
  ) => {
    if (event.pointerType === "mouse") return;
    longPressTriggered.current = false;
    longPressStart.current = { x: event.clientX, y: event.clientY };
    clearLongPressTimer();
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      openEntryMenu(entry, event.clientX, event.clientY);
    }, LONG_PRESS_MS);
  };

  const handleEntryPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = longPressStart.current;
    if (!start) return;
    const dx = Math.abs(event.clientX - start.x);
    const dy = Math.abs(event.clientY - start.y);
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
      longPressStart.current = null;
    }
  };

  const handleEntryPointerEnd = () => {
    clearLongPressTimer();
    longPressStart.current = null;
  };

  const activateEntry = (entry: FileExplorerEntry) => {
    if (entry.type === "directory") toggleDirectory(entry.path);
    else void loadPreview(entry);
  };

  const focusFirstChild = (current: HTMLElement) => {
    const items = Array.from(
      fileTreeRef.current?.querySelectorAll<HTMLElement>(
        ".file-row[role='treeitem']",
      ) ?? [],
    );
    const index = items.indexOf(current);
    const child = items[index + 1];
    if (
      !child ||
      Number(child.getAttribute("aria-level")) !==
        Number(current.getAttribute("aria-level")) + 1
    ) {
      return;
    }
    current.tabIndex = -1;
    child.tabIndex = 0;
    child.focus({ preventScroll: true });
    child.scrollIntoView({ block: "nearest" });
  };

  const handleEntryKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    entry: FileExplorerEntry,
    isDirectory: boolean,
    isExpanded: boolean,
  ) => {
    if (event.target !== event.currentTarget) return;
    const action = treeKeyboardAction(event.key, event.shiftKey);
    if (!action) return;
    event.preventDefault();

    if (
      action === "next" ||
      action === "previous" ||
      action === "first" ||
      action === "last"
    ) {
      focusTreeItem(event.currentTarget, action);
      return;
    }
    if (action === "expand") {
      if (isDirectory && !isExpanded) toggleDirectory(entry.path);
      else if (isDirectory) focusFirstChild(event.currentTarget);
      return;
    }
    if (action === "collapse") {
      if (isDirectory && isExpanded) {
        toggleDirectory(entry.path);
        return;
      }
      const parentPath = parentDirectoryPath(entry.path);
      const parent = Array.from(
        fileTreeRef.current?.querySelectorAll<HTMLElement>(
          ".file-row[role='treeitem']",
        ) ?? [],
      ).find((candidate) => candidate.dataset.filePath === parentPath);
      parent?.focus({ preventScroll: true });
      parent?.scrollIntoView({ block: "nearest" });
      return;
    }
    event.stopPropagation();
    if (action === "activate") activateEntry(entry);
    else {
      const point = keyboardContextMenuPoint(event.currentTarget);
      openEntryMenu(entry, point.x, point.y);
    }
  };

  const renderEntry = (
    entry: FileExplorerEntry,
    depth: number,
    defaultTabStop = false,
  ) => {
    const isDirectory = entry.type === "directory";
    const uploadDirectory = isDirectory
      ? entry.path
      : parentDirectoryPath(entry.path);
    const isExpanded = expanded.has(entry.path);
    const loading = loadingPaths.has(entry.path);
    const uploading = isDirectory && uploadingPaths.has(entry.path);
    const deleting = deletingPaths.has(entry.path);
    const gitStatus = isDirectory
      ? gitStatusMaps.directoryStatuses.get(entry.path)
      : gitStatusMaps.fileStatuses.get(entry.path);
    const meta = [entry.type === "symlink" ? "symlink" : "", displaySize(entry)]
      .filter(Boolean)
      .join(" · ");

    return (
      <div key={entry.path}>
        <div
          className={`file-row ${
            previewEntry?.path === entry.path ? "is-selected" : ""
          } ${
            treeHasFocus && focusedTreePath === entry.path ? "is-focused" : ""
          } ${
            dropTargetPath === entry.path && isDirectory ? "is-drop-target" : ""
          } ${uploading && isDirectory ? "is-uploading" : ""}`}
          data-file-path={entry.path}
          data-parent-path={parentDirectoryPath(entry.path)}
          role="treeitem"
          tabIndex={
            focusedTreePath === entry.path ||
            (!focusedTreePath && defaultTabStop)
              ? 0
              : -1
          }
          aria-level={depth + 1}
          aria-selected={previewEntry?.path === entry.path}
          aria-expanded={isDirectory ? isExpanded : undefined}
          style={{
            paddingLeft: FILE_TREE_BASE_INDENT + depth * FILE_TREE_INDENT,
          }}
          onFocus={() => setFocusedTreePath(entry.path)}
          onKeyDown={(event) =>
            handleEntryKeyDown(event, entry, isDirectory, isExpanded)
          }
          onDragOver={(e) => handleDirectoryDragOver(e, uploadDirectory)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDropTargetPath(null);
            }
          }}
          onDrop={(e) => handleDirectoryDrop(e, uploadDirectory)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openEntryMenu(entry, e.clientX, e.clientY);
          }}
          onPointerDown={(e) => handleEntryPointerDown(e, entry)}
          onPointerMove={handleEntryPointerMove}
          onPointerUp={handleEntryPointerEnd}
          onPointerCancel={handleEntryPointerEnd}
          onPointerLeave={handleEntryPointerEnd}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            if (longPressTriggered.current) {
              longPressTriggered.current = false;
              return;
            }
            activateEntry(entry);
          }}
        >
          <button
            type="button"
            className="file-twisty"
            tabIndex={-1}
            disabled={!isDirectory}
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget
                .closest<HTMLElement>(".file-row")
                ?.focus({ preventScroll: true });
              if (isDirectory) toggleDirectory(entry.path);
            }}
            aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
          >
            {isDirectory ? (
              isExpanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : null}
          </button>
          <span className="file-icon">
            {isDirectory ? (
              isExpanded ? (
                <FolderOpen size={16} />
              ) : (
                <Folder size={16} />
              )
            ) : (
              <File size={16} />
            )}
          </span>
          <span className="file-main">
            <span className="file-name">{entry.name}</span>
            <span className="file-path">{entry.path}</span>
          </span>
          {gitStatus ? (
            <span
              className="file-git-status"
              title={gitStatus.title}
              role="img"
              aria-label={gitStatus.title}
            >
              {gitStatus.codes.map((code) => (
                <span
                  className={`git-status-code git-status-${code.toLowerCase()}`}
                  key={code}
                  aria-hidden="true"
                >
                  {code}
                </span>
              ))}
            </span>
          ) : null}
          {meta ? <span className="file-meta">{meta}</span> : null}
          {loading || uploading || deleting ? (
            <span className="row-spinner" />
          ) : null}
          <span className="file-actions">
            <button
              type="button"
              className="ghost file-action"
              tabIndex={-1}
              title={
                isDirectory ? "Download directory as tar.gz" : "Download file"
              }
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget
                  .closest<HTMLElement>(".file-row")
                  ?.focus({ preventScroll: true });
                downloadEntry(entry);
              }}
            >
              <Download size={14} />
            </button>
            <button
              type="button"
              className="ghost file-action"
              tabIndex={-1}
              title="Copy absolute path"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget
                  .closest<HTMLElement>(".file-row")
                  ?.focus({ preventScroll: true });
                void copyEntryPath(entry);
              }}
            >
              <Copy size={14} />
            </button>
          </span>
        </div>
        {!query && isDirectory && isExpanded
          ? renderDirectory(entry.path, depth + 1)
          : null}
      </div>
    );
  };

  const renderDirectory = (path: string, depth: number) => {
    const entries = children[path];
    if (!entries && loadingPaths.has(path)) {
      return (
        <div
          className="file-row file-row-loading"
          style={{
            paddingLeft: FILE_TREE_BASE_INDENT + depth * FILE_TREE_INDENT,
          }}
        >
          <span className="file-loading-spinner" />
          <span className="file-loading-text">Loading directory</span>
        </div>
      );
    }
    if (!entries) return null;
    if (entries.length === 0) {
      return (
        <div
          className="file-row file-row-muted"
          style={{
            paddingLeft: FILE_TREE_BASE_INDENT + depth * FILE_TREE_INDENT,
          }}
        >
          Empty
        </div>
      );
    }
    return entries.map((entry, index) =>
      renderEntry(entry, depth, path === "" && index === 0),
    );
  };

  const renderInitialLoading = () => (
    <div className="file-skeleton-list" aria-label="Loading files">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="file-skeleton-row" key={index}>
          <span className="file-skeleton-icon" />
          <span className="file-skeleton-lines">
            <span className="file-skeleton-line file-skeleton-line-name" />
            <span className="file-skeleton-line file-skeleton-line-path" />
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {showCloseButton ? (
        <>
          <div className="modal-head">
            <h2>File Explorer</h2>
            <CloseButton onClick={onClose} />
          </div>
          {workspace ? (
            <div className="file-explorer-summary">
              <span>{workspaceName(workspace)}</span>
              <code>
                {rootInfo?.root ??
                  (initialWorkspacePath(workspace) || "Loading path...")}
              </code>
            </div>
          ) : null}
        </>
      ) : null}

      {!workspace ? (
        <p className="modal-error">No workspace is focused.</p>
      ) : null}

      <div className="file-explorer-content">
        <div className="file-explorer-browser">
          <div className="file-explorer-toolbar">
            <label className="file-search">
              <Search size={14} />
              <input
                value={search}
                onChange={(e) => updateCache({ search: e.currentTarget.value })}
                placeholder="Search loaded files"
              />
            </label>
            <label className="file-hidden-toggle">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.currentTarget.checked)}
              />
              Hidden
            </label>
            <button
              type="button"
              className="ghost file-action"
              title="Refresh"
              disabled={!workspace}
              onClick={() => {
                const pathsToRefresh = Array.from(expanded);
                if (!pathsToRefresh.includes("")) pathsToRefresh.unshift("");
                for (const path of pathsToRefresh) {
                  void loadDirectory(path, true);
                }
                void loadGitStatus(true);
                if (previewEntry) void loadPreview(previewEntry);
              }}
            >
              <RefreshCw
                className={gitSummaryState.loading ? "is-spinning" : ""}
                size={15}
              />
            </button>
          </div>

          {error ? <p className="modal-error">{error}</p> : null}
          {rootInfo?.truncated ? (
            <p className="modal-error">
              This directory is truncated at 1000 entries.
            </p>
          ) : null}

          <div
            ref={fileTreeRef}
            className={`file-tree ${dropTargetPath === "" ? "is-drop-target" : ""}`}
            role="tree"
            onFocusCapture={() => setTreeHasFocus(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setTreeHasFocus(false);
              }
            }}
            onDragOver={handleRootDragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDropTargetPath(null);
              }
            }}
            onDrop={handleRootDrop}
          >
            {uploadingPaths.has("") ? (
              <div className="file-upload-status">
                <span className="row-spinner" />
                Uploading to workspace root
              </div>
            ) : dropTargetPath === "" ? (
              <div className="file-upload-status">
                <Upload size={14} />
                Drop files to upload to workspace root
              </div>
            ) : null}
            {query ? (
              searchEntries.length ? (
                searchEntries.map((entry, index) =>
                  renderEntry(entry, 0, index === 0),
                )
              ) : (
                <div className="file-row file-row-muted">
                  No loaded files match.
                </div>
              )
            ) : !children[""] && loadingPaths.has("") ? (
              renderInitialLoading()
            ) : (
              renderDirectory("", 0)
            )}
          </div>
        </div>
        {previewPlacement === "inline" ? (
          <FilePreviewContent
            entry={previewEntry}
            preview={preview}
            loading={previewLoading}
            error={previewError}
          />
        ) : null}
      </div>
      <FileExplorerEntryMenu
        state={entryMenu}
        onClose={() => setEntryMenu(null)}
        onDownload={downloadEntry}
        onCopy={(entry) => {
          void copyEntryPath(entry);
        }}
        onDelete={setPendingDeleteEntry}
      />
      <ConfirmDialog
        open={!!pendingDeleteEntry}
        title={
          pendingDeleteEntry?.type === "directory"
            ? "Delete Directory"
            : "Delete File"
        }
        message={
          pendingDeleteEntry
            ? `Delete ${pendingDeleteEntry.type === "directory" ? "directory" : "file"} "${pendingDeleteEntry.path}"? This cannot be undone.`
            : "Delete this item?"
        }
        confirmLabel="Delete"
        danger
        onClose={() => setPendingDeleteEntry(null)}
        onConfirm={() => {
          if (pendingDeleteEntry) void deleteEntry(pendingDeleteEntry);
        }}
      />
    </>
  );
}
