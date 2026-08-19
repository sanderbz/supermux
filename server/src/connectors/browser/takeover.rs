//! **Phase 2 — the human takeover socket.**
//!
//! One WebSocket per session that turns the agent's headless page into a
//! *thing a person can use*: JPEG frames out at up to 60 fps, pointer/key/touch
//! events back in, and the phase-1 [`DriveLock`](super::lock::DriveLock) as the
//! interlock between the two drivers.
//!
//! ```text
//!   web canvas ──input JSON──▶ takeover WS ──Input.dispatch*──▶ page
//!        ▲                          │
//!        └──frame JSON (b64 jpeg)───┴──Page.screencastFrameAck──▶ page
//! ```
//!
//! # The lock IS the pause button
//!
//! Attaching sets [`DriveMode::HumanDriving`]. That single flag is the entire
//! "pause the agent" mechanism: every agent-side browser call goes through
//! [`DriveLock::gate`](super::lock::DriveLock::gate)/`ensure_agent` and is
//! refused (or parks in `await_agent`) until the human hands back. We do **not**
//! SIGSTOP the agent's pty — the agent stays alive, keeps thinking, and simply
//! cannot touch this page. Detaching (socket close, or an explicit `hand_back`)
//! releases it. Both transitions are idempotent, so a flapping mobile
//! connection cannot wedge a context in `HumanDriving`… except by staying
//! attached, which is exactly what it means.
//!
//! Releasing on ANY socket exit is correct — a human who is gone must not hold
//! the wheel — but "the socket closed" is not "the human finished". The release
//! therefore carries a [`HandOff`](super::lock::HandOff): only the explicit
//! `hand_back` frame is `Explicit`; every transport exit is `Disconnected`, and
//! a parked agent is told so instead of being told the login succeeded.
//!
//! # Frames and backpressure
//!
//! Chromium keeps at most **2 screencast frames in flight** and only produces
//! the next one when an earlier one is acked. Phase 1's pump acked immediately;
//! this socket asks for [`AckPolicy::Viewer`] instead and acks only **after the
//! client's socket has accepted the frame**, which converts that 2-frame window
//! into real end-to-end backpressure — a slow phone throttles chrome's encoder
//! rather than making the server drop frames it already paid to encode.
//!
//! The ack is a *counter decrement*, not a per-frame receipt, so a dropped
//! frame must still be acked or the stream stalls permanently. The one place
//! frames can be dropped is a `Lagged` broadcast receiver (the channel holds 16
//! and chrome will only ever have 2 outstanding, so this is close to
//! unreachable); we ack once per dropped frame there to keep the counter
//! honest. **Drop-old-frames** is the policy: a late frame is worthless.
//!
//! # Coordinates
//!
//! The client sends **page-viewport CSS pixels**, not canvas pixels. Only the
//! client knows its canvas' CSS size and the letterboxing of the image inside
//! it, so it does that division itself (`web/src/lib/browser/frame-map.ts`)
//! from the `metadata` we relay verbatim — `deviceWidth`/`deviceHeight` is the
//! CSS-pixel box the JPEG covers and `offsetTop` is the non-page strip above
//! it. The server does not trust the result: every coordinate is checked finite
//! and clamped to the live viewport (from the last frame's metadata) before it
//! reaches CDP.
//!
//! # Auth
//!
//! In-band first-frame, byte-identical to the terminal and chat sockets — a
//! browser `WebSocket` cannot send an `Authorization` header, so this router is
//! merged **outside** the bearer layer and reuses
//! [`crate::ws::verify_auth_frame`] / [`crate::ws::origin_allowed`].

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use axum::extract::ws::{close_code, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{debug, info, warn};

use super::context::{AckPolicy, AgentContext, ScreencastOptions};
use super::lock::{Actor, DriveMode, HandOff};
use crate::state::AppState;
use crate::ws::{
    close, origin_allowed, verify_auth_frame, AUTH_TIMEOUT, PING_EVERY, PONG_DEADLINE,
};

/// Close code for "this session has no browser context". Terminal, in the
/// WebSocket private range, and the same 4404 the terminal/chat sockets use for
/// their own "the thing you asked for is not there": the client must stop
/// redialling and say so, not back off forever. A takeover implies the agent
/// already opened a page — there is nothing to take over otherwise.
pub const CLOSE_NO_CONTEXT: u16 = 4404;
/// The `reason` string that goes with it. Pinned on both sides (the web client
/// asserts on this exact text) so the day it moves, a test fails.
pub const REASON_NO_CONTEXT: &str = "no browser context";
/// Close reason when another takeover socket already holds this session.
pub const REASON_ALREADY_ATTACHED: &str = "already attached";

/// Longest `insert_text` payload we relay in one frame. Generous for a paste,
/// small enough that a hostile client cannot use the socket as a memory
/// amplifier.
const MAX_TEXT_BYTES: usize = 8 * 1024;

/// Fallback clamp bound before the first frame's metadata has told us the real
/// viewport. Larger than any plausible page viewport; the real clamp arrives
/// with frame #1, a few ms in.
const COORD_CEILING: f64 = 100_000.0;

/// The WS sub-router. Merged at the TOP level of [`crate::http::router`] (next
/// to [`crate::ws::router_for`]), **not** into the bearer-protected `/api`
/// router — see the module docs on auth.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/ws/browser/{session}/takeover", get(handle_takeover_ws))
        .with_state(state)
}

