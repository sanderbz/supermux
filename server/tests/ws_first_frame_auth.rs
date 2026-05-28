//! M4 first-frame WS auth + Origin allowlist tests (TECH_PLAN §3.2.9, §6.2, §10).
//!
//! Auth runs BEFORE any pty work, so these need no tmux — they bind a real port
//! and assert the close codes for the auth/origin failure paths:
//!   * no first frame within 2s → close 1008,
//!   * wrong token → close 1008,
//!   * a non-auth first frame → close 1008,
//!   * a disallowed `Origin` → close 1008,
//!   * a valid token still reaches `auth_ok` (then 1011 because the session has
//!     no live pane) — proving the happy auth path is distinct from 1008.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as Msg;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "first-frame-auth-secret";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

// tungstenite 0.24 (the client side) uses `String`/`Vec<u8>` payloads.
fn text(s: &str) -> Msg {
    Msg::Text(s.to_owned())
}

async fn spawn_server() -> (SocketAddr, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-wsauth-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: None,
            push_sub: None,
            github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, dir)
}

async fn connect(addr: SocketAddr) -> Ws {
    let url = format!("ws://{addr}/ws/sessions/ghost");
    let (ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws
}

/// Read frames until a Close frame; return its code (skipping any auth_ok text).
async fn read_close_code(ws: &mut Ws, timeout: Duration) -> Option<u16> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(Msg::Close(Some(cf))))) => return Some(u16::from(cf.code)),
            Ok(Some(Ok(Msg::Close(None)))) => return None,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => return None,
            Err(_) => return None,
        }
    }
}

#[tokio::test]
async fn missing_auth_frame_closes_1008_within_2s() {
    let (addr, dir) = spawn_server().await;
    let mut ws = connect(addr).await;
    // Send nothing; the 2s server timeout must fire and close 1008.
    let start = tokio::time::Instant::now();
    let code = read_close_code(&mut ws, Duration::from_secs(4)).await;
    assert_eq!(code, Some(1008), "missing auth frame must close 1008");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "close should arrive within ~2s, took {:?}",
        start.elapsed()
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn wrong_token_closes_1008() {
    let (addr, dir) = spawn_server().await;
    let mut ws = connect(addr).await;
    ws.send(text(r#"{"type":"auth","token":"WRONG-TOKEN"}"#))
        .await
        .unwrap();
    let code = read_close_code(&mut ws, Duration::from_secs(4)).await;
    assert_eq!(code, Some(1008), "wrong token must close 1008");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn non_auth_first_frame_closes_1008() {
    let (addr, dir) = spawn_server().await;
    let mut ws = connect(addr).await;
    // A well-formed control frame that is NOT an auth frame.
    ws.send(text(r#"{"type":"input","data":"x"}"#))
        .await
        .unwrap();
    let code = read_close_code(&mut ws, Duration::from_secs(4)).await;
    assert_eq!(code, Some(1008), "non-auth first frame must close 1008");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn disallowed_origin_closes_1008() {
    let (addr, dir) = spawn_server().await;
    let url = format!("ws://{addr}/ws/sessions/ghost");
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    let (mut ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .expect("ws connect");
    let code = read_close_code(&mut ws, Duration::from_secs(4)).await;
    assert_eq!(code, Some(1008), "disallowed Origin must close 1008");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn valid_token_reaches_auth_ok() {
    let (addr, dir) = spawn_server().await;
    let mut ws = connect(addr).await;
    ws.send(text(&format!(r#"{{"type":"auth","token":"{TOKEN}"}}"#)))
        .await
        .unwrap();

    // First frame after a VALID auth must be auth_ok (not a 1008 close).
    let first = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("auth_ok timed out")
        .expect("stream ended")
        .expect("ws error");
    match first {
        Msg::Text(t) => assert!(
            t.as_str().contains("auth_ok"),
            "expected auth_ok, got {}",
            t.as_str()
        ),
        other => panic!("expected auth_ok text, got {other:?}"),
    }

    // The ghost session has no live tmux pane → the up-front liveness check
    // closes with the explicit terminal code 4404 "session not running" (NOT
    // 1008 — the token WAS accepted; and NOT 1011 — this is a terminal state the
    // client must not reconnect to, distinct from a transient server error).
    let code = read_close_code(&mut ws, Duration::from_secs(4)).await;
    assert_eq!(
        code,
        Some(4404),
        "no live session → terminal 'not running' close (4404)"
    );
    let _ = std::fs::remove_dir_all(dir);
}
