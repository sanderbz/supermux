# amux v3 — Technical Plan

> **Status**: canonical. This document is the single source of truth for all v3 implementation. Subagents execute against the milestone specs in §10.
> **Owner**: Sander. **Last revised**: 2026-05-21.
> **Companion docs**: `research/user-vision.md` (UX truth), `research/amux-feature-extract.md` (functional spec), `research/cmux-amux-landscape.md` (competitive features), `research/termius-ios-native-spec.md` (finish spec).

---

## 0. Executive summary

**What we're building.** amux v3 is a ground-up rebuild of the v2 Python monolith (`amux-server.py`, 46k lines). It is a Rust HTTP+WS backend that drives `tmux` sessions running Claude Code / Codex, paired with a React-19 + Vite frontend that delivers a Termius-grade mobile experience and a "BE in tmux, via web" desktop experience. The dashboard is dense, hover-peek tiles on the overview; a real keyboard-captured focus mode on desktop; a Vaul-detent bottom sheet with a Termius-style accessory dock on mobile. The agent surface is small and opinionated: Sessions, Board, Files, Scheduler — nothing else.

**Key architecture decisions.** Single Rust binary (`amux-server`) that embeds the built frontend via `include_dir!`, serves both HTTP and WebSocket on one TLS port (8823 in production, side-by-side with v2 on 8822), persists to a single SQLite (`~/.amux-v3/data.db`) via `sqlx`, and spawns child `tmux` processes for each agent session. Frontend uses xterm.js for the live terminal (WS pty bytes streamed character-by-character), TanStack Query for HTTP cache, Zustand for local UI state, Framer Motion 11 for every animation. No global mutable state outside Zustand stores. No 3s polling fallback — WebSocket is the only path for live terminal data, SSE for metadata, manual refetch on visibility for catch-up.

**Milestone count & total time.** 27 milestones (M0–M26), grouped into 5 tracks (bootstrap, backend, frontend-core, frontend-routes, integration/deploy). Total estimated LOC: ~14 500 (~7 200 Rust, ~7 300 TypeScript/TSX). Total estimated time: ~140 engineering-hours for a single experienced developer; ~50 wall-clock hours with 4-way parallelism on independent tracks. Critical path: M0 → M1 → M3 → M4 → M5 → M13 → M14 → M15 → M23 → M24 → M25.

---

## 1. Architecture overview

### 1.1 System diagram (text-art)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Browser / PWA                                   │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐  │
│  │ React 19 + Vite  │   │  xterm.js (WS)   │   │ TanStack Query (HTTP/SSE)│  │
│  │ Framer Motion    │   │  CanvasAddon     │   │ Zustand (UI state)       │  │
│  │ Vaul (sheets)    │   │  FitAddon        │   │ Vite-PWA (SW + offline)  │  │
│  └─────────┬────────┘   └────────┬─────────┘   └──────────┬───────────────┘  │
└────────────│─────────────────────│────────────────────────│──────────────────┘
             │ HTTPS (TLS)         │ WSS                    │ SSE
             │ Bearer/?_token=     │ ?_token=               │
             ▼                     ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│             amux-server (single Rust binary, port 8823)                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ axum 0.8 router + tower middleware                                       │ │
│  │   - bearer auth (always-on, explicit #[public] for exceptions)           │ │
│  │   - CORS allowlist (localhost + LAN-IP + *.ts.net)                       │ │
│  │   - origin allowlist (WS)                                                │ │
│  │   - tracing-subscriber (JSON logs)                                       │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│  ┌────────┐  ┌─────────┐  ┌────────┐  ┌──────────┐  ┌─────────┐ ┌─────────┐ │
│  │sessions│  │   ws    │  │ board  │  │  files   │  │schedule │ │ agents  │ │
│  │  +tmux │  │ pty fan │  │  CRUD  │  │ browser  │  │ tick    │ │  wait   │ │
│  │  +stat │  │  -out   │  │ +claim │  │ +editor  │  │ +cron   │ │  +slash │ │
│  └────┬───┘  └────┬────┘  └────┬───┘  └─────┬────┘  └────┬────┘ └────┬────┘ │
│       │           │            │            │            │           │       │
│       └───────────┴────────────┴────────────┴────────────┴───────────┘       │
│                                       │                                       │
│                  ┌────────────────────┴───────────────────┐                  │
│                  │ tokio runtime (multi-thread)            │                  │
│                  │ - per-session pty reader tasks          │                  │
│                  │ - broadcast::channel<Bytes> per session │                  │
│                  │ - tokio::sync::Notify for wait()        │                  │
│                  │ - tokio::interval ticks (scheduler, etc)│                  │
│                  └─────────────────────────────────────────┘                  │
│                                       │                                       │
│  ┌────────────────────┐  ┌────────────┴───────────┐  ┌────────────────────┐ │
│  │ sqlx::SqlitePool   │  │ tokio::process::Command│  │ include_dir!(web)  │ │
│  │ ~/.amux-v3/data.db │  │ tmux/git/claude/codex  │  │ static frontend    │ │
│  └────────────────────┘  └────────────────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────────┐
                          │ tmux server (system-wide)  │
                          │  amux-<name>               │
                          │   └─ claude / codex        │
                          │       └─ pty (fifo+log)    │
                          └────────────────────────────┘
```

### 1.2 Process model

- **amux-server** (single binary, long-running). Spawned from systemd. Owns the SQLite handle, tokio runtime, all HTTP/WS listeners, and one pty reader task per active session.
- **tmux server** (one per OS user, system-wide). Created on demand by `tmux new-session`. tmux sessions named `amux-<name>` survive amux-server restarts (they're not children of the Rust process). amux re-attaches via `tmux capture-pane` + `tmux pipe-pane` on startup.
- **claude / codex** (one per session). Child of tmux pane. PID tracked via `tmux list-panes -F '#{pane_pid}'` + `pgrep -P`.
- **No daemon-per-session**. The pty fan-out is in-process (one tokio task per session reading from a unix FIFO that `tmux pipe-pane` writes to).

### 1.3 Threading / concurrency model

- **tokio multi-thread runtime** (default worker count = CPU cores).
- **Per-session pty reader task**: drains a unix FIFO at `/tmp/amux-pty-<name>.fifo`, appends to in-memory ring buffer (`Arc<Mutex<VecDeque<Bytes>>>`, cap 64 KB), broadcasts to `tokio::sync::broadcast::Sender<Bytes>` (capacity 256).
- **Per-WS-subscriber task**: `broadcast::Receiver<Bytes>` reads from the per-session sender; on `RecvError::Lagged(n)` it closes with code 1013 (subscriber too slow, never blocks fan-out).
- **Per-session status detector task**: runs every 2s; captures last 30 lines via `tmux capture-pane`, runs `detect_status()`, emits status changes via SSE channel.
- **Scheduler tick task**: `tokio::time::interval(Duration::from_secs(10))`; queries `SELECT ... WHERE next_run <= ?`, dispatches each due schedule.
- **SSE fan-out**: a single `tokio::sync::broadcast::Sender<Event>` channel; HTTP handler returns an `axum::response::sse::Sse` stream that adapts the broadcast into `Event::default().json_data(...)`.
- **Locks**: per-session `tokio::sync::Mutex<SessionLock>` for `send_text`/`start`/`stop`/`config` (prevents tmux command races). Global state lives in `AppState` (struct of `Arc<...>` fields).

### 1.4 Auth model

- **Bearer token** stored at `~/.amux-v3/auth_token` (mode 0o600). Generated via `rand::rngs::OsRng` (32 bytes, base64url) on first start. Overridable via env `AMUX3_AUTH_TOKEN=...`; setting `AMUX3_AUTH_TOKEN=none` disables auth (dev-only escape hatch, logs a warning).
- **Required on ALL routes by default**. Middleware checks `Authorization: Bearer <tok>` OR `?_token=<tok>` query. Only routes annotated with `#[public]` (in practice: `/manifest.json`, `/sw.js`, `/icon.*`, `/`) skip the check.
- **No localhost bypass**. v2's localhost bypass was a CVE waiting to happen on Tailscale-served deployments — v3 removes it entirely.
- **WebSocket auth**: same token via `?_token=` query (browsers don't allow custom headers on WS upgrade).
- **Bind interfaces**: `127.0.0.1` + Tailscale interface (auto-detected via `tailscale ip --4`). Default config explicitly does NOT bind `0.0.0.0`.
- **Origin allowlist for WS**: `localhost`, `127.0.0.1`, LAN IP (auto-detected), `*.ts.net` (Tailscale MagicDNS). Other origins → close 1008.

### 1.5 Deployment

- **Single binary**. `cargo build --release` produces `target/release/amux-server`. Frontend built with `bun run build` produces `web/dist/`. Build script copies `web/dist/` to `server/static/` and `include_dir!("./static")` embeds it at compile time. End-state: one ~12 MB binary that serves the whole product.
- **Target host**: `clawd-02` (existing remote dev box). Production port: **8823** (v2 stays on 8822 indefinitely until v3 is dogfooded). systemd service: `amux-v3.service`. Working dir: `~/.amux-v3/`.
- **TLS**: reuse v2's pattern — `tailscale cert <host>` (Let's Encrypt via Tailscale), fall back to self-signed for raw-IP access. TLS is terminated in axum via `axum-server::tls_rustls`.
- **No Docker, no Node at runtime, no Python**. Just the binary + a sqlite file + the tmux server already on the box.

---

## 2. Repository layout

```
amux-v3/                         (repo root, NOT a Cargo workspace at top)
├── plan/TECH_PLAN.md            (this file)
├── research/                    (reference docs — read-only)
├── skill/                       (build orchestrator skill + state file)
│   ├── SKILL.md                 (the /amux-build skill)
│   └── state.json               (loop state)
├── scripts/
│   ├── dev.sh                   (cargo watch + vite dev concurrently)
│   ├── build.sh                 (build web → embed → cargo build --release)
│   ├── deploy.sh                (scp + systemctl restart)
│   └── migrate-v2.py            (read ~/.amux → write ~/.amux-v3)
├── server/                      (Rust backend)
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── build.rs                 (re-runs include_dir! when ./static changes)
│   ├── static/                  (generated; gitignored; symlink/copy of web/dist)
│   ├── migrations/
│   │   ├── 0001_init.sql
│   │   ├── 0002_board.sql
│   │   ├── 0003_schedules.sql
│   │   └── 0004_runtime_state.sql
│   ├── tests/
│   │   ├── http_session.rs      (axum::Router::oneshot integration)
│   │   ├── ws_pty.rs            (tungstenite client against ephemeral port)
│   │   ├── board_claim.rs       (atomic CAS race test)
│   │   └── status_detector.rs   (golden fixtures: 30 capture-pane samples)
│   └── src/
│       ├── main.rs              (entry: load config, init db, build router, serve)
│       ├── config.rs            (~/.amux-v3/config.toml + env override)
│       ├── auth.rs              (middleware + #[public] route attribute)
│       ├── error.rs             (AppError enum + IntoResponse impl)
│       ├── state.rs             (AppState struct: Pool, broadcast txs, etc.)
│       ├── http.rs              (axum Router builder; mounts all routes)
│       ├── static_assets.rs     (include_dir! + content-type detection)
│       ├── db/
│       │   ├── mod.rs           (pool init + migrate)
│       │   ├── sessions.rs      (Session model + queries)
│       │   ├── board.rs         (Issue / Status / atomic claim)
│       │   ├── schedules.rs     (Schedule + ScheduleRun)
│       │   ├── prefs.rs         (key/value)
│       │   └── runtime_state.rs (rate_limit_reset_at, hibernated, etc.)
│       ├── sessions/
│       │   ├── mod.rs           (public API: create/start/stop/send/...)
│       │   ├── lifecycle.rs     (start/stop/restart state machine)
│       │   ├── tmux.rs          (tokio::process wrappers)
│       │   ├── pty.rs           (FIFO reader + broadcast sender)
│       │   ├── status.rs        (multi-signal detector)
│       │   ├── steering.rs      (queue + next-boundary delivery)
│       │   ├── auto_actions.rs  (rate-limit, yolo, hibernate watchdog)
│       │   └── tests.rs         (status detector golden fixtures inline)
│       ├── ws/
│       │   ├── mod.rs           (axum WS handler + origin check)
│       │   ├── streamer.rs      (per-session singleton + subscriber map)
│       │   └── protocol.rs      (ClientMsg/ServerMsg enums + serde)
│       ├── board/
│       │   ├── mod.rs           (HTTP handlers)
│       │   ├── claim.rs         (atomic UPDATE ... WHERE ... RETURNING)
│       │   └── prefix.rs        (session-name → prefix algorithm)
│       ├── files/
│       │   ├── mod.rs           (HTTP handlers)
│       │   ├── path_safe.rs     (resolve + blocklist check)
│       │   └── range.rs         (HTTP Range + ETag for raw)
│       ├── scheduler/
│       │   ├── mod.rs           (tick loop)
│       │   ├── parser.rs        (free-text → cron + next_run)
│       │   ├── runner.rs        (tmux/shell job execution)
│       │   └── watch.rs         (done_pattern poller)
│       ├── agents/
│       │   ├── mod.rs           (HTTP handlers)
│       │   ├── wait.rs          (long-poll + Notify)
│       │   ├── delegate.rs      (send-to-peer convenience)
│       │   └── skills.rs        (skill registry + slash-command list)
│       ├── sse.rs               (broadcast → axum SSE adapter)
│       └── prelude.rs           (pub use ...; for module-internal use)
└── web/                         (React frontend)
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.ts
    ├── postcss.config.js
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── index.html
    ├── public/
    │   ├── manifest.json
    │   ├── icon-192.png
    │   ├── icon-512.png
    │   └── favicon.svg
    └── src/
        ├── main.tsx             (entry; providers; SW register)
        ├── App.tsx              (router shell; theme provider)
        ├── env.ts               (window._AMUX_* → typed accessors)
        ├── routes/
        │   ├── overview.tsx     (tile + list)
        │   ├── focus/
        │   │   ├── desktop.tsx  (split layout)
        │   │   ├── mobile.tsx   (Vaul sheet)
        │   │   └── index.tsx    (responsive switcher)
        │   ├── board.tsx
        │   ├── files.tsx
        │   ├── scheduler.tsx
        │   └── settings.tsx
        ├── components/
        │   ├── ui/              (shadcn primitives — button, input, sheet, ...)
        │   ├── session-tile/
        │   │   ├── tile.tsx
        │   │   ├── tail-preview.tsx
        │   │   └── status-dot.tsx
        │   ├── focus-mode/
        │   │   ├── desktop-split.tsx
        │   │   ├── mobile-sheet.tsx
        │   │   └── dock.tsx
        │   ├── terminal/
        │   │   ├── live-terminal.tsx
        │   │   └── peek-terminal.tsx (static, via /peek API)
        │   ├── kbd-accessory/
        │   │   ├── accessory-bar.tsx
        │   │   ├── group.tsx
        │   │   ├── pager.tsx
        │   │   └── manage-sheet.tsx
        │   ├── joystick/
        │   │   └── joystick.tsx
        │   ├── slash-menu/
        │   │   └── slash-menu.tsx
        │   ├── snippets/
        │   │   ├── snippet-panel.tsx
        │   │   └── snippet-editor.tsx
        │   ├── status-banner/
        │   │   └── reconnect-banner.tsx
        │   └── view-transitions/
        │       └── morph.tsx
        ├── hooks/
        │   ├── use-ws.ts
        │   ├── use-live-term.ts
        │   ├── use-sessions.ts
        │   ├── use-board.ts
        │   ├── use-sse.ts
        │   ├── use-haptics.ts
        │   ├── use-long-press.ts
        │   └── use-safe-area.ts
        ├── stores/
        │   ├── ui-store.ts      (theme, viewMode, dockOpen)
        │   ├── focus-store.ts   (currentSessionId)
        │   └── prefs-store.ts   (snippets, kbdGroups; persisted via /api/prefs)
        ├── lib/
        │   ├── api.ts           (typed fetcher; reads window._AMUX_AUTH_TOKEN)
        │   ├── springs.ts       (Framer Motion preset bank — Termius spec)
        │   ├── ansi.ts          (tail preview formatter; strips SGR)
        │   ├── keys.ts          (xterm KeyMap → tmux key name map)
        │   └── format.ts        (relative-time, token-format, etc.)
        └── styles/
            └── globals.css      (Tailwind v4 directives + tokens)
```

---

## 3. Backend (Rust) detailed design

### 3.1 `server/Cargo.toml` — annotated deps

```toml
[package]
name = "amux-server"
version = "3.0.0"
edition = "2021"
rust-version = "1.83"

[dependencies]
# ── async runtime ──
tokio = { version = "1.43", features = ["full"] }       # rt, macros, fs, process, sync, time
tokio-util = { version = "0.7", features = ["io"] }

# ── http ──
axum = { version = "0.8", features = ["ws", "macros", "multipart"] }
axum-server = { version = "0.7", features = ["tls-rustls"] }   # TLS
tower = { version = "0.5", features = ["util", "limit"] }
tower-http = { version = "0.6", features = ["cors", "trace", "fs", "limit"] }
http = "1.2"
http-body-util = "0.1"
bytes = "1.9"
mime_guess = "2.0"
include_dir = { version = "0.7", features = ["nightly"] }  # embed web/dist

# ── ws ──
tokio-tungstenite = "0.24"

# ── database ──
sqlx = { version = "0.8", default-features = false, features = [
    "runtime-tokio-rustls", "sqlite", "macros", "migrate", "chrono", "json"
] }

# ── serialization ──
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
toml = "0.8"

# ── time ──
chrono = { version = "0.4", features = ["serde"] }
cron = "0.13"                                            # cron parser

# ── tracing ──
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }

# ── auth/crypto ──
rand = "0.8"
base64 = "0.22"
constant_time_eq = "0.3"                                 # auth token compare

# ── misc ──
anyhow = "1.0"
thiserror = "2.0"
once_cell = "1.20"
regex = "1.11"
nix = { version = "0.29", features = ["signal", "process"] }  # SIGTERM Claude
notify = "7.0"                                           # FS watch for hot-reload (optional)
shell-escape = "0.1"
shellexpand = "3.1"
url = "2.5"
uuid = { version = "1.11", features = ["v4", "serde"] }
dirs = "5.0"                                             # home dir
which = "7.0"                                            # locate claude/tmux

[dev-dependencies]
tokio-test = "0.4"
tower = { version = "0.5", features = ["util"] }
tungstenite = "0.24"
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls"] }
pretty_assertions = "1.4"
insta = "1.42"                                           # snapshot tests for status detector
```

**Why each:**
- `axum` + `axum-server` for HTTP/WS+TLS. `axum 0.8` is stable, idiomatic, has good ergonomics for state via `State<AppState>`.
- `sqlx` over `rusqlite` for async + compile-time-checked queries.
- `tokio-tungstenite` for WS client in tests (axum handles server WS itself).
- `include_dir` for embedding `web/dist` — better than `include_bytes!` for many files.
- `cron` for cron-expression parsing in the scheduler.
- `notify` only if we want file-mtime self-restart à la v2 — can defer.
- `insta` for snapshot-testing the status detector against ~30 golden capture-pane outputs (this is THE crown jewel of v3 reliability).

### 3.2 Module-by-module design

#### 3.2.1 `main.rs`

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    let config = config::load()?;          // ~/.amux-v3/config.toml or defaults
    let pool = db::init(&config).await?;   // sqlx pool + run migrations
    let state = state::AppState::new(pool, config.clone());

    // spawn background tasks
    sessions::auto_actions::spawn(state.clone());
    scheduler::spawn(state.clone());
    sessions::reattach_existing(state.clone()).await?;  // restore pipe-pane after restart

    let app = http::router(state.clone());
    let listener = bind_tls(&config).await?;
    tracing::info!("amux-v3 listening on {}", config.bind);

    axum_server::from_tcp_rustls(listener, tls_config(&config).await?)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}
