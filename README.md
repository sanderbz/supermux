# supermux

### Claude Code, anywhere. The dashboard for the agentic developer.

Run a roomful of Claude Code agents on your VPS or home server. Watch, steer, and switch between them from your phone or laptop — with native-feeling UI on every device. Your sessions stay alive whether your laptop is open or closed.

<p align="center">
  <video src="https://github.com/sanderbz/supermux/raw/main/docs/showcase/supermux-showcase.mp4" autoplay loop muted playsinline width="900">
    <img src="docs/showcase/supermux-showcase.gif" alt="supermux in action" width="900">
  </video>
</p>

<p align="center"><em>Every Claude Code session at a glance. Hover for a live peek, type without leaving the overview, tap to zoom into focus mode, jump anywhere with ⌘K. Same dashboard on your phone.</em></p>

<p align="center">
  <a href="https://github.com/sanderbz/supermux/releases/latest"><img src="https://img.shields.io/github/v/release/sanderbz/supermux" alt="latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <img src="https://img.shields.io/badge/single--binary-Rust-orange" alt="Rust">
  <img src="https://img.shields.io/badge/runs%20on-Linux%20%7C%20macOS-success" alt="platforms">
</p>

---

## Why supermux

You opened three Claude Code sessions this morning. By lunch it's seven, scattered across iTerm tabs and a stale tmux session you can't remember the name of. You're switching with `⌘+\` like it's 2019. When Claude finishes a long task you only notice ten minutes later. When you leave for coffee you have to keep the laptop open.

That's the problem supermux solves.

- **All your Claude sessions in one view.** Live previews, color-true, sub-second fresh. See who's typing, who's waiting on you, who's idle.
- **Notifications when Claude needs you.** App notification (PWA, real push on iOS) the second Claude asks a question, finishes a task, or stops unexpectedly. Per-category mute.
- **Quick peek + type-in-place.** Hover a tile on desktop or swipe up on mobile to read the latest output and type a reply *without leaving the overview*.
- **Sessions live on your server, not your device.** Run on a VPS, a Raspberry Pi, or your home NAS. Close your laptop. Sessions keep running. Push notifications wake you when they need you.
- **A full harness, not a thin remote.** Start sessions, stop them, restart with a flag, resume an older conversation, rename inline, archive — all from the UI.
- **Native-feeling PWA.** Installs on macOS, Windows, iPhone, Android. iOS gets real push notifications, dictation in the prompt editor, drag-and-drop file uploads on desktop.

## What you can do

### See every agent, jump anywhere
- **Live overview** with color-true terminal previews. Refresh tiers self-throttle: 1 s for hot-active sessions, 2 s for the rest active, 4 s idle.
- **Quick peek** — hover a tile (desktop) or tap a pill (mobile) to read the latest output, type a reply, or hit a quick action without leaving the overview.
- **Focus mode** — tap any tile to zoom into a keyboard-captured xterm.js terminal (desktop) or a detented bottom-sheet (mobile). `⌘1..9` jumps instantly between sessions.
- **⌘K command palette** — fuzzy search across sessions, board issues, slash commands, MCP tools, and Claude Code skills.

### Notifications that find you
- **Real push notifications** when Claude finishes, asks a question, or stops. Works on iOS too — install the PWA, allow notifications, walk away from your machine.
- **Per-category mute** — silence "waiting for input", keep "agent finished" loud, never miss "stopped unexpectedly".

### Stay organized at scale
- **Custom groups** — drag tiles between groups, name them whatever (`production`, `experiments`, `Claude Boy and Friends`).
- **Six sort modes per group** — Smart / Custom / Name / Status / Recent / Age. Persisted server-side, synced across devices.
- **Agent Teams** — when an agent spawns a team, supermux detects the lead + members and collapses them into one TEAM CARD. Convert any session into a team in place.
- **Hide-stopped, view-mode dropdown** — calm the noise on a busy day.

