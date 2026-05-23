//! Agent→board hook endpoints (board-integration §C.2; AB1).
//!
//! The missing reverse edge: these routes let an agent report progress back onto
//! its own issue card. They are mounted OUTSIDE the bearer layer (alongside
//! `hooks::router_for` in `http::router`) because the agent never carries the
//! dashboard bearer — only its per-session `$SUPERMUX_HOOK_TOKEN`.
//!
//! **Auth (identical to the status hook, `crate::hooks`).** Each request presents
//! `X-Supermux-Hook-Token`, validated by a CONSTANT-TIME compare against
//! `session_runtime.hook_token WHERE name = body.session`. A leaked dashboard
//! bearer cannot drive these (it isn't checked); a leaked hook token of session A
//! cannot authenticate as session B (different stored token → 401).
//!
//! **Scope rule (the security crux).** Authentication only proves *which session*
//! you are. The issue you may mutate is then resolved as the issue WHERE
//! `session = <authenticated session>` (preferring `status='doing'`). An explicit
//! `item_id` (acceptance check) must ALSO belong to that issue. So an agent can
//! mutate ONLY the card linked to its own session — never anyone else's
//! (regression: `hook_scope_cross_session`). This mirrors `hook_auth_scope`.
//!
//! Every mutation re-publishes the board over SSE (`emit_board`) and writes an
//! `audit_log` row with `actor = agent:<session>`.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::db::board::{Issue, IssueField};
use crate::error::AppError;
use crate::state::AppState;

use super::{emit_board, valid_status};

/// Header the agent sets to its per-session `$SUPERMUX_HOOK_TOKEN` (same as the
/// status hook).
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The agent→board hook sub-router. Merged at the top level of `http::router`
/// (NO bearer layer — auth is the per-session hook token, validated per handler).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/board/comment", post(comment_handler))
        .route("/api/hook/board/status", post(status_handler))
        .route("/api/hook/board/check", post(check_handler))
        .route("/api/hook/board/link", post(link_handler))
        .with_state(state)
}

// ── auth + scope ──────────────────────────────────────────────────────────────

/// Constant-time validate the presented hook token against `session`'s stored
/// token (DB is the source of truth, §6.5). 401 on any mismatch / missing row.
/// Identical to `crate::hooks::hook_handler`'s check, factored for reuse.
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    session: &str,
) -> Result<(), AppError> {
    let expected = db::sessions::runtime(&state.pool, session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;
    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

/// Resolve the issue this authenticated session is allowed to touch. The scope
/// rule: the issue WHERE `session = <session>` (preferring `doing`). 404 (no
/// existence oracle for OTHER sessions' issues) when the session owns none.
async fn scoped_issue(state: &AppState, session: &str) -> Result<Issue, AppError> {
    db::board::doing_issue_for_session(&state.pool, session)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no issue linked to session '{session}'")))
}

/// Authenticate, then resolve the scoped issue — the common preamble for every
/// hook handler.
async fn auth_and_scope(
    state: &AppState,
    headers: &HeaderMap,
    session: &str,
) -> Result<Issue, AppError> {
    authenticate(state, headers, session).await?;
    scoped_issue(state, session).await
}

// ── comment ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CommentBody {
    session: String,
    body: String,
}

/// `POST /api/hook/board/comment` — append a comment to the agent's own issue.
async fn comment_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CommentBody>,
) -> Result<Json<Value>, AppError> {
    let issue = auth_and_scope(&state, &headers, &req.session).await?;
    let body = req.body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("body is required".into()));
    }
    let author = format!("agent:{}", req.session);
    let id = db::board::insert_comment(&state.pool, &issue.id, &author, body).await?;
    db::audit::log(
        &state.pool,
        &author,
        "issue.comment",
        &issue.id,
        json!({ "comment_id": id }),
    )
    .await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true, "id": id, "issue": issue.id })))
}

// ── status ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct StatusBody {
    session: String,
    status: String,
}

