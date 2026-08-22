//! Ephemeral OAuth flow-state store (design §P3a: "NOT a table — ephemeral").
//!
//! Keyed by the CSPRNG `state` value, holds the server-side `pkce_verifier`, the
//! `nonce`, and the initiating `host`. Single-use (consumed on callback), short
//! TTL. Binds a callback to its initiation so a replayed/forged/foreign-host
//! `state` is rejected (design §3 rows 11).

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use dashmap::DashMap;
use rand::RngCore;

/// Default flow TTL: an OAuth round-trip is seconds; 10 min is generous.
pub const FLOW_TTL_SECS: u64 = 600;

/// One in-flight login. Consumed exactly once at `/auth/callback`.
#[derive(Debug, Clone)]
pub struct FlowState {
    pub pkce_verifier: String,
    pub nonce: String,
    /// The Host the `/auth/login` arrived on; the callback must match it.
    pub host: String,
    /// The redirect URI handed to Google for this flow (per-host allowlist).
    pub redirect_uri: String,
    pub created_at: u64,
}

/// In-memory, process-local store. Lives on `AppState` (shared across clones via
/// the containing `Arc`).
#[derive(Default)]
pub struct FlowStore {
    map: DashMap<String, FlowState>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl FlowStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh 128-bit CSPRNG `state` and store the flow bound to it.
    /// Returns the `state` token to send to Google.
    pub fn insert(&self, pkce_verifier: String, nonce: String, host: String, redirect_uri: String) -> String {
        let mut raw = [0u8; 16]; // 128-bit
        rand::rngs::OsRng.fill_bytes(&mut raw);
        let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        self.map.insert(
            state.clone(),
            FlowState {
                pkce_verifier,
                nonce,
                host,
                redirect_uri,
                created_at: now_secs(),
            },
        );
        state
    }

    /// Consume a flow by `state`: single-use (removed on take), TTL-checked, and
    /// the caller must supply the inbound `host` which must match the one bound
    /// at initiation. `None` ⇒ unknown / already-consumed / expired / host
    /// mismatch — all indistinguishable to the caller (fail-closed).
    pub fn consume(&self, state: &str, host: &str) -> Option<FlowState> {
        let (_, flow) = self.map.remove(state)?; // single-use: gone even if it then fails checks
        if now_secs().saturating_sub(flow.created_at) > FLOW_TTL_SECS {
            return None;
        }
        if !host_matches(&flow.host, host) {
            return None;
        }
        Some(flow)
    }

    /// Drop expired flows (best-effort housekeeping; safe to never call).
    pub fn sweep(&self) {
        let now = now_secs();
        self.map
            .retain(|_, f| now.saturating_sub(f.created_at) <= FLOW_TTL_SECS);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }
}

/// Exact host comparison, case-insensitive, port-insensitive.
fn host_matches(a: &str, b: &str) -> bool {
    let norm = |h: &str| {
        h.trim()
            .to_ascii_lowercase()
            .split(':')
            .next()
            .unwrap_or("")
            .to_string()
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> FlowStore {
        FlowStore::new()
    }

    #[test]
    fn consume_is_single_use() {
        let s = store();
        let state = s.insert("verifier".into(), "nonce".into(), "acme.test".into(), "https://acme.test/cb".into());
        assert_eq!(s.len(), 1);
        let first = s.consume(&state, "acme.test");
        assert!(first.is_some(), "first consume succeeds");
        assert_eq!(s.len(), 0, "removed on consume");
        // Replay is rejected (single-use).
        assert!(s.consume(&state, "acme.test").is_none(), "replay rejected");
    }

    #[test]
    fn consume_rejects_host_mismatch() {
        let s = store();
        let state = s.insert("v".into(), "n".into(), "acme.test".into(), "https://acme.test/cb".into());
        // A callback arriving on a DIFFERENT host is rejected — and consumed
        // (single-use even on failure), so it cannot be retried on the right host.
        assert!(s.consume(&state, "evil.test").is_none(), "host mismatch rejected");
        assert!(s.consume(&state, "acme.test").is_none(), "already consumed");
    }

    #[test]
    fn consume_rejects_unknown_state() {
        let s = store();
        assert!(s.consume("never-issued", "acme.test").is_none());
    }

    #[test]
    fn consume_rejects_expired() {
        let s = store();
        let state = s.insert("v".into(), "n".into(), "acme.test".into(), "https://acme.test/cb".into());
        // Backdate the stored flow beyond the TTL.
        if let Some(mut e) = s.map.get_mut(&state) {
            e.created_at = now_secs().saturating_sub(FLOW_TTL_SECS + 60);
        }
        assert!(s.consume(&state, "acme.test").is_none(), "expired flow rejected");
    }

    #[test]
    fn state_tokens_are_unique_and_high_entropy() {
        let s = store();
        let a = s.insert("v".into(), "n".into(), "h".into(), "r".into());
        let b = s.insert("v".into(), "n".into(), "h".into(), "r".into());
        assert_ne!(a, b);
        assert!(a.len() >= 20, "128-bit base64url state");
    }
}
