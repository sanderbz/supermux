//! The chat WebSocket, the seed→live boundary, and the two backlog REST routes.
//!
//! Registered in [`crate::ws::router_for`] — **not** in
//! [`crate::sessions::router_for`]. The bearer middleware that protects the REST
//! surface cannot be satisfied by a browser `WebSocket` (it cannot set an
//! `Authorization` header), which is exactly why the terminal socket lives
//! outside it too. Auth is therefore in-band first-frame, verified with the
//! terminal socket's own [`crate::ws::verify_auth_frame`] /
//! [`crate::ws::origin_allowed`], so the two sockets fail identically.
//!
//! ## Frames
//!
//! server→client (all JSON text):
//! - `auth_ok` — the handshake echo, same literal the terminal socket sends.
//! - `seed` — one page of already-sealed [`WireEntry`]s (newest-last), plus
//!   `has_more`/`next_before` for paging further back through the REST route.
//! - `seed_done` — `high_water` (the exact seed→live boundary) and the flattened
//!   tail state.
//! - `entry` — one live entry. Sent **only** when `seq >= high_water`.
//! - `state` — a staleness transition (`live` / `reconnecting` / `no_hooks`).
//! - `resync` — the client must drop what it has; a fresh `seed`/`seed_done`
//!   follows immediately. Raised by a `Lagged` broadcast receiver and by the
//!   tailer bumping its resync epoch (pointer change / file rotation).
//!
//! client→server: `{"type":"auth","token":…}` and nothing else. A2 is a
//! read-only data plane, so any other frame is ignored (it only refreshes the
//! liveness timer) rather than being an error.
//!
//! ## No gap, no overlap
//!
//! The proof lives in [`super::store`]: `publish` seals+pushes+broadcasts under
//! one lock and `attach` snapshots+subscribes under the same one. This module
//! consumes that guarantee in exactly one place — [`classify_live`], which
//! forwards a live frame only when `seq >= high_water` while the seed carries
//! exactly `seq < high_water`. Dedupe is arithmetic; no uuid or text matching.
//!
//! ## Caps on BOTH paths
//!
//! Every entry that reaches a client — live, seed, or history page — is built by
//! [`WireEntry::seal`], which is the only constructor of the wire type and
//! applies [`MAX_ENTRY_BYTES`]. The seed page additionally stops at
//! [`SEED_MAX_BYTES`] *by measured bytes*, not by entry count. `fetch-full`
//! ([`entry_handler`]) is the deliberate escape hatch for a `truncated` entry
//! and is the one path that serializes an unsealed body — bounded by the
//! parser's own [`MAX_LINE_BYTES`](super::model::MAX_LINE_BYTES) line ceiling.

use std::io::BufReader;
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::ws::{close_code, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::Json;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::time::{Instant, MissedTickBehavior};

use super::model::{ChatEntry, Kind, WireEntry, SEED_MAX_BYTES};
use super::parser::parse_stream;
use super::store::{ChatStore, RING_CAP};
use super::tailer::{spawn_tailer, TailState, TailStatus, TailerLease};
use crate::db;
use crate::error::AppError;
use crate::sessions::resumable;
use crate::state::AppState;

/// Default backlog page size for [`history_handler`].
pub const HISTORY_DEFAULT_LIMIT: usize = 200;
/// Hard ceiling on `?limit=` — one ring's worth. A client that wants more pages
/// backwards; it never gets to ask for the whole 8.9 MB corpus in one request.
pub const HISTORY_MAX_LIMIT: usize = RING_CAP;
/// How long a cold attach waits for the tailer's first pass before seeding.
///
/// Without it the very first client of a session would seed an empty ring and
/// watch the whole conversation arrive as live `entry` frames — correct, but a
/// visibly worse first paint. Waiting is safe by construction: `attach` is
/// atomic whenever it happens, so no entry can slip between the wait and the
/// snapshot.
pub const SEED_WARMUP: Duration = Duration::from_millis(1_500);

// ── eligibility ─────────────────────────────────────────────────────────────

/// Track A v1 scope, server-side. The client has the same rule in
/// `web/src/components/chat/flag.ts`; THIS one is what makes it a guard.
///
/// * `provider == "claude"` — nothing else writes a Claude Code transcript.
/// * `host_id is None` — a remote session's transcript is on the remote box, so
///   the tailer would silently read a local file that is not this conversation.
/// * not a team lead — a lead's window is multiplexed across teammate panes,
///   which the A2 single-conversation data plane does not model.
pub fn chat_eligible(provider: &str, host_id: Option<i64>, team_name: Option<&str>) -> bool {
    // `team_name` alone is NOT a team signal: with the global agent-teams pref
    // on, CC ≥2.1.178 writes an implicit solo team for every plain session and
    // the watcher stamps the column — refusing on the column made the chat
    // plane 4404-unreachable on real sessions (found live). Only a lead with an
    // ACTUAL roster (≥1 teammate besides the lead) is refused.
    provider == "claude"
        && host_id.is_none()
        && !team_name.is_some_and(crate::teams::scan::real_team)
}

/// Load `name`'s row and refuse anything the chat data plane does not serve.
/// Ineligible reads as **404**, deliberately: whether a session exists but is a
/// codex/remote/lead one is not information this endpoint owes a caller.
async fn eligible_row(state: &AppState, name: &str) -> Result<db::sessions::Session, AppError> {
    if !crate::sessions::valid_name(name) {
        return Err(AppError::NotFound("session".to_string()));
    }
    let row = db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session {name}")))?;
    if !chat_eligible(&row.provider, row.host_id, row.team_name.as_deref()) {
        return Err(AppError::NotFound(format!("chat is unavailable for session {name}")));
    }
    Ok(row)
}

/// The session's transcript file, per the DB conversation pointer. A session
/// with no pointer yet resolves to a path that cannot exist, which every reader
/// below treats as "empty", never as an error.
fn transcript_path(row: &db::sessions::Session) -> PathBuf {
    resumable::project_dir_for(&row.dir).join(format!("{}.jsonl", row.cc_conversation_id))
}

// ── the history cursor ──────────────────────────────────────────────────────

/// `"<cc_conversation_id>:<byte offset>"`.
///
/// The conversation id is part of the cursor on purpose: a client holding a
/// cursor from BEFORE a `/clear` or a `--resume` must be told to re-seed (409),
/// not silently served bytes from a different conversation at the same offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryCursor {
    pub conversation_id: String,
    pub offset: u64,
}

impl HistoryCursor {
    pub fn format(conversation_id: &str, offset: u64) -> String {
        format!("{conversation_id}:{offset}")
    }

    /// `None` for anything malformed — a garbage cursor is a 400, never a
    /// silent full-file re-read.
    pub fn parse(raw: &str) -> Option<Self> {
        // `rsplit_once` so a (hypothetical) id containing `:` still parses.
        let (id, off) = raw.rsplit_once(':')?;
        if id.is_empty() || off.is_empty() {
            return None;
        }
        Some(Self {
            conversation_id: id.to_string(),
            offset: off.parse().ok()?,
        })
    }
}

