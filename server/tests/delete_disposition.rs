//! T7 — what `delete` and `purge` actually dispose of, asserted.
//!
//! §15.3 asks for "delete honesty: enumerate what is/isn't removed". The audit
//! found the enumeration was not just missing from the UI — one row of it was
//! WRONG in the code. `schedules.session` is a bare `TEXT NOT NULL` with no FK
//! (`0003_schedules.sql:7`), so deleting or purging a session left its
//! schedules pointing at a name that no longer resolves. Every tick then failed
//! its existence check, recorded an error run, **and pushed a notification to
//! the user's phone** (`runner.rs`) — forever, for a session they deleted.
//!
//! The disposition chosen (T7.1): the schedules are **soft-deleted**
//! (`deleted = now`), not hard-deleted. The tick loop filters `deleted IS NULL`
//! so firing stops immediately, while `schedule_runs` — which FK-CASCADEs off
//! `schedules(id)` and would be destroyed by a hard DELETE — keeps its history.
//! "The schedule stops and won't run again. Past runs stay in the log." is
//! already the copy on the manual delete-schedule path; this makes the implicit
//! path behave the same way.
//!
//! R3's mitigation: this file is the disposition table *as a test*, so a future
//! change to either handler that forgets the copy fails CI rather than turning
//! the dialog into a lie.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::schedules::Schedule;
use supermux_server::state::AppState;
use supermux_server::{db, sessions};

const TOKEN: &str = "delete-disposition-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-del-disp-{}", uuid::Uuid::new_v4()));
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

async fn new_state() -> (AppState, PathBuf) {
    let (config, dir) = temp_config();
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

fn new_session(name: &str, dir: &std::path::Path) -> db::sessions::NewSession {
    db::sessions::NewSession {
        name: name.to_string(),
        display_name: name.to_string(),
        dir: dir.display().to_string(),
        desc: String::new(),
        provider: "claude".to_string(),
        creator: "test".to_string(),
        flags: String::new(),
        tags: "[]".to_string(),
        branch: String::new(),
        mcp: String::new(),
        worktree: false,
        worktree_repo: String::new(),
        host_id: None,
        runtime: "native".to_string(),
    }
}

fn tmux_schedule(id: &str, session: &str) -> Schedule {
    let now = chrono::Utc::now().timestamp();
    Schedule {
        id: id.to_string(),
        title: "orphan candidate".to_string(),
        session: session.to_string(),
        command: String::new(),
        prompt: "ping".to_string(),
        kind: "tmux".to_string(),
        boot_dir: String::new(),
        boot_provider: String::new(),
        boot_worktree: 0,
        sched_type: "recurring".to_string(),
        recurrence: Some("every 1 minute".to_string()),
        run_at: None,
        next_run: Some(
            (chrono::Utc::now() + chrono::Duration::minutes(1))
                .to_rfc3339(),
        ),
        last_run: None,
        enabled: 1,
        run_count: 0,
        schedule_expr: Some("every 1 minute".to_string()),
        watch: 0,
        watch_timeout: 0,
        done_pattern: None,
        done_action: "notify".to_string(),
        confirm_finish: 0,
        bypass_permissions: 0,
        created: now,
        updated: now,
        deleted: None,
    }
}

/// T7.1 — the orphan fix, stated as an invariant: **no schedule survives its
/// session**. This is the failing test the fix was written against.
#[tokio::test]
async fn no_schedule_survives_its_session_delete() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("doomed", &dir))
        .await
        .unwrap();
    db::schedules::insert(&state.pool, &tmux_schedule("s-doomed", "doomed"))
        .await
        .unwrap();

    // Precondition: the tick loop can see it.
    let due = db::schedules::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        due.iter().any(|s| s.id == "s-doomed"),
        "precondition: the schedule is live to the tick loop"
    );

    db::sessions::delete(&state.pool, "doomed").await.unwrap();

    let due = db::schedules::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        !due.iter().any(|s| s.id == "s-doomed"),
        "the deleted session's schedule is still firing — every tick errors and \
         pushes to the user's phone"
    );
}

