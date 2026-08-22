import type { Pane, PaneLayout, Tab, Workspace } from "./types";

export type PaneJumpEntry = {
  paneId: string;
  title: string;
  subtitle: string;
  agent?: string;
  agentStatus?: string;
  current: boolean;
};

type ActivePaneSnapshot = {
  selectedPaneId?: string | null;
  layout?: Pick<PaneLayout, "panes" | "focused_pane_id"> | null;
};

type PaneJumpSnapshot = {
  layout?: Pick<PaneLayout, "panes"> | null;
  panes: Pane[];
  recentPaneIds: string[];
  tabs: Tab[];
  workspaces: Workspace[];
};

/** Resolves selection only when it still belongs to the active layout. */
export function activePaneIdForSnapshot(
  snapshot: ActivePaneSnapshot,
): string | undefined {
  return snapshot.selectedPaneId &&
    snapshot.layout?.panes.some(
      (pane) => pane.pane_id === snapshot.selectedPaneId,
    )
    ? snapshot.selectedPaneId
    : snapshot.layout?.focused_pane_id;
}

/** A pane can be closed inline only while a sibling keeps its tab alive. */
export function paneCanClose(
  panes: readonly Pick<Pane, "pane_id" | "tab_id">[],
  paneId: string,
): boolean {
  const target = panes.find((pane) => pane.pane_id === paneId);
  return (
    !!target &&
    panes.some(
      (pane) => pane.pane_id !== paneId && pane.tab_id === target.tab_id,
    )
  );
}

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
