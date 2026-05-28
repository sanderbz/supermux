# supermux — Architecture

A design reference for contributors. Setup and deploy live in [`README.md`](README.md).

---

## Shape

- **One Rust binary** (`supermux-server`). The release build embeds the frontend via `rust-embed` and serves HTTP + WebSocket + SSE on a single port (default `127.0.0.1:8824`, dev `8823`).
- **One SQLite file** (`~/.supermux/data.db`), accessed via `sqlx`.
- **tmux runs out-of-process** on a persistent socket in `~/.supermux/tmux/`. Sessions outlive supermux restarts; supermux reconciles to them on boot.
- **Frontend**: React 19 + Vite PWA, TypeScript. TanStack Query for HTTP cache, Zustand for UI state, framer-motion for animations, xterm.js for terminals, Vaul for bottom sheets.

```
┌── Browser / PWA ─────────────────────────────────────────────┐
│  React 19 + Vite ▸ xterm.js ▸ TanStack Query ▸ Zustand       │
└────────┬─────────────────┬────────────────────┬──────────────┘
         │ HTTP+bearer     │ WS pty (bytes)     │ SSE (events)
         ▼                 ▼                    ▼
┌── supermux-server (single binary) ───────────────────────────┐
│  axum 0.8 + tower (auth, CORS, tracing)                      │
│  sessions · ws · board · scheduler · files · agents · push   │
│  hosts · teams · claude_tools · external_edit · prefs        │
│  ─ tokio runtime: per-session pty readers, status detector,  │
│    SSE broadcast, scheduler tick, steering deliver loop      │
│  ─ sqlx ▸ SQLite          ─ tokio::process ▸ tmux/git/claude │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
                ┌── tmux server (persistent socket) ─┐
                │ supermux-<name>                    │
                │   └─ claude / codex / shell …      │
                └────────────────────────────────────┘
```

---

## Backend modules

`server/src/` — top-level files and submodules:

| Module | Role |
|---|---|
| `http.rs` | Router composition: every module exposes `router_for(state)`; `http::router()` merges them under bearer auth, plus the public router (`/api/health`, PWA shell, board iCal). |
| `auth.rs` | Bearer middleware. No localhost bypass. Hook tokens are a separate scoped path. |
| `config.rs` | Loads `~/.supermux/config.toml`; bind addr, push subject, project dirs, etc. |
| `state.rs` | `AppState`: pool, SSE broadcast, per-session `watch::Sender<(Status, version)>`, locks, host pool. |
| `sse.rs` | `GET /api/events` — server-sent event stream. |
| `static_assets.rs` | `rust-embed` of `web/dist/`; serves frontend on `/` in release. |
| `public.rs` | Auth-exempt routes: PWA manifest, service worker, icons. |
| `error.rs` | `AppError` → JSON envelope `{ok:false, error}`. |
| `audit.rs` | Mutation audit log (writes via `db::audit::log`; reads via `/api/audit`). |
| `log_redact.rs` | tracing layer that strips sensitive fields. |
| `external_edit.rs` | Bridges `$EDITOR` to the browser; SSE `external-edit` events drive the editor sheet. |
| `hooks.rs` | Session→server hook endpoints (status pings, etc). |
| `push.rs` | VAPID keypair, subscriptions, send fan-out (web-push + reqwest rustls). |
| `prefs.rs` | Snippets + kbd-groups CRUD. |
| `claude_config.rs` | Writes `~/.claude/settings.json` for the service user. |
| `sessions/` | tmux lifecycle, pty reader, status detector, teams, host pool, transport, steering deliver loop. |
| `ws/` | WebSocket router — pty fan-out (`broadcast::channel<Bytes>` per session), in-band first-frame auth. |
| `board/` | Issue tracker, hook protocol (`/api/hook/board/*`), iCal feed, claim flow, dispatch. |
| `scheduler/` | 10s tick, expression parser (`cron`, `every Nm/Nh`, named), runner (tmux/shell/boot), watch mode. |
| `files/` | Path-jailed file browser + editor; `path_safe.rs` enforces the jail. |
| `agents/` | `GET /api/agents/{name}/wait?state=...` long-poll on the session's status watch channel. |
| `hosts/` | Remote host registry + SSH bootstrap. |
| `teams/` | Detects agent-spawned teams, persists team membership, board sync. |
| `claude_tools/` | MCP + skills registry surfaced to the command palette. |
| `db/` | All SQL. One file per table family: `sessions`, `board`, `boards`, `schedules`, `audit`, `hosts`, `push`, `skills`, `steering`, `tracked_files`, `prefs`, `runtime_state`. |

A new module is one `mod` declaration in `lib.rs`, one `router_for(state)`, and one `.merge(...)` line in `http::protected_router`.

---

## Frontend layout

`web/src/` — directories:

- `routes/` — top-level pages: `overview.tsx`, `focus.tsx` (responsive switcher into `focus/desktop.tsx` / `focus/mobile.tsx`), `board.tsx`, `files.tsx`, `scheduler.tsx`, `settings.tsx`, plus the dev harness routes (`dev-focus`, `dev-teams`, `dev-term`, `dev-tiles`).
- `components/` — feature folders: `board/`, `focus-mode/`, `command-palette/`, `terminal/`, `session-tile/`, `files/`, `scheduler/`, `team/`, `onboarding/`, `ui/`, …
- `hooks/` — TanStack Query bindings + UI hooks: `use-sessions`, `use-board`, `use-teams`, `use-hosts`, `use-files`, `use-scheduler`, `use-push`, `use-live-term`, `use-sse`, `use-claude-tools`, `use-commands`, `use-overview-layout`, `use-connection-link`, `use-send-to-agent`, etc.
- `stores/` — Zustand stores: `ui-store`, `connection-store`, `archived-sheet-store`, `board-create-session-store`, `claude-tools-store`, `new-group-store`, `team-density-store`, `team-width-store`.
- `lib/` — utilities, API client (`api/`), motion bank (`springs.ts`), overview layout math.
- `brand/` — copy + tokens.
- `styles/` — Tailwind + `globals.css` (status tokens, glass material).

