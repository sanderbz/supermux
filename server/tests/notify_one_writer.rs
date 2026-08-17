//! T2 — there is exactly ONE writer of `state.pending_pushes`.
//!
//! **The hazard (R1, the sharpest edge in B5).** After T1's harvest, two code
//! paths do the identical `pending_pushes.remove(name).abort()` + `insert(...)`
//! dance on the same `DashMap`:
//!
//! * `notify::notify_event` — the new hook-anchored path (`notify.rs`), raised
//!   from `hooks::apply_payload`.
//! * `auto_actions::maybe_push_on_transition` — the old detector path, driven
//!   by the 2 s status classifier.
//!
//! A Claude session drives BOTH for one logical event: the `Stop` hook fires
//! the first, and ~2 s later the detector observes `Idle` and fires the second.
//! Left as-is they abort each other's timers in whichever order they happen to
//! land, and **the failure is silent** — a dropped push is indistinguishable
//! from a muted one, and nothing in either language errors. That is precisely
//! the class of bug that is impossible to diagnose from a user report.
//!
//! **The resolution.** The hook path is the only writer for providers that emit
//! hooks; the detector path returns early for them and survives as the explicit
//! fallback for providers that do NOT (codex / kimi / shell), so nobody loses
//! notifications. The two behaviours `main` grew inside the detector — the 15 s
//! team-finish window and `push_should_fire`'s subagent gate — move INTO the
//! hook path (T2.3) before the detector is demoted, never after.
//!
//! These tests assert the observable consequence rather than the mechanism: for
//! one logical turn boundary, the ring records exactly one attempt.

use std::path::PathBuf;
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db;
use supermux_server::sessions::status::Status;
use supermux_server::state::AppState;

const TOKEN: &str = "one-writer-token";
/// Long enough for the 2 s debounce plus the finish grace to settle.
const SETTLE: Duration = Duration::from_millis(3500);

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-one-writer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
    };
    (config, dir)
}

async fn setup(name: &str, provider: &str) -> (AppState, PathBuf) {
    let (config, dir) = temp_config();
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    db::sessions::insert_minimal(&state.pool, name, dir.to_str().unwrap(), provider)
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, name, "hook-token").await.unwrap();
    // A subscriber, so a send that is not muted actually reaches the fan-out
    // and records an attempt. The endpoint is unreachable; delivery failing is
    // irrelevant — this measures how many sends were ATTEMPTED.
    db::push::upsert(
        &state.pool,
        "https://example.invalid/push/one-writer",
        "BJxKIoLLj0mFqRoNzYSJ8kCFvZM5A4jjRkoOhbWEK4vJnCFj0T0zEbLpJPYuTGvUXMKgtBjRQmQKF6VZo7SFtRk",
        "k8JV6sjdbhAiXhTsevMK5A",
    )
    .await
    .unwrap();
    (state, dir)
}

/// How many sends were attempted, by category.
fn categories(state: &AppState) -> Vec<String> {
    let mut v: Vec<String> = state
        .push_attempts
        .snapshot()
        .iter()
        .map(|a| a.category.clone())
        .collect();
    v.reverse(); // the ring is newest-first
    v
}

/// The titles of the attempted sends, oldest-first.
///
/// The title is what tells the two writers apart, which is why it is asserted
/// and not just the count. The hook path titles a push with the BOT's name
/// (`notify::compose` — "the title names who is talking"); the detector path
/// titles it with the sentence `agent {name} finished`. So "how many pushes"
/// can look right while the wrong writer won the race, and only the title
/// exposes it.
fn titles(state: &AppState) -> Vec<String> {
    let mut v: Vec<String> = state
        .push_attempts
        .snapshot()
        .iter()
        .map(|a| a.title.clone())
        .collect();
    v.reverse();
    v
}

