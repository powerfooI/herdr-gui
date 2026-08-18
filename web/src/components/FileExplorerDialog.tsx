import {
  type DragEvent,
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
import { bridge } from "../api";
import { store, useStore } from "../store";
import type {
  FileExplorerEntry,
  FileExplorerList,
  FilePreview,
  GitDiffEntry,
  GitDiffKind,
  GitDiffSummary,
} from "../types";
import { ConfirmDialog } from "./ModalDialogs";
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
};

const explorerCache = new Map<string, FileExplorerCache>();
const explorerPrefetches = new Map<string, Promise<void>>();
const previewCache = new Map<string, FilePreview>();
const previewRequests = new Map<string, Promise<FilePreview>>();
const FILE_TREE_INDENT = 10;
const FILE_TREE_BASE_INDENT = 6;

function explorerCacheKey(workspaceId?: string, showHidden = false) {
  return `${workspaceId ?? "focused"}:${showHidden ? "hidden" : "visible"}`;
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

function readExplorerCache(workspaceId?: string, showHidden = false) {
  const key = explorerCacheKey(workspaceId, showHidden);
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
  workspaceId: string | undefined,
  showHidden: boolean,
  patch: Partial<FileExplorerCache>,
) {
  const key = explorerCacheKey(workspaceId, showHidden);
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

function previewCacheKey(workspaceId: string | undefined, path: string) {
  return `${workspaceId ?? "focused"}:${path}`;
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

function buildGitStatusMaps(
  summary: GitDiffSummary | null,
  explorerRoot?: string,
) {
  const fileStatuses = new Map<string, FileGitStatus>();
  const directoryChangedFiles = new Map<string, Set<string>>();
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
    const next: FileGitStatus = {
      label: gitStatusLabel(entry),
      title: `${gitKindLabel(entry.kind)} ${entry.status}`,
      tone: gitStatusTone(entry),
      priority: gitStatusPriority(entry),
    };
    const currentDescriptions = descriptions.get(mappedPath) ?? [];
    currentDescriptions.push(next.title);
    descriptions.set(mappedPath, currentDescriptions);
    if (!existing || next.priority > existing.priority) {
      fileStatuses.set(mappedPath, next);
    }

    const parts = mappedPath.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const directory = parts.slice(0, i + 1).join("/");
      const changedFiles =
        directoryChangedFiles.get(directory) ?? new Set<string>();
      changedFiles.add(mappedPath);
      directoryChangedFiles.set(directory, changedFiles);
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
    });
  }

  return { fileStatuses, directoryStatuses };
}

export function requestFilePreview(
  workspaceId: string,
  path: string,
  options?: { refresh?: boolean },
) {
  const key = previewCacheKey(workspaceId, path);
  const cached = previewCache.get(key);
  if (cached && !options?.refresh) return Promise.resolve(cached);
  const running = previewRequests.get(key);
  if (running) return running;
  const task = bridge.call("file.read", {
    workspace_id: workspaceId,
    path,
  }) as Promise<FilePreview>;
  previewRequests.set(
    key,
    task
      .then((preview) => {
        previewCache.set(key, preview);
        return preview;
      })
      .finally(() => {
        previewRequests.delete(key);
      }),
  );
  return previewRequests.get(key)!;
}

