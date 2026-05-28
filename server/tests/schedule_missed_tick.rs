//! Missed-tick recovery (TECH_PLAN §3.8 v2, §7 testing strategy; Codex #6).
//!
//! A schedule whose `next_run` is far in the past must NOT burst-fire on the next
//! tick: the tick logs a `skipped` run and ADVANCES `next_run` to the future
//! without executing the job. Paired with `schedule_run_keys` UNIQUE, this is
//! what stops double/late fires after a laptop sleep or process restart.

use std::path::PathBuf;
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, scheduler};

use chrono::Utc;

async fn new_state() -> (AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-missed-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: "missed-test-token".to_string(),
        provider_defaults: ProviderDefaults::default(),
        // `ws` was added to `Config` after this test's milestone branched; default
        // it so the full suite compiles against the merged `Config`.
        ws: WsConfig::default(),
        remote_callback_url: None,
            push_sub: None,
            github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

#[tokio::test]
async fn missed_window_skips_and_advances_without_firing() {
    let (state, dir) = new_state().await;
    let marker = dir.join("should-not-exist.txt");

    // A recurring shell job that, if it fired, would create the marker.
    let sched = scheduler::create(
        &state,
        scheduler::CreateScheduleInput {
            title: "missed".into(),
            command: format!("touch {}", marker.display()),
            kind: Some("shell".into()),
            schedule_expr: Some("every 1m".into()),
            ..Default::default()
        },
    )
    .await
    .expect("create schedule");

    // Force next_run 5 minutes into the past (well beyond the 60s missed window).
    let past = (Utc::now() - chrono::Duration::seconds(300)).to_rfc3339();
    sqlx::query("UPDATE schedules SET next_run = ? WHERE id = ?")
        .bind(&past)
        .bind(&sched.id)
        .execute(&state.pool)
        .await
        .unwrap();

    // First interval tick fires immediately on spawn; give it a beat to process.
    scheduler::spawn(state.clone());
    tokio::time::sleep(Duration::from_secs(2)).await;

    // The job must NOT have run.
    assert!(!marker.exists(), "missed schedule must not fire its job");

    // A 'skipped' run row must be recorded, and no 'ok' row.
    let runs = db::schedules::runs_for(&state.pool, &sched.id, 20).await.unwrap();
    assert!(
        runs.iter().any(|r| r.status == "skipped" && r.note == "missed window"),
        "expected a skipped/missed-window run, got {runs:?}"
    );
    assert!(!runs.iter().any(|r| r.status == "ok"), "must not record an ok run");

    // next_run must have advanced to the future; run_count untouched (no fire).
    let after = db::schedules::get(&state.pool, &sched.id).await.unwrap().unwrap();
    let next = chrono::DateTime::parse_from_rfc3339(after.next_run.as_deref().unwrap()).unwrap();
    assert!(next.with_timezone(&Utc) > Utc::now(), "next_run should be in the future");
    assert_eq!(after.run_count, 0, "missed window must not bump run_count");
    assert_eq!(after.enabled, 1, "recurring schedule stays enabled");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// `schedule_run_keys` UNIQUE makes a duplicate fire-key claim a no-op — the
/// idempotency guard the runner relies on to avoid double-fires on restart.
#[tokio::test]
async fn fire_key_is_idempotent() {
    let (state, dir) = new_state().await;
    let sched = scheduler::create(
        &state,
        scheduler::CreateScheduleInput {
            title: "idem".into(),
            command: "true".into(),
            kind: Some("shell".into()),
            schedule_expr: Some("every 1m".into()),
            ..Default::default()
        },
    )
    .await
    .expect("create schedule");

    let ts = Utc::now().timestamp();
    let first = db::schedules::claim_run_key(&state.pool, &sched.id, ts).await.unwrap();
    let second = db::schedules::claim_run_key(&state.pool, &sched.id, ts).await.unwrap();
    assert!(first, "first claim wins");
    assert!(!second, "second claim for the same fire-time is rejected");

    // A different fire-time is a fresh claim.
    let other = db::schedules::claim_run_key(&state.pool, &sched.id, ts + 60).await.unwrap();
    assert!(other);

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
