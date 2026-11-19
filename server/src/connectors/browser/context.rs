//! **One page, driven by an agent or a human** — its cookie jar, its
//! `localStorage`, its target, and its [`DriveLock`].
//!
//! # Two jars, one page primitive (shared-browser v1 §2.3)
//!
//! Everything below the identity line is shared; only *which* jar the page
//! lands in differs, and that is exactly one field:
//!
//! * **Agent scratch** ([`AgentContext::create`], `browser_context_id =
//!   Some(_)`). A CDP `BrowserContext` (`Target.createBrowserContext`), the same
//!   primitive an incognito window uses. The spike verified cookie *and*
//!   `localStorage` isolation between two of them, and verified that disposing
//!   one leaves its siblings responsive — so per-agent teardown is safe. This
//!   path is **byte-for-byte today's behaviour** and keeps every guarantee it
//!   has: an incognito-equivalent context does not persist to the profile dir,
//!   so scratch stays isolated even while sharing a durable `--user-data-dir`.
//! * **Workspace tab** ([`AgentContext::create_in_default_context`],
//!   `browser_context_id = None`). `Target.createTarget` with **no**
//!   `browserContextId` lands in the browser's DEFAULT context, whose cookies /
//!   `localStorage` / IndexedDB Chrome persists into
//!   `<user-data-dir>/Default/…`. **The profile IS the jar** — there is nothing
//!   to create and, decisively, nothing to dispose (see
//!   [`AgentContext::close`]).
//!
//! Every page-driving method below is identical for both and is deliberately
//! left untouched by v1 — in particular the screencast pump's ack accounting,
//! which is subtle and must not be re-derived.
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

use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch, Mutex};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::{debug, warn};

use super::cdp::{CdpClient, CdpEvent};
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

/// Ceiling on `deviceScaleFactor`. Chrome composites `width × scale` REAL
/// pixels, so the render cost is quadratic in this number while the legibility
/// win stops at "one frame pixel per screen pixel". A 3× phone therefore
/// renders at 2× and the extra third is left on the client's downscale, which
/// is free.
pub const MAX_DEVICE_SCALE: f64 = 2.0;

/// `everyNthFrame` for the drive profile. Chrome paints up to ~60 fps; a person
/// READING a page wants ~15 sharp frames far more than 60 that spent their
/// quality budget on motion, and it is the same trade the 512-cap made in the
/// other direction.
const DRIVE_EVERY_NTH: u32 = 4;

/// How long after the last navigation signal a page counts as **settled** and
/// the expensive reads (history, title, favicon) are worth issuing. Short enough
/// that the address bar feels immediate; long enough that a redirect chain is
/// read once at its landing instead of once per hop.
const NAV_SETTLE: Duration = Duration::from_millis(300);

/// Deadline on the watcher's own CDP reads. Deliberately far below
/// [`DEFAULT_CALL_TIMEOUT`](super::cdp::DEFAULT_CALL_TIMEOUT): a wedged page must
/// stall its own address bar for a few seconds, never wedge the pump that is the
/// only thing still telling the human what is going on.
const NAV_READ_BUDGET: Duration = Duration::from_secs(5);

/// Ceiling on a favicon data URI. Chrome will hand back whatever the site ships;
/// the address bar renders it at 16 px and this rides a JSON WebSocket frame, so
/// anything larger is dropped rather than relayed.
const MAX_FAVICON_BYTES: usize = 96 * 1024;

/// **The no-passkeys shim**, injected into every frame before any page script.
///
/// See [`AgentContext::disable_passkeys`] for WHY. In one line: a CDP-driven
/// Chrome on a server has no platform authenticator, so a WebAuthn ceremony
/// never resolves and the sign-in hangs for the agent AND for the human on
/// takeover. This makes the browser answer honestly (`false` to both
/// availability probes, so providers offer the password path) and fail fast
/// (`NotAllowedError` — the same error a user cancelling the OS prompt raises,
/// which every provider already handles) if a ceremony starts anyway.
///
/// Defensive by construction: the whole body is wrapped so that a browser
/// missing any of these APIs is left untouched rather than throwing into the
/// page, and a `get()` with no `publicKey` (password / federated / OTP autofill)
/// is delegated to the real implementation.
const NO_PASSKEYS_JS: &str = r#"
(() => {
  const define = (obj, name, value) => {
    try {
      Object.defineProperty(obj, name, {
        value, writable: true, configurable: true, enumerable: false,
      });
      return true;
    } catch (e) { return false; }
  };
  try {
    const deny = () => Promise.reject(
      new DOMException(
        'This browser has no authenticator available. Use a password or a verification code instead.',
        'NotAllowedError',
      ),
    );
    if (window.PublicKeyCredential) {
      // Feature detection FIRST: a provider that asks gets the honest `false`
      // and offers the password path, so the ceremony never begins.
      define(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable',
        () => Promise.resolve(false));
      define(PublicKeyCredential, 'isConditionalMediationAvailable',
        () => Promise.resolve(false));
      define(PublicKeyCredential, 'isPasskeyPlatformAuthenticatorAvailable',
        () => Promise.resolve(false));
    }
    const creds = navigator.credentials;
    if (creds) {
      // Bind through the PROTOTYPE, not the instance: `navigator.credentials`
      // may hand back a fresh wrapper, and an own-property assignment on one
      // instance would then not be the object the page calls.
      const proto = Object.getPrototypeOf(creds) || creds;
      const realGet = proto.get && proto.get.bind(creds);
      const realCreate = proto.create && proto.create.bind(creds);
      // Only WebAuthn is refused. A password / federated / OTP request carries no
      // `publicKey` and must keep working, or we would break ordinary autofill.
      const guard = (real) => {
        const fn = function (options) {
          if (options && options.publicKey) return deny();
          return real ? real(options) : deny();
        };
        // A tag the integration test reads: "the browser refused" and "WE
        // refused" must never be confusable, and on an origin where Chrome
        // refuses WebAuthn on its own they look identical without this.
        fn.__supermuxNoPasskeys = true;
        return fn;
      };
      for (const target of [proto, creds]) {
        define(target, 'get', guard(realGet));
        define(target, 'create', guard(realCreate));
      }
    }
    // A marker the integration test reads, so "the shim is installed" and "the
    // browser happens to behave" can never be confused for one another.
    define(window, '__supermuxNoPasskeys', {
      creds: !!navigator.credentials,
      getIsShim: !!(navigator.credentials
        && navigator.credentials.get
        && navigator.credentials.get.__supermuxNoPasskeys),
    });
  } catch (e) {
    define(window, '__supermuxNoPasskeys', {error: String(e && e.message)});
  }
})();
"#;

/// Events that mean **the page moved**, for the bounded wait after a history
/// step. `Page.loadEventFired` is the strong signal, but a back/forward restored
/// from Chrome's back-forward cache never fires it — the document was never
/// re-parsed — and announces itself with `frameNavigated` instead. Waiting only
/// on `load` would therefore block every bfcache "back" for the whole budget.
const HISTORY_DONE: [&str; 3] = [
    "Page.loadEventFired",
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
];

/// Read the page's icon **inside the page**, as a `data:` URI, or `null`.
///
/// Deliberately not fetched server-side. A signed-in site's icon is very often
/// behind the same cookie the profile holds, so a server-side `GET` would (a)
/// leave the profile's jar and come back 403, and (b) put the server's own IP on
/// a URL the human's page chose. In-page it is one `fetch` with the page's own
/// credentials, and every failure mode — CSP, CORS, 404, a non-image body — is
/// caught and degrades to `null` rather than to an error the human sees.
const FAVICON_JS: &str = r#"(async () => {
  try {
    const abs = (h) => { try { return new URL(h, location.href).href } catch (e) { return null } };
    const links = Array.from(document.querySelectorAll('link[rel~="icon"]'));
    const size = (l) => {
      const m = (l.getAttribute('sizes') || '').match(/\d+/);
      if (m) return parseInt(m[0], 10);
      return (l.getAttribute('type') || '') === 'image/svg+xml' ? 1000 : 1;
    };
    links.sort((a, b) => size(b) - size(a));
    const href = (links[0] && abs(links[0].getAttribute('href'))) || abs('/favicon.ico');
    if (!href || !/^https?:/i.test(href)) return null;
    const r = await fetch(href, { credentials: 'include', cache: 'force-cache' });
    if (!r.ok) return null;
    const b = await r.blob();
    if (!b.size || b.size > 65536) return null;
    if (!/^image\//.test(b.type || '')) return null;
    return await new Promise((done) => {
      const fr = new FileReader();
      fr.onload = () => done(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => done(null);
      fr.readAsDataURL(b);
    });
  } catch (e) { return null }
})()"#;

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

/// **Two profiles, and the gap between them is the whole legibility story.**
///
/// The same page streamed to a phone-sized card next to a chat transcript and
/// to a laptop viewport somebody is trying to READ are not the same problem.
/// One wants motion at ~138 KB/s; the other wants type it can resolve. The
/// server cannot guess which it is serving, so the client says
/// (`ClientMsg::Viewport`) and this picks.
impl ScreencastOptions {
    /// The largest frame either profile will ever ask chrome for — a cap on the
    /// encoder, on the wire and on the canvas the client has to paint. Past it a
    /// sharper frame buys nothing an eye can see on a real screen.
    pub const MAX_STREAM_PX: u32 = 1600;

    /// **watch** — the in-chat takeover card. The spike's measured mobile
    /// profile (jpeg q60, 512², every frame), byte for byte, because a person
    /// watching an agent work wants motion and a small bill, not typography.
    /// This is what a client that never negotiates keeps getting.
    pub fn watch() -> Self {
        Self::default()
    }

