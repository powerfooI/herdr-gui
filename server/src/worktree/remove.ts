import { randomBytes } from "node:crypto";
import { realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type RunProcessWithCodeTimeout = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

type HerdrCall = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<any>;

export type CheckoutState =
  | "missing"
  | "clean"
  | "dirty"
  | "residual"
  | "unknown";

export interface WorktreeRemovalCleanup {
  terminated_processes: number;
  recovered_stale_checkout?: boolean;
  preserved_path?: string;
  warning?: string;
}

export interface WorktreeRemovalOutcome {
  result: any;
  cleanup?: WorktreeRemovalCleanup;
}

export interface WorktreeRemovalRuntime {
  inspectCheckout(path: string): Promise<CheckoutState>;
  stopCheckoutProcesses(path: string): Promise<number[]>;
  preserveCheckout(path: string): Promise<string>;
}

const PROCESS_SCAN_TIMEOUT_MS = 10_000;
const PROCESS_STOP_GRACE_MS = 500;
// Large ignored build trees can make Git deletion legitimately take minutes.
export const WORKTREE_REMOVE_TIMEOUT_MS = 10 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathWithinCheckout(path: string, checkoutPath: string): boolean {
  const normalizedPath = path.replace(/ \(deleted\)$/, "").replace(/\/+$/, "");
  const normalizedCheckout = checkoutPath.replace(/\/+$/, "");
  return (
    normalizedPath === normalizedCheckout ||
    normalizedPath.startsWith(`${normalizedCheckout}/`)
  );
}

function safeCheckoutPath(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const normalized = resolve(path);
  return basename(normalized).length > 0 && dirname(normalized) !== normalized
    ? normalized
    : undefined;
}

export function parseCheckoutProcessIds(
  output: string,
  checkoutPath: string,
): number[] {
  const processIds = new Set<number>();
  let processId: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      processId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (
      line.startsWith("n") &&
      processId !== null &&
      pathWithinCheckout(line.slice(1), checkoutPath)
    ) {
      processIds.add(processId);
    }
  }
  return [...processIds].sort((left, right) => left - right);
}

export function isNotWorkingTreeRemoveError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("worktree_remove_failed:") &&
    (message.includes("is not a working tree") ||
      message.includes("is not a worktree"))
  );
}

export function createWorktreeRemovalCoordinator() {
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    run<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
      if (!workspaceId) {
        return Promise.reject(
          new Error("worktree.remove requires workspace_id"),
        );
      }
      const active = inFlight.get(workspaceId);
      if (active) return active as Promise<T>;

      let operationResult: Promise<T>;
      try {
        operationResult = operation();
      } catch (error) {
        operationResult = Promise.reject(error);
      }
      const pending = operationResult.finally(() => {
        if (inFlight.get(workspaceId) === pending) inFlight.delete(workspaceId);
      });
      inFlight.set(workspaceId, pending);
      return pending;
    },
  };
}

async function stopAndPreserveResidualCheckout(
  path: string,
  runtime: WorktreeRemovalRuntime,
  terminated: Set<number>,
): Promise<string | undefined> {
  for (const processId of await runtime.stopCheckoutProcesses(path)) {
    terminated.add(processId);
  }
  try {
    return await runtime.preserveCheckout(path);
  } catch (error) {
    // The last process may remove the directory while it is being stopped.
    const state = await runtime
      .inspectCheckout(path)
      .catch(() => "unknown" as const);
    if (state === "missing") return undefined;
    throw error;
  }
}

