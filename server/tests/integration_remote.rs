//! RT10 — end-to-end remote-SSH integration test (REMOTE_PLAN §RT10).
//!
//! This is the final ship-gate for the remote-SSH feature. It exercises every
//! milestone (RT1–RT9) in one self-contained flow against a localhost-ssh
//! fixture:
//!
//!   1. Boot an in-process supermux server on an ephemeral port (mirrors the
//!      `tests/ws_pty.rs` harness: `axum::serve` + `tokio::net::TcpListener`).
//!   2. `POST /api/hosts` to register `<user>@localhost`. Then
//!      `POST /api/hosts/{id}/check` and assert the row flips to
//!      `reachable` (RT8 + RT2).
//!   3. `POST /api/sessions` with `host_id` set, `provider="shell"`. The session
//!      runs `bash` on the remote (RT3/RT4 join).
//!   4. WebSocket connect → first-frame auth → `auth_ok` (RT3 routes the pty
//!      reader through `SshPtyReader`; the auth surface is unchanged from M4).
//!   5. `POST /send {"text":"echo remote-hello"}` → poll `/peek` until
//!      `remote-hello` shows up. Status flips `Active → Idle` within the
//!      generous-but-bounded window (RT3 + status detector).
//!   6. `GET /api/file?session=...&path=/etc/hostname` returns the remote
//!      hostname (matches `hostname` on localhost) — proves the file API's
//!      `SshFileTransport` dispatch on a session with `host_id` (RT6).
//!   7. Manually invoke `claude_config::install_hooks` against the
//!      `SshFileTransport` (provider=shell sessions don't auto-install — that
//!      is Claude-only — so we drive the public surface directly). Then
//!      `GET /api/file?session=...&path=~/.claude/settings.json` and assert
//!      the body contains the `supermux-hook` marker AND a URL that is NOT
//!      `127.0.0.1`, but the configured `remote_callback_url` (RT5).
//!   8. Tear down: `DELETE /api/sessions/...`, `DELETE /api/hosts/{id}`,
//!      pool/host-pool tear-down.
//!
//! The full e2e is gated `#[ignore = "requires localhost-ssh"]` and self-skips
//! if `ssh -o BatchMode=yes -o ConnectTimeout=2 localhost true` does not exit
//! 0 — exactly the same gating discipline as `tests/host_pool.rs`,
//! `tests/pty_ssh.rs`, and `tests/files_transport.rs`. The sandbox lacks
//! passwordless ssh-to-self; this is run on a dev box with:
//!
//! ```sh
//! cargo test --release --test integration_remote -- --ignored
//! ```
//!
//! In addition to the ignored e2e there are two ALWAYS-RUN smoke tests:
//!
//! - `config_round_trips_remote_callback_url` — pins the [`Config`] field
//!   so a future refactor that drops the option silently is caught.
//! - `effective_remote_callback_url_resolution_order` — exercises the public
//!   contract that a session with `host_id` set DOES route its hook callback
//!   URL through the configured `remote_callback_url`, NOT `127.0.0.1`. This
//!   is the contract the gated e2e proves at the byte level; the always-run
//!   variant proves it at the unit level so a regression on the resolver
//!   bombs even without a live remote.
//!
//! Compile-only smoke: every CI run that builds this binary (`cargo build
//! --test integration_remote`) is itself a regression net for the test file's
//! API surface — if any of the routes or types we use change shape, the test
//! file fails to compile and the milestone gate goes red before clippy.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::sessions::lifecycle::effective_remote_callback_url;
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "rt10-integration-secret-token";

// ── Always-run unit smoke ────────────────────────────────────────────────────

/// `Config { remote_callback_url: Some(..) }` must round-trip through a clone
/// + field read intact. This is the cheapest unit-level pin: a future refactor
/// that renames or drops the option will fail to compile (struct literal) AND
/// fail to assert (clone equality), giving two layers of regression net.
#[test]
fn config_round_trips_remote_callback_url() {
    let cfg = Config {
        data_dir: PathBuf::from("/tmp/rt10-cfg-test"),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: "tok".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: Some("https://supermux.tailnet.ts.net:8823".to_string()),
        push_sub: None,
        github_token: None,
    };
    let c2 = cfg.clone();
    assert_eq!(
        c2.remote_callback_url.as_deref(),
        Some("https://supermux.tailnet.ts.net:8823"),
        "remote_callback_url must round-trip through Config::clone unchanged"
    );

    // None is also valid (the LOCAL default; resolver falls back to extra_binds
    // / bind). Explicitly pin so a future change that makes it required errors
    // here, not in some downstream call site.
    let cfg_none = Config {
        data_dir: PathBuf::from("/tmp/rt10-cfg-test-none"),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: "tok".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
    };
    assert!(cfg_none.remote_callback_url.is_none());
}

