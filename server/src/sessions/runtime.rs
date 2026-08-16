//! The per-session RUNTIME SEAM.
//!
//! Every live-terminal operation supermux performs on a session — spawn, send,
//! resize, capture, scrollback window, teardown — used to be a direct call on
//! [`Tmux`]. This module hoists that surface into one object-safe trait,
//! [`SessionRuntime`], so a second backend (the tmux-less
//! [`native`](super::native) pty holder) can slot in beside tmux without any
//! call site knowing which one it is talking to.
//!
//! **Zero behaviour change for tmux.** [`TmuxRuntime`] is pure one-line
//! delegation to today's [`Tmux`]: same argv, same ordering, same error text.
//! Nothing about the tmux path is re-implemented here, so the tmux tests in
//! `sessions::tmux` remain the authority on that behaviour.
//!
//! **Which runtime a session gets** is the `sessions.runtime` column (migration
//! 0024, `'tmux'` | `'native'`), resolved + cached by
//! [`crate::state::AppState::runtime_for`].
//!
//! **What deliberately did NOT move into the trait.** Pane-scoped tmux
//! operations — `resize_pane`, `resize_lead_pane`, `kill_pane`,
//! `list_pane_ids`, `pane_in_session` — stay on the concrete [`Tmux`] handle.
//! They exist only because Claude Agent Teams renders teammates as tmux
//! split-window panes; that is a tmux-shaped concept with no native analogue,
//! and a native session can never host a team (`teams::start` refuses the
//! conversion, `teams::resolve_lead_pane` short-circuits `None`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::watch;

use super::tmux::{parse_hist_info, Tmux};
use super::transport::Transport;

/// One window of tmux-authoritative scrollback, returned by
/// [`Tmux::capture_history_window`] for copy-mode-over-web. tmux is the single
/// source of truth for every row above the live viewport; the client renders
/// these rows in a read-only history term and never reflows them itself (tmux
/// owns reflow). `rows` are PHYSICAL rows (captured without `-J`) already
/// wrapped at `cols`, so 1 tmux row = 1 display row and historical + live rows
/// wrap identically. Serialized into the `history` WS response frame.
#[derive(serde::Serialize, Debug, Clone)]
pub struct HistoryWindow {
    /// The captured rows, top→bottom, ANSI-coloured (`-e`), physical (no `-J`).
    pub rows: Vec<String>,
    /// `#{history_size}` at capture time — the absolute-line-id anchor the
    /// client uses to keep the rendered history from sliding under live output.
    pub history_size: u32,
    /// Actual bottom-inclusive scrollback range served (clamped into range).
    pub start_offset: i64,
    /// Bottom of the served range (`<= -1`; `-1` = the row just above the
    /// visible top).
    pub end_offset: i64,
    /// `start` reached `-history_size` — no older rows exist (stop fetching).
    pub hit_top: bool,
    /// `#{pane_width}` the capture was taken at — the client's width-match guard
    /// discards rows whose width no longer matches its live grid.
    pub cols: u16,
    /// `history_size` has reached `#{history_limit}` — tmux now trims oldest
    /// lines as new ones land while the size stays flat, so absolute-line-id
    /// anchors silently shift. The client must stop trusting its cross-fetch
    /// cache while this is set (drop + re-anchor per fetch).
    pub at_limit: bool,
}

/// The complete live-terminal surface one supermux session needs, independent of
/// the backend that provides it.
///
/// Object-safe by construction (no generic methods, no `Self` in return
/// position) so call sites hold an `Arc<dyn SessionRuntime>` handed out by
/// [`crate::state::AppState::runtime_for`].
///
/// The 16 required methods are exactly the operations the tmux call-site audit
/// found across `ws/`, `sessions::lifecycle`, `sessions::auto_actions`,
/// `sessions::pty` and `sessions::mod`. Two further methods carry DEFAULT
/// bodies — they are tmux-shaped affordances that degrade to "not applicable"
/// for any other backend, so a new impl need not write them.
#[async_trait]
pub trait SessionRuntime: Send + Sync {
    // ── lifecycle ────────────────────────────────────────────────────────────

