# Repository Guidelines

## Project Structure & Module Organization

This repo contains a Bun-powered bridge and a React/Vite frontend for Herdr.
Frontend code lives in `web/src`, with reusable UI under `web/src/components`,
assets under `web/src/assets`, and global styling in `web/src/styles.css`.
Server and bridge code lives in `server/src`. Release helpers live in `scripts/`.
Generated build output belongs in `server/public`, `server/src/public-files.gen.ts`,
`server/herdr-gui*`, and `dist/`; these paths are ignored and should not be
committed.

## Build, Test, and Development Commands

- `bun run dev:web`: start the Vite frontend on port 5173.
- `bun run dev:server`: start the Bun bridge with hot reload.
- `bun run build`: build frontend assets and the default standalone server binary.
- `bun run build:linux-x64`: build the Linux x86-64 standalone binary.
- `bun run build:darwin-arm64`: build the macOS Apple Silicon binary.
- `bun run package:linux-x64`: build and emit both versioned and latest `tar.xz`
  archives and checksums in `dist/`.
- `bun run package:linux-arm64`, `package:darwin-x64`, and
  `package:darwin-arm64`: package the other supported release targets.
- `bun run format`: format supported files with the pinned root Biome config.
- `bun run format:check`: verify that all supported files are formatted.
- `bun run lint`: lint all TypeScript and React code.
- `bun run test`: run the Bun unit test suite.
- `cd web && bun run typecheck`: run frontend TypeScript checks.
- `cd server && bun run typecheck`: run server TypeScript checks.

## Coding Style & Naming Conventions

Use TypeScript, React function components, and the existing CSS class naming
style. Format supported files with the root `biome.json`; do not rely on a
global or editor fallback formatter. Prefer small, focused components in
`web/src/components`. Keep manual edits ASCII unless the file already uses
non-ASCII text. Use existing store and bridge helpers before adding new
abstractions.

## Testing Guidelines

Unit tests live beside their modules as `*.test.ts` and use `bun:test`. Run
`bun run format:check`, `bun run lint`, `bun run typecheck`, and `bun run test`
before committing. For
frontend-facing work, also run `cd web && bun run build`. Release work must
package and inspect every supported platform archive and checksum.

## Commit & Pull Request Guidelines

Git history uses concise imperative messages, for example `Use built-in CLI
argument parser` or `Add command palette and release 0.0.3`. Keep commits
focused and mention user-visible behavior in the message when relevant. PRs
should include a short summary, verification commands, and screenshots for UI
changes.

## Release & Changelog Notes

Keep `CHANGELOG.md` concise: summarize user-visible highlights and important
fixes only. Before every release, update `CHANGELOG.md`, commit the code, then
build and publish release archives. Public releases are created from `v*` tags
by `.github/workflows/release.yml`.
