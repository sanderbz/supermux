//! Supermux-brokered OAuth for remote MCP servers — end to end against an
//! IN-PROCESS mock authorization server + mock MCP (no internet, no Claude).
//!
//! The mock (one axum app on `127.0.0.1:0`) plays both roles:
//!   * `POST /mcp` — 401 + `WWW-Authenticate: Bearer resource_metadata=…` until
//!     the bearer is one it minted, then a JSON-RPC `initialize` result, a 202 for
//!     `notifications/initialized`, and a two-tool `tools/list` result (the probe
//!     runs all three; the counters tell them apart);
//!   * `/.well-known/oauth-protected-resource` (RFC 9728) → `resource = /mcp`,
//!     `authorization_servers = [self]`;
//!   * `/.well-known/oauth-authorization-server` (RFC 8414) → issuer = self,
//!     `authorization_response_iss_parameter_supported: true`;
//!   * `POST /register` (RFC 7591) → a client id AND a client secret;
//!   * `GET /authorize` → straight back to `redirect_uri?code&state&iss`;
//!   * `POST /token` — checks `code_verifier` (S256), `resource`, `redirect_uri`,
//!     `client_secret`; issues `expires_in: 3600` + a refresh token; a refresh
//!     ROTATES the token and a re-use of the old one 401s `invalid_grant` and
//!     revokes the whole family;
//!   * `GET /userinfo` → `{"email":"owner@test"}`.
//!
//! The supermux side is the real `http::router` driven with `tower::oneshot`,
//! with the test-only `UrlPolicy { allow_loopback_http: true }` so the broker
//! may talk to the loopback mock. Every assertion below is a line of the design's
//! §7.3.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Query, State as AxState};
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use supermux_server::auth_human::AuthContext;
use supermux_server::config::{CompanyHost, Config, ProviderDefaults, TlsConfig};
use supermux_server::connectors::oauth_code::{self, UrlPolicy};
use supermux_server::db::connectors;
use supermux_server::external_access::store;
use supermux_server::scope::OptCtx;
use supermux_server::sessions::connector_config;
use supermux_server::state::AppState;
use supermux_server::vault::Vault;
use supermux_server::{db, http};

const TOKEN: &str = "oauth-e2e-token";
const ID: &str = "remote-oauth";
/// The supermux `Host` the browser used (a loopback owner transport → http).
const BOX_HOST: &str = "127.0.0.1:8824";

// ── the mock AS + MCP ───────────────────────────────────────────────────────────

#[derive(Default)]
struct MockState {
    base: String,
    registrations: Vec<Value>,
    next_client: u32,
    clients: HashMap<String, String>, // client_id → client_secret
    codes: HashMap<String, (String, String, String)>, // code → (challenge, redirect_uri, resource)
    next_token: u32,
    /// Live access tokens.
    access: HashSet<String>,
    /// refresh token → family id
    refresh: HashMap<String, u32>,
    /// A rotated-away refresh token (dead); reuse revokes its family.
    dead_refresh: HashMap<String, u32>,
    revoked_families: HashSet<u32>,
    /// access token → family
    access_family: HashMap<String, u32>,
    initialize_authed: u32,
    tools_list_authed: u32,
    refresh_calls: u32,
    refresh_forms: Vec<HashMap<String, String>>,
    exchange_forms: Vec<HashMap<String, String>>,
    refuse_refresh: bool,
}

type Mock = Arc<Mutex<MockState>>;

fn b64url(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn bearer_of(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
}

async fn mock_mcp(AxState(m): AxState<Mock>, headers: HeaderMap, body: String) -> Response {
    let mut g = m.lock().unwrap();
    let ok = bearer_of(&headers)
        .filter(|t| g.access.contains(t))
        .filter(|t| !g.revoked_families.contains(g.access_family.get(t).unwrap_or(&u32::MAX)))
        .is_some();
    if ok {
        let req: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let reply = match method {
            "initialize" => {
                g.initialize_authed += 1;
                json!({ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18", "capabilities": { "tools": {} }, "serverInfo": { "name": "mock", "version": "1" } } })
            }
            "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
            "tools/list" => {
                g.tools_list_authed += 1;
                json!({ "jsonrpc": "2.0", "id": 2, "result": { "tools": [
                    { "name": "echo", "inputSchema": { "type": "object" } },
                    { "name": "whoami", "inputSchema": { "type": "object" } },
                ] } })
            }
            _ => json!({ "jsonrpc": "2.0", "id": 0, "error": { "code": -32601, "message": "not implemented" } }),
        };
        return ([(header::CONTENT_TYPE, "application/json")], reply.to_string()).into_response();
    }
    let www = format!(r#"Bearer resource_metadata="{}/.well-known/oauth-protected-resource""#, g.base);
    (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, www)]).into_response()
}

async fn mock_prm(AxState(m): AxState<Mock>) -> Response {
    let g = m.lock().unwrap();
    (
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "resource": format!("{}/mcp", g.base), "authorization_servers": [g.base.clone()], "scopes_supported": ["mcp:tools"] }).to_string(),
    )
        .into_response()
}

