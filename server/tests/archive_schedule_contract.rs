//! T5 — the archive/schedule contract, asserted.
//!
//! The bug this file locks down: before B5 the scheduler was entirely
//! archive-blind. `enabled_with_next()` never joined `sessions`, and the tmux
//! job body called `sessions::lifecycle::send_harness_text`, whose
//! existence check was the archive-BLIND `db::sessions::exists`. That function
//! then *starts* the session when it is not alive. Net effect: archiving a
//! session hid it from `list` (which filters `archived = 0`) while its own
//! schedule silently brought it back to life on the next tick — running, and
//! invisible.
//!
//! **The contract B5 chose (G4, option a).** Archiving a session PAUSES its
//! schedules; unarchiving resumes them. Nothing is mutated on the `schedules`
//! rows, so the pause is a pure function of `sessions.archived` and is exactly
//! as reversible as `unarchive` itself. A tick that lands on an archived
//! session records an explicit, readable `skipped` run — not a generic error,
//! and *never* a start.
//!
//! The second half of the contract is the negative one, and it is the reason
//! `send_harness_text` is asserted directly here: no OTHER caller may
//! resurrect an archived session either. The guard lives at the send, not only
//! at the scheduler, so a future job kind cannot reintroduce the bug.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::schedules::Schedule;
use supermux_server::state::AppState;
use supermux_server::{db, scheduler, sessions};

const TOKEN: &str = "archive-schedule-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-arch-sched-{}", uuid::Uuid::new_v4()));
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
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
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
        model: String::new(),
        company_id: None,
    }
}

fn tmux_schedule(id: &str, session: &str) -> Schedule {
    let now = chrono::Utc::now().timestamp();
    Schedule {
        id: id.to_string(),
        title: "nightly ping".to_string(),
        session: session.to_string(),
        command: String::new(),
        prompt: "status?".to_string(),
        kind: "tmux".to_string(),
        boot_dir: String::new(),
        boot_provider: String::new(),
        boot_worktree: 0,
        sched_type: "recurring".to_string(),
        recurrence: Some("every 1 minute".to_string()),
        run_at: None,
        next_run: None,
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

/// T5.1 — the regression. Archive a session that owns an enabled schedule,
/// fire the schedule, and assert the session is NOT started and the run is
/// recorded with an explicit, readable status.
#[tokio::test]
async fn an_archived_sessions_schedule_does_not_resurrect_it() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("ghost", &dir))
        .await
        .unwrap();
    let sched = tmux_schedule("sched-ghost", "ghost");
    db::schedules::insert(&state.pool, &sched).await.unwrap();

    // Archive it. (The DB-level flip is what the scheduler must observe; the
    // full `lifecycle::archive` also stops a runtime, which needs a live pty.)
    db::sessions::set_archived(&state.pool, "ghost", true)
        .await
        .unwrap();
    assert!(
        !db::sessions::exists_active(&state.pool, "ghost").await.unwrap(),
        "precondition: the session is archived"
    );

    scheduler::runner::run(
        state.clone(),
        sched.clone(),
        scheduler::runner::Trigger::Tick {
            scheduled_for_ts: chrono::Utc::now().timestamp(),
        },
    )
    .await;

    // It must still be archived — no resurrection.
    assert!(
        !db::sessions::exists_active(&state.pool, "ghost").await.unwrap(),
        "the schedule resurrected an archived session"
    );

    // And the run must say so, readably.
    let runs = db::schedules::runs_for(&state.pool, "sched-ghost", 10)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1, "the tick recorded exactly one run");
    assert_eq!(
        runs[0].status, "skipped",
        "an archived target is a skip, not an error and not an ok"
    );
    assert!(
        runs[0].note.contains("archived"),
        "the note names the reason: {:?}",
        runs[0].note
    );
}

/// The other half of the contract: unarchiving resumes the schedule. Nothing
/// was mutated on the `schedules` row, so this is automatic — this test is what
/// stops a future implementation from "fixing" the bug by disabling the rows.
#[tokio::test]
async fn unarchiving_resumes_the_schedule_without_touching_its_row() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("back", &dir))
        .await
        .unwrap();
    let sched = tmux_schedule("sched-back", "back");
    db::schedules::insert(&state.pool, &sched).await.unwrap();

    db::sessions::set_archived(&state.pool, "back", true)
        .await
        .unwrap();
    scheduler::runner::run(
        state.clone(),
        sched.clone(),
        scheduler::runner::Trigger::Tick {
            scheduled_for_ts: chrono::Utc::now().timestamp(),
        },
    )
    .await;

    let after_archive = db::schedules::get(&state.pool, "sched-back")
        .await
        .unwrap()
        .expect("schedule survives the skip");
    assert_eq!(
        after_archive.enabled, 1,
        "the skip must not disable the schedule — the pause is a function of \
         sessions.archived, so unarchive alone restores it"
    );

    db::sessions::set_archived(&state.pool, "back", false)
        .await
        .unwrap();
    assert!(
        db::sessions::exists_active(&state.pool, "back").await.unwrap(),
        "unarchived sessions are active again"
    );
}

/// The guard lives at the send, not only at the scheduler: any caller trying to
/// deliver text to an archived session gets a 404, never a silent auto-start.
#[tokio::test]
async fn send_text_refuses_an_archived_session_instead_of_starting_it() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("hidden", &dir))
        .await
        .unwrap();
    db::sessions::set_archived(&state.pool, "hidden", true)
        .await
        .unwrap();

    let err = sessions::lifecycle::send_harness_text(&state, "hidden", "hello", None, None)
        .await
        .expect_err("an archived session is not a send target");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("NotFound"),
        "archive-blind `exists` would have auto-started it; got {msg}"
    );
}
