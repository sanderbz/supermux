# Security Policy

## Threat model & defaults

Know what you're deploying — supermux is a **remote shell with a web UI**:

- **The bearer token is full shell access.** Every `/api` and WebSocket
  endpoint is gated by one dashboard token, and a session terminal executes
  arbitrary commands as the service user. **Possessing the token is remote
  code execution on the host, by design.** Treat it like an SSH private key:
  never share it, never put it in URLs you publish, rotate it (Settings →
  Rotate token) if it may have leaked.
- **Loopback by default.** The server binds `127.0.0.1:8823` (the systemd
  deploy uses loopback port `8824` fronted by `tailscale serve`). Binding to
  `0.0.0.0` or any public interface exposes a shell-access service to the
  network — don't, unless you fully understand the consequences. The
  recommended exposure is **Tailscale-only** (see the README): the service
  stays on loopback and only your tailnet can reach it over HTTPS.
- **Per-session hook tokens.** Agent lifecycle hooks authenticate with
  per-session tokens that are scoped separately from the dashboard token, so
  a leaked hook token does not grant dashboard (shell) access.
- **The iCal feed is unauthenticated.** `/api/calendar.ics` is exempt from
  bearer auth because calendar clients can't send headers. Anyone who can
  reach the server can read board issue titles and due dates from it —
  another reason to keep the service loopback/tailnet-only and never publish
  its URL.
- **systemd sandbox.** The deployed unit runs unprivileged and hardened:
  `NoNewPrivileges`, `ProtectSystem=strict` with an explicit
  `ReadWritePaths` jail, `ProtectHome=tmpfs` (non-root deploys), an empty
  `CapabilityBoundingSet`, `RestrictSUIDSGID`, and a
  `SystemCallFilter=@system-service` profile that drops `@privileged`,
  `@resources` and `@obsolete`. Sessions and agents inherit all of it. An
  opt-in strict profile (`SUPERMUX_HARDENED=1`) additionally enables
  `MemoryDenyWriteExecute` and `PrivateTmp` (at the cost of JIT-based
  tooling and agent survival across restarts — see `etc/systemd/supermux.service`).

## Supported versions

Only the **latest release** and the current `main` are supported. If you're running an older build, pull the latest tag (or `main`) and re-deploy before filing a security report.

## Reporting a vulnerability

Please **don't** open a public GitHub issue. Use GitHub's private vulnerability reporting:

- **[Report a vulnerability](https://github.com/sanderbz/supermux/security/advisories/new)** — preferred.

Include a description, reproduction steps, the commit SHA you tested against, and (if you have one) a suggested fix.

What to expect:

- Acknowledgement within **5 working days**.
- A coordinated-disclosure window of up to **90 days**, extendable by mutual agreement if a fix needs more time.
- Credit in the release notes unless you'd rather stay anonymous.

Thanks for helping keep supermux users safe.