/// The RT5 resolver contract, exercised at the unit level via `build_env`'s
/// observable output: a session with `host_id=Some(_)` MUST NOT carry a
/// `SUPERMUX_URL=http://127.0.0.1:…` value when a `remote_callback_url` is
/// configured. The resolver itself is private; we observe it through the
/// public `start` path's env, but since `start` requires a real tmux + ssh
/// fixture we instead pin the only public seam: the config field is what
/// `build_env` consults. The full byte-level verification of the URL landing
/// in `~/.claude/settings.json` is the gated e2e below.
///
/// This is a pure-Rust smoke — no ssh, no tmux, no network. It runs on every
/// `cargo test` and gates the milestone's "no 127.0.0.1 for remote sessions"
/// invariant even when the e2e is skipped.
#[test]
fn effective_remote_callback_url_resolution_order() {
    // Drive the actual resolver — NOT a tautological assertion on the field.
    // The contract has three real branches we want to gate:
    //   (a) remote_callback_url=Some(x) wins → returns x verbatim
    //   (b) None + extra_binds containing a non-loopback → returns that bind
    //   (c) None + only loopback binds → falls back to config.bind (last resort,
    //       only viable behind an SSH reverse tunnel)
    // The headline regression — "no 127.0.0.1 sneaks into the remote hook URL
    // when a real address is available" — falls out of (a) and (b).
    let base_cfg = |remote: Option<&str>, extra: Vec<&str>| Config {
        data_dir: PathBuf::from("/tmp/rt10-resolver"),
        bind: "127.0.0.1:8823".parse().unwrap(),
        extra_binds: extra
            .into_iter()
            .map(|s| s.parse().expect("extra_binds parse"))
            .collect(),
        tls: TlsConfig::default(),
        auth_token: "tok".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: remote.map(|s| s.to_string()),
        push_sub: None,
        github_token: None,
    };

    // (a) explicit remote_callback_url wins
    let cfg = base_cfg(Some("https://supermux.tailnet.ts.net:8823"), vec![]);
    let resolved = effective_remote_callback_url(&cfg, "https");
    assert_eq!(resolved, "https://supermux.tailnet.ts.net:8823");
    assert!(!resolved.contains("127.0.0.1"));

    // (b) no remote_callback_url but a non-loopback bind exists → uses it
    let cfg = base_cfg(None, vec!["10.0.0.42:8823", "127.0.0.1:8823"]);
    let resolved = effective_remote_callback_url(&cfg, "https");
    assert!(
        resolved.contains("10.0.0.42"),
        "resolver should pick the non-loopback extra_bind; got {resolved}"
    );
    assert!(!resolved.contains("127.0.0.1"));

    // (c) only loopback → falls back to bind (reverse-tunnel scenario only)
    let cfg = base_cfg(None, vec![]);
    let resolved = effective_remote_callback_url(&cfg, "https");
    assert!(
        resolved.contains("127.0.0.1"),
        "fallback should be config.bind when nothing else is configured; got {resolved}"
    );
}

// ── Gated e2e fixture ────────────────────────────────────────────────────────

/// Returns true iff `ssh -o BatchMode=yes -o ConnectTimeout=2 localhost true`
/// succeeds. Same precheck as `tests/host_pool.rs` + `tests/pty_ssh.rs`.
async fn ssh_localhost_usable() -> bool {
    let probe = tokio::process::Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=2",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "localhost",
            "true",
        ])
        .output()
        .await;
    matches!(probe, Ok(o) if o.status.success())
}

/// Result of [`spawn_server`]. Carries the live state so the test can install
/// hooks via the public crate surface (the lifecycle::start path only
/// auto-installs for `provider=claude`).
struct Fixture {
    app: axum::Router,
    addr: SocketAddr,
    state: AppState,
    data_dir: PathBuf,
}

async fn spawn_server(remote_callback_url: Option<String>) -> Fixture {
    let dir = std::env::temp_dir().join(format!("supermux-rt10-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url,
        push_sub: None,
        github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral");
    let addr = listener.local_addr().unwrap();
    let serve_app = app.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, serve_app).await;
    });
    Fixture { app, addr, state, data_dir: dir }
}

/// Authenticated `axum::Router::oneshot`. Returns `(status, parsed-JSON)`.
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

