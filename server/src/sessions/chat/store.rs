//! Per-session chat ring + monotonic `seq` + snapshot-and-subscribe.
//!
//! # The invariant: the seed→live boundary has neither a gap nor an overlap
//!
//! [`ChatStore::publish`] seals each entry, pushes it into the ring **and**
//! broadcasts it inside ONE critical section. [`ChatStore::attach`] snapshots
//! the ring, reads `next_seq` as its `high_water` **and** subscribes inside the
//! SAME critical section.
//!
//! *No gap:* any entry whose `send` happened before `attach` took the lock is
//! already in the snapshot; any entry sent after `attach` released the lock was
//! necessarily produced after `subscribe`, so the new receiver has it. There is
//! no window in which an entry is in neither.
//!
//! *No overlap:* every entry carries a globally monotonic `seq`. The snapshot
//! contains exactly `seq < high_water`; a consumer forwards a live frame only
//! when `seq >= high_water`. Dedupe is arithmetic — no uuid or text matching.
//!
//! *Why [`std::sync::Mutex`] and not the tokio one:* a future `.await` inside
//! the critical section would break the atomicity the proof depends on. With a
//! std mutex that is a compile error, not a subtle regression. Nothing in here
//! blocks: `VecDeque` ops are O(1) and `broadcast::Sender::send` never waits on
//! a slow receiver (it evicts and reports `Lagged` instead).
//!
//! The tailer is the only producer (`publish`); the WS, the history route and
//! the sessions-SSE `chat_tail` are pure consumers.
//!
//! The tail *state* (`Live`/`Reconnecting`/`NoHooks`) is owned by
//! [`super::tailer`] and published on its own `watch` channel
//! ([`super::tailer::TailerLease::status`]), NOT on [`Attachment`]: staleness
//! changes without any entry being published (a stale pointer's file is silent
//! by definition), so hanging it off the entry path would make it unobservable
//! exactly when it matters. The store deliberately knows nothing about it.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tokio::sync::broadcast;

use super::model::{ChatEntry, Kind, WireEntry};

/// Entries kept per session for instant seeding + reconnects.
///
/// Sized against [`super::model::SEED_MAX_BYTES`]: at the corpus' typical entry
/// size (~1 KB) 500 entries fill roughly one seed page, so a reattach almost
/// never has to touch the disk. The pathological bound is
/// `RING_CAP * MAX_ENTRY_BYTES` (8 MB) — a real bound only because
/// [`WireEntry::seal`](super::model::WireEntry::seal) caps the header as well
/// as the body — and a store only exists while a chat client is attached (plus
/// the tailer's grace period): the tailer's idle sweep releases it from
/// `AppState::chat_stores` under the same lock that hands out its slot.
pub const RING_CAP: usize = 500;

/// Live broadcast depth. Deeper than [`RING_CAP`] is pointless (a receiver that
/// far behind is better served by a `resync` + fresh seed) and shallower makes
/// a single landing batch of 30-100 entries lag a healthy client.
pub const BROADCAST_CAP: usize = 1024;

/// Per-field cap for the tile tail (`chat_tail`, Task 5). Tiles show one line.
pub const TAIL_MAX_CHARS: usize = 200;

/// The one-line-per-side summary the sessions SSE delta carries per tile.
/// Built from the in-memory ring — **never** from a file read (a full recall
/// scan per tile would flood the blocking pool).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatTail {
    pub user: String,
    pub agent: String,
    /// Claude Code's own clock (ms) for the newer of the two entries. Not
    /// arrival time — never compare it against `activity_at`/`serverNowMs()`.
    pub ts: i64,
    /// Entries this store has published, in the **seq domain** (`Inner.next_seq`).
    ///
    /// THE DOMAIN IS THE DECISION (fase B2 T5), so it is written here once:
    ///
    /// * It is `next_seq`, **not** `ring.len()`. The ring saturates at
    ///   [`RING_CAP`] = 500, so its length is a WINDOW, not a total, and a
    ///   client comparing two windows would report "no new messages" for a busy
    ///   session forever.
    /// * `reset()` deliberately keeps `next_seq` monotonic across `/clear` and
    ///   `--resume` (see its doc), which is exactly what a seen-cursor wants: a
    ///   resync must not rewind the count and re-mark a conversation unread.
    /// * It is safe across store drops ONLY together with [`ChatTail::epoch`] —
    ///   a store is created and dropped many times a day per session and
    ///   `next_seq` restarts at 0 each time. A client compares counts only when
    ///   the epoch matches; otherwise it degrades to a dot rather than showing
    ///   a wrong number.
    pub entry_count: u64,
    /// The newest ring entry's timestamp — **Claude Code's clock**, for DISPLAY
    /// only. Never the unread comparison: CC's stamp can trail arrival by tens
    /// of seconds, and the client's cursor arithmetic runs on the server clock
    /// (`activity_at`). Same domain as [`ChatTail::ts`], one field wider.
    pub last_entry_ts: i64,
    /// This store's creation stamp (server clock, ms). Changes iff the store was
    /// dropped and rebuilt — which is what makes [`ChatTail::entry_count`]'s seq
    /// domain safe to compare across a client's lifetime.
    pub epoch: i64,
}