// ── page composition (seed + history share every rule) ──────────────────────

/// One page of sealed entries plus where to continue paging backwards.
#[derive(Debug)]
pub(crate) struct Page {
    pub entries: Vec<WireEntry>,
    pub has_more: bool,
    pub next_before: Option<String>,
}

impl Page {
    fn empty() -> Self {
        Self { entries: Vec::new(), has_more: false, next_before: None }
    }

    fn json(&self) -> Value {
        json!({
            "entries": self.entries,
            "has_more": self.has_more,
            "next_before": self.next_before,
        })
    }
}

/// First index of `entries` that fits `budget` **measured serialized bytes**,
/// counting back from the newest.
///
/// Byte-measured, not entry-counted: the corpus' entry sizes span three orders
/// of magnitude (a one-word prompt vs. a clipped 16 KB tool result), so any
/// count-based page is either tiny or over budget. The newest entry always
/// ships even if it alone exceeds the budget — an empty page for a non-empty
/// ring would read as "no conversation".
pub(crate) fn seed_start(entries: &[WireEntry], budget: usize) -> usize {
    if entries.is_empty() {
        return 0;
    }
    let size = |w: &WireEntry| serde_json::to_vec(w).map(|v| v.len() + 1).unwrap_or(0);
    let last = entries.len() - 1;
    let mut spent = size(&entries[last]);
    let mut start = last;
    for i in (0..last).rev() {
        let len = size(&entries[i]);
        if spent + len > budget {
            break;
        }
        spent += len;
        start = i;
    }
    line_aligned_start(entries, start)
}

/// Advance `start` so a page never begins in the MIDDLE of a transcript line.
///
/// One physical line fans out to N entries that share its start offset. The
/// paging cursor is a line offset read as "strictly below", so a page cut
/// between two blocks of one line would strand the blocks left behind — a
/// silent hole no `seq` arithmetic can catch (they are in neither page).
/// Dropping the tail of a split line is the safe side: the whole line is then
/// served by the next page down.
///
/// …unless dropping it would consume the WHOLE window (a window that is one
/// physical line: a huge fan-out against the byte budget, or a small `?limit=`
/// cutting into the newest line). An empty page for a non-empty window is the
/// worse hole — it renders as "no conversation" and carries no cursor to page
/// back with — so the line is shipped whole instead, the same call the byte
/// budget already makes for a single over-budget entry.
pub(crate) fn line_aligned_start(entries: &[WireEntry], mut start: usize) -> usize {
    if entries.is_empty() {
        return 0;
    }
    if start > 0 {
        while start < entries.len() && same_line(&entries[start], &entries[start - 1]) {
            start += 1;
        }
    } else {
        // The ring's oldest entry can itself be a non-first block whose `#0`
        // sibling was already evicted (`<uuid>#<i>` — see the parser).
        while start < entries.len() && entries[start].uuid().contains('#') {
            start += 1;
        }
    }
    if start == entries.len() {
        // Rewind to that line's own start: still never mid-line, just wider
        // than the budget asked for.
        start = entries.len() - 1;
        while start > 0 && same_line(&entries[start - 1], &entries[start]) {
            start -= 1;
        }
    }
    start
}

/// Do these two entries belong to the same PHYSICAL line?
///
/// The offset alone does not say so: a subagent entry's offset is a position in
/// `subagents/agent-<id>.jsonl`, so a main line and a subagent line that happen
/// to share a byte offset are unrelated. Treating them as one line silently
/// dropped one of them from the page.
fn same_line(a: &WireEntry, b: &WireEntry) -> bool {
    a.offset() == b.offset() && a.agent_id() == b.agent_id()
}

/// Build the seed page from an [`attach`](ChatStore::attach) snapshot. The
/// entries are ALREADY sealed (the store seals on publish), so this applies
/// only the page-level budget — the per-entry cap cannot be skipped here even
/// by mistake.
pub(crate) fn seed_page(ring: Vec<WireEntry>, oldest_main_offset: Option<u64>, conv: &str) -> Page {
    let start = seed_start(&ring, SEED_MAX_BYTES);
    let entries: Vec<WireEntry> = ring.into_iter().skip(start).collect();
    if entries.is_empty() {
        return Page::empty();
    }
    // The cursor is a MAIN-transcript byte offset — `history_page` resolves it
    // against that file and nothing else. A subagent entry's offset is a
    // position in its own file, so it can never be a cursor: handing one out
    // sent the client paging from an unrelated byte of the main transcript
    // (and everything between there and the ring's real start was unreachable).
    let Some(oldest_main) = entries.iter().find(|w| !w.is_subagent()).map(|w| w.offset()) else {
        // A window of nothing but subagent turns: correct to show, but there is
        // no main-file position to page back from.
        return Page { entries, has_more: false, next_before: None };
    };
    // Older content exists when the oldest main entry we send does not start
    // the file, or when the ring itself holds something older still.
    let has_more = oldest_main > 0 || oldest_main_offset.is_some_and(|o| o < oldest_main);
    Page {
        next_before: has_more.then(|| HistoryCursor::format(conv, oldest_main)),
        has_more,
        entries,
    }
}

/// The disk backlog **strictly below** `before`, newest-last.
///
/// The tailer owns the live path, so this never competes with it: it re-reads
/// the file from byte 0 and answers a bounded window. That whole-file read is
/// the deliberate trade for an explicit, user-driven "scroll further back"
/// action (it runs on the blocking pool, never per tile — see Task 5's
/// `chat_tail`, which is ring-only for exactly this reason).
pub(crate) fn history_page(path: &FsPath, conv: &str, before: u64, limit: usize) -> Page {
    let Ok(file) = std::fs::File::open(path) else {
        return Page::empty();
    };
    let (entries, _) = parse_stream(BufReader::new(file), 0);
    // Sidechain lines are dropped here for the same reason the tailer drops
    // them: the live path re-reads those turns, with their agent id, out of
    // `subagents/`. A backlog page that kept them would disagree with the seed
    // about what the conversation IS, at the exact seam between the two.
    let below: Vec<&ChatEntry> = entries
        .iter()
        .filter(|e| e.offset < before && !e.is_sidechain)
        .collect();
    if below.is_empty() {
        return Page::empty();
    }
    let window = history_window_start(&below, limit);
    // Both caps, on the same code path the seed uses: `seal` per entry, then
    // the page byte budget, then line alignment.
    let sealed: Vec<WireEntry> = below[window..]
        .iter()
        .map(|e| WireEntry::seal(HISTORY_SEQ, e))
        .collect();
    let start = line_aligned_start(&sealed, seed_start(&sealed, SEED_MAX_BYTES));
    let has_more = window + start > 0;
    let entries: Vec<WireEntry> = sealed.into_iter().skip(start).collect();
    let next_before = entries
        .first()
        .filter(|_| has_more)
        .map(|w| HistoryCursor::format(conv, w.offset()));
    Page { entries, has_more, next_before }
}

