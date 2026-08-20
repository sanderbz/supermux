//! Idempotency ledger for chat `POST /send` — the server half of the
//! "Retry can never duplicate a delivered message" guarantee.
//!
//! The chat composer mints a stable `send_id` per message and reuses it on every
//! retry (`web/.../use-pending-sends.ts`). A message that was actually delivered
//! but shown as a false failure — or one whose HTTP response was dropped — can
//! therefore be re-POSTed with the SAME `send_id`. This ledger remembers the ids
//! it has already typed into each session's pty so that re-POST is a no-op
//! instead of a second prompt in the agent's queue.
//!
//! Memory-only and deliberately small: a bounded, TTL-pruned list per session.
//! A server restart simply forgets — a retry that re-delivers once after a
//! restart is rare and harmless, and not worth persisting for. The check and the
//! record both happen under the caller's per-session lock
//! (`lifecycle::send_harness_text`), so a double-tap that races two POSTs cannot
//! slip both past the check.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a delivered `send_id` suppresses a re-POST. Comfortably longer than
/// any watchdog window or human retry latency, short enough that a genuinely new
/// message that happens to reuse an id (it will not — the ids are unique) could
/// never be shadowed for long.
const TTL: Duration = Duration::from_secs(300);

/// Cap on remembered ids per session, so a long-lived session cannot grow the
/// ledger without bound between TTL prunes.
const MAX_PER_SESSION: usize = 128;

/// Per-session `send_id → delivered-at` ledger.
#[derive(Default)]
pub struct SendDedup {
    inner: Mutex<HashMap<String, Vec<(String, Instant)>>>,
}

impl SendDedup {
    /// True if this `(session, send_id)` was already delivered inside the TTL.
    /// Prunes expired ids for the session as a side effect.
    pub fn seen(&self, name: &str, send_id: &str) -> bool {
        let now = Instant::now();
        let mut g = self.inner.lock().unwrap();
        match g.get_mut(name) {
            Some(v) => {
                v.retain(|(_, t)| now.duration_since(*t) < TTL);
                v.iter().any(|(id, _)| id == send_id)
            }
            None => false,
        }
    }

    /// Record a `send_id` as delivered to `name`. Idempotent, TTL-pruned, and
    /// capped (oldest dropped first).
    pub fn record(&self, name: &str, send_id: &str) {
        let now = Instant::now();
        let mut g = self.inner.lock().unwrap();
        let v = g.entry(name.to_string()).or_default();
        v.retain(|(_, t)| now.duration_since(*t) < TTL);
        if v.iter().all(|(id, _)| id != send_id) {
            v.push((send_id.to_string(), now));
        }
        if v.len() > MAX_PER_SESSION {
            let drop = v.len() - MAX_PER_SESSION;
            v.drain(0..drop);
        }
    }

    /// Forget a session entirely (delete / rename / archive).
    pub fn forget(&self, name: &str) {
        self.inner.lock().unwrap().remove(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unseen_id_is_not_seen_then_is_after_record() {
        let d = SendDedup::default();
        assert!(!d.seen("s", "a"));
        d.record("s", "a");
        assert!(d.seen("s", "a"));
        // A different id on the same session is independent.
        assert!(!d.seen("s", "b"));
        // Same id on a different session is independent.
        assert!(!d.seen("other", "a"));
    }

    #[test]
    fn record_is_idempotent_and_forget_clears() {
        let d = SendDedup::default();
        d.record("s", "a");
        d.record("s", "a");
        assert!(d.seen("s", "a"));
        d.forget("s");
        assert!(!d.seen("s", "a"));
    }

    #[test]
    fn the_cap_drops_the_oldest_first() {
        let d = SendDedup::default();
        for i in 0..(MAX_PER_SESSION + 5) {
            d.record("s", &format!("id-{i}"));
        }
        // The first five have been evicted; the most recent survive.
        assert!(!d.seen("s", "id-0"));
        assert!(!d.seen("s", "id-4"));
        assert!(d.seen("s", "id-5"));
        assert!(d.seen("s", &format!("id-{}", MAX_PER_SESSION + 4)));
    }
}
