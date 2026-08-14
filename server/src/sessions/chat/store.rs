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
//! Fase A3/A2-Task-3 note: the tail *state* (`Live`/`Reconnecting`/`NoHooks`)
//! is owned by `tailer.rs` and will be threaded onto [`Attachment`] when that
//! module lands; the store deliberately knows nothing about staleness.

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
/// `RING_CAP * MAX_ENTRY_BYTES` (8 MB), and a store only exists while a chat
/// client is attached (plus the tailer's grace period).
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
}

/// What a new subscriber receives: everything already published (`ring`), the
/// exact boundary (`high_water`), a receiver that starts at that boundary, and
/// the oldest line-start offset still in memory (where disk paging resumes).
pub struct Attachment {
    pub ring: Vec<WireEntry>,
    pub high_water: u64,
    pub rx: broadcast::Receiver<WireEntry>,
    pub oldest_offset: Option<u64>,
}

struct Inner {
    ring: VecDeque<WireEntry>,
    next_seq: u64,
    cap: usize,
}

/// Per-session chat ring. One per session, held in `AppState::chat_stores`.
pub struct ChatStore {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<WireEntry>,
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
        }
    }

    /// Publish a batch. **Called only by the tailer** — it is the file's single
    /// reader, so `seq` order is the file's byte order by construction.
    ///
    /// Seal + push + send happen under one lock: that is the whole no-gap proof
    /// (see the module docs). Do not "optimise" the send out of the critical
    /// section.
    pub fn publish(&self, entries: Vec<ChatEntry>) {
        if entries.is_empty() {
            return;
        }
        let mut g = self.lock();
        for e in &entries {
            let w = WireEntry::seal(g.next_seq, e);
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
            oldest_offset: g.ring.front().map(|w| w.offset()),
            rx,
        }
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
                Kind::Assistant if agent.is_none() => &mut agent,
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
        Some(ChatTail {
            user: user.map(|(_, s)| s).unwrap_or_default(),
            agent: agent.map(|(_, s)| s).unwrap_or_default(),
            ts,
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
    let text = w.body().get("text").and_then(|v| v.as_str())?;
    let mut out = String::new();
    for (i, word) in text.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(word);
        if out.chars().count() >= TAIL_MAX_CHARS {
            break;
        }
    }
    if out.is_empty() {
        return None;
    }
    match out.char_indices().nth(TAIL_MAX_CHARS) {
        Some((i, _)) => Some(out[..i].to_string()),
        None => Some(out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::chat::model::{ChatEntry, Kind};
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
            att.oldest_offset,
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
        assert_eq!(att.oldest_offset, None);
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
    fn tail_summary_is_none_when_the_ring_is_empty() {
        assert!(ChatStore::new().tail_summary().is_none());
    }

    #[test]
    fn tail_summary_is_the_last_prompt_and_the_last_assistant_line() {
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

    #[test]
    fn tail_summary_fields_are_capped_at_200_chars() {
        let store = ChatStore::new();
        let mut p = ChatEntry::test_text("p1", &"é".repeat(500));
        p.kind = Kind::Prompt;
        store.publish(vec![p]);
        let t = store.tail_summary().unwrap();
        assert_eq!(t.user.chars().count(), TAIL_MAX_CHARS);
        assert!(t.agent.is_empty(), "no assistant entry yet → empty, not a lie");
    }
}