/// First index of `below` that a `limit`-sized backlog page may need — i.e. the
/// only entries [`history_page`] is allowed to SEAL.
///
/// The count limit belongs here, before sealing, not after it: sealing is two
/// or more `serde_json` passes per entry plus a full body copy, and applying
/// the limit afterwards threw almost all of that away — on a real 12 MB
/// transcript on this host, 4,247 entries sealed to serve a page of 200, and
/// the waste grew with scroll depth.
///
/// The window is pulled back to its line start, so the byte budget and the line
/// alignment that run afterwards can only ever move it FORWARD — which is what
/// keeps them expressible inside this window at all.
pub(crate) fn history_window_start(below: &[&ChatEntry], limit: usize) -> usize {
    let mut window = below.len().saturating_sub(limit);
    while window > 0 && below[window - 1].offset == below[window].offset {
        window -= 1;
    }
    window
}

/// Backlog entries carry `seq = 0`: they are strictly below every live `seq`
/// and are addressed by `offset` (the paging cursor), not by the live boundary
/// arithmetic. Naming it makes that contract greppable.
const HISTORY_SEQ: u64 = 0;

/// The untruncated entry behind a `truncated` uuid (fetch-full). Deliberately
/// NOT sealed — this is the escape hatch the cap exists to make survivable, and
/// it is bounded by the parser's own line ceiling.
pub(crate) fn find_full_entry(path: &FsPath, uuid: &str) -> Option<ChatEntry> {
    let file = std::fs::File::open(path).ok()?;
    // Streamed, stopping at the first match: collecting the whole file first
    // materialised every entry with its full, uncapped body — ~45 ms and
    // ~32 MB per request on a 49 MB transcript, and a renderer resolving
    // several truncated entries issues several of these at once.
    let mut found = None;
    super::parser::parse_scan(BufReader::new(file), 0, |e| {
        let hit = e.uuid == uuid;
        if hit {
            found = Some(e);
        }
        !hit
    });
    found
}

/// Fetch-full across **every** file this conversation is made of — the main
/// transcript first, then `<conv-id>/subagents/agent-*.jsonl` (fase A6 T4.1).
///
/// WHY THIS EXISTS. [`find_full_entry`] scans one path, and until A6 the
/// handler only ever handed it the main transcript. Subagent entries reach the
/// client on the wire (the tailer's scope is the whole cursor SET, and
/// `seed_page`/`history_page` carry them with their `agent_id`), so a uuid the
/// client legitimately held could never be resolved: fetch-full was a
/// **structural 404** for an entire class of entry. It went unnoticed only
/// because the renderer drops subagent turns before it can ask
/// (`wire-entries.ts`), which is a coincidence of two layers agreeing, not a
/// contract — exactly the shape of dead signal A0's `b8daf73` lesson is about.
///
/// The main file is tried first because it is the overwhelmingly common case
/// and the subagent sweep costs a `read_dir`. A conversation with no
/// `subagents/` directory pays nothing beyond one failed `read_dir`.
pub(crate) fn find_full_entry_anywhere(
    project_dir: &FsPath,
    conversation_id: &str,
    uuid: &str,
) -> Option<ChatEntry> {
    let main = project_dir.join(format!("{conversation_id}.jsonl"));
    if let Some(found) = find_full_entry(&main, uuid) {
        return Some(found);
    }
    let dir = project_dir.join(conversation_id).join("subagents");
    let read = std::fs::read_dir(&dir).ok()?;
    // Sorted, so a hit is deterministic when two agents somehow share a uuid —
    // and so a test can assert *which* file answered.
    let mut files: Vec<PathBuf> = read
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    files.iter().find_map(|p| find_full_entry(p, uuid))
}

/// Fetch-full's response shape: every [`ChatEntry`] field a renderer needs,
/// with the body at full size.
#[derive(Debug, Serialize)]
struct FullEntry {
    uuid: String,
    kind: Kind,
    ts_ms: i64,
    offset: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    oversize: bool,
    body: Value,
}

impl From<ChatEntry> for FullEntry {
    fn from(e: ChatEntry) -> Self {
        Self {
            uuid: e.uuid,
            kind: e.kind,
            ts_ms: e.ts_ms,
            offset: e.offset,
            session_id: e.session_id,
            tool_use_id: e.tool_use_id,
            label: e.label,
            ok: e.ok,
            agent_id: e.agent_id,
            oversize: e.oversize,
            body: e.body,
        }
    }
}

// ── the live boundary ───────────────────────────────────────────────────────

/// What the socket does with one broadcast result.
#[derive(Debug)]
pub(crate) enum Forward {
    Send(WireEntry),
    /// Below the seed's `high_water` — already rendered. Arithmetic dedupe, no
    /// uuid or text matching.
    Skip,
    /// The receiver fell behind and the channel dropped entries for it. The
    /// hole is REPORTED and healed with a fresh seed; it is never skipped past.
    Resync,
    Stop,
}

pub(crate) fn classify_live(res: Result<WireEntry, RecvError>, high_water: u64) -> Forward {
    match res {
        Ok(w) if w.seq() >= high_water => Forward::Send(w),
        Ok(_) => Forward::Skip,
        Err(RecvError::Lagged(_)) => Forward::Resync,
        Err(RecvError::Closed) => Forward::Stop,
    }
}

// ── the per-session subscriber cap ──────────────────────────────────────────

fn subscribers() -> &'static DashMap<String, Arc<AtomicUsize>> {
    static COUNTS: OnceLock<DashMap<String, Arc<AtomicUsize>>> = OnceLock::new();
    COUNTS.get_or_init(DashMap::new)
}

/// A chat client's slot in the per-session cap. Dropping it frees the slot.
pub(crate) struct SubscriberSlot {
    name: String,
    count: Arc<AtomicUsize>,
}

impl Drop for SubscriberSlot {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::AcqRel);
        // Keep the map bounded by session count actually in use. Runs under the
        // same shard lock [`take_slot`] increments under, so a client arriving
        // right now either sees our decrement or creates a fresh counter.
        subscribers().remove_if(&self.name, |_, c| c.load(Ordering::Acquire) == 0);
    }
}

/// Claim one of `cap` slots for `name`. `None` = the socket must be refused
/// (1013 `AGAIN`, the same recoverable close the terminal socket uses for its
/// 33rd subscriber).
pub(crate) fn take_slot(name: &str, cap: usize) -> Option<SubscriberSlot> {
    // The increment happens INSIDE the entry guard — the same lock `Drop`'s
    // `remove_if` takes — so a concurrent departure can never drop a counter
    // this claim has already bumped.
    let entry = subscribers().entry(name.to_string()).or_default();
    let count = entry.value().clone();
    let claimed = count
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < cap).then_some(n + 1)
        })
        .is_ok();
    drop(entry);
    claimed.then(|| SubscriberSlot { name: name.to_string(), count })
}

// ── the socket ──────────────────────────────────────────────────────────────

