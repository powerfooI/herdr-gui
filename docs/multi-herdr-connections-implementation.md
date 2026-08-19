# Multi-Herdr Connections Implementation Plan

Status: **In progress**
Owner: herdr-gui maintainers
Started: 2026-08-18
Last updated: 2026-08-19 (M6 complete; M7 hardening planned)

## Objective

Allow one herdr-gui bridge to manage multiple Herdr servers. A server may be
available through local Unix sockets or through SSH-forwarded remote Unix
sockets. Each browser initially displays one selected connection at a time,
while the bridge may keep multiple connection runtimes alive concurrently.

The implementation must prevent data, terminal input, clipboard messages,
files, events, settings, and delayed asynchronous results from crossing
connection boundaries.

## Product and security defaults

The initial implementation uses these defaults unless a later decision changes
them:

1. herdr-gui remains a trusted, single-user administration tool. Connection
   profiles are shared by all authenticated browsers.
2. Each browser displays one active connection. A merged cross-server workspace
   tree is out of scope for the first release.
3. Server runtimes are independent of browser selection. `autoConnect` controls
   whether an inactive runtime remains connected; terminal render streams are
   opened only when viewed.
4. SSH authentication uses OpenSSH configuration, ssh-agent, and the operating
   system keychain. herdr-gui does not store SSH passwords, private-key contents,
   or passphrases.
5. A local profile attaches to existing Herdr sockets. Starting and supervising
   a local Herdr process is a separate future capability.
6. Connection profiles are persisted server-side in
   `~/.config/herdr-gui/connections.json`, with atomic writes, file mode `0600`,
   and parent directory mode `0700`.
7. Repository/workspace/session state is connection-scoped unless an explicit
   policy later defines a safe shared scope.
8. Profile mutation is an administrative operation under the existing
   herdr-gui trust model. A later hardening phase may restrict it to loopback by
   default.

## Architecture

```text
Browser
  |-- one same-origin WebSocket (/ws)
  `-- connection-scoped HTTP APIs
                 |
                 v
          ConnectionManager
          |-- ProfileStore
          |-- ConnectionRuntime: local-main
          |-- ConnectionRuntime: remote-dev  -> SSH tunnel
          `-- ConnectionRuntime: remote-prod -> SSH tunnel
```

### Bridge-global responsibilities

- HTTP authentication and login
- static frontend assets
- herdr-gui update operations
- browser WebSocket transport and client accounting
- connection profile persistence and CRUD
- connection catalog/status fan-out

### Per-connection runtime responsibilities

Each `ConnectionRuntime` owns:

- resolved control and render socket paths
- `HerdrClient`
- one `TerminalBridge`, all `ThinClient` instances, viewer maps, and clipboard
  relay state
- Herdr event subscription and reconnect lifecycle
- local socket or SSH tunnel transport
- agent session file access
- workspace file, Git status, worktree parent, hook, removal, and auto-sync
  services
- connection status, generation, and cleanup

A runtime must never reuse terminal maps, clipboard state, remote execution
state, or server-local resource IDs from another runtime.

## Protocol contract

Every downstream Herdr RPC must carry an explicit `connection_id`:

```json
{
  "id": "c123",
  "connection_id": "remote-dev",
  "method": "pane.list",
  "params": {}
}
```

Responses and pushed Herdr events, terminal frames, and clipboard messages must
carry the same connection identity. Bridge-global methods such as
`bridge.ping`, update operations, and `connections.*` do not require one.

A per-WebSocket selected connection may be used to filter watched events, but
must not be authoritative for RPC or HTTP routing.

Connection-scoped HTTP endpoints use paths such as:

```text
/api/connections/:connectionId/upload-image
/api/connections/:connectionId/file/download
/api/connections/:connectionId/agent-session/download
```

During migration, an omitted `connection_id` may resolve to the legacy default
connection for one compatibility window. New frontend code must always send it.

## Runtime lifecycle

Runtime states:

```text
disabled -> disconnected -> connecting -> ready
                                      |-> degraded
                                      |-> reconnecting
                                      `-> error
