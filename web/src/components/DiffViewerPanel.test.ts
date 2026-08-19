import { describe, expect, test } from "bun:test";
import type { ConnectionClient } from "../api";
import {
  diffCacheKey,
  diffSelectionStorageKey,
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
