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
//! and raise `resync`, which clears the ring so a client can never be shown two
//! conversations spliced together.
//!
//! A re-seed is **bounded and total**:
//!
//! * bounded — a cold cursor starts [`COLD_SEED_BYTES`] back from EOF (snapped
//!   forward to a line start), and the whole cursor set shares
//!   [`COLD_SEED_TOTAL_BYTES`], newest file first. Reading from byte 0 turned a
//!   real 110-file conversation into 80k entries / 739 MB of RSS for a ring
//!   that keeps 500;
//! * total — a shrink in ANY watched file re-seeds EVERY cursor, because the
//!   consumer clears the whole ring. Re-reading only the file that moved would
//!   silently drop every other file from the client's fresh seed.
//!
//! ## The staleness guard
//!
//! [`classify_pointer`] is a pure function over four inputs, covering the three
//! ways the DB pointer can be wrong:
//!
//! | failure mode | detection |
//! |---|---|
//! | server restart (pointer days stale — the c31518e bug class) | running && !hooks_live && within the boot window, measured from `max(session start, SERVER start)` → `Reconnecting` |
//! | terminal-side `--resume` | primary: the `SessionStart` hook refreshes the id and wakes us ([`AppState::chat_pointer_wake_for`]); backstop: our file is cold *while our own hooks are provably active* and a sibling is newer |
//! | hook install failure | running && !hooks_live for > [`NO_HOOKS_AFTER_MS`] → `NoHooks` (the pointer can never self-heal without a hook) |
//!
//! **Never auto-adopt.** A suspect pointer is *reported*, never swapped for a
//! guessed file: adopting the newest sibling would be wrong exactly when two
//! supermux sessions share a cwd. Adoption happens only through
//! [`Tailer::retarget`], driven by the hook-carried `session_id`.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
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

/// How much of an ALREADY-EXISTING file a fresh cursor reads before it starts
/// tailing appends.
///
/// A cold cursor used to start at byte 0 — and so did every subagent cursor the
/// first [`Tailer::rescan_subagents`] created. Measured on a real conversation
/// on this host (`-opt-projects-Reisposter`: 110 files, 1.25 GB, one of many
/// such dirs — a sibling project's `subagents/` is 1.7 GB), a single cold
/// `poll()` produced **80,034 entries in one `Vec`, 2.41 s, 739 MB peak RSS**
/// — for a ring that keeps 500 and a broadcast channel that holds 1024. On the
/// hosts supermux targets that is an OOM, not a slow first paint, and it
/// repeated on every attach more than [`IDLE_GRACE`] after the last detach.
///
/// Roughly one seed page per file is all a cold attach can use; everything
/// older is served from disk by the history route.
pub const COLD_SEED_BYTES: u64 = 512 * 1024;

/// Ceiling on the TOTAL pre-existing bytes ONE cursor set reads. A per-file
/// bound is not a bound when a conversation has >100 subagent files, so the set
/// shares this budget, newest file first. Files past it fall back to
/// [`MIN_COLD_SEED_BYTES`]: their history stays on disk, their appends stream
/// normally.
pub const COLD_SEED_TOTAL_BYTES: u64 = 2 * 1024 * 1024;

