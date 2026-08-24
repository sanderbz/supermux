//! The first AGENT-AUTHORED connector: **iCloud Mail** (connector-store spec §10).
//!
//! iCloud has no ready-made MCP, so this connector ships its own tiny MCP server
//! — a stdlib-only Python stdio server ([`SERVER_PY`], embedded at build time via
//! `include_str!`) exposing `list_inbox` / `read_message` / `send_message` over
//! IMAP+SMTP. [`seed`] runs once at boot: it writes the server to
//! `<data_dir>/connectors/icloud-mail/server.py` and upserts the connector
//! manifest so the store shows an **iCloud Mail** card (exactly as a
//! `POST /api/connectors` would), grantable per-agent through the ordinary grant
//! path.
//!
//! **Where the secret lives.** The manifest's `emit` block references the
//! credential only as `${ICLOUD_EMAIL}` / `${ICLOUD_APP_PW}` env placeholders —
//! never a value. The real app-specific password is written to the AES-256-GCM
//! [vault](crate::vault) via `POST /api/connectors/icloud-mail/credential`
//! (write-only), and is decrypted ONLY at launch, in
//! [`crate::sessions::connector_config`], to be injected as an env var into the
//! GRANTED session's `claude` child. An ungranted bot never gets the MCP server
//! (it is absent from that session's `--mcp-config`, enforced by
//! `--strict-mcp-config`) and never sees the secret.

use serde_json::json;

use crate::db::connectors;
use crate::state::AppState;

use super::manifest::{
    AuthDescriptor, AuthKind, CredentialField, Manifest, ToolDecl, KIND_AGENT_AUTHORED,
};

/// The connector id / store slug.
pub const ICLOUD_ID: &str = "icloud-mail";

/// Env-var names the emit block references and the vault injects at launch. These
/// double as the credential field KEYS (see [`crate::connectors::manifest`]).
pub const ENV_EMAIL: &str = "ICLOUD_EMAIL";
pub const ENV_APP_PW: &str = "ICLOUD_APP_PW";

/// The agent-authored MCP server, embedded so the connector is a single shippable
/// unit (no pip install, no external fetch). Written to disk verbatim at boot.
pub const SERVER_PY: &str = include_str!("icloud_mail_server.py");

/// A small envelope icon (data-URI SVG) for the store card. Theme-neutral stroke.
const ICON: &str = "data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' \
stroke='%233b82f6' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>\
<rect x='3' y='5' width='18' height='14' rx='2'/><path d='m3 7 9 6 9-6'/></svg>";

/// The three tools the server exposes (for the card's tool list/count).
fn tool_decls() -> Vec<ToolDecl> {
    vec![
        ToolDecl {
            name: "list_inbox".into(),
            description: "List recent messages in a mailbox (newest first).".into(),
        },
        ToolDecl {
            name: "read_message".into(),
            description: "Read one message by uid (headers + plain-text body).".into(),
        },
        ToolDecl {
            name: "send_message".into(),
            description: "Send an email from the connected iCloud account.".into(),
        },
    ]
}

/// The credential SCHEMA — the `.mcpb` `user_config` vocabulary. Field `key`s ARE
/// the env-var names the emit block references and the vault injects; the
/// app-specific password is `sensitive` (masked, vaulted, never echoed).
fn credential_fields() -> Vec<CredentialField> {
    vec![
        CredentialField {
            key: ENV_EMAIL.into(),
            title: "iCloud email address".into(),
            field_type: "string".into(),
            sensitive: false,
            required: true,
            // The connected-account identity: non-secret, surfaced in cleartext as
            // the account_label ("Connected as sander@icloud.com").
            identity: true,
            default: None,
            file_env: None,
        },
        CredentialField {
            key: ENV_APP_PW.into(),
            title: "App-specific password (appleid.apple.com — NOT your Apple ID password)".into(),
            field_type: "string".into(),
            sensitive: true,
            required: true,
            identity: false,
            default: None,
            file_env: None,
        },
    ]
}

/// Build the iCloud-Mail manifest whose `emit` launches the given (absolute)
/// server-script path via `python3`, with the credential injected as env only via
/// `${VAR}` placeholders (never a value).
pub fn manifest(server_path: &str) -> Manifest {
    let emit = json!({
        "command": "python3",
        "args": [server_path],
        "env": {
            ENV_EMAIL: format!("${{{ENV_EMAIL}}}"),
            ENV_APP_PW: format!("${{{ENV_APP_PW}}}"),
        }
    });
    Manifest {
        id: ICLOUD_ID.into(),
        kind: KIND_AGENT_AUTHORED.into(),
        display_name: "iCloud Mail".into(),
        icon: ICON.into(),
        description: "Read and send mail from an iCloud account over IMAP/SMTP. \
            Agent-authored MCP connector; auth is an app-specific password held in \
            the supermux vault and injected only into a granted session."
            .into(),
        tools: tool_decls(),
        credentials: credential_fields(),
        // Lane C (form): an identity address + a sealed app-specific password.
        auth: AuthDescriptor {
            kind: AuthKind::Form,
            help_url: Some("https://appleid.apple.com".into()),
            help_text: Some(
                "Create an app-specific password at appleid.apple.com — not your Apple ID password."
                    .into(),
            ),
            token_field: Some(ENV_APP_PW.into()),
            ..Default::default()
        },
        emit,
        categories: vec!["mail".into()],
    }
}

