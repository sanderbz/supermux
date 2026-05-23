# supermux

A self-hosted terminal multiplexer for running many parallel AI coding-agent
sessions (Claude Code, Codex, and any other CLI agent) from one dashboard.

supermux drives real `tmux` sessions on your machine and exposes them through a
fast web UI: a dense overview of every session with live terminal previews, a
keyboard-captured focus mode on desktop, and a Termius-grade bottom-sheet
experience on mobile. A single `cargo build` produces one self-contained binary
that embeds the web app (a PWA) — no Node, no Docker, no Python at runtime.

- **Backend** — Rust (`axum` + `tokio` + `sqlx`/SQLite), in `server/`.
- **Frontend** — TypeScript + React + Vite PWA, in `web/`.
- **Architecture** — see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Features

- **Live session overview** — a grid of tiles, each showing the last lines of
  its agent's terminal, updated live.
- **Focus mode** — full keyboard-captured terminal (xterm.js) on desktop; a
  detented bottom sheet with an accessory dock on mobile.
- **Board** — a lightweight issue tracker tied to sessions.
- **Files** — a path-jailed file browser + editor.
- **Scheduler** — cron-style scheduled jobs.
- **Single binary** — the release build embeds the frontend via `rust-embed`;
  ship one file plus a SQLite database.
- **Auth by default** — every API route requires a bearer token; there is no
  localhost bypass.

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

## Deploy

`scripts/deploy.sh` ships a pinned `git archive` of a clean commit to a host,
builds **natively** there (no cross-compilation), installs
`/usr/local/bin/supermux-server` and the systemd unit, and starts the service.

It is driven entirely by environment variables. Copy `.env.example` to `.env`
and fill in your values — `deploy.sh` sources `.env` automatically if present:

```bash
cp .env.example .env
$EDITOR .env          # set SUPERMUX_DEPLOY_HOST etc.
scripts/deploy.sh
```

The service binds to `127.0.0.1` (a loopback port — `SUPERMUX_INTERNAL_PORT`,
default `8824`) and speaks plain HTTP. Put it behind TLS one of two ways:

1. **Reverse proxy** (recommended for most setups) — terminate TLS with nginx
   or Caddy and proxy to `http://localhost:<SUPERMUX_INTERNAL_PORT>`.
2. **`tailscale serve`** — if your host is on a tailnet, set
   `SUPERMUX_USE_TAILSCALE=1` and `deploy.sh` will run
   `tailscale serve --https=<SUPERMUX_PUBLIC_PORT>` to terminate TLS and proxy
   to the loopback port.

The committed systemd unit at [`etc/systemd/supermux.service`](etc/systemd/supermux.service)
is a **template** — `deploy.sh` substitutes the service user, the user's login
home, the data directory, and the hardening knobs (`ProtectHome`,
`ReadWritePaths`) from your environment at install time. By default it keeps
the service unprivileged and applies a full set of systemd sandboxing
directives.

**HOME and DATA_DIR are deliberately separate.** The unit's `WorkingDirectory`
and `$HOME` point at the service user's actual login home
(`SUPERMUX_USER_HOME`, derived from the account or `/root`), while
`SUPERMUX_DATA_DIR` (e.g. `~/.supermux`) lives as a scoped sibling of it. This
way the dotfiles that spawned shells and agents (claude, codex, tmux children)
write — `.bash_history`, `.claude/`, `.claude.json`, `.cache/`, `.local/`, … —
land in the conventional place under `$HOME` and do **not** pollute the data
dir. The data dir stays scoped to supermux's own state (SQLite DB, auth
token, `config.toml`, uploads), so backing it up or wiping it never touches
the user's shell history or agent caches.

- **Default (unprivileged user).** `SUPERMUX_SERVICE_USER` defaults to
  `supermux`; the unit renders with `ProtectHome=true` and `ReadWritePaths=`
  scoped to the data dir. If tmux/git/claude need to write outside the data
  dir (multi-project workflows), set `SUPERMUX_READ_WRITE_PATHS` to a
  colon-separated list of extra writable roots — e.g.
  `SUPERMUX_READ_WRITE_PATHS=/home/supermux:/opt/projects`.
- **Root deploys.** `SUPERMUX_SERVICE_USER=root` is refused by default because
  `ProtectHome=true` would mask `/root` and the unit could not chdir to its
  data dir. To opt in, set `SUPERMUX_ALLOW_ROOT=1`; `deploy.sh` then renders
  the unit with `ProtectHome=false` and `ReadWritePaths=/root` so tmux/claude/
  git children can operate in arbitrary subdirs. All other hardening directives
  (NoNewPrivileges, ProtectKernelTunables, PrivateTmp, RestrictAddressFamilies,
  …) still apply, but the user-isolation trade-off is on the operator.

Verify after deploy (the health route is public, no token needed):

```bash
curl -sf http://127.0.0.1:<SUPERMUX_INTERNAL_PORT>/api/health
journalctl -u supermux -n 50
```

Coming from amux v2? See [`scripts/migrate-v2.py`](scripts/migrate-v2.py) — it
copies sessions, board issues, schedules, skills and prefs into the supermux
SQLite database (idempotent, dry-runnable).

## License

MIT — see [`LICENSE`](LICENSE).