```

Required invariants:

- `start()` and `stop()` are idempotent.
- Constructors do not start processes or background loops.
- Every start, stop, and profile replacement advances a generation.
- Delayed callbacks publish only when their generation and runtime identity are
  still current.
- One failing connection never prevents the HTTP management UI from starting.
- Profile replacement validates and starts the replacement before retiring the
  previous runtime where possible.
- Removing a profile disconnects herdr-gui only; it does not stop the Herdr
  server or close its workspaces.
- Runtime disposal closes event subscriptions, SSH processes, thin clients,
  terminal viewers, clipboard relays, timers, and auto-sync loops.

## SSH transport requirements

- One independently supervised SSH tunnel per SSH runtime, forwarding both
  control and render sockets.
- OpenSSH destination is a config alias or `user@host`; browser-supplied
  arbitrary options are rejected.
- Service mode uses non-interactive authentication (`BatchMode=yes`).
- Default host-key verification remains enabled; never set
  `StrictHostKeyChecking=no`.
- Tunnel exit after readiness is observed and reflected in runtime status.
- Unexpected exits retry with bounded jittered exponential backoff; permanent
  authentication and host-key failures surface actionable errors.
- Local forwarded sockets live in a short, private runtime directory. Paths do
  not contain user-controlled labels or hostnames.
- Connection count, active tunnels, subscriptions, and terminal streams have
  explicit resource limits.

## Frontend state and switching

Target state shape:

```ts
type AppState = {
  bridgeStatus: BridgeTransportStatus;
  connections: ConnectionSummary[];
  activeConnectionId: string | null;
  sessionsByConnectionId: Record<string, ServerSessionState>;
  globalPreferences: GlobalPreferences;
};
```

Connection identity must be included in:

- React keys and terminal identities
- recent pane history and terminal relay viewport caches
- browser notification tags and activation targets
- workspace pins and collapse state
- file, diff, preview, agent history, and session caches
- every resource-specific localStorage entry

An active-connection switch advances a client generation, prevents old actions,
tears down or freezes old terminal/dialog state, loads the new workspace model,
and publishes it only after both connection ID and generation still match.
`TerminalView` is remounted using a key equivalent to
`${connectionId}:${terminalId}`.

## User interface

The current status indicator becomes a connection switcher such as:

```text
● Local · Connected ▾
```

The switcher shows profile type and status and links to a dedicated management
dialog. The dialog supports:

- Add Local / Add SSH
- Edit
- Test connection
- Set default
- Connect / Reconnect / Disconnect
- Remove

Browser-to-bridge status and bridge-to-Herdr status remain visually distinct.
Existing "Pause client" behavior is not presented as disconnecting a Herdr
connection.

## Backward compatibility

- Existing CLI and environment connection options synthesize a read-only
  `legacy-default` profile for the current process.
- If no persisted registry or explicit legacy options exist, herdr-gui
  synthesizes the current default local socket profile.
- Explicit legacy options select their synthetic profile for that process and
  do not silently rewrite `connections.json`.
- The old request format temporarily routes to the default runtime.
- `/api/health` continues to describe the herdr-gui bridge. Selected Herdr
  identity and health move to connection-scoped status APIs.

## Milestones

| ID | Milestone | Status | Exit criteria |
| --- | --- | --- | --- |
| M0 | Architecture and implementation plan | Complete | Scope, invariants, defaults, migration, and validation are documented. |
| M1 | Extract behavior-preserving single `ConnectionRuntime` | Complete | Existing single local/SSH behavior runs through a runtime object; bridge-global and connection-scoped services are separated; current tests pass. |
| M2 | Add `ConnectionManager` and lifecycle isolation | Complete | Manager owns the default runtime; subscription and terminal cleanup are generation-safe; one runtime failure does not stop HTTP startup. |
| M3 | Add connection-scoped protocol and HTTP routing | Complete | RPC, response, push, terminal, clipboard, upload, download, and agent-session paths carry `connection_id`; compatibility fallback is tested. |
| M4 | Partition frontend state and identity | Complete | Store, caches, persistence, notifications, and terminal lifecycle are connection-scoped; stale results cannot cross a switch or runtime replacement. |
| M5 | Add local profile persistence, CRUD, and selector UI | Complete | Multiple local socket profiles can be added, tested, selected, edited, and removed safely; runtime generations prevent cross-browser same-ID replacement routing. |
| M6 | Add independently supervised multi-SSH transports | Complete | Multiple SSH profiles connect concurrently, report independent status, clean up, classify failures, and recover independently from tunnel exits. |
| M7 | Add optional background behavior and hardening | Planned | Auto-connect policy, resource limits, background notifications, idle cleanup, permissions, and operational documentation are complete. |

## Detailed implementation work

### M1: single runtime extraction

- Add `server/src/connections/` types and runtime factory.
- Move the singular `HerdrClient`, terminal bridge, SSH transport, event
  subscription, and all remote-facing service factories out of the implicit
  module-global connection scope in `server/src/index.ts`.
- Keep authentication, updates, static serving, and browser client accounting
  bridge-global.
- Give terminal and subscription lifecycles explicit stop/dispose handles.
- Preserve current CLI/env behavior and wire one `legacy-default` runtime.

### M2: manager and isolation

- Add `ConnectionManager` with a `Map<ConnectionId, ConnectionRuntime>`.
- Make runtime start/stop/profile replacement generation-safe.
- Add catalog/status events and resolve the default runtime centrally.
- Start HTTP before attempting optional runtime connections.
- Bound reconnect loops and make all timers cancellable.

### M3: routing

- Extend WebSocket request/response/push envelopes with `connection_id`.
- Split bridge-global RPC dispatch from connection-runtime dispatch.
- Add connection-scoped HTTP route resolution.
- Scope logs and diagnostics with connection ID.
- Add old-client default routing with deprecation logging.

### M4: frontend scoping

- Extend `web/src/api.ts` with connection-aware calls and pushes.
- Split bridge/catalog state from per-server session state in `web/src/store.ts`.
- Replace direct singleton bridge usage with an active connection client or
  explicit connection-aware calls.
- Add generation guards to refresh, actions, dialogs, and terminal attach.
- Namespace all server-resource caches and persistence.

### M5-M7: product surface and remote lifecycle

- Implement profile store and sanitized public DTOs.
- Add selector and management dialog.
- Generalize SSH tunnel startup into an independently supervised transport.
- Add resource limits, background policy, operational diagnostics, and docs.

## Validation contract

The most important integration fixture runs two fake Herdr servers that
intentionally return identical workspace, tab, pane, and terminal IDs.
Validation must prove:

- RPC results route to the requested connection.
- delayed results from an old connection cannot overwrite the active session.
- terminal frame, input, resize, scroll, and clipboard data never cross.
- file, Git, worktree, and agent-session operations use the correct host.
- browsers can concurrently select different connections.
- a failed or removed connection does not affect other runtimes.
- SSH tunnel exit triggers independent cleanup/status/reconnect behavior.
- connection registry permissions and input validation meet the security
  requirements.

Required repository checks for completed implementation milestones:

```bash
bun run format:check
bun run lint
cd web && bun run typecheck
cd server && bun run typecheck
bun run test
cd web && bun run build
```

## Progress update policy

This document is the implementation source of truth. Update it:

- when a milestone starts or completes;
- after a material architecture or product decision;
- after each implementation/review/validation round;
- whenever a blocker or residual risk is discovered.

Each update must change `Last updated`, the milestone table, and the log below.
Do not mark a milestone complete until its exit criteria and relevant validation
checks pass.

## Implementation log

### 2026-08-18

- Completed repository-level architecture reconnaissance.
- Confirmed the current bridge has one global Herdr client, terminal bridge,
  SSH tunnel, event subscription, remote service bundle, WebSocket client, and
  frontend store.
- Chose explicit `connection_id` routing instead of mutable per-WebSocket
  routing.
- Chose one `TerminalBridge` per connection to prevent terminal and clipboard
  collisions.
- Established trusted single-user and active-connection-only initial UX
  defaults.
- Created this implementation plan.
- Started M1: behavior-preserving extraction of a single connection runtime.
- Added `server/src/connections/runtime.ts` and `types.ts`. The stable
  `legacy-default` runtime now owns the control/render clients, SSH tunnel,
  terminal bridge, event subscription, agent-session access, file/Git/status
  services, worktree services, settings RPC, auto-sync, and image upload.
- Rewired `server/src/index.ts` to use exactly one runtime while keeping auth,
  updates, static serving, and browser WebSocket accounting bridge-global.
- Added explicit resource shutdown: terminal bridge disposal, cancellable
  generation-guarded event subscription retries, an explicit subscription
  `closed` promise, and SSH startup cancellation guards.
- Added three subscription-loop lifecycle tests and a terminal runtime disposal
  test. Focused lifecycle tests pass: 13 tests, 0 failures.
- Validation passes:
  - `bun run format:check`
  - `bun run lint`
  - `cd server && bun run typecheck` (includes the embedded frontend build)
  - `TMPDIR=/tmp bun run test` (362 tests, 0 failures)
  - local startup smoke test against Herdr 0.8.0 / protocol 19 with a successful
    `/api/health` response and event subscription
- The default macOS temporary directory in this environment makes the existing
  Unix-socket test paths exceed the platform limit, so socket-based tests use
  `TMPDIR=/tmp`.
- M1 remains in progress until an independent acceptance review confirms the
  extraction boundary and no live SSH regression is identified.

#### M1 independent review fix round

- An independent review found lifecycle races and insufficient isolation at the
  new runtime boundary. All findings accepted for M1 were addressed:
  - event subscription retries now survive synchronous `subscribe()` failures,
    rejected `ready`/`closed` promises, and observer callback exceptions;
    cancellation suppresses callbacks and reconnects after stop;
  - terminal bridges are irreversibly and idempotently disposed, reject later
    RPCs, and guard attach/relay continuations against concurrent disposal;
  - Herdr subscription close is idempotent and force-destroys the socket so
    `closed` cannot hang on a half-close;
  - workspace auto-sync stop is awaitable, drains active work, and uses a
    lifecycle generation to suppress retired invalidation, persistence, logs,
    and reruns;
  - agent-session operations are bound to their runtime's Herdr client and file
    access, with an injected runtime-owned session path cache;
  - the runtime and SSH tunnel now receive only downstream connection fields,
    constructed explicitly in `server/src/index.ts`;
  - SSH socket-readiness polling is cancellable on cleanup, process exit, and a
    superseding start, with deterministic injected-process/scheduler tests.
- Added deterministic coverage for subscription stop/retry/error cases,
  repeated and concurrent terminal disposal, Herdr close-before-ack semantics,
  auto-sync drain behavior, agent-session cache/handler isolation, and SSH
  readiness cancellation.
- Review feedback deliberately deferred to later milestones:
  - manager-time runtime resolution instead of `index.ts` module-level dispatch
    aliases: M2/M3;
  - HTTP listener startup before downstream runtime connection: M2;
  - runtime replacement and connection status: M2;
  - post-ready SSH supervision and reconnect: M6.
- Post-fix validation passes:
  - focused lifecycle/isolation tests: 35 tests, 0 failures;
  - `bun run format:check`;
  - `bun run lint`;
  - `cd server && bun run typecheck` (including embedded frontend build);
  - final `TMPDIR=/tmp bun run test`: 375 tests, 0 failures.
- The first full-suite run hit the existing timing-sensitive worktree process
  cleanup test at its five-second timeout. Its isolated rerun passed 21/21, and
  the immediately repeated full suite passed 375/375.
- Added the remaining SSH cancellation case for cleanup during remote-home
  resolution and ensured a rejected subscription `closed` promise force-closes
  the associated subscription before retrying.
- No live SSH server smoke test was performed. M1 remains in progress pending
  post-fix independent acceptance review and final parent validation.
- The final correctness review found one additional shutdown race: a
  `ThinClient` closed while asynchronous Herdr protocol resolution was pending
  could reset its closed state and open a socket after terminal bridge disposal.
  `ThinClient.close()` is now irreversible for the connection attempt, and a
  deferred-protocol test verifies that no socket is opened after disposal.
- The focused ThinClient/terminal regression suite passed, and a focused fresh
  reviewer confirmed the protocol-resolution disposal race is closed without a
  reconnect regression.
- Replaced the timing-based terminal attach/dispose test with a deterministic
  server barrier and stress-ran the terminal bridge suite five times.
- Final parent validation passes:
  - `bun run format:check`;
  - `bun run lint`;
  - `bun run typecheck`;
  - `cd web && bun run build`;
  - `TMPDIR=/tmp bun run test`: 376 tests, 0 failures;
  - `git diff --check`.
- Earlier full-suite attempts exposed the existing five-second worktree process
  cleanup timing sensitivity; the affected tests passed in isolation and the
  final unmodified full-suite command passed after deterministic terminal test
  cleanup.
- Marked M1 complete after independent review and final validation. Started M2:
  introduce `ConnectionManager`, runtime status/generation ownership, and
  management-UI-first startup while retaining the single legacy default.

#### M2 manager and lifecycle implementation round

- Added `server/src/connections/manager.ts` with an explicit runtime lifecycle
  contract and a manager-owned `Map<ConnectionId, Entry>`. Entries retain a
  stable identity, factory, current runtime, generation, sanitized status,
  shared start task, and shared stop/drain task. The manager supports internal
  multi-entry operation, default resolution, safe replacement, status
  snapshots, all-runtime iteration, and one-shot manager shutdown.
- Runtime construction is lazy and side-effect-free until `start()`. Transport
  startup must complete before subscription and workspace auto-sync background
  work begins. Concurrent starts share one task; concurrent stops share one
  drain; stop and replacement invalidate the current generation immediately.
- Runtime factory contexts expose `isCurrent()` and generation-guarded
  `reportError()`. The legacy event/error callbacks use `isCurrent()` so a
  retired runtime cannot publish browser events or logs after replacement.
- Added sanitized lifecycle states `disconnected`, `connecting`, `ready`,
  `stopping`, and `error`. Public status contains no stack or runtime config;
  URL credentials and common inline secret fields are redacted and messages
  are bounded.
- Added `server/src/connections/startup.ts`. `server/src/index.ts` now binds
  `Bun.serve` first and starts `legacy-default` asynchronously afterward. A
  rejected SSH transport updates manager status and is logged without making
  listener startup fatal or starting connection background work.
- Removed module-level destructured runtime service aliases. Legacy RPC and HTTP
  dispatch resolve the manager's current default runtime at request time while
  keeping existing request paths and payloads unchanged. Bridge health, login,
  updates, static serving, `bridge.ping`, and `bridge.status` remain available
  without a current runtime; connection HTTP calls return `503` only during the
  narrow no-runtime lifecycle window.
- Added read-only bridge-global `connections.list`; `bridge.status` now also
  includes `default_connection_id` and sanitized connection snapshots while
  retaining its existing `clients` and `terminals` fields.
- Browser close and send-failure cleanup, plus browser-count relay
  notifications, now iterate every current runtime. Signal, exit, and fatal
  paths use one cached manager-wide stop task.
- Added deterministic tests in `server/src/connections/manager.test.ts` and
  `startup.test.ts` covering default resolution, concurrent start sharing,
  failed-entry isolation, sanitized errors, status transitions, stop/drain
  idempotence, stale replacement suppression, all-runtime shutdown, and
  listener availability after asynchronous transport rejection.
- Deferred deliberately: explicit `connection_id` protocol/HTTP routing,
  profile persistence and CRUD, and frontend connection state remain M3-M5;
  post-ready SSH exit supervision and bounded reconnect remain M6.
- Focused M2/lifecycle validation passes: 25 tests, 0 failures across manager,
  startup ordering, subscription lifecycle, and terminal disposal suites.
- Full validation passes:
  - `bun run format:check`;
  - `bun run lint`;
  - `cd server && bun run typecheck` (including frontend production build and
    embedded asset generation);
  - `TMPDIR=/tmp bun run test`: 385 tests, 0 failures;
  - `git diff --check`.
- Local startup smoke with deliberately missing control/render sockets proved
  `/health`, the embedded management UI, WebSocket `connections.list`, and
  bridge status remain reachable. The default local transport reached `ready`,
  preserved the existing subscription retry behavior, and logged the failed
  best-effort Herdr ping without terminating the listener.
- `startup.test.ts` separately proves a rejecting transport start is observed
  only after listener binding and leaves bridge health/ping seams available.
- Initial independent boundary review rejected M2 and found lifecycle defects:
  failed startup candidates were retained, queued restart/replacement could
  construct or strand a retired runtime, non-ready runtimes were dispatchable,
  shutdown exited before drains, status redaction was incomplete, and the
  terminal attach/dispose test still used a polling deadline.
- Fixed those findings by cleaning failed candidates, adding ready-only runtime
  resolution, installing replacement factories before an existing stop drains,
  making stale candidate cleanup clear ownership, expanding redaction, adding
  a bounded idempotent shutdown controller, and replacing the terminal polling
  deadline with a direct fake-server attach barrier.
- A second challenge review found two additional blockers and both were fixed:
  - `start()` now checks `stopTask` before an obsolete in-flight `startTask`, so
    start -> stop -> start deterministically queues a new runtime;
  - managed update exit now schedules `shutdownController.request(0)` rather
    than bypassing the awaited manager drain with direct production
    `process.exit(0)`.
- Added deterministic regressions for failed transport/background cleanup,
  identity mismatch, credential redaction, synchronous stop failure isolation,
  stop during initial transport followed by restart, queued replacement, and
  graceful/forced/rejected shutdown drains.
- Parent stress-ran the manager, shutdown, startup, and terminal lifecycle suite
  five times: 28 tests per run, no failures.
- Final validation passes:
  - `bun run format:check`;
  - `bun run lint`;
  - `bun run typecheck`;
  - `cd web && bun run build`;
  - focused manager/shutdown/update tests: 46 tests, 0 failures;
  - `TMPDIR=/tmp bun run test`: 394 tests, 0 failures across 61 files;
  - `git diff --check`, with no staged files.
- Parent startup smoke used deliberately missing local control/render sockets and
  verified `/health`, embedded UI, WebSocket `connections.list`, `ready` legacy
  catalog status, non-fatal Herdr failure, and SIGTERM drain to `disconnected`
  before exit 143.
- Fresh final correctness and blocker reviewers returned PASS with no blocker or
  high-severity findings. Their accepted deferrals are explicit response
  identity/stale-result suppression in M3, frontend partitioning in M4,
  transactional profile validation in M5, and post-ready SSH supervision in
  M6.
- Marked M2 complete after review fixes and parent validation. Started M3:
  introduce explicit `connection_id` routing and identity propagation while
  retaining the single `legacy-default` compatibility path.

#### M3 connection protocol and HTTP routing implementation round

- Added `server/src/connections/protocol.ts` and `rpc-routing.ts`. Bridge-global
  `bridge.*`/`connections.*` methods remain independent; every downstream RPC
  resolves an explicit validated `connection_id` to a ready runtime at dispatch
  time. Only an omitted field uses the default compatibility route. Explicit
  malformed, unknown, and not-ready identities fail without fallback.
- Added a reusable `serializeConnectionEnvelope()` that owns top-level identity
  validation and serialization. Generic RPC responses/errors, Herdr events,
  settings replies, terminal replies, terminal frames, and terminal clipboard
  pushes now carry the originally resolved runtime identity. The request-local
  ID is retained across delayed work and is never recomputed from later default
  state.
- The compatibility logger is bounded: one non-high-frequency omitted-ID RPC
  warning per browser and one warning per legacy HTTP endpoint. Terminal input,
  resize, relay-resize, and scroll never emit per-operation deprecation logs.
- Generalized `createLegacyConnectionRuntime()` to accept a stable identity,
  pass it to terminal/settings services and event/error callbacks, and scope
  subscription and terminal diagnostics. `index.ts` still registers only
  `legacy-default` and does not introduce profile APIs.
- Added additive hello capability/default fields. Existing WebSocket result
  shapes and pending request IDs are unchanged, and the current
  `web/src/api.ts` continues to ignore additive top-level identity. Compatibility
  tests cover scoped RPC responses and event/terminal/clipboard pushes without
  beginning M4 frontend state partitioning.
- Added `server/src/connections/http-routing.ts` with explicit scoped paths for
  Herdr info, image upload, agent-session raw/ATIF downloads, and file
  download/upload/delete. Legacy aliases remain default-only. Routing validates
  and decodes one bounded ASCII connection segment, resolves only ready
  runtimes, preserves endpoint status/body/stream semantics, and sets
  `X-Herdr-Connection-Id` on resolved, unknown, not-ready, JSON, binary, and
  streaming responses.
- Added deterministic protocol/HTTP/runtime/settings tests plus a dual-terminal
  fixture. Two independent render sockets intentionally reuse
  `same-terminal`; frame, input, resize, scroll, clipboard, replies, and viewer
  state remain scoped to `alpha` or `beta`. Fake RPC runtimes likewise reuse
  workspace/pane resource IDs and receive only explicitly addressed calls.
- Focused M3 validation passes: 36 tests across protocol, HTTP routing, runtime
  identity, settings envelopes, terminal isolation, and current web API
  compatibility. Formatter, lint, both typechecks, and frontend production
  embed/build also pass.
- Process smoke with missing local Herdr sockets verified additive hello
  capabilities, bridge-global independence, explicit and omitted/default RPC
  errors, malformed/unknown identity errors, scoped and legacy HTTP headers,
  encoded IDs, malformed encoded IDs, bounded deprecation logs, listener
  survival, and SIGTERM drain to exit 143.
- The first smoke attempt deliberately included a raw `..` scoped path and
  failed its no-header assertion: Bun canonicalizes raw and percent-encoded dot
  segments before constructing `Request.url`, making that request
  indistinguishable from the legacy alias. The parser rejects dot segments when
  the original path is available and rejects preserved encoded slash/double
  encoding in the live server. While legacy aliases exist, Bun's pre-handler
  canonicalization remains an explicit compatibility-window risk under the
  authenticated single-user model.
- The original M3 worker exhausted its 30-minute runtime after writing the
  implementation and focused validation but before returning a handoff. The
  required resume attempt failed because the original child session was no
  longer available, so a same-role fallback worker adopted and audited the
  existing working tree rather than restarting the implementation.
- Fallback validation passed without further production-code changes:
  - focused protocol, HTTP, runtime, settings, terminal, and legacy web API
    compatibility tests: 36 tests, 0 failures;
  - `bun run format:check`, `bun run lint`, and `bun run typecheck`;
  - `TMPDIR=/tmp bun run test`: 413 tests, 0 failures across 65 files;
  - `cd web && bun run build` (2080 modules transformed);
  - `git diff --check`, with no staged files.
- The fallback process smoke independently verified protocol version/capability
  hello fields; bridge-global handling despite a malformed identity; explicit,
  omitted/default, unknown, and malformed RPC routing; scoped and legacy HTTP
  identity headers; bounded RPC/HTTP deprecation warnings; and SIGTERM drain to
  `disconnected` before exit 143 while the Herdr sockets were absent.
- M3 remains in progress pending independent parent review and acceptance. M4
  active-connection selection, push filtering, store/cache partitioning,
  terminal remount keys, and client-side stale-result rejection remain
  explicitly deferred. Transactional profile replacement remains M5,
  post-ready SSH supervision remains M6, and no live SSH smoke was performed.

#### M3 independent review-fix round

- Two independent reviewers rejected the first M3 implementation. Confirmed
  blockers/high findings were an incompatible nested Herdr event envelope,
  missing same-ID runtime-generation checks for delayed RPC/HTTP publication,
  and connection-agnostic persisted repository, auto-sync, and worktree-parent
  metadata. Reviews also found incomplete runtime log scoping/redaction and
  weak validation-error identity coverage.
- Restored the additive event contract: `{ event, data }` is now emitted as
  `{ connection_id, event, data }`. Invalid event records and downstream use of
  the reserved `connection_id` field are rejected and dropped rather than
  nested or relabeled. Server protocol and current web compatibility tests
  assert the public top-level shape.
- Added manager-owned ready-runtime leases containing connection ID, generation,
  runtime, and `isCurrent()`. RPC and HTTP routing retain the lease. The
  production reply publisher emits at most one tagged `connection changed
  during request` error after replacement and never publishes a retired result;
  HTTP publication cancels the stale body and returns a tagged 409. Settings
  and terminal RPC replies accept the same request guard. Deterministic tests
  replace a runtime under delayed protocol, HTTP, settings, and terminal work.
- Namespaced repository and auto-sync keys plus worktree-parent records by
  nonlegacy connection ID while preserving byte-for-byte legacy-default key
  formats. Identity now flows through settings RPC, status enrichment,
  worktree hooks, parent storage, and auto-sync. Settings list/update operations
  reject another connection's key. Tests cover two local/same-host runtimes
  with identical repo, checkout, workspace, and parent IDs.
- Added connection identity to auto-sync and SSH tunnel lifecycle diagnostics;
  runtime-injected sanitization redacts credential-bearing failures. RPC method,
  connection, and error log fields are bounded, control-cleaned, validated, and
  credential-redacted. Valid connection IDs on malformed request envelopes are
  retained in tagged errors; malformed IDs remain untagged and global methods
  remain independent.
- Strengthened tests for legacy warnings across clients/endpoints and silent
  terminal traffic, delayed multi-chunk streaming with download/range/cache
  headers, legacy key migration, cross-connection settings mutation rejection,
  parent isolation, and auto-sync execution isolation.
- Review-fix validation passes:
  - focused routing, lifecycle, metadata, settings, terminal, and current web
    compatibility suite: 68 tests, 0 failures;
  - `bun run format:check`, `bun run lint`, and `bun run typecheck`;
  - `TMPDIR=/tmp bun run test`: 422 tests, 0 failures across 66 files;
  - `cd web && bun run build`: 2080 modules transformed;
  - `git diff --check`, with no staged files.
- Review-fix process smoke verified malformed global independence, tagged valid-ID
  request validation, untagged malformed-ID validation, scoped and legacy HTTP
  identity headers, and SIGTERM drain to `disconnected` before exit 143 while
  the downstream sockets were absent.
- A full injectable production dispatcher was not extracted solely for test
  aesthetics. Production uses the tested manager lease, RPC publisher, HTTP
  publisher, settings guard, and terminal guard seams. The full two-production-
  runtime fixture remains blocked until M5 exposes registration/profile
  configuration; the real dual-render-server fixture and service-key isolation
  tests cover the available M3 boundaries.
- Bun pre-handler dot-segment canonicalization remains an authenticated legacy-
  alias compatibility-window risk. Observable raw/encoded traversal forms are
  rejected. Remove legacy aliases after migration or adopt a raw-target server
  seam if Bun exposes one.
- Fresh review after that round was split: one reviewer accepted M3; another
  rejected it because retired one-shot mutations could continue and an HTTP
  stream was guarded only before its response was returned. The lifecycle
  policy is now explicit: an operation already dispatched to an explicit
  runtime may finish its side effect on that originally resolved runtime, but
  it may not publish stale output. Runtime replacement drains runtime-owned
  background work such as auto-sync before the replacement completes. M4/M5
  must not reinterpret an old result as current.
- Tightened the remaining controllable boundaries:
  - guarded HTTP bodies now recheck their lease for every stream pull, cancel
    the source, and abort before delivering a post-replacement chunk;
  - queued settings persistence receives the lease guard, checks before and
    after its mutation and temporary-file write, and suppresses auto-sync
    notification after replacement;
  - scalar, array, and null WebSocket payloads now receive a deterministic
    invalid-envelope response rather than escaping through a destructuring
    exception;
  - Herdr event identifiers and terminal transport errors are bounded and
    credential/control sanitized in logs.
- Added deterministic regressions for mid-stream replacement cancellation and a
  settings mutation invalidated while queued. The focused protocol, manager,
  HTTP, settings, terminal, and settings-key suite passes 51 tests with 0
  failures.
- A final acceptance review found one remaining shared-state path: delayed
  worktree create/open/remove requests could still add or delete parent metadata
  after same-ID replacement. `rememberWorktreeParent()` and `forgetWorktree()`
  now check and propagate the request lease into queued settings persistence;
  production passes that guard for all three operations and suppresses stale
  cancellation warnings. Deterministic gated tests prove stale additions and
  deletions leave settings unchanged.
- Strengthened the shared sanitizer to remove ANSI and C0/C1 control characters,
  and added a directly tested RPC-envelope predicate for null, array, and scalar
  JSON inputs. Invalid request URLs also return a bounded 400 instead of
  escaping URL construction.
- Final parent validation passes:
  - `bun run format:check`;
  - `bun run lint`;
  - `bun run typecheck`;
  - `TMPDIR=/tmp bun run test`: 426 tests, 0 failures across 66 files;
  - `cd web && bun run build`: 2080 modules transformed;
  - `git diff --check`, with no staged files.
- Final process smoke verified additive hello capabilities, null-envelope
  rejection, bridge-global independence from malformed identity, explicit
  connection-tagged RPC failure, scoped and legacy HTTP identity headers,
  malformed HTTP identity rejection, and SIGTERM drain to `disconnected`
  before exit 143.
- The final fresh blocker review returned PASS with no blocker or high-severity
  finding and explicitly accepted the M3 one-shot-operation policy and M4-M6
  deferrals.
- Marked M3 complete. Started M4 frontend connection identity/state partitioning
  while production still exposes only `legacy-default` until M5.

### M4 round A: connection-aware browser bridge and core store partition

- Updated `web/src/api.ts` to model protocol-v2 hello metadata, connection
  capabilities/catalog types, and top-level identity on Herdr events, terminal
  frames, clipboard pushes, and scoped replies. Downstream calls now send an
  explicit `connection_id`; `bridge.*` and `connections.*` remain unscoped.
- Added stable connection clients. Each client captures browser routing
  generation and connection ID; active switches, same-ID runtime replacement,
  disconnect, or reconnect invalidate old clients and reject scoped pending
  requests. Scoped replies with missing or mismatched identity are rejected;
  global replies do not require identity.
- Updated `web/src/store.ts` with an active connection catalog/default,
  `sessionsByConnectionId`, and an active-session projection retained for
  component compatibility. Workspace/tab/pane/layout/content/selection/recent
  pane/error/pending-focus/terminal-epoch/refresh state is saved and restored
  independently even when servers reuse every resource ID.
- Added the programmatic `store.selectConnection()` seam for M5. Switching
  freezes the prior terminal epoch, restores the target session, advances the
  browser lease, clears relay viewports, resets focus/refresh/poll ownership,
  and refreshes only the selected runtime. Catalog generation changes perform
  the same invalidation for a same-ID runtime replacement.
- Every store-owned downstream RPC now uses the client captured when its action,
  refresh, content poll, or focus queue began. Publication and follow-up calls
  require both the captured connection ID and generation to remain current.
  Bridge-global health, update, status, pause, and catalog operations remain
  global.
- Herdr event refresh triggers are filtered by active identity. Agent task
  transition tracking is partitioned by connection; notification tags and
  activation targets carry connection identity, and activation switches before
  focusing the target pane.
- Added deterministic browser regressions in `web/src/api.test.ts` and
  `web/src/store.test.ts` for explicit/global envelopes, response mismatch,
  switch and same-ID invalidation, push identity, colliding resource IDs,
  session restore, stale refresh/action suppression, inactive-event filtering,
  per-connection task transitions, and notification target identity. Focused
  validation passes 32 tests with 0 failures.
- Round A full validation passes: `bun run format:check`, `bun run lint`, both
  typechecks, `TMPDIR=/tmp bun run test` (435 tests, 0 failures across 66
  files), `cd web && bun run build` (2080 modules transformed),
  `git diff --check`, and the no-staged-files check. Vite retains the existing
  large-chunk advisory.
- A fresh Round A review found one disconnected-pause edge: `Bridge.disconnect()`
  advanced its generation without a status callback when already disconnected.
  Pause now copies `bridge.clientGeneration` into the store directly; a
  regression covers this path. Toast notification actions also retain the
  originating connection ID, and the unused unrestricted explicit-call helper
  was removed.

### M4 round B1: terminal identity and lifecycle isolation

- Every terminal mount is keyed by connection ID, browser generation, pane ID,
  and terminal ID. A connection switch or same-ID runtime replacement therefore
  disposes the complete xterm instance, link preview state, resize sync,
  watchdogs, event handlers, and rendered buffer before a replacement mount can
  interact.
- Each mount captures one generation-bound `ConnectionClient`. Attach, input,
  keys, resize, scroll, paste, relay resize, file resolution, detach, and retry
  RPCs use only that client. Async frame, clipboard, upload, resolution, paste,
  attach, resize, and watchdog continuations recheck the captured lease before
  publication.
- Added a neutral terminal lifecycle registry. Intentional alpha-to-beta switch
  and pause synchronously dispatch alpha detach requests before invalidating the
  client. Same-ID runtime replacement performs local disposal without sending a
  stale detach to the already-installed replacement runtime. React cleanup
  cannot fall back to the mutable active connection.
- Terminal and clipboard pushes must carry a non-empty `terminal_id` and match
  both the captured `connection_id` and exact terminal mount. Malformed or
  terminal-less pushes are dropped at the browser API boundary, so split panes
  cannot consume an ambiguous frame or clipboard message.
- Relay viewport entries now include connection ID and generation. Terminal
  file resolution cache and in-flight keys include a connection scope and stale
  resolutions cannot populate or return cache entries. Image paste uploads use
  `/api/connections/:connection_id/upload-image` with an encoded single path
  segment and same-origin URL construction.
- Added deterministic lifecycle, colliding-push, relay-cache, file-cache stale
  completion, and scoped HTTP path tests. Focused terminal validation passes 83
  tests with 0 failures. `bun run lint`, frontend typecheck, and frontend build
  pass; Vite transformed 2082 modules and retained the existing large-chunk
  advisory.
- A fresh B1 review rejected the first pass because terminal-less pushes were
  still accepted, terminal file previews reused unscoped global caches, some
  outbound calls omitted `terminal_id`, clipboard failure callbacks could
  publish after remount, disposer exceptions could abort sibling cleanup, and
  colon-joined React keys were not injective.
- The follow-up requires exact push identity, scopes preview cache/in-flight
  entries by connection generation, suppresses stale and out-of-order preview
  publication with a monotonic request sequence, requires explicit terminal IDs
  for input and scroll, removes the ambiguous worktree cleanup detach, gates
  delayed clipboard notices, isolates disposer exceptions, and uses a JSON
  tuple mount key.
- The first follow-up test invocation used macOS's long default temporary path;
  12 Unix-socket terminal tests could not bind because their paths exceeded the
  platform limit. Re-running the same focused suite with `TMPDIR=/tmp` passes
  134 tests with 0 failures and 371 assertions across 13 files. Final follow-up
  checks also pass `bun run format:check`, `bun run lint`, frontend typecheck,
  `git diff --check`, and the no-staged-files check.
- M4 remains in progress. Round B2 still must convert non-terminal component
  RPCs and file/download/agent-session/Herdr-info HTTP calls, partition
  file/diff caches and server-resource persistence, and close/remount dialogs
  on connection changes. No profile selector/CRUD is added until M5.

### M4 round B2a: component RPC, HTTP, and in-memory cache isolation

- The initial B2a worker exceeded its turn budget after leaving a type-clean
  partial implementation; its persisted session could not be resumed. A
  fallback audit completed the existing direction rather than restarting or
  widening the milestone.
- Added a `useConnectionClient()` hook and injective scope-key helper. Direct
  file, diff, worktree, auto-sync, settings, and agent component work now
  captures one connection/generation client, checks it before chained calls and
  React/store publication, and invalidates request sequences on close or scope
  changes. No component-owned downstream `bridge.call()` remains.
- File explorer preview/tree caches, diff summary/file caches, prefetch maps,
  and in-flight request maps now include connection ID and browser generation.
  Stale preview and diff-file completions cannot populate those caches. Agent,
  settings, and worktree dialogs reset their pending state when their captured
  client changes.
- File upload, delete, and download; raw and ATIF agent-session downloads; and
  Herdr identity requests now use encoded `/api/connections/:id/...` paths.
  Terminal image upload remains scoped from B1. Bridge health stays on the
  bridge-global `/api/health` endpoint.
- Quick-open and background prefetch helpers capture the client at invocation;
  App quick-open suppresses stale completion, and external file-preview state is
  cleared as soon as the file component changes connection scope. Agent-panel
  session state is likewise cleared before an identically named pane can be
  reused on another connection.
- Added/updated deterministic tests for connection/generation scope keys,
  colliding file and diff resource IDs, stale file-preview completion, and a
  delayed diff file that resolves after its client retires. Fallback validation
  passes:
  - focused browser suite: 43 tests, 0 failures, 109 assertions;
  - frontend typecheck;
  - root lint;
  - targeted Biome formatting and `git diff --check`;
  - frontend production build: 2083 modules transformed, retaining the existing
    large-chunk advisory;
  - no staged files.
- M4 remains in progress. B2b must namespace the remaining resource-specific
  App/workspace local storage, reset or remount App-owned file/diff/dialog state
  on connection changes, and perform final complete-suite and process
  validation. Profile CRUD and selector UI remain M5.

### M4 round B2b: resource persistence and UI remount isolation

- Added `connectionStorageKey()`, which preserves the existing unprefixed
  `legacy-default` keys and encodes every other connection/base key as separate
  path segments. File explorer workspace, file preview, diff workspace, diff
  selected entry, workspace pins, and collapsed worktree groups are now scoped
  by connection ID. Theme, accent, sidebar presentation, diff presentation,
  shortcuts, notifications, connection pause, and update restart state remain
  bridge/browser-global.
- `WorkspaceTree` reads, writes, and listens only to its active connection's pin
  and collapse keys. App keys the tree by connection generation, so same-profile
  replacement keeps persisted preferences while disposing all in-memory state.
- App now performs an explicit layout-phase resource transition. It snapshots
  and saves the outgoing connection under the old ID, reads the target ID,
  invalidates file and pane-jump requests, clears file/diff/agent transient
  state, and restores target explorer/diff selections. Separate active-routing
  and state-owner refs prevent React's layout-triggered passive-effect flush
  from writing an alpha closure into beta storage.
- Workspace, agent, command, config, tab, file explorer, diff sidebar, diff
  content, and file preview components are keyed by connection ID and browser
  generation. Connection changes therefore close server-resource dialogs and
  discard component-local caches before colliding IDs can be displayed.
- Diff selection persistence now uses the common storage-key policy and restores
  the original `legacy-default` key shape. Stored file preview restoration
  always reads the active connection key and fetches through the captured
  connection client.
- Added deterministic storage tests covering encoded/injective keys,
  `legacy-default` compatibility, colliding alpha/beta workspace resources,
  independent pins/collapse/explorer/preview/diff values, generation remount
  with same-profile persistence, and saving alpha without modifying beta. A
  pre-existing zero-delay polling test was replaced with an explicit deferred
  request barrier.
- B2b validation passes:
  - focused resource suite: 36 tests, 0 failures, 111 assertions across seven
    files;
  - root lint and frontend typecheck;
  - targeted Biome formatting and `git diff --check`;
  - frontend production build: 2084 modules transformed, retaining the existing
    large-chunk advisory;
  - no staged files.
- M4 remains in progress pending parent full-suite/process validation and a fresh
  acceptance review. Profile CRUD/selector UI remains M5; SSH supervision and
  live SSH smoke remain M6.

### M4 final generation-boundary review fix

- The final whole-milestone review rejected M4 on two same-ID replacement
  boundaries. Cached server resources were partitioned by browser routing lease
  but were not owned by the `ConnectionManager` runtime generation, and task
  notification targets carried connection/resource IDs without that runtime
  generation.
- Every `ServerSessionState` now records `serverRuntimeGeneration`, distinct
  from the browser `connectionGeneration`. Catalog reconciliation evaluates
  every active and inactive connection, removes sessions for absent profiles,
  initializes new entries empty, tags the initial untagged legacy session, and
  empties any session whose recorded or catalog generation changed.
- Active replacement now disposes terminal mounts without sending a detach to
  the replacement runtime, advances the browser lease, and publishes an empty
  generation-tagged workspace/tab/pane/layout/content/selection session before
  refresh. Inactive replacement is cleared immediately, so selecting it later
  cannot restore retired IDs. Switching also refuses a cached session unless
  its server runtime generation matches the current catalog.
- Task notification browser and toast targets now include server runtime
  generation. Activation first validates that generation against the current
  catalog, allowing ordinary alpha/beta switching while rejecting a
  notification that outlived same-ID replacement. Notification tags use an
  injective JSON tuple of connection, runtime generation, and pane identity.
- Added deterministic production-path regressions for active replacement
  publication, inactive replacement followed by selection, a real deferred
  `store.refresh()` and store action across alpha-to-beta switching, and
  unchanged/replaced notification activation. A narrowly named test seam resets
  the singleton store, polling queues, focus chain, and task tracker without
  changing production dispatch behavior.
- Focused post-fix validation passes:
  - root lint and frontend typecheck;
  - 45 tests, 0 failures, 129 assertions across store, bridge API, terminal
    lifecycle, and connection storage suites;
  - targeted Biome formatting, `git diff --check`, and no staged files.
- The remaining final-review request for DOM-mounted xterm/App integration is a
  test-infrastructure gap rather than a demonstrated wiring defect; no DOM test
  dependency was added in M4.

### M4 final acceptance

- Parent follow-up validation after the generation fixes passed 49 focused
  tests with 0 failures. It also strengthened the notification-tag regression
  to vary runtime generation directly and changed the HTTP path test to use a
  valid nontrivial connection ID accepted by the server parser.
- Final complete validation passes:
  - `bun run format:check`;
  - `bun run lint`;
  - `bun run typecheck`;
  - `TMPDIR=/tmp bun run test`: 457 tests, 0 failures, 1458 assertions across
    72 files;
  - `cd web && bun run build`: 2084 modules transformed;
  - `git diff --check`, with no staged files.
- Final process smoke against the production bundle with absent Herdr sockets
  verified `/api/health`, the rendered entry document and current JS asset,
  protocol-v2 hello capabilities, global `connections.list`, explicit tagged
  `legacy-default` failure, invalid-envelope rejection, catalog runtime
  generation, scoped HTTP identity, malformed-ID rejection, and SIGTERM drain
  through `stopping` to `disconnected`.
- A real-browser smoke agent was also attempted but timed out without producing
  evidence; it is not counted as validation. Production App/xterm wiring is
  covered by static review, controller/helper tests, store production-path
  tests, the built bundle/process smoke, and server terminal integration tests.
- The final fresh acceptance reviewer returned **ACCEPT / PASS** with no
  blocker/high finding. Residual risks are the missing DOM-mounted switch
  harness and generation-scoped in-memory file/diff maps retaining retired
  entries until the browser tab closes. Neither is a demonstrated isolation
  defect; add bounded cleanup and a true two-runtime browser fixture when M5
  makes profile registration available.
- Marked M4 complete. Started M5 profile persistence, validation, CRUD, and
  selector UI. SSH supervision and live SSH smoke remain M6.

### M5a: persistent local profiles and backend lifecycle

- Added the strict version-1 local profile registry and public profile DTOs:
  - the default path is `~/.config/herdr-gui/connections.json`, with
    `HERDR_GUI_CONNECTIONS_PATH` supported only as an explicit operations/test
    override;
  - profile IDs reuse the protocol `connection_id` validator and reserve
    `legacy-default`; labels, absolute Unix socket paths, booleans, field sets,
    profile counts, and total file size are bounded and validated;
  - writes use a private directory, exclusive mode-0600 temporary file,
    file/directory fsync where supported, atomic rename, and a serialized write
    queue; direct file/parent symlinks and insecure override permissions are
    rejected without chmodding an arbitrary shared directory;
  - no command, SSH option, password, private key, passphrase, or other secret
    field is accepted or persisted.
- Added startup compatibility and real registration:
  - explicit CLI/environment downstream settings remain a read-only
    `legacy-default` process default and do not rewrite the registry;
  - otherwise persisted profiles and their persisted default are registered;
    with no registry, the current local socket configuration remains the
    synthetic default;
  - the first successful create from synthetic-only mode atomically persists
    and selects the new profile, then drains and unregisters the synthetic
    runtime so the current process and next restart agree;
  - the listener binds before the default and all `auto_connect` profiles start,
    and profile startup failures are caught independently.
- Refactored runtime construction in `server/src/index.ts` so every persisted
  local profile receives its own existing `ConnectionRuntime` graph with its
  own control/render socket paths, identity, generation, terminal bridge,
  subscription, settings, metadata, and caches. Persisted local runtime startup
  and reconnect also perform the bounded control/render probe before publishing
  `ready`, so a bad socket profile cannot become a routable lease or block a
  healthy peer. Explicit legacy SSH startup is still passed through unchanged;
  general SSH profiles and post-ready supervision remain M6.
- Extended `ConnectionManager` with a mutable registered default and serialized,
  draining unregister semantics. Default changes republish both affected
  statuses; removal blocks racing starts, invalidates leases, stops only the GUI
  runtime, and never sends a Herdr shutdown request.
- Added authenticated bridge-global RPCs for `connections.create`, `update`,
  `remove`, `set_default`, `connect`, `disconnect`, and `test`. Profile mutations
  are serialized, return sanitized errors, and use IDs from params rather than
  top-level connection routing identity. `connections.list` now merges runtime
  status with the sanitized local profile DTO, including `type`, `auto_connect`,
  socket paths, and `read_only`.
- `connections.test` performs a real bounded control `ping` followed by a real
  thin-client render Welcome handshake and always closes the render probe. It
  neither persists nor registers the candidate. Updating a ready profile first
  completes that probe; failed validation or persistence leaves the old file,
  factory, runtime, and generation usable. Later replacement/start failure
  executes explicit file and runtime rollback.
- Tests cover schema version, exact fields, duplicate/default/reserved IDs,
  control characters, relative and traversal paths, profile/file bounds,
  direct symlinks, insecure permissions, atomic mode and failed-write
  preservation; manager default/unregister/restart/generation behavior;
  explicit/default/persisted startup selection, auto-connect failure isolation,
  first-create migration, complete local CRUD, last-profile removal under an
  explicit legacy override, failed ready-profile update preservation, and two
  independent fake control/render servers deliberately returning identical
  workspace/pane/terminal IDs.
- One focused test run initially failed 10 tests because ancestor-symlink
  rejection treated macOS `/tmp` as unsafe. The implementation was corrected to
  reject the registry leaf and direct parent symlink while creating the atomic
  temporary file only inside a validated mode-0700 parent. The final focused
  run passes 36 tests, 0 failures, and 146 assertions.
- Final M5a validation on this working tree passes:
  - `bun run format:check` and `bun run lint`;
  - server typecheck (including the prerequisite 2084-module frontend build);
  - `TMPDIR=/tmp bun run test`: 478 tests, 0 failures, 1532 assertions across
    74 files;
  - live production-path two-profile smoke covering sanitized catalog/default,
    explicit alpha/beta scoped RPC against colliding resource IDs, beta control
    and render test handshake, connect/disconnect, default change, removal, and
    SIGTERM shutdown;
  - `git diff --check`, with no staged files.
- M5 remains **In progress** pending independent M5a review and M5b connection
  switcher/management UI. A DOM-mounted two-profile selector smoke and bounded
  frontend cache retirement are M5b follow-ups. SSH profile execution, tunnel
  exit supervision, retry/backoff, and live SSH smoke remain M6.

#### M5a independent review rejection and fixes

- Two fresh independent reviews rejected the first M5a pass because the
  temporary render probe lacked an EventEmitter `error` listener. A healthy
  control socket plus a missing, reset, or malformed render socket could
  therefore escape the rejected promise and terminate the bridge. The probe
  now installs its listener before `connect()`, and missing/malformed render
  regression tests prove contained rejection.
- One-shot `HerdrClient.call()` now destroys its socket on every completion,
  including timeout, so a half-open peer cannot retain descriptors. A real
  never-replying server test observes prompt client closure.
- Registry clear now validates the direct parent as a private non-symlink
  directory and opens it with `O_NOFOLLOW` where available before fsync. The
  compatibility policy still permits macOS `/tmp` to be an ancestor; a direct
  parent symlink clear test proves the target file is preserved.
- `ConnectionManager.unregister()` now invalidates and removes the registration
  even when best-effort runtime cleanup fails, logs the sanitized cleanup
  failure, and never leaves a reconnectable factory. First-create migration has
  a failing-stop regression proving `legacy-default` cannot return.
- Profile removal now unregisters routing before changing durable state. If the
  atomic persistence step fails, it restores the old factory and prior ready
  state; if recovery also fails it reports an `AggregateError`. An unregister
  failure performs no write at all, eliminating the previous rollback-write
  inconsistency window. Both boundaries have deterministic tests.
- Invalid registries are preserved in degraded startup mode. Local legacy
  connect/test remains usable, while create/update/remove/default mutations are
  rejected until the operator repairs or removes the invalid file.
- The former `/tmp` smoke is now a repeatable repository process test. It boots
  the production dispatcher against two real fake control/render servers that
  reuse `shared-workspace`, exercises catalog/test/connect/disconnect/create/
  update/default/remove, verifies explicit scoped and omitted-ID default RPC,
  and drains the child with SIGTERM.
- Parent validation before these fixes saw one unrelated worktree sleeper test
  exceed its five-second limit; its isolated rerun passed in 4.1 seconds and an
  immediate full retry passed 478 tests with zero failures. This flaky retry is
  recorded rather than silently counted as an initial pass.
- Post-fix validation passes 46 focused tests and the full 486-test suite with
  zero failures (1569 assertions across 75 files), plus format, lint, both
  typechecks, the 2084-module production frontend build, `git diff --check`,
  and the no-staged-files check. One parent run executed concurrently with two
  frontend builds and hit the known five-second worktree sleeper boundary;
  after terminating that contaminated run, the full suite passed sequentially
  with the same 486/0 result.
- A fresh independent acceptance reviewer rechecked every rejected finding and
  returned **ACCEPT / PASS**, with no blocker, high, or medium finding. Its
  nonblocking residual gaps are a dedicated `ECONNRESET` probe case, explicit
  response-identity assertions plus pane/terminal collisions in the process
  fixture, and a test where both removal persistence and runtime recovery fail.
  M5a is accepted; M5 remains in progress for the M5b selector/management UI.

### M5b: connection switcher and local profile management UI

- Replaced the topbar bridge status dot with a connection switcher that shows
  the active profile label, local type, and Herdr runtime lifecycle. Its
  popover lists every profile with active/default/read-only/status indicators
  and presents browser-to-bridge transport or pause state separately from the
  bridge-to-Herdr runtime state.
- Profile selection uses the existing `store.selectConnection()` generation
  boundary immediately. A disconnected/error profile may be started with the
  bridge-global `connections.connect` RPC, but completion never selects or
  switches the browser again. M4 terminal/session/cache invalidation therefore
  remains authoritative.
- Added a dedicated management dialog for Add Local, Edit with immutable ID,
  test saved or unsaved profiles, set default, connect, reconnect, disconnect,
  and confirmed removal. Synthetic profiles keep read-only controls, default
  profiles cannot be removed, errors remain backend-sanitized, and the disabled
  Add SSH control explicitly points to M6. The form sends the exact strict local
  profile schema and stores no profile data in browser persistence.
- Added deterministic frontend seams for catalog DTO parsing/transition merge,
  lifecycle labels, capability policy, safe ID suggestion, strict local form
  payloads, immediate selection with optional start, reconnect ordering, and
  error presentation. Async dialog feedback is guarded by a request token and
  mount lifetime; every administrative operation refreshes the global catalog.
- `bridge.status` now returns the same profile-aware public catalog as
  `connections.list`, preventing status polling from replacing socket paths and
  profile policy with manager-only status objects. The frontend additionally
  preserves already-known profile fields when talking to a transition server
  whose status response omits them.
- Focused tests cover profile DTO parsing/tolerance, global RPC identity,
  catalog field retention, removed-active fallback, runtime replacement,
  immediate disconnected selection without stale switch-back, strict form
  validation, read-only/default capability policy, reconnect sequencing, and a
  production-process assertion that `bridge.status` contains sanitized profile
  fields. No DOM-mounted harness exists, so keyboard/outside-click/focus and
  responsive rendering still require real UI smoke rather than being claimed
  as automated DOM evidence.
- Final M5b worker validation passes 48 focused tests and the sequential full
  suite with 496 tests, 0 failures, and 1595 assertions across 76 files, plus
  format, lint, both typechecks, the 2086-module production frontend build,
  `git diff --check`, and the no-staged-files check.
- M5 remains **In progress** pending a real browser/UI smoke and fresh
  independent review. SSH profile execution and supervision remain M6.

#### M5b independent review rejection: cross-browser runtime generation

- Two independent M5b reviewers rejected the first UI pass. The correctness
  reviewer found a high-severity cross-browser boundary: after browser B
  replaces or reconnects profile `alpha`, browser A can still issue a new
  resource action from the retired runtime before its next catalog poll. A
  request carrying only `connection_id=alpha` would otherwise dispatch into the
  replacement runtime and could mutate a colliding workspace, pane, or terminal
  ID. The UI reviewer separately found pending-form and keyboard/modal issues;
  those presentation fixes remain the next focused M5b round rather than being
  mixed into this protocol change.
- The protocol now supports additive top-level `connection_generation` on
  scoped RPC requests, replies, errors, Herdr events, terminal frames, and
  terminal clipboard pushes. New `ConnectionClient` instances capture both the
  browser lease generation and the exact server catalog generation. The server
  validates a supplied generation before dispatch and returns a deterministic
  identity-tagged 409 on mismatch; malformed values return 400. Missing values
  remain a bounded, logged old-client compatibility path and never substitute
  for an explicit malformed or stale value.
- Runtime construction threads its fixed manager generation through settings,
  terminal, clipboard, and event publishers. The frontend advertises and
  consumes the `connection_runtime_generation` hello capability, strictly
  matches capable-server replies, maintains the current catalog generation map,
  and drops missing/stale events and terminal pushes before store or xterm
  handlers run. Reconnect clears that map, so resource calls cannot dispatch
  until a fresh catalog has restored the active generation.
- Scoped HTTP URLs now carry `connection_generation` in the query string so
  navigation/download requests receive the same protection as fetch requests.
  The server validates it before handler dispatch, returns
  `X-Herdr-Connection-Generation` alongside the connection ID, and preserves
  binary/stream bodies plus per-chunk lease guards. Config, terminal image,
  explorer upload/delete/download, and agent-session download callers all use
  their captured client generation.
- The production process fixture now opens two browser WebSockets which both
  observe the old `alpha` generation. Browser B replaces `alpha` with a second
  fake Herdr server reusing resource IDs; browser A's old-generation
  `pane.close` and HTTP request receive 409 and are proven never to reach the
  replacement. Current-generation routing reaches only the replacement, while
  one explicit missing-generation call proves the compatibility route remains.
- The first generation-fix worker timed out after 30 minutes with a substantial,
  type-clean partial implementation. Runtime resume then failed because the
  persisted run lacked its required fan-out recovery identity, so a same-role
  fallback audited and completed the existing work rather than reimplementing
  it. The fallback additionally made capability enforcement dynamic for clients
  created before hello, bound the compatibility `Bridge.call()` entry point to
  the current catalog generation, prevented Config HTTP and polling refreshes
  before a capable server's catalog is ready, and added missing-generation HTTP
  compatibility coverage.
- The fallback's first post-audit focused rerun reported 88 passes and one
  regression-test failure because the new pre-hello client fixture changed its
  active ID when hello arrived, invalidating the browser lease before testing
  runtime-generation gating. The fixture now keeps the same active ID; the
  production logic did not fail. One format check also identified and then
  corrected a single multiline test-expression layout.
- Final generation-focused validation passes 89 tests with zero failures and
  383 assertions. Sequential full validation passes 500 tests with zero
  failures and 1650 assertions across 76 files, plus format, lint, both
  typechecks, the 2086-module production frontend build, `git diff --check`,
  and the no-staged-files check. Generated embedded-public output remains
  unchanged in Git. A fresh acceptance review remains pending before the
  separate ConnectionSwitcher accessibility/pending-state fix.

#### M5b protocol hardening, accessibility fixes, and final acceptance

- The first post-generation boundary review found a wire-envelope confusion
  flaw: an untrusted Herdr event could include bridge-reserved top-level fields
  such as `hello` or an RPC `id`, causing the browser to interpret the event as
  a capability downgrade or reply. The server now rejects every conflicting
  event field before publication. The frontend independently accepts exactly
  one wire-message kind, validates one initial unscoped hello per WebSocket,
  drops all non-hello frames before that handshake, and rejects scoped outgoing
  work until hello arrives.
- Reply parsing is also exclusive: a response must carry exactly one of
  `result` or a structured `error`; global replies reject either connection
  identity field, while scoped replies continue to require the captured
  connection and runtime generation. Malformed IDs/generations retain the
  validated identity where possible, and compatibility warnings never log an
  unvalidated supplied connection ID. Regression tests cover hello/event and
  event/reply overlap, reply-only identity injection, ID-only and malformed
  error frames, pre-hello calls and pushes, and valid old-server capability
  behavior.
- The manager's pending state no longer wedges or misleadingly cancels a
  persistent operation. Request-token lifetime is independent of form focus;
  while an operation is pending, Escape, Back, Cancel, backdrop dismissal, and
  Close are disabled or ignored. Completion refreshes the global catalog and
  only publishes feedback into the still-current dialog request.
- The switcher now uses the shared Radix portaled popover. It implements active
  initial focus, Arrow Up/Down, Home/End, exclusive menu-radio roles, explicit
  Tab exit to the actual adjacent tabbable document control, and revalidated
  trigger fallback. Tabbability excludes disabled, inert, hidden-ancestor,
  CSS-hidden, zero-layout, and Radix focus-guard elements and respects positive
  `tabindex` ordering.
- The management dialog is portaled above application overlays, makes the app
  root inert/hidden while mounted, traps Tab/Shift+Tab, uses the repository's
  robust initial-focus helper, restores trigger focus, and exposes busy and
  live status/error semantics. Selection success/failure is announced through
  the existing live toast. Read-only status is textual, small connection UI
  text uses the normal contrast token, long errors wrap, and popover/modal
  dimensions use Radix available height plus mobile safe-area insets.
- Independent protocol/security re-review
  `6e6a9b94-ae34-48bc-8496-3f63e0cfef91` returned **PASS** with no blocking
  finding. Final UI/accessibility review
  `e9fbac57-19db-4d4e-bd3a-a0c5394945b4` also returned **PASS** with no
  blocker, high, or medium finding.
- Final focused generation/profile validation passes 97 tests with zero
  failures and 423 assertions. Sequential full validation passes 501 tests
  with zero failures and 1672 assertions across 76 files. Format, lint, both
  TypeScript checks, the 2086-module production frontend build,
  `git diff --check`, and the no-staged-files check pass. Generated frontend
  assets remain ignored and unstaged.
- A real desktop/mobile browser smoke remains **NOT RUN**, not a claimed pass:
  the attempted browser daemon failed and this repository has no DOM-mounted
  ConnectionSwitcher/xterm harness. Keyboard focus timing, screen-reader
  announcements, zoom, and safe-area placement therefore remain explicit
  manual verification items rather than automated evidence.
- M5 is **Complete**. M6 remains responsible for persisted SSH profiles,
  independently supervised tunnels, exit detection, bounded retry/backoff, and
  live SSH smoke.

### M6: persisted SSH profiles and independently supervised transports

#### M6a: strict profiles, secure OpenSSH execution, and product UI

- Registry version 2 adds a discriminated local/SSH profile union while loading
  version-1 local registries unchanged. The first successful mutation rewrites
  the registry atomically as version 2; rollback preserves the exact previous
  version and bytes where required. SSH records contain only `id`, `label`,
  `type: "ssh"`, `ssh_destination`, two explicit remote socket paths, and
  `auto_connect`.
- Destination validation accepts only a bounded ASCII OpenSSH alias or
  `user@host`. Leading options, empty users, URI/port syntax, whitespace,
  control characters, slash, equals, comma, and multiple `@` are rejected.
  Remote socket paths are short absolute POSIX paths with distinct control and
  render leaves. Passwords, passphrases, keys, identity files, commands, ports,
  arbitrary options, host-key overrides, and user-selected local paths are not
  schema fields and fail exact-key validation.
- Every production remote SSH invocation now uses one trusted argv builder.
  Managed calls use batch mode, strict host-key verification, no TTY/local
  command/control-master reuse, bounded connection attempts, and `--` before
  the validated destination. No profile value supplies a command or option.
  Legacy CLI/environment destinations are validated by the same grammar.
- Each persisted SSH runtime allocates a random short mode-0700 directory under
  `/tmp`, with fixed `control.sock` and `render.sock` names that contain no
  profile data. Both explicit remote sockets are forwarded by one OpenSSH
  process. Startup verifies control `ping` and the render Welcome handshake.
  Disconnect, failed startup, probe, replacement, removal, and shutdown await
  bounded graceful/force process termination before removing owned sockets and
  the directory.
- The browser catalog, transition merge, selector, and manager now understand
  strict SSH DTOs. Add/Edit/Test SSH uses a dedicated form with destination,
  remote control/render sockets, and auto-connect only. Cards and switcher
  labels are type-aware, and the form explains that authentication and host
  trust come from the bridge service user's OpenSSH config, agent, or Keychain.
- The first M6a worker made a substantial partial implementation but failed on
  an ambiguous edit; its persisted run could not be revived. A same-role
  fallback then cold-started without output, so the parent audited and
  completed the preserved partial tree. This recovery and both failures were
  kept explicit rather than treating partial work as validated.
- M6a security and UI reviews initially rejected asynchronous tunnel cleanup,
  an empty-username validation mismatch, and permissive catalog parsing.
  Cleanup now waits for process exit with signal-9 fallback, frontend and
  backend validators agree, explicit SSH DTOs require complete safe fields,
  and cross-type catalog replacement clears stale opposite-transport fields.
  Re-reviews `8afa20fd-4e09-4867-b6c5-f595f2392e23` and
  `22f954a8-113c-41d5-8a88-58c006b87bad` returned **PASS**.

#### M6b: exit supervision, retry policy, and production boundary

- Tunnel stderr is continuously drained with 16 KiB retained for
  classification. ANSI/control content and raw banners never enter public
  errors. Host-key and authentication failures become curated permanent
  errors; reachability and unknown exits are transient.
- A post-ready exit is bound to the exact tunnel process and lifecycle
  generation. It immediately invalidates the manager generation, removes the
  ready lease, publishes `reconnecting` or permanent `error`, and retires the
  entire old runtime. Terminal bridges, subscriptions, auto-sync, RPC
  publishers, sockets, and the tunnel are therefore recreated together rather
  than reconnecting only the child process under an old generation.
- Each SSH profile owns an independent retry state. Transient failures use
  cancellable equal-jitter exponential delays capped at 30 seconds and six
  attempts; the attempt count resets only after a 30-second stable-ready
  interval. Manual connect resets policy. Disconnect, update, removal, failed
  update rollback, replacement, and shutdown invalidate timers/tokens, and
  permanent failures remain in `error` until explicit action.
- Synthetic legacy SSH now observes post-ready exit and retires its stale
  generation/runtime, but intentionally does not auto-retry or persist a
  profile. This preserves its read-only compatibility role without falsely
  reporting `ready` after the tunnel dies.
- The production process fixture prepends an isolated fake `ssh` only to the
  child bridge. It creates genuine Unix-socket proxy tunnels to two fake Herdr
  servers that reuse `shared-workspace`, starts both concurrently, kills alpha,
  observes `reconnecting` and a new generation/process, and proves beta remains
  ready and routable throughout. It also proves authentication failure does
  not retry, legacy SSH exit becomes error without retry, and SIGTERM removes
  surviving child processes and forwarded sockets.
- Final runtime review first found replacement retry intent surviving rollback,
  missing legacy exit wiring, and duplicate cleanup during pending startup.
  Retry state is now disabled before rollback and re-enabled only for prior
  intent, transport-exit handling is keyed from actual SSH configuration, and
  the manager's single stop task owns cleanup. Regression tests cover all three.
  Runtime re-review `ee299e8f-1390-49f5-8b6a-f87c8f13dd7d`, security review
  `38c4e72c-a9fb-43bd-8a04-27291191200d`, and boundary review
  `0ec5e1ff-3a6d-442a-8d1d-9b0e00cfbd63` returned **PASS**.
- A safe real-OpenSSH smoke exists but is skipped unless
  `HERDR_GUI_LIVE_SSH=1` plus destination and both existing remote socket paths
  are supplied. It preserves strict known-host verification, never starts or
  stops remote Herdr, and cleans only its private local directory. This live
  smoke remains **NOT RUN** in the current environment and is not claimed as a
  pass.
- Final sequential validation after adversarial review passes format, lint,
  both TypeScript checks, 542 tests with zero failures and 1975 assertions
  across 81 files, with the one opt-in live SSH test explicitly skipped. The
  production frontend build transforms 2087 modules and retains only the
  existing large-chunk advisory.
- M6 is **Complete**. M7 retains active-resource limits, optional background
  policy, idle cleanup, broader operational diagnostics, and documentation.

### PageUp/PageDown fullscreen TUI routing fix

- Full physical PageUp/PageDown keeps the existing `rows - 2` viewport size but
  now sends `source: "page-key"`. The thin-client wire encoder emits Herdr's
  `AttachScrollSource::PageKey` plus the original PageUp/PageDown escape bytes,
  so Pi fullscreen receives a page-key scroll rather than one synthesized mouse
  wheel event. Ordinary wheel input remains `source: "wheel"`.
- Alt+Page half-page behavior deliberately remains wheel-routed pending a
  separate semantic decision; it is not represented as a physical full-page
  key. Unit tests cover full/half source selection and exact PageKey wire bytes.
  Focused review `b0f25296-5f66-49d2-b094-99595c6a3044` returned **PASS**. A
  live fullscreen Pi browser smoke remains **NOT RUN** because the browser
  automation daemon is unavailable.

### Post-M6 adversarial review and hardening

- A five-lane fresh-context review covered lifecycle/generation races,
  routing/security, SSH/profile persistence, frontend isolation/UI, and test
  quality. A second and third focused pass re-reviewed every accepted fix.
- `ConnectionManager` now installs start, stop, and manager-wide shutdown tasks
  before publishing synchronous status callbacks. Reentrant stop-on-connecting,
  start-on-stopping, and peer start during `stopAll()` can no longer escape
  lifecycle serialization.
- One SSH failure consumes exactly one retry attempt even when the child exits
  after socket creation but before the functional probe completes. Suppression
  is bound to the manager's advanced reconnecting generation rather than timer
  presence, including the ordering where the retry timer fires before the old
  probe rejects.
- Failed update rollback no longer claims the old in-memory profile when writing
  the old registry back failed. The service keeps the last known durable
  replacement, retires its routing, and disables further persistent mutations
  until restart/repair. Create and default-change rollback failures likewise
  return aggregate errors and enter degraded mutation-disabled mode.
- SSH cleanup now rejects and preserves owned socket paths/private directories
  when process exit cannot be confirmed after graceful and signal-9 deadlines.
  Bounded stderr retains the final 16 KiB rather than the prefix, so a late
  authentication or host-key diagnostic cannot be hidden by a long banner.
  Legacy CLI/environment SSH also receives control and render protocol probes
  before being reported ready.
- Herdr one-shot and subscription NDJSON lines are bounded. One-shot replies and
  subscription acknowledgements must match their request IDs and contain
  exactly one result/error kind; subscription acknowledgement has a timeout.
- Browser WebSockets remain `connecting` until one valid exclusive hello and
  reconnect on a silent/malformed hello. Known capability fields require
  booleans. The bridge rejects browser WebSocket Origins whose authority does
  not match the request while retaining missing-Origin non-browser clients;
  reverse proxies must preserve the public `Host` authority.
- Existing unscoped single-connection localStorage values are copied once into
  the first real profile before its React tree mounts. Existing target values
  are never overwritten, dynamic diff selections are included, and a marker
  prevents cleared preferences from being re-imported later.
- Terminal/event/clipboard pushes now validate complete DTO shape at the API
  boundary, malformed base64 terminal frames are dropped without throwing,
  global RPC methods reject misleading connection identity fields, and both
  physical PageUp and PageDown wire branches are covered.
- Connection selector feedback and worktree-hook saves now carry request/scope
  guards, preventing A-to-B or close/reopen completions from mutating the new
  dialog/selection state.
- Production process fixtures now bind port zero and consume the bridge's
  reported actual port instead of releasing a reserved ephemeral port before
  child startup. Their stdout is continuously drained, and the SSH fixture's
  outer timeout exceeds its bounded local waits.
- Initial review run IDs were `2dbbb780-1fde-44ae-9358-d5e2a16c93fd`,
  `e157062a-bb3b-45a8-92f6-55776d0bea12`,
  `347b2544-6a7b-4734-a333-e1ffa3bf3d22`,
  `59693ac5-5cdb-4609-a1b5-aaeba699a6c2`, and
  `4cd0e281-c37f-4e4d-a65d-24c01523a7a7`. Focused validation then found and
  drove fixes for timer-fired retry cancellation and the global one-time
  storage marker. Final re-reviews `5d24b3bb-8b98-4b97-90f2-16aede5a53fc`
  and `4e49ddde-78b4-46e9-bde4-67f0b943e23f` returned **PASS** with no
  blocker.
- Findings intentionally deferred as outside this change's established model:
  aggregate resource and subprocess-output limits remain M7 work; explicit
  generation omission remains bounded old-client compatibility; arbitrary
  absolute file previews and no-password loopback operation remain documented
  privileged single-user behavior. Real browser, real SSH, and fullscreen Pi
  smoke tests remain **NOT RUN**, not claimed passes.
