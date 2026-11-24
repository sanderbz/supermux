//! Opt-in `live` frames on the chat WebSocket: what the pane shows RIGHT NOW.
//!
//! The transcript lags the pane by ~30 s, so a chat client that wants the
//! in-progress turn used to poll `GET /api/sessions/{n}/peek?ansi=1&lines=30`
//! once a second. This module pushes the same content instead, only when it
//! changes.
//!
//! ## Wire
//!
//! client→server (after `auth_ok`): `{"type":"live","enabled":true,"lines":30}`
//! to opt in (`lines` optional, default [`LINES_DEFAULT`], clamped to
//! [`LINES_MIN`]..=[`LINES_MAX`]; sending it again with another `lines` count
//! re-subscribes), `{"type":"live","enabled":false}` to opt out. Default is
//! off, so a socket that never sends it (the web client) sees no change.
//!
//! server→client:
//! `{"type":"live","ts_ms":<server ms>,"lines":[plain rows],"ansi":[same rows with SGR],"working":bool,"status":"<detector status>"}`
//!
//! ## Content
//!
//! ONE capture per tick through [`lifecycle::peek_ansi`] — the exact function
//! behind `GET /peek?ansi=1&lines=N`, so both runtimes (tmux and native) and the
//! 4 MiB peek cap apply unchanged. `lines` is that capture with the escapes
//! stripped, row for row, so the two arrays always have the same length. Rows
//! are dropped from the OLDEST end until the frame fits [`MAX_FRAME_BYTES`].
//!
//! ## When frames are sent
//!
//! The change signal is the session's existing [`PtyStream`] broadcast — the
//! one fan-out every terminal socket and the status detector's heartbeat already
//! ride, for tmux (`pipe-pane` FIFO) and native (holder spool) alike. A byte
//! batch marks the pane dirty; a dirty pane is captured at most once per
//! [`FLOOR`] (leading edge right away, trailing edge after the floor), and a
//! capture identical to the last one sent is not sent. A static pane costs
//! nothing: no bytes, no capture. A status change (the detector's
//! [`AppState::status_watch_for`] channel, the same one `agents::wait` uses)
//! also forces a capture, which is what delivers the final `working:false`.
//!
//! ## Cost
//!
//! One producer task per session, shared by every opted-in socket on it,
//! started by the first subscriber and gone when the last one leaves
//! ([`LiveHub`]). A session nobody watches live has no task, no capture and no
//! pty subscription. Each socket reads its frames from a `watch` channel, so a
//! slow socket only ever skips to the newest frame; nothing queues per socket.
//!
//! Remote (`host_id`) sessions never reach this: the chat socket refuses them
//! before `auth_ok`'s follow-ups are read. Both local runtimes are supported,
//! so there is no `unsupported` case today.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::json;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::{watch, Notify};
use tokio::time::Instant;

use crate::sessions::lifecycle;
use crate::state::{AppState, StatusUpdate};

/// Minimum gap between two captures (and so between two frames) of one session.
pub const FLOOR: Duration = Duration::from_millis(100);
/// `lines` when the client does not send one — the web's `/peek?lines=30`.
pub const LINES_DEFAULT: usize = 30;
/// Smallest accepted `lines` request.
pub const LINES_MIN: usize = 10;
/// Largest accepted `lines` request.
pub const LINES_MAX: usize = 60;
/// Byte budget for the row text of one frame (`lines` + `ansi` together).
/// A full 60-row history plus a tall, colourful screen is well under this; the
/// cap only exists so no pane can make one frame arbitrarily large.
pub const MAX_FRAME_BYTES: usize = 128 * 1024;
/// How often a producer retries the pty subscription while the session is not
/// running (stopped, restarting). Cheap: one liveness probe.
const RESUBSCRIBE_EVERY: Duration = Duration::from_secs(2);

/// The client's `lines` request, clamped. Missing or non-numeric = default.
pub fn clamp_lines(requested: Option<u64>) -> usize {
    match requested {
        Some(n) => (n.min(LINES_MAX as u64) as usize).max(LINES_MIN),
        None => LINES_DEFAULT,
    }
}

