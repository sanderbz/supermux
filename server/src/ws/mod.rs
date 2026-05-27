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
//!   4. Replay snapshot (≤512 KB, bounded ring) as binary frames, then live fan-out.
//!   5. Slow subscriber (`broadcast` Lagged) → close 1013 (never blocks fan-out).
//!   6. Server PING every 20s; no inbound traffic for 30s → close.

pub mod protocol;
pub mod streamer;

use std::net::IpAddr;
use std::time::Duration;

use axum::extract::ws::{close_code, CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior};

use crate::sessions::teams;
use crate::sessions::tmux::Tmux;
use crate::state::AppState;

use protocol::ClientMsg;

/// Server PING cadence and the inbound-silence deadline after which we close.
const PING_EVERY: Duration = Duration::from_secs(20);
const PONG_DEADLINE: Duration = Duration::from_secs(30);
/// First-frame auth window.
const AUTH_TIMEOUT: Duration = Duration::from_secs(2);
/// Pre-seed peek for the client's initial `Resize`. The web client (since the
/// cursor-row-mismatch fix) batches `[auth, resize]` together on `ws.onopen`, so
/// the resize lands within a couple of millis on the happy path. The 150ms
/// budget covers a slow first-paint browser; an older client that never resizes
/// (or that sends input as its second frame) just times out and the seed flows
/// at tmux's current pane size — same shape as pre-fix, no regression. Cost on
/// the never-resize path: ≤150 ms added to first paint, which is rare in
/// practice (every supermux client resizes on `auth_ok`).
const PRESEED_RESIZE_PEEK: Duration = Duration::from_millis(150);

/// Application close code for "the session's tmux pty is gone" (e.g. the DB row
/// survived a reboot but the tmux session did not). This is a TERMINAL condition,
/// distinct from `close_code::ERROR` (1011 — a transient server error worth a
/// backoff retry): the client must STOP reconnecting and surface a stopped state
/// rather than hammering the endpoint. 4000-4999 is the WebSocket private range.
const CLOSE_NOT_RUNNING: u16 = 4404;

/// The WS sub-router. Merged at the top level of `http::router` (no bearer layer).
///
/// `/ws/sessions/{name}` is the read/write SESSION terminal (unchanged). The
/// Agent-Teams routes add READ-ONLY teammate PANE streaming (AT-E §3.5): a
/// teammate is a tmux split-window pane, not a `sessions` row, so it gets an
/// ephemeral virtual stream and (for this slice) no client→pane input.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/ws/sessions/{name}", get(handle_ws))
        // Resolve `%id` from `~/.claude/teams/{team}/config.json` members[] and
        // validate it against the lead's window before streaming (AT-E). The
        // frontend opens this; an optional `?pane_id=%id` query lets a caller that
        // already has the id (e.g. from the team SSE model) skip config parsing —
        // validation still runs either way.
        .route("/ws/teams/{team}/{member}", get(handle_team_ws))
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

/// Optional query for the teammate-pane WS: `?pane_id=%17`. When present (and
/// non-empty) the handler skips reading `tmuxPaneId` out of `config.json` and uses
/// this id — but STILL validates it against the lead's window (the lead name comes
/// from config either way). Lets AT-F2 pass an id it already has from the team SSE.
#[derive(Debug, serde::Deserialize, Default)]
struct PaneQuery {
    #[serde(default)]
    pane_id: Option<String>,
}

/// Upgrade handler for a teammate PANE stream (Agent Teams §3.5, AT-E). Resolves
/// `(team, member)` → a live `%id` (re-read from config + validated against the
/// lead's window) and opens a READ-ONLY live terminal of that pane. Read-only is
/// acceptable for this slice; write/steer can come later.
async fn handle_team_ws(
    ws: WebSocketUpgrade,
    Path((team, member)): Path<(String, String)>,
    Query(q): Query<PaneQuery>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let origin_ok = origin_allowed(&state, &headers);
    ws.on_upgrade(move |socket| {
        handle_team_socket(socket, team, member, q.pane_id, state, origin_ok)
    })
}

