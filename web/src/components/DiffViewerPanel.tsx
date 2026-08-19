import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileDiff,
  Folder,
  RefreshCw,
} from "lucide-react";
import type { ConnectionClient } from "../api";
import type {
  GitDiffEntry,
  GitDiffFile,
  GitDiffKind,
  GitDiffSummary,
} from "../types";
import { useStore } from "../store";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { connectionStorageKey } from "../connectionStorage";

export type ActiveDiffSelection = {
  entry: GitDiffEntry | null;
  file: GitDiffFile | null;
  loading: boolean;
  error: string | null;
  entries: GitDiffEntry[];
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  summaryLoading: boolean;
};

export type DiffSelectionMeta = {
  userInitiated?: boolean;
};

type DiffCache = {
  summary: GitDiffSummary | null;
  selected: GitDiffEntry | null;
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  error: string | null;
};

type DiffScope = "working" | "branch-main";

const diffCache = new Map<string, DiffCache>();
const diffPrefetches = new Map<string, Promise<void>>();
const diffFileRequests = new Map<string, Promise<GitDiffFile>>();
const DIFF_TREE_INDENT = 9;
const DIFF_TREE_BASE_INDENT = 6;
const DIFF_PREFETCH_CONCURRENCY = 3;
const DIFF_SCOPE_KEY = "diffViewerScope";

function loadDiffScope(): DiffScope {
  return localStorage.getItem(DIFF_SCOPE_KEY) === "branch-main"
    ? "branch-main"
    : "working";
}

function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

export function diffCacheKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
) {
  return connectionClientScopeKey(
    client,
    "diff",
    workspaceId ?? "focused",
    scope,
  );
}

function diffFileRequestKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
) {
  return connectionClientScopeKey(
    client,
    "diff-file",
    workspaceId,
    scope,
    diffEntryKey(entry),
  );
}

export function diffSelectionStorageKey(
  connectionId: string,
  workspaceId: string,
  scope: DiffScope,
) {
  return connectionStorageKey(
    connectionId,
    `diffViewerSelected:${workspaceId}:${scope}`,
  );
}

function readStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
): GitDiffEntry | null {
  if (!workspaceId) return null;
  try {
    const raw = localStorage.getItem(
      diffSelectionStorageKey(connectionId, workspaceId, scope),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<GitDiffEntry>;
    if (
      typeof value.path === "string" &&
      ["staged", "unstaged", "untracked", "conflicted", "branch"].includes(
        value.kind ?? "",
      ) &&
      typeof value.status === "string"
    ) {
      return value as GitDiffEntry;
    }
  } catch {
    // Ignore invalid persisted UI state.
  }
  return null;
}

function writeStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
  entry: GitDiffEntry,
) {
  if (!workspaceId) return;
  localStorage.setItem(
    diffSelectionStorageKey(connectionId, workspaceId, scope),
    JSON.stringify(entry),
  );
}

function emptyDiffCache(): DiffCache {
  return {
    summary: null,
    selected: null,
    files: {},
    fileErrors: {},
    error: null,
  };
}

function readDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
) {
  const key = diffCacheKey(client, workspaceId, scope);
  const cached = diffCache.get(key);
  if (cached) {
    return {
      ...cached,
      files: { ...cached.files },
      fileErrors: { ...cached.fileErrors },
    };
  }
  const next = emptyDiffCache();
  diffCache.set(key, next);
  return {
    ...next,
    files: { ...next.files },
    fileErrors: { ...next.fileErrors },
  };
}

function writeDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  patch: Partial<DiffCache>,
) {
  const key = diffCacheKey(client, workspaceId, scope);
  const current = diffCache.get(key) ?? emptyDiffCache();
  diffCache.set(key, {
    ...current,
    ...patch,
    files: patch.files ? { ...patch.files } : { ...current.files },
    fileErrors: patch.fileErrors
      ? { ...patch.fileErrors }
      : { ...current.fileErrors },
  });
}

