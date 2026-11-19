//! The chain, asserted end to end.
//!
//! Workflows v1 replaces `done_pattern` polling with the one signal that was
//! already load-bearing in `scheduler/watch.rs`: the per-session status→idle
//! EDGE, plus the agent-confirm hook as its equal-ranked sibling. A chain is
//! that signal in a loop (spec §3.1):
//!
//! ```text
//! send step k  →  await (idle-edge | agent-confirm | timeout)  →  record  →  k+1
//! ```
//!
//! Everything below exists to keep that sentence true under the four ways it
//! can go wrong: a step that never finishes, a session archived underneath the
//! chain, a second tick landing while the first run is still in flight, and two
//! completion signals arriving for the same step.

use std::path::PathBuf;
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db::workflows::{StepInput, Workflow};
use supermux_server::state::AppState;
use supermux_server::workflows::engine::{self, Trigger};
use supermux_server::{db, sessions};

// ── harness ──────────────────────────────────────────────────────────────────

async fn new_state() -> (AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-wf-chain-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        swarm_reaper: Default::default(),
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "wf-chain-token".to_string(),
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

/// A live `shell`-provider session — the only kind a unit test can genuinely
/// deliver into, and enough for the chain: the engine's signal is the status
/// channel, which the test drives by hand exactly as the detector would.
async fn live_session(state: &AppState, name: &str, dir: &std::path::Path) {
    db::sessions::insert_minimal(&state.pool, name, dir.to_str().unwrap(), "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, name, "hook-token").await.unwrap();
}

async fn workflow_with(
    state: &AppState,
    id: &str,
    session: &str,
    steps: &[StepInput],
) -> Workflow {
    let now = chrono::Utc::now().timestamp();
    let wf = Workflow {
        id: id.to_string(),
        title: "Weekly report".into(),
        session: session.to_string(),
        company_id: None,
        enabled: 1,
        trigger_kind: "manual".into(),
        schedule_expr: None,
        next_run: None,
        last_run: None,
        run_count: 0,
        on_complete: r#"{"kind":"none"}"#.into(),
        created: now,
        updated: now,
        deleted: None,
    };
    let wf = db::workflows::insert(&state.pool, &wf).await.unwrap();
    db::workflows::replace_steps(&state.pool, id, steps).await.unwrap();
    wf
}

fn step(prompt: &str) -> StepInput {
    StepInput { prompt: prompt.into(), ..Default::default() }
}

/// The status→idle EDGE the detector would publish when a turn ends: a NEW
/// version, so a session that was already idle does not count as this step
/// finishing.
fn idle_edge(state: &AppState, session: &str) {
    let tx = state.status_watch_for(session);
    let next = tx.borrow().1 + 1;
    tx.send_replace(("idle".to_string(), next));
}

/// Poll until `f` holds or ~10s elapse. The chain is genuinely asynchronous —
/// a fixed sleep would be either flaky or slow, and this is neither.
async fn until<F, Fut>(what: &str, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..200 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for: {what}");
}

/// True once `preview` is the session's LAST SEND — i.e. the step's text is
/// genuinely on the pty. The engine subscribes to the status channel BEFORE it
/// sends (the baseline race, spec §3.3/3), so a test that waits for this is
/// guaranteed to have a watcher listening when it fires the edge. Waiting only
/// for the step-run row is not enough: that row is opened before the send.
async fn delivered(state: &AppState, session: &str, preview: &str) -> bool {
    db::sessions::get(&state.pool, session)
        .await
        .unwrap()
        .map(|s| s.last_send_text == preview)
        .unwrap_or(false)
}

async fn step_runs(state: &AppState, run_id: i64) -> Vec<db::workflows::WorkflowStepRun> {
    db::workflows::step_runs_for(&state.pool, run_id).await.unwrap()
}

async fn run_status(state: &AppState, run_id: i64) -> String {
    sqlx::query_scalar::<_, String>("SELECT status FROM workflow_runs WHERE id = ?")
        .bind(run_id)
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

async fn run_note(state: &AppState, run_id: i64) -> String {
    sqlx::query_scalar::<_, String>("SELECT note FROM workflow_runs WHERE id = ?")
        .bind(run_id)
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

// ── the cases ────────────────────────────────────────────────────────────────

/// The single most important assertion in this file: the chain is EDGE-driven,
/// not timer-driven. Step 2 must not exist until step 1's idle edge fires.
#[tokio::test]
async fn a_three_step_chain_advances_only_on_the_idle_edge() {
    let (state, dir) = new_state().await;
    live_session(&state, "chain", &dir).await;
    let wf = workflow_with(
        &state,
        "WF-chain",
        "chain",
        &[step("step one"), step("step two"), step("step three")],
    )
    .await;

    let run_id = engine::start(&state, wf, Trigger::Manual).await.unwrap();

    until("step 1 delivered", || async { delivered(&state, "chain", "step one").await }).await;
    // …and it STAYS at one. No timer advances this chain.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let after = step_runs(&state, run_id).await;
    assert_eq!(after.len(), 1, "step 2 was delivered before step 1's idle edge: {after:?}");
    assert_eq!(after[0].status, "running");
    assert_eq!(after[0].preview, "step one", "the preview is the plain prompt line");

    idle_edge(&state, "chain");
    until("step 2 delivered", || async { delivered(&state, "chain", "step two").await }).await;
    let after = step_runs(&state, run_id).await;
    assert_eq!(after[0].status, "ok");
    assert_eq!(after[0].signal, "status-idle", "the idle EDGE is what advanced it");

    idle_edge(&state, "chain");
    until("step 3 delivered", || async { delivered(&state, "chain", "step three").await }).await;

    idle_edge(&state, "chain");
    until("the run finishes ok", || async { run_status(&state, run_id).await == "ok" }).await;
    let all = step_runs(&state, run_id).await;
    assert_eq!(all.len(), 3);
    assert!(all.iter().all(|s| s.status == "ok"), "{all:?}");
    assert_eq!(all.iter().map(|s| s.position).collect::<Vec<_>>(), vec![0, 1, 2]);

    let _ = sessions::lifecycle::stop(&state, "chain").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A step that never confirms halts the chain LOUDLY: the run is `timeout`, the
/// step after it is never delivered, and the user is told.
#[tokio::test]
async fn a_step_timeout_halts_the_chain_loudly() {
    let (state, dir) = new_state().await;
    live_session(&state, "slow", &dir).await;
    let wf = workflow_with(
        &state,
        "WF-slow",
        "slow",
        &[
            step("step one"),
            StepInput { prompt: "step two".into(), timeout_secs: Some(1), ..Default::default() },
            step("step three"),
        ],
    )
    .await;

    let run_id = engine::start(&state, wf, Trigger::Manual).await.unwrap();
    until("step 1 delivered", || async { delivered(&state, "slow", "step one").await }).await;
    idle_edge(&state, "slow");
    until("step 2 delivered", || async { delivered(&state, "slow", "step two").await }).await;

    // Nothing else is sent; step 2's own 1s deadline elapses.
    until("the run times out", || async { run_status(&state, run_id).await == "timeout" }).await;
    let all = step_runs(&state, run_id).await;
    assert_eq!(all.len(), 2, "step 3 must NEVER be delivered: {all:?}");
    assert_eq!(all[1].status, "timeout");
    assert_eq!(all[1].signal, "timeout");
    assert!(
        run_note(&state, run_id).await.contains("step 2/3"),
        "the note names WHICH step stalled: {:?}",
        run_note(&state, run_id).await
    );

    let _ = sessions::lifecycle::stop(&state, "slow").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The archive contract, mid-chain. Archiving PAUSES a workflow; the chain
/// stops with a readable skip and the session is never resurrected.
#[tokio::test]
async fn archiving_the_session_mid_chain_halts_with_a_readable_skip_and_never_starts_it() {
    let (state, dir) = new_state().await;
    live_session(&state, "vanish", &dir).await;
    let wf = workflow_with(
        &state,
        "WF-vanish",
        "vanish",
        &[step("step one"), step("step two")],
    )
    .await;

    let run_id = engine::start(&state, wf, Trigger::Manual).await.unwrap();
    until("step 1 delivered", || async { delivered(&state, "vanish", "step one").await }).await;

    // Archive underneath the running chain, then let step 1 finish.
    db::sessions::set_archived(&state.pool, "vanish", true).await.unwrap();
    idle_edge(&state, "vanish");

    until("the run is skipped", || async { run_status(&state, run_id).await == "skipped" }).await;
    let note = run_note(&state, run_id).await;
    assert!(note.contains("archived"), "the note names the reason: {note:?}");
    assert!(
        !db::sessions::exists_active(&state.pool, "vanish").await.unwrap(),
        "the chain resurrected an archived session"
    );
    let all = step_runs(&state, run_id).await;
    assert_eq!(all.len(), 2);
    assert_eq!(all[1].status, "skipped", "step 2 was recorded as skipped, not sent");

    let _ = sessions::lifecycle::stop(&state, "vanish").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// §3.2 rule 2. A chain can outlive its own cadence; two interleaved chains in
/// one pane would be indistinguishable garbage in the transcript.
#[tokio::test]
async fn two_due_ticks_while_a_run_is_in_flight_produce_one_skipped_run_not_a_second_chain() {
    let (state, dir) = new_state().await;
    live_session(&state, "busy", &dir).await;
    let wf = workflow_with(&state, "WF-busy", "busy", &[step("step one"), step("step two")]).await;

    let first = engine::start(&state, wf.clone(), Trigger::Tick).await.unwrap();
    until("step 1 delivered", || async { delivered(&state, "busy", "step one").await }).await;

    let second = engine::start(&state, wf.clone(), Trigger::Tick).await.unwrap();
    assert_ne!(second, first);
    assert_eq!(run_status(&state, second).await, "skipped");
    assert!(
        run_note(&state, second).await.contains("still in flight"),
        "{:?}",
        run_note(&state, second).await
    );
    assert!(step_runs(&state, second).await.is_empty(), "the skipped run sent nothing");
    assert_eq!(
        step_runs(&state, first).await.len(),
        1,
        "the in-flight chain was not advanced by the second tick"
    );

    let _ = sessions::lifecycle::stop(&state, "busy").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The per-RUN fire guard. Both completion signals for the same step collapse to
/// exactly one advance — and the guard is run-scoped, so the workflow's NEXT run
/// still fires.
#[tokio::test]
async fn the_idle_edge_and_the_agent_hook_cannot_both_advance_the_same_step() {
    let (state, dir) = new_state().await;
    live_session(&state, "double", &dir).await;
    let wf =
        workflow_with(&state, "WF-double", "double", &[step("step one"), step("step two")]).await;

    let run_id = engine::start(&state, wf.clone(), Trigger::Manual).await.unwrap();
    until("step 1 delivered", || async { delivered(&state, "double", "step one").await }).await;

    // Fire BOTH signals for step 1.
    engine::confirm_step_done(&state, run_id, "double").await;
    idle_edge(&state, "double");

    until("step 2 delivered", || async { delivered(&state, "double", "step two").await }).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let all = step_runs(&state, run_id).await;
    assert_eq!(all.len(), 2, "step 1 advanced twice: {all:?}");
    assert_eq!(
        all.iter().filter(|s| s.position == 0).count(),
        1,
        "exactly one step-run row for step 1"
    );

    // Finish it, then prove the guard did NOT wedge the workflow: the next run
    // fires its step 1 again. (A workflow-scoped guard would have.)
    idle_edge(&state, "double");
    until("the first run finishes", || async { run_status(&state, run_id).await == "ok" }).await;

    let again = engine::start(&state, wf, Trigger::Manual).await.unwrap();
    assert_ne!(again, run_id);
    until("the second run delivers its step 1", || async {
        step_runs(&state, again).await.len() == 1
    })
    .await;
    assert_eq!(step_runs(&state, again).await[0].position, 0);

    let _ = sessions::lifecycle::stop(&state, "double").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// **Regression (the run-key collision).** `workflow_runs.id` is a per-database
/// AUTOINCREMENT, so the first run of every database is `1` — while the engine's
/// fire guard and waker map are process-global `static`s. Keyed on the bare run
/// id, two `AppState`s in one process collide on `1`: the first chain's claim
/// swallows the second's advance, and the first chain's waker is overwritten by
/// the second's. Both chains then stall at step 1, forever.
///
/// Two independent states, both with run id 1, both must advance.
#[tokio::test]
async fn two_chains_in_one_process_do_not_share_a_fire_guard_slot() {
    let (state_a, dir_a) = new_state().await;
    let (state_b, dir_b) = new_state().await;
    live_session(&state_a, "twinA", &dir_a).await;
    live_session(&state_b, "twinB", &dir_b).await;
    let wf_a = workflow_with(&state_a, "WF-twin", "twinA", &[step("a one"), step("a two")]).await;
    let wf_b = workflow_with(&state_b, "WF-twin", "twinB", &[step("b one"), step("b two")]).await;

    let run_a = engine::start(&state_a, wf_a, Trigger::Manual).await.unwrap();
    let run_b = engine::start(&state_b, wf_b, Trigger::Manual).await.unwrap();
    // The precondition that made the bug possible — same id, same workflow id,
    // different databases.
    assert_eq!(run_a, 1);
    assert_eq!(run_b, 1);

    until("A step 1 delivered", || async { delivered(&state_a, "twinA", "a one").await }).await;
    until("B step 1 delivered", || async { delivered(&state_b, "twinB", "b one").await }).await;

    idle_edge(&state_a, "twinA");
    idle_edge(&state_b, "twinB");

    // Neither chain may be swallowed by the other's claim.
    until("A step 2 delivered", || async { delivered(&state_a, "twinA", "a two").await }).await;
    until("B step 2 delivered", || async { delivered(&state_b, "twinB", "b two").await }).await;
    assert_eq!(step_runs(&state_a, run_a).await.len(), 2);
    assert_eq!(step_runs(&state_b, run_b).await.len(), 2);

    let _ = sessions::lifecycle::stop(&state_a, "twinA").await;
    let _ = sessions::lifecycle::stop(&state_b, "twinB").await;
    state_a.pool.close().await;
    state_b.pool.close().await;
    let _ = std::fs::remove_dir_all(dir_a);
    let _ = std::fs::remove_dir_all(dir_b);
}

/// The confirm footer hands the agent a run id in PLAINTEXT, in its own pane, so
/// the id is not a secret. The step-done hook must therefore check that the run
/// belongs to the session whose hook token authenticated the call — otherwise
/// any bot could advance any other bot's chain by guessing a small integer.
#[tokio::test]
async fn a_step_done_hook_from_another_bot_cannot_advance_the_chain() {
    let (state, dir) = new_state().await;
    live_session(&state, "owner", &dir).await;
    live_session(&state, "stranger", &dir).await;
    let wf = workflow_with(&state, "WF-owned", "owner", &[step("step one"), step("step two")]).await;

    let run_id = engine::start(&state, wf, Trigger::Manual).await.unwrap();
    until("step 1 delivered", || async { delivered(&state, "owner", "step one").await }).await;

    // A different bot confirms the same run id.
    engine::confirm_step_done(&state, run_id, "stranger").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        step_runs(&state, run_id).await.len(),
        1,
        "a stranger's hook advanced somebody else's chain"
    );

    // The owner's confirmation still works.
    engine::confirm_step_done(&state, run_id, "owner").await;
    until("step 2 delivered", || async { delivered(&state, "owner", "step two").await }).await;
    let all = step_runs(&state, run_id).await;
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].signal, "agent-confirmed");

    let _ = sessions::lifecycle::stop(&state, "owner").await;
    let _ = sessions::lifecycle::stop(&state, "stranger").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
