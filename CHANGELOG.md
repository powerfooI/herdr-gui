# Changelog

## Unreleased

### Added

- Add Windows support: the bridge maps local Herdr `%APPDATA%\herdr` socket
  names to native named pipes, gains Windows x64 build and release packages,
  and manages an isolated per-user startup task through Windows Task
  Scheduler.

### Performance

- Stop the idle-state render churn that made the UI hitch every second:
  removed a leftover background poll that read 200 lines of scrollback per
  visible pane every 1.5s without any consumer, skip broadcasting store
  updates when a refresh returns unchanged data, slow the metadata fallback
  poll to 5s and suspend it while the page is hidden.
- Subscribe components to just the state slices they read via a new
  `useStoreSelector` hook, so a store update no longer re-renders the whole
  app.

### Fixed

- Make Windows service registration Unicode-safe and let uninstall recover
  when either the Task Scheduler entry or generated helper is already missing.
- Re-attach the terminal when Herdr closes its stream after another herdr-gui
  client takes the terminal over (e.g. a second GUI instance viewing the same
  pane): the bridge now tells viewers when the stream closes and the frontend
  re-attaches with a bounded retry instead of leaving a blank terminal until
  the page was refreshed; sustained takeover wars surface an explicit error.
- Re-arm the metadata and update polls when the connection settles: they were
  stopped by the initial switch from the legacy placeholder connection and
  never restarted, leaving status updates and update checks without their
  fallback poll until the next manual action.

## 0.4.4 - 2026-08-22

### Added

- Allow resizing the Files/Changes navigation list in docked Inspectors too.

### Fixed

- Retry workspace, agent, and tab switches once the bridge connection is back
  when they are fired while the client is still reconnecting, so clicks right
  after returning to the app are no longer silently dropped.
- Re-attach the terminal whenever the xterm instance is recreated, fixing
  terminals that stayed blank after switching between desktop and mobile
  layouts or resuming the mobile app from the lock screen until the app was
  refreshed.
- Keep file and session downloads inside the app on iOS/PWA instead of
  navigating into the system document handler with no way back.
- Stop terminal selections from growing on mouse moves after a lost mouseup.
- Fix terminal attach against Herdr 0.8.2 (protocol 20), which renumbered the
  `TerminalAttach` launch-mode wire value.

## 0.4.3 - 2026-08-22

### Added

- Add a checkout-scoped Workspace Inspector for Files, Changes, and Agent
  History, with right/bottom docks, expanded and responsive modes, resizable
  navigation, shared checkout identity, and a `Cmd+Shift+B` toggle.

### Changed

- Keep the Workspace tree and terminal mounted while using or retargeting the
  Inspector, restoring each checkout's isolated view and layout preferences.
- Nest Agent sessions under their Workspace by default, with shared tab/tree
  status icons, quieter status labels, context menus, and an optional persisted
  separate Agents panel.
- Streamline desktop and mobile navigation, pane controls, embedded resource
  headers, responsive Diff controls, and the mobile Workspaces shortcut.
- Improve keyboard and focus behavior for Workspace/Agent trees, dialogs,
  resizers, mobile controls, and Inspector open/close flows.

### Fixed

- Isolate Files/Changes caches and asynchronous requests by connection and
  checkout, automatically load Diff content, and retire stale results after
  refresh, cleanup, or worktree lifecycle changes.
- Preserve completed Agent History when live status is unknown and prevent stale
  Agent or lifecycle state from leaking across pane and dialog contexts.

## 0.4.2 - 2026-08-20

### Added

- Paste text or images into the terminal on mobile from a configurable Paste
  shortcut button, using the same upload-and-paste-path flow as desktop paste.
- Render Mermaid diagrams in the file previewer: `.mmd`/`.mermaid` files get a
  Raw/Rendered toggle, and Mermaid code fences inside Markdown previews render
  inline as theme-aware SVG diagrams.
- Appearance: new "System" theme option that follows the OS color scheme
  (`prefers-color-scheme`) and switches live when the OS theme changes; the
  persisted preference is applied before first paint to avoid a theme flash.