/// Upgrade handler. The Origin decision is made on the pre-upgrade request and
/// carried into the socket task, because a real close frame can only be sent
/// after the upgrade.
async fn handle_takeover_ws(
    ws: WebSocketUpgrade,
    Path(session): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let origin_ok = origin_allowed(&state, &headers);
    ws.on_upgrade(move |socket| takeover_socket(socket, session, state, origin_ok))
}

// ── one viewer at a time ────────────────────────────────────────────────────

/// Sessions with a live takeover socket.
///
/// A second viewer would be actively harmful, not merely redundant: it would
/// double-ack every frame, and — worse — *its* disconnect would
/// `release_to_agent` while the first human is still driving, handing the wheel
/// back mid-gesture. So the second socket is refused with 1013 (retryable).
fn viewers() -> &'static Mutex<HashSet<String>> {
    static VIEWERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    VIEWERS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// **Is a human actually looking at this session's page right now?**
///
/// Phase 3 asks before deciding what a timed-out `request_human_takeover` park
/// means: a human who IS attached is simply taking their time (keep the wheel
/// with them), while nobody attached means the ask went unanswered and the
/// wheel must go back to the agent rather than wedging the context.
pub fn is_attached(session: &str) -> bool {
    viewers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(session)
}

/// RAII claim on a session's single viewer slot.
struct ViewerSlot(String);

impl ViewerSlot {
    fn claim(session: &str) -> Option<Self> {
        let mut set = viewers().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(session.to_string()) {
            return None;
        }
        Some(Self(session.to_string()))
    }
}

impl Drop for ViewerSlot {
    fn drop(&mut self) {
        viewers()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

// ── the wire ────────────────────────────────────────────────────────────────

/// Pointer phase. `move` is deliberately included: a drag, a hover menu, and a
/// `:hover` style are all things a human expects to work, and none of them
/// survives a click-only relay.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MouseKind {
    Move,
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TouchKind {
    Start,
    Move,
    End,
    Cancel,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    Down,
    Up,
}

/// client → server. Internally tagged, like every other supermux socket.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First frame, always: `{"type":"auth","token":…}`.
    Auth { token: String },
    /// Pointer event at page-viewport CSS pixels.
    Mouse {
        kind: MouseKind,
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<String>,
        #[serde(default)]
        buttons: u32,
        #[serde(default)]
        click_count: u32,
        #[serde(default)]
        modifiers: u32,
    },
    /// Wheel/scroll delta at a point.
    Wheel {
        x: f64,
        y: f64,
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
        #[serde(default)]
        modifiers: u32,
    },
    /// One key transition. `text` present ⇒ it inserts something.
    Key {
        kind: KeyKind,
        key: String,
        #[serde(default)]
        code: String,
        #[serde(default)]
        key_code: i64,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        modifiers: u32,
    },
    /// IME / paste / emoji — anything per-key events cannot express.
    Text { text: String },
    /// A single touch point (multi-touch is not modelled: the takeover canvas
    /// is one finger, and pinch-zoom belongs to the client's own viewport).
    Touch {
        kind: TouchKind,
        #[serde(default)]
        x: f64,
        #[serde(default)]
        y: f64,
    },
    /// Give the wheel back but KEEP watching (the socket stays open, frames
    /// keep flowing, input starts being refused).
    HandBack,
    /// Grab the wheel again after a `hand_back`.
    TakeOver,
    /// Re-send a full still frame — a static page emits no screencast frames
    /// (spike gotcha #1), so a client that missed the seed would otherwise sit
    /// on a blank canvas until something on the page moved.
    Resync,
    /// Client-initiated liveness ping.
    Ping,
}

/// server → client. All JSON text frames.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg<'a> {
    /// Handshake echo — the same literal the terminal socket sends.
    AuthOk,
    /// What you are looking at, sent once after the handshake.
    Target {
        session: &'a str,
        url: String,
        width: u32,
        height: u32,
    },
    /// One JPEG, base64, plus the CDP metadata the client maps taps with.
    Frame { data: &'a str, metadata: &'a Value },
    /// The live drive mode — the AGENT/HUMAN pill.
    Mode { mode: DriveMode },
    /// An input event was dropped because the human does not hold the wheel.
    Refused { reason: &'a str },
}

impl ServerMsg<'_> {
    fn to_frame(&self) -> Message {
        Message::Text(Utf8Bytes::from(
            serde_json::to_string(self).unwrap_or_else(|_| r#"{"type":"refused"}"#.to_string()),
        ))
    }
}

// ── input → CDP ─────────────────────────────────────────────────────────────

/// The live viewport, learned from the newest frame's metadata. Coordinates
/// from the client are clamped to it, so a malformed or hostile client can
/// dispatch inside the page but never at absurd offsets.
#[derive(Debug, Clone, Copy)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
}