```

Public API: `fn main()` + `init_tracing()` + `bind_tls()` + `tls_config()`.

Error handling: top-level `anyhow::Result`; any error short-circuits startup with a tracing error log + exit code 1. Within request handlers, use `crate::error::AppError` which implements `IntoResponse` and maps to typed JSON errors.

#### 3.2.2 `config.rs`

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub data_dir: PathBuf,           // ~/.amux-v3
    pub bind: SocketAddr,            // 127.0.0.1:8823
    pub extra_binds: Vec<SocketAddr>,// tailscale IP:8823 etc.
    pub tls: TlsConfig,              // cert + key paths OR self-signed
    pub auth_token: String,          // from file or AMUX3_AUTH_TOKEN env
    pub provider_defaults: ProviderDefaults,
}
pub fn load() -> Result<Config> { /* defaults + ~/.amux-v3/config.toml + env */ }
```

Loaded once at startup; passed everywhere via `Arc<Config>` in `AppState`.

#### 3.2.3 `auth.rs`

```rust
pub async fn auth_middleware(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    // 1. extract token from Authorization header OR ?_token=
    // 2. compare via constant_time_eq
    // 3. 401 if mismatch
    // 4. skip for routes ending in /manifest.json, /sw.js, /icon* (configured in router builder)
    next.run(req).await.into_response().pipe(Ok)
}
```

In `http.rs`, apply this middleware to a `Router::merge` of all `/api/*` and `/ws/*` routes. Public routes mount on a separate router with NO auth layer.

#### 3.2.4 `db/mod.rs`

```rust
pub async fn init(config: &Config) -> Result<SqlitePool> {
    let url = format!("sqlite://{}/data.db?mode=rwc", config.data_dir.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&url).await?;
    sqlx::query("PRAGMA journal_mode = WAL").execute(&pool).await?;
    sqlx::query("PRAGMA synchronous = NORMAL").execute(&pool).await?;
    sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
```

WAL mode (concurrent reads + 1 writer). `NORMAL` sync — safe and 5× faster than `FULL`. FK enabled.

#### 3.2.5 `sessions/mod.rs` — public API

```rust
pub async fn list(state: &AppState) -> Result<Vec<SessionSummary>>;
pub async fn create(state: &AppState, req: CreateRequest) -> Result<Session>;
pub async fn connect(state: &AppState, tmux_name: &str, name: Option<&str>) -> Result<Session>;
pub async fn get(state: &AppState, name: &str) -> Result<SessionDetail>;
pub async fn start(state: &AppState, name: &str, prompt: Option<&str>) -> Result<StartResult>;
pub async fn stop(state: &AppState, name: &str) -> Result<()>;                  // graceful → hard
pub async fn send_text(state: &AppState, name: &str, text: &str) -> Result<()>;
pub async fn send_keys(state: &AppState, name: &str, key: &str) -> Result<()>;
pub async fn paste(state: &AppState, name: &str, text: &str, submit: bool) -> Result<()>;
pub async fn peek(state: &AppState, name: &str, lines: usize) -> Result<String>;
pub async fn config_patch(state: &AppState, name: &str, patch: ConfigPatch) -> Result<Session>;
pub async fn delete(state: &AppState, name: &str) -> Result<()>;
pub async fn duplicate(state: &AppState, name: &str, new_name: &str) -> Result<()>;
pub async fn clone(state: &AppState, name: &str, new_name: &str) -> Result<CloneResult>;
pub async fn archive(state: &AppState, name: &str) -> Result<()>;
pub async fn wake(state: &AppState, name: &str) -> Result<()>;
pub async fn steer(state: &AppState, name: &str, text: &str) -> Result<SteerEntry>;
```

Each method acquires the per-session `tokio::sync::Mutex<SessionLock>` (stored in `state.session_locks: DashMap<String, Arc<Mutex<()>>>`).

#### 3.2.6 `sessions/tmux.rs`

```rust
pub struct Tmux<'a> { pub name: &'a str }            // amux-<name>
impl Tmux<'_> {
    pub async fn new_session(&self, dir: &Path, env: &HashMap<String, String>) -> Result<()>;
    pub async fn kill_session(&self) -> Result<()>;
    pub async fn capture_pane(&self, lines: usize) -> Result<String>;
    pub async fn send_text(&self, text: &str) -> Result<()>;       // uses load-buffer for >400 chars
    pub async fn send_key(&self, key: &str) -> Result<()>;
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()>;
    pub async fn pipe_pane(&self, target_path: &Path) -> Result<()>; // tee >> log > fifo
    pub async fn pane_pid(&self) -> Result<Option<u32>>;
    pub async fn exists(&self) -> Result<bool>;
}
```

All methods are thin `tokio::process::Command` wrappers. Each shells out to `tmux` (located via `which::which`).

#### 3.2.7 `sessions/pty.rs` — the live stream

```rust
pub struct PtyStream {
    pub name: String,
    pub fifo: PathBuf,                                    // /tmp/amux-pty-<name>.fifo
    pub log: PathBuf,                                     // ~/.amux-v3/logs/<name>.log
    pub replay: Arc<RwLock<VecDeque<Bytes>>>,             // last 64 KB
    pub broadcast: broadcast::Sender<Bytes>,              // capacity 256
}
impl PtyStream {
    pub async fn ensure_started(&self, tmux: &Tmux<'_>) -> Result<()>;
    // mkfifo if not exists, pipe-pane (idempotent), spawn reader task
    pub fn subscribe(&self) -> (Vec<Bytes>, broadcast::Receiver<Bytes>);
    // returns current replay snapshot + a fresh receiver
}
```

The reader task:
```rust
let mut reader = tokio::fs::OpenOptions::new().read(true).open(&fifo).await?;
let mut buf = [0u8; 8192];
loop {
    match reader.read(&mut buf).await {
        Ok(0) => { /* re-open fifo */ }
        Ok(n) => {
            let chunk = Bytes::copy_from_slice(&buf[..n]);
            push_replay(&replay, &chunk);
            let _ = broadcast.send(chunk);  // drops if no subs — fine
        }
        Err(e) => { tracing::warn!(?e, "fifo read"); sleep(100ms); }
    }
}
```

#### 3.2.8 `sessions/status.rs` — multi-signal detector

State machine — see §3.6 for the full spec.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status { Active, Waiting, Idle, Stopped, Unknown }

pub struct StatusDetector {
    last_pty_byte_at: Instant,           // updated by pty reader
    last_hook_event_at: Option<Instant>, // updated by Claude SettingsHook
    last_status: Status,
}
impl StatusDetector {
    pub fn detect(&mut self, capture: &str) -> Status { /* see §3.6 */ }
}
```

Status detection is a **pure function** of the inputs. Tests use golden fixtures in `tests/status_detector.rs`.

#### 3.2.9 `ws/mod.rs`

```rust
pub async fn handle_ws(
    ws: WebSocketUpgrade,
    Path(name): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> impl IntoResponse {
    // 1. validate origin (close 1008 on mismatch)
    // 2. validate token (close 1008)
    // 3. ws.on_upgrade(move |sock| handle_socket(sock, name, state))
}

async fn handle_socket(sock: WebSocket, name: String, state: AppState) {
    let stream = state.pty_for(&name).await?;
    let (replay, mut rx) = stream.subscribe();
    let (mut tx_ws, mut rx_ws) = sock.split();

    // 1. send replay
    for chunk in replay { tx_ws.send(Message::Binary(chunk)).await?; }

    // 2. fan-out and ping loop
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(chunk) => tx_ws.send(Message::Binary(chunk)).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return tx_ws.send(Message::Close(Some(CloseFrame {
                            code: CloseCode::Library(1013), reason: "too slow".into()
                        }))).await
                    }
                    _ => break,
                },
                _ = tokio::time::sleep(Duration::from_secs(20)) =>
                    tx_ws.send(Message::Ping(vec![])).await?,
            }
        }
    });

    // 3. read client → tmux
    while let Some(Ok(Message::Text(s))) = rx_ws.next().await {
        let cmd: ClientMsg = serde_json::from_str(&s)?;
        match cmd {
            ClientMsg::Input { data }   => state.tmux(&name).send_text(&data).await?,
            ClientMsg::Key { data }     => state.tmux(&name).send_key(&data).await?,
            ClientMsg::Resize { cols, rows } => state.tmux(&name).resize(cols, rows).await?,
            ClientMsg::Ping             => { /* server PINGs separately */ }
        }
    }
}
```

#### 3.2.10 `board/mod.rs` — atomic claim

```rust
pub async fn claim(pool: &SqlitePool, id: &str, session: &str) -> Result<Issue, ClaimError> {
    let row = sqlx::query_as!(Issue, r#"
        UPDATE issues
        SET status = 'doing', session = ?1, updated = ?2
        WHERE id = ?3
          AND status IN ('todo', 'backlog')
          AND owner_type = 'agent'
          AND deleted IS NULL
        RETURNING ...
    "#, session, now_unix(), id).fetch_optional(pool).await?;
    row.ok_or(ClaimError::Conflict)
}
```

Single statement = atomic; no transaction needed because SQLite serialises writes.

#### 3.2.11 `files/path_safe.rs`

```rust
pub fn resolve_safe(input: &str, jail: Option<&Path>) -> Result<PathBuf, PathError> {
    let p = shellexpand::tilde(input).into_owned();
    let abs = PathBuf::from(p).canonicalize()?;        // defeats ..
    if BLOCKED.iter().any(|b| abs == Path::new(b)) { return Err(PathError::Blocked) }
    if BLOCKED_PREFIXES.iter().any(|b| abs.starts_with(b)) { return Err(PathError::Blocked) }
    if let Some(home) = dirs::home_dir() {
        for rel in HOME_BLOCKED { if abs.starts_with(home.join(rel)) { return Err(PathError::Blocked) } }
    }
    if let Some(jail) = jail { if !abs.starts_with(jail) { return Err(PathError::OutsideJail) } }
    Ok(abs)
}
```

Blocklist verbatim from §3.4 of feature-extract: `/etc/shadow`, `/etc/sudoers`, …; prefixes `/etc/ssh/`, `/var/run/secrets/`, …; home-relative `.ssh`, `.gnupg`, `.aws`, …

#### 3.2.12 `scheduler/mod.rs` — tick loop

```rust
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tick.tick().await;
            let now = chrono::Utc::now();
            let due = sqlx::query_as::<_, Schedule>(
                "SELECT * FROM schedules WHERE deleted IS NULL AND enabled=1 AND next_run <= ?"
            ).bind(now.to_rfc3339()).fetch_all(&state.pool).await?;
            for sched in due {
                let st = state.clone();
                tokio::spawn(async move { runner::run(st, sched).await });
            }
        }
    });
}
```

#### 3.2.13 `agents/wait.rs` — the wait primitive

```rust
pub async fn wait(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<WaitQuery>,
) -> Result<Json<WaitResult>, AppError> {
    let want: Status = q.state.parse()?;
    let timeout = Duration::from_secs(q.timeout.unwrap_or(600));
    let deadline = tokio::time::Instant::now() + timeout;
    let notify = state.status_notify_for(&name);

    loop {
        let cur = sessions::current_status(&state, &name).await?;
        if cur == want { return Ok(Json(WaitResult { reached: true, status: cur })) }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(Json(WaitResult { reached: false, status: cur }))
        }
        tokio::select! {
            _ = notify.notified() => continue,
            _ = tokio::time::sleep(remaining) => continue,
        }
    }
}
```

Status changes detected by `sessions::status` task fire `notify.notify_waiters()`. HTTP long-poll, no SSE complication.

### 3.3 Database schema

```sql
-- migrations/0001_init.sql
CREATE TABLE sessions (
    name             TEXT PRIMARY KEY,                          -- slug
    dir              TEXT NOT NULL,
    desc             TEXT NOT NULL DEFAULT '',
    provider         TEXT NOT NULL DEFAULT 'claude',            -- 'claude'|'codex'
    flags            TEXT NOT NULL DEFAULT '',                  -- shlex-style
    pinned           INTEGER NOT NULL DEFAULT 0,                -- 0|1
    archived         INTEGER NOT NULL DEFAULT 0,
    auto_continue    INTEGER NOT NULL DEFAULT 0,
    auto_continue_msg TEXT NOT NULL DEFAULT 'continue',
    rate_limit_resume_text TEXT NOT NULL DEFAULT 'continue',
    tags             TEXT NOT NULL DEFAULT '[]',                -- JSON array
    creator          TEXT NOT NULL DEFAULT '',
    branch           TEXT NOT NULL DEFAULT '',
    worktree         INTEGER NOT NULL DEFAULT 0,
    worktree_repo    TEXT NOT NULL DEFAULT '',
    mcp              TEXT NOT NULL DEFAULT '',                  -- '' or 'chrome'
    created_at       INTEGER NOT NULL,
    start_count      INTEGER NOT NULL DEFAULT 0,
    last_started     INTEGER NOT NULL DEFAULT 0,
    last_send        INTEGER NOT NULL DEFAULT 0,
    last_send_text   TEXT NOT NULL DEFAULT '',
    task_summary     TEXT NOT NULL DEFAULT '',
    cc_session_name  TEXT NOT NULL DEFAULT '',
    cc_conversation_id TEXT NOT NULL DEFAULT '',
    codex_session_id TEXT NOT NULL DEFAULT '',
    start_error      TEXT NOT NULL DEFAULT '',
    CHECK (provider IN ('claude', 'codex'))
);
CREATE INDEX idx_sessions_pinned ON sessions(pinned DESC, last_send DESC);

CREATE TABLE session_runtime (    -- ephemeral but persisted across restarts
    name                  TEXT PRIMARY KEY REFERENCES sessions(name) ON DELETE CASCADE,
    rate_limit_reset_at   INTEGER NOT NULL DEFAULT 0,
    hibernated            INTEGER NOT NULL DEFAULT 0,
    restarting            INTEGER NOT NULL DEFAULT 0,
    last_claude_alive_pid INTEGER NOT NULL DEFAULT 0,
    last_status           TEXT NOT NULL DEFAULT 'unknown',
    last_status_at        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tracked_files (
    session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    path    TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (session, path)
);

CREATE TABLE steering_queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session   TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    text      TEXT NOT NULL,
    queued_at INTEGER NOT NULL
);

