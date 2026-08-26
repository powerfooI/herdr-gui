import { describe, expect, test } from "bun:test";
import type { ConnectionClient } from "./api";
import type { GitDiffSummary } from "./types";
import {
  gitDiffSummaryKey,
  readGitDiffSummary,
  refreshGitDiffSummary,
  retireGitDiffSummaryResource,
  subscribeGitDiffSummary,
} from "./gitDiffSummaryStore";

function summary(workspaceId: string): GitDiffSummary {
  return {
    workspace_id: workspaceId,
    root: "/repo",
    entries: [],
    counts: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      branch: 0,
    },
  };
}

describe("shared git diff summaries", () => {
  test("deduplicates refreshes and publishes one shared snapshot", async () => {
    let calls = 0;
    let resolve!: (value: GitDiffSummary) => void;
    const client: ConnectionClient = {
      connectionId: "shared-summary",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: () => {
        calls += 1;
        return new Promise<GitDiffSummary>((done) => {
          resolve = done;
        });
      },
    };
    const key = gitDiffSummaryKey(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    let publications = 0;
    const unsubscribe = subscribeGitDiffSummary(key, () => {
      publications += 1;
    });

    const first = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    const second = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );

    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect(readGitDiffSummary(key).loading).toBe(true);

    const next = summary("workspace");
    resolve(next);
    await first;

    expect(readGitDiffSummary(key)).toMatchObject({
      summary: next,
      loading: false,
      error: null,
    });
    expect(publications).toBe(2);
    unsubscribe();
  });

  test("queues one fresh request after an in-flight snapshot", async () => {
    const resolvers: Array<(value: GitDiffSummary) => void> = [];
    const client: ConnectionClient = {
      connectionId: "queued-summary",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: () =>
        new Promise<GitDiffSummary>((resolve) => resolvers.push(resolve)),
    };
    const key = gitDiffSummaryKey(client, "workspace", "working");
    const initial = refreshGitDiffSummary(client, "workspace", "working");
    const queued = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "workspace",
      { afterCurrent: true },
    );
    const duplicateQueued = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "workspace",
      { afterCurrent: true },
    );
    expect(queued).toBe(duplicateQueued);
    expect(resolvers).toHaveLength(1);

    resolvers[0]?.(summary("stale"));
    await initial;
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    const fresh = summary("fresh");
    resolvers[1]?.(fresh);
    await queued;
    expect(readGitDiffSummary(key).summary).toBe(fresh);
  });

  test("retires a queued refresh before it can restart the resource", async () => {
    let resolveInitial: ((value: GitDiffSummary) => void) | undefined;
    let calls = 0;
    const client: ConnectionClient = {
      connectionId: "retired-queue",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: () => {
        calls += 1;
        return new Promise<GitDiffSummary>((resolve) => {
          resolveInitial = resolve;
        });
      },
    };
    const key = gitDiffSummaryKey(
      client,
      "workspace",
      "working",
      "checkout:retired",
    );
    const initial = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:retired",
    );
    expect(readGitDiffSummary(key).loading).toBe(true);
    const queued = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:retired",
      { afterCurrent: true },
    );
    retireGitDiffSummaryResource(client, "checkout:retired");
    expect(readGitDiffSummary(key).loading).toBe(false);
    resolveInitial?.(summary("stale"));
    await initial;
    await expect(queued).rejects.toThrow("retired");
    expect(calls).toBe(1);
  });

  test("does not publish a request retired by resource cleanup", async () => {
    const resolvers: Array<(value: GitDiffSummary) => void> = [];
    const client: ConnectionClient = {
      connectionId: "retired-summary",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: () =>
        new Promise<GitDiffSummary>((resolve) => resolvers.push(resolve)),
    };
    const key = gitDiffSummaryKey(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    const retired = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    retireGitDiffSummaryResource(client, "checkout:stable");
    const current = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );

    const staleSummary = summary("stale");
    resolvers[0]?.(staleSummary);
    await retired;
    expect(readGitDiffSummary(key).summary).toBeNull();

    const freshSummary = summary("workspace");
    resolvers[1]?.(freshSummary);
    await current;
    expect(readGitDiffSummary(key).summary).toBe(freshSummary);
  });
});