/// Upgrade handler. The Origin decision is made on the pre-upgrade request and
/// carried into the socket task, exactly as the terminal socket does (a real WS
/// close frame can only be sent after the upgrade).
pub async fn handle_chat_ws(
    ws: WebSocketUpgrade,
    Path(name): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let origin_ok = crate::ws::origin_allowed(&state, &headers);
    ws.on_upgrade(move |socket| chat_socket(socket, name, state, origin_ok))
}

async fn send_frame(socket: &mut WebSocket, v: &Value) -> bool {
    socket.send(Message::Text(v.to_string().into())).await.is_ok()
}

/// A frame carrying the flattened [`TailStatus`] (`state` + `resync_epoch`)
/// plus `type` and any extras. One shape for `seed_done` and `state` so a
/// client parses the tail state in exactly one place.
fn status_frame(kind: &str, status: TailStatus, extra: &[(&str, Value)]) -> Value {
    let mut v = serde_json::to_value(status).unwrap_or_else(|_| json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert("type".to_string(), json!(kind));
        for (k, val) in extra {
            obj.insert((*k).to_string(), val.clone());
        }
    }
    v
}

/// Snapshot-and-subscribe, then push `seed` + `seed_done`. Returns the new
/// `(high_water, receiver)` pair, or `None` if the socket died mid-push.
///
/// The `attach` happens BEFORE the two sends, so entries published while the
/// seed is in flight are already queued on the returned receiver and stream in
/// behind it — that is the no-gap half of the store's proof, consumed here.
async fn push_seed(
    socket: &mut WebSocket,
    store: &ChatStore,
    conv: &str,
    status: TailStatus,
    resync_reason: Option<&str>,
) -> Option<(u64, broadcast::Receiver<WireEntry>)> {
    if let Some(reason) = resync_reason {
        // Told BEFORE the new page lands: the client drops what it has rather
        // than splicing a second conversation onto the first.
        if !send_frame(socket, &json!({ "type": "resync", "reason": reason })).await {
            return None;
        }
    }
    let att = store.attach();
    let high_water = att.high_water;
    let rx = att.rx;
    let page = seed_page(att.ring, att.oldest_main_offset, conv);
    let mut frame = page.json();
    if let Some(obj) = frame.as_object_mut() {
        obj.insert("type".to_string(), json!("seed"));
    }
    if !send_frame(socket, &frame).await {
        return None;
    }
    let done = status_frame("seed_done", status, &[("high_water", json!(high_water))]);
    send_frame(socket, &done).await.then_some((high_water, rx))
}

/// Give the tailer's first pass a moment to land before the first seed. A
/// second client of an already-running tailer sees a non-default status and
/// does not wait at all.
async fn warm_up(lease: &mut TailerLease) {
    if lease.status() != TailStatus::default() {
        return;
    }
    let _ = tokio::time::timeout(SEED_WARMUP, lease.changed()).await;
}

/// Re-read the session's CURRENT conversation id before a re-seed.
///
/// The seed's `next_before` is stamped with it and [`history_handler`]
/// validates that stamp against the row, so a re-seed carrying the id captured
/// at socket open hands the client a cursor the history route answers 409 to —
/// and it stays 409 for the life of the socket, because obeying the 409 by
/// re-seeding over the same socket reissues the same stale id. A resync is
/// exactly the moment the conversation is most likely to have moved (a
/// `/clear`, a terminal-side `--resume`, a hook-driven retarget), so the id is
/// refreshed there. A read failure keeps the previous id: never a guess.
async fn refresh_conv(state: &AppState, name: &str, conv: &mut String) {
    if let Ok(Some(row)) = db::sessions::get(&state.pool, name).await {
        *conv = row.cc_conversation_id;
    }
}

/// The WS close for a tailer that is gone. NOTHING restarts a tailer for an
/// existing lease, so a socket that stays open after its task exits shows a
/// conversation that silently stopped updating — the failure mode the 4404
/// close was written for and never reached, because the `watch::Sender` lives
/// inside the handle the lease itself holds (so `changed()` can never `Err`
/// while the socket is up).
///
/// A transient stop (the blocking pool, the idle sweep) closes 1013 `AGAIN`,
/// which the client's terminal-socket machinery already redials with backoff —
/// and a redial starts a fresh tailer. A terminal one (row deleted, session no
/// longer chat-eligible) closes 4404, which stops the redial loop.
fn stop_close_code(retry: bool) -> u16 {
    if retry {
        close_code::AGAIN
    } else {
        crate::ws::CLOSE_NOT_RUNNING
    }
}

async fn chat_socket(mut socket: WebSocket, name: String, state: AppState, origin_ok: bool) {
    use crate::ws::{close, verify_auth_frame, AUTH_TIMEOUT, CLOSE_NOT_RUNNING, PING_EVERY, PONG_DEADLINE};

    if !origin_ok {
        close(&mut socket, close_code::POLICY, "origin not allowed").await;
        return;
    }
    // First-frame auth — byte-identical contract to the terminal socket.
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
    if !crate::sessions::valid_name(&name) {
        close(&mut socket, close_code::POLICY, "bad name").await;
        return;
    }

    // Eligibility. A refusal is TERMINAL (4404, the same code the terminal
    // socket uses for a session that is not running) so the client stops
    // redialing instead of storming the endpoint: no codex session will ever
    // become chat-eligible by retrying.
    let row = match db::sessions::get(&state.pool, &name).await {
        Ok(Some(row)) => row,
        _ => {
            close(&mut socket, CLOSE_NOT_RUNNING, "no such session").await;
            return;
        }
    };
    if !chat_eligible(&row.provider, row.host_id, row.team_name.as_deref()) {
        tracing::debug!(session = %name, provider = %row.provider, "chat ws refused: ineligible");
        close(&mut socket, CLOSE_NOT_RUNNING, "chat unavailable for this session").await;
        return;
    }

    // Same cap and same recoverable close as the terminal socket's 33rd client.
    let Some(_slot) = take_slot(&name, state.config.ws.subscribers_per_session) else {
        close(&mut socket, close_code::AGAIN, "subscriber limit").await;
        return;
    };

    // The lease starts the tailer (or joins the running one) and keeps it alive
    // for as long as this socket is open.
    let mut lease = spawn_tailer(&state, &name);
    warm_up(&mut lease).await;
    let store = state.chat_store_for(&name);
    // Mutable: the conversation can move under an open socket, and every seed's
    // paging cursor is stamped with it (see `refresh_conv`).
    let mut conv = row.cc_conversation_id.clone();

    let mut status = lease.status();
    // The tailer can already be gone before we seed (it exited between the
    // claim and here). Seeding an orphaned store would show a conversation
    // that never updates again.
    if let TailState::Stopped { reason, retry } = status.state {
        close(&mut socket, stop_close_code(retry), reason).await;
        return;
    }
    let Some((mut high_water, mut rx)) =
        push_seed(&mut socket, &store, &conv, status, None).await
    else {
        return;
    };
    let mut epoch = status.resync_epoch;

    let mut last_inbound = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Skip);
    ping.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // A2 has NO input path: every other frame only refreshes the
                    // liveness timer. Ignoring beats erroring — an older client
                    // batching `[auth, resize]` (the terminal socket's habit)
                    // must not kill its chat socket.
                    Some(Ok(_)) => last_inbound = Instant::now(),
                }
            }
            live = rx.recv() => {
                match classify_live(live, high_water) {
                    Forward::Send(w) => {
                        if !send_frame(&mut socket, &json!({ "type": "entry", "entry": w })).await {
                            break;
                        }
                    }
                    Forward::Skip => {}
                    Forward::Resync => {
                        refresh_conv(&state, &name, &mut conv).await;
                        match push_seed(&mut socket, &store, &conv, lease.status(), Some("lagged")).await {
                            Some((hw, fresh)) => { high_water = hw; rx = fresh; }
                            None => break,
                        }
                    }
                    Forward::Stop => break,
                }
            }
            changed = lease.changed() => {
                match changed {
                    Ok(next) => {
                        status = next;
                        // The tailer task is gone and nothing will start
                        // another one for THIS lease: close so the client can
                        // redial (which does) instead of ping-ponging forever
                        // against a tail that no longer moves.
                        if let TailState::Stopped { reason, retry } = status.state {
                            close(&mut socket, stop_close_code(retry), reason).await;
                            break;
                        }
                        if status.resync_epoch != epoch {
                            // The tailer re-seeded (pointer moved / file rotated):
                            // the ring now holds a DIFFERENT conversation, so
                            // the cursor we are about to issue must carry the
                            // NEW id or the history route will 409 it.
                            epoch = status.resync_epoch;
                            refresh_conv(&state, &name, &mut conv).await;
                            match push_seed(&mut socket, &store, &conv, status, Some("conversation changed")).await {
                                Some((hw, fresh)) => { high_water = hw; rx = fresh; }
                                None => break,
                            }
                        } else if !send_frame(&mut socket, &status_frame("state", status, &[])).await {
                            break;
                        }
                    }
                    // Backstop: every `watch::Sender` gone. Unreachable while
                    // this lease is alive (it holds the handle that owns the
                    // sender) — the live path is the `Stopped` state above.
                    Err(_) => {
                        close(&mut socket, CLOSE_NOT_RUNNING, "tail stopped").await;
                        break;
                    }
                }
            }
            _ = ping.tick() => {
                if last_inbound.elapsed() > PONG_DEADLINE {
                    close(&mut socket, close_code::AWAY, "ping timeout").await;
                    break;
                }
                if socket.send(Message::Ping(bytes::Bytes::new())).await.is_err() {
                    break;
                }
            }
        }
    }
}

