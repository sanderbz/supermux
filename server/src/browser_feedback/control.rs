//! Session-scoped relay to an explicitly enabled Chrome extension tab.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::response::Response;
use axum::{routing::get, Router};
use futures_util::SinkExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::{db::browser_feedback as store, error::AppError, state::AppState};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_STEPS: usize = 32;
const MAX_TIMEOUT: u64 = 30_000;

#[derive(Default)]
pub struct ControlBridge {
    peers: Mutex<HashMap<String, Arc<Peer>>>,
    cancelled: Mutex<HashMap<(String, String, String), tokio::time::Instant>>,
}
struct Peer {
    binding: store::Binding,
    target: String,
    lease_id: String,
    url: String,
    title: String,
    tx: mpsc::Sender<Value>,
    pending: Mutex<Option<Pending>>,
}
struct Pending {
    id: String,
    total: usize,
    completed: usize,
    reply: oneshot::Sender<Value>,
}

fn interrupted(id: &str, completed: usize, code: &str) -> Value {
    json!({"id":id,"ok":false,"completed":completed,"results":[],"outcome_unknown":true,
        "error":{"code":code,"message":"Control ended before the batch outcome was confirmed. Inspect the page before trying again."}})
}
impl Peer {
    fn stop(&self, reason: &str) {
        let _ = self.tx.try_send(json!({"type":"stop","reason":reason}));
        if let Some(p) = self.pending.lock().unwrap().take() {
            let _ = p.reply.send(interrupted(&p.id, p.completed, reason));
        }
    }
}
impl ControlBridge {
    pub fn connected(&self, binding: &str) -> bool {
        self.peers.lock().unwrap().contains_key(binding)
    }
    pub fn revoke(&self, binding: &str) {
        if let Some(peer) = self.peers.lock().unwrap().remove(binding) {
            peer.stop("revoked");
        }
    }
    fn register(&self, peer: Arc<Peer>) {
        if let Some(old) = self
            .peers
            .lock()
            .unwrap()
            .insert(peer.binding.id.clone(), peer)
        {
            old.stop("replaced");
        }
    }
    fn detach(&self, peer: &Peer) {
        let mut peers = self.peers.lock().unwrap();
        if peers
            .get(&peer.binding.id)
            .is_some_and(|p| p.target == peer.target)
        {
            peers.remove(&peer.binding.id);
        }
        drop(peers);
        peer.stop("disconnected");
    }
    fn for_session(&self, session: &str) -> Vec<Arc<Peer>> {
        self.peers
            .lock()
            .unwrap()
            .values()
            .filter(|p| p.binding.session == session)
            .cloned()
            .collect()
    }
}

async fn current(state: &AppState, peer: &Peer) -> Result<bool, AppError> {
    let Some(binding) = store::binding(&state.pool, &peer.binding.id).await? else {
        return Ok(false);
    };
    Ok(binding.token_hash == peer.binding.token_hash
        && binding.origin == peer.binding.origin
        && binding.session == peer.binding.session
        && super::binding_is_current(state, &binding).await?
        && state
            .browser_control
            .peers
            .lock()
            .unwrap()
            .get(&binding.id)
            .is_some_and(|p| p.target == peer.target))
}

pub async fn list(state: &AppState, session: &str) -> Result<Value, AppError> {
    let mut targets = Vec::new();
    for peer in state.browser_control.for_session(session) {
        if current(state, &peer).await? {
            targets.push(
                json!({"target":peer.target,"binding_id":peer.binding.id,"lease_id":peer.lease_id,
                "origin":peer.binding.origin,"url":peer.url,"title":peer.title}),
            );
        }
    }
    targets.sort_by(|a, b| a["target"].as_str().cmp(&b["target"].as_str()));
    Ok(
        json!({"targets":targets,"command":"supermux-browser --json '{\"target\":\"…\",\"steps\":[{\"action\":\"snapshot\"}]}'"}),
    )
}

