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
- `bun run package:linux-arm64`, `package:darwin-x64`,
  `package:darwin-arm64`, `package:windows-x64`, and
  `package:windows-arm64`: package the other supported release targets.
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
fixes only, and accumulate entries under `## Unreleased` as changes land.

Cutting a release takes one action, no manual version-bump PR:

- GitHub: run the **Cut Release** workflow from the Actions tab with a version
  (`X.Y.Z` or `patch`/`minor`/`major`). It runs the precommit gates, bumps the
  three `package.json` versions, finalizes the changelog section, lands the
  release commit on `main` through an automated PR that the workflow opens and
  merges itself (branch protection requires PRs on `main`; no protection
  changes or extra secrets are needed), tags the merge commit, and starts the
  Release workflow on the tag.
- Local: `bun run release:cut <X.Y.Z | patch | minor | major>` from a clean
  `main` checkout creates the release commit and tag locally. Pushing them is
  subject to the same branch protection as any other push, so prefer the CI
  path above.

Public releases are built and published by `.github/workflows/release.yml`
from `v*` tags, with release notes taken from the version's `CHANGELOG.md`
section.