- Releases no longer require a manual version-bump PR: the new **Cut Release**
  workflow (or `bun run release:cut <version>` locally) bumps versions,
  finalizes the changelog, lands the release commit on `main` through an
  automated self-merging PR, tags it, and starts the release pipeline in one
  step. GitHub release notes now come from the version's `CHANGELOG.md`
  section instead of auto-generated PR lists.

### Changed

- Creating the first connection profile no longer drops the default local
  server from the list: it is persisted as a writable `Local` profile with the
  same socket paths and auto-connect enabled, so the localhost Herdr remains
  available alongside newly added profiles.
- SSH connection profiles no longer require remote socket paths: leave them
  empty and the bridge infers the default Herdr sockets under the remote home
  directory (`~/.config/herdr/herdr.sock` and
  `~/.config/herdr/herdr-client.sock`) at connect time.

### Fixed

- Use the theme-aware code surface for Markdown fenced code blocks in the file
  previewer: light mode no longer renders them as a low-contrast dark box
  (they previously always used the dark terminal background).
- Replace the browser-native `window.confirm` when removing a connection with
  the in-app confirmation dialog (Escape/Enter/focus handling included).
- Keep popovers, dialogs, and menus open while terminal output streams in:
  frame-driven terminal refocusing no longer steals focus from overlay UI,
  which previously collapsed the connection menu (and other popovers) the
  moment a working agent produced output.

## 0.4.1 - 2026-08-20

### Fixed

- Remove the WebSocket browser-origin check from 0.4.0: it rejected legitimate
  browsers behind reverse proxies that rewrite the `Host` header, leaving the
  UI stuck at "Browser disconnected from bridge". Access control is once again
  the deployment's responsibility (authentication, HTTPS at the proxy, VPN, or
  firewall), as documented in SECURITY.md.

## 0.4.0 - 2026-08-20

### Added

- Manage multiple local and SSH-backed Herdr servers from one bridge, with a
  per-browser active connection, isolated runtime state, persisted profiles,
  connection testing, automatic SSH supervision, and a connection manager UI.
- Reload the current browser page or standalone PWA from the application menu.

### Changed

- Refine dialogs and notifications with consistent icon controls, clearer action
  hierarchy, and English date and relative-time presentation.

### Fixed

- Push `pane.agent_status_changed` events from each connection so agent
  working/idle/done transitions reach the browser immediately instead of
  waiting for the next metadata poll, which could leave agents looking idle
  while they work.
- Refresh workspace metadata as soon as a hidden or unfocused page becomes
  visible, focused, or back online, so browser timer throttling no longer
  leaves statuses stale.
- Recover Apple IME commits when WebKit emits input before or without keydown
  or reports a different keyup code, without replaying text already sent from
  keypress.
- Keep connection-scoped RPC, HTTP, terminal, clipboard, file, Git, worktree,
  agent, and settings activity bound to the selected server generation so stale
  work cannot cross into a replacement connection.
- Send full-page Page Up and Page Down as page-key input instead of wheel input,
  restoring page-sized scrolling in fullscreen Pi while preserving Alt/Option
  half-page scrolling.

## 0.3.5 - 2026-08-18

### Added

- View full agent messages as sanitized rendered Markdown or raw text.
- Collapse individual file sections in the Diff Viewer.

### Changed

- Present Session Inspector activity chronologically as collapsible steps with
  concise previews.
- Run numbered command-menu actions with `Alt+1` through `Alt+9` to avoid
  browser-reserved Command-number shortcuts.
- Improve mobile and no-wrap Diff Viewer layouts, keeping file headers and
  navigation controls visible while code scrolls.

### Fixed

- Keep browser WebSocket connections open when Bun queues outbound data under
  backpressure, while retaining the 8 MiB slow-client protection and accurate
  disconnect cleanup.
- Restore text selection after releasing a pane divider outside the window.

## 0.3.4 - 2026-08-17

### Added

