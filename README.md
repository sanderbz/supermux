# supermux

**Run a roomful of AI coding agents from one dashboard.** supermux drives real `tmux` sessions — local and remote (over SSH) — running Claude Code, Codex, plain shells, anything. A live web UI lets you watch, steer, and switch between dozens at once. One Rust binary; the PWA is embedded. No Node, Docker, or Python at runtime.

<p align="center">
  <video src="https://github.com/sanderbz/supermux/raw/main/docs/showcase/supermux-showcase.mp4" autoplay loop muted playsinline width="900">
    <img src="docs/showcase/supermux-showcase.gif" alt="supermux in action" width="900">
  </video>
</p>

<p align="center"><em>Every tmux session at a glance. Hover a tile for a live peek, type without leaving the overview, click to zoom into focus mode, jump anywhere with ⌘K. Same dashboard on your phone.</em></p>

---

## Why supermux

If you've spun up three Claude sessions in three terminals and wished you could *see* them all without `⌘+\`-juggling tabs, this is that. One self-hosted process that:

- Watches every tmux pane with sub-second-fresh previews.
- Lets you jump full-screen into any one with keyboard-captured terminal input.
- Survives reboots — sessions live in tmux, not in supermux.
- **Spans machines** — any host you can `ssh` into shows up next to local sessions.
- Runs the **same UI on your phone** as on your desktop.

## Features

### See everything, jump anywhere
- **Live overview** with color-true terminal previews. Refresh tiers: 1s for hot-active sessions, 2s for the rest active, 4s idle, 5s waiting.
- **Focus mode**: keyboard-captured xterm.js on desktop, a detented bottom sheet on mobile. ⌘1..9 jumps instantly between sessions.
- **⌘K command palette**: fuzzy search across sessions, board issues, slash-commands, MCP tools, and Claude Code skills.
- **Full scrollback on every attach** — a fresh tab gets the same history tmux is still holding.
- **Hover-tile menu** — Stop, Archive, Info — without leaving the overview.

### Remote hosts over SSH
- Register any reachable machine (Tailscale, VPN, public DNS, reverse tunnel) under **Settings → Hosts**. supermux multiplexes one SSH ControlMaster per host.
- **One-click bootstrap** installs the `authorized_keys` entry and verifies each prereq.
- New sessions can target any host from the same sheet; remote tiles wear a discreet badge.
- The host registry soft-deletes, so historical tiles still resolve.

### Agent Teams
- When an agent spawns a team, supermux detects the lead + members and groups them into one **TEAM CARD** at the top of the grid.
- One-click **convert** turns any existing session into a team in place.
- Per-team width (Compact / Standard / Wide / Full).
- Focus mode gets a team strip on the left — tap a teammate for a read-only live view.

### Custom groups + per-group sort
- Drag-and-drop **groups** in the overview (dnd-kit).
- Six **sort modes** per group: Smart / Custom / Name / Status / Recent / Age. Persisted server-side and synced across devices over SSE.
- Hover the gap between two rows on desktop for an inline **+ Add group**; or press `g n`; or use the palette.
- Click-vs-drag threshold (short click opens the session, drag picks up). 700ms drop-flash + insertion line.
- The desktop focus mode's session strip is group-aware — mirror the overview, or set a custom override for the strip.

### Edit your prompt in a real textarea
- ✎ Edit in the dock lifts whatever you've typed at Claude's `❯` prompt into a browser-native textarea — iOS selection handles, autocorrect, dictation, paste-over-select.
- **Send** writes back and submits. **Done** writes back so you can send when ready.
- Mobile gets a full-page edit surface with proper safe-area handling.
- No scraping, no keystroke replay. supermux bridges `$EDITOR` to Claude Code's own `chat:externalEditor` (Ctrl+G), which owns the serialize→edit→deserialize contract.

### Mobile-first
- **Swipe-up session switcher** — a horizontal strip of pills above the lower bar.
- Always-visible ✎ Edit pill (no keyboard-gated affordances).
- Full-page edit surface that dims the terminal behind it.
- iOS PWA cold-launch fixes, sheet/keyboard race fixes, drag-handle dead space removed.
- Same web app, installable on any device.

### The rest
- **Inline session rename** — live tmux rename + pty survival, no terminal loss.
- **Live git status per session** — branch, dirty, ahead/behind — on demand in the info panel.
- **Board** — session-scoped issue tracker. Sessions can comment, mark issues done, attach commits, or ask for input via per-session hook tokens.
- **Scheduler** — cron + `every Nm/Nh` jobs with a live list and an iCal feed.
- **Push notifications** when an agent needs you. Per-category mute: waiting / finished / stopped / schedule-error.
- **Files** — path-jailed browser + editor.
- **MCP & Skills** in the command palette — toggle MCPs per session, tap-activate skills.

