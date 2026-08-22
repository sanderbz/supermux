//! End-to-end test for the first AGENT-AUTHORED connector — iCloud Mail
//! (connector-store spec §10). Drives the real Axum router + boot seed and pins
//! the three load-bearing properties:
//!
//!   1. **Lists as a store card.** After the boot seed, `GET /api/connectors`
//!      returns an `icloud-mail` card (kind `agent_authored`) with its three
//!      tools and its credential SCHEMA — and never a secret value.
//!   2. **The grant scopes it per-agent.** A credential write that grants the
//!      connector to `alpha` makes `assemble()` inject the icloud MCP server +
//!      the decrypted secret env into ALPHA's launch — and inject NOTHING into
//!      an ungranted `beta` (byte-identical launch).
//!   3. **The secret is vaulted, not plaintext on disk.** The app-specific
//!      password appears in NO file under the data dir (only the AES-GCM vault
//!      ciphertext), never in the API echo, never in the connector manifest.
//!
//! Modeled on `tests/recall_http.rs` (in-memory router + temp-dir).

use std::path::{Path, PathBuf};

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::connectors::icloud;
use supermux_server::sessions::connector_config;
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "icloud-connector-token";
// A throwaway app-specific password shape (NOT a real credential) used only to
// prove it never lands in plaintext on disk or in an API response.
const FAKE_APP_PW: &str = "abcd-efgh-ijkl-mnop";
const FAKE_EMAIL: &str = "tester@icloud.com";

fn test_config(data_dir: &Path) -> Config {
    Config {
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

/// Recursively collect every regular file under `dir`.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

#[tokio::test]
async fn icloud_connector_lists_grants_and_vaults_the_secret() {
    let data_dir = std::env::temp_dir().join(format!("supermux-icloud-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();

    let config = test_config(&data_dir);
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);

    // Boot seed: write the embedded MCP server + upsert the manifest.
    icloud::seed(&state).await;
    let app = http::router(state.clone());

    // The embedded MCP server is materialized on disk where emit points.
    let server_path = icloud::server_path(&data_dir);
    assert!(server_path.exists(), "icloud MCP server.py must be written to disk");
    let server_src = std::fs::read_to_string(&server_path).unwrap();
    assert!(server_src.contains("imap.mail.me.com"), "server speaks IMAP");
    assert!(server_src.contains("smtp.mail.me.com"), "server speaks SMTP");

    // ── 1. Lists as a store card (secret-free) ────────────────────────────────
    let (st, body) = send(&app, Method::GET, "/api/connectors?source=local", None).await;
    assert_eq!(st, StatusCode::OK);
    let cards = body["connectors"].as_array().expect("connectors array");
    let card = cards
        .iter()
        .find(|c| c["id"] == json!("icloud-mail"))
        .expect("icloud-mail lists as a store card");
    assert_eq!(card["kind"], json!("agent_authored"));
    assert_eq!(card["display_name"], json!("iCloud Mail"));
    let tool_names: Vec<&str> = card["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(tool_names.contains(&"list_inbox"));
    assert!(tool_names.contains(&"read_message"));
    assert!(tool_names.contains(&"send_message"));
    // Credential SCHEMA is present (field names/flags) — never a value.
    let creds = card["credentials"].as_array().unwrap();
    let pw = creds.iter().find(|c| c["key"] == json!("ICLOUD_APP_PW")).unwrap();
    assert_eq!(pw["sensitive"], json!(true));
    let card_text = card.to_string();
    assert!(!card_text.contains(FAKE_APP_PW), "no secret in the card");

    // ── 2. Write the credential to the vault + one-tap grant to alpha ──────────
    let (st, resp) = send(
        &app,
        Method::POST,
        "/api/connectors/icloud-mail/credential",
        Some(json!({
            "fields": { "ICLOUD_EMAIL": FAKE_EMAIL, "ICLOUD_APP_PW": FAKE_APP_PW },
            "session_name": "alpha"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "credential write ok: {resp}");
    assert!(resp["secret_ref"].is_string(), "a secret_ref is minted");
    // The echo is masked — the value never comes back out.
    assert_eq!(resp["fields"]["ICLOUD_APP_PW"], json!("••• set"));
    assert!(!resp.to_string().contains(FAKE_APP_PW), "response never echoes the secret");

    // The grant is visible on alpha's connector list (secret-free), NOT beta's.
    let (_, alpha) = send(&app, Method::GET, "/api/sessions/alpha/connectors", None).await;
    let a_ids: Vec<&str> = alpha["connectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["connector_id"].as_str().unwrap())
        .collect();
    assert!(a_ids.contains(&"icloud-mail"), "alpha is granted icloud-mail");
    let a_card = alpha["connectors"][0].clone();
    assert_eq!(a_card["has_secret"], json!(true), "grant carries a vaulted secret");

    let (_, beta) = send(&app, Method::GET, "/api/sessions/beta/connectors", None).await;
    let b_ids: Vec<&str> = beta["connectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["connector_id"].as_str().unwrap())
        .collect();
    assert!(!b_ids.contains(&"icloud-mail"), "beta is NOT granted — per-agent scoping");

    // ── 3. The scoping seam injects the secret into ALPHA only ────────────────
    let alpha_cfg = connector_config::assemble(&state, "alpha")
        .await
        .unwrap()
        .expect("alpha has a grant => an active launch config");
    // The icloud MCP server is wired into alpha's inline --mcp-config.
    assert!(alpha_cfg.launch_flags.iter().any(|w| w == "--mcp-config"));
    assert!(alpha_cfg.launch_flags.iter().any(|w| w == "--strict-mcp-config"));
    let mcp_json = alpha_cfg
        .launch_flags
        .iter()
        .find(|w| w.contains("icloud-mail"))
        .expect("alpha's mcp-config names icloud-mail");
    assert!(mcp_json.contains("python3"), "emit launches the python server");
    // The decrypted secret is injected as env for alpha — the ONLY place the
    // plaintext exists at runtime, in the granted child's environment.
    assert_eq!(
        alpha_cfg.env.get("ICLOUD_APP_PW").map(String::as_str),
        Some(FAKE_APP_PW)
    );
    assert_eq!(
        alpha_cfg.env.get("ICLOUD_EMAIL").map(String::as_str),
        Some(FAKE_EMAIL)
    );

    // Beta (ungranted, no memory) gets NO config at all — byte-identical launch.
    let beta_cfg = connector_config::assemble(&state, "beta").await.unwrap();
    assert!(beta_cfg.is_none(), "ungranted beta gets a byte-identical launch");

    // ── 4. The secret is NOT plaintext anywhere on disk ───────────────────────
    let mut files = Vec::new();
    walk(&data_dir, &mut files);
    assert!(!files.is_empty());
    for f in &files {
        let bytes = std::fs::read(f).unwrap_or_default();
        assert!(
            !bytes.windows(FAKE_APP_PW.len()).any(|w| w == FAKE_APP_PW.as_bytes()),
            "secret found in plaintext on disk: {f:?}"
        );
    }

    state.pool.close().await;
    std::fs::remove_dir_all(&data_dir).ok();
}
