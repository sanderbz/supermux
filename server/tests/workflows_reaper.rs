//! The crash reaper (§3.6) — new in Workflows v1.
//!
//! Watchers are in-memory tokio tasks, so a restart mid-step loses one. Today
//! that is SILENT: the schedule's `done_action` never fires and nobody is told.
//! In a chain it is worse — the run sits `running` forever, and §3.2 rule 2
//! ("one run at a time") then blocks the workflow from ever firing again.
//!
//! The reaper is what makes that failure honest and self-healing.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db::workflows::{StepInput, Workflow};
use supermux_server::state::AppState;
use supermux_server::workflows;
use supermux_server::workflows::engine;
use supermux_server::{db, sessions};

use chrono::Utc;

async fn new_state() -> (AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-wf-reap-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        swarm_reaper: Default::default(),
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "wf-reap-token".to_string(),
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
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

/// A four-step workflow on a live bot, with short per-step deadlines so the
/// reaper's arithmetic is testable in seconds rather than half an hour.
async fn seed(state: &AppState, dir: &std::path::Path, id: &str, session: &str) -> Workflow {
    db::sessions::insert_minimal(&state.pool, session, dir.to_str().unwrap(), "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, session, "hook-token").await.unwrap();
    let now = Utc::now().timestamp();
    let wf = Workflow {
        id: id.to_string(),
        title: "Weekly report".into(),
        session: session.to_string(),
        company_id: None,
        enabled: 1,
        trigger_kind: "recurring".into(),
        schedule_expr: Some("every 1m".into()),
        next_run: Some((Utc::now() + chrono::Duration::seconds(120)).to_rfc3339()),
        last_run: None,
        run_count: 0,
        on_complete: r#"{"kind":"none"}"#.into(),
        created: now,
        updated: now,
        deleted: None,
    };
    let wf = db::workflows::insert(&state.pool, &wf).await.unwrap();
    let steps: Vec<StepInput> = (1..=4)
        .map(|i| StepInput {
            prompt: format!("step {i}"),
            timeout_secs: Some(10),
            ..Default::default()
        })
        .collect();
    db::workflows::replace_steps(&state.pool, id, &steps).await.unwrap();
    wf
}

/// Leave the DB in exactly the shape a kill -9 mid-step leaves it: a `running`
/// run, an open step run at `position`, and a heartbeat that stopped `age`
/// seconds ago.
async fn abandoned_run(state: &AppState, wf_id: &str, position: i64, age: i64) -> i64 {
    let run_id = db::workflows::open_run(&state.pool, wf_id, "tick").await.unwrap();
    let steps = db::workflows::steps_for(&state.pool, wf_id).await.unwrap();
    let step = &steps[position as usize];
    db::workflows::open_step_run(&state.pool, run_id, &step.id, position, &step.prompt)
        .await
        .unwrap();
    let stamp = Utc::now().timestamp() - age;
    sqlx::query("UPDATE workflow_runs SET heartbeat = ?, current_step = ? WHERE id = ?")
        .bind(stamp)
        .bind(position)
        .bind(run_id)
        .execute(&state.pool)
        .await
        .unwrap();
    run_id
}

async fn run_row(state: &AppState, run_id: i64) -> db::workflows::WorkflowRun {
    sqlx::query_as::<_, db::workflows::WorkflowRun>("SELECT * FROM workflow_runs WHERE id = ?")
        .bind(run_id)
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_run_whose_heartbeat_went_stale_is_reaped_to_interrupted_and_the_workflow_fires_again() {
    let (state, dir) = new_state().await;
    seed(&state, &dir, "WF-reap", "reapbot").await;
    let mut sse = state.sse_tx.subscribe();

    // Step 2 of 4 (index 1), heartbeat older than its 10s timeout + 60s grace.
    let run_id = abandoned_run(&state, "WF-reap", 1, 10 + 61).await;

    engine::reap(&state).await;

    let run = run_row(&state, run_id).await;
    assert_eq!(run.status, "interrupted");
    assert!(
        run.note.contains("'Weekly report' was interrupted at step 2 of 4"),
        "the note names the step: {:?}",
        run.note
    );
    assert!(run.finished_at.is_some(), "a reaped run is closed, not left dangling");

    let steps = db::workflows::step_runs_for(&state.pool, run_id).await.unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].status, "interrupted", "the open step run is closed too");
    assert!(steps[0].finished_at.is_some());

    // Told once, out loud.
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), sse.recv())
        .await
        .expect("an alerts frame is raised")
        .expect("sse");
    assert_eq!(frame.event, "alerts");
    assert_eq!(frame.payload["source"], "workflows");
    assert_eq!(frame.payload["status"], "interrupted");
    assert!(
        frame.payload["detail"].as_str().unwrap_or("").contains("step 2 of 4"),
        "{:?}",
        frame.payload
    );

    // …and the workflow is unblocked: rule 2 no longer sees a run in flight, so
    // the next due window fires normally.
    assert!(
        db::workflows::running_for(&state.pool, "WF-reap").await.unwrap().is_none(),
        "nothing is left in flight"
    );
    sqlx::query("UPDATE workflows SET next_run = ? WHERE id = 'WF-reap'")
        .bind((Utc::now() - chrono::Duration::seconds(1)).to_rfc3339())
        .execute(&state.pool)
        .await
        .unwrap();
    workflows::tick_once(&state).await.unwrap();
    for _ in 0..200 {
        let sess = db::sessions::get(&state.pool, "reapbot").await.unwrap().unwrap();
        if sess.last_send_text == "step 1" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let sess = db::sessions::get(&state.pool, "reapbot").await.unwrap().unwrap();
    assert_eq!(sess.last_send_text, "step 1", "the next cadence fired the chain again");

    let _ = sessions::lifecycle::stop(&state, "reapbot").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The negative. A step that is genuinely still working — its heartbeat inside
/// its own deadline — must not be killed by the sweep it shares a tick with.
#[tokio::test]
async fn a_fresh_running_run_is_not_reaped() {
    let (state, dir) = new_state().await;
    seed(&state, &dir, "WF-fresh", "freshbot").await;

    // Well inside the 10s step timeout + 60s grace.
    let run_id = abandoned_run(&state, "WF-fresh", 0, 5).await;

    engine::reap(&state).await;

    let run = run_row(&state, run_id).await;
    assert_eq!(run.status, "running", "a live run was reaped out from under its watcher");
    assert!(run.finished_at.is_none());
    let steps = db::workflows::step_runs_for(&state.pool, run_id).await.unwrap();
    assert_eq!(steps[0].status, "running");

    let _ = sessions::lifecycle::stop(&state, "freshbot").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
