//! Granting a CATALOG card installs it — the chat connect card no longer 404s on
//! first use (`not found: connector 'pmcp-inhouseseo'`).
//!
//! Catalog cards (`pmcp-*`) are curated JSON, not `connectors` rows: they become
//! rows only when "installed". The store UI installs client-side before granting;
//! the chat **connect card** (a bot calling the `connect` MCP tool) goes straight
//! to grant/credential, so the FIRST use of every catalog connector 404'd. The fix
//! is server-side (`connectors::api::ensure_installed`) so every entry point agrees.
//!
//! Pinned here:
//!   1. `POST /grant` on a NEVER-installed catalog id installs + grants, writes the
//!      `connector.install` audit row, and the row carries the card's `emit` — so
//!      the granted bot's launch actually wires the MCP server (granted ≠ dead).
//!   2. An UNKNOWN id still 404s on grant — a member can never author a global row.
//!   3. `POST /credential` on a never-installed catalog id works the first time.
//!   4. `DELETE` does NOT auto-install (no resurrection), and a delete after the
//!      auto-install really removes the row.
//!   5. The store's client-side install shape (no `emit`) is backfilled from the
//!      catalog, so a store-installed card launches too.
//!
//! Modeled on `tests/connector_icloud.rs` (in-memory router + temp data dir).

use std::path::Path;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::sessions::connector_config;
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "catalog-install-token";
/// A curated catalog card that is NOT seeded at boot: Lane D (`mcp_oauth`, no
/// credential to paste) and a hosted-remote emit — exactly the live failure.
const CATALOG_ID: &str = "pmcp-inhouseseo";
const CATALOG_URL: &str = "https://app.inhouseseo.ai/api/mcp";
/// A curated Lane B card (one secret to paste) for the credential path.
const KEY_CARD_ID: &str = "pmcp-github";
const FAKE_TOKEN: &str = "ghp-not-a-real-token-0000";

