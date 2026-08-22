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
            },
            CompanyHost {
                host: HOST_B.to_string(),
                company_id: 2,
                redirect_uri: format!("https://{HOST_B}/auth/callback"),
            },
        ],
        owner_hosts: Vec::new(),
        cookie_key: b"cookie-key-cookie-key-cookie-key0".to_vec(),
        csrf_key: b"csrf-key0-csrf-key0-csrf-key0-csr".to_vec(),
        session_ttl_secs: 3600,
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

    // prefs WRITES gated (reads open) — POST/PUT 404, but GET is allowed.
    assert_eq!(
        send_cookie(&f.app, "POST", "/api/snippets", &alice, &csrf,
            serde_json::json!({"title":"t","body":"b"})).await,
        nf, "member 404s POST /api/snippets (a prefs write)");
    assert_eq!(
        send_cookie(&f.app, "PUT", "/api/prefs/overview_sort", &alice, &csrf,
            serde_json::json!({"value":"name"})).await,
        nf, "member 404s PUT /api/prefs/{{key}}");
    assert_ne!(
        get_cookie(&f.app, "/api/snippets", &alice).await, nf,
        "member may READ prefs (GET /api/snippets is not gated)");

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

    // Member GET is fine (read-only, harmless).
    assert_ne!(
        get_cookie(&f.app, "/api/settings/experimental/agent-teams", &alice).await,
        StatusCode::NOT_FOUND, "member may READ the agent-teams toggle");

    // Owner PUT succeeds (owner-neutral gate).
    assert_eq!(
        send_bearer(&f.app, "PUT", "/api/settings/experimental/agent-teams",
            serde_json::json!({"enabled": true})).await,
        StatusCode::OK, "owner flips the agent-teams toggle");
}