async function uploadExplorerFile(
  workspaceId: string,
  directory: string,
  file: File,
) {
  const url = new URL("/api/file/upload", window.location.origin);
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("directory", directory);
  url.searchParams.set("filename", file.name);
  const response = await fetch(url, {
    method: "POST",
    body: file,
  });
  const text = await response.text();
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

async function deleteExplorerEntry(workspaceId: string, path: string) {
  const url = new URL("/api/file/delete", window.location.origin);
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("path", path);
  const response = await fetch(url, { method: "POST" });
  const text = await response.text();
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

export function prefetchFileExplorerWorkspace(workspaceId?: string) {
  if (!workspaceId) return Promise.resolve();
  const showHidden = false;
  const key = explorerCacheKey(workspaceId, showHidden);
  const running = explorerPrefetches.get(key);
  if (running) return running;

  const task = (async () => {
    const cached = readExplorerCache(workspaceId, showHidden);
    const paths = Array.from(cached.expanded);
    if (!paths.includes("")) paths.unshift("");

    for (const path of paths) {
      const list = (await bridge.call("file.list", {
        workspace_id: workspaceId,
        path,
        show_hidden: showHidden,
      })) as FileExplorerList;
      const latest = readExplorerCache(workspaceId, showHidden);
      writeExplorerCache(workspaceId, showHidden, {
        rootInfo: list,
        children: { ...latest.children, [path]: list.entries },
        expanded: latest.expanded,
        error: null,
      });
    }
  })()
    .catch(() => {
      // Background warmups should never surface transient bridge errors.
    })
    .finally(() => {
      explorerPrefetches.delete(key);
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
  activePath,
  onClose,
  onPreviewChange,
}: {
  open: boolean;
  workspaceId?: string;
  activePath?: string;
  onClose: () => void;
  onPreviewChange?: (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => void;
}) {
  if (!open) return null;

  return (
    <aside className="file-explorer-side" aria-label="File Explorer">
      <FileExplorerContent
        open={open}
        workspaceId={workspaceId}
        onClose={onClose}
        showCloseButton={false}
        previewPlacement="external"
        activePath={activePath}
        onPreviewChange={onPreviewChange}
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

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onClose, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

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
    <div ref={ref} className="context-menu" style={style}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
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
  onClose,
  showCloseButton,
  previewPlacement = "inline",
  activePath,
  onPreviewChange,
}: {
  open: boolean;
  workspaceId?: string;
  onClose: () => void;
  showCloseButton: boolean;
  previewPlacement?: "inline" | "external";
  activePath?: string;
  onPreviewChange?: (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => void;
}) {
  const s = useStore();
  const focusedWorkspace = s.workspaces.find((w) => w.focused);
  const workspace =
    s.workspaces.find((w) => w.workspace_id === workspaceId) ??
    focusedWorkspace;
  const cacheWorkspaceId = workspace?.workspace_id;
  const [showHidden, setShowHidden] = useState(false);
  const [cache, setCache] = useState<FileExplorerCache>(() =>
    readExplorerCache(cacheWorkspaceId, showHidden),
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
  const [gitSummary, setGitSummary] = useState<GitDiffSummary | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [previewEntry, setPreviewEntry] = useState<FileExplorerEntry | null>(
    null,
  );
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);
  const gitStatusRequestKeyRef = useRef<string | null>(null);
  const previewRequestKeyRef = useRef<string | null>(null);
  const fileTreeRef = useRef<HTMLDivElement | null>(null);
  const { search, rootInfo, children, expanded, error } = cache;
  const gitStatusMaps = useMemo(
    () => buildGitStatusMaps(gitSummary, rootInfo?.root),
    [gitSummary, rootInfo?.root],
  );
  const emitPreviewChange = (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => {
    onPreviewChange?.(selection, meta);
  };

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
      writeExplorerCache(cacheWorkspaceId, showHidden, next);
      return next;
    });
  };

  const clearLongPressTimer = () => {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const loadDirectory = async (path: string, force = false) => {
    if (!workspace?.workspace_id) return;
    if (!force && children[path]) return;
    setLoadingPaths((current) => new Set(current).add(path));
    updateCache({ error: null });
    try {
      const list = (await bridge.call("file.list", {
        workspace_id: workspace.workspace_id,
        path,
        show_hidden: showHidden,
      })) as FileExplorerList;
      setCache((current) => {
        const next = {
          ...current,
          rootInfo: list,
          children: { ...current.children, [path]: list.entries },
          expanded: new Set(current.expanded),
          error: null,
        };
        writeExplorerCache(cacheWorkspaceId, showHidden, next);
        return next;
      });
    } catch (e) {
      updateCache({ error: (e as Error).message });
    } finally {
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  };

  const loadGitStatus = async () => {
    if (!workspace?.workspace_id) {
      gitStatusRequestKeyRef.current = null;
      setGitSummary(null);
      setGitStatusLoading(false);
      return;
    }
    const requestKey = workspace.workspace_id;
    gitStatusRequestKeyRef.current = requestKey;
    setGitStatusLoading(true);
    try {
      const summary = (await bridge.call("git.diff_summary", {
        workspace_id: requestKey,
        mode: "working",
      })) as GitDiffSummary;
      if (gitStatusRequestKeyRef.current === requestKey) {
        setGitSummary(summary);
      }
    } catch {
      if (gitStatusRequestKeyRef.current === requestKey) {
        setGitSummary(null);
      }
    } finally {
      if (gitStatusRequestKeyRef.current === requestKey) {
        setGitStatusLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!open) return;
    const cached = readExplorerCache(cacheWorkspaceId, showHidden);
    setCache(cached);
    setLoadingPaths(new Set());
    setUploadingPaths(new Set());
    setDeletingPaths(new Set());
    setDropTargetPath(null);
    setEntryMenu(null);
    setPendingDeleteEntry(null);
    setGitSummary(null);
    setGitStatusLoading(false);
    gitStatusRequestKeyRef.current = null;
    setPreviewEntry(null);
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
    if (previewPlacement === "inline") {
      emitPreviewChange({
        entry: null,
        preview: null,
        loading: false,
        error: null,
      });
    }
    previewRequestKeyRef.current = null;
    const pathsToRefresh = Array.from(cached.expanded);
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
  }, [cacheWorkspaceId, open, showHidden, showCloseButton]);

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
      let latest = readExplorerCache(workspaceId, showHidden);
      const nextExpanded = new Set(latest.expanded);
      for (const path of parentPaths) nextExpanded.add(path);
      writeExplorerCache(workspaceId, showHidden, {
        expanded: nextExpanded,
      });
      if (!cancelled) {
        setCache((current) => ({
          ...current,
          expanded: new Set(nextExpanded),
        }));
      }

      for (const path of parentPaths) {
        if (cancelled) return;
        latest = readExplorerCache(workspaceId, showHidden);
        if (latest.children[path]) continue;
        setLoadingPaths((current) => new Set(current).add(path));
        try {
          const list = (await bridge.call("file.list", {
            workspace_id: workspaceId,
            path,
            show_hidden: showHidden,
          })) as FileExplorerList;
          latest = readExplorerCache(workspaceId, showHidden);
          const expandedWithPath = new Set(latest.expanded);
          for (const parentPath of parentPaths)
            expandedWithPath.add(parentPath);
          writeExplorerCache(workspaceId, showHidden, {
            rootInfo: list,
            children: { ...latest.children, [path]: list.entries },
            expanded: expandedWithPath,
            error: null,
          });
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
          if (!cancelled) {
            setCache((current) => ({
              ...current,
              error: (e as Error).message,
            }));
          }
        } finally {
          if (!cancelled) {
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
  }, [activePath, cacheWorkspaceId, open, showHidden, workspace?.workspace_id]);

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
  const searchEntries = query
    ? loadedEntries.filter((entry) =>
        [entry.name, entry.path].some((value) =>
          value.toLowerCase().includes(query),
        ),
      )
    : [];

  useEffect(() => {
    if (!activePath || !isWorkspaceRelativePath(activePath)) return;
    const tree = fileTreeRef.current;
    if (!tree) return;
    const row = Array.from(
      tree.querySelectorAll<HTMLElement>(".file-row[data-file-path]"),
    ).find((candidate) => candidate.dataset.filePath === activePath);
    row?.scrollIntoView({ block: "nearest" });
  }, [activePath, children, expanded, query]);

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
    const workspaceId = workspace.workspace_id;
    const key = previewCacheKey(workspaceId, entry.path);
    previewRequestKeyRef.current = key;
    setPreviewEntry(entry);
    setPreviewError(null);
    const cached = previewCache.get(key);
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
      });
      if (previewRequestKeyRef.current === key) {
        setPreview(next);
        emitPreviewChange(
          { entry, preview: next, loading: false, error: null },
          { userInitiated: true },
        );
      }
    } catch (e) {
      if (previewRequestKeyRef.current === key && !cached) {
        const message = (e as Error).message;
        setPreviewError(message);
        emitPreviewChange(
          { entry, preview: null, loading: false, error: message },
          { userInitiated: true },
        );
      }
    } finally {
      if (previewRequestKeyRef.current === key) setPreviewLoading(false);
    }
  };

  const copyEntryPath = async (entry: FileExplorerEntry) => {
    const root = rootInfo?.root || initialWorkspacePath(workspace);
    const value = root ? absolutePath(root, entry) : entry.path;
    try {
      await navigator.clipboard.writeText(value);
      store.notify({
        kind: "success",
        message: "Path copied",
        detail: value,
        autoDismissMs: 5000,
      });
    } catch (e) {
      store.notify({
        kind: "error",
        message: "Failed to copy path",
        detail: (e as Error).message,
      });
    }
  };

  const downloadEntry = (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id) return;
    const url = new URL("/api/file/download", window.location.origin);
    url.searchParams.set("workspace_id", workspace.workspace_id);
    url.searchParams.set("path", entry.path);
    const link = document.createElement("a");
    link.href = url.toString();
    link.download =
      entry.type === "directory"
        ? `${entry.name || "download"}.tar.gz`
        : entry.name || "download";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    store.notify({
      kind: "info",
      message: "Download started",
      detail: entry.path,
      autoDismissMs: 5000,
    });
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
      writeExplorerCache(cacheWorkspaceId, showHidden, next);
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
    const cacheKey = previewCacheKey(workspace.workspace_id, entry.path);
    previewCache.delete(cacheKey);
    if (entry.type === "directory") {
      const childCacheKeyPrefix = `${cacheKey}/`;
      for (const key of previewCache.keys()) {
        if (key.startsWith(childCacheKeyPrefix)) previewCache.delete(key);
      }
    }
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
    if (!workspace?.workspace_id) return;
    markDeletePath(entry.path, true);
    updateCache({ error: null });
    try {
      await deleteExplorerEntry(workspace.workspace_id, entry.path);
      removeEntryFromCache(entry);
      clearDeletedPreview(entry);
      await loadDirectory(parentDirectoryPath(entry.path), true);
      void loadGitStatus();
      store.notify({
        kind: "success",
        message:
          entry.type === "directory" ? "Directory deleted" : "File deleted",
        detail: entry.path,
        autoDismissMs: 5000,
      });
    } catch (e) {
      store.notify({
        kind: "error",
        message: "Delete failed",
        detail: (e as Error).message,
      });
    } finally {
      markDeletePath(entry.path, false);
    }
  };

  const invalidateUploadedPreviews = (paths: string[]) => {
    if (!workspace?.workspace_id || !paths.length) return;
    for (const path of paths) {
      previewCache.delete(previewCacheKey(workspace.workspace_id, path));
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
    if (!workspace?.workspace_id) return;
    const uploadFiles = Array.from(files).filter((file) => file.name);
    if (!uploadFiles.length) return;
    markUploadPath(directory, true);
    updateCache({ error: null });
    try {
      const results = await Promise.allSettled(
        uploadFiles.map((file) =>
          uploadExplorerFile(workspace.workspace_id, directory, file),
        ),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) throw failed.reason;
      if (directory) {
        updateCache({ expanded: new Set(expanded).add(directory) });
      }
      await loadDirectory(directory, true);
      invalidateUploadedPreviews(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.path] : [],
        ),
      );
      void loadGitStatus();
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
      store.notify({
        kind: "error",
        message: "Upload failed",
        detail: (e as Error).message,
      });
    } finally {
      markUploadPath(directory, false);
      setDropTargetPath(null);
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

  const renderEntry = (entry: FileExplorerEntry, depth: number) => {
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
          } ${dropTargetPath === entry.path && isDirectory ? "is-drop-target" : ""} ${
            uploading && isDirectory ? "is-uploading" : ""
          }`}
          data-file-path={entry.path}
          style={{
            paddingLeft: FILE_TREE_BASE_INDENT + depth * FILE_TREE_INDENT,
          }}
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
          onClick={() => {
            if (longPressTriggered.current) {
              longPressTriggered.current = false;
              return;
            }
            if (isDirectory) {
              toggleDirectory(entry.path);
            } else {
              void loadPreview(entry);
            }
          }}
        >
          <button
            type="button"
            className="file-twisty"
            disabled={!isDirectory}
            onClick={(e) => {
              e.stopPropagation();
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
              className={`file-git-status is-${gitStatus.tone}`}
              title={gitStatus.title}
            >
              {gitStatus.label}
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
              title={
                isDirectory ? "Download directory as tar.gz" : "Download file"
              }
              onClick={(e) => {
                e.stopPropagation();
                downloadEntry(entry);
              }}
            >
              <Download size={14} />
            </button>
            <button
              type="button"
              className="ghost file-action"
              title="Copy absolute path"
              onClick={(e) => {
                e.stopPropagation();
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
    return entries.map((entry) => renderEntry(entry, depth));
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
      <div className="modal-head">
        <h2>File Explorer</h2>
        {showCloseButton ? (
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        ) : null}
      </div>

      {workspace ? (
        <div className="file-explorer-summary">
          <span>{workspaceName(workspace)}</span>
          <code>
            {rootInfo?.root ??
              (initialWorkspacePath(workspace) || "Loading path...")}
          </code>
        </div>
      ) : (
        <p className="modal-error">No workspace is focused.</p>
      )}

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
                void loadGitStatus();
              }}
            >
              <RefreshCw
                className={gitStatusLoading ? "is-spinning" : ""}
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
                searchEntries.map((entry) => renderEntry(entry, 0))
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