/// Floor under the shared budget: every file may always read at least this much
/// of its tail. A subagent that STARTED writing between two polls is already
/// non-empty when we first see it, and parking it at EOF would drop the opening
/// lines of a live turn — the shared budget exists to bound *history*, not to
/// blind the tail.
pub const MIN_COLD_SEED_BYTES: u64 = 64 * 1024;

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
    /// The session is not running because its terminal DIED under it — the
    /// in-memory `holder_died` badge (`auto_actions::HOLDER_DIED`) is up.
    ///
    /// A deliberate stop and a crash leave the same `session_running: false`
    /// behind, and they are not the same claim: after a stop the transcript is
    /// a complete history of a conversation the user ended, while after a crash
    /// it is a conversation that was cut off mid-sentence and whose last turn
    /// may never have been written. Only the crash is a data-plane failure.
    pub session_crashed: bool,
    pub session_last_started_ms: i64,
    /// When THIS server process started ([`AppState::server_start_ms`]).
    pub server_start_ms: i64,
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
    /// The tailer task is GONE, and nothing restarts one for an existing lease.
    ///
    /// A socket that sees this must CLOSE: staying open would leave the client
    /// ping-ponging against a tail nobody maintains, showing a conversation
    /// that stopped updating. `retry` says whether redialing can help (a
    /// transient stop — a blocking pool that went away, an idle sweep) or not
    /// (the row is gone, the session is not chat-eligible).
    Stopped { reason: &'static str, retry: bool },
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

/// The `reason` a pointer whose FILE does not exist is stamped with.
///
/// Named, and pinned by a test on each side, because the client keys a whole
/// presentation decision on it: a session that has never been spoken to has
/// nothing to reconnect TO, so the chat surface suppresses its connection chip
/// while the tail is also empty rather than promising a reconnection that
/// cannot happen (`web/src/components/chat/chat-socket.ts::NO_TRANSCRIPT_REASON`).
pub const NO_TRANSCRIPT_REASON: &str = "no transcript for the tracked conversation";

/// Classify the DB conversation pointer. Pure — the whole guard is table-tested.
pub fn classify_pointer(i: PointerInputs) -> TailState {
    // No file at all. An empty-but-composable chat is precisely the lie this
    // guard exists to prevent, and that is true whether or not the session is
    // still running.
    if !i.pointer_path_exists {
        return TailState::Reconnecting { reason: NO_TRANSCRIPT_REASON };
    }

    // A stopped session's tail is history, not a claim about now: nothing will
    // append to it, so neither a newer sibling nor a silent hook says anything
    // about whether we are reading the right file.
    //
    // …UNLESS the session did not stop, it DIED. A holder that crashed took the
    // agent with it mid-turn: whatever it was writing when it went is not in
    // the file, and no `Stop` hook ever closed the turn. Reporting that as
    // `Live` is the plane telling the surface everything is current while the
    // pane behind it has no process at all — the state in which a composer
    // stayed enabled over a dead session and its sends read as delivered.
    // `Reconnecting` is the honest word: what is on screen stays on screen
    // (`TailState`'s own contract, above), and it is not presented as complete.
    if !i.session_running {
        if i.session_crashed {
            return TailState::Reconnecting { reason: "the session's terminal died" };
        }
        return TailState::Live;
    }

    if !i.hooks_live {
        // The pointer's only self-heal path is a hook. Past the boot window,
        // silence means the hooks are not wired — a state that must be visible,
        // never guessed around.
        //
        // The window runs from the later of the SESSION's start and the
        // SERVER's. `hooks_live` is in-memory only (repopulated solely by an
        // authenticated hook POST), so after a restart — which the in-app
        // updater performs on every release — it is empty for every running
        // session, while `sessions.last_started` is persisted and is hours or
        // days old for exactly the long-lived sessions this guard is for.
        // Measuring from the session alone flipped every idle session straight
        // into the TERMINAL `NoHooks` state until the user submitted a prompt.
        let window_from = i.session_last_started_ms.max(i.server_start_ms);
        if i.now_ms.saturating_sub(window_from) > NO_HOOKS_AFTER_MS {
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
    /// How far back from EOF this cursor was allowed to seed. Kept so a
    /// rotation re-seeds under the SAME bound instead of falling back to 0.
    seed_budget: u64,
}

impl FileCursor {
    /// A cursor over `path` seeded at most `budget` bytes back from EOF.
    /// Returns the cursor and how much of `budget` it actually consumed, so a
    /// cursor SET can share one total budget.
    fn seeded(path: PathBuf, budget: u64) -> (Self, u64) {
        let offset = seed_offset(&path, budget);
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let spent = len.saturating_sub(offset);
        (Self { path, offset, seed_budget: budget }, spent)
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
            // Backstop for a file that shrank between `Tailer::any_shrank` and
            // here. Re-seed under the same bound a cold cursor gets — never
            // byte 0, which on a large rotated file is the flood this cap
            // exists to stop.
            self.offset = seed_offset(&self.path, self.seed_budget);
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

/// Where a cold cursor over `path` starts: `budget` bytes back from EOF, snapped
/// FORWARD past the partial line that lands in the middle of.
///
/// Offsets stay file-absolute (`parse_stream` is told the base), so a seeded
/// cursor's entries carry exactly the same `offset` they would have carried
/// after a full read — the history cursor keeps working across the boundary.
fn seed_offset(path: &Path, budget: u64) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let len = meta.len();
    if len <= budget {
        return 0;
    }
    let back = len - budget;
    let Ok(mut f) = std::fs::File::open(path) else {
        return 0;
    };
    if f.seek(SeekFrom::Start(back)).is_err() {
        return 0;
    }
    let mut buf: Vec<u8> = Vec::new();
    let read = std::io::BufReader::new(f)
        .take(crate::sessions::chat::model::MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut buf);
    match read {
        Ok(n) if buf.last() == Some(&b'\n') => back + n as u64,
        // No line terminator within the parser's own line ceiling: the tail is
        // one pathological line. Start at EOF rather than mid-line — and never
        // fall back to byte 0, which is the unbounded read this bound exists
        // to prevent.
        _ => len,
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
    /// Pre-existing bytes this cursor SET may still read ([`COLD_SEED_TOTAL_BYTES`]).
    cold_budget: u64,
}

impl Tailer {
    pub fn new(project_dir: impl Into<PathBuf>, conversation_id: &str) -> Self {
        let project_dir = project_dir.into();
        let path = transcript_path(&project_dir, conversation_id);
        let mut t = Self {
            project_dir,
            conversation_id: conversation_id.to_string(),
            main: FileCursor { path: path.clone(), offset: 0, seed_budget: 0 },
            subagents: BTreeMap::new(),
            pending_resync: false,
            cold_budget: COLD_SEED_TOTAL_BYTES,
        };
        t.main = t.open_cold(path);
        t
    }

    /// Open a cursor that seeds from the tail, charged against the set's shared
    /// [`COLD_SEED_TOTAL_BYTES`] budget (never below [`MIN_COLD_SEED_BYTES`]).
    /// Bounded by construction, whatever the project dir holds.
    fn open_cold(&mut self, path: PathBuf) -> FileCursor {
        let budget = COLD_SEED_BYTES.min(self.cold_budget).max(MIN_COLD_SEED_BYTES);
        let (cursor, spent) = FileCursor::seeded(path, budget);
        self.cold_budget = self.cold_budget.saturating_sub(spent);
        cursor
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
        let path = transcript_path(&self.project_dir, conversation_id);
        self.subagents.clear();
        self.cold_budget = COLD_SEED_TOTAL_BYTES;
        self.main = self.open_cold(path);
        self.pending_resync = true;
        true
    }

    /// Drain every watched file once.
    pub fn poll(&mut self) -> TailPoll {
        let mut out = TailPoll {
            resync: std::mem::take(&mut self.pending_resync),
            ..Default::default()
        };

        self.rescan_subagents();
        // A rotation/truncation in ANY watched file clears the WHOLE ring
        // downstream (`resync` → `ChatStore::reset`), so EVERY cursor has to
        // re-seed. Re-reading only the file that moved would leave the client's
        // fresh seed holding just that file: a truncated main transcript would
        // silently drop every subagent turn, and a rotated subagent file would
        // re-seed the chat with the subagent's transcript and nothing else.
        if self.any_shrank() {
            self.rewind_all();
            out.resync = true;
        }

        let (main, restarted) = self.main.drain();
        out.resync |= restarted;
        // Sidechain lines in the MAIN file are dropped: the same turns are read,
        // with their agent id, out of `subagents/`. Keeping both would render
        // every subagent turn twice.
        out.entries
            .extend(main.into_iter().filter(|e| !e.is_sidechain));

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
    ///
    /// New cursors are seeded NEWEST FILE FIRST, so when the set's shared cold
    /// budget runs out it is the stale agents (a conversation here has 109 of
    /// them) that start at EOF, never the ones still writing.
    fn rescan_subagents(&mut self) {
        let dir = self.subagents_dir();
        let Ok(read) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut fresh: Vec<(i64, String, PathBuf)> = Vec::new();
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
            if self.subagents.contains_key(id) {
                continue;
            }
            let mtime = entry.metadata().ok().and_then(|m| mtime_ms(&m)).unwrap_or(0);
            fresh.push((mtime, id.to_string(), path));
        }
        fresh.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        for (_, id, path) in fresh {
            let cursor = self.open_cold(path);
            self.subagents.insert(id, cursor);
        }
    }

    /// Did any watched file get SHORTER than its cursor (rotation/truncation)?
    fn any_shrank(&self) -> bool {
        std::iter::once(&self.main)
            .chain(self.subagents.values())
            .any(|c| {
                std::fs::metadata(&c.path).is_ok_and(|m| m.len() < c.offset)
            })
    }

    /// Re-seed EVERY cursor from a fresh shared budget — the counterpart of the
    /// consumer clearing the whole ring on `resync`.
    fn rewind_all(&mut self) {
        self.cold_budget = COLD_SEED_TOTAL_BYTES;
        let main = self.main.path.clone();
        self.main = self.open_cold(main);
        let paths: Vec<(String, PathBuf)> = self
            .subagents
            .iter()
            .map(|(id, c)| (id.clone(), c.path.clone()))
            .collect();
        for (id, path) in paths {
            let cursor = self.open_cold(path);
            self.subagents.insert(id, cursor);
        }
    }

    /// Test seam: how many bytes the current cursor set would still read (file
    /// length minus cursor offset, summed). The cold-seed bound is a claim
    /// about exactly this number.
    #[cfg(test)]
    fn pending_span(&self) -> u64 {
        std::iter::once(&self.main)
            .chain(self.subagents.values())
            .map(|c| {
                std::fs::metadata(&c.path)
                    .map(|m| m.len().saturating_sub(c.offset))
                    .unwrap_or(0)
            })
            .sum()
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
    let (handle, fresh) = claim(name);
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

/// Take a subscriber claim on `name`'s handle, creating the slot when the
/// session has no tailer yet (the `bool` says whether the caller must start the
/// task). The count is incremented **inside the map entry's shard lock** — the
/// same lock [`sweep_if_idle`] takes — so the grace-period sweep can never
/// remove a slot a claim has already joined but not yet counted. Incrementing
/// after the lock is released would hand the caller a handle whose task is
/// exiting, and its chat would stay empty forever.
fn claim(name: &str) -> (Arc<TailerHandle>, bool) {
    let mut fresh = false;
    let entry = registry().entry(name.to_string()).or_insert_with(|| {
        fresh = true;
        Arc::new(TailerHandle {
            subscribers: AtomicUsize::new(0),
            status: watch::channel(TailStatus::default()).0,
        })
    });
    entry.value().subscribers.fetch_add(1, Ordering::AcqRel);
    (entry.value().clone(), fresh)
}

/// Drop `name`'s slot iff nothing holds a claim — the grace-period exit. Runs
/// under the same shard lock as [`claim`], so a subscriber arriving right now
/// either wins the lock (we see its claim and keep running) or finds the slot
/// gone and starts a fresh tailer.
///
/// `on_sweep` runs INSIDE that shard lock and is where the session's chat ring
/// is released. It has to be inside: releasing the store after the lock would
/// race a client that has already claimed a fresh slot and taken the store —
/// the tailer would then publish into a store nobody is subscribed to.
fn sweep_if_idle(name: &str, on_sweep: impl Fn()) -> bool {
    registry()
        .remove_if(name, |_, h| {
            let idle = h.subscribers.load(Ordering::Acquire) == 0;
            if idle {
                on_sweep();
            }
            idle
        })
        .is_some()
}

/// Give up `name`'s slot on ANY other loop exit (a deleted row, an ineligible
/// session, a gone blocking pool). A dead handle left registered would make the
/// next attach — session names are reusable — join a task that no longer runs
/// and never receive a single entry. Only OUR handle is removed: if a sweep
/// already let a newer task install its own, that one is left alone.
fn abandon(name: &str, handle: &Arc<TailerHandle>) -> bool {
    registry()
        .remove_if(name, |_, h| Arc::ptr_eq(h, handle))
        .is_some()
}

/// The current tail status without taking a lease (does not start a tailer).
pub fn status_of(name: &str) -> Option<TailStatus> {
    registry().get(name).map(|h| h.status())
}

/// Facts one blocking pass collected about the tail, so the async loop never
/// touches the filesystem itself.
struct Pass {
    /// Sealed HERE, on the blocking pool — see
    /// [`ChatStore::publish_sealed`](super::store::ChatStore::publish_sealed).
    entries: Vec<super::model::WireEntry>,
    resync: bool,
    pointer_exists: bool,
    pointer_mtime_ms: Option<i64>,
    newest_sibling_mtime_ms: Option<i64>,
}

/// One filesystem pass. `want_siblings` gates the project-dir scan: it is a
/// `read_dir` + `statx` of every top-level `*.jsonl` (153 files in the worst
/// real dir on this host) and is consumed by exactly ONE branch of
/// [`classify_pointer`] — the `--resume` backstop, which needs a running,
/// hooked, *recently* hooked session. The loop body runs on every poll AND on
/// every debounced FS burst, so computing it unconditionally cost thousands of
/// `statx` per second across a busy server for a value most passes discarded.
fn blocking_pass(mut core: Tailer, want_siblings: bool) -> (Tailer, Pass) {
    let poll = core.poll();
    let meta = std::fs::metadata(core.transcript_path()).ok();
    let pass = Pass {
        entries: poll
            .entries
            .iter()
            .map(super::model::WireEntry::seal_pending)
            .collect(),
        resync: poll.resync,
        pointer_exists: meta.is_some(),
        pointer_mtime_ms: meta.as_ref().and_then(mtime_ms),
        newest_sibling_mtime_ms: want_siblings
            .then(|| newest_sibling_mtime_ms(core.project_dir(), core.conversation_id()))
            .flatten(),
    };
    (core, pass)
}

async fn run(state: AppState, name: String, handle: Arc<TailerHandle>) {
    let store = state.chat_store_for(&name);
    let pointer_wake = state.chat_pointer_wake_for(&name);
    let fs_wake = Arc::new(Notify::new());
    // The watcher is a live guard: dropping it stops the watch, so it is kept
    // paired with the directory it is armed on. The INNER `Option` memoises a
    // failed arm — without it every pass rebuilt (and dropped) an inotify
    // instance, forever, because the "already armed?" test could never be true.
    let mut watcher: Option<(PathBuf, Option<notify::RecommendedWatcher>)> = None;
    let mut core: Option<Tailer> = None;
    let mut idle_since: Option<Instant> = None;
    let mut resync_epoch = 0u64;

    let mut tick = tokio::time::interval(POLL_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Every exit reports WHY, and the socket closes on it: nothing restarts a
    // tailer for an existing lease, so a task that quits silently leaves its
    // clients ping-ponging against a tail that no longer moves.
    let stopped = loop {
        // Idle shutdown, checked FIRST so every path through the body is
        // subject to it — including the DB-error retry below. Keep the cursor
        // warm through a reload, then let go of both the slot and the ring.
        if handle.subscribers.load(Ordering::Acquire) == 0 {
            let since = *idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= IDLE_GRACE
                && sweep_if_idle(&name, || state.drop_chat_store(&name))
            {
                break TailState::Stopped { reason: "chat tail idle", retry: true };
            }
        } else {
            idle_since = None;
        }

        // The session row is the pointer's source of truth; a vanished row (or a
        // session that is not an eligible local Claude one) ends the task.
        let row = match crate::db::sessions::get(&state.pool, &name).await {
            Ok(Some(row)) => row,
            // Verbatim `CLOSE_REASON_NO_SESSION` so the client's `goneFor`
            // recognises it and renders "This session no longer exists." — a
            // generic phrasing here (the old "session is gone") closed 4404 but
            // fell through `goneFor` to the flat "Couldn't load this
            // conversation." over a session the user just deleted.
            Ok(None) => break TailState::Stopped {
                reason: super::ws::CLOSE_REASON_NO_SESSION,
                retry: false,
            },
            // A pool timeout / SQLITE_BUSY is NOT "the row was deleted".
            // Treating it as one killed the session's chat for good — the task
            // exited and nothing ever started another one for the open socket.
            Err(e) => {
                tracing::debug!(session = %name, error = %e, "chat tailer: session row read failed");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        if row.provider != "claude" || row.host_id.is_some() {
            break TailState::Stopped {
                reason: "chat is unavailable for this session",
                retry: false,
            };
        }

        let project = resumable::project_dir_for(&row.dir);
        let conv = row.cc_conversation_id.clone();
        let rebuilt = rebuild(&mut core, &project, &conv);

        // Arm/re-arm the directory watcher (best effort; the poll runs anyway).
        if watcher.as_ref().map(|(p, _)| p.as_path()) != Some(project.as_path()) {
            watcher = Some((project.clone(), arm_fs_watcher(&project, fs_wake.clone())));
        }

        // The guard's non-filesystem inputs, read BEFORE the pass so the pass
        // knows whether the sibling scan is worth doing at all.
        let now_ms = chrono::Utc::now().timestamp_millis();
        let hooks_live = state.has_hooks(&name);
        let last_hook = last_hook_ms(&state, &name, now_ms);
        let (running, crashed) = session_liveness(&state, &name).await;
        let hook_fresh = last_hook
            .is_some_and(|h| now_ms.saturating_sub(h) <= HOOK_ACTIVITY_WINDOW_MS);

        // Filesystem work happens off the async worker: a re-seed can read a
        // whole seed window from disk.
        let taken = core.take().expect("core was just set");
        let want_siblings = running && hooks_live && hook_fresh;
        let pass = tokio::task::spawn_blocking(move || blocking_pass(taken, want_siblings)).await;
        // The blocking pool is gone (shutdown), or the pass panicked. Either
        // way this task is done — say so, loudly, instead of leaving every
        // attached socket waiting on a tail that will never move again.
        let Ok((returned, pass)) = pass else {
            tracing::warn!(session = %name, "chat tailer: blocking pass did not complete");
            break TailState::Stopped { reason: "tail worker stopped", retry: true };
        };
        core = Some(returned);

        if rebuilt || pass.resync {
            // The ring holds what the PREVIOUS cursor set published: another
            // conversation after a retarget, or a second copy of this one when a
            // fresh task re-reads the file from byte 0. Clearing it (seq stays
            // monotonic) is what makes "resync" mean "re-seed" rather than
            // "splice" or "double".
            if store.reset() {
                // An already-empty ring means the client has nothing to drop, so
                // a cold first attach never spends an epoch on a no-op.
                resync_epoch += 1;
            }
        }
        store.publish_sealed(pass.entries);

        let state_now = classify_pointer(PointerInputs {
            pointer_path_exists: !conv.is_empty() && pass.pointer_exists,
            pointer_mtime_ms: pass.pointer_mtime_ms,
            newest_sibling_mtime_ms: pass.newest_sibling_mtime_ms,
            hooks_live,
            last_hook_ms: last_hook,
            session_running: running,
            session_crashed: crashed,
            // `sessions.last_started` is stored in SECONDS.
            session_last_started_ms: row.last_started.saturating_mul(1_000),
            server_start_ms: state.server_start_ms,
            now_ms,
        });
        let status = TailStatus { state: state_now, resync_epoch };
        handle.status.send_if_modified(|cur| {
            let changed = *cur != status;
            *cur = status;
            changed
        });

        tokio::select! {
            _ = tick.tick() => {}
            _ = fs_wake.notified() => { tokio::time::sleep(FS_DEBOUNCE).await; }
            // A hook just changed `cc_conversation_id`: re-resolve NOW rather
            // than waiting for the backstop to notice a cold pointer.
            _ = pointer_wake.notified() => {}
        }
    };

    // Every exit path gives the slot back, so a re-attach (or a session created
    // later under the same, reusable, name) starts a real tailer instead of
    // joining this dead one. After a sweep this is a no-op; after an early exit
    // — deleted row, ineligible session, gone blocking pool — it is the thing
    // that stops a lease from waiting forever on a task that is gone.
    //
    // Deliberately NOT conditional on `subscribers == 0`: a claim that lands
    // between the loop's exit and here holds a handle whose task is already
    // gone, and leaving the slot registered would make it — and every later
    // attach — join a tailer that will never publish. Removing the slot and
    // publishing `Stopped` is what lets that client close and redial into a
    // fresh task.
    abandon(&name, &handle);
    handle.status.send_if_modified(|cur| {
        let next = TailStatus { state: stopped, ..*cur };
        let changed = *cur != next;
        *cur = next;
        changed
    });
}

/// (Re)build the cursor set for this pass; `true` when the client must resync.
///
/// A **first** build counts, and that is load-bearing: the
/// [`ChatStore`](super::store::ChatStore) lives
/// in `AppState::chat_stores` and OUTLIVES this task (the loop exits
/// [`IDLE_GRACE`] after the last lease drops; the store is only dropped on
/// session delete). A fresh cursor set starts at byte 0, so without the resync a
/// restarted tailer would publish every entry the previous one already
/// published, and the seed would show the whole conversation twice.
fn rebuild(core: &mut Option<Tailer>, project: &Path, conversation_id: &str) -> bool {
    match core.as_mut() {
        // Same project dir: only a moved pointer changes anything, and it is the
        // one adoption path (hook-carried id, never a guessed sibling).
        Some(t) if t.project_dir() == project => t.retarget(conversation_id),
        // First pass of this task, or the session's cwd moved under us.
        _ => {
            *core = Some(Tailer::new(project, conversation_id));
            true
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

/// `(running, crashed)` for [`classify_pointer`], from the most authoritative
/// source that is actually available.
///
/// The detector's own recent classification (the in-memory `cadence_recency`
/// cache) and the `HOLDER_DIED` badge are the fast, precise answer — but they
/// are BOTH in-memory and empty right after a server restart, which the in-app
/// updater performs on every release. That restart window is exactly where a
/// holder that died before or during the restart used to slip through: with no
/// cache and no badge, `session_running` fell back to the runtime probe, found
/// it dead (`running=false`), and `session_crashed` returned false because the
/// badge was gone — so `classify_pointer` read `!running && !crashed` as a clean
/// STOP and returned `Live`, presenting a dead data plane as a trustworthy
/// historical tail.
///
/// The fix consults a PERSISTENT signal when the cache is cold: the DB's
/// `last_status`. `force_stopped_on_death` and a user Stop both persist
/// `stopped`, so a dead runtime whose persisted status is `stopped` is a clean
/// stop (→ `Live`, history). But a dead runtime whose persisted status is
/// anything else — `active`/`idle`/`starting` — was supposed to be RUNNING, so
/// its death was never recorded as a stop: that is a crash, and it must classify
/// `Reconnecting`, not `Live`.
async fn session_liveness(state: &AppState, name: &str) -> (bool, bool) {
    let badge_crashed = holder_died_badge(state, name);

    // The detector's last classification, recomputed every ~2s while this
    // process has been up. Present ⇒ trust it, and the badge is the crash bit.
    let cached = {
        let map = state.cadence_recency.lock().unwrap_or_else(|e| e.into_inner());
        map.get(name).map(|r| r.status)
    };
    if let Some(status) = cached {
        let running = status != crate::sessions::status::Status::Stopped;
        return (running, !running && badge_crashed);
    }

    // Cold cache (fresh process). Probe the runtime directly.
    let alive = match state.runtime_for(name).await {
        Ok(rt) => rt.alive().await,
        Err(_) => false,
    };
    if alive {
        return (true, false);
    }

    // Not alive, and no in-memory tick to say whether that was intended. The
    // persisted status is the tie-breaker. Only a status that positively means
    // the session was RUNNING (active/idle/waiting/starting) turns a dead
    // runtime into a crash: its death was never recorded as a stop. `stopped` is
    // a clean stop, and `unknown` — the cold-start non-decision — is NOT
    // evidence the session was ever live, so neither is a crash. This keeps a
    // never-run / freshly-tracked session (persisted `unknown`) reporting its
    // historical tail as Live rather than falsely flagging it crashed.
    let persisted_running = crate::db::sessions::runtime(&state.pool, name)
        .await
        .ok()
        .flatten()
        .is_some_and(|r| is_running_status(&r.last_status));
    (false, badge_crashed || persisted_running)
}

/// Does a persisted `last_status` mean the session was RUNNING (as opposed to a
/// clean `stopped` or the cold-start `unknown`)? A dead runtime under one of
/// these is a crash the restart erased the badge for.
fn is_running_status(last_status: &str) -> bool {
    use crate::sessions::status::Status;
    last_status == Status::Active.as_str()
        || last_status == Status::Idle.as_str()
        || last_status == Status::Waiting.as_str()
        || last_status == Status::Starting.as_str()
}

/// Did the death detector raise the in-memory `HOLDER_DIED` badge?
///
/// (`auto_actions::force_stopped_on_death` → `state.set_error(HOLDER_DIED)`),
/// which is also what the roster and the focus header read to draw "Terminal
/// died". Cleared on the next `UserPromptSubmit`/`SessionStart`, so a healed or
/// restarted session stops being crashed the moment it is alive again — and gone
/// entirely after a server restart, which is why [`session_liveness`] cannot
/// rely on it alone.
fn holder_died_badge(state: &AppState, name: &str) -> bool {
    state
        .session_activity(name)
        .and_then(|a| a.error)
        .is_some_and(|(kind, _)| kind == crate::sessions::auto_actions::HOLDER_DIED)
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
    use crate::sessions::status::Status;
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
            session_crashed: false,
            session_last_started_ms: 10_000,
            server_start_ms: 0,
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

    /// THE CLIENT KEYS A PRESENTATION DECISION ON THIS EXACT STRING.
    ///
    /// A session that has never been spoken to has no transcript file, so this
    /// branch fires from its first frame — and, unlike `no_hooks`, it has no
    /// escalation ceiling, so it never changes. The chat surface therefore
    /// reads the REASON (not the collapsed one-word state) and stands its
    /// connection chip down while the tail is also empty, instead of promising
    /// a reconnection that cannot happen. `web/src/components/chat/chat-socket.ts`
    /// carries the twin constant and `web/tests/unit/chat-connection.test.ts`
    /// the twin assertion; the day this string moves, one of the two fails.
    #[test]
    fn a_missing_pointer_names_its_reason_and_the_client_can_match_it() {
        let i = PointerInputs { pointer_path_exists: false, ..base() };
        assert_eq!(
            classify_pointer(i),
            TailState::Reconnecting { reason: NO_TRANSCRIPT_REASON }
        );
        assert_eq!(NO_TRANSCRIPT_REASON, "no transcript for the tracked conversation");
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
    fn a_server_restart_does_not_flip_every_running_session_to_no_hooks() {
        // `hooks_live` is IN-MEMORY: a restart (the in-app updater does one on
        // every release) empties it for every running session, while
        // `sessions.last_started` is persisted and days old for exactly the
        // long-lived sessions this guard exists for. Measuring the window from
        // the session's start alone put every idle session into the TERMINAL
        // `NoHooks` state — "hooks are not installed" — until the user
        // happened to submit a prompt.
        let just_restarted = PointerInputs {
            hooks_live: false,
            session_running: true,
            session_last_started_ms: 0, // started days ago
            server_start_ms: 99_000,    // …but WE started 1s ago
            now_ms: 100_000,
            ..base()
        };
        assert!(
            matches!(classify_pointer(just_restarted.clone()), TailState::Reconnecting { .. }),
            "inside the SERVER's boot window a silent hook is unproven, not broken"
        );

        // …and once the server itself has been up past the window with still no
        // hook, it really is the terminal state.
        let settled = PointerInputs {
            now_ms: 99_000 + NO_HOOKS_AFTER_MS + 1,
            ..just_restarted
        };
        assert_eq!(classify_pointer(settled), TailState::NoHooks);
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
    fn a_session_whose_terminal_died_is_not_live() {
        // The regression this pins: a CRASHED holder left `session_running:
        // false` behind and took the branch above, so the socket published
        // `Live` for a pane with no process in it. The surface read that as a
        // current conversation, kept its composer enabled, and reported the
        // sends it swallowed as delivered. A crash is not a stop.
        let died = PointerInputs {
            session_running: false,
            session_crashed: true,
            hooks_live: false,
            last_hook_ms: None,
            pointer_mtime_ms: Some(1_000),
            newest_sibling_mtime_ms: Some(99_999),
            session_last_started_ms: 0,
            ..base()
        };
        assert!(
            matches!(classify_pointer(died.clone()), TailState::Reconnecting { .. }),
            "a holder that died mid-turn must never publish a live tail",
        );

        // …and the two are told apart by the badge alone: the same inputs with
        // a DELIBERATE stop are still the historical tail, unchanged.
        let stopped = PointerInputs { session_crashed: false, ..died };
        assert_eq!(classify_pointer(stopped), TailState::Live);

        // A crash badge on a session that is RUNNING again (healed, restarted)
        // says nothing — `session_running` wins, and the normal ladder applies.
        let healed = PointerInputs { session_running: true, session_crashed: true, ..base() };
        assert_eq!(classify_pointer(healed), TailState::Live);
    }

    async fn liveness_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-liveness-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    #[tokio::test]
    async fn a_dead_runtime_after_a_restart_classifies_crashed_not_a_clean_stop() {
        // #9 (MEDIUM): dead-vs-stopped used to be inferred ONLY from the in-memory
        // HOLDER_DIED badge and the in-memory detector cache. Both are empty right
        // after a server restart (the in-app updater restarts on every release),
        // so a holder that died before/during the restart fell through: the
        // runtime probe found it dead (running=false), the badge was gone
        // (crashed=false), and classify_pointer read that as a clean stop → Live,
        // presenting a dead data plane as a trustworthy historical tail.
        //
        // The persisted `last_status` is the tie-breaker the restart cannot erase.
        let (state, dir) = liveness_state().await;
        let name = "dead-after-restart";
        crate::db::sessions::insert_minimal(&state.pool, name, "/tmp", "claude")
            .await
            .unwrap();
        crate::db::sessions::ensure_runtime(&state.pool, name, "tok")
            .await
            .unwrap();

        // Simulate the exact post-restart state: no cadence tick recorded, no
        // HOLDER_DIED badge, runtime not alive, and a persisted status that says
        // the session was RUNNING when the process went down.
        crate::db::sessions::set_last_status(&state.pool, name, Status::Active.as_str())
            .await
            .unwrap();
        assert!(
            state.cadence_recency.lock().unwrap().get(name).is_none(),
            "the detector cache must be cold, as it is after a restart"
        );
        let (running, crashed) = session_liveness(&state, name).await;
        assert!(!running, "the runtime is not alive");
        assert!(
            crashed,
            "a dead runtime whose persisted status was RUNNING is a crash, not a stop"
        );
        assert!(
            matches!(
                classify_pointer(PointerInputs {
                    session_running: running,
                    session_crashed: crashed,
                    ..base()
                }),
                TailState::Reconnecting { .. }
            ),
            "so the tail must publish Reconnecting, never Live",
        );

        // The control: a session the user DELIBERATELY stopped persists `stopped`,
        // and after the same restart its historical tail is still legitimately
        // Live — the fix must not flag a clean stop as a crash.
        crate::db::sessions::set_last_status(&state.pool, name, Status::Stopped.as_str())
            .await
            .unwrap();
        let (running, crashed) = session_liveness(&state, name).await;
        assert!(!running);
        assert!(!crashed, "a persisted clean stop is history, not a crash");
        assert_eq!(
            classify_pointer(PointerInputs {
                session_running: running,
                session_crashed: crashed,
                ..base()
            }),
            TailState::Live,
        );

        // A freshly-tracked / never-run session persists `unknown` — the
        // cold-start non-decision, NOT evidence it was ever live — so a dead
        // runtime under it is history, not a crash. (This is the exact edge that
        // must not flip a brand-new chat's tail to Reconnecting.)
        crate::db::sessions::set_last_status(&state.pool, name, Status::Unknown.as_str())
            .await
            .unwrap();
        let (running, crashed) = session_liveness(&state, name).await;
        assert!(!running);
        assert!(!crashed, "persisted `unknown` is not proof the session was running");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
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

    // ── the cold-seed bound ─────────────────────────────────────────────────

    /// Enough lines to blow past `COLD_SEED_BYTES` several times over.
    fn big_file(path: &Path, lines: usize, tag: &str) {
        let body: Vec<String> = (0..lines).map(|i| user_line(&format!("{tag}{i}"))).collect();
        append(path, &body);
    }

    #[tokio::test]
    async fn a_cold_cursor_seeds_from_the_tail_not_from_byte_zero() {
        // Pre-fix a fresh cursor started at byte 0 and `drain()` read to EOF, so
        // one cold poll over a real conversation returned 80k entries / 739 MB
        // RSS for a ring that keeps 500.
        let dir = tmp_project("coldseed");
        let f = dir.join("conv-a.jsonl");
        big_file(&f, 8_000, "u");
        let len = std::fs::metadata(&f).unwrap().len();
        assert!(len > COLD_SEED_BYTES, "the fixture must exceed the cold bound");

        let mut t = Tailer::new(&dir, "conv-a");
        assert!(
            t.pending_span() <= COLD_SEED_BYTES,
            "a cold cursor must not queue up the whole {len}-byte file"
        );
        let p = t.poll();
        assert!(!p.entries.is_empty());
        assert!(p.entries.len() < 8_000, "the cold seed is the TAIL, not the file");
        assert_eq!(
            p.entries.last().unwrap().uuid,
            "u7999",
            "…and it must end at the newest line"
        );

        // The seed starts exactly ON a line boundary: the byte before the first
        // entry's offset is the previous line's terminator.
        let first = p.entries[0].offset;
        assert!(first > 0);
        let raw = std::fs::read(&f).unwrap();
        assert_eq!(raw[first as usize - 1], b'\n', "a seed must never start mid-line");
        assert_eq!(&raw[first as usize..first as usize + 1], b"{");

        // …and tailing continues normally from there.
        append(&f, &[user_line("u8000")]);
        assert_eq!(uuids(&t.poll().entries), ["u8000"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_cold_pass_over_many_subagents_shares_one_total_budget() {
        // The real shape this bound is for: `-opt-projects-Reisposter` has a
        // single conversation with 109 subagent files / 986 MB. A per-file cap
        // is not a cap; the SET shares one, newest file first.
        let dir = tmp_project("coldsubs");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1")]);
        let subs = dir.join("conv-a").join("subagents");
        let mut paths = Vec::new();
        for i in 0..8 {
            let p = subs.join(format!("agent-x{i}.jsonl"));
            big_file(&p, 4_000, &format!("s{i}_"));
            paths.push(p);
        }
        let total: u64 = paths
            .iter()
            .map(|p| std::fs::metadata(p).unwrap().len())
            .sum();
        assert!(total > COLD_SEED_TOTAL_BYTES * 2, "the fixture must dwarf the budget");

        let mut t = Tailer::new(&dir, "conv-a");
        t.rescan_subagents();
        let span = t.pending_span();
        let ceiling = COLD_SEED_TOTAL_BYTES + 9 * MIN_COLD_SEED_BYTES;
        assert!(
            span <= ceiling,
            "a cold cursor SET queued {span} bytes of a {total}-byte subagents dir; \
             the bound is {ceiling}"
        );
        // Newest first: the last file written gets a full COLD_SEED_BYTES
        // window, the first one written is down to the floor.
        let newest = t.subagents.get("x7").unwrap();
        let oldest = t.subagents.get("x0").unwrap();
        let span_of = |c: &FileCursor| std::fs::metadata(&c.path).unwrap().len() - c.offset;
        assert!(span_of(newest) > MIN_COLD_SEED_BYTES);
        assert!(
            span_of(oldest) <= MIN_COLD_SEED_BYTES,
            "a stale agent past the shared budget must fall back to the floor"
        );
        // A file that appears LATER is empty when we meet it, so it costs
        // nothing and is tailed in full.
        let late = subs.join("agent-z9.jsonl");
        append(&late, &[sidechain_line("late1", None)]);
        let ids = uuids(&t.poll().entries);
        assert!(ids.contains(&"late1".to_string()), "a new agent must still be tailed whole");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_rotation_in_one_file_reseeds_every_cursor_not_just_that_one() {
        // `resync` clears the WHOLE ring downstream, so a re-seed that re-reads
        // only the file that moved leaves the client holding just that file.
        let dir = tmp_project("rotate-all");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1"), user_line("u2")]);
        let sub = dir.join("conv-a").join("subagents").join("agent-x1.jsonl");
        append(&sub, &[sidechain_line("s1", None), sidechain_line("s2", None)]);

        let mut t = Tailer::new(&dir, "conv-a");
        assert_eq!(uuids(&t.poll().entries), ["u1", "u2", "s1", "s2"]);

        // The SUBAGENT file rotates (rewritten shorter). The main file did not
        // move — and must still be re-published, or it vanishes from the seed.
        std::fs::write(&sub, format!("{}\n", sidechain_line("z1", None))).unwrap();
        let after = t.poll();
        assert!(after.resync, "a backwards length is a client-visible resync");
        assert_eq!(
            uuids(&after.entries),
            ["u1", "u2", "z1"],
            "every cursor re-seeds, not only the one that rotated"
        );

        // Mirror case: the MAIN file rotates, the subagent did not.
        std::fs::write(&f, format!("{}\n", user_line("m1"))).unwrap();
        let after = t.poll();
        assert!(after.resync);
        assert_eq!(uuids(&after.entries), ["m1", "z1"]);
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

    // ── the cursor set vs. the store, which outlives the task ────────────────

    #[test]
    fn a_restarted_tailer_reseeds_the_ring_instead_of_doubling_it() {
        // The store lives in `AppState::chat_stores` and survives the task's
        // IDLE_GRACE exit. A new task starts with a COLD cursor and re-reads the
        // file from byte 0, so unless a fresh cursor set counts as a resync every
        // entry is published — and seeded — a second time.
        use crate::sessions::chat::store::ChatStore;
        let dir = tmp_project("restart");
        let f = dir.join("conv-a.jsonl");
        append(&f, &[user_line("u1"), user_line("u2")]);
        let store = ChatStore::new();

        let mut task1: Option<Tailer> = None;
        assert!(rebuild(&mut task1, &dir, "conv-a"));
        store.reset();
        store.publish(task1.as_mut().unwrap().poll().entries);
        assert_eq!(store.attach().ring.len(), 2);

        // …the last lease drops, the task exits, the store stays. A new attach:
        let mut task2: Option<Tailer> = None;
        assert!(
            rebuild(&mut task2, &dir, "conv-a"),
            "a cold cursor over a warm ring MUST resync, or the seed doubles"
        );
        store.reset();
        store.publish(task2.as_mut().unwrap().poll().entries);
        let ring = store.attach().ring;
        assert_eq!(ring.len(), 2, "the conversation must not be seeded twice");
        assert_eq!(ring.iter().map(|w| w.uuid()).collect::<Vec<_>>(), ["u1", "u2"]);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rebuild_is_quiet_while_nothing_moved_and_loud_when_it_does() {
        let dir = tmp_project("rebuild");
        let other = tmp_project("rebuild-moved");
        let mut core: Option<Tailer> = None;
        assert!(rebuild(&mut core, &dir, "conv-a"), "the first build is a resync");
        assert!(!rebuild(&mut core, &dir, "conv-a"), "an unchanged pointer must not churn");
        assert!(rebuild(&mut core, &dir, "conv-b"), "a moved pointer re-seeds");
        assert_eq!(core.as_ref().unwrap().conversation_id(), "conv-b");
        assert!(rebuild(&mut core, &other, "conv-b"), "a moved cwd is a fresh cursor set");
        assert_eq!(core.as_ref().unwrap().project_dir(), other.as_path());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(other);
    }

    // ── the registry: claims, the idle sweep, and early exits ────────────────

    #[test]
    fn the_idle_sweep_never_removes_a_claimed_tailer_and_releases_the_ring_with_it() {
        let name = format!("sweep-{}", uuid::Uuid::new_v4());
        // The store release rides INSIDE the sweep's shard-lock predicate, so
        // it must fire exactly when — and only when — the slot is removed.
        let released = std::cell::Cell::new(0usize);
        let sweep = || sweep_if_idle(&name, || released.set(released.get() + 1));

        let (h, fresh) = claim(&name);
        assert!(fresh, "the first claim must start a task");
        assert!(!sweep(), "a claimed tailer must not be swept");

        let (h2, fresh2) = claim(&name);
        assert!(!fresh2, "a second subscriber joins the running task");
        assert!(Arc::ptr_eq(&h, &h2));
        h2.subscribers.fetch_sub(1, Ordering::AcqRel);
        assert!(!sweep(), "one lease is still holding it open");
        assert_eq!(released.get(), 0, "a live tailer's ring must never be released");

        h.subscribers.fetch_sub(1, Ordering::AcqRel);
        assert!(sweep(), "the last lease gone → the slot is released");
        assert!(status_of(&name).is_none());
        assert_eq!(
            released.get(),
            1,
            "…and the ring goes with it, or the transcript stays resident for the \
             process lifetime for every session anyone ever opened chat on"
        );
    }

    #[test]
    fn an_early_exit_leaves_no_dead_handle_for_the_next_attach_to_join() {
        // A deleted row / ineligible session breaks out of the loop with a lease
        // still alive. If the slot stayed, the NEXT attach — session names are
        // reusable — would join a handle whose task is gone and tail nothing.
        let name = format!("abandon-{}", uuid::Uuid::new_v4());
        let (dead, _) = claim(&name);
        assert!(abandon(&name, &dead), "the exiting task gives its slot back");

        let (fresh_handle, fresh) = claim(&name);
        assert!(fresh, "a re-attach after an early exit must start a NEW tailer");
        assert!(!Arc::ptr_eq(&dead, &fresh_handle));

        // …and a stale task that exits later must not evict the live one.
        assert!(!abandon(&name, &dead), "only OUR handle is ever removed");
        assert!(status_of(&name).is_some());
        fresh_handle.subscribers.fetch_sub(1, Ordering::AcqRel);
        assert!(sweep_if_idle(&name, || {}));
    }

    #[test]
    fn a_stopped_tail_is_a_state_the_socket_can_act_on() {
        // The WS `Err(_)` arm on `lease.changed()` is unreachable while a lease
        // is alive (the lease OWNS the handle that owns the `watch::Sender`),
        // so a task that just exited used to leave every attached socket
        // ping-ponging against a tail nobody maintains. The exit reason rides
        // the status channel instead — and says whether redialing helps.
        for (state, retry) in [
            (TailState::Stopped { reason: crate::sessions::chat::ws::CLOSE_REASON_NO_SESSION, retry: false }, false),
            (TailState::Stopped { reason: "tail worker stopped", retry: true }, true),
        ] {
            let TailState::Stopped { reason, retry: got } = state else {
                unreachable!()
            };
            assert!(!reason.is_empty(), "a stop reason rides the close frame");
            assert_eq!(got, retry);
            let v = serde_json::to_value(TailStatus { state, resync_epoch: 3 }).unwrap();
            assert_eq!(v["state"], serde_json::json!("stopped"));
            assert_eq!(v["retry"], serde_json::json!(retry));
        }
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
