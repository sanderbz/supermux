# supermux

A from-scratch Rust + TypeScript rewrite of amux — the Claude Code session
multiplexer. One `cargo build` produces a single self-contained binary
(`supermux-server`) that embeds the built web app and serves the whole product.

- **Backend** — Rust (`axum` + `tokio` + `rusqlite`), in `server/`.
- **Frontend** — TypeScript + Vite PWA, in `web/`.
- **Architecture & milestones** — see [`plan/TECH_PLAN.md`](plan/TECH_PLAN.md).

## Quickstart (development)

Prerequisites: `cargo` (rustup), `bun`, and `tmux`.

```bash
scripts/dev.sh        # runs the Rust backend + Vite dev server with hot-reload
```

The backend listens on `127.0.0.1:8823` by default and serves the API; Vite
serves the frontend with hot module reload. Configuration is resolved in this
order (see `server/src/config.rs`):

1. `SUPERMUX_DATA_DIR` env var — data directory (default `~/.supermux`).
2. `<data_dir>/config.toml` — optional partial overrides (`bind`, `auth_token`, …).
3. `SUPERMUX_BIND` env var — overrides the bind address (e.g. `:0` in tests).

On first start the server generates an auth token at `<data_dir>/auth_token`
(mode `0600`). All API routes require `Authorization: Bearer <token>` —
**there is no localhost bypass**. The single public, unauthenticated route is
`GET /api/health`, used by deploy verification.

## Production build

```bash
scripts/build.sh      # bun build -> embed into server/static -> cargo build --release
```

Produces `server/target/release/supermux-server`. The binary embeds `web/dist`
via `rust-embed`, so it has no runtime asset dependencies. Expect a ~30–60 MB
stripped binary given the dependency set.

## Deploy (clawd-02, side-by-side with v2)

```bash
scripts/deploy.sh     # SUPERMUX_DEPLOY_HOST=clawd-02 by default
```

`deploy.sh` rsyncs the source to the host, builds **natively** there
(clawd-02 is `aarch64` Linux — no cross-compilation), installs
`/usr/local/bin/supermux-server` and the systemd unit
[`etc/systemd/supermux.service`](etc/systemd/supermux.service), runs
`systemctl daemon-reload && enable && start supermux`, and exposes supermux over
Tailscale.

### Coexistence with v2 (TECH_PLAN §8.4)

supermux runs **alongside** the old amux v2 with zero overlap until supermux is
dogfooded:

| | service | data dir | internal bind | public (Tailscale) |
|---|---|---|---|---|
| **v2** | `amux.service` | `~/.amux` | `:8822` | `clawd-02…ts.net` (8822) |
| **supermux** | `supermux.service` | `~/.supermux` | `127.0.0.1:8824` | `:8823` (`tailscale serve`) |

> v2's TLS cert helper already binds loopback `:8823`, so supermux binds an
> internal loopback port (`8824`, pinned via `~/.supermux/config.toml`) and
> `tailscale serve --https=8823` terminates TLS on the documented public port
> 8823, proxying to the internal port. Separate data dir + separate internal
> port ⇒ no conflict; v2 is never touched.

Verify after deploy:

```bash
# supermux — public, no token needed
curl -sf https://clawd-02.<tailnet>.ts.net:8823/api/health
# v2 — still serving
curl -sk https://clawd-02.<tailnet>.ts.net/
journalctl -u supermux -n 50
```

## Migration from v2

See [`scripts/migrate-v2.py`](scripts/migrate-v2.py) (milestone M26) — copies
v2 sessions, board issues, schedules, skills and prefs into the supermux SQLite
DB. Idempotent and dry-runnable.