    /// **drive** — the workspace viewport, sized for the human looking at it.
    ///
    /// `css_w`/`css_h` are the viewer's CSS box and `dpr` its device pixel
    /// ratio, so the cap is the count of REAL pixels their screen can show.
    /// Paired with [`AgentContext::set_viewport_scaled`], which lays the page
    /// out at that same box, the result is 1:1 and readable instead of a 1366px
    /// render squeezed through a 512px pipe and re-upscaled in a canvas.
    pub fn drive(css_w: u32, css_h: u32, dpr: f64) -> Self {
        let scale = if dpr.is_finite() {
            dpr.clamp(1.0, MAX_DEVICE_SCALE)
        } else {
            1.0
        };
        let px = |css: u32| -> u32 {
            let want = f64::from(css.max(1)) * scale;
            (want.round() as u32).clamp(1, Self::MAX_STREAM_PX)
        };
        Self {
            format: "jpeg".to_string(),
            quality: 75,
            max_width: px(css_w),
            max_height: px(css_h),
            every_nth_frame: DRIVE_EVERY_NTH,
            ack: AckPolicy::Immediate,
        }
    }

    /// The `Page.startScreencast` payload. Split out so the mapping is testable
    /// without chrome AND so the renegotiation path below cannot drift from the
    /// start path — the bug that would show up as "the profile changed but the
    /// picture did not".
    pub fn cdp_params(&self) -> Value {
        json!({
            "format": self.format,
            "quality": self.quality,
            "maxWidth": self.max_width,
            "maxHeight": self.max_height,
            "everyNthFrame": self.every_nth_frame.max(1),
        })
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

// ── nav state: what an address bar shows (P1-5) ─────────────────────────────

/// One entry of `Page.getNavigationHistory`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NavEntry {
    /// CDP's `entryId` — the only thing `Page.navigateToHistoryEntry` accepts.
    pub id: i64,
    pub url: String,
    pub title: String,
}

/// The page's back/forward stack, exactly as CDP reports it.
///
/// **CDP has no relative `go`.** `Page.navigateToHistoryEntry` takes an absolute
/// `entryId`, so "back" is `entries[currentIndex - 1].id` and the whole of
/// [`AgentContext::go`] is the index arithmetic in
/// [`entry_at_delta`](Self::entry_at_delta). This is a pure value type precisely
/// so that arithmetic — the part that can be off by one and silently navigate a
/// human somewhere they never asked for — is testable without a browser.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct NavHistory {
    pub current_index: i64,
    pub entries: Vec<NavEntry>,
}

impl NavHistory {
    /// Parse a `Page.getNavigationHistory` result. A missing or malformed field
    /// yields an empty history, never a panic: this parses browser output.
    ///
    /// `currentIndex` defaults to `-1` (not `0`) so an unreadable result reports
    /// *no* history rather than a first entry that does not exist — `can_go_back`
    /// on a lie is a button that navigates a human somewhere at random.
    pub fn from_cdp(v: &Value) -> Self {
        let entries = v
            .get("entries")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|e| NavEntry {
                        id: e.get("id").and_then(Value::as_i64).unwrap_or(-1),
                        url: str_of(e.get("url")),
                        title: str_of(e.get("title")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            current_index: v.get("currentIndex").and_then(Value::as_i64).unwrap_or(-1),
            entries,
        }
    }

    /// Is there an entry BEHIND the current one?
    pub fn can_go_back(&self) -> bool {
        self.entry_at_delta(-1).is_some()
    }

    /// …and one AHEAD?
    pub fn can_go_forward(&self) -> bool {
        self.entry_at_delta(1).is_some()
    }

    /// The `entryId` `delta` steps from here, or `None` when that falls off
    /// either end of the stack — which is the honest answer to "can I go back?"
    /// at the first page, not an error.
    ///
    /// `delta == 0` is `None` on purpose: re-navigating to the entry you are
    /// already on is a reload wearing a different name, and
    /// [`AgentContext::reload`] is the call that means it.
    pub fn entry_at_delta(&self, delta: i64) -> Option<i64> {
        if delta == 0 {
            return None;
        }
        let target = self.current_index.checked_add(delta)?;
        let index = usize::try_from(target).ok()?;
        self.entries.get(index).map(|e| e.id)
    }

    /// The URL of the entry the page is ON, if the stack has one. Authoritative
    /// over a remembered `frameNavigated`, because it is what Chrome itself
    /// considers the current document after a history step.
    pub fn current_url(&self) -> Option<&str> {
        usize::try_from(self.current_index)
            .ok()
            .and_then(|i| self.entries.get(i))
            .map(|e| e.url.as_str())
    }
}

/// A modal `alert` / `confirm` / `prompt` / `beforeunload` the page has opened.
///
/// This is page **state**, not an event, and it lives on [`NavState`] for one
/// decisive reason: a JS dialog blocks the renderer, so a human attaching to a
/// page that is *already* blocked must learn about it from the very first frame
/// they are handed. An event they were not connected for would leave them
/// staring at a frozen page with nothing to press.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageDialog {
    /// CDP's `type`: `alert` | `confirm` | `prompt` | `beforeunload`.
    pub kind: String,
    pub message: String,
    /// The prefilled value of a `prompt()`'s input; empty for the other kinds.
    pub default_prompt: String,
}

/// **What the address bar shows** — the live nav state of one page.
///
/// Produced by [`AgentContext::watch_nav`] and consumed twice: pushed to the
/// takeover socket as the live omnibox feed, and written through to
/// `browser_tabs` so the tab list stops showing where a page *was*.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct NavState {
    pub url: String,
    pub title: String,
    /// A `data:` URI of the page's icon, fetched **in the page** (see
    /// [`FAVICON_JS`]). `None` until one is found, and `None` again when the
    /// site moves and its new icon cannot be read — never a stale icon for a
    /// site the human is no longer on.
    pub favicon: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// **Transport only**: the scheme is `https:`/`wss:`. It answers "is this
    /// connection encrypted", it does NOT answer "is this certificate trusted",
    /// and the UI must not draw it as if it did.
    pub secure: bool,
    /// The modal blocking the page right now, if any.
    pub dialog: Option<PageDialog>,
}

/// A running nav-state watcher: the pump task and the channel it publishes on.
///
/// A [`watch`] channel, not a [`broadcast`] one — the difference matters. Nav
/// state is *state*: a client attaching mid-page must be handed the current
/// value immediately, and a client that fell behind wants the latest one, not a
/// replay of every redirect hop. Frames are the opposite, which is why the
/// screencast pump next door is a broadcast.
struct NavWatcher {
    tx: watch::Sender<NavState>,
    pump: JoinHandle<()>,
}

/// A JSON string field, or `""`. The watcher parses browser output constantly
/// and every field of it is optional in practice.
fn str_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_string()
}

/// Does this URL's scheme mean the transport is encrypted?
///
/// URL-derived on purpose (v1): `Security.securityStateChanged` reports
/// certificate trust, which is a much stronger claim than the padlock this
/// feeds, and one we would then have to keep honest. `http:` is false,
/// `about:blank` is false — there is no encrypted connection to a page that was
/// never fetched, and claiming otherwise is exactly the fiction a padlock must
/// never tell.
pub fn secure_scheme(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("wss://")
}

/// `scheme://host[:port]` of an absolute URL — the favicon cache key.
///
/// String surgery rather than a URL parser by design: this decides only whether
/// to re-fetch an icon, so a URL it cannot read simply misses the cache and
/// costs one extra in-page `fetch`.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if scheme.is_empty() || host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// Is this event about the page's MAIN frame?
///
/// A subframe's load must never move the address bar or spin the spinner. An
/// *unknown* main frame — the window between the pump starting and its first
/// frame-tree read — counts as main, because dropping the first real signal
/// after attach would leave the bar blank until the human navigated again.
fn is_main_frame(params: &Value, key: &str, main: Option<&str>) -> bool {
    let Some(id) = params.get(key).and_then(Value::as_str) else {
        return main.is_none();
    };
    match main {
        Some(m) => m == id,
        None => true,
    }
}

/// **Does this frame's capture box disagree with the override we set?**
///
/// `metadata.deviceWidth/deviceHeight` is the box chrome captured in, and it is
/// supposed to be the box [`DeviceMetrics`] asked for. When a navigation drops
/// the override off the capture surface it comes back as the real window
/// instead, and the takeover canvas letterboxes that wide frame into a tall box
/// — the page in a short band at the top, background under it.
///
/// Pure, and deliberately conservative: metadata WITHOUT a usable box (a seed
/// still is a `Page.captureScreenshot` and carries none) is not evidence of
/// anything, so it is never a mismatch.
pub fn capture_mismatch(metadata: Option<&Value>, want: (u32, u32)) -> bool {
    let Some(meta) = metadata else {
        return false;
    };
    let px = |key: &str| meta.get(key).and_then(Value::as_f64).map(|v| v.round() as u32);
    let (Some(w), Some(h)) = (px("deviceWidth"), px("deviceHeight")) else {
        return false;
    };
    if w == 0 || h == 0 {
        return false;
    }
    (w, h) != want
}

/// **Is this `Page.frameNavigated` a MAIN-frame commit?**
///
/// Pure, and split out so the address bar's "is this my url" rule is one
/// testable thing. A frame with a `parentId` is an iframe and its url is not
/// the page's; a payload with no `frame` at all is not a commit we can reason
/// about. Both are "no".
fn main_frame_committed(params: &Value) -> bool {
    match params.get("frame") {
        Some(frame) => frame.get("parentId").is_none(),
        None => false,
    }
}

