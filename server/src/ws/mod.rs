//! WebSocket pty endpoint (TECH_PLAN §3.2.9, §3.4, §6.2; M4).
//!
//! Mounted at `/ws/sessions/{name}` and deliberately NOT wrapped by the bearer
//! middleware — auth is **in-band first-frame** (`{"type":"auth","token":...}`),
//! so the token never lands in a URL, access log, or screenshot (Codex T0 / #7).
//!
//! Handshake (§3.2.9):
//!   1. **Origin allowlist** (§6.2) — bad Origin → close 1008.
//!   2. **First-frame auth** within 2s — missing/invalid → close 1008.
//!   3. `{"type":"auth_ok"}`, then per-session subscriber cap → 33rd closes 1013
//!      (recoverable: the client silently reconnects on next visibility).
//!   4. Replay snapshot (≤64 KB) as binary frames, then live fan-out.
//!   5. Slow subscriber (`broadcast` Lagged) → close 1013 (never blocks fan-out).
//!   6. Server PING every 20s; no inbound traffic for 30s → close.

pub mod protocol;
pub mod streamer;

use std::net::IpAddr;
use std::time::Duration;

use axum::extract::ws::{close_code, CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use tokio::time::{Instant, MissedTickBehavior};

use crate::sessions::tmux::Tmux;
use crate::state::AppState;

use protocol::ClientMsg;

/// Server PING cadence and the inbound-silence deadline after which we close.
const PING_EVERY: Duration = Duration::from_secs(20);
const PONG_DEADLINE: Duration = Duration::from_secs(30);
/// First-frame auth window.
const AUTH_TIMEOUT: Duration = Duration::from_secs(2);

/// Application close code for "the session's tmux pty is gone" (e.g. the DB row
/// survived a reboot but the tmux session did not). This is a TERMINAL condition,
/// distinct from `close_code::ERROR` (1011 — a transient server error worth a
/// backoff retry): the client must STOP reconnecting and surface a stopped state
/// rather than hammering the endpoint. 4000-4999 is the WebSocket private range.
const CLOSE_NOT_RUNNING: u16 = 4404;

/// The WS sub-router. Merged at the top level of `http::router` (no bearer layer).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/ws/sessions/{name}", get(handle_ws))
        .with_state(state)
}

/// Upgrade handler. The Origin decision is made on the pre-upgrade request and
/// carried into the socket task (a real WS close frame can only be sent after the
/// upgrade, so a bad Origin still upgrades and is closed 1008 — §6.2).
async fn handle_ws(
    ws: WebSocketUpgrade,
    Path(name): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let origin_ok = origin_allowed(&state, &headers);
    ws.on_upgrade(move |socket| handle_socket(socket, name, state, origin_ok))
}