- Run the first nine visible command-menu actions with `Cmd+1` through `Cmd+9`,
  with matching shortcut hints beside each action.

### Fixed

- Recover iOS terminal input committed by third-party IMEs during keyup or input
  events when xterm does not forward the helper-textarea mutation.
- Route complete native iOS paste mutations through the terminal paste API when
  the ClipboardEvent text is missing or truncated.

## 0.3.3 - 2026-08-13

### Added

- Customize the mobile terminal shortcut panel through a direct 2-by-8 slot editor:
  select any compact, bordered grid position to add or edit its label and key
  action with a searchable, theme-aware picker. Empty positions are preserved
  in the editor but compacted out of the runtime shortcut panel, and Page Up and
  Page Down are included by default instead of separate fixed scroll buttons.
  Up to four optional right-side buttons can also be configured for the original
  Up/Down position.
- Pin individual workspaces or linked worktrees to the top of the Workspace
  tree with browser persistence. Pinned linked worktrees are lifted out of their
  repository group into the top-level pinned section.
- Collapse and expand linked worktrees beneath their repository workspace, with
  the collapsed groups saved in the current browser.
- Mark linked-worktree workspace items with a compact branch icon, expanded to
  a `WT` badge when pinned or otherwise top-level, and hide a redundant branch
  badge when its branch matches the workspace name.

### Changed

- Route configurable Page Up/Down actions through terminal scrollback (one page,
  or half a page with Alt) instead of sending escape sequences that shells can
  interpret as input-history navigation.
- Hide the application overlay scrollbar inside dialogs, popovers, menus, and
  the mobile shortcut panel while retaining touch, wheel, and trackpad scrolling.

## 0.3.2 - 2026-08-10

### Changed

- Restore compatibility with reverse proxies that rewrite the upstream Host
  header by relying on configured authentication instead of comparing Host and
  Origin authorities.

## 0.3.1 - 2026-08-10

### Changed

- Check for releases through small, bounded platform manifests instead of
  repeatedly downloading full application archives, while retaining a legacy
  fallback for older releases and mirrors.

### Fixed

- Harden automatic updates by binding version, platform, archive name, and
  checksum metadata before narrowly extracting, backing up, and atomically
  replacing the executable. Browser update checks and installs now require an explicit
  same-origin request header, and custom update URLs cannot expose embedded
  credentials or use unauthenticated remote transports.
- Block cross-origin WebSocket control and DNS-rebinding access to the
  privileged API by validating browser origins and accepting only loopback
  request hosts when herdr-gui runs without authentication.
- Stop terminals from repainting through stale intermediate widths on tab
  switches, especially over slow remote connections. Resize updates are now
  deduplicated and debounced, hidden views cannot collapse a terminal to 2x1,
  and the adaptive attach watchdog handles frames arriving before or after the
  attach response without starting a false retry loop.
- Keep the clipboard relay stable across tab switches, project its viewport
  from the complete active pane layout, and pre-size a previously visited
  target tab before focusing it. Late attach responses can no longer restore
  stale relay dimensions, including when switching between single and split
  pane tabs.

## 0.3.0 - 2026-08-07

### Added

- Publish the initial public release with browser terminals, workspace and worktree management, File Explorer, Diff Viewer, and Agent Session Inspect.
- Ship checksum-verified standalone packages for Linux and macOS on x86-64 and arm64.

## 0.2.31 - 2026-08-07

### Fixed

- Preserve rapid Chinese IME punctuation input without dropped, duplicated, or reordered characters.

## 0.2.30 - 2026-08-07

### Changed

- Dismiss ordinary in-app notifications after 15 seconds while keeping active operations visible.

### Fixed

- Open existing worktrees from their repository source even when another checkout is focused.

## 0.2.29 - 2026-08-06

### Changed

- Show the running herdr-gui version beside the app title.

### Fixed

- Relay remote OSC 52 clipboard requests to the browser that initiated them, including Pi file-tree copy actions.

## 0.2.28 - 2026-08-06

### Added

