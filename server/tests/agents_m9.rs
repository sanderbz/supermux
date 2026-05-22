//! M9 acceptance integration tests (TECH_PLAN §10 "### M9 —", §3.4, §5).
//!
//! Driven via `axum::Router::oneshot` against an isolated temp-dir DB (same
//! pattern as `board.rs`). Covers the four §10 M9 acceptance criteria that don't
//! need live tmux:
//!   * `GET /api/slash-commands` returns the built-ins (~50) + skills.
//!   * `GET /api/kbd-groups` returns the four defaults on first read (seeded).
//!   * `/api/snippets` + `/api/skills` + `/api/agents/delegate` CRUD round-trip.
//!   * Steering exactly-once dequeue (the transactional pop) — see
//!     `steering_exactly_once`.
//!
//! The `wait` long-poll criterion has its own regression in `wait_race.rs`.

use amux_server::config::{Config, ProviderDefaults, TlsConfig};
use amux_server::state::AppState;
use amux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "agents-m9-test-token";

async fn test_app() -> (axum::Router, AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("amux-m9-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    (http::router(state.clone()), state, dir)
}

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    let req = match body {
        Some(b) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(b.to_string())).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

// ── slash-commands ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn slash_commands_returns_builtins_and_skills() {
    let (app, _state, dir) = test_app().await;

    let (status, body) = send(&app, Method::GET, "/api/slash-commands", None).await;
    assert_eq!(status, StatusCode::OK);
    let cmds = body["data"].as_array().expect("data array");
    // ~50 built-ins per §10 acceptance (the verbatim list is 55).
    assert!(cmds.len() >= 50, "expected ~50 built-ins, got {}", cmds.len());
    let names: Vec<&str> = cmds.iter().filter_map(|c| c["cmd"].as_str()).collect();
    assert!(names.contains(&"/compact"));
    assert!(names.contains(&"/status"));

    // Add a skill — it must appear in the merged list as `/<name>`.
    let skill_name = format!("m9testskill_{}", uuid::Uuid::new_v4().simple());
    let content = "---\ndescription: A test skill\nargument-hint: <foo>\n---\nbody";
    let (s, _) = send(
        &app,
        Method::POST,
        &format!("/api/skills/{skill_name}"),
        Some(json!({ "content": content })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let (_s, body2) = send(&app, Method::GET, "/api/slash-commands", None).await;
    let cmds2 = body2["data"].as_array().unwrap();
    let entry = cmds2
        .iter()
        .find(|c| c["cmd"] == json!(format!("/{skill_name}")))
        .expect("skill present in slash-commands");
    assert_eq!(entry["desc"], json!("A test skill"));

    // Cleanup the on-disk skill copies + DB.
    let (s, _) = send(&app, Method::DELETE, &format!("/api/skills/{skill_name}"), None).await;
    assert_eq!(s, StatusCode::OK);

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn slash_commands_requires_auth() {
    let (app, _state, dir) = test_app().await;
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/slash-commands")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

// ── skills CRUD ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn skills_crud_roundtrip_and_frontmatter() {
    let (app, _state, dir) = test_app().await;
    let name = format!("m9crud_{}", uuid::Uuid::new_v4().simple());
    let content = "---\ndescription: Crud desc\nargument-hint: <arg>\n---\nThe body.";

    // Create.
    let (s, _) = send(
        &app,
        Method::POST,
        &format!("/api/skills/{name}"),
        Some(json!({ "content": content })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    // List parses frontmatter into description + hint.
    let (_s, list) = send(&app, Method::GET, "/api/skills", None).await;
    let item = list["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!(name))
        .expect("skill in list");
    assert_eq!(item["description"], json!("Crud desc"));
    assert_eq!(item["hint"], json!("<arg>"));

    // Get returns full content.
    let (_s, got) = send(&app, Method::GET, &format!("/api/skills/{name}"), None).await;
    assert_eq!(got["data"]["content"], json!(content));

    // Filesystem sync wrote both copies.
    let home = dirs::home_dir().unwrap();
    let amux_path = home.join(".amux-v3/skills").join(format!("{name}.md"));
    let claude_path = home.join(".claude/commands").join(format!("{name}.md"));
    assert!(amux_path.exists(), "amux skill copy written");
    assert!(claude_path.exists(), "claude command copy written");

    // Delete removes DB row + fs copies.
    let (s, _) = send(&app, Method::DELETE, &format!("/api/skills/{name}"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert!(!amux_path.exists());
    assert!(!claude_path.exists());

    // Second delete is 404.
    let (s, _) = send(&app, Method::DELETE, &format!("/api/skills/{name}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn skill_name_traversal_rejected() {
    let (app, _state, dir) = test_app().await;
    // axum's path matcher won't even route a slash-containing name, but the
    // dotted-traversal token is route-able and must be 400.
    let (s, _) = send(
        &app,
        Method::POST,
        "/api/skills/..",
        Some(json!({ "content": "x" })),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(dir);
}

// ── kbd-groups (default seeding) ────────────────────────────────────────────────

#[tokio::test]
async fn kbd_groups_seed_defaults_on_first_read() {
    let (app, _state, dir) = test_app().await;

    let (status, body) = send(&app, Method::GET, "/api/kbd-groups", None).await;
    assert_eq!(status, StatusCode::OK);
    let groups = body["data"].as_array().expect("data array");
    assert_eq!(groups.len(), 4, "four defaults seeded on first GET");
    let names: Vec<&str> = groups.iter().filter_map(|g| g["name"].as_str()).collect();
    assert_eq!(names, vec!["Agent", "Shell", "Tmux", "Symbols"]);

    // Each group has a 4-key JSON payload.
    let agent = &groups[0];
    let keys: Vec<Value> = serde_json::from_str(agent["keys"].as_str().unwrap()).unwrap();
    assert_eq!(keys.len(), 4);
    assert_eq!(keys[0]["label"], json!("Esc"));
    assert_eq!(keys[0]["key"], json!("Escape"));

    // A second GET does NOT re-seed (still 4, not 8).
    let (_s, body2) = send(&app, Method::GET, "/api/kbd-groups", None).await;
    assert_eq!(body2["data"].as_array().unwrap().len(), 4);

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn kbd_groups_crud() {
    let (app, _state, dir) = test_app().await;
    // Trigger seeding.
    let _ = send(&app, Method::GET, "/api/kbd-groups", None).await;

    // Create requires exactly 4 keys.
    let (s, _) = send(
        &app,
        Method::POST,
        "/api/kbd-groups",
        Some(json!({ "name": "Bad", "keys": [{"label":"a","key":"a"}] })),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, created) = send(
        &app,
        Method::POST,
        "/api/kbd-groups",
        Some(json!({
            "name": "Custom",
            "keys": [
                {"label":"1","key":"1"},{"label":"2","key":"2"},
                {"label":"3","key":"3"},{"label":"4","key":"4"}
            ]
        })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let id = created["id"].as_i64().unwrap();

    // Patch the name.
    let (s, _) = send(
        &app,
        Method::PATCH,
        &format!("/api/kbd-groups/{id}"),
        Some(json!({ "name": "Renamed" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (_s, list) = send(&app, Method::GET, "/api/kbd-groups", None).await;
    assert!(list["data"]
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["name"] == json!("Renamed")));

    // Delete.
    let (s, _) = send(&app, Method::DELETE, &format!("/api/kbd-groups/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = send(&app, Method::DELETE, &format!("/api/kbd-groups/{id}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(dir);
}

/// `PUT /api/kbd-groups` — whole-list replace (M24b integration fix). The M16
/// manage-sheet funnels every reorder / add / remove through this single
/// canonical write. Replaces the seeded defaults wholesale, then verifies the
/// list is exactly the new content (old rows gone, new order preserved).
#[tokio::test]
async fn kbd_groups_replace_whole_list() {
    let (app, _state, dir) = test_app().await;
    // Seed the four defaults.
    let _ = send(&app, Method::GET, "/api/kbd-groups", None).await;

    // Replace the WHOLE list with two new groups.
    let four = |p: &str| {
        json!([
            {"label": format!("{p}1"), "key": format!("{p}1")},
            {"label": format!("{p}2"), "key": format!("{p}2")},
            {"label": format!("{p}3"), "key": format!("{p}3")},
            {"label": format!("{p}4"), "key": format!("{p}4")},
        ])
    };
    let (s, body) = send(
        &app,
        Method::PUT,
        "/api/kbd-groups",
        Some(json!({
            "groups": [
                { "name": "First",  "keys": four("a") },
                { "name": "Second", "keys": four("b") },
            ]
        })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let groups = body["data"].as_array().expect("replace returns the list");
    assert_eq!(groups.len(), 2, "the old four defaults are fully replaced");
    let names: Vec<&str> = groups.iter().filter_map(|g| g["name"].as_str()).collect();
    assert_eq!(names, vec!["First", "Second"], "order preserved by position");

    // A fresh GET reflects the replacement (no stale rows).
    let (_s, list) = send(&app, Method::GET, "/api/kbd-groups", None).await;
    assert_eq!(list["data"].as_array().unwrap().len(), 2);

    // A group with the wrong key count is rejected — the whole PUT is atomic, so
    // a rejected request leaves the prior list untouched.
    let (s, _) = send(
        &app,
        Method::PUT,
        "/api/kbd-groups",
        Some(json!({ "groups": [{ "name": "Bad", "keys": [{"label":"x","key":"x"}] }] })),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (_s, still) = send(&app, Method::GET, "/api/kbd-groups", None).await;
    assert_eq!(
        still["data"].as_array().unwrap().len(),
        2,
        "a rejected replace must not mutate the table"
    );

    let _ = std::fs::remove_dir_all(dir);
}

// ── snippets CRUD ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn snippets_crud() {
    let (app, _state, dir) = test_app().await;

    let (status, empty) = send(&app, Method::GET, "/api/snippets", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["data"].as_array().unwrap().len(), 0);

    let (s, created) = send(
        &app,
        Method::POST,
        "/api/snippets",
        Some(json!({ "title": "compact", "body": "/compact" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let id = created["id"].as_i64().unwrap();

    let (_s, list) = send(&app, Method::GET, "/api/snippets", None).await;
    let row = &list["data"].as_array().unwrap()[0];
    assert_eq!(row["title"], json!("compact"));
    assert_eq!(row["body"], json!("/compact"));

    let (s, _) = send(
        &app,
        Method::PATCH,
        &format!("/api/snippets/{id}"),
        Some(json!({ "body": "/compact now" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let (s, _) = send(&app, Method::DELETE, &format!("/api/snippets/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = send(&app, Method::DELETE, &format!("/api/snippets/{id}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(dir);
}

// ── delegations + audit ────────────────────────────────────────────────────────

#[tokio::test]
async fn delegate_missing_session_is_404() {
    let (app, _state, dir) = test_app().await;
    let (s, _) = send(
        &app,
        Method::POST,
        "/api/agents/delegate",
        Some(json!({ "from": "ghost", "to": "phantom", "prompt": "hi" })),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn delegations_records_edge_and_audit() {
    let (app, state, dir) = test_app().await;
    // Two sessions so the FK + send_text path is satisfiable. `to` is a shell
    // session; send_text auto-wakes via tmux which won't exist in CI — so we
    // record the edge directly through the db layer to assert the graph + audit
    // wiring without needing live tmux.
    db::sessions::insert_minimal(&state.pool, "boss", "/tmp", "shell").await.unwrap();
    db::sessions::insert_minimal(&state.pool, "worker", "/tmp", "shell").await.unwrap();

    let id = db::audit::record_delegation(&state.pool, "boss", "worker", "do the thing")
        .await
        .unwrap();
    assert!(id > 0);
    db::audit::log(
        &state.pool,
        "agent:boss",
        "session.delegate",
        "worker",
        json!({ "from": "boss" }),
    )
    .await
    .unwrap();

    // GET delegations?session=boss → one outgoing edge.
    let (s, body) = send(&app, Method::GET, "/api/agents/delegations?session=boss", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["data"]["outgoing"].as_array().unwrap().len(), 1);
    assert_eq!(body["data"]["incoming"].as_array().unwrap().len(), 0);
    assert_eq!(body["data"]["outgoing"][0]["to_session"], json!("worker"));

    // worker sees one incoming.
    let (_s, body2) = send(&app, Method::GET, "/api/agents/delegations?session=worker", None).await;
    assert_eq!(body2["data"]["incoming"].as_array().unwrap().len(), 1);

    // The audit endpoint surfaces the delegate row (newest first).
    let (s, audit) = send(&app, Method::GET, "/api/audit?limit=10", None).await;
    assert_eq!(s, StatusCode::OK);
    let rows = audit["data"].as_array().unwrap();
    assert!(rows.iter().any(|r| r["action"] == json!("session.delegate")
        && r["actor"] == json!("agent:boss")
        && r["target"] == json!("worker")));
    // Secret hygiene: the prompt body must NOT appear in the audit detail (§6.4).
    assert!(rows
        .iter()
        .all(|r| !r["detail"].as_str().unwrap_or("").contains("do the thing")));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn audit_requires_auth() {
    let (app, _state, dir) = test_app().await;
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/audit")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

// ── steering exactly-once delivery (the transactional pop) ──────────────────────

#[tokio::test]
async fn steering_exactly_once() {
    let (_app, state, dir) = test_app().await;
    db::sessions::insert_minimal(&state.pool, "steered", "/tmp", "shell").await.unwrap();

    // Queue three messages.
    db::steering::enqueue(&state.pool, "steered", "first").await.unwrap();
    db::steering::enqueue(&state.pool, "steered", "second").await.unwrap();
    db::steering::enqueue(&state.pool, "steered", "third").await.unwrap();

    // The transactional pop delivers oldest-first, one per call.
    assert_eq!(db::steering::pop_oldest(&state.pool, "steered").await.unwrap().as_deref(), Some("first"));
    assert_eq!(db::steering::pop_oldest(&state.pool, "steered").await.unwrap().as_deref(), Some("second"));

    // Concurrency: parallel pops on the remaining ONE message ⇒ exactly one gets
    // it, the rest get None (no double-delivery). This is the exactly-once
    // guarantee the §10 acceptance criterion demands. `pop_oldest` retries
    // transient SQLITE_BUSY internally, so the count is deterministic.
    let mut handles = Vec::new();
    for _ in 0..12 {
        let pool = state.pool.clone();
        handles.push(tokio::spawn(async move {
            db::steering::pop_oldest(&pool, "steered").await.unwrap()
        }));
    }
    let mut delivered = 0;
    for h in handles {
        if h.await.unwrap().is_some() {
            delivered += 1;
        }
    }
    assert_eq!(delivered, 1, "the last message must be delivered exactly once");

    // Queue is now empty.
    assert!(db::steering::pop_oldest(&state.pool, "steered").await.unwrap().is_none());

    let _ = std::fs::remove_dir_all(dir);
}
