# supermux

A self-hosted terminal multiplexer for running many parallel AI coding-agent
sessions (Claude Code, Codex, and any other CLI agent) from one dashboard.

<p align="center">
  <video src="https://github.com/sanderbz/supermux/raw/main/docs/showcase/supermux-showcase.mp4" autoplay loop muted playsinline width="900">
    <img src="docs/showcase/supermux-showcase.gif" alt="supermux in action — overview, peek, type-on-hover, focus, sort + groups, mobile" width="900">
  </video>
</p>

<p align="center"><em>Every tmux session at a glance — hover any tile for a live peek, type without leaving the overview, click for a smooth zoom into focus mode, jump anywhere with ⌘K, and the same dashboard on your phone.</em></p>

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

## Quickstart deploy

The friendly path — one command, a few questions, you're deployed:

```bash
bash scripts/setup.sh     # friendly wizard, ~30 seconds
bash scripts/deploy.sh    # actual deploy
```

`setup.sh` walks you through the handful of values `deploy.sh` needs (SSH host,
service user, ports, optional Tailscale) with smart defaults — hit Enter
through it for the common case. It also detects your environment (does SSH
work? is `tailscale` on the host?) and adjusts defaults. Advanced users can
still hand-edit `.env` directly afterwards, or run the wizard non-interactively
with `bash scripts/setup.sh --yes` (you'll need `SUPERMUX_DEPLOY_HOST` set in
the environment).

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

### Quickstart deploy

For a fresh host where you have key-based SSH and passwordless sudo, the
"set one variable and go" path is:

```bash
cp .env.example .env
$EDITOR .env          # set SUPERMUX_DEPLOY_HOST=<user@host>
bash scripts/deploy.sh
```

`deploy.sh` runs an upfront preflight against the host and prints a one-page
plan before doing anything destructive. The defaults are noob-proof:

- **Non-root by default — even from a root SSH session.** The account you
  *deploy with* (your SSH login, often `root` on a fresh VPS) is **not** the
  account the service *runs as*. Deploying over a root SSH session is fine and
  expected — root provisions (creates the service user, installs the unit) —
  but the service runs as the unprivileged `supermux` user. Running as root
  would throw away the systemd hardening sandbox **and** trip Claude Code's
  refusal to run `--dangerously-skip-permissions` as uid 0, so it is refused
  unless you explicitly force `SUPERMUX_ALLOW_ROOT=1` (a loud, last-resort
  escape hatch — see below).
- **Service user** — defaults to `supermux`. If the user doesn't exist on the
  host, `deploy.sh` fully provisions it for you: `sudo useradd -m -s /bin/bash
  supermux` plus ownership of its home, data dir, and project dirs. If you pick
  a non-default `SUPERMUX_SERVICE_USER`, you must create it yourself (the script
  refuses rather than silently provisioning an unexpected account).
- **Project directories** (where your agents work) — `deploy.sh` provisions the
  dirs the service user needs read+write access to. The default is
  `<user-home>/projects` (e.g. `/home/supermux/projects`), already owned by the
  service user → zero permission fuss. Point `SUPERMUX_PROJECT_DIRS` elsewhere
  (colon-separated) and the script wires it up: dirs under the user's home just
  work; dirs outside it (`/opt/projects`, `/srv/work`, …) are created and
  `chown -R`'d to the service user, then added to the systemd `ReadWritePaths`
  so the sandbox permits the writes.
- **Service-user Claude login** — supermux uses your Claude **subscription**
  (OAuth), never an API key / `ANTHROPIC_API_KEY` / API billing. The service
  user must be logged in. After provisioning, `deploy.sh` checks for
  `~supermux/.claude/.credentials.json`; if it's missing it offers (with your
  consent) to copy the deployer's existing Claude login to the service user —
  the fast path that reuses your subscription. Either way it **verifies** the
  login before declaring success and, if it's still missing, warns loudly with
  the exact command to run: `sudo -u supermux -i claude` then `/login`. Control
  the copy behaviour with `SUPERMUX_COPY_CLAUDE_CREDS` (`ask` / `1` / `0`).
- **ReadWritePaths** — defaults to a sane set covering the data dir, the
  service user's home, the project dirs, and `/opt/projects` (only if that
  directory exists on the host). Override `SUPERMUX_READ_WRITE_PATHS` to scope
  it differently — `deploy.sh` still appends your project dirs so agents can
  always write there.
