//! M4 WebSocket pty stream integration tests (TECH_PLAN §3.2.7/§3.2.9, §10 M4).
//!
//! These bind a real ephemeral TCP port + `axum::serve` (the `oneshot` harness
//! used elsewhere can't drive a WS upgrade) and connect with `tokio-tungstenite`.
//! Bidirectional + replay coverage spawns REAL tmux sessions (provider `shell`),
//! so they self-skip when tmux is absent (CI has tmux per the M4 verification).
//!
//! Coverage (M4 acceptance):
//!   * first-frame auth → `auth_ok`,
//!   * live pty bytes flow to the client (input round-trips),
//!   * a second client receives the replay buffer,
//!   * the (cap+1)-th subscriber is closed 1013.

use amux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use amux_server::sessions::lifecycle;
use amux_server::sessions::{self, CreateInput};
use amux_server::state::AppState;
use amux_server::{db, http};

use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as Msg;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "ws-pty-secret-token";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

// tungstenite 0.24 (the client side) uses `String`/`Vec<u8>` payloads.
fn text(s: &str) -> Msg {
    Msg::Text(s.to_owned())
}

async fn spawn_server(ws: WsConfig) -> (AppState, SocketAddr, PathBuf) {
    let dir = std::env::temp_dir().join(format!("amux-wspty-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (state, addr, dir)
}

async fn connect(addr: SocketAddr, name: &str) -> Ws {
    let url = format!("ws://{addr}/ws/sessions/{name}");
    let (ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws
}

/// Send the first-frame auth and wait for `auth_ok`.
async fn auth(ws: &mut Ws) {
    ws.send(text(&format!(r#"{{"type":"auth","token":"{TOKEN}"}}"#)))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .expect("auth_ok timed out")
            .expect("ws stream ended")
            .expect("ws error");
        if let Msg::Text(t) = &msg {
            assert!(
                t.as_str().contains("auth_ok"),
                "expected auth_ok, got: {}",
                t.as_str()
            );
            return;
        }
        // Skip any non-text control frame.
    }
}

/// Read frames until a binary frame's accumulated text contains `needle`.
async fn read_binary_until(ws: &mut Ws, needle: &str, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut acc = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(Msg::Binary(b)))) => {
                acc.push_str(&String::from_utf8_lossy(&b));
                if acc.contains(needle) {
                    return true;
                }
            }
            Ok(Some(Ok(Msg::Close(_)))) => return false,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => return false,
            Err(_) => return false,
        }
    }
}

/// Read frames until a Close frame; return its code.
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

async fn make_session(state: &AppState, name: &str) {
    sessions::create(
        state,
        CreateInput {
            name: name.to_string(),
            dir: Some("/tmp".to_string()),
            desc: None,
            provider: Some("shell".to_string()),
            creator: None,
            flags: None,
            tags: None,
            branch: None,
            mcp: None,
            worktree: None,
        },
    )
    .await
    .expect("create session");
    lifecycle::start(state, name, None).await.expect("start session");
}

async fn teardown(state: &AppState, name: &str, dir: PathBuf) {
    let _ = lifecycle::stop(state, name).await;
    let _ = sessions::delete(state, name).await;
    let _ = std::process::Command::new("tmux")
        .args(["kill-session", "-t", &format!("amux3-{name}")])
        .output();
    let _ = std::fs::remove_file(format!("/tmp/amux3-pty-{name}.fifo"));
    let _ = std::fs::remove_dir_all(dir);
}

/// First-frame auth → auth_ok, live pty bytes round-trip, and a 2nd client gets
/// the replay buffer.
#[tokio::test]
async fn ws_auth_live_stream_and_replay() {
    if !tmux_available() {
        eprintln!("skipping ws_auth_live_stream_and_replay: tmux not on PATH");
        return;
    }
    let (state, addr, dir) = spawn_server(WsConfig::default()).await;
    let name = format!("wsp{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    make_session(&state, &name).await;

    // Client A: connect + auth, then drive input that produces pane output.
    let mut a = connect(addr, &name).await;
    auth(&mut a).await;
    // Let the FIFO reader attach (pipe-pane) before producing output.
    tokio::time::sleep(Duration::from_millis(400)).await;

    // Input path: xterm sends the typed line then a named Enter key.
    a.send(text(r#"{"type":"input","data":"echo XYZMARKER"}"#))
        .await
        .unwrap();
    a.send(text(r#"{"type":"key","data":"Enter"}"#)).await.unwrap();

    // Live: a subsequent binary frame must carry the echoed marker.
    assert!(
        read_binary_until(&mut a, "XYZMARKER", Duration::from_secs(10)).await,
        "live pty bytes for XYZMARKER never arrived on client A"
    );

    // Replay: a second client connecting now receives the buffered output in its
    // initial (replay) binary frames.
    let mut b = connect(addr, &name).await;
    auth(&mut b).await;
    assert!(
        read_binary_until(&mut b, "XYZMARKER", Duration::from_secs(5)).await,
        "replay buffer did not carry prior output to client B"
    );

    drop(a);
    drop(b);
    teardown(&state, &name, dir).await;
}

/// With `subscribers_per_session = 2`, the 3rd subscriber is closed 1013 (the
/// "33rd at the default cap of 32" acceptance, scaled down for a fast test).
#[tokio::test]
async fn ws_subscriber_cap_overflow_closes_1013() {
    if !tmux_available() {
        eprintln!("skipping ws_subscriber_cap_overflow_closes_1013: tmux not on PATH");
        return;
    }
    let (state, addr, dir) = spawn_server(WsConfig {
        broadcast_capacity: 1024,
        subscribers_per_session: 2,
    })
    .await;
    let name = format!("wscap{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    make_session(&state, &name).await;

    let mut a = connect(addr, &name).await;
    auth(&mut a).await;
    let mut b = connect(addr, &name).await;
    auth(&mut b).await;
    // Both must enter fan-out (subscribe → receiver_count == cap).
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The 3rd subscriber is over the cap → close 1013 (recoverable, not banned).
    let mut c = connect(addr, &name).await;
    auth(&mut c).await;
    let code = read_close_code(&mut c, Duration::from_secs(5)).await;
    assert_eq!(code, Some(1013), "over-cap subscriber must be closed 1013");

    drop(a);
    drop(b);
    drop(c);
    teardown(&state, &name, dir).await;
}
