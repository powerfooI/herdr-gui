import { describe, expect, test } from "bun:test";
import {
  findTerminalFileLinkCandidates,
  TerminalFileResolutionCache,
} from "./terminalFileLinks";

describe("terminal file links", () => {
  test("finds absolute and workspace-relative file paths", () => {
    expect(
      findTerminalFileLinkCandidates(
        "Open /tmp/llm-endpoints-table.png and a/b/c.png or ./docs/guide.md.",
      ).map(({ path, absolute }) => ({ path, absolute })),
    ).toEqual([
      { path: "/tmp/llm-endpoints-table.png", absolute: true },
      { path: "a/b/c.png", absolute: false },
      { path: "./docs/guide.md", absolute: false },
    ]);
  });

  test("supports explicit single-file paths and removes line locations", () => {
    expect(
      findTerminalFileLinkCandidates(
        "Open ./README.md, /NOTICE and src/app.tsx:42:7.",
      ).map(({ path, absolute }) => ({ path, absolute })),
    ).toEqual([
      { path: "./README.md", absolute: false },
      { path: "/NOTICE", absolute: true },
      { path: "src/app.tsx", absolute: false },
    ]);
  });

  test("handles quoted paths without extracting paths from identifiers or URLs", () => {
    expect(
      findTerminalFileLinkCandidates(
        "`src/app.tsx` orbit/path/to/file.ts https://example.com/a/b.png",
        [{ start: 38, end: 65 }],
      ).map((candidate) => candidate.path),
    ).toEqual(["src/app.tsx", "orbit/path/to/file.ts"]);
    expect(findTerminalFileLinkCandidates("prefix:src/app.tsx")).toEqual([]);
    expect(findTerminalFileLinkCandidates("../outside/file.txt")).toEqual([]);
    expect(findTerminalFileLinkCandidates("~/outside/file.txt")).toEqual([]);
  });

  test("caches positive and negative workspace resolutions", async () => {
    let calls = 0;
    const cache = new TerminalFileResolutionCache(
      async (_scopeId, _workspaceId, paths) => {
        calls += 1;
        return paths
          .filter((path) => path === "a/b/c.png")
          .map((path) => ({ candidate: path, path }));
      },
    );

    expect(
      Array.from(
        (
          await cache.resolve("alpha", "w1", ["a/b/c.png", "missing/file.png"])
        ).entries(),
      ),
    ).toEqual([["a/b/c.png", "a/b/c.png"]]);
    expect(
      await cache.resolve("alpha", "w1", ["a/b/c.png", "missing/file.png"]),
    ).toEqual(new Map([["a/b/c.png", "a/b/c.png"]]));
    expect(calls).toBe(1);

    await cache.resolve("alpha", "w2", ["a/b/c.png"]);
    await cache.resolve("beta", "w1", ["a/b/c.png"]);
    expect(calls).toBe(3);
  });

  test("expires negative results sooner than positive results", async () => {
    let now = 0;
    let exists = false;
    let calls = 0;
    const cache = new TerminalFileResolutionCache(
      async (_scopeId, _workspaceId, paths) => {
        calls += 1;
        return exists ? paths.map((path) => ({ candidate: path, path })) : [];
      },
      { positiveTtlMs: 100, negativeTtlMs: 10, now: () => now },
    );

    expect(await cache.resolve("alpha", "w1", ["a/b/c.png"])).toEqual(
      new Map(),
    );
    exists = true;
    now = 9;
    expect(await cache.resolve("alpha", "w1", ["a/b/c.png"])).toEqual(
      new Map(),
    );
    now = 10;
    expect(await cache.resolve("alpha", "w1", ["a/b/c.png"])).toEqual(
      new Map([["a/b/c.png", "a/b/c.png"]]),
    );
    now = 109;
    expect(await cache.resolve("alpha", "w1", ["a/b/c.png"])).toEqual(
      new Map([["a/b/c.png", "a/b/c.png"]]),
    );
    expect(calls).toBe(2);
  });

  test("does not publish or cache a resolution after its connection scope retires", async () => {
    let currentScope = "alpha";
    let complete!: (files: Array<{ candidate: string; path: string }>) => void;
    let calls = 0;
    const cache = new TerminalFileResolutionCache(
      async () => {
        calls += 1;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
      { isScopeCurrent: (scopeId) => scopeId === currentScope },
    );

    const stale = cache.resolve("alpha", "same", ["same/file.txt"]);
    currentScope = "beta";
    complete([{ candidate: "same/file.txt", path: "alpha/file.txt" }]);
    expect(await stale).toEqual(new Map());

    currentScope = "alpha";
    const retry = cache.resolve("alpha", "same", ["same/file.txt"]);
    expect(calls).toBe(2);
    complete([{ candidate: "same/file.txt", path: "alpha/file.txt" }]);
    expect(await retry).toEqual(new Map([["same/file.txt", "alpha/file.txt"]]));
  });
});
