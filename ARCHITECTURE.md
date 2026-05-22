# supermux — Architecture

This document describes how supermux is built: the Rust backend, the React
frontend, the data model, the live-status detector, and how the pieces fit
together. It is a design reference for contributors.

For setup and deploy instructions, see [`README.md`](README.md).

---

## 0. Executive summary

**What we're building.** supermux is a Rust HTTP+WS backend that drives `tmux` sessions running Claude Code / Codex, paired with a React-19 + Vite frontend that delivers a Termius-grade mobile experience and a "BE in tmux, via web" desktop experience. The dashboard is dense, hover-peek tiles on the overview; a real keyboard-captured focus mode on desktop; a Vaul-detent bottom sheet with a Termius-style accessory dock on mobile. The agent surface is small and opinionated: Sessions, Board, Files, Scheduler — nothing else.

**Key architecture decisions.** Single Rust binary (`supermux-server`) that embeds the built frontend via `rust-embed` (stable Rust, no nightly), serves both HTTP and WebSocket on one port, persists to a single SQLite (`~/.supermux/data.db`) via `sqlx`, and spawns child `tmux` processes for each agent session. Frontend uses xterm.js for the live terminal (WS pty bytes streamed character-by-character), TanStack Query for HTTP cache, Zustand for local UI state, Framer Motion 11 for every animation. No global mutable state outside Zustand stores. No 3s polling fallback — WebSocket is the only path for live terminal data, SSE for metadata, manual refetch on visibility for catch-up.

**The hero data flow (tile-tail-preview).** The overview's wow moment — dense grid of tiles each showing the last 6 lines of its agent's terminal, live — is plumbed end-to-end. The status detector's `tmux capture-pane` (every 2s per session, §3.6) writes the captured text into `session_runtime.last_capture`. `SessionSummary` gains `preview_lines: Vec<String>` (last 6 lines, ANSI-stripped). The SSE `sessions` event payload includes `preview_lines` deltas (only when changed). The frontend tile renders directly from `SessionSummary` — no per-tile WS subscription, no polling, single source of truth. Full data flow documented §3.6 → §3.4 SSE → §4.3 SessionTile.

**WebSocket auth (first-frame).** WS auth uses an in-band first-frame `{type:"auth", token:"..."}` message (NOT `?_token=` in the URL). This keeps the token out of access logs, browser address bars, and screenshots. Backend accepts the upgrade, waits up to 2s for the auth frame, then closes 1008 if missing/invalid.

**WS close 1013 = silent reconnect on visibility-visible.** Subscriber-too-slow is treated as temporarily permanent: no tight backoff retry, but a silent one-shot reconnect on next `visibilitychange → visible` event (≥2s debounce). The reconnect banner morphs amber → green without user action.

**Scope.** The codebase is organized into five tracks: bootstrap, backend, frontend-core, frontend-routes, and integration/deploy/polish. Total size is roughly ~16 000 lines (~7 600 Rust, ~8 400 TypeScript/TSX).

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
│             supermux-server (single Rust binary, port 8823)                      │
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
│  │ sqlx::SqlitePool   │  │ tokio::process::Command│  │ rust-embed (web)   │ │
│  │ ~/.supermux/data.db │  │ tmux/git/claude/codex  │  │ static frontend    │ │
│  └────────────────────┘  └────────────────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────────┐
                          │ tmux server (system-wide)  │
                          │  supermux-<name>               │
                          │   └─ claude / codex        │
                          │       └─ pty (fifo+log)    │
                          └────────────────────────────┘
```

### 1.2 Process model

- **supermux-server** (single binary, long-running). Spawned from systemd. Owns the SQLite handle, tokio runtime, all HTTP/WS listeners, and one pty reader task per active session.
- **tmux server** (one per OS user, system-wide). Created on demand by `tmux new-session`. tmux sessions named `supermux-<name>` survive supermux-server restarts (they're not children of the Rust process). supermux re-attaches via `tmux capture-pane` + `tmux pipe-pane` on startup.
- **claude / codex** (one per session). Child of tmux pane. PID tracked via `tmux list-panes -F '#{pane_pid}'` + `pgrep -P`.
- **No daemon-per-session**. The pty fan-out is in-process (one tokio task per session reading from a unix FIFO that `tmux pipe-pane` writes to).

### 1.3 Threading / concurrency model

- **tokio multi-thread runtime** (default worker count = CPU cores).
- **Per-session pty reader task**: drains a unix FIFO at `/tmp/supermux-pty-<name>.fifo`, appends to in-memory ring buffer (`Arc<Mutex<VecDeque<Bytes>>>`, cap 64 KB), broadcasts to `tokio::sync::broadcast::Sender<Bytes>` (capacity 256).
- **Per-WS-subscriber task**: `broadcast::Receiver<Bytes>` reads from the per-session sender; on `RecvError::Lagged(n)` it closes with code 1013 (subscriber too slow, never blocks fan-out).
- **Per-session status detector task**: runs every 2s; captures last 30 lines via `tmux capture-pane`, runs `detect_status()`, emits status changes via SSE channel.
- **Scheduler tick task**: `tokio::time::interval(Duration::from_secs(10))`; queries `SELECT ... WHERE next_run <= ?`, dispatches each due schedule.
- **SSE fan-out**: a single `tokio::sync::broadcast::Sender<Event>` channel; HTTP handler returns an `axum::response::sse::Sse` stream that adapts the broadcast into `Event::default().json_data(...)`.
- **Locks**: per-session `tokio::sync::Mutex<SessionLock>` for `send_text`/`start`/`stop`/`config` (prevents tmux command races). Global state lives in `AppState` (struct of `Arc<...>` fields).

### 1.4 Auth model

- **Bearer token** stored at `~/.supermux/auth_token` (mode 0o600). Generated via `rand::rngs::OsRng` (32 bytes, base64url) on first start. Overridable via env `SUPERMUX_AUTH_TOKEN=...`; setting `SUPERMUX_AUTH_TOKEN=none` disables auth (dev-only escape hatch, logs a warning).
- **Required on ALL routes by default**. Middleware checks `Authorization: Bearer <tok>` OR `?_token=<tok>` query. Only routes annotated with `#[public]` (in practice: `/manifest.json`, `/sw.js`, `/icon.*`, `/`) skip the check.
- **No localhost bypass**. A localhost auth bypass is a CVE waiting to happen on Tailscale-served deployments — supermux has none.
- **WebSocket auth**: same token via `?_token=` query (browsers don't allow custom headers on WS upgrade).
- **Bind interfaces**: `127.0.0.1` + Tailscale interface (auto-detected via `tailscale ip --4`). Default config explicitly does NOT bind `0.0.0.0`.
- **Origin allowlist for WS**: `localhost`, `127.0.0.1`, LAN IP (auto-detected), `*.ts.net` (Tailscale MagicDNS). Other origins → close 1008.

### 1.5 Deployment

- **Single binary**. `cargo build --release` produces `target/release/supermux-server`. Frontend built with `bun run build` produces `web/dist/`. The build script copies `web/dist/` to `server/static/` and `#[derive(RustEmbed)] #[folder = "static/"]` (via `rust-embed`) embeds it at compile time. End-state: one binary (~30-60MB stripped given the dependency set) that serves the whole product.
- **Service**: runs under systemd as an unprivileged account, binding a loopback port. The data directory defaults to `~/.supermux/`. See `etc/systemd/supermux.service` and `scripts/deploy.sh`.
- **TLS**: terminated by a reverse proxy (nginx/Caddy) or by `tailscale serve`, in front of the loopback port.
- **No Docker, no Node at runtime, no Python**. Just the binary + a SQLite file + the tmux server already on the box.

---

## 2. Repository layout

```
supermux/                         (repo root, NOT a Cargo workspace at top)
├── ARCHITECTURE.md              (this file)
├── README.md
├── LICENSE
├── etc/systemd/supermux.service (systemd unit template)
├── scripts/
│   ├── dev.sh                   (cargo watch + vite dev concurrently)
│   ├── build.sh                 (build web → embed → cargo build --release)
│   ├── deploy.sh                (ship git archive → build on host → install)
│   └── migrate-v2.py            (read ~/.amux → write ~/.supermux)
├── server/                      (Rust backend)
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── build.rs                 (re-runs rust-embed when ./static changes)
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
│       ├── config.rs            (~/.supermux/config.toml + env override)
│       ├── auth.rs              (middleware + #[public] route attribute)
│       ├── error.rs             (AppError enum + IntoResponse impl)
│       ├── state.rs             (AppState struct: Pool, broadcast txs, etc.)
│       ├── http.rs              (axum Router builder; mounts all routes)
│       ├── static_assets.rs     (rust-embed + content-type detection)
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
        ├── env.ts               (window._SUPERMUX_* → typed accessors)
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
        │   ├── api.ts           (typed fetcher; reads window._SUPERMUX_AUTH_TOKEN)
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
name = "supermux-server"
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
rust-embed = { version = "8.5", features = ["mime-guess"] }  # embed web/dist on stable Rust

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
- `rust-embed` for embedding `web/dist` — works on stable Rust (was `include_dir` with nightly feature in v1; Codex caught the mismatch with `rust-version = "1.83"`). Provides `RustEmbed::get(path)` returning `Cow<'static, [u8]>` + cached mime guess via the `mime-guess` feature.
- `cron` for cron-expression parsing in the scheduler.
- `notify` only if we want file-mtime self-restart à la v2 — can defer.
- `insta` for snapshot-testing the status detector against ~30 golden capture-pane outputs (this is THE crown jewel of v3 reliability).

### 3.2 Module-by-module design

#### 3.2.1 `main.rs`

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    let config = config::load()?;          // ~/.supermux/config.toml or defaults
    let pool = db::init(&config).await?;   // sqlx pool + run migrations
    let state = state::AppState::new(pool, config.clone());

    // spawn background tasks
    sessions::auto_actions::spawn(state.clone());
    scheduler::spawn(state.clone());
    sessions::reattach_existing(state.clone()).await?;  // restore pipe-pane after restart

    let app = http::router(state.clone());
    let listener = bind_tls(&config).await?;
    tracing::info!("supermux listening on {}", config.bind);

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
    pub data_dir: PathBuf,           // ~/.supermux
    pub bind: SocketAddr,            // 127.0.0.1:8823
    pub extra_binds: Vec<SocketAddr>,// tailscale IP:8823 etc.
    pub tls: TlsConfig,              // cert + key paths OR self-signed
    pub auth_token: String,          // from file or SUPERMUX_AUTH_TOKEN env
    pub provider_defaults: ProviderDefaults,
}
pub fn load() -> Result<Config> { /* defaults + ~/.supermux/config.toml + env */ }
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