/// A client→server `live` frame, if `text` is one: `Some(Some(lines))` = opt in
/// with that (clamped) count, `Some(None)` = opt out, `None` = not a live frame.
pub fn parse_client_frame(text: &str) -> Option<Option<usize>> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("type")?.as_str()? != "live" {
        return None;
    }
    let enabled = v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
    Some(enabled.then(|| clamp_lines(v.get("lines").and_then(|l| l.as_u64()))))
}

/// Is the agent mid-turn? The detector's `active` is the one busy status; every
/// other value (`idle`, `waiting`, `stopped`, `starting`, `unknown`) is not.
pub fn is_working(status: &str) -> bool {
    status == "active"
}

/// CSI (SGR and friends) plus OSC (hyperlinks, titles) — what a `capture-pane -e`
/// or the native grid can put in a row.
static ESC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\x1b\[[0-9;?:<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
        .unwrap()
});

fn strip(row: &str) -> String {
    ESC_RE.replace_all(row, "").into_owned()
}

/// Split a capture into rows and drop the OLDEST rows until the frame fits.
fn rows_within_budget(raw: &str) -> Vec<String> {
    let mut rows: Vec<String> = raw.lines().map(str::to_string).collect();
    let mut total: usize = rows.iter().map(|r| r.len() + strip(r).len()).sum();
    let mut drop = 0;
    while total > MAX_FRAME_BYTES && drop < rows.len() {
        total -= rows[drop].len() + strip(&rows[drop]).len();
        drop += 1;
    }
    rows.drain(..drop);
    rows
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Serialize one frame. Done once per change per `lines` group and shared by
/// every socket in it.
pub fn frame_json(ansi_rows: &[String], status: &str) -> Arc<str> {
    let plain: Vec<String> = ansi_rows.iter().map(|r| strip(r)).collect();
    json!({
        "type": "live",
        "ts_ms": now_ms(),
        "lines": plain,
        "ansi": ansi_rows,
        "working": is_working(status),
        "status": status,
    })
    .to_string()
    .into()
}

// ── the session-facing seam ─────────────────────────────────────────────────

/// What a producer needs from a session. The production impl is [`PaneSource`];
/// tests drive the producer with a fake.
#[async_trait]
pub trait LiveSource: Send + Sync + 'static {
    /// A receiver of the pane's output bytes, or `None` while the session is
    /// not running. Only used as a change signal; the bytes are not parsed.
    async fn output(&self) -> Option<broadcast::Receiver<Bytes>>;
    /// The `/peek?ansi=1&lines=N` text. `None` = capture failed; skip the tick.
    async fn capture_ansi(&self, lines: usize) -> Option<String>;
    /// The detector's status channel.
    fn status_watch(&self) -> watch::Receiver<StatusUpdate>;
    /// The persisted status, for a channel that has not been written since
    /// this server started (it is seeded `"unknown"`).
    async fn persisted_status(&self) -> Option<String>;
}

/// The real session: the `/peek` capture, the shared pty stream, the detector's
/// status channel.
pub struct PaneSource {
    state: AppState,
    name: String,
}

impl PaneSource {
    pub fn new(state: AppState, name: String) -> Self {
        Self { state, name }
    }
}

#[async_trait]
impl LiveSource for PaneSource {
    async fn output(&self) -> Option<broadcast::Receiver<Bytes>> {
        // `pty_for` starts the reader if needed, but on a running session the
        // status detector has already started it every tick, so this joins the
        // existing stream. Probe liveness first so a stopped session never gets
        // a reader spun up on its behalf.
        let rt = self.state.runtime_for(&self.name).await.ok()?;
        if !rt.alive().await {
            return None;
        }
        let stream = self.state.pty_for(&self.name).await.ok()?;
        Some(stream.subscribe().1)
    }

    async fn capture_ansi(&self, lines: usize) -> Option<String> {
        lifecycle::peek_ansi(&self.state, &self.name, lines)
            .await
            .ok()
    }

    fn status_watch(&self) -> watch::Receiver<StatusUpdate> {
        self.state.status_watch_for(&self.name).subscribe()
    }

    async fn persisted_status(&self) -> Option<String> {
        crate::db::sessions::runtime(&self.state.pool, &self.name)
            .await
            .ok()
            .flatten()
            .map(|row| row.last_status)
            .filter(|s| !s.is_empty())
    }
}

// ── the hub ─────────────────────────────────────────────────────────────────