fn test_config(data_dir: &Path) -> Config {
    Config {
        swarm_reaper: Default::default(),
        data_dir: data_dir.to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    }
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

/// The ids of the LOCAL (installed) rows — the catalog mirror is excluded.
async fn installed_ids(app: &axum::Router) -> Vec<String> {
    let (st, body) = send(app, Method::GET, "/api/connectors?source=local", None).await;
    assert_eq!(st, StatusCode::OK);
    body["connectors"]
        .as_array()
        .expect("connectors array")
        .iter()
        .filter_map(|c| c["id"].as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
async fn granting_a_catalog_card_installs_it() {
    let data_dir = std::env::temp_dir().join(format!("supermux-catinst-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let config = test_config(&data_dir);
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());

    // ── 0. Precondition: the catalog card is NOT a local row ──────────────────
    assert!(
        !installed_ids(&app).await.iter().any(|id| id == CATALOG_ID),
        "{CATALOG_ID} starts un-installed (it is a curated catalog card, not a row)"
    );
    // …but the READ side already resolves it from the mirror (the connect card's
    // schema fetch), which is exactly why only the WRITE side 404'd.
    let (st, card) = send(&app, Method::GET, &format!("/api/connectors/{CATALOG_ID}"), None).await;
    assert_eq!(st, StatusCode::OK, "the read side resolves the catalog card");
    assert_eq!(card["source"], json!("catalog"));

    // ── 1. The chat connect card's grant — the live failure ───────────────────
    let (st, resp) = send(
        &app,
        Method::POST,
        &format!("/api/connectors/{CATALOG_ID}/grant"),
        Some(json!({ "session_name": "alpha" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "grant installs the catalog card: {resp}");

    // The row now exists locally, carrying the curated card's identity + lane.
    assert!(
        installed_ids(&app).await.iter().any(|id| id == CATALOG_ID),
        "the grant materialized {CATALOG_ID} into the registry"
    );
    let (_, local) = send(&app, Method::GET, &format!("/api/connectors/{CATALOG_ID}"), None).await;
    assert_eq!(local["source"], json!("local"), "it resolves as an installed row now");
    assert_eq!(local["display_name"], json!("InhouseSEO"));
    assert_eq!(local["auth"]["kind"], json!("mcp_oauth"), "the curated Lane survives");
    assert!(
        local["categories"].as_array().unwrap().iter().any(|c| c == "data"),
        "the curated category chip survives: {}",
        local["categories"]
    );

    // The auto-install is audited with its provenance.
    let entries = db::audit::list(&state.pool, 50).await.unwrap();
    let install = entries
        .iter()
        .find(|e| e.action == "connector.install")
        .expect("the auto-install writes a connector.install audit row");
    assert_eq!(install.target, CATALOG_ID);
    assert!(install.detail.contains("grant"), "audit names the trigger: {}", install.detail);

    // ── 2. Granted ≠ dead: the launch actually wires the MCP server ───────────
    let alpha = connector_config::assemble(&state, "alpha")
        .await
        .unwrap()
        .expect("alpha has a grant => an active launch config");
    let mcp_json = alpha
        .launch_flags
        .iter()
        .find(|w| w.contains(CATALOG_ID))
        .expect("alpha's mcp-config names the connector");
    assert!(
        mcp_json.contains(CATALOG_URL),
        "the installed row carries the card's emit template: {mcp_json}"
    );

    // ── 3. An unknown id still 404s (no global row authoring) ─────────────────
    let (st, _) = send(
        &app,
        Method::POST,
        "/api/connectors/not-a-real-connector/grant",
        Some(json!({ "session_name": "alpha" })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "an unknown id is still a 404");
    assert!(!installed_ids(&app)
        .await
        .iter()
        .any(|id| id == "not-a-real-connector"));

    // ── 4. The credential path installs on first use too ──────────────────────
    assert!(!installed_ids(&app).await.iter().any(|id| id == KEY_CARD_ID));
    let (st, resp) = send(
        &app,
        Method::POST,
        &format!("/api/connectors/{KEY_CARD_ID}/credential"),
        Some(json!({
            "fields": { "GITHUB_TOKEN": FAKE_TOKEN },
            "session_name": "alpha"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "first-time credential seal on a catalog card: {resp}");
    assert!(resp["secret_ref"].is_string());
    assert!(!resp.to_string().contains(FAKE_TOKEN), "the echo stays masked");
    assert!(installed_ids(&app).await.iter().any(|id| id == KEY_CARD_ID));
    // A credential seal on an unknown id is still a 404.
    let (st, _) = send(
        &app,
        Method::POST,
        "/api/connectors/not-a-real-connector/credential",
        Some(json!({ "fields": { "K": "v" }, "session_name": "alpha" })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // ── 5. Delete does NOT auto-install, and really removes ───────────────────
    let (st, _) = send(&app, Method::DELETE, "/api/connectors/pmcp-notion", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "deleting an un-installed catalog card 404s");
    assert!(
        !installed_ids(&app).await.iter().any(|id| id == "pmcp-notion"),
        "a delete must never resurrect a catalog card as a row"
    );
    let (st, _) = send(&app, Method::DELETE, &format!("/api/connectors/{CATALOG_ID}"), None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(!installed_ids(&app).await.iter().any(|id| id == CATALOG_ID));

    state.pool.close().await;
    std::fs::remove_dir_all(&data_dir).ok();
}

/// The store's client-side install posts the card fields WITHOUT `emit`; the
/// server backfills the template from the catalog so a store-installed card can
/// launch (before this, `emit_json` landed as `null` and the granted bot got an
/// empty `mcpServers` entry).
#[tokio::test]
async fn the_store_install_shape_keeps_its_emit_template() {
    let data_dir = std::env::temp_dir().join(format!("supermux-catemit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let config = test_config(&data_dir);
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());

    // Exactly what `connector-detail.tsx` posts before it grants.
    let (st, _) = send(
        &app,
        Method::POST,
        "/api/connectors",
        Some(json!({
            "id": "pmcp-playwright",
            "kind": "mcp_catalog",
            "display_name": "Playwright",
            "icon": "",
            "description": "Drive a real browser.",
            "tools": [],
            "credentials": []
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = send(
        &app,
        Method::POST,
        "/api/connectors/pmcp-playwright/grant",
        Some(json!({ "session_name": "alpha" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let alpha = connector_config::assemble(&state, "alpha")
        .await
        .unwrap()
        .expect("alpha has a grant");
    let mcp_json = alpha
        .launch_flags
        .iter()
        .find(|w| w.contains("pmcp-playwright"))
        .expect("alpha's mcp-config names the connector");
    assert!(
        mcp_json.contains("@playwright/mcp"),
        "the store install keeps the catalog's emit template: {mcp_json}"
    );

    // A manifest that DECLARES its own emit is never overwritten by the catalog.
    let (st, _) = send(
        &app,
        Method::POST,
        "/api/connectors",
        Some(json!({
            "id": "pmcp-playwright",
            "kind": "mcp_catalog",
            "display_name": "Playwright",
            "emit": { "command": "my-own-binary", "args": [] }
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let alpha = connector_config::assemble(&state, "alpha").await.unwrap().unwrap();
    let mcp_json = alpha
        .launch_flags
        .iter()
        .find(|w| w.contains("pmcp-playwright"))
        .unwrap();
    assert!(mcp_json.contains("my-own-binary"), "a declared emit wins: {mcp_json}");

    state.pool.close().await;
    std::fs::remove_dir_all(&data_dir).ok();
}
