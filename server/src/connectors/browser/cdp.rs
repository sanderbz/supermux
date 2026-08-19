//! A minimal async **Chrome DevTools Protocol client over a raw WebSocket**.
//!
//! # Why not Playwright / chromiumoxide
//!
//! The spike (`SPIKE-RESULT.md` §4b) re-proved the entire feature set —
//! screencast at 60 fps, `Input.*` injection, per-context isolation, clean
//! teardown — over a **raw CDP WebSocket with Playwright entirely absent**.
//! Shipping a Node runtime inside a single-binary Rust server would be a
//! significant regression in the product's core promise, and a full CDP crate
//! would add a large dependency tree for the ~12 commands we actually use. So
//! this is hand-rolled on **`tokio-tungstenite`, which is already a direct
//! dependency of this crate** — the connector adds **zero** new crates.
//!
//! # Shape
//!
//! One WebSocket to the *browser* endpoint, multiplexed three ways:
//!
//! * **Commands** — `{id, method, params, sessionId?}`. `id` is a process-wide
//!   monotonic counter; a `oneshot` per in-flight id lives in `pending`.
//! * **Responses** — `{id, result}` or `{id, error}` → resolves that oneshot.
//! * **Events** — `{method, params, sessionId?}` → fanned out on a `broadcast`.
//!
//! Per-target sessions use **flat mode** (`Target.attachToTarget
//! {flatten:true}`): every target's traffic rides this one socket, tagged with
//! `sessionId`. That keeps one reader task for the whole browser regardless of
//! how many agents have contexts open.
//!
//! # Failure model
//!
//! If the socket dies, the reader task fails every pending command with
//! [`BrowserError::Transport`] and marks the client closed, so callers get a
//! prompt typed error instead of hanging until their timeout.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, warn};

use super::error::{BrowserError, Result};

/// Default per-command deadline. Chrome answers locally in single-digit ms;
/// anything past this means the browser is wedged, not slow.
pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Fan-out capacity of the event channel. Screencast runs at up to 60 fps per
/// context, so this is sized for a couple of seconds of burst before a slow
/// subscriber starts seeing `Lagged` (which is the correct outcome — frames are
/// droppable, see `SPIKE-RESULT.md` gotcha #2).
const EVENT_CHANNEL_CAP: usize = 512;

/// One CDP event, tagged with the flat-mode session it came from.
#[derive(Debug, Clone)]
pub struct CdpEvent {
    /// e.g. `Page.loadEventFired`, `Page.screencastFrame`.
    pub method: String,
    /// The event payload (`{}` when the event carries none).
    pub params: Value,
    /// `Some` for target-scoped events in flat mode, `None` for browser-level.
    pub session_id: Option<String>,
}

/// An open CDP connection to the browser endpoint.
pub struct CdpClient {
    next_id: AtomicI64,
    outbound: mpsc::UnboundedSender<Message>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<std::result::Result<Value, String>>>>>,
    events: broadcast::Sender<CdpEvent>,
    closed: Arc<AtomicBool>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl std::fmt::Debug for CdpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CdpClient")
            .field("closed", &self.closed.load(Ordering::Relaxed))
            .finish()
    }
}

impl CdpClient {
    /// Connect to a browser-level CDP endpoint (`ws://127.0.0.1:<port>/devtools/browser/<id>`).
    pub async fn connect(ws_url: &str) -> Result<Arc<Self>> {
        let (stream, _resp) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| BrowserError::Transport(format!("connect {ws_url}: {e}")))?;
        let (mut sink, mut source) = stream.split();