CREATE TABLE share_tokens (
    token     TEXT PRIMARY KEY,
    session   TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    perms     TEXT NOT NULL,                       -- 'output'|'output+files'|'output+files+notes'
    label     TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,                            -- nullable
    created_at INTEGER NOT NULL,
    CHECK (perms IN ('output','output+files','output+files+notes'))
);
```

```sql
-- migrations/0002_board.sql
CREATE TABLE issues (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    desc        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'todo',
    session     TEXT REFERENCES sessions(name) ON DELETE SET NULL,
    creator     TEXT NOT NULL DEFAULT '',
    due         TEXT,
    due_time    TEXT,
    created     INTEGER NOT NULL,
    updated     INTEGER NOT NULL,
    deleted     INTEGER,
    owner_type  TEXT NOT NULL DEFAULT 'human',
    pinned      INTEGER NOT NULL DEFAULT 0,
    pos         REAL NOT NULL DEFAULT 0,
    notified    INTEGER NOT NULL DEFAULT 0,
    CHECK (owner_type IN ('human','agent'))
);
CREATE INDEX idx_issues_status ON issues(status, deleted, pos);
CREATE INDEX idx_issues_session ON issues(session, status, deleted);

CREATE TABLE issue_tags (
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (issue_id, tag)
);
CREATE INDEX idx_issue_tags_tag ON issue_tags(tag);

