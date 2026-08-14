//! Transcript tailer: the byte cursor, the subagents scope, and the staleness
//! guard.
//!
//! The tailer is the **only** reader of a session's transcript file, so byte
//! offsets and the store's `seq` are consistent by construction: everything the
//! WS and the sessions-SSE `chat_tail` see went through exactly one
//! [`ChatStore::publish`](super::store::ChatStore::publish), in file order.
//!
//! ## Watcher shape
//!
//! A [`notify`] watcher on the **project directory** (not the file) plus an
//! unconditional slow safety poll, exactly as `teams::watcher` already
//! documents: FSEvents get dropped, and a `--resume` writes a *different* file,
//! which only a directory event can reveal. The debounce is much tighter than
//! teams' 400 ms — a landing batch is the thing we want to be fast on.
//!
//! ## Cursor
//!
//! One byte offset per file. Compaction is **inline** (`compact_boundary`,
//! same `sessionId`), so the cursor survives it — it is never reset on
//! compaction. It resets only when the resolved path changes (a pointer change)
//! or the file's length went *backwards* (truncation/rotation); both re-seed
//! from the top and raise `resync`, which clears the ring so a client can never
//! be shown two conversations spliced together.
//!
//! ## The staleness guard
//!
//! [`classify_pointer`] is a pure function over four inputs, covering the three
//! ways the DB pointer can be wrong:
//!
//! | failure mode | detection |
//! |---|---|
//! | server restart (pointer days stale — the c31518e bug class) | running && !hooks_live && within the boot window → `Reconnecting` |
//! | terminal-side `--resume` | primary: the `SessionStart` hook refreshes the id and wakes us ([`AppState::chat_pointer_wake_for`]); backstop: our file is cold *while our own hooks are provably active* and a sibling is newer |
//! | hook install failure | running && !hooks_live for > [`NO_HOOKS_AFTER_MS`] → `NoHooks` (the pointer can never self-heal without a hook) |
//!
//! **Never auto-adopt.** A suspect pointer is *reported*, never swapped for a
//! guessed file: adopting the newest sibling would be wrong exactly when two
//! supermux sessions share a cwd. Adoption happens only through
//! [`Tailer::retarget`], driven by the hook-carried `session_id`.

use std::collections::BTreeMap;
use std::io::{BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::{watch, Notify};

use super::model::ChatEntry;
use super::parser::parse_stream;
use crate::sessions::resumable;
use crate::state::AppState;

/// Slow safety re-scan cadence. FSEvents can be dropped and an editor-less
/// append on some filesystems produces no event at all, so the poll runs
/// unconditionally (`teams::watcher`'s rationale, verbatim).
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Debounce after an FS event before draining. Much tighter than teams' 400 ms:
/// a landing batch is exactly what we want to be fast on (A0: text-only
/// first-visible p50 is 31 s, so the tail is the *confirming* layer — but once
/// bytes land they must not sit in a debounce).
pub const FS_DEBOUNCE: Duration = Duration::from_millis(150);

/// How long a running, never-hooked session stays `Reconnecting` before it is
/// called what it is. The `SessionStart` hook fires when Claude launches, so a
/// full minute of silence means the hooks are not installed/authorised.
pub const NO_HOOKS_AFTER_MS: i64 = 60_000;

/// The backstop only trusts "a newer sibling means *we* resumed" while our own
/// hooks are provably active within this window.
pub const HOOK_ACTIVITY_WINDOW_MS: i64 = 10_000;

/// How far ahead of our pointer a sibling must be before it counts as a
/// different, *newer* conversation rather than write-ordering jitter.
pub const SIBLING_LEAD_MS: i64 = 5_000;

/// How long the tailer keeps running after the last subscriber leaves, so a
/// page reload / redial does not re-seed from disk.
pub const IDLE_GRACE: Duration = Duration::from_secs(30);

// ── the staleness guard ──────────────────────────────────────────────────────

/// Everything [`classify_pointer`] is allowed to look at. All times are the
/// **server** clock in ms (the `activity_at` domain) — never a transcript
/// entry's own `timestamp`, which A0 measured up to 27 s away from arrival.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointerInputs {
    /// Does `<project>/<cc_conversation_id>.jsonl` exist right now?
    pub pointer_path_exists: bool,
    pub pointer_mtime_ms: Option<i64>,
    /// Newest OTHER `*.jsonl` in the project dir.
    pub newest_sibling_mtime_ms: Option<i64>,
    /// `state.hooks_live` has this session (≥1 authenticated hook POST seen).
    pub hooks_live: bool,
    /// Newest `state.last_hook` turn-state stamp, in the same ms domain.
    pub last_hook_ms: Option<i64>,
    /// The session's last detected status is not `stopped`.
    pub session_running: bool,
    pub session_last_started_ms: i64,
    pub now_ms: i64,
}

