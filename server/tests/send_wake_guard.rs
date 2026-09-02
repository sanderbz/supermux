//! THE AUTO-WAKE SEAM, asserted.
//!
//! `#81` put two recovery guards on `auto_actions::auto_heal`: refuse to
//! restart a claude session whose resume link is provably dead, and believe
//! `start`'s `ready` flag rather than the mere existence of a pane. Its
//! sibling — the auto-wake inside `lifecycle::send_harness_text` — had neither,
//! and grepping for `send_harness_text` in `lifecycle.rs` found only the
//! function itself. That is the seam EVERY writer funnels through:
//! `POST /api/sessions/{name}/send`, `POST /api/agents/delegate`,
//! `scheduler::runner`, the board dispatcher, the steering deliver loop.
//!
//! So the exact failure #81 closed was still one `/send` away. Measured on the
//! rig: the heal correctly refused ("auto-heal: skipped — a claude session with
//! no resume link would come back empty"), the API correctly held
//! `stopped + holder_died` — and then a single `POST …/send` returned
//! `{"ok":true}`, `claude --resume <gone>` printed "No conversation found with
//! session ID: …" and EXITED, the prompt was typed at the bash prompt it left
//! behind ("PROBE: command not found"), and six seconds later the row read
//! `idle` with `error=null` while the chat surface said "The session has it —
//! waiting for the transcript to catch up." and never retracted.
//!
//! This file is the test that was missing.

use std::path::PathBuf;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use supermux_server::agents::delegate::DelegateInput;
use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::sessions::runtime::{HistoryWindow, SessionRuntime};
use supermux_server::state::AppState;
use supermux_server::{db, sessions};

const TOKEN: &str = "send-wake-guard-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-wake-{}", uuid::Uuid::new_v4()));
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

/// A stopped NATIVE claude row — the shape a crashed session leaves behind.
async fn dead_claude_row(state: &AppState, name: &str) {
    db::sessions::insert_minimal(&state.pool, name, "/tmp", "claude").await.unwrap();
    db::sessions::set_runtime(&state.pool, name, "native").await.unwrap();
    db::sessions::ensure_runtime(&state.pool, name, "test-token").await.unwrap();
    db::sessions::set_last_status(&state.pool, name, "stopped").await.unwrap();
}

