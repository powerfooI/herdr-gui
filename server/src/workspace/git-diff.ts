import { sshCommandArgv } from "../bridge/ssh-command";
import {
  GIT_DIFF_MAX_BYTES,
  GIT_DIFF_TIMEOUT_MS,
  GIT_PULL_TIMEOUT_MS,
  GIT_UNTRACKED_NUMSTAT_CONCURRENCY,
} from "./file-constants";
import { sanitizeExplorerPath } from "./file-paths";
import type {
  GitDiffEntry,
  GitDiffKind,
  GitDiffMode,
  RunProcessWithCodeTimeout,
} from "./file-types";

const GIT_ATTRIBUTE_BATCH_SIZE = 100;

export function statusLabel(code: string, kind: GitDiffKind) {
  if (kind === "untracked") return "untracked";
  if (kind === "conflicted") return "conflicted";
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type changed";
    case "M":
    default:
      return "modified";
  }
}

function isConflictedStatus(x: string, y: string) {
  return (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  );
}

export function parseStatusSummary(output: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const rawPath = line.slice(3);
    const renameParts = rawPath.split(" -> ");
    const oldPath = renameParts.length > 1 ? renameParts[0] : undefined;
    const path =
      renameParts.length > 1 ? renameParts.slice(1).join(" -> ") : rawPath;
    if (!path) continue;

    if (x === "?" && y === "?") {
      entries.push({
        path,
        kind: "untracked",
        status: "untracked",
      });
      continue;
    }
    if (isConflictedStatus(x, y)) {
      entries.push({
        path,
        old_path: oldPath,
        kind: "conflicted",
        status: "conflicted",
      });
      continue;
    }
    if (x !== " ") {
      entries.push({
        path,
        old_path: oldPath,
        kind: "staged",
        status: statusLabel(x, "staged"),
      });
    }
    if (y !== " ") {
      entries.push({
        path,
        old_path: oldPath,
        kind: "unstaged",
        status: statusLabel(y, "unstaged"),
      });
    }
  }
  return entries.sort(
    (a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: "base" }) ||
      a.kind.localeCompare(b.kind),
  );
}

export function parseBranchSummary(output: string): GitDiffEntry[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const rawStatus = parts[0] ?? "";
      const renamed = rawStatus.startsWith("R") || rawStatus.startsWith("C");
      const path = renamed ? (parts[2] ?? parts[1] ?? "") : (parts[1] ?? "");
      const oldPath = renamed ? parts[1] : undefined;
      return {
        path,
        old_path: oldPath,
        kind: "branch" as const,
        status: statusLabel(rawStatus[0] ?? "M", "branch"),
      };
    })
    .filter((entry) => entry.path)
    .sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
    );
}

function parseNumstatValue(value: string) {
  if (value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumstatPath(raw: string) {
  const trimmed = raw.trim();
  const tabParts = trimmed.split("\t").filter(Boolean);
  const path = tabParts[tabParts.length - 1] ?? trimmed;
  const braceRename = /\{.*? => (.*?)\}/.exec(path);
  if (braceRename) return path.replace(/\{.*? => (.*?)\}/, "$1");
  const arrowIndex = path.lastIndexOf(" => ");
  if (arrowIndex >= 0) return path.slice(arrowIndex + 4).replace(/[{}]/g, "");
  return path;
}

function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parseNumstatValue(parts[0] ?? "0");
    const deletions = parseNumstatValue(parts[1] ?? "0");
    const path = normalizeNumstatPath(parts.slice(2).join("\t"));
    if (!path) continue;
    const current = stats.get(path) ?? { additions: 0, deletions: 0 };
    stats.set(path, {
      additions: current.additions + additions,
      deletions: current.deletions + deletions,
    });
  }
  return stats;
}

export function parseGeneratedAttributes(output: string) {
  const generatedPaths = new Set<string>();
  const fields = output.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index] ?? "";
    const attribute = fields[index + 1] ?? "";
    const value = (fields[index + 2] ?? "").toLowerCase();
    if (
      path &&
      attribute === "linguist-generated" &&
      (value === "set" || value === "true")
    ) {
      generatedPaths.add(path);
    }
  }
  return generatedPaths;
}

function entryKeyForStats(entry: Pick<GitDiffEntry, "kind" | "path">) {
  return `${entry.kind}:${entry.path}`;
}