/// What a new subscriber receives: everything already published (`ring`), the
/// exact boundary (`high_water`), a receiver that starts at that boundary, and
/// where disk paging resumes.
pub struct Attachment {
    pub ring: Vec<WireEntry>,
    pub high_water: u64,
    pub rx: broadcast::Receiver<WireEntry>,
    /// Oldest line-start offset in the ring **from the MAIN transcript**.
    ///
    /// Deliberately not "the oldest entry's offset": subagent entries carry
    /// offsets in their own file, and this number is compared against — and
    /// turned into — a history cursor, which addresses the main transcript
    /// only. Mixing the two domains made the client page to an unrelated byte.
    pub oldest_main_offset: Option<u64>,
}

struct Inner {
    ring: VecDeque<WireEntry>,
    next_seq: u64,
    cap: usize,
}

/// Server-clock milliseconds. The domain every cursor comparison happens in —
/// deliberately not Claude Code's clock (see [`ChatTail`]).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Per-session chat ring. One per session, held in `AppState::chat_stores`.
pub struct ChatStore {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<WireEntry>,
    /// When this store was built (server clock, ms). Published as
    /// [`ChatTail::epoch`]; the thing that makes a seq-domain counter comparable
    /// across the store's many lifetimes.
    epoch: i64,
}

impl Default for ChatStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatStore {
    pub fn new() -> Self {
        Self::build(RING_CAP, BROADCAST_CAP)
    }

    /// Test/tuning seam: `cap` bounds BOTH the ring and the broadcast depth, so
    /// a small store can exercise eviction and `Lagged` deterministically.
    pub fn with_capacity(cap: usize) -> Self {
        Self::build(cap.max(1), cap.max(1))
    }

    fn build(ring_cap: usize, broadcast_cap: usize) -> Self {
        let (tx, _) = broadcast::channel(broadcast_cap.max(1));
        Self {
            inner: Mutex::new(Inner {
                ring: VecDeque::with_capacity(ring_cap.min(64)),
                next_seq: 0,
                cap: ring_cap.max(1),
            }),
            tx,
            epoch: now_ms(),
        }
    }

    /// Publish a batch, sealing it here. Convenience for callers that are
    /// already off the async runtime (tests, the A1 provisional path).
    pub fn publish(&self, entries: Vec<ChatEntry>) {
        self.publish_sealed(entries.iter().map(WireEntry::seal_pending).collect());
    }

    /// Publish ALREADY-SEALED entries. **Called only by the tailer** — it is
    /// the file's single reader, so `seq` order is the file's byte order by
    /// construction.
    ///
    /// Stamping `seq` + push + send happen under one lock: that is the whole
    /// no-gap proof (see the module docs). Do not "optimise" the send out of
    /// the critical section.
    ///
    /// Sealing is deliberately NOT in here. It is the expensive half — two or
    /// more `serde_json` passes plus a full body copy per entry — and doing it
    /// under the lock blocked `attach` (every socket, every resync) and
    /// `tail_summary` (every detector tick, every session) behind it, on a
    /// Tokio worker.
    pub fn publish_sealed(&self, sealed: Vec<WireEntry>) {
        if sealed.is_empty() {
            return;
        }
        let mut g = self.lock();
        for mut w in sealed {
            w.set_seq(g.next_seq);
            g.next_seq += 1;
            g.ring.push_back(w.clone());
            while g.ring.len() > g.cap {
                g.ring.pop_front();
            }
            // Err = nobody is subscribed right now; the ring still has it.
            let _ = self.tx.send(w);
        }
    }