/// What the chat client is told about the tail's trustworthiness.
///
/// `Reconnecting` is deliberately not an error: the transcript we already
/// showed stays on screen, but the client must not present it as a complete,
/// current conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TailState {
    Live,
    Reconnecting { reason: &'static str },
    /// The pointer can NEVER self-heal: its only refresh path is a hook.
    NoHooks,
}

/// The full status the WS publishes: the state plus a monotonic epoch that is
/// bumped on every re-seed, so a client can tell "same state, new conversation"
/// from "nothing changed".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TailStatus {
    #[serde(flatten)]
    pub state: TailState,
    pub resync_epoch: u64,
}

impl Default for TailStatus {
    fn default() -> Self {
        Self { state: TailState::Reconnecting { reason: "starting" }, resync_epoch: 0 }
    }
}

/// Classify the DB conversation pointer. Pure — the whole guard is table-tested.
pub fn classify_pointer(i: PointerInputs) -> TailState {
    // No file at all. An empty-but-composable chat is precisely the lie this
    // guard exists to prevent, and that is true whether or not the session is
    // still running.
    if !i.pointer_path_exists {
        return TailState::Reconnecting { reason: "no transcript for the tracked conversation" };
    }

    // A stopped session's tail is history, not a claim about now: nothing will
    // append to it, so neither a newer sibling nor a silent hook says anything
    // about whether we are reading the right file.
    if !i.session_running {
        return TailState::Live;
    }

    if !i.hooks_live {
        // The pointer's only self-heal path is a hook. Past the boot window,
        // silence means the hooks are not wired — a state that must be visible,
        // never guessed around.
        if i.now_ms.saturating_sub(i.session_last_started_ms) > NO_HOOKS_AFTER_MS {
            return TailState::NoHooks;
        }
        // Inside the window the pointer is merely unproven: after a server
        // restart the DB id can be days old and nothing has re-confirmed it yet.
        return TailState::Reconnecting { reason: "no hook since start" };
    }

    // Backstop for a terminal-side `--resume` whose `SessionStart` hook was late
    // or lost. It keys on OUR file being cold *while our own hooks prove the
    // session is active*, so a second supermux session sharing the cwd cannot
    // false-positive: another session's writes only matter if ours is
    // simultaneously silent under our own hook activity.
    let hook_fresh = i.last_hook_ms
        .is_some_and(|h| i.now_ms.saturating_sub(h) <= HOOK_ACTIVITY_WINDOW_MS);
    if hook_fresh {
        if let Some(sibling) = i.newest_sibling_mtime_ms {
            let ours = i.pointer_mtime_ms.unwrap_or(0);
            if sibling > ours.saturating_add(SIBLING_LEAD_MS) {
                return TailState::Reconnecting { reason: "newer conversation in this project" };
            }
        }
    }

    TailState::Live
}

/// Newest mtime (ms) among the project dir's top-level `*.jsonl` files, ignoring
/// our own `<conv>.jsonl`. `None` when there is no other conversation.
pub fn newest_sibling_mtime_ms(project_dir: &Path, conversation_id: &str) -> Option<i64> {
    let mut newest: Option<i64> = None;
    for entry in std::fs::read_dir(project_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if path.file_stem().and_then(|s| s.to_str()) == Some(conversation_id) {
            continue;
        }
        if let Some(ms) = entry.metadata().ok().and_then(|m| mtime_ms(&m)) {
            newest = Some(newest.map_or(ms, |n: i64| n.max(ms)));
        }
    }
    newest
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    let d = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(d.as_millis() as i64)
}

// ── the cursor ───────────────────────────────────────────────────────────────

/// One watched file and how far into it we have already published.
#[derive(Debug)]
struct FileCursor {
    path: PathBuf,
    offset: u64,
}

impl FileCursor {
    fn new(path: PathBuf) -> Self {
        Self { path, offset: 0 }
    }