type FrameTx = watch::Sender<Option<Arc<str>>>;

struct Group {
    tx: FrameTx,
    subs: usize,
}

#[derive(Default)]
struct Inner {
    /// Opted-in sockets per requested `lines` count.
    groups: BTreeMap<usize, Group>,
    /// A producer task exists for this session.
    running: bool,
}

/// One session's live state: its subscriber groups and the producer's wake.
#[derive(Default)]
struct SessionLive {
    inner: Mutex<Inner>,
    /// Fired when the subscriber set changes.
    wake: Notify,
}

fn lock(m: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Registry of per-session producers. One process-wide instance ([`hub`]);
/// tests build their own.
#[derive(Default)]
pub struct LiveHub {
    sessions: DashMap<String, Arc<SessionLive>>,
}

/// The process-wide hub the chat socket uses.
pub fn hub() -> &'static Arc<LiveHub> {
    static HUB: OnceLock<Arc<LiveHub>> = OnceLock::new();
    HUB.get_or_init(|| Arc::new(LiveHub::default()))
}

impl LiveHub {
    /// Is a producer running for `name`?
    pub fn is_producing(&self, name: &str) -> bool {
        self.sessions
            .get(name)
            .is_some_and(|s| lock(&s.inner).running)
    }

    /// Opt one socket in. Starts the session's producer if this is the first
    /// subscriber; `source` is only called in that case.
    pub fn join(
        self: &Arc<Self>,
        name: &str,
        lines: usize,
        source: impl FnOnce() -> Arc<dyn LiveSource>,
    ) -> LiveSubscription {
        // The subscriber is added UNDER the map entry's lock — the same lock the
        // producer's exit (`remove_if`) takes — so a producer can never retire
        // a session a subscriber has just joined.
        let entry = self.sessions.entry(name.to_string()).or_default();
        let sess = entry.value().clone();
        let (rx, spawn) = {
            let mut inner = lock(&sess.inner);
            let group = inner.groups.entry(lines).or_insert_with(|| Group {
                tx: watch::channel(None).0,
                subs: 0,
            });
            group.subs += 1;
            let mut rx = group.tx.subscribe();
            // A group already streaming has the current frame: hand it over now
            // rather than waiting for the next change.
            if group.tx.borrow().is_some() {
                rx.mark_changed();
            }
            let spawn = !inner.running;
            inner.running = true;
            (rx, spawn)
        };
        drop(entry);
        sess.wake.notify_one();
        if spawn {
            tokio::spawn(run_producer(
                self.clone(),
                name.to_string(),
                sess.clone(),
                source(),
            ));
        }
        LiveSubscription { rx, sess, lines }
    }
}

/// One opted-in socket. Dropping it opts the socket out.
pub struct LiveSubscription {
    rx: watch::Receiver<Option<Arc<str>>>,
    sess: Arc<SessionLive>,
    lines: usize,
}

impl LiveSubscription {
    /// The next frame to send. Pending forever if the producer is gone (it is
    /// not, while this subscription exists).
    pub async fn next(&mut self) -> Arc<str> {
        loop {
            if self.rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
            if let Some(frame) = self.rx.borrow_and_update().clone() {
                return frame;
            }
        }
    }

    /// The (clamped) `lines` count this subscription streams.
    pub fn lines(&self) -> usize {
        self.lines
    }
}

impl Drop for LiveSubscription {
    fn drop(&mut self) {
        {
            let mut inner = lock(&self.sess.inner);
            if let Some(group) = inner.groups.get_mut(&self.lines) {
                group.subs = group.subs.saturating_sub(1);
                if group.subs == 0 {
                    inner.groups.remove(&self.lines);
                }
            }
        }
        self.sess.wake.notify_one();
    }
}

async fn recv_output(rx: &mut Option<broadcast::Receiver<Bytes>>) -> Result<(), RecvError> {
    match rx {
        Some(rx) => rx.recv().await.map(|_| ()),
        None => std::future::pending().await,
    }
}

