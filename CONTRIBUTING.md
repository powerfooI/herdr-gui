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

## Pages Website and Tutorial

The landing page lives in `site/`. The tutorial has one canonical
source, `docs/TUTORIAL.md`; `scripts/build-pages.ts` renders it into the
`site/tutorial/index.html` template, rewrites shared screenshots and reference
links, and validates local links and fragments throughout the built site.
Do not duplicate the tutorial body in the HTML template.

```bash
bun test scripts/pages-content.test.ts
bun run build:site
```

Serve `.pages-dist/` with a local static HTTP server and open `/tutorial/`.
Also check deployment beneath the `/herdr-studio/` Pages subpath, narrow-screen
layouts, keyboard navigation, and reading with JavaScript disabled. Generated
`.pages-dist/` files must not be committed. The Pages workflow rebuilds when
the tutorial source, renderer, template, or shared website assets change.

## Pull Requests

Keep commits focused and use short imperative commit messages. Describe the
user-visible behavior, verification performed, and compatibility impact.
Include screenshots for interface changes. Avoid committing generated
artifacts from `dist/`, `server/public/`, or compiled binaries.

Pull requests without a release-note category label are labeled automatically:
documentation-only changes become `documentation`, dependency updates become
`dependencies`, fix-oriented titles become `bug`, and other code changes become
`enhancement`. Release preparation PRs receive `skip-changelog`. Add one of the
categories from `.github/release.yml` before merging to override the automatic
choice.

By contributing, you agree that your contribution is licensed under the MIT
License.