    /// Read everything appended since `offset`. Returns the entries and whether
    /// the file had to be re-read from the top (length went backwards).
    ///
    /// A partial trailing line is deliberately left behind: Claude Code appends
    /// with ordinary buffered writes, so a poll can land mid-line and the next
    /// one must re-read it whole ([`parse_stream`] owns that rule).
    fn drain(&mut self) -> (Vec<ChatEntry>, bool) {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return (Vec::new(), false);
        };
        let len = meta.len();
        let mut restarted = false;
        if len < self.offset {
            self.offset = 0;
            restarted = true;
        }
        if len == self.offset {
            return (Vec::new(), restarted);
        }
        let Ok(mut f) = std::fs::File::open(&self.path) else {
            return (Vec::new(), restarted);
        };
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return (Vec::new(), restarted);
        }
        let (entries, next) = parse_stream(BufReader::new(f), self.offset);
        self.offset = next;
        (entries, restarted)
    }
}

/// What one [`Tailer::poll`] produced.
#[derive(Debug, Default)]
pub struct TailPoll {
    /// New entries, in file order: the main transcript first, then each
    /// subagent file (deterministically ordered by agent id).
    pub entries: Vec<ChatEntry>,
    /// The cursor was reset — the consumer must drop what it has and re-seed.
    /// Raised by a pointer change and by a file that shrank, never by an inline
    /// `compact_boundary`.
    pub resync: bool,
}

/// The per-session file cursor set: the main transcript plus every
/// `<conv-id>/subagents/agent-*.jsonl`.
#[derive(Debug)]
pub struct Tailer {
    project_dir: PathBuf,
    conversation_id: String,
    main: FileCursor,
    /// agent id → its own cursor. `BTreeMap` so a poll's output order is stable.
    subagents: BTreeMap<String, FileCursor>,
    pending_resync: bool,
}

impl Tailer {
    pub fn new(project_dir: impl Into<PathBuf>, conversation_id: &str) -> Self {
        let project_dir = project_dir.into();
        let main = FileCursor::new(transcript_path(&project_dir, conversation_id));
        Self {
            project_dir,
            conversation_id: conversation_id.to_string(),
            main,
            subagents: BTreeMap::new(),
            pending_resync: false,
        }
    }

    pub fn project_dir(&self) -> &Path {
        &self.project_dir
    }

    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    pub fn transcript_path(&self) -> &Path {
        &self.main.path
    }

    /// Point at a different conversation. Returns `true` when this actually
    /// moved (the next [`poll`](Self::poll) then re-seeds and reports `resync`).
    ///
    /// This is the ONLY adoption path, and it is driven by the hook-carried
    /// `session_id` — the authoritative signal. The tailer never adopts a file
    /// it merely noticed.
    pub fn retarget(&mut self, conversation_id: &str) -> bool {
        if self.conversation_id == conversation_id {
            return false;
        }
        self.conversation_id = conversation_id.to_string();
        self.main = FileCursor::new(transcript_path(&self.project_dir, conversation_id));
        self.subagents.clear();
        self.pending_resync = true;
        true
    }

    /// Drain every watched file once.
    pub fn poll(&mut self) -> TailPoll {
        let mut out = TailPoll {
            resync: std::mem::take(&mut self.pending_resync),
            ..Default::default()
        };

        let (main, restarted) = self.main.drain();
        out.resync |= restarted;
        // Sidechain lines in the MAIN file are dropped: the same turns are read,
        // with their agent id, out of `subagents/`. Keeping both would render
        // every subagent turn twice.
        out.entries
            .extend(main.into_iter().filter(|e| !e.is_sidechain));

        self.rescan_subagents();
        for (agent_id, cursor) in self.subagents.iter_mut() {
            let (entries, restarted) = cursor.drain();
            out.resync |= restarted;
            out.entries.extend(entries.into_iter().map(|mut e| {
                // The file IS the authority on whose entries these are: a
                // subagent line without an `agentId` would otherwise render as
                // a main-thread turn.
                e.is_sidechain = true;
                if e.agent_id.is_none() {
                    e.agent_id = Some(agent_id.clone());
                }
                e
            }));
        }
        out
    }

    /// Pick up subagent files that appeared since the last poll. Existing
    /// cursors are left untouched — a rescan must never rewind one.
    fn rescan_subagents(&mut self) {
        let dir = self.subagents_dir();
        let Ok(read) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("agent-"))
            else {
                continue;
            };
            if !self.subagents.contains_key(id) {
                self.subagents
                    .insert(id.to_string(), FileCursor::new(path.clone()));
            }
        }
    }

    /// `<project>/<conv-id>/subagents/` (A0: subagent transcripts live beside
    /// their parent conversation, one file + one `.meta.json` per agent).
    pub fn subagents_dir(&self) -> PathBuf {
        self.project_dir
            .join(&self.conversation_id)
            .join("subagents")
    }
}

fn transcript_path(project_dir: &Path, conversation_id: &str) -> PathBuf {
    project_dir.join(format!("{conversation_id}.jsonl"))
}