- Add half-page Terminal history scrolling with `Alt/Option+Page Up/Down`.

### Fixed

- Copy OSC 52 selections from remote Agent and TUI sessions through the browser clipboard.

## 0.2.27 - 2026-08-06

### Fixed

- Open the corresponding Agent pane when a task-completion notification is clicked.
- Refresh stale notification targets and fall back to the Workspace when the Agent pane has already closed.

## 0.2.26 - 2026-08-04

### Added

- Add a repository-scoped Worktree Lifecycle center for checkout status, hooks, pull, sync, open, create, and removal actions.

### Changed

- Align Agent status badges and present repository hook scripts as readable code blocks.

### Fixed

- Keep lifecycle actions scoped to the selected repository when several Git repositories are open.
- Let Herdr close a worktree workspace before residual process cleanup to avoid stale working-tree removal failures.

## 0.2.25 - 2026-08-03

### Changed

- Align Agent status badges in the recent Pane switcher with Workspace status styles.

### Fixed

- Recover stale worktree removals while preserving residual files and stopping checkout processes.
- Keep long hook and removal operations connected, then verify cleanup before reporting success.

## 0.2.24 - 2026-07-28

### Fixed

- Emit unquoted, safely escaped systemd `EnvironmentFile` paths.

## 0.2.23 - 2026-07-28

### Added

- Show assistant replies in Session Inspect with an optional user-only filter.

### Changed

- Rework Session Inspect around clearer conversation, details, preview, and export views.
- Extend accent colors across top-bar controls, File Explorer, and Diff Viewer.

### Fixed

- Recover assistant messages from older Codex sessions without duplicating newer records.

## 0.2.22 - 2026-07-28

### Added

- Add persistent accent colors, including the original neutral appearance.

### Changed

- Move the Workspaces, Files, and Diff Viewer controls into the top bar.
- Reorganize Menu into concise preferences, updates, and runtime sections.

### Fixed

- Reject invalid persisted sidebar widths and stabilize Vite development login routing.
- Improve Menu keyboard navigation, Escape handling, and focus restoration.

## 0.2.21 - 2026-07-27

### Added

- Add `herdr-gui service reload` for systemd and launchd services.

### Changed

- Preserve managed systemd wrapper commands during reinstall and emit portable
  unquoted `ExecStart` paths.

## 0.2.20 - 2026-07-27

### Added

- Install and manage systemd or launchd user services from the CLI.
- Generate persistent login tokens and tokenized URLs for non-localhost access.

### Changed

- Let the external service supervisor restart the process after automatic updates.

## 0.2.19 - 2026-07-27

### Fixed

- Keep the final Terminal columns visible with Apple system monospace fonts.
- Name tabs created with `Cmd+T` consistently as `Tab N`.

## 0.2.18 - 2026-07-27

### Added

- Add macOS shortcuts to create, close, and switch tabs.
- Show workspace-first recent Pane switching with Agent icons and status.

### Changed

- Add portable release configuration, CI, licensing metadata, and service examples.
- Add systemd and launchd service examples with automatic supervisor detection and restarts.

### Fixed

- Scroll Terminal history with the mouse wheel and Page Up/Down without sending arrow input.
- Keep Terminal selection scrollable and tab confirmation dialogs visible across views.

### Security

- Verify release archive checksums before installing or automatically updating.

## 0.2.17 - 2026-07-24

### Added

- Add an architecture-aware installer for Linux x86-64 and macOS Apple Silicon.

### Fixed

- Select the correct release archive and preserve process arguments when automatically updating on Linux or macOS.

## 0.2.16 - 2026-07-24

### Fixed

- Send `Alt+Enter` and `Shift+Enter` as distinct terminal sequences.
- Preserve IME composition and additional modifiers in Terminal shortcuts.

## 0.2.15 - 2026-07-24

### Changed

- Support Herdr protocol 17 and future compatible protocol versions.

### Fixed

- Recover stalled browser bridge connections and refresh reused terminals for additional clients.
- Avoid redundant embedded asset rewrites that caused development reload churn.

