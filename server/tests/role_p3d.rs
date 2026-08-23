//! P3d integration matrix — role semantics (owner / admin / member) over the REAL
//! router with human-auth enabled and the Google OIDC exchange behind a mock.
//!
//! Three callers:
//!   * owner — the bearer token (omniscient);
//!   * carol — an ADMIN human (`role=admin`, `company_id NULL`, omniscient);
//!   * alice — a scoped MEMBER (`role=member`, company 1).
//!
//! The security properties under test (design §P3d / owner-confirmed role model):
//!   * A member CANNOT reach the global-admin routers — companies mutate, hosts,
//!     scheduler, prefs writes, audit, push — all return a uniform 404.
//!   * `GET /api/companies` returns ONLY the member's own company (the switcher
//!     shows just theirs); owner/admin see the whole roster.
//!   * A member CAN create an agent in their OWN company, but a `company_id` for
//!     another company is a uniform 404.
//!   * A member CAN grant a connector into their own company scope
//!     (`@company:<their id>`), but NOT `*` (global all-agents) nor another
//!     company (`@company:<other>`) — all 404.
//!   * The owner (bearer) and an ADMIN human bypass every gate.

use std::sync::Arc;

use supermux_server::auth_human::oidc::MockOidcVerifier;
use supermux_server::config::{CompanyHost, Config, HumanAuthConfig, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tower::ServiceExt;

const TOKEN: &str = "owner-secret-token";
const HOST_A: &str = "acme.test";
const HOST_B: &str = "beta.test";

struct Fixture {
    app: axum::Router,
    root_a: std::path::PathBuf,
}

fn human_auth_cfg() -> HumanAuthConfig {
    HumanAuthConfig {
        google_client_id: Some("client-123.apps.googleusercontent.com".to_string()),
        google_client_secret: Some("google-secret".to_string()),
        owner_email: None,
        company_hosts: vec![
            CompanyHost {
                host: HOST_A.to_string(),
                company_id: 1,
                redirect_uri: format!("https://{HOST_A}/auth/callback"),
                ephemeral: false,
            },
            CompanyHost {
                host: HOST_B.to_string(),
                company_id: 2,
                redirect_uri: format!("https://{HOST_B}/auth/callback"),
                ephemeral: false,
            },
        ],
        owner_hosts: Vec::new(),
        cookie_key: b"cookie-key-cookie-key-cookie-key0".to_vec(),
        csrf_key: b"csrf-key0-csrf-key0-csrf-key0-csr".to_vec(),
        invite_key: b"invite-key0-invite-key0-invite-k".to_vec(),
        session_ttl_secs: 3600,
        base_domain: None,
    }
}

async fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("supermux-p3d-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root_a = dir.join("company-a");
    let root_b = dir.join("company-b");
    std::fs::create_dir_all(&root_a).unwrap();
    std::fs::create_dir_all(&root_b).unwrap();

    let config = Config {
        data_dir: dir.clone(),
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
        human_auth: human_auth_cfg(),
    };
    let pool = db::init(&config).await.expect("db init");

    let a = db::companies::create(&pool, "acme", "Acme", &root_a.to_string_lossy())
        .await
        .expect("company A");
    let b = db::companies::create(&pool, "beta", "Beta", &root_b.to_string_lossy())
        .await
        .expect("company B");
    assert_eq!((a.id, b.id), (1, 2), "company ids are 1,2 as the hosts expect");

    // alice: a scoped MEMBER of company 1. carol: an ADMIN (company NULL).
    db::human_users::insert(&pool, "alice@acme.test", "Alice", Some(1), "member")
        .await
        .expect("seed alice");
    db::human_users::insert(&pool, "carol@corp.test", "Carol", None, "admin")
        .await
        .expect("seed carol");

    // A connector definition the grant tests target.
    db::connectors::upsert(&pool, "mail", "mcp", "Mail", "", "desc", "[]", "[]", "{}", "{}")
        .await
        .expect("seed connector");

    let state = AppState::new(pool, config);
    let mock = Arc::new(MockOidcVerifier::new());
    mock.insert("alice-code", "alice@acme.test", None, None);
    mock.insert("carol-code", "carol@corp.test", None, None);
    state.human_auth.set_verifier(mock);

    let app = http::router(state.clone());
    Fixture { app, root_a }
}

// ── login + request helpers ─────────────────────────────────────────────────────

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn set_cookie(resp: &axum::response::Response, name: &str) -> Option<String> {
    for hv in resp.headers().get_all(header::SET_COOKIE) {
        let s = hv.to_str().ok()?;
        if let Some(rest) = s.strip_prefix(&format!("{name}=")) {
            return Some(rest.split(';').next().unwrap_or("").to_string());
        }
    }
    None
}

/// Drive /auth/login → /auth/callback on `host`; return (session_cookie, csrf).
async fn login(app: &axum::Router, host: &str, code: &str) -> (String, String) {
    let login = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/login")
                .header(header::HOST, host)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::FOUND, "login 302");
    let loc = login.headers().get(header::LOCATION).unwrap().to_str().unwrap().to_string();
    let st = query_param(&loc, "state").expect("state param");
    let cb = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/auth/callback?code={code}&state={st}"))
                .header(header::HOST, host)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cb.status(), StatusCode::FOUND, "callback 302 to /");
    let sess = set_cookie(&cb, "supermux_hsess").expect("session cookie");
    let csrf = set_cookie(&cb, "supermux_csrf").expect("csrf cookie");
    (sess, csrf)
}

