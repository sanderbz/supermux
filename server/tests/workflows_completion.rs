//! The five typed completion actions (spec §5.3) — the curated replacement for
//! `done_action: command:<text>`.
//!
//! Two properties are asserted here that no amount of prose can hold:
//!
//! 1. **The dragon stays dead.** `on_complete` is a tagged enum with no
//!    free-text arm. An unknown `kind` is a 400 at the writer, not a default,
//!    and the agent hook path refuses the two outward-facing arms outright.
//! 2. **The honesty rule.** supermux has no MCP client. A `connector_send`
//!    completion is an INSTRUCTION delivered to the bot's pane — so every string
//!    the user reads says "asked scout to send via Gmail", never "sent". A
//!    completion action that cannot be honoured errors the run and pushes; it is
//!    NEVER a silent skip, because "email me the summary" failing quietly is
//!    worse than the workflow failing quietly.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db::workflows::{StepInput, Workflow};
use supermux_server::error::AppError;
use supermux_server::state::AppState;
use supermux_server::workflows::complete::{
    self, connector_instruction, CompletionAction, CompletionOutcome,
};
use supermux_server::{db, sessions};

use chrono::Utc;

async fn new_state() -> (AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-wf-complete-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        swarm_reaper: Default::default(),
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "wf-complete-token".to_string(),
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

async fn bot(state: &AppState, dir: &std::path::Path, name: &str, company_id: Option<i64>) {
    db::sessions::insert_minimal(&state.pool, name, dir.to_str().unwrap(), "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, name, "hook-token").await.unwrap();
    if let Some(cid) = company_id {
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = ?")
            .bind(cid)
            .bind(name)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}

/// A finished one-step workflow plus its closed run — the state `complete::fire`
/// is always handed.
async fn finished_run(
    state: &AppState,
    id: &str,
    session: &str,
    on_complete: &str,
) -> (Workflow, db::workflows::WorkflowRun) {
    let now = Utc::now().timestamp();
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
        on_complete: on_complete.to_string(),
        created: now,
        updated: now,
        deleted: None,
    };
    let wf = db::workflows::insert(&state.pool, &wf).await.unwrap();
    db::workflows::replace_steps(
        &state.pool,
        id,
        &[StepInput { prompt: "draft it".into(), ..Default::default() }],
    )
    .await
    .unwrap();
    let run_id = db::workflows::open_run(&state.pool, id, "manual").await.unwrap();
    db::workflows::close_run(&state.pool, run_id, "ok", "").await.unwrap();
    let run = db::workflows::get_run(&state.pool, run_id).await.unwrap().unwrap();
    (wf, run)
}

async fn install_gmail(state: &AppState, session: &str) -> String {
    db::connectors::upsert(
        &state.pool, "gmail", "mcp", "Gmail", "", "", "[]", "[]", "{}", "{}",
    )
    .await
    .unwrap();
    let account =
        db::connectors::account_add(&state.pool, "gmail", "sander@acme.com", None, None)
            .await
            .unwrap();
    db::connectors::grant_with_account(
        &state.pool, session, "gmail", None, true, Some(&account),
    )
    .await
    .unwrap();
    account
}

async fn run_row(state: &AppState, run_id: i64) -> db::workflows::WorkflowRun {
    db::workflows::get_run(&state.pool, run_id).await.unwrap().unwrap()
}

// ── the honesty rule ─────────────────────────────────────────────────────────

/// The load-bearing copy assertion. The server has no MCP client, so what it
/// does is ASK the bot — and every string built from the outcome says so.
#[tokio::test]
async fn the_connector_send_is_an_instruction_to_the_bot_and_says_asked_not_sent() {
    let (state, dir) = new_state().await;
    bot(&state, &dir, "scout", None).await;
    let account = install_gmail(&state, "scout").await;
    let (_, run) = finished_run(&state, "WF-ask", "scout", r#"{"kind":"none"}"#).await;

    let outcome = complete::fire(
        &state,
        &run,
        &CompletionAction::ConnectorSend {
            connector_id: "gmail".into(),
            account_ref: account,
            to: "sander@example.com".into(),
            subject: Some("Weekly report".into()),
        },
    )
    .await;

    let CompletionOutcome::Asked(text) = outcome else {
        panic!("a reachable connector send is an ASK, got {outcome:?}");
    };
    assert_eq!(text, "asked scout to send via Gmail");
    assert!(!text.contains("sent"), "the server cannot send anything itself: {text}");

    // What actually left the server is an instruction, in the bot's pane.
    let sess = db::sessions::get(&state.pool, "scout").await.unwrap().unwrap();
    assert_eq!(
        sess.last_send_text,
        "Use the Gmail connector (account sander@acme.com) to send the summary of this workflow \
         run to sander@example.com with subject \"Weekly report\". Do not include anything else."
    );
    // …and the run is still ok. Nothing failed.
    assert_eq!(run_row(&state, run.id).await.status, "ok");

    let _ = sessions::lifecycle::stop(&state, "scout").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn connector_send_with_a_revoked_grant_errors_the_run_and_pushes_never_silently_skips() {
    let (state, dir) = new_state().await;
    bot(&state, &dir, "scout", None).await;
    let account = install_gmail(&state, "scout").await;
    let (_, run) = finished_run(&state, "WF-revoked", "scout", r#"{"kind":"none"}"#).await;
    let mut sse = state.sse_tx.subscribe();

    // The grant existed when the workflow was saved. It does not now.
    assert!(db::connectors::revoke(&state.pool, "scout", "gmail").await.unwrap());

    let outcome = complete::fire(
        &state,
        &run,
        &CompletionAction::ConnectorSend {
            connector_id: "gmail".into(),
            account_ref: account,
            to: "sander@example.com".into(),
            subject: None,
        },
    )
    .await;

    let CompletionOutcome::Failed(note) = outcome else {
        panic!("a revoked grant must FAIL, not skip: {outcome:?}");
    };
    assert!(note.contains("Gmail"), "the note names the connector: {note}");
    assert!(note.contains("nothing was sent"), "{note}");

    let after = run_row(&state, run.id).await;
    assert_eq!(after.status, "error", "a completion action that did not happen is an error");
    assert!(after.note.contains("Gmail"), "{:?}", after.note);

    // Nothing was typed into the pane.
    let sess = db::sessions::get(&state.pool, "scout").await.unwrap().unwrap();
    assert_eq!(sess.last_send_text, "", "a refused send must not reach the bot");

    // And exactly one frame told the user.
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), sse.recv())
        .await
        .expect("an alerts frame is raised")
        .expect("sse");
    assert_eq!(frame.payload["status"], "error");
    assert!(frame.payload["detail"].as_str().unwrap_or("").contains("Gmail"));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), sse.recv()).await.is_err(),
        "one frame, not one per retry"
    );

    let _ = sessions::lifecycle::stop(&state, "scout").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn message_bot_to_another_company_is_refused() {
    let (state, dir) = new_state().await;
    sqlx::query("INSERT INTO companies (id, slug, display_name, root_dir, created_at, updated_at) VALUES (7, 'acme', 'Acme', ?, 0, 0)")
        .bind(dir.to_str().unwrap())
        .execute(&state.pool)
        .await
        .unwrap();
    bot(&state, &dir, "scout", None).await;      // HQ
    bot(&state, &dir, "outsider", Some(7)).await; // company 7
    let (_, run) = finished_run(&state, "WF-cross", "scout", r#"{"kind":"none"}"#).await;

    let outcome = complete::fire(
        &state,
        &run,
        &CompletionAction::MessageBot { session: "outsider".into() },
    )
    .await;

    let CompletionOutcome::Failed(note) = outcome else {
        panic!("a cross-company target must be refused: {outcome:?}");
    };
    assert!(note.contains("outsider"), "{note}");
    assert_eq!(run_row(&state, run.id).await.status, "error");

    // Nothing was delivered to either side.
    let target = db::sessions::get(&state.pool, "outsider").await.unwrap().unwrap();
    assert_eq!(target.last_send_text, "", "a refused message must not reach the other bot");

    let _ = sessions::lifecycle::stop(&state, "scout").await;
    let _ = sessions::lifecycle::stop(&state, "outsider").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

// ── the typed seam ───────────────────────────────────────────────────────────

#[tokio::test]
async fn the_hook_path_400s_on_connector_send_and_on_message_bot() {
    // A session token must not be able to arm something that emails the world,
    // or that types into another bot's pane.
    assert!(complete::parse_for_hook(
        r#"{"kind":"connector_send","connector_id":"gmail","account_ref":"a","to":"x@y.z"}"#
    )
    .is_err());
    assert!(complete::parse_for_hook(r#"{"kind":"message_bot","session":"ceo"}"#).is_err());
    // The three inward-facing arms are fine over the hook.
    assert_eq!(complete::parse_for_hook(r#"{"kind":"none"}"#).unwrap(), CompletionAction::None);
    assert_eq!(complete::parse_for_hook(r#"{"kind":"notify"}"#).unwrap(), CompletionAction::Notify);
    assert_eq!(
        complete::parse_for_hook(r#"{"kind":"disable"}"#).unwrap(),
        CompletionAction::Disable
    );
}

#[tokio::test]
async fn an_unknown_completion_kind_is_a_400_not_a_default() {
    // The dragon, by its old name…
    let err = complete::parse(r#"{"kind":"command","text":"rm -rf /"}"#).unwrap_err();
    assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    // …and by any other.
    assert!(complete::parse(r#"{"kind":"shell","command":"true"}"#).is_err());
    assert!(complete::parse(r#"{"kind":"boot"}"#).is_err());
    // A blank column is the honest default, not a parse failure: 0038's DEFAULT
    // is `{"kind":"none"}` and a hand-edited row may be ''.
    assert_eq!(complete::parse("").unwrap(), CompletionAction::None);
    assert_eq!(complete::parse(r#"{"kind":"none"}"#).unwrap(), CompletionAction::None);
}

#[test]
fn the_connector_instruction_is_built_only_from_typed_fields() {
    assert_eq!(
        connector_instruction("Gmail", "sander@acme.com", "sander@example.com", Some("Weekly report")),
        "Use the Gmail connector (account sander@acme.com) to send the summary of this workflow \
         run to sander@example.com with subject \"Weekly report\". Do not include anything else."
    );
    // No account identity, no subject: the sentence shrinks rather than carrying
    // an empty parenthesis or a dangling `with subject ""`.
    assert_eq!(
        connector_instruction("Gmail", "", "ops@example.com", None),
        "Use the Gmail connector to send the summary of this workflow run to ops@example.com. \
         Do not include anything else."
    );
    // Every hole in the template is filled from a TYPED field, and the enum has
    // no free-text arm at all — so there is nothing an operator could type that
    // reaches this sentence except the four validated values.
    let action = CompletionAction::ConnectorSend {
        connector_id: "gmail".into(),
        account_ref: "acct-1".into(),
        to: "ops@example.com".into(),
        subject: None,
    };
    let round = serde_json::to_string(&action).unwrap();
    assert!(!round.contains("text"), "no free-text field exists: {round}");
    assert_eq!(complete::parse(&round).unwrap(), action);
}