/// Read-only teammate-pane socket task. Mirrors [`handle_socket`]'s handshake
/// (origin → first-frame auth → liveness → subscribe → replay → fan-out/ping) but
/// (1) resolves+validates the pane id instead of taking a session name, and
/// (2) DROPS all client input (no `input_drain_loop`) — a teammate stream is
/// view-only for this slice. Inbound frames only refresh the liveness timer.
async fn handle_team_socket(
    mut socket: WebSocket,
    team: String,
    member: String,
    pane_override: Option<String>,
    state: AppState,
    origin_ok: bool,
) {
    if !origin_ok {
        close(&mut socket, close_code::POLICY, "origin not allowed").await;
        return;
    }

    // 1. First-frame auth — identical contract to the session terminal.
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

    // 2. Resolve + VALIDATE the pane (re-read config fresh; refuse a stale id).
    //    A resolution failure (no team / no pane / stale id) is the teammate
    //    analogue of "session not running" → terminal 4404 so the client stops
    //    hammering rather than backing off forever.
    let resolved = match teams::resolve_member_pane(&team, &member, pane_override.as_deref()).await {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(team = %team, member = %member, error = %e, "ws team: pane unresolved");
            close(&mut socket, CLOSE_NOT_RUNNING, "teammate pane not available").await;
            return;
        }
    };
    let stream_key = resolved.stream_key(&member);

    // 3. Ensure the per-pane reader is running + enforce the subscriber cap. The
    //    stream is keyed by `{lead}/{member}` with its own FIFO/log, so it never
    //    clobbers the lead's session stream.
    let stream = match state.pty_for_pane(&stream_key, &resolved.pane_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(team = %team, member = %member, error = %e, "team pty stream unavailable");
            close(&mut socket, close_code::ERROR, "stream unavailable").await;
            return;
        }
    };
    if stream.subscriber_count() >= state.config.ws.subscribers_per_session {
        close(&mut socket, close_code::AGAIN, "subscriber limit").await;
        return;
    }

    // 4. Subscribe FIRST so the broadcast receiver starts queueing live bytes,
    //    THEN read the full authoritative scrollback from tmux and send it as
    //    the seed. The fresh capture-pane covers the same ground as the in-memory
    //    replay buffer PLUS the rest of tmux's history-limit that the bounded
    //    ring would have evicted on a long-running pane — and tmux owns the
    //    persistent state, so a fresh tab after a web-app restart sees the same
    //    history the multiplexer is still holding. The in-memory replay ring is
    //    discarded for the WS path (still maintained by pty.rs for tail/preview).
    let (_replay, mut rx) = stream.subscribe();
    let tmux = Tmux::for_pane(&resolved.lead_session, &resolved.pane_id);
    if !send_seed_then_done(&mut socket, &tmux).await {
        return;
    }

    // 5. Read-only fan-out + ping loop. No input task: inbound frames are
    //    ignored except to refresh the liveness timer (and Close ends the loop).
    let mut last_inbound = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Skip);
    ping.tick().await;

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // Any other inbound frame (incl. a stray Input) just refreshes
                    // the liveness timer — read-only means we never apply it.
                    Some(Ok(_)) => { last_inbound = Instant::now(); }
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

    // 2a. Agent Teams routing fix — if THIS session is hosting a team, pin the
    //     whole WS path (live stream + seed + send-keys + resize) to the LEAD's
    //     specific tmux pane id. Without this, every session-target tmux op
    //     resolves to whichever pane tmux thinks is "active", which Claude
    //     `split-window`s a teammate to be by default — so the user typing into
    //     `/focus/<lead>` would see the teammate's screen and their keystrokes
    //     would land in the teammate's pty (see [`teams::resolve_lead_pane`]).
    //     `None` for a non-team session preserves the historical session-target
    //     byte-for-byte (zero regression for single-pane sessions).
    let lead_pane_id: Option<String> = teams::resolve_lead_pane(&name).await;

    // 3. Ensure the per-session reader is running and enforce the subscriber cap.
    //    When `lead_pane_id` is `Some`, build the stream PINNED to that pane id
    //    (replacing any cached stream still on the legacy session-target — see
    //    `for_lead_session`); otherwise the historical per-session stream is
    //    used unchanged.
    let stream = match lead_pane_id.as_deref() {
        Some(lp) => state.pty_for_lead(&name, lp).await,
        None => state.pty_for(&name).await,
    };
    let stream = match stream {
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

    // 4. Subscribe FIRST so the broadcast receiver starts queueing live bytes,
    //    THEN read the full authoritative scrollback from tmux and send it as
    //    the seed. tmux owns the persistent pane state (history-limit = 50000
    //    lines), so a fresh browser tab — or one that comes back after the web
    //    app restarted — sees the same scrollback the multiplexer is holding,
    //    not just the in-memory replay ring's last 512 KB (which evicts on a
    //    busy session). See [`send_seed_then_done`] for the ANSI-coherence
    //    rationale and the replay_done boundary contract.
    //
    //    Build `tmux` against the LEAD pane if one was resolved above (so seed
    //    captures the lead's content, not whichever pane tmux thinks is active)
    //    — same byte-for-byte behaviour as today for non-team sessions.
    let (_replay, mut rx) = stream.subscribe();
    let tmux = match lead_pane_id.as_deref() {
        Some(lp) => Tmux::for_pane(&name, lp.to_string()),
        None => Tmux::new(&name),
    };

    // 4a. Cursor-row-mismatch fix (Option A — server-side belt). Before the
    //    seed capture, peek up to one inbound frame within PRESEED_RESIZE_PEEK.
    //    If it's a Resize, apply it FIRST so the capture-pane visible covers
    //    the CLIENT'S geometry; otherwise hold it and re-queue after the input
    //    task exists (strict in-order delivery — never dropped). The companion
    //    client change batches `[auth, resize]` together so this peek almost
    //    always finds the resize within an RTT.
    let held_first_frame = match peek_initial_resize(&mut socket, &state, &name, &tmux).await {
        Ok(h) => h,
        Err(_) => return,
    };

    if !send_seed_then_done(&mut socket, &tmux).await {
        return;
    }

    // 5. Per-session input task (typing-latency win #1 + #2). The recv branch
    //    below must NEVER `.await` a `tmux send-keys` fork inline — that
    //    head-of-line-blocks the OUTBOUND echo branch of the same `select!`. So
    //    parsed `ClientMsg`s are handed to a dedicated drain task over an mpsc
    //    queue: the recv branch does a non-blocking `send` and immediately loops
    //    back to service the echo. The drain task applies messages in ARRIVAL
    //    ORDER under the per-session lock (preserving §5.2 ordering) and coalesces
    //    runs of `Input` into ONE `send-keys` (N forks → 1 during fast typing /
    //    key-repeat / paste bursts). The channel is unbounded: input frames are
    //    tiny and already rate-limited by the human at the keyboard; an unbounded
    //    queue means we never drop a keystroke under a momentary fork stall.
    //
    //    Pass the resolved `lead_pane_id` through so `apply_one` targets the
    //    lead pane explicitly — without it, send-keys would silently hit the
    //    active pane (typically a teammate post-split). The drain task
    //    inherits the routing for as long as this WS is open; a later WS
    //    attach re-resolves via the same `resolve_lead_pane` (pane ids can
    //    churn across team config writes).
    let (input_tx, input_rx) = mpsc::unbounded_channel::<ClientMsg>();
    let input_task = tokio::spawn(input_drain_loop(
        state.clone(),
        name.clone(),
        lead_pane_id.clone(),
        input_rx,
    ));

    // If `peek_initial_resize` held a non-resize first frame (rare — a stray
    // Input typed before WS open, a client Ping, an auth-after-auth), enqueue
    // it on the input task NOW so strict arrival order is preserved (it came
    // BEFORE any frame the loop below will read). An unbounded mpsc never
    // blocks; a send failure means the task already exited (teardown), in
    // which case the loop below will exit on its own.
    if let Some(held) = held_first_frame {
        let _ = input_tx.send(held);
    }

    // 6. Unified fan-out + client-read + ping loop (single task, no split — uses
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
                                    // Non-blocking hand-off; the drain task applies
                                    // it in order. A closed channel only happens if
                                    // the drain task has exited (teardown) — then we
                                    // break and tear down too.
                                    if input_tx.send(cmd).is_err() {
                                        break;
                                    }
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

    // Teardown: dropping the sender signals the drain task to finish applying any
    // already-queued input (so a final "type then close" doesn't lose the text)
    // and then exit cleanly. We await it so the per-session lock is released and
    // no orphan task lingers past the socket.
    drop(input_tx);
    let _ = input_task.await;
}