async fn status_of(resp: axum::response::Response) -> StatusCode {
    resp.status()
}

async fn get_cookie(app: &axum::Router, uri: &str, cookie: &str) -> StatusCode {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    status_of(resp).await
}

async fn get_cookie_body(app: &axum::Router, uri: &str, cookie: &str) -> (StatusCode, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

async fn get_bearer(app: &axum::Router, uri: &str) -> (StatusCode, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

async fn send_cookie(
    app: &axum::Router,
    method: &str,
    uri: &str,
    cookie: &str,
    csrf: &str,
    body: serde_json::Value,
) -> StatusCode {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .header("x-supermux-csrf", csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    status_of(resp).await
}

async fn send_bearer(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> StatusCode {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    status_of(resp).await
}

// ── the matrix ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn member_cannot_reach_global_admin_routers() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;
    let nf = StatusCode::NOT_FOUND;

    // companies CRUD (create/rename/archive/delete) — all 404 for a member.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/companies", &alice, &csrf,
            serde_json::json!({"slug":"x","display_name":"X","root_dir":"/tmp/x"})).await,
        nf, "member 404s POST /api/companies");
    assert_eq!(
        send_cookie(&f.app, "PATCH", "/api/companies/1", &alice, &csrf,
            serde_json::json!({"display_name":"Renamed"})).await,
        nf, "member 404s PATCH /api/companies/{{id}}");
    assert_eq!(
        send_cookie(&f.app, "DELETE", "/api/companies/2", &alice, &csrf,
            serde_json::json!({})).await,
        nf, "member 404s DELETE /api/companies/{{id}}");

    // hosts CRUD — whole router owner/admin-only.
    assert_eq!(get_cookie(&f.app, "/api/hosts", &alice).await, nf, "member 404s GET /api/hosts");
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/hosts", &alice, &csrf,
            serde_json::json!({"label":"h","ssh":"u@h"})).await,
        nf, "member 404s POST /api/hosts");

    // scheduler CRUD — whole router owner/admin-only.
    assert_eq!(get_cookie(&f.app, "/api/schedules", &alice).await, nf, "member 404s GET /api/schedules");
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/schedules", &alice, &csrf,
            serde_json::json!({"prompt":"x","schedule_expr":"@daily","target":"y"})).await,
        nf, "member 404s POST /api/schedules");

    // prefs — P3d deny-by-default: BOTH writes AND reads are denied for a member
    // (prefs are not on the member allowlist; the backstop 404s the whole
    // surface). The `require_admin_writes_mw` on this router is defense-in-depth.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/snippets", &alice, &csrf,
            serde_json::json!({"title":"t","body":"b"})).await,
        nf, "member 404s POST /api/snippets (a prefs write)");
    assert_eq!(
        send_cookie(&f.app, "PUT", "/api/prefs/overview_sort", &alice, &csrf,
            serde_json::json!({"value":"name"})).await,
        nf, "member 404s PUT /api/prefs/{{key}}");
    assert_eq!(
        get_cookie(&f.app, "/api/snippets", &alice).await, nf,
        "member 404s GET /api/snippets too (deny-by-default: prefs not allowlisted)");

    // audit read + push — owner/admin-only.
    assert_eq!(get_cookie(&f.app, "/api/audit", &alice).await, nf, "member 404s GET /api/audit");
    assert_eq!(get_cookie(&f.app, "/api/push/key", &alice).await, nf, "member 404s GET /api/push/key");
}

