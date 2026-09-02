//! T7 — what `delete` and `purge` actually dispose of, asserted.
//!
//! §15.3 asks for "delete honesty: enumerate what is/isn't removed". The audit
//! found the enumeration was not just missing from the UI — one row of it was
//! WRONG in the code. `workflows.session` is a bare `TEXT NOT NULL` with no FK
//! (`0038_workflows.sql`, deliberately — spec §2.4), so deleting or purging a
//! session left its jobs pointing at a name that no longer resolves. Every tick
//! then failed its existence check, recorded an error run, **and pushed a
//! notification to the user's phone** — forever, for a session they deleted.
//!
//! The disposition chosen (T7.1): the workflows are **soft-deleted**
//! (`deleted = now`), not hard-deleted. The tick loop filters `deleted IS NULL`
//! so firing stops immediately, while `workflow_runs` — which FK-CASCADEs off
//! `workflows(id)` and would be destroyed by a hard DELETE — keeps its history.
//! "The workflow stops and won't run again. Past runs stay in the log." is
//! already the copy on the manual delete path; this makes the implicit path
//! behave the same way.
//!
//! Workflows v1 note: `workflows.session` being unkeyed is now a WRITTEN-DOWN
//! choice with four named cascades (rename / delete / duplicate / archive), and
//! three of the four are asserted here.
//!
//! R3's mitigation: this file is the disposition table *as a test*, so a future
//! change to either handler that forgets the copy fails CI rather than turning
//! the dialog into a lie.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::workflows::{StepInput, Workflow};
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
        swarm_reaper: Default::default(),
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

fn workflow(id: &str, session: &str) -> Workflow {
    let now = chrono::Utc::now().timestamp();
    Workflow {
        id: id.to_string(),
        title: "orphan candidate".to_string(),
        session: session.to_string(),
        company_id: None,
        enabled: 1,
        trigger_kind: "recurring".to_string(),
        schedule_expr: Some("every 1 minute".to_string()),
        next_run: Some((chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339()),
        last_run: None,
        run_count: 0,
        on_complete: r#"{"kind":"notify"}"#.to_string(),
        created: now,
        updated: now,
        deleted: None,
    }
}

fn step(prompt: &str) -> StepInput {
    StepInput { prompt: prompt.to_string(), ..Default::default() }
}

/// T7.1 — the orphan fix, stated as an invariant: **no workflow survives its
/// session**. This is the failing test the fix was written against.
#[tokio::test]
async fn no_workflow_survives_its_session_delete() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("doomed", &dir))
        .await
        .unwrap();
    db::workflows::insert(&state.pool, &workflow("s-doomed", "doomed"))
        .await
        .unwrap();

    // Precondition: the tick loop can see it.
    let due = db::workflows::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        due.iter().any(|s| s.id == "s-doomed"),
        "precondition: the workflow is live to the tick loop"
    );

    db::sessions::delete(&state.pool, "doomed").await.unwrap();

    let due = db::workflows::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        !due.iter().any(|s| s.id == "s-doomed"),
        "the deleted session's workflow is still firing — every tick errors and \
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
async fn no_workflow_survives_its_session_purge() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("purged", &dir))
        .await
        .unwrap();
    db::workflows::insert(&state.pool, &workflow("s-purged", "purged"))
        .await
        .unwrap();
    db::sessions::set_archived(&state.pool, "purged", true)
        .await
        .unwrap();

    sessions::purge(&state, "purged").await.expect("purge");

    let due = db::workflows::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        !due.iter().any(|s| s.id == "s-purged"),
        "the purged session's workflow is still firing"
    );
}

/// The disposition is a SOFT delete, and that distinction is load-bearing:
/// `workflow_runs` FK-CASCADEs off `workflows(id)`, so hard-deleting the
/// workflow would take the run ledger with it. "Past runs stay in the log" is
/// the promise the manual delete path already makes; the implicit path
/// keeps it too.
#[tokio::test]
async fn deleting_a_session_soft_deletes_its_workflows_and_keeps_the_run_log() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("historic", &dir))
        .await
        .unwrap();
    db::workflows::insert(&state.pool, &workflow("s-historic", "historic"))
        .await
        .unwrap();
    db::workflows::insert_run(
        &state.pool,
        "s-historic",
        chrono::Utc::now().timestamp(),
        "tick",
        "ok",
        "sent to historic",
    )
    .await
    .unwrap();

    db::sessions::delete(&state.pool, "historic").await.unwrap();

    let runs = db::workflows::runs_for(&state.pool, "s-historic", 10)
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
/// it just was never named as one. It must NOT dispose of the workflows: T5's
/// contract is that they are *paused* (a pure function of `sessions.archived`)
/// and resume on unarchive. This test is what stops T7's fix from being
/// implemented one layer too high and quietly destroying them.
#[tokio::test]
async fn archive_preserves_the_workflows_it_only_pauses_them() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("resting", &dir))
        .await
        .unwrap();
    db::workflows::insert(&state.pool, &workflow("s-resting", "resting"))
        .await
        .unwrap();

    db::sessions::set_archived(&state.pool, "resting", true)
        .await
        .unwrap();

    let sched = db::workflows::get(&state.pool, "s-resting")
        .await
        .unwrap()
        .expect("archive must not delete the workflow — it is reversible");
    assert!(sched.deleted.is_none(), "archive is not a disposition");
    assert_eq!(sched.enabled, 1, "the row is untouched; the pause is dynamic");
}

