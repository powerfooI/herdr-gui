import { WORKSPACE_PINS_STORAGE_KEY } from "./workspacePins";
import { COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY } from "./workspaceTreeCollapse";

export const LEGACY_DEFAULT_CONNECTION_ID = "legacy-default";

export const FILE_EXPLORER_WORKSPACE_STORAGE_KEY = "fileExplorerWorkspaceId";
export const FILE_PREVIEW_STORAGE_KEY = "filePreview";
export const DIFF_VIEWER_WORKSPACE_STORAGE_KEY = "diffViewerWorkspaceId";

export interface StoredFilePreview {
  workspaceId: string;
  path: string;
  name: string;
}

export interface ConnectionResourceSelection {
  fileExplorerWorkspaceId?: string;
  filePreview: StoredFilePreview | null;
  diffViewerWorkspaceId?: string;
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type EnumerableStorageWriter = StorageWriter &
  Partial<Pick<Storage, "key" | "length">>;

const LEGACY_MIGRATION_MARKER_KEY = "connectionStorageLegacyMigration:v1";
const DIFF_SELECTION_STORAGE_PREFIX = "diffViewerSelected:";

/**
 * Namespaces one server-resource preference without changing legacy-default
 * keys. Path-segment encoding keeps arbitrary connection IDs and base keys
 * injective while preserving current single-connection browser data.
 */
export function connectionStorageKey(
  connectionId: string,
  baseKey: string,
): string {
  if (!connectionId) throw new Error("invalid connection_id");
  if (!baseKey) throw new Error("invalid storage key");
  if (connectionId === LEGACY_DEFAULT_CONNECTION_ID) return baseKey;
  return `herdr.connection/${encodeURIComponent(connectionId)}/${encodeURIComponent(baseKey)}`;
}

function optionalString(storage: StorageReader, key: string) {
  return storage.getItem(key) || undefined;
}

export function readStoredFilePreview(
  storage: StorageReader,
  connectionId: string,
): StoredFilePreview | null {
  try {
    const raw = storage.getItem(
      connectionStorageKey(connectionId, FILE_PREVIEW_STORAGE_KEY),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as {
      workspaceId?: unknown;
      path?: unknown;
      name?: unknown;
    };
    if (typeof value.workspaceId !== "string") return null;
    if (typeof value.path !== "string") return null;
    return {
      workspaceId: value.workspaceId,
      path: value.path,
      name:
        typeof value.name === "string" && value.name
          ? value.name
          : (value.path.split("/").filter(Boolean).pop() ?? value.path),
    };
  } catch {
    return null;
  }
}

export function readConnectionResourceSelection(
  storage: StorageReader,
  connectionId: string,
): ConnectionResourceSelection {
  return {
    fileExplorerWorkspaceId: optionalString(
      storage,
      connectionStorageKey(connectionId, FILE_EXPLORER_WORKSPACE_STORAGE_KEY),
    ),
    filePreview: readStoredFilePreview(storage, connectionId),
    diffViewerWorkspaceId: optionalString(
      storage,
      connectionStorageKey(connectionId, DIFF_VIEWER_WORKSPACE_STORAGE_KEY),
    ),
  };
}

/** Save the outgoing connection before activating a target connection. */
export function writeConnectionResourceSelection(
  storage: StorageWriter,
  connectionId: string,
  selection: {
    fileExplorerWorkspaceId?: string;
    filePreview?: StoredFilePreview | null;
    diffViewerWorkspaceId?: string;
  },
): void {
  const explorerKey = connectionStorageKey(
    connectionId,
    FILE_EXPLORER_WORKSPACE_STORAGE_KEY,
  );
  if (selection.fileExplorerWorkspaceId) {
    storage.setItem(explorerKey, selection.fileExplorerWorkspaceId);
  } else {
    storage.removeItem(explorerKey);
  }

  const diffKey = connectionStorageKey(
    connectionId,
    DIFF_VIEWER_WORKSPACE_STORAGE_KEY,
  );
  if (selection.diffViewerWorkspaceId) {
    storage.setItem(diffKey, selection.diffViewerWorkspaceId);
  } else {
    storage.removeItem(diffKey);
  }

  // An absent preview means the caller has no newer preview to persist. This
  // preserves a stored preview while its panel is closed or not yet restored.
  if (selection.filePreview !== undefined) {
    const previewKey = connectionStorageKey(
      connectionId,
      FILE_PREVIEW_STORAGE_KEY,
    );
    if (selection.filePreview) {
      storage.setItem(previewKey, JSON.stringify(selection.filePreview));
    } else {
      storage.removeItem(previewKey);
    }
  }
}

/** Copy pre-connection preferences once without overwriting target values. */
export function migrateLegacyConnectionStorage(
  storage: EnumerableStorageWriter,
  targetConnectionId: string,
): boolean {
  if (
    !targetConnectionId ||
    targetConnectionId === LEGACY_DEFAULT_CONNECTION_ID
  ) {
    return false;
  }
  if (storage.getItem(LEGACY_MIGRATION_MARKER_KEY) !== null) return false;

  const legacyKeys = new Set([
    FILE_EXPLORER_WORKSPACE_STORAGE_KEY,
    FILE_PREVIEW_STORAGE_KEY,
    DIFF_VIEWER_WORKSPACE_STORAGE_KEY,
    WORKSPACE_PINS_STORAGE_KEY,
    COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  ]);
  if (typeof storage.key === "function" && typeof storage.length === "number") {
    // Snapshot before writing namespaced values changes Storage.length.
    const existingKeys = Array.from({ length: storage.length }, (_, index) =>
      storage.key?.(index),
    );
    for (const key of existingKeys) {
      if (key?.startsWith(DIFF_SELECTION_STORAGE_PREFIX)) legacyKeys.add(key);
    }
  }

  for (const legacyKey of legacyKeys) {
    const value = storage.getItem(legacyKey);
    if (value === null) continue;
    const targetKey = connectionStorageKey(targetConnectionId, legacyKey);
    if (storage.getItem(targetKey) === null) storage.setItem(targetKey, value);
  }
  storage.setItem(LEGACY_MIGRATION_MARKER_KEY, "1");
  return true;
}

export function transitionConnectionResourceSelection(
  storage: StorageWriter,
  outgoingConnectionId: string,
  outgoingSelection: {
    fileExplorerWorkspaceId?: string;
    filePreview?: StoredFilePreview | null;
    diffViewerWorkspaceId?: string;
  },
  targetConnectionId: string,
): ConnectionResourceSelection {
  writeConnectionResourceSelection(
    storage,
    outgoingConnectionId,
    outgoingSelection,
  );
  return readConnectionResourceSelection(storage, targetConnectionId);
}
