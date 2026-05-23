//! Board CRUD integration tests (TECH_PLAN §3.4, M6 acceptance; feature-extract
//! §2.1). Driven via `axum::Router::oneshot` against an isolated temp-dir DB.
//! Covers: create=201 + id prefix, list, patch, soft-delete + 404, clear-done,
//! claim error surfaces (404/409), statuses CRUD + builtin protection, tag
//! completion, the PUBLIC iCal feed, and auth enforcement.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "board-test-token";

async fn test_app() -> (axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-board-test-{}", uuid::Uuid::new_v4()));
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
    (http::router(state), dir)
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

async fn mk_session(app: &axum::Router, name: &str) {
    let (status, _) = send(
        app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": name, "provider": "shell" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

fn cleanup(dir: std::path::PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn create_lists_and_id_prefix() {
    let (app, dir) = test_app().await;
    mk_session(&app, "gel-astro").await;

    // No session → SUPERMUX prefix.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "unassigned task" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["data"]["id"], json!("SUPERMUX-1"));
    assert_eq!(body["data"]["status"], json!("todo"));
    assert_eq!(body["data"]["owner_type"], json!("human"));

    // Multi-word session → initials prefix.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "ship it", "session": "gel-astro", "tags": ["urgent", "be"] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["data"]["id"], json!("GA-1"));
    assert_eq!(body["data"]["session"], json!("gel-astro"));
    assert_eq!(body["data"]["tags"], json!(["be", "urgent"]));

    // Second SUPERMUX issue increments the counter.
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "another" })),
    )
    .await;
    assert_eq!(body["data"]["id"], json!("SUPERMUX-2"));

    // List returns all three.
    let (status, body) = send(&app, Method::GET, "/api/board", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().unwrap().len(), 3);

    cleanup(dir);
}

#[tokio::test]
async fn create_requires_title_and_known_refs() {
    let (app, dir) = test_app().await;

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "   " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "x", "status": "nonsense" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "x", "session": "ghost" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "x", "owner_type": "robot" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    cleanup(dir);
}

