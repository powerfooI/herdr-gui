# Workspace Resource Inspector UX Design

Status: **Implemented**
Last updated: 2026-08-22

## Objective

Make Files and Changes feel like tools of the active checkout instead of global
application pages. Keep the terminal visible while browsing files or reviewing
changes, preserve context across workspaces and linked worktrees, and prevent
resource state from crossing checkout or connection boundaries.

The central product rule is:

> Resource data belongs to a checkout; the active workspace provides the
> runtime route; the originating tab provides the return location; an agent or
> pane may provide an initial path.

## Problems addressed

The previous application model treated Workspaces, Files, and Diff as mutually
exclusive sidebar activities. Opening Files or Diff replaced the Workspace tree
and hid the terminal surface. Separate `fileExplorerWorkspaceId` and
`diffViewerWorkspaceId` state could also diverge temporarily from the focused
workspace.

That model created several UX problems:

- Files and Diff appeared global even though every request was workspace-scoped.
- The active repository, checkout, or worktree was not always obvious.
- Users could not watch an agent or use a terminal while inspecting its files.
- Switching workspaces could change the resource target without a strong visual
  transition.
- Linked worktrees of the same repository could contain identical paths but
  different content and Git state.

## Product decisions

1. The Workspace tree remains visible as the stable global navigation surface.
2. Files, Changes, and agent History live in a dockable Workspace Inspector
   next to the terminal.
3. The Inspector follows one explicit checkout and never silently mixes data
   from another worktree.
4. Files, Changes, and History share one Inspector slot and switch through
   Inspector tabs.
5. The terminal stays mounted while the Inspector is open.
6. Inspector data and cache state are shared by consumers of the same checkout;
   navigation and return state remain local to the workspace/tab interaction.
7. Repository groups organize worktrees but do not expose an ambiguous combined
   Files or Diff view.
8. Narrow layouts fall back to an overlay or full-screen resource flow while
   preserving the mounted terminal session where practical.

## Ownership hierarchy

```text
Connection
  `-- Repository                         repo_key
       `-- Checkout / linked worktree    checkout_key + checkout_path
            `-- Herdr workspace          workspace_id
                 `-- Tab                 tab_id
                      `-- Pane / agent    pane_id + foreground_cwd
```

### Repository

A repository is a grouping and lifecycle boundary. It is identified by
`repo_key`. Repository-level actions include managing worktrees, creating a
linked worktree, fetching, refreshing status, and collapsing the group.

A repository group does not have one meaningful working tree, so it must not
open a normal File Explorer or Diff Viewer without first choosing a checkout.

### Checkout or linked worktree

The checkout is the resource-data owner:

- File Explorer root: `checkout_path`
- Working tree Diff: Git commands run with `git -C checkout_path`
- Against-main Diff: current checkout/branch compared with its resolved main
  base
- File selection, directory state, Diff selection, and collapse state: scoped
  to a stable checkout key

The stable persistence key is:

```text
checkout_key = worktree.gui_settings_key
            ?? repo_key + ":" + normalized(checkout_path)
