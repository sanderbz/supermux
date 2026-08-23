//! **A bot's `connect(service)` tool stopped for a human.**
//!
//! The connector store's `connect` affordance (spec §8) is an MCP tool whose
//! descriptor carries the `anthropic/requiresUserInteraction` marker
//! ([`crate::connectors::connect_tool_descriptor`]): when a bot calls it, Claude
//! Code always routes it to the human prompt instead of auto-running it, and the
//! turn stops there. Until this module existed, supermux had NO idea that had
//! happened — `session.connect_request` was declared on the wire and read by the
//! web `ConnectCard`, but nothing server-side ever populated it, so an agent
//! calling `connect()` could never raise the inline card in production (round-1
//! jury, claim 5).
//!
//! This is the detector, and it is a pure function on the same posture as
//! [`super::elicitation`] and [`super::activity::permission_ask`]: ONE
//! `PreToolUse` hook payload → the typed [`ConnectAsk`], or `None`. No clock, no
//! I/O, no state, no secret — the credential NEVER travels this plane (the card
//! POSTs it straight to the vault; see `connectors::api::put_credential`).
//!
//! **What a connect call looks like on the wire.** Claude names an MCP tool
//! `mcp__<server>__<tool>`, so the store's connect tool arrives as
//! `mcp__connect__connect` (or the bare `connect` when a future host exposes it
//! unprefixed). Its single argument is the connector id, in `tool_input.service`
//! — exactly the `connect_tool_descriptor` input schema. We require BOTH the tool
//! shape AND a non-empty `service` before raising the card: a stray third-party
//! tool that merely happens to be called "connect" without that argument is not
//! this affordance and must not raise a credential prompt in supermux's voice.

use serde::Serialize;

use super::activity::HookPayload;

/// Cap on the connector id we carry to the card (a wire string → a surface).
const MAX_ID: usize = 128;

/// **The live connect ask** — a bot's `connect(service)` tool is blocked on a
/// human. In-memory only, never persisted (same posture as
/// [`super::elicitation::ElicitationAsk`]). Serializes to the web
/// `ConnectRequestInfo` shape: the web `ConnectCard` fetches the connector's
/// display name, tool count and OAuth capability from the (secret-free) card
/// schema itself, so the server side only needs to name WHICH connector stalled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectAsk {
    /// Correlates the ask across SSE deltas (keys the card, like the form's id).
    /// Absent → the web keys on `connector_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The connector id the bot asked to connect (the `service` argument).
    pub connector_id: String,
}

/// Is `tool_name` the store's connect affordance? The bare `connect` (a future
/// unprefixed host) or the MCP-named `mcp__<server>__connect`.
fn is_connect_tool(tool_name: &str) -> bool {
    tool_name == "connect" || tool_name.ends_with("__connect")
}

/// Parse a `PreToolUse` payload into a connect ask.
///
/// `None` unless the payload is BOTH a connect tool AND carries a non-empty
/// `service` argument — the two together are what distinguish the store's
/// credential affordance from any other tool that merely shares the name.
pub fn parse(payload: &HookPayload) -> Option<ConnectAsk> {
    let tool = payload.tool_name.as_deref()?;
    if !is_connect_tool(tool) {
        return None;
    }
    let service = payload
        .tool_input
        .as_ref()
        .and_then(|i| i.service.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(ConnectAsk {
        id: None,
        connector_id: clip(service, MAX_ID),
    })
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
    use serde_json::json;

    fn payload(v: serde_json::Value) -> HookPayload {
        HookPayload::deserialize(v).unwrap()
    }
    use serde::Deserialize;

    #[test]
    fn a_prefixed_connect_call_with_a_service_arg_is_the_ask() {
        let a = parse(&payload(json!({
            "tool_name": "mcp__connect__connect",
            "tool_input": { "service": "pmcp-notion" }
        })))
        .expect("a connect tool with a service arg raises the ask");
        assert_eq!(a.connector_id, "pmcp-notion");
    }

    #[test]
    fn the_bare_connect_tool_is_also_recognised() {
        let a = parse(&payload(json!({
            "tool_name": "connect",
            "tool_input": { "service": "icloud-mail" }
        })))
        .expect("the unprefixed connect tool is the same affordance");
        assert_eq!(a.connector_id, "icloud-mail");
    }

    #[test]
    fn a_connect_tool_without_a_service_arg_is_not_the_ask() {
        // A stray tool called "connect" with no connector id is NOT this
        // credential affordance and must not raise a card in supermux's voice.
        assert!(parse(&payload(json!({ "tool_name": "connect", "tool_input": {} }))).is_none());
        assert!(parse(&payload(json!({ "tool_name": "connect" }))).is_none());
        assert!(parse(&payload(json!({
            "tool_name": "connect",
            "tool_input": { "service": "   " }
        })))
        .is_none());
    }

    #[test]
    fn list_connectors_never_raises_the_connect_card() {
        // P2d: the discovery read `mcp__connect__list_connectors` ends in
        // `__list_connectors`, NOT `__connect`, and carries no `service` — so it can
        // never be mistaken for the credential affordance, even if a `service` arg
        // is somehow present (belt-and-suspenders).
        assert!(parse(&payload(json!({
            "tool_name": "mcp__connect__list_connectors",
            "tool_input": {}
        })))
        .is_none());
        assert!(parse(&payload(json!({
            "tool_name": "mcp__connect__list_connectors",
            "tool_input": { "service": "pmcp-github" }
        })))
        .is_none());
    }

    #[test]
    fn an_ordinary_tool_call_is_ignored() {
        assert!(parse(&payload(json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls" }
        })))
        .is_none());
        assert!(parse(&payload(json!({
            "tool_name": "mcp__github__create_issue",
            "tool_input": { "service": "pmcp-github" }
        })))
        .is_none());
    }

    #[test]
    fn the_ask_serializes_to_the_web_connect_request_shape() {
        let a = ConnectAsk { id: None, connector_id: "pmcp-slack".into() };
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["connector_id"], json!("pmcp-slack"));
        // `id` is omitted when absent so the web keys on connector_id.
        assert!(v.get("id").is_none());
    }
}
