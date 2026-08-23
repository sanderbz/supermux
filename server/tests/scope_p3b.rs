//! P3b integration matrix — per-company scoping of the REST/files/delegate/iCal
//! surfaces (and the pty WS), exercised through the REAL router with human-auth
//! enabled and the Google OIDC exchange behind a mock.
//!
//! Three callers — the owner (bearer), human-A (company 1 cookie), human-B
//! (company 2 cookie) — against two sessions (`sess-a` in company 1, `sess-b` in
//! company 2). The security property under test (design §3):
//!
//!   * A reaches A's session / files; A gets a **uniform 404** on B's, byte-
//!     identical to a nonexistent slug (no existence leak).
//!   * The owner reaches everything.
//!   * `delegate` with a spoofed main/NULL `from` by a scoped human is refused.
//!   * A scoped human 404s `/api/calendar.ics`; the owner (no cookie) still gets it.
//!   * The pty WS: A's cookie authenticates the socket, and A's cross-company /
//!     nonexistent / own-dead targets ALL close with the same terminal 4404.
//!
//! The SSE per-subscriber filter (drop cross-company + unstamped→owner-only) is
//! proven at the unit level in `src/sse.rs` (`scoped_stream_*` / `owner_stream_*`)
//! and `src/scope.rs` (`Scope::sees`); it is not re-driven over a live stream here.

use std::sync::Arc;

use supermux_server::auth_human::oidc::MockOidcVerifier;
use supermux_server::config::{CompanyHost, Config, HumanAuthConfig, ProviderDefaults, TlsConfig};
use supermux_server::db::sessions::NewSession;
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as Msg;
use tower::ServiceExt;

const TOKEN: &str = "owner-secret-token";
const HOST_A: &str = "acme.test";
const HOST_B: &str = "beta.test";

