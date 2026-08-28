# Architecture and Implementation

This document describes the main design boundaries in Herdr Studio. For
user-facing behavior, see [FEATURES.md](../FEATURES.md). For operational setup,
see [DEPLOYMENT.md](./DEPLOYMENT.md).

## System overview

Browsers cannot open Unix domain sockets or Windows named pipes directly, so a
small local bridge sits between the browser and Herdr:

```text
Browser (React + Vite)
   |  WebSocket (JSON RPC and pushed events)
   v
Bridge (Bun + TypeScript)  -- node:net protocols --> Herdr sockets
```

The bridge serves the built frontend, authenticates browser sessions, and maps
browser requests onto Herdr's two socket protocols:

- `herdr.sock` carries the NDJSON control API.
- `herdr-client.sock` carries the bincode thin-client render protocol.

For control operations, the frontend sends a request shaped like
`{ id, method, params }`. The bridge forwards it to Herdr and returns either
`{ id, result }` or `{ id, error }`. Events received after
`events.subscribe` are pushed to connected browsers as `{ event: ... }`.
Terminal rendering uses Herdr's server-rendered ANSI stream at the browser's
current rows and columns rather than recreating terminal state in the bridge.

## Runtime responsibilities

The Bun bridge owns capabilities unavailable to a normal browser:

- Herdr control and render socket access;
- local and SSH-backed connection lifecycle;
- file, Git, worktree, hook, and session-record operations on the Herdr host;
- terminal stream and clipboard relay;
- authentication, health checks, updates, and static assets.

The React application owns presentation and browser-local state, including the
selected connection, open interface panels, recent panes, appearance settings,
and mobile controls. WebSocket events keep multiple authenticated browsers in
sync with server-side Herdr state, while each browser retains its own view and
connection selection.

## Connection isolation

One bridge may manage multiple existing Herdr servers. Profiles are shared by
all authenticated browsers, but each browser displays one connection at a time.
A bridge-global `ConnectionManager` owns the profile store and independent
`ConnectionRuntime` instances:

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

Each runtime owns its Herdr clients, terminal viewers, clipboard relay,
subscriptions, reconnect lifecycle, downstream services, and transport. These
resources are not shared between connections.

Connection-scoped traffic carries both an immutable connection ID and a runtime
generation. A generation changes when a runtime is replaced or its transport is
retired. This prevents delayed replies, event callbacks, stream chunks, or
cached metadata from an old runtime from being published into a new one.

Bridge-global methods handle authentication, health, updates, client accounting,
and profile management. Downstream RPC and HTTP operations require a ready
runtime lease. Explicit malformed, unknown, stale, or not-ready identities fail
without falling back to another connection.

The complete lifecycle, routing, persistence, security, and validation contract
is documented in
[Multi-Herdr Connections](./multi-herdr-connections-implementation.md).

## SSH transport

An SSH runtime launches a supervised OpenSSH process and forwards the remote
control and render sockets into a private temporary directory. Startup succeeds
only after both the control `ping` and render-protocol handshake complete.
Transient transport failures use bounded backoff; authentication, host-key, and
permanent protocol failures do not retry.

The destination is restricted to an OpenSSH alias or `user@host`. Ports, jump
hosts, identities, agent use, and Keychain behavior remain in the service user's
normal OpenSSH configuration. Herdr Studio does not store credentials or accept
arbitrary SSH command options.

Remote file operations, image paste, Git commands, worktree hooks, and supported
session inspection run through the same connection runtime. This keeps their
host boundary aligned with the Herdr server selected by the browser.

## Distribution model

Production builds compile the Bun bridge and embedded frontend into a single
platform executable. This is the supported distribution model: users do not
need Bun, Node.js, or a separate static web server.

An npm package could use either of two different designs:

- A **Node-native package** would let `npx herdr-gui` run under the user's Node
  runtime, but it would require porting `Bun.serve`, `Bun.spawn`, `Bun.file`, and
  `Bun.write` to Node HTTP, WebSocket, process, and filesystem APIs.
- A **binary-wrapper package** could select and run a precompiled platform
  binary. It would not require Bun on the user's machine, but the downloaded
  binary would still embed the Bun runtime.

Therefore, a true Node-only `npx` release is a server-runtime port rather than a
packaging-only change. Standalone executable commands are documented in
[DEPLOYMENT.md](./DEPLOYMENT.md#build-a-standalone-executable).

## Technology stack

- **Bridge:** Bun, TypeScript, and `node:net` for Herdr's NDJSON control and
  bincode render protocols.
- **Web:** Vite, React, and TypeScript.
- **Terminal:** `xterm.js`, displaying Herdr's server-rendered ANSI stream at
  the exact client dimensions.
- **Transport:** same-origin HTTP and WebSocket between the browser and bridge;
  local sockets or supervised OpenSSH forwarding between the bridge and Herdr.

## Trust boundary

Herdr Studio is a trusted, single-user administration tool. A connected browser
can control terminal sessions, modify workspace files, and trigger trusted
repository hooks. The bridge does not provide multi-user authorization,
sandboxing, TLS termination, or rate limiting. Keep it on loopback by default
and read [SECURITY.md](../SECURITY.md) before allowing remote access.
