import { describe, expect, test } from "bun:test";
import type { ConnectionClient } from "../api";
import {
  clearDiffViewerResourceCache,
  diffCacheKey,
  diffRuntimeContextKey,
  diffSelectionStorageKey,
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