CREATE TABLE issue_counters (
    prefix TEXT PRIMARY KEY,
    next_n INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE statuses (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    position   INTEGER NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0
);
INSERT INTO statuses (id, label, position, is_builtin) VALUES
    ('backlog', 'Backlog', 0, 1),
    ('todo', 'To Do', 1, 1),
    ('doing', 'In Progress', 2, 1),
    ('review', 'In Review', 3, 1),
    ('done', 'Done', 4, 1),
    ('discarded', 'Discarded', 5, 1);
```

```sql
-- migrations/0003_schedules.sql
CREATE TABLE schedules (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    session       TEXT NOT NULL DEFAULT '',
    command       TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'tmux',         -- 'tmux'|'shell'|'boot'
    boot_dir      TEXT NOT NULL DEFAULT '',             -- for kind=boot
    boot_provider TEXT NOT NULL DEFAULT 'claude',
    boot_worktree INTEGER NOT NULL DEFAULT 0,
    sched_type    TEXT NOT NULL DEFAULT 'once',         -- 'once'|'recurring'
    recurrence    TEXT,                                  -- 'hourly'|'daily'|'weekly'|'monthly'
    run_at        TEXT,
    next_run      TEXT,
    last_run      TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    run_count     INTEGER NOT NULL DEFAULT 0,
    schedule_expr TEXT,
    watch         INTEGER NOT NULL DEFAULT 0,
    watch_timeout INTEGER NOT NULL DEFAULT 120,
    done_pattern  TEXT,
    done_action   TEXT NOT NULL DEFAULT 'disable',
    created       INTEGER NOT NULL,
    updated       INTEGER NOT NULL,
    deleted       INTEGER,
    CHECK (kind IN ('tmux','shell','boot'))
);
CREATE INDEX idx_schedules_due ON schedules(deleted, enabled, next_run);

CREATE TABLE schedule_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    ran_at      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'ok',             -- 'ok'|'error'|'done'
    note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_schedule_runs_sid ON schedule_runs(schedule_id, ran_at DESC);
```

```sql
-- migrations/0004_runtime_state.sql
CREATE TABLE prefs (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE skills (
    name    TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated INTEGER NOT NULL
);

CREATE TABLE snippets (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT NOT NULL,
    body    TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
);

CREATE TABLE kbd_groups (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    keys     TEXT NOT NULL,                              -- JSON: [{label,key},…] length 4
    position INTEGER NOT NULL DEFAULT 0
);
```

### 3.4 HTTP + WebSocket API

Comprehensive endpoint list — see `research/amux-feature-extract.md` §1.1, §2.1, §3.1, §4.1, §5 for exhaustive shapes. v3 keeps the URL surface, with these explicit additions:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agents/{name}/wait?state=idle&timeout=600` | **NEW.** Long-poll until session reaches state. 600s max timeout. |
| POST | `/api/agents/delegate` | **NEW.** `{from, to, prompt}` — sends prompt to `to`, records delegation edge. |
| GET | `/api/agents/delegations?session=X` | **NEW.** Returns delegation edges in/out of session for graph view. |
| GET | `/api/snippets` / POST / DELETE / PATCH | **NEW.** Saved-command CRUD (used by snippet picker). |
| GET | `/api/kbd-groups` / POST / DELETE / PATCH | **NEW.** Accessory-bar group CRUD. |

Everything else is the canonical list from `research/amux-feature-extract.md` Appendix B. Notable shape decisions:

- **SSE event format**: same JSON-on-data-line as v2, but emitted via axum SSE adapter. Event types `sessions`, `board`, `schedules`, `alerts`, `ping`, `status` (NEW: just the per-session status changes, not full session list). Ping every 10s.
- **WS subprotocol**: none. Binary frames for pty bytes, text frames for JSON control. Same `ClientMsg` shape as v2: `input`/`key`/`resize`/`ping`.
- **Auth**: `?_token=` (preferred) or `Authorization: Bearer`. WS only supports query (browser limitation).
- **Status codes**: 200 OK, 201 Created, 202 Accepted (stop returns immediately), 400 BadRequest, 401 Unauthorized, 403 Forbidden, 404 NotFound, 409 Conflict (claim race), 410 Gone (deleted), 500 InternalServerError.
- **All responses**: `application/json` with shape `{ ok: bool, data?: T, error?: string }`. Error code mapping in `error.rs`.

### 3.5 tmux integration

Same conventions as v2 (§1.4 of feature-extract):

- tmux session name = `amux-<name>`.
- `new-session -d -s amux-<name> -n <name> -c <dir> -e AMUX_SESSION=<name> -e AMUX_URL=https://localhost:8823 <SHELL>`.
- `set-option remain-on-exit on`, `allow-rename off`, `automatic-rename off`.
- After spawn: source `~/.zprofile`/`~/.bash_profile`/`~/.profile` (whichever exists), `cd <dir>`, then send the `claude` (or `codex`) command.
- `pipe-pane -O -t <target> 'tee -a <log> > <fifo>'` for live stream. Replaces any existing pipe (idempotent).
- For session adoption (`/api/sessions/connect`): read `pane_current_path`, rename tmux to `amux-<name>`, write DB row.

Wait-for-ready poll: `tmux capture-pane` every 1s, looking for `❯` or `❱` or known Claude UI tokens, max 10s. If resume picker stuck → send `Escape Escape C-c`, clear `cc_session_name`/`cc_conversation_id`, retry with `--name`. Same as v2.

### 3.6 Live status detector (the killer feature)

**Goal**: when the UI says "waiting", the agent is actually waiting. cmux issue #1027 publicly failed at this; v3's bar is to never get it wrong twice in a row.

**Multi-signal fusion**:

1. **PTY heartbeat** (`last_pty_byte_at`). If bytes flowed in the last 1.5s → likely `Active`. If silent ≥30s → likely `Idle`.
2. **Capture-pane regex bank** (the v2 detector, ported verbatim with golden-fixture tests).
3. **Claude Code SettingsHook events** (NEW). amux-v3 writes `~/.claude/settings.json` with hooks:
   ```json
   {
     "hooks": {
       "PreToolUse":  [{"matcher": "*", "hooks": [{"type":"command","command":"curl -fsS --max-time 1 -X POST -H 'Authorization: Bearer $AMUX_TOKEN' $AMUX_URL/api/_internal/hook -d '{\"session\":\"'$AMUX_SESSION'\",\"event\":\"pre_tool\"}'"}]}],
       "PostToolUse": [...],
       "Notification": [...],
       "Stop":         [...],
       "SubagentStop": [...]
     }
   }
   ```
   Each hook fires a POST to `/api/_internal/hook` which the StatusDetector consumes. Event types: `pre_tool` (Active), `post_tool` (Idle-candidate), `notification` (Waiting), `stop` (Idle), `subagent_stop` (Idle).
4. **Prompt pattern** (capture-pane string matches). Same regex bank as v2 §1.3.
5. **Idle timeout**. No PTY bytes + no active markers for ≥30s → `Idle`.

**Fusion rule (per-session, runs every 2s)**:

```rust
fn detect(&mut self, capture: &str, last_pty: Instant, last_hook: Option<(Instant, HookEvent)>) -> Status {
    // 1. fresh hook events outrank parsing
    if let Some((t, evt)) = last_hook {
        if t.elapsed() < Duration::from_secs(3) {
            return match evt {
                HookEvent::Notification => Status::Waiting,
                HookEvent::PreToolUse   => Status::Active,
                HookEvent::Stop | HookEvent::SubagentStop => Status::Idle,
                _ => self.last_status,
            };
        }
    }
    // 2. capture-pane regex bank (active/waiting markers from v2 §1.3)
    if regex::ACTIVE_BANK.is_match(capture)  { return Status::Active }
    if regex::WAITING_BANK.is_match(capture) { return Status::Waiting }
    if regex::IDLE_BANK.is_match(capture)    { return Status::Idle }
    // 3. pty heartbeat fallback
    if last_pty.elapsed() < Duration::from_millis(1500) { return Status::Active }
    if last_pty.elapsed() > Duration::from_secs(30)     { return Status::Idle }
    self.last_status
}
```

**Per-status side-effects** (in a separate `auto_actions.rs` task, NOT in the detector):
- `Active|Waiting → Idle`: complete board issue, pickup next.
- Any → `Stopped`: mark restarting=true if auto_continue, schedule restart.
- `Active|Waiting → Waiting` (sustained ≥5s): emit alert + push.

**Tests**: 30 golden capture-pane snapshots from real Claude / Codex sessions, plus 5 corruption snapshots, in `tests/fixtures/status/*.txt`. Each is paired with a `.expected` file containing one of `active|waiting|idle`. `insta` snapshot-tests guarantee no regressions when the regex bank evolves.

### 3.7 `wait` primitive

HTTP long-poll, 600s max timeout. Each session has a `tokio::sync::Notify` in `state.status_notify: DashMap<String, Arc<Notify>>`. The status-detector task calls `notify.notify_waiters()` on every state change. The `wait` handler `tokio::select!`s on (timeout, notify) and re-queries on each notify.

```bash
# CLI usage (via auto-installed amux stub):
amux wait worker-2 --state done --timeout 600
# Returns: {"reached": true, "status": "idle"} or {"reached": false, "status": "active"}
```

Frontend uses this for the delegation graph view: when an agent runs `amux wait`, the UI shows a "waiting on worker-2" pill on the source session.

### 3.8 Scheduler tick loop

`tokio::time::interval(Duration::from_secs(10))`. Three job kinds:

1. **`kind = 'tmux'`** — send `command` to `session`. Same as v2.
2. **`kind = 'shell'`** — `tokio::process::Command::new("/bin/bash").arg("-c").arg(&command)` with 600s timeout. Same as v2.
3. **`kind = 'boot'`** — **NEW**. Spawn a new session with `boot_dir`, `boot_provider`, `boot_worktree`, then send `command` as the initial prompt. This is the "spawn a `/cso` agent every Monday 9am" workflow.

Expression parser (`parser.rs`): supports the v2 expression grammar (`in 30m`, `every 5m`, `every weekday at HH:MM`, `daily at HH:MM`, 5-field cron). Built on `cron::Schedule` for cron + custom parser for the rest.

Watch mode: same as v2 — poll `tmux capture-pane` every 5s for up to `watch_timeout`s; match `done_pattern` regex; on match fire `done_action` (`disable`, `notify`, or `command:<text>`).

### 3.9 Background tasks (overview)

Spawned once at startup in `main.rs`:

| Task | Interval | Purpose |
|---|---|---|
| `sessions::pty::reader` | per-session, FIFO-driven | drain pty → broadcast |
| `sessions::status::detector` | 2s per session | multi-signal status detection |
| `sessions::auto_actions::rate_limit` | 3s | detect rate-limit prompt, auto-resume after reset |
| `sessions::auto_actions::yolo` | 3s | auto-press 1 on "Do you want to proceed?" when YOLO flag set |
| `sessions::auto_actions::compact` | 60s | auto `/compact` when context >85% |
| `sessions::auto_actions::hibernate` | 60s | stop sessions idle >30min (wakes on send) |
| `sessions::auto_actions::reaper` | 1h | restart sessions whose Claude pid is >48h old |
| `scheduler::tick` | 10s | run due schedules |
| `sse::keepalive` | 10s | emit `{type:"ping"}` event |
| `db::maintenance` | 24h | VACUUM, prune schedule_runs >30 days |

Each task is a `tokio::spawn`'d future that borrows `Arc<AppState>`. Errors are logged but never propagate (the task is fire-and-forget; logging is the only feedback channel).

---

## 4. Frontend (React) detailed design

### 4.1 Routing

```tsx
// App.tsx — react-router-dom v7
<BrowserRouter>
  <ThemeProvider>
    <QueryClientProvider>
      <Routes>
        <Route path="/"               element={<Overview />} />
        <Route path="/focus/:name"    element={<Focus />} />
        <Route path="/board"          element={<Board />} />
        <Route path="/files/:name?"   element={<Files />} />
        <Route path="/scheduler"      element={<Scheduler />} />
        <Route path="/settings"       element={<Settings />} />
      </Routes>
      <ReconnectBanner />
    </QueryClientProvider>
  </ThemeProvider>
</BrowserRouter>
```

Each route renders responsive layouts (Tailwind `md:` breakpoint at 768px = desktop). Focus route forks into `<DesktopFocus />` and `<MobileFocus />` based on `useMediaQuery`.

State deps:
- All routes read sessions from `useSessions()` (TanStack Query against `/api/sessions`, SSE-driven invalidation).
- Focus route reads from `useLiveTerm(name)` for terminal bytes.
- Board route reads from `useBoard()`.

### 4.2 Component hierarchy (selected)

```
<Overview>
  <Header viewMode toggle search />
  {viewMode === 'tile'
    ? <TileGrid> { sessions.map(s => <SessionTile session={s} />) } </TileGrid>
    : <SessionList> { sessions.map(s => <SessionRow session={s} />) } </SessionList>}
  <Fab onClick={openNewSessionSheet} />
</Overview>

<DesktopFocus>
  <SessionStrip width={320}>
    {sessions.map(s => <CompactTile session={s} active={s.name === current} />)}
  </SessionStrip>
  <MainPane>
    <FocusHeader session={current} onDetach onClose />
    <LiveTerminal name={current.name} />
    <DesktopDock />
  </MainPane>
</DesktopFocus>

<MobileFocus>
  <SessionPill onTap={openPicker} />
  <VaulSheet detents={['40vh','100vh']} initial='100vh'>
    <FocusHeader minimal />
    <LiveTerminal name={current.name} />
    <MobileDock>
      <SessionChip />
      <KbdToggle />
      <SpecialsButton onClick={openSpecialsSheet} />
      <InputField />
    </MobileDock>
    <AccessoryBar />
    <Joystick />
  </VaulSheet>
</MobileFocus>
```

### 4.3 The session-tile component (HERO — pixel-spec)

**File**: `web/src/components/session-tile/tile.tsx`. **Lines**: ~180 LOC.

**Default state (idle in grid)**:
- Card width: 100% of grid cell, aspect ratio 4:3 (so 320×240 at the most common breakpoint).
- Border-radius: `12px` (`rounded-xl`).
- Background: `bg-card` (semantic token; light=white, dark=neutral-900). Border `1px solid` of `border` token.
- Inner padding: `12px` top, `0` bottom (the terminal-tail-preview butts the bottom edge).
- **Title row** (top, 32px tall): Claude chat description (falls back to session name) in `text-sm font-medium`, truncated. Status dot 8×8px on the right. Token count + branch in `text-xs text-muted-foreground` underneath (16px tall).
- **Terminal tail preview** (bottom, fills remaining ~150px): rendered as static text via `<TailPreview lines={s.preview_lines} />` — a CSS-only block, `font-mono text-[10.5px] leading-[14px] text-zinc-700 dark:text-zinc-300`. ANSI stripped. Top-fade mask: `mask-image: linear-gradient(to bottom, transparent 0%, black 24px)`. Last 6 lines visible, anchored to bottom.

**Hover state** (desktop, pointer:fine media query):
- Framer Motion `whileHover` → `scale: 1.06, zIndex: 10` with `transition={{ type: 'spring', stiffness: 380, damping: 24 }}`.
- The TailPreview expands its visible lines from 6 → 14 (CSS variable bumped via `whileHover`).
- A subtle outer glow appears: `boxShadow: '0 12px 36px -8px rgba(0,0,0,0.18)'`.
- Mouse leaves → snaps back via same spring.

**Active state** (status === 'active'):
- A subtle pulsing border via Framer Motion `animate={{ boxShadow: ['inset 0 0 0 1px hsl(var(--accent)/0.5)', 'inset 0 0 0 1px hsl(var(--accent)/0.0)'] }}` with `repeat: Infinity, duration: 1.6, ease: 'easeInOut'`.

**Waiting state** (status === 'waiting'):
- Blue pulse border using same pattern but a `hsl(214 95% 60%)` color, slower (2.2s), and a tiny "Needs input" pill at the top-right (10px text, semibold, full-pill capsule).
- Plays a one-shot subtle haptic on transition into waiting (`window.navigator.vibrate?.(8)`), debounced.

**Click**:
- `onClick={() => navigate(`/focus/${s.name}`)}`. The route transition uses View Transitions API (Chromium-only enhancement; fallback = instant). The TileTransitionName is set via `style={{ viewTransitionName: 'session-' + s.name }}` so the tile morphs into the focus header.

**Mobile** (pointer:coarse):
- No hover state (CSS `@media (hover: hover)` gates it).
- Tap = focus.
- **Long-press** (350ms via `useLongPress`): opens a "quick-peek" modal showing the full LiveTerminal in a read-only embed, fingerprint-shaped capsule on the screen with a close X. This is the "I want to see what it's doing without committing to focus mode" gesture.

**Acceptance** (per `termius-ios-native-spec.md`):
- Spring values match Termius §SwiftUI spring presets §Recommended values.
- Tap-press scale = 0.96, 100ms ease-out (see #1 of acceptance criteria).
- Hit target ≥44pt on mobile.

### 4.4 The focus-mode component (HERO — pixel-spec)

**File**: `web/src/components/focus-mode/*.tsx`. **Lines**: ~620 LOC across desktop + mobile + dock.

**Desktop layout** (≥768px):
- Two-column flex. Left: 320px wide session-strip (vertical scroll, the compact tiles). Right: main pane.
- Main pane: full-height column. Header (44px), terminal (flex-1), dock (bottom).
- **Keyboard capture**: on focus mount, the xterm DOM node gets `tabIndex={0}` + auto-focus. A document-level keydown listener (in `LiveTerminal`) intercepts all keys EXCEPT the global shortcut bank (Cmd+K, Cmd+D = detach, Cmd+W = stop session, Cmd+1..9 = jump session). Caught keys are sent via `ws.send({type: 'key', data: tmuxKeyFor(e)})` or `{type: 'input', data: textFor(e)}`. xterm's own input handler is disabled (`Terminal.onData` IS used however to push composed input — we let xterm handle IME).
- **Detach affordance**: explicit button labeled "Detach" with ⌘D, plus the keyboard shortcut. Returns to overview WITHOUT killing the session. View Transition morphs back.
- **Status banner**: rendered globally; pinned 8px below top in this view too (Termius §Reconnect banner).

**Mobile layout** (<768px):
- Full-screen takeover via Vaul drawer.
- **Detents**: `peek` = 40vh (terminal visible but bottom-half), `full` = 100vh.
- **Default detent on open**: `full`.
- **Rubber-band** above full: per Termius §Apple Maps spec — `(x * d * 0.55) / (d + 0.55 * x)`. Vaul exposes this via `dampOnOverScroll`; we pass `0.55`.
- **Velocity dismiss**: >1200 pt/s downward → drop to peek. Vaul's `dismissible` + custom velocity-snap callback.
- **Drag indicator**: 36×5 px, `bg-muted-foreground/30`, 2.5px radius, 6px from top. Auto-shown by Vaul.
- **Top bar** (44px + safe-area-top): chevron-back (left edge), session title (truncating), `···` overflow (right).
- **Terminal**: middle, fills available height between top bar and dock.
- **Bottom dock** (56pt + safe-area-bottom): see §4.4.1.
- **Accessory bar** (above keyboard, 44pt): see §4.4.2.

#### 4.4.1 Mobile bottom dock

```
┌──────────────────────────────────────────────────────────────┐
│ [session-pill ▾]  [⌨ toggle]  [···]  [input ───────→ send]   │
└──────────────────────────────────────────────────────────────┘
```

- **Session pill** (left, 32px tall, capsule): shows current session name + status dot. Tap = open session picker sheet (full list, selectable). Horizontal swipe LEFT on this pill switches to next session; RIGHT to prev.
- **Keyboard toggle** (32×32): shows current keyboard state; tap = show/hide native keyboard.
- **Specials** (32×32, `···` glyph): tap = open "Specials" sheet — a half-detent sheet showing all kbd-groups (Agent, Shell, Tmux, Symbols, user-custom). Each group is a 2×2 grid of 4 keys.
- **Input field**: when keyboard up, grows from 32px to max 80px (3 lines). On typing `/` at start, the slash menu appears.
- **Send button**: 32×32 circular, right edge. Disabled (40% opacity) when input is empty.

#### 4.4.2 Accessory bar (above keyboard)

Termius pattern. 44pt tall. Layout:

```
┌─[Back]─[Gesture]─[⌨]─[···]─[Settings]─┃─[F1]─[F2]─[F3]─[F4]─┐
│   gray nav (5)                       page indicator dots    │
└──────────────────────────────────────────────────────────────┘
```

- 5 fixed gray chips on the LEFT: Back (chevron), Gesture toggle (joystick on/off), Keyboard toggle, More (opens groups list), Settings (opens manage sheet).
- 4 user-editable function-key chips on the RIGHT: e.g. [Esc] [Tab] [Ctrl-C] [Ctrl-U].
- **Swipe on the right area** = page between groups. Snap with `.snappy(duration: 0.25)`, `decelerationRate = 0.99`.
- **Page indicator** dots beneath the function-key area; auto-fade after 1.5s.
- **Each chip**: ≥44×44 hit target, 32px visible height. `bg-muted` (gray) or `bg-card` (white). 8px continuous corner radius. Font: SF Mono 13pt semibold for symbols.

### 4.5 LiveTerminal hook

```ts
// hooks/use-live-term.ts
export type LiveTermState = 'connecting' | 'live' | 'reconnecting' | 'offline'

export function useLiveTerm(name: string): {
  containerRef: React.Ref<HTMLDivElement>
  state: LiveTermState
  send(text: string): void
  sendKey(name: string): void
  resize(cols: number, rows: number): void
  copyAll(): void
} {
  const termRef = useRef<XTerm.Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // 1. on mount: new Terminal({...fontFamily, fontSize, theme...}), .open(container), .loadAddon(CanvasAddon), FitAddon.fit()
  // 2. WS connect with exponential backoff (300ms × 2^n cap 30s)
  //    on permanent codes (1008, 1011, 1013, 4001): stop reconnecting, show "offline"
  // 3. ws.onmessage(blob) → term.write(new Uint8Array(blob))
  // 4. term.onData(s) → ws.send({type:'input', data: s})
  // 5. ResizeObserver on container → debounce 100ms → FitAddon.fit() + ws.send({type:'resize', cols, rows})
  return { containerRef, state, send, sendKey, resize, copyAll }
}
```

Implementation notes:
- `xterm.js` v5.5+ with `@xterm/addon-canvas` + `@xterm/addon-fit` + `@xterm/addon-web-links`.
- Theme uses CSS variables read at mount: `getComputedStyle(document.documentElement).getPropertyValue('--terminal-fg')`.
- Replay buffer arrives as the first WS message; `term.write` handles it transparently.
- Reconnect handles close codes 1011 (server), 1008 (auth/origin), 1013 (subscriber limit), 4001 (explicit) as PERMANENT — no retry; UI shows "Tap to retry" button. All other closes → exponential backoff with banner.

### 4.6 State management (Zustand)

```ts
// stores/ui-store.ts
export const useUI = create<UIStore>()(persist((set) => ({
  theme: 'dark',
  viewMode: 'tile' as 'tile' | 'list',
  dockOpen: true,
  setTheme: (t) => set({ theme: t }),
  setViewMode: (v) => set({ viewMode: v }),
}), { name: 'amux-v3-ui' }))

// stores/focus-store.ts
export const useFocus = create<FocusStore>((set) => ({
  currentSessionId: null,
  set: (id) => set({ currentSessionId: id }),
}))

// stores/prefs-store.ts — synced with backend /api/prefs and /api/snippets etc.
```

Total ~120 LOC across all stores. TanStack Query is the source of truth for server data; Zustand for ephemeral UI state.

### 4.7 Animations spec (Framer Motion preset bank)

```ts
// lib/springs.ts
export const springs = {
  // matches Termius spec §SwiftUI Recommended values
  buttonPress:    { type: 'spring', stiffness: 700, damping: 30, mass: 0.5 } as const,
  toggleSnap:     { type: 'spring', stiffness: 320, damping: 24 } as const,
  sheetDetent:    { type: 'spring', stiffness: 280, damping: 30 } as const, // response 0.45, damp 0.82
  cardExpand:     { type: 'spring', stiffness: 380, damping: 28 } as const, // response 0.32, damp 0.72
  snappy:         { type: 'spring', stiffness: 500, damping: 32 } as const, // 0.25s feel
  smooth:         { type: 'spring', stiffness: 200, damping: 28 } as const, // 0.4s
  tileHover:      { type: 'spring', stiffness: 380, damping: 24 } as const,
  statusMorph:    { type: 'spring', stiffness: 500, damping: 32 } as const,
} as const

export const eases = {
  out:   [0.2, 0, 0, 1]   as const,        // 100ms button press
  inOut: [0.4, 0, 0.2, 1] as const,        // 200ms generic
} as const
```

EVERY motion in the app uses one of these. No `transition: all`. No ad-hoc cubic-bezier. PR review enforces.

### 4.8 Mobile-first responsive rules

- Tailwind v4 breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`.
- **Desktop layouts** activate at `md` (≥768px).
- **Touch optimisations** gated by `@media (pointer: coarse)` — hover states removed, hit targets enlarged.
- **Safe area** handled via `padding-top: env(safe-area-inset-top)` etc. (Tailwind plugin `tailwindcss-safe-area`).
- **Viewport meta**: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`.
- **Apple PWA meta**: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`.

### 4.9 PWA manifest + service worker

```json
// public/manifest.json
{
  "name": "amux",
  "short_name": "amux",
  "start_url": "/?source=pwa",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    {"src":"/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any maskable"},
    {"src":"/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any maskable"}
  ]
}
```

Service worker via `vite-plugin-pwa` (Workbox under the hood). Caching strategy:
- HTML shell: `NetworkFirst`, 3s timeout.
- JS/CSS hashes: `CacheFirst` indefinitely (fingerprinted).
- API GETs: bypass (always network).
- WS: bypass.

Background sync (later v3.1): queue `POST /api/sessions/{name}/send` calls when offline; replay on `online` event with conflict alert.

### 4.10 Capacitor-ready

To preserve a clean Capacitor wrap path later:
- **NO localStorage for auth-critical data** — keep using `window._AMUX_AUTH_TOKEN` which Capacitor will inject via WebView script.
- **NO native browser features that Capacitor doesn't bridge** by default. Avoid `webkitDirectory`, `<a download>` without filename.
- **Always use `import.meta.env.BASE_URL`** for routing so Capacitor's `capacitor://localhost` origin works.
- **Vaul + Framer Motion both work fine in WKWebView** (verified by community).
- **xterm.js works in WKWebView** but Canvas addon performance is poorer than DOM; ship Canvas for desktop, DOM for mobile (or detect Capacitor and degrade).
- **Service worker**: disabled inside Capacitor (Capacitor handles caching natively). The PWA manifest is unused too.

---

## 5. Data flow diagrams

### 5.1 Session boot

```
User clicks "+" in overview
  ─POST /api/sessions {name, dir, provider, worktree}─►  backend
                                                          ├─ INSERT INTO sessions
                                                          ├─ create worktree if requested
                                                          └─ respond 201 {ok}
User clicks "Start" or sends an initial prompt
  ─POST /api/sessions/{name}/start {prompt}─►            backend
                                                          ├─ acquire session lock
                                                          ├─ tmux new-session -d -s amux-{name} ...
                                                          ├─ pipe-pane to fifo
                                                          ├─ spawn pty reader task
                                                          ├─ send "claude --resume X" or "--name X"
                                                          ├─ poll capture-pane for ❯ (max 10s)
                                                          ├─ if prompt: send_text(prompt) after readline settle
                                                          └─ respond {ok, message, resumed}
SSE pushes {type:"sessions", payload:[...]} (delta) to all clients
Frontend invalidates useSessions(); tile updates with status=active
```

### 5.2 Terminal keystroke

```
User types 'l' in xterm focus
  xterm.onData('l') → wsRef.current.send(JSON.stringify({type:'input', data:'l'}))
  ─ws frame─►  backend ws handler
                ├─ parse ClientMsg::Input { data: "l" }
                ├─ acquire session lock
                └─ tmux send-keys -t amux-name -l 'l'
  ◄─pty byte (fifo)─  tmux writes 'l' to pty
                ┌─ reader task fires broadcast::send(Bytes("l"))
                ├─ for each subscriber Receiver: forward
                └─ ws handler send_task: tx_ws.send(Message::Binary(b"l"))
  ◄─binary ws frame─  to all subscribed browsers (incl. originator for echo)
  xterm.write(byte) → renders 'l'
End-to-end latency: <30ms LAN, <100ms over Tailscale.
```

### 5.3 WS reconnect

```
Network blip → close event (code 1006)
  ─ws.onclose─►  useLiveTerm hook
                ├─ setState('reconnecting')
                ├─ backoff = min(300 * 2^attempt, 30000)
                ├─ ReconnectBanner shows amber pill "Reconnecting…"
                └─ setTimeout(connect, backoff)
On reconnect:
  ─ws open─►   backend
                ├─ replay buffer sent immediately (up to 64KB)
                ├─ xterm.write(replay) → terminal restored
                └─ subscriber added back to broadcast
  ReconnectBanner morphs amber→green "Connected", auto-dismiss 1.2s
```

### 5.4 Status detector cycle

```
Every 2s, per session, status task tick:
  ├─ capture = tmux capture-pane -p -S -30
  ├─ status = detector.detect(capture, last_pty_byte_at, last_hook_event)
  └─ if status != last_status:
        ├─ UPDATE session_runtime SET last_status=?, last_status_at=?
        ├─ status_notify.notify_waiters()  (wakes /agents/{name}/wait)
        └─ sse_tx.send(Event::Status { name, status })
Frontend SSE handler:
  ├─ on Event::Status: queryClient.setQueryData(['session', name], (s) => ({ ...s, status }))
  └─ tile re-renders with new dot color
```

### 5.5 Scheduler tick

```
Every 10s, scheduler::tick:
  ├─ SELECT * FROM schedules WHERE deleted IS NULL AND enabled=1 AND next_run <= NOW
  ├─ for each: tokio::spawn(runner::run(state, sched))
runner::run:
  ├─ match kind:
  │     'tmux' → sessions::send_text(session, command)
  │     'shell'→ tokio::process::Command::new("bash").arg("-c").arg(command)
  │     'boot' → sessions::create + sessions::start(prompt=command)
  ├─ INSERT INTO schedule_runs (sched_id, ran_at, status, note)
  ├─ UPDATE schedules SET last_run=NOW, run_count=run_count+1
  ├─ recompute next_run from schedule_expr (or disable if sched_type='once')
  └─ if watch=1 and kind='tmux': tokio::spawn(watch::poll(state, sched, pre_output))
```

---

## 6. Security

### 6.1 Auth

- **Bearer token required on EVERY route by default**. Middleware applied at the router root, EXCEPT the explicit public-routes router (manifest, sw, icons, base HTML — and base HTML embeds the token inline for in-browser use, so it's only secret to non-authorised network observers).
- **No localhost bypass**. v2's `/api`+`/ws` carve-out is brittle and was a CVE class; v3 simply requires the token everywhere.
- **Constant-time compare** (`constant_time_eq::constant_time_eq`).
- **AUTH_TOKEN in HTML body trade-off**: the token is rendered into the served HTML via `window._AMUX_AUTH_TOKEN`. Acceptable risk because we bind only to `127.0.0.1` + Tailscale interface, and Tailscale provides device-level auth. Documented in CLAUDE.md.

### 6.2 Origin allowlist (WS)

- `localhost`, `127.0.0.1`, auto-detected LAN IP, `*.ts.net`.
- Other Origin → close 1008.

### 6.3 Path safety (files)

- Same blocklist as v2 §3.4 of feature-extract — `/etc/shadow`, `/etc/sudoers`, `/etc/ssh/*`, `/var/run/secrets/*`, home-relative `.ssh`/`.gnupg`/`.aws`/`.kube`/`.netrc`/`.npmrc`/`.docker`/`.config/gcloud`/`.config/gh`.
- All paths canonicalized via `PathBuf::canonicalize()` before the check.
- Optional jail param for session-scoped views (rooted at `CC_DIR`).

### 6.4 Audit log

- Every destructive HTTP call (DELETE, PATCH that flips dangerous flags, schedule run) writes a row to a NEW `audit_log` table: `(ts, actor, action, target, detail_json)`. Actor = "user" for HTTP, "scheduler" for tick, "agent:<name>" for cross-session calls.
- Visible in Settings → Audit Log (last 200 rows; full export to JSON).

---

## 7. Testing strategy

### 7.1 Backend (cargo test)

- **Unit tests** in each module (e.g. `sessions/status.rs` has 30+ golden-fixture tests).
- **Integration tests** in `server/tests/`:
  - `http_session.rs` — boot the Router with an in-memory SQLite pool, call via `axum::Router::oneshot`. Covers CRUD + auth.
  - `ws_pty.rs` — bind an ephemeral port, connect with `tokio-tungstenite`, verify replay + bidirectional bytes + close codes.
  - `board_claim.rs` — 100 concurrent `POST /claim` calls, exactly one 200, 99 409s.
  - `status_detector.rs` — `insta::assert_snapshot!` over `tests/fixtures/status/*.txt`.
  - `scheduler.rs` — fake-clock test that a `recurring` cron triggers at the right tick.
- **Property tests** (proptest, optional): path-safety resolver never escapes its jail.

### 7.2 Frontend (Vitest + Playwright)

- **Vitest** (unit): pure-function utils (`ansi.ts`, `keys.ts`, `format.ts`); reducer-like hooks (`use-live-term` with a mocked WebSocket).
- **Playwright** (e2e): the binary boots in CI on port 18823, Playwright drives a real Chromium. Smoke tests:
  - Overview loads, tile renders, hover scales.
  - Click → focus mode, terminal renders, type "echo hi" → output appears.
  - Board: create issue, drag to new column, atomic claim race.
  - Files: open a file, edit, save.
  - Scheduler: create a `tmux` schedule for "in 5s", verify it fires.
- Mobile viewport tests in Playwright (`devices['iPhone 14 Pro']`).

### 7.3 Acceptance tests

The 20 acceptance criteria in `termius-ios-native-spec.md` §"v3 finish acceptance criteria" are turned into checklist items in `web/ACCEPTANCE.md`. Manually verified on a physical iPhone (or Playwright + device emulation where possible). 18/20 must pass before v3 ships.

---

## 8. Deployment

### 8.1 Build

```bash
# scripts/build.sh
set -euo pipefail
cd web && bun install && bun run build && cd ..
rm -rf server/static && cp -r web/dist server/static
cd server && cargo build --release
echo "binary: server/target/release/amux-server ($(du -h server/target/release/amux-server | cut -f1))"
```

### 8.2 Deploy

```bash
# scripts/deploy.sh
set -euo pipefail
HOST=clawd-02
scp server/target/release/amux-server "$HOST":/tmp/amux-server-new
ssh "$HOST" 'sudo install -m 0755 -o root -g root /tmp/amux-server-new /usr/local/bin/amux-v3-server
              sudo systemctl restart amux-v3
              sleep 2 && sudo systemctl is-active amux-v3'
```

### 8.3 systemd unit

```ini
# /etc/systemd/system/amux-v3.service
[Unit]
Description=amux v3 (Rust)
After=network.target

[Service]
Type=simple
User=sander
WorkingDirectory=/home/sander
Environment="AMUX3_DATA_DIR=/home/sander/.amux-v3"
ExecStart=/usr/local/bin/amux-v3-server
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### 8.4 Coexistence with v2

- v2 stays on port 8822 (Tailscale-served at `clawd-02.foo.ts.net`).
- v3 listens on port 8823 (Tailscale-served at a separate hostname or path via `tailscale serve` config).
- Both write to separate data dirs (`~/.amux/` vs `~/.amux-v3/`).
- Run side-by-side until v3 is dogfooded for 2 weeks without regression, then disable v2 service.

---

## 9. Migration from v2

`scripts/migrate-v2.py` (Python script; reads v2 files, writes v3 DB). One-shot, idempotent, dry-runnable.

```python
# pseudo
import sqlite3, json, glob, os, pathlib
src = pathlib.Path.home() / '.amux'
dst_db = pathlib.Path.home() / '.amux-v3' / 'data.db'

con = sqlite3.connect(dst_db)
cur = con.cursor()

# 1. sessions: read each .env + .meta.json, INSERT INTO sessions
for env_file in (src / 'sessions').glob('*.env'):
    name = env_file.stem
    env = parse_env(env_file)
    meta = json.load(open(src / 'sessions' / f'{name}.meta.json'))
    cur.execute("INSERT OR IGNORE INTO sessions (name, dir, desc, ...) VALUES (...)", ...)

# 2. board: open v2's data.db, ATTACH it, copy issues/issue_tags/issue_counters/statuses
cur.execute("ATTACH DATABASE ? AS old", (str(src / 'data.db'),))
cur.execute("INSERT OR IGNORE INTO issues SELECT * FROM old.issues")
# ... etc

# 3. schedules: same
# 4. skills: read ~/.amux/skills/*.md (or v2 skills table) → v3 skills table
# 5. prefs: copy

con.commit()
print(f"migrated {sessions} sessions, {issues} issues, {schedules} schedules")
```

**Memory + log files**: stay in their v2 locations (don't move). v3 has its own logs in `~/.amux-v3/logs/`.

---

## 10. Milestone breakdown

> The orchestrator skill (§11) reads this section to dispatch subagents. Each milestone is self-contained — given the listed deps, a subagent can execute with no further input beyond this document.

### M0 — Workspace bootstrap

- **Depends on**: nothing.
- **Scope** (~250 LOC): `cargo new server`, `bun create vite@latest web -- --template react-ts`, install Tailwind v4 + shadcn CLI + Framer Motion + Vaul + xterm.js + TanStack Query + Zustand. Generate `scripts/dev.sh` (runs `cargo watch` + `vite` concurrently), `scripts/build.sh`. Commit.
- **Acceptance**:
  - `cd server && cargo build` succeeds.
  - `cd web && bun run build` succeeds.
  - `scripts/dev.sh` starts both servers and Vite hot-reloads `web/src/App.tsx` edits in the browser.
- **Time budget**: 2h.
- **Verification**: `curl http://localhost:5173/` returns HTML; `cargo build` exits 0.
- **Subagent prompt**:
  > You are bootstrapping the amux-v3 repo skeleton. Read `/Users/sandervm/amux-v3/plan/TECH_PLAN.md` §2 (repository layout) and §3.1 (Cargo deps) and §4 (frontend stack). Create the directory tree exactly as in §2. Initialise `server/` with `cargo init --name amux-server` and populate `Cargo.toml` with the exact dep list from §3.1. Initialise `web/` with `bun create vite@latest . -- --template react-ts`, then install: react@^19, tailwindcss@^4, @tailwindcss/vite, framer-motion@^11, vaul, @xterm/xterm, @xterm/addon-canvas, @xterm/addon-fit, @xterm/addon-web-links, @tanstack/react-query, zustand, react-router-dom@^7. Wire Tailwind v4 via `@tailwindcss/vite` plugin in `vite.config.ts`. Add `scripts/dev.sh` that runs `cargo watch -x run` and `bun run dev` in parallel via `&` + `wait`. Add `scripts/build.sh` per §8.1. Write a stub `server/src/main.rs` that binds `127.0.0.1:8823` with an axum `Router::new().route("/", get(|| async { "amux v3" }))`. Write a stub `web/src/App.tsx` returning `<div>amux v3</div>`. Verify both build and `scripts/dev.sh` works. Commit "M0: workspace bootstrap" and report.

### M1 — Backend: DB layer + migrations + auth

- **Depends on**: M0.
- **Scope** (~500 LOC): `server/migrations/0001..0004.sql` per §3.3. `server/src/db/mod.rs` (pool init), `db/sessions.rs`, `db/board.rs`, `db/schedules.rs`, `db/prefs.rs`, `db/runtime_state.rs` (each with `sqlx::query_as!` typed queries). `auth.rs` middleware. `error.rs` (`AppError` enum + `IntoResponse`). `config.rs`. `state.rs` (`AppState`).
- **Acceptance**:
  - Server starts, creates `~/.amux-v3/data.db`, runs all migrations.
  - Hitting `/api/sessions` without token → 401. With `Authorization: Bearer <tok>` → 200 + `[]`.
  - `~/.amux-v3/auth_token` is created mode 0o600 on first start.
- **Time budget**: 5h.
- **Verification**: `cargo test --package amux-server db::tests` green; manual curl works.
- **Subagent prompt**:
  > You are implementing the persistence and auth layers for amux-v3. Read TECH_PLAN.md §3.2.2-3.2.4 (modules: config, auth, db), §3.3 (full schema), §6.1 (auth model). Write `server/migrations/0001_init.sql`..`0004_runtime_state.sql` containing the EXACT SQL from §3.3 — every table, column, index, CHECK constraint included. Write `server/src/db/mod.rs` with `init()` per §3.2.4. For each table, write a Rust struct `#[derive(sqlx::FromRow, Serialize)]` and typed queries in the matching `db/<name>.rs` (start with sessions and board only; the rest can be stubs). Write `auth.rs` middleware that reads token from header OR `_token` query, compares via `constant_time_eq`, returns 401 otherwise. Write `error.rs` with `AppError` enum (`Unauthorized`, `NotFound(String)`, `Conflict(String)`, `BadRequest(String)`, `Internal(anyhow::Error)`) and `IntoResponse` impl that returns `{ok:false, error:"..."}` JSON. Write `config.rs` that loads from `~/.amux-v3/config.toml` if present, else defaults. Write `state.rs`: `AppState { pool, config, session_locks, status_notify, sse_tx }`. Wire it all in `main.rs`: load config, init pool, build router with auth middleware on `/api/*`. Add three integration tests in `server/tests/auth.rs` covering: missing token=401, wrong token=401, correct token=200. Verify `cargo test` passes. Commit "M1: db + auth" and report.

### M2 — Backend: HTTP routes for sessions CRUD

- **Depends on**: M1.
- **Scope** (~600 LOC): `sessions/mod.rs` public API (create/list/get/delete/duplicate/config_patch — non-tmux parts only), HTTP handlers in `http.rs`. Tracked-files endpoints. Steering queue endpoints (DB-backed).
- **Acceptance**: All `/api/sessions/*` endpoints from §1.1 of feature-extract that don't require tmux work (~80% of them). Integration tests cover happy path + 404 + 409.
- **Time budget**: 6h.
- **Verification**: `cargo test --package amux-server http_session` green.
- **Subagent prompt**:
  > Implement the non-tmux-dependent session HTTP endpoints. Read TECH_PLAN.md §3.2.5 (sessions public API), §3.4 (HTTP endpoints), and `research/amux-feature-extract.md` §1.1 (canonical endpoint list) and §1.2 (data model). Write `server/src/sessions/mod.rs` with `list`, `create`, `get`, `delete`, `duplicate`, `config_patch` (the tmux-free subset). For each, write a handler in `server/src/http.rs` mounted via `axum::Router::route("/api/sessions", get(list_handler).post(create_handler))` etc. Sessions data model per §1.2 of feature-extract; persist to the `sessions` table from M1. Tracked-files endpoints: `/api/sessions/{name}/tracked-files` GET/POST/DELETE — use the `tracked_files` table from M1. Steering: GET/POST/DELETE `/api/sessions/{name}/steer` — uses `steering_queue` table. Write integration tests in `server/tests/http_session.rs` covering: POST create returns 201, POST duplicate name returns 409, GET non-existent returns 404, PATCH config rename works end-to-end. Skip `start/stop/send/keys/paste/clone/archive/wake/peek` — those are M3. Verify tests pass. Commit "M2: sessions CRUD" and report.

### M3 — Backend: tmux integration + session lifecycle

- **Depends on**: M2.
- **Scope** (~700 LOC): `sessions/tmux.rs` (full `Tmux` API per §3.2.6). `sessions/lifecycle.rs` (`start`, `stop`, `send_text`, `send_keys`, `paste`, `peek`, `archive`, `wake`, `clone`). Wait-for-ready logic. Resume strategy per §1.5 of feature-extract.
- **Acceptance**:
  - `POST /start` on a real machine spawns tmux + claude, returns 200.
  - `POST /send {text:"echo hi"}` causes "hi" to appear in scrollback (verifiable via `/peek`).
  - `POST /stop` cleanly exits.
  - 80-char and 1200-char texts both work (the latter via `load-buffer`).
- **Time budget**: 8h.
- **Verification**: Manual smoke + a tmux-using integration test (CI must have tmux installed).
- **Subagent prompt**:
  > Implement the tmux integration and session lifecycle. Read TECH_PLAN.md §3.2.6 (`Tmux` API), §3.5 (tmux conventions), and `research/amux-feature-extract.md` §1.4 (tmux integration), §1.5 (Claude/Codex invocation). Write `server/src/sessions/tmux.rs` with the full `Tmux<'_>` impl: every method spawns `tokio::process::Command::new("tmux").args([...])`. Use `which::which("tmux")` to locate. Capture stdout, error on non-zero exit. For `send_text`: if >400 chars, use `tmux load-buffer - + paste-buffer -p`; else `send-keys -l`. Write `server/src/sessions/lifecycle.rs` with `start`, `stop` (graceful /exit→15s grace→hard kill via `nix::sys::signal::kill`), `send_text` (acquires per-session lock, calls `Tmux::send_text` then `Enter`), `send_keys` (allowlist enforced per §1.4 of feature-extract), `paste`, `peek`, `archive`, `wake`, `clone`. Resume strategy per §1.5 of feature-extract: try `cc_session_name`, else `cc_conversation_id`, else `--name`. Wait-for-ready: poll `capture-pane` every 1s for up to 10s expecting `❯` or `❱`. Mount HTTP routes for these in `http.rs`. Write integration test `server/tests/lifecycle.rs` that spawns a session running `bash` (provider="shell" — add a test-only provider variant), sends "echo hi", waits, and asserts "hi" is in peek output. Verify. Commit "M3: tmux + lifecycle" and report.

### M4 — Backend: WebSocket pty stream

- **Depends on**: M3.
- **Scope** (~500 LOC): `sessions/pty.rs` (FIFO reader + broadcast), `ws/mod.rs` (axum WS handler), `ws/streamer.rs` (per-session singleton via `DashMap<String, Arc<PtyStream>>`), `ws/protocol.rs` (serde types).
- **Acceptance**:
  - `wss://localhost:8823/ws/sessions/{name}?_token=X` connects.
  - First message is replay (≤64 KB).
  - Subsequent bytes flow within <50ms of tmux output.
  - Client sends `{type:'input',data:'l'}` → 'l' appears at the prompt.
  - Subscribing 8 clients works; 9th gets close 1013.
  - Per-WS server PING every 20s, close after no PONG in 30s.
- **Time budget**: 8h.
- **Verification**: `cargo test --test ws_pty` green; manual browser test.
- **Subagent prompt**:
  > Implement the WebSocket pty streamer. Read TECH_PLAN.md §3.2.7 (pty), §3.2.9 (ws handler), §3.4 (WS wire protocol), §5.2 (terminal keystroke diagram), and `research/amux-feature-extract.md` §1.6 (live updates). Write `server/src/sessions/pty.rs`: `PtyStream` struct + `ensure_started(tmux)` that mkfifos `/tmp/amux-pty-<name>.fifo`, calls `tmux pipe-pane -O -t amux-<name> 'tee -a <log> > <fifo>'`, and spawns a tokio task that reads 8KB chunks from the FIFO and broadcasts via `tokio::sync::broadcast::Sender<Bytes>` (cap 256). Replay buffer is `Arc<RwLock<VecDeque<Bytes>>>` capped at 64 KB; push from the reader, snapshot on subscribe. Write `server/src/ws/protocol.rs` with `ClientMsg` enum (`Input{data}`, `Key{data}`, `Resize{cols,rows}`, `Ping`) using `#[serde(tag = "type", rename_all = "lowercase")]`. Write `server/src/ws/streamer.rs` with a `DashMap` of per-session `Arc<PtyStream>` and a `for_session(&self, name)` accessor that creates-on-demand. Write `server/src/ws/mod.rs` with `axum::extract::WebSocketUpgrade` handler: validate Origin against allowlist (close 1008 on mismatch), validate `?_token=` (close 1008), reject if already 8 subscribers (close 1013), on upgrade send replay + spawn fan-out task per §3.2.9 sketch. Per-WS PING every 20s; track last PONG, close on >30s silence. Mount at `/ws/sessions/:name`. Write `server/tests/ws_pty.rs` using `tokio-tungstenite` against an ephemeral port: connect, expect replay, send `{"type":"input","data":"x"}`, capture next inbound binary, assert it contains "x" (use the test session running `cat`). Verify. Commit "M4: ws pty" and report.

### M5 — Backend: status detector (multi-signal)

- **Depends on**: M3, M4.
- **Scope** (~600 LOC): `sessions/status.rs` (detector + state machine), the `/api/_internal/hook` endpoint, `~/.claude/settings.json` writer (in `auto_actions.rs` or a new `claude_config.rs`), per-session status loop, status broadcast via SSE channel, notify-waiters for `wait`. Golden-fixture tests.
- **Acceptance**:
  - 30 golden capture-pane fixtures classified correctly (insta snapshots).
  - SettingsHook callback bumps status to `waiting` within 1s of a real Claude notification.
  - SSE clients receive `{type:'status', name, status}` on every change.
  - `GET /api/agents/{name}/wait?state=idle&timeout=5` returns within 5s with `{reached:false,status:'active'}` if session is active.
- **Time budget**: 10h.
- **Verification**: `cargo test status_detector` green; live test with real Claude.
- **Subagent prompt**:
  > Implement the multi-signal status detector — the most-important reliability feature in v3. Read TECH_PLAN.md §3.6 (full detector spec), §3.2.8 (status module), `research/amux-feature-extract.md` §1.3 (v2 status state machine — pattern bank), §"What v2 got wrong" #5 (lesson). Write `server/src/sessions/status.rs` per §3.6: `Status` enum (`Active|Waiting|Idle|Stopped|Unknown`), `StatusDetector` struct, `detect()` function implementing the fusion rule (hook > regex bank > pty heartbeat > timeout fallback). Regex bank: port the v2 patterns verbatim — ACTIVE matches `(?i)(esc to interrupt|running\.\.\.|reading \d+ file|esc t…|✻.*…)`; WAITING matches `(?i)(enter to select|do you want to proceed|❯\s*\d+\.|interrupted.*what should claude|approve)`; IDLE matches `(?i)(✻.* for \d|⏵⏵|bypass permissions|plan mode|❯\s*$|\$ $|gpt-\S+ · ~)`. Spawn per-session status loop in `sessions/auto_actions.rs::spawn_status_loop`: every 2s, capture-pane, run `detect`, on change UPDATE `session_runtime`, send to `state.sse_tx`, fire `state.status_notify.get(&name).unwrap().notify_waiters()`. Write `claude_config.rs::install_hooks()` that writes/merges `~/.claude/settings.json` with hooks per §3.6 (PreToolUse/PostToolUse/Notification/Stop/SubagentStop all POST to `/api/_internal/hook`). Add `/api/_internal/hook` HTTP handler (auth required, but session can call via its own `AMUX_TOKEN`) that updates `last_hook_event_at` in the detector. Write `agents/wait.rs` per §3.7. Add 30 fixtures in `server/tests/fixtures/status/` (copy from real capture-pane outputs — invent realistic ones if needed for now, document each as `<filename>.<expected>.txt`). Write `server/tests/status_detector.rs` using `insta::assert_snapshot!` over every fixture. Verify. Commit "M5: status detector" and report.

### M6 — Backend: board CRUD + atomic claim

- **Depends on**: M1.
- **Scope** (~400 LOC): `board/mod.rs` (HTTP handlers), `board/claim.rs` (atomic UPDATE), `board/prefix.rs` (id generation), statuses CRUD, iCal export, tag-completion.
- **Acceptance**: All `/api/board/*` endpoints per §2.1 of feature-extract pass integration tests. 100 concurrent claim requests on same id → exactly one 200.
- **Time budget**: 5h.
- **Verification**: `cargo test board` green.
- **Subagent prompt**:
  > Implement the Kanban board endpoints. Read TECH_PLAN.md §3.2.10 (atomic claim), `research/amux-feature-extract.md` §2 (full subsystem 2). Write `server/src/board/mod.rs` with handlers for: list (`GET /api/board`), create (`POST /api/board`), patch, delete (soft, sets `deleted=ts`), clear-done, claim (`POST /api/board/{id}/claim`), statuses CRUD, tag-completion, calendar.ics (PUBLIC, no auth). Write `board/prefix.rs` per §2.3 of feature-extract: prefix from session name = one-word→5 alphanumeric upcased, multi-word→first letters upcased, capped 5, no session→"AMUX". Counter via `INSERT OR IGNORE INTO issue_counters (prefix, next_n) VALUES (?, 1); UPDATE ... SET next_n=next_n+1 WHERE prefix=? RETURNING next_n`. Write `board/claim.rs` per §3.2.10. iCal export per §2.7 of feature-extract — concat `BEGIN:VCALENDAR ... END:VCALENDAR` with VEVENT per issue with `due`. Auto-notify-on-assign per §2.6: when creating with session+owner_type=agent+status in (todo,backlog) and creator!=session, send `notified=1` and tmux send_text the title to that session. Write `server/tests/board_claim.rs`: spawn 100 tokio tasks all POSTing to the same `/claim` — assert exactly one Ok response. Verify. Commit "M6: board" and report.

### M7 — Backend: files browser + editor

- **Depends on**: M1.
- **Scope** (~500 LOC): `files/mod.rs` HTTP handlers, `files/path_safe.rs`, `files/range.rs` (HTTP Range + ETag).
- **Acceptance**: All endpoints from §3.1 of feature-extract work; blocked paths return 403; HTTP Range serves partial content.
- **Time budget**: 5h.
- **Verification**: `cargo test files` green; manual curl with `Range: bytes=100-200`.
- **Subagent prompt**:
  > Implement the file browser, editor, and uploader. Read TECH_PLAN.md §3.2.11 (path safety), `research/amux-feature-extract.md` §3 (full subsystem 3). Write `server/src/files/path_safe.rs` per §3.2.11 with the exact blocklist from §3.4 of feature-extract. Write `server/src/files/range.rs`: parse `Range: bytes=A-B` header, return 206 with `Content-Range`; compute ETag as `"{mtime}-{size}"`; handle `If-None-Match` → 304. Write `server/src/files/mod.rs` with handlers for: `GET /api/ls`, `GET /api/file` (type-detect by extension per §3.2 of feature-extract: images→base64 data_url, pdf→data_url, video→metadata only, audio, binary, text), `PUT /api/file` (writable extensions per §3.3), `GET /api/file/raw` (range-aware), `POST /api/fs/upload` (multipart, 200MB cap), `DELETE /api/fs/delete`, `POST /api/upload` (base64 single file with image magic-byte check), `GET /api/uploads/{filename}`, `GET /api/autocomplete/dir`. Use `axum::extract::Multipart` for multipart. Use `tokio::fs` everywhere. Write `server/tests/files.rs` with assertions for: GET ls of a tempdir returns expected entries; PUT then GET round-trips text; GET raw with Range returns 206 + correct bytes; PUT to `/etc/shadow` returns 403. Verify. Commit "M7: files" and report.

### M8 — Backend: scheduler tick + cron + job types

- **Depends on**: M1, M3.
- **Scope** (~500 LOC): `scheduler/mod.rs` (tick loop), `scheduler/parser.rs` (expression grammar + cron), `scheduler/runner.rs` (tmux/shell/boot jobs), `scheduler/watch.rs` (done_pattern poller), HTTP handlers.
- **Acceptance**: Schedule "in 5s" fires within 6s; recurring "every 1m" fires every minute; cron `*/1 * * * *` works; watch mode detects pattern and fires `done_action`.
- **Time budget**: 6h.
- **Verification**: `cargo test scheduler` green; live test.
- **Subagent prompt**:
  > Implement the scheduler. Read TECH_PLAN.md §3.8 (tick loop), §3.2.12 (sketch), `research/amux-feature-extract.md` §4 (full subsystem 4). Write `server/src/scheduler/parser.rs`: supports `in <N><unit>` (one-shot), `every <N><unit>`, `every morning/evening/night`, `every weekday at HH:MM`, `every <dayname> at HH:MM`, `daily at HH:MM`, `weekly on <day> at HH:MM`, `monthly on <N> at HH:MM`, AND 5-field cron expressions (use the `cron` crate's `Schedule::from_str`). Returns `next_run: DateTime<Utc>`. Write `scheduler/runner.rs::run(state, sched)` matching on `kind`: `tmux` → call `sessions::send_text`; `shell` → `tokio::process::Command::new("/bin/bash").arg("-c").arg(&sched.command)` with 600s timeout; `boot` (NEW for v3) → call `sessions::create` (with `boot_dir`, `boot_provider`, `boot_worktree`) then `sessions::start(prompt = sched.command)`. After run: INSERT into schedule_runs, UPDATE schedules SET last_run/run_count, recompute next_run via parser (or disable if sched_type='once'). If watch=1 and kind='tmux' and status=ok, spawn `watch.rs::poll(state, sched, pre_output)`. Watch poller: every 5s up to watch_timeout, capture-pane, extract new output via tail anchor (last 100 of pre_output's last 200 chars), match `done_pattern` regex; on match, fire `done_action` (`disable` | `notify` | `command:<text>`). Write `scheduler/mod.rs::spawn(state)` with 10s tokio::interval. HTTP handlers: list, create (computes next_run), runs, single, run-now, patch, delete. Write `server/tests/scheduler.rs`: create a schedule "in 1s" with kind=shell command="touch /tmp/amux-test-marker"; sleep 12s; assert marker exists. Verify. Commit "M8: scheduler" and report.

### M9 — Backend: agents/wait primitive + skills + slash commands

- **Depends on**: M5.
- **Scope** (~400 LOC): `agents/wait.rs`, `agents/delegate.rs`, `agents/skills.rs`, `/api/slash-commands` endpoint (built-ins + skills merged).
- **Acceptance**: `GET /api/agents/{name}/wait` long-polls correctly. `GET /api/slash-commands` returns built-ins (~50 commands) + skills (whatever's in `skills` table + `~/.claude/commands/*.md`).
- **Time budget**: 4h.
- **Verification**: `cargo test agents` green.
- **Subagent prompt**:
  > Implement the agent-orchestration primitives. Read TECH_PLAN.md §3.7 (wait), §3.4 (new endpoints), `research/amux-feature-extract.md` §5 (subsystem 5). Write `server/src/agents/wait.rs` per §3.7 — long-poll handler using `state.status_notify` from M5. Write `agents/delegate.rs::delegate(from, to, prompt)` HTTP handler: calls `sessions::send_text(to, prompt)`, records an edge in a new `delegations(from, to, prompt, ts)` table (add a migration `0005_delegations.sql`). Write `GET /api/agents/delegations?session=X` returning edges in/out. Write `agents/skills.rs`: CRUD over `skills` table; on POST, also write to `~/.amux-v3/skills/<name>.md` AND `~/.claude/commands/<name>.md` so Claude picks them up. `GET /api/skills` parses YAML frontmatter for `description` and `argument-hint`. Add `GET /api/slash-commands`: returns the BUILTIN_SLASH_COMMANDS list (port the verbatim list from `research/amux-feature-extract.md` §5.3) + the skills list. Verify. Commit "M9: agents/wait/skills" and report.

### M10 — Frontend: routing shell + Tailwind + shadcn install

- **Depends on**: M0.
- **Scope** (~400 LOC): React Router setup, Tailwind v4 config with semantic tokens, install shadcn primitives we need (Button, Input, Sheet, Dialog, ScrollArea, Popover, Toggle, Tabs, Tooltip, DropdownMenu), basic `<Layout>` with side-nav (desktop) and bottom-nav (mobile), theme provider (dark default).
- **Acceptance**: All routes render placeholder content; theme toggles; tailwind classes work.
- **Time budget**: 5h.
- **Verification**: Visual inspection in dev.
- **Subagent prompt**:
  > Build the routing shell and design-system foundations. Read TECH_PLAN.md §4.1 (routing), §4.8 (responsive rules), §2 (file layout). Set up React Router v7 with the routes from §4.1. Configure Tailwind v4 with semantic tokens in `web/src/styles/globals.css`: `--background`, `--foreground`, `--card`, `--border`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive` — each with light + dark variants (dark default). Install shadcn primitives via `bunx --bun shadcn@latest add button input sheet dialog scroll-area popover toggle tabs tooltip dropdown-menu badge`. Configure shadcn to write into `web/src/components/ui/` (copy-source). Build `<Layout>` that wraps `<Outlet />`: at `md+` shows a 64px-wide left side-nav with icons (Overview, Board, Files, Scheduler, Settings); at `<md` shows a bottom tab bar (5 icons + label) using safe-area-inset. Build `<ThemeProvider>` (system|light|dark via `localStorage`). Build `<QueryClientProvider>` with default options (staleTime 30s, refetchOnWindowFocus true). Wire all routes to placeholders: each renders `<h1>Route Name</h1>`. Verify all 6 routes render at both desktop and mobile widths in dev mode. Commit "M10: routing + design system" and report.

### M11 — Frontend: session-tile component (hero)

- **Depends on**: M10.
- **Scope** (~350 LOC): `<SessionTile>`, `<TailPreview>`, `<StatusDot>`, with full hover-peek spring + active/waiting pulses + click navigation with View Transitions.
- **Acceptance**: Per §4.3 pixel spec. Mock data renders correctly; hover spring matches Termius §recommended values; click navigates with View Transition (Chromium only — fallback ok).
- **Time budget**: 6h.
- **Verification**: Storybook-like dev page at `/dev/tiles` renders 12 mocked sessions in tile grid.
- **Subagent prompt**:
  > Build the SessionTile hero component. Read TECH_PLAN.md §4.3 (full pixel spec — read every word), §4.7 (animations spec), `research/termius-ios-native-spec.md` §"v3 finish acceptance criteria" #1, #2, #19. Write `web/src/components/session-tile/tile.tsx`: ~180 LOC component taking `{session: Session}` props. Use `motion.div` from framer-motion. Default state: card 4:3, `rounded-xl border bg-card`, title row 32px (title + status dot + tokens/branch row), TailPreview filling rest. Use `<TailPreview lines={session.preview_lines} />` child component. WhileHover (desktop): `scale: 1.06, zIndex: 10`, spring per `lib/springs.ts::tileHover` (also write this file with the full preset bank from §4.7). On hover, bump `--tail-lines` CSS variable from 6 to 14 (TailPreview consumes it). Active state: pulse via `animate={{ boxShadow: [...]}} transition={{ repeat: Infinity, duration: 1.6 }}`. Waiting state: blue pulse + "Needs input" pill, 2.2s, plus `window.navigator.vibrate?.(8)` on transition into waiting (debounced via useRef). Click → `navigate('/focus/' + session.name)` with `style={{ viewTransitionName: 'session-' + session.name }}` (gated by `if ('startViewTransition' in document)`). Mobile (use `useMediaQuery('(pointer:coarse)')`): NO hover; tap = focus; long-press 350ms via a `useLongPress` hook → opens a quick-peek Dialog. Write `web/src/components/session-tile/tail-preview.tsx`: pre-formatted block, `font-mono text-[10.5px] leading-[14px]`, last N lines anchored to bottom, top-fade via `mask-image`. Write `web/src/components/session-tile/status-dot.tsx`: 8×8 colored circle. Write a dev page `web/src/routes/dev-tiles.tsx` (gated behind `import.meta.env.DEV`) that renders 12 mocked tiles in a CSS grid. Verify the hover, click, and animation behaviors match spec. Commit "M11: session-tile" and report.

### M12 — Frontend: overview route (tile + list toggle + search)

- **Depends on**: M11.
- **Scope** (~300 LOC): `routes/overview.tsx`, `useSessions()` hook (TanStack Query + SSE invalidation), `useSse()` hook, view-mode toggle, search input, FAB for new session.
- **Acceptance**: Real data from backend renders; SSE updates flow through; search filters by name/desc/tags; view toggle persists in `useUI` store.
- **Time budget**: 5h.
- **Verification**: Boot backend with mocked sessions, render overview, verify live updates.
- **Subagent prompt**:
  > Build the overview route. Read TECH_PLAN.md §4.1, §4.2, §4.6, `research/user-vision.md` "Overview screen", §1.7 of feature-extract. Write `web/src/hooks/use-sse.ts`: connect to `/api/events?_token=...`, dispatch events to callbacks; auto-reconnect (300ms × 2^n cap 30s); declare stale after 18s silence (force reconnect); on visibility/focus/online events, if last data >4s ago, refetch. Write `web/src/hooks/use-sessions.ts`: `useQuery({ queryKey:['sessions'], queryFn: api.listSessions, staleTime: 30_000 })`. Subscribe to SSE 'sessions' event in a top-level effect that calls `queryClient.setQueryData(['sessions'], payload)`. Write `web/src/routes/overview.tsx`: header with title, search input (debounced 200ms), view-mode toggle (Tile/List, reads `useUI` store). Body: if tile mode, CSS grid `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2` of `<SessionTile />`; if list mode, vertical list of `<SessionRow />` (write this — compact row with name, status dot, last activity, click → focus). FAB bottom-right (mobile only — desktop has it in the header) opens `<NewSessionSheet />` (use shadcn `<Sheet />`). NewSessionSheet has fields: name, dir (with `/api/autocomplete/dir` typeahead), desc, provider radio, worktree checkbox. On submit, POST /api/sessions + navigate to focus. Sort sessions per `research/amux-feature-extract.md` §1.2: pinned-desc, running-desc, (active|waiting before idle), -last_activity. Search filters by name/desc/tags. Wire view-mode persistence via Zustand store from §4.6. Verify with real backend + mock sessions. Commit "M12: overview" and report.

### M13 — Frontend: LiveTerminal hook + xterm.js wrapper

- **Depends on**: M10, M4.
- **Scope** (~400 LOC): `hooks/use-live-term.ts`, `components/terminal/live-terminal.tsx`.
- **Acceptance**: `<LiveTerminal name="..." />` renders, connects to WS, displays replay + live bytes; resizes correctly via FitAddon + ResizeObserver; sends user keystrokes back; reconnects on close.
- **Time budget**: 6h.
- **Verification**: Render a `<LiveTerminal>` against a real session; type and see output.
- **Subagent prompt**:
  > Build the LiveTerminal hook + component. Read TECH_PLAN.md §4.5 (full spec), §5.2 (data flow). Write `web/src/hooks/use-live-term.ts` per §4.5 signature: create `XTerm.Terminal` with options `{ fontFamily: 'SF Mono, Menlo, monospace', fontSize: 13, theme: themeFromCss(), allowTransparency: false, cursorBlink: true }`; load `CanvasAddon` + `FitAddon` + `WebLinksAddon`; `open(containerRef.current)`; `fit()`. Connect to `wss://<host>:<port>/ws/sessions/<name>?_token=<tok>` (URL via `lib/api.ts`). On `ws.onmessage(blob)`: `await blob.arrayBuffer()` → `new Uint8Array(buf)` → `term.write(arr)`. On `term.onData(s)`: `ws.send(JSON.stringify({ type:'input', data: s }))`. ResizeObserver on container: debounce 100ms, `fitAddon.fit()`, then `ws.send({type:'resize', cols: term.cols, rows: term.rows})`. State machine: `connecting → live → reconnecting → offline`. Exponential backoff per §4.5; permanent close codes (1011, 1008, 1013, 4001) → `offline` (no retry). Expose `send(text)`, `sendKey(name)`, `copyAll()` (uses `term.buffer.active` and pushes to clipboard). Write `web/src/components/terminal/live-terminal.tsx`: thin wrapper that uses the hook, renders `<div ref={containerRef} className="h-full w-full" />`, and pipes the `state` to a small overlay banner (handled separately in §M23 — for now, show "Reconnecting…" text). Add `/dev/term/:name` route for manual testing. Verify with real backend WS. Commit "M13: live terminal" and report.

### M14 — Frontend: focus-mode desktop (keyboard capture + split)

- **Depends on**: M11, M13.
- **Scope** (~400 LOC): `routes/focus/desktop.tsx`, `components/focus-mode/desktop-split.tsx`, `components/focus-mode/dock.tsx` (desktop variant).
- **Acceptance**: Per §4.4 desktop spec. Cmd+D detaches, Cmd+W stops, Cmd+1..9 jumps. All other keys go to xterm/tmux.
- **Time budget**: 6h.
- **Verification**: Focus a session, type a multi-line bash command including Ctrl+C, verify echo + interrupt.
- **Subagent prompt**:
  > Build the desktop focus mode. Read TECH_PLAN.md §4.4 desktop subsection (every detail). Write `web/src/routes/focus/desktop.tsx`: two-column flex (320px session-strip left, flex-1 main right). Session strip: vertical scroll of compact tiles (write `<CompactTile />`: 320px wide × 56px tall, current session highlighted). Main: `<FocusHeader />` (44px, session name, status dot, Detach button, Stop button), `<LiveTerminal />` (flex-1), `<DesktopDock />` (bottom, 56px, just shows current keyboard hints and a one-line input for special send). Implement keyboard capture: a document-level keydown listener (registered in a useEffect when the route mounts, removed on unmount) that intercepts global shortcuts (Cmd/Ctrl+K, +D, +W, +1..9) and lets all other keys flow to xterm via `e.target` not preventing default. Cmd+D = `navigate('/')`; Cmd+W = stop + navigate. Cmd+1..9 = jump to N-th session in the list. Verify with real session — type "vim foo.md", arrows work, Esc works, :wq works. Commit "M14: focus desktop" and report.

### M15 — Frontend: focus-mode mobile (Vaul sheet + dock)

- **Depends on**: M13.
- **Scope** (~500 LOC): `routes/focus/mobile.tsx`, `components/focus-mode/mobile-sheet.tsx`, `components/focus-mode/dock.tsx` (mobile variant), session pill, kbd toggle, specials sheet.
- **Acceptance**: Per §4.4 mobile spec. Vaul sheet detents work; rubber-band per Apple spec; dock height correct; specials sheet opens with 4-group layout.
- **Time budget**: 8h.
- **Verification**: Test on iPhone Safari (real device): tap session → focus mode opens at full detent, drag-down rubber-bands then dismisses to peek.
- **Subagent prompt**:
  > Build the mobile focus mode. Read TECH_PLAN.md §4.4 mobile subsection (every detail), §4.4.1 (dock), `research/termius-ios-native-spec.md` §"Apple Maps — Detail card pull-up", §"Apple Mail iOS 18", §"v3 finish acceptance criteria" #8, #9, #10, #11. Write `web/src/routes/focus/mobile.tsx` wrapping Vaul's `<Drawer.Root open={true} dismissible={true}>`. Configure detents: snap points `["40%","100%"]` (Vaul uses fractions). Initial detent: `1` (full). `dampOnOverScroll: 0.55` (custom prop or implement via the modal-snap callback to apply Apple's bungee formula on translation above max). Snap with `transition={{ type:'spring', stiffness:280, damping:30 }}` (matches `.spring(response:0.45, dampingFraction:0.82)`). Velocity-dismiss: hook into Vaul's `onPointerUp` — if `velocity.y > 1200 px/s downward`, snap to peek. Drag indicator (handled by Vaul default; verify it's 36×5px). Inside Drawer.Content: `<FocusHeader minimal />` (44px), `<LiveTerminal name={current} />` (flex-1), `<MobileDock />` (56px + safe-area-bottom). Write `<MobileDock />`: flex row, 56px tall, items: session-pill (left), kbd-toggle, specials button, input (grows), send button. Session pill: capsule with status dot + name + chevron; tap = open `<SessionPickerSheet />` (Vaul half-sheet); swipe horizontally on it = nav prev/next session (use Framer Motion `drag="x"`). Write `<SpecialsSheet />`: Vaul half-sheet; horizontal pager of kbd-groups, each group = 2×2 of 4 keys; uses snap with `.snappy`. Verify on real iPhone. Commit "M15: focus mobile" and report.

### M16 — Frontend: kbd-accessory swipeable groups + manage sheet

- **Depends on**: M15.
- **Scope** (~500 LOC): `components/kbd-accessory/accessory-bar.tsx`, `group.tsx`, `pager.tsx`, `manage-sheet.tsx`.
- **Acceptance**: Per Termius §"Swipeable 4-key accessory groups". 5 gray fixed + 4 user-editable; horizontal swipe pages between groups; manage sheet allows reorder/add/remove of keys with haptics.
- **Time budget**: 6h.
- **Verification**: On iPhone, swipe through groups; open manage, reorder a key, verify persistence via `/api/kbd-groups`.
- **Subagent prompt**:
  > Build the Termius-style swipeable accessory bar. Read TECH_PLAN.md §4.4.2 (full spec), `research/termius-ios-native-spec.md` §"Swipeable 4-key accessory groups", §"Keyboard accessory bar — heights & spacing", §"v3 finish acceptance criteria" #5, #6, #18. Write `web/src/components/kbd-accessory/accessory-bar.tsx`: 44pt-tall flex row. Left fixed cluster of 5 gray chips (Back, Gesture, Kbd, More, Settings). Right pager of user groups (4 chips each). Page indicator dots below right side, auto-hide after 1.5s. Write `<Pager />`: snap-swipe between groups, snap threshold 30% width OR velocity >400px/s, spring `.snappy(duration:0.25)`. Use Framer Motion `<motion.div drag="x" dragConstraints>`. Write `<Group />`: 2-row x 4-col? No — single row of 4 chips per spec. Each chip: ≥44×44 hit, 32px visible height, 8px continuous corner, SF Mono 13pt semibold. Press state: scale 0.96, light haptic via `navigator.vibrate(8)`. Write `<ManageSheet />` (Vaul full-sheet): tap Settings (gear) chip → opens. Shows all groups with drag handles (use `framer-motion`'s `Reorder.Group`). Within a group, tap a key to edit (label + tmux key name). Add `+` to add a new group; `−` to remove. Persist via `POST /api/kbd-groups` (backend M9 didn't include this — add a small migration `0006_kbd.sql` here OR keep prefs blob-based: store as `prefs[kbd_groups]` JSON). Default groups: Agent (Esc, Tab, Ctrl-C, Ctrl-U), Shell (~, /, |, &), Tmux (Ctrl-B, p, n, d), Symbols ('$', '#', '`', '*'). On mount, load from prefs; if absent, write defaults. Verify swipe + reorder + persistence. Commit "M16: kbd accessory" and report.

### M17 — Frontend: joystick + 2-finger gesture

- **Depends on**: M13, M15.
- **Scope** (~400 LOC): `components/joystick/joystick.tsx`, two-finger pan handler in `LiveTerminal`.
- **Acceptance**: Per Termius §"Hold-anywhere arrow joystick" + §"Two-finger PageUp/PageDown". Long-press 350ms anywhere on terminal arms joystick with haptic + visible rose; drag emits arrows at 3 speed tiers. Two-finger swipe emits PageUp/Down.
- **Time budget**: 6h.
- **Verification**: On iPhone, hold + drag = arrow keys flowing; two-finger swipe = scrollback paging.
- **Subagent prompt**:
  > Build the touch gestures over the terminal. Read TECH_PLAN.md §4.4 mobile (the gestures bullet), `research/termius-ios-native-spec.md` §"Hold-anywhere arrow joystick", §"Two-finger PageUp / PageDown", §"v3 finish acceptance criteria" #2, #3, #4, #7. Write `web/src/components/joystick/joystick.tsx` as an absolutely-positioned overlay on the terminal viewport. PointerDown handler: start 350ms timer; if pointer moves >8px in that window, cancel. On arm: `navigator.vibrate(8)` (selection haptic equivalent), render rose at touch point (88px circle, 1px tertiary stroke, 0 fill, 80ms ease-in). Movement after arm: compute radial distance from origin. Direction lock: dominant axis until re-orient cone of 30° held for 80ms. Speed tier by distance: 8-32→90ms, 32-72→50ms, ≥72→20ms repeat interval. Each interval, call `sendKey('Up'|'Down'|'Left'|'Right')` via the LiveTerminal context. Release: rose fade-out 120ms. Reduce Motion: skip rose, just emit keys. Two-finger gesture: a separate `PointerEvent` listener that tracks 2 simultaneous pointers; compute average translation; on 20px cumulative downward swipe → `sendKey('PageUp')`; every additional 24px → another PageUp; same logic for upward → PageDown. Velocity shortcut: >1500 px/s emits 2 keys. Two-finger gesture cancels the joystick. Toggle between gesture modes via the "Gesture" chip in accessory bar (when joystick is off, long-press triggers Apple-style selection instead — that's a NEXT-milestone item; for now just enable/disable). Verify on real iPhone. Commit "M17: joystick + 2-finger" and report.

### M18 — Frontend: slash menu + snippets + dictation

- **Depends on**: M15.
- **Scope** (~400 LOC): `components/slash-menu/slash-menu.tsx`, `components/snippets/snippet-panel.tsx`, `components/snippets/snippet-editor.tsx`, dictation button (uses WebSpeech API).
- **Acceptance**: Typing `/` in input shows slash menu with all commands (built-ins + skills) fetched from `/api/slash-commands`. Snippet panel slides up from accessory bar with `.spring(response:0.35, damping:0.85)`. Long-press snippet fires it.
- **Time budget**: 5h.
- **Verification**: Type `/com` → menu shows `/compact`; Enter selects. Snippet panel open + tap inserts; long-press fires immediately.
- **Subagent prompt**:
  > Build the slash menu, snippet picker/editor, and dictation. Read TECH_PLAN.md §4.4.1 (dock), `research/termius-ios-native-spec.md` §"Snippet editor — in-place vs modal", §"ChatGPT iOS — message composer". Write `web/src/components/slash-menu/slash-menu.tsx`: when input value starts with `/`, fetch `/api/slash-commands` (cached via TanStack Query 60s), filter by typed prefix, render as a popover above the input. Spring `.smooth`. Each row: cmd + desc. Arrow keys nav, Enter selects (inserts into input, sets cursor at end). Write `web/src/components/snippets/snippet-panel.tsx`: in-place slide-up panel from above accessory bar. Height `min(320px, 50vh)`. Spring per spec. `.thinMaterial` look: `bg-background/70 backdrop-blur-xl`. Tap row = insert; long-press 500ms = run-immediately (call `sendText(snippet.body)` directly), medium haptic (`navigator.vibrate(15)`). Swipe-left on row reveals Edit / Delete; full-swipe past 50% auto-deletes with medium haptic. Write `web/src/components/snippets/snippet-editor.tsx` (modal full-sheet via Vaul): title input + body textarea + Save/Cancel. Persist via `/api/snippets`. Default snippets: `continue`, `/compact`, `/status`. Wire dictation: a mic button in the dock that uses `webkitSpeechRecognition` (`SpeechRecognition` polyfill); on result, set input value. Gracefully degrade if not supported. Verify each interaction. Commit "M18: slash + snippets" and report.

### M19 — Frontend: board route

- **Depends on**: M10, M6.
- **Scope** (~600 LOC): `routes/board.tsx` with columns, cards, drag-reorder, create-issue dialog, tag chips, due-date picker.
- **Acceptance**: Drag a card between columns updates server. Atomic claim hits 409 visibly. Calendar sync URL visible in settings.
- **Time budget**: 7h.
- **Verification**: Create 3 issues, drag, verify SSE board updates flow back.
- **Subagent prompt**:
  > Build the kanban Board route. Read TECH_PLAN.md §4 board reference, `research/amux-feature-extract.md` §2, `research/user-vision.md` "Board". Write `web/src/hooks/use-board.ts` (TanStack Query against `/api/board`, SSE-driven invalidation on 'board' event). Write `web/src/routes/board.tsx`: horizontal scrollable row of columns (one per status; columns config from `/api/board/statuses`). Each column: header (label + count + add-card button), vertical list of `<IssueCard />`. Use `framer-motion`'s `<Reorder.Group>` for within-column reorder; for cross-column drag, use HTML5 drag-drop OR `react-dnd` (prefer plain pointerdown/move/up to stay light). On drop: compute new `pos` as midpoint between neighbors, PATCH. `<IssueCard />`: shows title, session pill (if assigned), tags as small chips, due date if set, owner_type icon (human/agent). Tap = open `<IssueDetailSheet />` for edit. Create: `+` in column header → `<NewIssueDialog />` with fields title, desc, session (combo), due date, tags, owner_type radio. Statuses CRUD: gear icon in header opens `<ManageStatusesSheet />`. Spring values everywhere from `lib/springs.ts`. Verify drag, multi-tab consistency via SSE. Commit "M19: board" and report.

### M20 — Frontend: files route

- **Depends on**: M10, M7.
- **Scope** (~500 LOC): `routes/files.tsx` with breadcrumb, list/grid view, file viewers (image/PDF/video/audio/text), markdown editor (CodeMirror 6).
- **Acceptance**: Browse, open file, edit text, save. Image preview inline. Video plays via Range-aware `<video>`.
- **Time budget**: 6h.
- **Verification**: Click around in `~/`, open a markdown, edit, save.
- **Subagent prompt**:
  > Build the Files route. Read TECH_PLAN.md §4 files reference, `research/amux-feature-extract.md` §3, `research/user-vision.md` "Files". Write `web/src/routes/files.tsx`: breadcrumb at top, hidden-toggle, sort options, then either: sidebar+main (md+) or drill-down (<md). The optional `:name` route param scopes the root to that session's `CC_DIR`. Use `/api/ls` for listings. On click: if directory → navigate; if file → `<FileViewer file={meta} />` which fetches `/api/file` and renders by type: image (inline `<img src={data_url}>`), pdf (`<embed type="application/pdf">`), video (`<video src={`/api/file/raw?path=${path}`} controls>` — Range support is server-side), audio similarly, text (read-only or, if writable extension, CodeMirror 6 with markdown/syntax highlighting). For markdown, add `<MarkdownEditor>` using `@uiw/react-codemirror` (or stick with `@codemirror/lang-markdown` directly to avoid wrappers). Save = PUT /api/file. Upload via drag-drop on the file list: dropzone overlay, POSTs multipart to `/api/fs/upload`. Verify image, pdf, video, text all render; edit a .md and save round-trips. Commit "M20: files" and report.

### M21 — Frontend: scheduler route

- **Depends on**: M10, M8.
- **Scope** (~500 LOC): `routes/scheduler.tsx` with job list, create/edit dialog with expression builder, recent-runs list, run-now button.
- **Acceptance**: Create boot/tmux/shell jobs with cron OR free-text expression. Verify next_run computed correctly. Inline edit, enable/disable toggle.
- **Time budget**: 6h.
- **Verification**: Create "every 5m" schedule sending `/status` to a session; observe runs.
- **Subagent prompt**:
  > Build the Scheduler route. Read TECH_PLAN.md §4 scheduler reference, §3.8 (backend job kinds: tmux/shell/boot), `research/amux-feature-extract.md` §4, `research/user-vision.md` "Scheduler specifically". Write `web/src/routes/scheduler.tsx`: list of schedules with columns title / kind / session / next_run / last_run / enabled-toggle. Click = open `<ScheduleDetailSheet />` for edit + history (last 20 runs). Create: `+` button opens `<NewScheduleDialog />` with: kind radio (boot / tmux / shell), and matching field set. boot: dir, provider, worktree?, prompt. tmux: session combo, text. shell: command. Expression field: free-text input with helper buttons that pre-fill common patterns ("every morning", "every weekday at 9am", "every 5m", "in 30m"). Show computed next_run in real-time (validation against `/api/schedules` POST with `enabled:0, _validate:true` dry-run — or do the parse client-side for happy paths, fall back to server). Use `react-day-picker` for one-shot date+time picking. Run-now button calls `POST /api/schedules/{id}/run` and refetches. Watch mode: checkbox + done_pattern regex input + done_action select. Verify creating a "in 10s, shell, `touch /tmp/sched-test`" job actually runs. Commit "M21: scheduler" and report.

### M22 — Frontend: settings route

- **Depends on**: M10.
- **Scope** (~300 LOC): `routes/settings.tsx` with theme, view-mode default, auth-token copy button, audit log viewer, API key inputs (Anthropic, OpenAI), default model picker.
- **Acceptance**: All settings persist via backend or localStorage as appropriate.
- **Time budget**: 4h.
- **Verification**: Toggle theme, change default model, restart browser, settings retained.
- **Subagent prompt**:
  > Build the Settings route. Read TECH_PLAN.md §4 settings reference, §6.4 (audit log), `research/amux-feature-extract.md` §1.8 (config endpoints). Write `web/src/routes/settings.tsx`: sections — Appearance (theme select: system/light/dark via `useUI` store), Default View (tile/list via `useUI`), API Keys (Anthropic / OpenAI — masked inputs, GET /api/settings/env on load, PATCH on save), Default Model (combo from a fixed list, PATCH `/api/settings/default-model`), Auth Token (display masked + copy button + regenerate button — confirm dialog), Audit Log (last 200 rows from `/api/audit?limit=200`, table view). Spring values for accordion-style section expand if used. Verify each setting writes/reads correctly. Commit "M22: settings" and report.

### M23 — Cross-cutting: View Transitions + status banner + PWA

- **Depends on**: M10, M12, M14, M15.
- **Scope** (~300 LOC): `components/view-transitions/morph.tsx` helper, `components/status-banner/reconnect-banner.tsx`, PWA manifest + vite-plugin-pwa config.
- **Acceptance**: Tile-to-focus morphs (Chromium); reconnect banner shows on WS reconnects per Termius spec; PWA installable on iPhone.
- **Time budget**: 5h.
- **Verification**: `lighthouse` PWA score ≥90; visual on Safari/Chrome; install to home screen.
- **Subagent prompt**:
  > Implement cross-cutting polish: View Transitions, the reconnect banner, and PWA scaffolding. Read TECH_PLAN.md §4.9 (PWA), `research/termius-ios-native-spec.md` §"Reconnect banner / connection status surface", §"v3 finish acceptance criteria" #8. Write `web/src/components/view-transitions/morph.tsx`: helper that wraps `navigate()` with `document.startViewTransition(() => flushSync(() => navigate(to)))` if supported; falls back to plain navigate. Update SessionTile click to use it. Write `web/src/components/status-banner/reconnect-banner.tsx`: pinned 8px below safe-area-top, 36px tall pill, glass effect (`backdrop-blur-xl bg-background/70`), tinted by state. Subscribe to a global `useConnection()` store (Zustand) which `useLiveTerm` and `useSse` push state into. States: Connecting (amber), Reconnecting (amber + spinner), Connected (green checkmark, auto-dismiss 1.2s), Offline (red, "Tap to retry"). Animations: slide-in `.smooth(0.35s)`, state morph `.snappy(0.25)` in-place (no slide-out), success slide-out after 1.2s linger `.smooth(0.4)`. Wire PWA: install `vite-plugin-pwa`, configure `manifest` per §4.9. SW: NetworkFirst for HTML, CacheFirst for hashed assets. Add the apple-touch-icon, apple-mobile-web-app-capable, status-bar-style meta tags in `index.html`. Verify with Lighthouse + home-screen install on iPhone. Commit "M23: cross-cutting polish" and report.

### M24 — Integration tests + acceptance criteria pass

- **Depends on**: M11..M23.
- **Scope** (~600 LOC): Playwright e2e suite covering the critical user journeys; manual checklist for the 20 acceptance criteria from termius spec.
- **Acceptance**: All e2e tests pass on CI; ≥18 of 20 acceptance criteria pass on real iPhone.
- **Time budget**: 8h.
- **Verification**: CI green; manual sign-off on iPhone.
- **Subagent prompt**:
  > Build the e2e Playwright suite + run the acceptance checklist. Read TECH_PLAN.md §7 (testing strategy), `research/termius-ios-native-spec.md` §"v3 finish acceptance criteria". Set up Playwright in `web/`: `bunx playwright install chromium webkit`. Write `web/tests/e2e/` with these specs: overview-loads.spec.ts (boot binary, navigate to /, expect at least 1 tile), focus-types-and-sees-output.spec.ts (boot, navigate to focus, type "echo hi", expect "hi" to appear within 3s), board-create-claim.spec.ts (POST 100 claims concurrently via 100 contexts, expect exactly one success), files-edit-save.spec.ts (browse to a temp file, edit, save, verify content via direct fs read), scheduler-fires.spec.ts (create "in 5s shell" schedule, wait, verify marker file). Mobile suite: use `devices['iPhone 14 Pro']` context; assertions: tile is tappable, focus mode opens at full detent, dock is 56px tall, accessory bar is 44px tall, joystick arms in <400ms. Also write `web/ACCEPTANCE.md` with the 20 criteria from the Termius spec, each rendered as a checkbox + manual-test instructions. Run the suite, fix discovered bugs (or open follow-up issues if non-blocking), report passing count. Commit "M24: e2e + acceptance" and report.

### M25 — Deployment scripts + v2 coexistence

- **Depends on**: M24.
- **Scope** (~200 LOC): `scripts/build.sh`, `scripts/deploy.sh`, `etc/systemd/amux-v3.service`, README updates.
- **Acceptance**: Single `scripts/deploy.sh` run produces a running v3 on clawd-02 port 8823; v2 still works on 8822.
- **Time budget**: 4h.
- **Verification**: Both URLs respond; no port conflict; logs in `journalctl -u amux-v3`.
- **Subagent prompt**:
  > Wire up build and deploy. Read TECH_PLAN.md §8 (deployment). Write `scripts/build.sh` per §8.1; `scripts/deploy.sh` per §8.2; the systemd unit per §8.3. Ensure the binary opens its own data dir at `~/.amux-v3/` (no overlap with v2's `~/.amux/`). On clawd-02, install the systemd unit (`sudo install` the file, `systemctl daemon-reload`, `enable`, `start`). Configure `tailscale serve` to expose v3 on a distinct path or hostname (`tailscale serve --bg --https=8823 https+insecure://localhost:8823`). Verify with `curl https://clawd-02.foo.ts.net:8823/api/health` returns 200 with token, and that v2 at port 8822 still serves. Update top-level README with quickstart. Commit "M25: deploy" and report.

### M26 — Data migration from v2

- **Depends on**: M25.
- **Scope** (~300 LOC): `scripts/migrate-v2.py`.
- **Acceptance**: Running the script copies all v2 sessions, board issues, schedules, skills, prefs into v3 SQLite; idempotent on re-run.
- **Time budget**: 4h.
- **Verification**: Run dry-run, then real, then compare `sqlite3 .amux-v3/data.db 'select count(*) from sessions'` to `ls ~/.amux/sessions/*.env | wc -l`.
- **Subagent prompt**:
  > Write the v2→v3 data migration. Read TECH_PLAN.md §9, `research/amux-feature-extract.md` Appendix A (filesystem layout), §1.2 (.env keys), §2.2 (issues schema), §4.2 (schedules schema). Write `scripts/migrate-v2.py`: open `~/.amux-v3/data.db` write-mode, ATTACH `~/.amux/data.db` as `old`. For each `.env` in `~/.amux/sessions/`, parse env-style (quote-aware) + corresponding `.meta.json`, INSERT OR IGNORE into v3's `sessions` + `session_runtime`. Copy `old.issues`, `old.issue_tags`, `old.issue_counters`, `old.statuses` into v3 (with column-name remapping if any). Copy `old.schedules`, `old.schedule_runs`. Copy `old.skills`. Copy `old.prefs`. Print summary line per table. Add `--dry-run` flag that COUNTs but doesn't insert. Idempotent: use `INSERT OR IGNORE` everywhere. Verify on a real v2 install, then verify v3 reads them all. Commit "M26: migration" and report.

---

### Milestone dependency graph (visual)

```
M0
 ├─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─┐
 │       │      │      │       │
 │       ├─► M6 ┤      │       └─► M9
 │       └─► M7 ┘      │
 │              └─► M8 ┘
 │
 └─► M10 ─► M11 ─► M12
         │      │
         ├──────┴─► M13 ─► M14 ─► M16
         │              └─► M15 ─┴─► M17
         │                       └─► M18
         ├─► M19 (needs M6)
         ├─► M20 (needs M7)
         ├─► M21 (needs M8)
         └─► M22
                     ────► M23 ────► M24 ─► M25 ─► M26
```

### Parallelism opportunities

- **M0 → M1 → M10** can fork: after M1 ships, backend (M2..M9) and frontend shell (M10) can proceed in parallel.
- **M6, M7, M8** are independent of each other and of M2..M5 (only depend on M1). 3-way parallel.
- **M19, M20, M21, M22** are independent of each other (depend on M10 + their respective backend). 4-way parallel.
- **M16, M17, M18** are independent of each other (all depend on M15). 3-way parallel.
- **Critical path**: M0 → M1 → M3 → M4 → M5 → M13 → M14 → M15 → M23 → M24 → M25 → M26 (12 milestones, ~75h serial).

---

## 11. Loop / orchestrator skill spec

### `/amux-build` skill

**Location**: `/Users/sandervm/amux-v3/skill/SKILL.md` (plus `state.json` for loop state).

**Purpose**: walk milestones in dependency order, dispatch subagents in parallel where deps allow, run a critic after each, loop on failures.

**State file** (`/Users/sandervm/amux-v3/skill/state.json`):

```json
{
  "milestones": {
    "M0":  { "status": "done",       "started_at": "...", "finished_at": "...", "subagent": "id-1" },
    "M1":  { "status": "in_progress","started_at": "...", "subagent": "id-2" },
    "M2":  { "status": "blocked",    "deps": ["M1"] },
    "M3":  { "status": "blocked",    "deps": ["M2"] },
    "...": "..."
  },
  "last_tick": "2026-05-21T22:00:00Z"
}
```

**Skill body** (sketch, ~30 LOC of markdown):

```markdown
---
description: Execute the TECH_PLAN milestones in dep order, parallel where possible, critic after each.
---

# amux-build

1. Read `/Users/sandervm/amux-v3/plan/TECH_PLAN.md` §10 milestone list.
2. Read `/Users/sandervm/amux-v3/skill/state.json`. If missing, initialize with every milestone status="todo".
3. Compute ready set: milestones whose deps are all "done" AND status is "todo".
4. For each ready milestone, dispatch a subagent with the EXACT prompt from §10. Track its task id in state.json.
5. Wait for completed subagents. For each finished:
   a. Run critic: dispatch a second subagent with prompt "Read TECH_PLAN.md §10 M<n>. Read the commit it produced. Verify each acceptance criterion. Return PASS or FAIL+reasons."
   b. If PASS: mark "done", commit state.json.
   c. If FAIL: mark "blocked-failing", record failure reasons, dispatch a fix subagent with the original prompt + critic's failure list.
6. Repeat from step 3 until all milestones are "done" or stuck (no ready set + ≥1 blocked-failing for >3 retries).
7. Final report: list status of each milestone + total wall time.
```

The skill is invoked as `/amux-build` from a top-level Claude Code session. It's tens of subagents executing in waves, with the critic gate after each.

---

## 12. Risks + mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | tmux behaves differently on Linux (clawd-02) vs macOS (dev) — `pipe-pane` quirks, `send-keys -l` quoting | CI runs against tmux 3.4 on Linux; integration test in `tests/lifecycle.rs` running real tmux is mandatory before any tmux-touching merge |
| 2 | xterm.js perf with many concurrent terminals (focus-mode strip has ≤320px-wide tiles potentially showing live previews) | Keep tiles read-only/sampled (peek every 2s via SSE delta), NOT live xterm instances; only the focused session uses xterm |
| 3 | Vaul iOS Safari quirks (sheet flicker on rubber-band, keyboard pushing content) | Use Vaul ≥1.0; explicit `interactsWithModal` config; test against iOS 17, 18, 26 in CI via Playwright webkit |
| 4 | View Transitions API only in Chromium → degraded look in Safari | Fallback to instant navigate is acceptable; revisit when WebKit ships (in progress as of 2026) |
| 5 | Status detector regex bank breaks on next Claude UI revision | Settings hooks + heartbeat are the primary signals; regex bank is fallback. Golden fixtures + snapshot tests catch regressions in CI |
| 6 | WebSocket-over-HTTP/2 forbidden — Tailscale serve may force h2 → WS upgrade fails | Backend listens on raw TCP for WS (separate port if needed); frontend reads `window._AMUX_SERVER_PORT` injected into HTML |
| 7 | sqlx compile-time-checked queries require live DB at build time → CI flakiness | Use `cargo sqlx prepare` to write `.sqlx/query-*.json` files into the repo; CI runs offline mode |
| 8 | Vite + Tailwind v4 still has rough edges (e.g. dynamic class names) | Use the official `@tailwindcss/vite` plugin; avoid dynamic class concatenation, prefer `cva` (class-variance-authority) |
| 9 | Reconnect storm if many tabs open and network blips | Exponential backoff with jitter ±20%; per-tab BroadcastChannel coalescing (later) |
| 10 | Auth token leak via inline HTML body → exposed if attacker can read the served page | Bind only to localhost + Tailscale interface; Tailscale already device-authenticated; documented limitation |

---

## 13. Out of scope (v3.0)

These will not ship in v3.0. v3.1+ may revisit.

- Notes, Channels, Calendar UI (the export iCal endpoint stays), Map, Habits, CRM, Torrents, Mail, Journal — explicit drops.
- Standalone Terminal view (we have Focus mode; there's no separate "terminal" route).
- RBAC, multi-user, audit log UI beyond a read-only listing.
- Best-of-N execution (Cursor pattern).
- Live diff viewer with GitHub PR comment sync (`git diff` HTTP endpoints stay; UI is minimal).
- Spotlight testing (Conductor pattern: hot-swap branches in a running dev-server).
- VS Code extension.
- Cloud / SaaS hosting.
- Background sync replay (PWA scaffolding lands, full sync deferred).
- Browser pane / Chrome import.
- SSH/remote workspaces.
- Workspace forking + sharing UI (share tokens persist in DB; sharing UI deferred).
- Mermaid + LaTeX rendering in chat (no chat in v3.0; chat is the tmux pane).
- Custom syntax/colorblind themes (just dark + light).

---

## Appendix A — Quick reference: files this plan creates

```
~/amux-v3/
├── plan/TECH_PLAN.md                                          ← this file
├── skill/SKILL.md                                             ← /amux-build orchestrator
├── skill/state.json                                           ← loop state
├── scripts/{dev,build,deploy,migrate-v2}.{sh,py}
├── server/{Cargo.toml, build.rs}
├── server/src/{main,config,auth,error,state,http,static_assets}.rs
├── server/src/db/{mod,sessions,board,schedules,prefs,runtime_state}.rs
├── server/src/sessions/{mod,lifecycle,tmux,pty,status,steering,auto_actions}.rs
├── server/src/ws/{mod,streamer,protocol}.rs
├── server/src/board/{mod,claim,prefix}.rs
├── server/src/files/{mod,path_safe,range}.rs
├── server/src/scheduler/{mod,parser,runner,watch}.rs
├── server/src/agents/{mod,wait,delegate,skills}.rs
├── server/src/sse.rs
├── server/migrations/{0001_init,0002_board,0003_schedules,0004_runtime_state,0005_delegations,0006_kbd}.sql
├── server/tests/{auth,http_session,ws_pty,board_claim,status_detector,scheduler,files,lifecycle}.rs
├── server/tests/fixtures/status/*.txt
├── web/{package.json,vite.config.ts,tailwind.config.ts,tsconfig.json,index.html}
├── web/public/{manifest.json,icon-{192,512}.png,favicon.svg}
├── web/src/{main,App,env}.tsx, web/src/styles/globals.css
├── web/src/routes/{overview,board,files,scheduler,settings}.tsx
├── web/src/routes/focus/{desktop,mobile,index}.tsx
├── web/src/components/ui/* (shadcn)
├── web/src/components/session-tile/{tile,tail-preview,status-dot}.tsx
├── web/src/components/focus-mode/{desktop-split,mobile-sheet,dock}.tsx
├── web/src/components/terminal/{live-terminal,peek-terminal}.tsx
├── web/src/components/kbd-accessory/{accessory-bar,group,pager,manage-sheet}.tsx
├── web/src/components/joystick/joystick.tsx
├── web/src/components/slash-menu/slash-menu.tsx
├── web/src/components/snippets/{snippet-panel,snippet-editor}.tsx
├── web/src/components/status-banner/reconnect-banner.tsx
├── web/src/components/view-transitions/morph.tsx
├── web/src/hooks/{use-ws,use-live-term,use-sessions,use-board,use-sse,use-haptics,use-long-press,use-safe-area}.ts
├── web/src/stores/{ui-store,focus-store,prefs-store}.ts
├── web/src/lib/{api,springs,ansi,keys,format}.ts
├── web/ACCEPTANCE.md
└── web/tests/e2e/*.spec.ts
```

---

**End of TECH_PLAN.md.** Tens of subagents will now execute against §10. Good luck.