/// One unit of work the drain task applies to tmux, in order. `Text` is a
/// coalesced run of one-or-more `Input` frames joined into a single literal send;
/// `Ctrl` is a single non-`Input` control frame (a named `Key`, a `Resize`, or a
/// no-op) that acts as a coalescing BOUNDARY.
enum Apply {
    /// A coalesced literal-text batch (≥1 `Input` frames joined). Never empty.
    Text(String),
    /// A single non-`Input` control frame that breaks the batch.
    Ctrl(ClientMsg),
}

/// Defense-in-depth "Option A" for the cursor-row-mismatch bug: peek ONE
/// inbound frame within [`PRESEED_RESIZE_PEEK`] BEFORE building the seed. If
/// it's a `Resize`, apply it to tmux so the seed's `capture-pane visible`
/// covers the CLIENT'S geometry (not tmux's default 80×24, which would land
/// fewer rows than xterm's grid and put the CUP at a row that maps to blank
/// space below the captured content). If it's any other frame (a stray Input,
/// a client Ping, etc.) we **hold** it and return it to the caller, which
/// re-queues it onto the input mpsc the moment that channel exists — strict
/// arrival-order delivery is preserved (no dropped keystrokes).
///
/// Paired with the client's `[auth, resize]` batched send (Option B in
/// `web/src/hooks/use-live-term.ts`); together they make the happy path
/// "resize-then-seed" instead of "seed-with-stale-geometry-then-resize".
///
/// Returns `Ok(held)`:
/// - `Ok(None)` — peek timed out OR the peeked frame was a `Resize` we already
///   applied. Caller proceeds to seed at the (possibly resized) geometry.
/// - `Ok(Some(msg))` — a non-resize frame arrived; hold it so the caller can
///   enqueue it on the input task once that task's channel exists.
/// - `Err(())` — the socket errored / closed mid-peek; caller should return
///   (the connection is already done).
///
/// Cost on the "no client ever resizes" path: ≤150 ms wall-clock added to
/// first paint. Cost on the typical path (client sends auth+resize together):
/// ≈ one network RTT (microseconds on a LAN).
async fn peek_initial_resize(
    socket: &mut WebSocket,
    state: &AppState,
    name: &str,
    tmux: &Tmux<'_>,
) -> Result<Option<ClientMsg>, ()> {
    let inbound = match tokio::time::timeout(PRESEED_RESIZE_PEEK, socket.recv()).await {
        // Peek window expired. Common when the client never sends a resize
        // (legacy/test client) or hasn't finished its first paint yet.
        Err(_) => return Ok(None),
        // Socket closed cleanly or errored: tear down.
        Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return Err(()),
        Ok(Some(Ok(msg))) => msg,
    };
    let text = match inbound {
        Message::Text(t) => t,
        // Ping is auto-ponged by the transport; Binary/Pong on the client→server
        // direction aren't part of the wire protocol. Treat as "no resize seen"
        // — don't hold (nothing to apply), don't drop a real input.
        _ => return Ok(None),
    };
    let cmd = match serde_json::from_str::<ClientMsg>(text.as_str()) {
        Ok(c) => c,
        // Malformed JSON: same as "no resize". Don't hold; the client will
        // either keep talking or we'll close on inbound-silence.
        Err(_) => return Ok(None),
    };
    match cmd {
        ClientMsg::Resize { cols, rows } => {
            // Apply the resize INLINE under the per-session lock — matches the
            // contract `apply_one` follows on the live input path (§5.2). No
            // input drain task exists yet, so taking the lock here cannot
            // deadlock against it. A failure is logged and ignored so the
            // attach still proceeds (the seed degrades to tmux's current size
            // — same as the no-peek world).
            let lock = state.lock_for(name);
            let _guard = lock.lock().await;
            if let Err(e) = tmux.resize(cols, rows).await {
                tracing::debug!(session = %name, error = %e, "pre-seed resize failed");
            }
            Ok(None)
        }
        // Any other first-frame-after-auth (Input typed before WS open, a
        // client Ping, etc.) is held; the caller queues it onto the input
        // task's mpsc the moment that channel exists. Strict in-order
        // delivery: nothing was applied between auth and this frame, and the
        // queue is drained in arrival order under the per-session lock.
        other => Ok(Some(other)),
    }
}

