# Herdr Studio Features

Herdr Studio is a browser and PWA client for a running
[Herdr](https://herdr.dev) server. It keeps Herdr's workspace, tab, pane, and
agent model, while adding repository tools, session inspection, mobile controls,
and operational features around it.

For installation and deployment, see
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

## Workspace, Tab, and Pane Navigation

- Browse all Herdr workspaces and their recognized agents from one sidebar.
- Create, rename, focus, pin, and close workspaces.
- Group linked Git worktrees under their parent repository workspace. Groups can
  be collapsed, while individual workspaces or worktrees can be pinned to the
  top. Pin and collapse preferences are stored in the current browser.
- Create, rename, switch, and close tabs in the focused workspace.
- Split the active pane right or down, resize pane boundaries with the pointer,
  focus neighboring panes, zoom a pane, and close panes.
- Use the searchable command menu (`Cmd/Ctrl+K`) for workspace, worktree, file,
  tab, pane, and agent actions. Entering a workspace-relative or absolute file
  path opens that file directly.

### Recent Pane Switcher

`Ctrl+Tab` opens a most-recently-used switcher that can jump between panes in
other tabs and workspaces. It keeps the 12 most recently focused live panes and
also includes panes in the current layout. Each entry shows its workspace, tab
or working directory, and Agent icon/status when available.

- Press `Ctrl+Tab` to start on the previously used pane.
- Keep holding `Ctrl` and press `Tab` to move forward.
- Use `Ctrl+Shift+Tab` to move backward.
- `Up` and `Down` also move through the list.
- Release `Ctrl` or press `Enter` to switch.
- Press `Esc` to cancel.

Closed panes are removed from the history automatically.

## Full Browser Terminal

- Render Herdr's server-side terminal stream at the browser's current rows and
  columns, including split-pane layouts.
- Send normal terminal input, modified Enter sequences, and common macOS
  line-editing shortcuts.
- Scroll terminal history with a mouse wheel, trackpad, touch gesture,
  `Page Up`/`Page Down`, or half-page `Alt/Option+Page Up`/`Page Down`.
- Paste multiline text through terminal paste handling.
- Paste a clipboard image to upload it on the Herdr host and insert the resulting
  path into the terminal. This also works through `--ssh-host`.
- Relay OSC 52 clipboard writes from local or remote terminal applications to
  the initiating browser.
- `Cmd/Ctrl`-click HTTP(S) links to open them safely in a new tab.
- `Cmd/Ctrl`-click workspace-relative or absolute file paths in terminal output
  to preview text, Markdown, or images without leaving the terminal.
- Preserve IME composition and rapid CJK punctuation input.

## Agent Awareness and Session Inspection

Herdr reports recognized agents and their state, and Herdr Studio projects that
information across the workspace tree, pane switcher, command menu, and Agent
panel.

- See Agent identity and status such as working, blocked, done, or idle.
- Focus an Agent's pane from the sidebar, command menu, recent pane switcher, or
  a browser task-completion notification.
- Open a message-history drawer beside the active terminal. Assistant messages
  can be included or hidden.
- Inspect turn count, token usage, update time, session ID, session file, and
  other session details.
- Open Session Inspector in Timeline, ATIF, or raw transcript mode, with search
  for ATIF and raw content.
- Export the original session file or the normalized ATIF trajectory.

Session inspection currently supports Codex, Claude, Kimi, Grok Build, and Pi.
It requires a readable session record; for agents that rely on Herdr integration,
the UI shows the integration command when session metadata is unavailable.
Session paths reported by Herdr are read from the remote host when `--ssh-host`
is active, and Pi session IDs support remote lookup. Other ID/directory fallback
searches, including Grok Build discovery, remain local and may not resolve a
remote session unless its transcript is also locally accessible.

## Git Worktree Lifecycle

Herdr Studio adds a repository-scoped lifecycle view around Herdr workspaces:

- Create a linked worktree from the latest fetched `origin/main` without
  modifying the source workspace's current branch or dirty files.
- Discover and open existing linked worktrees.
- View all repository checkouts, their paths, open/closed state, branch status,
  and uncommitted-change counts.
- Focus open worktrees, run `git pull`, and enable automatic branch updates per
  checkout.
- Remove linked worktrees with confirmation, hook execution, process cleanup,
  and recovery that preserves residual files when safe removal is not possible.
- Manage the lifecycle from a workspace context menu or from the command menu by
  searching for `worktree lifecycle`.

### Paseo Worktree Hooks

Herdr Studio understands the repository-local
[Paseo worktree hook](https://paseo.sh/docs/worktrees) format in `paseo.json`.
Add commands under `worktree`:

```json
{
  "worktree": {
    "setup": "bun install",
    "opened": "./scripts/worktree-opened.sh",
    "teardown": "./scripts/worktree-teardown.sh",
    "removed": "./scripts/worktree-removed.sh"
  }
}
```

| Paseo hook | When Herdr Studio runs it | Working directory |
| --- | --- | --- |
| `setup` | After a new linked worktree has been created and opened | New worktree |
| `opened` | After an existing linked worktree has been opened | Opened worktree |
| `teardown` | Before a linked worktree is removed | Worktree being removed |
| `removed` | After removal finishes | Source checkout |

For `setup`, `opened`, and `teardown`, Herdr Studio first looks for `paseo.json` in
the target checkout and falls back to the source checkout only when the target
has no `paseo.json`. The first existing file wins. After removal, the target no
longer exists, so `removed` normally uses the source checkout's configuration.

Commands run through `sh -c`. The following variables are available:

| Variable | Value |
| --- | --- |
| `PASEO_HOOK` | `setup`, `opened`, `teardown`, or `removed` |
| `PASEO_CHECKOUT_PATH` | Target worktree path, including the former path for `removed` |
| `PASEO_SOURCE_CHECKOUT_PATH` | Parent/source checkout path when known |
| `HERDR_GUI_HOOK_EVENT` | `worktree.created`, `worktree.opened`, `worktree.before_remove`, or `worktree.removed` |
| `HERDR_GUI_HOOK_CHECKOUT_PATH` | Same target path exposed under a `HERDR_GUI_`-prefixed alias |
| `HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH` | Same source path exposed under a `HERDR_GUI_`-prefixed alias |

Operation notices show the hook outcome and bounded diagnostic output; failures
can include the exit code, stderr, or an error. A failed `teardown` hook stops
removal so the repository can clean up or disable the hook before retrying.
Other hooks are not transactional: a failed `setup` or `opened` hook does not
undo the create/open operation, and a failed `removed` hook cannot restore an
already removed worktree.

Hooks are enabled by default for every repository. They can be disabled per
repository from **Worktree hooks** or **Worktree Lifecycle**; the dialogs also
show which `paseo.json` and commands were detected.

With `--ssh-host`, configuration is read and commands are executed on the remote
host. Hooks are trusted repository code and are not sandboxed; review a
repository's `paseo.json` before creating, opening, or removing its worktrees.

### Automatic Branch Updates

Automatic branch updates periodically fetch `origin/main` and merge it into an
enabled workspace's current branch. The default interval is 10 minutes, and the
current interval and last result are visible in the UI.

For safety, Herdr Studio skips a run when the checkout is dirty or on a detached
HEAD. It verifies that the branch, HEAD, and worktree did not change while the
fetch was running. A conflicting merge is aborted automatically. Updates run
only while the workspace is open in the current Herdr Studio connection.

Use **Menu → Automatic branch updates**, a workspace context menu, or Worktree
Lifecycle to manage saved per-checkout settings.

## File Explorer and Preview

- Browse a cached, expandable workspace file tree and optionally include hidden
  files.
- Search files that have been loaded into the tree.
- See Git status badges on changed files and directories.
- Preview text with line numbers, syntax highlighting, and `Cmd/Ctrl+F` search.
- Render Markdown with a Raw/Rendered toggle, including Mermaid code fences
  rendered as diagrams.
- Render `.mmd`/`.mermaid` Mermaid sources as diagrams with a Raw/Rendered
  toggle.
- Preview common image formats; unsupported binary files remain download-only.
- Drag files onto the workspace root or a directory to upload them.
- Download files directly or directories as workspace-scoped `.tar.gz`
  archives.
- Copy absolute paths and delete files or directories with confirmation.
- Open the file action menu with right-click on desktop or long-press on touch
  devices.

File operations and previews work for both local and SSH-backed workspaces.

## Diff Viewer

- Browse changed files as a directory tree with staged, unstaged, untracked,
  conflicted, and branch-diff badges plus added/deleted line counts.
- Switch between the current working tree and the current branch **Against
  main**.
- View all changed files in repository order.
- Use side-by-side or unified diffs on desktop; mobile uses a unified layout.
- Toggle wrapping independently on desktop and mobile.
- Search the rendered diff with `Cmd/Ctrl+F`, Enter/Shift+Enter navigation, or
  the previous/next controls.
- Syntax-highlight textual diffs and preview changed image files.
- Jump from a diff section to the corresponding File Explorer preview.

The selected scope, view mode, wrapping preference, and recent selection are
preserved in the browser.

## Mobile and PWA

- Responsive workspace, terminal, File Explorer, and Diff Viewer layouts with
  mobile-safe viewport and keyboard handling.
- A floating terminal panel with two rows of configurable key actions.
- A direct `2×8` shortcut editor: empty slots retain their position in the
  editor but are compacted out of the runtime panel.
- Up to four optional terminal side buttons.
- Shortcut actions for control keys, arrows, Enter variants, and full/half-page
  terminal scrolling.
- A Paste shortcut that sends clipboard text to the pane and uploads clipboard
  images, pasting the uploaded path like the desktop paste flow.
- A mobile pane switcher for tabs containing multiple panes.
- A bundled glyph-only Nerd Font fallback for common terminal icons.
- Installable as a standalone PWA from iOS/iPadOS Safari, macOS Safari, Chrome,
  or Edge. PWA mode removes browser chrome but still requires a reachable
  `herdr-gui` server process; it does not provide offline access.
- Reload the current browser or standalone PWA from **Menu → Reload page**.

Mobile shortcut layouts and appearance preferences are stored in the current
browser and do not change Herdr server configuration.

## Remote, Multi-Client, and Operations

- Connect to a remote Herdr with `--ssh-host`; Herdr Studio automatically forwards
  both the control and terminal-render Unix sockets over SSH.
- Apply file operations, image paste, Git operations, and Paseo hooks on the
  same remote host, with remote session inspection subject to the metadata
  resolution limits described above.
- Connect multiple browsers to one bridge and receive pushed Herdr events in
  each client.
- Pause or resume the current browser connection, see the connected-client
  count, or pause the other clients.
- Enable browser task-completion notifications that return directly to the
  relevant pane.
- Choose light/dark themes (or follow the system color scheme) and persistent accent colors.
- Install and manage a systemd or launchd user service from the CLI.
- Check for Herdr Studio releases and perform a checksum-verified, one-click binary
  update when running a standalone binary under a supported supervisor.
- Use `/health` or `/healthz` for service probes.

Loopback access is unauthenticated by default. Non-loopback binds use a generated
login token unless a fixed password is configured. The built-in authentication
does not provide TLS, rate limiting, multi-user authorization, or sandboxing;
see [SECURITY.md](./SECURITY.md) before exposing the service.

## Keyboard Shortcut Reference

The in-app reference is available from **Menu → Keyboard shortcuts**.

### Global

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+K` | Open or close the command menu |
| `Alt/Option+1` … `Alt/Option+9` while the command menu is open | Run the corresponding numbered visible action |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Open and navigate the recent Pane switcher |
| `Cmd+B` | Toggle the desktop sidebar |
| `Cmd+T` | Create a tab in the focused workspace |
| `Cmd+W` | Close the focused tab |
| `Cmd+Option+Left` / `Cmd+Option+Right` | Switch tabs, wrapping at either end |
| `Ctrl+1` … `Ctrl+9` | Switch to a numbered tab in the focused workspace |
| `Ctrl+Shift+W` | Open Workspaces |
| `Cmd/Ctrl+Shift+E` | Toggle File Explorer |
| `Ctrl+Shift+G` | Open Diff Viewer |
| `Esc` | Dismiss the current menu, dialog, notification, or update banner |

A host browser can reserve shortcuts such as `Cmd+T` and `Cmd+W`; they are most
reliable in an installed PWA or another standalone/webview host.

### Terminal

| Shortcut | Action |
| --- | --- |
| `Page Up` / `Page Down` | Scroll terminal history by one page |
| `Alt/Option+Page Up` / `Alt/Option+Page Down` | Scroll terminal history by half a page |
| `Shift+Enter` | Send a multiline Enter sequence |
| `Alt+Enter` | Send an Alt-modified Enter sequence |
| `Cmd+Left` / `Cmd+Up` | Move to the beginning of the current input line |
| `Cmd+Right` / `Cmd+Down` | Move to the end of the current input line |
| `Cmd+Backspace` | Delete to the beginning of the current input line |
| `Cmd+V` on Apple, `Ctrl+V` elsewhere | Paste text or images |
| `Cmd/Ctrl+Click` an HTTP(S) link | Open the link |
| `Cmd/Ctrl+Click` a file path | Preview the workspace file |
| `Cmd/Ctrl+Shift+H` | Toggle Agent message history for the active terminal |

### Preview and Diff

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+F` | Search the visible raw file preview or Diff Viewer |
| `Enter` / `Shift+Enter` in Diff search | Move to the next/previous match |
