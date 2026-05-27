//! Push-debounce behaviour (SD-13b: trailing-coalesce on transition).
//!
//! `maybe_push_on_transition` schedules a delayed send and cancels prior
//! pending sends for the same session — so a rapid `Starting → Active → Idle`
//! flurry, or a team-lead bouncing through `Idle` while it orchestrates,
//! coalesces into ONE notification fired after the system has been quiet
//! for the debounce window.
//!
//! The tests observe `state.pending_pushes` (the per-session abort-handle map)
//! and `state.push_attempts` (the ring `send_push_inner` writes to on every
//! fan-out attempt). A loopback "definitely closed" subscription
//! (`http://127.0.0.1:1/`) lets the send proceed past the empty-subs early
//! return and record the attempt without depending on a real push service —
//! the connection refuses immediately, so failures land fast.

use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db;
use supermux_server::sessions::auto_actions::maybe_push_on_transition;
use supermux_server::sessions::status::Status;
use supermux_server::state::AppState;

const TOKEN: &str = "push-debounce-token";

async fn setup() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "supermux-pushdebounce-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
        push_sub: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    (state, dir)
}

/// Insert a session row + runtime + a bogus push subscription. The endpoint
/// is `https://127.0.0.1:1/x`: port 1 is reserved/closed everywhere standard,
/// so reqwest's connect refuses immediately and `send_push_inner` records
/// the (failed) attempt without burning seconds on a hung HTTPS handshake.
async fn seed(state: &AppState, name: &str, status: &str, team_name: Option<&str>) {
    db::sessions::insert_minimal(&state.pool, name, "/tmp", "shell")
        .await
        .expect("insert session");
    db::sessions::ensure_runtime(&state.pool, name, "test-hook-token")
        .await
        .expect("ensure runtime");
    db::sessions::set_last_status(&state.pool, name, status)
        .await
        .expect("set status");
    if let Some(t) = team_name {
        db::sessions::set_team_name(&state.pool, name, Some(t))
            .await
            .expect("set team_name");
    }
    db::push::upsert(
        &state.pool,
        "https://127.0.0.1:1/x",
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
        "tBHItJI5svbpez7KI4CCXg",
    )
    .await
    .expect("upsert sub");
}

async fn cleanup(state: &AppState, dir: std::path::PathBuf) {
    // Abort any pending timers so the test process exits cleanly.
    state.pending_pushes.iter().for_each(|e| e.value().abort());
    let _ = std::fs::remove_dir_all(dir);
}

