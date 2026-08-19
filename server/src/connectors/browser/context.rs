//! One agent's **isolated browser context** — its own cookie jar, its own
//! `localStorage`, its own page, and its own [`DriveLock`].
//!
//! # Isolation
//!
//! A context is a CDP `BrowserContext` (`Target.createBrowserContext`), the
//! same primitive an incognito window uses. The spike verified cookie *and*
//! `localStorage` isolation between two of them, and verified that disposing
//! one leaves its siblings responsive — so per-agent teardown is safe.
//!
//! # Flat-mode sessions
//!
//! Each context owns exactly one page target, attached with
//! `Target.attachToTarget {flatten:true}`. Every command below therefore rides
//! the single browser WebSocket carrying our `sessionId`; there is no second
//! socket per page.
//!
//! # Every mutating method takes an [`Actor`]
//!
//! That is the lock, in the type system: an [`Actor::Agent`] call goes through
//! [`DriveLock::ensure_agent`] and is refused with
//! [`BrowserError::HumanDriving`] while a human has taken over, while
//! [`Actor::Human`] always passes. Read-only helpers are ungated — observing
//! the page is never a conflict.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use super::cdp::CdpClient;
use super::error::{BrowserError, Result};
use super::lock::{Actor, DriveLock, DriveMode};

/// How long [`AgentContext::navigate`] waits for `Page.loadEventFired` before
/// returning anyway. Navigation is *started* regardless; this only bounds how
/// long we block the caller. Slow third-party pages must not wedge a tool call.
const LOAD_BUDGET: Duration = Duration::from_secs(20);

/// Fan-out capacity for a context's screencast frames. Frames are droppable by
/// design (see `SPIKE-RESULT.md` gotcha #2) — a lagging viewer skips ahead
/// rather than pushing back on the browser.
const FRAME_CHANNEL_CAP: usize = 16;

/// One JPEG/PNG frame off `Page.screencastFrame`.
#[derive(Debug, Clone)]
pub struct ScreencastFrame {
    /// Base64-encoded image bytes, exactly as CDP delivered them (phase 2
    /// relays these to the browser client without a re-encode).
    pub data: String,
    /// `{offsetTop, pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX,
    /// scrollOffsetY, timestamp}` — the transform a client needs to map a tap
    /// back to page coordinates (gotcha #6).
    pub metadata: Value,
    /// The CDP `sessionId` this frame must be acked with, present only under
    /// [`AckPolicy::Viewer`] — under [`AckPolicy::Immediate`] the pump already
    /// acked and there is nothing for the consumer to do.
    ///
    /// Chromium counts *frames in flight* (max 2) and each ack is a decrement
    /// carrying the screencast's — not the frame's — session id, so an ack is
    /// fungible: a consumer that DROPS a frame still has to ack for it or the
    /// counter saturates and the stream stalls forever. See
    /// [`AgentContext::ack_frame`].
    pub ack: Option<Value>,
}

/// Who is responsible for `Page.screencastFrameAck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckPolicy {
    /// The pump acks the moment it has fanned a frame out (phase-1 behaviour).
    /// Chrome then renders/encodes at full speed regardless of the consumer.
    Immediate,
    /// The pump leaves the ack to the consumer, which acks only once the frame
    /// has actually been handed to its viewer. Chrome's 2-frame in-flight
    /// window then becomes REAL backpressure: a slow phone throttles the
    /// encoder instead of burning a core on frames nobody sees.
    Viewer,
}

/// Screencast tuning. Defaults are the spike's mobile-friendly recommendation:
/// jpeg q60 capped at 512px, which measured ~138 KB/s at 60 fps.
#[derive(Debug, Clone, Serialize)]
pub struct ScreencastOptions {
    pub format: String,
    pub quality: u32,
    #[serde(rename = "maxWidth")]
    pub max_width: u32,
    #[serde(rename = "maxHeight")]
    pub max_height: u32,
    #[serde(rename = "everyNthFrame")]
    pub every_nth_frame: u32,
    /// Who acks (not part of the CDP payload — hence `skip`).
    #[serde(skip)]
    pub ack: AckPolicy,
}