impl Viewport {
    /// Read `deviceWidth`/`deviceHeight` off a `Page.screencastFrame`
    /// `metadata` object; `None` when the metadata does not carry a usable box.
    pub fn from_metadata(metadata: &Value) -> Option<Self> {
        let width = metadata.get("deviceWidth").and_then(Value::as_f64)?;
        let height = metadata.get("deviceHeight").and_then(Value::as_f64)?;
        (width > 0.0 && height > 0.0).then_some(Self { width, height })
    }

    /// Clamp a client-supplied point into this viewport. Non-finite input
    /// (`NaN`, `Infinity` — both legal JSON floats through serde) collapses to
    /// `0.0` rather than reaching CDP.
    pub fn clamp(&self, x: f64, y: f64) -> (f64, f64) {
        let fix = |v: f64, max: f64| {
            if v.is_finite() {
                v.clamp(0.0, max)
            } else {
                0.0
            }
        };
        (fix(x, self.width), fix(y, self.height))
    }
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            width: COORD_CEILING,
            height: COORD_CEILING,
        }
    }
}

/// One CDP call: `(method, params)`.
pub type CdpCall = (&'static str, Value);

/// Translate a client message into the CDP command it forwards, or `None` when
/// it is a control frame (auth/hand_back/…) with no page effect.
///
/// Pure, so the whole mapping — button masks, `rawKeyDown` vs `keyDown`,
/// clamping, the text cap — is testable without a browser or a socket.
pub fn to_cdp(msg: &ClientMsg, viewport: Viewport) -> Option<CdpCall> {
    match msg {
        ClientMsg::Mouse {
            kind,
            x,
            y,
            button,
            buttons,
            click_count,
            modifiers,
        } => {
            let (x, y) = viewport.clamp(*x, *y);
            let kind_str = match kind {
                MouseKind::Move => "mouseMoved",
                MouseKind::Down => "mousePressed",
                MouseKind::Up => "mouseReleased",
            };
            // A press/release with no button named is a left click; a move
            // with no buttons held is a plain hover.
            let button = match button.as_deref() {
                Some("left") | Some("right") | Some("middle") | Some("back") | Some("forward")
                | Some("none") => button.as_deref().unwrap(),
                _ if matches!(kind, MouseKind::Move) => "none",
                _ => "left",
            };
            Some((
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind_str,
                    "x": x, "y": y,
                    "button": button,
                    "buttons": buttons,
                    "clickCount": (*click_count).min(3).max(u32::from(!matches!(kind, MouseKind::Move))),
                    "modifiers": modifiers & 0b1111,
                }),
            ))
        }
        ClientMsg::Wheel {
            x,
            y,
            dx,
            dy,
            modifiers,
        } => {
            let (x, y) = viewport.clamp(*x, *y);
            let delta = |v: f64| if v.is_finite() { v.clamp(-10_000.0, 10_000.0) } else { 0.0 };
            Some((
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": x, "y": y,
                    "deltaX": delta(*dx), "deltaY": delta(*dy),
                    "buttons": 0,
                    "modifiers": modifiers & 0b1111,
                }),
            ))
        }
        ClientMsg::Key {
            kind,
            key,
            code,
            key_code,
            text,
            modifiers,
        } => {
            // `rawKeyDown` vs `keyDown` is not cosmetic: a keyDown WITHOUT text
            // still fires an empty `input`-ish path in some engines, and
            // DevTools' own screencast picks between the two exactly this way.
            let text = text.as_deref().filter(|t| !t.is_empty());
            let kind_str = match (kind, text) {
                (KeyKind::Down, Some(_)) => "keyDown",
                (KeyKind::Down, None) => "rawKeyDown",
                (KeyKind::Up, _) => "keyUp",
            };
            let mut params = json!({
                "type": kind_str,
                "key": clip(key, 32),
                // gotcha #8: an empty `code` breaks pages that read e.code.
                "code": clip(code, 32),
                "windowsVirtualKeyCode": key_code,
                "nativeVirtualKeyCode": key_code,
                "modifiers": modifiers & 0b1111,
            });
            if let Some(t) = text {
                let t = clip(t, 16);
                params["text"] = json!(t);
                params["unmodifiedText"] = json!(t);
            }
            Some(("Input.dispatchKeyEvent", params))
        }
        ClientMsg::Text { text } => {
            if text.is_empty() {
                return None;
            }
            Some((
                "Input.insertText",
                json!({ "text": clip(text, MAX_TEXT_BYTES) }),
            ))
        }
        ClientMsg::Touch { kind, x, y } => {
            let (x, y) = viewport.clamp(*x, *y);
            let kind_str = match kind {
                TouchKind::Start => "touchStart",
                TouchKind::Move => "touchMove",
                TouchKind::End => "touchEnd",
                TouchKind::Cancel => "touchCancel",
            };
            // touchEnd/touchCancel take an EMPTY point list — passing the
            // lifted finger is a protocol error, not a no-op.
            let points = match kind {
                TouchKind::Start | TouchKind::Move => json!([{ "x": x, "y": y }]),
                TouchKind::End | TouchKind::Cancel => json!([]),
            };
            Some((
                "Input.dispatchTouchEvent",
                json!({ "type": kind_str, "touchPoints": points }),
            ))
        }
        ClientMsg::Auth { .. }
        | ClientMsg::HandBack
        | ClientMsg::TakeOver
        | ClientMsg::Resync
        | ClientMsg::Ping => None,
    }
}