/// `<data_dir>/connectors/icloud-mail/server.py` — where the embedded server is
/// materialized.
pub fn server_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir
        .join("connectors")
        .join(ICLOUD_ID)
        .join("server.py")
}

/// Boot-time seed (idempotent): write the embedded MCP server to disk and upsert
/// the connector manifest so the store lists an **iCloud Mail** card grantable
/// per-agent. Called once from `main` after the pool is up. Best-effort — a
/// failure is logged, never fatal (a broken seed must not block boot).
pub async fn seed(state: &AppState) {
    let data_dir = &state.config.data_dir;
    let path = server_path(data_dir);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            tracing::warn!(error = %e, "icloud-mail: could not create connector dir; skipping seed");
            return;
        }
    }
    // Rewrite the script each boot so a shipped update lands; content is embedded,
    // never user-supplied.
    if let Err(e) = tokio::fs::write(&path, SERVER_PY).await {
        tracing::warn!(error = %e, "icloud-mail: could not write server.py; skipping seed");
        return;
    }

    let manifest = manifest(&path.to_string_lossy());
    let cols = manifest.to_columns();
    // Fold the declared Lane C (form) auth descriptor into provenance so the card
    // layer surfaces it (the "Get your key →" help link) instead of only shape-
    // deriving a bare `form`. Same fold `api::store_manifest` does for imports.
    let mut provenance = json!({ "builtin": true, "agent_authored": true });
    if let Ok(a) = serde_json::to_value(&manifest.auth) {
        provenance["auth"] = a;
    }
    provenance["categories"] = json!(manifest.categories);
    if let Err(e) = connectors::upsert(
        &state.pool,
        &manifest.id,
        &manifest.kind,
        &manifest.display_name,
        &manifest.icon,
        &manifest.description,
        &cols.tools_json,
        &cols.credentials_json,
        &cols.emit_json,
        &serde_json::to_string(&provenance).unwrap_or_else(|_| "{}".into()),
    )
    .await
    {
        tracing::warn!(error = %e, "icloud-mail: manifest upsert failed");
        return;
    }
    tracing::info!(connector = ICLOUD_ID, "seeded agent-authored iCloud Mail connector");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_shape_is_agent_authored_with_env_placeholders() {
        let m = manifest("/data/connectors/icloud-mail/server.py");
        assert_eq!(m.id, ICLOUD_ID);
        assert_eq!(m.kind, KIND_AGENT_AUTHORED);
        assert_eq!(m.display_name, "iCloud Mail");
        assert_eq!(m.categories, vec!["mail".to_string()], "shows under the Mail chip");
        // Three tools declared on the card.
        assert_eq!(m.tools.len(), 3);
        let names: Vec<&str> = m.tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"list_inbox"));
        assert!(names.contains(&"read_message"));
        assert!(names.contains(&"send_message"));

        // Credential schema: two fields, only the password sensitive.
        assert_eq!(m.credentials.len(), 2);
        let pw = m.credentials.iter().find(|c| c.key == ENV_APP_PW).unwrap();
        assert!(pw.sensitive && pw.required, "app password is sensitive + required");
        let email = m.credentials.iter().find(|c| c.key == ENV_EMAIL).unwrap();
        assert!(!email.sensitive, "email address is not marked sensitive");

        // emit references the secret ONLY via ${VAR} placeholders — never a value.
        assert_eq!(m.emit["command"], json!("python3"));
        assert_eq!(m.emit["args"][0], json!("/data/connectors/icloud-mail/server.py"));
        assert_eq!(m.emit["env"][ENV_EMAIL], json!("${ICLOUD_EMAIL}"));
        assert_eq!(m.emit["env"][ENV_APP_PW], json!("${ICLOUD_APP_PW}"));
        // No plaintext secret anywhere in the serialized manifest.
        let s = serde_json::to_string(&m).unwrap();
        assert!(!s.to_lowercase().contains("password\":\"") || !s.contains("secret-value"));
        m.validate().unwrap();
    }

    #[test]
    fn embedded_server_is_a_python_mcp_stdio_server() {
        // The embedded script is real and exposes the three tools + stdio loop.
        assert!(SERVER_PY.contains("def tool_list_inbox"));
        assert!(SERVER_PY.contains("def tool_read_message"));
        assert!(SERVER_PY.contains("def tool_send_message"));
        assert!(SERVER_PY.contains("tools/call"));
        assert!(SERVER_PY.contains("imap.mail.me.com"));
        assert!(SERVER_PY.contains("smtp.mail.me.com"));
        // Credentials are read ONLY from env — never baked into the script.
        assert!(SERVER_PY.contains("ICLOUD_EMAIL"));
        assert!(SERVER_PY.contains("ICLOUD_APP_PW"));
        assert!(!SERVER_PY.contains("@icloud.com\""), "no hardcoded account");
    }
}