---

## Wire protocols

- **HTTP REST** — every API route returns either an envelope `{ok: true, data}` or `{ok: false, error}`. Bearer in `Authorization: Bearer <token>`; `?_token=...` query param accepted for `<video>` and EventSource only.
- **WebSocket** — pty bytes streamed binary, in-band first-frame auth (`{"type":"auth","token":"..."}`), 2s deadline before close 1008. Close 1013 (subscriber-too-slow) triggers a silent reconnect on the next `visibilitychange → visible`.
- **SSE** — `GET /api/events` is the single live channel for everything that isn't a pty stream. Named events the server emits: `sessions`, `status`, `alerts`, `board`, `boards`, `teams`, `prefs`, `settings`, `external-edit`. Clients invalidate TanStack Query caches keyed by event type.

---

## Status detection

`server/src/sessions/status.rs` + `sessions/auto_actions.rs`.

A per-session loop captures the tmux pane (`tmux capture-pane`) and classifies the screen as one of:

- `Active` — agent is working.
- `Waiting` — blocked on the user (Claude permission prompt, etc).
- `Idle` — turn finished, prompt visible.
- `Stopped` — tmux pane is gone.
- `Starting` — short-lived boot window.
- `Unknown` — cold-start sentinel.

Transitions go through a 50ms flap debounce; only confirmed edges are committed. On commit: DB write first (`last_status`), then `watch::Sender<(status, version)>` send-replace, then SSE `status` broadcast. Tick cadence is adaptive: 1s for hot-active, 2s active, 4s idle, 5s waiting/stopped.

The board hook protocol and the scheduler's watch mode both subscribe to the same per-session watch channel — one source of truth for "is this turn done."

---

## Database

`server/migrations/0001..0018_*.sql` — applied at startup. Highlights:

- `sessions` + `session_runtime` — the source-of-truth row per tmux session; ANSI-capture preview lives in `runtime`.
- `issues` + `acceptance_items` + `issue_links` + `issue_tags` + `boards` + `delegations` — the board.
- `schedules` + `schedule_runs` + `schedule_run_keys` — scheduler + idempotency.
- `audit_log` — every mutation. Append-only.
- `push_subscriptions` + `notif_prefs` — VAPID-encrypted subscriptions + per-category mute prefs.
- `hosts` — remote host registry.
- `steering_queue` — single-flight per-session steering messages.
- `skills`, `tracked_files`, `kbd_groups`, `snippets` — supporting stores.

Migrations are forward-only. Schema changes go in a new file `00NN_<name>.sql`.

---

## Auth

- **Bearer token** at `~/.supermux/auth_token`, mode `0600`, generated on first start. Required for every API route except `/api/health`, the PWA shell, and the board iCal feed.
- **Hook tokens** are per-session, stored on the session row. The board hook routes (`/api/hook/board/*`) accept `X-Supermux-Hook-Token` and scope the request to that session's currently-doing issue.
- No localhost bypass. Constant-time comparison via `constant_time_eq`.

---

## Deploy + sandbox

Two paths:

1. **`scripts/deploy.sh`** — runs from a workstation. Ships a clean `git archive` to the host, builds natively as the service user (no cross-compilation), installs the binary + systemd units, and starts the service. This path also renders + installs the on-host self-deploy units.
2. **`scripts/deploy-self.sh`** — runs from inside the service. Writes a request file to `~/.supermux/deploy/request`. A root-side `supermux-deploy.path` unit watches that file; on change a root oneshot (`supermux-deploy.service`) runs `/usr/local/sbin/supermux-deploy-runner`. The runner builds (as the service user via `runuser`, outside the supermux.service cgroup so the `SystemCallFilter` doesn't apply), installs, restarts, verifies `/api/health`, rolls back on failure. The agent gets zero new privilege — the runner only replaces the unprivileged binary and restarts the unprivileged unit.

The service unit (`etc/systemd/supermux.service`) is hardened: `NoNewPrivileges`, `RestrictSUIDSGID`, `CapabilityBoundingSet=` (empty), `SystemCallFilter=@system-service ~@privileged @resources @obsolete`, `PrivateTmp`, `ProtectHome=tmpfs` (`.gitconfig` / `.ssh` bind-mounted past it), `ProtectSystem=strict`, `ReadWritePaths` scoped to the data dir and the project dirs.

`KillMode=process` + `TMUX_TMPDIR` anchored in the data dir means tmux (and every session) survives a `systemctl restart supermux`.

---

## Conventions

- **One module = one router**. `pub fn router_for(state: AppState) -> Router`. Composition lives in `http.rs`.
- **Envelopes**, not naked JSON, on every API response.
- **No 3s polling fallbacks**. WS for pty, SSE for everything else, manual refetch on `visibilitychange`.
- **Audit every mutation**. Failed audit insert fails the request — `?`, not `let _ =`.
- **Path-jail every filesystem entry point**. `files::path_safe::resolve_safe` is the single function; modules that need their own jail (the git layer) wrap it.
- **Springs from `lib/springs.ts`**, no ad-hoc cubic-beziers in component code.
- **`data-vr-*` attributes** on components that visual-regression Playwright targets.
- **No private/customer names in code, tests, or comments** — this repo is open source.