    /// Snapshot-and-subscribe. See the module docs for why both halves are one
    /// critical section.
    pub fn attach(&self) -> Attachment {
        let g = self.lock();
        let rx = self.tx.subscribe();
        Attachment {
            ring: g.ring.iter().cloned().collect(),
            high_water: g.next_seq,
            oldest_main_offset: g.ring.iter().find(|w| !w.is_subagent()).map(|w| w.offset()),
            rx,
        }
    }

    /// Drop every ring entry — the RESYNC primitive, called only by the tailer
    /// when the conversation pointer moved, the file rotated, or a fresh tailer
    /// task is about to re-read a file this store already holds. Returns whether
    /// anything was actually dropped, so a caller can tell a client-visible
    /// resync from a no-op on a ring nobody has ever seen.
    ///
    /// `next_seq` is deliberately **not** reset: `seq` stays globally monotonic,
    /// so an in-flight subscriber's `seq >= high_water` filter keeps working
    /// across the boundary and can never mistake a new conversation's entry for
    /// one it already rendered. Clearing the ring is what makes a `resync` mean
    /// "re-seed" instead of "splice two conversations together".
    pub fn reset(&self) -> bool {
        let mut g = self.lock();
        let had = !g.ring.is_empty();
        g.ring.clear();
        had
    }

    /// The tile summary: the newest prompt and the newest assistant line in the
    /// ring, each collapsed to one line and capped at [`TAIL_MAX_CHARS`].
    /// `None` while the ring is empty, so the delta field is simply omitted
    /// rather than published as an empty chat.
    pub fn tail_summary(&self) -> Option<ChatTail> {
        let g = self.lock();
        let mut user: Option<(&WireEntry, String)> = None;
        let mut agent: Option<(&WireEntry, String)> = None;
        for w in g.ring.iter().rev() {
            if user.is_some() && agent.is_some() {
                break;
            }
            let slot = match w.kind() {
                Kind::Prompt if user.is_none() => &mut user,
                // A failure banner is the LAST thing the agent said and by far
                // the most important: a tile whose tail skipped it showed the
                // sentence before a five-hour outage as the session's current
                // state (verify matrix, `limit.hit.session_5h.transcript`).
                Kind::Assistant | Kind::AgentError if agent.is_none() => &mut agent,
                _ => continue,
            };
            if let Some(line) = one_line(w) {
                *slot = Some((w, line));
            }
        }
        if user.is_none() && agent.is_none() {
            return None;
        }
        let ts = user
            .as_ref()
            .map(|(w, _)| w.ts_ms())
            .into_iter()
            .chain(agent.as_ref().map(|(w, _)| w.ts_ms()))
            .max()
            .unwrap_or(0);
        // Computed inside the same critical section that already walks the
        // ring — no second lock, no second pass.
        let entry_count = g.next_seq;
        let last_entry_ts = g.ring.back().map(|w| w.ts_ms()).unwrap_or(ts);
        Some(ChatTail {
            user: user.map(|(_, s)| s).unwrap_or_default(),
            agent: agent.map(|(_, s)| s).unwrap_or_default(),
            ts,
            entry_count,
            last_entry_ts,
            epoch: self.epoch,
        })
    }