pub async fn has_binding(state: &AppState, session: &str) -> bool {
    for binding in store::bindings(&state.pool, session)
        .await
        .unwrap_or_default()
    {
        if super::binding_is_current(state, &binding)
            .await
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

pub async fn with_hint(state: &AppState, session: &str, text: &str) -> String {
    if text.trim_start().starts_with('/') {
        return text.to_string();
    }
    for peer in state.browser_control.for_session(session) {
        if current(state, &peer).await.unwrap_or(false) {
            return format!("{text}\n\nBrowser control: supermux-browser list.");
        }
    }
    text.to_string()
}

fn validate_steps(args: &Value, origin: &str) -> Result<(Vec<Value>, u64), AppError> {
    let bad = || {
        AppError::BadRequest(
            "browser actions require 1–32 bounded steps and a timeout of 1–30000 ms".into(),
        )
    };
    let steps = args["steps"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= MAX_STEPS)
        .ok_or_else(bad)?;
    let timeout = match args.get("timeout_ms") {
        Some(v) => v.as_u64().ok_or_else(bad)?,
        None => MAX_TIMEOUT,
    };
    if timeout == 0
        || timeout > MAX_TIMEOUT
        || serde_json::to_vec(steps).map_err(|_| bad())?.len() > 128 * 1024
    {
        return Err(bad());
    }
    for step in steps {
        let action = step["action"].as_str().ok_or_else(bad)?;
        if !matches!(
            action,
            "snapshot"
                | "click"
                | "type"
                | "fill"
                | "key"
                | "scroll"
                | "navigate"
                | "back"
                | "reload"
                | "wait"
                | "evaluate"
                | "screenshot"
                | "dialog"
        ) {
            return Err(bad());
        }
        if action == "navigate"
            && super::payload::origin(step["url"].as_str().ok_or_else(bad)?)? != origin
        {
            return Err(AppError::Forbidden(
                "navigation must remain on the paired website origin".into(),
            ));
        }
        for key in ["text", "expression", "prompt_text"] {
            if step
                .get(key)
                .is_some_and(|v| v.as_str().is_none_or(|s| s.len() > 16 * 1024))
            {
                return Err(bad());
            }
        }
    }
    Ok((steps.clone(), timeout))
}

/// Cancellation also runs when the HTTP caller drops its future.
struct Inflight {
    peer: Arc<Peer>,
    id: String,
}
impl Drop for Inflight {
    fn drop(&mut self) {
        let mut pending = self.peer.pending.lock().unwrap();
        if pending.as_ref().is_some_and(|p| p.id == self.id) {
            pending.take();
            let _ = self.peer.tx.try_send(json!({"type":"cancel","id":self.id}));
        }
    }
}
fn request_id(args: &Value) -> Result<String, AppError> {
    match args.get("request_id") {
        None => Ok(super::id("bc")),
        Some(value) => value
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 100
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .map(str::to_owned)
            .ok_or_else(|| AppError::BadRequest("invalid browser request_id".into())),
    }
}

/// The caller's target and request id identify one batch, including a cancelled
/// request whose worker has not reached dispatch yet.
pub async fn cancel_actions(
    state: &AppState,
    session: &str,
    args: &Value,
) -> Result<Value, AppError> {
    let target = args["target"]
        .as_str()
        .ok_or_else(|| AppError::BadRequest("browser target is required".into()))?;
    if args.get("request_id").is_none() {
        return Err(AppError::BadRequest(
            "browser request_id is required".into(),
        ));
    }
    let id = request_id(args)?;
    let peer = state
        .browser_control
        .for_session(session)
        .into_iter()
        .find(|p| p.target == target)
        .ok_or_else(|| {
            AppError::Conflict("browser control target is no longer connected".into())
        })?;
    let lock = state.lock_for(session);
    let _guard = lock.lock().await;
    if !current(state, &peer).await? {
        return Err(AppError::Forbidden(
            "browser pairing is no longer authorized".into(),
        ));
    }
    {
        let mut cancelled = state.browser_control.cancelled.lock().unwrap();
        cancelled.retain(|_, at| at.elapsed() < Duration::from_secs(60));
        let key = (session.to_owned(), target.to_owned(), id.clone());
        if !cancelled.contains_key(&key) && cancelled.len() >= 256 {
            if !peer
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|p| p.id == id)
            {
                return Err(AppError::Conflict(
                    "browser cancellation queue is full; stop control in the browser".into(),
                ));
            }
        } else {
            cancelled.insert(key, tokio::time::Instant::now());
        }
    }
    let cancelled = {
        let mut pending = peer.pending.lock().unwrap();
        if pending.as_ref().is_some_and(|p| p.id == id) {
            pending.take()
        } else {
            None
        }
    };
    if let Some(p) = cancelled {
        let _ = peer.tx.try_send(json!({"type":"cancel","id":id}));
        let _ = p.reply.send(interrupted(&id, p.completed, "cancelled"));
        // An action may already be awaiting CDP. End this activation rather
        // than let a subsequent batch overlap its uncertain completion.
        state.browser_control.detach(&peer);
    }
    Ok(json!({"cancelled":true,"request_id":id}))
}

pub async fn actions(state: &AppState, session: &str, args: &Value) -> Result<Value, AppError> {
    let target = args["target"]
        .as_str()
        .ok_or_else(|| AppError::BadRequest("use a target from browser_connected_tabs".into()))?;
    let peer = state
        .browser_control
        .for_session(session)
        .into_iter()
        .find(|p| p.target == target)
        .ok_or_else(|| {
            AppError::Conflict(
                "browser control target is no longer connected; list connected tabs again".into(),
            )
        })?;
    let (steps, timeout) = validate_steps(args, &peer.binding.origin)?;
    let lock = state.lock_for(session);
    let guard = lock.lock().await;
    if !current(state, &peer).await? {
        return Err(AppError::Forbidden(
            "browser pairing is no longer authorized".into(),
        ));
    }
    let id = request_id(args)?;
    {
        let mut cancelled = state.browser_control.cancelled.lock().unwrap();
        cancelled.retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if cancelled.contains_key(&(session.to_owned(), target.to_owned(), id.clone())) {
            let mut result = interrupted(&id, 0, "cancelled");
            result["outcome_unknown"] = json!(false);
            return Ok(result);
        }
    }
    let (reply, rx) = oneshot::channel();
    {
        let mut pending = peer.pending.lock().unwrap();
        if pending.is_some() {
            return Err(AppError::Conflict(
                "another browser batch is still running".into(),
            ));
        }
        *pending = Some(Pending {
            id: id.clone(),
            total: steps.len(),
            completed: 0,
            reply,
        });
    }
    let _inflight = Inflight {
        peer: peer.clone(),
        id: id.clone(),
    };
    peer.tx
        .try_send(json!({"type":"command","id":id,"steps":steps,"timeout_ms":timeout}))
        .map_err(|_| AppError::Conflict("browser connection is unavailable".into()))?;
    drop(guard);
    let value = match tokio::time::timeout(Duration::from_millis(timeout + 1000), rx).await {
        Ok(Ok(value)) => value,
        _ => {
            let completed = peer
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.completed)
                .unwrap_or(0);
            interrupted(&id, completed, "timeout")
        }
    };
    if !current(state, &peer).await? {
        return Ok(interrupted(
            &id,
            value["completed"].as_u64().unwrap_or(0) as usize,
            "revoked_or_disconnected",
        ));
    }
    Ok(value)
}

