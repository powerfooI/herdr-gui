import { describe, expect, test } from "bun:test";
import {
  connectionStorageKey,
  FILE_EXPLORER_WORKSPACE_STORAGE_KEY,
  FILE_PREVIEW_STORAGE_KEY,
  LEGACY_DEFAULT_CONNECTION_ID,
  migrateLegacyConnectionStorage,
  readConnectionResourceSelection,
  transitionConnectionResourceSelection,
  writeConnectionResourceSelection,
} from "./connectionStorage";
import { WORKSPACE_PINS_STORAGE_KEY } from "./workspacePins";
import { COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY } from "./workspaceTreeCollapse";
import { connectionClientScopeKey } from "./useConnectionClient";

class MemoryStorage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("connection resource storage", () => {
  test("preserves legacy-default keys and injectively encodes other identities", () => {
    expect(
      connectionStorageKey(
        LEGACY_DEFAULT_CONNECTION_ID,
        FILE_EXPLORER_WORKSPACE_STORAGE_KEY,
      ),
    ).toBe(FILE_EXPLORER_WORKSPACE_STORAGE_KEY);
    expect(connectionStorageKey("alpha/beta", "file/preview")).not.toBe(
      connectionStorageKey("alpha", "beta/file/preview"),
    );
    expect(
      connectionStorageKey("alpha:one", WORKSPACE_PINS_STORAGE_KEY),
    ).not.toBe(
      connectionStorageKey("alpha", `one:${WORKSPACE_PINS_STORAGE_KEY}`),
    );
  });

  test("copies legacy single-connection preferences into the first real profile once", () => {
    const storage = new MemoryStorage();
    storage.setItem(FILE_EXPLORER_WORKSPACE_STORAGE_KEY, "legacy-workspace");
    storage.setItem(FILE_PREVIEW_STORAGE_KEY, '{"path":"legacy.md"}');
    storage.setItem(WORKSPACE_PINS_STORAGE_KEY, '["legacy-pin"]');
    storage.setItem(COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY, '["legacy-group"]');
    storage.setItem(
      "diffViewerSelected:workspace:working",
      '{"path":"legacy-diff.ts","kind":"modified"}',
    );
    storage.setItem(
      connectionStorageKey("alpha", FILE_PREVIEW_STORAGE_KEY),
      '{"path":"alpha.md"}',
    );

    expect(migrateLegacyConnectionStorage(storage, "alpha")).toBeTrue();
    expect(
      storage.getItem(
        connectionStorageKey("alpha", FILE_EXPLORER_WORKSPACE_STORAGE_KEY),
      ),
    ).toBe("legacy-workspace");
    expect(
      storage.getItem(connectionStorageKey("alpha", FILE_PREVIEW_STORAGE_KEY)),
    ).toBe('{"path":"alpha.md"}');
    expect(
      storage.getItem(
        connectionStorageKey("alpha", WORKSPACE_PINS_STORAGE_KEY),
      ),
    ).toBe('["legacy-pin"]');
    expect(
      storage.getItem(
        connectionStorageKey("alpha", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY),
      ),
    ).toBe('["legacy-group"]');
    expect(
      storage.getItem(
        connectionStorageKey("alpha", "diffViewerSelected:workspace:working"),
      ),
    ).toContain("legacy-diff.ts");

    storage.removeItem(
      connectionStorageKey("alpha", FILE_EXPLORER_WORKSPACE_STORAGE_KEY),
    );
    storage.setItem(FILE_EXPLORER_WORKSPACE_STORAGE_KEY, "new-legacy-value");
    expect(migrateLegacyConnectionStorage(storage, "alpha")).toBeFalse();
    expect(migrateLegacyConnectionStorage(storage, "beta")).toBeFalse();
    expect(
      storage.getItem(
        connectionStorageKey("alpha", FILE_EXPLORER_WORKSPACE_STORAGE_KEY),
      ),
    ).toBeNull();
    expect(
      storage.getItem(
        connectionStorageKey("beta", FILE_EXPLORER_WORKSPACE_STORAGE_KEY),
      ),
    ).toBeNull();
  });

  test("keeps colliding workspace resources independent across connections", () => {
    const storage = new MemoryStorage();
    writeConnectionResourceSelection(storage, "alpha", {
      fileExplorerWorkspaceId: "same",
      filePreview: {
        workspaceId: "same",
        path: "alpha.txt",
        name: "alpha.txt",
      },
      diffViewerWorkspaceId: "same",
    });
    writeConnectionResourceSelection(storage, "beta", {
      fileExplorerWorkspaceId: "same",
      filePreview: {
        workspaceId: "same",
        path: "beta.txt",
        name: "beta.txt",
      },
      diffViewerWorkspaceId: "same",
    });
    storage.setItem(
      connectionStorageKey("alpha", WORKSPACE_PINS_STORAGE_KEY),
      '["alpha-pin"]',
    );
    storage.setItem(
      connectionStorageKey("beta", WORKSPACE_PINS_STORAGE_KEY),
      '["beta-pin"]',
    );
    storage.setItem(
      connectionStorageKey("alpha", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY),
      '["alpha-group"]',
    );
    storage.setItem(
      connectionStorageKey("beta", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY),
      '["beta-group"]',
    );

    expect(readConnectionResourceSelection(storage, "alpha")).toEqual({
      fileExplorerWorkspaceId: "same",
      filePreview: {
        workspaceId: "same",
        path: "alpha.txt",
        name: "alpha.txt",
      },
      diffViewerWorkspaceId: "same",
    });
    expect(readConnectionResourceSelection(storage, "beta")).toEqual({
      fileExplorerWorkspaceId: "same",
      filePreview: {
        workspaceId: "same",
        path: "beta.txt",
        name: "beta.txt",
      },
      diffViewerWorkspaceId: "same",
    });
    expect(
      storage.getItem(
        connectionStorageKey("alpha", WORKSPACE_PINS_STORAGE_KEY),
      ),
    ).toBe('["alpha-pin"]');
    expect(
      storage.getItem(connectionStorageKey("beta", WORKSPACE_PINS_STORAGE_KEY)),
    ).toBe('["beta-pin"]');
    expect(
      storage.getItem(
        connectionStorageKey("alpha", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY),
      ),
    ).toBe('["alpha-group"]');
    expect(
      storage.getItem(
        connectionStorageKey("beta", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY),
      ),
    ).toBe('["beta-group"]');
  });

  test("keeps persistence across generations while remounting transient UI", () => {
    const storage = new MemoryStorage();
    writeConnectionResourceSelection(storage, "alpha", {
      fileExplorerWorkspaceId: "same",
      filePreview: {
        workspaceId: "same",
        path: "persisted.txt",
        name: "persisted.txt",
      },
      diffViewerWorkspaceId: "same",
    });

    expect(
      connectionClientScopeKey(
        { connectionId: "alpha", generation: 1 },
        "resource-ui",
      ),
    ).not.toBe(
      connectionClientScopeKey(
        { connectionId: "alpha", generation: 2 },
        "resource-ui",
      ),
    );
    expect(
      readConnectionResourceSelection(storage, "alpha").filePreview,
    ).toEqual({
      workspaceId: "same",
      path: "persisted.txt",
      name: "persisted.txt",
    });
  });

  test("saves outgoing alpha without writing its values into beta", () => {
    const storage = new MemoryStorage();
    writeConnectionResourceSelection(storage, "beta", {
      fileExplorerWorkspaceId: "beta-workspace",
      filePreview: {
        workspaceId: "beta-workspace",
        path: "beta.md",
        name: "beta.md",
      },
      diffViewerWorkspaceId: "beta-diff",
    });

    const restoredBeta = transitionConnectionResourceSelection(
      storage,
      "alpha",
      {
        fileExplorerWorkspaceId: "alpha-workspace",
        filePreview: {
          workspaceId: "alpha-workspace",
          path: "alpha.md",
          name: "alpha.md",
        },
        diffViewerWorkspaceId: "alpha-diff",
      },
      "beta",
    );

    expect(readConnectionResourceSelection(storage, "alpha")).toEqual({
      fileExplorerWorkspaceId: "alpha-workspace",
      filePreview: {
        workspaceId: "alpha-workspace",
        path: "alpha.md",
        name: "alpha.md",
      },
      diffViewerWorkspaceId: "alpha-diff",
    });
    expect(restoredBeta).toEqual({
      fileExplorerWorkspaceId: "beta-workspace",
      filePreview: {
        workspaceId: "beta-workspace",
        path: "beta.md",
        name: "beta.md",
      },
      diffViewerWorkspaceId: "beta-diff",
    });
    expect(
      storage.getItem(connectionStorageKey("beta", FILE_PREVIEW_STORAGE_KEY)),
    ).toContain("beta.md");
  });
});
