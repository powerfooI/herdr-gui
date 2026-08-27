import { describe, expect, test } from "bun:test";
import { createLastStepTurnTracker } from "./last-step-turns";

async function flushTransitions() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function status(paneId: string, workspaceId: string, agentStatus: string) {
  return {
    event: "pane.agent_status_changed",
    data: {
      pane_id: paneId,
      workspace_id: workspaceId,
      agent_status: agentStatus,
    },
  };
}

describe("last-step turn tracking", () => {
  test("captures starts and completes only workspace-wide activity periods", async () => {
    const captures: string[] = [];
    const completions: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
      completeWorkspaceStep: async (workspaceId) => {
        completions.push(workspaceId);
      },
    });

    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    tracker.handleHerdrEvent(status("p2", "w1", "working"));
    await flushTransitions();
    tracker.handleHerdrEvent(status("p1", "w1", "idle"));
    tracker.handleHerdrEvent(status("p2", "w1", "done"));
    await flushTransitions();
    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await flushTransitions();

    expect(captures).toEqual(["w1", "w1"]);
    expect(completions).toEqual(["w1"]);
  });

  test("seeds active workspaces from pane listings without capturing", async () => {
    const captures: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
    });

    tracker.reconcilePaneList({
      panes: [
        {
          pane_id: "p1",
          workspace_id: "w1",
          agent: "pi",
          agent_status: "working",
        },
      ],
    });
    tracker.handleHerdrEvent(status("p2", "w1", "working"));
    tracker.handleHerdrEvent(status("p1", "w1", "idle"));
    tracker.handleHerdrEvent(status("p2", "w1", "done"));
    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await Promise.resolve();

    expect(captures).toEqual(["w1"]);
  });

  test("does not let a stale idle listing overwrite a newer working event", async () => {
    const captures: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
    });
    const idlePane = {
      pane_id: "p1",
      workspace_id: "w1",
      agent: "pi",
      agent_status: "idle",
    };
    tracker.reconcilePaneList({ panes: [idlePane] });
    const listRevision = tracker.beginPaneList();
    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    tracker.reconcilePaneList({ panes: [idlePane] }, listRevision);
    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await Promise.resolve();

    expect(captures).toEqual(["w1"]);
  });

  test("does not let a stale working listing suppress the next turn", async () => {
    const captures: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
    });
    const workingPane = {
      pane_id: "p1",
      workspace_id: "w1",
      agent: "pi",
      agent_status: "working",
    };
    tracker.reconcilePaneList({ panes: [workingPane] });
    const listRevision = tracker.beginPaneList();
    tracker.handleHerdrEvent(status("p1", "w1", "idle"));
    tracker.reconcilePaneList({ panes: [workingPane] }, listRevision);
    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await Promise.resolve();

    expect(captures).toEqual(["w1"]);
  });

  test("captures a quiet-to-active transition observed by a later pane listing", async () => {
    const captures: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
    });

    tracker.reconcilePaneList({ panes: [] });
    tracker.reconcilePaneList({
      panes: [
        {
          pane_id: "p1",
          workspace_id: "w1",
          agent: "pi",
          agent_status: "working",
        },
        {
          pane_id: "p2",
          workspace_id: "w1",
          agent: "codex",
          agent_status: "working",
        },
      ],
    });
    await Promise.resolve();

    expect(captures).toEqual(["w1"]);
  });

  test("forgets closed panes when deciding whether a workspace is quiet", async () => {
    const captures: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
    });

    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await flushTransitions();
    tracker.handleHerdrEvent({
      event: "pane.closed",
      data: { pane_id: "p1", workspace_id: "w1" },
    });
    await flushTransitions();
    tracker.handleHerdrEvent(status("p2", "w1", "working"));
    await flushTransitions();

    expect(captures).toEqual(["w1", "w1"]);
  });

  test("debounces transient idle flapping before snapshot work starts", async () => {
    const captures: string[] = [];
    const completions: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
      completeWorkspaceStep: async (workspaceId) => {
        completions.push(workspaceId);
      },
      transitionDebounceMs: 20,
    });

    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    tracker.handleHerdrEvent(status("p1", "w1", "idle"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(captures).toEqual([]);
    expect(completions).toEqual([]);

    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushTransitions();
    expect(captures).toEqual(["w1"]);
    await tracker.stop();
  });

  test("coalesces queued edges while one workspace snapshot is in flight", async () => {
    const captures: string[] = [];
    const completions: string[] = [];
    let releaseCapture: () => void = () => undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
        await captureGate;
      },
      completeWorkspaceStep: async (workspaceId) => {
        completions.push(workspaceId);
      },
    });

    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await flushTransitions();
    tracker.handleHerdrEvent(status("p1", "w1", "idle"));
    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    releaseCapture();
    await flushTransitions();

    expect(captures).toEqual(["w1"]);
    expect(completions).toEqual([]);
    await tracker.stop();
  });

  test("transfers a working pane between workspace activity periods", async () => {
    const captures: string[] = [];
    const completions: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        captures.push(workspaceId);
      },
      completeWorkspaceStep: async (workspaceId) => {
        completions.push(workspaceId);
      },
    });
    tracker.reconcilePaneList({
      panes: [
        {
          pane_id: "p1",
          workspace_id: "old",
          agent: "pi",
          agent_status: "working",
        },
      ],
    });

    tracker.handleHerdrEvent({
      event: "pane.moved",
      data: { pane_id: "p1", workspace_id: "new" },
    });
    await flushTransitions();

    expect(completions).toEqual(["old"]);
    expect(captures).toEqual(["new"]);
    await tracker.stop();
  });

  test("does not complete a closed workspace after its capture settles", async () => {
    const completions: string[] = [];
    let releaseCapture: () => void = () => undefined;
    let signalCapture: () => void = () => undefined;
    const captureStarted = new Promise<void>((resolve) => {
      signalCapture = resolve;
    });
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async () => {
        signalCapture();
        await captureGate;
      },
      completeWorkspaceStep: async (workspaceId) => {
        completions.push(workspaceId);
      },
    });

    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await captureStarted;
    tracker.handleHerdrEvent({
      event: "workspace.closed",
      data: { workspace_id: "w1" },
    });
    releaseCapture();
    await flushTransitions();

    expect(completions).toEqual([]);
    await tracker.stop();
  });

  test("reports capture failures without rejecting event handling", async () => {
    const errors: string[] = [];
    const tracker = createLastStepTurnTracker({
      captureWorkspaceBaseline: async () => {
        throw new Error("snapshot failed");
      },
      onCaptureError: (error, workspaceId) => {
        errors.push(`${workspaceId}: ${error.message}`);
      },
    });

    tracker.handleHerdrEvent(status("p1", "w1", "working"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(["w1: snapshot failed"]);
  });
});
