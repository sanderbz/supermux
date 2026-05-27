# supermux

**Run a roomful of AI coding agents from one dashboard.** supermux drives real
`tmux` sessions across your fleet — local *and* remote machines over SSH —
running Claude Code, Codex, plain shells, anything you want. A fast, live
web UI lets you watch, steer, and switch between dozens of them at once. A
single Rust binary embeds the PWA: no Node, no Docker, no Python at runtime.

<p align="center">
  <video src="https://github.com/sanderbz/supermux/raw/main/docs/showcase/supermux-showcase.mp4" autoplay loop muted playsinline width="900">
    <img src="docs/showcase/supermux-showcase.gif" alt="supermux in action — overview, peek, type-on-hover, focus, sort + groups, mobile" width="900">
  </video>
</p>

<p align="center"><em>Every tmux session at a glance — hover any tile for a live peek, type without leaving the overview, click for a smooth zoom into focus mode, jump anywhere with ⌘K, and the same dashboard on your phone.</em></p>

---

## Why supermux

If you've ever spun up three Claude sessions in three terminals and wished you
could *see* them all without `⌘+\`-juggling tabs, supermux is that. It's
**one self-hosted process** that:

- Watches all your live tmux panes with sub-second-fresh previews.
- Lets you jump into any one full-screen with keyboard-captured terminal input.
- Survives reboots — sessions live in tmux, not in supermux, so your agents
  keep working when the dashboard restarts.
- **Spans machines** — point supermux at any host you can `ssh` into and its
  tmux sessions show up next to your local ones, same dashboard, same shortcuts.
- Runs the **same UI on your phone** as on your desktop — installable as a PWA.

## Features

### See everything, jump anywhere
- **Live overview** of every tmux session with color-true terminal previews
  refreshed adaptively (1s for the top 4 most-active, 2s for the rest).
- **Focus mode**: full keyboard-captured xterm.js on desktop, a Termius-grade
  detented bottom sheet on mobile. ⌘1..9 jumps between sessions instantly.
- **⌘K command palette** with fuzzy search across sessions, board issues,
  schedules, files, snippets, MCP tools, and Claude Code skills.
- **Full scrollback on every attach**: a fresh browser tab gets the same
  history `tmux` is still holding, not just the visible screen.
- **Hover any tile** for an action menu — Stop, Archive, Info — without
  leaving the overview.

### Remote hosts over SSH
- Register any reachable machine (Tailscale, VPN, public DNS, SSH reverse
  tunnel — all work) under **Settings → Hosts** (the old `/hosts` URL still
  works — it redirects there); supermux multiplexes a single SSH ControlMaster
  connection per host for low-latency PTY streaming.
- **One-click bootstrap** installs the `authorized_keys` entry and verifies
  each prereq with a per-line checklist — no manual ssh-copy-id dance.
- Start a session on a remote host from the same "New session" sheet as a
  local one; a discreet **remote badge** marks tiles that aren't on this box.
- Sessions reattach across hosts on supermux restart; the host registry
  soft-deletes so historical tiles still resolve their origin machine.

### Agent Teams
- Tell one agent to *spawn a team* and supermux auto-detects the teammates
  it created, groups them into a single **TEAM CARD** in the overview, and
  pins the team above the rest of the grid.
- One-click **convert** any existing session into a team in place.
- Per-team width controls (Compact / Standard / Wide / Full) so a busy team
  card doesn't crowd the rest of the grid.
- Team-aware focus strip on the left of the focus mode — see lead +
  teammates side-by-side, tap a teammate for a read-only live view.
- Team-scoped boards: per-team task entries roll up to one place.

### Custom groups + per-group sort
- Drag-and-drop **groups** of sessions in the overview with dnd-kit.
- **Per-group sort modes** — Smart / Custom / Name / Status / Recent activity
  / Age — persisted per group in localStorage.
- Hover the gap between two rows on desktop to reveal an inline **+ Add group
  here**; or press `g n`, or use the command palette.
- Tile drag with click-vs-drag threshold (short clicks open the session;
  drags pick up). 700ms drop-flash, container outline for smart-sort
  destinations, inter-tile insertion line for custom-sort.
- The desktop focus mode's left **session strip** is group-aware too: same
  groups, same sort modes — either **mirror the overview** or set a
  **custom-for-this-strip** override.

### Edit your prompt in a native editor
- ✎ Edit affordance in the dock lifts whatever you've typed at Claude's `❯`
  prompt into a browser-native textarea — full iOS selection handles,
  autocorrect, dictation, paste-over-select.
- **Send button** writes back AND submits in one tap; **Done** writes back
  to the prompt for the user to send when ready.
- On mobile: a full-page edit surface (iOS Notes-style) with system-font
  body, tuned spring physics, and proper safe-area handling.
- Clean architecture: Claude Code's own `chat:externalEditor` (Ctrl+G) owns
  the buffer serialize→edit→deserialize contract — supermux just bridges
  `$EDITOR` to a browser sheet. No scraping, no keystroke replay.

### Mobile-first, not mobile-afterthought
- **Swipe-up session switcher** — a Termius-style horizontal session strip
  slides out from above the lower bar. Tap a pill to jump.
- Always-visible ✎ Edit pill (no more keyboard-gated affordances).
- Full-page edit surface that covers the dimmed terminal so there's nothing
  to look at except what you're typing.
- iOS PWA cold-launch black-bar fix, sheet-vs-keyboard race fixes, drag-
  handle dead space removed.
- Same web app, installable on any device.

### The rest
- **Inline session rename**: live tmux rename + pty survival so a running
  session can be renamed without losing its terminal.
- **Live git status per session**: branch, dirty, ahead/behind — read on
  demand when you open the info panel.
- **Board** — a lightweight, session-scoped issue tracker. Sessions can
  comment, mark issues done, or ask for input via per-session hook tokens.
- **Scheduler** — cron-style scheduled jobs with a live calendar.
- **Files** — path-jailed file browser + editor.
- **MCP & Skills** discovery in the command palette — toggle MCPs per
  session, tap-activate skills.

### Built for self-hosting
- **Single binary**: the release build embeds the frontend via `rust-embed`;
  ship one file plus a SQLite database.
- **Auth by default**: every API route requires a bearer token; no localhost
  bypass. The token is generated on first start at `~/.supermux/auth_token`
  with mode `0600`.
- **systemd-sandboxed**: runs as a dedicated unprivileged user with
  `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, restricted address families,
  and a tight `ReadWritePaths` scoped to the data dir + your project dirs.