### Built for self-hosting
- **Single binary** — `rust-embed` ships the frontend inside; one file plus a SQLite database.
- **Auth by default** — every API route requires a bearer token. No localhost bypass. Token at `~/.supermux/auth_token` (mode `0600`).
- **systemd-sandboxed** — runs as a dedicated unprivileged user with `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, restricted address families, `ReadWritePaths` scoped to the data dir + your project dirs.
- **Tmux survival** — the tmux socket lives in the persistent data dir, so sessions outlive supermux restarts.

## Supported platforms

- **Linux** — `x86_64` and `aarch64` (primary deploy target).
- **macOS** — Apple Silicon and Intel (development + local self-host).
- **Windows** — not supported. supermux relies on Unix-only primitives (`tmux`, ptys, SIGWINCH, Unix domain sockets). WSL2 works as a Linux host.

Toolchain floor: `rustc 1.83` (see `server/Cargo.toml`'s `rust-version`) and a recent `bun` 1.x. `tmux` is a runtime requirement, and [Claude Code](https://code.claude.com/docs/en/setup) (the `claude` CLI) is the runtime dependency for the default agent provider — `deploy.sh` checks for it and can install it for you (`SUPERMUX_INSTALL_CLAUDE=1`).

## Quickstart — deploy

**Run this from your workstation, not on the server.** `deploy.sh` deploys *over SSH* to a separate Linux host: it ships the code, builds natively there, and installs the service. The machine you run the command from is your control box; the machine you point `SUPERMUX_DEPLOY_HOST` at is the target.

```bash
bash scripts/setup.sh     # friendly wizard, ~30 seconds (run on your workstation)
bash scripts/deploy.sh    # ships over SSH, builds natively on the target host, starts the service
```

The wizard asks the handful of values `deploy.sh` needs (SSH host, service user, ports, Tailscale) with smart defaults — hit Enter through it for the common case. Or set `SUPERMUX_DEPLOY_HOST=user@host` and run `scripts/setup.sh --yes` for a non-interactive deploy.

**Sitting on the box you want supermux to run on?** Deploying onto the current machine isn't a first-class flow yet — the wizard always asks for an SSH target. For local *development*, use [`scripts/dev.sh`](#quickstart--develop). For a real same-host deploy, point `SUPERMUX_DEPLOY_HOST` at an SSH alias for that box (needs `sshd` running plus key auth to itself).

**Push notifications (optional):** the PWA's iOS push works out of the box with a placeholder VAPID contact. To use your own `mailto:`, set `push_sub = "mailto:you@your-domain"` in `~/.supermux/config.toml`, or export `SUPERMUX_PUSH_SUB`. Settings → Notifications has a Send test button to confirm delivery.

**In-UI updates (v0.3.0+):** Settings → Updates polls GitHub for new
releases and offers a 1-click upgrade with live SSE progress and auto-
rollback on failure — the same `git fetch + reset + build + install +
verify` pipeline as `scripts/deploy-self.sh`, just exposed as a button. A
preflight refuses unsafe upgrades (dirty working tree, unpushed commits,
detached HEAD, missing tools, low disk) and the manual command is shown
when the install isn't systemd+path-unit (bare binary, dev, docker).

## Quickstart — develop

Prerequisites: `cargo` (rustup), `bun`, and `tmux`.

```bash
scripts/dev.sh        # Rust backend + Vite dev server with HMR
```

Backend on `127.0.0.1:8823`; Vite serves the frontend. The server generates `~/.supermux/auth_token` (mode `0600`) on first start; all API routes need `Authorization: Bearer <token>` — no localhost bypass.

## Architecture

- **Backend** — Rust (`axum` + `tokio` + `sqlx`/SQLite), in `server/`.
- **Frontend** — TypeScript + React + Vite PWA, in `web/`.
- **Process model** — single binary; tmux runs out-of-process on a persistent socket so sessions survive restarts.
- **Live data path** — WebSockets for terminal pty streams (binary frames); SSE for everything else (session lists, status, board, push, alerts).

Module map and protocol details: [`ARCHITECTURE.md`](ARCHITECTURE.md).

<details>
<summary><strong>Deploy guide — the full reference</strong></summary>

`scripts/deploy.sh` runs from your workstation and ships a pinned `git archive` of a clean commit *over SSH* to a remote host (not the machine you run it on), builds natively there (no cross-compilation), installs `/usr/local/bin/supermux-server` plus the systemd unit, and starts the service. It runs an upfront preflight and prints a one-page plan before doing anything destructive.

### Defaults

- **Non-root by default, even from a root SSH session.** Root provisions; the service drops to the unprivileged `supermux` user. Forcing root throws away the systemd sandbox and trips Claude Code's refusal to run `--dangerously-skip-permissions` as uid 0, so it's refused unless you explicitly set `SUPERMUX_ALLOW_ROOT=1`.
- **Service user** defaults to `supermux`. If it doesn't exist, `deploy.sh` provisions it. Pick a non-default name and the script refuses rather than silently creating something unexpected.
- **Project directories** — `SUPERMUX_PROJECT_DIRS` (default `<user-home>/projects`). Under-home dirs just work; outside-home dirs (`/opt/projects`, `/srv/work`, …) are created, `chown -R`'d, and folded into the systemd `ReadWritePaths` so the sandbox permits agent writes.
- **Claude Code (the agent runtime)** — every non-shell session launches the `claude` binary on the service user's PATH, so it's a runtime dependency for the default provider. After provisioning, `deploy.sh` checks whether the service user has `claude` and, when missing, installs it (official native installer — no Node) per `SUPERMUX_INSTALL_CLAUDE` (`ask` = offer interactively, `1` = auto, `0` = warn only). A host without it still deploys, so this is a loud warning, not a hard stop.
- **Service-user Claude login** — supermux uses your Claude subscription (OAuth), never an API key. After confirming the binary, `deploy.sh` checks for `~supermux/.claude/.credentials.json` and offers to copy the deployer's existing login; it verifies before declaring success and prints the exact `sudo -u supermux -i claude` + `/login` command if anything's missing.
- **Tailscale** — auto-detected. If `tailscaled` is running, `deploy.sh` exposes the service via `tailscale serve` on port `443`. Rename once with `sudo tailscale set --hostname=supermux` for the cleanest URL. Override with `SUPERMUX_USE_TAILSCALE=0|1` or `SUPERMUX_PUBLIC_PORT`.
- **Toolchains** — `bun` and `cargo` are required (native build). `SUPERMUX_INSTALL_TOOLCHAINS=1` opts in to automatic install via the official `bun` + `rustup` installers; otherwise missing toolchains are a hard error with manual instructions. When opted in, `deploy.sh` first provisions the system build prerequisites (`unzip` for the bun installer, plus a C toolchain, `pkg-config`, OpenSSL headers and `cmake` for the rust release build) using the host's package manager (apt/dnf/apk/pacman), so a truly fresh minimal box is turnkey.

### TLS

The service binds `127.0.0.1` and speaks plain HTTP. Put it behind TLS one of two ways:

1. **Reverse proxy** (nginx, Caddy) terminating at `http://localhost:<SUPERMUX_INTERNAL_PORT>` (default `8824`). See **WebSocket origins** below — a proxied hostname usually needs an `extra_origins` entry.
2. **`tailscale serve`** — set `SUPERMUX_USE_TAILSCALE=1` and `deploy.sh` runs `tailscale serve --https=<SUPERMUX_PUBLIC_PORT>` to terminate TLS and proxy to the loopback port.

