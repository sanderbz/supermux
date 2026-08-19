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

    // NATIVE (tmux-less) session runtime: the pty holder. The daemon spawns
    // THIS binary as `pty-holder …` for every native session; the holder owns
    // the pty master, spools raw output to disk and serves one daemon
    // connection over a unix socket. Because the unit uses `KillMode=process`,
    // a deploy restarts only the daemon — holders (and the agents inside them)
    // survive, and the new daemon reconnects + replays the spool. Dispatched
    // here, alongside `__edit` and before any server boot, so the holder
    // process stays lean: no config, no DB, no listener.
    if std::env::args().nth(1).as_deref() == Some("pty-holder") {
        init_tracing();
        return sessions::native::holder::main(std::env::args().skip(2)).await;
    }

    // Operator maintenance: sweep leaked `claude-swarm-*` agent-team tmux
    // servers once and exit. `--dry-run` reports without killing anything.
    // Needs no DB and no listener; `--help`-less by convention (see pty-holder).
    if std::env::args().nth(1).as_deref() == Some("swarm-reaper") {
        init_tracing();
        return sessions::swarm::cli(std::env::args().skip(2)).await;
    }

    init_tracing();

    // Drop the agent-nesting markers this process INHERITED before anything can
    // spawn. Start supermux from inside a Claude Code pane (routine when an
    // agent deploys or dogfoods the server) and its environ carries
    // `CLAUDE_CODE_CHILD_SESSION=1` / `CLAUDECODE=1` / `CLAUDE_CODE_SESSION_ID`;
    // `Command::envs` ADDS to the parent environment, so every pane we spawn
    // would inherit them, every `claude` in one would treat itself as a nested
    // child, and transcript saving — the whole chat plane's only data source —
    // would be off with a one-line warning nobody reads. See
    // `sessions::lifecycle::AGENT_NESTING_ENV`. First thing after tracing so the
    // scrub precedes the tmux server, every holder, and the reconcile.
    let scrubbed = sessions::lifecycle::scrub_inherited_agent_env();
    if !scrubbed.is_empty() {
        tracing::warn!(
            vars = ?scrubbed,
            "supermux was started from inside an agent session; dropped its nesting markers \
             so spawned panes get a clean environment (transcript saving would otherwise be off)",
        );
    }

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
    // POST-UPDATE ATTACH AUDIT — snapshot FIRST. Every update restarts this
    // daemon while its `setsid`-detached holders keep running, and the promise
    // is that each one is picked back up. `reconcile_on_boot` below rewrites
    // `last_status` to `stopped` for everything it finds dead, which destroys
    // the evidence of what was running at shutdown — so the audit's target list
    // has to be taken before it, and judged (once, ~20s in) after the pumps
    // have had time to attach.
    let audit_targets = sessions::auto_actions::snapshot_for_audit(&state).await;

    sessions::auto_actions::reconcile_on_boot(&state).await;

    // Background tasks. The scheduler tick runs here.
    scheduler::spawn(state.clone());
    // Resume per-session status detection on boot (cold-start init).
    sessions::auto_actions::spawn_all(&state).await;
    // Resume per-session steering delivery on boot.
    sessions::steering::deliver_loop::spawn_all(&state).await;
    // One-shot audit: ~20s from now, prove every session that was running at
    // shutdown is attached again — auto-healing (and always logging a summary
    // line) for the ones that are not. Runs after `spawn_all` so the detector
    // loops and their pumps are already dialling.
    sessions::auto_actions::spawn_post_update_audit(&state, audit_targets);
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
    // Reap leaked Claude agent-team tmux servers (claude-swarm-<pid> sockets).
    // First tick is immediate: also the boot sweep after a crash or OOM kill.
    sessions::swarm::spawn_reaper(state.clone());

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
