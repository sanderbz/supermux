//! supermux server entry point (TECH_PLAN §3.2.1).
//!
//! M1 startup sequence: init tracing, load config (creating `~/.supermux` and the
//! mode-0o600 `auth_token`), open the SQLite pool + run migrations, build the
//! router with auth on `/api/*`, and serve. TLS bind, background tasks, and
//! session reattach join in later milestones. Module definitions live in
//! `lib.rs` so the binary and integration tests share them.

use supermux_server::{agents, config, db, http, log_redact, scheduler, sessions, state, teams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = config::load()?;

    // Session survival across restarts/deploys (§3.5). tmux keeps its control
    // socket under $TMUX_TMPDIR (default `/tmp`). Under the systemd hardening
    // `PrivateTmp=true`, `/tmp` is recreated fresh on every (re)start, so a new
    // instance cannot reach the PREVIOUS tmux server — every session would read
    // `stopped` even though `KillMode=process` kept it alive. Anchor the socket
    // in the PERSISTENT data dir instead so the server reconnects to the same
    // tmux server (and thus the same live sessions) across restarts. Must run
    // BEFORE any tmux call (reconcile_on_boot below). Honor an operator-set
    // TMUX_TMPDIR if present.
    let tmux_dir = std::env::var_os("TMUX_TMPDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| config.data_dir.join("tmux"));
    match std::fs::create_dir_all(&tmux_dir) {
        // Set it unconditionally so every tmux child inherits the same persistent
        // socket dir, whether it came from the unit's Environment or this default.
        Ok(()) => std::env::set_var("TMUX_TMPDIR", &tmux_dir),
        Err(e) => tracing::warn!(
            tmux_dir = %tmux_dir.display(),
            error = %e,
            "could not create persistent TMUX_TMPDIR — sessions may not survive restarts",
        ),
    }

    let pool = db::init(&config).await?;
    let bind = config.bind;

    let state = state::AppState::new(pool, config);

    // Reconcile every persisted session's status against tmux reality BEFORE
    // serving: a server restart (or a machine reboot, which wipes all tmux
    // sessions) leaves stale `active`/`idle` rows that would render dead
    // sessions as healthy. Forcing tmux-less sessions to `stopped` here makes
    // the overview correct from the first paint.
    sessions::auto_actions::reconcile_on_boot(&state).await;

    // Background tasks (§3.9). M8 adds the scheduler tick.
    scheduler::spawn(state.clone());
    // M5a: resume per-session status detection on boot (cold-start init §3.2.8).
    sessions::auto_actions::spawn_all(&state).await;
    // M9: resume per-session steering delivery on boot (§3.9 deliver loop).
    sessions::steering::deliver_loop::spawn_all(&state).await;
    // AT-B (§3.2): file-driven Agent-Teams detector. Watches `~/.claude/teams`
    // (+ slow safety poll), re-validates teammate `%id`s each tick, broadcasts
    // the team snapshot over SSE. Cheap no-op while no team files exist.
    teams::spawn(state.clone());
    // AB3 (board-integration §C.2): auto-install supermux-managed commands (e.g.
    // `/supermux-task`) into the service user's `~/.claude/commands/` so the
    // agent's board-write surface is present with no manual step. Idempotent +
    // non-clobbering (preserves a co-located user command of the same name).
    agents::skills::seed_managed_commands().await;

    let app = http::router(state);

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("supermux listening on http://{bind}");

    axum::serve(listener, app).await?;
    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // §3.4 (Codex #24): the redaction layer is installed BEFORE the formatter so
    // an Authorization/Cookie header or a `?_token=` query never reaches the
    // log output in clear — defense-in-depth ahead of any future TraceLayer.
    tracing_subscriber::registry()
        .with(filter)
        .with(log_redact::RedactionLayer)
        .with(fmt::layer())
        .init();
}
