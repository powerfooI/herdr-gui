type PaneActivity = {
  workspaceId: string;
  status: string;
};

type EventEnvelope = {
  event?: unknown;
  data?: unknown;
};

type PendingTransition = {
  timer: ReturnType<typeof setTimeout>;
};

function eventName(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const envelope = event as EventEnvelope;
  if (typeof envelope.event === "string") return envelope.event;
  if (
    envelope.data &&
    typeof envelope.data === "object" &&
    !Array.isArray(envelope.data)
  ) {
    const type = (envelope.data as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return null;
}

function eventData(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const data = (event as EventEnvelope).data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export type LastStepTurnTracker = {
  beginPaneList: () => number;
  reconcilePaneList: (result: unknown, startedAtRevision?: number) => void;
  handleHerdrEvent: (event: unknown) => void;
  stop: () => Promise<void>;
  clear: () => void;
};

/** Tracks debounced workspace quiet/active boundaries from per-pane status. */
export function createLastStepTurnTracker(args: {
  captureWorkspaceBaseline: (workspaceId: string) => Promise<void>;
  completeWorkspaceStep?: (workspaceId: string) => Promise<void>;
  onCaptureError?: (error: Error, workspaceId: string) => void;
  onCompleteError?: (error: Error, workspaceId: string) => void;
  transitionDebounceMs?: number;
}): LastStepTurnTracker {
  const transitionDebounceMs = args.transitionDebounceMs ?? 0;
  const panes = new Map<string, PaneActivity>();
  const paneEventRevisions = new Map<string, number>();
  const closedWorkspaceRevisions = new Map<string, number>();
  const stableActivity = new Map<string, boolean>();
  const appliedActivity = new Map<string, boolean>();
  const pendingTransitions = new Map<string, PendingTransition>();
  const workers = new Map<string, Promise<void>>();
  const workspaceGenerations = new Map<string, number>();
  let activityRevision = 0;
  let paneListSeeded = false;
  let stopping = false;

  function workspaceIsActive(workspaceId: string) {
    for (const pane of panes.values()) {
      if (pane.workspaceId === workspaceId && pane.status === "working") {
        return true;
      }
    }
    return false;
  }

  function reportTransitionError(
    error: unknown,
    workspaceId: string,
    active: boolean,
  ) {
    const callback = active ? args.onCaptureError : args.onCompleteError;
    if (!callback) return;
    try {
      callback(
        error instanceof Error ? error : new Error(String(error)),
        workspaceId,
      );
    } catch {
      // Logging/observer callbacks are an event-delivery boundary and must not
      // terminate the transition worker that provides snapshot backpressure.
    }
  }

  function startWorker(workspaceId: string) {
    if (stopping || workers.has(workspaceId)) return;
    const generation = workspaceGenerations.get(workspaceId) ?? 0;
    const task = (async () => {
      while (!stopping) {
        const desired = stableActivity.get(workspaceId) ?? false;
        const applied = appliedActivity.get(workspaceId) ?? false;
        if (desired === applied) return;
        try {
          if (desired) {
            await args.captureWorkspaceBaseline(workspaceId);
          } else {
            await args.completeWorkspaceStep?.(workspaceId);
          }
        } catch (error) {
          // Git/IO failures are translated exactly once at this event boundary;
          // the failed edge is considered consumed so status flapping cannot
          // create an unbounded retry queue.
          reportTransitionError(error, workspaceId, desired);
        }
        if (
          stopping ||
          (workspaceGenerations.get(workspaceId) ?? 0) !== generation
        ) {
          return;
        }
        appliedActivity.set(workspaceId, desired);
      }
    })();
    workers.set(workspaceId, task);
    const finish = () => {
      if (workers.get(workspaceId) === task) workers.delete(workspaceId);
      if (
        !stopping &&
        (stableActivity.get(workspaceId) ?? false) !==
          (appliedActivity.get(workspaceId) ?? false)
      ) {
        startWorker(workspaceId);
      }
    };
    void task.then(finish, finish);
  }

  function commitTransition(workspaceId: string, active: boolean) {
    if (stopping || workspaceIsActive(workspaceId) !== active) return;
    if ((stableActivity.get(workspaceId) ?? false) === active) return;
    stableActivity.set(workspaceId, active);
    startWorker(workspaceId);
  }

  function observeWorkspace(workspaceId: string) {
    if (stopping) return;
    const active = workspaceIsActive(workspaceId);
    const pending = pendingTransitions.get(workspaceId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingTransitions.delete(workspaceId);
    }
    if ((stableActivity.get(workspaceId) ?? false) === active) return;
    if (transitionDebounceMs <= 0) {
      commitTransition(workspaceId, active);
      return;
    }
    const timer = setTimeout(() => {
      const current = pendingTransitions.get(workspaceId);
      if (!current || current.timer !== timer) return;
      pendingTransitions.delete(workspaceId);
      commitTransition(workspaceId, active);
    }, transitionDebounceMs);
    pendingTransitions.set(workspaceId, { timer });
  }

  function cancelWorkspace(workspaceId: string) {
    workspaceGenerations.set(
      workspaceId,
      (workspaceGenerations.get(workspaceId) ?? 0) + 1,
    );
    const pending = pendingTransitions.get(workspaceId);
    if (pending) clearTimeout(pending.timer);
    pendingTransitions.delete(workspaceId);
    stableActivity.delete(workspaceId);
    appliedActivity.delete(workspaceId);
  }

  function resetState() {
    for (const pending of pendingTransitions.values()) {
      clearTimeout(pending.timer);
    }
    pendingTransitions.clear();
    panes.clear();
    paneEventRevisions.clear();
    closedWorkspaceRevisions.clear();
    stableActivity.clear();
    appliedActivity.clear();
    workers.clear();
    workspaceGenerations.clear();
    activityRevision = 0;
    paneListSeeded = false;
  }

  return {
    beginPaneList: () => activityRevision,
    reconcilePaneList(result, startedAtRevision = activityRevision) {
      if (stopping) return;
      const listed =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as { panes?: unknown }).panes
          : undefined;
      if (!Array.isArray(listed)) return;
      const next = new Map<string, PaneActivity>();
      for (const pane of listed) {
        if (!pane || typeof pane !== "object" || Array.isArray(pane)) continue;
        const record = pane as {
          pane_id?: unknown;
          workspace_id?: unknown;
          agent?: unknown;
          agent_status?: unknown;
        };
        if (
          typeof record.pane_id === "string" &&
          typeof record.workspace_id === "string" &&
          typeof record.agent === "string" &&
          record.agent.length > 0 &&
          typeof record.agent_status === "string"
        ) {
          next.set(record.pane_id, {
            workspaceId: record.workspace_id,
            status: record.agent_status,
          });
        }
      }
      const affectedWorkspaces = new Set<string>();
      for (const pane of panes.values())
        affectedWorkspaces.add(pane.workspaceId);
      for (const [paneId, listedPane] of next) {
        if (
          (closedWorkspaceRevisions.get(listedPane.workspaceId) ?? 0) >
          startedAtRevision
        ) {
          next.delete(paneId);
          continue;
        }
        if ((paneEventRevisions.get(paneId) ?? 0) > startedAtRevision) {
          const eventPane = panes.get(paneId);
          if (eventPane) next.set(paneId, eventPane);
          else next.delete(paneId);
        }
      }
      for (const [paneId, eventPane] of panes) {
        if (
          !next.has(paneId) &&
          (paneEventRevisions.get(paneId) ?? 0) > startedAtRevision
        ) {
          next.set(paneId, eventPane);
        }
      }
      panes.clear();
      for (const [paneId, pane] of next) {
        panes.set(paneId, pane);
        affectedWorkspaces.add(pane.workspaceId);
      }
      if (!paneListSeeded) {
        for (const workspaceId of affectedWorkspaces) {
          const active = workspaceIsActive(workspaceId);
          stableActivity.set(workspaceId, active);
          appliedActivity.set(workspaceId, active);
        }
      } else {
        for (const workspaceId of affectedWorkspaces) {
          observeWorkspace(workspaceId);
        }
      }
      paneListSeeded = true;
    },
    handleHerdrEvent(event) {
      if (stopping) return;
      const name = eventName(event);
      const data = eventData(event);
      if (!name || !data) return;

      if (name === "pane.agent_status_changed") {
        const paneId = data.pane_id;
        const workspaceId = data.workspace_id;
        const status = data.agent_status;
        if (
          typeof paneId !== "string" ||
          !paneId ||
          typeof workspaceId !== "string" ||
          !workspaceId ||
          typeof status !== "string"
        ) {
          return;
        }
        const previous = panes.get(paneId);
        activityRevision += 1;
        paneEventRevisions.set(paneId, activityRevision);
        closedWorkspaceRevisions.delete(workspaceId);
        panes.set(paneId, { workspaceId, status });
        if (previous && previous.workspaceId !== workspaceId) {
          observeWorkspace(previous.workspaceId);
        }
        observeWorkspace(workspaceId);
        return;
      }

      if (name === "pane.moved" || name === "pane_moved") {
        const paneId = data.pane_id;
        const workspaceId = data.workspace_id ?? data.new_workspace_id;
        if (
          typeof paneId !== "string" ||
          !paneId ||
          typeof workspaceId !== "string" ||
          !workspaceId
        ) {
          return;
        }
        const previous = panes.get(paneId);
        if (!previous || previous.workspaceId === workspaceId) return;
        const status =
          typeof data.agent_status === "string"
            ? data.agent_status
            : previous.status;
        activityRevision += 1;
        paneEventRevisions.set(paneId, activityRevision);
        closedWorkspaceRevisions.delete(workspaceId);
        panes.set(paneId, { workspaceId, status });
        observeWorkspace(previous.workspaceId);
        observeWorkspace(workspaceId);
        return;
      }

      if (name === "pane.closed" || name === "pane_closed") {
        const paneId = data.pane_id;
        if (typeof paneId === "string") {
          const pane = panes.get(paneId);
          activityRevision += 1;
          paneEventRevisions.set(paneId, activityRevision);
          panes.delete(paneId);
          if (pane) observeWorkspace(pane.workspaceId);
        }
        return;
      }

      if (name === "workspace.closed" || name === "workspace_closed") {
        const workspaceId = data.workspace_id;
        if (typeof workspaceId !== "string") return;
        activityRevision += 1;
        closedWorkspaceRevisions.set(workspaceId, activityRevision);
        for (const [paneId, pane] of panes) {
          if (pane.workspaceId === workspaceId) {
            paneEventRevisions.set(paneId, activityRevision);
            panes.delete(paneId);
          }
        }
        cancelWorkspace(workspaceId);
      }
    },
    async stop() {
      if (stopping) {
        await Promise.allSettled(workers.values());
        return;
      }
      stopping = true;
      for (const pending of pendingTransitions.values()) {
        clearTimeout(pending.timer);
      }
      pendingTransitions.clear();
      // Snapshot errors are already reported inside each worker; allSettled is
      // used only at this shutdown boundary to drain every in-flight process.
      await Promise.allSettled(workers.values());
      resetState();
    },
    clear() {
      stopping = true;
      resetState();
    },
  };
}