struct Fixture {
    app: axum::Router,
    state: AppState,
    root_a: std::path::PathBuf,
    root_b: std::path::PathBuf,
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

async fn make_session(state: &AppState, name: &str, company: Option<i64>, dir: &std::path::Path) {
    db::sessions::create(
        &state.pool,
        &NewSession {
            name: name.to_string(),
            display_name: name.to_string(),
            dir: dir.to_string_lossy().to_string(),
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
            company_id: company,
        },
    )
    .await
    .expect("create session");
}

async fn make_remote_session(
    state: &AppState,
    name: &str,
    company: Option<i64>,
    dir: &std::path::Path,
    host_id: i64,
) {
    db::sessions::create(
        &state.pool,
        &NewSession {
            name: name.to_string(),
            display_name: name.to_string(),
            dir: dir.to_string_lossy().to_string(),
            desc: String::new(),
            provider: "claude".to_string(),
            creator: "test".to_string(),
            flags: String::new(),
            tags: "[]".to_string(),
            branch: String::new(),
            mcp: String::new(),
            worktree: false,
            worktree_repo: String::new(),
            host_id: Some(host_id),
            runtime: "native".to_string(),
            model: String::new(),
            company_id: company,
        },
    )
    .await
    .expect("create remote session");
}

async fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("supermux-p3b-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root_a = dir.join("company-a");
    let root_b = dir.join("company-b");
    std::fs::create_dir_all(&root_a).unwrap();
    std::fs::create_dir_all(&root_b).unwrap();
    std::fs::write(root_a.join("ok.txt"), b"alpha-company-a").unwrap();
    std::fs::write(root_b.join("secret.txt"), b"bravo-company-b").unwrap();

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

    // Companies A (id 1) then B (id 2), each rooted at its temp dir.
    let a = db::companies::create(&pool, "acme", "Acme", &root_a.to_string_lossy())
        .await
        .expect("company A");
    let b = db::companies::create(&pool, "beta", "Beta", &root_b.to_string_lossy())
        .await
        .expect("company B");
    assert_eq!((a.id, b.id), (1, 2), "company ids are 1,2 as the hosts expect");

    // Allowlisted colleagues: alice in company 1, bob in company 2.
    db::human_users::insert(&pool, "alice@acme.test", "Alice", Some(1), "member")
        .await
        .expect("seed alice");
    db::human_users::insert(&pool, "bob@beta.test", "Bob", Some(2), "member")
        .await
        .expect("seed bob");

    let state = AppState::new(pool, config);
    let mock = Arc::new(MockOidcVerifier::new());
    mock.insert("alice-code", "alice@acme.test", None, None);
    mock.insert("bob-code", "bob@beta.test", None, None);
    state.human_auth.set_verifier(mock);

    // Sessions: sess-a in company 1 (dir = A root), sess-b in company 2 (dir = B
    // root), main-null with no company (a main bot) for the delegate from-spoof.
    make_session(&state, "sess-a", Some(1), &root_a).await;
    make_session(&state, "sess-b", Some(2), &root_b).await;
    make_session(&state, "main-null", None, &dir).await;

    // A host row so remote sessions satisfy the sessions.host_id FK. It is never
    // dialed: the scoped-human gate refuses remote transports BEFORE resolving
    // the SSH transport, so this row only has to exist, not be reachable.
    let host = db::hosts::create(&state.pool, "remote-box", "user@remote.invalid", None)
        .await
        .expect("create host");

    // REMOTE-host sessions (host_id set) for the files-jail-bypass matrix: one in
    // company 1 (alice's own) and one in company 2 (foreign). The scoped-human
    // gate refuses BOTH before any transport is resolved.
    make_remote_session(&state, "sess-a-remote", Some(1), &root_a, host.id).await;
    make_remote_session(&state, "sess-b-remote", Some(2), &root_b, host.id).await;

    let app = http::router(state.clone());
    Fixture { app, state, root_a, root_b }
}

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

/// One named cookie value from ALL Set-Cookie headers.
fn set_cookie(resp: &axum::response::Response, name: &str) -> Option<String> {
    for hv in resp.headers().get_all(header::SET_COOKIE) {
        let s = hv.to_str().ok()?;
        if let Some(rest) = s.strip_prefix(&format!("{name}=")) {
            return Some(rest.split(';').next().unwrap_or("").to_string());
        }
    }
    None
}

/// Drive /auth/login → /auth/callback on `host`; return (session_cookie, csrf_cookie).
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

// ── request helpers ────────────────────────────────────────────────────────────

async fn status_body(resp: axum::response::Response) -> (StatusCode, Vec<u8>) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

async fn get_cookie(app: &axum::Router, uri: &str, cookie: &str) -> (StatusCode, Vec<u8>) {
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
    status_body(resp).await
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
    status_body(resp).await
}

async fn post_cookie(
    app: &axum::Router,
    uri: &str,
    cookie: &str,
    csrf: &str,
    body: serde_json::Value,
) -> (StatusCode, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .header("x-supermux-csrf", csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    status_body(resp).await
}

async fn delete_cookie(
    app: &axum::Router,
    uri: &str,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(uri)
                .header(header::COOKIE, format!("supermux_hsess={cookie}"))
                .header("x-supermux-csrf", csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    status_body(resp).await
}

async fn post_bearer(
    app: &axum::Router,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    status_body(resp).await
}

async fn delete_bearer(app: &axum::Router, uri: &str) -> (StatusCode, Vec<u8>) {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    status_body(resp).await
}

// ── the matrix ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn owner_reaches_every_company_session() {
    let f = fixture().await;
    let (sa, _) = get_bearer(&f.app, "/api/sessions/sess-a").await;
    let (sb, _) = get_bearer(&f.app, "/api/sessions/sess-b").await;
    assert_eq!(sa, StatusCode::OK, "owner reaches company-1 session");
    assert_eq!(sb, StatusCode::OK, "owner reaches company-2 session");
}

#[tokio::test]
async fn scoped_human_reaches_own_company_session_only() {
    let f = fixture().await;
    let (alice, _csrf) = login(&f.app, HOST_A, "alice-code").await;

    // Own company → 200.
    let (own, _) = get_cookie(&f.app, "/api/sessions/sess-a", &alice).await;
    assert_eq!(own, StatusCode::OK, "alice reaches her own company session");

    // Other company → 404, using the IDENTICAL error template a nonexistent slug
    // gets: the only thing that varies is the slug the caller themselves typed,
    // so a cross-company `sess-b` is indistinguishable from a `sess-b` that never
    // existed (no existence leak). We prove both slugs render the same template.
    let (other, other_body) = get_cookie(&f.app, "/api/sessions/sess-b", &alice).await;
    let (nope, nope_body) = get_cookie(&f.app, "/api/sessions/does-not-exist", &alice).await;
    assert_eq!(other, StatusCode::NOT_FOUND, "alice 404s company-2 session");
    assert_eq!(nope, StatusCode::NOT_FOUND, "alice 404s a nonexistent slug");
    let templ = |slug: &str| format!(r#"{{"error":"not found: session '{slug}'","ok":false}}"#);
    assert_eq!(
        String::from_utf8(other_body).unwrap(),
        templ("sess-b"),
        "cross-company 404 == the 404 a NONEXISTENT 'sess-b' would give (same template)"
    );
    assert_eq!(
        String::from_utf8(nope_body).unwrap(),
        templ("does-not-exist"),
        "nonexistent 404 uses the same template — only the echoed slug differs"
    );
}

#[tokio::test]
async fn scoped_human_blocked_on_other_company_subroutes() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;

    // A read subroute (peek) and a write subroute (send) both 404 cross-company.
    let (peek, _) = get_cookie(&f.app, "/api/sessions/sess-b/peek", &alice).await;
    assert_eq!(peek, StatusCode::NOT_FOUND, "alice 404s company-2 peek");

    let (send, _) =
        post_cookie(&f.app, "/api/sessions/sess-b/send", &alice, &csrf, serde_json::json!({"text":"hi"})).await;
    assert_eq!(send, StatusCode::NOT_FOUND, "alice 404s a send into company-2");

    // And the connectors + agents-wait outliers (guarded explicitly, off the
    // sessions scope layer) also 404 cross-company.
    let (conn, _) = get_cookie(&f.app, "/api/sessions/sess-b/connectors", &alice).await;
    assert_eq!(conn, StatusCode::NOT_FOUND, "alice 404s company-2 connectors");
    let (wait, _) = get_cookie(&f.app, "/api/agents/sess-b/wait?state=idle&timeout=1", &alice).await;
    assert_eq!(wait, StatusCode::NOT_FOUND, "alice 404s company-2 agent wait");
}

#[tokio::test]
async fn files_jail_confines_scoped_human_to_company_root() {
    let f = fixture().await;
    let (alice, _csrf) = login(&f.app, HOST_A, "alice-code").await;

    // Own root → bytes.
    let own = f.root_a.join("ok.txt");
    let (st, body) =
        get_cookie(&f.app, &format!("/api/file/raw?path={}", own.to_string_lossy()), &alice).await;
    assert_eq!(st, StatusCode::OK, "alice reads a file under her company root");
    assert_eq!(body, b"alpha-company-a", "alice gets the real bytes");

    // Other company's root → 404, NEVER bytes.
    let secret = f.root_b.join("secret.txt");
    let (st2, body2) =
        get_cookie(&f.app, &format!("/api/file/raw?path={}", secret.to_string_lossy()), &alice).await;
    assert_eq!(st2, StatusCode::NOT_FOUND, "alice 404s a file outside her company root");
    assert_ne!(body2, b"bravo-company-b", "alice never receives company-2 bytes");

    // The owner can read company B's file (jail None).
    let (sto, bodyo) = get_bearer(&f.app, &format!("/api/file/raw?path={}", secret.to_string_lossy())).await;
    assert_eq!(sto, StatusCode::OK, "owner reads any path");
    assert_eq!(bodyo, b"bravo-company-b");
}

/// HIGH — the remote-transport files-jail bypass. The company jail is a LOCAL
/// concept; on the REMOTE branch `safe_path` discarded it (blocklist only), and
/// `transport_for_session` derived the host from ANY caller-named `session`. A
/// scoped human could therefore point a file query at a foreign-company session
/// (or any remote-host session) and read outside their company root. Fix: the
/// named `session` must pass the company gate, AND a scoped human is refused any
/// remote transport — both collapse to a uniform 404, never bytes.
#[tokio::test]
async fn scoped_human_files_remote_and_foreign_session_are_404() {
    let f = fixture().await;
    let (alice, _csrf) = login(&f.app, HOST_A, "alice-code").await;

    // A path that IS under alice's own company root — so any leak would be a
    // real bypass, not just an out-of-jail path failure.
    let own = f.root_a.join("ok.txt");
    let own_path = own.to_string_lossy().into_owned();

    // (i) alice's OWN company but a REMOTE-host session → refused. Remote-host
    // file browsing stays owner/admin (the local jail can't confine a remote FS).
    let (st1, b1) = get_cookie(
        &f.app,
        &format!("/api/file/raw?session=sess-a-remote&path={own_path}"),
        &alice,
    )
    .await;
    assert_eq!(st1, StatusCode::NOT_FOUND, "own-company REMOTE session → 404");
    assert_ne!(b1, b"alpha-company-a", "a remote session never yields bytes");

    // (ii) a FOREIGN-company REMOTE session → 404 (never targets company-2's host).
    let (st2, _) = get_cookie(
        &f.app,
        &format!("/api/file/raw?session=sess-b-remote&path={own_path}"),
        &alice,
    )
    .await;
    assert_eq!(st2, StatusCode::NOT_FOUND, "foreign-company REMOTE session → 404");

    // (iii) a FOREIGN-company LOCAL session NAMED in a file query → 404, even
    // though the requested PATH is under alice's own root. The session-ownership
    // gate fires regardless of the path.
    let (st3, b3) = get_cookie(
        &f.app,
        &format!("/api/file/raw?session=sess-b&path={own_path}"),
        &alice,
    )
    .await;
    assert_eq!(st3, StatusCode::NOT_FOUND, "foreign-company LOCAL session in a file query → 404");
    assert_ne!(b3, b"alpha-company-a", "naming a foreign session never yields bytes");

    // Sanity: with NO session named, alice still reads her own company root (the
    // P3b local jail path is unchanged) — proves the gate didn't break the norm.
    let (stok, bok) = get_cookie(&f.app, &format!("/api/file/raw?path={own_path}"), &alice).await;
    assert_eq!(stok, StatusCode::OK, "alice still reads her own company-root file");
    assert_eq!(bok, b"alpha-company-a");

    // Owner still reads any LOCAL path (jail None), unchanged.
    let secret = f.root_b.join("secret.txt");
    let (sto, bo) =
        get_bearer(&f.app, &format!("/api/file/raw?path={}", secret.to_string_lossy())).await;
    assert_eq!(sto, StatusCode::OK, "owner reads any local path");
    assert_eq!(bo, b"bravo-company-b");
}

/// MEDIUM — the unguarded team-management handlers. `dismiss` and
/// `remove_member` (destructive: KillThenDismiss kills the lead's tmux pane)
/// accepted human cookies with NO scope gate. Fix: gate both by the resolved
/// lead session's company; a scoped human whose target team is unresolvable /
/// foreign gets a uniform 404 and NOTHING is killed or dismissed; owner bypasses.
///
/// The test env has no on-disk teams, so for a scoped human EVERY team name is
/// unresolvable → the fail-closed 404 (a member can neither enumerate nor mutate
/// any team). The owner bypasses the gate and reaches the handler.
#[tokio::test]
async fn scoped_human_cannot_dismiss_or_remove_team_owner_bypasses() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;

    // dismiss: scoped human → uniform 404 (fail-closed, no resolvable lead).
    let (ad, _) = post_cookie(
        &f.app,
        "/api/teams/acme-team/dismiss",
        &alice,
        &csrf,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(ad, StatusCode::NOT_FOUND, "scoped human 404s a team dismiss");

    // dismiss: owner bypasses the gate → archive no-ops a missing team → ok.
    let (od, ob) = post_bearer(&f.app, "/api/teams/acme-team/dismiss", serde_json::json!({})).await;
    assert_eq!(od, StatusCode::OK, "owner dismiss succeeds (scope gate bypassed)");
    assert_eq!(String::from_utf8(ob).unwrap(), r#"{"ok":true}"#);

    // remove_member: scoped human → 404 at the gate, BEFORE the kill/dismiss path.
    let (ar, _) = delete_cookie(
        &f.app,
        "/api/teams/acme-team/members/x@acme-team",
        &alice,
        &csrf,
    )
    .await;
    assert_eq!(ar, StatusCode::NOT_FOUND, "scoped human 404s a member removal");
    // …and it recorded NO dismissal — nothing was killed or dismissed.
    let dismissed = db::teams_dismissed::list_for_team(&f.state.pool, "acme-team")
        .await
        .unwrap();
    assert!(dismissed.is_empty(), "a scoped human's blocked removal dismisses nothing");

    // remove_member: owner bypasses the gate and REACHES the handler — which
    // returns its own UnknownTeam 404 for a genuinely-absent team. Proves the
    // gate scoped by identity, not by breaking the route for everyone.
    let (or_, _) = delete_bearer(&f.app, "/api/teams/acme-team/members/x@acme-team").await;
    assert_eq!(or_, StatusCode::NOT_FOUND, "owner reaches the handler (UnknownTeam), not the scope gate");
}

#[tokio::test]
async fn delegate_from_spoof_is_refused_for_scoped_human() {
    let f = fixture().await;
    let (alice, csrf) = login(&f.app, HOST_A, "alice-code").await;

    // Spoof a main/NULL `from` to try to reach company 2 through the omniscient
    // branch of the delegation gate → refused (404), server derives A's company.
    let (spoof, _) = post_cookie(
        &f.app,
        "/api/agents/delegate",
        &alice,
        &csrf,
        serde_json::json!({"from":"main-null","to":"sess-b","prompt":"x","actor":"human"}),
    )
    .await;
    assert_eq!(spoof, StatusCode::NOT_FOUND, "spoofed NULL `from` is refused");

    // A legit `from` (her own session) to a cross-company `to` also 404s.
    let (cross, _) = post_cookie(
        &f.app,
        "/api/agents/delegate",
        &alice,
        &csrf,
        serde_json::json!({"from":"sess-a","to":"sess-b","prompt":"x","actor":"human"}),
    )
    .await;
    assert_eq!(cross, StatusCode::NOT_FOUND, "cross-company delegate is refused");
}

#[tokio::test]
async fn ical_is_owner_only() {
    let f = fixture().await;
    let (alice, _csrf) = login(&f.app, HOST_A, "alice-code").await;

    // A scoped human's cookie → 404.
    let (st, _) = get_cookie(&f.app, "/api/calendar.ics", &alice).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "a scoped human 404s the iCal feed");

    // No cookie / no bearer (the owner's calendar client on a trusted transport)
    // → served, unchanged.
    let resp = f
        .app
        .clone()
        .oneshot(Request::builder().uri("/api/calendar.ics").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "the public (no-cookie) feed still serves");
}

// ── pty WS gate ────────────────────────────────────────────────────────────────

/// Bind the real router on a loopback port so a WebSocket client can upgrade.
async fn spawn(state: AppState) -> std::net::SocketAddr {
    let app = http::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

/// Open the pty WS for `session` with alice's cookie, send a dummy first frame
/// (consumed, never injected), and return `(reached_auth_ok, close_code)`.
async fn ws_probe(addr: std::net::SocketAddr, session: &str, cookie: &str) -> (bool, Option<u16>) {
    let url = format!("ws://{addr}/ws/sessions/{session}");
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert(header::COOKIE, format!("supermux_hsess={cookie}").parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.expect("ws upgrade");
    // A human authenticates by cookie; the first frame is consumed regardless.
    ws.send(Msg::Text(r#"{"type":"auth","token":""}"#.to_string())).await.unwrap();

    let mut auth_ok = false;
    let mut code = None;
    for _ in 0..8 {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Msg::Text(t)))) => {
                if t.contains("auth_ok") {
                    auth_ok = true;
                }
            }
            Ok(Some(Ok(Msg::Close(Some(cf)))))=> {
                code = Some(u16::from(cf.code));
                break;
            }
            Ok(Some(Ok(_))) => {}
            _ => break,
        }
    }
    (auth_ok, code)
}

#[tokio::test]
async fn ws_cookie_auths_and_cross_company_is_uniform_4404() {
    let f = fixture().await;
    let (alice, _csrf) = login(&f.app, HOST_A, "alice-code").await;
    let addr = spawn(f.state.clone()).await;

    // Own (dead) session, other-company session, and a nonexistent slug: A's
    // cookie authenticates ALL three (auth_ok), and all three close with the
    // identical terminal 4404 — so a member cannot tell "wrong company" from
    // "no such session" from "stopped".
    let own = ws_probe(addr, "sess-a", &alice).await;
    let other = ws_probe(addr, "sess-b", &alice).await;
    let nope = ws_probe(addr, "no-such-session", &alice).await;

    assert!(own.0, "alice's cookie authenticates the WS (auth_ok) for her own session");
    assert!(other.0, "…and for a cross-company session (auth precedes the gate)");
    assert!(nope.0, "…and for a nonexistent slug");
    assert_eq!(own.1, Some(4404), "own dead session closes 4404");
    assert_eq!(other.1, Some(4404), "cross-company closes the identical 4404");
    assert_eq!(nope.1, Some(4404), "nonexistent closes the identical 4404");
}