```

### Workspace

The workspace supplies the current `workspace_id` used by bridge APIs. Multiple
workspace surfaces that resolve to the same checkout may share resource caches,
but every async request remains bound to the current connection and workspace
runtime generation.

For non-Git workspaces, resource ownership falls back to the workspace identity.

### Tab

The originating tab is a navigation anchor. Opening the Inspector records a
`returnTabId`; closing or expanding/collapsing the Inspector does not create or
modify a Herdr terminal tab.

Selecting another terminal tab keeps a docked Inspector open. Switching to a
workspace with a different checkout retargets the Inspector while restoring
that checkout's isolated resource state. Terminal becomes the sole surface only
through the explicit Session/close action.

### Pane or agent

An agent does not own repository changes. Git cannot reliably attribute a
working-tree edit to one agent. Agent and pane actions only provide context:

- Browse Files starts at `foreground_cwd` when it is inside the checkout.
- Review Changes opens the owning checkout's workspace-wide Diff.
- A terminal file link resolves through the pane's `workspace_id`, not a global
  focused workspace.

An agent-specific "changes since this agent started" feature would require a
separate recorded baseline and is outside this design.

## Desktop information architecture

```text
+-------------------+------------------------------------+---------------------+
| WORKSPACES        | [Agent 1] [Agent 2] [+]            | INSPECTOR           |
|                   |                                    | Files Changes    [x]|
| v main        Δ5 +------------------------------------+---------------------+
|   pi · p-a1  work |                                    | feature/auth - WT   |
| v feature WT Δ12 |              Terminal              +---------+-----------+
|   codex · p-b2 ok |                                    | Files   | Preview   |
| > other repo      |       active tab pane layout       | tree    | or Diff   |
|                   |                                    |         |           |
+-------------------+------------------------------------+---------+-----------+
| Connected - repository / feature/auth - Agent 1                              |
+-------------------------------------------------------------------------------+
```

Workspace rows keep contextual actions in their right-click or long-press menu
instead of permanent Files, Changes, or overflow buttons. Git status remains
visible as metadata. Agent sessions render as child rows of the workspace that
owns their pane.

### Workspace and worktree rows

A repository group contains checkout rows. Each checkout row shows:

- workspace/check-out display name;
- branch or detached state;
- linked-worktree marker;
- staged, unstaged, untracked, and conflicted status where available.

Agent status does not appear on the workspace row. Every pane with an agent
identity, including completed sessions with unknown live status, appears as a
collapsible child row of its owning workspace. The compact child row carries the
agent icon and only persistent attention status; pane identity and working
directory remain available in its tooltip and context actions. Pane IDs appear
inline only when a workspace has multiple agent panes. The child and TabBar use
the same reusable Agent-icon/status-dot component. The child icon aligns to the
workspace label column, while non-idle lifecycle status aligns to the trailing
metadata edge.

Example:

```text
v main                    main       Δ5
  pi · p-a1                         working
v feature/auth   WT       Δ12
  codex · p-b2                       done
