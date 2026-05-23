//! supermux server entry point (TECH_PLAN §3.2.1).
//!
//! M1 startup sequence: init tracing, load config (creating `~/.supermux` and the
//! mode-0o600 `auth_token`), open the SQLite pool + run migrations, build the
//! router with auth on `/api/*`, and serve. TLS bind, background tasks, and
//! session reattach join in later milestones. Module definitions live in
//! `lib.rs` so the binary and integration tests share them.

use supermux_server::{agents, config, db, http, log_redact, scheduler, sessions, state};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = config::load()?;
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
