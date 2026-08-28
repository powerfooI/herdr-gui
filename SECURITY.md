# Security Policy

## Supported Versions

Security fixes are provided for the latest released version.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
private security advisory feature and include affected versions, reproduction
steps, and expected impact. If private advisories are unavailable, contact the
maintainer through the address listed on their GitHub profile.

## Trust Model

Herdr Studio is a privileged local administration tool. A connected browser can
interact with terminal sessions, run repository hooks, read session data, and
upload or delete workspace files. Anyone who can access the UI should be
treated as having the same authority as the user running Herdr Studio.

The server binds to `127.0.0.1` by default. Do not expose it directly to the
public internet. When binding to a non-loopback address:

- Set a strong `HERDR_GUI_PASSWORD`.
- Prefer `HERDR_GUI_PASSWORD` over the `--password` flag so the password is not
  exposed in process arguments.
- Put the service behind HTTPS or a trusted VPN.
- Restrict network access with a firewall or reverse proxy.
- The bridge performs no browser-origin or request-host checks. Any request
  that reaches the listener (and, when required, passes authentication) has
  full authority over the GUI. Secure the access path yourself: terminate TLS
  at a trusted reverse proxy or VPN, keep the listener off untrusted networks,
  and use a strong password.
- Treat worktree hook configuration as executable code.

The built-in password protects application access but does not provide TLS,
rate limiting, multi-user authorization, or sandboxing.

Automatic updates trust the configured HTTPS release origin (or an explicitly
configured loopback test mirror) and its published manifest/checksum assets. Checksums detect corruption and bind the selected
archive, but they are not an independent publisher signature. Treat a custom
update mirror as trusted executable-code infrastructure.