```

`parent_workspace_id` may influence initial ordering after worktree creation,
but grouping must ultimately use `repo_key`; a creation-source workspace may be
closed before its linked worktree.

## Workspace Inspector

The Inspector is a persistent, resizable tool surface with three resource tabs:

```text
repository
feature/auth  WT
/path/to/checkout
[ Files ] [ Changes 12 ] [ History ]    Dock   Expand   Close
```

The header always displays enough identity to prevent cross-worktree mistakes:

- repository name;
- branch/worktree label;
- linked-worktree marker;
- visible checkout path, truncated with a full-path tooltip when necessary;
- current Files, Changes, or History mode.

Because this identity remains visible across all three tabs, embedded Files and
Changes navigation panels do not repeat generic `File Explorer` or `Diff Viewer`
titles or the checkout path.

### Right dock

Right dock is the default on wide desktop layouts.

```text
+-----------------------------+----------------------+
| Terminal                    | Files or Changes     |
|                             |                      |
+-----------------------------+----------------------+
```

Implemented sizing:

- terminal minimum width: 480 px;
- Inspector minimum width: 360 px;
- default Inspector width: 520 px, bounded by the available stage size;
- maximum Inspector width: 65% of the main content area.

### Bottom dock

Bottom dock preserves terminal width and is useful for multi-pane terminals or
wide diffs.

```text
+----------------------------------------------------+
| Terminal                                           |
+----------------------------------------------------+
| Files or Changes                                   |
+----------------------------------------------------+
```

### Expanded mode

Expanded mode temporarily gives Files or Changes the full main surface. The
terminal remains mounted but hidden. Closing expanded mode restores the prior
dock, size, active tab, and terminal layout.

### Resizing behavior

Inspector resize must not recreate terminal components. During a drag:

- batch geometry updates with `requestAnimationFrame`;
- refit xterm and update pane geometry without reconnecting;
- avoid persisting every pointer event;
- persist the final size after drag completion;
- preserve per-checkout dock and size preferences where appropriate.

Expanded Files and Changes add a vertical separator between file navigation and
content. Pointer dragging adjusts the navigation width while preserving minimum
widths for both panes. The separator also supports Left/Right and Home/End keys,
and double-click resets the default ratio. Files and Changes retain independent
checkout-scoped ratios; narrow drill-in layouts do not show the separator.

## Files experience

### Wide Inspector

A wide Inspector shows tree and preview together:

```text
+----------------------+--------------------------------+
| FILES                | src/components/App.tsx         |
| v src                |                                |
|   v components       | 1 import ...                   |
|     App.tsx        < | 2                              |
|     Workspace.tsx    | 3 export function App() {     |
|   api.ts             | 4   ...                        |
+----------------------+--------------------------------+
```

### Narrow Inspector

A narrow Inspector uses drill-in navigation instead of compressing both panes:

```text
FILES                         < Files
--------------------          --------------------------
v src                         src/components/App.tsx
  v components
    App.tsx                   1 import ...
    Workspace.tsx             2
  api.ts                      3 export function ...
```

File Preview keeps code highlighting, line numbers, search, Markdown rendering,
and image preview behavior.

An agent-originated Browse Files action starts at the pane's foreground working
directory when it is contained by the checkout; otherwise it starts at the
checkout root.

## Changes experience

Changes uses the same Inspector slot. The active checkout is always explicit:

```text
repository / feature/auth / Changes
Working tree | Against main
```

### Narrow Inspector

Keep Diff search navigation together and allow the Split/Unified plus
Wrap/No-wrap display controls to move as a second responsive group rather than
clipping at the Inspector edge. Use unified Diff by default when space remains
insufficient.

### Wide Inspector or bottom dock

Allow unified and split modes. Preserve search, wrapping, generated-file labels,
and automatic collapse behavior.

Large diffs, byte-truncated diffs, and files marked with
`linguist-generated=true` remain auto-collapsed. A user may expand them
manually. Collapsed sections must not perform Diff HTML rendering or syntax
highlighting until expanded.

"Open in Files" switches the same Inspector from Changes to Files and selects
the same checkout and path. It must never resolve through a different focused
workspace.

## Main interactions

### From a workspace or worktree row

- Click row body: focus the workspace and its active terminal tab.
- Click the disclosure: expand or collapse linked worktrees and agent sessions.
- Right-click or long-press opens the contextual action menu without reserving a
  trailing inline-action column.
- The menu provides Files, Changes, copy checkout path, pin, worktree lifecycle,
  and close actions. Files and Changes open in the unified Inspector.

### From TabBar

Agent sessions are nested directly under their owning workspace by default.
Workspace and Agent hierarchy levels use a compact indent while keeping each
Agent icon aligned with the label column of its owning workspace. Selecting an
agent child focuses its pane. Its context menu provides Terminal, Files,
Changes, History, export, and close actions.

A persistent `Agents: Nested | Separate` control sits at the bottom of the
Workspaces panel. `Nested` is the default. `Separate` removes Agent children from
workspace rows and restores a dedicated Agents panel below Workspaces without
changing selection, context-menu, completed-session, or Inspector behavior.

The right side of the active workspace TabBar contains one Inspector toggle:

```text
[Agent 1  PiIcon●] [Agent 2  CodexIcon●] [+]      Inspector 12
```

Agent tabs reuse the compact Agent icon and overlaid colored status dot from the
Workspace navigator. The marker summarizes the focused agent pane; when a tab
contains multiple agent kinds it appends `+N`, with full identity and status
available in its tooltip.

The Inspector control opens the last checkout-scoped Inspector view without
duplicating its Files, Changes, and History tabs in the TabBar. `Cmd+Shift+B`
toggles the same control and ignores key-repeat events.

- Selecting a terminal tab keeps the Inspector docked and mounted.
- Selecting another workspace retargets the open Inspector without closing it.
- Switching among Files, Changes, and History does not explicitly refit or
  resize the terminal; the terminal ResizeObserver remains the sole response to
  actual stage geometry changes.
- Selecting Inspector restores the last compatible Inspector view for that
  workspace.
- Closing the Inspector returns focus to `returnTabId` when it still exists,
  otherwise to the workspace's active tab.

### From an agent or pane

Agent/pane context menu:

```text
Open Terminal
Browse Files at Agent CWD
Review Workspace Changes
View Agent History
```

View Agent History opens the pane's session in the History tab of the same
Inspector instead of a second terminal-side drawer. Opening from a browse or
history action moves focus into the requested Inspector content; shortcut-based
opens preserve terminal focus.

### From terminal links

Cmd/Ctrl-clicking a workspace path opens Files in the same pane workspace and
selects the path. It must carry `workspace_id`, and optionally `pane_id`, through
the entire request rather than consulting global focus at completion time.

## Responsive behavior

The stage width controls docking, while the Inspector's own width controls its
internal resource layout:

| Measurement | Behavior |
| --- | --- |
| Stage >= 1000 px | Terminal with a right or bottom Inspector dock |
| Stage 700-999 px | Full-height right Inspector overlay or bottom overlay |
| Stage < 700 px | Full-screen mobile Files/Changes/History flow |
| Inspector >= 560 px | File navigation and preview/Diff shown together |
| Inspector < 560 px | Drill-in Files/Changes navigation with one surface visible |

### Mobile

The active workspace exposes local resource navigation:

```text
[ Session ] [ Files ] [ Changes 12 ] [ History ]
```

History is available when the active pane has an agent session. Files uses
list-to-preview navigation. Changes uses changed-files-to-Diff navigation. The
Workspaces action belongs to the bottom-right quick-control stack directly above
the expand/collapse toggle, rather than consuming top-bar space; it collapses
and expands with the rest of that stack. Headers include the repository and
worktree label:

```text
< feature/auth / Files
< feature/auth / Changes
```

The mobile terminal session remains mounted while switching among local
resource views, preserving the same terminal connection and state.

## State model

Implemented navigation state:

```ts
type InspectorView = "files" | "changes" | "history";
type WorkspaceSurface = "terminal" | InspectorView;
type InspectorDock = "right" | "bottom";

type ResourceScope =
  | {
      kind: "worktree";
      connectionId: string;
      repoKey: string;
      checkoutKey: string;
      checkoutPath: string;
      workspaceId: string;
    }
  | {
      kind: "workspace";
      connectionId: string;
      workspaceId: string;
    };

interface WorkspaceInspectorState {
  scope: ResourceScope;
  open: boolean;
  view: InspectorView;
  dock: InspectorDock;
  size: number;
  expanded: boolean;
  returnTabId?: string;
  originPaneId?: string;
  initialDirectory?: string;
}

interface InspectorPreferences {
  view: InspectorView;
  dock: InspectorDock;
  rightSize: number;
  bottomSize: number;
  filesNavigationRatio: number;
  changesNavigationRatio: number;
}
```

Resource content state remains separate:

```ts
interface CheckoutResourceState {
  files: {
    directory: string;
    selectedPath?: string;
    showHidden: boolean;
  };
  changes: {
    scope: "working" | "branch-main";
    selectedKey?: string;
  };
}
```

### Persistence and caches

- Runtime routing keys include connection identity/generation and
  `workspace_id`.
- Persistent Files/Changes state and Inspector layout preferences use
  `checkoutKey` for Git worktrees and workspace identity for non-Git
  workspaces.
- File and Diff data caches may be shared by workspaces that resolve to the same
  checkout only if request-generation isolation remains intact.
- Batched Diff prefetch reads and writes the same checkout resource key as the
  visible Changes view; a workspace-ID cache must not suppress checkout-scoped
  requests and leave expanded sections indefinitely loading.
- Tab/pane IDs are navigation anchors, not resource-cache owners.
- Closing a workspace does not delete checkout state if another workspace still
  targets that checkout.
- Removing a worktree deletes its checkout-scoped resource state after a
  successful removal.

## Worktree lifecycle

### Closed worktree

A worktree without `open_workspace_id` remains in Worktree Manager rather than
appearing as an interactive checkout row. Available actions are:

```text
Open Workspace
Open Workspace and Browse Files
Open Workspace and Review Changes
Remove Worktree
```

The UI creates and visibly opens the workspace before routing the Inspector; it
does not create an invisible workspace.

### Removal

When removing a worktree used by an Inspector, tab, or agent, confirmation
summarizes the impact:

```text
Remove feature/auth worktree?

- 1 workspace is open
- 2 agent tabs are active
- 12 uncommitted changes
- Files is viewing src/auth/login.ts
```

After successful removal:

1. close associated workspaces/tabs according to lifecycle policy;
2. close or retarget the Inspector to the source/main checkout;
3. delete checkout-scoped Files/Changes state and caches;
4. refresh the repository group;
5. leave sibling worktrees untouched.

Prunable or missing worktrees disable Files/Changes actions and offer cleanup.

## Keyboard and focus

Existing shortcuts keep their key bindings but become context-resolved:

- Cmd+Shift+B: toggle the Workspace Inspector's last compatible view.
- Cmd/Ctrl+Shift+E: toggle Files for the active tab workspace.
- Ctrl+Shift+G: toggle Changes for the active tab workspace.
- Ctrl+Shift+W: focus Workspace navigation.
- Cmd/Ctrl+F: search the currently focused terminal/resource surface.
- Escape: close transient search/menu state first, then close expanded mode or
  the Inspector according to existing escape priority.

Focus rules:

- opening from a terminal shortcut keeps terminal focus unless the command is
  explicitly a browse/select action;
- clicking Files/Changes moves focus into that surface;
- closing restores the originating control or terminal tab;
- resizer and utility controls are keyboard reachable and have visible focus;
- Workspace and nested Agent rows use roving tree focus, Enter/Space activation,
  arrow-key navigation, and Shift+F10/ContextMenu-key actions;
- collapsed mobile quick controls leave the tab order and accessibility tree;
- confirmation dialogs leave Enter to the focused native button;
- dock, expand, close, worktree, and change-count controls expose clear labels.

## Error and edge-case behavior

- If the target workspace closes during a request, retire the result and either
  rebind to another workspace for the same checkout or close the Inspector.
- Clearing or refreshing a checkout increments its resource revision so older
  Files/Changes prefetches cannot recreate deleted state or overwrite a newer
  snapshot.
- If the active connection changes, resource state from the old connection must
  not render in the new one.
- If a worktree path disappears, show an unavailable state and lifecycle action;
  never fall back to another checkout with the same repository.
- If `returnTabId` no longer exists, return to the workspace's current active
  tab.
- If an agent CWD is outside the checkout, show the checkout root and avoid
  exposing arbitrary host paths.
- When terminal and Inspector minimum sizes cannot both fit, transition to
  overlay/full-screen mode rather than shrinking either into an unusable state.

## Implementation status

All four phases are complete in the current implementation.

### Phase 1: contextual shell — complete

- Keep Workspace Tree mounted for all desktop resource views.
- Introduce a `WorkspaceInspectorHost` beside the terminal surface.
- Move Files and Changes controls from the global activity switcher into the
  workspace TabBar/toolbar.
- Keep `TerminalPaneLayout` mounted while the Inspector is open.
- Add resizable right dock and expanded mode.

### Phase 2: resource scope normalization — complete

- Replace independent global Files/Diff workspace IDs with one explicit
  `ResourceScope`.
- Derive request targets from the active workspace/tab/pane at invocation time.
- Key persistence by connection plus checkout/workspace identity.
- Preserve existing File Explorer and Diff caches after adapting their keys.

### Phase 3: worktree hierarchy — complete

- Group checkout rows by stable `repo_key`.
- Use `checkoutKey` for resource preferences and `workspace_id` for routing.
- Keep checkout-row resource actions in the right-click/long-press menu and
  retain visible Git status metadata.
- Nest agent panes under their owning workspace by default, remove aggregate
  agent state from workspace rows, and provide a persisted separate-panel
  compatibility option.
- Handle closed, prunable, and removed worktrees.

### Phase 4: agent and responsive flows — complete

- Add Agent CWD and workspace Changes actions.
- Add narrow Inspector drill-in Files and unified Diff behavior.
- Implement bottom docking and mobile local navigation.
- Complete focus restoration, keyboard behavior, and accessibility checks.

## Implemented acceptance criteria

- The terminal remains connected and preserves state while Files or Changes is
  open.
- Workspace Tree remains available on desktop while the Inspector is docked.
- Every Inspector displays its repository/checkout identity.
- Files and Git commands always target the displayed checkout.
- Two linked worktrees with the same relative path never share selection,
  preview, Diff, or collapse state accidentally.
- Switching workspace/worktree restores its independent Inspector state.
- Terminal file links open the pane's checkout, not a stale focused workspace.
- Selecting another terminal tab or workspace keeps the Inspector open and
  preserves isolated checkout resource state.
- Large/generated Diff sections remain lazy while collapsed.
- Right dock, bottom dock, expanded, overlay, and mobile modes preserve a usable
  minimum terminal/resource size.
- Worktree removal cannot leave stale resource content visible.
- Connection/runtime-generation isolation remains unchanged.

## Out of scope

- A merged Diff across multiple worktrees.
- Treating Files or Changes as synthetic Herdr terminal tabs.
- Attributing arbitrary working-tree changes to an agent without a recorded
  baseline.
- Editing files directly in File Preview.
- Showing Files or Diff for a closed worktree through an invisible workspace.
- Cross-worktree file comparison; this may be designed later as a separate
  repository tool.