### Pick up where you left off
- **Rich prompt history** — every prompt you sent to a session, searchable, with the assistant's first-line reply paired in. Tabbed: just this session, or the whole project (every Claude Code transcript under this cwd). Press `⌘G` in focus mode.
- **Slash-commands and teammate routings** show up as their own kinds in history with mini badges. Sub-agents and system events available behind toggles.
- **Resume picker** — supermux reads Claude Code's own JSONL transcripts, so any past conversation in this cwd is one tap away from a `claude --resume`.

### Edit prompts in a real textarea
- **✎ Edit** in the dock lifts whatever you've typed at Claude's `❯` prompt into a browser-native textarea: iOS selection handles, autocorrect, dictation, paste-over-select.
- **Done** writes back, you hit Enter when ready. **Send** writes back and submits.
- Mobile gets a full-page edit surface with proper safe-area handling.
- Built on Claude Code's own `chat:externalEditor` (Ctrl+G) bridge — no scraping, no keystroke replay.

### Drag-and-drop uploads
- **Drag a file onto the terminal pane** on desktop — supermux uploads it server-side and pastes the resolved path at Claude's cursor.
- **Native file picker** on mobile, with a tap-to-upload action sheet.
- Image previews, paste-image-from-clipboard, the lot. The thing that always sucks over plain `ssh`.

### Keep Claude working while you're away
- **Scheduler** — cron and "every Nm/Nh" jobs. Schedule a daily `claude --resume` with a prompt. iCal feed. Live job list.
- **Kanban board** — session-scoped issue tracker. Sessions can comment, mark issues done, attach commits, or ask for input via per-session hook tokens. Wire it into your agent flow and let Claude pull its own next task.
- **Schedules and board updates trigger push notifications** when something needs you.

### Reach across machines
- **Add any host you can SSH to** under Settings → Hosts (Tailscale, VPN, public DNS, reverse tunnel). supermux multiplexes one SSH ControlMaster per host.
- **One-click bootstrap** installs the `authorized_keys` entry and verifies prereqs.
- New sessions can target any host from the same sheet; remote tiles wear a discreet badge.

### The rest
- **Inline session rename** — live `tmux` rename + pty survival.
- **Per-session git status** — branch, dirty, ahead/behind — on demand.
- **Files browser** — path-jailed, with an editor.
- **MCP & Skills** in the palette — toggle MCPs per session, tap-activate skills.
- **Mode shift** — flip Claude Code's permission mode (normal / accept-edits / plan / bypass) without a relaunch.
- **In-UI updater** — Settings → Updates. 1-click upgrade with live SSE progress and auto-rollback on failure.

---

## supermux vs. the alternatives

|                                          | **supermux** | Termius (generic SSH/terminal) | Claude Code's built-in remote |
|---|:---:|:---:|:---:|
| Built specifically for Claude Code        | ✅ | ❌ | ✅ |
| Start / stop / restart Claude sessions from the UI | ✅ | ❌ | ⚠️ best-effort |
| Many sessions in one live overview        | ✅ | ❌ (tab/window-based) | ❌ |
| Push notifications when Claude needs you  | ✅ (iOS too) | ❌ | ❌ |
| Resume any past Claude conversation       | ✅ | ❌ | ⚠️ |
| Searchable prompt history per project     | ✅ | ❌ | ❌ |
| Drag-and-drop file upload into the prompt | ✅ | ❌ (pain over SSH) | ❌ |
| Mobile-first UI (real PWA on iOS/Android) | ✅ | ✅ (paid) | ❌ |
| Sessions survive your device being offline | ✅ (tmux on server) | ⚠️ via tmux yourself | ❌ |
| Scheduled prompts / runs                  | ✅ | ❌ | ❌ |
| Kanban issue board agents read & write    | ✅ | ❌ | ❌ |
| Agent teams (multi-agent collaboration)   | ✅ | ❌ | ❌ |
| Self-hosted, MIT, your data on your box   | ✅ | ❌ (proprietary) | ✅ |

**Termius** is a great generic terminal. supermux is a Claude Code *control room* — knows the agent lifecycle, knows when it's waiting, surfaces its history, and pushes you the moment it asks.

