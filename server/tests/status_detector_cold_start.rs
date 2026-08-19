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
use supermux_server::sessions::chat;
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
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "secret-test-token-status".to_string(),
        provider_defaults: ProviderDefaults::default(),
        // The WebSocket layer requires a `ws` block in `Config`; default it so
        // the cold-start test compiles against the merged `Config`.
        ws: WsConfig::default(),
        swarm_reaper: Default::default(),
        remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

#[tokio::test]
async fn cold_start_heartbeat_is_five_minutes_ago() {
    let (state, dir) = test_state().await;

    // With no live pty reader attached, the heartbeat reads as the cold-start
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

    // A real PTY byte arrives (what the ws reader records): → Active. No hooks
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
    // A2: the tick also carries the per-session chat-tail gate (change + 1s
    // debounce) for the `chat_tail` key on the same SSE delta.
    let mut chat_tail = auto_actions::ChatTailGate::new();
    auto_actions::tick(
        &state,
        "ghost",
        &mut detector,
        &mut tail,
        &mut last_capture_at,
        &mut chat_tail,
    )
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
    let mut chat_tail = auto_actions::ChatTailGate::new();
    let mut captured = String::new();
    for _ in 0..24 {
        auto_actions::tick(
            &state,
            &name,
            &mut detector,
            &mut tail,
            &mut last_capture_at,
            &mut chat_tail,
        )
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

/// A2 Task 5 — the `chat_tail` WIRING, end to end through a real `tick`.
///
/// `ChatTailGate`'s own unit tests pin the policy (change gate + debounce) as a
/// pure function; this pins the two things they structurally cannot see: that
/// `tick` reads the session's ring at all, and that what the gate returns is
/// actually inserted into the `sessions` SSE delta item (and triggers one).
/// Without this, gating the key behind `tail_changed`, dropping the insert, or
/// sampling the wrong store would leave every unit test green.
///
/// The ring is seeded through the PUBLIC parser rather than a hand-built entry,
/// so the shape the tailer really publishes is what the tile summary is built
/// from.
#[tokio::test]
async fn detector_tick_puts_the_chat_tail_on_the_sessions_delta() {
    if !tmux_available() {
        eprintln!("skipping detector_tick_puts_the_chat_tail_on_the_sessions_delta: no tmux");
        return;
    }
    let (state, dir) = test_state().await;
    let name = format!("ct{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    db::sessions::insert_minimal(&state.pool, &name, "/tmp", "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, &name, "tok").await.unwrap();
    sessions::lifecycle::start(&state, &name, None).await.unwrap();

    // Seed the in-memory ring exactly as the tailer would.
    let lines = [
        r#"{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"run the tests"}]}}"#,
        r#"{"type":"assistant","uuid":"a1","timestamp":"2026-01-01T00:00:01Z","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"running them now"}]}}"#,
    ];
    let mut entries = Vec::new();
    for l in lines {
        match chat::parser::parse_line(l, 0) {
            chat::parser::ParsedLine::Entry(e) => entries.extend(e),
            other => panic!("fixture line did not parse: {other:?}"),
        }
    }
    state.chat_store_for(&name).publish(entries);

    let mut rx = state.sse_tx.subscribe();
    let mut detector = StatusDetector::new();
    let mut tail = None;
    let mut last_capture_at =
        Instant::now() - supermux_server::sessions::status::MAX_PREVIEW_STALENESS;
    let mut chat_tail = auto_actions::ChatTailGate::new();

    auto_actions::tick(
        &state,
        &name,
        &mut detector,
        &mut tail,
        &mut last_capture_at,
        &mut chat_tail,
    )
    .await
    .unwrap();

    // Drain everything this tick broadcast and pick our session's rows out.
    fn drain_chat_tails(
        rx: &mut tokio::sync::broadcast::Receiver<supermux_server::state::SseEvent>,
        name: &str,
    ) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if ev.event != "sessions" {
                continue;
            }
            let Some(rows) = ev.payload.get("delta").and_then(|d| d.as_array()) else {
                continue;
            };
            for row in rows {
                if row.get("name").and_then(|n| n.as_str()) == Some(name) {
                    if let Some(t) = row.get("chat_tail") {
                        out.push(t.clone());
                    }
                }
            }
        }
        out
    }

    let first = drain_chat_tails(&mut rx, &name);
    assert_eq!(
        first.len(),
        1,
        "the tick must put chat_tail on the sessions delta exactly once; got {first:?}"
    );
    assert_eq!(first[0]["user"], serde_json::json!("run the tests"));
    assert_eq!(first[0]["agent"], serde_json::json!("running them now"));

    // Unchanged ring, and well past the 1s debounce so the CHANGE gate is the
    // only thing that can suppress it: the key must be absent, not re-sent —
    // absent means "unchanged", and the tile keeps what it has.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    last_capture_at = Instant::now() - supermux_server::sessions::status::MAX_PREVIEW_STALENESS;
    auto_actions::tick(
        &state,
        &name,
        &mut detector,
        &mut tail,
        &mut last_capture_at,
        &mut chat_tail,
    )
    .await
    .unwrap();
    assert!(
        drain_chat_tails(&mut rx, &name).is_empty(),
        "an unchanged chat tail must not be re-broadcast"
    );

    // A NEW transcript entry with the status already settled and the pane quiet:
    // the chat tail must be able to trigger the delta ON ITS OWN. The transcript
    // lands in batches tens of seconds after the pane goes quiet, so a chat_tail
    // that only rides an existing status/pane-tail change would strand the last
    // turn's summary until the next keystroke.
    let later = r#"{"type":"assistant","uuid":"a2","timestamp":"2026-01-01T00:01:00Z","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"3 failed"}]}}"#;
    let chat::parser::ParsedLine::Entry(e) = chat::parser::parse_line(later, 0) else {
        panic!("fixture line did not parse")
    };
    state.chat_store_for(&name).publish(e);
    last_capture_at = Instant::now() - supermux_server::sessions::status::MAX_PREVIEW_STALENESS;
    auto_actions::tick(
        &state,
        &name,
        &mut detector,
        &mut tail,
        &mut last_capture_at,
        &mut chat_tail,
    )
    .await
    .unwrap();
    let third = drain_chat_tails(&mut rx, &name);
    assert_eq!(
        third.len(),
        1,
        "a changed chat tail must reach the delta even when nothing else changed; got {third:?}"
    );
    assert_eq!(third[0]["agent"], serde_json::json!("3 failed"));

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