## 0.2.14 - 2026-07-24

### Added

- Add Pi agent icons, message history, session summaries, and ATIF export.

### Fixed

- Read agent session files from the remote host when herdr-gui connects over SSH.

## 0.2.13 - 2026-07-22

### Changed

- Remove Herdr Server update checks and prompts while retaining connected version and protocol diagnostics.

## 0.2.12 - 2026-07-20

### Fixed

- Restore Terminal rendering with Herdr 0.7.4 by avoiding repeated attach transitions.
- Preserve indentation when pasting multiline text into terminal editors.

## 0.2.11 - 2026-07-20

### Added

- Add Grok Build session discovery, message history, Timeline, and ATIF export.
- Show passive Herdr Server update status and update guidance in Menu.

### Fixed

- Negotiate and validate Herdr thin-client protocols 14 through 16 instead of assuming protocol 14.

## 0.2.10 - 2026-07-15

### Added

- Add overlay scrollbars that preserve content width and full-message viewing in Session Inspect.

### Changed

- Create new worktrees from the latest `origin/main` revision.

### Fixed

- Create and group worktrees under the workspace that initiated them, including repositories opened in multiple workspaces.
- Reload the frontend after self-update and harden static asset and SPA fallback handling.

## 0.2.9 - 2026-07-15

### Added

- Preview existing workspace-relative Terminal file paths with `Cmd/Ctrl+Click`, including SSH workspaces.

### Fixed

- Restore Kimi assistant, reasoning, tool, and token details in session timelines without duplicate messages.
- Stop Terminal HTTP links before trailing parenthesized prose.

## 0.2.8 - 2026-07-13

### Added

- Add opt-in automatic `origin/main` updates for open workspaces, with per-repository controls.

### Changed

- Present task notifications as a switch in Menu.

### Fixed

- Prevent automatic updates for dirty, detached, changed, or conflicting Git checkouts.
- Stop Terminal links before Unicode punctuation and invisible characters.

## 0.2.7 - 2026-07-10

### Added

- Add a `Ctrl+Tab` recent pane switcher with current-pane marking.

### Changed

- Use the HTTPS release host for install and self-update downloads.

### Fixed

- Allow terminal scrolling while selecting text.
- Improve Kimi agent icon contrast in light theme.

## 0.2.6 - 2026-07-07

### Added

- Add Session Inspect summaries with raw session preview and export.
- Add Timeline and ATIF views for agent sessions, including ATIF export.

### Fixed

- Keep session preview search focused correctly after `Cmd/Ctrl+F`.
- Classify Codex tool output as observations in the session timeline.

## 0.2.5 - 2026-07-06

### Added

- Add an agent message history drawer for Codex, Claude, and Kimi sessions.
- Show the Herdr integration install command when session history is unavailable.

### Changed

- Remove manual send-message actions from Command K and agent menus.

## 0.2.4 - 2026-07-06

### Fixed

- Do not show task completion notifications for the currently active pane.

## 0.2.3 - 2026-07-06

### Fixed

- Stabilize terminal font fallback so Chrome and Safari render closer together.

## 0.2.2 - 2026-07-05

### Fixed

- Fix self-update restarts when herdr-gui runs under a parent process wrapper.
- Show restart mode and diagnostic log path while applying updates.

## 0.2.1 - 2026-07-05

### Added

- Add unauthenticated `/health` and `/healthz` endpoints for probes.

## 0.2.0 - 2026-07-05

### Added

- Add browser task completion notifications with an Open workspace action.
- Add one-click update and restart for Linux x64 standalone releases.

### Fixed

- Keep password login valid across herdr-gui self-restarts.

## 0.1.10 - 2026-07-05

### Added

- Add File Explorer drag-and-drop uploads plus confirmed file and directory deletion.
- Show Git status badges in File Explorer for changed files and directories.

### Changed

- Move File Explorer delete actions into the right-click and long-press menu.

## 0.1.9 - 2026-07-04

### Added