    /// Create the session's terminal: a detached process running `shell` with
    /// `dir` as its working directory and `env` injected into the pty.
    async fn spawn(&self, dir: &Path, env: &HashMap<String, String>, shell: &str) -> Result<()>;

    /// Is the session's terminal live? Best-effort and infallible by contract:
    /// any backend fault reads as "gone" so callers fail toward teardown rather
    /// than serving a dead pane.
    async fn alive(&self) -> bool;

    /// Tear the session's terminal down. Ok when it is already gone.
    async fn kill(&self) -> Result<()>;

    // ── input ────────────────────────────────────────────────────────────────

    /// Inject `text` literally — NO trailing Enter (callers send the key
    /// separately).
    async fn send_text(&self, text: &str) -> Result<()>;

    /// Send one named key (`Enter`, `C-c`, `Escape`, …). Not literal.
    async fn send_key(&self, key: &str) -> Result<()>;

    /// Paste `text` as ONE paste (never N keystrokes). `bracketed` requests
    /// bracketed-paste framing so the receiving app sees a single paste.
    async fn paste(&self, text: &str, bracketed: bool) -> Result<()>;

    /// Resize the session's viewport. Bounds are enforced by callers.
    async fn resize(&self, cols: u16, rows: u16) -> Result<()>;

    // ── capture ──────────────────────────────────────────────────────────────

    /// The last `lines` rows, PLAIN text (no SGR). Feeds the status detector.
    async fn capture_plain(&self, lines: usize) -> Result<String>;

    /// The last `lines` rows WITH SGR escapes preserved. Feeds the colour-true
    /// tile preview.
    async fn capture_ansi(&self, lines: usize) -> Result<String>;

    /// The CURRENT VISIBLE screen only (no scrollback), SGR preserved. Used to
    /// pre-fill a fresh reader's replay buffer so a subscriber that connects
    /// before any new byte flows sees the screen instead of a black pane.
    async fn capture_screen_ansi(&self) -> Result<String>;

    /// The entire scrollback as plain text — the `archive` dump.
    async fn capture_full(&self) -> Result<String>;

    /// The WS ATTACH SEED: full scrollback + the current visible screen, framed
    /// so the client's two-buffer (primary/alt) model lines up with the
    /// backend's, cursor included. See
    /// [`Tmux::capture_history_with_alt_screen_aware_visible`] for the framing
    /// contract and its bug history — the byte shape is part of the WS wire
    /// protocol.
    async fn seed(&self) -> Result<String>;

    /// One window of scrollback for copy-mode-over-web, bottom-inclusive at
    /// `end_offset` (`<= -1`), at most `count` rows.
    async fn history_window(&self, end_offset: i64, count: u32) -> Result<HistoryWindow>;

    /// `(history_size, cols)` for the WS `attach_meta` boundary frame. Infallible
    /// by contract: a probe failure degrades to `(0, 0)`, which the client reads
    /// as "no history yet" and re-inits on the next resync.
    async fn history_meta(&self) -> (u32, u16);

    // ── introspection ────────────────────────────────────────────────────────

    /// The pty's top-level process id (the agent runs as its child). `None` when
    /// the backend reports no process.
    async fn pane_pid(&self) -> Result<Option<u32>>;

    /// True when the program has exited but the terminal is still held open and
    /// capturable (tmux's `remain-on-exit` state).
    async fn dead(&self) -> Result<bool>;

    // ── provided (tmux-shaped affordances; default = "not applicable") ───────

    /// The external label this runtime is known by, surfaced in
    /// `StartResult.target` (`supermux-<name>` for tmux). Defaults to empty: a
    /// backend with no external multiplexer has no such handle.
    fn target(&self) -> String {
        String::new()
    }

    /// DIAGNOSTIC ONLY — the tmux session name this handle currently resolves
    /// to, used by the WS attach's cross-session-leak catcher. Defaults to
    /// `None` (a non-tmux runtime has no tmux session-name mapping, so the
    /// catcher simply has nothing to compare and stays silent).
    async fn resolved_session_name(&self) -> Option<String> {
        None
    }

