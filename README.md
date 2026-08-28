# Herdr Studio

A minimal **web client** for [Herdr](https://herdr.dev). It connects to a
running Herdr server through its local socket API and provides a browser and PWA
dashboard for workspaces, tabs, panes, terminals, agents, files, and diffs.

> **Note:** Herdr Studio was formerly named `herdr-gui`. The command-line
> binary, release archives, and on-disk configuration paths still use the
> `herdr-gui` name; only the product branding has changed.

## Documentation

- [Feature tour and keyboard shortcuts](./FEATURES.md)
- [Installation, configuration, services, and builds](./docs/DEPLOYMENT.md)
- [Architecture and implementation](./docs/ARCHITECTURE.md)
- [Security guidance](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

## Screenshots

> These screenshots predate the product rebrand, so their header still shows
> `herdr-gui`. The current application header reads **Herdr Studio**; the
> illustrated layout and behavior are unchanged.

### Desktop

[![Desktop workspace with a live terminal and session inspector][desktop-session]][desktop-session]

Workspace terminal with live agent and session inspection.

<!-- markdownlint-disable MD033 -->

<table width="100%">
  <thead>
    <tr>
      <th width="33.33%" align="center">File explorer</th>
      <th width="33.33%" align="center">Diff viewer</th>
      <th width="33.33%" align="center">Command palette</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-gui-desktop-finder.png"><img src="./docs/images/herdr-gui-desktop-finder.png" alt="Desktop file explorer" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-gui-desktop-diff-viewer.png"><img src="./docs/images/herdr-gui-desktop-diff-viewer.png" alt="Desktop diff viewer" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-gui-desktop-terminal.png"><img src="./docs/images/herdr-gui-desktop-terminal.png" alt="Desktop terminal with the command palette open" width="100%" /></a>
      </td>
    </tr>
  </tbody>
</table>

### Mobile

<table width="100%">
  <thead>
    <tr>
      <th width="33.33%" align="center">Workspaces and agents</th>
      <th width="33.33%" align="center">Full terminal control</th>
      <th width="33.33%" align="center">File explorer</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-gui-mobile-workspaces.png"><img src="./docs/images/herdr-gui-mobile-workspaces.png" alt="Mobile workspace and agent list" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-gui-mobile-terminal.png"><img src="./docs/images/herdr-gui-mobile-terminal.png" alt="Mobile terminal" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-gui-mobile-finder.png"><img src="./docs/images/herdr-gui-mobile-finder.png" alt="Mobile file explorer" width="100%" /></a>
      </td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-enable MD033 -->

Click any screenshot to open the full-resolution image.

[desktop-session]: ./docs/images/herdr-gui-desktop-session-inspect.png

## Quick start

Herdr must already be installed and running. On Linux and macOS, install the
latest standalone Herdr Studio binary with:

```bash
curl -fsSL \
  https://github.com/powerfooI/herdr-studio/releases/latest/download/install-herdr-gui.sh \
  | sh
```

Make sure `~/.local/bin` is in `PATH`, then start the application:

```bash
herdr-gui
```

Open the URL printed by the process. Windows x64 and ARM64 archives are
available from the [latest release](https://github.com/powerfooI/herdr-studio/releases/latest).
See the [deployment guide](./docs/DEPLOYMENT.md) for checksum verification,
fixed-version installation, authentication, remote connections, updates, and
user-service setup.

## Install as a PWA

For day-to-day use, install Herdr Studio as a standalone web app after starting
and authenticating with `herdr-gui`:

- **iPhone or iPad (Safari):** **Share** -> **Add to Home Screen**.
- **macOS (Safari 17+):** **File** -> **Add to Dock**.
- **Chrome or Edge:** choose **Install app** from the browser menu.

The installed app still requires the `herdr-gui` process to be running and
reachable; PWA mode does not provide offline access.

## Development

Source builds require [Bun](https://bun.sh) 1.4 or newer. Start the bridge and
frontend in separate terminals:

```bash
bun install
(cd web && bun install)
(cd server && bun install)

bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
validation commands and pull request guidelines.

## Security

Herdr Studio can control terminal sessions and modify workspace files. Keep the
default loopback binding unless you understand the trust boundary. Read
[SECURITY.md](./SECURITY.md) before exposing the service to another device.

## License

The project code is available under the [MIT License](./LICENSE). Bundled fonts
and brand assets retain their original terms; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