/// Build the attach seed from tmux's authoritative pane state — full primary
/// scrollback AND the current visible screen, properly framed so xterm.js's
/// two-buffer model lines up with tmux's. Send as one Binary frame, then the
/// `replay_done` Text boundary the client uses to reveal its viewport. Returns
/// false on a socket-send failure (the caller should return).
///
/// **Why this is alt-screen-aware (the bug history)** — an earlier revision
/// dumped `capture-pane -p -e -S - -E -` as one flat stream prefixed with
/// `\x1b[2J\x1b[3J\x1b[H`. That works for shell sessions (no alt buffer in
/// play) but corrupts a TUI session (Claude Code's alt-screen mode): tmux's
/// capture-pane DOES NOT emit the `\x1b[?1049h` enter-alt-screen marker
/// between primary scrollback and the alt-screen visible portion, so xterm
/// landed the captured cells in whichever buffer was currently active and
/// the cursor sat at the end of the captured block rather than at Claude's
/// TUI prompt. Symptoms: splash banner stacked 2–3× (past Claude relaunches
/// in primary scrollback) and typed echo painting on the wrong row.
///
/// [`Tmux::capture_history_with_alt_screen_aware_visible`] models the two
/// buffers explicitly: in primary mode it returns the flat capture (correct
/// without alt-screen escapes); in alt-screen mode it splits the capture
/// into history (PRIMARY scrollback) + `\x1b[?1049h\x1b[2J\x1b[H` (enter
/// ALT, clear, home) + visible (ALT buffer) + `\x1b[<row>;<col>H` (restore
/// cursor where tmux says). Writing that onto a fresh `term.reset()`
/// reproduces tmux's state — both buffers populated, cursor where Claude
/// expects it, and the user can scroll up natively to see history.
///
/// **CALL AFTER `stream.subscribe()`** so the broadcast receiver is already
/// queueing live bytes — that way the snapshot covers tmux up to ~now and the
/// queued bytes drain in order BEHIND it. A byte that lands in both (captured
/// AND broadcast) repaints harmlessly: the snapshot is a complete ANSI state
/// and the live drain appends whole chunks, so no escape sequence is torn
/// across the seed boundary.
///
/// A capture failure (rare — tmux command contention) degrades to no seed:
/// the client still attaches and sees live output from this point. The
/// `replay_done` boundary is ALWAYS sent so the client's "hide viewport until
/// the snapshot lands, then jump to bottom + reveal in one paint" gate is
/// released even when nothing seeded.
async fn send_seed_then_done(socket: &mut WebSocket, tmux: &Tmux<'_>) -> bool {
    if let Ok(body) = tmux.capture_history_with_alt_screen_aware_visible().await {
        if !body.is_empty()
            && socket
                .send(Message::Binary(Bytes::from(body)))
                .await
                .is_err()
        {
            return false;
        }
    }
    socket
        .send(Message::Text(Utf8Bytes::from_static(
            r#"{"type":"replay_done"}"#,
        )))
        .await
        .is_ok()
}