#[tokio::test]
async fn member_get_companies_returns_only_their_own() {
    let f = fixture().await;
    let (alice, _csrf) = login(&f.app, HOST_A, "alice-code").await;

    let (st, body) = get_cookie_body(&f.app, "/api/companies", &alice).await;
    assert_eq!(st, StatusCode::OK, "member may list companies");
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = v["data"].as_array().expect("data array");
    assert_eq!(arr.len(), 1, "member sees ONLY their own company");
    assert_eq!(arr[0]["id"].as_i64(), Some(1), "…and it is company 1 (theirs)");

    // The owner sees the whole roster (both companies).
    let (sto, bo) = get_bearer(&f.app, "/api/companies").await;
    assert_eq!(sto, StatusCode::OK);
    let vo: serde_json::Value = serde_json::from_slice(&bo).unwrap();
    assert_eq!(vo["data"].as_array().unwrap().len(), 2, "owner sees every company");
}

#[tokio::test]
async fn member_creates_agent_in_own_company_only() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;

    // Explicit own company → created.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/sessions", &alice, &csrf,
            serde_json::json!({"name":"bot-own","company_id":1,"runtime":"native"})).await,
        StatusCode::CREATED, "member creates an agent in their own company");

    // Company omitted → defaults to theirs (created under company 1).
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/sessions", &alice, &csrf,
            serde_json::json!({"name":"bot-default","runtime":"native"})).await,
        StatusCode::CREATED, "member's omitted company defaults to their own");
    // The default landed the session under company 1's root.
    assert!(f.root_a.join("bot-default").is_dir(), "default-company session is under company-A root");

    // Another company → uniform 404 (a member can't even learn it exists).
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/sessions", &alice, &csrf,
            serde_json::json!({"name":"bot-foreign","company_id":2,"runtime":"native"})).await,
        StatusCode::NOT_FOUND, "member 404s creating an agent in another company");
}

#[tokio::test]
async fn member_connector_grant_confined_to_own_company() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;

    // Own company scope → granted.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/connectors/mail/grant", &alice, &csrf,
            serde_json::json!({"session_name":"company:1"})).await,
        StatusCode::OK, "member grants @company:1 (their own)");

    // Global all-agents → 404.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/connectors/mail/grant", &alice, &csrf,
            serde_json::json!({"session_name":"all"})).await,
        StatusCode::NOT_FOUND, "member 404s an all-agents (global) grant");

    // Another company → 404.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/connectors/mail/grant", &alice, &csrf,
            serde_json::json!({"session_name":"company:2"})).await,
        StatusCode::NOT_FOUND, "member 404s a cross-company grant");

    // Creating/deleting a GLOBAL connector definition → 404.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/connectors", &alice, &csrf,
            serde_json::json!({"id":"newconn","kind":"mcp","display_name":"N","tools":[],"credentials":[]})).await,
        StatusCode::NOT_FOUND, "member 404s authoring a global connector definition");
    assert_eq!(
        send_cookie(&f.app, "DELETE", "/api/connectors/mail", &alice, &csrf,
            serde_json::json!({})).await,
        StatusCode::NOT_FOUND, "member 404s deleting a global connector definition");
}

#[tokio::test]
async fn admin_human_bypasses_every_gate() {
    let f = fixture().await;
    // carol is an ADMIN (company NULL) — she may log in on any allowlisted host.
    let (carol, csrf) = login(&f.app, HOST_A, "carol-code").await;

    // Sees the whole company roster.
    let (st, body) = get_cookie_body(&f.app, "/api/companies", &carol).await;
    assert_eq!(st, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["data"].as_array().unwrap().len(), 2, "admin sees every company");

    // Company management: rename a company (a mutate that require_admin gates but
    // has no filesystem side effect — proves the admin passes the gate).
    assert_eq!(
        send_cookie(&f.app, "PATCH", "/api/companies/1", &carol, &csrf,
            serde_json::json!({"display_name":"Acme Renamed"})).await,
        StatusCode::OK, "admin renames a company (company-management gate passed)");

    // Global-admin routers reachable (not 404).
    assert_ne!(get_cookie(&f.app, "/api/hosts", &carol).await, StatusCode::NOT_FOUND, "admin reaches hosts");
    assert_ne!(get_cookie(&f.app, "/api/schedules", &carol).await, StatusCode::NOT_FOUND, "admin reaches scheduler");
    assert_ne!(get_cookie(&f.app, "/api/audit", &carol).await, StatusCode::NOT_FOUND, "admin reaches audit");

    // Global (all-agents) connector grant allowed for an admin.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/connectors/mail/grant", &carol, &csrf,
            serde_json::json!({"session_name":"all"})).await,
        StatusCode::OK, "admin may grant globally");
}