// ── the running task ─────────────────────────────────────────────────────────

/// Live tailer tasks, keyed by session name. Process-global (like
/// `sessions::native`'s handle memo) because a tailer owns an OS-level watcher
/// and a file cursor: two of them on one session would double-publish.
fn registry() -> &'static DashMap<String, Arc<TailerHandle>> {
    static TAILERS: OnceLock<DashMap<String, Arc<TailerHandle>>> = OnceLock::new();
    TAILERS.get_or_init(DashMap::new)
}

/// The shared handle a lease holds and the loop reads.
pub struct TailerHandle {
    subscribers: AtomicUsize,
    status: watch::Sender<TailStatus>,
}

impl TailerHandle {
    pub fn status(&self) -> TailStatus {
        *self.status.borrow()
    }
}

/// A subscriber's claim on a session's tailer. The loop keeps running while at
/// least one lease is alive, and for [`IDLE_GRACE`] after the last one drops —
/// so a page reload does not pay for a fresh disk seed.
pub struct TailerLease {
    name: String,
    handle: Arc<TailerHandle>,
    status: watch::Receiver<TailStatus>,
}

impl TailerLease {
    pub fn session(&self) -> &str {
        &self.name
    }

    /// The current tail status (state + resync epoch).
    pub fn status(&self) -> TailStatus {
        *self.status.borrow()
    }

    /// Wait for the next status transition. `Err` only once the tailer is gone.
    pub async fn changed(&mut self) -> Result<TailStatus, watch::error::RecvError> {
        self.status.changed().await?;
        Ok(*self.status.borrow_and_update())
    }
}

