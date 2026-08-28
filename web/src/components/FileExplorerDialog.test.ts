import { describe, expect, test } from "bun:test";
import type { ConnectionClient } from "../api";
import type { FilePreview, GitDiffEntry, GitDiffSummary } from "../types";
import {
  buildGitStatusMaps,
  clearFileExplorerResourceCache,
  explorerCacheKey,
  explorerRuntimeContextKey,
  filePreviewCacheKey,
  invalidateFilePreviewCache,
  prefetchFileExplorerWorkspace,
  requestFilePreview,
} from "./FileExplorerDialog";

function preview(label: string): FilePreview {
  return {
    workspace_id: "same-workspace",
    checkout_path: "/tmp",
    root: "/tmp",
    path: `${label}.txt`,
    size: label.length,
    mtime_ms: 1,
    text: label,
    binary: false,
    truncated: false,
  };
}

function client(
  connectionId: string,
  generation: number,
  call: ConnectionClient["call"],
  isCurrent: () => boolean = () => true,
): ConnectionClient {
  return {
    connectionId,
    generation,
    serverRuntimeGeneration: generation,
    call,
    isCurrent,
    acceptsServerGeneration: (value) => value === generation,
  };
}

describe("file explorer git status", () => {
  test("preserves every diff entry for a partially staged file", () => {
    const unstaged: GitDiffEntry = {
      path: "src/components/App.tsx",
      kind: "unstaged",
      status: "modified",
    };
    const staged: GitDiffEntry = {
      path: unstaged.path,
      kind: "staged",
      status: "modified",
    };
    const summary: GitDiffSummary = {
      workspace_id: "workspace",
      root: "/repo",
      entries: [staged, unstaged],
      counts: {
        staged: 1,
        unstaged: 1,
        untracked: 0,
        conflicted: 0,
        branch: 0,
        "last-step": 0,
      },
    };

    const status = buildGitStatusMaps(summary, "/repo").fileStatuses.get(
      unstaged.path,
    );

    expect(status?.entry).toBe(staged);
    expect(status?.entries).toEqual([unstaged, staged]);
    expect(status?.label).toBe("Modified");
    expect(status?.codes).toEqual(["M"]);
  });

  test("sorts file and directory status codes independently of summary order", () => {
    const summary: GitDiffSummary = {
      workspace_id: "workspace",
      root: "/repo",
      entries: [
        { path: "src/app.ts", kind: "unstaged", status: "modified" },
        { path: "src/new.ts", kind: "untracked", status: "untracked" },
        { path: "src/app.ts", kind: "staged", status: "added" },
      ],
      counts: {
        staged: 1,
        unstaged: 1,
        untracked: 1,
        conflicted: 0,
        branch: 0,
        "last-step": 0,
      },
    };

    const maps = buildGitStatusMaps(summary, "/repo");
    expect(maps.fileStatuses.get("src/app.ts")?.codes).toEqual(["A", "M"]);
    expect(maps.directoryStatuses.get("src")?.codes).toEqual(["A", "M", "U"]);
  });
});