/// `CLAUDE_CONFIG_DIR` is a process-global; only this test in the file touches
/// `claude_tools`, but serialize its env mutation for hygiene (a poisoned lock is
/// fine to recover from here).
static CLAUDE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// P3d regression: the Claude MCP registry router is owner/admin-only. A scoped
/// MEMBER must NOT be able to inject a GLOBAL MCP server (`scope=user`, arbitrary
/// command) into `~/.claude.json` — that server would launch inside EVERY
/// subsequently-spawned agent across ALL companies (cross-company RCE). Every
/// route of the router (registry read included) returns a uniform 404 for a
/// member; the owner reaches the handler and the write lands (owner-neutral).
#[tokio::test]
async fn member_cannot_touch_claude_mcp_registry() {
    let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // Point ~/.claude.json at a throwaway dir so a REGRESSION (member reaching the
    // handler) cannot pollute this box's real config, and so we can inspect it.
    let cdir = std::env::temp_dir().join(format!("supermux-p3d-mcp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&cdir).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &cdir);
    let claude_json = cdir.join(".claude.json");

    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;
    let nf = StatusCode::NOT_FOUND;

    // Member POST: inject a global user-scope MCP that shells out. Must 404.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/claude/mcp", &alice, &csrf,
            serde_json::json!({
                "name": "member-inject",
                "scope": "user",
                "config": { "type": "stdio", "command": "/bin/sh", "args": ["-c", "id > /tmp/pwn"] }
            })).await,
        nf, "member 404s POST /api/claude/mcp (global MCP-injection)");

    // …and NOTHING was written to the global ~/.claude.json (gate fires before the
    // handler's atomic write). No file, or a file with no such server, both prove it.
    if claude_json.exists() {
        let root: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&claude_json).unwrap()).unwrap();
        assert!(
            root.get("mcpServers").and_then(|m| m.get("member-inject")).is_none(),
            "member's rejected MCP-injection must NOT have been written to ~/.claude.json");
    }

    // Member DELETE (sabotage an existing server): uniform 404.
    assert_eq!(
        send_cookie(&f.app, "DELETE", "/api/claude/mcp/whatever?scope=user", &alice, &csrf,
            serde_json::json!({})).await,
        nf, "member 404s DELETE /api/claude/mcp/{{name}}");

    // Member enable/disable (project-trust sabotage): uniform 404.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/claude/mcp/whatever/disable", &alice, &csrf,
            serde_json::json!({})).await,
        nf, "member 404s POST /api/claude/mcp/{{name}}/disable");

    // The registry READ is gated too (we chose to hide the whole global registry
    // from a member — their connectors are company-scoped via the store).
    assert_eq!(get_cookie(&f.app, "/api/claude/registry", &alice).await, nf,
        "member 404s GET /api/claude/registry");

    // Owner reaches the handler: the same injection SUCCEEDS and the write lands —
    // proving the gate is owner-neutral (AuthContext::Owner ⇒ require_admin no-op).
    assert_ne!(
        send_bearer(&f.app, "POST", "/api/claude/mcp",
            serde_json::json!({
                "name": "owner-ok",
                "scope": "user",
                "config": { "type": "stdio", "command": "/bin/true" }
            })).await,
        nf, "owner reaches the MCP add handler (not gated)");
    let root: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&claude_json).unwrap()).unwrap();
    assert_eq!(
        root["mcpServers"]["owner-ok"]["command"], serde_json::json!("/bin/true"),
        "owner's MCP add wrote through to ~/.claude.json (owner-neutral)");

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    std::fs::remove_dir_all(&cdir).ok();
}

#[tokio::test]
async fn owner_bearer_bypasses_every_gate() {
    let f = fixture().await;
    // The owner bearer reaches the admin routers and manages companies. Rename
    // (no filesystem side effect) proves company-management passes the gate.
    assert_eq!(
        send_bearer(&f.app, "PATCH", "/api/companies/1",
            serde_json::json!({"display_name":"Acme Owner-Renamed"})).await,
        StatusCode::OK, "owner renames a company");
    assert_ne!(
        get_bearer(&f.app, "/api/hosts").await.0, StatusCode::NOT_FOUND,
        "owner reaches hosts");
    assert_eq!(
        send_bearer(&f.app, "POST", "/api/connectors/mail/grant",
            serde_json::json!({"session_name":"all"})).await,
        StatusCode::OK, "owner may grant globally");
}