    /// A poisoned chat lock is not worth killing a request over: the critical
    /// sections are panic-free (`VecDeque` + a non-blocking send), so the data
    /// behind a poisoned lock is still consistent.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// `body.text` collapsed to a single whitespace-separated line and capped at
/// [`TAIL_MAX_CHARS`] **chars** (never bytes — the tail is user text).
fn one_line(w: &WireEntry) -> Option<String> {
    one_line_capped(w.body().get("text").and_then(|v| v.as_str())?, TAIL_MAX_CHARS)
}

/// `text` collapsed to a single whitespace-separated line and capped at `max`
/// **chars** (never bytes — this is user text). Returns `None` when nothing
/// survived (empty / whitespace-only).
///
/// The char count is tracked incrementally and an over-budget word is copied
/// only as far as it fits: re-counting after every push was quadratic in the
/// output, and a body with no whitespace at all (a base64 blob, a minified
/// payload) is ONE word — up to `MAX_ENTRY_BYTES` of it copied, then counted,
/// then thrown away. This runs under the store mutex on every detector tick.
///
/// Extracted from [`one_line`] (B5/T1) and shared with [`crate::notify`], which
/// composes push bodies at a smaller budget: the lock screen and the tile must
/// show the *same* string, so they must go through the *same* function.
pub fn one_line_capped(text: &str, max: usize) -> Option<String> {
    let mut out = String::new();
    let mut chars = 0usize;
    for word in text.split_whitespace() {
        let sep = usize::from(chars > 0);
        let room = max.saturating_sub(chars + sep);
        if room == 0 {
            break;
        }
        // Bounded even for a single 16 KB "word": we never need to know how far
        // past the budget it goes, only that it is past it.
        let len = word.chars().take(room + 1).count();
        if sep > 0 {
            out.push(' ');
        }
        if len > room {
            out.extend(word.chars().take(room));
            break;
        }
        out.push_str(word);
        chars += sep + len;
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::chat::model::{ChatEntry, Kind};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::broadcast;

    fn entry(i: u64) -> ChatEntry {
        let mut e = ChatEntry::test_text(&format!("u{i}"), "hi");
        e.offset = i * 100;
        e.ts_ms = 1_000 + i as i64;
        e
    }

    #[test]
    fn attach_snapshot_and_live_stream_are_strictly_consecutive_with_no_gap_or_overlap() {
        let store = Arc::new(ChatStore::new());
        for i in 0..50 {
            store.publish(vec![entry(i)]);
        }
        let att = store.attach();
        for i in 50..120 {
            store.publish(vec![entry(i)]);
        }
        let mut seen: Vec<u64> = att.ring.iter().map(|w| w.seq()).collect();
        let mut rx = att.rx;
        while let Ok(w) = rx.try_recv() {
            if w.seq() >= att.high_water {
                seen.push(w.seq());
            }
        }
        assert_eq!(seen, (seen[0]..=119).collect::<Vec<_>>());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn firehose_concurrent_attach_never_gaps_or_duplicates() {
        let store = Arc::new(ChatStore::new());
        let s = store.clone();
        let writer = tokio::task::spawn_blocking(move || {
            for i in 0..5000 {
                s.publish(vec![entry(i)]);
            }
        });
        for _ in 0..200 {
            let att = store.attach();
            let mut seqs: Vec<u64> = att.ring.iter().map(|w| w.seq()).collect();
            let mut rx = att.rx;
            for _ in 0..50 {
                match rx.try_recv() {
                    Ok(w) if w.seq() >= att.high_water => seqs.push(w.seq()),
                    _ => break,
                }
            }
            for pair in seqs.windows(2) {
                assert_eq!(pair[1], pair[0] + 1, "gap/dupe at {pair:?}");
            }
            tokio::task::yield_now().await;
        }
        writer.await.unwrap();
    }

    /// Hardening pin for the invariant the plan's firehose test *names* but
    /// cannot enforce.
    ///
    /// That test's drain loop `break`s on the first non-matching `try_recv`, so
    /// an `Empty` (the common case while its `spawn_blocking` writer is still
    /// warming up), a `Lagged`, **and an actual overlap** (`seq < high_water`)
    /// all end the drain silently. Instrumented on this store it saw 139 of its
    /// 200 attaches land on an *empty* ring and only 12 live frames in the whole
    /// run, and moving `subscribe()` out of the critical section left it green
    /// 3 runs out of 3.
    ///
    /// This one keeps a real OS-thread writer running for the whole test so
    /// every attach lands mid-stream, hammers the boundary from several reader
    /// threads at once (each attach is an independent chance to observe the
    /// unlock→subscribe window), and asserts BOTH halves of the proof:
    /// * **no overlap** — a live frame below `high_water` is a double render;
    /// * **no gap** — the first live frame is *exactly* `high_water`.
    ///
    /// Mutation-checked: with `subscribe()` moved out of the critical section it
    /// fails on the `GAP` assertion.
    #[test]
    fn attach_boundary_is_exact_under_a_real_race_no_gap_no_overlap() {
        const READERS: usize = 4;
        const ATTACHES: usize = 5_000;
        // A shallow ring keeps each snapshot cheap — the window this test hunts
        // is between the unlock and the `subscribe`, and has nothing to do with
        // ring depth. The live channel stays deep enough that a hot writer never
        // drowns a reader in `Lagged` before it sees its first frame.
        let store = Arc::new(ChatStore::build(16, BROADCAST_CAP));
        let stop = Arc::new(AtomicBool::new(false));

        let (s, st) = (store.clone(), stop.clone());
        let writer = std::thread::spawn(move || {
            let mut i = 0u64;
            while !st.load(Ordering::Relaxed) {
                s.publish(vec![entry(i)]);
                i += 1;
            }
        });

        let readers: Vec<_> = (0..READERS)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || {
                    let mut boundaries = 0usize;
                    for _ in 0..ATTACHES {
                        let att = store.attach();
                        let hw = att.high_water;
                        if let Some(last) = att.ring.last() {
                            assert_eq!(
                                last.seq() + 1,
                                hw,
                                "the snapshot must end exactly at high_water"
                            );
                        }
                        let mut rx = att.rx;
                        loop {
                            match rx.try_recv() {
                                Ok(w) => {
                                    assert!(
                                        w.seq() >= hw,
                                        "OVERLAP: live seq {} was already in the seed \
                                         (high_water {hw})",
                                        w.seq()
                                    );
                                    assert_eq!(
                                        w.seq(),
                                        hw,
                                        "GAP: the first live frame after high_water {hw} \
                                         skipped ahead"
                                    );
                                    boundaries += 1;
                                    break;
                                }
                                // Nothing published since we subscribed.
                                Err(broadcast::error::TryRecvError::Empty) => {
                                    std::hint::spin_loop()
                                }
                                // BROADCAST_CAP overrun: resync territory (pinned by
                                // `lagged_receiver_is_reported_not_silently_skipped`),
                                // not a boundary observation.
                                Err(_) => break,
                            }
                        }
                    }
                    boundaries
                })
            })
            .collect();

        let observed: usize = readers.into_iter().map(|h| h.join().unwrap()).sum();
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        assert!(
            observed * 2 >= READERS * ATTACHES,
            "the race never happened — only {observed} live boundaries across \
             {} attaches, so this test would not have caught a gap",
            READERS * ATTACHES
        );
    }