#[derive(Deserialize)]
struct AuthFrame {
    #[serde(rename = "type")]
    kind: String,
    version: u32,
    token: String,
    binding_id: String,
    lease_id: String,
    origin: String,
    url: String,
    #[serde(default)]
    title: String,
}
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/browser/control/ws", get(upgrade))
        .with_state(state)
}
async fn upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let allowed = headers
        .get(header::ORIGIN)
        .is_some_and(super::extension_origin_allowed);
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| serve(socket, state, allowed))
}
async fn serve(mut socket: WebSocket, state: AppState, allowed: bool) {
    if !allowed {
        let _ = socket.close().await;
        return;
    }
    let auth = match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) if t.len() <= 16 * 1024 => {
            serde_json::from_str::<AuthFrame>(&t).ok()
        }
        _ => None,
    };
    let Some(auth) = auth else {
        let _ = socket.close().await;
        return;
    };
    if auth.kind != "auth"
        || auth.version != 1
        || auth.token.len() < 32
        || auth.token.len() > 128
        || auth.lease_id.is_empty()
        || auth.lease_id.len() > 128
        || auth.title.len() > 1000
        || auth.url.len() > 8192
    {
        let _ = socket.close().await;
        return;
    }
    let binding = store::binding_for_token(&state.pool, &super::hash(&auth.token))
        .await
        .ok()
        .flatten();
    let Some(binding) = binding else {
        let _ = socket.close().await;
        return;
    };
    if binding.id != auth.binding_id
        || binding.origin != auth.origin
        || super::payload::origin(&auth.url).ok().as_deref() != Some(&binding.origin)
        || !super::binding_is_current(&state, &binding)
            .await
            .unwrap_or(false)
    {
        let _ = socket.close().await;
        return;
    }
    let (tx, mut outgoing) = mpsc::channel(8);
    let peer = Arc::new(Peer {
        binding,
        target: super::id("bct"),
        lease_id: auth.lease_id,
        url: auth.url,
        title: auth.title,
        tx,
        pending: Mutex::new(None),
    });
    state.browser_control.register(peer.clone());
    if socket
        .send(Message::Text(
            json!({"type":"ready","lease_id":peer.lease_id,"connection_id":peer.target})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        state.browser_control.detach(&peer);
        return;
    }
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut last_seen = tokio::time::Instant::now();
    let mut last_ping = last_seen;
    loop {
        tokio::select! {
            value = outgoing.recv() => {
                let Some(value) = value else { break };
                let stop = value["type"] == "stop";
                if socket.send(Message::Text(value.to_string().into())).await.is_err() || stop { break }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        last_seen = tokio::time::Instant::now();
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { break };
                        if !current(&state,&peer).await.unwrap_or(false) { break }
                        if value["type"] == "ping" {
                            if socket.send(Message::Text(json!({"type":"pong"}).to_string().into())).await.is_err() { break }
                            continue
                        }
                        if value["type"] == "pong" { continue }
                        if value["type"] == "stop" { break }
                        if !accept_reply(&peer,&value) { break }
                    }
                    Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break } }
                    Some(Ok(Message::Pong(_))) => { last_seen = tokio::time::Instant::now(); }
                    _ => break,
                }
            }
            _ = tick.tick() => {
                if last_seen.elapsed() > Duration::from_secs(60) || !current(&state,&peer).await.unwrap_or(false) { break }
                if last_ping.elapsed() >= Duration::from_secs(20) {
                    if socket.send(Message::Text(json!({"type":"ping"}).to_string().into())).await.is_err() { break }
                    last_ping = tokio::time::Instant::now();
                }
            }
        }
    }
    state.browser_control.detach(&peer);
    let _ = socket.close().await;
}

