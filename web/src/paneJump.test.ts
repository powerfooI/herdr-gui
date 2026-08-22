import { describe, expect, test } from "bun:test";
import {
  activePaneIdForSnapshot,
  paneCanClose,
  paneJumpEntries,
  paneJumpTargetId,
} from "./paneJump";
import type { Pane, Tab, Workspace } from "./types";

function workspace(workspaceId: string, label: string): Workspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
  };
}

function tab(tabId: string, workspaceId: string): Tab {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    number: 1,
    label: "1",
    focused: false,
    pane_count: 1,
    agent_status: "unknown",
  };
}

function pane(
  paneId: string,
  workspaceId: string,
  tabId: string,
  agent?: string,
): Pane {
  return {
    pane_id: paneId,
    terminal_id: `terminal-${paneId}`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    cwd: `/repos/${workspaceId}`,
    agent,
    agent_status: agent ? "working" : "unknown",
    revision: 1,
  };
}

describe("recent pane projection", () => {
  test("falls back from a stale selection to the layout-focused pane", () => {
    const layout = {
      focused_pane_id: "mobile-active",
      panes: [
        {
          pane_id: "mobile-active",
          focused: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    };

    expect(activePaneIdForSnapshot({ selectedPaneId: "stale", layout })).toBe(
      "mobile-active",
    );
    expect(
      activePaneIdForSnapshot({ selectedPaneId: "mobile-active", layout }),
    ).toBe("mobile-active");
  });

  test("only allows inline close when a pane has a sibling in its tab", () => {
    const panes = [
      pane("p1", "w1", "t1"),
      pane("p2", "w1", "t1"),
      pane("p3", "w1", "t2"),
    ];

    expect(paneCanClose(panes, "p1")).toBe(true);
    expect(paneCanClose(panes, "p2")).toBe(true);
    expect(paneCanClose(panes, "p3")).toBe(false);
    expect(paneCanClose(panes, "missing")).toBe(false);
  });

  test("emphasizes the workspace and keeps agent state as metadata", () => {
    const entries = paneJumpEntries(
      {
        layout: {
          panes: [
            {
              pane_id: "p1",
              focused: true,
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
        panes: [pane("p1", "w1", "t1", "codex")],
        recentPaneIds: ["p1"],
        tabs: [tab("t1", "w1")],
        workspaces: [workspace("w1", "example-repo")],
      },
      "p1",
    );

    expect(entries).toEqual([
      {
        paneId: "p1",
        title: "example-repo",
        subtitle: "Tab 1 · /repos/w1",
        agent: "codex",
        agentStatus: "working",
        current: true,
      },
    ]);
  });

  test("keeps recent order, removes duplicates, and omits absent agent state", () => {
    const entries = paneJumpEntries({
      layout: {
        panes: [
          {
            pane_id: "p1",
            focused: false,
            rect: { x: 0, y: 0, width: 1, height: 1 },
          },
          {
            pane_id: "p2",
            focused: true,
            rect: { x: 1, y: 0, width: 1, height: 1 },
          },
        ],
      },
      panes: [pane("p1", "w1", "t1"), pane("p2", "w2", "t2")],
      recentPaneIds: ["p2", "p2"],
      tabs: [tab("t1", "w1"), tab("t2", "w2")],
      workspaces: [workspace("w1", "one"), workspace("w2", "two")],
    });

    expect(entries.map((entry) => entry.paneId)).toEqual(["p2", "p1"]);
    expect(entries[0].title).toBe("two");
    expect(entries[0].agent).toBeUndefined();
    expect(entries[0].agentStatus).toBeUndefined();
  });

  test("does not refocus the pane that is already current", () => {
    const entries = [
      {
        paneId: "current",
        title: "one",
        subtitle: "Tab 1",
        current: true,
      },
      {
        paneId: "previous",
        title: "two",
        subtitle: "Tab 1",
        current: false,
      },
    ];

    expect(paneJumpTargetId(entries, 0)).toBeNull();
    expect(paneJumpTargetId(entries, 1)).toBe("previous");
    expect(paneJumpTargetId(entries, 2)).toBeNull();
  });
});
