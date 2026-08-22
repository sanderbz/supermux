//! T8 — the manual recovery ladder, and its auth scoping.
//!
//! The AUTOMATIC layer already existed and is good: holder supervision, the
//! `auto_heal` reaction with its 10-minute cooldown, the "Terminal died" badge.
//! What did not exist was any way for a HUMAN to act on it — clients composed
//! their own stop+start (two of them, differently), there was no manual heal at
//! all, and no way back from a wedged runtime short of deleting the session.
//!
//! Three rungs, ordered by WHAT THEY PRESERVE rather than by how drastic they
//! sound. That ordering is the design: "restart" and "reset" mean nothing to
//! someone deciding under pressure whether they are about to lose a
//! conversation.
//!
//! | rung           | preserves                         | destroys                    |
//! |----------------|-----------------------------------|-----------------------------|
//! | Recover holder | scrollback                        | nothing else                |
//! | Restart        | conversation, worktree, schedules | live pty + in-memory buffer |
//! | Reset          | worktree, schedules, config       | conversation + scrollback   |
//!
//! Every one of the three is a NEW authenticated route, so the auth matrix is
//! asserted for each: unauthenticated → 401, a session-scoped hook token cannot
//! reach them at all (let alone for a *different* session), and an unknown name
//! → 404. Reset additionally refuses a running session with a 409.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const BEARER: &str = "recovery-ladder-bearer";
const TOK_A: &str = "hook-token-of-alpha";

/// The three rungs, so every matrix row runs against all of them rather than
/// against whichever one someone remembered.
const RUNGS: [&str; 3] = ["restart", "recover", "reset"];

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-recovery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: BEARER.to_string(),
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

/// Session names are UNIQUE PER TEST, not the obvious "alpha"/"beta".
///
/// These tests share the host's tmux server, and a session name IS a tmux
/// session name (`supermux-<name>`). A fixed name meant one test's `restart`
/// genuinely spawned `supermux-alpha`, which a concurrently-running `reset`
/// then saw as alive and refused with a 409 — a real cross-test collision
/// through global state outside the process, which no amount of temp-dir
/// isolation would have caught.
async fn setup() -> (AppState, axum::Router, PathBuf, String, String) {
    let (config, dir) = temp_config();
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let alpha = format!("a{}", &suffix[..12]);
    let beta = format!("b{}", &suffix[12..24]);
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    for (name, tok) in [(alpha.as_str(), TOK_A), (beta.as_str(), "hook-token-of-beta")] {
        db::sessions::insert_minimal(&state.pool, name, dir.to_str().unwrap(), "claude")
            .await
            .unwrap();
        db::sessions::ensure_runtime(&state.pool, name, tok).await.unwrap();
    }
    let app = http::router(state.clone());
    (state, app, dir, alpha, beta)
}

/// Leave no tmux session behind: `restart` really does spawn one.
fn kill_tmux(name: &str) {
    let _ = std::process::Command::new("tmux")
        .args(["kill-session", "-t", &format!("supermux-{name}")])
        .output();
}