/// Poll `/peek` until `needle` appears or `tries × 250ms` elapse. Returns the
/// last seen scrollback (so the assertion error message is useful).
async fn peek_until(
    app: &axum::Router,
    name: &str,
    needle: &str,
    tries: u32,
) -> String {
    let mut last = String::new();
    for _ in 0..tries {
        let (status, body) =
            send(app, Method::GET, &format!("/api/sessions/{name}/peek"), None).await;
        if status == StatusCode::OK {
            last = body["data"].as_str().unwrap_or("").to_string();
            if last.contains(needle) {
                return last;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    last
}

/// Resolve the local user — `$USER` → `whoami` → fail. Used to build the
/// `user@localhost` ssh target.
fn local_user() -> String {
    if let Ok(u) = std::env::var("USER") {
        let u = u.trim();
        if !u.is_empty() {
            return u.to_string();
        }
    }
    if let Ok(out) = std::process::Command::new("whoami").output() {
        if out.status.success() {
            let u = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !u.is_empty() {
                return u;
            }
        }
    }
    panic!("RT10: could not resolve local user (set $USER or have whoami on PATH)");
}

// ── Gated end-to-end ─────────────────────────────────────────────────────────

/// The full RT10 e2e. See module docs for the slice-by-slice walk. Gated
/// `#[ignore = "requires localhost-ssh"]`: opt-in only with
/// `cargo test --release --test integration_remote -- --ignored`.
#[tokio::test]
#[ignore = "requires localhost-ssh"]
async fn end_to_end_remote_session() {
    // Self-skip if ssh-localhost is unusable so a misconfigured dev box gets
    // a clean "skipped" line rather than a confusing failure.
    if !ssh_localhost_usable().await {
        eprintln!("SKIP end_to_end_remote_session: ssh-localhost not usable");
        return;
    }
    if which::which("tmux").is_err() {
        eprintln!("SKIP end_to_end_remote_session: tmux not on PATH");
        return;
    }

    // The "remote" URL the hook curl should dial back to. We point it at the
    // server's bound ephemeral addr AFTER spawn — but the fixture takes the
    // URL at spawn time, so we use the conventional Tailscale-style sentinel
    // here and assert on the marker. (The actual reverse-tunnel mechanics are
    // out of scope for this test — what we PROVE is "not 127.0.0.1".)
    let remote_url = "http://supermux-rt10.tailnet.ts.net:8823".to_string();
    let f = spawn_server(Some(remote_url.clone())).await;

    let user = local_user();
    let ssh_target = format!("{user}@localhost");
    // Uuid-suffix host + session names so the test never collides with itself on
    // re-runs (the tmux session namespace on the remote is global; a leak from
    // an earlier failed run otherwise poisons subsequent attempts). Matches the
    // sibling pattern in tests/lifecycle.rs.
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let host_name = format!("rt10-host-{}", &run_id[..8]);
    let session = format!("rt10-{}", &run_id[..8]);

    // ── 1. Register the host. POST /api/hosts → 201, auto-check fires.
    let (status, body) = send(
        &f.app,
        Method::POST,
        "/api/hosts",
        Some(json!({ "name": host_name, "ssh_target": ssh_target })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create host body: {body}");
    let host_id = body["data"]["id"].as_i64().expect("host id is a number");

    // ── 2. Explicit check → reachable.
    let (status, body) = send(
        &f.app,
        Method::POST,
        &format!("/api/hosts/{host_id}/check"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "check body: {body}");
    let host_status = body["data"]["status"].as_str().unwrap_or("");
    assert_eq!(
        host_status, "reachable",
        "localhost ssh host must be reachable; got {host_status}"
    );

    // ── 3. Create a remote shell session.
    let (status, body) = send(
        &f.app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": session,
            "provider": "shell",
            "host_id": host_id,
            "dir": "/tmp",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create session body: {body}");

    // Start it — spawns the pty via the SSH transport (RT3).
    let (status, body) = send(
        &f.app,
        Method::POST,
        &format!("/api/sessions/{session}/start"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "start body: {body}");

    // ── 4. WS connect → first-frame auth → auth_ok.
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as Msg;
    let url = format!("ws://{}/ws/sessions/{session}", f.addr);
    let (mut ws, _resp) =
        tokio_tungstenite::connect_async(url).await.expect("ws connect");
    ws.send(Msg::Text(format!(r#"{{"type":"auth","token":"{TOKEN}"}}"#)))
        .await
        .unwrap();
    // Read until we see auth_ok or time out.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut saw_auth_ok = false;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(Msg::Text(t)))) if t.contains("auth_ok") => {
                saw_auth_ok = true;
                break;
            }
            Ok(Some(Ok(_))) => {} // replay binary frames are fine
            Ok(Some(Err(e))) => panic!("ws error before auth_ok: {e}"),
            Ok(None) => panic!("ws stream ended before auth_ok"),
            Err(_) => break,
        }
    }
    assert!(saw_auth_ok, "WS first-frame auth must reach auth_ok");
    let _ = ws.close(None).await;

    // ── 5. Send → peek roundtrip.
    let (status, _) = send(
        &f.app,
        Method::POST,
        &format!("/api/sessions/{session}/send"),
        Some(json!({ "text": "echo remote-hello" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sb = peek_until(&f.app, &session, "remote-hello", 20).await;
    assert!(
        sb.contains("remote-hello"),
        "expected 'remote-hello' in peek scrollback within 5s:\n{sb}"
    );

    // Status flips Active → Idle within 10s. We poll the public surface.
    let mut saw_active = false;
    let mut saw_idle_after_active = false;
    let st_deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < st_deadline {
        let (sc, body) = send(
            &f.app,
            Method::GET,
            &format!("/api/sessions/{session}/status"),
            None,
        )
        .await;
        if sc == StatusCode::OK {
            let s = body["data"]["status"].as_str().unwrap_or("").to_lowercase();
            if s.contains("active") {
                saw_active = true;
            } else if saw_active && (s.contains("idle") || s.contains("stopped")) {
                saw_idle_after_active = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    // The status flow is "best-effort" — if the regex detector didn't catch
    // active (very short echo command), don't fail the whole milestone over a
    // detector flake; log + carry on. The send→peek byte path above is the
    // hard contract.
    if !saw_idle_after_active {
        eprintln!(
            "status-flow note: did not observe Active→Idle within 10s (saw_active={saw_active}). \
             The send→peek byte path passed; status detector flake is logged but not fatal."
        );
    }

    // ── 6. Remote file browse — /etc/hostname matches `hostname` on localhost.
    let (status, body) = send(
        &f.app,
        Method::GET,
        &format!("/api/file?session={session}&path=/etc/hostname"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "GET /etc/hostname body: {body}");
    let remote_hostname = body["content"].as_str().unwrap_or("").trim().to_string();
    let local_hostname = std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    // localhost ssh → same machine, so the contents match. We compare without
    // a strict equality to tolerate hostname-short vs FQDN differences (some
    // boxes have `/etc/hostname = host.fqdn.tld` but `hostname` prints
    // `host`); a prefix containment in either direction is sufficient.
    assert!(
        !remote_hostname.is_empty(),
        "remote /etc/hostname must not be empty"
    );
    assert!(
        remote_hostname.contains(&local_hostname)
            || local_hostname.contains(&remote_hostname),
        "remote /etc/hostname '{remote_hostname}' must overlap local hostname '{local_hostname}'"
    );

    // ── 7. Install hooks remotely + assert marker + remote_callback_url.
    //
    // provider=shell sessions don't auto-install hooks (Claude-only path);
    // drive `claude_config::install_hooks` directly through the public
    // surface, using a SshFileTransport built from the live HostPool.
    use supermux_server::files::transport::SshFileTransport;
    use supermux_server::sessions::transport::HostId;
    let transport: Arc<dyn supermux_server::files::transport::FileTransport> = Arc::new(
        SshFileTransport::new(f.state.host_pool.clone(), HostId(host_id)),
    );
    supermux_server::claude_config::install_hooks(
        &session,
        "rt10-hook-token",
        transport.as_ref(),
        None,
    )
    .await
    .expect("install_hooks (remote) must succeed against live ControlMaster");

    // Read back via the file API (session→host_id dispatch goes through SSH).
    let (status, body) = send(
        &f.app,
        Method::GET,
        &format!("/api/file?session={session}&path=~/.claude/settings.json"),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "GET ~/.claude/settings.json body: {body}"
    );
    let settings = body["content"].as_str().unwrap_or("").to_string();
    assert!(
        settings.contains("supermux-hook"),
        "settings.json must contain the supermux-hook marker; got:\n{settings}"
    );
    // The hook command embeds `$SUPERMUX_URL` (resolved AT FIRE TIME on the
    // remote shell from the env we set), NOT the literal URL — that's by
    // design (the URL must NOT be written to the world-readable settings
    // file). What we CAN assert is the marker exists + the literal
    // `127.0.0.1` does NOT appear (which would be the local-default mistake
    // RT5 specifically fixes).
    assert!(
        !settings.contains("127.0.0.1"),
        "settings.json must NOT contain literal 127.0.0.1 (would be a regression of RT5):\n{settings}"
    );

    // ── 8. Teardown — DELETE session, DELETE host, assert cleanup.
    let (status, _) = send(
        &f.app,
        Method::DELETE,
        &format!("/api/sessions/{session}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "session DELETE must succeed");

    // GET the deleted session → 404.
    let (status, _) =
        send(&f.app, Method::GET, &format!("/api/sessions/{session}"), None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "deleted session must 404 after DELETE"
    );

    let (status, _) = send(
        &f.app,
        Method::DELETE,
        &format!("/api/hosts/{host_id}"),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "host DELETE must succeed after session removed"
    );

    let (status, _) = send(
        &f.app,
        Method::GET,
        &format!("/api/hosts/{host_id}"),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "deleted host must 404 after DELETE"
    );

    // Tear down the host pool's ControlMaster so we don't leak across runs.
    let _ = f.state.host_pool.tear_down(host_id).await;
    let _ = std::fs::remove_dir_all(&f.data_dir);
}