async function finalizeSuccessfulRemoval({
  result,
  cleanupPath,
  runtime,
  terminated,
  recovered = false,
  preservedPath,
  log,
}: {
  result: any;
  cleanupPath?: string;
  runtime: WorktreeRemovalRuntime;
  terminated: Set<number>;
  recovered?: boolean;
  preservedPath?: string;
  log: (message: string) => void;
}): Promise<WorktreeRemovalOutcome> {
  let warning: string | undefined;
  if (cleanupPath) {
    const finalState = await runtime
      .inspectCheckout(cleanupPath)
      .catch(() => "unknown" as const);
    if (finalState === "residual") {
      try {
        preservedPath =
          (await stopAndPreserveResidualCheckout(
            cleanupPath,
            runtime,
            terminated,
          )) ?? preservedPath;
        recovered = true;
      } catch (cleanupError) {
        warning = `Herdr removed the worktree, but stale checkout cleanup failed: ${errorMessage(cleanupError)}`;
        log(`[bridge] ${warning}`);
      }
    } else if (finalState === "clean" || finalState === "dirty") {
      warning = `Herdr reported success, but the checkout is still a ${finalState} working tree at ${cleanupPath}`;
      log(`[bridge] ${warning}`);
    } else if (finalState === "unknown") {
      warning = `Herdr reported success, but the checkout removal could not be verified at ${cleanupPath}`;
      log(`[bridge] ${warning}`);
    }
  }

  const cleanup =
    terminated.size > 0 || recovered || warning
      ? {
          terminated_processes: terminated.size,
          ...(recovered ? { recovered_stale_checkout: true } : {}),
          ...(preservedPath ? { preserved_path: preservedPath } : {}),
          ...(warning ? { warning } : {}),
        }
      : undefined;
  return { result, cleanup };
}