/// Pure coalescing planner (typing-latency win #2) — single source of the
/// ordering+batching contract, exercised directly by the unit tests. Folds a
/// drained run of arrival-ordered `ClientMsg`s into the minimal sequence of
/// [`Apply`] ops: CONTIGUOUS `Input` frames join into ONE `Text` (N forks → 1),
/// and every non-`Input` frame is emitted as its own `Ctrl` boundary that flushes
/// any pending `Text` BEFORE it. The output order matches the input order
/// exactly, so strict in-order delivery is preserved (type "abc"→"abc"; an Enter
/// after text submits after the text; a multi-line paste stays contiguous).
fn plan_applies(msgs: impl IntoIterator<Item = ClientMsg>) -> Vec<Apply> {
    let mut plan: Vec<Apply> = Vec::new();
    let mut pending = String::new();
    for msg in msgs {
        match msg {
            ClientMsg::Input { data } => pending.push_str(&data),
            other => {
                if !pending.is_empty() {
                    plan.push(Apply::Text(std::mem::take(&mut pending)));
                }
                plan.push(Apply::Ctrl(other));
            }
        }
    }
    if !pending.is_empty() {
        plan.push(Apply::Text(pending));
    }
    plan
}

/// Per-session input drain (typing-latency win #1 + #2). Owns the mpsc receiver;
/// applies messages in arrival order under the per-session lock, COALESCING runs
/// of `Input` into a single `send-keys` so fast typing / key-repeat / paste
/// bursts cost one fork instead of N. Coalescing NEVER crosses a non-`Input`
/// boundary (a named `Key`, a `Resize`, etc.): the buffered `Input` batch is
/// flushed first, THEN that message is applied — strict in-order delivery is
/// preserved (type "abc"→"abc"; an Enter after text submits after the text).
/// Exits when the channel closes (socket teardown), after draining what's left.
///
/// `lead_pane_id` is the Agent Teams routing pin (see [`handle_socket`]):
/// `Some(%id)` when the session is hosting a team — every tmux op in `apply_one`
/// targets that pane explicitly so keystrokes can't be silently misrouted to
/// the active pane (typically a teammate post-split). `None` for a non-team
/// session keeps the historical session-target behaviour byte-for-byte.
async fn input_drain_loop(
    state: AppState,
    name: String,
    lead_pane_id: Option<String>,
    mut rx: mpsc::UnboundedReceiver<ClientMsg>,
) {
    // Reused across wakeups to avoid a per-burst allocation.
    let mut run: Vec<ClientMsg> = Vec::new();
    while let Some(first) = rx.recv().await {
        // Greedily drain every frame already queued so a fast burst is coalesced
        // in one planning pass (non-blocking `try_recv` until the queue empties).
        run.clear();
        run.push(first);
        while let Ok(next) = rx.try_recv() {
            run.push(next);
        }
        for op in plan_applies(run.drain(..)) {
            apply_one(&state, &name, lead_pane_id.as_deref(), op).await;
        }
    }
}