/// The blocker: a send may not resurrect what the heal just refused.
///
/// The session points at a conversation whose `<project>/<id>.jsonl` is not on
/// disk. Waking it would run `claude --resume <id>`, which prints "No
/// conversation found with session ID: …" and exits — so what receives the text
/// three lines later is a bash prompt wearing the session's name. The refusal is
/// a 409 that NAMES the conversation, because "start it fresh" and "point it at
/// a conversation that still exists" are the two things the user can do and
/// neither is guessable from a generic error.
#[tokio::test]
async fn a_send_may_not_wake_a_claude_session_whose_resume_link_is_gone() {
    let (state, dir) = new_state().await;
    dead_claude_row(&state, "ghost").await;
    db::sessions::set_cc_conversation_id(&state.pool, "ghost", "conv-that-vanished")
        .await
        .unwrap();

    let rt = state.runtime_for("ghost").await.unwrap();
    assert!(!rt.alive().await, "precondition: nothing is running, so the send would auto-wake");

    let err = sessions::lifecycle::send_harness_text(&state, "ghost", "PROBE", None, None)
        .await
        .expect_err("the seam must refuse rather than hand the prompt to a shell");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("Conflict"),
        "an undeliverable send is a 409, not a silent success; got {msg}",
    );
    assert!(
        msg.contains("conv-that-vanished"),
        "the refusal must name the conversation that is gone; got {msg}",
    );

    // `send_text` — the composer / `POST …/send` door — carries the same guard,
    // because it delegates to the same seam.
    let err = sessions::lifecycle::send_text(&state, "ghost", "PROBE")
        .await
        .expect_err("/send funnels through the same seam");
    assert!(format!("{err:?}").contains("conv-that-vanished"));

    // Nothing was recorded as sent: the roster's send preview must not claim an
    // arrival that a shell ate.
    let row = db::sessions::get(&state.pool, "ghost").await.unwrap().unwrap();
    assert!(
        row.last_send_text.trim().is_empty(),
        "an undelivered prompt must not be stamped as this session's last send; got {:?}",
        row.last_send_text,
    );

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The delegate fabric inherits the refusal, and — this is the half that
/// mattered on the rig — records NO delivered edge.
///
/// `agents::delegate` writes its `record_delegation` row AFTER the send, with
/// `?`, so a refusing seam is the whole fix: the graph view never grows an edge
/// for a prompt a bash prompt ate, and the sender's surface has an error to
/// settle its unconfirmed row on instead of a permanent "waiting for the
/// transcript to catch up."
#[tokio::test]
async fn delegate_reports_undelivered_and_records_no_edge() {
    let (state, dir) = new_state().await;
    db::sessions::insert_minimal(&state.pool, "sender", "/tmp", "shell").await.unwrap();
    dead_claude_row(&state, "receiver").await;
    db::sessions::set_cc_conversation_id(&state.pool, "receiver", "conv-that-vanished")
        .await
        .unwrap();

    let err = supermux_server::agents::delegate::delegate(
        axum::extract::State(state.clone()),
        supermux_server::scope::OptCtx(None),
        axum::Json(DelegateInput {
            from: "sender".into(),
            to: "receiver".into(),
            prompt: "What is 17 times 23?".into(),
            actor: None,
        }),
    )
    .await
    .err()
    .expect("delivery into a session that cannot be woken is not a delegation");
    assert!(
        format!("{err:?}").contains("conv-that-vanished"),
        "the sender is told WHY, got {err:?}",
    );

    assert!(
        db::audit::delegations_out(&state.pool, "sender").await.unwrap().is_empty(),
        "a refused delivery must not leave a 'Delegated to ●receiver' edge behind",
    );
    assert!(db::audit::delegations_in(&state.pool, "receiver").await.unwrap().is_empty());

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The seam refuses a DEAD link, never a MISSING one.
///
/// A claude session that has never had a conversation is the ordinary first
/// send: starting it loses nothing, so the guard must let it through. (The
/// automatic heal declines that same row — a fresh start is not a recovery —
/// and the two answers are deliberately different; see
/// `auto_actions::dead_resume_link`.)
#[tokio::test]
async fn a_first_send_to_a_never_started_claude_session_is_not_refused() {
    let (state, dir) = new_state().await;
    dead_claude_row(&state, "brandnew").await;
    // No pty holder can be spawned from a test binary, and we do not want one:
    // the assertion is about WHICH refusal comes back. Point the holder at a
    // path that does not exist so `start` fails fast on the spawn instead of
    // waiting out a holder-connect timeout.
    std::env::set_var("SUPERMUX_HOLDER_BIN", "/nonexistent/supermux-holder-for-tests");

    let err = sessions::lifecycle::send_text(&state, "brandnew", "hello")
        .await
        .expect_err("no holder binary is spawnable in a unit test, so this still fails");
    let msg = format!("{err:?}");
    assert!(
        !msg.contains("can't be woken"),
        "a row with no resume link must reach `start` — the dead-link guard is not \
         allowed to swallow an ordinary first send; got {msg}",
    );

    std::env::remove_var("SUPERMUX_HOLDER_BIN");
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

// ── the ALREADY-AWAKE retry, parked at the resume picker (codex #1, wave-7) ────
//
// The wake guards above close the FIRST send (the wake lands on a modal, so
// `start().ready == false` refuses). But a session that is already ALIVE — its
// `claude --resume <stale>` sitting in the interactive Resume picker, a live
// program — never enters `wake_for_send`: `send_harness_text` takes `woke ==
// false`. Before the send-path guard, that retry typed text+Enter straight into
// the picker and recorded `last_send`, so the swallowed message was reported
// delivered (and, via the fabric, grew a delegated edge).
//
// A live runtime stub parked at the picker is the only way to reproduce it — a
// real pty can't be spawned from a test binary. It is injected into the runtime
// cache so `runtime_for` returns it, and it COUNTS every keystroke so the test
// proves nothing was typed.

struct PickerStub {
    capture: String,
    text_calls: AtomicUsize,
    key_calls: AtomicUsize,
}

impl PickerStub {
    fn parked_at(capture: &str) -> Arc<Self> {
        Arc::new(Self {
            capture: capture.to_string(),
            text_calls: AtomicUsize::new(0),
            key_calls: AtomicUsize::new(0),
        })
    }
}

#[async_trait]
impl SessionRuntime for PickerStub {
    async fn spawn(&self, _d: &Path, _e: &HashMap<String, String>, _s: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn alive(&self) -> bool {
        true // ← the picker is a live program: force the already-awake path
    }
    async fn kill(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn send_text(&self, _t: &str) -> anyhow::Result<()> {
        self.text_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn send_key(&self, _k: &str) -> anyhow::Result<()> {
        self.key_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn paste(&self, _t: &str, _b: bool) -> anyhow::Result<()> {
        Ok(())
    }
    async fn resize(&self, _c: u16, _r: u16) -> anyhow::Result<()> {
        Ok(())
    }
    async fn capture_plain(&self, _lines: usize) -> anyhow::Result<String> {
        Ok(self.capture.clone())
    }
    async fn capture_ansi(&self, _lines: usize) -> anyhow::Result<String> {
        Ok(self.capture.clone())
    }
    async fn capture_screen_ansi(&self) -> anyhow::Result<String> {
        Ok(self.capture.clone())
    }
    async fn capture_full(&self) -> anyhow::Result<String> {
        Ok(self.capture.clone())
    }
    async fn seed(&self) -> anyhow::Result<String> {
        Ok(self.capture.clone())
    }
    async fn history_window(&self, end_offset: i64, _count: u32) -> anyhow::Result<HistoryWindow> {
        Ok(HistoryWindow {
            rows: vec![],
            history_size: 0,
            start_offset: end_offset,
            end_offset,
            hit_top: true,
            cols: 80,
            at_limit: false,
        })
    }
    async fn history_meta(&self) -> (u32, u16) {
        (0, 80)
    }
    async fn pane_pid(&self) -> anyhow::Result<Option<u32>> {
        Ok(None)
    }
    async fn dead(&self) -> anyhow::Result<bool> {
        Ok(false)
    }
}

const PICKER: &str = "Resume a conversation\n❯ 1. Fix the parser  2h ago\n  2. Older chat";

/// A retry `/send` to a session that is ALREADY AWAKE but parked at the resume
/// picker must report UNDELIVERED, type nothing into the picker, and record no
/// `last_send`. (The first send already refuses on the wake path; this is the
/// second, already-alive retry that used to slip through.)
#[tokio::test]
async fn a_retry_send_parked_at_the_picker_types_nothing_and_is_undelivered() {
    let (state, dir) = new_state().await;
    db::sessions::insert_minimal(&state.pool, "parked", "/tmp", "claude").await.unwrap();
    let rt = PickerStub::parked_at(PICKER);
    state.session_runtimes.insert("parked".to_string(), rt.clone());

    let err = sessions::lifecycle::send_text(&state, "parked", "PROBE")
        .await
        .expect_err("a send into an open picker must be refused, not typed into the modal");
    assert!(
        format!("{err:?}").contains("Conflict"),
        "an undeliverable send is a 409; got {err:?}",
    );
    assert_eq!(rt.text_calls.load(Ordering::SeqCst), 0, "the retry must NOT be typed into the picker");
    assert_eq!(rt.key_calls.load(Ordering::SeqCst), 0, "and no Enter is submitted into it");

    let row = db::sessions::get(&state.pool, "parked").await.unwrap().unwrap();
    assert!(
        row.last_send_text.trim().is_empty(),
        "a message the picker swallowed must not be stamped as this session's last send; got {:?}",
        row.last_send_text,
    );

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The delegate fabric inherits the picker refusal and grows NO edge — the harm
/// codex flagged (a message swallowed into a modal yet reported delivered) does
/// not reach the graph.
#[tokio::test]
async fn delegate_into_an_open_picker_records_no_edge() {
    let (state, dir) = new_state().await;
    db::sessions::insert_minimal(&state.pool, "sender", "/tmp", "shell").await.unwrap();
    db::sessions::insert_minimal(&state.pool, "receiver", "/tmp", "claude").await.unwrap();
    let rt = PickerStub::parked_at(PICKER);
    state.session_runtimes.insert("receiver".to_string(), rt.clone());

    let err = supermux_server::agents::delegate::delegate(
        axum::extract::State(state.clone()),
        supermux_server::scope::OptCtx(None),
        axum::Json(DelegateInput {
            from: "sender".into(),
            to: "receiver".into(),
            prompt: "What is 17 times 23?".into(),
            actor: None,
        }),
    )
    .await
    .err()
    .expect("delivery into an open picker is not a delegation");
    assert!(format!("{err:?}").contains("Conflict"), "the sender is told it was undelivered; got {err:?}");

    assert_eq!(rt.text_calls.load(Ordering::SeqCst), 0, "nothing typed into the picker via the fabric");
    assert!(
        db::audit::delegations_out(&state.pool, "sender").await.unwrap().is_empty(),
        "a refused delivery must not leave a 'Delegated to ●receiver' edge behind",
    );
    assert!(db::audit::delegations_in(&state.pool, "receiver").await.unwrap().is_empty());

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

// ── the SELECTION screens (owner report, review wave 2) ───────────────────────
//
// The picker tests above are one instance of a wider rule the guard now states
// outright: a send is admitted ONLY on positive evidence that the agent is at
// its TEXT COMPOSER. Everything else — the agent's own question / plan / paused
// modal / permission menu, a picker recognised by its footer rather than its
// title, an interactive prompt from a program the user ran by hand in the same
// pane — is answered with a KEYPRESS, and `send_text` + Enter there drops the
// message and picks whatever row is highlighted.
//
// The browser refuses in front of that (`use-composer.ts`'s `sendGate`). NOTHING
// else does: `POST /api/agents/delegate`, `scheduler::runner`, the board
// dispatcher and the steering loop all funnel through `send_harness_text` with
// no lens at all. These are the tests for those callers.

/// The live AskUserQuestion screen, CC 2.1.233 — the same capture the unit tests
/// read, trimmed to the rows a 30-line `capture_plain` would return. Its `❯`
/// caret is ABOVE the option list, so what identifies it at the bottom of the
/// screen is the key legend.
const ASK_QUESTION: &str = include_str!("fixtures/pty/ask-user-question.txt");

/// An idle Claude composer — the one screen that admits.
const COMPOSER: &str = "\n\n❯ Try \"fix tests\"\n  ? for shortcuts\n  ⏵⏵ auto mode on\n";

/// A resume picker with a long conversation list: `Resume a conversation` has
/// scrolled off the top of the capture, so the TITLE check cannot see it. Its
/// footer is still on screen, and that is what must refuse.
fn picker_without_its_title() -> String {
    let mut s = String::new();
    for i in 0..26 {
        s.push_str(&format!("  {}. Fix the parser — {i}h ago\n", i + 3));
    }
    s.push_str("\nEnter to select · Esc to cancel\n");
    s
}

/// (a) A picker this server can only recognise by its FOOTER — the title is out
/// of the capture window — must still refuse, type nothing, and stamp no
/// `last_send`.
#[tokio::test]
async fn a_retry_send_to_a_picker_whose_title_scrolled_out_is_undelivered() {
    let (state, dir) = new_state().await;
    db::sessions::insert_minimal(&state.pool, "longlist", "/tmp", "claude").await.unwrap();
    let capture = picker_without_its_title();
    assert!(!capture.contains("Resume a conversation"), "the fixture must not carry the title");
    let rt = PickerStub::parked_at(&capture);
    state.session_runtimes.insert("longlist".to_string(), rt.clone());

    let err = sessions::lifecycle::send_text(&state, "longlist", "PROBE")
        .await
        .expect_err("a picker is a picker whether or not its title is still on screen");
    assert!(format!("{err:?}").contains("Conflict"), "an undeliverable send is a 409; got {err:?}");
    assert_eq!(rt.text_calls.load(Ordering::SeqCst), 0, "nothing typed into the picker");
    assert_eq!(rt.key_calls.load(Ordering::SeqCst), 0, "and no Enter submitted into it");

    let row = db::sessions::get(&state.pool, "longlist").await.unwrap().unwrap();
    assert!(row.last_send_text.trim().is_empty(), "got {:?}", row.last_send_text);

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// (b) THE OWNER'S SCREEN, via the lens-less callers. A delegate (and by the
/// same seam the scheduler, the board and steering) arriving while Claude is
/// asking a question must come back UNDELIVERED — and must not submit an option
/// on the sender's behalf.
#[tokio::test]
async fn delegate_while_claude_asks_a_question_is_undelivered_and_answers_nothing() {
    let (state, dir) = new_state().await;
    db::sessions::insert_minimal(&state.pool, "sender", "/tmp", "shell").await.unwrap();
    db::sessions::insert_minimal(&state.pool, "asking", "/tmp", "claude").await.unwrap();
    let rt = PickerStub::parked_at(ASK_QUESTION);
    state.session_runtimes.insert("asking".to_string(), rt.clone());

    let err = supermux_server::agents::delegate::delegate(
        axum::extract::State(state.clone()),
        supermux_server::scope::OptCtx(None),
        axum::Json(DelegateInput {
            from: "sender".into(),
            to: "asking".into(),
            prompt: "please also check the parser".into(),
            actor: None,
        }),
    )
    .await
    .err()
    .expect("delivery into an open question is not a delegation");
    let msg = format!("{err:?}");
    assert!(msg.contains("Conflict"), "the sender is told it was undelivered; got {msg}");
    // The SENTENCE names what is really there. The bug the owner hit was a 409
    // that sent them looking for a resume picker and a folder-trust dialog while
    // an ordinary question was on screen.
    assert!(!msg.contains("resume picker"), "must not name a picker that is not there; got {msg}");
    assert!(!msg.contains("folder-trust"), "must not name a trust dialog that is not there; got {msg}");

    // THE SAFETY ASSERTION: not one keystroke. A paste is dropped by the dialog
    // and the Enter after it would pick the highlighted row — answering "Apple"
    // on behalf of a sender who never saw the question.
    assert_eq!(rt.text_calls.load(Ordering::SeqCst), 0, "nothing typed into the question");
    assert_eq!(rt.key_calls.load(Ordering::SeqCst), 0, "and NO option submitted");

    let row = db::sessions::get(&state.pool, "asking").await.unwrap().unwrap();
    assert!(row.last_send_text.trim().is_empty(), "got {:?}", row.last_send_text);
    assert!(
        db::audit::delegations_out(&state.pool, "sender").await.unwrap().is_empty(),
        "a refused delivery must not leave an edge behind",
    );

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// (c) THE UN-WEDGE. The same seam, the same session, one keystroke later: the
/// dialog is gone and the agent is back at its composer, so the message is
/// typed and submitted exactly as before. Without this the two tests above would
/// pass on a guard that refuses everything.
#[tokio::test]
async fn a_send_to_an_agent_at_its_composer_is_delivered() {
    let (state, dir) = new_state().await;
    db::sessions::insert_minimal(&state.pool, "ready", "/tmp", "claude").await.unwrap();
    let rt = PickerStub::parked_at(COMPOSER);
    state.session_runtimes.insert("ready".to_string(), rt.clone());

    sessions::lifecycle::send_text(&state, "ready", "PROBE")
        .await
        .expect("an idle composer takes messages — this is the half of the report that IS a wedge");
    assert_eq!(rt.text_calls.load(Ordering::SeqCst), 1, "the message is typed");
    assert_eq!(rt.key_calls.load(Ordering::SeqCst), 1, "and submitted with one Enter");

    let row = db::sessions::get(&state.pool, "ready").await.unwrap().unwrap();
    assert!(row.last_send_text.contains("PROBE"), "got {:?}", row.last_send_text);

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
