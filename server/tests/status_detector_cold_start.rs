//! Cold-start init + `last_capture` writeback for the detector loop (M5a).
//!
//! Two acceptance criteria from §10 / §3.2.8 / §3.6:
//!   * After a server restart, detectors initialise with the PTY heartbeat at
//!     `now − 5min` so the FIRST tick reads `Unknown` (never a spurious `Active`
//!     off a defaulted "now"), and flips to `Active` only once a real byte flows.
//!   * `session_runtime.last_capture` is updated EVERY detector tick — it is the
//!     canonical source for `SessionView.preview_lines` (CEO #1).
//!
//! The cold-start semantics are tested deterministically against `AppState` +
//! `StatusDetector` (no tmux needed). The writeback is an integration test
//! against a real tmux `shell` session (skipped when tmux is absent).

use std::time::{Duration, Instant};

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::sessions::auto_actions;
use supermux_server::sessions::status::{StatusDetector, TurnState};
use supermux_server::state::AppState;
use supermux_server::{db, sessions};

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

async fn test_state() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-status-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: "secret-test-token-status".to_string(),
        provider_defaults: ProviderDefaults::default(),
        // M4 added the required `ws` block after M5a branched; default it so the
        // M5a cold-start test compiles against the merged `Config`.
        ws: WsConfig::default(),
        remote_callback_url: None,
            push_sub: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

#[tokio::test]
async fn cold_start_heartbeat_is_five_minutes_ago() {
    let (state, dir) = test_state().await;

    // With no live reader (M4 absent), the heartbeat reads as the cold-start
    // sentinel: ~5 minutes ago.
    let elapsed = state.last_pty("never-seen").elapsed();
    assert!(
        elapsed >= Duration::from_secs(295) && elapsed <= Duration::from_secs(310),
        "cold-start heartbeat should be ~5min ago, was {elapsed:?}"
    );

    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn cold_start_first_tick_is_unknown_then_active_on_byte() {
    let (state, dir) = test_state().await;
    let mut detector = StatusDetector::new();

    // First tick: empty capture + cold heartbeat + never-classified → Unknown
    // (the idle timeout must NOT fabricate Idle off the cold sentinel).
    let first = detector.detect("", state.last_pty("alpha"), TurnState::default(), false);
    assert_eq!(first.as_str(), "unknown", "cold-start first tick must be Unknown");

    // A real PTY byte arrives (what M4's reader will record): → Active. No hooks
    // wired for this session, so the heartbeat heuristic is the liveness signal.
    state.pty_heartbeat.insert("alpha".to_string(), Instant::now());
    let second = detector.detect("", state.last_pty("alpha"), TurnState::default(), false);
    assert_eq!(second.as_str(), "active", "fresh PTY byte must read Active");

    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn tick_on_unstarted_session_leaves_status_unknown() {
    // A session that has a row but no running tmux: the tick cannot capture, so
    // it leaves the status at its default `unknown` (API renders 'stopped').
    let (state, dir) = test_state().await;
    db::sessions::insert_minimal(&state.pool, "ghost", "/tmp", "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, "ghost", "tok").await.unwrap();

    let mut detector = StatusDetector::new();
    // M5b: `tick` now carries the cross-tick preview-tail memo (last broadcast
    // tail) for the SSE "status OR tail6 changed" rule, plus the last-capture
    // time that bounds the capture-skip optimization.
    let mut tail = None;
    let mut last_capture_at = Instant::now();
    auto_actions::tick(&state, "ghost", &mut detector, &mut tail, &mut last_capture_at)
        .await
        .unwrap();

    let rt = db::sessions::runtime(&state.pool, "ghost").await.unwrap().unwrap();
    assert_eq!(rt.last_status, "unknown", "unstarted session stays Unknown");

    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn detector_tick_writes_last_capture() {
    if !tmux_available() {
        eprintln!("skipping detector_tick_writes_last_capture: tmux not on PATH");
        return;
    }
    let (state, dir) = test_state().await;
    let name = format!("st{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    // Insert the session row directly (bypassing sessions::create so no extra
    // background loop competes with the manual tick below), then start its tmux.
    db::sessions::insert_minimal(&state.pool, &name, "/tmp", "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, &name, "tok").await.unwrap();
    sessions::lifecycle::start(&state, &name, None).await.unwrap();

    // Produce identifiable scrollback.
    let marker = "DETECTORHEARTBEAT42";
    sessions::lifecycle::send_text(&state, &name, &format!("echo {marker}"))
        .await
        .unwrap();

    // Run ticks until the marker shows up in last_capture (acceptance: written
    // every tick, canonical preview source).
    let mut detector = StatusDetector::new();
    let mut tail = None;
    // Seed "stale" so the first manual tick always captures (the loop seeds it
    // the same way).
    let mut last_capture_at = Instant::now()
        - supermux_server::sessions::status::MAX_PREVIEW_STALENESS;
    let mut captured = String::new();
    for _ in 0..24 {
        auto_actions::tick(&state, &name, &mut detector, &mut tail, &mut last_capture_at)
            .await
            .unwrap();
        let rt = db::sessions::runtime(&state.pool, &name).await.unwrap().unwrap();
        captured = rt.last_capture;
        if captured.contains(marker) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(
        captured.contains(marker),
        "last_capture should carry the freshest pane content; got:\n{captured}"
    );

    // Hero data flow: the API derives preview_lines from last_capture.
    let view = sessions::get(&state, &name).await.unwrap();
    assert!(
        view.preview_lines.iter().any(|l| l.contains(marker)),
        "preview_lines should reflect last_capture; got: {:?}",
        view.preview_lines
    );

    // Teardown.
    let _ = sessions::delete(&state, &name).await;
    let _ = std::process::Command::new("tmux")
        .args(["kill-session", "-t", &format!("supermux-{name}")])
        .output();
    std::fs::remove_dir_all(dir).ok();
}

/// Startup reconciliation: a DB session whose `supermux-<name>` tmux pane does
/// not exist must have its persisted status forced to `stopped` on boot — a
/// server restart / machine reboot wipes tmux, so a stale `active` row would
/// otherwise render a dead session as healthy. No tmux pane is ever created
/// here, so the reconcile must flip the row regardless of whether tmux is
/// installed.
#[tokio::test]
async fn reconcile_on_boot_marks_tmux_less_sessions_stopped() {
    let (state, dir) = test_state().await;

    // A session that was `active` before the (simulated) restart, but whose
    // tmux pane does not exist now — a unique name guarantees no stray pane.
    let name = format!("rec{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    db::sessions::insert_minimal(&state.pool, &name, "/tmp", "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, &name, "tok").await.unwrap();
    db::sessions::set_last_status(&state.pool, &name, "active").await.unwrap();

    // Sanity: the stale row reads `active` before reconciliation.
    let before = db::sessions::runtime(&state.pool, &name).await.unwrap().unwrap();
    assert_eq!(before.last_status, "active", "precondition: stale active row");

    // Boot reconciliation: tmux pane is absent → status must flip to `stopped`.
    auto_actions::reconcile_on_boot(&state).await;

    let after = db::sessions::runtime(&state.pool, &name).await.unwrap().unwrap();
    assert_eq!(
        after.last_status, "stopped",
        "a session with no tmux pane must reconcile to stopped on boot"
    );

    // The session row itself is NOT deleted — a stopped session stays resumable.
    assert!(
        db::sessions::get(&state.pool, &name).await.unwrap().is_some(),
        "reconcile must not delete the session row (stopped sessions stay resumable)"
    );

    std::fs::remove_dir_all(dir).ok();
}
