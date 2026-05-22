//! amux-v3 server entry point (TECH_PLAN §3.2.1).
//!
//! M1 startup sequence: init tracing, load config (creating `~/.amux-v3` and the
//! mode-0o600 `auth_token`), open the SQLite pool + run migrations, build the
//! router with auth on `/api/*`, and serve. TLS bind, background tasks, and
//! session reattach join in later milestones. Module definitions live in
//! `lib.rs` so the binary and integration tests share them.

use amux_server::{config, db, http, scheduler, sessions, state};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = config::load()?;
    let pool = db::init(&config).await?;
    let bind = config.bind;

    let state = state::AppState::new(pool, config);

    // Background tasks (§3.9). M8 adds the scheduler tick.
    scheduler::spawn(state.clone());
    // M5a: resume per-session status detection on boot (cold-start init §3.2.8).
    sessions::auto_actions::spawn_all(&state).await;
    // M9: resume per-session steering delivery on boot (§3.9 deliver loop).
    sessions::steering::deliver_loop::spawn_all(&state).await;

    let app = http::router(state);

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("amux-v3 listening on http://{bind}");

    axum::serve(listener, app).await?;
    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).init();
}
