# Multi-Herdr Connections

Status: **M1-M6 complete; M7 follow-up planned**
Last updated: 2026-08-19
Pull request: [#18 Add multi-server connection management](https://github.com/powerfooI/herdr-gui/pull/18)

## Objective

Allow one herdr-gui bridge to manage multiple existing Herdr servers over local
Unix sockets or SSH-forwarded Unix sockets. Profiles are shared by authenticated
browsers, but each browser independently selects one active connection.

The primary invariant is isolation: resource IDs, terminal traffic, clipboard
messages, files, settings, events, and delayed async results must never cross
connection or runtime-generation boundaries.

## Product scope

- herdr-gui remains a trusted single-user administration tool.
- Local profiles attach to existing sockets; herdr-gui does not start local
  Herdr processes.
- SSH profiles use the service user's OpenSSH config, ssh-agent, and system
  Keychain. herdr-gui stores no SSH passwords, keys, passphrases, ports,
  commands, or arbitrary options.
- Each browser displays one connection at a time. A merged cross-server tree is
  out of scope.
- Server runtimes are independent of browser selection. `auto_connect` controls
  startup behavior; terminal render streams open only while viewed.
- Removing or disconnecting a profile stops only the bridge runtime and tunnel;
  it does not stop the Herdr server or its workspaces.

## Architecture

```text
Authenticated browser
  |-- same-origin WebSocket (/ws)
  `-- connection-scoped HTTP APIs
                 |
                 v
          ConnectionManager
          |-- ProfileStore
          |-- local ConnectionRuntime
          |-- local ConnectionRuntime
          `-- SSH ConnectionRuntime -> supervised OpenSSH tunnel
```

Bridge-global responsibilities:

- authentication, static assets, health, and updates;
- browser WebSocket transport and client accounting;
- profile CRUD and connection catalog/status publication.

Each `ConnectionRuntime` owns its own:

- immutable connection identity and manager generation;
- control/render socket paths and `HerdrClient`;
- terminal bridge, thin clients, viewer maps, and clipboard relay;
- event subscription and reconnect lifecycle;
- file, Git, worktree, hooks, agent-session, settings, and auto-sync services;
- local transport or supervised SSH tunnel;
- cleanup and status publication.

No runtime-owned map, cache, callback, or downstream service is shared between
connections.

## Connection profiles

The registry is stored at `~/.config/herdr-gui/connections.json` by default.
Its directory is mode `0700`; the file is mode `0600`. Writes are serialized,
bounded, validated, fsynced where supported, and atomically renamed. Registry
and direct-parent symlinks are rejected.

Registry v2 stores a strict local/SSH union:

```ts
type LocalProfile = {
  id: string;
  label: string;
  type: "local";
  control_socket_path: string;
  client_socket_path: string;
  auto_connect: boolean;
};

type SshProfile = {
  id: string;
  label: string;
  type: "ssh";
  ssh_destination: string;
  remote_control_socket_path: string;
  remote_client_socket_path: string;
  auto_connect: boolean;
};
```

Version-1 local registries remain readable and migrate to v2 on the first
successful mutation. Invalid registries are preserved and start in degraded,
mutation-disabled mode so the operator can repair the durable file.

If durable rollback fails after a mutation, routing is retired and further
profile mutations are disabled rather than pretending memory and disk agree.

## Routing and generation contract

Bridge-global methods (`bridge.*`, `connections.*`) are unscoped and reject
misleading connection identity fields. Every downstream operation is bound to:

1. a validated `connection_id`;
2. the manager-owned `connection_generation` for that runtime;
3. a request-local ready-runtime lease.

Example RPC:

```json
{
  "id": "c123",
  "connection_id": "remote-dev",
  "connection_generation": 7,
  "method": "pane.list",
  "params": {}
}
```

Replies, errors, Herdr events, terminal frames, and clipboard pushes carry the
same identity and generation. Explicit malformed, unknown, stale, or not-ready
identities fail without fallback.

Connection-scoped HTTP endpoints use paths such as:

```text
/api/connections/:connectionId/upload-image
/api/connections/:connectionId/file/download
/api/connections/:connectionId/agent-session/download
```

HTTP requests include the runtime generation and receive connection identity
headers. Streaming responses recheck their lease for every chunk and cancel the
source after replacement.

A dispatched side effect may finish on the runtime to which it was originally
routed, but stale replies, push messages, stream chunks, or metadata commits
must not be published after that lease retires.

Omitted identity/generation remains a bounded, logged compatibility path for old
single-connection clients. It never applies to an explicit malformed or stale
value.

## Runtime lifecycle

Public states are:

```text
disconnected -> connecting -> ready
                    |          |
                    |          `-> reconnecting
                    `------------> error
ready/reconnecting/error -> stopping -> disconnected
```

Lifecycle invariants:

- construction is side-effect free;
- concurrent starts and stops share one installed task;
- start, stop, replacement, and post-ready transport exit invalidate stale
  leases before publishing new status;
- status callbacks may synchronously re-enter the manager without escaping
  serialization;
- only `ready` runtimes are routable;
- one failing runtime never prevents the HTTP management surface or healthy
  peers from operating;
- shutdown drains every runtime once and has a bounded forced-exit path;
- disposal closes subscriptions, terminal resources, clipboard relays, SSH
  children, timers, and auto-sync work.

## SSH transport

- Destination input is a bounded OpenSSH alias or `user@host` only.
- Generated argv uses fixed options and places the validated destination after
  `--`.
- Normal host-key verification remains enabled. Service mode uses noninteractive
  authentication.
- One OpenSSH process per SSH runtime forwards both remote sockets into a random
  short mode-`0700` directory under `/tmp`.
- Startup requires both a control `ping` and render-protocol Welcome handshake.
- Child stderr is continuously drained with only the final bounded 16 KiB kept
  for classification; raw banners and control sequences are not exposed.
- Authentication, host-key, and permanent protocol failures do not retry.
  Transient failures use cancellable equal-jitter exponential backoff, capped at
  30 seconds and six attempts, with reset after 30 seconds stable-ready.
- Post-ready exit invalidates the runtime generation before cleanup/retry.
- Cleanup removes owned paths only after confirmed child exit, with bounded
  graceful termination and signal-9 fallback. Unconfirmed exit preserves the
  paths and reports failure.
- Legacy CLI/environment SSH receives the same validation and functional
  probes, but intentionally does not persist or auto-retry.

## Browser and UI isolation

The frontend separates bridge-global state from per-connection server sessions.
Each server session records both the browser routing generation and server
runtime generation.

Connection identity scopes:

- React mount keys and terminal identities;
- workspace/tab/pane/layout/content state;
- terminal relay viewport and file-link caches;
- file explorer, diff, preview, and agent-session caches;
- workspace pins, collapse state, and resource localStorage keys;
- task notification tags and activation targets;
- every async request sequence and dialog completion.

Switching connection invalidates the old browser lease, disposes terminal and
dialog state, restores only generation-compatible cached state, and refreshes
the target runtime. Same-ID server replacement clears both active and inactive
cached sessions before any colliding resource ID can be reused.

The top-bar connection selector supports add/edit/test/default/connect/reconnect/
disconnect/remove operations. Its menu and management dialog are portaled,
keyboard navigable, focus-managed, and protected against stale async feedback.
There is currently no global next/previous-connection shortcut.

## WebSocket and downstream protocol hardening

- Browser WebSockets must present a same-authority Origin; missing Origin remains
  compatible with non-browser clients. Reverse proxies must preserve the public
  browser-facing `Host` on upgrade.
- A browser bridge becomes connected only after one valid, exclusive, unscoped
  hello. Non-hello frames before it are dropped; malformed or silent hello
  reconnects.
- Wire messages have exactly one kind. Replies carry exactly one of
  `result`/`error`; bridge-reserved fields cannot be injected through Herdr
  events.
- One-shot and subscription NDJSON lines are bounded. Reply/ack IDs must match,
  and subscription acknowledgement has a timeout.
- Terminal/event/clipboard DTOs are validated completely; malformed base64
  terminal frames are dropped without publication.

## Compatibility

- Explicit CLI/environment socket or SSH settings synthesize a read-only
  `legacy-default` process profile and remain authoritative for that process.
- With no registry, current default local sockets are exposed through a
  synthetic legacy profile until the first successful profile mutation.
- Existing unscoped browser storage is copied once into the first real profile
  without overwriting an existing target value.
- Legacy HTTP aliases and omitted RPC identity remain temporarily supported.
- `/api/health` describes the bridge; Herdr identity and readiness are
  connection-scoped.

## Milestones

| Milestone | Status | Result |
| --- | --- | --- |
| M0 Architecture | Complete | Scope, trust model, invariants, and validation contract defined. |
| M1 Runtime extraction | Complete | One complete downstream service graph per runtime. |
| M2 Manager/lifecycle | Complete | Generation-safe start, stop, replacement, and shutdown. |
| M3 Routing | Complete | Connection-scoped RPC, HTTP, replies, pushes, terminal, and clipboard. |
| M4 Frontend isolation | Complete | Per-connection state, persistence, caches, and stale-result guards. |
| M5 Local profiles/UI | Complete | Private persistence, CRUD, testing, selector, and management dialog. |
| M6 SSH profiles | Complete | Strict profile schema, supervised tunnels, probes, cleanup, and retry. |
| M7 Operational hardening | Planned | Aggregate resource limits, idle/background policy, and broader diagnostics. |

## Validation

Required checks:

```bash
bun run format:check
bun run lint
bun run typecheck
TMPDIR=/tmp bun run test
cd web && bun run build
```

Current evidence:

- 542 tests pass across 81 files; one opt-in live SSH test is skipped by default.
- CI `validate` passes on Linux.
- Production fixtures exercise two local and two SSH runtimes whose fake Herdr
  servers deliberately reuse resource IDs.
- Two-browser replacement coverage proves stale RPC and HTTP generations cannot
  reach a same-ID replacement runtime.
- Lifecycle tests cover synchronous status reentrancy, startup/stop races,
  rollback failure, retry cancellation, and shutdown drain.
- The opt-in real OpenSSH smoke passed against Herdr 0.8.0 / protocol 19 and
  verified both control and render forwarding.
- A standalone browser/bridge smoke verified profile selection, scoped workspace
  listing, and terminal render attachment.
- Full Page Up/Page Down wire tests verify Herdr `PageKey` input; Alt/Option
  half-page scrolling remains wheel-routed by design.

## Remaining work

M7 follow-up:

- aggregate connection/tunnel/subscription/terminal resource limits;
- optional inactive-connection background policy and idle cleanup;
- broader operational metrics and diagnostics;
- eventual removal plan for omitted identity/generation and legacy HTTP aliases.

Manual coverage still recommended:

- mobile, screen-reader, zoom, and safe-area UI matrix;
- fullscreen Pi visual smoke for physical Page Up/Page Down;
- additional long-running SSH interruption/recovery exercises.

Known compatibility limitation: Bun may canonicalize dot segments before the
HTTP handler sees the raw target. Observable traversal forms are rejected, but
legacy aliases prevent distinguishing every pre-handler canonicalized form.
Remove those aliases when the compatibility window closes or adopt a raw-target
server seam if Bun exposes one.

## Code map

- Manager/lifecycle: `server/src/connections/manager.ts`
- Profiles/persistence/service: `server/src/connections/profiles.ts`,
  `server/src/connections/profile-service.ts`
- Runtime composition: `server/src/connections/runtime.ts`
- RPC/HTTP protocol: `server/src/connections/protocol.ts`,
  `server/src/connections/rpc-routing.ts`,
  `server/src/connections/http-routing.ts`
- SSH execution/supervision: `server/src/bridge/ssh-command.ts`,
  `server/src/bridge/ssh-tunnel.ts`,
  `server/src/connections/ssh-profile-runtime.ts`
- Frontend bridge/store: `web/src/api.ts`, `web/src/store.ts`
- Selector/manager UI: `web/src/components/ConnectionSwitcher.tsx`
- Connection-scoped browser helpers: `web/src/connectionHttp.ts`,
  `web/src/connectionStorage.ts`, `web/src/terminalConnection.ts`,
  `web/src/useConnectionClient.ts`

## Maintenance policy

Keep this document focused on durable architecture, invariants, current
validation, and remaining work. Detailed implementation chronology, individual
review IDs, temporary failures, and intermediate test counts belong in Git and
the pull-request history rather than here.