    /// Pause required BETWEEN literal text and the `Enter` that submits it.
    ///
    /// tmux gets one for free: `send-keys <text>` and `send-keys Enter` are two
    /// forks, so the child sees two separate `read()`s. A backend that writes
    /// straight to the pty does not — text and `\r` arrive in ONE read, and
    /// Ink-style TUIs (Claude, Codex) classify that as a paste, turning the
    /// carriage return into a composer newline instead of a submit.
    ///
    /// Default `ZERO` keeps every tmux call site byte-for-byte and timing-for-
    /// timing identical; the native runtime overrides it. Callers apply it at
    /// EVERY text-then-Enter site (see `lifecycle::submit_gap`).
    fn submit_gap(&self) -> Duration {
        Duration::ZERO
    }

    /// Is the terminal sitting at its SHELL PROMPT (no program running in the
    /// foreground)? `None` = "can not tell", which every caller must treat as
    /// the historical behaviour.
    ///
    /// Exists so `start()` can refuse to type a launch command into a terminal
    /// that is already running the agent (which would inject `claude --resume …`
    /// into the live agent's composer). tmux keeps the default `None` — its
    /// behaviour is unchanged.
    async fn shell_is_foreground(&self) -> Option<bool> {
        None
    }

    /// A watch that TICKS whenever the backend re-attached to its terminal and
    /// rebuilt its grid from scratch, meaning every attached client's view is
    /// now stale and must be re-seeded. `None` for a backend that can not lose
    /// and re-acquire its terminal mid-session (tmux: the pane is the state).
    fn attach_generation(&self) -> Option<watch::Receiver<u64>> {
        None
    }

    /// WHY this session's terminal is gone, when the backend can PROVE it is
    /// gone without disturbing anything. `None` means "can not prove it" — the
    /// session is serving, or the backend simply has no such evidence.
    ///
    /// Exists because "is it alive?" is not enough to keep the UI honest: the
    /// status detector classifies off the CAPTURE and can only ever produce
    /// active/waiting/idle, so a terminal that dies MID-RUN keeps its last
    /// status forever unless something hands the detector a `Stopped` (see
    /// `auto_actions::tick`). The reason string is what turns a silent blank
    /// screen into "holder died: panic: …".
    ///
    /// Default `None` keeps the tmux path exactly as it was — its own
    /// "any → stopped" reconciliation is a separate, deliberately deferred
    /// concern.
    async fn death(&self) -> Option<TerminalDeath> {
        None
    }

    /// Is what `capture_*` returns right now AUTHORITATIVE — i.e. is it really
    /// this session's screen, rather than a placeholder the backend serves while
    /// it has no view of the terminal?
    ///
    /// `true` for tmux: `capture-pane` either reads the live pane or fails. The
    /// native backend answers `false` until its pump has attached at least once,
    /// because a fresh daemon holds an EMPTY grid and its capture calls
    /// deliberately do not block forever waiting for a holder that may be dead.
    /// Callers that PERSIST a capture (the detector's `last_capture` writeback)
    /// must skip it while this is false — otherwise a daemon restart overwrites
    /// every stored preview with blanks, which is what emptied the overview
    /// cards when a holder died.
    async fn capture_is_authoritative(&self) -> bool {
        true
    }
}

/// A proven, non-destructive verdict that a session's terminal is gone, plus the
/// human-readable reason ([`SessionRuntime::death`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalDeath {
    /// One short line, safe to render: `exited with status 0`,
    /// `panic: …`, `holder is gone (pid 1234 left no exit marker …)`.
    pub reason: String,
    /// The terminal did NOT end the ordinary way (a child that exited, an
    /// explicit stop) — it crashed, was killed, or vanished. Only an unexpected
    /// death earns the user a visible error badge; a normal exit is just
    /// `stopped`.
    pub unexpected: bool,
}

impl TerminalDeath {
    /// The ordinary ending: the child process exited with `code`.
    pub fn exited(code: i32) -> Self {
        Self {
            reason: format!("exited with status {code}"),
            unexpected: false,
        }
    }
}

