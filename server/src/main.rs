//! supermux server entry point.
//!
//! Startup sequence: init tracing, load config (creating `~/.supermux` and the
//! mode-0o600 `auth_token`), open the SQLite pool + run migrations, build the
//! router with auth on `/api/*`, and serve. TLS bind, background tasks, and
//! session reattach join in later milestones. Module definitions live in
//! `lib.rs` so the binary and integration tests share them.

use supermux_server::{
    agents, config, db, external_edit, http, scheduler, sessions, state, teams,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // "Edit in native editor" bridge. When Claude's
    // built-in Ctrl+G spawns `$EDITOR`, supermux points `$EDITOR` at THIS binary's
    // hidden `__edit` subcommand: it relays Claude's input buffer to a browser
    // editor sheet and writes the edited text back. Checked BEFORE init_tracing /
    // the server boot so the bridge process stays lean (no DB, no listener) and
    // exits cleanly. The temp-file path is the last argv after `__edit`.
    if std::env::args().nth(1).as_deref() == Some("__edit") {
        return external_edit::run_bridge(std::env::args().nth(2)).await;
    }

    init_tracing();

    let config = config::load()?;

    // Install the `$EDITOR` bridge wrapper (`<data_dir>/bin/supermux-edit`) that
    // `sessions::lifecycle` exports into each pane. Idempotent; a failure here only
    // disables the edit-in-native-editor affordance (logged), never the server.
    external_edit::install_bridge_script(&config.data_dir);

    // Session survival across restarts/deploys. tmux keeps its control
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

    // Background tasks. The scheduler tick runs here.
    scheduler::spawn(state.clone());
    // Resume per-session status detection on boot (cold-start init).
    sessions::auto_actions::spawn_all(&state).await;
    // Resume per-session steering delivery on boot.
    sessions::steering::deliver_loop::spawn_all(&state).await;
    // File-driven Agent-Teams detector. Watches `~/.claude/teams`
    // (+ slow safety poll), re-validates teammate `%id`s each tick, broadcasts
    // the team snapshot over SSE. Cheap no-op while no team files exist.
    teams::spawn(state.clone());
    // Auto-install supermux-managed commands (e.g.
    // `/supermux-task`) into the service user's `~/.claude/commands/` so the
    // agent's board-write surface is present with no manual step. Idempotent +
    // non-clobbering (preserves a co-located user command of the same name).
    agents::skills::seed_managed_commands().await;
    // Start the HostPool reaper. Sweeps every 60s,
    // tears down SSH ControlMasters that have been idle > 10min AND have no
    // live session row pointing at them. Cheap no-op while no remote hosts
    // are registered.
    sessions::spawn_reaper(state.host_pool.clone());

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
    // (No tracing-layer-based redaction: callers must wrap sensitive values with log_redact::redact() before logging. Audited and reviewed.)
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .init();
}