### WebSocket origins

supermux checks the browser's `Origin` header on every WebSocket upgrade and closes non-matching connections with code `1008 "origin not allowed"` (you'll see `ws closed code=1008 reason=origin not allowed` in the browser console, and the UI never goes live). The built-in allowlist covers `localhost`, `127.0.0.1`/`::1`, private-LAN IPv4 ranges (`10/8`, `172.16/12`, `192.168/16`, and link-local), `*.ts.net` (Tailscale), and the server's own bind address.

If you reach supermux by a **hostname that isn't one of those** — a reverse-proxy domain, or an internal DNS name that resolves to a private IP (`supermux.corp.example`, `box-12.internal.example`) — the browser sends that hostname as the `Origin`, the allowlist misses it, and the WebSocket closes with `1008`. This is the common snag for non-Tailscale deployments. Add the browser-facing hostname(s) to `extra_origins` in `~/.supermux/config.toml`:

```toml
bind = "0.0.0.0:8824"
extra_origins = ["supermux.corp.example", "box-12.internal.example"]
```

Exact host match only (no wildcards); the scheme and port are ignored, only the host part of the `Origin` is compared. Restart the service after editing (`systemctl restart supermux`).

### HOME and DATA_DIR are separate

The systemd unit's `WorkingDirectory` and `$HOME` point at the service user's actual login home (so agent caches like `.claude/`, `.cache/`, `.bash_history` land where they're expected). The data dir (`~/.supermux`) is a sibling and holds only supermux state — SQLite DB, auth token, `config.toml`, uploads. Backing it up or wiping it never touches shell history or agent caches.

### Verify

```bash
curl -sf http://127.0.0.1:<SUPERMUX_INTERNAL_PORT>/api/health
journalctl -u supermux -n 50
```

Public routes are `/api/health`, the PWA shell (manifest / service worker / icons), and the board iCal feed. Everything else needs the bearer.

</details>

## License

MIT — see [`LICENSE`](LICENSE).