/// P3d regression: the `/api/skills/{name}` upsert + delete write ATTACKER-
/// CONTROLLED markdown to GLOBAL paths — `~/.supermux/skills/<name>.md` AND
/// `~/.claude/commands/<name>.md`, the global Claude Code slash-command namespace
/// that EVERY agent across ALL companies expands into its prompt (and a command
/// `.md` can carry bash-exec). A scoped MEMBER must NOT reach either: both return
/// a uniform 404 and NOTHING is written. The owner reaches the handler and the
/// write lands (owner-neutral). `delegate`/`wait` on the SAME agents sub-router
/// stay company-scoped and are covered elsewhere — this gate is skills-only.
#[tokio::test]
async fn member_cannot_write_global_skills() {
    let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // Redirect BOTH global roots at a throwaway dir: HOME drives
    // `~/.supermux/skills/…` (dirs::home_dir) and CLAUDE_CONFIG_DIR drives the
    // commands dir. A regression (member reaching the handler) then pollutes only
    // this temp dir — and lets us assert nothing was written.
    let hdir = std::env::temp_dir().join(format!("supermux-p3d-skills-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&hdir).unwrap();
    let prev_home = std::env::var_os("HOME");
    let prev_ccd = std::env::var_os("CLAUDE_CONFIG_DIR");
    std::env::set_var("HOME", &hdir);
    std::env::set_var("CLAUDE_CONFIG_DIR", &hdir);
    let supermux_pwn = hdir.join(".supermux").join("skills").join("pwn.md");
    let claude_pwn = hdir.join("commands").join("pwn.md");

    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;
    let nf = StatusCode::NOT_FOUND;

    // Member POST: inject a slash-command that shells out. Must 404.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/skills/pwn", &alice, &csrf,
            serde_json::json!({
                "content": "---\ndescription: pwn\n---\n!`id > /tmp/pwn-skill`\n"
            })).await,
        nf, "member 404s POST /api/skills/{{name}} (global slash-command injection)");
    // …and NEITHER global copy was written (gate fires before the fs sync).
    assert!(!supermux_pwn.exists(),
        "member's rejected skill must NOT reach ~/.supermux/skills/pwn.md");
    assert!(!claude_pwn.exists(),
        "member's rejected skill must NOT reach ~/.claude/commands/pwn.md");

    // Member DELETE (sabotage / probe an existing command): uniform 404.
    assert_eq!(
        send_cookie(&f.app, "DELETE", "/api/skills/anything", &alice, &csrf,
            serde_json::json!({})).await,
        nf, "member 404s DELETE /api/skills/{{name}}");

    // Owner reaches the handler: the same write SUCCEEDS and lands on disk —
    // proving the gate is owner-neutral (AuthContext::Owner ⇒ require_admin no-op).
    let owner_skill = hdir.join(".supermux").join("skills").join("owner-ok.md");
    assert_ne!(
        send_bearer(&f.app, "POST", "/api/skills/owner-ok",
            serde_json::json!({ "content": "---\ndescription: fine\n---\nbody\n" })).await,
        nf, "owner reaches the skills upsert handler (not gated)");
    assert!(owner_skill.exists(),
        "owner's skill write landed at ~/.supermux/skills/owner-ok.md (owner-neutral)");

    match prev_home {
        Some(v) => std::env::set_var("HOME", v),
        None => std::env::remove_var("HOME"),
    }
    match prev_ccd {
        Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
        None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
    }
    std::fs::remove_dir_all(&hdir).ok();
}

/// P3d regression: `PUT /api/settings/experimental/agent-teams` is a GLOBAL prefs
/// write (it flips a box-wide toggle that changes how EVERY next session spawns).
/// A scoped MEMBER must 404 on the write; the owner succeeds. The GET stays
/// readable for everyone (a harmless global bool, no cross-company info).
#[tokio::test]
async fn member_cannot_write_agent_teams_pref() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;

    // Member PUT → uniform 404.
    assert_eq!(
        send_cookie(&f.app, "PUT", "/api/settings/experimental/agent-teams", &alice, &csrf,
            serde_json::json!({"enabled": true})).await,
        StatusCode::NOT_FOUND, "member 404s PUT /api/settings/experimental/agent-teams");

    // P3d deny-by-default: the member 404s the READ too (settings/experimental is
    // not on the member allowlist — the backstop hides the whole surface). The
    // in-handler `require_admin` on the PUT stays as defense-in-depth.
    assert_eq!(
        get_cookie(&f.app, "/api/settings/experimental/agent-teams", &alice).await,
        StatusCode::NOT_FOUND, "member 404s GET the agent-teams toggle (deny-by-default)");

    // Owner PUT succeeds (owner-neutral gate).
    assert_eq!(
        send_bearer(&f.app, "PUT", "/api/settings/experimental/agent-teams",
            serde_json::json!({"enabled": true})).await,
        StatusCode::OK, "owner flips the agent-teams toggle");
}

// ── P3d deny-by-default MEMBER BACKSTOP (the class fix) ──────────────────────────