/// A hard DELETE must BROADCAST its removal, not just mutate the DB.
///
/// The states-audit residual: `sessions::delete` flipped the row out of the DB
/// but emitted no `sessions` removal delta, so every open tab kept the deleted
/// session's tile — green "Idle" dot, selected in the roster, a live composer —
/// until an unrelated focus/visibility/online resync. `archive` has always
/// broadcast `{name, archived:true}`; the hard-delete twin now broadcasts
/// `{name, removed:true}`, which the frontend's `applyDelta` drops on exactly
/// like the archive flag. This is the failing test that fix was written against:
/// without the broadcast, no `sessions` delta carrying `removed:true` ever
/// reaches a subscriber.
#[tokio::test]
async fn delete_broadcasts_a_sessions_removal_delta() {
    use std::time::Duration;

    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("vanishing", &dir))
        .await
        .unwrap();

    // Subscribe AFTER the create so the channel starts clean for the delete delta.
    let mut rx = state.sse_tx.subscribe();

    sessions::delete(&state, "vanishing").await.expect("delete");

    // Drain up to ~2s: the delete's own detector/status re-sends may interleave;
    // we only need the removal delta itself to reach subscribers.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut saw_removed = false;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            Ok(Ok(ev)) if ev.event == "sessions" => {
                let deltas = ev
                    .payload
                    .get("delta")
                    .and_then(|d| d.as_array())
                    .cloned()
                    .unwrap_or_default();
                for d in deltas {
                    let is_target =
                        d.get("name").and_then(|n| n.as_str()) == Some("vanishing");
                    let removed = d.get("removed").and_then(|a| a.as_bool()) == Some(true);
                    if is_target && removed {
                        saw_removed = true;
                        break;
                    }
                }
                if saw_removed {
                    break;
                }
            }
            Ok(Ok(_)) => continue,
            Ok(Err(_)) | Err(_) => continue,
        }
    }
    assert!(
        saw_removed,
        "expected a `sessions` SSE delta with removed=true for the deleted session",
    );
}

/// The same invariant on the purge path. `purge` is the only *user-facing*
/// hard delete (the Archived sheet's "Delete forever"), so this is the one that
/// actually happens in the wild.
#[tokio::test]
async fn no_schedule_survives_its_session_purge() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("purged", &dir))
        .await
        .unwrap();
    db::schedules::insert(&state.pool, &tmux_schedule("s-purged", "purged"))
        .await
        .unwrap();
    db::sessions::set_archived(&state.pool, "purged", true)
        .await
        .unwrap();

    sessions::purge(&state, "purged").await.expect("purge");

    let due = db::schedules::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        !due.iter().any(|s| s.id == "s-purged"),
        "the purged session's schedule is still firing"
    );
}

/// The disposition is a SOFT delete, and that distinction is load-bearing:
/// `schedule_runs` FK-CASCADEs off `schedules(id)`, so hard-deleting the
/// schedule would take the run ledger with it. "Past runs stay in the log" is
/// the promise the manual delete-schedule path already makes; the implicit path
/// keeps it too.
#[tokio::test]
async fn the_schedules_run_history_survives_the_disposition() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("historic", &dir))
        .await
        .unwrap();
    db::schedules::insert(&state.pool, &tmux_schedule("s-historic", "historic"))
        .await
        .unwrap();
    db::schedules::insert_run(
        &state.pool,
        "s-historic",
        chrono::Utc::now().timestamp(),
        "ok",
        "sent to historic",
    )
    .await
    .unwrap();

    db::sessions::delete(&state.pool, "historic").await.unwrap();

    let runs = db::schedules::runs_for(&state.pool, "s-historic", 10)
        .await
        .unwrap();
    assert_eq!(
        runs.len(),
        1,
        "a hard DELETE would have CASCADEd the run ledger away; the disposition \
         must be a soft delete"
    );
}

/// Archive is the reversible verb — it is the "undo window" §15.3 asks for,
/// it just was never named as one. It must NOT dispose of the schedules: T5's
/// contract is that they are *paused* (a pure function of `sessions.archived`)
/// and resume on unarchive. This test is what stops T7's fix from being
/// implemented one layer too high and quietly destroying them.
#[tokio::test]
async fn archive_preserves_the_schedules_it_only_pauses_them() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("resting", &dir))
        .await
        .unwrap();
    db::schedules::insert(&state.pool, &tmux_schedule("s-resting", "resting"))
        .await
        .unwrap();

    db::sessions::set_archived(&state.pool, "resting", true)
        .await
        .unwrap();

    let sched = db::schedules::get(&state.pool, "s-resting")
        .await
        .unwrap()
        .expect("archive must not delete the schedule — it is reversible");
    assert!(sched.deleted.is_none(), "archive is not a disposition");
    assert_eq!(sched.enabled, 1, "the row is untouched; the pause is dynamic");
}

/// Purge refuses a live session (409) and an absent one (404) BEFORE anything
/// destructive runs — so a failed purge disposes of nothing, schedules
/// included. Guards the ordering, not just the outcome.
#[tokio::test]
async fn a_refused_purge_disposes_of_nothing() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("live", &dir))
        .await
        .unwrap();
    db::schedules::insert(&state.pool, &tmux_schedule("s-live", "live"))
        .await
        .unwrap();

    // Not archived → 409, and nothing is touched.
    sessions::purge(&state, "live")
        .await
        .expect_err("purge must refuse a live session");
    let due = db::schedules::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        due.iter().any(|s| s.id == "s-live"),
        "a refused purge must not have disposed of the schedule"
    );
    assert!(db::sessions::exists(&state.pool, "live").await.unwrap());

    // Unknown name → 404.
    sessions::purge(&state, "no-such-session")
        .await
        .expect_err("purge of an unknown session is a 404");
}