    #[test]
    fn a_pre_sealed_batch_still_gets_dense_monotonic_seqs_under_the_lock() {
        // Sealing moved OUT of the critical section (the tailer does it on the
        // blocking pool), so the store stamps `seq` afterwards. The placeholder
        // must never survive, and the boundary arithmetic must be unchanged.
        use crate::sessions::chat::model::{WireEntry, PENDING_SEQ, MAX_ENTRY_BYTES};
        let store = ChatStore::new();
        store.publish(vec![entry(0)]);

        let pre: Vec<WireEntry> = (1..5).map(|i| WireEntry::seal_pending(&entry(i))).collect();
        assert!(pre.iter().all(|w| w.seq() == PENDING_SEQ));
        store.publish_sealed(pre);

        let att = store.attach();
        assert_eq!(
            att.ring.iter().map(|w| w.seq()).collect::<Vec<_>>(),
            (0..5).collect::<Vec<_>>(),
            "a pre-sealed batch is stamped in ring order, no placeholder left"
        );
        assert_eq!(att.high_water, 5);

        // The placeholder is the WIDEST seq, so stamping the real one can only
        // shrink an entry that was measured against the cap.
        let big = ChatEntry::test_text("big", &"y".repeat(64 * 1024));
        let mut w = WireEntry::seal_pending(&big);
        let pending_len = serde_json::to_vec(&w).unwrap().len();
        assert!(pending_len <= MAX_ENTRY_BYTES);
        w.set_seq(1);
        assert!(serde_json::to_vec(&w).unwrap().len() <= pending_len);
    }

