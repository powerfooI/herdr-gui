import { GIT_PULL_TIMEOUT_MS } from "../workspace/file-constants";
import type { RunProcessWithCodeTimeout } from "../workspace/file-types";

export const WORKTREE_BASE_REF = "origin/main";

export interface WorktreeBaseSyncResult {
  workspace_id: string;
  root: string;
  base: typeof WORKTREE_BASE_REF;
  commit: string;
  command: "git fetch origin main";
  stdout: string;
  stderr: string;
}

type GitRootResolver = (workspaceId: string) => Promise<{ root: string }>;

function processError(
  result: { code: number; stdout: string; stderr: string },
  fallback: string,
): string {
  return (result.stderr || result.stdout || fallback).trim().slice(0, 2_000);
}

/**
 * Refresh origin/main without merging it into the workspace's current branch.
 * The subsequent Herdr call uses origin/main explicitly, so feature workspaces
 * and dirty checkouts are not mutated while the new branch still starts from
 * the latest remote main commit.
 */
export async function syncWorktreeBase({
  workspaceId,
  resolveGitRoot,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  resolveGitRoot: GitRootResolver;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<WorktreeBaseSyncResult> {
  if (!workspaceId) throw new Error("worktree.create requires workspace_id");
  const { root } = await resolveGitRoot(workspaceId);
  const runGit = (args: string) => {
    const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} ${args}`;
    return runProcessWithCodeTimeout(
      host ? ["ssh", host, command] : ["sh", "-lc", command],
      GIT_PULL_TIMEOUT_MS,
    );
  };

  // An explicit destination guarantees that origin/main is refreshed even
  // when Git would otherwise only write the fetched commit to FETCH_HEAD.
  const fetchResult = await runGit(
    "fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
  );
  if (fetchResult.code !== 0) {
    throw new Error(
      `Unable to update origin/main before creating the worktree: ${processError(
        fetchResult,
        `git fetch exited ${fetchResult.code}`,
      )}`,
    );
  }

  const revisionResult = await runGit(
    "rev-parse --verify refs/remotes/origin/main^{commit}",
  );
  const commit = revisionResult.stdout.trim();
  if (revisionResult.code !== 0 || !commit) {
    throw new Error(
      `Unable to resolve origin/main after fetching it: ${processError(
        revisionResult,
        "origin/main does not point to a commit",
      )}`,
    );
  }

  return {
    workspace_id: workspaceId,
    root,
    base: WORKTREE_BASE_REF,
    commit,
    command: "git fetch origin main",
    stdout: fetchResult.stdout.trim(),
    stderr: fetchResult.stderr.trim(),
  };
}