/// T2.1 — the interleaving. A `Stop` hook and a detector `Idle` transition for
/// the same session inside the quiet window describe ONE turn boundary and must
/// produce ONE push.
///
/// Before T2 this produced either one or two depending on which timer won, and
/// which one it was could change between runs.
#[tokio::test]
async fn a_stop_hook_and_a_detector_idle_produce_exactly_one_push() {
    let (state, dir) = setup("interleave", "claude").await;
    db::sessions::set_last_status(&state.pool, "interleave", "idle").await.ok();

    // The hook path — what Claude actually emits at a turn boundary.
    supermux_server::notify::notify_event(
        &state,
        "interleave",
        supermux_server::notify::NotifEvent::TurnFinished,
    );
    // …and the detector observing the same boundary a beat later.
    tokio::time::sleep(Duration::from_millis(200)).await;
    supermux_server::sessions::auto_actions::maybe_push_on_transition(
        &state,
        "interleave",
        Status::Idle,
    );

    tokio::time::sleep(SETTLE).await;

    let cats = categories(&state);
    assert_eq!(
        cats.len(),
        1,
        "one turn boundary must be one push; got {cats:?} — the two writers of \
         pending_pushes are racing",
    );
    assert_eq!(cats[0], "agent_finished");
    // …and it must be the HOOK path's push, deterministically. Counting alone
    // is not enough: today the detector's timer aborts the hook's and the count
    // still reads 1, so the assertion that actually pins the fix is WHICH
    // writer survived. The hook path titles with the bot's name; the detector
    // titles with the sentence "agent {name} finished".
    assert_eq!(
        titles(&state),
        vec!["interleave"],
        "the surviving push must come from the hook path — a detector push here \
         means it is still a competing writer and merely won this run",
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// The second interleaving, and the one users actually feel: a turn ends and
/// the agent immediately asks for permission. The dialog's banner must replace
/// the finish, not arrive alongside it.
#[tokio::test]
async fn a_finish_followed_by_a_permission_ask_shows_the_dialog_not_both() {
    let (state, dir) = setup("dialog", "claude").await;
    db::sessions::set_last_status(&state.pool, "dialog", "idle").await.ok();

    supermux_server::notify::notify_event(
        &state,
        "dialog",
        supermux_server::notify::NotifEvent::TurnFinished,
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    // The dialog goes up. It must be the thing that rings.
    state.set_permission_request(
        "dialog",
        supermux_server::sessions::activity::PermissionAsk {
            tool: "Bash".to_string(),
            summary: "⚡ run the test suite".to_string(),
            kind: "bash".to_string(),
            mode: Some("default".to_string()),
        },
    );
    db::sessions::set_last_status(&state.pool, "dialog", "waiting").await.ok();
    supermux_server::notify::notify_event(
        &state,
        "dialog",
        supermux_server::notify::NotifEvent::PermissionAsked,
    );

    tokio::time::sleep(SETTLE).await;

    let cats = categories(&state);
    assert_eq!(
        cats,
        vec!["agent_waiting"],
        "the blocked agent is the news; the finish it superseded must not also ring",
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// T2.2 — the detector survives as the FALLBACK. A provider that emits no hooks
/// has nothing else to notify it, so demoting the detector for hook-capable
/// providers must not silence these.
///
/// This is the test that makes gate G2(a) safe: the coverage reduction it asks
/// the owner to accept is bounded by this assertion.
#[tokio::test]
async fn a_provider_without_hooks_still_pushes_from_the_detector() {
    for provider in ["codex", "kimi", "shell"] {
        let (state, dir) = setup("fallback", provider).await;
        db::sessions::set_last_status(&state.pool, "fallback", "waiting").await.ok();

        supermux_server::sessions::auto_actions::maybe_push_on_transition(
            &state,
            "fallback",
            Status::Waiting,
        );
        tokio::time::sleep(SETTLE).await;

        assert_eq!(
            categories(&state),
            vec!["agent_waiting"],
            "provider={provider} emits no hooks — the detector is its ONLY path \
             to a notification, so it must stay live",
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The other half of T2.2: for a hook-capable provider the detector must NOT
/// fire, because the hook path already did. Without this the demotion is not
/// actually in effect and the race above only looks fixed.
#[tokio::test]
async fn the_detector_is_silent_for_a_hook_capable_provider() {
    let (state, dir) = setup("hooked", "claude").await;
    db::sessions::set_last_status(&state.pool, "hooked", "waiting").await.ok();

    // The detector alone, with no hook event at all.
    supermux_server::sessions::auto_actions::maybe_push_on_transition(
        &state,
        "hooked",
        Status::Waiting,
    );
    tokio::time::sleep(SETTLE).await;

    assert!(
        categories(&state).is_empty(),
        "a Claude session's notifications are hook-anchored; the detector must \
         not be a second, competing writer",
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// T2.3 — the subagent gate moved INTO the hook path, and still holds.
///
/// A multi-agent turn reads idle between subagent dispatches. `main` grew this
/// gate in the detector path; demoting the detector without carrying it across
/// would have re-opened the "cried finished mid-turn" bug that gate closed.
#[tokio::test]
async fn a_turn_with_subagents_in_flight_does_not_announce_itself_finished() {
    let (state, dir) = setup("swarm", "claude").await;
    db::sessions::set_last_status(&state.pool, "swarm", "idle").await.ok();

    state.inc_subagents("swarm");
    state.inc_subagents("swarm");

    supermux_server::notify::notify_event(
        &state,
        "swarm",
        supermux_server::notify::NotifEvent::TurnFinished,
    );
    tokio::time::sleep(SETTLE).await;

    assert!(
        categories(&state).is_empty(),
        "two subagents are still in flight — the turn is not done",
    );

    let _ = std::fs::remove_dir_all(dir);
}