impl Drop for TailerLease {
    fn drop(&mut self) {
        self.handle.subscribers.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Start (or join) `name`'s tailer and hold it open until the returned lease
/// drops. **Idempotent**: one task per session — a second caller joins the first
/// one's task rather than starting a competing reader (two readers would
/// double-publish, and the store's `seq` would stop being the file's byte
/// order).
///
/// The lease is the subscriber claim the plan's "started on first chat attach,
/// stopped when the last subscriber leaves + a grace period" rule is built on:
/// dropping it decrements the count, and the loop exits [`IDLE_GRACE`] later.
///
/// Must be called from inside a Tokio runtime (the chat WS handler is).
pub fn spawn_tailer(state: &AppState, name: &str) -> TailerLease {
    let mut fresh = false;
    let handle = {
        let entry = registry().entry(name.to_string()).or_insert_with(|| {
            fresh = true;
            Arc::new(TailerHandle {
                subscribers: AtomicUsize::new(0),
                status: watch::channel(TailStatus::default()).0,
            })
        });
        entry.value().clone()
    };
    // Claim BEFORE the task can observe an idle count, so the grace-period exit
    // cannot race a first subscriber.
    handle.subscribers.fetch_add(1, Ordering::AcqRel);
    let status = handle.status.subscribe();
    if fresh {
        tokio::spawn(run(state.clone(), name.to_string(), handle.clone()));
    }
    TailerLease {
        name: name.to_string(),
        handle,
        status,
    }
}

/// The current tail status without taking a lease (does not start a tailer).
pub fn status_of(name: &str) -> Option<TailStatus> {
    registry().get(name).map(|h| h.status())
}

/// Facts one blocking pass collected about the tail, so the async loop never
/// touches the filesystem itself.
struct Pass {
    poll: TailPoll,
    pointer_exists: bool,
    pointer_mtime_ms: Option<i64>,
    newest_sibling_mtime_ms: Option<i64>,
}

fn blocking_pass(mut core: Tailer) -> (Tailer, Pass) {
    let poll = core.poll();
    let meta = std::fs::metadata(core.transcript_path()).ok();
    let pass = Pass {
        poll,
        pointer_exists: meta.is_some(),
        pointer_mtime_ms: meta.as_ref().and_then(mtime_ms),
        newest_sibling_mtime_ms: newest_sibling_mtime_ms(core.project_dir(), core.conversation_id()),
    };
    (core, pass)
}

async fn run(state: AppState, name: String, handle: Arc<TailerHandle>) {
    let store = state.chat_store_for(&name);
    let pointer_wake = state.chat_pointer_wake_for(&name);
    let fs_wake = Arc::new(Notify::new());
    // The watcher is a live guard: dropping it stops the watch, so it is kept
    // paired with the directory it is armed on.
    let mut watch_guard: Option<(PathBuf, notify::RecommendedWatcher)> = None;
    let mut core: Option<Tailer> = None;
    let mut idle_since: Option<Instant> = None;
    let mut resync_epoch = 0u64;

    let mut tick = tokio::time::interval(POLL_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        // The session row is the pointer's source of truth; a vanished row (or a
        // session that is not an eligible local Claude one) ends the task.
        let row = match crate::db::sessions::get(&state.pool, &name).await {
            Ok(Some(row)) => row,
            _ => break,
        };
        if row.provider != "claude" || row.host_id.is_some() {
            break;
        }

        let project = resumable::project_dir_for(&row.dir);
        let conv = row.cc_conversation_id.clone();
        let mut forced_resync = false;
        match core.as_mut() {
            Some(t) if t.project_dir() == project => {
                forced_resync |= t.retarget(&conv);
            }
            // First pass, or the session's cwd moved under us: a brand-new
            // cursor set. Only a *replacement* is a resync — the first build has
            // published nothing yet.
            slot => {
                forced_resync |= slot.is_some();
                core = Some(Tailer::new(&project, &conv));
            }
        }

        // Arm/re-arm the directory watcher (best effort; the poll runs anyway).
        if watch_guard.as_ref().map(|(p, _)| p.as_path()) != Some(project.as_path()) {
            watch_guard = arm_fs_watcher(&project, fs_wake.clone()).map(|w| (project.clone(), w));
        }

        // Filesystem work happens off the async worker: a re-seed can read a
        // whole 8 MB transcript.
        let taken = core.take().expect("core was just set");
        let pass = tokio::task::spawn_blocking(move || blocking_pass(taken)).await;
        // The blocking pool is gone (shutdown) — nothing left to tail.
        let Ok((returned, pass)) = pass else { break };
        core = Some(returned);

        if forced_resync || pass.poll.resync {
            // The ring holds the OLD conversation. Clearing it (seq stays
            // monotonic) is what makes "resync" mean "re-seed", not "splice".
            store.reset();
            resync_epoch += 1;
        }
        if !pass.poll.entries.is_empty() {
            store.publish(pass.poll.entries);
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        let state_now = classify_pointer(PointerInputs {
            pointer_path_exists: !conv.is_empty() && pass.pointer_exists,
            pointer_mtime_ms: pass.pointer_mtime_ms,
            newest_sibling_mtime_ms: pass.newest_sibling_mtime_ms,
            hooks_live: state.has_hooks(&name),
            last_hook_ms: last_hook_ms(&state, &name, now_ms),
            session_running: session_running(&state, &name).await,
            // `sessions.last_started` is stored in SECONDS.
            session_last_started_ms: row.last_started.saturating_mul(1_000),
            now_ms,
        });
        let status = TailStatus { state: state_now, resync_epoch };
        handle.status.send_if_modified(|cur| {
            let changed = *cur != status;
            *cur = status;
            changed
        });

        // Idle shutdown: keep the cursor warm through a reload, then let go.
        if handle.subscribers.load(Ordering::Acquire) == 0 {
            let since = *idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= IDLE_GRACE {
                // `remove_if` runs under the same shard lock `spawn_tailer`'s
                // `entry` takes, so a subscriber arriving now either wins the
                // lock (and we keep running) or finds the slot gone and spawns a
                // fresh task.
                if registry()
                    .remove_if(&name, |_, h| h.subscribers.load(Ordering::Acquire) == 0)
                    .is_some()
                {
                    break;
                }
            }
        } else {
            idle_since = None;
        }

        tokio::select! {
            _ = tick.tick() => {}
            _ = fs_wake.notified() => { tokio::time::sleep(FS_DEBOUNCE).await; }
            // A hook just changed `cc_conversation_id`: re-resolve NOW rather
            // than waiting for the backstop to notice a cold pointer.
            _ = pointer_wake.notified() => {}
        }
    }
}

/// Newest hook stamp for `name`, translated from the `Instant` domain the turn
/// state machine records into the server-ms domain the guard compares in.
fn last_hook_ms(state: &AppState, name: &str, now_ms: i64) -> Option<i64> {
    let t = state.turn_state(name);
    let newest = [t.user_prompt, t.pre_tool, t.post_tool, t.stop, t.subagent_stop, t.notification]
    .into_iter()
    .flatten()
    .max()?;
    Some(now_ms - newest.elapsed().as_millis() as i64)
}

/// Is the session anything other than `stopped`? Prefers the detector's own
/// last classification (already computed every 2s) and only falls back to
/// asking the runtime when no tick has been recorded yet.
async fn session_running(state: &AppState, name: &str) -> bool {
    let cached = {
        let map = state.cadence_recency.lock().unwrap_or_else(|e| e.into_inner());
        map.get(name).map(|r| r.status)
    };
    match cached {
        Some(status) => status != crate::sessions::status::Status::Stopped,
        None => match state.runtime_for(name).await {
            Ok(rt) => rt.alive().await,
            Err(_) => false,
        },
    }
}

/// Watch the project directory (recursively, so `<conv>/subagents/` is covered
/// the moment it appears). Best effort: the slow poll is the guarantee.
fn arm_fs_watcher(project: &Path, wake: Arc<Notify>) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            wake.notify_one();
        }
    })
    .ok()?;
    if watcher.watch(project, RecursiveMode::Recursive).is_ok() {
        return Some(watcher);
    }
    tracing::debug!(
        dir = %project.display(),
        "chat tail FS watcher could not arm; falling back to the slow poll"
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    // ── the staleness guard: a pure table ────────────────────────────────────

    /// A healthy, hooked, running session whose own transcript is the hot file.
    fn base() -> PointerInputs {
        PointerInputs {
            pointer_path_exists: true,
            pointer_mtime_ms: Some(99_000),
            newest_sibling_mtime_ms: None,
            hooks_live: true,
            last_hook_ms: Some(99_500),
            session_running: true,
            session_last_started_ms: 10_000,
            now_ms: 100_000,
        }
    }

    #[test]
    fn live_when_hooks_are_flowing_and_our_file_is_the_hot_one() {
        assert_eq!(classify_pointer(base()), TailState::Live);
    }

    #[test]
    fn server_restart_with_stale_pointer_is_reconnecting_not_live() {
        // The c31518e bug class: the DB pointer can be days old after a restart
        // and no hook has fired yet, so nothing has re-proved it.
        let i = PointerInputs {
            hooks_live: false,
            pointer_mtime_ms: Some(1_000),
            session_last_started_ms: 5_000,
            session_running: true,
            now_ms: 6_000,
            ..base()
        };
        assert!(matches!(classify_pointer(i), TailState::Reconnecting { .. }));
    }

    #[test]
    fn terminal_side_resume_is_caught_by_the_cold_pointer_backstop() {
        let i = PointerInputs {
            hooks_live: true,
            last_hook_ms: Some(99_000),
            pointer_mtime_ms: Some(50_000),
            newest_sibling_mtime_ms: Some(99_500),
            session_running: true,
            now_ms: 100_000,
            ..base()
        };
        assert!(matches!(classify_pointer(i), TailState::Reconnecting { .. }));
    }

    #[test]
    fn a_second_session_sharing_the_cwd_does_not_false_positive() {
        // Sibling is newer, but OUR pointer is equally hot → the other file is
        // someone else's session, not our resume.
        let i = PointerInputs {
            hooks_live: true,
            last_hook_ms: Some(99_000),
            pointer_mtime_ms: Some(99_400),
            newest_sibling_mtime_ms: Some(99_500),
            session_running: true,
            now_ms: 100_000,
            ..base()
        };
        assert_eq!(classify_pointer(i), TailState::Live);
    }

    #[test]
    fn hook_install_failure_is_its_own_terminal_state() {
        let i = PointerInputs {
            hooks_live: false,
            session_running: true,
            session_last_started_ms: 0,
            now_ms: 120_000,
            ..base()
        };
        assert_eq!(classify_pointer(i), TailState::NoHooks);
    }

    #[test]
    fn a_stopped_session_is_never_flagged_stale() {
        // A historical tail is legitimate truth: nothing is going to append to
        // it, so "newer sibling" and "no hooks" say nothing about correctness.
        let stopped = PointerInputs {
            session_running: false,
            hooks_live: false,
            last_hook_ms: None,
            pointer_mtime_ms: Some(1_000),
            newest_sibling_mtime_ms: Some(99_999),
            session_last_started_ms: 0,
            ..base()
        };
        assert_eq!(classify_pointer(stopped), TailState::Live);
    }

    #[test]
    fn missing_pointer_file_is_reconnecting_not_empty_chat() {
        // An empty-but-composable chat is exactly the lie we are preventing.
        for running in [true, false] {
            let i = PointerInputs {
                pointer_path_exists: false,
                pointer_mtime_ms: None,
                session_running: running,
                ..base()
            };
            assert!(
                matches!(classify_pointer(i), TailState::Reconnecting { .. }),
                "running={running}: a missing transcript must never read as an empty chat"
            );
        }
    }

    #[test]
    fn the_backstop_ignores_a_newer_sibling_when_our_hooks_are_quiet() {
        // No hook in the last 10s → we cannot prove the session is active, so a
        // newer sibling is just another session's file. Reporting `Reconnecting`
        // here would flag every idle session in a shared cwd.
        let i = PointerInputs {
            hooks_live: true,
            last_hook_ms: Some(1_000),
            pointer_mtime_ms: Some(50_000),
            newest_sibling_mtime_ms: Some(99_500),
            now_ms: 100_000,
            ..base()
        };
        assert_eq!(classify_pointer(i), TailState::Live);
    }

    #[test]
    fn no_hooks_only_applies_once_the_boot_window_has_passed() {
        // A session that started 3s ago has simply not had its `SessionStart`
        // hook land yet — that is `Reconnecting`, not the terminal `NoHooks`.
        let i = PointerInputs {
            hooks_live: false,
            session_running: true,
            session_last_started_ms: 97_000,
            now_ms: 100_000,
            ..base()
        };
        assert!(matches!(classify_pointer(i), TailState::Reconnecting { .. }));
    }

    #[test]
    fn every_reconnecting_reason_is_a_distinct_static_string() {
        // The reason rides the wire; a duplicated/empty one makes the UI state
        // unexplainable.
        let mut reasons = vec![];
        for i in [
            PointerInputs { pointer_path_exists: false, ..base() },
            PointerInputs { hooks_live: false, now_ms: 11_000, ..base() },
            PointerInputs {
                pointer_mtime_ms: Some(50_000),
                newest_sibling_mtime_ms: Some(99_500),
                last_hook_ms: Some(99_000),
                ..base()
            },
        ] {
            match classify_pointer(i) {
                TailState::Reconnecting { reason } => {
                    assert!(!reason.is_empty());
                    reasons.push(reason);
                }
                other => panic!("expected Reconnecting, got {other:?}"),
            }
        }
        reasons.sort_unstable();
        let before = reasons.len();
        reasons.dedup();
        assert_eq!(reasons.len(), before, "reasons must be distinguishable");
    }

    // ── the cursor + the subagents scope (real files, no live Claude) ────────

    fn tmp_project(tag: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("supermux-chattail-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn append(path: &Path, lines: &[String]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn user_line(uuid: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","message":{{"role":"user","content":"hi {uuid}"}}}}"#
        )
    }

    fn sidechain_line(uuid: &str, agent_id: Option<&str>) -> String {
        let agent = agent_id.map(|a| format!(r#","agentId":"{a}""#)).unwrap_or_default();
        format!(
            r#"{{"type":"user","uuid":"{uuid}","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","isSidechain":true{agent},"message":{{"role":"user","content":"sub {uuid}"}}}}"#
        )
    }

    fn compact_line(uuid: &str) -> String {
        format!(
            r#"{{"type":"system","subtype":"compact_boundary","uuid":"{uuid}","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","compactMetadata":{{"whatever":[1,2,3]}}}}"#
        )
    }

    fn uuids(entries: &[crate::sessions::chat::model::ChatEntry]) -> Vec<String> {
        entries.iter().map(|e| e.uuid.clone()).collect()
    }

    #[tokio::test]
    async fn cursor_survives_an_inline_compact_boundary() {
        let dir = tmp_project("compact");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1"), user_line("u2")]);
        let mut t = Tailer::new(&dir, "conv-a");

        let first = t.poll();
        assert_eq!(uuids(&first.entries), ["u1", "u2"]);
        assert!(!first.resync);

        append(&f, &[compact_line("c1"), user_line("u3")]);
        let second = t.poll();
        assert_eq!(
            uuids(&second.entries),
            ["c1", "u3"],
            "compaction is INLINE — pre-boundary entries must not be re-emitted"
        );
        assert!(!second.resync, "an inline boundary is not a resync");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn pointer_change_reseeds_from_the_new_file_and_emits_resync() {
        let dir = tmp_project("pointer");
        let a = dir.join("conv-a.jsonl");
        let b = dir.join("conv-b.jsonl");
        append(&a, &[user_line("a1"), user_line("a2")]);
        append(&b, &[user_line("b1"), user_line("b2")]);

        let mut t = Tailer::new(&dir, "conv-a");
        assert_eq!(uuids(&t.poll().entries), ["a1", "a2"]);

        assert!(!t.retarget("conv-a"), "the same id must not churn the cursor");
        assert!(t.retarget("conv-b"));
        let after = t.poll();
        assert!(after.resync, "a new conversation must force a client resync");
        assert_eq!(
            uuids(&after.entries),
            ["b1", "b2"],
            "the new file is read from the TOP, never from the old cursor"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn truncated_file_reseeds_instead_of_reading_garbage() {
        let dir = tmp_project("truncate");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1"), user_line("u2"), user_line("u3")]);
        let mut t = Tailer::new(&dir, "conv-a");
        assert_eq!(uuids(&t.poll().entries).len(), 3);

        // Rotation/truncation: the file is now SHORTER than our cursor.
        std::fs::write(&f, format!("{}\n", user_line("z1"))).unwrap();
        let after = t.poll();
        assert!(after.resync, "a backwards length must be reported, not read past");
        assert_eq!(uuids(&after.entries), ["z1"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn subagent_files_are_watched_and_tagged_with_agent_id() {
        let dir = tmp_project("subagents");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1")]);
        let sub = dir.join("conv-a").join("subagents").join("agent-x1.jsonl");
        // Line 1 carries `agentId`; line 2 does NOT — the FILENAME must still
        // tag it, or a subagent's entries would render as main-thread ones.
        append(&sub, &[sidechain_line("s1", Some("x1")), sidechain_line("s2", None)]);

        let mut t = Tailer::new(&dir, "conv-a");
        let poll = t.poll();
        assert_eq!(uuids(&poll.entries), ["u1", "s1", "s2"]);
        let subs = &poll.entries[1..];
        for e in subs {
            assert_eq!(e.agent_id.as_deref(), Some("x1"));
            assert!(e.is_sidechain);
        }

        // The subagent file has its own cursor: appending only re-emits the new line.
        append(&sub, &[sidechain_line("s3", None)]);
        assert_eq!(uuids(&t.poll().entries), ["s3"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sidechain_lines_in_the_main_file_are_dropped_not_double_counted() {
        // They are re-read, with their agent id, from `subagents/`.
        let dir = tmp_project("sidechain");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1"), sidechain_line("s1", Some("x1"))]);
        let mut t = Tailer::new(&dir, "conv-a");
        assert_eq!(uuids(&t.poll().entries), ["u1"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_partial_trailing_line_is_re_read_whole_on_the_next_poll() {
        let dir = tmp_project("partial");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1")]);
        let mut t = Tailer::new(&dir, "conv-a");
        assert_eq!(uuids(&t.poll().entries), ["u1"]);

        // A buffered write lands mid-line.
        let whole = user_line("u2");
        let (head, tail) = whole.split_at(20);
        {
            let mut fh = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
            fh.write_all(head.as_bytes()).unwrap();
        }
        let mid = t.poll();
        assert!(mid.entries.is_empty(), "a half-written line must not be parsed");
        assert!(!mid.resync);
        {
            let mut fh = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
            fh.write_all(tail.as_bytes()).unwrap();
            fh.write_all(b"\n").unwrap();
        }
        assert_eq!(uuids(&t.poll().entries), ["u2"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_quiet_file_polls_to_nothing_and_never_resyncs() {
        let dir = tmp_project("quiet");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1")]);
        let mut t = Tailer::new(&dir, "conv-a");
        assert_eq!(t.poll().entries.len(), 1);
        for _ in 0..3 {
            let p = t.poll();
            assert!(p.entries.is_empty());
            assert!(!p.resync, "an idle tail must not churn the client");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_missing_transcript_polls_to_nothing_instead_of_erroring() {
        let dir = tmp_project("missing");
        let mut t = Tailer::new(&dir, "conv-nope");
        let p = t.poll();
        assert!(p.entries.is_empty());
        assert!(!p.resync);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_tailer_never_auto_adopts_a_newer_sibling() {
        // The whole point of "report, never guess": adoption happens only via
        // `retarget`, which is driven by the hook-carried session id.
        let dir = tmp_project("adopt");
        let a = dir.join("conv-a.jsonl");
        let b = dir.join("conv-b.jsonl");
        append(&a, &[user_line("a1")]);
        append(&b, &[user_line("b1")]);
        let mut t = Tailer::new(&dir, "conv-a");
        let _ = t.poll();
        let _ = t.poll();
        assert_eq!(t.conversation_id(), "conv-a");
        assert_eq!(t.transcript_path(), a.as_path());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn newest_sibling_scan_ignores_our_own_file_and_non_jsonl() {
        let dir = tmp_project("siblings");
        std::fs::write(dir.join("conv-a.jsonl"), "").unwrap();
        std::fs::write(dir.join("notes.md"), "x").unwrap();
        assert_eq!(newest_sibling_mtime_ms(&dir, "conv-a"), None);
        std::fs::write(dir.join("conv-b.jsonl"), "").unwrap();
        assert!(newest_sibling_mtime_ms(&dir, "conv-a").is_some());
        let _ = std::fs::remove_dir_all(dir);
    }
}