describe("connection-scoped file prefetch", () => {
  test("a retired prefetch cannot replace or detach its successor", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    let calls = 0;
    const scopedClient = client("prefetch-retirement", 1, () => {
      calls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const list = {
      workspace_id: "runtime-workspace",
      checkout_path: "/repo",
      root: "/repo",
      path: "",
      entries: [],
      truncated: false,
    };

    const retired = prefetchFileExplorerWorkspace(
      "runtime-workspace",
      scopedClient,
      "checkout:stable",
    );
    expect(calls).toBe(1);
    clearFileExplorerResourceCache(scopedClient, "checkout:stable", {
      removeItem: () => undefined,
    });
    const current = prefetchFileExplorerWorkspace(
      "runtime-workspace",
      scopedClient,
      "checkout:stable",
    );
    expect(calls).toBe(2);

    resolvers[0]?.(list);
    await retired;
    expect(
      prefetchFileExplorerWorkspace(
        "runtime-workspace",
        scopedClient,
        "checkout:stable",
      ),
    ).toBe(current);
    expect(calls).toBe(2);

    resolvers[1]?.(list);
    await current;
  });
});

describe("connection-scoped file previews", () => {
  test("isolates colliding workspace paths by connection generation", async () => {
    const alpha = client("alpha", 1, async () => preview("alpha"));
    const beta = client("beta", 1, async () => preview("beta"));

    expect(explorerCacheKey(alpha, "same", false)).not.toBe(
      explorerCacheKey(beta, "same", false),
    );
    expect(filePreviewCacheKey(alpha, "same", "same.txt")).not.toBe(
      filePreviewCacheKey(beta, "same", "same.txt"),
    );
    expect(explorerCacheKey(alpha, "runtime-a", false, "checkout:stable")).toBe(
      explorerCacheKey(alpha, "runtime-b", false, "checkout:stable"),
    );
    expect(
      explorerRuntimeContextKey(alpha, "runtime-a", "checkout:stable"),
    ).not.toBe(
      explorerRuntimeContextKey(alpha, "runtime-b", "checkout:stable"),
    );
    await expect(
      requestFilePreview("same", "same.txt", { client: alpha }),
    ).resolves.toMatchObject({ text: "alpha" });
    await expect(
      requestFilePreview("same", "same.txt", { client: beta }),
    ).resolves.toMatchObject({ text: "beta" });
  });

  test("refreshes a cached preview when the Inspector reopens", async () => {
    let text = "before";
    let calls = 0;
    const scopedClient = client("refresh-preview", 1, async () => {
      calls += 1;
      return preview(text);
    });

    const initial = await requestFilePreview("same", "same.txt", {
      client: scopedClient,
    });
    expect(initial).toMatchObject({ text: "before" });
    expect(typeof initial.resource_revision).toBe("number");
    text = "after";
    await expect(
      requestFilePreview("same", "same.txt", { client: scopedClient }),
    ).resolves.toMatchObject({ text: "before" });
    const refreshed = await requestFilePreview("same", "same.txt", {
      client: scopedClient,
      refresh: true,
    });
    expect(refreshed).toMatchObject({ text: "after" });
    expect(refreshed.resource_revision).toBeGreaterThan(
      initial.resource_revision ?? 0,
    );
    expect(calls).toBe(2);
  });

  test("deduplicates concurrent refresh consumers", async () => {
    let resolvePreview: ((value: FilePreview) => void) | undefined;
    let calls = 0;
    const scopedClient = client("refresh-in-flight", 1, () => {
      calls += 1;
      return new Promise<FilePreview>((resolve) => {
        resolvePreview = resolve;
      });
    });

    const initial = requestFilePreview("same", "same.txt", {
      client: scopedClient,
    });
    const refresh = requestFilePreview("same", "same.txt", {
      client: scopedClient,
      refresh: true,
    });
    expect(refresh).toBe(initial);
    expect(calls).toBe(1);

    resolvePreview?.(preview("shared"));
    await expect(initial).resolves.toMatchObject({ text: "shared" });
    await expect(refresh).resolves.toMatchObject({ text: "shared" });
    expect(calls).toBe(1);
  });

  test("invalidates cached descendants without touching sibling paths", async () => {
    let calls = 0;
    const scopedClient = client(
      "invalidate-directory",
      1,
      async (_method, params) => {
        calls += 1;
        return preview(String(params?.path));
      },
    );
    for (const path of ["dir/a.txt", "dir/nested/b.txt", "dir-two/c.txt"]) {
      await requestFilePreview("same", path, { client: scopedClient });
    }
    invalidateFilePreviewCache(scopedClient, "same", "dir", true);

    await requestFilePreview("same", "dir/a.txt", { client: scopedClient });
    await requestFilePreview("same", "dir/nested/b.txt", {
      client: scopedClient,
    });
    await requestFilePreview("same", "dir-two/c.txt", {
      client: scopedClient,
    });
    expect(calls).toBe(5);
  });

  test("evicts old previews when their estimated memory exceeds the budget", async () => {
    let calls = 0;
    const imageData = `data:image/png;base64,${"a".repeat(5_000_000)}`;
    const scopedClient = client(
      "bounded-previews",
      1,
      async (_method, params) => {
        calls += 1;
        return {
          ...preview(String(params?.path ?? "")),
          text: null,
          binary: true,
          image_data_url: imageData,
        };
      },
    );

    for (const path of ["one.png", "two.png", "three.png"]) {
      await requestFilePreview("same", path, { client: scopedClient });
    }
    expect(calls).toBe(3);

    await requestFilePreview("same", "one.png", { client: scopedClient });
    expect(calls).toBe(4);
  });

  test("does not cache a result after its client becomes stale", async () => {
    let current = true;
    let calls = 0;
    let resolveFirst!: (value: FilePreview) => void;
    const scopedClient = client(
      "stale-preview",
      7,
      () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<FilePreview>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(preview("fresh"));
      },
      () => current,
    );

    const stale = requestFilePreview("same", "same.txt", {
      client: scopedClient,
    });
    current = false;
    resolveFirst(preview("stale"));
    await expect(stale).rejects.toThrow("connection changed");

    current = true;
    await expect(
      requestFilePreview("same", "same.txt", { client: scopedClient }),
    ).resolves.toMatchObject({ text: "fresh" });
    expect(calls).toBe(2);
  });
});
