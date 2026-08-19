//! **A bot asked you to take the wheel of its browser.**
//!
//! The Shared Browser connector's `request_human_takeover(reason)` tool carries
//! the `anthropic/requiresUserInteraction` marker
//! ([`crate::connectors::REQUIRES_USER_INTERACTION_META`]), exactly like the
//! store's `connect(service)` affordance: Claude routes the call to the human
//! prompt instead of auto-running it, and the turn stops there. This module is
//! the detector that turns that `PreToolUse` payload into
//! [`crate::state::SessionActivity::browser_takeover`], which the chat surface
//! renders as the "take the wheel" card that opens the takeover panel.
//!
//! Same posture as [`super::connect_ask`]: ONE `PreToolUse` hook payload → the
//! typed [`TakeoverAsk`], or `None`. No clock, no I/O, no state.
//!
//! **Two producers, one field.** The ask is ALSO raised server-side by
//! [`crate::connectors::browser::tools`] when the tool actually runs (a host
//! without the interaction gate, or a human who approved the call) — that path
//! additionally parks the agent on the drive lock. Both write the same field, so
//! the card looks identical whichever order the two arrive in.

use serde::Serialize;

use super::activity::HookPayload;

/// Cap on the free-text reason we carry to the card (a wire string → a surface).
const MAX_REASON: usize = 240;

/// The fallback sentence when the agent asked for a takeover without saying why.
/// An ask with no reason is still a real ask — the human must hear about it —
/// so this names what is happening rather than dropping the card.
pub const DEFAULT_REASON: &str = "needs you to take the wheel of its browser";

/// **The live takeover ask** — a bot's `request_human_takeover(reason)` tool is
/// blocked on a human. In-memory only (same posture as
/// [`super::connect_ask::ConnectAsk`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TakeoverAsk {
    /// Correlates the ask across SSE deltas (keys the card). Absent → the web
    /// keys on the session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The session whose browser context the panel must attach to. Always the
    /// asking bot's own session — a bot cannot ask you to drive another's.
    pub session: String,
    /// The agent's own sentence: what it needs the human to do.
    pub reason: String,
}

impl TakeoverAsk {
    /// Build an ask for `session`, clipping the agent's reason to the card's
    /// budget (and substituting [`DEFAULT_REASON`] when it is empty).
    pub fn new(session: impl Into<String>, reason: &str) -> Self {
        let reason = reason.trim();
        let reason = if reason.is_empty() { DEFAULT_REASON } else { reason };
        Self {
            id: None,
            session: session.into(),
            reason: clip(reason, MAX_REASON),
        }
    }
}

/// Is `tool_name` the shared browser's takeover affordance? The bare name (a
/// future unprefixed host) or the MCP-named `mcp__<server>__request_human_takeover`.
fn is_takeover_tool(tool_name: &str) -> bool {
    tool_name == crate::connectors::browser::mcp::TAKEOVER_TOOL
        || tool_name.ends_with(&format!(
            "__{}",
            crate::connectors::browser::mcp::TAKEOVER_TOOL
        ))
}

/// Parse a `PreToolUse` payload into a takeover ask for `session`.
///
/// `None` unless the payload is the takeover tool. Unlike the connect ask, a
/// missing argument does NOT suppress the card: the whole point is that the
/// agent is stuck behind something only a person can do, and a card that says
/// less is better than no card at all.
pub fn parse(payload: &HookPayload, session: &str) -> Option<TakeoverAsk> {
    let tool = payload.tool_name.as_deref()?;
    if !is_takeover_tool(tool) {
        return None;
    }
    let reason = payload
        .tool_input
        .as_ref()
        .and_then(|i| i.reason.as_deref())
        .unwrap_or("");
    Some(TakeoverAsk::new(session, reason))
}

/// Trim + cap at `max` CHARS (never bytes — a cut inside a multi-byte char is a
/// panic).
fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    fn payload(v: serde_json::Value) -> HookPayload {
        HookPayload::deserialize(v).unwrap()
    }

    #[test]
    fn the_mcp_named_takeover_call_raises_the_ask_with_its_reason() {
        let a = parse(
            &payload(json!({
                "tool_name": "mcp__browser__request_human_takeover",
                "tool_input": { "reason": "sign in to bank.example and approve the 2FA push" }
            })),
            "alice",
        )
        .expect("the takeover tool raises the ask");
        assert_eq!(a.session, "alice");
        assert_eq!(a.reason, "sign in to bank.example and approve the 2FA push");
    }

    #[test]
    fn a_takeover_without_a_reason_still_raises_a_card() {
        let a = parse(
            &payload(json!({ "tool_name": "request_human_takeover" })),
            "bob",
        )
        .expect("an ask with no sentence is still an ask");
        assert_eq!(a.reason, DEFAULT_REASON);
    }

    #[test]
    fn an_ordinary_tool_call_is_ignored() {
        assert!(parse(&payload(json!({ "tool_name": "Bash" })), "alice").is_none());
        assert!(parse(
            &payload(json!({ "tool_name": "mcp__browser__browser_navigate" })),
            "alice"
        )
        .is_none());
        assert!(parse(&payload(json!({})), "alice").is_none());
    }

    #[test]
    fn a_long_reason_is_clipped_by_chars_not_bytes() {
        let long = "é".repeat(MAX_REASON + 50);
        let a = TakeoverAsk::new("alice", &long);
        assert_eq!(a.reason.chars().count(), MAX_REASON);
    }

    #[test]
    fn the_ask_serializes_to_the_web_shape() {
        let v = serde_json::to_value(TakeoverAsk::new("alice", "2FA code")).unwrap();
        assert_eq!(v["session"], json!("alice"));
        assert_eq!(v["reason"], json!("2FA code"));
        assert!(v.get("id").is_none(), "id is omitted when absent");
    }
}