/// The per-session producer. Exits when the last subscriber is gone.
async fn run_producer(
    hub: Arc<LiveHub>,
    name: String,
    sess: Arc<SessionLive>,
    src: Arc<dyn LiveSource>,
) {
    let mut status_rx = src.status_watch();
    let mut status = status_rx.borrow_and_update().0.clone();
    if status == "unknown" {
        if let Some(persisted) = src.persisted_status().await {
            status = persisted;
        }
    }
    let mut status_open = true;
    let mut output = src.output().await;
    let mut retry = tokio::time::interval(RESUBSCRIBE_EVERY);
    retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    retry.tick().await;

    let mut dirty = true;
    let mut last_capture: Option<Instant> = None;
    // What each group was last sent: (ansi rows, status).
    let mut last_sent: HashMap<usize, (Vec<String>, String)> = HashMap::new();

    loop {
        let groups: Vec<(usize, FrameTx)> = {
            let inner = lock(&sess.inner);
            inner
                .groups
                .iter()
                .map(|(l, g)| (*l, g.tx.clone()))
                .collect()
        };
        if groups.is_empty() {
            // Retire under the map entry's lock (see `join`): only if still no
            // subscriber, so a racing join either sees `running` still true and
            // relies on us, or arrives after removal and spawns a fresh producer.
            let retired = hub
                .sessions
                .remove_if(&name, |_, v| {
                    if !Arc::ptr_eq(v, &sess) {
                        return false;
                    }
                    let mut inner = lock(&v.inner);
                    if inner.groups.is_empty() {
                        inner.running = false;
                        true
                    } else {
                        false
                    }
                })
                .is_some();
            if retired {
                tracing::debug!(session = %name, "live producer stopped: no subscribers");
                return;
            }
            // Not retired: either a subscriber just joined (loop on), or this
            // session state is no longer the registered one, which no join can
            // reach any more — stop rather than spin.
            let mut inner = lock(&sess.inner);
            if inner.groups.is_empty() {
                inner.running = false;
                return;
            }
            continue;
        }
        last_sent.retain(|l, _| groups.iter().any(|(g, _)| g == l));
        // A group nobody has sent to yet (a new `lines` count) needs a capture.
        if groups.iter().any(|(l, _)| !last_sent.contains_key(l)) {
            dirty = true;
        }
        let due = last_capture.map(|t| t + FLOOR).unwrap_or_else(Instant::now);

        tokio::select! {
            _ = sess.wake.notified() => {}
            got = recv_output(&mut output) => match got {
                Ok(()) | Err(RecvError::Lagged(_)) => dirty = true,
                // The stream was rebuilt (session stop/restart): resubscribe
                // on the retry tick.
                Err(RecvError::Closed) => output = None,
            },
            changed = status_rx.changed(), if status_open => match changed {
                Ok(()) => {
                    status = status_rx.borrow_and_update().0.clone();
                    dirty = true;
                }
                Err(_) => status_open = false,
            },
            _ = retry.tick(), if output.is_none() => {
                output = src.output().await;
                if output.is_some() {
                    dirty = true;
                }
            }
            _ = tokio::time::sleep_until(due), if dirty => {
                dirty = false;
                last_capture = Some(Instant::now());
                for (lines, tx) in &groups {
                    let Some(raw) = src.capture_ansi(*lines).await else { continue };
                    let rows = rows_within_budget(&raw);
                    let unchanged = last_sent
                        .get(lines)
                        .is_some_and(|(r, s)| *r == rows && *s == status);
                    if unchanged {
                        continue;
                    }
                    tx.send_replace(Some(frame_json(&rows, &status)));
                    last_sent.insert(*lines, (rows, status.clone()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scripted pane: `screen` is what a capture returns, `out` is the byte
    /// signal, `status` the detector channel.
    struct Fake {
        screen: Mutex<String>,
        out: broadcast::Sender<Bytes>,
        status: watch::Sender<StatusUpdate>,
        captures: AtomicUsize,
    }

    impl Fake {
        fn new(screen: &str, status: &str) -> Arc<Self> {
            Arc::new(Self {
                screen: Mutex::new(screen.to_string()),
                out: broadcast::channel(64).0,
                status: watch::channel((status.to_string(), 0)).0,
                captures: AtomicUsize::new(0),
            })
        }
        /// The pane prints `screen`.
        fn print(&self, screen: &str) {
            *self.screen.lock().unwrap() = screen.to_string();
            let _ = self.out.send(Bytes::from_static(b"x"));
        }
        fn set_status(&self, s: &str) {
            self.status.send_modify(|v| {
                v.0 = s.to_string();
                v.1 += 1;
            });
        }
        fn captures(&self) -> usize {
            self.captures.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl LiveSource for Fake {
        async fn output(&self) -> Option<broadcast::Receiver<Bytes>> {
            Some(self.out.subscribe())
        }
        async fn capture_ansi(&self, _lines: usize) -> Option<String> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            Some(self.screen.lock().unwrap().clone())
        }
        fn status_watch(&self) -> watch::Receiver<StatusUpdate> {
            self.status.subscribe()
        }
        async fn persisted_status(&self) -> Option<String> {
            None
        }
    }

    fn src(f: &Arc<Fake>) -> impl FnOnce() -> Arc<dyn LiveSource> {
        let f = f.clone();
        move || f as Arc<dyn LiveSource>
    }

    fn parse(frame: &str) -> serde_json::Value {
        serde_json::from_str(frame).unwrap()
    }

    /// Let spawned tasks run without advancing (paused) time.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    async fn no_frame_within(sub: &mut LiveSubscription, d: Duration) -> bool {
        tokio::time::timeout(d, sub.next()).await.is_err()
    }

    #[test]
    fn client_frames_parse_and_clamp() {
        assert_eq!(
            parse_client_frame(r#"{"type":"live","enabled":true}"#),
            Some(Some(30))
        );
        assert_eq!(
            parse_client_frame(r#"{"type":"live","enabled":true,"lines":45}"#),
            Some(Some(45))
        );
        assert_eq!(
            parse_client_frame(r#"{"type":"live","enabled":true,"lines":1}"#),
            Some(Some(LINES_MIN))
        );
        assert_eq!(
            parse_client_frame(r#"{"type":"live","enabled":true,"lines":9999}"#),
            Some(Some(LINES_MAX))
        );
        assert_eq!(
            parse_client_frame(r#"{"type":"live","enabled":false}"#),
            Some(None)
        );
        assert_eq!(parse_client_frame(r#"{"type":"auth","token":"x"}"#), None);
        assert_eq!(parse_client_frame("not json"), None);
    }

    #[test]
    fn frame_carries_plain_and_ansi_rows_of_equal_length() {
        let rows = vec![
            "\x1b[1mhello\x1b[0m".to_string(),
            "\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\".to_string(),
        ];
        let v = parse(&frame_json(&rows, "active"));
        assert_eq!(v["type"], "live");
        assert_eq!(v["lines"], json!(["hello", "link"]));
        assert_eq!(v["ansi"].as_array().unwrap().len(), 2);
        assert_eq!(v["working"], true);
        assert!(v["ts_ms"].as_i64().unwrap() > 0);
        assert_eq!(parse(&frame_json(&rows, "idle"))["working"], false);
    }

    #[test]
    fn oversized_capture_keeps_the_newest_rows_under_budget() {
        let row = "y".repeat(1000);
        let raw = (0..400)
            .map(|i| format!("{i}{row}"))
            .collect::<Vec<_>>()
            .join("\n");
        let rows = rows_within_budget(&raw);
        let bytes: usize = rows.iter().map(|r| 2 * r.len()).sum();
        assert!(bytes <= MAX_FRAME_BYTES);
        assert!(rows.last().unwrap().starts_with("399"));
        assert!(rows.len() < 400);
    }

    #[tokio::test(start_paused = true)]
    async fn opt_in_gets_the_current_pane_then_only_changes() {
        let hub = Arc::new(LiveHub::default());
        let fake = Fake::new("one", "active");
        let mut sub = hub.join("s", 30, src(&fake));
        let first = parse(&sub.next().await);
        assert_eq!(first["lines"], json!(["one"]));
        assert_eq!(first["working"], true);

        // Static pane: no frame, and no capture either.
        let before = fake.captures();
        assert!(no_frame_within(&mut sub, Duration::from_secs(5)).await);
        assert_eq!(
            fake.captures(),
            before,
            "a static pane must not be captured"
        );

        // Bytes that do not change the rendered pane: captured, but not sent.
        fake.print("one");
        assert!(no_frame_within(&mut sub, Duration::from_secs(1)).await);

        fake.print("one\ntwo");
        assert_eq!(parse(&sub.next().await)["lines"], json!(["one", "two"]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_is_coalesced_to_the_floor() {
        let hub = Arc::new(LiveHub::default());
        let fake = Fake::new("0", "active");
        let mut sub = hub.join("s", 30, src(&fake));
        sub.next().await;
        let mut last = Instant::now();
        let mut frames = 0;
        // 50 updates, 10 ms apart: 500 ms of output.
        let writer = {
            let fake = fake.clone();
            tokio::spawn(async move {
                for i in 1..=50 {
                    fake.print(&i.to_string());
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
        };
        let mut last_body = String::new();
        while let Ok(f) = tokio::time::timeout(Duration::from_secs(1), sub.next()).await {
            let now = Instant::now();
            assert!(now - last >= FLOOR, "two frames {:?} apart", now - last);
            last = now;
            frames += 1;
            last_body = parse(&f)["lines"][0].as_str().unwrap().to_string();
        }
        writer.await.unwrap();
        assert!(
            frames <= 7,
            "500 ms of output at a 100 ms floor sent {frames} frames"
        );
        assert_eq!(
            last_body, "50",
            "the trailing edge must deliver the final pane"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn turn_end_sends_a_final_working_false_frame() {
        let hub = Arc::new(LiveHub::default());
        let fake = Fake::new("done.", "active");
        let mut sub = hub.join("s", 30, src(&fake));
        assert_eq!(parse(&sub.next().await)["working"], true);
        // The pane is unchanged; only the detector flips to idle.
        fake.set_status("idle");
        let fin = parse(&sub.next().await);
        assert_eq!(fin["working"], false);
        assert_eq!(fin["status"], "idle");
        assert_eq!(fin["lines"], json!(["done."]));
        assert!(no_frame_within(&mut sub, Duration::from_secs(5)).await);
    }

    #[tokio::test(start_paused = true)]
    async fn one_producer_per_session_and_it_stops_with_the_last_subscriber() {
        let hub = Arc::new(LiveHub::default());
        let fake = Fake::new("a", "idle");
        let mut a = hub.join("s", 30, src(&fake));
        let mut b = hub.join("s", 30, || panic!("a second producer must not be built"));
        a.next().await;
        b.next().await;
        assert!(hub.is_producing("s"));
        // Both sockets get the same change from one capture.
        let before = fake.captures();
        fake.print("b");
        assert_eq!(parse(&a.next().await)["lines"], json!(["b"]));
        assert_eq!(parse(&b.next().await)["lines"], json!(["b"]));
        assert_eq!(fake.captures(), before + 1);

        drop(a);
        settle().await;
        assert!(hub.is_producing("s"), "one subscriber left");
        drop(b);
        settle().await;
        assert!(!hub.is_producing("s"));
        assert!(
            hub.sessions.get("s").is_none(),
            "no state kept for an unwatched session"
        );
        // Output on an unwatched session costs nothing.
        let before = fake.captures();
        fake.print("c");
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(fake.captures(), before);

        // A later opt-in starts a fresh producer.
        let mut c = hub.join("s", 30, src(&fake));
        assert_eq!(parse(&c.next().await)["lines"], json!(["c"]));
        assert!(hub.is_producing("s"));
    }

    #[tokio::test(start_paused = true)]
    async fn opt_out_stops_frames_to_that_socket_only() {
        let hub = Arc::new(LiveHub::default());
        let fake = Fake::new("a", "active");
        let mut keep = hub.join("s", 30, src(&fake));
        let wide = hub.join("s", 60, || unreachable!());
        keep.next().await;
        drop(wide); // `{"type":"live","enabled":false}` drops the subscription
        settle().await;
        fake.print("b");
        assert_eq!(parse(&keep.next().await)["lines"], json!(["b"]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_joiner_gets_the_current_frame_immediately() {
        let hub = Arc::new(LiveHub::default());
        let fake = Fake::new("now", "active");
        let mut a = hub.join("s", 30, src(&fake));
        a.next().await;
        let captures = fake.captures();
        let mut b = hub.join("s", 30, || unreachable!());
        assert_eq!(parse(&b.next().await)["lines"], json!(["now"]));
        assert_eq!(fake.captures(), captures, "served from the shared frame");
    }
}
