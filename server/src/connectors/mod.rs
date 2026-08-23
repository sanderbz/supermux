//! Connector store (server foundation) — the manifest registry, the per-agent
//! grant engine, the write-only credential vault surface, and the `connect()`
//! affordance plumbing (spec §§3-6, 8).
//!
//! **Router-registry pattern** (same as [`crate::claude_tools`]): [`router_for`]
//! returns this module's sub-router; `http::protected_router` merges it in with
//! one `.merge` line. No shared-file edit beyond that line.
//!
//! **Secret hygiene (load-bearing).** Credential values are WRITE-ONLY: they land
//! straight in the [`crate::vault`] (AES-256-GCM), are never logged, and every
//! read path masks them with [`crate::claude_tools::MASKED`]. Decryption happens
//! ONLY at launch, in [`crate::sessions::connector_config`], to inject the secret
//! as an env var into the granted session's `claude` child.
//!
//! **Per-agent scoping** is NOT here — it lives in the launch path
//! ([`crate::sessions::connector_config::assemble`], called from
//! `sessions::lifecycle`), the single component that owns the per-session config
//! dir. This module only records grants (`session_connectors`) + secrets.

pub mod api;
/// Shared-Browser connector: the leak-safe persistent chrome service, the
/// per-agent CDP contexts, and the AGENT/HUMAN drive lock (phase 1).
pub mod browser;
pub mod catalog;
pub mod connect_server;
/// Per-account "Test connection" probes + the honest health mapping (Slice 3).
pub mod health;
pub mod icloud;
/// The generic, table-driven IMAP/SMTP mail family (Gmail/Outlook/Fastmail) —
/// the DRY generalization of the iCloud connector.
pub mod imap_connector;
pub mod manifest;
/// P2a — connector-OAuth device-code sign-in + guided per-company app registration.
pub mod oauth;

use axum::routing::{delete, get, post};
use axum::Router;
use serde_json::{json, Value};

use crate::state::AppState;

/// The `_meta` key that forces a tool to the human-in-the-loop prompt even when
/// an allow-rule matches (Claude Code ≥ 2.1.199). supermux renders such a tool
/// call as the inline Connect card (spec §8 step 2).
pub const REQUIRES_USER_INTERACTION_META: &str = "anthropic/requiresUserInteraction";

/// Build the MCP tool descriptor for a connector's `connect(service)` tool,
/// carrying the `_meta` marker that always reaches the human prompt. This is the
/// SERVER-SIDE plumbing (spec §8 step 2): the actual connect MCP server binary is
/// a later phase, but the descriptor shape — and the marker that makes supermux
/// render the inline Connect card instead of auto-running it — is fixed here so
/// both the future server and the web card agree on it.
pub fn connect_tool_descriptor(service: &str) -> Value {
    json!({
        "name": "connect",
        "description": format!("Connect the '{service}' connector so its tools become available to you. TIP: call list_connectors FIRST to find the right connector id and how it signs in, explain it to the human in plain language, then connect. This opens a secure sign-in / API-key card; the credential is stored in the supermux vault and never shown to the agent. After the human finishes, the connector's tools (mcp__<service>__*) appear on your next turn — retry then and confirm it works."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "service": { "type": "string", "description": "The connector id to connect." }
            },
            "required": ["service"]
        },
        "_meta": { REQUIRES_USER_INTERACTION_META: true }
    })
}

/// Build the connector-store sub-router (bearer-protected; the auth layer is
/// applied by `http::protected_router`).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        // Store: list cards / read one / create-or-update a manifest / remove.
        // `GET /api/connectors` merges local rows + the catalog mirror (secret-
        // free) and accepts `?source=`/`?q=`/`?category=`/`?featured=` filters.
        .route("/api/connectors", get(api::list).post(api::upsert))
        // The PulseMCP catalog mirror on its own: real, installable MCP cards.
        .route("/api/connectors/catalog", get(api::catalog))
        .route("/api/connectors/catalog/refresh", post(api::catalog_refresh))
        // Locally-cached (never hotlinked) catalog icon bytes.
        .route("/api/connectors/catalog/icon/{id}", get(api::catalog_icon))
        .route("/api/connectors/{id}", get(api::get_one).delete(api::remove))
        // Import a `.mcpb` manifest.json → a connector card.
        .route("/api/connectors/import", post(api::import_mcpb))
        // Write a credential → vault (write-only), optionally auto-granting +
        // capturing the connected-account identity (multi-account).
        .route("/api/connectors/{id}/credential", post(api::put_credential))
        // The CONSUMERS of a connector (blast-radius): every grant, scope-resolved.
        .route("/api/connectors/{id}/grants", get(api::connector_grants))
        // Account lifecycle: disconnect (revoke grants, KEEP the secret) / reconnect.
        .route("/api/connectors/{id}/disconnect", post(api::disconnect_account))
        .route("/api/connectors/{id}/reconnect", post(api::reconnect_account))
        // Per-account "Test connection": a per-kind liveness probe writing health.
        .route("/api/connectors/{id}/test", post(api::test_account))
        // Grant / revoke to a session (or the '*' all-agents sentinel).
        .route("/api/connectors/{id}/grant", post(api::grant))
        .route("/api/connectors/{id}/grant", delete(api::revoke))
        // A session's connector grants (masked), for the store's grant state.
        .route("/api/sessions/{name}/connectors", get(api::session_connectors))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_descriptor_carries_interaction_marker() {
        let d = connect_tool_descriptor("icloud-mail");
        assert_eq!(d["name"], json!("connect"));
        assert_eq!(d["_meta"][REQUIRES_USER_INTERACTION_META], json!(true));
        assert!(d["description"].as_str().unwrap().contains("icloud-mail"));
    }
}