// ── the backlog REST routes (bearer-protected, registered in sessions) ───────

#[derive(Debug, Default, Deserialize)]
pub struct HistoryQuery {
    /// `"<cc_conversation_id>:<offset>"`. Absent = from the newest line down.
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// `GET /api/sessions/{name}/chat/history?before=<cursor>&limit=N` — the
/// backlog below the in-memory ring.
pub async fn history_handler(
    Path(name): Path<String>,
    Query(q): Query<HistoryQuery>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let row = eligible_row(&state, &name).await?;
    let before = match q.before.as_deref() {
        None => u64::MAX,
        Some(raw) => {
            let cursor = HistoryCursor::parse(raw)
                .ok_or_else(|| AppError::BadRequest("malformed chat history cursor".to_string()))?;
            if cursor.conversation_id != row.cc_conversation_id {
                // The conversation moved under the client (a `/clear`, a
                // `--resume`, a restart). Splicing the old cursor's bytes onto
                // the new conversation is precisely the lie A2 exists to stop.
                return Err(AppError::Conflict(
                    "history cursor belongs to a different conversation — re-seed".to_string(),
                ));
            }
            cursor.offset
        }
    };
    let limit = q
        .limit
        .unwrap_or(HISTORY_DEFAULT_LIMIT)
        .clamp(1, HISTORY_MAX_LIMIT);
    let path = transcript_path(&row);
    let conv = row.cc_conversation_id.clone();
    let page = tokio::task::spawn_blocking(move || history_page(&path, &conv, before, limit))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("chat history read failed: {e}")))?;
    Ok(Json(json!({ "ok": true, "data": page.json() })))
}