/// A no-human world (human-auth DISABLED): every request is the owner bearer, so
/// `Scope::of` is always `All` and the deny-by-default backstop is a pure
/// pass-through. Proves the class fix is byte-identical when no scoped human can
/// exist.
async fn no_human_fixture() -> axum::Router {
    let dir = std::env::temp_dir().join(format!("supermux-p3d-nh-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
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
        // The whole point: NO human-auth configured.
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    http::router(state)
}

/// (a) A scoped MEMBER is a uniform 404 on the newly-closed global-write leaks —
/// `POST /api/teams/start`, `POST /api/teams/start-from-existing` (a FOREIGN and
/// their OWN session), `POST/DELETE /api/claude/statusline`, and `GET/POST
/// /api/board*` — AND no global write lands: the company-B session is NOT hijacked
/// into a team, and no `~/.claude/settings.json` `statusLine` slot is written.
#[tokio::test]
async fn member_denied_teams_statusline_board_and_no_global_write() {
    let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // Redirect the global Claude settings at a throwaway dir so a REGRESSION
    // (member reaching install/uninstall) could only pollute this temp dir — and
    // lets us assert nothing was written.
    let cdir = std::env::temp_dir().join(format!("supermux-p3d-sl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&cdir).unwrap();
    let prev_ccd = std::env::var_os("CLAUDE_CONFIG_DIR");
    std::env::set_var("CLAUDE_CONFIG_DIR", &cdir);

    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;
    let nf = StatusCode::NOT_FOUND;

    // Owner seeds a company-2 (foreign) and a company-1 (own) session to probe the
    // team-conversion hijack from a member.
    assert_eq!(send_bearer(&f.app, "POST", "/api/sessions",
        serde_json::json!({"name":"bob-sess","company_id":2,"runtime":"native"})).await,
        StatusCode::CREATED, "owner seeds a company-B session");
    assert_eq!(send_bearer(&f.app, "POST", "/api/sessions",
        serde_json::json!({"name":"alice-sess","company_id":1,"runtime":"native"})).await,
        StatusCode::CREATED, "owner seeds a company-A session");

    // ── teams: start + start-from-existing (foreign AND own) all 404 ──
    assert_eq!(send_cookie(&f.app, "POST", "/api/teams/start", &alice, &csrf,
        serde_json::json!({"task":"do things"})).await, nf,
        "member 404s POST /api/teams/start");
    assert_eq!(send_cookie(&f.app, "POST", "/api/teams/start-from-existing", &alice, &csrf,
        serde_json::json!({"name":"bob-sess","task":"hijack"})).await, nf,
        "member 404s start-from-existing on a FOREIGN session (cross-company hijack)");
    assert_eq!(send_cookie(&f.app, "POST", "/api/teams/start-from-existing", &alice, &csrf,
        serde_json::json!({"name":"alice-sess","task":"convert"})).await, nf,
        "member 404s start-from-existing even on their OWN session (teams denied in v1)");

    // …and the foreign session was NOT converted (no `team` tag was added).
    let (st, body) = get_bearer(&f.app, "/api/sessions/bob-sess").await;
    assert_eq!(st, StatusCode::OK, "owner still reads the company-B session");
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let tags = v["data"]["tags"].as_array().cloned().unwrap_or_default();
    assert!(!tags.iter().any(|t| t == "team"),
        "company-B session must NOT have been hijacked into a team lead");

    // ── statusline install/uninstall: 404 + no global settings.json write ──
    assert_eq!(send_cookie(&f.app, "POST", "/api/claude/statusline/install", &alice, &csrf,
        serde_json::json!({})).await, nf, "member 404s POST /api/claude/statusline/install");
    assert_eq!(send_cookie(&f.app, "DELETE", "/api/claude/statusline", &alice, &csrf,
        serde_json::json!({})).await, nf, "member 404s DELETE /api/claude/statusline");
    let settings = cdir.join("settings.json");
    if settings.exists() {
        let root: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        assert!(root.get("statusLine").is_none(),
            "member's rejected statusline install must NOT have written the global statusLine slot");
    }

    // ── board: reads + writes all 404 for a member (global kanban, denied in v1) ──
    assert_eq!(get_cookie(&f.app, "/api/board", &alice).await, nf, "member 404s GET /api/board");
    assert_eq!(get_cookie(&f.app, "/api/boards", &alice).await, nf, "member 404s GET /api/boards");
    assert_eq!(send_cookie(&f.app, "POST", "/api/board/1/start", &alice, &csrf,
        serde_json::json!({})).await, nf, "member 404s POST /api/board/{{id}}/start");

    match prev_ccd {
        Some(vv) => std::env::set_var("CLAUDE_CONFIG_DIR", vv),
        None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
    }
    std::fs::remove_dir_all(&cdir).ok();
}

/// (b) A scoped MEMBER CAN still reach the allowlist: `GET /api/companies` (own),
/// `GET /api/sessions` (company-filtered to ONLY their sessions), a company-scoped
/// op on their OWN session (and a uniform 404 on a foreign one), `POST
/// /api/agents/delegate` (reachable — proven via the pre-delivery empty-prompt
/// 400, not a 404), a `/api/file` read within their company root, and `GET
/// /api/events`.
#[tokio::test]
async fn member_can_reach_the_allowlist() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;
    let nf = StatusCode::NOT_FOUND;

    // Owner seeds two company-A sessions + one company-B session.
    for (n, c) in [("alice-a", 1), ("alice-a2", 1), ("bob-b", 2)] {
        assert_eq!(send_bearer(&f.app, "POST", "/api/sessions",
            serde_json::json!({"name": n, "company_id": c, "runtime": "native"})).await,
            StatusCode::CREATED, "owner seeds session {n}");
    }

    // GET /api/companies — own only.
    let (stc, bc) = get_cookie_body(&f.app, "/api/companies", &alice).await;
    assert_eq!(stc, StatusCode::OK, "member reaches GET /api/companies");
    let vc: serde_json::Value = serde_json::from_slice(&bc).unwrap();
    assert_eq!(vc["data"].as_array().unwrap().len(), 1, "…and sees only their own company");

    // GET /api/sessions — company-filtered: alice sees ONLY her two, never bob-b.
    let (sts, bs) = get_cookie_body(&f.app, "/api/sessions", &alice).await;
    assert_eq!(sts, StatusCode::OK, "member reaches the roster (allowlisted)");
    let vs: serde_json::Value = serde_json::from_slice(&bs).unwrap();
    let names: Vec<String> = vs["data"].as_array().unwrap().iter()
        .map(|s| s["name"].as_str().unwrap_or_default().to_string()).collect();
    assert!(names.contains(&"alice-a".to_string()) && names.contains(&"alice-a2".to_string()),
        "member's roster shows their own company sessions: got {names:?}");
    assert!(!names.iter().any(|n| n == "bob-b"),
        "member's roster is company-filtered — no company-B session leaks: got {names:?}");

    // A company-scoped op on her OWN session → OK; the FOREIGN one → uniform 404.
    assert_eq!(get_cookie(&f.app, "/api/sessions/alice-a", &alice).await, StatusCode::OK,
        "member reaches a scoped op on her own session");
    assert_eq!(get_cookie(&f.app, "/api/sessions/bob-b", &alice).await, nf,
        "member 404s a company-B session (sessions scope layer)");

    // delegate is REACHABLE for a member (the backstop admits it) — proven by the
    // handler's pre-delivery empty-prompt 400 (a denied route would be 404). No
    // keystroke is ever delivered. (Cross-company/spoofed refusal is in scope_p3b.)
    assert_eq!(send_cookie(&f.app, "POST", "/api/agents/delegate", &alice, &csrf,
        serde_json::json!({"from":"alice-a","to":"alice-a2","prompt":"   "})).await,
        StatusCode::BAD_REQUEST,
        "member reaches delegate (empty-prompt 400, not a backstop 404)");

    // a /api/file read within her company root.
    let file = f.root_a.join("hello.txt");
    std::fs::write(&file, b"hi-from-alice").unwrap();
    let (stf, bf) = get_cookie_body(&f.app,
        &format!("/api/file/raw?path={}", file.to_string_lossy()), &alice).await;
    assert_eq!(stf, StatusCode::OK, "member reads a file under her company root");
    assert_eq!(bf, b"hi-from-alice", "…and gets the real bytes");

    // GET /api/events (SSE) — reachable (not a backstop 404).
    assert_ne!(get_cookie(&f.app, "/api/events", &alice).await, nf,
        "member reaches the SSE stream (allowlisted)");
}

/// P3d allowlist-precision (HIGH): `GET /api/sessions/archived` must be
/// company-filtered for a MEMBER — exactly like the live roster (`list_handler`).
/// The archived sheet listed EVERY company's archived sessions with no company
/// fence (it takes no ctx), so a member could enumerate other companies' archived
/// sessions by name. A member now sees ONLY their own company's archived rows; a
/// company-B archived session is absent. Owner (`Scope::All`) still sees all.
#[tokio::test]
async fn member_archived_sessions_are_company_filtered() {
    let f = fixture().await;
    let (alice, _csrf) = login(&f.app, HOST_A, "alice-code").await;

    // Owner seeds one company-A and one company-B session, then archives BOTH
    // (archive flips `archived = 1` synchronously before returning the 202).
    for (n, c) in [("arch-a", 1), ("arch-b", 2)] {
        assert_eq!(send_bearer(&f.app, "POST", "/api/sessions",
            serde_json::json!({"name": n, "company_id": c, "runtime": "native"})).await,
            StatusCode::CREATED, "owner seeds session {n}");
        assert_eq!(send_bearer(&f.app, "POST", &format!("/api/sessions/{n}/archive"),
            serde_json::json!({})).await,
            StatusCode::ACCEPTED, "owner archives {n}");
    }

    // Member: sees ONLY their own company-A archived session; company-B is absent.
    let (st, body) = get_cookie_body(&f.app, "/api/sessions/archived", &alice).await;
    assert_eq!(st, StatusCode::OK, "member reaches the archived sheet (allowlisted)");
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let names: Vec<String> = v["data"].as_array().unwrap().iter()
        .map(|s| s["name"].as_str().unwrap_or_default().to_string()).collect();
    assert!(names.contains(&"arch-a".to_string()),
        "member sees their own company's archived session: got {names:?}");
    assert!(!names.iter().any(|n| n == "arch-b"),
        "member's archived list is company-filtered — no company-B leak: got {names:?}");

    // Owner sees BOTH archived sessions (Scope::All, unchanged).
    let (sto, bo) = get_bearer(&f.app, "/api/sessions/archived").await;
    assert_eq!(sto, StatusCode::OK);
    let vo: serde_json::Value = serde_json::from_slice(&bo).unwrap();
    let onames: Vec<String> = vo["data"].as_array().unwrap().iter()
        .map(|s| s["name"].as_str().unwrap_or_default().to_string()).collect();
    assert!(onames.contains(&"arch-a".to_string()) && onames.contains(&"arch-b".to_string()),
        "owner sees every company's archived sessions: got {onames:?}");
}

/// P3d allowlist-precision (MEDIUM): `POST /api/upload` (the chat composer's
/// base64 attachment upload) was NOT on the member allowlist, so every composer
/// attachment 404'd for a member. The upload writes to the server data-dir scratch
/// `uploads/` — NOT tied to any company session or company dir — so allowlisting
/// alone is safe (no session scoping needed). A member now reaches it (200), and
/// the owner is unaffected.
#[tokio::test]
async fn member_can_upload_composer_attachment() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;

    // A base64 note ("hi"). `.txt` is not an image ext, so it is accepted as-is.
    let st = send_cookie(&f.app, "POST", "/api/upload", &alice, &csrf,
        serde_json::json!({"name": "note.txt", "data": "aGk="})).await;
    assert_eq!(st, StatusCode::OK,
        "member reaches POST /api/upload (composer attachment) — not a backstop 404");

    // Owner unaffected (Scope::All bypasses the backstop).
    assert_eq!(
        send_bearer(&f.app, "POST", "/api/upload",
            serde_json::json!({"name": "owner.txt", "data": "aGk="})).await,
        StatusCode::OK, "owner uploads unaffected");
}

/// (c) The owner bearer and an ADMIN human BYPASS the backstop entirely: routes
/// denied to a member (board, prefs reads) are reachable for both.
#[tokio::test]
async fn owner_and_admin_bypass_the_member_backstop() {
    let f = fixture().await;
    let (carol, _csrf) = login(&f.app, HOST_A, "carol-code").await; // admin (company NULL)
    let nf = StatusCode::NOT_FOUND;

    // Board (denied to a member) — reachable for the owner AND the admin.
    assert_ne!(get_bearer(&f.app, "/api/board").await.0, nf, "owner reaches /api/board");
    assert_ne!(get_cookie(&f.app, "/api/board", &carol).await, nf, "admin reaches /api/board");
    // Prefs reads (denied to a member) — reachable for both.
    assert_ne!(get_bearer(&f.app, "/api/snippets").await.0, nf, "owner reaches /api/snippets");
    assert_ne!(get_cookie(&f.app, "/api/snippets", &carol).await, nf, "admin reaches /api/snippets");
}

/// (d) A no-human world is byte-identical: with human-auth disabled, the owner
/// bearer reaches the member-denied routes — the backstop never bites (every
/// identity is `Scope::All`).
#[tokio::test]
async fn no_human_world_backstop_is_a_passthrough() {
    let app = no_human_fixture().await;
    let nf = StatusCode::NOT_FOUND;
    // Routes that are DENIED to a scoped member are all reachable here.
    assert_ne!(get_bearer(&app, "/api/board").await.0, nf, "no-human owner reaches /api/board");
    assert_ne!(get_bearer(&app, "/api/snippets").await.0, nf, "no-human owner reaches /api/snippets");
    assert_ne!(get_bearer(&app, "/api/hosts").await.0, nf, "no-human owner reaches /api/hosts");
    // …and an allowlisted route is reachable too (sanity: nothing over-blocks).
    assert_ne!(get_bearer(&app, "/api/sessions").await.0, nf, "no-human owner reaches /api/sessions");
}