/// `Runtime.evaluate` on a flat-mode session, value or [`Value::Null`].
///
/// A free function because the pump owns no `&self`: it holds the client and the
/// session id directly so it can outlive nothing and borrow nothing.
async fn eval_on(client: &CdpClient, session: &str, expression: &str) -> Value {
    client
        .call_with_timeout(
            Some(session),
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
            }),
            NAV_READ_BUDGET,
        )
        .await
        .ok()
        .and_then(|v| v.get("result").and_then(|r| r.get("value")).cloned())
        .unwrap_or(Value::Null)
}

/// The `Emulation.setDeviceMetricsOverride` payload — **one builder**, shared by
/// the call that sets the override and the one that restores it after a
/// navigation, so the two can never drift.
fn device_metrics_params(width: u32, height: u32, scale: f64, mobile: bool) -> Value {
    json!({
        "width": width, "height": height,
        "deviceScaleFactor": scale, "mobile": mobile,
    })
}

/// The `userAgentMetadata` (UA Client Hints) that MUST ride alongside a
/// `setUserAgentOverride` — a UA string with no metadata leaves the high-entropy
/// hints (`Sec-CH-UA-Platform`, `-Mobile`) saying something the string
/// contradicts, and that mismatch is exactly the detection the module docs warn
/// about. Both variants keep the SAME Chromium brand + major as the pinned
/// binary ([`PINNED_CHROME_MAJOR`]); only the platform/model/`mobile` differ. The
/// GREASE `Not.A/Brand` entry mirrors stock Chrome's own low-entropy filler.
fn user_agent_metadata(mobile: bool) -> Value {
    let major = super::launch::PINNED_CHROME_MAJOR;
    let v = major.to_string();
    let fv = format!("{major}.0.0.0");
    let brands = json!([
        { "brand": "Chromium", "version": v },
        { "brand": "Google Chrome", "version": v },
        { "brand": "Not.A/Brand", "version": "24" },
    ]);
    let full_version_list = json!([
        { "brand": "Chromium", "version": fv },
        { "brand": "Google Chrome", "version": fv },
        { "brand": "Not.A/Brand", "version": "24.0.0.0" },
    ]);
    if mobile {
        json!({
            "brands": brands,
            "fullVersionList": full_version_list,
            "platform": "Android",
            "platformVersion": "13.0.0",
            "architecture": "",
            "model": "Pixel 7",
            "mobile": true,
            "bitness": "",
            "wow64": false,
        })
    } else {
        json!({
            "brands": brands,
            "fullVersionList": full_version_list,
            "platform": "Linux",
            "platformVersion": "",
            "architecture": "x86",
            "model": "",
            "mobile": false,
            "bitness": "64",
            "wow64": false,
        })
    }
}

/// **The override this target is running with, and the reason it is shared.**
///
/// A main-frame navigation silently un-sizes the CAPTURE. Measured against
/// Chrome 149 (headless=new): after a commit the document keeps its emulated
/// layout viewport — `innerWidth` is still 390 — but the screencast surface
/// reverts to the real `--window-size` window, so the very next frame arrives
/// 1366×757 with the mobile page drawn into its top-left corner. The takeover
/// canvas letterboxes that wide frame into a tall box and the human sees a
/// short band of page at the top with the box's background under it.
///
/// Nothing announces the drop and re-sending the SAME payload is a chrome
/// no-op, so it takes a clear-then-set to undo — which is
/// [`AgentContext::repair_capture`], fired by the takeover relay the moment a
/// frame's own box disagrees with this one ([`capture_mismatch`]). Kept whole
/// so that repair can re-issue the override verbatim rather than guess at it.
#[derive(Debug)]
struct DeviceMetrics {
    width: AtomicU32,
    height: AtomicU32,
    /// `f64::to_bits` — an atomic float without a mutex around it.
    scale: AtomicU64,
    mobile: AtomicBool,
}

impl DeviceMetrics {
    fn new(width: u32, height: u32, scale: f64, mobile: bool) -> Self {
        Self {
            width: AtomicU32::new(width),
            height: AtomicU32::new(height),
            scale: AtomicU64::new(scale.to_bits()),
            mobile: AtomicBool::new(mobile),
        }
    }

    fn store(&self, width: u32, height: u32, scale: f64, mobile: bool) {
        self.width.store(width, Ordering::Relaxed);
        self.height.store(height, Ordering::Relaxed);
        self.scale.store(scale.to_bits(), Ordering::Relaxed);
        self.mobile.store(mobile, Ordering::Relaxed);
    }

    /// The CSS-pixel box the page is laid out at.
    fn css(&self) -> (u32, u32) {
        (
            self.width.load(Ordering::Relaxed),
            self.height.load(Ordering::Relaxed),
        )
    }

    /// The payload that re-asserts this override, verbatim.
    fn cdp_params(&self) -> Value {
        let (width, height) = self.css();
        device_metrics_params(
            width,
            height,
            f64::from_bits(self.scale.load(Ordering::Relaxed)),
            self.mobile.load(Ordering::Relaxed),
        )
    }
}

/// A live per-agent browser context.
pub struct AgentContext {
    /// The lock subject — a session name for scratch, a `tb_…` tab id for a
    /// workspace tab.
    session: String,
    /// `Some(_)` ⇒ an isolated (incognito-equivalent) context we own and must
    /// dispose. `None` ⇒ the browser's DEFAULT context: the persistent profile,
    /// which is shared by every workspace tab and must NEVER be disposed.
    browser_context_id: Option<String>,
    target_id: String,
    cdp_session_id: String,
    client: Arc<CdpClient>,
    lock: DriveLock,
    /// The device-metrics override this target is laid out at — mirrored from
    /// every `Emulation.setDeviceMetricsOverride` we issue, which is
    /// authoritative because nothing else in the tree ever sets one. Atomic,
    /// not behind the screencast mutex, because the takeover seed reads it on a
    /// path with nothing to await. Kept whole (not just the CSS box) because
    /// [`AgentContext::repair_capture`] has to RE-ISSUE it verbatim.
    metrics: Arc<DeviceMetrics>,
    /// Live screencast pump, if one is running.
    screencast: Mutex<Option<Screencast>>,
    /// Live nav-state watcher, if one is running (P1-5).
    nav: Mutex<Option<NavWatcher>>,
    /// Which User-Agent override is currently applied: `-1` never touched (the
    /// launch `--user-agent` flag's pinned desktop UA + the binary's native
    /// UA-CH), `0` desktop override, `1` mobile override. Tracked so a viewport
    /// tick only issues `Emulation.setUserAgentOverride` when the mobile flag
    /// actually flips — the override persists across navigations, so re-sending
    /// it every negotiate would be pure chatter — and so a phone-first tab never
    /// needlessly overrides the clean native desktop UA-CH.
    ua_applied: AtomicI8,
}

struct Screencast {
    tx: broadcast::Sender<ScreencastFrame>,
    pump: JoinHandle<()>,
    /// The options this cast is RUNNING with. Kept so a second caller asking
    /// for a different profile is honoured instead of silently inheriting the
    /// first attacher's — see [`AgentContext::start_screencast`].
    options: ScreencastOptions,
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

        match Self::finish_create(
            client.clone(),
            session,
            Some(browser_context_id.as_str()),
            width,
            height,
            "about:blank",
        )
        .await
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

    /// **Open a page in the browser's DEFAULT (persistent) context** — the
    /// workspace path (v1 §2.3 R2 / §4.1).
    ///
    /// The one structural difference from [`create`](Self::create): it does
    /// **not** call `Target.createBrowserContext` at all. A `createTarget` with
    /// no `browserContextId` lands in the default context, which is the durable
    /// profile on disk, which is the human's cookie jar. That is the entire
    /// mechanism by which a login survives a tab close, an idle reap, a Chrome
    /// crash and a `systemctl restart`.
    ///
    /// `subject` is the lock subject (a tab id here, not a session name), and
    /// `url` is where the page opens — a rehydrating tab reopens at its stored
    /// URL rather than at `about:blank`.
    pub async fn create_in_default_context(
        client: Arc<CdpClient>,
        subject: &str,
        width: u32,
        height: u32,
        url: &str,
    ) -> Result<Self> {
        // No createBrowserContext, and therefore nothing to dispose if
        // `finish_create` fails halfway — its own `closeTarget` on the way out
        // is not needed either, because a failed createTarget leaves no target.
        Self::finish_create(client, subject, None, width, height, url).await
    }