fn accept_reply(peer: &Peer, value: &Value) -> bool {
    let mut slot = peer.pending.lock().unwrap();
    let Some(pending) = slot.as_mut() else {
        return true;
    };
    if value["id"].as_str() != Some(&pending.id) {
        return true;
    }
    let Some(completed) = value["completed"]
        .as_u64()
        .filter(|n| *n <= pending.total as u64 && *n >= pending.completed as u64)
    else {
        return false;
    };
    if value["type"] == "progress" {
        pending.completed = completed as usize;
        return true;
    }
    if value["type"] != "result"
        || value["origin"].as_str() != Some(&peer.binding.origin)
        || !value["ok"].is_boolean()
        || !value["results"].is_array()
        || value["results"]
            .as_array()
            .is_some_and(|r| r.len() > pending.total)
        || (value["ok"] == true && completed != pending.total as u64)
        || !valid_results(&value["results"], &peer.binding.origin)
    {
        return false;
    }
    let pending = slot.take().unwrap();
    let _ = pending.reply.send(value.clone());
    true
}

fn valid_results(value: &Value, _origin: &str) -> bool {
    // The authenticated result envelope supplies the controlled tab's origin.
    // Evaluated data and child frames can legitimately name other origins.
    value.is_array() && valid_images(value)
}
fn valid_images(value: &Value) -> bool {
    use base64::Engine;
    match value {
        Value::Array(items) => items.iter().all(valid_images),
        Value::Object(object) => {
            if let Some(data) = object.get("data_base64") {
                let Some(data) = data.as_str().filter(|s| s.len() <= 6 * 1024 * 1024) else {
                    return false;
                };
                if object.get("mime").and_then(Value::as_str) != Some("image/png") {
                    return false;
                }
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
                    return false;
                };
                if bytes.len() > 4 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                    return false;
                }
            }
            object.values().all(valid_images)
        }
        _ => true,
    }
}