**Claude Code's built-in remote** lets you connect to a session that's already running. supermux is the persistent host that orchestrates many of them: it starts them, stops them, restarts them with new flags, resumes old conversations, schedules them, and keeps them alive while your laptop sleeps in your bag.

---

## Quickstart (5 minutes)

You need a Linux machine you can SSH into (VPS, home server, Raspberry Pi, dev box). The PWA installs on whatever you're holding.

```bash
git clone https://github.com/sanderbz/supermux
cd supermux
bash scripts/setup.sh     # friendly wizard, ~30 seconds
bash scripts/deploy.sh    # ships over SSH, builds natively on the target, starts the service
```

`setup.sh` asks the handful of values `deploy.sh` needs (SSH host, service user, ports, Tailscale) with smart defaults — hit Enter through it for the common case. Or set `SUPERMUX_DEPLOY_HOST=user@host` and run `scripts/setup.sh --yes` for a non-interactive deploy.

After deploy, open the printed URL on any device. On mobile, "Add to Home Screen" gives you the full PWA experience including push.

**Local dev** (Rust + bun + tmux on your laptop):

```bash
scripts/dev.sh   # Rust backend on :8823, Vite HMR for the PWA
```

---

## Built for self-hosting

- **One Rust binary, with the PWA embedded.** No Node, Docker, or Python at runtime. One file plus a SQLite DB.
- **systemd-sandboxed by default** — runs as an unprivileged user with `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, restricted address families, and `ReadWritePaths` scoped to the data dir + your project dirs.
- **Auth on every API route** — bearer token at `~/.supermux/auth_token` (mode `0600`). No localhost bypass.
- **Tmux survival** — the tmux socket lives in the persistent data dir, so sessions outlive supermux restarts.
- **In-UI 1-click updates** — `git fetch → build → install → verify → auto-rollback on failure`, exposed as a button. Preflight refuses unsafe upgrades.

### Supported platforms

- **Linux** — `x86_64` and `aarch64` (primary deploy target).
- **macOS** — Apple Silicon and Intel (development + local self-host).
- **Windows** — not supported (relies on Unix-only primitives like `tmux`, ptys, SIGWINCH, Unix domain sockets). WSL2 works as a Linux host.

Toolchain floor: `rustc 1.83` and a recent `bun` 1.x. `tmux` is a runtime dep; [Claude Code](https://code.claude.com/docs/en/setup) is the default agent (`deploy.sh` can install it for you via `SUPERMUX_INSTALL_CLAUDE=1`).

### Tailscale-ready

If you have `tailscaled` running on the target host, `deploy.sh` auto-detects it and exposes supermux via `tailscale serve` on `:443`. Rename once (`sudo tailscale set --hostname=supermux`) and you have a clean, HTTPS, internal-only URL on every device on your tailnet.

---

<details>
<summary><strong>Architecture</strong></summary>

- **Backend** — Rust (`axum` + `tokio` + `sqlx`/SQLite), in `server/`.
- **Frontend** — TypeScript + React + Vite PWA, in `web/`.
- **Process model** — single binary; tmux runs out-of-process on a persistent socket so sessions survive restarts.
- **Live data path** — WebSockets for terminal pty streams (binary frames); SSE for everything else (session lists, status, board, push, alerts).

Module map and protocol details: [`ARCHITECTURE.md`](ARCHITECTURE.md).

</details>

<details>
<summary><strong>Deploy guide — the full reference</strong></summary>

`scripts/deploy.sh` runs from your workstation and ships a pinned `git archive` of a clean commit *over SSH* to a remote host (not the machine you run it on), builds natively there (no cross-compilation), installs `/usr/local/bin/supermux-server` plus the systemd unit, and starts the service. It runs an upfront preflight and prints a one-page plan before doing anything destructive.

### Defaults

- **Non-root by default, even from a root SSH session.** Root provisions; the service drops to the unprivileged `supermux` user. Forcing root throws away the systemd sandbox and trips Claude Code's refusal to run `--dangerously-skip-permissions` as uid 0, so it's refused unless you explicitly set `SUPERMUX_ALLOW_ROOT=1`.
- **Service user** defaults to `supermux`. If it doesn't exist, `deploy.sh` provisions it. Pick a non-default name and the script refuses rather than silently creating something unexpected.
- **Project directories** — `SUPERMUX_PROJECT_DIRS` (default `<user-home>/projects`). Under-home dirs just work; outside-home dirs (`/opt/projects`, `/srv/work`, …) are created, `chown -R`'d, and folded into the systemd `ReadWritePaths` so the sandbox permits agent writes.
- **Claude Code (the agent runtime)** — every non-shell session launches the `claude` binary on the service user's PATH, so it's a runtime dependency for the default provider. After provisioning, `deploy.sh` checks whether the service user has `claude` and, when missing, installs it (official native installer — no Node) per `SUPERMUX_INSTALL_CLAUDE` (`ask` = offer interactively, `1` = auto, `0` = warn only).
- **Service-user Claude login** — supermux uses your Claude subscription (OAuth), never an API key. After confirming the binary, `deploy.sh` checks for `~supermux/.claude/.credentials.json` and offers to copy the deployer's existing login.
- **Tailscale** — auto-detected. If `tailscaled` is running, `deploy.sh` exposes the service via `tailscale serve` on port `443`.
- **Toolchains** — `bun` and `cargo` are required (native build). `SUPERMUX_INSTALL_TOOLCHAINS=1` opts in to automatic install via the official `bun` + `rustup` installers; otherwise missing toolchains are a hard error with manual instructions.

### TLS

The service binds `127.0.0.1` and speaks plain HTTP. Put it behind TLS one of two ways:

1. **Reverse proxy** (nginx, Caddy) terminating at `http://localhost:<SUPERMUX_INTERNAL_PORT>` (default `8824`). See **WebSocket origins** below — a proxied hostname usually needs an `extra_origins` entry.
2. **`tailscale serve`** — set `SUPERMUX_USE_TAILSCALE=1` and `deploy.sh` runs `tailscale serve --https=<SUPERMUX_PUBLIC_PORT>` to terminate TLS and proxy to the loopback port.