async fn handle_socket(mut socket: WebSocket, name: String, state: AppState, origin_ok: bool) {
    if !origin_ok {
        close(&mut socket, close_code::POLICY, "origin not allowed").await;
        return;
    }

    // 1. First-frame auth: the first inbound frame within 2s must be a valid
    //    `{"type":"auth","token":...}`.
    let authed = match tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => verify_auth_frame(&state, t.as_str()),
        _ => false,
    };
    if !authed {
        close(&mut socket, close_code::POLICY, "auth required").await;
        return;
    }
    if socket
        .send(Message::Text(Utf8Bytes::from_static(r#"{"type":"auth_ok"}"#)))
        .await
        .is_err()
    {
        return;
    }

    // 2. Up-front liveness check: if the tmux session is gone (a `stopped`
    //    session — DB row survived a reboot but the pty did not), close with the
    //    explicit terminal code 4404 so the client STOPS reconnecting instead of
    //    storming this endpoint. This is logged at debug, not warn: a stopped
    //    session being opened is expected, not a server fault.
    if !Tmux::new(&name).exists().await.unwrap_or(false) {
        tracing::debug!(session = %name, "ws closed: session not running");
        close(&mut socket, CLOSE_NOT_RUNNING, "session not running").await;
        return;
    }

    // 3. Ensure the per-session reader is running and enforce the subscriber cap.
    let stream = match state.pty_for(&name).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(session = %name, error = %e, "pty stream unavailable");
            close(&mut socket, close_code::ERROR, "stream unavailable").await;
            return;
        }
    };
    if stream.subscriber_count() >= state.config.ws.subscribers_per_session {
        // Recoverable, NOT permanent (Eng P1 #4): the client reconnects silently
        // on its next visibility-visible event.
        close(&mut socket, close_code::AGAIN, "subscriber limit").await;
        return;
    }

    // 4. Replay snapshot first (so the client is current before any live byte).
    let (replay, mut rx) = stream.subscribe();
    for chunk in replay {
        if socket.send(Message::Binary(chunk)).await.is_err() {
            return;
        }
    }

    // 5. Unified fan-out + client-read + ping loop (single task, no split — uses
    //    WebSocket's inherent recv/send).
    let mut last_inbound = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Skip);
    ping.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(msg)) => {
                        last_inbound = Instant::now();
                        match msg {
                            Message::Text(t) => {
                                if let Ok(cmd) = serde_json::from_str::<ClientMsg>(t.as_str()) {
                                    apply_client_msg(&state, &name, cmd).await;
                                }
                            }
                            Message::Close(_) => break,
                            // Ping is auto-ponged by the transport; Pong/Binary
                            // just refresh the liveness timer above.
                            _ => {}
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Ok(chunk) => {
                        if socket.send(Message::Binary(chunk)).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Slow subscriber — drop it rather than stall fan-out.
                        close(&mut socket, close_code::AGAIN, "too slow").await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ping.tick() => {
                if last_inbound.elapsed() > PONG_DEADLINE {
                    close(&mut socket, close_code::AWAY, "ping timeout").await;
                    break;
                }
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// Route a control frame to tmux. Holds the per-session lock for the duration of
/// the tmux command (§5.2 keystroke path "acquire session lock").
async fn apply_client_msg(state: &AppState, name: &str, cmd: ClientMsg) {
    let tmux = Tmux::new(name);
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    let res = match cmd {
        ClientMsg::Input { data } => tmux.send_text(&data).await,
        ClientMsg::Key { data } => tmux.send_key(&data).await,
        ClientMsg::Resize { cols, rows } => tmux.resize(cols, rows).await,
        // Auth-after-auth and client Ping are no-ops on the input path.
        ClientMsg::Auth { .. } | ClientMsg::Ping => Ok(()),
    };
    if let Err(e) = res {
        tracing::debug!(session = %name, error = %e, "ws input → tmux failed");
    }
}

/// Constant-time validation of the first-frame auth message (§6.1).
fn verify_auth_frame(state: &AppState, text: &str) -> bool {
    match serde_json::from_str::<ClientMsg>(text) {
        Ok(ClientMsg::Auth { token }) => constant_time_eq::constant_time_eq(
            token.as_bytes(),
            state.config.auth_token.as_bytes(),
        ),
        _ => false,
    }
}

/// Origin allowlist (§6.2): `localhost`, `127.0.0.1`/`::1`, the bind/extra-bind
/// IPs, private-LAN IPv4, and Tailscale MagicDNS (`*.ts.net`). A *missing* Origin
/// header means a non-browser client (native app / curl) — allowed; browsers
/// always send Origin, so cross-site requests are caught.
fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    let origin = match headers.get(header::ORIGIN) {
        None => return true,
        Some(v) => match v.to_str() {
            Ok(s) => s,
            Err(_) => return false,
        },
    };
    let host = match url::Url::parse(origin).ok().and_then(|u| u.host_str().map(str::to_string)) {
        Some(h) => h,
        None => return false,
    };

    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.ends_with(".ts.net")
        || is_private_lan(&host)
        || matches_bind_host(state, &host)
}

/// Private-range IPv4 (RFC1918) or link-local — i.e. a LAN address. (Loopback is
/// matched by string above; we deliberately avoid `is_loopback`-style bypasses on
/// the auth path — §6.1.)
fn is_private_lan(host: &str) -> bool {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_private() || v4.is_link_local(),
        _ => false,
    }
}

/// Allow the server's own bind IP and any configured extra-bind IP as an Origin.
fn matches_bind_host(state: &AppState, host: &str) -> bool {
    state.config.bind.ip().to_string() == host
        || state
            .config
            .extra_binds
            .iter()
            .any(|a| a.ip().to_string() == host)
}

/// Send a close frame, swallowing transport errors (we're tearing down anyway).
async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: Utf8Bytes::from_static(reason),
        })))
        .await;
}