impl Default for ScreencastOptions {
    fn default() -> Self {
        Self {
            format: "jpeg".to_string(),
            quality: 60,
            max_width: 512,
            max_height: 512,
            every_nth_frame: 1,
            ack: AckPolicy::Immediate,
        }
    }
}

/// A key press descriptor. Chrome needs the *full* payload — the spike found
/// that omitting `code` leaves pages reading `e.code == ""` (gotcha #8).
#[derive(Debug, Clone)]
pub struct KeyPress {
    pub key: &'static str,
    pub code: &'static str,
    pub windows_virtual_key_code: i64,
    /// The text the key inserts, if any (`None` for Backspace/Escape/arrows).
    pub text: Option<&'static str>,
}

impl KeyPress {
    /// The common named keys a tool call or a takeover keyboard needs.
    pub fn named(name: &str) -> Option<Self> {
        let k = match name {
            "Enter" => Self {
                key: "Enter",
                code: "Enter",
                windows_virtual_key_code: 13,
                text: Some("\r"),
            },
            "Backspace" => Self {
                key: "Backspace",
                code: "Backspace",
                windows_virtual_key_code: 8,
                text: None,
            },
            "Tab" => Self {
                key: "Tab",
                code: "Tab",
                windows_virtual_key_code: 9,
                text: Some("\t"),
            },
            "Escape" => Self {
                key: "Escape",
                code: "Escape",
                windows_virtual_key_code: 27,
                text: None,
            },
            "ArrowUp" => Self {
                key: "ArrowUp",
                code: "ArrowUp",
                windows_virtual_key_code: 38,
                text: None,
            },
            "ArrowDown" => Self {
                key: "ArrowDown",
                code: "ArrowDown",
                windows_virtual_key_code: 40,
                text: None,
            },
            "ArrowLeft" => Self {
                key: "ArrowLeft",
                code: "ArrowLeft",
                windows_virtual_key_code: 37,
                text: None,
            },
            "ArrowRight" => Self {
                key: "ArrowRight",
                code: "ArrowRight",
                windows_virtual_key_code: 39,
                text: None,
            },
            _ => return None,
        };
        Some(k)
    }
}

/// A live per-agent browser context.
pub struct AgentContext {
    session: String,
    browser_context_id: String,
    target_id: String,
    cdp_session_id: String,
    client: Arc<CdpClient>,
    lock: DriveLock,
    /// Live screencast pump, if one is running.
    screencast: Mutex<Option<Screencast>>,
}

struct Screencast {
    tx: broadcast::Sender<ScreencastFrame>,
    pump: JoinHandle<()>,
}

impl std::fmt::Debug for AgentContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentContext")
            .field("session", &self.session)
            .field("browser_context_id", &self.browser_context_id)
            .field("target_id", &self.target_id)
            .field("mode", &self.lock.mode())
            .finish()
    }
}

impl AgentContext {
    /// Create an isolated context + its page and attach a flat-mode session.
    ///
    /// If anything fails midway the partially-created context is disposed
    /// before the error is returned, so a failed create leaks no context.
    pub async fn create(
        client: Arc<CdpClient>,
        session: &str,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        // `disposeOnDetach:false` on purpose: a client disconnecting must NOT
        // nuke the agent's browsing session (spike gotcha #12).
        let ctx = client
            .call(
                "Target.createBrowserContext",
                json!({ "disposeOnDetach": false }),
            )
            .await?;
        let browser_context_id = ctx["browserContextId"]
            .as_str()
            .ok_or_else(|| BrowserError::Protocol {
                method: "Target.createBrowserContext".into(),
                message: "no browserContextId in result".into(),
            })?
            .to_string();

        match Self::finish_create(client.clone(), session, &browser_context_id, width, height).await
        {
            Ok(me) => Ok(me),
            Err(e) => {
                let _ = client
                    .call(
                        "Target.disposeBrowserContext",
                        json!({ "browserContextId": browser_context_id }),
                    )
                    .await;
                Err(e)
            }
        }
    }