async fn mock_as_meta(AxState(m): AxState<Mock>) -> Response {
    let g = m.lock().unwrap();
    let b = &g.base;
    (
        [(header::CONTENT_TYPE, "application/json")],
        json!({
            "issuer": b,
            "authorization_endpoint": format!("{b}/authorize"),
            "token_endpoint": format!("{b}/token"),
            "registration_endpoint": format!("{b}/register"),
            "userinfo_endpoint": format!("{b}/userinfo"),
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
            "authorization_response_iss_parameter_supported": true,
        })
        .to_string(),
    )
        .into_response()
}

async fn mock_register(AxState(m): AxState<Mock>, Json(body): Json<Value>) -> Response {
    let mut g = m.lock().unwrap();
    g.next_client += 1;
    let id = format!("client-{}", g.next_client);
    let secret = format!("secret-{}", g.next_client);
    g.clients.insert(id.clone(), secret.clone());
    g.registrations.push(body.clone());
    (
        StatusCode::CREATED,
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "client_id": id, "client_secret": secret, "redirect_uris": body["redirect_uris"] }).to_string(),
    )
        .into_response()
}

async fn mock_authorize(AxState(m): AxState<Mock>, Query(q): Query<HashMap<String, String>>) -> Response {
    let mut g = m.lock().unwrap();
    assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
    assert_eq!(q.get("code_challenge_method").map(String::as_str), Some("S256"));
    let code = format!("code-{}", g.codes.len() + 1);
    g.codes.insert(
        code.clone(),
        (
            q.get("code_challenge").cloned().unwrap_or_default(),
            q.get("redirect_uri").cloned().unwrap_or_default(),
            q.get("resource").cloned().unwrap_or_default(),
        ),
    );
    let loc = format!(
        "{}?code={}&state={}&iss={}",
        q.get("redirect_uri").cloned().unwrap_or_default(),
        code,
        q.get("state").cloned().unwrap_or_default(),
        urlencoding_min(&g.base),
    );
    (StatusCode::FOUND, [(header::LOCATION, loc)]).into_response()
}

/// Just enough percent-encoding for an `http://127.0.0.1:port` issuer.
fn urlencoding_min(s: &str) -> String {
    s.replace(':', "%3A").replace('/', "%2F")
}

fn oauth_err(status: StatusCode, code: &str) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], json!({ "error": code }).to_string()).into_response()
}

fn mint(g: &mut MockState, family: u32) -> Value {
    g.next_token += 1;
    let at = format!("at-{}", g.next_token);
    let rt = format!("rt-{}", g.next_token);
    g.access.insert(at.clone());
    g.access_family.insert(at.clone(), family);
    g.refresh.insert(rt.clone(), family);
    json!({ "access_token": at, "token_type": "Bearer", "expires_in": 3600, "refresh_token": rt, "scope": "mcp:tools" })
}