/// `GET /api/sessions/{name}/chat/entry/{uuid}` — fetch-full for an entry the
/// wire had to clip.
pub async fn entry_handler(
    Path((name, uuid)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let row = eligible_row(&state, &name).await?;
    // A6 T4.1 — the whole conversation, not just the main transcript. A 404
    // from here now means "no such entry", which is what a 404 should mean.
    let project_dir = resumable::project_dir_for(&row.dir);
    let conv = row.cc_conversation_id.clone();
    let wanted = uuid.clone();
    let found =
        tokio::task::spawn_blocking(move || find_full_entry_anywhere(&project_dir, &conv, &wanted))
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("chat entry read failed: {e}")))?;
    let entry = found.ok_or_else(|| AppError::NotFound(format!("chat entry {uuid}")))?;
    Ok(Json(json!({ "ok": true, "data": FullEntry::from(entry) })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::chat::model::{ChatEntry, Kind, MAX_ENTRY_BYTES, SEED_MAX_BYTES};
    use crate::sessions::chat::store::ChatStore;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use tokio::sync::broadcast::error::RecvError;

    fn entry_at(uuid: &str, offset: u64, text: &str) -> ChatEntry {
        ChatEntry {
            uuid: uuid.to_string(),
            kind: Kind::Assistant,
            ts_ms: 0,
            offset,
            session_id: Some("conv-a".to_string()),
            tool_use_id: None,
            label: None,
            ok: None,
            is_sidechain: false,
            agent_id: None,
            is_meta: false,
            oversize: false,
            body: serde_json::json!({ "text": text }),
        }
    }

    fn wire(seq: u64, uuid: &str, offset: u64, text: &str) -> WireEntry {
        WireEntry::seal(seq, &entry_at(uuid, offset, text))
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-chatws-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_lines(path: &Path, lines: &[String]) {
        let mut f = std::fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn user_line(uuid: &str, text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "uuid": uuid,
            "timestamp": "2026-01-01T00:00:00Z",
            "sessionId": "conv-a",
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    // ── eligibility: the server-side half of the client's flag.ts guard ──────

    #[test]
    fn chat_eligibility_matches_the_client_guard() {
        // web/src/components/chat/flag.ts: `provider === 'claude' && host_id ==
        // null && !isTeamLead`. The client guard hides the UI; THIS one is what
        // makes it a guard — a hand-rolled socket cannot tail a codex session,
        // a remote host's transcript, or a team lead's spliced pane.
        assert!(chat_eligible("claude", None, None));
        assert!(!chat_eligible("codex", None, None), "provider must be claude");
        assert!(!chat_eligible("kimi", None, None));
        assert!(!chat_eligible("shell", None, None));
        assert!(
            !chat_eligible("claude", Some(3), None),
            "a remote host's transcript is not on this filesystem"
        );
        // `Some(team_name)` alone no longer refuses: the column is polluted by
        // CC's implicit solo teams (one per plain session with agent-teams on).
        // With no on-disk roster for "squad", it's not a real team → eligible.
        assert!(
            chat_eligible("claude", None, Some("squad")),
            "a rosterless team_name (the solo-implicit pollution) must stay eligible"
        );
        // A REAL team (roster with a teammate) still refuses — proven at the
        // path-parameterized level in teams::scan::tests (real_team_in); the
        // fs-backed default resolver is exercised here only for the None path.
    }

    // ── the history cursor ──────────────────────────────────────────────────

    #[test]
    fn history_cursor_round_trips_and_rejects_garbage() {
        let c = HistoryCursor::parse(&HistoryCursor::format("conv-a", 4096)).unwrap();
        assert_eq!(c.conversation_id, "conv-a");
        assert_eq!(c.offset, 4096);
        assert!(HistoryCursor::parse("no-colon").is_none());
        assert!(HistoryCursor::parse("conv-a:notanumber").is_none());
        assert!(HistoryCursor::parse(":5").is_none(), "an empty id is not a conversation");
        assert!(HistoryCursor::parse("conv-a:").is_none());
    }

    // ── the seed page: caps by measured bytes, never split lines ────────────

    #[test]
    fn seed_page_stops_at_the_byte_budget_not_the_entry_count() {
        let ring: Vec<WireEntry> = (0..100u64)
            .map(|i| wire(i, &format!("u{i}"), i * 9_000, &"x".repeat(8_000)))
            .collect();
        let start = seed_start(&ring, SEED_MAX_BYTES);
        assert!(
            start > 0,
            "100 × ~8 KB entries cannot fit a {SEED_MAX_BYTES}-byte page"
        );
        let page = &ring[start..];
        let bytes: usize = page.iter().map(|w| serde_json::to_vec(w).unwrap().len()).sum();
        assert!(bytes <= SEED_MAX_BYTES, "page is {bytes} bytes, over the budget");
        assert_eq!(
            page.last().unwrap().uuid(),
            "u99",
            "the NEWEST entries are the ones a seed keeps"
        );
        // …and a ring that fits is sent whole.
        assert_eq!(seed_start(&ring[..3], SEED_MAX_BYTES), 0);
    }

    #[test]
    fn a_single_over_budget_entry_still_ships_rather_than_an_empty_seed() {
        let ring = vec![wire(0, "u0", 0, &"x".repeat(64 * 1024))];
        assert_eq!(seed_start(&ring, 16), 0, "never return an empty page for a non-empty ring");
    }

    #[test]
    fn the_seed_window_never_splits_a_multi_block_line() {
        // One line fans out to N entries that share a line-start offset. Cutting
        // between two of them would make `next_before` (a line offset, read as
        // "strictly below") skip the blocks left behind — a silent hole.
        let ring = vec![
            wire(0, "a", 0, "one"),
            wire(1, "b", 500, "two"),
            wire(2, "b#1", 500, "three"),
            wire(3, "c", 900, "four"),
        ];
        assert_eq!(
            line_aligned_start(&ring, 2),
            3,
            "a cut inside line 500 must advance to the next LINE start"
        );
        assert_eq!(line_aligned_start(&ring, 1), 1, "a cut already on a line start stays");
        // A ring whose oldest entry is a non-first block (its `#0` sibling was
        // evicted) is the same hazard at index 0.
        let split = vec![wire(9, "b#1", 500, "two"), wire(10, "c", 900, "four")];
        assert_eq!(line_aligned_start(&split, 0), 1);
    }

    #[test]
    fn seed_entry_over_cap_is_truncated_with_uuid_intact() {
        let store = ChatStore::new();
        store.publish(vec![entry_at("big", 0, &"y".repeat(64 * 1024))]);
        let att = store.attach();
        let page = seed_page(att.ring, att.oldest_main_offset, "conv-a");
        let e = &page.entries[0];
        assert!(e.truncated(), "a seeded entry over the cap must be clipped");
        assert_eq!(e.uuid(), "big", "the uuid must survive so fetch-full can resolve it");
        assert!(serde_json::to_vec(e).unwrap().len() <= MAX_ENTRY_BYTES + 512);
    }

    #[test]
    fn seed_page_reports_more_when_older_entries_exist_on_disk() {
        // The oldest entry in the ring starts at byte 4096 → everything below it
        // is still on disk and reachable through the history route.
        let ring = vec![wire(7, "u7", 4_096, "hi"), wire(8, "u8", 4_200, "hi")];
        let page = seed_page(ring, Some(4_096), "conv-a");
        assert!(page.has_more);
        assert_eq!(page.next_before.as_deref(), Some("conv-a:4096"));

        // A ring that starts at byte 0 IS the whole conversation.
        let whole = vec![wire(0, "u0", 0, "hi")];
        let page = seed_page(whole, Some(0), "conv-a");
        assert!(!page.has_more);
        assert!(page.next_before.is_none());
    }

    // ── the two offset domains ──────────────────────────────────────────────

    fn sub_wire(seq: u64, uuid: &str, offset: u64, agent: &str) -> WireEntry {
        let mut e = entry_at(uuid, offset, "sub");
        e.is_sidechain = true;
        e.agent_id = Some(agent.to_string());
        WireEntry::seal(seq, &e)
    }

    #[test]
    fn the_paging_cursor_is_a_main_transcript_offset_never_a_subagent_one() {
        // A subagent entry's `offset` is a position in
        // `subagents/agent-<id>.jsonl`; `history_page` resolves the cursor
        // against the MAIN transcript. Handing out a subagent offset sent the
        // client paging from an unrelated byte — and everything between there
        // and the ring's real start was unreachable.
        let ring = vec![
            sub_wire(0, "s1", 312, "x1"),
            sub_wire(1, "s2", 480, "x1"),
            wire(2, "m1", 9_000, "main"),
            wire(3, "m2", 9_400, "main"),
        ];
        let page = seed_page(ring, Some(9_000), "conv-a");
        assert_eq!(page.entries.len(), 4, "subagent turns still SHOW");
        assert_eq!(
            page.next_before.as_deref(),
            Some("conv-a:9000"),
            "…but the cursor is the oldest MAIN entry, not the ring's front"
        );

        // A window that is nothing but subagent turns has no main-file position
        // to page back from — better no cursor than a wrong one.
        let subs_only = vec![sub_wire(0, "s1", 312, "x1"), sub_wire(1, "s2", 480, "x1")];
        let page = seed_page(subs_only, None, "conv-a");
        assert!(!page.has_more);
        assert!(page.next_before.is_none());
    }

    #[test]
    fn a_main_and_a_subagent_line_that_share_an_offset_are_not_one_line() {
        // Line alignment used to compare offsets alone, so a coincidental
        // collision between two FILES read as one physical line and silently
        // dropped one of them from the page.
        let ring = vec![
            wire(0, "m0", 500, "main"),
            sub_wire(1, "s0", 500, "x1"),
            wire(2, "m1", 900, "main"),
        ];
        assert_eq!(
            line_aligned_start(&ring, 1),
            1,
            "a subagent line at the same byte offset is a DIFFERENT line"
        );
        // …while real blocks of one line still group.
        let blocks = vec![
            sub_wire(0, "s", 500, "x1"),
            sub_wire(1, "s#1", 500, "x1"),
            wire(2, "m1", 900, "main"),
        ];
        assert_eq!(line_aligned_start(&blocks, 1), 2);
    }

    #[test]
    fn history_pages_agree_with_the_live_path_about_sidechain_lines() {
        // The tailer drops the main file's sidechain lines (the same turns are
        // re-read, with their agent id, from `subagents/`). A backlog page that
        // kept them disagreed with the seed about what the conversation IS,
        // right at the seam between the two.
        let dir = tmp_dir("histsidechain");
        let path = dir.join("conv-a.jsonl");
        let side = serde_json::json!({
            "type": "user",
            "uuid": "side1",
            "timestamp": "2026-01-01T00:00:00Z",
            "sessionId": "conv-a",
            "isSidechain": true,
            "agentId": "x1",
            "message": { "role": "user", "content": "sub work" },
        })
        .to_string();
        write_lines(&path, &[user_line("u0", "hi"), side, user_line("u1", "bye")]);

        let page = history_page(&path, "conv-a", u64::MAX, 100);
        assert_eq!(
            page.entries.iter().map(|w| w.uuid()).collect::<Vec<_>>(),
            ["u0", "u1"],
            "sidechain lines are the subagent files' content, not the main thread's"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── the live path ───────────────────────────────────────────────────────

    #[test]
    fn only_entries_at_or_above_the_high_water_are_forwarded() {
        assert!(matches!(classify_live(Ok(wire(9, "u9", 0, "x")), 10), Forward::Skip));
        assert!(matches!(classify_live(Ok(wire(10, "u10", 0, "x")), 10), Forward::Send(_)));
        assert!(matches!(classify_live(Err(RecvError::Lagged(3)), 10), Forward::Resync));
        assert!(matches!(classify_live(Err(RecvError::Closed), 10), Forward::Stop));
    }

    #[tokio::test]
    async fn live_entry_over_cap_is_truncated_with_uuid_intact() {
        let store = ChatStore::new();
        let att = store.attach();
        store.publish(vec![entry_at("big", 0, &"y".repeat(64 * 1024))]);
        let mut rx = att.rx;
        let Forward::Send(w) = classify_live(rx.recv().await, att.high_water) else {
            panic!("the first live entry must be forwarded");
        };
        assert!(w.truncated(), "the live path applies the SAME seal as the seed");
        assert_eq!(w.uuid(), "big");
        assert!(serde_json::to_vec(&w).unwrap().len() <= MAX_ENTRY_BYTES + 512);
    }

    #[tokio::test]
    async fn lagged_subscriber_gets_resync_then_a_fresh_seed_never_a_silent_hole() {
        let store = ChatStore::with_capacity(4);
        let att = store.attach();
        for i in 0..64u64 {
            store.publish(vec![entry_at(&format!("u{i}"), i * 10, "hi")]);
        }
        let mut rx = att.rx;
        assert!(
            matches!(classify_live(rx.recv().await, att.high_water), Forward::Resync),
            "a slow subscriber must surface Lagged as a resync, never a silent skip"
        );
        // The resync is answered by a FRESH attach — a re-seed, not a splice.
        let fresh = store.attach();
        assert_eq!(fresh.high_water, 64);
        let page = seed_page(fresh.ring, fresh.oldest_main_offset, "conv-a");
        assert_eq!(
            page.entries.last().unwrap().seq(),
            63,
            "the re-seed ends at the newest published entry"
        );
        assert!(
            page.entries.iter().map(|w| w.seq()).eq(60..64),
            "…and is itself hole-free"
        );
    }

    // ── the subscriber cap ──────────────────────────────────────────────────

    #[test]
    fn the_33rd_chat_subscriber_is_refused_like_the_terminal_socket() {
        let name = format!("chatcap-{}", uuid::Uuid::new_v4());
        let mut held: Vec<SubscriberSlot> = Vec::new();
        for _ in 0..32 {
            held.push(take_slot(&name, 32).expect("under the cap"));
        }
        assert!(take_slot(&name, 32).is_none(), "the 33rd subscriber is refused");
        held.pop();
        assert!(take_slot(&name, 32).is_some(), "a departing client frees its slot");
    }

    // ── the history page (disk backlog below the ring) ──────────────────────

    #[test]
    fn history_page_reads_strictly_below_the_cursor_and_pages_backwards() {
        let dir = tmp_dir("history");
        let path = dir.join("conv-a.jsonl");
        let lines: Vec<String> = (0..10).map(|i| user_line(&format!("u{i}"), "hello")).collect();
        write_lines(&path, &lines);

        // Everything (no cursor → the whole file), newest last.
        let all = history_page(&path, "conv-a", u64::MAX, 100);
        assert_eq!(all.entries.len(), 10);
        assert!(!all.has_more);
        let cut = all.entries[5].offset();

        let older = history_page(&path, "conv-a", cut, 100);
        assert_eq!(
            older.entries.iter().map(|w| w.uuid()).collect::<Vec<_>>(),
            ["u0", "u1", "u2", "u3", "u4"],
            "strictly below the cursor — the cursor's own line is never re-sent"
        );

        // A limit pages backwards: the NEWEST `limit` below the cursor, and a
        // cursor to continue with.
        let page = history_page(&path, "conv-a", cut, 2);
        assert_eq!(
            page.entries.iter().map(|w| w.uuid()).collect::<Vec<_>>(),
            ["u3", "u4"]
        );
        assert!(page.has_more);
        let next = HistoryCursor::parse(page.next_before.as_deref().unwrap()).unwrap();
        assert_eq!(next.offset, page.entries[0].offset());
        assert_eq!(next.conversation_id, "conv-a");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_history_page_seals_only_the_window_it_can_return() {
        // `history_page` seals `below[history_window_start(..)..]` and nothing
        // else, so this index IS the seal count. It used to seal every entry
        // below the cursor and then drop all but `limit` — 4,247 seals to serve
        // 200 on a real 12 MB transcript, worse the further back you scroll.
        let mut owned: Vec<ChatEntry> = (0..400u64)
            .map(|i| entry_at(&format!("u{i}"), i * 100, "hi"))
            .collect();
        let below: Vec<&ChatEntry> = owned.iter().collect();
        assert_eq!(history_window_start(&below, 5), 395, "5 sealed, not 400");
        assert_eq!(history_window_start(&below, 1_000), 0, "a page bigger than the file is the file");

        // …and a window that would start mid-line is pulled back to the LINE
        // start first, so everything downstream only moves forward.
        owned[396].offset = owned[395].offset;
        owned[397].offset = owned[395].offset;
        let below: Vec<&ChatEntry> = owned.iter().collect();
        assert_eq!(
            history_window_start(&below, 3),
            395,
            "a limit cutting inside a fanned-out line takes the whole line"
        );
    }

    #[test]
    fn history_page_applies_both_caps() {
        // Per-entry `seal` AND the page byte budget, on the SAME code path the
        // seed uses (the matrix in the plan's Task 4).
        let dir = tmp_dir("histcaps");
        let path = dir.join("conv-a.jsonl");
        let lines: Vec<String> = (0..40)
            .map(|i| user_line(&format!("u{i}"), &"z".repeat(48 * 1024)))
            .collect();
        write_lines(&path, &lines);

        let page = history_page(&path, "conv-a", u64::MAX, 500);
        assert!(!page.entries.is_empty());
        for e in &page.entries {
            assert!(e.truncated(), "every history entry goes through seal");
            assert!(serde_json::to_vec(e).unwrap().len() <= MAX_ENTRY_BYTES + 512);
        }
        let bytes: usize = page.entries.iter().map(|w| serde_json::to_vec(w).unwrap().len()).sum();
        assert!(bytes <= SEED_MAX_BYTES, "history page is {bytes} bytes, over the budget");
        assert!(page.has_more, "a truncated page must offer a cursor to continue");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_of_a_missing_transcript_is_an_empty_page_not_an_error() {
        let dir = tmp_dir("histmissing");
        let page = history_page(&dir.join("gone.jsonl"), "conv-a", u64::MAX, 10);
        assert!(page.entries.is_empty());
        assert!(!page.has_more);
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── fetch-full ──────────────────────────────────────────────────────────

    #[test]
    fn fetch_full_returns_the_untruncated_entry_for_a_truncated_uuid() {
        let dir = tmp_dir("fetchfull");
        let path = dir.join("conv-a.jsonl");
        let big = "q".repeat(64 * 1024);
        write_lines(&path, &[user_line("small", "hi"), user_line("big", &big)]);

        // What the wire saw: clipped, but addressable by uuid.
        let clipped = WireEntry::seal(3, &entry_at("big", 0, &big));
        assert!(clipped.truncated());

        let full = find_full_entry(&path, "big").expect("uuid resolves");
        assert_eq!(full.uuid, "big");
        assert_eq!(
            full.body.get("text").and_then(|v| v.as_str()).map(str::len),
            Some(64 * 1024),
            "fetch-full is the escape hatch — it must NOT be sealed"
        );
        assert!(find_full_entry(&path, "nope").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fetch_full_resolves_a_subagent_uuid_instead_of_404ing_structurally() {
        // A6 T4.1. Subagent entries reach the client on the wire — the tailer's
        // scope is the whole cursor SET and `seed_page` carries them with their
        // `agent_id` — but fetch-full scanned ONLY the main transcript, so a
        // uuid the client legitimately held was unresolvable by construction.
        // The 404 was avoided only by the renderer happening to drop subagent
        // turns before it could ask, which is two layers agreeing rather than a
        // contract.
        let dir = tmp_dir("fetchfull-sub");
        let project = dir.clone();
        let big = "z".repeat(64 * 1024);
        write_lines(&project.join("conv-a.jsonl"), &[user_line("main-1", "hi")]);
        let subs = project.join("conv-a").join("subagents");
        std::fs::create_dir_all(&subs).expect("subagents dir");
        write_lines(&subs.join("agent-x1.jsonl"), &[user_line("sub-1", &big)]);

        // The main file still answers first, and cheapest.
        let main = find_full_entry_anywhere(&project, "conv-a", "main-1").expect("main resolves");
        assert_eq!(main.uuid, "main-1");

        // …and the subagent file now answers at all.
        let sub = find_full_entry_anywhere(&project, "conv-a", "sub-1").expect("subagent resolves");
        assert_eq!(sub.uuid, "sub-1");
        assert_eq!(
            sub.body.get("text").and_then(|v| v.as_str()).map(str::len),
            Some(64 * 1024),
            "the escape hatch is unsealed for subagent entries too"
        );

        // A 404 from the handler now means "no such entry" and nothing else.
        assert!(find_full_entry_anywhere(&project, "conv-a", "nope").is_none());
        // A conversation with no subagents/ directory is not an error.
        assert!(find_full_entry_anywhere(&project, "conv-none", "main-1").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn a_window_that_is_one_whole_line_ships_it_rather_than_an_empty_page() {
        // Line alignment moves the cut FORWARD, so a window whose every entry
        // belongs to one physical line used to be advanced away entirely: an
        // empty page with `has_more:false` — a non-empty ring rendering as "no
        // conversation", with no cursor to page back with either.
        let ring: Vec<WireEntry> = (0..100u64)
            .map(|i| {
                let uuid = if i == 0 { "L".to_string() } else { format!("L#{i}") };
                wire(i, &uuid, 500, &"x".repeat(8_000))
            })
            .collect();
        let total: usize = ring.iter().map(|w| serde_json::to_vec(w).unwrap().len()).sum();
        assert!(
            total > SEED_MAX_BYTES,
            "the budget must really cut into this line for the test to mean anything"
        );
        let page = seed_page(ring, Some(500), "conv-a");
        assert_eq!(page.entries.len(), 100, "one over-budget line ships whole");
        assert_eq!(page.entries[0].uuid(), "L", "…and still starts at the LINE start");
        assert!(page.has_more, "byte 500 is not the start of the file");
        assert_eq!(page.next_before.as_deref(), Some("conv-a:500"));

        // Same rule when the ring's oldest entry is an orphan block (its `#0`
        // sibling was evicted): serve what we have, never nothing.
        let orphans = vec![wire(0, "L#3", 500, "a"), wire(1, "L#4", 500, "b")];
        let page = seed_page(orphans, Some(500), "conv-a");
        assert_eq!(page.entries.len(), 2);
    }

    #[test]
    fn a_limit_that_cuts_inside_the_newest_line_still_returns_that_line() {
        // `?limit=1` on a file whose last line fans out to two blocks: the cut
        // lands mid-line, so alignment must fall back to the line start instead
        // of answering an empty page the client cannot page past.
        let dir = tmp_dir("limitline");
        let path = dir.join("conv-a.jsonl");
        let multi = serde_json::json!({
            "type": "assistant",
            "uuid": "m",
            "timestamp": "2026-01-01T00:00:00Z",
            "sessionId": "conv-a",
            "message": { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "answer" },
            ] },
        })
        .to_string();
        write_lines(&path, &[user_line("u0", "hi"), multi]);

        let page = history_page(&path, "conv-a", u64::MAX, 1);
        assert_eq!(
            page.entries.iter().map(|w| w.uuid()).collect::<Vec<_>>(),
            ["m", "m#1"],
            "a mid-line cut yields the whole line, never an empty page"
        );
        assert!(page.has_more);
        let next = HistoryCursor::parse(page.next_before.as_deref().unwrap()).unwrap();
        assert_eq!(next.offset, page.entries[0].offset());
        // …and the page below it is complete: no entry is stranded in neither.
        let older = history_page(&path, "conv-a", next.offset, 10);
        assert_eq!(older.entries.iter().map(|w| w.uuid()).collect::<Vec<_>>(), ["u0"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