#[tokio::test]
async fn patch_updates_fields_and_tags() {
    let (app, dir) = test_app().await;
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "draft", "tags": ["a"] })),
    )
    .await;
    let id = body["data"]["id"].as_str().unwrap().to_string();

    let (status, body) = send(
        &app,
        Method::PATCH,
        &format!("/api/board/{id}"),
        Some(json!({ "title": "done draft", "status": "doing", "pinned": true, "tags": ["x", "y"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["title"], json!("done draft"));
    assert_eq!(body["data"]["status"], json!("doing"));
    assert_eq!(body["data"]["pinned"], json!(1));
    assert_eq!(body["data"]["tags"], json!(["x", "y"]));

    // Empty patch is a 400.
    let (status, _) = send(
        &app,
        Method::PATCH,
        &format!("/api/board/{id}"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Patch on a missing issue is a 404.
    let (status, _) = send(
        &app,
        Method::PATCH,
        "/api/board/NOPE-9",
        Some(json!({ "title": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    cleanup(dir);
}

#[tokio::test]
async fn soft_delete_then_gone_and_clear_done() {
    let (app, dir) = test_app().await;
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "trash me" })),
    )
    .await;
    let id = body["data"]["id"].as_str().unwrap().to_string();

    let (status, body) = send(&app, Method::DELETE, &format!("/api/board/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], json!(id));

    // Now invisible to list and a 404 to fetch via patch.
    let (_, body) = send(&app, Method::GET, "/api/board", None).await;
    assert_eq!(body["data"].as_array().unwrap().len(), 0);
    let (status, _) = send(&app, Method::DELETE, &format!("/api/board/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // clear-done: create + move two to done, leave one.
    for t in ["one", "two", "three"] {
        send(
            &app,
            Method::POST,
            "/api/board",
            Some(json!({ "title": t })),
        )
        .await;
    }
    let (_, body) = send(&app, Method::GET, "/api/board", None).await;
    let ids: Vec<String> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect();
    for id in ids.iter().take(2) {
        send(
            &app,
            Method::PATCH,
            &format!("/api/board/{id}"),
            Some(json!({ "status": "done" })),
        )
        .await;
    }
    let (status, body) = send(&app, Method::POST, "/api/board/clear-done", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["remaining"], json!(1));

    cleanup(dir);
}

#[tokio::test]
async fn claim_error_surfaces() {
    let (app, dir) = test_app().await;
    mk_session(&app, "worker").await;

    // Claiming a non-existent issue → 404.
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/board/NOPE-1/claim",
        Some(json!({ "session": "worker" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Human-owned issue → 409.
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "human task", "owner_type": "human" })),
    )
    .await;
    let human_id = body["data"]["id"].as_str().unwrap().to_string();
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/board/{human_id}/claim"),
        Some(json!({ "session": "worker" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["ok"], json!(false));

    // Agent task, wrong status (done) → 409.
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "agent task", "owner_type": "agent", "status": "done" })),
    )
    .await;
    let done_id = body["data"]["id"].as_str().unwrap().to_string();
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/board/{done_id}/claim"),
        Some(json!({ "session": "worker" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Claim with an unknown session → 400.
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "claimable", "owner_type": "agent", "status": "todo" })),
    )
    .await;
    let ok_id = body["data"]["id"].as_str().unwrap().to_string();
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/board/{ok_id}/claim"),
        Some(json!({ "session": "ghost" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Happy path → 200. The claim response is now `{ issue, delivered, steer_id }`
    // (S3): the issue moved to `doing`+assigned, and deliver defaults true so the
    // work was auto-sent (a steer enqueued, its id returned for the Undo toast).
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/board/{ok_id}/claim"),
        Some(json!({ "session": "worker" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["issue"]["status"], json!("doing"));
    assert_eq!(body["data"]["issue"]["session"], json!("worker"));
    assert_eq!(body["data"]["delivered"], json!(true));
    assert!(body["data"]["steer_id"].is_number(), "steer_id returned for Undo");

    // Re-claiming the now-doing issue → 409.
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/board/{ok_id}/claim"),
        Some(json!({ "session": "worker" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    cleanup(dir);
}

#[tokio::test]
async fn statuses_crud_and_builtin_protection() {
    let (app, dir) = test_app().await;

    // Six builtins seeded.
    let (status, body) = send(&app, Method::GET, "/api/board/statuses", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().unwrap().len(), 6);

    // Add a custom column.
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/board/statuses",
        Some(json!({ "label": "Blocked!" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let new_id = body["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(new_id, "blocked");
    assert_eq!(body["data"]["is_builtin"], json!(0));

    // Rename it.
    let (status, _) = send(
        &app,
        Method::PATCH,
        &format!("/api/board/statuses/{new_id}"),
        Some(json!({ "label": "On Hold" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Reorder (move custom column to the front).
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/board/statuses/reorder",
        Some(json!({ "order": [new_id, "backlog", "todo", "doing", "review", "done", "discarded"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = send(&app, Method::GET, "/api/board/statuses", None).await;
    assert_eq!(body["data"][0]["id"], json!(new_id));

    // Put an issue in the custom column, then delete the column → issue → todo.
    let (_, body) = send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "stuck", "status": new_id })),
    )
    .await;
    let issue_id = body["data"]["id"].as_str().unwrap().to_string();

    let (status, _) = send(
        &app,
        Method::DELETE,
        &format!("/api/board/statuses/{new_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = send(&app, Method::GET, "/api/board", None).await;
    let issue = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == json!(issue_id))
        .unwrap();
    assert_eq!(issue["status"], json!("todo"));

    // Built-ins cannot be deleted.
    let (status, _) = send(&app, Method::DELETE, "/api/board/statuses/todo", None).await;
    assert_eq!(status, StatusCode::CONFLICT);

    cleanup(dir);
}

#[tokio::test]
async fn tag_completion_aggregates() {
    let (app, dir) = test_app().await;
    for (t, st) in [("a", "todo"), ("b", "done"), ("c", "done")] {
        send(
            &app,
            Method::POST,
            "/api/board",
            Some(json!({ "title": t, "status": st, "tags": ["sprint"] })),
        )
        .await;
    }
    let (status, body) = send(
        &app,
        Method::GET,
        "/api/board/tag-completion?tag=sprint",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["total"], json!(3));
    assert_eq!(body["data"]["done"], json!(2));
    assert_eq!(body["data"]["complete"], json!(false));

    cleanup(dir);
}

#[tokio::test]
async fn calendar_ics_is_public_and_well_formed() {
    let (app, dir) = test_app().await;

    // All-day + timed issues with due dates.
    send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "all day, with; comma", "due": "2026-05-25" })),
    )
    .await;
    send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "timed", "due": "2026-05-26", "due_time": "14:30" })),
    )
    .await;
    // No due date → not in the feed.
    send(
        &app,
        Method::POST,
        "/api/board",
        Some(json!({ "title": "no due" })),
    )
    .await;

    // NO auth header — the feed is public (§2.7).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/calendar.ics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ct = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(ct.starts_with("text/calendar"), "content-type was {ct}");
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(body.to_vec()).unwrap();

    assert!(text.starts_with("BEGIN:VCALENDAR"));
    assert!(text.trim_end().ends_with("END:VCALENDAR"));
    assert_eq!(text.matches("BEGIN:VEVENT").count(), 2, "two issues have due");
    assert!(text.contains("DTSTART;VALUE=DATE:20260525"));
    assert!(text.contains("DTSTART:20260526T143000"));
    assert!(text.contains("DTEND:20260526T153000"));
    // RFC 5545 escaping of the summary.
    assert!(text.contains("SUMMARY:all day\\, with\\; comma"));
    // CRLF line endings.
    assert!(text.contains("\r\n"));

    cleanup(dir);
}

#[tokio::test]
async fn board_routes_require_auth_but_ical_does_not() {
    let (app, dir) = test_app().await;

    // Protected route without a token → 401.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/board")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // Public iCal without a token → 200.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/calendar.ics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    cleanup(dir);
}