/// Apply a single planned op to tmux under the per-session lock (§5.2 keystroke
/// path "acquire session lock"). A coalesced `Text` batch routes through the
/// existing [`Tmux::send_text`] (which keeps the ≤[`PASTE_THRESHOLD`] literal
/// `send-keys` path and the paste-buffer fallback for large merges); a `Ctrl`
/// boundary applies the named key / resize / no-op as before.
///
/// When `lead_pane_id` is `Some` (the session is hosting an Agent Team), the
/// tmux handle is built with `Tmux::for_pane` so send-keys/resize hit the
/// LEAD's pane explicitly. Without this pin tmux resolves `-t supermux-<name>`
/// to the active pane (= a teammate after Claude splits) and silently steals
/// the keystrokes — the multi-bug fix this whole code path is paired with.
///
/// `Resize` of a teammate-aware lead uses `resize-window` regardless (see
/// `Tmux::resize`): resize-window with a pane target tells tmux "resize the
/// window CONTAINING this pane", which is exactly the same effect (and same
/// teammate reflow) the legacy session-target had. Pane-scoped resize is NOT
/// what we want here — the user is resizing their xterm to the WINDOW, which
/// is what tmux already maps to via `resize-window`; using `resize-pane`
/// instead would only stretch the lead inside the existing window and leave
/// the user without their full viewport.
///
/// [`PASTE_THRESHOLD`]: crate::sessions::tmux::PASTE_THRESHOLD
async fn apply_one(state: &AppState, name: &str, lead_pane_id: Option<&str>, op: Apply) {
    let tmux = match lead_pane_id {
        Some(lp) => Tmux::for_pane(name, lp.to_string()),
        None => Tmux::new(name),
    };
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    let res = match op {
        Apply::Text(text) => tmux.send_text(&text).await,
        Apply::Ctrl(ClientMsg::Input { data }) => tmux.send_text(&data).await,
        Apply::Ctrl(ClientMsg::Key { data }) => tmux.send_key(&data).await,
        Apply::Ctrl(ClientMsg::Resize { cols, rows }) => tmux.resize(cols, rows).await,
        // Auth-after-auth and client Ping are no-ops on the input path.
        Apply::Ctrl(ClientMsg::Auth { .. } | ClientMsg::Ping) => Ok(()),
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

#[cfg(test)]
mod coalesce_tests {
    //! Typing-latency win #2: the [`plan_applies`] coalescing contract. Pins that
    //! contiguous `Input` runs join into ONE send (N forks → 1) while strict
    //! arrival order is preserved across every non-`Input` boundary.

    use super::*;

    fn input(s: &str) -> ClientMsg {
        ClientMsg::Input { data: s.to_string() }
    }
    fn key(s: &str) -> ClientMsg {
        ClientMsg::Key { data: s.to_string() }
    }

    /// Render a plan into a compact, assertable trace: a `Text` batch becomes
    /// `"=<joined>"`, a `Ctrl` becomes `"K:<key>"` / `"R:<c>x<r>"` / `"X"`.
    fn trace(plan: &[Apply]) -> Vec<String> {
        plan.iter()
            .map(|op| match op {
                Apply::Text(t) => format!("={t}"),
                Apply::Ctrl(ClientMsg::Key { data }) => format!("K:{data}"),
                Apply::Ctrl(ClientMsg::Resize { cols, rows }) => format!("R:{cols}x{rows}"),
                Apply::Ctrl(_) => "X".to_string(),
            })
            .collect()
    }

    #[test]
    fn contiguous_inputs_coalesce_into_one_send() {
        // Fast typing "a","b","c" arriving together → a single joined send (one
        // fork), bytes in order → "abc".
        let plan = plan_applies([input("a"), input("b"), input("c")]);
        assert_eq!(trace(&plan), vec!["=abc"]);
    }

    #[test]
    fn enter_after_text_submits_after_the_text() {
        // The named Enter must NOT merge into the text batch, and must come AFTER
        // it — typing then submit preserves order.
        let plan = plan_applies([input("ls"), input(" -la"), key("Enter")]);
        assert_eq!(trace(&plan), vec!["=ls -la", "K:Enter"]);
    }

    #[test]
    fn interleaved_named_keys_split_batches_preserving_order() {
        // text → Esc → text → Enter: two separate text batches, the named keys at
        // their exact positions; nothing reordered, nothing merged across a Key.
        let plan = plan_applies([
            input("vi"),
            key("Escape"),
            input(":wq"),
            key("Enter"),
        ]);
        assert_eq!(trace(&plan), vec!["=vi", "K:Escape", "=:wq", "K:Enter"]);
    }

    #[test]
    fn multiline_paste_run_stays_one_contiguous_batch() {
        // A multi-line paste split into several Input frames coalesces into ONE
        // send with the newlines intact and in order (no reordering across lines).
        let plan = plan_applies([
            input("line1\n"),
            input("line2\n"),
            input("line3"),
        ]);
        assert_eq!(trace(&plan), vec!["=line1\nline2\nline3"]);
    }

    #[test]
    fn resize_is_a_boundary_too() {
        // A Resize breaks the batch just like a Key and stays at its position.
        let plan = plan_applies([
            input("ab"),
            ClientMsg::Resize { cols: 80, rows: 24 },
            input("cd"),
        ]);
        assert_eq!(trace(&plan), vec!["=ab", "R:80x24", "=cd"]);
    }

    #[test]
    fn empty_run_plans_nothing() {
        assert!(plan_applies([]).is_empty());
    }

    #[test]
    fn key_only_run_has_no_empty_text_batch() {
        // A lone Enter produces just the Ctrl op — no spurious empty Text send.
        let plan = plan_applies([key("Enter")]);
        assert_eq!(trace(&plan), vec!["K:Enter"]);
    }
}