    async fn finish_create(
        client: Arc<CdpClient>,
        session: &str,
        browser_context_id: Option<&str>,
        width: u32,
        height: u32,
        url: &str,
    ) -> Result<Self> {
        let mut params = json!({ "url": url });
        // Present ⇒ isolated context. ABSENT ⇒ the default, persistent one.
        //
        // `width`/`height` ride along ONLY on the isolated path, unchanged. In
        // the default context Chrome refuses them outright ("Target position can
        // only be set for new windows" — measured against Chrome 149), and they
        // buy nothing there: the viewport is per-target and is pinned below with
        // `Emulation.setDeviceMetricsOverride` either way (gotcha #11).
        if let Some(bcid) = browser_context_id {
            params["browserContextId"] = json!(bcid);
            params["width"] = json!(width);
            params["height"] = json!(height);
        }
        let target = client.call("Target.createTarget", params).await?;
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
            browser_context_id: browser_context_id.map(str::to_string),
            target_id,
            cdp_session_id,
            client,
            lock: DriveLock::new(session),
            metrics: Arc::new(DeviceMetrics::new(width, height, 1.0, false)),
            screencast: Mutex::new(None),
            nav: Mutex::new(None),
            ua_applied: AtomicI8::new(-1),
        };
        // Domains we need events + evaluation from.
        me.session_call("Page.enable", json!({})).await?;
        me.session_call("Runtime.enable", json!({})).await?;
        // Passkeys are a dead end in this browser — say so at the API, once, for
        // every frame, before any page script runs. See [`NO_PASSKEYS_JS`].
        me.disable_passkeys().await;
        // `--window-size` is a browser-wide default; the viewport is per-target
        // (gotcha #11), so pin it here.
        me.session_call("Emulation.setDeviceMetricsOverride", me.metrics.cdp_params())
            .await?;
        // …and only NOW go where the caller asked, so the real document is the
        // first one the page-setup script above has ever covered.
        Ok(me)
    }

    /// **Turn the passkey ceremony off at the API** for every frame of this page.
    ///
    /// Measured: a Google sign-in in the shared browser reaches *"Verifying it's
    /// you — complete sign-in using your passkey"* and **hangs there forever**.
    /// A WebAuthn ceremony needs a platform authenticator (Touch ID, Windows
    /// Hello, a phone) that a headless-shell-less, CDP-driven Chrome on a server
    /// simply does not have; `navigator.credentials.get()` returns a promise
    /// nobody will ever settle. The page blocks, "Try another way" is dead, and
    /// it is dead for the HUMAN on takeover too — so the tab cannot be signed in
    /// at all, by anyone, which is the worst failure mode a shared browser has.
    ///
    /// The fix is to stop pretending. Two halves, both needed:
    ///
    ///   * **advertise no authenticator** — `isUserVerifyingPlatformAuthenticator\
    ///     Available()` and `isConditionalMediationAvailable()` resolve `false`,
    ///     which is the honest answer and is what providers feature-detect on.
    ///     Google reads it and offers the password path INSTEAD of a passkey, so
    ///     the good case is that the ceremony never starts;
    ///   * **fail fast if one starts anyway** — `credentials.get`/`create` reject
    ///     with a `NotAllowedError` `DOMException`, the exact error a real user
    ///     cancelling the OS prompt produces. Every provider already has a
    ///     fallback path for it, so the page degrades to password/code in
    ///     milliseconds instead of hanging.
    ///
    /// `NotAllowedError` is chosen deliberately over throwing something novel: a
    /// bespoke error is an unhandled rejection on the site's happy path, and an
    /// unhandled rejection hangs the flow just as thoroughly as the promise did.
    ///
    /// Non-WebAuthn credentials still work — the shim delegates any `get()` that
    /// carries no `publicKey` (password / federated / OTP) to the real
    /// implementation, so autofill and one-tap sign-ins are untouched.
    ///
    /// `Page.addScriptToEvaluateOnNewDocument` runs it before ANY page script in
    /// every frame including cross-origin iframes (the IdP is usually one), which
    /// is why this is not an `evaluate` after navigation. Best-effort: a Chrome
    /// that rejects the command leaves the page exactly as it is today, so this
    /// can never fail a launch.
    async fn disable_passkeys(&self) {
        // Registered for every document this page loads FROM NOW ON, in every
        // frame including the cross-origin iframe an IdP usually lives in.
        if let Err(e) = self
            .session_call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": NO_PASSKEYS_JS }),
            )
            .await
        {
            tracing::warn!(
                session = %self.session,
                error = %e,
                "browser: could not disable passkeys on this page; a WebAuthn prompt may hang"
            );
        }
        // …and once, now, for the document the target was CREATED with.
        // `Target.createTarget {url}` starts loading before we can attach, so the
        // very first document is the one the registration above cannot reach
        // (measured: the probe page reported no shim at all and
        // `credentials.get()` hung). Opening the target blank and navigating
        // afterwards would close that gap perfectly, but it pushes a history
        // entry the human sees as a live Back button on a fresh tab, and
        // resetting it races the commit — so this is the honest trade: the first
        // document is covered best-effort here, every navigation after it is
        // covered unconditionally above, and a sign-in flow is always the latter.
        let _ = self
            .session_call(
                "Runtime.evaluate",
                json!({ "expression": NO_PASSKEYS_JS, "returnByValue": true }),
            )
            .await;
    }

    // ── identity ────────────────────────────────────────────────────────────

    /// The supermux session name this context belongs to.
    pub fn session(&self) -> &str {
        &self.session
    }
    /// The CDP `browserContextId` (the isolation boundary), or `None` for a page
    /// in the DEFAULT persistent context — a workspace tab, whose jar is the
    /// profile on disk.
    pub fn browser_context_id(&self) -> Option<&str> {
        self.browser_context_id.as_deref()
    }

    /// Is this page in the persistent (default) context? True for a workspace
    /// tab, false for an agent-scratch context.
    pub fn is_persistent(&self) -> bool {
        self.browser_context_id.is_none()
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
        let events = self.client.subscribe();
        let result = self
            .session_call("Page.navigate", json!({ "url": url }))
            .await?;
        if let Some(err) = result.get("errorText").and_then(Value::as_str) {
            return Err(BrowserError::Protocol {
                method: "Page.navigate".into(),
                message: format!("{url}: {err}"),
            });
        }
        self.await_nav(events, &["Page.loadEventFired"], url).await;
        Ok(())
    }

    /// Wait (bounded) for one of `methods` on THIS page.
    ///
    /// `events` must have been subscribed **before** the command that will
    /// produce them — that ordering is the whole point, and the reason this
    /// takes a receiver instead of making one: a fast load that lands between
    /// the command and a subscribe is a caller that waits out the full budget
    /// for an event it already missed.
    ///
    /// Never an error: navigation was *started* regardless, and this only bounds
    /// how long the caller blocks. A slow third-party page must not wedge a tool
    /// call or an HTTP handler.
    async fn await_nav(
        &self,
        mut events: broadcast::Receiver<CdpEvent>,
        methods: &[&str],
        what: &str,
    ) {
        let want = self.cdp_session_id.clone();
        let waited = tokio::time::timeout(LOAD_BUDGET, async {
            loop {
                match events.recv().await {
                    Ok(ev) => {
                        if ev.session_id.as_deref() == Some(want.as_str())
                            && methods.contains(&ev.method.as_str())
                        {
                            return;
                        }
                    }
                    // Lagged: we may have missed the event, so stop waiting
                    // rather than hang until the budget expires.
                    Err(broadcast::error::RecvError::Lagged(_)) => return,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        })
        .await;
        if waited.is_err() {
            debug!(session = %self.session, what, "browser: nav event not seen within budget");
        }
    }

    // ── navigation controls (P1-4) ──────────────────────────────────────────
    //
    // Gated exactly like every other mutating verb, so they inherit the drive
    // lock for free: an agent is refused while a human holds the wheel, and
    // `Actor::Human` always passes (that IS the escalation path).

    /// Reload the page. `ignore_cache` is the hard reload a human means when the
    /// soft one did not fix it.
    pub async fn reload(&self, actor: Actor, ignore_cache: bool) -> Result<()> {
        self.lock.gate(actor)?;
        let events = self.client.subscribe();
        self.session_call("Page.reload", json!({ "ignoreCache": ignore_cache }))
            .await?;
        self.await_nav(events, &["Page.loadEventFired"], "reload")
            .await;
        Ok(())
    }

    /// Stop the in-flight load — the X next to the address bar.
    ///
    /// Does not wait for anything: "stop" is finished the moment Chrome accepts
    /// it, and the page it leaves behind is whatever had already arrived.
    pub async fn stop(&self, actor: Actor) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call("Page.stopLoading", json!({}))
            .await
            .map(|_| ())
    }

    /// The back/forward stack. **Ungated**: reading where a page has been is an
    /// observation, exactly like [`current_url`](Self::current_url).
    pub async fn history(&self) -> Result<NavHistory> {
        let out = self
            .session_call("Page.getNavigationHistory", json!({}))
            .await?;
        Ok(NavHistory::from_cdp(&out))
    }

    /// Step `delta` entries through the page's own history.
    ///
    /// `Ok(false)` ⇒ **there was no entry there** — the honest answer to "back"
    /// on the first page of a stack, and deliberately not an error: a UI that
    /// showed a red toast for pressing Back at the start of history would be
    /// lying about what went wrong.
    pub async fn go(&self, actor: Actor, delta: i64) -> Result<bool> {
        self.lock.gate(actor)?;
        let Some(entry_id) = self.history().await?.entry_at_delta(delta) else {
            return Ok(false);
        };
        let events = self.client.subscribe();
        self.session_call(
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry_id }),
        )
        .await?;
        // The WIDER event set: a bfcache restore never re-parses the document
        // and so never fires `load` (see `HISTORY_DONE`).
        self.await_nav(events, &HISTORY_DONE, "history").await;
        Ok(true)
    }

    /// Answer the modal the page has opened (`Page.handleJavaScriptDialog`).
    ///
    /// **Not gated on the drive lock's human/agent split beyond the usual
    /// `gate`**, and load-bearing for the human path: an `alert()` blocks the
    /// renderer outright, so a viewer with no way to dismiss one is a viewer
    /// watching a permanently frozen page.
    pub async fn handle_dialog(
        &self,
        actor: Actor,
        accept: bool,
        prompt_text: Option<&str>,
    ) -> Result<()> {
        self.lock.gate(actor)?;
        let mut params = json!({ "accept": accept });
        if let Some(text) = prompt_text {
            params["promptText"] = json!(text);
        }
        self.session_call("Page.handleJavaScriptDialog", params)
            .await
            .map(|_| ())
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

    /// **The cookies the browser would send to THIS page**, straight from the
    /// jar — httpOnly auth cookies included, which `document.cookie` can never
    /// see (measured: a test jar's httpOnly `sid` is invisible to it while a
    /// 5-minute `shortcsrf` is not).
    ///
    /// No `urls` argument on purpose: CDP defaults to the page's own frame
    /// URLs, so a `browser_tabs.url` row that has drifted from where the page
    /// actually is cannot mis-target the read.
    ///
    /// Needs **no `Network.enable`** — measured on the pinned Chrome 149, the
    /// flat page session answers with the Network domain disabled. Read-only,
    /// and ungated for exactly the reason [`Self::evaluate`] is.
    pub async fn cookies(&self) -> Result<Vec<Value>> {
        let out = self.session_call("Network.getCookies", json!({})).await?;
        Ok(out
            .get("cookies")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
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

    /// Resize this target's viewport (per-target, not browser-wide) at 1:1.
    pub async fn set_viewport(
        &self,
        actor: Actor,
        width: u32,
        height: u32,
        mobile: bool,
    ) -> Result<()> {
        self.set_viewport_scaled(actor, width, height, 1.0, mobile)
            .await
    }

    /// The same override, **at the viewer's device pixel ratio** — the call
    /// that makes a shared browser legible.
    ///
    /// Two distinct things happen here and both matter:
    ///
    /// * `width`/`height` decide how the PAGE LAYS OUT. A 390px box gets the
    ///   site's mobile layout; a 1200px box gets the desktop one. Streaming a
    ///   1366px render to a 390px phone is not the same picture shrunk — it is
    ///   the wrong page.
    /// * `deviceScaleFactor` decides how SHARP it is. Chrome composites
    ///   `width × scale` real pixels, so a retina viewer asking for its own box
    ///   gets a frame with its own pixels in it rather than an upscale of a
    ///   CSS-pixel render. Clamped to [`MAX_DEVICE_SCALE`]: the cost is
    ///   quadratic and the benefit stops at one frame pixel per screen pixel.
    ///
    /// `Actor::Human` is never refused by the lock, deliberately: a person
    /// whose window is 390px wide must be able to make the page lay out at
    /// 390px even while an agent holds the wheel, because the alternative is a
    /// picture they cannot read. It is the same escalation rule the input relay
    /// runs on.
    pub async fn set_viewport_scaled(
        &self,
        actor: Actor,
        width: u32,
        height: u32,
        dpr: f64,
        mobile: bool,
    ) -> Result<()> {
        self.lock.gate(actor)?;
        let (width, height) = (width.max(1), height.max(1));
        let scale = if dpr.is_finite() {
            dpr.clamp(1.0, MAX_DEVICE_SCALE)
        } else {
            1.0
        };
        self.session_call(
            "Emulation.setDeviceMetricsOverride",
            device_metrics_params(width, height, scale, mobile),
        )
        .await?;
        // Stored only once chrome has taken it, so `viewport_css` — and the
        // repair that re-issues these same values — can never publish a box the
        // page was refused.
        self.metrics.store(width, height, scale, mobile);
        // A phone VIEWPORT is not enough for UA-sniffing sites (Google): they
        // pick mobile-vs-desktop off the User-Agent, which `setDeviceMetricsOverride`
        // never touches. Match the UA to the viewport's mobile flag so they serve
        // the mobile layout the human is looking at.
        self.apply_user_agent(mobile).await?;
        Ok(())
    }

    /// **Point the User-Agent (string + UA-CH) at the viewport's mobile flag.**
    ///
    /// Only issues a CDP call when the flag actually flips (`ua_applied`), because
    /// the override persists across navigations. A phone-first tab that never
    /// shows a desktop viewer keeps the launch flag's pinned desktop UA and the
    /// binary's clean native UA-CH untouched; the desktop override is written only
    /// to UNDO a previous mobile one, and then string + metadata are switched
    /// together so the UA-CH never contradicts the string (the drift the module
    /// docs call a detection, not a cosmetic bug).
    ///
    /// NOTE: the UA rides the navigation REQUEST, so a page ALREADY loaded under
    /// the old UA keeps its layout until the next navigation/reload — the caller's
    /// concern, not this method's.
    async fn apply_user_agent(&self, mobile: bool) -> Result<()> {
        let want: i8 = i8::from(mobile);
        let prev = self.ua_applied.load(Ordering::Relaxed);
        if prev == want {
            return Ok(());
        }
        // Never touched + desktop wanted: the launch `--user-agent` already serves
        // the pinned desktop UA with the binary's native (clean) UA-CH. Overriding
        // it would only risk drift, so just record the state and leave it.
        if prev == -1 && !mobile {
            self.ua_applied.store(0, Ordering::Relaxed);
            return Ok(());
        }
        let ua = if mobile {
            super::launch::CHROME_USER_AGENT_MOBILE
        } else {
            super::launch::CHROME_USER_AGENT
        };
        self.session_call(
            "Emulation.setUserAgentOverride",
            json!({
                "userAgent": ua,
                "acceptLanguage": "en-US,en;q=0.9",
                "platform": if mobile { "Android" } else { "Linux" },
                "userAgentMetadata": user_agent_metadata(mobile),
            }),
        )
        .await?;
        self.ua_applied.store(want, Ordering::Relaxed);
        Ok(())
    }

    /// The CSS-pixel box this target is currently laid out at.
    ///
    /// Free (no CDP round trip) and always true, because it mirrors the only
    /// `setDeviceMetricsOverride` any code path here issues. The takeover seed
    /// uses it to send a real `width`/`height` and a real `metadata` box
    /// **before frame #1**, so the input clamp is right from the first click
    /// instead of from whenever the page next repaints — which on a static page
    /// is never.
    pub fn viewport_css(&self) -> (u32, u32) {
        self.metrics.css()
    }

    /// **Put the CAPTURE back at the box the page is laid out at.**
    ///
    /// A main-frame commit drops the emulated size off the capture surface
    /// while leaving it on the document (see [`DeviceMetrics`]) — the frames
    /// come back window-shaped with the page drawn into a corner of them, and
    /// the takeover canvas letterboxes that into a band with background under
    /// it. Nothing observes the drop, so the caller detects it from a frame
    /// ([`capture_mismatch`]) and calls this.
    ///
    /// **CLEAR, then set.** Chrome ignores a `setDeviceMetricsOverride` whose
    /// payload equals the override it already believes it is running, and that
    /// is exactly the state the drop leaves behind: the emulation is still
    /// "on" with our numbers, only the capture forgot. Re-sending the same
    /// payload is then a no-op — measured — and the band stays. Clearing first
    /// makes the set a real change.
    ///
    /// Ungated: this is a restoration of an override an actor already passed
    /// the lock to set, not a new claim on the page.
    pub async fn repair_capture(&self) -> Result<()> {
        self.session_call("Emulation.clearDeviceMetricsOverride", json!({}))
            .await?;
        self.session_call("Emulation.setDeviceMetricsOverride", self.metrics.cdp_params())
            .await?;
        Ok(())
    }

    // ── screencast (phase 2 consumes this) ──────────────────────────────────

    /// Start (or re-subscribe to) this context's screencast and return a
    /// receiver of frames.
    ///
    /// The pump acks each frame right after fanning it out. Acking is
    /// **mandatory** — without it Chrome delivers ~3 frames and stalls — and it
    /// doubles as free backpressure (spike gotcha #2). Phase 2 may move the ack
    /// to "after the client socket accepted the frame"; the hook is one line.
    ///
    /// # Options are negotiable, not first-come
    ///
    /// This used to hand every later caller the running cast and drop their
    /// options on the floor, which made the profile a property of *whoever
    /// attached first*. A viewer telling us its screen size (the whole point of
    /// [`ScreencastOptions::drive`]) would then be answered with somebody
    /// else's 512px stream. Now:
    ///
    /// * same options ⇒ plain re-subscribe, as before;
    /// * different encoder options, same [`AckPolicy`] ⇒ chrome is stopped and
    ///   restarted with the new payload while the **pump and the channel stay
    ///   alive**, so existing subscribers keep their receiver (a fresh channel
    ///   would hand them `Closed`, which the takeover socket reads as "the
    ///   screencast died" and hangs up on the human);
    /// * a different ack policy ⇒ the pump itself is wrong (the policy is baked
    ///   in at spawn), so it is aborted and rebuilt below.
    pub async fn start_screencast(
        &self,
        actor: Actor,
        options: ScreencastOptions,
    ) -> Result<broadcast::Receiver<ScreencastFrame>> {
        self.lock.gate(actor)?;
        let mut slot = self.screencast.lock().await;
        // Copied out so no borrow of `slot` is alive across the awaits below.
        let running = slot.as_ref().map(|sc| (sc.tx.clone(), sc.options.clone()));
        if let Some((tx, current)) = running {
            if current == options {
                return Ok(tx.subscribe());
            }
            if current.ack == options.ack {
                self.session_call("Page.stopScreencast", json!({})).await?;
                self.session_call("Page.startScreencast", options.cdp_params())
                    .await?;
                if let Some(sc) = slot.as_mut() {
                    sc.options = options;
                }
                return Ok(tx.subscribe());
            }
            if let Some(old) = slot.take() {
                old.pump.abort();
            }
            self.session_call("Page.stopScreencast", json!({})).await?;
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

        self.session_call("Page.startScreencast", options.cdp_params())
            .await?;
        *slot = Some(Screencast { tx, pump, options });
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

    // ── the nav-state watcher (P1-5) ────────────────────────────────────────

    /// Subscribe to this page's live nav state, starting the watcher if it is
    /// not already running. **Ungated** — observing a page is never a conflict.
    ///
    /// Idempotent: every caller shares one pump and one channel, so a takeover
    /// socket attaching to a tab that already has a write-through consumer costs
    /// nothing extra. The receiver is handed the current value immediately
    /// (`watch` semantics), so a client that attaches to a page which has not
    /// moved in an hour still gets an address bar.
    ///
    /// # Where each field comes from
    ///
    /// | field | source |
    /// |---|---|
    /// | `url` | `Page.frameNavigated` (main frame) + `Page.navigatedWithinDocument` (SPA routing), confirmed by `Page.getNavigationHistory` on settle |
    /// | `loading` | `Page.frameStartedLoading` / `Page.frameStoppedLoading` |
    /// | `title` | `Target.targetInfoChanged` live, plus `document.title` on settle |
    /// | `favicon` | [`FAVICON_JS`] on settle — in-page, cached per origin |
    /// | `can_go_*` | `Page.getNavigationHistory` on settle |
    /// | `secure` | the URL scheme ([`secure_scheme`]) |
    /// | `dialog` | `Page.javascriptDialogOpening` / `…Closed` |
    pub async fn watch_nav(&self) -> Result<watch::Receiver<NavState>> {
        let mut slot = self.nav.lock().await;
        if let Some(w) = slot.as_ref() {
            return Ok(w.tx.subscribe());
        }
        // Subscribe BEFORE the enables, for the same reason `navigate` does:
        // an event that lands between them is an event nobody ever sees.
        let events = self.client.subscribe();
        // Titles without a round trip per navigation. Browser-level (it takes no
        // sessionId) and idempotent, so N tabs calling it is one setting. Its
        // events carry no `sessionId` either, which is why the pump filters
        // `Target.targetInfoChanged` on `targetId` instead.
        let _ = self
            .client
            .call("Target.setDiscoverTargets", json!({ "discover": true }))
            .await;

        let (tx, rx) = watch::channel(NavState::default());
        let pump = {
            let client = self.client.clone();
            let want = self.cdp_session_id.clone();
            let target = self.target_id.clone();
            let tx = tx.clone();
            tokio::spawn(nav_pump(client, want, target, tx, events))
        };
        *slot = Some(NavWatcher { tx, pump });
        Ok(rx)
    }

    /// The current nav state without starting a watcher — `None` when none is
    /// running. A read for callers that must not spawn machinery.
    pub async fn nav_now(&self) -> Option<NavState> {
        self.nav.lock().await.as_ref().map(|w| w.tx.borrow().clone())
    }

    /// Stop the nav-state watcher and drop its pump.
    pub async fn stop_nav(&self) {
        if let Some(w) = self.nav.lock().await.take() {
            w.pump.abort();
        }
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
        self.stop_nav().await;
        if let Err(e) = self
            .client
            .call("Target.closeTarget", json!({ "targetId": self.target_id }))
            .await
        {
            debug!(session = %self.session, error = %e, "browser: closeTarget");
        }
        // **Only a scratch context is disposed.** Disposing the DEFAULT context
        // would be a protocol error at best and would nuke every other workspace
        // tab — and the profile's cookies with them — at worst (v1 §2.3 R5). A
        // workspace tab closes with `closeTarget` and nothing else.
        let Some(bcid) = self.browser_context_id.as_deref() else {
            return;
        };
        if let Err(e) = self
            .client
            .call(
                "Target.disposeBrowserContext",
                json!({ "browserContextId": bcid }),
            )
            .await
        {
            debug!(session = %self.session, error = %e, "browser: disposeBrowserContext");
        }
    }
}

/// **The nav-state pump** — one per live page, modelled on the screencast pump
/// next door: subscribe once to the whole CDP event stream, filter on this
/// page's `sessionId`, fan out on one channel.
///
/// # The settle debounce is the design
///
/// The cheap signals (url, loading, dialog, title-from-`targetInfoChanged`) are
/// applied and published the instant they arrive — that is the spinner and the
/// address bar, and they must feel immediate. The **expensive** ones — a
/// history read, `document.title`, and an in-page favicon fetch — are deferred
/// until the page has been quiet for [`NAV_SETTLE`]. A redirect chain is then
/// three cheap url updates and *one* expensive read at the landing, instead of
/// three of each on pages that are moving anyway.
///
/// # A dialog freezes the reads, not the pump
///
/// `Runtime.evaluate` against a page blocked on `alert()` does not return until
/// the human answers. Running the settle there would hang the pump — and the
/// pump is the only thing that can tell the human a dialog is up. So while
/// `dialog` is set the settle publishes what it already knows and reads nothing.
async fn nav_pump(
    client: Arc<CdpClient>,
    want: String,
    target: String,
    tx: watch::Sender<NavState>,
    mut events: broadcast::Receiver<CdpEvent>,
) {
    let mut state = NavState::default();
    let mut main_frame: Option<String> = None;
    // The origin the current `favicon` was read for, so a same-site navigation
    // does not re-fetch an icon we already hold.
    let mut icon_origin: Option<String> = None;
    // `Some(deadline)` ⇒ a settle is pending. Seeded to "now" so the first thing
    // the pump does is read the page it attached to.
    let mut settle_at: Option<Instant> = Some(Instant::now());

    loop {
        let settle = async {
            match settle_at {
                Some(at) => tokio::time::sleep_until(at).await,
                // Nothing pending: park forever and let the event arm drive.
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            event = events.recv() => {
                let ev = match event {
                    Ok(ev) => ev,
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // Frames and nav events share one channel and frames are
                        // 60/s, so lagging here is normal. Re-settle rather than
                        // guess: whatever we missed, a fresh read is the truth.
                        debug!(dropped = n, "browser: nav pump lagged");
                        settle_at = Some(Instant::now() + NAV_SETTLE);
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let ours = ev.session_id.as_deref() == Some(want.as_str());
                let mut publish = false;
                match ev.method.as_str() {
                    "Page.frameNavigated" if ours => {
                        // A SUBFRAME navigation is neither the address bar nor
                        // a new capture surface.
                        if !main_frame_committed(&ev.params) {
                            continue;
                        }
                        let frame = ev.params.get("frame").cloned().unwrap_or(json!({}));
                        main_frame = frame.get("id").and_then(Value::as_str).map(str::to_string);
                        let url = str_of(frame.get("url"));
                        if !url.is_empty() {
                            state.url = url;
                            state.secure = secure_scheme(&state.url);
                        }
                        publish = true;
                        settle_at = Some(Instant::now() + NAV_SETTLE);
                    }
                    "Page.navigatedWithinDocument" if ours => {
                        // SPA routing: same document, new address. No load event
                        // will ever fire for it, which is exactly why the bar
                        // has to be told here.
                        if !is_main_frame(&ev.params, "frameId", main_frame.as_deref()) {
                            continue;
                        }
                        let url = str_of(ev.params.get("url"));
                        if !url.is_empty() {
                            state.url = url;
                            state.secure = secure_scheme(&state.url);
                        }
                        publish = true;
                        settle_at = Some(Instant::now() + NAV_SETTLE);
                    }
                    "Page.frameStartedLoading" if ours => {
                        if is_main_frame(&ev.params, "frameId", main_frame.as_deref()) {
                            state.loading = true;
                            publish = true;
                        }
                    }
                    "Page.frameStoppedLoading" if ours => {
                        if is_main_frame(&ev.params, "frameId", main_frame.as_deref()) {
                            state.loading = false;
                            publish = true;
                            settle_at = Some(Instant::now() + NAV_SETTLE);
                        }
                    }
                    "Page.loadEventFired" if ours => {
                        state.loading = false;
                        publish = true;
                        settle_at = Some(Instant::now() + NAV_SETTLE);
                    }
                    "Page.javascriptDialogOpening" if ours => {
                        state.dialog = Some(PageDialog {
                            kind: str_of(ev.params.get("type")),
                            message: str_of(ev.params.get("message")),
                            default_prompt: str_of(ev.params.get("defaultPrompt")),
                        });
                        // Publish IMMEDIATELY and cancel any pending settle: the
                        // renderer is blocked from this instant, and this frame
                        // is the human's only way to learn it.
                        settle_at = None;
                        publish = true;
                    }
                    "Page.javascriptDialogClosed" if ours => {
                        state.dialog = None;
                        publish = true;
                        settle_at = Some(Instant::now() + NAV_SETTLE);
                    }
                    // Browser-level: no `sessionId`, so it is matched on the
                    // targetId instead. This is the free live title.
                    "Target.targetInfoChanged" => {
                        let info = ev.params.get("targetInfo").cloned().unwrap_or(json!({}));
                        if info.get("targetId").and_then(Value::as_str) != Some(target.as_str()) {
                            continue;
                        }
                        let title = str_of(info.get("title"));
                        // Chrome falls back to the URL as a target's "title"
                        // before the document has one; showing that in a title
                        // slot next to the address bar is a duplicate, not a
                        // title.
                        if !title.is_empty() && title != state.url {
                            state.title = title;
                            publish = true;
                        }
                    }
                    _ => continue,
                }
                if publish {
                    publish_nav(&tx, &state);
                }
            }

            () = settle => {
                settle_at = None;
                // See the doc comment: a blocked renderer answers no reads.
                if state.dialog.is_none() {
                    let read = client.call_with_timeout(
                        Some(&want),
                        "Page.getNavigationHistory",
                        json!({}),
                        NAV_READ_BUDGET,
                    );
                    if let Ok(v) = read.await {
                        let history = NavHistory::from_cdp(&v);
                        state.can_go_back = history.can_go_back();
                        state.can_go_forward = history.can_go_forward();
                        // Chrome's own idea of the current document beats a
                        // remembered `frameNavigated` after a history step.
                        if let Some(url) = history.current_url() {
                            if !url.is_empty() {
                                state.url = url.to_string();
                                state.secure = secure_scheme(url);
                            }
                        }
                    }
                    if main_frame.is_none() {
                        // Seed the main frame id so a subframe cannot spin the
                        // spinner for the rest of this page's life.
                        let read = client.call_with_timeout(
                            Some(&want),
                            "Page.getFrameTree",
                            json!({}),
                            NAV_READ_BUDGET,
                        );
                        if let Ok(v) = read.await {
                            main_frame = v
                                .pointer("/frameTree/frame/id")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                        }
                    }
                    if let Some(title) = eval_on(&client, &want, "document.title").await.as_str() {
                        state.title = title.to_string();
                    }
                    let origin = origin_of(&state.url);
                    // Re-read the icon only when the SITE moved. Same-site
                    // navigation keeps its icon, and this is a network fetch.
                    if origin.is_some() && (state.favicon.is_none() || icon_origin != origin) {
                        state.favicon = match eval_on(&client, &want, FAVICON_JS).await {
                            Value::String(uri)
                                if uri.starts_with("data:image/")
                                    && uri.len() <= MAX_FAVICON_BYTES =>
                            {
                                Some(uri)
                            }
                            // No icon, an unreadable one, or one too big to
                            // relay: say so, rather than keep the last site's.
                            _ => None,
                        };
                        icon_origin = origin;
                    } else if origin.is_none() {
                        state.favicon = None;
                        icon_origin = None;
                    }
                }
                publish_nav(&tx, &state);
            }
        }
    }
}

/// Publish only a state that actually CHANGED.
///
/// `watch` wakes every receiver on send, and the takeover socket turns each wake
/// into a WebSocket frame. Re-sending an identical state on every settle would
/// be a steady drip of frames that say nothing.
fn publish_nav(tx: &watch::Sender<NavState>, state: &NavState) {
    // Scoped so the read guard is released before the send takes the write one.
    let changed = { *tx.borrow() != *state };
    if changed {
        tx.send_replace(state.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── P1-4: the go-delta → entryId index math ─────────────────────────────

    fn history_of(current: i64, ids: &[i64]) -> NavHistory {
        NavHistory {
            current_index: current,
            entries: ids
                .iter()
                .map(|id| NavEntry {
                    id: *id,
                    url: format!("https://example.test/{id}"),
                    title: String::new(),
                })
                .collect(),
        }
    }

    /// The no-passkeys shim, pinned as source. The behaviour is proven against a
    /// real chrome in `api::tests::real_chrome_passkeys_fail_fast_…`; this is the
    /// cheap guard that the contract's load-bearing pieces cannot be edited away.
    #[test]
    fn the_no_passkeys_shim_denies_webauthn_and_spares_everything_else() {
        // `NotAllowedError` specifically: it is what a human cancelling the OS
        // prompt raises, so every provider already has a fallback for it. A
        // bespoke error would be an unhandled rejection — which hangs the flow
        // just as thoroughly as the promise this replaces.
        assert!(NO_PASSKEYS_JS.contains("'NotAllowedError'"));
        // Feature detection answers honestly, so the good case is that the
        // ceremony never starts and the provider offers the password path.
        assert!(NO_PASSKEYS_JS.contains("isUserVerifyingPlatformAuthenticatorAvailable"));
        assert!(NO_PASSKEYS_JS.contains("isConditionalMediationAvailable"));
        // Only WebAuthn is refused: a get()/create() with no `publicKey` is
        // password / federated / OTP autofill and must still reach the real impl.
        assert!(NO_PASSKEYS_JS.contains("options.publicKey"));
        assert!(NO_PASSKEYS_JS.contains("real(options)"), "non-WebAuthn calls reach the real impl");
        assert!(NO_PASSKEYS_JS.contains("proto.get.bind(creds)"));
        assert!(NO_PASSKEYS_JS.contains("proto.create.bind(creds)"));
        // The tag the real-chrome test uses to tell OUR refusal from Chrome's.
        assert!(NO_PASSKEYS_JS.contains("fn.__supermuxNoPasskeys = true"));
        // Never throw into the page.
        assert!(NO_PASSKEYS_JS.contains("catch (e)"));
    }

    #[test]
    fn a_history_step_resolves_to_the_neighbouring_entry_id() {
        // CDP has no relative `go`: back is `entries[current - 1].id`, and the
        // ids are NOT the indices — 40/41/42 here on purpose, because using the
        // index as the entryId is the bug this pins.
        let h = history_of(1, &[40, 41, 42]);
        assert_eq!(h.entry_at_delta(-1), Some(40));
        assert_eq!(h.entry_at_delta(1), Some(42));
        assert_eq!(h.entry_at_delta(-2), None, "off the front of the stack");
        assert_eq!(h.entry_at_delta(2), None, "off the back of the stack");
        assert!(h.can_go_back());
        assert!(h.can_go_forward());
    }

    #[test]
    fn the_ends_of_the_stack_are_a_none_not_a_wrap() {
        let first = history_of(0, &[40, 41]);
        assert_eq!(first.entry_at_delta(-1), None);
        assert!(!first.can_go_back());
        assert!(first.can_go_forward());

        let last = history_of(1, &[40, 41]);
        assert_eq!(last.entry_at_delta(1), None);
        assert!(last.can_go_back());
        assert!(!last.can_go_forward());
    }

    #[test]
    fn a_zero_delta_is_never_a_navigation() {
        // Re-entering the current entry is a reload with a different name, and
        // `reload` is the call that means it.
        assert_eq!(history_of(1, &[40, 41, 42]).entry_at_delta(0), None);
    }

    #[test]
    fn an_unreadable_history_offers_no_buttons_at_all() {
        // The default `currentIndex` is -1, not 0: a history we could not read
        // must not claim a first entry that may not exist, because
        // `can_go_back` on a lie is a button that navigates a human at random.
        let empty = NavHistory::from_cdp(&json!({}));
        assert_eq!(empty.current_index, -1);
        assert!(empty.entries.is_empty());
        assert!(!empty.can_go_back());
        assert!(!empty.can_go_forward());
        assert_eq!(empty.current_url(), None);
        // …and arithmetic on it cannot panic or wrap.
        assert_eq!(empty.entry_at_delta(-1), None);
        assert_eq!(empty.entry_at_delta(1), None);
        assert_eq!(empty.entry_at_delta(i64::MIN), None);
        assert_eq!(empty.entry_at_delta(i64::MAX), None);
    }

    #[test]
    fn a_cdp_history_parses_into_ids_urls_and_a_current_page() {
        let h = NavHistory::from_cdp(&json!({
            "currentIndex": 1,
            "entries": [
                { "id": 7, "url": "https://a.test/", "title": "A" },
                { "id": 9, "url": "https://b.test/x", "title": "B" },
                { "id": 11 },
            ],
        }));
        assert_eq!(h.current_index, 1);
        assert_eq!(h.entries.len(), 3);
        assert_eq!(h.entries[0].id, 7);
        assert_eq!(h.entries[1].title, "B");
        // A partial entry is empty strings, not a panic and not a dropped row —
        // dropping it would shift every index after it.
        assert_eq!(h.entries[2].url, "");
        assert_eq!(h.current_url(), Some("https://b.test/x"));
        assert_eq!(h.entry_at_delta(-1), Some(7));
        assert_eq!(h.entry_at_delta(1), Some(11));
    }

    // ── P1-5: the shape and the sourcing of nav state ───────────────────────

    #[test]
    fn the_padlock_is_a_transport_claim_and_nothing_more() {
        assert!(secure_scheme("https://example.test/x"));
        assert!(secure_scheme("HTTPS://EXAMPLE.TEST/"));
        assert!(secure_scheme("wss://example.test/socket"));
        assert!(!secure_scheme("http://example.test/x"));
        // No page was fetched, so there is no encrypted connection to claim.
        assert!(!secure_scheme("about:blank"));
        assert!(!secure_scheme(""));
        // A scheme that merely CONTAINS https is not https.
        assert!(!secure_scheme("javascript:void('https://')"));
    }

    #[test]
    fn the_favicon_cache_key_is_the_site_not_the_page() {
        // Same site, different page ⇒ same key ⇒ no re-fetch.
        assert_eq!(
            origin_of("https://a.test/one?q=1#f"),
            origin_of("https://a.test/two")
        );
        assert_eq!(origin_of("https://a.test:8443/x").as_deref(), Some("https://a.test:8443"));
        // A different scheme or host is a different site.
        assert_ne!(origin_of("https://a.test/"), origin_of("http://a.test/"));
        assert_ne!(origin_of("https://a.test/"), origin_of("https://b.test/"));
        // Nothing to key on ⇒ no cache, and the caller clears the icon.
        assert_eq!(origin_of("about:blank"), None);
        assert_eq!(origin_of(""), None);
        assert_eq!(origin_of("https://"), None);
    }

    #[test]
    fn a_subframe_never_moves_the_address_bar() {
        let main = json!({ "frameId": "F-main" });
        let sub = json!({ "frameId": "F-sub" });
        assert!(is_main_frame(&main, "frameId", Some("F-main")));
        assert!(!is_main_frame(&sub, "frameId", Some("F-main")));
        // Before the first frame-tree read we do not know which frame is main,
        // and dropping the first real signal after attach would leave the bar
        // blank until the human navigated again.
        assert!(is_main_frame(&sub, "frameId", None));
        // An event with no frame at all is only ours while nothing is known.
        assert!(is_main_frame(&json!({}), "frameId", None));
        assert!(!is_main_frame(&json!({}), "frameId", Some("F-main")));
    }

    #[test]
    fn the_favicon_is_read_inside_the_page_never_by_the_server() {
        // The invariant, pinned as text because it is a privacy property, not a
        // style one: the icon is fetched by the PAGE, with the page's own
        // credentials, so the request stays inside the profile's cookie jar and
        // the server's IP never appears on a URL the page chose.
        assert!(FAVICON_JS.contains("fetch("));
        assert!(FAVICON_JS.contains("credentials"));
        assert!(FAVICON_JS.contains("readAsDataURL"));
        assert!(FAVICON_JS.contains(r#"link[rel~="icon"]"#));
        assert!(FAVICON_JS.contains("/favicon.ico"));
        // Every failure mode degrades to `null`, never to an exception that
        // `evaluate` would turn into an error the human sees.
        assert!(FAVICON_JS.contains("catch"));
        // …and it never navigates the page it is reading.
        assert!(!FAVICON_JS.contains("location.href ="));
    }

    #[test]
    fn nav_state_is_the_shape_the_address_bar_parses() {
        let state = NavState {
            url: "https://example.test/inbox".into(),
            title: "Inbox".into(),
            favicon: Some("data:image/png;base64,AAA".into()),
            loading: false,
            can_go_back: true,
            can_go_forward: false,
            secure: true,
            dialog: Some(PageDialog {
                kind: "confirm".into(),
                message: "Discard?".into(),
                default_prompt: String::new(),
            }),
        };
        let v: Value = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert_eq!(v["url"], json!("https://example.test/inbox"));
        assert_eq!(v["title"], json!("Inbox"));
        assert_eq!(v["favicon"], json!("data:image/png;base64,AAA"));
        assert_eq!(v["loading"], json!(false));
        assert_eq!(v["can_go_back"], json!(true));
        assert_eq!(v["can_go_forward"], json!(false));
        assert_eq!(v["secure"], json!(true));
        assert_eq!(v["dialog"]["kind"], json!("confirm"));
        assert_eq!(v["dialog"]["message"], json!("Discard?"));
        assert_eq!(v["dialog"]["default_prompt"], json!(""));
        // An unknown icon is null, not "" — the client draws a placeholder for
        // one and a broken image for the other.
        let bare = serde_json::to_value(NavState::default()).unwrap();
        assert_eq!(bare["favicon"], Value::Null);
        assert_eq!(bare["dialog"], Value::Null);
    }

    #[tokio::test]
    async fn an_unchanged_nav_state_is_not_republished() {
        // `watch` wakes every receiver on send and the takeover socket turns
        // each wake into a WebSocket frame, so a settle that learned nothing
        // must be silent rather than a steady drip of identical frames.
        let (tx, mut rx) = watch::channel(NavState::default());
        let mut state = NavState {
            url: "https://a.test/".into(),
            ..NavState::default()
        };
        publish_nav(&tx, &state);
        assert!(rx.has_changed().unwrap());
        assert_eq!(rx.borrow_and_update().url, "https://a.test/");

        publish_nav(&tx, &state);
        assert!(!rx.has_changed().unwrap(), "identical state must not wake anyone");

        state.loading = true;
        publish_nav(&tx, &state);
        assert!(rx.has_changed().unwrap(), "a real change must");
    }

    /// **The black-band regression** (`fitFrame` letterboxing a 1366×757 frame
    /// into a 390×700 box). A main-frame commit un-sizes the capture, so
    /// [`AgentContext::repair_capture`] re-asserts the override — and it may
    /// only ever re-assert the box we actually set, byte for byte, or the
    /// repair becomes a second source of truth that drifts from the first.
    #[test]
    fn the_restore_payload_is_the_set_payload() {
        let m = DeviceMetrics::new(1366, 900, 1.0, false);
        assert_eq!(m.cdp_params(), device_metrics_params(1366, 900, 1.0, false));
        assert_eq!(m.css(), (1366, 900));

        // A phone takes the wheel: the restore has to follow, or the first
        // navigation puts the desktop capture back.
        m.store(390, 700, 2.0, true);
        assert_eq!(m.css(), (390, 700));
        let p = m.cdp_params();
        assert_eq!(p["width"], json!(390));
        assert_eq!(p["height"], json!(700));
        assert_eq!(p["deviceScaleFactor"], json!(2.0));
        assert_eq!(p["mobile"], json!(true));
        assert_eq!(p, device_metrics_params(390, 700, 2.0, true));
    }

    /// **The UA-CH must AGREE with the UA string**, or the high-entropy hints
    /// betray the spoof (the module docs' detection, not cosmetics). Both variants
    /// carry the pinned binary's Chromium major; only platform/`mobile` differ.
    #[test]
    fn the_user_agent_metadata_matches_the_pinned_major_and_the_viewport() {
        let major = super::super::launch::PINNED_CHROME_MAJOR.to_string();

        let mob = user_agent_metadata(true);
        assert_eq!(mob["mobile"], json!(true));
        assert_eq!(mob["platform"], json!("Android"));
        assert_eq!(mob["brands"][0]["version"], json!(major));
        assert_eq!(
            mob["fullVersionList"][1]["version"],
            json!(format!("{major}.0.0.0"))
        );

        let desk = user_agent_metadata(false);
        assert_eq!(desk["mobile"], json!(false));
        assert_eq!(desk["platform"], json!("Linux"));
        // Same brand major on both — only the platform/mobile flip.
        assert_eq!(desk["brands"][0]["version"], mob["brands"][0]["version"]);
    }

    /// **The signal the repair runs off.** A frame captured at a box that is
    /// not the box we laid the page out at IS the black band, one frame before
    /// a human can see it — so this predicate is the whole detector, and its
    /// false-positive cases matter: a seed still carries no metadata at all and
    /// must never be read as drift, or every attach would trigger a repair.
    #[test]
    fn a_frame_captured_at_the_wrong_box_is_the_black_band() {
        let want = (390, 700);
        assert!(!capture_mismatch(
            Some(&json!({ "deviceWidth": 390, "deviceHeight": 700 })),
            want
        ));
        // The measured failure: the document is still 390 wide but the capture
        // came back as the real window.
        assert!(capture_mismatch(
            Some(&json!({ "deviceWidth": 1366, "deviceHeight": 757 })),
            want
        ));
        // Height alone is enough — that is the axis the letterbox eats.
        assert!(capture_mismatch(
            Some(&json!({ "deviceWidth": 390, "deviceHeight": 757 })),
            want
        ));
        // CDP sends these as floats.
        assert!(!capture_mismatch(
            Some(&json!({ "deviceWidth": 390.0, "deviceHeight": 700.0 })),
            want
        ));
        // No metadata, no claim: a `Page.captureScreenshot` still carries none,
        // and a zero box is chrome saying nothing rather than saying zero.
        assert!(!capture_mismatch(None, want));
        assert!(!capture_mismatch(Some(&json!({})), want));
        assert!(!capture_mismatch(
            Some(&json!({ "deviceWidth": 0, "deviceHeight": 0 })),
            want
        ));
    }

    /// Only the MAIN frame's commit moves the address bar; a subframe's url is
    /// not the page's.
    #[test]
    fn only_a_main_frame_commit_moves_the_address_bar() {
        assert!(main_frame_committed(
            &json!({ "frame": { "id": "F1", "url": "https://nos.nl/" } })
        ));
        assert!(
            !main_frame_committed(
                &json!({ "frame": { "id": "F2", "parentId": "F1", "url": "https://ads.test/" } })
            ),
            "an iframe is not the page"
        );
        assert!(!main_frame_committed(&json!({})), "no frame, no commit");
    }

    #[test]
    fn the_cdp_payload_matches_the_profile() {
        let opts = ScreencastOptions::drive(1200, 800, 1.0);
        let p = opts.cdp_params();
        assert_eq!(p["format"], "jpeg");
        assert_eq!(p["quality"], json!(75));
        assert_eq!(p["maxWidth"], json!(1200));
        assert_eq!(p["maxHeight"], json!(800));
        assert_eq!(p["everyNthFrame"], json!(DRIVE_EVERY_NTH));
        // `everyNthFrame: 0` is a protocol error; the floor is enforced at the
        // payload, so no caller can construct one that stalls the cast.
        let zero = ScreencastOptions {
            every_nth_frame: 0,
            ..ScreencastOptions::watch()
        };
        assert_eq!(zero.cdp_params()["everyNthFrame"], json!(1));
    }

    #[test]
    fn the_drive_profile_is_the_viewers_real_pixels_capped() {
        // 1:1 laptop.
        let laptop = ScreencastOptions::drive(1366, 768, 1.0);
        assert_eq!((laptop.max_width, laptop.max_height), (1366, 768));
        // Retina: the cap is real pixels, or the frame is an upscale of a
        // CSS-pixel render and the text stays soft.
        let retina = ScreencastOptions::drive(700, 500, 2.0);
        assert_eq!((retina.max_width, retina.max_height), (1400, 1000));
        // The device-scale ceiling is a cost guard: rendering is quadratic in it.
        let phone = ScreencastOptions::drive(390, 400, 3.0);
        assert_eq!(phone.max_width, 780, "dpr clamped to MAX_DEVICE_SCALE");
        // A wall is still capped.
        let wall = ScreencastOptions::drive(4096, 4096, 2.0);
        assert_eq!(wall.max_width, ScreencastOptions::MAX_STREAM_PX);
        // Nonsense in, sane out.
        let bad = ScreencastOptions::drive(0, 0, f64::NAN);
        assert_eq!((bad.max_width, bad.max_height), (1, 1));
    }

    #[test]
    fn the_watch_profile_is_the_spikes_measured_default() {
        // The in-chat card's stream. If this moves, the agent-watch path
        // regressed — which this change is explicitly not allowed to do.
        assert_eq!(ScreencastOptions::watch(), ScreencastOptions::default());
        let w = ScreencastOptions::watch();
        assert_eq!((w.max_width, w.max_height, w.quality, w.every_nth_frame), (512, 512, 60, 1));
        // …and it is a DIFFERENT profile from any negotiated one, which is what
        // makes `start_screencast` restart the cast instead of re-subscribing.
        assert_ne!(ScreencastOptions::watch(), ScreencastOptions::drive(1200, 800, 1.0));
        assert_eq!(
            ScreencastOptions::drive(1200, 800, 1.0),
            ScreencastOptions::drive(1200, 800, 1.0),
            "same request ⇒ same options ⇒ a plain re-subscribe",
        );
    }

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