/// The tmux backend: **pure delegation** to [`Tmux`]. Every method below is a
/// one-liner onto the identical `Tmux` call the pre-seam code made, so the tmux
/// path is byte-for-byte what it was.
///
/// Owns its `name` and `transport` (rather than borrowing, as `Tmux<'a>` does)
/// because the resolver hands out `Arc<dyn SessionRuntime>` values that outlive
/// any one call site. Constructing the borrowed [`Tmux`] per call is free — it
/// is three field moves, no allocation, no syscall.
///
/// `pane_id` pins the handle to a specific tmux pane (`%id`) instead of the
/// `supermux-<name>` session. The WS attach uses it for an Agent-Teams LEAD so
/// seed / history / meta read the lead's pane and not whichever pane tmux
/// currently considers active.
pub struct TmuxRuntime {
    name: String,
    transport: Arc<Transport>,
    pane_id: Option<String>,
}

impl TmuxRuntime {
    /// A LOCAL, session-targeted handle — the exact equivalent of
    /// `Tmux::new(name)`, which is what every non-WS call site used before the
    /// seam. Local on purpose: the pre-seam call sites in `lifecycle`,
    /// `auto_actions` and `sessions::mod` were all `Tmux::new` (local) even for
    /// a `host_id`-bearing row, and this slice must not change that.
    pub fn local(name: &str) -> Self {
        Self {
            name: name.to_string(),
            transport: Arc::new(Transport::Local),
            pane_id: None,
        }
    }

    /// A handle over an explicit transport, optionally pinned to a pane. Used by
    /// the WS attach path, which already resolved both before the seam existed
    /// (`Tmux::new_on` / `for_pane_on` / `for_pane`), so passing them through
    /// keeps that path byte-identical.
    pub fn on(transport: Option<Arc<Transport>>, name: &str, pane_id: Option<String>) -> Self {
        Self {
            name: name.to_string(),
            transport: transport.unwrap_or_else(|| Arc::new(Transport::Local)),
            pane_id,
        }
    }

    /// The borrowed [`Tmux`] handle this runtime delegates to. Session-targeted
    /// unless a `pane_id` was pinned.
    fn tmux(&self) -> Tmux<'_> {
        match &self.pane_id {
            None => Tmux::new_on(&self.transport, &self.name),
            Some(id) => Tmux::for_pane_on(&self.transport, &self.name, id.clone()),
        }
    }
}

#[async_trait]
impl SessionRuntime for TmuxRuntime {
    async fn spawn(&self, dir: &Path, env: &HashMap<String, String>, shell: &str) -> Result<()> {
        self.tmux().new_session(dir, env, shell).await
    }

    async fn alive(&self) -> bool {
        self.tmux().target_alive().await
    }

    async fn kill(&self) -> Result<()> {
        self.tmux().kill_session().await
    }

    async fn send_text(&self, text: &str) -> Result<()> {
        self.tmux().send_text(text).await
    }

    async fn send_key(&self, key: &str) -> Result<()> {
        self.tmux().send_key(key).await
    }

    async fn paste(&self, text: &str, bracketed: bool) -> Result<()> {
        self.tmux().paste_via_buffer(text, bracketed).await
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.tmux().resize(cols, rows).await
    }

    async fn capture_plain(&self, lines: usize) -> Result<String> {
        self.tmux().capture_pane(lines).await
    }

    async fn capture_ansi(&self, lines: usize) -> Result<String> {
        self.tmux().capture_pane_ansi(lines).await
    }

    async fn capture_screen_ansi(&self) -> Result<String> {
        self.tmux().capture_screen_ansi().await
    }

    async fn capture_full(&self) -> Result<String> {
        self.tmux().capture_full().await
    }

    async fn seed(&self) -> Result<String> {
        self.tmux()
            .capture_history_with_alt_screen_aware_visible()
            .await
    }

    async fn history_window(&self, end_offset: i64, count: u32) -> Result<HistoryWindow> {
        self.tmux().capture_history_window(end_offset, count).await
    }

    async fn history_meta(&self) -> (u32, u16) {
        // Same probe + same parser the WS used inline before the seam; only the
        // two fields `attach_meta` actually carries are returned.
        let info = self.tmux().pane_history_meta().await;
        let (history_size, cols, _alt, _limit) = parse_hist_info(&info);
        (history_size, cols)
    }

    async fn pane_pid(&self) -> Result<Option<u32>> {
        self.tmux().pane_pid().await
    }

    async fn dead(&self) -> Result<bool> {
        self.tmux().pane_dead().await
    }

    fn target(&self) -> String {
        self.tmux().target()
    }