    #[test]
    fn lagged_receiver_is_reported_not_silently_skipped() {
        let store = ChatStore::with_capacity(4);
        let att = store.attach();
        for i in 0..64 {
            store.publish(vec![entry(i)]);
        }
        let mut rx = att.rx;
        assert!(
            matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Lagged(_))),
            "a slow subscriber MUST surface Lagged so the WS can force a resync"
        );
    }

    #[test]
    fn ring_is_bounded_and_keeps_the_newest() {
        let store = ChatStore::new();
        let total = (RING_CAP + 37) as u64;
        for i in 0..total {
            store.publish(vec![entry(i)]);
        }
        let att = store.attach();
        assert_eq!(att.ring.len(), RING_CAP, "the ring must stay bounded");
        assert_eq!(
            att.ring.last().unwrap().seq(),
            total - 1,
            "the NEWEST entry must be retained"
        );
        assert_eq!(
            att.ring.first().unwrap().seq(),
            total - RING_CAP as u64,
            "the oldest RING_CAP entries win, evicted from the front"
        );
        assert_eq!(att.high_water, total);
        assert_eq!(
            att.oldest_main_offset,
            Some((total - RING_CAP as u64) * 100),
            "the seed/disk boundary is the oldest RING entry's line-start offset"
        );
    }

    #[test]
    fn attach_on_an_empty_store_is_an_empty_snapshot_not_a_gap() {
        let store = ChatStore::new();
        let att = store.attach();
        assert!(att.ring.is_empty());
        assert_eq!(att.high_water, 0);
        assert_eq!(att.oldest_main_offset, None);
        let mut rx = att.rx;
        store.publish(vec![entry(0)]);
        let w = rx.try_recv().expect("the first entry must reach a pre-attached rx");
        assert_eq!(w.seq(), 0);
    }

    #[test]
    fn a_multi_entry_publish_keeps_seq_dense_across_the_batch() {
        // A landing batch is 30-100 entries (a0: tool-heavy turns) and arrives as
        // ONE publish — `seq` must still be dense and per-entry.
        let store = ChatStore::new();
        store.publish((0..64).map(entry).collect());
        let att = store.attach();
        let seqs: Vec<u64> = att.ring.iter().map(|w| w.seq()).collect();
        assert_eq!(seqs, (0..64).collect::<Vec<_>>());
    }

    #[test]
    fn reset_clears_the_ring_but_keeps_seq_monotonic() {
        // The tailer calls this on a pointer change: the OLD conversation must
        // leave the seed, while `seq` keeps rising so a live subscriber's
        // `seq >= high_water` filter still holds across the boundary.
        let store = ChatStore::new();
        for i in 0..10 {
            store.publish(vec![entry(i)]);
        }
        let before = store.attach();
        assert!(store.reset(), "a ring that held entries is a client-visible resync");
        assert!(!store.reset(), "clearing an empty ring is a no-op, not a resync");
        let after = store.attach();
        assert!(after.ring.is_empty(), "a resync must not leave the old conversation seedable");
        assert_eq!(after.oldest_main_offset, None);
        assert_eq!(
            after.high_water, before.high_water,
            "`seq` must NOT rewind — a reused seq would read as a duplicate"
        );
        store.publish(vec![entry(99)]);
        let fresh = store.attach();
        assert_eq!(fresh.ring.len(), 1);
        assert_eq!(fresh.ring[0].seq(), before.high_water);
    }

    #[test]
    fn tail_summary_is_none_when_the_ring_is_empty_so_the_delta_field_is_omitted() {
        // `None`, never `Some(ChatTail::default())`: the sessions delta omits the
        // key entirely rather than publishing an empty chat for a session whose
        // ring nobody has filled yet.
        assert!(ChatStore::new().tail_summary().is_none());
    }

    #[test]
    fn tail_summary_is_last_user_oneliner_plus_last_agent_line() {
        let store = ChatStore::new();
        let mut p = ChatEntry::test_text("p1", "first prompt");
        p.kind = Kind::Prompt;
        p.ts_ms = 10;
        let mut a = ChatEntry::test_text("a1", "an answer");
        a.ts_ms = 20;
        let mut p2 = ChatEntry::test_text("p2", "second\nprompt   line");
        p2.kind = Kind::Prompt;
        p2.ts_ms = 30;
        store.publish(vec![p, a, p2]);
        let t = store.tail_summary().unwrap();
        assert_eq!(t.user, "second prompt line", "newlines collapse to one line");
        assert_eq!(t.agent, "an answer");
        assert_eq!(t.ts, 30, "the tail stamp is the NEWEST of the two");
    }

    /* ── fase B2 T5: the unread counter's domain ──────────────────────────── */

    #[test]
    fn entry_count_is_the_seq_domain_and_is_monotone_within_an_epoch() {
        // The DECISION, pinned: `entry_count` is `next_seq`, not `ring.len()`.
        // A ring-length count saturates at RING_CAP and would report "nothing
        // new" forever on a busy session.
        let store = ChatStore::with_capacity(4);
        for i in 0..10 {
            store.publish(vec![entry(i)]);
        }
        let t = store.tail_summary().unwrap();
        assert_eq!(t.entry_count, 10, "seq domain — not the 4-entry ring window");

        store.publish(vec![entry(10)]);
        let t2 = store.tail_summary().unwrap();
        assert!(t2.entry_count > t.entry_count, "monotone within an epoch");
        assert_eq!(t2.epoch, t.epoch, "the same store keeps its epoch");
    }

    #[test]
    fn reset_does_not_rewind_the_count() {
        // `/clear` and `--resume` call `reset()`, which deliberately keeps
        // `next_seq` monotonic. A seen-cursor wants exactly that: a resync must
        // not rewind the counter and re-mark a whole conversation unread.
        let store = ChatStore::new();
        for i in 0..5 {
            store.publish(vec![entry(i)]);
        }
        let before = store.tail_summary().unwrap();
        assert!(store.reset());
        assert!(
            store.tail_summary().is_none(),
            "an emptied ring publishes no tail at all"
        );
        store.publish(vec![entry(99)]);
        let after = store.tail_summary().unwrap();
        assert!(
            after.entry_count > before.entry_count,
            "reset cleared the ring but not the counter ({} → {})",
            before.entry_count,
            after.entry_count
        );
        assert_eq!(after.epoch, before.epoch, "reset is not a new store");
    }

    #[test]
    fn a_dropped_and_recreated_store_gets_a_new_epoch_and_a_reset_count() {
        // Stores are created and dropped many times a day per session (the
        // store lives only while a chat client is attached, plus the tailer's
        // grace period). The epoch is what makes the seq-domain count safe
        // across that: a client that sees a different epoch degrades to a dot
        // instead of subtracting two unrelated counters.
        let first = ChatStore::new();
        for i in 0..7 {
            first.publish(vec![entry(i)]);
        }
        let a = first.tail_summary().unwrap();
        assert_eq!(a.entry_count, 7);
        drop(first);

        // A fresh store for the same session — `next_seq` restarts at 0.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = ChatStore::new();
        second.publish(vec![entry(0)]);
        let b = second.tail_summary().unwrap();
        assert_eq!(b.entry_count, 1, "a new store counts from zero");
        assert!(
            b.epoch >= a.epoch,
            "the epoch is a server-clock stamp, so it never goes backwards"
        );
        assert_ne!(
            b.epoch, a.epoch,
            "a rebuilt store MUST be distinguishable, or the count is compared \
             against a counter that no longer exists"
        );
    }

    #[test]
    fn last_entry_ts_is_the_newest_ring_entry_on_ccs_clock() {
        // Display only. The unread comparison runs on the SERVER clock
        // (`activity_at`); CC's stamp can trail arrival by tens of seconds.
        let store = ChatStore::new();
        let mut p = ChatEntry::test_text("p1", "prompt");
        p.kind = Kind::Prompt;
        p.ts_ms = 10;
        let mut a = ChatEntry::test_text("a1", "answer");
        a.ts_ms = 20;
        // A later entry that is NEITHER a prompt nor an assistant line: `ts` (the
        // one-liner pair's stamp) ignores it, `last_entry_ts` does not.
        let mut later = ChatEntry::test_text("t1", "tool output");
        later.kind = Kind::ToolResult;
        later.ts_ms = 55;
        store.publish(vec![p, a, later]);
        let t = store.tail_summary().unwrap();
        assert_eq!(t.ts, 20, "the one-liner pair's stamp is unchanged");
        assert_eq!(t.last_entry_ts, 55, "the ring's newest entry");
    }

    #[test]
    fn a_session_with_no_store_still_has_no_chat_tail() {
        // The whole reason the attention ladder is provider-neutral: the SSE
        // producer uses the non-creating accessor, so a session nobody is
        // watching has no store and therefore no tail — and must still get a
        // tier from `activity_at`.
        assert!(ChatStore::new().tail_summary().is_none());
    }

    #[test]
    fn tail_summary_is_last_user_oneliner_plus_last_agent_line_capped_at_200_chars() {
        let store = ChatStore::new();
        let mut p = ChatEntry::test_text("p1", &"é".repeat(500));
        p.kind = Kind::Prompt;
        store.publish(vec![p]);
        let t = store.tail_summary().unwrap();
        assert_eq!(t.user.chars().count(), TAIL_MAX_CHARS);
        assert!(t.agent.is_empty(), "no assistant entry yet → empty, not a lie");
    }
}
