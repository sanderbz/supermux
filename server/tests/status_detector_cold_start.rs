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

use amux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use amux_server::sessions::auto_actions;
use amux_server::sessions::status::StatusDetector;
use amux_server::state::AppState;
use amux_server::{db, sessions};

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

async fn test_state() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("amux-status-test-{}", uuid::Uuid::new_v4()));
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
    let first = detector.detect("", state.last_pty("alpha"), None);
    assert_eq!(first.as_str(), "unknown", "cold-start first tick must be Unknown");

    // A real PTY byte arrives (what M4's reader will record): → Active.
    state.pty_heartbeat.insert("alpha".to_string(), Instant::now());
    let second = detector.detect("", state.last_pty("alpha"), None);
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
    auto_actions::tick(&state, "ghost", &mut detector).await.unwrap();

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
    let mut captured = String::new();
    for _ in 0..24 {
        auto_actions::tick(&state, &name, &mut detector).await.unwrap();
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
        .args(["kill-session", "-t", &format!("amux3-{name}")])
        .output();
    std::fs::remove_dir_all(dir).ok();
}