    async fn resolved_session_name(&self) -> Option<String> {
        self.tmux().resolved_session_name().await
    }
}

/// The `runtime` column value for the historical tmux backend. Also the column
/// DEFAULT, so every pre-0024 row reads as this.
pub const RUNTIME_TMUX: &str = "tmux";
/// The `runtime` column value for the tmux-less native backend.
pub const RUNTIME_NATIVE: &str = "native";

/// Is `value` a runtime kind this build knows? Used by `sessions::create` to
/// reject anything else with a 400 before it reaches the INSERT.
pub fn valid_runtime(value: &str) -> bool {
    matches!(value, RUNTIME_TMUX | RUNTIME_NATIVE)
}

// ─────────────────────────────────────────────────────────────────────────────
// NATIVE HOOK — the single wiring point for the native-core slice.
// ─────────────────────────────────────────────────────────────────────────────

/// The native backend, adapting [`NativeSession`](super::native::NativeSession)
/// — owned by the native-core slice — onto [`SessionRuntime`].
///
/// **Why a wrapper and not `impl SessionRuntime for NativeSession`.** The two
/// slices land independently: the trait lives here, `NativeSession` lives in
/// `sessions::native` (a module this slice does not own). A newtype on the seam
/// side means neither slice has to wait for the other, and if the native slice
/// later grows its own `impl SessionRuntime for NativeSession` there is no
/// duplicate-impl clash to untangle — deleting this wrapper and returning the
/// `Arc<NativeSession>` directly from [`native_runtime_for`] is a two-line
/// change.
///
/// The adaptation is mechanical. `NativeSession`'s capture/probe methods are
/// INFALLIBLE (they read an in-process VT grid — there is no shell-out that can
/// fail), so the `Result`-returning trait methods wrap them in `Ok`. That is the
/// only translation; everything else is a straight call.
pub struct NativeRuntime {
    session: Arc<super::native::NativeSession>,
}

impl NativeRuntime {
    /// Wrap a native session handle.
    pub fn new(session: Arc<super::native::NativeSession>) -> Self {
        Self { session }
    }
}

#[async_trait]
impl SessionRuntime for NativeRuntime {
    async fn spawn(&self, dir: &Path, env: &HashMap<String, String>, shell: &str) -> Result<()> {
        self.session.spawn(dir, env, shell).await
    }

    async fn alive(&self) -> bool {
        self.session.alive().await
    }

    async fn kill(&self) -> Result<()> {
        self.session.kill().await
    }

    async fn send_text(&self, text: &str) -> Result<()> {
        self.session.send_text(text).await
    }

    async fn send_key(&self, key: &str) -> Result<()> {
        self.session.send_key(key).await
    }

    async fn paste(&self, text: &str, bracketed: bool) -> Result<()> {
        self.session.paste(text, bracketed).await
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.session.resize(cols, rows).await
    }

    async fn capture_plain(&self, lines: usize) -> Result<String> {
        Ok(self.session.capture_plain(lines).await)
    }

    async fn capture_ansi(&self, lines: usize) -> Result<String> {
        Ok(self.session.capture_ansi(lines).await)
    }

    async fn capture_screen_ansi(&self) -> Result<String> {
        Ok(self.session.capture_screen_ansi().await)
    }

    async fn capture_full(&self) -> Result<String> {
        Ok(self.session.capture_full().await)
    }

    async fn seed(&self) -> Result<String> {
        Ok(self.session.seed().await)
    }

    async fn history_window(&self, end_offset: i64, count: u32) -> Result<HistoryWindow> {
        Ok(self.session.history_window(end_offset, count).await)
    }

    async fn history_meta(&self) -> (u32, u16) {
        self.session.history_meta().await
    }

    async fn pane_pid(&self) -> Result<Option<u32>> {
        Ok(self.session.pane_pid().await)
    }

    async fn dead(&self) -> Result<bool> {
        Ok(self.session.dead().await)
    }

    /// The bare session name. There is no external multiplexer to prefix — the
    /// holder is addressed by this name under the data dir — so `StartResult`
    /// reports the name itself rather than a `supermux-`-prefixed tmux handle.
    fn target(&self) -> String {
        self.session.name().to_string()
    }