/// Three rapid `Idle` transitions within ~150ms collapse to ONE entry in
/// `pending_pushes` (the latest); after the 2s default settle the timer
/// completes, the entry is removed, and `push_attempts` has recorded exactly
/// one fan-out attempt (with `category == agent_finished`).
#[tokio::test(flavor = "current_thread")]
async fn rapid_transitions_collapse_to_one_push() {
    let (state, dir) = setup().await;
    seed(&state, "burst", "idle", None).await;

    for _ in 0..3 {
        maybe_push_on_transition(&state, "burst", Status::Idle);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The map carries exactly one (the latest) abort handle for this session
    // — every prior call's task was aborted before its timer expired.
    assert_eq!(state.pending_pushes.len(), 1, "rapid calls must collapse to 1 pending handle");

    // Wait through the default 2s settle plus generous margin for the spawned
    // task's bookkeeping (DB read of current status + push HTTPS connect-refuse
    // + recording into the ring). Larger margin than tight-CI minimum so a
    // loaded runner doesn't flake.
    tokio::time::sleep(Duration::from_millis(3500)).await;

    let snap = state.push_attempts.snapshot();
    let agent_finished_attempts: Vec<_> = snap
        .iter()
        .filter(|a| a.category == "agent_finished" && a.title.contains("burst"))
        .collect();
    assert_eq!(
        agent_finished_attempts.len(),
        1,
        "expected exactly ONE agent_finished attempt after burst+settle, got {:?}",
        snap.iter().map(|a| &a.title).collect::<Vec<_>>()
    );
    // The completed task removed its own slot from the map.
    assert!(
        state.pending_pushes.get("burst").is_none(),
        "settled task must remove its pending_pushes slot"
    );

    cleanup(&state, dir).await;
}

/// If the session transitions OUT of the notify-worthy state during the
/// debounce window, the scheduled timer task re-reads `last_status`, finds
/// it no longer maps to the pending category, and drops the send — no push
/// attempt is recorded.
#[tokio::test(flavor = "current_thread")]
async fn transition_away_during_debounce_drops_push() {
    let (state, dir) = setup().await;
    seed(&state, "flipper", "idle", None).await;

    // Schedule the Idle push…
    maybe_push_on_transition(&state, "flipper", Status::Idle);
    // …then immediately flip back to Active, simulating a real
    // Idle → Active flap within the 2s quiet window.
    db::sessions::set_last_status(&state.pool, "flipper", "active")
        .await
        .expect("flip to active");

    tokio::time::sleep(Duration::from_millis(3500)).await;

    let snap = state.push_attempts.snapshot();
    let attempts_for_flipper: Vec<_> =
        snap.iter().filter(|a| a.title.contains("flipper")).collect();
    assert!(
        attempts_for_flipper.is_empty(),
        "no push should fire when status moved off Idle during the debounce window; got {:?}",
        attempts_for_flipper.iter().map(|a| &a.title).collect::<Vec<_>>()
    );

    cleanup(&state, dir).await;
}

/// On a team-tagged session, an `Idle` transition is debounced with the
/// longer 15s window (T_TEAM_FINISH). At 4s after the call (well past the
/// default 2s window, well short of 15s) the entry is STILL pending and no
/// push has fired — proof the longer window applies to leads that bounce
/// through Idle while orchestrating teammates.
#[tokio::test(flavor = "current_thread")]
async fn team_finish_uses_extended_window() {
    let (state, dir) = setup().await;
    seed(&state, "leadsess", "idle", Some("some-team")).await;

    maybe_push_on_transition(&state, "leadsess", Status::Idle);
    tokio::time::sleep(Duration::from_millis(5000)).await;

    // Still pending: the extended team-finish window has NOT elapsed.
    assert!(
        state.pending_pushes.get("leadsess").is_some(),
        "team-tagged Idle must remain pending past the default 2s window"
    );
    let snap = state.push_attempts.snapshot();
    let attempts_for_lead: Vec<_> =
        snap.iter().filter(|a| a.title.contains("leadsess")).collect();
    assert!(
        attempts_for_lead.is_empty(),
        "no push should have fired yet at t=4s (team window is 15s); got {:?}",
        attempts_for_lead.iter().map(|a| &a.title).collect::<Vec<_>>()
    );

    cleanup(&state, dir).await;
}

/// Cross-check: `Waiting` on a team-tagged session uses the SHORT window
/// (the team-aware extension is opt-in only for `Idle`/agent_finished —
/// "needs you" is unambiguous and shouldn't be delayed even for teams).
#[tokio::test(flavor = "current_thread")]
async fn team_waiting_keeps_short_window() {
    let (state, dir) = setup().await;
    seed(&state, "teamwait", "waiting", Some("some-team")).await;

    maybe_push_on_transition(&state, "teamwait", Status::Waiting);
    tokio::time::sleep(Duration::from_millis(3500)).await;

    let snap = state.push_attempts.snapshot();
    let waits: Vec<_> = snap
        .iter()
        .filter(|a| a.category == "agent_waiting" && a.title.contains("teamwait"))
        .collect();
    assert_eq!(
        waits.len(),
        1,
        "team-tagged Waiting must fire after the SHORT 2s window, got {:?}",
        snap.iter().map(|a| &a.title).collect::<Vec<_>>()
    );

    cleanup(&state, dir).await;
}