#[cfg(test)]
pub(crate) async fn connect_test(state: &AppState, binding_id: &str) -> String {
    let binding = store::binding(&state.pool, binding_id)
        .await
        .unwrap()
        .unwrap();
    let (tx, _) = mpsc::channel(8);
    let peer = Arc::new(Peer {
        url: binding.origin.clone(),
        binding,
        target: super::id("bct"),
        lease_id: "fixture-lease".into(),
        title: "Fixture".into(),
        tx,
        pending: Mutex::new(None),
    });
    let target = peer.target.clone();
    state.browser_control.register(peer);
    target
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as ClientMessage};
    type Client = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;
    const EXTENSION: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Harness {
        state: AppState,
        address: std::net::SocketAddr,
        task: tokio::task::JoinHandle<()>,
        dir: std::path::PathBuf,
    }
    impl Drop for Harness {
        fn drop(&mut self) {
            self.task.abort();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    async fn harness() -> Harness {
        let (state, app, dir) = super::super::tests::setup().await;
        crate::db::sessions::ensure_runtime(&state.pool, "agent", "hook-agent")
            .await
            .unwrap();
        crate::db::sessions::insert_minimal(&state.pool, "other", "/tmp", "codex")
            .await
            .unwrap();
        crate::db::sessions::ensure_runtime(&state.pool, "other", "hook-other")
            .await
            .unwrap();
        sqlx::query("INSERT INTO browser_feedback_bindings(id,origin,session,token_hash,created_at) VALUES('bb_control','https://example.test','agent',?,1)")
            .bind(super::super::hash(TOKEN)).execute(&state.pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Harness {
            state,
            address,
            task,
            dir,
        }
    }
    async fn socket(h: &Harness, origin: &str) -> Client {
        let mut request = format!("ws://{}/api/browser/control/ws", h.address)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
        tokio_tungstenite::connect_async(request).await.unwrap().0
    }
    async fn send(socket: &mut Client, value: Value) {
        socket
            .send(ClientMessage::Text(value.to_string().into()))
            .await
            .unwrap();
    }
    async fn next(socket: &mut Client) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
            {
                ClientMessage::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "ping" {
                        send(socket, json!({"type":"pong"})).await;
                        continue;
                    }
                    return value;
                }
                ClientMessage::Ping(data) => socket.send(ClientMessage::Pong(data)).await.unwrap(),
                other => panic!("unexpected frame: {other:?}"),
            }
        }
    }
    fn auth(token: &str) -> Value {
        json!({"type":"auth","version":1,"token":token,"binding_id":"bb_control","lease_id":"lease-a",
            "origin":"https://example.test","url":"https://example.test/page","title":"Fixture"})
    }
    async fn connected(h: &Harness) -> (Client, String) {
        let mut socket = socket(h, EXTENSION).await;
        send(&mut socket, auth(TOKEN)).await;
        let ready = next(&mut socket).await;
        assert_eq!(ready["type"], "ready");
        (socket, ready["connection_id"].as_str().unwrap().into())
    }
    async fn hook(
        h: &Harness,
        session: &str,
        token: &str,
        tool: &str,
        args: Value,
    ) -> (u16, Value) {
        let response = reqwest::Client::new()
            .post(format!("http://{}/api/hook/browser/tool", h.address))
            .header("X-Supermux-Hook-Token", token)
            .json(&json!({"session":session,"tool":tool,"args":args}))
            .send()
            .await
            .unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }

    #[tokio::test]
    async fn control_socket_requires_extension_origin_and_first_frame_binding_auth() {
        let h = harness().await;
        for (origin, frame) in [
            ("https://example.test", auth(TOKEN)),
            (EXTENSION, auth("wrong")),
            (
                EXTENSION,
                json!({"type":"command","steps":[{"action":"snapshot"}]}),
            ),
        ] {
            let mut socket = socket(&h, origin).await;
            // A rejected Origin can close before the client sends anything.
            let _ = socket
                .send(ClientMessage::Text(frame.to_string().into()))
                .await;
            let reply = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap();
            assert!(!matches!(reply, Some(Ok(ClientMessage::Text(_)))));
            assert!(!h.state.browser_control.connected("bb_control"));
        }
        let (_socket, target) = connected(&h).await;
        assert!(target.starts_with("bct_"));
        let (mut socket, _) = connected(&h).await;
        send(&mut socket, json!({"type":"ping"})).await;
        assert_eq!(next(&mut socket).await["type"], "pong");
    }

    #[tokio::test]
    async fn connected_tabs_and_batches_use_hook_scope_without_headless_grants() {
        let h = harness().await;
        let (mut socket, target) = connected(&h).await;
        assert_eq!(
            hook(&h, "other", "hook-agent", "extension_list", json!({}))
                .await
                .0,
            401
        );
        let (status, list) = hook(&h, "other", "hook-other", "extension_list", json!({})).await;
        assert_eq!(status, 200);
        assert_eq!(list["result"]["targets"].as_array().unwrap().len(), 0);
        assert_eq!(
            hook(
                &h,
                "other",
                "hook-other",
                "actions",
                json!({"target":target,"steps":[{"action":"snapshot"}]})
            )
            .await
            .0,
            409
        );
        let (status, list) = hook(&h, "agent", "hook-agent", "extension_list", json!({})).await;
        assert_eq!(status, 200);
        assert_eq!(list["result"]["targets"][0]["target"], target);
        let state = h.state.clone();
        let target2 = target.clone();
        let task = tokio::spawn(async move {
            actions(&state,"agent",&json!({"target":target2,"steps":[{"action":"click","ref":"p1-f0-e1"},{"action":"snapshot"}]})).await.unwrap()
        });
        let command = next(&mut socket).await;
        assert_eq!(command["type"], "command");
        assert_eq!(command["steps"].as_array().unwrap().len(), 2);
        assert!(matches!(
            actions(
                &h.state,
                "agent",
                &json!({"target":target,"steps":[{"action":"snapshot"}]})
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        send(
            &mut socket,
            json!({"type":"progress","id":command["id"],"completed":1}),
        )
        .await;
        send(&mut socket,json!({"type":"result","id":command["id"],"origin":"https://example.test","ok":true,"completed":2,"results":[{}, {"url":"https://example.test/page","nodes":[{"ref":"p2-f0-e1","role":"button","name":"Save"}],"frames":[{"id":"f1","url":"https://embedded.test/widget","frames":[{"id":"f2","url":"https://nested.test/"}]}]}]})).await;
        let result = task.await.unwrap();
        assert_eq!(result["completed"], 2);
        assert_eq!(result["ok"], true);
    }

    #[tokio::test]
    async fn disconnect_preserves_partial_count_and_old_activation_cannot_control_replacement() {
        let h = harness().await;
        let (mut socket, target) = connected(&h).await;
        let state = h.state.clone();
        let old = target.clone();
        let task = tokio::spawn(async move {
            actions(
                &state,
                "agent",
                &json!({"target":old,"steps":[{"action":"click"},{"action":"snapshot"}]}),
            )
            .await
            .unwrap()
        });
        let command = next(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"progress","id":command["id"],"completed":1}),
        )
        .await;
        socket.close(None).await.unwrap();
        let result = task.await.unwrap();
        assert_eq!(result["outcome_unknown"], true);
        assert_eq!(result["completed"], 1);
        let (_replacement, new_target) = connected(&h).await;
        assert_ne!(target, new_target);
        assert!(matches!(
            actions(
                &h.state,
                "agent",
                &json!({"target":target,"steps":[{"action":"snapshot"}]})
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            list(&h.state, "agent").await.unwrap()["targets"][0]["target"],
            new_target
        );
    }

    #[tokio::test]
    async fn revoked_pairing_cancels_pending_command_and_leaks_no_response_content() {
        let h = harness().await;
        let (mut socket, target) = connected(&h).await;
        let state = h.state.clone();
        let task = tokio::spawn(async move {
            actions(
                &state,
                "agent",
                &json!({"target":target,"steps":[{"action":"snapshot"}]}),
            )
            .await
            .unwrap()
        });
        let _command = next(&mut socket).await;
        sqlx::query("UPDATE browser_feedback_bindings SET revoked_at=1 WHERE id='bb_control'")
            .execute(&h.state.pool)
            .await
            .unwrap();
        h.state.browser_control.revoke("bb_control");
        let result = task.await.unwrap();
        assert_eq!(result["outcome_unknown"], true);
        assert_eq!(result["results"], json!([]));
        assert_eq!(list(&h.state, "agent").await.unwrap()["targets"], json!([]));
    }

    #[tokio::test]
    async fn timeout_cancels_once_without_replaying_batch() {
        let h = harness().await;
        let (mut socket, target) = connected(&h).await;
        let state = h.state.clone();
        let task = tokio::spawn(async move {
            actions(
                &state,
                "agent",
                &json!({"target":target,"timeout_ms":1,"steps":[{"action":"snapshot"}]}),
            )
            .await
            .unwrap()
        });
        let command = next(&mut socket).await;
        let result = task.await.unwrap();
        assert_eq!(result["outcome_unknown"], true);
        let cancel = next(&mut socket).await;
        assert_eq!(cancel["type"], "cancel");
        assert_eq!(cancel["id"], command["id"]);
    }

    #[tokio::test]
    async fn dropping_caller_cancels_batch_and_replacement_cleanup_keeps_new_target() {
        let h = harness().await;
        let (mut old_socket, old_target) = connected(&h).await;
        let state = h.state.clone();
        let task = tokio::spawn(async move {
            actions(
                &state,
                "agent",
                &json!({"target":old_target,"steps":[{"action":"snapshot"}]}),
            )
            .await
        });
        let command = next(&mut old_socket).await;
        task.abort();
        let _ = task.await;
        assert_eq!(
            next(&mut old_socket).await,
            json!({"type":"cancel","id":command["id"]})
        );
        let (_new_socket, new_target) = connected(&h).await;
        assert_eq!(next(&mut old_socket).await["reason"], "replaced");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            list(&h.state, "agent").await.unwrap()["targets"][0]["target"],
            new_target
        );
    }

    #[tokio::test]
    async fn reassignment_blocks_inflight_result_and_hides_connected_target() {
        let h = harness().await;
        let (mut socket, target) = connected(&h).await;
        let state = h.state.clone();
        let task = tokio::spawn(async move {
            actions(
                &state,
                "agent",
                &json!({"target":target,"steps":[{"action":"snapshot"}]}),
            )
            .await
            .unwrap()
        });
        let command = next(&mut socket).await;
        let company =
            crate::db::companies::create(&h.state.pool, "other-company", "Other company", "/tmp")
                .await
                .unwrap();
        sqlx::query("UPDATE sessions SET company_id=? WHERE name='agent'")
            .bind(company.id)
            .execute(&h.state.pool)
            .await
            .unwrap();
        send(&mut socket,json!({"type":"result","id":command["id"],"origin":"https://example.test","ok":true,"completed":1,"results":[{"text":"must not escape"}]})).await;
        let result = task.await.unwrap();
        assert_eq!(result["outcome_unknown"], true);
        assert_eq!(result["results"], json!([]));
        assert_eq!(list(&h.state, "agent").await.unwrap()["targets"], json!([]));
    }

    #[tokio::test]
    async fn actual_control_mcp_relays_batch_and_emits_image_without_base64_text() {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let h = harness().await;
        let (mut socket, target) = connected(&h).await;
        let script = h.dir.join("control-mcp.py");
        tokio::fs::write(&script, crate::connectors::browser::mcp::SERVER_PY)
            .await
            .unwrap();
        let mut child = tokio::process::Command::new("python3")
            .arg(script)
            .arg("--control-only")
            .env("SUPERMUX_URL", format!("http://{}", h.address))
            .env("SUPERMUX_SESSION", "agent")
            .env("SUPERMUX_HOOK_TOKEN", "hook-agent")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        stdin
            .write_all(
                (json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}).to_string() + "\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let line = tokio::time::timeout(Duration::from_secs(3), stdout.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let list: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 2);
        assert_eq!(list["result"]["tools"][1]["name"], "browser_actions");
        stdin.write_all((json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_actions","arguments":{"target":target,"steps":[{"action":"snapshot"},{"action":"screenshot"}]}}}).to_string()+"\n").as_bytes()).await.unwrap();
        let command = next(&mut socket).await;
        let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
        send(&mut socket,json!({"type":"result","id":command["id"],"origin":"https://example.test","ok":true,"completed":2,"results":[{"url":"https://example.test/page","nodes":[{"ref":"p1-f0-e1","name":"Save"}]},{"mime":"image/png","data_base64":image,"width":1,"height":1}]})).await;
        let line = tokio::time::timeout(Duration::from_secs(3), stdout.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_ne!(reply["result"]["isError"].as_bool(), Some(true));
        let body: Value =
            serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["completed"], 2);
        assert!(reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("p1-f0-e1"));
        assert!(!reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(image));
        assert_eq!(reply["result"]["content"][1]["type"], "image");
        assert_eq!(reply["result"]["content"][1]["data"], image);
        child.kill().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_before_dispatch_sends_nothing_and_other_ids_remain_independent() {
        let h = harness().await;
        let (mut socket, target) = connected(&h).await;
        assert_eq!(
            hook(
                &h,
                "other",
                "hook-other",
                "cancel_actions",
                json!({"target":target,"request_id":"call_a"})
            )
            .await
            .0,
            409
        );
        assert_eq!(
            hook(
                &h,
                "agent",
                "hook-agent",
                "cancel_actions",
                json!({"target":target,"request_id":"call_a"})
            )
            .await
            .0,
            200
        );
        let result = actions(
            &h.state,
            "agent",
            &json!({"target":target,"request_id":"call_a","steps":[{"action":"click"}]}),
        )
        .await
        .unwrap();
        assert_eq!(result["completed"], 0);
        assert_eq!(result["outcome_unknown"], false);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), socket.next())
                .await
                .is_err()
        );
        let state = h.state.clone();
        let target2 = target.clone();
        let task = tokio::spawn(async move {
            actions(&state,"agent",&json!({"target":target2,"request_id":"call_b","steps":[{"action":"evaluate","expression":"({url:'https://linked.test/'})"}]})).await.unwrap()
        });
        let command = next(&mut socket).await;
        assert_eq!(command["id"], "call_b");
        cancel_actions(
            &h.state,
            "agent",
            &json!({"target":target,"request_id":"call_a"}),
        )
        .await
        .unwrap();
        send(&mut socket,json!({"type":"result","id":command["id"],"origin":"https://example.test","ok":true,"completed":1,"results":[{"url":"https://linked.test/"}]})).await;
        assert_eq!(task.await.unwrap()["ok"], true);
        let state = h.state.clone();
        let target2 = target.clone();
        let task = tokio::spawn(async move {
            actions(
                &state,
                "agent",
                &json!({"target":target2,"steps":[{"action":"snapshot"}]}),
            )
            .await
            .unwrap()
        });
        let command = next(&mut socket).await;
        send(&mut socket,json!({"type":"result","id":command["id"],"origin":"https://wrong.test","ok":true,"completed":1,"results":[{"text":"do not return"}]})).await;
        let result = task.await.unwrap();
        assert_eq!(result["outcome_unknown"], true);
        assert_eq!(result["results"], json!([]));
    }

    #[tokio::test]
    async fn actual_mcp_cancellation_keeps_reader_live_and_handles_pre_registration_race() {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        for before_registration in [false, true] {
            let h = harness().await;
            let (mut socket, target) = connected(&h).await;
            let script = h.dir.join("cancel-mcp.py");
            let source = crate::connectors::browser::mcp::SERVER_PY;
            let wrapper = if before_registration {
                format!(
                    r#"import threading
namespace={{'__name__':'test'}}
exec({source:?},namespace)
original=namespace['_post_tool']
gate=threading.Event()
def post(tool,args,timeout):
    if tool=='actions':
        assert gate.wait(5)
    result=original(tool,args,timeout)
    if tool=='cancel_actions':
        gate.set()
    return result
namespace['_post_tool']=post
namespace['main']()
"#
                )
            } else {
                format!(
                    r#"import threading
namespace={{'__name__':'test'}}
exec({source:?},namespace)
original=namespace['_post_tool']
parked=threading.Event()
released=threading.Event()
def post(tool,args,timeout):
    if tool=='request_human_takeover':
        parked.set()
        assert released.wait(5)
        return ({{'ok':True,'result':{{'resumed':True}}}},200)
    if tool=='read':
        assert released.is_set()
        return ({{'ok':True,'result':{{'ordered':True}}}},200)
    if tool=='actions':
        assert parked.wait(5)
    result=original(tool,args,timeout)
    if tool=='cancel_actions':
        released.set()
    return result
namespace['_post_tool']=post
namespace['main']()
"#
                )
            };
            tokio::fs::write(&script, wrapper).await.unwrap();
            let mut child = tokio::process::Command::new("python3")
                .arg(script)
                .env("SUPERMUX_URL", format!("http://{}", h.address))
                .env("SUPERMUX_SESSION", "agent")
                .env("SUPERMUX_HOOK_TOKEN", "hook-agent")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
            if !before_registration {
                stdin.write_all((json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"request_human_takeover","arguments":{"reason":"fixture parked"}}}).to_string()+"\n"+
                    &json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"browser_read","arguments":{}}}).to_string()+"\n").as_bytes()).await.unwrap();
            }
            stdin.write_all((json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_actions","arguments":{"target":target,"steps":[{"action":"click"},{"action":"type","text":"never"}]}}}).to_string()+"\n").as_bytes()).await.unwrap();
            let command = if before_registration {
                None
            } else {
                let command = next(&mut socket).await;
                send(
                    &mut socket,
                    json!({"type":"progress","id":command["id"],"completed":1}),
                )
                .await;
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let peer = h.state.browser_control.for_session("agent").pop().unwrap();
                        if peer
                            .pending
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|p| p.completed == 1)
                        {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                // A full pre-registration queue must not prevent cancellation
                // of known current work.
                for i in 0..256 {
                    h.state.browser_control.cancelled.lock().unwrap().insert(
                        ("agent".into(), target.clone(), format!("other_{i}")),
                        tokio::time::Instant::now(),
                    );
                }
                Some(command)
            };
            stdin.write_all((json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":999}}).to_string()+"\n"+
                &json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}).to_string()+"\n"+
                &json!({"jsonrpc":"2.0","id":8,"method":"ping"}).to_string()+"\n").as_bytes()).await.unwrap();
            let mut saw_ping = false;
            let mut saw_cancel = false;
            for _ in 0..if before_registration { 2 } else { 4 } {
                let line = tokio::time::timeout(Duration::from_secs(5), stdout.next_line())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                let reply: Value = serde_json::from_str(&line).unwrap();
                if reply["id"] == 8 {
                    saw_ping = true;
                } else if reply["id"] == 6 || reply["id"] == 9 {
                    let body: Value = serde_json::from_str(
                        reply["result"]["content"][0]["text"].as_str().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(
                        body[if reply["id"] == 6 {
                            "resumed"
                        } else {
                            "ordered"
                        }],
                        true
                    );
                } else {
                    assert_eq!(reply["id"], 7);
                    assert_eq!(reply["result"]["isError"], true);
                    let body: Value = serde_json::from_str(
                        reply["result"]["content"][0]["text"].as_str().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(body["completed"], if before_registration { 0 } else { 1 });
                    assert_eq!(body["results"], json!([]));
                    saw_cancel = true;
                }
            }
            assert!(saw_ping && saw_cancel);
            if let Some(command) = command {
                let cancel = next(&mut socket).await;
                assert_eq!(cancel["type"], "cancel");
                assert_eq!(cancel["id"], command["id"]);
                assert_eq!(list(&h.state, "agent").await.unwrap()["targets"], json!([]));
            } else {
                assert!(
                    tokio::time::timeout(Duration::from_millis(50), socket.next())
                        .await
                        .is_err()
                );
            }
            child.kill().await.unwrap();
        }
    }

    #[test]
    fn control_protocol_bounds_steps_urls_and_screenshot_responses() {
        assert!(validate_steps(&json!({"steps":[]}), "https://example.test").is_err());
        assert!(validate_steps(
            &json!({"steps":vec![json!({"action":"click"});33]}),
            "https://example.test"
        )
        .is_err());
        assert!(validate_steps(
            &json!({"steps":[{"action":"navigate","url":"https://other.test"}]}),
            "https://example.test"
        )
        .is_err());
        assert!(validate_steps(
            &json!({"timeout_ms":30001,"steps":[{"action":"snapshot"}]}),
            "https://example.test"
        )
        .is_err());
        assert!(valid_results(
            &json!([{"url":"https://other.test/private"}]),
            "https://example.test"
        ));
        assert!(valid_results(
            &json!([{"url":"https://example.test/page","frames":[{"url":"https://embedded.test/"}],"value":{"url":"https://data.test/link"}}]),
            "https://example.test"
        ));
        assert!(!valid_results(
            &json!([{"mime":"image/png","data_base64":"bad"}]),
            "https://example.test"
        ));
        assert!(validate_steps(&json!({"steps":[{"action":"fill","ref":"p1-f1-e1","text":"new"},{"action":"wait","state":"ready"},{"action":"reload"},{"action":"back"}]}),"https://example.test").is_ok());
    }
}