- **Tailscale** — auto-detected. If the host has `tailscale` installed AND
  `tailscaled` is running, `deploy.sh` defaults to exposing the service via
  `tailscale serve` on port `443`, giving you a clean URL like
  `https://<host>.<your-tailnet>.ts.net/` (no port suffix). For the nicest
  hostname, rename the device once: `sudo tailscale set --hostname=supermux`
  → the URL becomes `https://supermux.<your-tailnet>.ts.net/`. Without
  Tailscale, `deploy.sh` skips this step and you front the loopback port with
  your own reverse proxy. Override with `SUPERMUX_USE_TAILSCALE=0` or `=1`,
  or change the port via `SUPERMUX_PUBLIC_PORT` if `443` is already taken.
- **Toolchains** — `bun` and `cargo` are required on the host (the build is
  native). They are not installed silently. Set
  `SUPERMUX_INSTALL_TOOLCHAINS=1` to opt in to automatic install via the
  official `bun` and `rustup` installers (pinned to your local `bun` version
  and `rustup`'s stable channel) — otherwise a missing toolchain is a hard
  error with manual-install instructions.
- **Running as root (last resort)** — `SUPERMUX_SERVICE_USER=root` is refused
  unless you also set `SUPERMUX_ALLOW_ROOT=1`, which prints a loud warning. This
  is a security + functionality trade-off, not just a hardening knob: the
  systemd sandbox is largely given up (`ProtectHome=false`,
  `ReadWritePaths=/root`) and Claude Code refuses
  `--dangerously-skip-permissions` as uid 0, so your agents may not run. Prefer
  the default unprivileged user — root still runs the deploy, only the service
  drops privileges.

### Configuration reference

The service binds to `127.0.0.1` (a loopback port — `SUPERMUX_INTERNAL_PORT`,
default `8824`) and speaks plain HTTP. Put it behind TLS one of two ways:

1. **Reverse proxy** (recommended for most setups) — terminate TLS with nginx
   or Caddy and proxy to `http://localhost:<SUPERMUX_INTERNAL_PORT>`.
2. **`tailscale serve`** — if your host is on a tailnet, set
   `SUPERMUX_USE_TAILSCALE=1` and `deploy.sh` will run
   `tailscale serve --https=<SUPERMUX_PUBLIC_PORT>` (default `443`) to
   terminate TLS and proxy to the loopback port. Rename the device once with
   `sudo tailscale set --hostname=supermux` for a clean
   `https://supermux.<your-tailnet>.ts.net/` URL.

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

- **Default (unprivileged user) — even from a root SSH session.**
  `SUPERMUX_SERVICE_USER` defaults to `supermux`; the unit renders with
  `ProtectHome=true` and `ReadWritePaths=` set to the smart default (data dir +
  service-user home + project dirs + `/opt/projects` if present). The account
  you SSH in as to deploy is independent of this: root (or any sudo-capable
  login) *provisions* the host, then the service drops to `supermux`. Override
  `SUPERMUX_READ_WRITE_PATHS` (colon-separated) to scope the writable set
  differently, e.g. `SUPERMUX_READ_WRITE_PATHS=/home/supermux:/srv/scratch`.
- **Project directories.** `SUPERMUX_PROJECT_DIRS` (default
  `<user-home>/projects`) is where agents do their work. `deploy.sh` creates
  these and ensures the service user owns them — under-home dirs already are
  owned; outside-home dirs are `chown -R`'d — and folds them into
  `ReadWritePaths` so the sandbox permits agent writes.
- **Claude login (subscription, never API key).** The service user must be
  logged in to Claude with your **subscription**. `deploy.sh` checks for
  `~supermux/.claude/.credentials.json` after provisioning, offers (with
  consent) to copy the deployer's existing login, then verifies — warning loudly
  with `sudo -u supermux -i claude` + `/login` if it's still missing. supermux
  never uses `ANTHROPIC_API_KEY` or API billing.
- **Running as root (last resort).** `SUPERMUX_SERVICE_USER=root` is refused by
  default — not only because `ProtectHome=true` would mask `/root`, but because
  Claude Code refuses `--dangerously-skip-permissions` as uid 0 (agents may not
  run at all). To force it, set `SUPERMUX_ALLOW_ROOT=1`; you'll get a loud
  warning, and `deploy.sh` renders the unit with `ProtectHome=false` and
  `ReadWritePaths=/root`. All other hardening directives (NoNewPrivileges,
  ProtectKernelTunables, PrivateTmp, RestrictAddressFamilies, …) still apply,
  but the user-isolation + Claude trade-offs are on the operator.

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