        let (outbound, mut outbox) = mpsc::unbounded_channel::<Message>();
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAP);
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<_>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        // Writer: serialises every outbound frame through one task so `call`
        // needs no lock on the sink.
        let writer = tokio::spawn(async move {
            while let Some(msg) = outbox.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // Reader: correlates responses, fans out events, and — critically —
        // fails every in-flight command if the socket dies.
        let reader = {
            let pending = pending.clone();
            let events = events.clone();
            let closed = closed.clone();
            tokio::spawn(async move {
                while let Some(next) = source.next().await {
                    let text = match next {
                        Ok(Message::Text(t)) => t,
                        Ok(Message::Binary(_)) | Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                            continue
                        }
                        Ok(Message::Close(_)) | Ok(Message::Frame(_)) => break,
                        Err(e) => {
                            debug!(error = %e, "browser: CDP socket read error");
                            break;
                        }
                    };
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        warn!("browser: undecodable CDP frame");
                        continue;
                    };
                    if let Some(id) = value.get("id").and_then(Value::as_i64) {
                        let slot = pending.lock().await.remove(&id);
                        if let Some(tx) = slot {
                            let outcome = match value.get("error") {
                                Some(err) => Err(err
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown CDP error")
                                    .to_string()),
                                None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(outcome);
                        }
                    } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                        // A send error only means "nobody is subscribed".
                        let _ = events.send(CdpEvent {
                            method: method.to_string(),
                            params: value.get("params").cloned().unwrap_or(json!({})),
                            session_id: value
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        });
                    }
                }
                // Socket is gone: unblock everyone waiting on it.
                closed.store(true, Ordering::SeqCst);
                let mut map = pending.lock().await;
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err("CDP socket closed".to_string()));
                }
            })
        };

        Ok(Arc::new(Self {
            next_id: AtomicI64::new(1),
            outbound,
            pending,
            events,
            closed,
            tasks: Mutex::new(vec![reader, writer]),
        }))
    }

    /// Subscribe to the raw event stream (all targets, all methods).
    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    /// Has the socket gone away?
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Send a browser-level command and await its result.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_on(None, method, params).await
    }

    /// Send a command scoped to a flat-mode target session (or browser-level
    /// when `session_id` is `None`) and await its result.
    pub async fn call_on(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.call_with_timeout(session_id, method, params, DEFAULT_CALL_TIMEOUT)
            .await
    }

    /// As [`call_on`](Self::call_on) with an explicit deadline.
    pub async fn call_with_timeout(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        if self.is_closed() {
            return Err(BrowserError::Transport("CDP socket closed".to_string()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session_id {
            frame["sessionId"] = json!(sid);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let payload = frame.to_string();
        if self.outbound.send(Message::Text(payload)).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(BrowserError::Transport("CDP writer is gone".to_string()));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(BrowserError::Protocol {
                method: method.to_string(),
                message,
            }),
            Ok(Err(_recv)) => Err(BrowserError::Transport(format!(
                "CDP response channel dropped for {method}"
            ))),
            Err(_elapsed) => {
                self.pending.lock().await.remove(&id);
                Err(BrowserError::Timeout(method.to_string()))
            }
        }
    }

    /// Fire-and-forget: send a command without awaiting its response.
    ///
    /// Used for the two commands where the answer is worthless and the latency
    /// is not: `Page.screencastFrameAck` (60/s per viewer) and the final
    /// `Browser.close` (the socket dies as a *consequence* of it landing).
    pub fn notify(&self, session_id: Option<&str>, method: &str, params: Value) -> Result<()> {
        if self.is_closed() {
            return Err(BrowserError::Transport("CDP socket closed".to_string()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session_id {
            frame["sessionId"] = json!(sid);
        }
        self.outbound
            .send(Message::Text(frame.to_string()))
            .map_err(|_| BrowserError::Transport("CDP writer is gone".to_string()))
    }

    /// Drop the socket and stop both pump tasks. Idempotent.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Dropping every sender ends the writer task, which closes the sink,
        // which ends the reader task.
        let mut tasks = self.tasks.lock().await;
        for t in tasks.iter() {
            t.abort();
        }
        tasks.clear();
        let mut map = self.pending.lock().await;
        for (_, tx) in map.drain() {
            let _ = tx.send(Err("CDP client closed".to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_to_a_dead_endpoint_is_a_typed_transport_error() {
        // Port 1 on loopback: nothing listens, connection is refused fast.
        let err = CdpClient::connect("ws://127.0.0.1:1/devtools/browser/none")
            .await
            .expect_err("must not connect");
        assert!(matches!(err, BrowserError::Transport(_)), "got {err:?}");
    }

    #[test]
    fn event_carries_the_flat_mode_session_id() {
        let raw = json!({
            "method": "Page.screencastFrame",
            "sessionId": "S1",
            "params": { "data": "AAA", "sessionId": 7 }
        });
        // Mirrors the reader task's decode path.
        let ev = CdpEvent {
            method: raw["method"].as_str().unwrap().to_string(),
            params: raw["params"].clone(),
            session_id: raw["sessionId"].as_str().map(str::to_string),
        };
        assert_eq!(ev.session_id.as_deref(), Some("S1"));
        assert_eq!(ev.params["sessionId"], json!(7));
    }
}
