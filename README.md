# Herdr Studio

A minimal **web client** for [Herdr](https://herdr.dev). It connects to a
running Herdr server through its local socket API and provides a browser and PWA
dashboard for workspaces, tabs, panes, terminals, agents, files, and diffs.

> **Note:** Herdr Studio was formerly named `herdr-gui`. The command-line
> binary, release archives, and on-disk configuration paths still use the
> `herdr-gui` name; only the product branding has changed.

## Documentation

- [Project website](https://powerfooI.github.io/herdr-studio/)
- [Feature tour and keyboard shortcuts](./FEATURES.md)
- [Installation, configuration, services, and builds](./docs/DEPLOYMENT.md)
- [Architecture and implementation](./docs/ARCHITECTURE.md)
- [Security guidance](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

## Screenshots

### Desktop

[![Desktop workspace with a live terminal and session history][desktop-session]][desktop-session]

Workspace terminal with live agent session history.

<!-- markdownlint-disable MD033 -->

<table width="100%">
  <thead>
    <tr>
      <th width="33.33%" align="center">File explorer</th>
      <th width="33.33%" align="center">Diff viewer</th>
      <th width="33.33%" align="center">Full terminal</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-studio-desktop-file-explorer.png"><img src="./docs/images/herdr-studio-desktop-file-explorer.png" alt="Desktop file explorer" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-studio-desktop-diff-viewer.png"><img src="./docs/images/herdr-studio-desktop-diff-viewer.png" alt="Desktop diff viewer" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-studio-desktop-terminal.png"><img src="./docs/images/herdr-studio-desktop-terminal.png" alt="Desktop terminal" width="100%" /></a>
      </td>
    </tr>
  </tbody>
</table>

### Mobile

<table width="100%">
  <thead>
    <tr>
      <th width="33.33%" align="center">Changed files</th>
      <th width="33.33%" align="center">Full terminal control</th>
      <th width="33.33%" align="center">File viewer</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-studio-mobile-changed-files.png"><img src="./docs/images/herdr-studio-mobile-changed-files.png" alt="Mobile changed files viewer" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-studio-mobile-terminal.png"><img src="./docs/images/herdr-studio-mobile-terminal.png" alt="Mobile terminal" width="100%" /></a>
      </td>
      <td width="33.33%" align="center" valign="top">
        <a href="./docs/images/herdr-studio-mobile-file-viewer.png"><img src="./docs/images/herdr-studio-mobile-file-viewer.png" alt="Mobile file viewer" width="100%" /></a>
      </td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-enable MD033 -->

Click any screenshot to open the full-resolution image.

[desktop-session]: ./docs/images/herdr-studio-desktop-session-history.png

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
