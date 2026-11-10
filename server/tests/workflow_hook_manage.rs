//! `list` / `disable` / `delete` on the agent→workflows hook.
//!
//! The scope rule is the one every hook route defends: the workflow's `session`
//! must be the authenticated one. On top of it, `delete` is narrower than
//! `disable`: only a workflow the session created itself may be deleted, because
//! the owner can switch a paused workflow back on but cannot undo a delete.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::sessions::NewSession;
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "wf-manage-bearer";
const HOOK_HEADER: &str = "X-Supermux-Hook-Token";
const CREATE: &str = "/api/hook/workflow/create";
const LIST: &str = "/api/hook/workflow/list";
const DISABLE: &str = "/api/hook/workflow/disable";
const DELETE: &str = "/api/hook/workflow/delete";

struct Harness {
    app: axum::Router,
    state: AppState,
    data_dir: PathBuf,
    work_dir: PathBuf,
}

impl Harness {
    fn cleanup(self) {
        for d in [self.data_dir, self.work_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("supermux-wfmanage-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn spawn_harness() -> Harness {
    let data_dir = tmp("data");
    let work_dir = tmp("work");
    let config = Config {
        data_dir: data_dir.clone(),
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
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    Harness { app, state, data_dir, work_dir }
}

/// A session plus its hook token (`hook-token-for-<name>`).
async fn make_session(h: &Harness, name: &str) -> String {
    db::sessions::create(
        &h.state.pool,
        &NewSession {
            name: name.to_string(),
            display_name: name.to_string(),
            dir: h.work_dir.to_string_lossy().to_string(),
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
        },
    )
    .await
    .expect("create session");
    let token = format!("hook-token-for-{name}");
    db::sessions::ensure_runtime(&h.state.pool, name, &token)
        .await
        .expect("runtime row");
    token
}

async fn send(h: &Harness, method: Method, uri: &str, headers: &[(&str, String)], body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    for (k, v) in headers {
        req = req.header(*k, v.clone());
    }
    let resp = h
        .app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn hook(h: &Harness, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    send(h, Method::POST, uri, &[(HOOK_HEADER, token.to_string())], body).await
}

/// A workflow the AGENT created through its own hook. Returns its id.
async fn agent_created(h: &Harness, session: &str, token: &str, title: &str) -> String {
    let (status, body) = hook(
        h,
        CREATE,
        token,
        json!({ "session": session, "title": title, "prompt": "look", "schedule_expr": "every 12h" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["data"]["id"].as_str().expect("id").to_string()
}

/// A workflow the OWNER created for `session` through the bearer API.
async fn owner_created(h: &Harness, session: &str, title: &str) -> String {
    let (status, body) = send(
        h,
        Method::POST,
        "/api/workflows",
        &[("Authorization", format!("Bearer {TOKEN}"))],
        json!({
            "title": title,
            "session": session,
            "schedule_expr": "daily at 09:00",
            "steps": [{ "prompt": "the owner's daily check" }],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["data"]["id"].as_str().expect("id").to_string()
}

async fn row(h: &Harness, id: &str) -> Option<db::workflows::Workflow> {
    db::workflows::get(&h.state.pool, id).await.unwrap()
}

// ── the negatives first ──────────────────────────────────────────────────────

#[tokio::test]
async fn another_sessions_workflow_can_be_neither_listed_nor_paused_nor_deleted() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let b = make_session(&h, "m-b").await;
    let theirs = agent_created(&h, "m-b", &b, "B's check").await;

    let (status, body) = hook(&h, LIST, &a, json!({ "session": "m-a" })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"], json!([]), "A must not see B's workflow");

    for uri in [DISABLE, DELETE] {
        let (status, body) = hook(&h, uri, &a, json!({ "session": "m-a", "id": theirs })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}: {body}");
        // Naming B in the payload with A's token is the same 401 as on create.
        let (status, _) = hook(&h, uri, &a, json!({ "session": "m-b", "id": theirs })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    let still = row(&h, &theirs).await.expect("B's workflow survives");
    assert_eq!(still.enabled, 1, "and is still enabled");
    h.cleanup();
}

#[tokio::test]
async fn no_token_or_the_dashboard_bearer_buys_nothing() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let id = agent_created(&h, "m-a", &a, "mine").await;

    for uri in [LIST, DISABLE, DELETE] {
        let body = json!({ "session": "m-a", "id": id });
        let (status, _) = send(&h, Method::POST, uri, &[], body.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} without a token");
        let (status, _) =
            send(&h, Method::POST, uri, &[("Authorization", format!("Bearer {TOKEN}"))], body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} with only the bearer");
    }
    assert_eq!(row(&h, &id).await.expect("survives").enabled, 1);
    h.cleanup();
}

#[tokio::test]
async fn the_owners_workflow_may_be_paused_but_not_deleted() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let owners = owner_created(&h, "m-a", "Owner's daily check").await;

    let (status, body) = hook(&h, DELETE, &a, json!({ "session": "m-a", "id": owners })).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(
        body.to_string().contains("supermux-schedule disable"),
        "the refusal points at disable: {body}"
    );
    assert!(row(&h, &owners).await.is_some(), "a 403 deletes nothing");

    let (status, body) = hook(&h, DISABLE, &a, json!({ "session": "m-a", "id": owners })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["changed"], json!(true));
    assert_eq!(row(&h, &owners).await.expect("still there").enabled, 0);
    h.cleanup();
}

#[tokio::test]
async fn a_missing_id_is_a_400_and_an_unknown_one_a_404() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    for uri in [DISABLE, DELETE] {
        let (status, body) = hook(&h, uri, &a, json!({ "session": "m-a" })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {body}");
        let (status, body) = hook(&h, uri, &a, json!({ "session": "m-a", "id": "WF-nope" })).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}: {body}");
    }
    h.cleanup();
}

// ── the positives ────────────────────────────────────────────────────────────

#[tokio::test]
async fn list_shows_this_sessions_workflows_and_who_created_them() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let mine = agent_created(&h, "m-a", &a, "Ads test week check").await;
    let owners = owner_created(&h, "m-a", "Owner's daily check").await;

    let (status, body) = hook(&h, LIST, &a, json!({ "session": "m-a" })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["data"].as_array().expect("array");
    assert_eq!(rows.len(), 2, "{body}");
    let by_id = |id: &str| rows.iter().find(|r| r["id"] == json!(id)).expect("listed").clone();
    let m = by_id(&mine);
    assert_eq!(m["created_by_you"], json!(true));
    assert_eq!(m["enabled"], json!(true));
    assert_eq!(m["schedule_expr"], json!("every 12h"));
    assert_eq!(m["steps"][0]["prompt"], json!("look"));
    assert_eq!(by_id(&owners)["created_by_you"], json!(false));
    h.cleanup();
}

#[tokio::test]
async fn disable_pauses_and_is_idempotent() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let id = agent_created(&h, "m-a", &a, "mine").await;

    let (status, body) = hook(&h, DISABLE, &a, json!({ "session": "m-a", "id": id })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["changed"], json!(true));
    assert_eq!(row(&h, &id).await.expect("kept").enabled, 0);

    let (status, body) = hook(&h, DISABLE, &a, json!({ "session": "m-a", "id": id })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["changed"], json!(false));

    let audited = db::audit::has_action(&h.state.pool, "workflow.disable").await.unwrap();
    assert!(audited, "the pause is in the ledger");
    h.cleanup();
}

#[tokio::test]
async fn delete_removes_a_workflow_the_session_created_itself() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let id = agent_created(&h, "m-a", &a, "mine").await;

    let (status, body) = hook(&h, DELETE, &a, json!({ "session": "m-a", "id": id })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["deleted"], json!(true));
    assert!(row(&h, &id).await.is_none(), "gone from the live set");

    let (_, body) = hook(&h, LIST, &a, json!({ "session": "m-a" })).await;
    assert_eq!(body["data"], json!([]));

    // A second delete is a 404, not a second ledger row.
    let (status, _) = hook(&h, DELETE, &a, json!({ "session": "m-a", "id": id })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    h.cleanup();
}

// ── the cap counts armed workflows only ──────────────────────────────────────
//
// A bot that plans many one-off checks used to hit the 429 with nothing armed:
// every finished one-shot (switched off by the engine) and every paused
// workflow still counted, and only the owner could clear them.

async fn agent_once(h: &Harness, session: &str, token: &str, title: &str) -> (StatusCode, Value) {
    hook(
        h,
        CREATE,
        token,
        json!({ "session": session, "title": title, "prompt": "look", "schedule_expr": "in 20m" }),
    )
    .await
}

/// What the engine does when a one-shot fires: next_run NULL switches it off.
async fn fire_once(h: &Harness, id: &str) {
    db::workflows::record_fire(&h.state.pool, id, chrono::Utc::now(), None).await.unwrap();
}

async fn age_days(h: &Harness, id: &str, days: i64) {
    let ts = (chrono::Utc::now() - chrono::Duration::days(days)).timestamp();
    sqlx::query("UPDATE workflows SET updated = ? WHERE id = ?")
        .bind(ts)
        .bind(id)
        .execute(&h.state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn paused_and_finished_workflows_do_not_count_toward_the_cap() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let cap = supermux_server::workflows::MAX_WORKFLOWS_PER_SESSION;

    let mut ids = Vec::new();
    for i in 0..cap {
        let (status, body) = agent_once(&h, "m-a", &a, &format!("check {i}")).await;
        assert_eq!(status, StatusCode::CREATED, "#{i}: {body}");
        ids.push(body["data"]["id"].as_str().unwrap().to_string());
    }
    // Full: twenty armed one-shots.
    let (status, body) = agent_once(&h, "m-a", &a, "one too many").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(body.to_string().contains("pause or delete one"), "{body}");

    // A one-shot that has run frees its slot.
    fire_once(&h, &ids[0]).await;
    assert_eq!(row(&h, &ids[0]).await.expect("kept").enabled, 0, "the engine switched it off");
    let (status, body) = agent_once(&h, "m-a", &a, "after a finished one").await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Full again; a paused one frees its slot too.
    let (status, _) = agent_once(&h, "m-a", &a, "full again").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = hook(&h, DISABLE, &a, json!({ "session": "m-a", "id": ids[1] })).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = agent_once(&h, "m-a", &a, "after a paused one").await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Nothing was deleted to make room: the finished and paused rows are still
    // listed (they are days, not weeks, old).
    assert!(row(&h, &ids[0]).await.is_some());
    assert!(row(&h, &ids[1]).await.is_some());
    let (_, body) = hook(&h, LIST, &a, json!({ "session": "m-a" })).await;
    assert_eq!(body["data"].as_array().unwrap().len(), cap + 2);
    h.cleanup();
}

#[tokio::test]
async fn the_bearer_path_counts_armed_workflows_only_too() {
    let h = spawn_harness().await;
    make_session(&h, "m-a").await;
    let cap = supermux_server::workflows::MAX_WORKFLOWS_PER_SESSION;
    let bearer = [("Authorization", format!("Bearer {TOKEN}"))];
    let mut first = String::new();
    for i in 0..cap {
        let id = owner_created(&h, "m-a", &format!("owner {i}")).await;
        if i == 0 {
            first = id;
        }
    }
    let over = json!({ "title": "over", "session": "m-a", "steps": [{ "prompt": "x" }] });
    let (status, _) = send(&h, Method::POST, "/api/workflows", &bearer, over.clone()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

    let (status, body) = send(
        &h,
        Method::PATCH,
        &format!("/api/workflows/{first}"),
        &bearer,
        json!({ "enabled": false }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = send(&h, Method::POST, "/api/workflows", &bearer, over).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    h.cleanup();
}

#[tokio::test]
async fn only_the_sessions_own_week_old_finished_one_shots_are_tidied() {
    let h = spawn_harness().await;
    let a = make_session(&h, "m-a").await;
    let b = make_session(&h, "m-b").await;

    // Tidied: mine, a one-shot, ran, off for 8 days.
    let (_, body) = agent_once(&h, "m-a", &a, "old finished").await;
    let old_done = body["data"]["id"].as_str().unwrap().to_string();
    fire_once(&h, &old_done).await;
    age_days(&h, &old_done, 8).await;

    // Kept: mine, finished, but only 2 days ago.
    let (_, body) = agent_once(&h, "m-a", &a, "recent finished").await;
    let recent_done = body["data"]["id"].as_str().unwrap().to_string();
    fire_once(&h, &recent_done).await;
    age_days(&h, &recent_done, 2).await;

    // Kept: mine, a one-shot I paused before it ever ran.
    let (_, body) = agent_once(&h, "m-a", &a, "paused never ran").await;
    let paused_unrun = body["data"]["id"].as_str().unwrap().to_string();
    hook(&h, DISABLE, &a, json!({ "session": "m-a", "id": paused_unrun })).await;
    age_days(&h, &paused_unrun, 8).await;

    // Kept: mine, a recurring one that is paused (the owner may switch it back on).
    let paused_recurring = agent_created(&h, "m-a", &a, "paused recurring").await;
    hook(&h, DISABLE, &a, json!({ "session": "m-a", "id": paused_recurring })).await;
    age_days(&h, &paused_recurring, 8).await;

    // Kept: the owner's finished one-shot for me.
    let (status, body) = send(
        &h,
        Method::POST,
        "/api/workflows",
        &[("Authorization", format!("Bearer {TOKEN}"))],
        json!({ "title": "owner once", "session": "m-a", "schedule_expr": "in 20m",
                "steps": [{ "prompt": "x" }] }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let owners_done = body["data"]["id"].as_str().unwrap().to_string();
    fire_once(&h, &owners_done).await;
    age_days(&h, &owners_done, 8).await;

    // Kept: another session's old finished one-shot.
    let (_, body) = agent_once(&h, "m-b", &b, "B old finished").await;
    let theirs = body["data"]["id"].as_str().unwrap().to_string();
    fire_once(&h, &theirs).await;
    age_days(&h, &theirs, 8).await;

    // The tidy runs when m-a schedules its next check.
    let (status, body) = agent_once(&h, "m-a", &a, "next check").await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    assert!(row(&h, &old_done).await.is_none(), "my week-old finished one-shot is tidied");
    for (id, what) in [
        (&recent_done, "recent finished"),
        (&paused_unrun, "paused, never ran"),
        (&paused_recurring, "paused recurring"),
        (&owners_done, "the owner's"),
        (&theirs, "another session's"),
    ] {
        assert!(row(&h, id).await.is_some(), "{what} must survive");
    }
    // Soft delete only: the row and its history are still in the table.
    let deleted: Option<i64> = sqlx::query_scalar("SELECT deleted FROM workflows WHERE id = ?")
        .bind(&old_done)
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert!(deleted.is_some());
    h.cleanup();
}