- Show all Diff Viewer files in order with image previews for binary image diffs.
- Add File Explorer downloads for files and directories.

### Fixed

- Keep directory downloads scoped to the workspace and package them as `tar.gz`.

## 0.1.8 - 2026-07-03

### Fixed

- Keep Command K selection anchored to the top result while search results change.

## 0.1.7 - 2026-07-02

### Added

- Show per-file added and deleted line counts in Diff Viewer.

## 0.1.6 - 2026-07-02

### Added

- Add search controls to Diff Viewer with match navigation and shortcuts.
- Add desktop Diff Viewer wrap toggle.

### Fixed

- Keep split diff panes at equal width when wrapping is disabled.
- Keep hidden File Preview from intercepting Diff Viewer search shortcuts.

## 0.1.5 - 2026-06-30

### Added

- Add workspace menu Git pull action.
- Add Diff Viewer mode for comparing the current branch against main.
- Add mobile Ctrl+R shortcut button.

### Changed

- Improve toast presentation for command and hook output.
- Hide the mobile tab line when there is only one tab.

## 0.1.4 - 2026-06-29

### Added

- Render Markdown files in File Explorer with a Raw toggle.
- Open file paths directly from the command menu.

### Changed

- Preserve Terminal, File Preview, and Diff Viewer state when switching views.
- Keep File Explorer focused on the active preview file and expand parent folders.

### Fixed

- Restore the active File Preview after page refresh.

## 0.1.3 - 2026-06-27

### Added

- Styled app-wide tooltips for existing title hints.

### Changed

- Narrow command-menu close/remove actions to the current workspace, worktree, pane, or agent context.
- Remove agent Ctrl+C/Ctrl+D shortcuts from command and context menus.
- Remove File Explorer and Diff Viewer shortcuts from workspace context menus.

### Fixed

- Avoid detecting `/path` fragments inside relative terminal paths as previewable files.

## 0.1.2 - 2026-06-27

### Added

- Cmd/Ctrl-click terminal file paths to preview files in a dialog.
- Image previews for common image files, including absolute paths such as `/tmp/...`.

### Fixed

- Keep Agent and Workspace terminal switching in sync after focusing agent panes.

## 0.1.1 - 2026-06-26

### Added

- Text file preview in File Explorer with line numbers, search, and syntax highlighting.
- `file.read` bridge API for local and SSH-backed workspaces.

### Changed

- File Explorer folders expand on single click.
- Lazy-load terminal and file preview editor chunks to reduce the main bundle.

### Fixed

- Preserve text previews when UTF-8 files are truncated at the preview limit.
- Keep Workspaces shortcut behavior consistent from file preview.

## 0.1.0 - 2026-06-26

### Added

- File Explorer side panel with cached directory loading.
- Diff Viewer with changed-file tree, split/unified views, syntax highlighting, and mobile diff browsing.
- Shortcut Lookup dialog from the Menu.

### Changed

- Improve mobile terminal controls with a compact floating shortcut panel.
- Diff Viewer opens with `Ctrl+Shift+G` on desktop.

## 0.0.12 - 2026-06-25

### Added

- Show connected client count and allow pausing other herdr-gui clients.
- Show a reconnect shortcut in the top bar when this client is paused or disconnected.

### Changed

- Move connection pause controls into the Menu connection section.

## 0.0.11 - 2026-06-25

### Added

- Pause/resume connection control to stop this browser from syncing with Herdr.

### Changed

- Worktree lucky branch names no longer include a `feature/` prefix.
- Connection resumed toast now dismisses after 5 seconds.

### Fixed

- Text paste now uses terminal paste handling for multiline content.
- Shift+Enter is sent as a modified Enter sequence for multiline agent input.

## 0.0.10 - 2026-06-25

### Added

- External provider icons for agent rows.
- `Ctrl+1` through `Ctrl+9` shortcuts for switching tabs.

### Changed

- Improve agent icon and status-dot alignment.
- Improve command menu search ranking with top results and keywords.

## 0.0.9 - 2026-06-25

### Added

