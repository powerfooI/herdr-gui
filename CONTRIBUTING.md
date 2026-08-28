# Contributing

## Development Setup

Install Bun 1.4 or newer, start a local Herdr server, then install dependencies:

```bash
bun install
(cd web && bun install)
(cd server && bun install)
```

Run the bridge and frontend in separate terminals:

```bash
bun run dev:server
bun run dev:web
```

## Validation

Before submitting a change, run:

```bash
bun run lint
bun run typecheck
bun run test
```

Use `bun run build` for changes that affect production assets or server
bundling. Release changes should also validate the relevant
`package:<platform>` command.

## Pull Requests

Keep commits focused and use short imperative commit messages. Describe the
user-visible behavior, verification performed, and compatibility impact.
Include screenshots for interface changes. Avoid committing generated
artifacts from `dist/`, `server/public/`, or compiled binaries.

By contributing, you agree that your contribution is licensed under the MIT
License.
