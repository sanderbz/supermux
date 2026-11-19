//! The archive/workflow contract, asserted. (Port of `archive_schedule_contract.rs`.)
//!
//! The bug this file locks down: before B5 the scheduler was entirely
//! archive-blind. `enabled_with_next()` never joined `sessions`, and the tmux
//! job body called `sessions::lifecycle::send_harness_text`, whose existence
//! check was the archive-BLIND `db::sessions::exists`. That function then
//! *starts* the session when it is not alive. Net effect: archiving a session
//! hid it from `list` (which filters `archived = 0`) while its own schedule
//! silently brought it back to life on the next tick — running, and invisible.
//!
//! **The contract (G4, option a), carried over unchanged into Workflows v1.**
//! Archiving a session PAUSES its workflows; unarchiving resumes them. Nothing
//! is mutated on the `workflows` row, so the pause is a pure function of
//! `sessions.archived` and is exactly as reversible as `unarchive` itself. A
//! tick that lands on an archived session records an explicit, readable
//! `skipped` run — not a generic error, and *never* a start.
//!
//! The second half of the contract is the negative one, and it is the reason
//! `send_harness_text` is asserted directly here: no OTHER caller may resurrect
//! an archived session either. The guard lives at the send, not only at the
//! engine, so a future delivery path cannot reintroduce the bug.

use std::path::PathBuf;
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db::workflows::{StepInput, Workflow};
use supermux_server::state::AppState;
use supermux_server::workflows::engine::{self, Trigger};
use supermux_server::{db, sessions};

const TOKEN: &str = "archive-workflow-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-arch-wf-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        swarm_reaper: Default::default(),
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        company_isolation: Vec::new(),
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
        archive_on_stop: false,
        config_dir: String::new(),
    }
}

/// A one-step recurring workflow — today's `tmux_schedule` fixture, retyped.
async fn nightly_ping(state: &AppState, id: &str, session: &str) -> Workflow {
    let now = chrono::Utc::now().timestamp();
    let wf = Workflow {
        id: id.to_string(),
        title: "nightly ping".into(),
        session: session.to_string(),
        company_id: None,
        enabled: 1,
        trigger_kind: "recurring".into(),
        schedule_expr: Some("every 1 minute".into()),
        next_run: None,
        last_run: None,
        run_count: 0,
        on_complete: r#"{"kind":"notify"}"#.into(),
        created: now,
        updated: now,
        deleted: None,
    };
    let wf = db::workflows::insert(&state.pool, &wf).await.unwrap();
    db::workflows::replace_steps(
        &state.pool,
        id,
        &[StepInput { prompt: "status?".into(), ..Default::default() }],
    )
    .await
    .unwrap();
    wf
}

async fn wait_for_run(state: &AppState, workflow_id: &str) -> db::workflows::WorkflowRun {
    for _ in 0..200 {
        let runs = db::workflows::runs_for(&state.pool, workflow_id, 10).await.unwrap();
        if let Some(r) = runs.iter().find(|r| r.status != "running") {
            return r.clone();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the workflow never recorded a terminal run");
}

/// T5.1 — the regression. Archive a session that owns an enabled workflow, fire
/// it, and assert the session is NOT started and the run is recorded with an
/// explicit, readable status.
#[tokio::test]
async fn an_archived_sessions_workflow_does_not_resurrect_it() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("ghost", &dir)).await.unwrap();
    let wf = nightly_ping(&state, "WF-ghost", "ghost").await;

    // Archive it. (The DB-level flip is what the engine must observe; the full
    // `lifecycle::archive` also stops a runtime, which needs a live pty.)
    db::sessions::set_archived(&state.pool, "ghost", true).await.unwrap();
    assert!(
        !db::sessions::exists_active(&state.pool, "ghost").await.unwrap(),
        "precondition: the session is archived"
    );

    engine::start(&state, wf, Trigger::Tick).await.unwrap();
    let run = wait_for_run(&state, "WF-ghost").await;

    // It must still be archived — no resurrection.
    assert!(
        !db::sessions::exists_active(&state.pool, "ghost").await.unwrap(),
        "the workflow resurrected an archived session"
    );

    // And the run must say so, readably.
    assert_eq!(
        run.status, "skipped",
        "an archived target is a skip, not an error and not an ok"
    );
    assert!(run.note.contains("archived"), "the note names the reason: {:?}", run.note);
    let steps = db::workflows::step_runs_for(&state.pool, run.id).await.unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].status, "skipped", "the STEP is skipped too, not sent");
}

/// The other half of the contract: unarchiving resumes the workflow. Nothing
/// was mutated on the `workflows` row, so this is automatic — this test is what
/// stops a future implementation from "fixing" the bug by disabling the rows.
#[tokio::test]
async fn unarchiving_resumes_the_workflow_without_touching_its_row() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("back", &dir)).await.unwrap();
    let wf = nightly_ping(&state, "WF-back", "back").await;

    db::sessions::set_archived(&state.pool, "back", true).await.unwrap();
    engine::start(&state, wf, Trigger::Tick).await.unwrap();
    wait_for_run(&state, "WF-back").await;

    let after_archive = db::workflows::get(&state.pool, "WF-back")
        .await
        .unwrap()
        .expect("the workflow survives the skip");
    assert_eq!(
        after_archive.enabled, 1,
        "the skip must not disable the workflow — the pause is a function of \
         sessions.archived, so unarchive alone restores it"
    );

    db::sessions::set_archived(&state.pool, "back", false).await.unwrap();
    assert!(
        db::sessions::exists_active(&state.pool, "back").await.unwrap(),
        "unarchived sessions are active again"
    );
}

/// The guard lives at the send, not only at the engine: any caller trying to
/// deliver text to an archived session gets a 404, never a silent auto-start.
#[tokio::test]
async fn send_text_refuses_an_archived_session_instead_of_starting_it() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("hidden", &dir)).await.unwrap();
    db::sessions::set_archived(&state.pool, "hidden", true).await.unwrap();

    let err = sessions::lifecycle::send_harness_text(&state, "hidden", "hello", None, None)
        .await
        .expect_err("an archived session is not a send target");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("NotFound"),
        "archive-blind `exists` would have auto-started it; got {msg}"
    );
}