    /// The native path writes text and `Enter` into the SAME pty, so it needs the
    /// inter-`read()` gap tmux's two forks provided implicitly.
    fn submit_gap(&self) -> Duration {
        super::native::runtime::SUBMIT_GAP
    }

    async fn shell_is_foreground(&self) -> Option<bool> {
        self.session.shell_is_foreground().await
    }

    /// The holder connection CAN drop and come back (deploy, lag-disconnect),
    /// and each reconnect rebuilds the grid from the spool — so the native
    /// runtime is exactly the case this hook exists for.
    fn attach_generation(&self) -> Option<watch::Receiver<u64>> {
        Some(self.session.attach_generation())
    }

    /// The holder can die under a running session (crash, OOM kill, a stray
    /// `SIGKILL`), and the spool's `exit` marker + the meta pid prove it without
    /// touching the socket.
    async fn death(&self) -> Option<TerminalDeath> {
        self.session.death().await
    }

    /// A fresh daemon holds an EMPTY grid until its pump has attached and
    /// replayed the spool; a capture taken before that is blank, not real.
    async fn capture_is_authoritative(&self) -> bool {
        self.session.grid_is_authoritative()
    }
}

/// Build the NATIVE runtime for `name`.
///
/// **This is the single wiring point between the seam slice and the native-core
/// slice**, coordinated on the agreed constructor
///
/// ```ignore
/// pub fn runtime_for(name: &str, data_dir: &Path) -> Arc<NativeSession>
/// ```
///
/// which returns a PROCESS-WIDE SHARED handle (the native module memoizes one
/// per session name), so the seam never ends up with two competing connections
/// to the same holder.
///
/// Fallible on purpose even though the current constructor is infallible: this
/// is the one place a future "native is unavailable on this platform / the
/// holder binary is missing" refusal belongs, and callers already handle an
/// `Err` here as "runtime unavailable" rather than silently falling back to
/// tmux (which would spawn a tmux session for a row that claims not to have
/// one).
pub fn native_runtime_for(name: &str, data_dir: &Path) -> Result<Arc<dyn SessionRuntime>> {
    Ok(Arc::new(NativeRuntime::new(super::native::runtime_for(
        name, data_dir,
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The trait must stay OBJECT-SAFE — every call site holds
    /// `Arc<dyn SessionRuntime>`. Adding a generic method or a `Self` return
    /// would break this at compile time, right here.
    #[test]
    fn trait_is_object_safe_and_tmux_runtime_coerces() {
        let rt: Arc<dyn SessionRuntime> = Arc::new(TmuxRuntime::local("demo"));
        // `target()` is the one sync method — proves the vtable is reachable
        // and that delegation lands on the `supermux-` prefixed tmux name.
        assert_eq!(rt.target(), "supermux-demo");
    }

    /// A pane-pinned handle addresses the RAW `%id`, never `supermux-<name>` —
    /// the Agent-Teams lead-pane pin the WS attach depends on.
    #[test]
    fn tmux_runtime_pane_pin_targets_the_pane_id() {
        let rt = TmuxRuntime::on(None, "demo", Some("%17".to_string()));
        assert_eq!(rt.target(), "%17");
    }

    /// Only the two known kinds validate; everything else is a 400 upstream.
    #[test]
    fn valid_runtime_accepts_only_known_kinds() {
        assert!(valid_runtime(RUNTIME_TMUX));
        assert!(valid_runtime(RUNTIME_NATIVE));
        assert!(!valid_runtime(""));
        assert!(!valid_runtime("Tmux"));
        assert!(!valid_runtime("screen"));
        assert!(!valid_runtime("native "));
    }

    /// The native hook resolves to a real `dyn SessionRuntime` — i.e. the
    /// `NativeRuntime` adapter satisfies the whole trait (object-safe, every
    /// method present) and the seam never silently degrades a native row to
    /// tmux. `target()` is the one sync method, so it can be asserted without a
    /// runtime; it must be the BARE name (no `supermux-` prefix — there is no
    /// tmux session to prefix).
    #[tokio::test]
    async fn native_hook_resolves_to_a_session_runtime() {
        let dir = std::env::temp_dir().join(format!(
            "supermux-runtime-seam-{}",
            std::process::id()
        ));
        let rt: Arc<dyn SessionRuntime> =
            native_runtime_for("seam-demo", &dir).expect("native runtime resolves");
        assert_eq!(rt.target(), "seam-demo");
        // A native runtime has no tmux session-name mapping, so the WS attach's
        // cross-session-leak catcher stays silent for it (the map's explicit
        // "the diagnostic returns None for native" requirement).
        assert!(rt.resolved_session_name().await.is_none());
        crate::sessions::native::forget("seam-demo");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The `history` WS frame is built field-by-field from this struct, so its
    /// SERIALIZED SHAPE is wire protocol. Moving the type from `tmux.rs` to
    /// `runtime.rs` must not have touched a single key or type.
    #[test]
    fn history_window_json_shape_is_unchanged() {
        let w = HistoryWindow {
            rows: vec!["a".into(), "b".into()],
            history_size: 1234,
            start_offset: -300,
            end_offset: -1,
            hit_top: false,
            cols: 80,
            at_limit: true,
        };
        let v = serde_json::to_value(&w).unwrap();
        let obj = v.as_object().expect("HistoryWindow serializes to an object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "at_limit",
                "cols",
                "end_offset",
                "history_size",
                "hit_top",
                "rows",
                "start_offset",
            ]
        );
        assert_eq!(v["rows"], serde_json::json!(["a", "b"]));
        assert_eq!(v["history_size"], 1234);
        assert_eq!(v["start_offset"], -300);
        assert_eq!(v["end_offset"], -1);
        assert_eq!(v["hit_top"], false);
        assert_eq!(v["cols"], 80);
        assert_eq!(v["at_limit"], true);
    }

    /// The three seam hooks the native fixes hang off must be INERT for tmux —
    /// that is what makes "zero behaviour change for tmux" checkable rather than
    /// asserted. A `submit_gap` that is not zero would insert a sleep into every
    /// tmux send; an `attach_generation` that is `Some` would make the WS
    /// re-seed on a tick nothing ever produces; a `shell_is_foreground` that is
    /// not `None` would change which starts type the launch command.
    #[test]
    fn the_native_hooks_are_inert_on_the_tmux_runtime() {
        let rt = TmuxRuntime::local("demo");
        assert_eq!(rt.submit_gap(), Duration::ZERO);
        assert!(rt.attach_generation().is_none());
        let rt: Arc<dyn SessionRuntime> = Arc::new(TmuxRuntime::local("demo"));
        assert_eq!(rt.submit_gap(), Duration::ZERO);
        assert!(rt.attach_generation().is_none());
    }

    /// …and LIVE on the native runtime: the 50ms gap an Ink TUI needs to see the
    /// Enter as a keypress instead of the tail of a paste, plus the generation
    /// watch the WS attach re-seeds on.
    #[tokio::test]
    async fn the_native_runtime_declares_a_submit_gap_and_an_attach_generation() {
        let dir = std::env::temp_dir()
            .join(format!("supermux-seam-hooks-{}", std::process::id()));
        let rt: Arc<dyn SessionRuntime> =
            native_runtime_for("hooks-demo", &dir).expect("native runtime resolves");
        assert_eq!(rt.submit_gap(), Duration::from_millis(50));
        assert_eq!(rt.submit_gap(), crate::sessions::native::runtime::SUBMIT_GAP);
        let ticks = rt.attach_generation().expect("native exposes an attach generation");
        assert_eq!(*ticks.borrow(), 0, "no attach has completed yet");
        // No holder, no `meta.json` → nothing to read a foreground group from.
        assert_eq!(rt.shell_is_foreground().await, None);
        crate::sessions::native::forget("hooks-demo");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The type is re-exported from `sessions::tmux` for source compatibility —
    /// `Tmux::capture_history_window` still returns it and existing
    /// `use crate::sessions::tmux::HistoryWindow` imports keep resolving.
    #[test]
    fn history_window_is_re_exported_from_tmux() {
        fn takes(_: crate::sessions::tmux::HistoryWindow) {}
        takes(HistoryWindow {
            rows: vec![],
            history_size: 0,
            start_offset: 0,
            end_offset: 0,
            hit_top: true,
            cols: 0,
            at_limit: false,
        });
    }
}