/// Purge refuses a live session (409) and an absent one (404) BEFORE anything
/// destructive runs — so a failed purge disposes of nothing, workflows
/// included. Guards the ordering, not just the outcome.
#[tokio::test]
async fn a_refused_purge_disposes_of_nothing() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("live", &dir))
        .await
        .unwrap();
    db::workflows::insert(&state.pool, &workflow("s-live", "live"))
        .await
        .unwrap();

    // Not archived → 409, and nothing is touched.
    sessions::purge(&state, "live")
        .await
        .expect_err("purge must refuse a live session");
    let due = db::workflows::enabled_with_next(&state.pool).await.unwrap();
    assert!(
        due.iter().any(|s| s.id == "s-live"),
        "a refused purge must not have disposed of the workflow"
    );
    assert!(db::sessions::exists(&state.pool, "live").await.unwrap());

    // Unknown name → 404.
    sessions::purge(&state, "no-such-session")
        .await
        .expect_err("purge of an unknown session is a 404");
}

/// **Rename** — the second of the four cascades (spec §2.4). `workflows.session`
/// is unkeyed TEXT, so deferred-FK does not reach it: without the explicit
/// `UPDATE workflows SET session = ?` in `db::sessions::rename`, renaming a bot
/// orphans every job it owns — pointed at a slug that no longer resolves.
#[tokio::test]
async fn renaming_a_session_repoints_its_workflows() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("scout", &dir))
        .await
        .unwrap();
    db::workflows::insert(&state.pool, &workflow("wf-renamed", "scout"))
        .await
        .unwrap();

    db::sessions::rename(&state.pool, "scout", "recon").await.unwrap();

    let wf = db::workflows::get(&state.pool, "wf-renamed")
        .await
        .unwrap()
        .expect("a rename must not lose the workflow");
    assert_eq!(wf.session, "recon", "the workflow follows its bot's new name");
    assert!(
        db::workflows::list_for_session(&state.pool, "scout").await.unwrap().is_empty(),
        "nothing is left pointing at the old slug — that is what orphans a job"
    );
}

/// **Duplicate** — the third cascade. A copy that arrived with the trigger but
/// an empty body would be exactly the bug `copy_for_session`'s doc-comment was
/// written to prevent, one level down: today's function copies zero children.
///
/// This exercises the two db calls `sessions::duplicate` makes back-to-back
/// (`db::sessions::duplicate` then `db::workflows::copy_for_session`), which is
/// the whole of the cascade — the rest of that handler is pty and detector work.
#[tokio::test]
async fn duplicating_a_session_copies_workflows_and_their_steps_disabled_with_reset_counters() {
    let (state, dir) = new_state().await;
    db::sessions::create(&state.pool, &new_session("template", &dir))
        .await
        .unwrap();

    let mut src = workflow("wf-template", "template");
    src.run_count = 7;
    src.last_run = Some("2026-08-01T09:00:00+00:00".to_string());
    db::workflows::insert(&state.pool, &src).await.unwrap();
    let src_steps = db::workflows::replace_steps(
        &state.pool,
        "wf-template",
        &[step("one"), step("two"), step("three")],
    )
    .await
    .unwrap();

    db::sessions::duplicate(&state.pool, "template", "template-copy").await.unwrap();
    let copied = db::workflows::copy_for_session(&state.pool, "template", "template-copy")
        .await
        .unwrap();
    assert_eq!(copied, 1);

    let copies = db::workflows::list_for_session(&state.pool, "template-copy").await.unwrap();
    assert_eq!(copies.len(), 1);
    let copy = &copies[0];
    assert_ne!(copy.id, "wf-template", "the copy is its own row, with its own fire-key space");
    assert!(copy.id.starts_with("WF-"));
    assert_eq!(copy.title, "orphan candidate");
    assert_eq!(copy.enabled, 0, "a copy that starts firing on its own is a surprise");
    assert_eq!(copy.run_count, 0, "inheriting the original's ledger would make the copy's log a lie");
    assert_eq!(copy.next_run, None);
    assert_eq!(copy.last_run, None);

    // The steps come too — same order, same bodies, NEW ids.
    let copy_steps = db::workflows::steps_for(&state.pool, &copy.id).await.unwrap();
    assert_eq!(copy_steps.len(), 3, "a workflow IS its ordered steps; a copy without them is broken");
    assert_eq!(copy_steps.iter().map(|s| s.position).collect::<Vec<_>>(), vec![0, 1, 2]);
    assert_eq!(
        copy_steps.iter().map(|s| s.prompt.as_str()).collect::<Vec<_>>(),
        vec!["one", "two", "three"]
    );
    for s in &copy_steps {
        assert!(s.id.starts_with("WS-"));
        assert!(!src_steps.iter().any(|o| o.id == s.id), "the copy's steps are its own");
    }

    // And the original is untouched.
    let original = db::workflows::get(&state.pool, "wf-template").await.unwrap().unwrap();
    assert_eq!(original.enabled, 1);
    assert_eq!(original.run_count, 7);
}