### WebSocket origins

supermux checks the browser's `Origin` header on every WebSocket upgrade and closes non-matching connections with code `1008 "origin not allowed"`. The built-in allowlist covers `localhost`, `127.0.0.1`/`::1`, private-LAN IPv4 ranges, `*.ts.net` (Tailscale), and the server's own bind address. If you reach supermux by a hostname that isn't one of those (a reverse-proxy domain, an internal DNS name), add it to `extra_origins` in `~/.supermux/config.toml`:

```toml
bind = "127.0.0.1:8824"
extra_origins = ["supermux.corp.example", "box-12.internal.example"]
```

Exact host match only (no wildcards). Restart the service after editing.

### Verify

```bash
curl -sf http://127.0.0.1:<SUPERMUX_INTERNAL_PORT>/api/health
journalctl -u supermux -n 50
```

Public routes are `/api/health`, the PWA shell, and the board iCal feed. Everything else needs the bearer.

</details>

<details>
<summary><strong>Push notifications setup</strong></summary>

The PWA's iOS push works out of the box with a placeholder VAPID contact. To use your own `mailto:`, set `push_sub = "mailto:you@your-domain"` in `~/.supermux/config.toml`, or export `SUPERMUX_PUSH_SUB`. Settings → Notifications has a **Send test** button to confirm delivery before you trust it for real alerts.

iOS specifics: Safari only allows push from installed home-screen PWAs, so add to home screen first, then grant notification permission inside the installed app.

</details>

---

## Contributing

Issues, ideas, screenshots of your dashboard with 14 Claude sessions — welcome. PRs land via review; CI runs on every push to `main`. Heavy code paths (sessions, ws, scheduler, board) have inline `#[cfg(test)]` tests plus integration tests under `server/tests/`. The frontend is type-checked end-to-end with `tsc -b` and uses Playwright for e2e smoke.

## License

MIT — see [`LICENSE`](LICENSE).