function diffMode(params: Record<string, unknown>): GitDiffMode {
  return params.mode === "branch-main" ? "branch-main" : "working";
}

function runGitShellCommand({
  root,
  command,
  host,
  shQuote,
  runProcessWithCodeTimeout,
  timeoutMs = GIT_DIFF_TIMEOUT_MS,
}: {
  root: string;
  command: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  timeoutMs?: number;
}) {
  const fullCommand = `git -C ${shQuote(root)} -c core.quotepath=false ${command}`;
  return runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, fullCommand) : ["sh", "-lc", fullCommand],
    timeoutMs,
  );
}

async function collectGeneratedPaths({
  root,
  entries,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  entries: GitDiffEntry[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const generatedPaths = new Set<string>();
  const paths = Array.from(new Set(entries.map((entry) => entry.path)));
  for (let index = 0; index < paths.length; index += GIT_ATTRIBUTE_BATCH_SIZE) {
    const batch = paths.slice(index, index + GIT_ATTRIBUTE_BATCH_SIZE);
    const result = await runGitShellCommand({
      root,
      command: `check-attr -z linguist-generated -- ${batch.map(shQuote).join(" ")}`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
    if (result.code !== 0) continue;
    for (const path of parseGeneratedAttributes(result.stdout)) {
      generatedPaths.add(path);
    }
  }
  return generatedPaths;
}

async function collectStats({
  root,
  mode,
  base,
  entries,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  mode: GitDiffMode;
  base: string | undefined;
  entries: GitDiffEntry[];
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const mergeStats = (
    kind: GitDiffKind,
    output: string,
    fallbackKind?: GitDiffKind,
  ) => {
    for (const [path, value] of parseNumstat(output)) {
      stats.set(`${kind}:${path}`, value);
      if (fallbackKind) stats.set(`${fallbackKind}:${path}`, value);
    }
  };

  if (mode === "branch-main") {
    const result = await runGitShellCommand({
      root,
      command: `diff --numstat --find-renames ${shQuote(base ?? "main")}...HEAD`,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    });
    if (result.code === 0 || result.code === 1) {
      mergeStats("branch", result.stdout);
    }
    return stats;
  }

  const staged = await runGitShellCommand({
    root,
    command: "diff --cached --numstat --find-renames",
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  if (staged.code === 0 || staged.code === 1)
    mergeStats("staged", staged.stdout);

  const unstaged = await runGitShellCommand({
    root,
    command: "diff --numstat --find-renames",
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  if (unstaged.code === 0 || unstaged.code === 1) {
    mergeStats("unstaged", unstaged.stdout, "conflicted");
  }

  const untrackedEntries = entries.filter(
    (entry) => entry.kind === "untracked",
  );
  let cursor = 0;
  const worker = async () => {
    while (cursor < untrackedEntries.length) {
      const entry = untrackedEntries[cursor];
      cursor += 1;
      if (!entry) continue;
      const result = await runGitShellCommand({
        root,
        command: `diff --no-ext-diff --no-index --numstat -- /dev/null ${shQuote(entry.path)}`,
        host,
        shQuote,
        runProcessWithCodeTimeout,
      });
      if (result.code !== 0 && result.code !== 1) continue;
      const value = parseNumstat(result.stdout).get(entry.path);
      if (value) stats.set(entryKeyForStats(entry), value);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          GIT_UNTRACKED_NUMSTAT_CONCURRENCY,
          untrackedEntries.length,
        ),
      },
      () => worker(),
    ),
  );

  return stats;
}

async function resolveMainBase({
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const command = `
set -eu
for ref in main refs/heads/main origin/main refs/remotes/origin/main; do
  if git -C ${shQuote(root)} rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    printf '%s' "$ref"
    exit 0
  fi
done
exit 1
`;
  const result = await runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "main branch was not found")
        .trim()
        .slice(0, 1000),
    );
  }
  return result.stdout.trim();
}

export async function readDiffSummary({
  workspaceId,
  workspace,
  root,
  params,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  workspace: any;
  root: string;
  params: Record<string, unknown>;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const mode = diffMode(params);
  const base =
    mode === "branch-main"
      ? await resolveMainBase({
          root,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : undefined;
  const result =
    mode === "branch-main"
      ? await runGitShellCommand({
          root,
          command: `diff --name-status --find-renames ${shQuote(base ?? "main")}...HEAD`,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : await runGitShellCommand({
          root,
          command: "status --porcelain=v1 --untracked-files=all",
          host,
          shQuote,
          runProcessWithCodeTimeout,
        });
  if (result.code !== 0) {
    throw new Error(
      (
        result.stderr ||
        result.stdout ||
        `git ${mode === "branch-main" ? "diff" : "status"} exited ${result.code}`
      )
        .trim()
        .slice(0, 1000),
    );
  }
  const entries =
    mode === "branch-main"
      ? parseBranchSummary(result.stdout)
      : parseStatusSummary(result.stdout);
  const [stats, generatedPaths] = await Promise.all([
    collectStats({
      root,
      mode,
      base,
      entries,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }),
    collectGeneratedPaths({
      root,
      entries,
      host,
      shQuote,
      runProcessWithCodeTimeout,
    }),
  ]);
  const entriesWithStats = entries.map((entry) => {
    const entryWithStats = {
      ...entry,
      ...(stats.get(entryKeyForStats(entry)) ?? {}),
    };
    return generatedPaths.has(entry.path)
      ? { ...entryWithStats, generated: true }
      : entryWithStats;
  });
  return {
    workspace_id: workspaceId,
    repo_name: workspace?.worktree?.repo_name ?? workspace?.label ?? "",
    root,
    mode,
    base,
    entries: entriesWithStats,
    counts: {
      staged: entriesWithStats.filter((entry) => entry.kind === "staged")
        .length,
      unstaged: entriesWithStats.filter((entry) => entry.kind === "unstaged")
        .length,
      untracked: entriesWithStats.filter((entry) => entry.kind === "untracked")
        .length,
      conflicted: entriesWithStats.filter(
        (entry) => entry.kind === "conflicted",
      ).length,
      branch: entriesWithStats.filter((entry) => entry.kind === "branch")
        .length,
    },
  };
}

export async function readDiffFile({
  workspaceId,
  root,
  params,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  root: string;
  params: Record<string, unknown>;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const path = sanitizeExplorerPath(params.path);
  if (!path) throw new Error("git.diff_file requires path");
  const mode = diffMode(params);
  const base =
    mode === "branch-main"
      ? await resolveMainBase({
          root,
          host,
          shQuote,
          runProcessWithCodeTimeout,
        })
      : undefined;
  const kind =
    mode === "branch-main"
      ? "branch"
      : params.kind === "staged" ||
          params.kind === "untracked" ||
          params.kind === "conflicted"
        ? params.kind
        : "unstaged";
  const gitCommand =
    mode === "branch-main"
      ? `diff --no-ext-diff --find-renames ${shQuote(base ?? "main")}...HEAD -- ${shQuote(path)}`
      : kind === "staged"
        ? `diff --cached --no-ext-diff -- ${shQuote(path)}`
        : kind === "untracked"
          ? `diff --no-ext-diff --no-index -- /dev/null ${shQuote(path)}`
          : kind === "conflicted"
            ? `diff --cc --no-ext-diff -- ${shQuote(path)}`
            : `diff --no-ext-diff -- ${shQuote(path)}`;
  const result = await runGitShellCommand({
    root,
    command: gitCommand,
    host,
    shQuote,
    runProcessWithCodeTimeout,
  });
  const diffExitOk =
    kind === "untracked"
      ? result.code === 0 || result.code === 1
      : result.code === 0;
  if (!diffExitOk) {
    throw new Error(
      (result.stderr || result.stdout || `git diff exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  const truncated = Buffer.byteLength(result.stdout) > GIT_DIFF_MAX_BYTES;
  return {
    workspace_id: workspaceId,
    root,
    path,
    kind,
    diff: truncated
      ? result.stdout.slice(0, GIT_DIFF_MAX_BYTES)
      : result.stdout,
    truncated,
  };
}

export async function pullGit({
  workspaceId,
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} -c core.quotepath=false pull --ff-only`;
  const result = await runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
    GIT_PULL_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git pull exited ${result.code}`)
        .trim()
        .slice(0, 2000),
    );
  }
  return {
    workspace_id: workspaceId,
    root,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