export async function removeWorktreeWithRecovery({
  call,
  params,
  checkoutPath,
  runtime,
  log = console.warn,
}: {
  call: HerdrCall;
  params: Record<string, unknown>;
  checkoutPath?: string;
  runtime: WorktreeRemovalRuntime;
  log?: (message: string) => void;
}): Promise<WorktreeRemovalOutcome> {
  const terminated = new Set<number>();
  const cleanupPath = checkoutPath ? safeCheckoutPath(checkoutPath) : undefined;
  if (checkoutPath && !cleanupPath) {
    log(`[bridge] refusing worktree cleanup for unsafe path: ${checkoutPath}`);
  }

  try {
    const result = await call("worktree.remove", params);
    return finalizeSuccessfulRemoval({
      result,
      cleanupPath,
      runtime,
      terminated,
      log,
    });
  } catch (error) {
    if (!cleanupPath || !isNotWorkingTreeRemoveError(error)) {
      throw error;
    }

    const currentState = await runtime
      .inspectCheckout(cleanupPath)
      .catch(() => "unknown" as const);
    if (
      currentState === "clean" ||
      currentState === "dirty" ||
      currentState === "unknown"
    ) {
      throw error;
    }

    let preservedPath: string | undefined;
    if (currentState === "residual") {
      // A detached watcher can recreate a checkout after Git has removed its
      // metadata. Stop every process rooted there before moving the leftovers.
      try {
        preservedPath = await stopAndPreserveResidualCheckout(
          cleanupPath,
          runtime,
          terminated,
        );
      } catch (stopError) {
        throw new Error(
          `${errorMessage(error)}; unable to preserve the stale checkout: ${errorMessage(stopError)}`,
          { cause: stopError },
        );
      }
    }

    try {
      const result = await call("worktree.remove", {
        ...params,
        force: true,
      });
      return finalizeSuccessfulRemoval({
        result,
        cleanupPath,
        runtime,
        terminated,
        recovered: true,
        preservedPath,
        log,
      });
    } catch (retryError) {
      const preserved = preservedPath
        ? `; stale files were preserved at ${preservedPath}`
        : "";
      throw new Error(
        `${errorMessage(error)}${preserved}; recovery failed: ${errorMessage(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

export function createWorktreeRemovalRuntime({
  host,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host?: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}): WorktreeRemovalRuntime {
  const runShell = (script: string) =>
    runProcessWithCodeTimeout(
      host ? ["ssh", host, script] : ["sh", "-lc", script],
      PROCESS_SCAN_TIMEOUT_MS,
    );

  const inspectCheckout = async (path: string): Promise<CheckoutState> => {
    const quotedPath = shQuote(path);
    const script = `
path=${quotedPath}
git_bin=$(command -v git 2>/dev/null || true)
if [ -z "$git_bin" ] && [ -x /usr/bin/git ]; then git_bin=/usr/bin/git; fi
if [ ! -e "$path" ]; then
  printf missing
elif [ -z "$git_bin" ]; then
  printf unknown
elif ! path_root=$(cd "$path" 2>/dev/null && pwd -P); then
  printf residual
elif ! git_root=$("$git_bin" -C "$path" rev-parse --show-toplevel 2>/dev/null); then
  printf residual
elif ! git_root=$(cd "$git_root" 2>/dev/null && pwd -P); then
  printf residual
elif [ "$path_root" != "$git_root" ]; then
  printf residual
else
  status_output=$("$git_bin" -C "$path" status --porcelain --untracked-files=all 2>/dev/null) || { printf unknown; exit 0; }
  if [ -n "$status_output" ]; then printf dirty; else printf clean; fi
fi
`.trim();
    const result = await runShell(script);
    const state = result.stdout.trim();
    return ["missing", "clean", "dirty", "residual"].includes(state)
      ? (state as CheckoutState)
      : "unknown";
  };

  const listCheckoutProcesses = async (path: string): Promise<number[]> => {
    let canonicalPath = path;
    if (host) {
      const resolved = await runShell(
        `cd ${shQuote(path)} 2>/dev/null && pwd -P`,
      );
      if (resolved.code === 0 && resolved.stdout.trim()) {
        canonicalPath = resolved.stdout.trim();
      }
    } else {
      canonicalPath = await realpath(path).catch(() => path);
    }
    const script = `
if [ -d /proc ]; then
  for link in /proc/[0-9]*/cwd; do
    cwd=$(readlink "$link" 2>/dev/null) || continue
    pid=\${link#/proc/}
    pid=\${pid%/cwd}
    printf 'p%s\\nn%s\\n' "$pid" "$cwd"
  done
elif command -v lsof >/dev/null 2>&1; then
  lsof -a -d cwd -Fp -Fn 2>/dev/null || true
else
  exit 127
fi
`.trim();
    const result = await runShell(script);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `process scan exited ${result.code}`,
      );
    }
    return parseCheckoutProcessIds(result.stdout, canonicalPath).filter(
      (processId) => host || processId !== process.pid,
    );
  };

  const signalProcesses = async (signal: "TERM" | "KILL", ids: number[]) => {
    if (ids.length === 0) return;
    const command = `kill -${signal} ${ids.join(" ")} 2>/dev/null || true`;
    await runProcessWithCodeTimeout(
      host ? ["ssh", host, command] : ["sh", "-lc", command],
      PROCESS_SCAN_TIMEOUT_MS,
    );
  };

  const stopCheckoutProcesses = async (path: string): Promise<number[]> => {
    const candidates = await listCheckoutProcesses(path);
    if (candidates.length === 0) return [];
    // Require the PID to survive a second cwd scan. This excludes the
    // short-lived scanner shell itself and narrows the PID-reuse race before
    // sending a signal.
    const confirmed = new Set(await listCheckoutProcesses(path));
    const initial = candidates.filter((processId) => confirmed.has(processId));
    if (initial.length === 0) return [];
    await signalProcesses("TERM", initial);
    await new Promise((resolve) => setTimeout(resolve, PROCESS_STOP_GRACE_MS));
    const remaining = await listCheckoutProcesses(path);
    await signalProcesses("KILL", remaining);
    if (remaining.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const survivors = await listCheckoutProcesses(path);
      if (survivors.length > 0) {
        throw new Error(
          `processes still use the checkout after termination: ${survivors.join(", ")}`,
        );
      }
    }
    return initial;
  };

  const preserveCheckout = async (path: string): Promise<string> => {
    const suffix = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    const destination = join(
      dirname(path),
      `${basename(path)}.recovered-${suffix}-${randomBytes(3).toString("hex")}`,
    );
    if (!host) {
      await rename(path, destination);
      return destination;
    }
    const result = await runProcessWithCodeTimeout(
      [
        "ssh",
        host,
        `mv_bin=$(command -v mv 2>/dev/null || true); ` +
          `[ -n "$mv_bin" ] || mv_bin=/bin/mv; ` +
          `"$mv_bin" ${shQuote(path)} ${shQuote(destination)}`,
      ],
      PROCESS_SCAN_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `mv exited ${result.code}`);
    }
    return destination;
  };

  return { inspectCheckout, stopCheckoutProcesses, preserveCheckout };
}