- Lucky default names for new workspaces and worktree branches.
- Command menu actions for focusing panes by direction.

### Changed

- Dialogs with inputs now focus the primary field more reliably.
- Terminal links now require Cmd/Ctrl-click to open.

### Fixed

- Confirm dialogs now keep keyboard focus and support Enter to confirm.
- Removed the unused Read pane output action and dialog.

## 0.0.8 - 2026-06-24

### Added

- Pane management with split, resize, zoom, focus, and close actions.
- Mobile pane switcher for multi-pane terminal sessions.

### Changed

- Reorganized the command menu into clearer action groups.
- Improve mobile safe-area, keyboard, and terminal viewport handling.

### Fixed

- Reduce terminal right-side blank space and remove the xterm overview-ruler line.
- Improve multi-pane terminal attachment stability for one browser client.

## 0.0.7 - 2026-06-24

### Added

- Repo-level Worktree Hooks dialog that reads current repo `paseo.json` worktree hooks.
- herdr-gui settings storage for per-repo hook enablement.
- Paseo `setup`, `opened`, `teardown`, and `removed` worktree hook support.

### Changed

- Move worktree hook controls from global Menu to the workspace context menu.
- Auto-dismiss regular toast notifications after 3 minutes.

### Fixed

- Improve multi-client terminal stability and weak-network websocket handling.
- Avoid stale plugin-based worktree hook behavior by using only repo `paseo.json`.

## 0.0.6 - 2026-06-24

### Added

- Automatic update checks with one-click standalone binary update.
- Agent and tab context menus, plus remove worktree from the command menu.
- Worktree git status badges in the sidebar.

### Fixed

- Avoid mobile keyboard popups while viewing, switching, or using terminal shortcut buttons.
- Improve mobile and Safari terminal scrolling, selection, paste, and loading behavior.
- Make update installs safer with same-directory binary replacement.

## 0.0.5 - 2026-06-23

### Added

- `herdr-gui --version` and `herdr-gui -V`.

### Fixed

- Split worktree hooks into before-remove and removed phases, with visible hook results and safer terminal recovery after removal.
- Expand the command menu with New worktree and tab management actions, plus confirmations for closing tabs and panes.
- Improve terminal focus, Chinese question-mark input, copy cleanup, and Safari/mobile selection-anchor handling.
- Keep important operation failures in dismissible toast notifications instead of transient top-level error bars.
- Restore terminal Chinese IME behavior by avoiding xterm helper textarea selection overrides.
- Ensure release binaries embed freshly built frontend assets.

## 0.0.4 - 2026-06-23

### Added

- Clickable blue HTTP/HTTPS links in terminal output.
- Changelog modal from the Menu.
- Light theme with Menu toggle.
- `Cmd+B` sidebar toggle.
- Terminal maximize toggle.
- Terminal Unicode grapheme handling and monospaced CJK font fallback for Chinese text selection.
- Hide sidebar and terminal maximize controls on mobile.
- Safari terminal click handling to avoid sticky text selection anchors.
- Faster workspace and agent status refresh in the sidebar.
- Terminal loading overlay while switching panes or workspaces.
- Physical Page Up and Page Down key handling in terminal.
- Open existing Herdr worktrees from the workspace menu and Actions panel.
- macOS Command key shortcuts in terminal for line start, line end, and delete to line start.
- Chinese question mark input fallback in terminal.
- Faster terminal switching with reused terminal attach sessions.
- Loading indicator for the target workspace while focus changes.

## 0.0.3 - 2026-06-23

### Added

- Actions command combobox for workspace, tab, pane, agent, and hook actions.

### Changed

- Removed the top-bar updated timestamp.

## 0.0.2 - 2026-06-23

### Added

- Version display in Menu.
- Release packaging script for versioned and latest `tar.xz` archives.

### Fixed

- Browser-side image and `Ctrl+V` paste handling in terminal.

## 0.0.1 - 2026-06-23

### Added

- Initial web UI, Bun bridge, terminal, worktree, hooks, uploads, and standalone binary.