- **Tmux survival**: tmux's socket lives in the persistent data dir, so
  sessions outlive supermux restarts (and even reboots if the kernel
  cooperates).

## Supported platforms

- **macOS** — Apple Silicon and Intel (development + local self-host).
- **Linux** — `x86_64` and `aarch64` (the primary deploy target).
- **Windows** — not supported. supermux relies on Unix-only primitives
  (`tmux`, ptys, SIGWINCH, Unix domain sockets). WSL2 works as a Linux host.

Toolchain floor: `rustc 1.83` (see `server/Cargo.toml`'s `rust-version`) and
a recent `bun` (1.x) for the web build. `tmux` is a runtime requirement.

## Quickstart — deploy

```bash
bash scripts/setup.sh     # friendly wizard, ~30 seconds
bash scripts/deploy.sh    # ships, builds natively on the host, starts the service
```

The wizard asks the handful of values `deploy.sh` needs (SSH host, service
user, ports, Tailscale, …) with smart defaults — hit Enter through it for
the common case. Or set `SUPERMUX_DEPLOY_HOST=user@host` and run
`scripts/setup.sh --yes` for a non-interactive deploy.

**Push notifications (optional):** the PWA's iOS push works out of the box
with the default placeholder VAPID contact. To use your real `mailto:` (so
the push service has a real address if it needs to flag abuse), set
`push_sub = "mailto:you@your-domain"` in `~/.supermux/config.toml` on the
host, or export `SUPERMUX_PUSH_SUB`. The Settings page has a "Send test"
button that confirms end-to-end delivery.

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
scripts/dev.sh        # Rust backend + Vite dev server with hot-reload
```

The backend listens on `127.0.0.1:8823`; Vite serves the frontend with HMR.
On first start the server generates `~/.supermux/auth_token` (mode `0600`);
all API routes require `Authorization: Bearer <token>` — there is no
localhost bypass.

## Architecture

- **Backend** — Rust (`axum` + `tokio` + `sqlx`/SQLite), in `server/`.
- **Frontend** — TypeScript + React + Vite PWA, in `web/`.
- **Process model** — a single binary; tmux runs out-of-process on a
  persistent socket so sessions survive supermux restarts.
- **Live data path** — WebSockets for terminal pty streams (binary frames),
  SSE for everything else (session lists, status, board, schedules, alerts).

Full design + module map: [`ARCHITECTURE.md`](ARCHITECTURE.md).

<details>
<summary><strong>Deploy guide — the full reference</strong></summary>

`scripts/deploy.sh` ships a pinned `git archive` of a clean commit to a
host, builds **natively** there (no cross-compilation), installs
`/usr/local/bin/supermux-server` plus the systemd unit, and starts the
service. It runs an upfront preflight and prints a one-page plan before
doing anything destructive.

### Noob-proof defaults

- **Non-root by default — even from a root SSH session.** The account you
  *deploy with* (your SSH login, often `root` on a fresh VPS) is **not** the
  account the service *runs as*. Deploying over a root SSH session is fine
  — root provisions (creates the service user, installs the unit) — but the
  service drops to the unprivileged `supermux` user. Forcing root throws
  away the systemd sandbox **and** trips Claude Code's refusal to run
  `--dangerously-skip-permissions` as uid 0, so it's refused unless you
  explicitly set `SUPERMUX_ALLOW_ROOT=1` (a loud, last-resort escape hatch).
- **Service user** — defaults to `supermux`. If it doesn't exist on the
  host, `deploy.sh` provisions it (home + ownership). Pick a non-default
  user and the script refuses rather than silently provisioning an
  unexpected account.
- **Project directories** — `SUPERMUX_PROJECT_DIRS` (default
  `<user-home>/projects`). Under-home dirs just work; outside-home dirs
  (`/opt/projects`, `/srv/work`, …) are created, `chown -R`'d to the
  service user, and folded into the systemd `ReadWritePaths` so the
  sandbox permits agent writes.
- **Service-user Claude login** — supermux uses your Claude
  **subscription** (OAuth), never an API key or `ANTHROPIC_API_KEY`. After
  provisioning, `deploy.sh` checks for `~supermux/.claude/.credentials.json`
  and offers to copy the deployer's existing Claude login; it verifies
  before declaring success and prints the exact `sudo -u supermux -i
  claude` + `/login` command if anything's still missing.
- **Tailscale** — auto-detected. If `tailscale` is installed and
  `tailscaled` running, `deploy.sh` exposes the service via `tailscale
  serve` on port `443`, giving you a clean `https://<host>.<your-tailnet>
  .ts.net/` URL. Rename once with `sudo tailscale set --hostname=supermux`
  for the nicest URL. Override with `SUPERMUX_USE_TAILSCALE=0|1` or
  `SUPERMUX_PUBLIC_PORT`.
- **Toolchains** — `bun` and `cargo` are required (native build). Set
  `SUPERMUX_INSTALL_TOOLCHAINS=1` to opt in to automatic install via the
  official `bun` + `rustup` installers — otherwise missing toolchains are a
  hard error with manual-install instructions.

### TLS

The service binds `127.0.0.1` and speaks plain HTTP. Put it behind TLS one
of two ways:

1. **Reverse proxy** (nginx, Caddy, etc.) terminating at
   `http://localhost:<SUPERMUX_INTERNAL_PORT>` (default `8824`).
2. **`tailscale serve`** — set `SUPERMUX_USE_TAILSCALE=1` and `deploy.sh`
   runs `tailscale serve --https=<SUPERMUX_PUBLIC_PORT>` to terminate TLS
   and proxy to the loopback port.

### HOME and DATA_DIR are deliberately separate

The systemd unit's `WorkingDirectory` + `$HOME` point at the service user's
actual login home (so agent caches like `.claude/`, `.cache/`,
`.bash_history` land where they're conventionally expected). The data dir
(`~/.supermux`) lives as a scoped sibling and holds only supermux's own
state — SQLite DB, auth token, `config.toml`, uploads. Backing it up or
wiping it never touches the user's shell history or agent caches.

### Verify after deploy

```bash
curl -sf http://127.0.0.1:<SUPERMUX_INTERNAL_PORT>/api/health
journalctl -u supermux -n 50
```

The `/api/health` route is the only public one — no token needed — and is
what `deploy.sh` uses to confirm the service came up.

</details>

## License

MIT — see [`LICENSE`](LICENSE).
