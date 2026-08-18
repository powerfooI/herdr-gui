import type { Pane, PaneLayout, Tab, Workspace } from "./types";

export type PaneJumpEntry = {
  paneId: string;
  title: string;
  subtitle: string;
  agent?: string;
  agentStatus?: string;
  current: boolean;
};

type PaneJumpSnapshot = {
  layout?: Pick<PaneLayout, "panes"> | null;
  panes: Pane[];
  recentPaneIds: string[];
  tabs: Tab[];
  workspaces: Workspace[];
};

/** Projects live pane state into a deduplicated, most-recent-first switcher. */
export function paneJumpEntries(
  snapshot: PaneJumpSnapshot,
  activePaneId?: string | null,
): PaneJumpEntry[] {
  const paneById = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  const workspaceById = new Map(
    snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
  );
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  const fallbackPaneIds =
    snapshot.layout?.panes.map((pane) => pane.pane_id) ?? [];
  const seen = new Set<string>();
  const orderedPaneIds = [...snapshot.recentPaneIds, ...fallbackPaneIds];

  return orderedPaneIds
    .filter((paneId) => {
      if (seen.has(paneId)) return false;
      seen.add(paneId);
      return paneById.has(paneId);
    })
    .map((paneId) =>
      paneJumpEntry(
        paneById.get(paneId)!,
        workspaceById,
        tabById,
        paneId === activePaneId,
      ),
    );
}

/** Returns a real focus target, excluding an invalid or already-current item. */
export function paneJumpTargetId(
  entries: PaneJumpEntry[],
  index: number,
): string | null {
  const entry = entries[index];
  return entry && !entry.current ? entry.paneId : null;
}

function paneJumpEntry(
  pane: Pane,
  workspaceById: Map<string, Workspace>,
  tabById: Map<string, Tab>,
  current: boolean,
): PaneJumpEntry {
  const workspace = workspaceById.get(pane.workspace_id);
  const tab = tabById.get(pane.tab_id);
  const cwd = pane.foreground_cwd ?? pane.cwd ?? "";
  const workspaceLabel = workspace?.label ?? pane.workspace_id;
  const tabLabel = tab
    ? tab.label && tab.label !== String(tab.number)
      ? tab.label
      : `Tab ${tab.number}`
    : pane.tab_id;
  const subtitle = [tabLabel, cwd]
    .filter((value) => value.trim().length > 0)
    .join(" · ");

  return {
    paneId: pane.pane_id,
    title: workspaceLabel,
    subtitle,
    agent: pane.agent,
    agentStatus: pane.agent ? pane.agent_status : undefined,
    current,
  };
}