/// **The relay's own gate.** `Actor::Human` is never refused by the lock — that
/// is the whole point of the human escalation path — so "is this socket allowed
/// to drive right now" has to be asked separately, here, before anything is
/// forwarded. It is false the moment the wheel is not ours: after a `hand_back`,
/// or if something else released the context underneath us.
pub fn human_may_drive(mode: DriveMode) -> bool {
    matches!(mode, DriveMode::HumanDriving)
}

/// Truncate to `max` BYTES on a char boundary (never mid-UTF-8).
fn clip(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── the socket ──────────────────────────────────────────────────────────────

async fn takeover_socket(
    mut socket: WebSocket,
    session: String,
    state: AppState,
    origin_ok: bool,
) {
    if !origin_ok {
        close(&mut socket, close_code::POLICY, "origin not allowed").await;
        return;
    }

    // 1. First-frame auth — the terminal socket's contract, verbatim.
    let authed = match tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => verify_auth_frame(&state, t.as_str()),
        _ => false,
    };
    if !authed {
        close(&mut socket, close_code::POLICY, "auth required").await;
        return;
    }
    // 1a. Same name gate the REST surface applies, before the name is used as a
    //     map key or reaches a log line.
    if !crate::sessions::valid_name(&session) {
        close(&mut socket, close_code::POLICY, "bad name").await;
        return;
    }
    if socket.send(ServerMsg::AuthOk.to_frame()).await.is_err() {
        return;
    }

    // 2. There must ALREADY be a context: a takeover takes over something. We
    //    deliberately do NOT `context_for` here — that would let an unauthorised
    //    surface spawn chrome, and it would present an empty about:blank as if
    //    it were the agent's work.
    let Some(ctx) = state.browser.context(&session).await else {
        close(&mut socket, CLOSE_NO_CONTEXT, REASON_NO_CONTEXT).await;
        return;
    };

    // 3. One viewer per session (see `ViewerSlot`).
    let Some(_slot) = ViewerSlot::claim(&session) else {
        close(&mut socket, close_code::AGAIN, REASON_ALREADY_ATTACHED).await;
        return;
    };

    // 4. **Grab the wheel.** This is the agent pause — see the module docs.
    let previous = ctx.lock().request_human_takeover();
    info!(session = %session, %previous, "browser takeover: attached");

    let outcome = drive(&mut socket, &session, &ctx).await;

    // 5. Teardown, unconditional. `stop_screencast` first so chrome stops
    //    encoding for a socket that is gone, then the wheel goes back to the
    //    agent — which also wakes anything parked in `await_agent`.
    if let Err(e) = ctx.stop_screencast(Actor::Human).await {
        debug!(session = %session, error = %e, "browser takeover: stopScreencast");
    }
    // **Truthfully.** EVERY way out of `drive` is the socket going away — a tab
    // close, a dead mobile link, a ping timeout, an error — and none of them is
    // the human saying "I'm done". The one explicit hand-back is the
    // `ClientMsg::HandBack` frame, which already released the wheel (as
    // `Explicit`) inside the loop; this redundant release cannot overwrite that
    // label, because `release_to_agent` only records the release that actually
    // took the wheel back. So a parked agent is told the truth in both cases —
    // see `tools::handback_result`.
    ctx.lock().release_to_agent(HandOff::Disconnected);
    info!(session = %session, ?outcome, "browser takeover: detached, released to AGENT");
}

/// Why the socket loop ended. Logged, not sent — by the time we know, the
/// socket is usually already gone.
#[derive(Debug)]
enum Outcome {
    ClientClosed,
    PingTimeout,
    SendFailed,
    ScreencastGone,
    StartFailed,
}