/// `POST /api/hook/board/status` — move the agent's own issue to `status`. The
/// agent has FULL status authority (user decision): any valid column, including
/// `done`. Validated against the `statuses` table for a clean 400.
async fn status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<StatusBody>,
) -> Result<Json<Value>, AppError> {
    let issue = auth_and_scope(&state, &headers, &req.session).await?;
    let status = req.status.trim();
    if !valid_status(&state, status).await? {
        return Err(AppError::BadRequest(format!("unknown status '{status}'")));
    }
    db::board::patch_issue(
        &state.pool,
        &issue.id,
        &[IssueField::Status(status.to_string())],
    )
    .await?;
    db::audit::log(
        &state.pool,
        &format!("agent:{}", req.session),
        "issue.status",
        &issue.id,
        json!({ "status": status }),
    )
    .await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true, "issue": issue.id, "status": status })))
}

// ── acceptance check ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CheckBody {
    session: String,
    item_id: i64,
    done: bool,
}

/// `POST /api/hook/board/check` — tick/untick one acceptance item that MUST
/// belong to the agent's own issue (the second arm of the scope rule).
async fn check_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CheckBody>,
) -> Result<Json<Value>, AppError> {
    let issue = auth_and_scope(&state, &headers, &req.session).await?;
    // The item must belong to the scoped issue — otherwise the agent could tick
    // another card's checklist by guessing an id.
    let item = db::board::get_acceptance(&state.pool, req.item_id)
        .await?
        .filter(|i| i.issue_id == issue.id)
        .ok_or_else(|| {
            AppError::NotFound(format!("acceptance item {} not on this issue", req.item_id))
        })?;
    db::board::toggle_acceptance(&state.pool, item.id, req.done).await?;
    db::audit::log(
        &state.pool,
        &format!("agent:{}", req.session),
        "issue.check",
        &issue.id,
        json!({ "item_id": item.id, "done": req.done }),
    )
    .await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true, "issue": issue.id, "item_id": item.id, "done": req.done })))
}

// ── link ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LinkBody {
    session: String,
    kind: String,
    #[serde(rename = "ref")]
    r#ref: String,
    #[serde(default)]
    label: Option<String>,
}