function resolveSelectedEntry(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  preferred?: GitDiffEntry | null,
) {
  const stored = readStoredSelection(client.connectionId, workspaceId, scope);
  const candidates = [preferred, stored].filter(Boolean) as GitDiffEntry[];
  for (const candidate of candidates) {
    const match = entries.find(
      (entry) => diffEntryKey(entry) === diffEntryKey(candidate),
    );
    if (match) return match;
  }
  return entries[0] ?? null;
}

function requestDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
) {
  if (!client.isCurrent()) {
    return Promise.reject(new Error("connection changed during diff request"));
  }
  const requestKey = diffFileRequestKey(client, workspaceId, scope, entry);
  const running = diffFileRequests.get(requestKey);
  if (running) return running;
  const task = client.call("git.diff_file", {
    workspace_id: workspaceId,
    mode: scope,
    path: entry.path,
    kind: entry.kind,
  }) as Promise<GitDiffFile>;
  diffFileRequests.set(
    requestKey,
    task
      .then((file) => {
        if (!client.isCurrent()) {
          throw new Error("connection changed during diff request");
        }
        return file;
      })
      .finally(() => {
        diffFileRequests.delete(requestKey);
      }),
  );
  return diffFileRequests.get(requestKey)!;
}

function cacheDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  file: GitDiffFile,
) {
  if (!client.isCurrent()) return;
  const cached = readDiffCache(client, workspaceId, scope);
  const nextFileErrors = { ...cached.fileErrors };
  delete nextFileErrors[diffEntryKey(entry)];
  writeDiffCache(client, workspaceId, scope, {
    files: { ...cached.files, [diffEntryKey(entry)]: file },
    fileErrors: nextFileErrors,
    error: null,
  });
}

function prefetchDiffFilesInBatches(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  onFile?: (entry: GitDiffEntry, file: GitDiffFile) => void,
  onFileError?: (entry: GitDiffEntry, error: string) => void,
) {
  const queue = entries.filter((entry) => {
    const cached = readDiffCache(client, workspaceId, scope);
    return !cached.files[diffEntryKey(entry)];
  });
  if (!queue.length) return Promise.resolve();

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const entry = queue[cursor];
      cursor += 1;
      try {
        const file = await requestDiffFile(client, workspaceId, scope, entry);
        if (!client.isCurrent()) return;
        cacheDiffFile(client, workspaceId, scope, entry, file);
        onFile?.(entry, file);
      } catch (e) {
        if (!client.isCurrent()) return;
        onFileError?.(entry, (e as Error).message);
      }
    }
  };

  return Promise.all(
    Array.from(
      { length: Math.min(DIFF_PREFETCH_CONCURRENCY, queue.length) },
      () => worker(),
    ),
  ).then(() => undefined);
}

function workspaceName(workspace?: { label?: string; workspace_id?: string }) {
  return workspace?.label || workspace?.workspace_id || "";
}

function kindLabel(kind: GitDiffKind) {
  switch (kind) {
    case "staged":
      return "Staged";
    case "unstaged":
      return "Unstaged";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflict";
    case "branch":
      return "Branch";
  }
}

function diffStatsForEntries(entries: GitDiffEntry[]) {
  return entries.reduce(
    (total, entry) => ({
      additions: total.additions + (entry.additions ?? 0),
      deletions: total.deletions + (entry.deletions ?? 0),
      hasStats:
        total.hasStats ||
        typeof entry.additions === "number" ||
        typeof entry.deletions === "number",
    }),
    { additions: 0, deletions: 0, hasStats: false },
  );
}

type DiffTreeNode = {
  name: string;
  path: string;
  children: Map<string, DiffTreeNode>;
  entries: GitDiffEntry[];
};

function makeTreeNode(name: string, path: string): DiffTreeNode {
  return { name, path, children: new Map(), entries: [] };
}

