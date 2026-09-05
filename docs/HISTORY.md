# History synchronization

`createAgentSessionHandlers` owns a per-connection projection cache shared by
History, summary, transcript preview, and ATIF export. It retains at most 16
sessions and an estimated 32 MiB of serialized UTF-16 payload, including four
recent History revisions per session. Oversized projections are served but not
retained. Concurrent requests share in-flight reads and projection; raw preview
prefix reads and raw downloads remain separate.

Each refresh resolves the session and stats its file. Path, provider, session,
size, modification time, file identity, change metadata, and provider descriptor
metadata invalidate cached projections. Reads are followed by another stat and
retried up to three times if the file changed. Errors invalidate retained data;
incomplete JSONL records are skipped until a later change. This is metadata-based
consistency, not a filesystem transaction: changes after the final stat appear
on the next refresh, and filesystems with coarse metadata can miss same-size
in-place rewrites within their timestamp resolution.

## Version 2 protocol

Send `history_version: 2` to `agent_history.get`, with an optional
`cursor: { epoch, revision }` from the last accepted response. Legacy callers
still receive their conversation-only `messages` response.

- `mode: "snapshot"` supplies `entries` and replaces the client window. Missing
  files/sessions produce an empty snapshot. Invalid or expired cursors, connection
  replacement, eviction, file replacement, and truncation reset via snapshots.
- `mode: "delta"` supplies `base_revision`, `upserts`, `removed`, and, only when
  membership/order changes, the complete ordered ID list `order`. It does not
  also include `messages`, `entries`, or a trajectory. A no-change delta has empty
  changes and the same revision.
- The window holds the most recent 200 conversation/tool/error entries. Window
  eviction is represented by removals; ATIF and raw exports remain complete.

IDs identify projected content occurrences (or tool call IDs), **not durable
source records or ATIF step numbers**. Diffs compare full projected windows, so
provider changes such as Codex switching from event messages to response items
can remove/update earlier entries safely. Synthetic fallback timestamps remain
stable for a cached file generation. The client accepts responses only against
the cursor used by that request and the current pane/connection lease.

History refreshes every four seconds only while open and the document is
visible, with no overlapping active refresh. Long card content is capped at
4,000 characters in the default DOM; full tool details open as escaped plain
text on demand. Tool names and source call IDs associate results without moving
them away from their transcript position.

## Message type filters

The User, Agent, and Tool toggle buttons independently filter the current
200-entry window. All types start enabled. Agent includes assistant errors;
Tool includes calls, outputs, and tool errors. Button counts describe the
unfiltered window; the History badge shows visible/total when filtered.
The minimap and card numbering follow the visible list. Hidden entries still
receive incremental updates, and exports are unaffected. Selections survive
pane switches and close/reopen while the drawer stays mounted; they are not
saved across page reloads. If no entries match, Show all types restores the view.

![History filtered to tool calls and outputs using synthetic test data](screenshots/history-tool-filter.png)

## Remaining work

Changed files still require a **full JSONL read and full provider projection**.
There is no provider-specific incremental parser, byte-offset cursor, database,
or new transport. Raw transcript preview and explicit full ATIF export can
still transmit large payloads. Cache payload estimates bound retained serialized
content, not transient parsing allocations or exact JavaScript heap usage.