**Lock map lifecycle (added v2 per Eng concurrency #5/#6).** Both `session_locks` and `status_notify`/`status_watch` maps are added-on-first-use and EXPLICITLY removed in `sessions::delete` (and `archive`). Without this, weeks of session churn leak entries. Required cleanup: `state.session_locks.remove(name); state.status_watch.remove(name); state.hook_tokens.remove(name);`.

**Status detector locking rule.** The 2s status detector tick MUST NOT acquire the per-session `SessionLock`. `tmux capture-pane` is read-only on tmux server, never races a write. Stating this explicitly so subagents don't add a `lock().await` "for safety" that would starve detection under bursty sends.

**`archive` is async-job-shaped.** `POST /api/sessions/{name}/archive` returns **202 Accepted + `{job_id}`** immediately. The actual scrollback dump (potentially 50k lines) runs in `tokio::task::spawn_blocking` (filesystem-bound). Progress + completion are surfaced via the SSE `alerts` channel. Mirrors v2's stop-pool pattern.

**`stop` failure surface.** `POST /stop` returns 202 (was already in plan). If the stop graceful→hard sequence fails, emit an `alert` SSE event with `{level:"error", session, detail}`. Status transitions cleanly `stopped → unknown → stopped` (never silent).

#### 3.2.6 `sessions/tmux.rs`

```rust
pub struct Tmux<'a> { pub name: &'a str }            // supermux-<name>
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
    pub fifo: PathBuf,                                    // /tmp/supermux-pty-<name>.fifo
    pub log: PathBuf,                                     // ~/.supermux/logs/<name>.log
    pub replay: Arc<RwLock<VecDeque<Bytes>>>,             // last 64 KB
    pub broadcast: broadcast::Sender<Bytes>,              // capacity 1024 (config-tunable, see below)
    started: tokio::sync::OnceCell<()>,                   // spawn-once gate (Eng concurrency #1)
}
impl PtyStream {
    pub async fn ensure_started(&self, tmux: &Tmux<'_>) -> Result<()>;
    // mkfifo if not exists, pipe-pane (idempotent), spawn reader task — ONCE via OnceCell
    pub fn subscribe(&self) -> (Vec<Bytes>, broadcast::Receiver<Bytes>);
    // returns current replay snapshot + a fresh receiver
    pub fn tail(&self, n: usize) -> Vec<String>;
    // CEO #1 fast-path: returns last N lines of replay (ANSI stripped), without re-capture-paning
}
```

**WS subscriber + broadcast capacity (v2 changes per CEO #6).** Per-session WS subscriber cap = **32** (was 8 in v1 — too tight for multi-device PWA: one user across phone + laptop + 2 tabs + Capacitor + TV + collaborator easily hits 4+). Broadcast channel capacity = **1024** (was 256 — same chatty-agent argument). Both are config-tunable via `config.toml`:
```toml
[ws]
broadcast_capacity = 1024
subscribers_per_session = 32
```

**Spawn-once via OnceCell (Eng concurrency #1).** `ensure_started` is idempotent AND race-safe: two concurrent WS subscribers calling `ensure_started` will both succeed but only one performs the `mkfifo` + `pipe-pane` + reader-spawn (`OnceCell::get_or_try_init`). Without this, both could `pipe-pane` and the second tee would race the first.

**FIFO open pattern (Eng P0 #1 + Codex #2).** The naive `tokio::fs::File::open(fifo)` blocks the kernel-level `open(2)` until a writer connects — that blocks an entire tokio worker thread (not just the task). The correct pattern:

```rust
use nix::fcntl::{open, OFlag};
use nix::sys::stat::Mode;
use tokio::io::unix::AsyncFd;
use std::os::unix::io::OwnedFd;
use std::io::Read;

// 1. mkfifo (idempotent — ignore EEXIST)
let _ = nix::unistd::mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR);

// 2. Wait until pipe-pane exit status is 0 (max 5 tries × 100ms)
ensure_pipe_pane_started(tmux).await?;

// 3. Open NON-BLOCKING read; also keep a write fd alive (Linux trick) to prevent
//    spurious EOFs whenever the tmux writer momentarily closes.
let rfd = open(&fifo, OFlag::O_RDONLY | OFlag::O_NONBLOCK, Mode::empty())?;
let _keep_writer = open(&fifo, OFlag::O_WRONLY | OFlag::O_NONBLOCK, Mode::empty())?;
let async_fd = AsyncFd::new(OwnedFd::from_raw_fd(rfd))?;

// 4. Read loop via AsyncFd + epoll readiness
let mut buf = [0u8; 8192];
let mut eof_backoff_ms = 100u64;
loop {
    let mut guard = async_fd.readable().await?;
    match guard.try_io(|inner| inner.get_ref().as_raw_fd().read(&mut buf)) {
        Ok(Ok(0)) => {
            // True EOF on the read end (very rare given keep_writer above)
            tokio::time::sleep(Duration::from_millis(eof_backoff_ms)).await;
            eof_backoff_ms = (eof_backoff_ms * 2).min(2000);
            // Detect tmux session death — tear down if so
            if !tmux.exists().await.unwrap_or(false) {
                tracing::warn!(name=%self.name, "tmux session gone, stream-dead");
                break;
            }
            continue;
        }
        Ok(Ok(n)) => {
            eof_backoff_ms = 100;
            let chunk = Bytes::copy_from_slice(&buf[..n]);
            push_replay(&replay, &chunk);
            let _ = broadcast.send(chunk);  // drops if no subs — fine
        }
        Ok(Err(e)) if e.kind() == ErrorKind::WouldBlock => continue,
        Ok(Err(e)) => { tracing::warn!(?e, "fifo read"); break; }
        Err(_would_block) => continue,
    }
}
```

Key invariants:
- `O_NONBLOCK` + `AsyncFd` + epoll readiness — never blocks a tokio worker.
- The keep-alive write fd suppresses spurious `Ok(0)` on transient writer-close (Linux pipe semantics).
- EOF backoff caps at 2s — no hot loop on tmux death.
- Reader task terminates when `tmux.exists()` returns false (session truly gone); session is marked `stream-dead` and surfaced via status.

**`broadcast.send` returns Err when no subscribers** — documented intentional drop. New subscribers get the replay snapshot on connect.

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

**Status broadcast (Eng P0 #2 fix — watch::Sender instead of Notify).** v1 used `tokio::sync::Notify` for the `wait` long-poll, which has a notify-before-subscribe race: between a `wait` handler reading `current_status` and registering `notified()`, the detector tick can fire `notify_waiters()` (which DROPS, unlike `notify_one`), losing the transition forever.

v2 replaces `Notify` with **versioned watch channel**:
```rust
// per-session, in AppState::status_watch: DashMap<String, watch::Sender<(Status, u64)>>
let (tx, _rx) = tokio::sync::watch::channel((Status::Unknown, 0u64));
// On detector tick:
let (cur, ver) = *tx.borrow();
if new_status != cur {
    tx.send_replace((new_status, ver + 1));
    // also: persist to session_runtime, emit SSE
}
```
Wait handler observes `version` advance (or matching status). No race window. See §3.7 for the wait loop.

**Cold-start initialization (Eng failure-path table).** On `main.rs` boot, all detectors initialize with `last_pty_byte_at = Instant::now() - Duration::from_secs(300)`. Without this, after a server restart every session would be classified `Active` for the first 1.5s (since "last pty byte" defaults to "now"). Initial detector tick must observe `Unknown` until either capture-pane confirms a status OR pty bytes actually flow.

**`last_capture` field — the tile-preview source-of-truth (CEO #1).** After every successful 2s capture-pane tick, the detector ALSO writes `capture` (last 30 lines, ANSI stripped) to `session_runtime.last_capture`. This is the single canonical source the SessionSummary builder reads from for `preview_lines`. The detector is responsible for both classification AND preview text — same input (`capture-pane -p -S -30`), two outputs. See §3.6 fusion rule.

#### 3.2.9 `ws/mod.rs`

**Auth model (v2 change — TIER 0 fix per Codex #7).** Browsers can't set custom headers on WS upgrade, but the standard fix is **NOT** `?_token=` in the query (which leaks into tracing logs, reverse-proxy access logs, browser address bar, and shared screenshots). Two safe options; v3 uses **first-frame auth**:

1. The WS upgrade is accepted with NO token check (only the Origin allowlist).
2. The server starts a 2-second timeout. If the first inbound frame is not `{"type":"auth","token":"<tok>"}` with a valid token, server closes with code 1008.
3. On valid auth, server replies `{"type":"auth_ok"}` and switches to the normal pty stream (replay first).

Alternative (acceptable): `Sec-WebSocket-Protocol: supermux.bearer.<token>` subprotocol header — browsers accept this via `new WebSocket(url, ['supermux.bearer.' + token])`. Implementer's choice; first-frame is simpler to debug and works through any proxy.

Frontend impact: `useLiveTerm` connects WITHOUT `?_token=`, sends `{type:"auth",token:...}` immediately on `onopen`, waits for `auth_ok` before considering itself `live`. Documented in §4.5.

**Subscriber overflow (1013) is recoverable, NOT permanent (Eng P1 #4).** v1 marked close 1013 as PERMANENT (mobile UI showed "Tap to retry"). v2 changes this: 1013 closes the WS but the client AUTOMATICALLY reconnects on next `visibilitychange → visible` (≥2s debounce). See §4.5 for the frontend behavior.

```rust
pub async fn handle_ws(
    ws: WebSocketUpgrade,
    Path(name): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // 1. validate origin (close 1008 on mismatch) — pre-upgrade
    // 2. ws.on_upgrade(move |sock| handle_socket(sock, name, state))
    // (NO ?_token= validation here — auth happens in-band)
}

async fn handle_socket(sock: WebSocket, name: String, state: AppState) {
    let (mut tx_ws, mut rx_ws) = sock.split();

    // 1. First-frame auth: wait up to 2s for {type:"auth", token:"..."}
    let auth_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let auth_ok = tokio::select! {
        msg = rx_ws.next() => matches!(msg, Some(Ok(Message::Text(s))) if state.verify_auth_frame(&s)),
        _ = tokio::time::sleep_until(auth_deadline) => false,
    };
    if !auth_ok {
        let _ = tx_ws.send(Message::Close(Some(CloseFrame {
            code: CloseCode::Library(1008), reason: "auth required".into()
        }))).await;
        return;
    }
    let _ = tx_ws.send(Message::Text(r#"{"type":"auth_ok"}"#.into())).await;

    // 2. Enforce per-session subscriber cap (config.ws.subscribers_per_session = 32)
    let stream = state.pty_for(&name).await.unwrap();
    if stream.subscriber_count() >= state.config.ws.subscribers_per_session {
        let _ = tx_ws.send(Message::Close(Some(CloseFrame {
            code: CloseCode::Library(1013), reason: "subscriber limit".into()
        }))).await;
        return;
    }

    let (replay, mut rx) = stream.subscribe();

    // 3. send replay
    for chunk in replay { tx_ws.send(Message::Binary(chunk)).await.ok(); }

    // 4. fan-out and ping loop
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

    // 5. read client → tmux
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

**Tracing redaction (Codex #24).** Configure `tracing-subscriber` with a layer that redacts the `Authorization` header, the `Cookie` header, and any query key matching `_token|token|key` to `<redacted>` before the JSON formatter sees them. Without this, every 401 request gets the bearer token written to the log.

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

**Critical fix (TIER 0 per Codex #3).** `std::fs::canonicalize` requires the path to EXIST — every `PUT /api/file` to create a new file would 500 in v1. v2 uses the **parent-canonicalize + filename join** pattern; canonicalize-able parent always exists for any create/write target.

```rust
pub async fn resolve_safe(input: &str, jail: Option<&Path>) -> Result<PathBuf, PathError> {
    let expanded = shellexpand::tilde(input).into_owned();
    let candidate = PathBuf::from(expanded);

    // Canonicalize parent (must exist); join basename. Defeats `..` traversal.
    let abs = if candidate.exists() {
        tokio::fs::canonicalize(&candidate).await?
    } else {
        let parent = candidate.parent().ok_or(PathError::Invalid)?;
        let name = candidate.file_name().ok_or(PathError::Invalid)?;
        tokio::fs::canonicalize(parent).await?.join(name)
    };

    // Block exact paths (case-insensitive compare to defeat macOS HFS+ `/ETC/SHADOW` trick)
    let abs_lower = abs.to_string_lossy().to_lowercase();
    if BLOCKED.iter().any(|b| abs_lower == b.to_lowercase()) {
        return Err(PathError::Blocked);
    }
    if BLOCKED_PREFIXES.iter().any(|b| abs_lower.starts_with(&b.to_lowercase())) {
        return Err(PathError::Blocked);
    }
    if let Some(home) = dirs::home_dir() {
        for rel in HOME_BLOCKED {
            if abs.starts_with(home.join(rel)) { return Err(PathError::Blocked); }
        }
    }
    if let Some(jail) = jail {
        if !abs.starts_with(jail) { return Err(PathError::OutsideJail); }
    }

    // TOCTOU mitigation: callers MUST use the returned PathBuf with O_NOFOLLOW
    // (tokio::fs::OpenOptions::new().custom_flags(libc::O_NOFOLLOW)) to refuse
    // any symlink swap between resolve_safe and the actual open.
    Ok(abs)
}
```

Fixes:
- **Async**: `tokio::fs::canonicalize` (was sync `PathBuf::canonicalize` — blocks tokio worker).
- **Non-existent file**: parent-canonicalize + join basename.
- **macOS case insensitivity**: lowercase compare for blocklist matches (`/etc/shadow` == `/ETC/SHADOW` on HFS+ default).
- **TOCTOU symlink swap**: caller-side `O_NOFOLLOW` is mandatory. Document in §3.2.11 and enforce via a `safe_open(...)` helper used by the files module.

Blocklist verbatim from §3.4 of feature-extract: `/etc/shadow`, `/etc/sudoers`, …; prefixes `/etc/ssh/`, `/var/run/secrets/`, …; home-relative `.ssh`, `.gnupg`, `.aws`, …

**Property test mandatory (not optional)** — was "optional" in v1; v2 promotes to required CI gate: proptest the resolver against random Unicode-normalization, `..`-stacks, `//`-collapses, NUL bytes, and symlink fixtures.

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

**Fixed (Eng P0 #2): version-watched, no notify-before-subscribe race.** v1 used `Notify::notified()`, which loses transitions if the detector fires `notify_waiters()` between the `read current_status` and `.notified().await` registration. v2 uses `tokio::sync::watch::Sender<(Status, u64)>` per session.

```rust
pub async fn wait(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<WaitQuery>,
) -> Result<Json<WaitResult>, AppError> {
    let want: Status = q.state.parse()?;
    // Cap timeout at 300s to fit under Tailscale's 300s idle-connection kill (Codex #9)
    let timeout = Duration::from_secs(q.timeout.unwrap_or(300).min(300));
    let deadline = tokio::time::Instant::now() + timeout;

    let rx = state.status_watch_for(&name).await?.subscribe();
    let mut rx = rx;
    // Read initial value WITHOUT a separate query — watch::Receiver always has the latest
    let (cur, mut ver) = *rx.borrow();
    if cur == want { return Ok(Json(WaitResult { reached: true, status: cur })) }

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let (cur, _) = *rx.borrow();
            return Ok(Json(WaitResult { reached: false, status: cur }));
        }
        // Send periodic keep-alive newlines via Sse-style chunked-transfer so reverse
        // proxies don't kill the idle connection (Codex #9). Either flush a 0-byte
        // padding every 25s or switch to SSE. Cap timeout at 300s as above.
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() { break; }  // sender dropped (session deleted)
                let (cur, new_ver) = *rx.borrow();
                if new_ver == ver { continue; }
                ver = new_ver;
                if cur == want { return Ok(Json(WaitResult { reached: true, status: cur })) }
            }
            _ = tokio::time::sleep(remaining) => {
                let (cur, _) = *rx.borrow();
                return Ok(Json(WaitResult { reached: false, status: cur }));
            }
        }
    }
    Err(AppError::NotFound(name))
}
```

Status changes detected by `sessions::status` task call `tx.send_replace((status, ver+1))` on a single `watch::Sender` per session (stored in `state.status_watch: DashMap<String, watch::Sender<(Status, u64)>>`). `watch::Receiver::changed()` is wake-once-per-change AND it ALWAYS holds the latest value, so there is no race window.

**Debounce on flaps (Codex #9 secondary).** Detector tick is 2s, so flapping is already debounced. But if hooks fire many events in 1s, the watch send can still rapid-update. Coalesce via a 50ms debounce: detector tick only persists/broadcasts the FINAL status after 50ms of stability.

HTTP long-poll, no SSE complication.

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
    CHECK (provider IN ('claude', 'codex', 'shell'))   -- 'shell' added v2 for test-only sessions (fix contradiction B from Codex)
);
CREATE INDEX idx_sessions_pinned ON sessions(pinned DESC, last_send DESC);
-- Partial index for the common overview query that filters archived=0 (Eng schema gap)
CREATE INDEX idx_sessions_active ON sessions(pinned DESC, last_send DESC) WHERE archived = 0;

CREATE TABLE session_runtime (    -- ephemeral but persisted across restarts
    name                  TEXT PRIMARY KEY REFERENCES sessions(name) ON DELETE CASCADE,
    rate_limit_reset_at   INTEGER NOT NULL DEFAULT 0,
    hibernated            INTEGER NOT NULL DEFAULT 0,
    restarting            INTEGER NOT NULL DEFAULT 0,
    last_claude_alive_pid INTEGER NOT NULL DEFAULT 0,
    last_status           TEXT NOT NULL DEFAULT 'unknown',
    last_status_at        INTEGER NOT NULL DEFAULT 0,
    -- Added v2 for hero tile-tail preview (CEO #1): last 30 lines of capture-pane output, ANSI stripped
    last_capture          TEXT NOT NULL DEFAULT '',
    -- Added v2 for per-session hook auth scoping (Eng P1 #3): random 32-byte base64url per session
    hook_token            TEXT NOT NULL DEFAULT '',
    CHECK (last_status IN ('active','waiting','idle','stopped','unknown'))
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
-- Added v2 (Eng schema gap): cover SELECT id,text FROM steering_queue WHERE session=? ORDER BY id LIMIT 1
CREATE INDEX idx_steering_session ON steering_queue(session, id);

CREATE TABLE share_tokens (
    token     TEXT PRIMARY KEY,
    session   TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    perms     TEXT NOT NULL,                       -- 'output'|'output+files'|'output+files+notes'
    label     TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,                            -- nullable
    created_at INTEGER NOT NULL,
    CHECK (perms IN ('output','output+files','output+files+notes'))
);
-- Added v2 (Eng schema gap): cover DELETE WHERE session=? on session delete
CREATE INDEX idx_share_tokens_session ON share_tokens(session);
```

**Note on `share_tokens` table.** Schema exists, but v3.0 does NOT ship a `share` UI or HTTP CRUD. The table is reserved for v3.1. To stop subagents from inferring "implement share endpoints," §13 (Out of scope) restates this explicitly, and §3.4 does NOT list `/api/sessions/{name}/share` endpoints.

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
    CHECK (kind IN ('tmux','shell','boot')),
    CHECK (sched_type IN ('once','recurring')),                                    -- Added v2 (Eng schema gap)
    CHECK (done_action IN ('disable','notify') OR done_action LIKE 'command:%')   -- Added v2 (Eng schema gap)
);
CREATE INDEX idx_schedules_due ON schedules(deleted, enabled, next_run);

-- Added v2 (Eng): idempotency tuple for scheduler missed-tick recovery (Codex #6)
-- (schedule_id, scheduled_for_ts) UNIQUE — prevents double-fire on restart
CREATE TABLE schedule_run_keys (
    schedule_id      TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    scheduled_for_ts INTEGER NOT NULL,
    fired_at         INTEGER NOT NULL,
    PRIMARY KEY (schedule_id, scheduled_for_ts)
);

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

**`kbd_groups` is table-backed, NOT prefs-blob (Eng schema gap; resolves Codex contradiction E).** v1's M16 prompt offered an alternative "OR keep prefs blob-based: store as `prefs[kbd_groups]` JSON." v2 commits: **table only**. M16 reads/writes via `/api/kbd-groups` (handlers added in M9). The "OR" alternative is REMOVED from the M16 prompt.

```sql
-- migrations/0005_delegations.sql (NEW v2 — Eng + Codex finding #5)
CREATE TABLE delegations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    to_session   TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    prompt       TEXT NOT NULL,
    ts           INTEGER NOT NULL
);
CREATE INDEX idx_delegations_from ON delegations(from_session, ts DESC);
CREATE INDEX idx_delegations_to   ON delegations(to_session, ts DESC);
```

Notes: `from` is a SQL keyword — column aliased `from_session`. Cascading delete cleans rows when either side disappears. The M9 subagent prompt is updated to reference this migration (not invent it).

```sql
-- migrations/0006_alerts.sql (NEW v2 — minor: persist alerts ring buffer optionally)
-- Actually: alerts stay in-process (50-entry ring buffer), per Eng §3.3 last bullet.
-- This file is reserved-empty; we keep numbering aligned with kbd_groups which
-- already lives in 0004. NO 0006 migration required.

-- migrations/0007_audit.sql (NEW v2 — Eng + Codex finding #5)
CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    actor  TEXT NOT NULL,                                -- 'user' | 'scheduler' | 'agent:<name>'
    action TEXT NOT NULL,                                -- e.g. 'session.delete', 'schedule.run', 'file.put'
    target TEXT NOT NULL DEFAULT '',                     -- the affected entity id/path
    detail TEXT NOT NULL DEFAULT '{}'                    -- JSON detail
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
```

**Which routes write `audit_log` rows (Eng §6.4 spec):**
- `DELETE /api/sessions/{name}` → `action=session.delete`
- `DELETE /api/board/{id}` → `action=issue.delete`
- `DELETE /api/schedules/{id}` → `action=schedule.delete`
- `POST /api/schedules/{id}/run` → `action=schedule.run`
- `scheduler::tick` firing a schedule → `actor=scheduler, action=schedule.fire`
- `PUT /api/file` → `action=file.put`
- `DELETE /api/fs/delete` → `action=file.delete`
- `PATCH /api/settings/env` → `action=settings.env.patch` (detail does NOT include the value)
- `POST /api/sessions/{name}/archive` → `action=session.archive`

`agents::delegate::delegate(from, to, ...)` → `actor=agent:<from>, action=session.delegate, target=<to>`.

Wired via `db::audit_writer::log(&pool, AuditEntry{...})` helper called from each handler.

### 3.4 HTTP + WebSocket API

Comprehensive endpoint list — see `research/amux-feature-extract.md` §1.1, §2.1, §3.1, §4.1, §5 for exhaustive shapes. v3 keeps the URL surface, with these explicit additions:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions` | Returns `SessionSummary[]` including `preview_lines: string[]` (last 6 lines of `last_capture`, ANSI stripped). The SSE `sessions` event payload uses the SAME shape (deltas only). |
| GET | `/api/agents/{name}/wait?state=idle&timeout=300` | **NEW.** Long-poll until session reaches state. **300s max** (was 600s — capped under Tailscale's 300s proxy timeout per Codex #9). Watch-channel backed (Eng P0 #2). |
| POST | `/api/agents/delegate` | **NEW.** `{from, to, prompt}` — sends prompt to `to`, records delegation edge. |
| GET | `/api/agents/delegations?session=X` | **NEW.** Returns delegation edges in/out of session for graph view. |
| GET | `/api/snippets` / POST / DELETE / PATCH | **NEW.** Saved-command CRUD (used by snippet picker). |
| GET | `/api/kbd-groups` / POST / DELETE / PATCH | **NEW.** Accessory-bar group CRUD. |
| POST | `/api/_internal/hook` | **NEW v2 (Eng P1 #3 + table).** Per-session `hook_token` auth (header `X-Supermux-Hook-Token`), NOT the dashboard bearer. Called by Claude SettingsHook to surface `pre_tool` / `post_tool` / `notification` / `stop` / `subagent_stop` events. Body: `{session, event}`. |
| GET | `/api/audit?limit=200` | **NEW v2 (Eng + table).** Returns last N audit_log rows. Auth required. |
| GET | `/api/health` | **NEW v2 (Eng).** `#[public]` (no auth). Returns `{version, uptime_s, db_ok, tmux_ok}`. Used by M25 deploy verification. |

**Out-of-scope (v3.0):** `/api/sessions/{name}/share` (GET/POST/DELETE) — schema (`share_tokens`) exists for v3.1 forward-compat; no handlers in v3.0. Restated in §13.

Everything else is the canonical list from `research/amux-feature-extract.md` Appendix B. Notable shape decisions:

- **HTTP envelope** (v2 explicit per Eng): `application/json` shaped `{ ok: bool, data?: T, error?: string }`. Two envelopes by design: HTTP uses `data`, SSE uses `payload` because SSE is a stream-of-events, not request-reply.
- **SSE event format**: same JSON-on-data-line as v2, but emitted via axum SSE adapter. Event shape `{type: "...", payload: ...}`. Event types: `sessions` (full + delta), `board`, `schedules`, `alerts`, `ping` (every 10s), `status` (per-session status delta — name + status + version). The `sessions` event payload always includes `preview_lines` delta keys.
- **WS subprotocol**: none. Binary frames for pty bytes, text frames for JSON control. `ClientMsg` v2 adds `Auth{token}` as the first-frame auth message; otherwise same as v1: `input`/`key`/`resize`/`ping`.
- **Auth (HTTP)**: `Authorization: Bearer <token>` is the canonical form; `?_token=` is still accepted for legacy curl convenience but logged-with-redaction. **WS uses in-band first-frame `{type:"auth",token:...}` ONLY** — no query string (Codex #7).
- **Status codes**: 200 OK, 201 Created, 202 Accepted (stop returns immediately), 400 BadRequest, 401 Unauthorized, 403 Forbidden, 404 NotFound, 409 Conflict (claim race), 410 Gone (deleted), 500 InternalServerError.

**`http.rs` router-registry pattern (Eng dep-graph fix per M2 prompt).** v2 mandates `http::router(state)` is composed via per-module `router_for(state) -> Router` functions:

```rust
pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(sessions::router_for(state.clone()))
        .merge(board::router_for(state.clone()))
        .merge(files::router_for(state.clone()))
        .merge(scheduler::router_for(state.clone()))
        .merge(agents::router_for(state.clone()))
        .merge(prefs::router_for(state.clone()))
        .merge(audit::router_for(state.clone()))
        .layer(auth::middleware(state.clone()))
        .merge(public::router_for(state))   // manifest, sw, icons, /api/health — no auth
}
```

Each milestone M6/M7/M8/M9 adds ONE file and ONE line in `http.rs::router()`. No 3-way merge conflicts on `http.rs`.

### 3.5 tmux integration

Same conventions as v2 (§1.4 of feature-extract), with v2-vs-v3 coexistence prefix:

- **tmux session prefix: `supermux-<name>`** (v2 keeps `supermux-<name>`). This prevents v2 and v3 from BOTH calling `pipe-pane` on the same tmux session and trampling each other's FIFOs during the 2-week side-by-side dogfooding window (Eng failure-paths table). v3 also REFUSES to attach to any session not prefixed `supermux-`.
- `new-session -d -s supermux-<name> -n <name> -c <dir> -e SUPERMUX_SESSION=<name> -e SUPERMUX_URL=<bind_url> <SHELL>`.
  - `SUPERMUX_URL` is read from the `config.bind` (NOT hardcoded `localhost:8823`) — Eng failure-paths table. Hook command must use `$SUPERMUX_URL` so config changes don't break Claude calls.
  - `SUPERMUX_HOOK_TOKEN` is ALSO injected per-session (see §6.5 below) — distinct from the dashboard bearer.
- `set-option remain-on-exit on`, `allow-rename off`, `automatic-rename off`.
- After spawn: source `~/.zprofile`/`~/.bash_profile`/`~/.profile` (whichever exists), `cd <dir>`, then send the `claude` (or `codex`) command.
- `pipe-pane -O -t <target> 'tee -a <log> > <fifo>'` for live stream. Replaces any existing pipe (idempotent). FIFO path: `/tmp/supermux-pty-<name>.fifo` (v3-prefixed).
- For session adoption (`/api/sessions/connect`): read `pane_current_path`, rename tmux to `supermux-<name>` (refusing if already `supermux-...`), write DB row.

**`~/.claude/settings.json` write strategy (Eng concurrency #4 + Codex #19).** `claude_config.rs::install_hooks()` MUST be atomic and non-destructive:

1. Read existing `~/.claude/settings.json` (handle ENOENT as empty `{}`).
2. Parse as JSON.
3. Set/replace ONLY the `hooks.PreToolUse|PostToolUse|Notification|Stop|SubagentStop` entries whose `matcher` is `"*"` and whose first `hooks[].command` includes the string `supermux-hook` (a marker we always inject in the command line for identifiability). This makes the operation idempotent and coexistence-safe: any user-added hooks AND any v2-supermux hooks pass through unmodified.
4. Write to `~/.claude/settings.json.supermux-tmp`, fsync, `rename(2)` over the original (atomic on POSIX).

This way:
- cmux's hooks coexist with supermux's.
- Re-running `install_hooks()` is idempotent.
- A user-edited `settings.json` is not blown away on every restart.
- A v2 amux running on the same machine writes nothing to settings.json (v2 didn't use hooks per feature-extract), so no conflict.

Wait-for-ready poll: `tmux capture-pane` every 1s, looking for `❯` or `❱` or known Claude UI tokens, max 10s. If resume picker stuck → send `Escape Escape C-c`, clear `cc_session_name`/`cc_conversation_id`, retry with `--name`. Same as v2.

### 3.6 Live status detector (the killer feature)

**Goal**: when the UI says "waiting", the agent is actually waiting. cmux issue #1027 publicly failed at this; v3's bar is to never get it wrong twice in a row.

**Multi-signal fusion**:

1. **PTY heartbeat** (`last_pty_byte_at`). If bytes flowed in the last 1.5s → likely `Active`. If silent ≥30s → likely `Idle`.
2. **Capture-pane regex bank** (the v2 detector, ported verbatim with golden-fixture tests).
3. **Claude Code SettingsHook events** (NEW). supermux writes `~/.claude/settings.json` with hooks. **Auth is per-session `SUPERMUX_HOOK_TOKEN`, NOT the dashboard bearer** (Eng P1 #3 + Codex #4):
   ```json
   {
     "hooks": {
       "PreToolUse":  [{"matcher": "*", "hooks": [{"type":"command","blocking": false, "command": "supermux-hook curl -fsS --max-time 1 -X POST -H \"X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN\" $SUPERMUX_URL/api/_internal/hook -d \"{\\\"session\\\":\\\"$SUPERMUX_SESSION\\\",\\\"event\\\":\\\"pre_tool\\\"}\" || true"}]}],
       "PostToolUse": [...],
       "Notification": [...],
       "Stop":         [...],
       "SubagentStop": [...]
     }
   }
   ```
   Each hook fires a POST to `/api/_internal/hook` which the StatusDetector consumes. Event types: `pre_tool` (Active), `post_tool` (Idle-candidate; treated by the fusion rule as "no override; fall through to other signals"), `notification` (Waiting), `stop` (Idle), `subagent_stop` (Idle).

   **Hook auth contract** (Eng P1 #3 fix):
   - The token in `$SUPERMUX_HOOK_TOKEN` is per-session, generated at session create (32 bytes from `OsRng`, base64url), stored in `session_runtime.hook_token`.
   - `/api/_internal/hook` validates `X-Supermux-Hook-Token` against `session_runtime.hook_token` WHERE `name = body.session`. Token does NOT grant access to other sessions.
   - The dashboard bearer token is NEVER exposed to the session's environment, tmux env, or Claude's settings.json.
   - Hook command includes `|| true` AND `--max-time 1` AND `"blocking": false` so an unreachable supermux-server never blocks Claude tool execution.
   - The literal string `supermux-hook` in the command line is a marker (see §3.5 install_hooks) for idempotent re-installs.

   **Why not the dashboard bearer in env (Codex #4)?** Because `SUPERMUX_TOKEN` in tmux session env is then visible to: `env | grep SUPERMUX`, accidental `set -x`, any child telemetry uploader, any user with `ps aux` access on the same box (since the curl arg list shows `-H 'Authorization: Bearer ...'`). The per-session hook token has a tiny blast radius: leak of one session's token only grants that session's hook event surface, nothing else.
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

**Cold-start initialization (Eng failure-paths table).** On main.rs boot, when reattaching to a tmux session, the detector inits with `last_pty_byte_at = Instant::now() - Duration::from_secs(300)`. Without this, the first tick after restart would classify every session `Active` because "last pty byte" defaults to now.

**Hero data flow — the tile-tail-preview pipeline (CEO #1 + edits #1-6):**

```
status detector tick (every 2s, per session)
  ├─ capture = tmux capture-pane -p -S -30
  ├─ status  = detector.detect(capture, last_pty, last_hook)
  ├─ tail6   = ansi_strip(capture).lines().tail(6)
  ├─ UPDATE session_runtime SET last_capture = ?, last_status = ?, last_status_at = ?
  ├─ if status changed: state.status_watch[name].send_replace((status, ver+1))
  ├─ if status changed OR tail6 changed:
  │      sse_tx.send(Event::Sessions { delta: [{name, status?, preview_lines?}] })
  └─ end
```

Frontend (`useSessions` hook) listens for SSE `sessions` event, applies the delta via `queryClient.setQueryData(['sessions'], updater)`. Tile re-renders with the new `preview_lines`. **No per-tile WebSocket. No polling.** This is the hero data flow.

PtyStream's `tail(n)` method (§3.2.7) gives a slightly fresher tail from the raw pty replay buffer, but the canonical source is `session_runtime.last_capture` (consistent across all subscribers and survives restart).

**Tests**: 30 golden capture-pane snapshots from real Claude / Codex sessions, plus 5 corruption snapshots, in `tests/fixtures/status/*.txt`. Each is paired with a `.expected` file containing one of `active|waiting|idle`. `insta` snapshot-tests guarantee no regressions when the regex bank evolves.

**Performance optimization (Eng [P2] #7).** When pty bytes have flowed in the last 2s AND `last_status == Active`, the detector tick CAN SKIP the `tmux capture-pane` shell-out — the pty heartbeat alone establishes Active and we already have `last_capture` from a recent tick. This halves tmux spawn rate under high session count. v3.1 evolution path: migrate to `tmux -C` control mode (one persistent connection per session).

**Build split — M5a + M5b (v2.1, to flatten the backend critical path).** The status detector is decomposed into two buildable milestones so the regex/heartbeat core can start the moment M3 lands (parallel with M4) instead of waiting for both:

- **M5a — status detector core.** The pure `detect()` fusion function, the `Status` enum, the per-session 2s detector loop, PTY heartbeat (`last_pty_byte_at`), the capture-pane regex bank, the idle timeout, the `last_capture` writeback to `session_runtime`, cold-start init, and the capture-pane skip optimization. Plus the golden-fixture infrastructure (`tests/fixtures/status/*.txt`) and the `status_detector` / `status_detector_cold_start` snapshot tests. **Depends on M3** only (needs tmux `capture-pane` + session env injection; PTY heartbeat is read off the timestamp the M4 reader updates, but the core compiles and tests against fixtures without M4 wired). The 30 golden fixtures live here.
- **M5b — hook integration + multi-signal fusion + wait channel.** The Claude Code SettingsHook events (`/api/_internal/hook` endpoint with per-session `hook_token` auth), the `claude_config.rs::install_hooks()` atomic-rename namespaced writer, wiring the hook-event signal into the fusion rule (hook > regex > heartbeat > timeout), the per-session `tokio::sync::watch::Sender<(Status, u64)>` for the wait primitive, status broadcast via the SSE channel, and the 50ms flap debounce. Tests: `wait_race`, `hook_auth_scope`. **Depends on M4 + M5a** (M4 for the live pty heartbeat the fusion rule reads; M5a for the detector core it extends).

All downstream consumers that previously depended on "M5" now depend on **M5b** (the detector is only multi-signal-complete — watch channel + SSE status deltas — after M5b): M9 (wait channel) and M12 (SSE status deltas) — see §10 deps. The fusion code in this section is the M5b target; the regex bank + heartbeat + idle timeout in this section is the M5a target.

### 3.7 `wait` primitive

HTTP long-poll, 600s max timeout. Each session has a `tokio::sync::Notify` in `state.status_notify: DashMap<String, Arc<Notify>>`. The status-detector task calls `notify.notify_waiters()` on every state change. The `wait` handler `tokio::select!`s on (timeout, notify) and re-queries on each notify.

```bash
# CLI usage (via auto-installed supermux stub):
supermux wait worker-2 --state done --timeout 600
# Returns: {"reached": true, "status": "idle"} or {"reached": false, "status": "active"}
```

Frontend uses this for the delegation graph view: when an agent runs `supermux wait`, the UI shows a "waiting on worker-2" pill on the source session.

### 3.8 Scheduler tick loop

```rust
let mut tick = tokio::time::interval(Duration::from_secs(10));
tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
```

**`MissedTickBehavior::Skip` (Codex #6).** Default is `Burst` — on laptop wake from sleep, every missed 10s tick fires immediately, dispatching every schedule N times. v2 uses `Skip`: missed ticks are dropped; the next scheduled tick fires normally.

Three job kinds:

1. **`kind = 'tmux'`** — send `command` to `session`. Same as v2.
2. **`kind = 'shell'`** — `tokio::process::Command::new("/bin/bash").arg("-c").arg(&command)` with 600s timeout. Same as v2.
3. **`kind = 'boot'`** — **NEW**. Spawn a new session with `boot_dir`, `boot_provider`, `boot_worktree`, then send `command` as the initial prompt. This is the "spawn a `/cso` agent every Monday 9am" workflow.

**Boot job pre-flight (Eng failure-paths table).** Before creating a worktree for `kind='boot' boot_worktree=1`, check parent repo cleanliness via `git status --porcelain`; if dirty, write a `schedule_runs` row with `status='error', note='parent worktree dirty'` and skip the run (do NOT silently pollute the repo).

**Idempotency keys (Codex #6).** Each dispatch inserts a row into `schedule_run_keys (schedule_id, scheduled_for_ts)` BEFORE running. PRIMARY KEY = unique; if INSERT fails with UNIQUE, the schedule already fired for this `scheduled_for_ts` — skip. This prevents double-fire on restart.

**Missed-tick catch-up policy (Eng failure-paths table).** When the tick runs:
- `SELECT * FROM schedules WHERE deleted IS NULL AND enabled=1 AND next_run <= now`
- For each: if `now - next_run > 60s` → log `schedule_runs(status='skipped', note='missed window')` and ADVANCE `next_run` (don't fire). Otherwise fire normally.

**`next_run` recomputation (Eng failure-paths table).** Distinct semantics:
- 5-field cron expressions: `next_run = Schedule::upcoming(Utc).next()` — wall-clock aligned.
- "every Nm" / "every Nh": `next_run = last_run + N*unit` — interval anchored to last fire (drifts intentionally; user expectation per `in 5m` semantics).
- "every weekday at HH:MM" / "daily at HH:MM" / "every <day> at HH:MM": wall-clock aligned via cron expression conversion.

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
| `sessions::steering::deliver_loop` | 60s per session | dequeue steering messages on status `waiting`/`idle` boundary; single-flight; transactional `SELECT id LIMIT 1 / DELETE WHERE id=?` for exactly-once delivery (Eng concurrency #3) |
| `db::audit_writer` | event-driven | drains `audit_log` ingest channel; batches inserts every 250ms |
| `sse::keepalive` | 10s | emit `{type:"ping"}` event |
| `db::maintenance` | 24h | VACUUM, prune `schedule_runs` >30 days, prune `audit_log` >90 days, prune `schedule_run_keys` >30 days |
| `state::cleanup_locks_map` | 1h | (defense in depth) sweep `session_locks` + `status_watch` + `hook_tokens` for entries with no matching `sessions` row; explicit cleanup happens in `sessions::delete` (Eng concurrency #5/#6) — this is the backstop |

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

**File**: `web/src/components/session-tile/tile.tsx`. **Lines**: ~280 LOC (bumped from 180 in v1 per CEO M11 amplification).

**Grid container**: CSS grid `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2` (8px gap per user-vision.md "small gap, ~4-8pt"; closer to 8 since touch grids look denser at 4px).

**Default state (idle in grid)**:
- Card width: 100% of grid cell, aspect ratio 4:3 (so 320×240 at the most common breakpoint).
- Border-radius: `12px` (`rounded-xl`).
- Background: `bg-card` (semantic token; light=white, dark=neutral-900). Border `1px solid` of `border` token.
- Inner padding: `12px` top, `0` bottom (the terminal-tail-preview butts the bottom edge).
- **Title row** (top, 32px tall): Claude chat description (`task_summary` field, falling back to session name) in `text-sm font-medium`, truncated. Status dot 8×8px on the right. Token count + branch in `text-xs text-muted-foreground` underneath (16px tall).
- **Terminal tail preview** (bottom, fills remaining ~150px): rendered from `s.preview_lines: string[]` which is delivered via the SSE `sessions` event payload (deltas only — see §3.6 hero data flow). The element is `<motion.div layout>` so when `preview_lines` updates the new lines slide up smoothly (no scroll jump, no flicker). CSS-only block, `font-mono text-[10.5px] leading-[14px] text-zinc-700 dark:text-zinc-300`. ANSI already stripped server-side. Top-fade mask: `mask-image: linear-gradient(to bottom, transparent 0%, black 24px)`. Last 6 lines visible, anchored to bottom; expands to 14 on hover (next state).

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
- **Long-press** (350ms via `useLongPress`): opens a "quick-peek" modal showing the **REAL live-streaming** LiveTerminal in a read-only embed (NOT a static peek). Half-sheet via Vaul, current session, no input. Close = X or backdrop tap. Reuses `useLiveTerm` hook — establishes a real WS subscription, tears down on close.

**Skeleton state** (initial load, before SSE delivers first sessions list):
- Tile shape with shimmer overlay; renders for ≤200ms in practice. Suppresses layout shift.

**Error state** (tmux session missing for this row):
- Border-red-300, title prefix `(missing)`, click goes to a quick-recovery sheet offering "Reattach" or "Delete from supermux."

**Reduce Motion** (`prefers-reduced-motion: reduce`):
- Disables hover-scale, pulse animations, and the layout-morph on preview updates.
- Replaces with a 120ms cross-fade on status change and a static preview update (no slide).
- Active/Waiting "pulse" becomes a static colored border at full opacity.

**Layout-morph on preview update (CEO M11):** the `<TailPreview>` block uses `<motion.div layout transition={springs.smooth}>` so new lines slide up rather than jump-cutting. Implementation note: ANSI is already stripped server-side; only line additions/removals trigger layout — text content updates in place via `key={lineHash}` to avoid full re-renders.

**Click**:
- `onClick={() => navigateMorph(`/focus/${s.name}`)}`. The route transition uses View Transitions API (Chromium-only enhancement; fallback = instant). The TileTransitionName is set via `style={{ viewTransitionName: 'session-' + s.name }}` so the tile morphs into the focus header. Note: morph correctness on canvas-backed xterm is limited — the focus terminal renders only after navigation completes, so the morph is title-row + container only (terminal area cross-fades in). Codex contradiction C is acknowledged: the morph is a smooth container resize, NOT a "canvas-to-canvas" pixel morph.

**Acceptance** (per `termius-ios-native-spec.md`):
- Spring values match Termius §SwiftUI spring presets §Recommended values.
- Tap-press scale = 0.96, 100ms ease-out (see #1 of acceptance criteria).
- Hit target ≥44pt on mobile.
- Hover-peek expands tail from 6 → 14 lines within one spring frame (16ms).
- Long-press on mobile opens a real live-streaming embed (real LiveTerminal, not screenshot).
- Skeleton loader shows during initial load until SSE delivers the first sessions list (≤200ms target).
- Tile re-renders cleanly when `preview_lines` updates mid-hover (no flicker, no scroll jump).
- Reduce Motion disables hover-scale and pulse; replaces with crossfade.

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
- **Drag-down past peek** = dismiss the sheet entirely → return to overview (CEO M15 amplification — v1 only specified "shrinks to peek detent" without onward semantics).
- **Drag indicator**: 36×5 px, `bg-muted-foreground/30`, 2.5px radius, 6px from top. Auto-shown by Vaul.
- **Top bar** (44px + safe-area-top): chevron-back (left edge), session title (truncating), `···` overflow (right).
- **Terminal**: middle, fills available height between top bar and dock.
- **Bottom dock** (56pt + safe-area-bottom): see §4.4.1.
- **Accessory bar** (above keyboard, 44pt): see §4.4.2.

**Edge-swipe gestures (CEO M15 amplification, matches user-vision.md "Gestures")**:
- **Edge-swipe-right** (from left edge, ≥40px inward, velocity ≥800 px/s): `navigate('/')` — back to overview.
- **Edge-swipe-left** (from right edge): next session in pinned-then-active order. Pre-renders the next session's title + status dot during the drag (peek-of-next), springs back if released before 40% threshold, snaps with `springs.sheetDetent` if past threshold.

**iOS Safari haptics caveat (Codex #14, #17).** `navigator.vibrate` is **unavailable on iOS Safari** — this means the "haptic on chip press / status morph" spec is a NO-OP on the primary mobile target. v3.0 strategy:
- All `navigator.vibrate(...)` calls remain in code, gated by `if ('vibrate' in navigator)` — Android Chrome users get the feedback.
- iOS users get a CSS-only equivalent: each haptic point ALSO triggers a 60ms `scale: 0.96 → 1.0` micro-press on the target element via Framer Motion. This provides visible-without-sound feedback.
- True iOS haptics are a Capacitor wrap concern (`HapticsImpactFeedback`) and are deferred to v3.1 / native shell.
- Documented in M16/M17 acceptance criteria.

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

#### 4.4.3 Desktop dock (CEO M14 amplification — pixel spec)

Desktop dock lives at the bottom of `<DesktopFocus>`, height 56px (mirrors mobile dock height for muscle-memory). Same `bg-card` + 1px top border treatment.

```
┌──[⌘K Palette]──[/ Slash]──[+ Snippets]──┃──[Esc][Tab][^C][^U]──┃──[Detach ⌘D]──[Stop ⌘W]──┐
│      left cluster (3 icon buttons)        editable 4-chip send-row   right cluster (2 buttons)│
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Layout:
- **Left cluster** (24px gap from left edge):
  - **⌘K palette trigger** — 36×36 icon-button (lucide `Command`), opens command palette (a future v3.1 surface; v3.0: stub that shows "Press ⌘K to focus search").
  - **/ Slash menu launcher** — 36×36 icon-button (lucide `Slash`). Click = open the slash menu (same component as M18).
  - **+ Snippet drawer toggle** — 36×36 icon-button (lucide `Plus`). Click = open snippet panel as a Vaul side-sheet on the right (320px wide).
- **Send-row** (center, 4 chips, 28px tall each, 6px gap): editable via gear icon at the end. Default: Esc / Tab / Ctrl-C / Ctrl-U. Tap = `sendKey(label)`. Hover shows tooltip with the underlying tmux key name.
- **Right cluster** (24px gap from right edge):
  - **Detach ⌘D** — 36×36 icon-button (lucide `Minimize2`), tooltip "Detach (⌘D)". Click = `navigate('/')`.
  - **Stop ⌘W** — 36×36 icon-button (lucide `Square`), tooltip "Stop session (⌘W)". Click = confirm + `POST /stop`.

Compact-tile peek-popover (CEO M14 amplification — for the session-strip on the left):
- Hover (≥300ms dwell) over a non-current compact tile in the 320px session strip → popover appears, left-anchored, 380×220px, showing the full 14-line tail preview from that session's `last_capture`. Same content as the overview hover, scaled down.
- Spring: `springs.cardExpand`. Dismiss on mouseleave or after 100ms of no motion away.

LOC: ~150 extra over the bare-dock placeholder in v1.

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
- `xterm.js` v5.5+ with `@xterm/addon-canvas` (desktop) or `@xterm/addon-dom` (Capacitor/iOS mobile) + `@xterm/addon-fit` + `@xterm/addon-web-links`.
- Theme uses CSS variables read at mount: `getComputedStyle(document.documentElement).getPropertyValue('--terminal-fg')`.
- **First-frame auth (v2 per TIER 0 #4 / Codex #7)**: connect WITHOUT `?_token=` in URL. On `onopen`, immediately send `JSON.stringify({type:"auth", token: window._SUPERMUX_AUTH_TOKEN})`. Wait for `{type:"auth_ok"}` text frame before considering the connection `live`. If we get a 1008 close instead, treat as permanent auth failure.
- Replay buffer arrives as the first binary message AFTER `auth_ok`; `term.write` handles it transparently.
- **Reconnect close-code semantics (v2 per Eng P1 #4 / CEO #6)**:
  - **1008** (auth/origin) and **4001** (explicit revocation): permanent — UI shows "Tap to retry" button.
  - **1011** (server error): exponential backoff (300ms × 2^n, cap 30s), max 6 attempts then permanent.
  - **1013** (subscriber too slow): NOT permanent. Close the WS, mark state `reconnecting`, but DO NOT auto-retry on a tight backoff. Instead, on the NEXT `visibilitychange → visible` event (≥2s debounce), silently reconnect (silent = no banner state change beyond the in-progress reconnecting state; on success, brief green checkmark per Termius spec). This handles the mobile-Safari-backgrounded case gracefully.
  - **All other closes** (1006 network, 1000 normal, etc.): exponential backoff with banner.
- **Jitter on day 1 (Eng P1 #5 + CEO #6 #9)**: backoff includes ±20% decorrelated jitter from the first retry, NOT "later." Formula: `delay = base * 2^attempt; jittered = delay/2 + random(delay)`. This avoids the reconnect-storm during Tailscale server-restart handoffs.
- **Mount/unmount cleanup (Eng test gaps)**: on hook teardown, `term.dispose()` AND `ws.close(1000, 'unmount')`. Vitest mount/unmount cycle test (100 iterations) asserts WS count returns to zero.

### 4.6 State management (Zustand)

```ts
// stores/ui-store.ts
export const useUI = create<UIStore>()(persist((set) => ({
  theme: 'dark',
  viewMode: 'tile' as 'tile' | 'list',
  dockOpen: true,
  setTheme: (t) => set({ theme: t }),
  setViewMode: (v) => set({ viewMode: v }),
}), { name: 'supermux-ui' }))

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
  "name": "supermux",
  "short_name": "supermux",
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
- **NO localStorage for auth-critical data** — keep using `window._SUPERMUX_AUTH_TOKEN` which Capacitor will inject via WebView script.
- **NO native browser features that Capacitor doesn't bridge** by default. Avoid `webkitDirectory`, `<a download>` without filename.
- **Always use `import.meta.env.BASE_URL`** for routing so Capacitor's `capacitor://localhost` origin works.
- **Vaul + Framer Motion both work fine in WKWebView** (verified by community).
- **xterm.js works in WKWebView** but Canvas addon performance is poorer than DOM; ship Canvas for desktop, DOM for mobile (or detect Capacitor and degrade).
- **Service worker**: disabled inside Capacitor (Capacitor handles caching natively). The PWA manifest is unused too.

### 4.11 Empty states (CEO #3 — required, not afterthought)

Every route must implement an empty state with: message (one short sentence, builder-to-builder voice — no "Oops!" no "Great!"), inline SVG illustration (no images, monochrome with `currentColor`), one primary CTA, and a spring-in animation using `springs.cardExpand`. Required for M11/M12/M19/M20/M21/M22 acceptance.

| Route | Message | Illustration | Primary CTA |
|---|---|---|---|
| **Overview** (no sessions) | "No agents yet. Boot your first one." | terminal-with-cursor SVG | "Boot first agent" → opens NewSessionSheet pre-filled with cwd + provider=claude |
| **Overview** (search no-match) | "No matches for `{query}`." | magnifier SVG | "Clear search" |
| **Board** (no issues) | "Your board is clear." | clipboard SVG | "Add an issue" → opens NewIssueDialog |
| **Files** (empty dir) | "Nothing here." | folder-empty SVG | "Go up" / drop-zone hint |
| **Scheduler** (no schedules) | "Nothing scheduled. supermux can boot agents, send commands, or run shell jobs on a timer." | clock-with-spark SVG | "New schedule" → opens NewScheduleDialog with three preset chips (boot, send, shell) |
| **Settings → Audit log** (no rows yet) | "No audit events yet." | document-clean SVG | (none) |

### 4.12 Loading + error states (CEO #3)

**Skeleton patterns:**
- Tile skeleton: tile shape (border, padding) with three pulse stripes for title/meta/preview lines. Visible only for ≤200ms on first SSE arrival.
- List skeleton: 8 rows of `bg-muted/40 h-8 rounded-md animate-pulse`.
- Board skeleton: 5 columns of 3 cards each.

**Error states:**
- **Backend unreachable** (TanStack Query throws after retry): full-page sheet with "Can't reach supermux-server. Last connected {relativeTime}. Retrying in {countdown}s." + manual "Retry now" button.
- **Session missing** (404 on `/api/sessions/{name}` in focus): redirect to `/?missing={name}` with toast "Session `{name}` no longer exists."
- **WS auth failed** (1008 after first-frame): "Authentication failed — refresh and re-enter." + "Refresh" button.

Spring values: `springs.cardExpand` for in, `springs.smooth` for out.

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
                                                          ├─ tmux new-session -d -s supermux-{name} ...
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
                └─ tmux send-keys -t supermux-name -l 'l'
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
- **AUTH_TOKEN in HTML body trade-off**: the token is rendered into the served HTML via `window._SUPERMUX_AUTH_TOKEN`. Acceptable risk because we bind only to `127.0.0.1` + Tailscale interface, and Tailscale provides device-level auth. Documented in CLAUDE.md.

### 6.2 Origin allowlist (WS)

- `localhost`, `127.0.0.1`, auto-detected LAN IP, `*.ts.net`.
- Other Origin → close 1008.

### 6.3 Path safety (files)

- Same blocklist as v2 §3.4 of feature-extract — `/etc/shadow`, `/etc/sudoers`, `/etc/ssh/*`, `/var/run/secrets/*`, home-relative `.ssh`/`.gnupg`/`.aws`/`.kube`/`.netrc`/`.npmrc`/`.docker`/`.config/gcloud`/`.config/gh`.
- All paths canonicalized via `PathBuf::canonicalize()` before the check.
- Optional jail param for session-scoped views (rooted at `CC_DIR`).

### 6.4 Audit log

- Schema and writing-routes list: see §3.3 (migration `0007_audit.sql`) and the "Which routes write `audit_log` rows" subsection.
- Every destructive HTTP call writes a row via the `db::audit_writer` task. Actor = `user` for HTTP, `scheduler` for tick, `agent:<name>` for cross-session calls.
- Visible in Settings → Audit Log (last 200 rows from `/api/audit?limit=200`; full export to JSON via "Download all").
- Audit values NEVER contain secrets (the `settings.env.patch` row's `detail` field includes which env var was changed, NOT its value).

### 6.5 Hook auth (v2 — per Eng P1 #3, Codex #4)

Separate from the dashboard bearer token. Per-session, narrow-scope.

- **Generation**: at `sessions::create` time, generate 32 random bytes (`OsRng`), base64url-encode, write to `session_runtime.hook_token`.
- **Injection**: the tmux session env gets `SUPERMUX_HOOK_TOKEN=<token>` AND `SUPERMUX_SESSION=<name>` AND `SUPERMUX_URL=<bind_url>`. Crucially, it does **NOT** get `SUPERMUX_TOKEN` (the dashboard bearer).
- **Validation**: `/api/_internal/hook` checks `X-Supermux-Hook-Token` header against `SELECT hook_token FROM session_runtime WHERE name = body.session`. Mismatch → 401. Token compares via `constant_time_eq`.
- **Scope**: a leaked hook token only grants the ability to surface hook events for ONE session. It cannot list sessions, read state, modify config, or anything else. Compare to v1's design where leaking a hook would leak the master dashboard token.
- **Rotation**: on session restart, generate a fresh hook token (avoid long-lived secrets in env). The `install_hooks()` writer re-writes settings.json with the new token.
- **Failure mode**: hook commands are `--max-time 1`, `|| true`, and `"blocking": false` so an unreachable or down supermux-server never blocks Claude tool execution (Eng + Codex).

---

## 7. Testing strategy

### 7.1 Backend (cargo test)

- **Unit tests** in each module (e.g. `sessions/status.rs` has 30+ golden-fixture tests).
- **Integration tests** in `server/tests/`:
  - `http_session.rs` — boot the Router with an in-memory SQLite pool, call via `axum::Router::oneshot`. Covers CRUD + auth.
  - `ws_pty.rs` — bind an ephemeral port, connect with `tokio-tungstenite`, verify first-frame auth + replay + bidirectional bytes + close codes.
  - `ws_first_frame_auth.rs` (v2) — verify a missing auth frame → close 1008 within 2s; verify malformed auth → 1008.
  - `board_claim.rs` — 100 concurrent `POST /claim` calls, exactly one 200, 99 409s; sets `busy_timeout=5000` PRAGMA + uses `BEGIN IMMEDIATE` to convert any `SQLITE_BUSY` into the 409 path, not 500s (Codex #1).
  - `status_detector.rs` — `insta::assert_snapshot!` over `tests/fixtures/status/*.txt`.
  - `status_detector_cold_start.rs` (v2) — simulate server restart, assert initial status = `Unknown` until either capture confirms OR pty bytes flow (Eng test gap).
  - `pty_recovery.rs` (v2) — kill tmux mid-stream, verify reader recovers within 5s without server restart (Eng test gap).
  - `subscriber_overflow_recovery.rs` (v2) — artificially slow a WS subscriber to overflow capacity, assert close 1013 + reconnect (on next visibility-visible) restores live stream within 3s (Eng test gap).
  - `wait_race.rs` (v2) — spawn 100 wait handlers and one detector tick; assert none get stuck for the wrong reason (Eng P0 #2 regression test).
  - `hook_auth_scope.rs` (v2) — assert that a leaked dashboard bearer cannot call `/api/_internal/hook` for any session; assert that a leaked hook_token of session A cannot mark session B (Eng P1 #3).
  - `scheduler.rs` — fake-clock test that a `recurring` cron triggers at the right tick.
  - `schedule_missed_tick.rs` (v2) — boot-time catch-up window 60s; older fires logged as `skipped`; `schedule_run_keys` UNIQUE prevents double-fire on restart (Eng test gap + Codex #6).
  - `stress_reconnect.rs` (v2) — spawn 50 SSE clients, kill the server, restart, verify all reconnect within 30s without sqlx pool exhaustion errors (Eng test gap).
  - `migration_dataset.rs` (v2) — round-trip a real v2 dataset through `migrate-v2.py`, then read every v3 endpoint and assert no 500s (Eng test gap + Codex #18).
- **Property tests** (proptest, **required** — v1 said "optional"): `path_safe::resolve_safe` never escapes its jail under random Unicode-normalization + `..`-stacks + symlink fixtures (Codex #3).

### 7.2 Frontend (Vitest + Playwright)

- **Vitest** (unit): pure-function utils (`ansi.ts`, `keys.ts`, `format.ts`); reducer-like hooks (`use-live-term` with a mocked WebSocket). **Required**: `use-live-term` mount/unmount cycle test (100 iterations) asserts terminal disposal + WS count returns to zero (Eng test gap — memory-leak gate for Cmd+1..9 rapid switching).
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
echo "binary: server/target/release/supermux-server ($(du -h server/target/release/supermux-server | cut -f1))"
```

### 8.2 Deploy

`scripts/deploy.sh` ships a pinned `git archive` of a clean commit to a host,
builds natively there, installs `/usr/local/bin/supermux-server` and the
systemd unit, and starts the service. It is configured entirely via
environment variables (or a gitignored `.env` — see `.env.example`):
`SUPERMUX_DEPLOY_HOST`, `SUPERMUX_SERVICE_USER`, `SUPERMUX_DATA_DIR`,
`SUPERMUX_INTERNAL_PORT`, and optionally `SUPERMUX_USE_TAILSCALE` /
`SUPERMUX_PUBLIC_PORT`.

### 8.3 systemd unit

The committed unit at `etc/systemd/supermux.service` is a template — `deploy.sh`
substitutes `__SERVICE_USER__` and `__DATA_DIR__` at install time. The service
runs as an unprivileged account, binds a loopback port, and applies a full set
of systemd sandboxing directives (see the unit file for the rationale of each).

### 8.4 TLS termination

The backend speaks plain HTTP on a loopback port. Terminate TLS in front of it
one of two ways:

- **Reverse proxy** — nginx or Caddy proxying to `http://localhost:<port>`.
- **`tailscale serve`** — if the host is on a tailnet; `deploy.sh` does this for
  you when `SUPERMUX_USE_TAILSCALE=1`.

A separate data directory and a distinct port make it straightforward to run
supermux alongside any other service on the same host.

---

## 9. Migration from amux

`scripts/migrate-v2.py` reads an existing amux install and writes into the
supermux SQLite DB. One-shot, idempotent, dry-runnable.

**Column-explicit copies (NO `SELECT *`).** The amux and supermux schemas drift
(supermux has `created_at`, `task_summary`, `cc_session_name`, `last_capture`,
`hook_token`; amux has columns supermux drops). `SELECT *` would either fail or
silently insert NULLs. Columns are named explicitly on both sides; the dry-run
asserts table-info compatibility before any write.

```python
# pseudo
import sqlite3, json, glob, os, pathlib, secrets, time
src = pathlib.Path.home() / '.amux'
dst_db = pathlib.Path.home() / '.supermux' / 'data.db'

con = sqlite3.connect(dst_db)
cur = con.cursor()

# Dry-run sanity: assert v3 expected columns are a strict superset (or close to it) of v2's
# and report drift before any write.

# 1. sessions: read each .env + .meta.json, INSERT INTO sessions
for env_file in (src / 'sessions').glob('*.env'):
    name = env_file.stem
    env = parse_env(env_file)
    meta = json.load(open(src / 'sessions' / f'{name}.meta.json'))
    cur.execute(
        """INSERT OR IGNORE INTO sessions
           (name, dir, desc, provider, flags, pinned, archived, auto_continue,
            tags, creator, branch, worktree, worktree_repo, mcp, created_at,
            start_count, last_started, last_send, last_send_text, task_summary,
            cc_session_name, cc_conversation_id, codex_session_id, start_error,
            auto_continue_msg, rate_limit_resume_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (...,)
    )
    # Backfill session_runtime with a generated hook_token (v3-only column)
    cur.execute(
        "INSERT OR IGNORE INTO session_runtime (name, hook_token) VALUES (?, ?)",
        (name, secrets.token_urlsafe(32))
    )

# 2. board: open v2's data.db, ATTACH it, copy issues/issue_tags/issue_counters/statuses
#    with explicit column lists
cur.execute("ATTACH DATABASE ? AS old", (str(src / 'data.db'),))
cur.execute("""INSERT OR IGNORE INTO issues
                  (id, title, desc, status, session, creator, due, due_time,
                   created, updated, deleted, owner_type, pinned, pos, notified)
               SELECT id, title, desc, status, session, creator, due, due_time,
                      created, updated, deleted, owner_type, pinned, pos, notified
               FROM old.issues""")
# ... similar for issue_tags, issue_counters, statuses, schedules, schedule_runs, skills, prefs

# (skip v2-only columns like gcal_event_id; do not let SELECT * paper over the difference)

con.commit()
print(f"migrated {sessions} sessions, {issues} issues, {schedules} schedules")
```

**Memory + log files**: stay in their v2 locations (don't move). v3 has its own logs in `~/.supermux/logs/`.


---

---

## 12. Risks + mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | tmux behaves differently on Linux vs macOS — `pipe-pane` quirks, `send-keys -l` quoting | CI runs against tmux 3.4 on Linux; integration test in `tests/lifecycle.rs` running real tmux is mandatory before any tmux-touching merge |
| 2 | xterm.js perf with many concurrent terminals (focus-mode strip has ≤320px-wide tiles potentially showing live previews) | Keep tiles read-only/sampled (peek every 2s via SSE delta), NOT live xterm instances; only the focused session uses xterm |
| 3 | Vaul iOS Safari quirks (sheet flicker on rubber-band, keyboard pushing content) | Use Vaul ≥1.0; explicit `interactsWithModal` config; test against iOS 17, 18, 26 in CI via Playwright webkit |
| 4 | View Transitions API only in Chromium → degraded look in Safari | Fallback to instant navigate is acceptable; revisit when WebKit ships (in progress as of 2026) |
| 5 | Status detector regex bank breaks on next Claude UI revision | Settings hooks + heartbeat are the primary signals; regex bank is fallback. Golden fixtures + snapshot tests catch regressions in CI |
| 6 | WebSocket-over-HTTP/2 forbidden — Tailscale serve may force h2 → WS upgrade fails | Backend listens on raw TCP for WS (separate port if needed); frontend reads `window._SUPERMUX_SERVER_PORT` injected into HTML |
| 7 | sqlx compile-time-checked queries require live DB at build time → CI flakiness | Use `cargo sqlx prepare` to write `.sqlx/query-*.json` files into the repo; CI runs offline mode |
| 8 | Vite + Tailwind v4 still has rough edges (e.g. dynamic class names) | Use the official `@tailwindcss/vite` plugin; avoid dynamic class concatenation, prefer `cva` (class-variance-authority) |
| 9 | Reconnect storm if many tabs open and network blips | Exponential backoff with **decorrelated jitter ±20% from day 1** (NOT "later" as v1 said) per Eng P1 #5 / CEO #9; per-tab BroadcastChannel coalescing deferred to v3.1 |
| 10 | Auth token leak via inline HTML body → exposed if attacker can read the served page | Bind only to localhost + Tailscale interface; Tailscale already device-authenticated; SW cache for HTML INVALIDATED on token rotation (M23b); documented limitation |
| 11 | FIFO open ordering + tokio blocking semantics (Eng P0 #1) | §3.2.7 v2: `O_RDONLY \| O_NONBLOCK` + `AsyncFd` + keep-alive write fd; integration test `pty_recovery.rs` verifies kill-tmux-mid-stream recovery |
| 12 | Tmux spawn rate scales linearly with sessions × tasks/sec; at 50+ sessions the box becomes fork-bound (Eng P2 #7 + Codex #23) | v3.0: skip capture-pane when pty bytes flowed in last 2s + last_status=Active. v3.1 evolution: migrate to `tmux -C` control mode (one persistent connection per session, parsed output stream) |
| 13 | Tile-tail-preview hero moment depends on data flow added in v2 schema (CEO #1) | `session_runtime.last_capture` + `SessionSummary.preview_lines` + SSE delta payload, all landed in M1+M2, exercised in M11 |
| 14 | iOS Safari haptics are silently no-op (Codex #14, #17) | Documented in §4.4. iOS gets CSS-only scale-press feedback; true iOS haptics deferred to Capacitor v3.1 |
| 15 | `sqlx prepare` metadata drift between local and CI (Eng P2 #6) | M0 setup includes `pre-commit` hook running `cargo sqlx prepare --check`; CI pins `sqlx-cli` version to match the `sqlx` crate dep |
| 16 | Scheduler drift after laptop sleep / GC pause (Codex #6) | §3.8 v2: `MissedTickBehavior::Skip` + `schedule_run_keys` idempotency + 60s catch-up window policy |

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
- Workspace forking + sharing UI: `share_tokens` table exists for v3.1 forward-compat, but **NO HTTP handlers ship in v3.0** (Eng API surface clarity). The schema is dormant infrastructure.
- Mermaid + LaTeX rendering in chat (no chat in v3.0; chat is the tmux pane).
- Custom syntax/colorblind themes (just dark + light).

---

## Appendix A — Quick reference: repository files

```
supermux/
├── ARCHITECTURE.md                                            ← this file
├── README.md
├── LICENSE
├── etc/systemd/supermux.service                               ← systemd unit template
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
├── server/migrations/{0001_init,0002_board,0003_schedules,0004_runtime_state,0005_delegations,0007_audit}.sql
├── server/tests/{auth,http_session,ws_pty,ws_first_frame_auth,board_claim,status_detector,status_detector_cold_start,pty_recovery,subscriber_overflow_recovery,wait_race,hook_auth_scope,scheduler,schedule_missed_tick,stress_reconnect,migration_dataset,files,path_safe_proptest,lifecycle}.rs
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

