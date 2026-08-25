import { describe, expect, test } from "bun:test";
import type { ConnectionClient } from "../api";
import {
  beginDiffFileSelection,
  buildActiveDiffSelection,
  clearDiffViewerResourceCache,
  diffCacheKey,
  diffRuntimeContextKey,
  diffSelectionStorageKey,
  expandedDirsForSelection,
  mergeResolvedDiffFile,
  prefetchDiffFilesInBatches,
  prefetchDiffViewerWorkspace,
} from "./DiffViewerPanel";

describe("connection-scoped diff identity", () => {
  test("isolates identical workspace IDs in memory and persistence", () => {
    const alpha = { connectionId: "alpha", generation: 1 };
    const beta = { connectionId: "beta", generation: 1 };
    expect(diffCacheKey(alpha, "same", "working")).not.toBe(
      diffCacheKey(beta, "same", "working"),
    );
    expect(diffCacheKey(alpha, "same", "working")).not.toBe(
      diffCacheKey({ connectionId: "alpha", generation: 2 }, "same", "working"),
    );
    expect(diffSelectionStorageKey("alpha", "same", "working")).not.toBe(
      diffSelectionStorageKey("beta", "same", "working"),
    );
    expect(diffSelectionStorageKey("legacy-default", "same", "working")).toBe(
      "diffViewerSelected:same:working",
    );
    expect(diffCacheKey(alpha, "runtime-a", "working", "checkout:stable")).toBe(
      diffCacheKey(alpha, "runtime-b", "working", "checkout:stable"),
    );
    expect(
      diffRuntimeContextKey(alpha, "runtime-a", "working", "checkout:stable"),
    ).not.toBe(
      diffRuntimeContextKey(alpha, "runtime-b", "working", "checkout:stable"),
    );
  });

  test("expands only the selected file ancestors", () => {
    expect(
      Array.from(
        expandedDirsForSelection({
          path: "src/components/App.tsx",
          kind: "unstaged",
          status: "M",
        }),
      ),
    ).toEqual(["", "src", "src/components"]);
    expect(Array.from(expandedDirsForSelection(null))).toEqual([""]);
  });

  test("honors explicit null selection overrides", () => {
    const entry = {
      path: "stale.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const file = {
      workspace_id: "workspace",
      root: "/tmp/workspace",
      path: entry.path,
      kind: entry.kind,
      diff: "stale",
      truncated: false,
    };
    const selection = buildActiveDiffSelection(
      {
        summary: null,
        selected: entry,
        files: { "unstaged:stale.ts": file },
        fileErrors: {},
        error: "stale error",
      },
      { entry: null, file: null, error: null },
      null,
      false,
    );

    expect(selection.entry).toBeNull();
    expect(selection.file).toBeNull();
    expect(selection.error).toBeNull();
  });

  test("prefetches files into the requested checkout resource cache", async () => {
    let diffCalls = 0;
    const client: ConnectionClient = {
      connectionId: "scoped-prefetch",
      generation: 4,
      serverRuntimeGeneration: 2,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 2,
      call: async (_method, params) => {
        diffCalls += 1;
        return {
          path: String(params?.path ?? ""),
          diff: "diff --git a/file b/file",
        };
      },
    };
    const entries = [
      { path: "one.ts", kind: "unstaged", status: "M" },
      { path: "two.ts", kind: "unstaged", status: "M" },
    ] as const;

    await prefetchDiffFilesInBatches(client, "workspace-runtime", "working", [
      ...entries,
    ]);
    expect(diffCalls).toBe(2);

    const loaded: string[] = [];
    await prefetchDiffFilesInBatches(
      client,
      "workspace-runtime",
      "working",
      [...entries],
      "checkout:stable",
      (entry) => loaded.push(entry.path),
    );
    expect(diffCalls).toBe(4);
    expect(loaded.sort()).toEqual(["one.ts", "two.ts"]);

    await prefetchDiffFilesInBatches(
      client,
      "workspace-runtime",
      "working",
      [...entries],
      "checkout:stable",
    );
    expect(diffCalls).toBe(4);
  });

  test("does not repopulate a checkout cache after resource cleanup", async () => {
    let calls = 0;
    let resolveRetired!: (value: unknown) => void;
    const client: ConnectionClient = {
      connectionId: "cleared-diff",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 1,
      call: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveRetired = resolve;
          });
        }
        return { path: "same.ts", diff: "fresh" };
      },
    };
    const entry = {
      path: "same.ts",
      kind: "unstaged" as const,
      status: "M",
    };

    const retired = prefetchDiffFilesInBatches(
      client,
      "runtime-workspace",
      "working",
      [entry],
      "checkout:stable",
    );
    clearDiffViewerResourceCache(client, "checkout:stable", {
      removeItem: () => undefined,
    });
    resolveRetired({ path: "same.ts", diff: "stale" });
    await retired;

    await prefetchDiffFilesInBatches(
      client,
      "runtime-workspace",
      "working",
      [entry],
      "checkout:stable",
    );
    expect(calls).toBe(2);
  });

  test("keeps the latest selection when an older file request resolves", () => {
    const first = {
      path: "first.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const second = {
      path: "second.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const resolved = mergeResolvedDiffFile(
      {
        summary: null,
        selected: second,
        files: {},
        fileErrors: {},
        error: "second is still loading",
      },
      first,
      {
        workspace_id: "workspace",
        root: "/tmp/workspace",
        path: first.path,
        kind: first.kind,
        diff: "diff --git a/first.ts b/first.ts",
        truncated: false,
      },
    );

    expect(resolved.selected).toBe(second);
    expect(resolved.files["unstaged:first.ts"]?.path).toBe("first.ts");
    expect(resolved.error).toBe("second is still loading");
  });

  test("clears a stale file error when retrying its selection", () => {
    const entry = {
      path: "retry.ts",
      kind: "unstaged" as const,
      status: "M",
    };
    const next = beginDiffFileSelection(
      {
        summary: null,
        selected: null,
        files: {},
        fileErrors: { "unstaged:retry.ts": "old failure" },
        error: "old failure",
      },
      entry,
    );

    expect(next.selected).toBe(entry);
    expect(next.fileErrors).toEqual({});
    expect(next.error).toBeNull();
  });

  test("bounds cached patch files by estimated bytes", () => {
    let cache: Parameters<typeof beginDiffFileSelection>[0] = {
      summary: null,
      selected: null,
      files: {},
      fileErrors: {},
      error: null,
    };
    const largeDiff = "x".repeat(1_500_000);
    const entries = Array.from({ length: 4 }, (_, index) => ({
      path: `large-${index}.ts`,
      kind: "unstaged" as const,
      status: "M",
    }));

    for (const entry of entries) {
      cache = beginDiffFileSelection(cache, entry);
      cache = mergeResolvedDiffFile(cache, entry, {
        workspace_id: "workspace",
        root: "/tmp/workspace",
        path: entry.path,
        kind: entry.kind,
        diff: largeDiff,
        truncated: false,
      });
    }

    expect(cache.selected).toBe(entries[entries.length - 1]);
    expect(Object.keys(cache.files).length).toBeLessThanOrEqual(2);
  });

  test("bounds cached patch files for large change sets", async () => {
    let diffCalls = 0;
    const client: ConnectionClient = {
      connectionId: "bounded-diff-cache",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 1,
      call: async (_method, params) => {
        diffCalls += 1;
        return {
          path: String(params?.path ?? ""),
          diff: "diff --git a/file b/file",
        };
      },
    };
    const entries = Array.from({ length: 30 }, (_, index) => ({
      path: `file-${index}.ts`,
      kind: "unstaged" as const,
      status: "M",
    }));

    await prefetchDiffFilesInBatches(
      client,
      "large-workspace",
      "working",
      entries,
    );
    expect(diffCalls).toBe(30);

    await prefetchDiffFilesInBatches(
      client,
      "large-workspace",
      "working",
      entries.slice(0, 6),
    );
    expect(diffCalls).toBe(36);
  });

  test("evicts least-recently-used cache contexts", async () => {
    let calls = 0;
    const scopedClient: ConnectionClient = {
      connectionId: "bounded-contexts",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: (value) => value === 1,
      call: async (_method, params) => {
        calls += 1;
        return {
          path: String(params?.path ?? ""),
          diff: "diff --git a/file b/file",
        };
      },
    };
    const entry = {
      path: "same.ts",
      kind: "unstaged" as const,
      status: "M",
    };

    for (let index = 0; index < 9; index += 1) {
      await prefetchDiffFilesInBatches(
        scopedClient,
        `workspace-${index}`,
        "working",
        [entry],
      );
    }
    expect(calls).toBe(9);

    await prefetchDiffFilesInBatches(scopedClient, "workspace-0", "working", [
      entry,
    ]);
    expect(calls).toBe(10);
  });

  test("does not cache a diff file that resolves after its lease retires", async () => {
    let current = true;
    let diffCalls = 0;
    let resolveFirstDiff!: (value: unknown) => void;
    let signalFirstDiff!: () => void;
    const firstDiffRequested = new Promise<void>((resolve) => {
      signalFirstDiff = resolve;
    });
    const client: ConnectionClient = {
      connectionId: "stale-diff",
      generation: 7,
      serverRuntimeGeneration: 3,
      isCurrent: () => current,
      acceptsServerGeneration: (value) => value === 3,
      call: async (method) => {
        if (method === "git.diff_summary") {
          return {
            root: "/tmp/repo",
            entries: [{ path: "same.ts", kind: "unstaged", status: "M" }],
          };
        }
        diffCalls += 1;
        if (diffCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstDiff = resolve;
            signalFirstDiff();
          });
        }
        return { path: "same.ts", text: "fresh" };
      },
    };

    const stale = prefetchDiffViewerWorkspace("same", client);
    await firstDiffRequested;
    current = false;
    resolveFirstDiff({ path: "same.ts", text: "stale" });
    await stale;

    current = true;
    await prefetchDiffViewerWorkspace("same", client);
    expect(diffCalls).toBe(2);
  });
});