    async fn finish_create(
        client: Arc<CdpClient>,
        session: &str,
        browser_context_id: &str,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let target = client
            .call(
                "Target.createTarget",
                json!({
                    "url": "about:blank",
                    "browserContextId": browser_context_id,
                    "width": width,
                    "height": height,
                }),
            )
            .await?;
        let target_id = target["targetId"]
            .as_str()
            .ok_or_else(|| BrowserError::Protocol {
                method: "Target.createTarget".into(),
                message: "no targetId in result".into(),
            })?
            .to_string();

        // Flat mode: this target's traffic rides the browser socket, tagged.
        let attached = client
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;
        let cdp_session_id = attached["sessionId"]
            .as_str()
            .ok_or_else(|| BrowserError::Protocol {
                method: "Target.attachToTarget".into(),
                message: "no sessionId in result".into(),
            })?
            .to_string();

        let me = Self {
            session: session.to_string(),
            browser_context_id: browser_context_id.to_string(),
            target_id,
            cdp_session_id,
            client,
            lock: DriveLock::new(session),
            screencast: Mutex::new(None),
        };
        // Domains we need events + evaluation from.
        me.session_call("Page.enable", json!({})).await?;
        me.session_call("Runtime.enable", json!({})).await?;
        // `--window-size` is a browser-wide default; the viewport is per-target
        // (gotcha #11), so pin it here.
        me.session_call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width, "height": height,
                "deviceScaleFactor": 1, "mobile": false,
            }),
        )
        .await?;
        Ok(me)
    }

    // ── identity ────────────────────────────────────────────────────────────

    /// The supermux session name this context belongs to.
    pub fn session(&self) -> &str {
        &self.session
    }
    /// The CDP `browserContextId` (the isolation boundary).
    pub fn browser_context_id(&self) -> &str {
        &self.browser_context_id
    }
    /// The CDP `targetId` of this context's page.
    pub fn target_id(&self) -> &str {
        &self.target_id
    }
    /// The flat-mode `sessionId` commands for this page carry.
    pub fn cdp_session_id(&self) -> &str {
        &self.cdp_session_id
    }
    /// This context's AGENT/HUMAN drive lock.
    pub fn lock(&self) -> &DriveLock {
        &self.lock
    }
    /// Shorthand for `self.lock().mode()`.
    pub fn mode(&self) -> DriveMode {
        self.lock.mode()
    }

    async fn session_call(&self, method: &str, params: Value) -> Result<Value> {
        self.client
            .call_on(Some(&self.cdp_session_id), method, params)
            .await
    }

    // ── navigation + reading (reads are ungated) ────────────────────────────

    /// Navigate and wait (bounded) for the load event.
    pub async fn navigate(&self, actor: Actor, url: &str) -> Result<()> {
        self.lock.gate(actor)?;
        // Subscribe BEFORE issuing the command so a fast load cannot race us.
        let mut events = self.client.subscribe();
        let result = self
            .session_call("Page.navigate", json!({ "url": url }))
            .await?;
        if let Some(err) = result.get("errorText").and_then(Value::as_str) {
            return Err(BrowserError::Protocol {
                method: "Page.navigate".into(),
                message: format!("{url}: {err}"),
            });
        }
        let want = self.cdp_session_id.clone();
        let waited = tokio::time::timeout(LOAD_BUDGET, async {
            loop {
                match events.recv().await {
                    Ok(ev) => {
                        if ev.method == "Page.loadEventFired"
                            && ev.session_id.as_deref() == Some(want.as_str())
                        {
                            return;
                        }
                    }
                    // Lagged: we may have missed the load event, so stop
                    // waiting rather than hang until the budget expires.
                    Err(broadcast::error::RecvError::Lagged(_)) => return,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        })
        .await;
        if waited.is_err() {
            debug!(session = %self.session, url, "browser: load event not seen within budget");
        }
        Ok(())
    }

    /// Evaluate JS in the page and return the value (`returnByValue`).
    ///
    /// Ungated: reading the DOM is never a control conflict, and phase 2's
    /// takeover UI needs to read page state while the human drives.
    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        let out = self
            .session_call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;
        if let Some(details) = out.get("exceptionDetails") {
            let msg = details
                .get("exception")
                .and_then(|e| e.get("description"))
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("unknown exception")
                .to_string();
            return Err(BrowserError::Evaluate(msg));
        }
        Ok(out
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Convenience: `document.location.href`.
    pub async fn current_url(&self) -> Result<String> {
        Ok(self
            .evaluate("document.location.href")
            .await?
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    // ── input (all gated) ───────────────────────────────────────────────────

    /// A full left click at viewport coordinates.
    pub async fn click(&self, actor: Actor, x: f64, y: f64) -> Result<()> {
        self.lock.gate(actor)?;
        for kind in ["mousePressed", "mouseReleased"] {
            self.session_call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind, "x": x, "y": y,
                    "button": "left", "buttons": 1, "clickCount": 1,
                }),
            )
            .await?;
        }
        Ok(())
    }

    /// Move the pointer (hover) without clicking.
    pub async fn move_mouse(&self, actor: Actor, x: f64, y: f64) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y, "buttons": 0 }),
        )
        .await
        .map(|_| ())
    }

    /// Scroll by a wheel delta at a point.
    pub async fn scroll(&self, actor: Actor, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseWheel", "x": x, "y": y,
                "deltaX": dx, "deltaY": dy, "buttons": 0,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Insert text as if pasted / committed by an IME. Handles non-ASCII and
    /// emoji, which per-key events do not.
    pub async fn insert_text(&self, actor: Actor, text: &str) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call("Input.insertText", json!({ "text": text }))
            .await
            .map(|_| ())
    }

    /// Press and release a named key with the full CDP payload.
    pub async fn press_key(&self, actor: Actor, name: &str) -> Result<()> {
        self.lock.gate(actor)?;
        let k = KeyPress::named(name).ok_or_else(|| BrowserError::Protocol {
            method: "Input.dispatchKeyEvent".into(),
            message: format!("unsupported key '{name}'"),
        })?;
        for kind in ["keyDown", "keyUp"] {
            let mut params = json!({
                "type": kind,
                "key": k.key,
                "code": k.code,
                "windowsVirtualKeyCode": k.windows_virtual_key_code,
                "nativeVirtualKeyCode": k.windows_virtual_key_code,
            });
            if kind == "keyDown" {
                if let Some(text) = k.text {
                    params["text"] = json!(text);
                    params["unmodifiedText"] = json!(text);
                }
            }
            self.session_call("Input.dispatchKeyEvent", params).await?;
        }
        Ok(())
    }

    /// A touch tap. Enable touch emulation first (see
    /// [`set_touch_emulation`](Self::set_touch_emulation)) if the page only
    /// binds mouse handlers — Chrome then synthesises the compatibility click.
    pub async fn tap(&self, actor: Actor, x: f64, y: f64) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Input.dispatchTouchEvent",
            json!({
                "type": "touchStart",
                "touchPoints": [{ "x": x, "y": y }],
            }),
        )
        .await?;
        self.session_call(
            "Input.dispatchTouchEvent",
            json!({ "type": "touchEnd", "touchPoints": [] }),
        )
        .await
        .map(|_| ())
    }

    /// Toggle touch emulation for this target.
    pub async fn set_touch_emulation(&self, actor: Actor, enabled: bool) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Emulation.setTouchEmulationEnabled",
            json!({ "enabled": enabled, "maxTouchPoints": 5 }),
        )
        .await
        .map(|_| ())
    }

    /// Resize this target's viewport (per-target, not browser-wide).
    pub async fn set_viewport(
        &self,
        actor: Actor,
        width: u32,
        height: u32,
        mobile: bool,
    ) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width, "height": height,
                "deviceScaleFactor": 1, "mobile": mobile,
            }),
        )
        .await
        .map(|_| ())
    }

    // ── screencast (phase 2 consumes this) ──────────────────────────────────

    /// Start (or re-subscribe to) this context's screencast and return a
    /// receiver of frames.
    ///
    /// The pump acks each frame right after fanning it out. Acking is
    /// **mandatory** — without it Chrome delivers ~3 frames and stalls — and it
    /// doubles as free backpressure (spike gotcha #2). Phase 2 may move the ack
    /// to "after the client socket accepted the frame"; the hook is one line.
    pub async fn start_screencast(
        &self,
        actor: Actor,
        options: ScreencastOptions,
    ) -> Result<broadcast::Receiver<ScreencastFrame>> {
        self.lock.gate(actor)?;
        let mut slot = self.screencast.lock().await;
        if let Some(existing) = slot.as_ref() {
            return Ok(existing.tx.subscribe());
        }

        let (tx, rx) = broadcast::channel(FRAME_CHANNEL_CAP);
        let pump = {
            let mut events = self.client.subscribe();
            let client = self.client.clone();
            let want = self.cdp_session_id.clone();
            let tx = tx.clone();
            let policy = options.ack;
            tokio::spawn(async move {
                loop {
                    let ev = match events.recv().await {
                        Ok(ev) => ev,
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            debug!(dropped = n, "browser: screencast pump lagged");
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    };
                    if ev.method != "Page.screencastFrame"
                        || ev.session_id.as_deref() != Some(want.as_str())
                    {
                        continue;
                    }
                    let ack = ev.params.get("sessionId").cloned();
                    let frame = ScreencastFrame {
                        data: ev
                            .params
                            .get("data")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        metadata: ev.params.get("metadata").cloned().unwrap_or(json!({})),
                        // Under `Viewer` the consumer owns the ack, so it needs
                        // the token; under `Immediate` we ack below and hand it
                        // `None` so a consumer cannot double-ack.
                        ack: match policy {
                            AckPolicy::Viewer => ack.clone(),
                            AckPolicy::Immediate => None,
                        },
                    };
                    let _ = tx.send(frame);
                    if policy == AckPolicy::Immediate {
                        if let Some(ack) = ack {
                            if let Err(e) = client.notify(
                                Some(&want),
                                "Page.screencastFrameAck",
                                json!({ "sessionId": ack }),
                            ) {
                                warn!(error = %e, "browser: screencast ack failed");
                                break;
                            }
                        }
                    }
                }
            })
        };

        self.session_call(
            "Page.startScreencast",
            json!({
                "format": options.format,
                "quality": options.quality,
                "maxWidth": options.max_width,
                "maxHeight": options.max_height,
                "everyNthFrame": options.every_nth_frame.max(1),
            }),
        )
        .await?;
        *slot = Some(Screencast { tx, pump });
        Ok(rx)
    }

    /// Stop the screencast and drop its pump.
    pub async fn stop_screencast(&self, actor: Actor) -> Result<()> {
        self.lock.gate(actor)?;
        let taken = self.screencast.lock().await.take();
        if let Some(sc) = taken {
            sc.pump.abort();
            self.session_call("Page.stopScreencast", json!({})).await?;
        }
        Ok(())
    }

    /// Ack one screencast frame under [`AckPolicy::Viewer`].
    ///
    /// Fire-and-forget (`notify`) on purpose: at up to 60 acks/s a round trip
    /// per ack would add its own latency for a result that carries no
    /// information. **Every** frame the consumer receives must be acked exactly
    /// once — including frames it decided to DROP — because Chromium's ack is a
    /// decrement of a 2-slot in-flight counter, not a per-frame receipt. Skip
    /// one and the screencast silently stops.
    pub fn ack_frame(&self, ack: &Value) -> Result<()> {
        self.client.notify(
            Some(&self.cdp_session_id),
            "Page.screencastFrameAck",
            json!({ "sessionId": ack }),
        )
    }

    /// The methods [`dispatch_input`](Self::dispatch_input) will forward. An
    /// allowlist, not a filter: the takeover socket builds CDP payloads from
    /// untrusted client JSON, so the set of commands it can reach is pinned
    /// here rather than wherever the next caller happens to be written.
    pub const INPUT_METHODS: [&'static str; 4] = [
        "Input.dispatchMouseEvent",
        "Input.dispatchKeyEvent",
        "Input.dispatchTouchEvent",
        "Input.insertText",
    ];

    /// Forward one already-built `Input.*` payload to this context's page.
    ///
    /// The typed helpers above (`click`, `press_key`, …) are what a *tool call*
    /// wants — one intention, several CDP events. A human at a takeover canvas
    /// is the other shape: raw pointer/key events at ~60 Hz that must arrive
    /// individually (a `mouseMoved` during a drag is not a click). This is that
    /// seam, and it carries the same [`Actor`] gate as every other mutating
    /// method — plus the [`INPUT_METHODS`](Self::INPUT_METHODS) allowlist.
    pub async fn dispatch_input(&self, actor: Actor, method: &str, params: Value) -> Result<()> {
        self.lock.gate(actor)?;
        if !Self::INPUT_METHODS.contains(&method) {
            return Err(BrowserError::Protocol {
                method: method.to_string(),
                message: "not an allowed input method".to_string(),
            });
        }
        self.session_call(method, params).await.map(|_| ())
    }

    /// One-shot JPEG of the current page, base64. Needed because a static page
    /// emits no screencast frames (gotcha #1) — a client attaching mid-idle
    /// would otherwise see a blank canvas.
    pub async fn screenshot(&self) -> Result<String> {
        let out = self
            .session_call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": 70 }),
            )
            .await?;
        Ok(out
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    // ── teardown ────────────────────────────────────────────────────────────

    /// Close the page and dispose the browser context. Best-effort: every step
    /// runs even if an earlier one failed, so a half-dead browser still gets
    /// the disposal commands it can honour.
    pub async fn close(&self) {
        let taken = self.screencast.lock().await.take();
        if let Some(sc) = taken {
            sc.pump.abort();
        }
        if let Err(e) = self
            .client
            .call("Target.closeTarget", json!({ "targetId": self.target_id }))
            .await
        {
            debug!(session = %self.session, error = %e, "browser: closeTarget");
        }
        if let Err(e) = self
            .client
            .call(
                "Target.disposeBrowserContext",
                json!({ "browserContextId": self.browser_context_id }),
            )
            .await
        {
            debug!(session = %self.session, error = %e, "browser: disposeBrowserContext");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys_carry_the_full_payload() {
        let enter = KeyPress::named("Enter").unwrap();
        assert_eq!(enter.code, "Enter");
        assert_eq!(enter.windows_virtual_key_code, 13);
        assert_eq!(enter.text, Some("\r"));
        // gotcha #8: `code` must never be empty or pages reading e.code break.
        for name in [
            "Enter",
            "Backspace",
            "Tab",
            "Escape",
            "ArrowUp",
            "ArrowDown",
        ] {
            assert!(!KeyPress::named(name).unwrap().code.is_empty(), "{name}");
        }
        assert!(KeyPress::named("F13").is_none());
    }

    #[test]
    fn screencast_defaults_are_the_mobile_profile() {
        let o = ScreencastOptions::default();
        assert_eq!(o.format, "jpeg");
        assert!(o.quality <= 70, "jpeg beats png ~2.3x; keep quality modest");
        assert!(
            o.max_width <= 512 && o.max_height <= 512,
            "size server-side (gotcha #4)"
        );
        assert_eq!(o.every_nth_frame, 1);
    }
}