function buildDiffTree(entries: GitDiffEntry[]) {
  const root = makeTreeNode("", "");
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = makeTreeNode(part, path);
        node.children.set(part, child);
      }
      node = child;
    });
    node.entries.push(entry);
  }
  return root;
}

function sortDiffTreeChildren(children: Iterable<DiffTreeNode>) {
  return [...children].sort((a, b) => {
    const aFile = a.entries.length > 0;
    const bFile = b.entries.length > 0;
    if (aFile !== bFile) return aFile ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function treeOrderedDiffEntries(entries: GitDiffEntry[]) {
  const ordered: GitDiffEntry[] = [];
  const visit = (node: DiffTreeNode) => {
    for (const child of sortDiffTreeChildren(node.children.values())) {
      if (child.entries.length) {
        ordered.push(...child.entries);
      } else {
        visit(child);
      }
    }
  };
  visit(buildDiffTree(entries));
  return ordered;
}

function expandedDirsForEntries(entries: GitDiffEntry[]) {
  const expanded = new Set<string>([""]);
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      expanded.add(parts.slice(0, i).join("/"));
    }
  }
  return expanded;
}

export function prefetchDiffViewerWorkspace(
  workspaceId: string | undefined,
  client: ConnectionClient,
) {
  if (!workspaceId || !client.isCurrent()) return Promise.resolve();
  const prefetchKey = connectionClientScopeKey(
    client,
    "diff-prefetch",
    workspaceId,
  );
  const running = diffPrefetches.get(prefetchKey);
  if (running) return running;

  const task = (async () => {
    const scope: DiffScope = "working";
    const cached = readDiffCache(client, workspaceId, scope);
    const summary = (await client.call("git.diff_summary", {
      workspace_id: workspaceId,
      mode: scope,
    })) as GitDiffSummary;
    if (!client.isCurrent()) return;
    const selected = resolveSelectedEntry(
      client,
      workspaceId,
      scope,
      summary.entries,
      cached.selected,
    );
    const files = { ...cached.files };

    writeDiffCache(client, workspaceId, scope, {
      summary,
      selected,
      files,
      error: null,
    });

    if (!selected) return;
    const key = diffEntryKey(selected);
    if (files[key]) return;
    const file = await requestDiffFile(client, workspaceId, scope, selected);
    if (!client.isCurrent()) return;
    writeDiffCache(client, workspaceId, scope, {
      summary,
      selected,
      files: { ...files, [key]: file },
      error: null,
    });
  })()
    .catch(() => {
      // Background warmups should never surface transient bridge errors.
    })
    .finally(() => {
      diffPrefetches.delete(prefetchKey);
    });

  diffPrefetches.set(prefetchKey, task);
  return task;
}

export function DiffViewerPanel({
  workspaceId,
  onSelectionChange,
}: {
  workspaceId?: string;
  onSelectionChange?: (
    selection: ActiveDiffSelection,
    meta?: DiffSelectionMeta,
  ) => void;
}) {
  const s = useStore();
  const connectionClient = useConnectionClient();
  const focusedWorkspace = s.workspaces.find((w) => w.focused);
  const workspace =
    s.workspaces.find((w) => w.workspace_id === workspaceId) ??
    focusedWorkspace;
  const cacheWorkspaceId = workspace?.workspace_id;
  const [diffScope, setDiffScope] = useState<DiffScope>(() => loadDiffScope());
  const [cache, setCache] = useState<DiffCache>(() =>
    readDiffCache(connectionClient, cacheWorkspaceId, loadDiffScope()),
  );
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [fileLoadingKey, setFileLoadingKey] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set([""]),
  );
  const activeContextRef = useRef(
    diffCacheKey(connectionClient, cacheWorkspaceId, diffScope),
  );

  useEffect(() => {
    activeContextRef.current = diffCacheKey(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
    );
  }, [cacheWorkspaceId, connectionClient, diffScope]);

  const isCurrentContext = (
    workspaceId: string | undefined,
    scope: DiffScope,
  ) =>
    connectionClient.isCurrent() &&
    activeContextRef.current ===
      diffCacheKey(connectionClient, workspaceId, scope);

  const updateCache = (patch: Partial<DiffCache>) => {
    setCache((current) => {
      const next = {
        ...current,
        ...patch,
        files: patch.files ? { ...patch.files } : { ...current.files },
        fileErrors: patch.fileErrors
          ? { ...patch.fileErrors }
          : { ...current.fileErrors },
      };
      writeDiffCache(connectionClient, cacheWorkspaceId, diffScope, next);
      return next;
    });
  };

  const diffSelection = useCallback(
    (
      source: DiffCache = cache,
      patch: Partial<ActiveDiffSelection> = {},
    ): ActiveDiffSelection => {
      const selected = patch.entry ?? source.selected;
      const files = patch.files ?? source.files;
      const key = selected ? diffEntryKey(selected) : "";
      return {
        entry: selected,
        file: patch.file ?? (key ? (files[key] ?? null) : null),
        loading:
          patch.loading ??
          (summaryLoading || (!!key && fileLoadingKey === key && !files[key])),
        error: patch.error ?? source.error,
        entries:
          patch.entries ??
          treeOrderedDiffEntries(source.summary?.entries ?? []),
        files,
        fileErrors: patch.fileErrors ?? source.fileErrors,
        summaryLoading: patch.summaryLoading ?? summaryLoading,
      };
    },
    [cache, fileLoadingKey, summaryLoading],
  );

  useEffect(() => {
    onSelectionChange?.(diffSelection(cache));
  }, [cache, diffSelection, onSelectionChange]);

  const loadSummary = async (previousSelected = cache.selected) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    setSummaryLoading(true);
    updateCache({ error: null });
    try {
      const summary = (await connectionClient.call("git.diff_summary", {
        workspace_id: workspaceId,
        mode: scope,
      })) as GitDiffSummary;
      if (!isCurrentContext(workspaceId, scope)) return;
      if (!connectionClient.isCurrent()) return;
      const selected = resolveSelectedEntry(
        connectionClient,
        workspaceId,
        scope,
        summary.entries,
        previousSelected,
      );
      updateCache({
        summary,
        selected,
      });
      setExpandedDirs(expandedDirsForEntries(summary.entries));
    } catch (e) {
      if (!isCurrentContext(workspaceId, scope)) return;
      updateCache({ error: (e as Error).message });
    } finally {
      if (isCurrentContext(workspaceId, scope)) setSummaryLoading(false);
    }
  };

  const loadFile = async (
    entry: GitDiffEntry,
    meta: DiffSelectionMeta = {},
  ) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    const key = diffEntryKey(entry);
    updateCache({ selected: entry, error: null });
    writeStoredSelection(
      connectionClient.connectionId,
      workspaceId,
      scope,
      entry,
    );
    const cachedFile = cache.files[key];
    if (cachedFile) {
      onSelectionChange?.(
        diffSelection(cache, { entry, file: cachedFile }),
        meta,
      );
      return;
    }
    setFileLoadingKey(key);
    onSelectionChange?.(
      diffSelection(cache, { entry, file: null, loading: true, error: null }),
      meta,
    );
    try {
      const file = await requestDiffFile(
        connectionClient,
        workspaceId,
        scope,
        entry,
      );
      if (!isCurrentContext(workspaceId, scope)) return;
      setCache((current) => {
        const next = {
          ...current,
          selected: entry,
          files: { ...current.files, [key]: file },
          fileErrors: Object.fromEntries(
            Object.entries(current.fileErrors).filter(
              ([errorKey]) => errorKey !== key,
            ),
          ),
          error: null,
        };
        writeDiffCache(connectionClient, cacheWorkspaceId, scope, next);
        return next;
      });
      onSelectionChange?.(
        diffSelection(cache, {
          entry,
          file,
          files: { ...cache.files, [key]: file },
          fileErrors: Object.fromEntries(
            Object.entries(cache.fileErrors).filter(
              ([errorKey]) => errorKey !== key,
            ),
          ),
          loading: false,
          error: null,
        }),
        meta,
      );
    } catch (e) {
      if (!isCurrentContext(workspaceId, scope)) return;
      const message = (e as Error).message;
      updateCache({
        error: message,
        fileErrors: { ...cache.fileErrors, [key]: message },
      });
      onSelectionChange?.(
        diffSelection(cache, {
          entry,
          file: null,
          loading: false,
          error: message,
          fileErrors: { ...cache.fileErrors, [key]: message },
        }),
        meta,
      );
    } finally {
      if (isCurrentContext(workspaceId, scope)) setFileLoadingKey(null);
    }
  };

  const selectedDiffEntryKey = cache.selected
    ? diffEntryKey(cache.selected)
    : "";

  useEffect(() => {
    localStorage.setItem(DIFF_SCOPE_KEY, diffScope);
  }, [diffScope]);

  useEffect(() => {
    const cached = readDiffCache(connectionClient, cacheWorkspaceId, diffScope);
    setFileLoadingKey(null);
    setCache(cached);
    setExpandedDirs(expandedDirsForEntries(cached.summary?.entries ?? []));
    onSelectionChange?.({
      entry: cached.selected,
      file: cached.selected
        ? (cached.files[diffEntryKey(cached.selected)] ?? null)
        : null,
      loading: false,
      error: cached.error,
      entries: treeOrderedDiffEntries(cached.summary?.entries ?? []),
      files: cached.files,
      fileErrors: cached.fileErrors,
      summaryLoading: false,
    });
    void loadSummary(cached.selected);
    // Reopen against a fresh workspace snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheWorkspaceId, connectionClient, diffScope]);

  useEffect(() => {
    if (cache.selected) void loadFile(cache.selected);
    else {
      onSelectionChange?.(
        diffSelection(cache, {
          entry: null,
          file: null,
          loading: false,
          error: null,
        }),
      );
    }
    // Load the selected file whenever summary refresh changes selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheWorkspaceId, connectionClient, diffScope, selectedDiffEntryKey]);

  useEffect(() => {
    if (!cacheWorkspaceId || !cache.summary?.entries.length) return;
    let cancelled = false;
    void prefetchDiffFilesInBatches(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
      cache.summary.entries,
      (entry, file) => {
        if (cancelled) return;
        if (!connectionClient.isCurrent()) return;
        cacheDiffFile(
          connectionClient,
          cacheWorkspaceId,
          diffScope,
          entry,
          file,
        );
        setCache((current) => {
          const key = diffEntryKey(entry);
          if (current.files[key]) return current;
          const nextFileErrors = { ...current.fileErrors };
          delete nextFileErrors[key];
          const next = {
            ...current,
            files: { ...current.files, [key]: file },
            fileErrors: nextFileErrors,
          };
          writeDiffCache(connectionClient, cacheWorkspaceId, diffScope, next);
          return next;
        });
      },
      (entry, error) => {
        if (cancelled || !connectionClient.isCurrent()) return;
        const key = diffEntryKey(entry);
        setCache((current) => {
          const next = {
            ...current,
            fileErrors: { ...current.fileErrors, [key]: error },
          };
          writeDiffCache(connectionClient, cacheWorkspaceId, diffScope, next);
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cacheWorkspaceId, cache.summary?.entries, connectionClient, diffScope]);

  const selectedKey = cache.selected ? diffEntryKey(cache.selected) : null;
  const tree = useMemo(
    () => buildDiffTree(cache.summary?.entries ?? []),
    [cache.summary?.entries],
  );

  const toggleDir = (path: string) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderTreeNode = (node: DiffTreeNode, depth: number): ReactNode[] => {
    const items: ReactNode[] = [];
    const children = sortDiffTreeChildren(node.children.values());

    for (const child of children) {
      const isFile = child.entries.length > 0;
      const open = expandedDirs.has(child.path);
      if (!isFile) {
        items.push(
          <button
            type="button"
            className="diff-tree-row diff-tree-folder"
            style={{
              paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
            }}
            key={child.path}
            onClick={() => toggleDir(child.path)}
          >
            <span className="diff-tree-twisty">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            <Folder size={15} />
            <span className="diff-tree-name">{child.name}</span>
          </button>,
        );
        if (open) items.push(...renderTreeNode(child, depth + 1));
        continue;
      }

      const primary = child.entries[0];
      const selected = child.entries.some(
        (entry) => diffEntryKey(entry) === selectedKey,
      );
      const stats = diffStatsForEntries(child.entries);
      items.push(
        <button
          type="button"
          key={child.path}
          className={`diff-tree-row diff-tree-file ${selected ? "is-selected" : ""}`}
          style={{
            paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
          }}
          onClick={() => void loadFile(primary, { userInitiated: true })}
        >
          <span className="diff-tree-twisty" />
          <File size={15} />
          <span className="diff-tree-name">{child.name}</span>
          <span className="diff-tree-badges">
            {child.entries.map((entry) => (
              <span
                className={`diff-kind diff-kind-${entry.kind}`}
                key={diffEntryKey(entry)}
              >
                {kindLabel(entry.kind)}
              </span>
            ))}
          </span>
          {stats.hasStats ? (
            <span className="diff-tree-stats" aria-label="Line changes">
              <span className="diff-stat-add">+{stats.additions}</span>
              <span className="diff-stat-del">-{stats.deletions}</span>
            </span>
          ) : null}
        </button>,
      );
    }
    return items;
  };

  return (
    <aside className="diff-viewer-side" aria-label="Diff Viewer">
      <div className="modal-head">
        <h2>Diff Viewer</h2>
        <button
          type="button"
          className="ghost"
          title="Refresh"
          onClick={() => void loadSummary()}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="diff-scope-toggle" aria-label="Diff scope">
        <button
          type="button"
          className={diffScope === "working" ? "is-active" : ""}
          onClick={() => setDiffScope("working")}
          aria-pressed={diffScope === "working"}
        >
          Working tree
        </button>
        <button
          type="button"
          className={diffScope === "branch-main" ? "is-active" : ""}
          onClick={() => setDiffScope("branch-main")}
          aria-pressed={diffScope === "branch-main"}
        >
          Against main
        </button>
      </div>

      {workspace ? (
        <div className="diff-summary-head">
          <span>
            {workspaceName(workspace)}
            {cache.summary?.base ? ` · base ${cache.summary.base}` : ""}
          </span>
          <code>
            {cache.summary?.root ??
              workspace.worktree?.checkout_path ??
              workspace.cwd ??
              ""}
          </code>
        </div>
      ) : (
        <p className="modal-error">No workspace is focused.</p>
      )}

      {cache.error ? <p className="modal-error">{cache.error}</p> : null}

      <div className="diff-list diff-tree" aria-label="Changed files">
        {summaryLoading && !cache.summary ? (
          <DiffSkeleton />
        ) : cache.summary?.entries.length ? (
          renderTreeNode(tree, 0)
        ) : (
          <div className="diff-empty">
            <FileDiff size={18} />
            <span>No changes</span>
          </div>
        )}
      </div>
      {fileLoadingKey ? (
        <div className="diff-loading-inline">Loading diff...</div>
      ) : null}
    </aside>
  );
}

function DiffSkeleton() {
  return (
    <div className="diff-skeleton-list">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="diff-skeleton-row" key={index}>
          <span className="diff-skeleton-badge" />
          <span className="diff-skeleton-lines">
            <span className="diff-skeleton-line diff-skeleton-line-name" />
            <span className="diff-skeleton-line diff-skeleton-line-status" />
          </span>
        </div>
      ))}
    </div>
  );
}