async fn mock_token(AxState(m): AxState<Mock>, Form(f): Form<HashMap<String, String>>) -> Response {
    let mut g = m.lock().unwrap();
    let client_id = f.get("client_id").cloned().unwrap_or_default();
    let Some(secret) = g.clients.get(&client_id).cloned() else {
        return oauth_err(StatusCode::UNAUTHORIZED, "invalid_client");
    };
    if f.get("client_secret") != Some(&secret) {
        return oauth_err(StatusCode::UNAUTHORIZED, "invalid_client");
    }
    match f.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            g.exchange_forms.push(f.clone());
            let code = f.get("code").cloned().unwrap_or_default();
            let Some((challenge, redirect_uri, resource)) = g.codes.remove(&code) else {
                return oauth_err(StatusCode::UNAUTHORIZED, "invalid_grant");
            };
            let verifier = f.get("code_verifier").cloned().unwrap_or_default();
            if b64url(&Sha256::digest(verifier.as_bytes())) != challenge {
                return oauth_err(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            if f.get("redirect_uri") != Some(&redirect_uri) || f.get("resource") != Some(&resource) {
                return oauth_err(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            let family = g.next_token + 1000;
            let body = mint(&mut g, family);
            ([(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
        }
        Some("refresh_token") => {
            g.refresh_calls += 1;
            g.refresh_forms.push(f.clone());
            if g.refuse_refresh {
                return oauth_err(StatusCode::UNAUTHORIZED, "invalid_grant");
            }
            let rt = f.get("refresh_token").cloned().unwrap_or_default();
            if let Some(fam) = g.dead_refresh.get(&rt).copied() {
                // Reuse detection: the whole family dies.
                g.revoked_families.insert(fam);
                return oauth_err(StatusCode::UNAUTHORIZED, "invalid_grant");
            }
            let Some(fam) = g.refresh.remove(&rt) else {
                return oauth_err(StatusCode::UNAUTHORIZED, "invalid_grant");
            };
            if g.revoked_families.contains(&fam) {
                return oauth_err(StatusCode::UNAUTHORIZED, "invalid_grant");
            }
            g.dead_refresh.insert(rt, fam);
            let body = mint(&mut g, fam);
            ([(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
        }
        _ => oauth_err(StatusCode::BAD_REQUEST, "unsupported_grant_type"),
    }
}

async fn mock_userinfo(AxState(m): AxState<Mock>, headers: HeaderMap) -> Response {
    let g = m.lock().unwrap();
    if bearer_of(&headers).is_some_and(|t| g.access.contains(&t)) {
        return ([(header::CONTENT_TYPE, "application/json")], json!({ "email": "owner@test", "sub": "u1" }).to_string()).into_response();
    }
    StatusCode::UNAUTHORIZED.into_response()
}

async fn spawn_mock() -> (Mock, String) {
    let m: Mock = Arc::new(Mutex::new(MockState::default()));
    let app = Router::new()
        .route("/mcp", post(mock_mcp))
        .route("/.well-known/oauth-protected-resource", get(mock_prm))
        .route("/.well-known/oauth-protected-resource/mcp", get(mock_prm))
        .route("/.well-known/oauth-authorization-server", get(mock_as_meta))
        .route("/register", post(mock_register))
        .route("/authorize", get(mock_authorize))
        .route("/token", post(mock_token))
        .route("/userinfo", get(mock_userinfo))
        .with_state(m.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{port}");
    m.lock().unwrap().base = base.clone();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (m, base)
}

// ── the supermux side ───────────────────────────────────────────────────────────

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

struct Harness {
    state: AppState,
    app: Router,
    mock: Mock,
    base: String,
    data_dir: std::path::PathBuf,
}

async fn harness() -> Harness {
    let data_dir = std::env::temp_dir().join(format!("supermux-oauth-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let config = test_config(&data_dir);
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    state.set_oauth_url_policy_for_tests(UrlPolicy { allow_loopback_http: true });
    let (mock, base) = spawn_mock().await;
    let app = http::router(state.clone());
    // A remote-OAuth connector whose emit points at the mock.
    connectors::upsert(
        &state.pool,
        ID,
        "mcp_catalog",
        "Remote OAuth",
        "",
        "",
        "[]",
        "[]",
        &json!({ "type": "http", "url": format!("{base}/mcp") }).to_string(),
        r#"{"imported":true,"auth":{"kind":"mcp_oauth"}}"#,
    )
    .await
    .unwrap();
    for s in ["bot", "bot-a", "bot-b"] {
        db::sessions::insert_minimal(&state.pool, s, "/tmp", "claude").await.unwrap();
    }
    Harness { state, app, mock, base, data_dir }
}

async fn send(app: &Router, method: Method, uri: &str, bearer: bool, host: Option<&str>, body: Option<Value>) -> (StatusCode, HeaderMap, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    if bearer {
        b = b.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    }
    if let Some(h) = host {
        b = b.header(header::HOST, h);
    }
    let req = match body {
        Some(v) => b.header(header::CONTENT_TYPE, "application/json").body(Body::from(v.to_string())).unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    (status, headers, v)
}

async fn start(h: &Harness, session: &str, return_to: &str, host: &str) -> (StatusCode, Value) {
    let (st, _, v) = send(
        &h.app,
        Method::POST,
        &format!("/api/connectors/{ID}/oauth/start"),
        true,
        Some(host),
        Some(json!({ "session_name": session, "return_to": return_to })),
    )
    .await;
    (st, v)
}

/// Follow the authorize URL against the mock (a real HTTP GET, no redirects) and
/// return the path+query the provider sent the browser back to.
async fn follow_authorize(authorize_url: &str) -> String {
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let r = client.get(authorize_url).send().await.unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::FOUND);
    let loc = r.headers().get(header::LOCATION).unwrap().to_str().unwrap().to_string();
    let u = url::Url::parse(&loc).unwrap();
    assert_eq!(u.host_str(), Some("127.0.0.1"));
    assert_eq!(u.port(), Some(8824));
    format!("{}?{}", u.path(), u.query().unwrap_or(""))
}

async fn callback(h: &Harness, path_and_query: &str) -> (StatusCode, HeaderMap) {
    let (st, headers, _) = send(&h.app, Method::GET, path_and_query, false, None, None).await;
    (st, headers)
}

fn location(headers: &HeaderMap) -> String {
    headers.get(header::LOCATION).unwrap().to_str().unwrap().to_string()
}

async fn complete(h: &Harness, state: &str) -> (StatusCode, Value) {
    let (st, _, v) = send(
        &h.app,
        Method::POST,
        &format!("/api/connectors/{ID}/oauth/complete"),
        true,
        None,
        Some(json!({ "state": state })),
    )
    .await;
    (st, v)
}

/// One whole owner flow for `session`: start → authorize → callback → complete.
async fn full_flow(h: &Harness, session: &str) -> Value {
    let (st, v) = start(h, session, &format!("/store/{ID}"), BOX_HOST).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let cb = follow_authorize(v["authorize_url"].as_str().unwrap()).await;
    let (st, headers) = callback(h, &cb).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), format!("/store/{ID}?oauth_pending=1"));
    let (st, out) = complete(h, v["state"].as_str().unwrap()).await;
    assert_eq!(st, StatusCode::OK, "{out}");
    out
}

async fn counts(state: &AppState) -> (i64, i64, i64) {
    let a: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM connector_accounts").fetch_one(&state.pool).await.unwrap();
    let g: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_connectors").fetch_one(&state.pool).await.unwrap();
    let v: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault").fetch_one(&state.pool).await.unwrap();
    (a, g, v)
}

async fn vault_fields(h: &Harness, secret_ref: &str) -> std::collections::BTreeMap<String, String> {
    let vault = Vault::open(&h.data_dir).unwrap();
    let row = connectors::vault_get(&h.state.pool, secret_ref).await.unwrap().unwrap();
    vault.open_fields(&row.fields_enc, &row.nonce).unwrap()
}

async fn reseal(h: &Harness, secret_ref: &str, fields: &std::collections::BTreeMap<String, String>) {
    let vault = Vault::open(&h.data_dir).unwrap();
    let sealed = vault.seal(fields).unwrap();
    connectors::vault_put(&h.state.pool, secret_ref, ID, &sealed.fields_enc, &sealed.nonce, false).await.unwrap();
}

fn mcp_entry(fin: &connector_config::FinishedConfig) -> Value {
    let i = fin.launch_flags.iter().position(|w| w == "--mcp-config").expect("--mcp-config");
    let cfg: Value = serde_json::from_str(&fin.launch_flags[i + 1]).unwrap();
    cfg["mcpServers"][ID].clone()
}

// ── tests ───────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn start_discovers_registers_once_and_fences_the_redirect_host() {
    let h = harness().await;

    // 1. start → authorize URL shape + one DCR registration with the secret cached.
    let (st, v) = start(&h, "bot", "/store/remote-oauth", BOX_HOST).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let auth = url::Url::parse(v["authorize_url"].as_str().unwrap()).unwrap();
    let q: HashMap<String, String> = auth.query_pairs().into_owned().collect();
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["resource"], format!("{}/mcp", h.base));
    assert_eq!(q["redirect_uri"], "http://127.0.0.1:8824/api/oauth/callback");
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["scope"], "mcp:tools");
    assert!(q["state"].len() >= 32);
    assert_eq!(v["expires_in"], json!(600));
    let cfg = store::read_or_default(&h.data_dir).unwrap();
    assert_eq!(cfg.mcp_oauth_clients.len(), 1);
    assert_eq!(cfg.mcp_oauth_clients[0].client_secret.as_deref(), Some("secret-1"));
    assert_eq!(cfg.mcp_oauth_clients[0].redirect_uri, "http://127.0.0.1:8824/api/oauth/callback");
    assert_eq!(h.mock.lock().unwrap().registrations.len(), 1);
    let reg = h.mock.lock().unwrap().registrations[0].clone();
    assert_eq!(reg["redirect_uris"], json!(["http://127.0.0.1:8824/api/oauth/callback"]));
    assert_eq!(reg["token_endpoint_auth_method"], json!("none"));

    // A second start does NOT register twice.
    let (st, _) = start(&h, "bot", "/store/remote-oauth", BOX_HOST).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(h.mock.lock().unwrap().registrations.len(), 1, "never register twice for the same key");

    // An EPHEMERAL (quick-tunnel) host is refused, fail-closed; an unknown host too.
    let mut cfg = store::read_or_default(&h.data_dir).unwrap();
    cfg.company_hosts.push(CompanyHost {
        host: "calm-frog.trycloudflare.com".into(),
        company_id: 1,
        redirect_uri: "https://calm-frog.trycloudflare.com/auth/callback".into(),
        ephemeral: true,
    });
    store::write_atomic(&h.data_dir, &cfg).unwrap();
    h.state.reload_human_auth().unwrap();
    let (st, v) = start(&h, "bot", "/store", "calm-frog.trycloudflare.com").await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    assert!(v["error"].as_str().unwrap().contains("not available on this address"));
    let (st, _) = start(&h, "bot", "/store", "evil.example.net").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // A tailnet host is an owner transport → https redirect.
    let (st, v) = start(&h, "bot", "/store", "box.taild681cb.ts.net").await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v["authorize_url"].as_str().unwrap().contains("https%3A%2F%2Fbox.taild681cb.ts.net%2Fapi%2Foauth%2Fcallback"));

    // A 6th concurrent start evicts the oldest: never more than 5 live flows.
    for _ in 0..6 {
        let (st, _) = start(&h, "bot", "/store", BOX_HOST).await;
        assert_eq!(st, StatusCode::OK);
    }
    let owner_flows = h.state.oauth_code_flows.iter().filter(|e| e.value().initiator == "owner").count();
    assert_eq!(owner_flows, 5);

    // A bad return_to is refused up front.
    let (st, _) = start(&h, "bot", "//evil", BOX_HOST).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn callback_stashes_only_and_complete_seals_grants_and_probes() {
    let h = harness().await;
    let (st, v) = start(&h, "bot", "/store/remote-oauth", BOX_HOST).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let flow_state = v["state"].as_str().unwrap().to_string();

    // 2. authorize → callback: a 302 back to return_to + oauth_pending, no-store,
    //    the state NOT in the URL, and the DB untouched.
    let cb = follow_authorize(v["authorize_url"].as_str().unwrap()).await;
    let (st, headers) = callback(&h, &cb).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store/remote-oauth?oauth_pending=1");
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
    assert!(!location(&headers).contains(&flow_state));
    assert_eq!(counts(&h.state).await, (0, 0, 0), "the public callback writes nothing");
    assert_eq!(h.mock.lock().unwrap().exchange_forms.len(), 1);
    let form = h.mock.lock().unwrap().exchange_forms[0].clone();
    assert_eq!(form["client_secret"], "secret-1", "the DCR secret rides the exchange");
    assert_eq!(form["resource"], format!("{}/mcp", h.base));

    // A replayed callback for the same state is a uniform failure.
    let (st, headers) = callback(&h, &cb).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store?connect_error=state");

    // 2 (cont). complete as the initiator → account + grant + a REAL probe.
    let (st, out) = complete(&h, &flow_state).await;
    assert_eq!(st, StatusCode::OK, "{out}");
    assert_eq!(out["label"], json!("owner@test"));
    assert_eq!(out["health"]["status"], json!("ok"));
    assert_eq!(out["target"], json!("bot"));
    assert_eq!(h.mock.lock().unwrap().initialize_authed, 1, "exactly one authenticated initialize");
    assert_eq!(h.mock.lock().unwrap().tools_list_authed, 1, "the probe ran a REAL tools/list with the bearer");
    assert_eq!(out["health"]["tool_count"], json!(2), "the count the server actually listed: {out}");
    assert_eq!(out["health"]["message"], json!("Server answered — 2 tools."));
    let accounts = connectors::accounts_for_connector(&h.state.pool, ID).await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].account_label, "owner@test");
    assert_eq!(accounts[0].status, "active");
    assert_eq!(accounts[0].health.as_deref(), Some("ok"));
    assert!(accounts[0].last_checked_at > 0);
    let secret_ref = accounts[0].secret_ref.clone().unwrap();
    let fields = vault_fields(&h, &secret_ref).await;
    let keys: Vec<&String> = fields.keys().collect();
    assert_eq!(keys, vec!["MCP_OAUTH_ACCESS_TOKEN", "MCP_OAUTH_EXPIRES_AT", "MCP_OAUTH_META", "MCP_OAUTH_REFRESH_TOKEN"]);
    assert_eq!(fields["MCP_OAUTH_ACCESS_TOKEN"], "at-1");

    // The session's grant carries the secret and is NOT applied yet (never started).
    let (st, _, sc) = send(&h.app, Method::GET, "/api/sessions/bot/connectors", true, None, None).await;
    assert_eq!(st, StatusCode::OK);
    let g = &sc["connectors"][0];
    assert_eq!(g["connector_id"], json!(ID));
    assert_eq!(g["has_secret"], json!(true));
    assert_eq!(g["applied"], json!(false));
    assert_eq!(g["running"], json!(false));
    assert_eq!(g["account"]["account_label"], json!("owner@test"));
    assert_eq!(g["account"]["health"], json!("ok"));

    // A second complete with the consumed state → 404 (single use).
    let (st, _) = complete(&h, &flow_state).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Once the bot starts after the grant, `applied` flips.
    db::sessions::bump_start(&h.state.pool, "bot").await.unwrap();
    let (_, _, sc) = send(&h.app, Method::GET, "/api/sessions/bot/connectors", true, None, None).await;
    assert_eq!(sc["connectors"][0]["applied"], json!(true));
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn complete_by_another_identity_is_refused_and_a_missing_iss_never_reaches_it() {
    let h = harness().await;
    let (st, v) = start(&h, "bot", "/store", BOX_HOST).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let flow_state = v["state"].as_str().unwrap().to_string();
    let cb = follow_authorize(v["authorize_url"].as_str().unwrap()).await;
    let (st, _) = callback(&h, &cb).await;
    assert_eq!(st, StatusCode::FOUND);

    // 3. A DIFFERENT admin identity than the initiator (owner) → 404, flow consumed.
    let other = OptCtx(Some(AuthContext::Human { user_id: 9, company_id: None, role: "admin".into() }));
    let r = oauth_code::complete(
        axum::extract::State(h.state.clone()),
        other,
        axum::extract::Path(ID.to_string()),
        Json(oauth_code::CompleteBody { state: flow_state.clone() }),
    )
    .await;
    assert!(matches!(r, Err(supermux_server::error::AppError::NotFound(_))), "{r:?}");
    assert_eq!(counts(&h.state).await, (0, 0, 0), "no DB change");
    assert!(!h.state.oauth_code_flows.contains_key(&flow_state), "consumed");
    // …and the rightful owner can't finish it either now.
    let (st, _) = complete(&h, &flow_state).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // A callback WITHOUT `iss` on an AS that supports it → connect_error=issuer.
    let (st, v) = start(&h, "bot", "/store/x?y=1", BOX_HOST).await;
    assert_eq!(st, StatusCode::OK);
    let cb = follow_authorize(v["authorize_url"].as_str().unwrap()).await;
    let no_iss: String = cb.split('&').filter(|p| !p.starts_with("iss=")).collect::<Vec<_>>().join("&");
    let (st, headers) = callback(&h, &no_iss).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store/x?y=1&connect_error=issuer", "`&` when return_to had a query");
    let (st, _) = complete(&h, v["state"].as_str().unwrap()).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "the flow died at the callback");
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn launch_injects_a_placeholder_header_refreshes_at_launch_and_rotates() {
    let h = harness().await;
    full_flow(&h, "bot").await;

    // 4. assemble("bot") → the entry + the token in env only.
    let fin = connector_config::assemble(&h.state, "bot").await.unwrap().expect("active");
    let entry = mcp_entry(&fin);
    assert_eq!(entry["type"], json!("http"));
    assert_eq!(entry["url"], json!(format!("{}/mcp", h.base)));
    assert_eq!(entry["headers"]["Authorization"], json!("Bearer ${SUPERMUX_MCP_TOKEN_REMOTE_OAUTH}"));
    assert_eq!(fin.env.get("SUPERMUX_MCP_TOKEN_REMOTE_OAUTH").map(String::as_str), Some("at-1"));
    let flags = fin.launch_flags.join(" ");
    assert!(!flags.contains("at-1") && !flags.contains("rt-1"), "no plaintext in flags: {flags}");
    let settings_i = fin.launch_flags.iter().position(|w| w == "--settings").unwrap();
    let settings = std::fs::read_to_string(&fin.launch_flags[settings_i + 1]).unwrap();
    assert!(!settings.contains("at-1") && !settings.contains("rt-1"));
    assert!(!fin.env.values().any(|v| v == "rt-1"), "the refresh token never enters the env");
    let acct = connectors::accounts_for_connector(&h.state.pool, ID).await.unwrap().remove(0);
    assert!(acct.last_used_at > 0);
    assert_eq!(h.mock.lock().unwrap().refresh_calls, 0, "fresh token: no refresh");

    // 5. About to expire → assemble refreshes (carrying the client_secret), the
    //    vault row now holds the ROTATED refresh token, rotated_at > 0.
    let secret_ref = acct.secret_ref.clone().unwrap();
    let mut fields = vault_fields(&h, &secret_ref).await;
    fields.insert("MCP_OAUTH_EXPIRES_AT".into(), (chrono::Utc::now().timestamp() + 60).to_string());
    reseal(&h, &secret_ref, &fields).await;
    let fin = connector_config::assemble(&h.state, "bot").await.unwrap().expect("active");
    assert_eq!(h.mock.lock().unwrap().refresh_calls, 1);
    let rf = h.mock.lock().unwrap().refresh_forms[0].clone();
    assert_eq!(rf["client_secret"], "secret-1", "client_secret rides the refresh too");
    assert_eq!(rf["resource"], format!("{}/mcp", h.base));
    assert_eq!(fin.env.get("SUPERMUX_MCP_TOKEN_REMOTE_OAUTH").map(String::as_str), Some("at-2"));
    let fields = vault_fields(&h, &secret_ref).await;
    assert_eq!(fields["MCP_OAUTH_REFRESH_TOKEN"], "rt-2", "rotated");
    assert_eq!(fields["MCP_OAUTH_ACCESS_TOKEN"], "at-2");
    let row = connectors::vault_get(&h.state.pool, &secret_ref).await.unwrap().unwrap();
    assert!(row.rotated_at > 0);
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn two_bot_re_sign_in_reseals_the_same_row_and_never_trips_reuse_detection() {
    let h = harness().await;
    // 6. Sign in for bot-a, grant the same account to bot-b.
    let out = full_flow(&h, "bot-a").await;
    let account_ref = out["account_ref"].as_str().unwrap().to_string();
    let (st, _, _) = send(
        &h.app,
        Method::POST,
        &format!("/api/connectors/{ID}/grant"),
        true,
        None,
        Some(json!({ "session_name": "bot-b", "account_ref": account_ref })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let acct = connectors::account_get(&h.state.pool, &account_ref).await.unwrap().unwrap();
    let secret_ref = acct.secret_ref.clone().unwrap();

    // A SECOND full flow for bot-a (same label) re-seals the SAME secret_ref.
    let out2 = full_flow(&h, "bot-a").await;
    assert_eq!(out2["account_ref"], json!(account_ref));
    let acct2 = connectors::account_get(&h.state.pool, &account_ref).await.unwrap().unwrap();
    assert_eq!(acct2.secret_ref.as_deref(), Some(secret_ref.as_str()), "re-sealed in place");
    assert_eq!(counts(&h.state).await.2, 1, "exactly one vault row for the account");
    let fields = vault_fields(&h, &secret_ref).await;
    assert_eq!(fields["MCP_OAUTH_ACCESS_TOKEN"], "at-2", "the fresh token");
    let row = connectors::vault_get(&h.state.pool, &secret_ref).await.unwrap().unwrap();
    assert!(row.rotated_at > 0);

    // bot-b presents the FRESH token…
    let fin = connector_config::assemble(&h.state, "bot-b").await.unwrap().expect("active");
    assert_eq!(fin.env.get("SUPERMUX_MCP_TOKEN_REMOTE_OAUTH").map(String::as_str), Some("at-2"));
    // …and a later refresh from bot-b succeeds (the old family's rt-1 is never replayed).
    let mut fields = vault_fields(&h, &secret_ref).await;
    fields.insert("MCP_OAUTH_EXPIRES_AT".into(), (chrono::Utc::now().timestamp() + 10).to_string());
    reseal(&h, &secret_ref, &fields).await;
    let fin = connector_config::assemble(&h.state, "bot-b").await.unwrap().expect("active");
    assert_eq!(fin.env.get("SUPERMUX_MCP_TOKEN_REMOTE_OAUTH").map(String::as_str), Some("at-3"));
    assert!(h.mock.lock().unwrap().revoked_families.is_empty(), "reuse detection never tripped");
    // Both bots are wired to the one account.
    let grants = connectors::grants_for_connector(&h.state.pool, ID).await.unwrap();
    assert_eq!(grants.len(), 2);
    assert!(grants.iter().all(|g| g.secret_ref.as_deref() == Some(secret_ref.as_str())));
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn a_refused_refresh_still_emits_the_entry_and_marks_the_account_honestly() {
    let h = harness().await;
    full_flow(&h, "bot").await;
    let acct = connectors::accounts_for_connector(&h.state.pool, ID).await.unwrap().remove(0);
    let secret_ref = acct.secret_ref.clone().unwrap();
    let mut fields = vault_fields(&h, &secret_ref).await;
    fields.insert("MCP_OAUTH_EXPIRES_AT".into(), (chrono::Utc::now().timestamp() + 10).to_string());
    reseal(&h, &secret_ref, &fields).await;
    h.mock.lock().unwrap().refuse_refresh = true;

    // 7. The entry is STILL emitted (stale bearer), the account reads disconnected/expired.
    let fin = connector_config::assemble(&h.state, "bot").await.unwrap().expect("active");
    let entry = mcp_entry(&fin);
    assert_eq!(entry["headers"]["Authorization"], json!("Bearer ${SUPERMUX_MCP_TOKEN_REMOTE_OAUTH}"));
    assert_eq!(fin.env.get("SUPERMUX_MCP_TOKEN_REMOTE_OAUTH").map(String::as_str), Some("at-1"));
    let acct = connectors::account_get(&h.state.pool, &acct.id).await.unwrap().unwrap();
    assert_eq!(acct.status, "disconnected");
    assert_eq!(acct.health.as_deref(), Some("expired"));
    assert_eq!(acct.last_error.as_deref(), Some("Sign-in expired — reconnect"));
    let (_, _, sc) = send(&h.app, Method::GET, "/api/sessions/bot/connectors", true, None, None).await;
    assert_eq!(sc["connectors"][0]["has_secret"], json!(true));
    assert_eq!(sc["connectors"][0]["account"]["status"], json!("disconnected"));
    assert_eq!(sc["connectors"][0]["account"]["health"], json!("expired"));
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn every_callback_failure_is_a_uniform_redirect_with_no_db_change() {
    let h = harness().await;
    let (st, v) = start(&h, "bot", "/store/x?y=1", BOX_HOST).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let st_ok = v["state"].as_str().unwrap().to_string();
    let iss = urlencoding_min(&h.base);

    // 8. tampered iss
    let (st, headers) = callback(&h, &format!("/api/oauth/callback?code=x&state={st_ok}&iss=http%3A%2F%2Fevil.example")).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store/x?y=1&connect_error=issuer");
    assert!(!h.state.oauth_code_flows.contains_key(&st_ok), "flow removed");

    // error=access_denied → denied
    let (_, v) = start(&h, "bot", "/store/x?y=1", BOX_HOST).await;
    let s2 = v["state"].as_str().unwrap().to_string();
    let (st, headers) = callback(&h, &format!("/api/oauth/callback?error=access_denied&state={s2}&iss={iss}")).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store/x?y=1&connect_error=denied");

    // error=<800 chars> → still just `denied` (the code is clamped for the log).
    let (_, v) = start(&h, "bot", "/store", BOX_HOST).await;
    let s3 = v["state"].as_str().unwrap().to_string();
    let long = "x".repeat(800);
    let (st, headers) = callback(&h, &format!("/api/oauth/callback?error={long}&state={s3}&iss={iss}")).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store?connect_error=denied");

    // unknown / replayed state → state (we have no flow, so /store)
    let (st, headers) = callback(&h, "/api/oauth/callback?code=x&state=nope").await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store?connect_error=state");
    let (st, headers) = callback(&h, "/api/oauth/callback").await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store?connect_error=state");
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");

    // a bad code → exchange
    let (_, v) = start(&h, "bot", "/store", BOX_HOST).await;
    let s4 = v["state"].as_str().unwrap().to_string();
    let (st, headers) = callback(&h, &format!("/api/oauth/callback?code=bogus&state={s4}&iss={iss}")).await;
    assert_eq!(st, StatusCode::FOUND);
    assert_eq!(location(&headers), "/store?connect_error=exchange");

    assert_eq!(counts(&h.state).await, (0, 0, 0), "no DB change on any failure");
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn grant_fence_derives_the_secret_from_the_account_and_scopes_members() {
    let h = harness().await;
    // Company A (id 1) with a bot, company B (id 2) with a bot + an account.
    for (name, cid) in [("a-bot", 1_i64), ("b-bot", 2_i64)] {
        sqlx::query("INSERT INTO sessions (name, dir, provider, company_id, created_at) VALUES (?, '/tmp', 'claude', ?, ?)")
            .bind(name)
            .bind(cid)
            .bind(chrono::Utc::now().timestamp())
            .execute(&h.state.pool)
            .await
            .unwrap();
    }
    let out = full_flow(&h, "b-bot").await;
    let b_account = out["account_ref"].as_str().unwrap().to_string();
    let b_secret = connectors::account_get(&h.state.pool, &b_account).await.unwrap().unwrap().secret_ref.unwrap();

    // 9. A member of company A granting company B's account to their bot → 404.
    let member_a = OptCtx(Some(AuthContext::Human { user_id: 3, company_id: Some(1), role: "member".into() }));
    let r = supermux_server::connectors::api::grant(
        axum::extract::State(h.state.clone()),
        member_a,
        axum::extract::Path(ID.to_string()),
        Json(supermux_server::connectors::api::GrantBody {
            session_name: "a-bot".into(),
            secret_ref: Some(b_secret.clone()),
            account_ref: Some(b_account.clone()),
            enabled: true,
        }),
    )
    .await;
    assert!(matches!(r, Err(supermux_server::error::AppError::NotFound(_))), "{r:?}");
    assert!(connectors::grants_for_session(&h.state.pool, "a-bot").await.unwrap().is_empty());

    // The owner passing a FOREIGN secret_ref with a valid account_ref: the stored
    // secret_ref is the ACCOUNT's, never the body's.
    let (st, _, _) = send(
        &h.app,
        Method::POST,
        &format!("/api/connectors/{ID}/grant"),
        true,
        None,
        Some(json!({ "session_name": "bot", "account_ref": b_account, "secret_ref": "attacker-supplied" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let g = connectors::grants_for_session(&h.state.pool, "bot").await.unwrap().remove(0);
    assert_eq!(g.secret_ref.as_deref(), Some(b_secret.as_str()));
    std::fs::remove_dir_all(&h.data_dir).ok();
}

#[tokio::test]
async fn the_callback_is_public_and_start_complete_are_not() {
    let h = harness().await;
    // 10. Callback without a bearer answers (a redirect, not a 401).
    let (st, _) = callback(&h, "/api/oauth/callback?state=nope").await;
    assert_eq!(st, StatusCode::FOUND);
    // start / complete without a bearer → 401.
    let (st, _, _) = send(&h.app, Method::POST, &format!("/api/connectors/{ID}/oauth/start"), false, Some(BOX_HOST), Some(json!({ "session_name": "bot" }))).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _, _) = send(&h.app, Method::POST, &format!("/api/connectors/{ID}/oauth/complete"), false, None, Some(json!({ "state": "x" }))).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    // A non-OAuth card refuses to start.
    connectors::upsert(&h.state.pool, "plain-key", "mcp_catalog", "Key", "", "", "[]", "[]", r#"{"url":"https://x.example/mcp"}"#, r#"{"auth":{"kind":"api_key"}}"#).await.unwrap();
    let (st, _, v) = send(&h.app, Method::POST, "/api/connectors/plain-key/oauth/start", true, Some(BOX_HOST), Some(json!({ "session_name": "bot" }))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    std::fs::remove_dir_all(&h.data_dir).ok();
}