async fn drive(socket: &mut WebSocket, session: &str, ctx: &AgentContext) -> Outcome {
    // Seed: the target line, a still frame, and the current mode. The still is
    // load-bearing — a static page produces NO screencast frames (gotcha #1),
    // so without it a client attaching to an idle page sees a blank canvas.
    let url = ctx.current_url().await.unwrap_or_default();
    if socket
        .send(
            ServerMsg::Target {
                session,
                url,
                width: 0,
                height: 0,
            }
            .to_frame(),
        )
        .await
        .is_err()
    {
        return Outcome::SendFailed;
    }
    if let Ok(still) = ctx.screenshot().await {
        let meta = json!({});
        if socket
            .send(
                ServerMsg::Frame {
                    data: &still,
                    metadata: &meta,
                }
                .to_frame(),
            )
            .await
            .is_err()
        {
            return Outcome::SendFailed;
        }
    }
    if socket
        .send(ServerMsg::Mode { mode: ctx.mode() }.to_frame())
        .await
        .is_err()
    {
        return Outcome::SendFailed;
    }

    // The screencast, with the ack handed to US (see the module docs on
    // backpressure).
    let mut frames = match ctx
        .start_screencast(
            Actor::Human,
            ScreencastOptions {
                ack: AckPolicy::Viewer,
                ..ScreencastOptions::default()
            },
        )
        .await
    {
        Ok(rx) => rx,
        Err(e) => {
            warn!(session = %session, error = %e, "browser takeover: startScreencast failed");
            return Outcome::StartFailed;
        }
    };

    let mut modes = ctx.lock().subscribe();
    let mut viewport = Viewport::default();
    // The newest ack token, kept so DROPPED frames can still be acked — an
    // unacked frame permanently stalls chrome's 2-slot in-flight window.
    let mut last_ack: Option<Value> = None;

    let mut last_inbound = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Skip);
    ping.tick().await;

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                match inbound {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => {
                        return Outcome::ClientClosed;
                    }
                    Some(Ok(Message::Text(t))) => {
                        last_inbound = Instant::now();
                        let Ok(msg) = serde_json::from_str::<ClientMsg>(t.as_str()) else {
                            // Unknown/garbled frame: a no-op, exactly like the
                            // other sockets. It still counts as liveness.
                            continue;
                        };
                        match msg {
                            ClientMsg::HandBack => {
                                // THE explicit hand-off: the human pressed the
                                // button. The only exit that may be reported to
                                // a parked agent as "the human finished".
                                ctx.lock().release_to_agent(HandOff::Explicit);
                                continue;
                            }
                            ClientMsg::TakeOver => {
                                ctx.lock().request_human_takeover();
                                continue;
                            }
                            ClientMsg::Resync => {
                                if let Ok(still) = ctx.screenshot().await {
                                    let meta = json!({});
                                    if socket.send(ServerMsg::Frame { data: &still, metadata: &meta }.to_frame()).await.is_err() {
                                        return Outcome::SendFailed;
                                    }
                                }
                                continue;
                            }
                            ClientMsg::Auth { .. } | ClientMsg::Ping => continue,
                            _ => {}
                        }
                        // THE GATE. The human's own events are never gated by
                        // `Actor::Human` (that is the point of the escalation
                        // path), so the mode is checked HERE: if the wheel is
                        // not ours — a `hand_back` landed, or the context was
                        // released underneath us — the event is dropped and the
                        // client is told why, rather than silently racing the
                        // agent for the same page.
                        if !human_may_drive(ctx.mode()) {
                            if socket
                                .send(ServerMsg::Refused { reason: "agent is driving" }.to_frame())
                                .await
                                .is_err()
                            {
                                return Outcome::SendFailed;
                            }
                            continue;
                        }
                        if let Some((method, params)) = to_cdp(&msg, viewport) {
                            if let Err(e) = ctx.dispatch_input(Actor::Human, method, params).await {
                                debug!(session = %session, method, error = %e, "browser takeover: input");
                            }
                        }
                    }
                    Some(Ok(_)) => { last_inbound = Instant::now(); }
                }
            }

            frame = frames.recv() => {
                match frame {
                    Ok(f) => {
                        if let Some(vp) = Viewport::from_metadata(&f.metadata) {
                            viewport = vp;
                        }
                        if f.ack.is_some() {
                            last_ack = f.ack.clone();
                        }
                        let sent = socket
                            .send(ServerMsg::Frame { data: &f.data, metadata: &f.metadata }.to_frame())
                            .await;
                        // Ack AFTER the socket accepted it — the whole point of
                        // `AckPolicy::Viewer`. On a send failure we are leaving
                        // anyway, so the unacked frame is irrelevant.
                        if sent.is_err() {
                            return Outcome::SendFailed;
                        }
                        if let Some(ack) = &f.ack {
                            let _ = ctx.ack_frame(ack);
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        // Dropped `n` frames we never saw. Their acks are still
                        // owed (an ack is a counter decrement, not a receipt),
                        // so pay them with the last token we hold or chrome
                        // never sends another frame.
                        debug!(session = %session, dropped = n, "browser takeover: frame lag");
                        if let Some(ack) = &last_ack {
                            for _ in 0..n {
                                let _ = ctx.ack_frame(ack);
                            }
                        }
                    }
                    Err(RecvError::Closed) => return Outcome::ScreencastGone,
                }
            }

            changed = modes.changed() => {
                if changed.is_err() {
                    return Outcome::ScreencastGone;
                }
                let mode = *modes.borrow_and_update();
                if socket.send(ServerMsg::Mode { mode }.to_frame()).await.is_err() {
                    return Outcome::SendFailed;
                }
            }

            _ = ping.tick() => {
                if last_inbound.elapsed() > PONG_DEADLINE {
                    close(socket, close_code::AWAY, "ping timeout").await;
                    return Outcome::PingTimeout;
                }
                if socket.send(Message::Ping(bytes::Bytes::new())).await.is_err() {
                    return Outcome::SendFailed;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> ClientMsg {
        serde_json::from_str(s).expect("client frame")
    }

    #[test]
    fn a_tap_becomes_a_clamped_left_press() {
        let vp = Viewport { width: 400.0, height: 300.0 };
        let msg = parse(r#"{"type":"mouse","kind":"down","x":9999,"y":-5}"#);
        let (method, params) = to_cdp(&msg, vp).expect("a CDP call");
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["type"], "mousePressed");
        assert_eq!(params["x"], json!(400.0), "clamped to the live viewport");
        assert_eq!(params["y"], json!(0.0), "negative clamps to the top edge");
        assert_eq!(params["button"], "left");
        assert_eq!(params["clickCount"], json!(1), "a press must count as a click");
    }

    #[test]
    fn a_hover_carries_no_button_and_no_click_count() {
        let msg = parse(r#"{"type":"mouse","kind":"move","x":10,"y":20}"#);
        let (_, params) = to_cdp(&msg, Viewport::default()).unwrap();
        assert_eq!(params["type"], "mouseMoved");
        assert_eq!(params["button"], "none");
        assert_eq!(params["clickCount"], json!(0));
    }

    #[test]
    fn non_finite_coordinates_never_reach_cdp() {
        // `NaN`/`Infinity` are not JSON literals, but a client can produce them
        // as an overflowing float; the clamp is the guard either way.
        let vp = Viewport { width: 100.0, height: 100.0 };
        assert_eq!(vp.clamp(f64::NAN, f64::INFINITY), (0.0, 0.0));
        assert_eq!(vp.clamp(-1.0, 1e300), (0.0, 100.0));
    }

    #[test]
    fn a_text_key_is_keydown_and_a_bare_key_is_rawkeydown() {
        let typed = parse(r#"{"type":"key","kind":"down","key":"a","code":"KeyA","key_code":65,"text":"a"}"#);
        let (_, params) = to_cdp(&typed, Viewport::default()).unwrap();
        assert_eq!(params["type"], "keyDown");
        assert_eq!(params["text"], "a");
        assert_eq!(params["code"], "KeyA");

        let bare = parse(r#"{"type":"key","kind":"down","key":"ArrowLeft","code":"ArrowLeft","key_code":37}"#);
        let (_, params) = to_cdp(&bare, Viewport::default()).unwrap();
        assert_eq!(params["type"], "rawKeyDown");
        assert!(params.get("text").is_none());

        let up = parse(r#"{"type":"key","kind":"up","key":"a","code":"KeyA","key_code":65,"text":"a"}"#);
        let (_, params) = to_cdp(&up, Viewport::default()).unwrap();
        assert_eq!(params["type"], "keyUp");
    }

    #[test]
    fn touch_end_sends_an_empty_point_list() {
        let start = parse(r#"{"type":"touch","kind":"start","x":5,"y":6}"#);
        let (method, params) = to_cdp(&start, Viewport::default()).unwrap();
        assert_eq!(method, "Input.dispatchTouchEvent");
        assert_eq!(params["touchPoints"][0]["x"], json!(5.0));
        let end = parse(r#"{"type":"touch","kind":"end"}"#);
        let (_, params) = to_cdp(&end, Viewport::default()).unwrap();
        assert_eq!(params["type"], "touchEnd");
        assert_eq!(params["touchPoints"], json!([]));
    }

    #[test]
    fn oversized_text_is_clipped_on_a_char_boundary() {
        let long = "é".repeat(MAX_TEXT_BYTES); // 2 bytes each
        let msg = ClientMsg::Text { text: long };
        let (method, params) = to_cdp(&msg, Viewport::default()).unwrap();
        assert_eq!(method, "Input.insertText");
        let out = params["text"].as_str().unwrap();
        assert!(out.len() <= MAX_TEXT_BYTES);
        assert!(out.chars().all(|c| c == 'é'), "never split a code point");
    }

    #[test]
    fn control_frames_dispatch_nothing() {
        for raw in [
            r#"{"type":"hand_back"}"#,
            r#"{"type":"take_over"}"#,
            r#"{"type":"resync"}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"auth","token":"x"}"#,
        ] {
            assert!(to_cdp(&parse(raw), Viewport::default()).is_none(), "{raw}");
        }
    }

    #[test]
    fn every_dispatched_method_is_on_the_context_allowlist() {
        // The gate in `AgentContext::dispatch_input` is only as good as this
        // agreement: anything this module can emit must be allowed there.
        for raw in [
            r#"{"type":"mouse","kind":"down","x":1,"y":1}"#,
            r#"{"type":"wheel","x":1,"y":1,"dy":10}"#,
            r#"{"type":"key","kind":"down","key":"a","code":"KeyA","key_code":65,"text":"a"}"#,
            r#"{"type":"text","text":"hi"}"#,
            r#"{"type":"touch","kind":"start","x":1,"y":1}"#,
        ] {
            let (method, _) = to_cdp(&parse(raw), Viewport::default()).unwrap();
            assert!(
                AgentContext::INPUT_METHODS.contains(&method),
                "{method} is not allowlisted"
            );
        }
    }

    #[test]
    fn viewport_comes_from_the_frame_metadata() {
        let meta = json!({ "deviceWidth": 512, "deviceHeight": 384, "pageScaleFactor": 1, "offsetTop": 0 });
        let vp = Viewport::from_metadata(&meta).expect("a viewport");
        assert_eq!((vp.width, vp.height), (512.0, 384.0));
        assert!(Viewport::from_metadata(&json!({})).is_none());
        assert!(
            Viewport::from_metadata(&json!({ "deviceWidth": 0, "deviceHeight": 0 })).is_none(),
            "a zero box would make every clamp collapse to the origin"
        );
    }

    #[test]
    fn the_viewer_slot_admits_exactly_one() {
        let first = ViewerSlot::claim("solo").expect("first in");
        assert!(ViewerSlot::claim("solo").is_none(), "second must be refused");
        assert!(ViewerSlot::claim("other").is_some(), "other sessions unaffected");
        drop(first);
        assert!(ViewerSlot::claim("solo").is_some(), "slot frees on drop");
    }

    #[test]
    fn the_relay_gate_tracks_the_mode() {
        assert!(human_may_drive(DriveMode::HumanDriving));
        assert!(
            !human_may_drive(DriveMode::AgentDriving),
            "after hand_back the canvas must go read-only"
        );
    }

    #[test]
    fn server_frames_are_the_shapes_the_client_parses() {
        let auth = serde_json::to_string(&ServerMsg::AuthOk).unwrap();
        assert_eq!(auth, r#"{"type":"auth_ok"}"#, "must match the other sockets");
        let mode = serde_json::to_string(&ServerMsg::Mode { mode: DriveMode::HumanDriving }).unwrap();
        assert_eq!(mode, r#"{"type":"mode","mode":"human_driving"}"#);
        let meta = json!({ "deviceWidth": 512 });
        let frame = serde_json::to_string(&ServerMsg::Frame { data: "AAA", metadata: &meta }).unwrap();
        assert!(frame.starts_with(r#"{"type":"frame","data":"AAA""#), "{frame}");
    }
    // ── real-chrome end-to-end (phase 2's whole claim) ──────────────────────

    /// A page that is guaranteed to PRODUCE frames (a CSS animation drives the
    /// compositor; a static page emits one frame and stops — spike gotcha #1)
    /// and that can PROVE input landed (a text input + a click counter).
    fn takeover_page() -> String {
        let html = "<style>body{margin:0}\
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\
.s{position:fixed;left:0;top:200px;width:120px;height:120px;background:red;animation:spin 1s linear infinite}\
input{position:fixed;left:0;top:0;width:400px;height:60px;font-size:24px}</style>\
<input id=box><div class=s></div>\
<script>window.taps=0;document.addEventListener('mousedown',function(){window.taps++})</script>";
        format!("data:text/html,{}", html.replace(' ', "%20"))
    }

    /// REAL-CHROME phase-2 end-to-end. Ignored by default (spawns the pinned
    /// `chrome-headless-shell`); run with
    /// `cargo test -- --ignored real_chrome_takeover`.
    ///
    /// Proves the four things the takeover socket exists to do, against a live
    /// browser and with NO mocking of CDP:
    ///
    /// 1. `Page.screencastFrame` events really arrive under
    ///    [`AckPolicy::Viewer`] (frames > 0 over ~2 s) **and** carry an ack
    ///    token, which is what makes viewer-paced backpressure possible.
    /// 2. A human's forwarded `Input.*` — built by the same [`to_cdp`] the
    ///    socket uses — mutates the real DOM while `HumanDriving`.
    /// 3. The agent is REFUSED by the lock on that same page while the human
    ///    holds it, and the DOM proves nothing of the agent's landed.
    /// 4. After a hand-back the relay gate closes, and teardown leaves no
    ///    orphan chrome and no user-data-dir.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_takeover_streams_frames_and_accepts_human_input() {
        use super::super::{BrowserConfig, BrowserService};
        use std::time::Duration;

        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        let svc = BrowserService::new(BrowserConfig::default());
        let ctx = svc.context_for("takeover").await.expect("context");
        let pid = svc.chrome_pid().await.expect("a chrome pid");
        let udd = svc.user_data_dir().await.expect("a user-data-dir");
        ctx.navigate(Actor::Agent, &takeover_page())
            .await
            .expect("navigate");

        // ── 1. attach: the human grabs the wheel, frames start flowing ──────
        assert_eq!(ctx.lock().request_human_takeover(), DriveMode::AgentDriving);
        let mut frames = ctx
            .start_screencast(
                Actor::Human,
                ScreencastOptions {
                    ack: AckPolicy::Viewer,
                    ..ScreencastOptions::default()
                },
            )
            .await
            .expect("startScreencast");

        let mut count = 0usize;
        let mut viewport = Viewport::default();
        let mut acked = 0usize;
        let window = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < window {
            match tokio::time::timeout(Duration::from_millis(400), frames.recv()).await {
                Ok(Ok(f)) => {
                    count += 1;
                    assert!(!f.data.is_empty(), "a frame with no jpeg bytes");
                    if let Some(vp) = Viewport::from_metadata(&f.metadata) {
                        viewport = vp;
                    }
                    // Exactly what the relay does: ack only after "delivery".
                    let ack = f.ack.as_ref().expect("Viewer policy must hand us the ack");
                    ctx.ack_frame(ack).expect("ack");
                    acked += 1;
                }
                Ok(Err(_)) => break,
                Err(_) => break,
            }
        }
        println!("takeover: frames={count} acked={acked} viewport={viewport:?}");
        assert!(count > 0, "NO screencast frames arrived in 2s");
        assert!(
            count > 2,
            "only {count} frames — viewer-acked backpressure is stalling the stream"
        );
        assert!(viewport.width > 0.0, "no frame metadata carried a viewport");

        // ── 2. the human's input mutates the page ───────────────────────────
        for raw in [
            r#"{"type":"mouse","kind":"move","x":30,"y":30}"#,
            r#"{"type":"mouse","kind":"down","x":30,"y":30,"button":"left","buttons":1,"click_count":1}"#,
            r#"{"type":"mouse","kind":"up","x":30,"y":30,"button":"left","buttons":0,"click_count":1}"#,
            r#"{"type":"text","text":"hallo human"}"#,
        ] {
            let (method, params) = to_cdp(&parse(raw), viewport).expect("a CDP call");
            ctx.dispatch_input(Actor::Human, method, params)
                .await
                .unwrap_or_else(|e| panic!("human input {raw} refused: {e}"));
        }
        let typed = ctx
            .evaluate("document.getElementById('box').value")
            .await
            .expect("read back");
        assert_eq!(typed, json!("hallo human"), "human typing did not land");
        let taps = ctx.evaluate("window.taps").await.expect("read taps");
        assert_eq!(taps, json!(1), "the human's click did not reach the page");

        // ── 3. the agent is refused on the same page, and proves it ─────────
        let (method, params) = to_cdp(
            &parse(r#"{"type":"text","text":"AGENT"}"#),
            viewport,
        )
        .unwrap();
        let err = ctx
            .dispatch_input(Actor::Agent, method, params)
            .await
            .expect_err("the agent MUST be refused while a human drives");
        assert!(
            matches!(err, super::super::error::BrowserError::HumanDriving { .. }),
            "wrong refusal: {err:?}"
        );
        let still = ctx
            .evaluate("document.getElementById('box').value")
            .await
            .expect("read back");
        assert_eq!(still, json!("hallo human"), "the agent's input LANDED anyway");

        // ── 4. hand back: the relay gate closes, the agent is served again ──
        assert_eq!(
            ctx.lock().release_to_agent(HandOff::Explicit),
            DriveMode::HumanDriving
        );
        assert!(
            !human_may_drive(ctx.mode()),
            "after hand_back the socket must stop forwarding"
        );
        let (method, params) =
            to_cdp(&parse(r#"{"type":"text","text":"!"}"#), viewport).unwrap();
        ctx.dispatch_input(Actor::Agent, method, params)
            .await
            .expect("the agent drives again once the human let go");

        // ── teardown: no orphan chrome, no profile dir ──────────────────────
        ctx.stop_screencast(Actor::Human).await.expect("stop");
        svc.shutdown().await;
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "LEAK: chrome pid {pid} still alive");
        assert!(!udd.exists(), "LEAK: user-data-dir {udd:?} survived");
    }
}