/// `POST /api/hook/board/link` — attach a PR/commit ref to the agent's own issue.
async fn link_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LinkBody>,
) -> Result<Json<Value>, AppError> {
    let issue = auth_and_scope(&state, &headers, &req.session).await?;
    let kind = req.kind.trim();
    if kind != "pr" && kind != "commit" {
        return Err(AppError::BadRequest(
            "kind must be 'pr' or 'commit'".into(),
        ));
    }
    let r#ref = req.r#ref.trim();
    if r#ref.is_empty() {
        return Err(AppError::BadRequest("ref is required".into()));
    }
    let label = req.label.unwrap_or_default();
    let id = db::board::insert_link(&state.pool, &issue.id, kind, r#ref, label.trim()).await?;
    db::audit::log(
        &state.pool,
        &format!("agent:{}", req.session),
        "issue.link",
        &issue.id,
        json!({ "link_id": id, "kind": kind }),
    )
    .await?;
    emit_board(&state).await;
    Ok(Json(json!({ "ok": true, "id": id, "issue": issue.id })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::board::NewIssue;
    use axum::http::HeaderValue;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-hook-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
        };
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// Seed a session with a hook token + a `doing` issue linked to it.
    async fn seed_agent_with_issue(state: &AppState, session: &str, token: &str, issue_id: &str) {
        db::sessions::insert_minimal(&state.pool, session, "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::ensure_runtime(&state.pool, session, token)
            .await
            .unwrap();
        db::board::insert_issue(
            &state.pool,
            &NewIssue {
                id: issue_id.to_string(),
                title: format!("issue {issue_id}"),
                desc: String::new(),
                status: "doing".into(),
                session: Some(session.to_string()),
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
            },
        )
        .await
        .unwrap();
    }

    fn token_header(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(HOOK_TOKEN_HEADER, HeaderValue::from_str(token).unwrap());
        h
    }

    #[tokio::test]
    async fn agent_comment_on_own_issue() {
        let (state, dir) = test_state().await;
        seed_agent_with_issue(&state, "worker-a", "tok-a", "A-1").await;

        let _ = comment_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "body": "done step 1" })).unwrap()),
        )
        .await
        .expect("comment ok");

        let comments = db::board::comments_for(&state.pool, "A-1").await.unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].author, "agent:worker-a");
        assert_eq!(comments[0].body, "done step 1");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_may_set_done() {
        // User decision: an agent has full status authority, including `done`.
        let (state, dir) = test_state().await;
        seed_agent_with_issue(&state, "worker-a", "tok-a", "A-1").await;

        let _ = status_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "status": "done" })).unwrap()),
        )
        .await
        .expect("status ok");

        let issue = db::board::get_issue(&state.pool, "A-1").await.unwrap().unwrap();
        assert_eq!(issue.status, "done");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_status_rejects_unknown_column() {
        let (state, dir) = test_state().await;
        seed_agent_with_issue(&state, "worker-a", "tok-a", "A-1").await;
        let bad = status_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "status": "nope" })).unwrap()),
        )
        .await;
        assert!(matches!(bad, Err(AppError::BadRequest(_))));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn wrong_token_is_unauthorized() {
        // Mirror `hook_auth_scope`: presenting the wrong token for a session 401s.
        let (state, dir) = test_state().await;
        seed_agent_with_issue(&state, "worker-a", "tok-a", "A-1").await;

        let res = comment_handler(
            State(state.clone()),
            token_header("WRONG"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "body": "x" })).unwrap()),
        )
        .await;
        assert!(matches!(res, Err(AppError::Unauthorized)));
        // Nothing was written.
        assert!(db::board::comments_for(&state.pool, "A-1").await.unwrap().is_empty());

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_a_token_cannot_touch_agent_b_issue() {
        // THE SCOPE CRUX: agent A authenticating as itself cannot comment on B's
        // card. A's token only ever resolves to A's own session's issue.
        let (state, dir) = test_state().await;
        seed_agent_with_issue(&state, "worker-a", "tok-a", "A-1").await;
        seed_agent_with_issue(&state, "worker-b", "tok-b", "B-1").await;

        // A presents B's session name with A's token → 401 (token is B's session's).
        let cross_auth = comment_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-b", "body": "hijack" })).unwrap()),
        )
        .await;
        assert!(matches!(cross_auth, Err(AppError::Unauthorized)));

        // A authenticates honestly as itself → only its OWN issue is touched.
        let _ = comment_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "body": "mine" })).unwrap()),
        )
        .await
        .unwrap();
        // B's card is untouched; A's got the comment.
        assert!(db::board::comments_for(&state.pool, "B-1").await.unwrap().is_empty());
        assert_eq!(db::board::comments_for(&state.pool, "A-1").await.unwrap().len(), 1);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_check_only_own_issue_items() {
        let (state, dir) = test_state().await;
        seed_agent_with_issue(&state, "worker-a", "tok-a", "A-1").await;
        seed_agent_with_issue(&state, "worker-b", "tok-b", "B-1").await;
        let a_item = db::board::insert_acceptance(&state.pool, "A-1", "step").await.unwrap();
        let b_item = db::board::insert_acceptance(&state.pool, "B-1", "step").await.unwrap();

        // A ticks its own item → ok.
        let _ = check_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "item_id": a_item, "done": true })).unwrap()),
        )
        .await
        .expect("own item ok");
        assert_eq!(db::board::acceptance_for(&state.pool, "A-1").await.unwrap()[0].done, 1);

        // A tries to tick B's item (guessing the id) → 404, B untouched.
        let cross = check_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "item_id": b_item, "done": true })).unwrap()),
        )
        .await;
        assert!(matches!(cross, Err(AppError::NotFound(_))));
        assert_eq!(db::board::acceptance_for(&state.pool, "B-1").await.unwrap()[0].done, 0);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_link_attaches_to_own_issue() {
        let (state, dir) = test_state().await;
        seed_agent_with_issue(&state, "worker-a", "tok-a", "A-1").await;

        let _ = link_handler(
            State(state.clone()),
            token_header("tok-a"),
            Json(serde_json::from_value(json!({ "session": "worker-a", "kind": "pr", "ref": "https://x/pr/9" })).unwrap()),
        )
        .await
        .expect("link ok");
        let links = db::board::links_for(&state.pool, "A-1").await.unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].r#ref, "https://x/pr/9");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