async fn post(
    app: &axum::Router,
    name: &str,
    rung: &str,
    auth: Option<&str>,
    hook_token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/sessions/{name}/{rung}"));
    if let Some(a) = auth {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {a}"));
    }
    if let Some(t) = hook_token {
        builder = builder.header("X-Supermux-Hook-Token", t);
    }
    let resp = app.clone().oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

// ── the auth matrix, for all three rungs ────────────────────────────────────

#[tokio::test]
async fn every_rung_refuses_an_unauthenticated_call() {
    let (_state, app, dir, alpha, _beta) = setup().await;
    for rung in RUNGS {
        let (status, _) = post(&app, &alpha, rung, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "rung={rung}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn every_rung_refuses_a_wrong_bearer() {
    let (_state, app, dir, alpha, _beta) = setup().await;
    for rung in RUNGS {
        let (status, _) = post(&app, &alpha, rung, Some("not-the-token"), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "rung={rung}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// The scoping question that matters: a per-session hook token is a capability
/// held by a RUNNING AGENT. Restarting or resetting a session is a human
/// decision about that agent's own life, so the token must buy nothing —
/// including against its own session, which is the case a naive "is this token
/// valid?" check would wave through.
#[tokio::test]
async fn a_session_scoped_hook_token_cannot_drive_any_rung() {
    let (_state, app, dir, alpha, beta) = setup().await;
    for rung in RUNGS {
        // Its own session.
        let (status, _) = post(&app, &alpha, rung, None, Some(TOK_A)).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "rung={rung}: an agent must not restart/reset itself via its hook token",
        );
        // A DIFFERENT session — the cross-session escalation.
        let (status, _) = post(&app, &beta, rung, None, Some(TOK_A)).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "rung={rung}: alpha's token must not reach beta",
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn every_rung_404s_an_unknown_session() {
    let (_state, app, dir, _alpha, _beta) = setup().await;
    for rung in RUNGS {
        let (status, _) = post(&app, "no-such-session", rung, Some(BEARER), None).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "rung={rung}: an unknown name is a 404, never a silent success",
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// An ARCHIVED session is not a recovery target either — recovering one would
/// resurrect it invisibly, which is exactly the bug T5 fixed on the schedule
/// path. All three rungs gate on `exists_active`, so this holds by construction.
#[tokio::test]
async fn no_rung_can_resurrect_an_archived_session() {
    let (state, app, dir, alpha, _beta) = setup().await;
    db::sessions::set_archived(&state.pool, &alpha, true).await.unwrap();
    for rung in RUNGS {
        let (status, _) = post(&app, &alpha, rung, Some(BEARER), None).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "rung={rung}: an archived session must not be recoverable into a hidden running state",
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

// ── behaviour ───────────────────────────────────────────────────────────────

/// The whole point of T8.2: a `recover` that does nothing must SAY what it did
/// not do. Before B5 every one of these outcomes was a `tracing` line, so a user
/// looking at "Terminal died" could not tell "on cooldown" from "auto-heal is
/// off" from "this type cannot be healed" — three different next actions, all
/// rendered as the same silence.
#[tokio::test]
async fn recover_reports_its_outcome_instead_of_failing_silently() {
    let (_state, app, dir, alpha, _beta) = setup().await;
    let (status, body) = post(&app, &alpha, "recover", Some(BEARER), None).await;

    // Not an error: "auto-heal is off" and "this session cannot be healed" are
    // ANSWERS. Modelling them as failures would bury them in a generic red
    // toast that says less than the word itself does.
    assert_eq!(status, StatusCode::OK);
    let outcome = body["data"]["outcome"].as_str().expect("an outcome string");
    assert!(
        ["healed", "failed", "disabled", "cooldown", "unsupported", "gone", "superseded"]
            .contains(&outcome),
        "unknown outcome {outcome:?} — the UI maps these by name",
    );
    assert!(body["data"]["healed"].is_boolean());

    let _ = std::fs::remove_dir_all(dir);
}

/// Reset refuses a session that is still running, with a 409 rather than a
/// convenience stop-then-reset. Resetting under a live pty would leave a running
/// agent writing into a runtime row that no longer describes it, and that
/// split-brain is much harder to explain than the refusal.
#[tokio::test]
async fn reset_on_a_stopped_session_succeeds_and_rotates_the_hook_token() {
    let (state, app, dir, alpha, _beta) = setup().await;
    db::sessions::track_cc_conversation_id(&state.pool, &alpha, "conv-abc")
        .await
        .unwrap();
    let before = db::sessions::runtime(&state.pool, &alpha)
        .await
        .unwrap()
        .unwrap()
        .hook_token;

    let (status, _) = post(&app, &alpha, "reset", Some(BEARER), None).await;
    assert_eq!(status, StatusCode::OK, "a stopped session resets cleanly");

    let after = db::sessions::runtime(&state.pool, &alpha).await.unwrap().unwrap();
    assert_ne!(
        after.hook_token, before,
        "a reset answers 'something about this runtime is wrong', and a stale or \
         leaked token is squarely in that set",
    );

    let row = db::sessions::get(&state.pool, &alpha).await.unwrap().unwrap();
    assert_eq!(
        row.cc_conversation_id, "",
        "the conversation link is dropped — the next start begins fresh rather \
         than resuming into whatever was wedged",
    );
    // …and the things the user thinks of as THEIRS survive.
    assert_eq!(row.dir, dir.to_str().unwrap(), "the working directory is untouched");
    assert_eq!(row.provider, "claude", "the config survives a reset");
    assert_eq!(row.archived, 0);

    let _ = std::fs::remove_dir_all(dir);
}

/// Restart asks for an END STATE ("be running again"), so a stop that is a
/// no-op because the session was already down must not fail the call — that
/// would break the button in exactly the situation it exists for.
#[tokio::test]
async fn restart_does_not_refuse_an_already_stopped_session() {
    let (_state, app, dir, alpha, _beta) = setup().await;
    let (status, _) = post(&app, &alpha, "restart", Some(BEARER), None).await;
    assert_ne!(
        status,
        StatusCode::NOT_FOUND,
        "the session exists — a restart must not 404 merely because it was down",
    );
    assert_ne!(status, StatusCode::UNAUTHORIZED);
    // `restart` genuinely starts the session, so this test owns a real tmux
    // session until it cleans it up.
    kill_tmux(&alpha);
    let _ = std::fs::remove_dir_all(dir);
}

/// Every `Heal` outcome carries a sentence, and no two are the same. This is
/// what stops the ladder regressing to "something went wrong".
#[tokio::test]
async fn every_heal_outcome_has_its_own_sentence() {
    use supermux_server::sessions::auto_actions::Heal;
    let all = [
        Heal::Healed,
        Heal::Failed,
        Heal::Disabled,
        Heal::Cooldown,
        Heal::Unsupported,
        Heal::Gone,
        Heal::Superseded,
    ];
    let mut seen: Vec<&str> = Vec::new();
    for h in all {
        let r = h.reason();
        assert!(!r.trim().is_empty(), "{h:?} has no sentence");
        assert!(
            !seen.contains(&r),
            "{h:?} reuses another outcome's sentence — the whole point is that \
             these are distinguishable",
        );
        seen.push(r);
        assert!(!h.as_str().is_empty());
    }
    assert!(Heal::Healed.healed());
    assert!(!Heal::Cooldown.healed());
}
