//! A generic, table-driven **IMAP/SMTP mail** connector family — the DRY
//! generalization of [`super::icloud`] (connector-store spec §10, expansion §4c).
//!
//! iCloud proved the pattern: an agent-authored, stdlib-only Python stdio MCP
//! server exposing `list_inbox` / `read_message` / `send_message` over IMAP+SMTP,
//! with an app-specific password held write-only in the vault. Every other
//! app-password mailbox differs from iCloud in only four constants (IMAP/SMTP
//! host + port), so rather than clone a file per provider this module ships ONE
//! shared server ([`SERVER_PY`], generalized to read host/port from env) and
//! seeds a Lane C `Form` card per provider from a small [`PROVIDERS`] table.
//!
//! **Where the secret lives** (identical to iCloud). The manifest `emit`
//! references the credential only as `${MAIL_ADDRESS}` / `${MAIL_APP_PW}` env
//! placeholders — never a value; the fixed host/port are baked in as literal
//! (non-secret) env. The real app-specific password is written to the AES-256-GCM
//! [vault](crate::vault) via `POST /api/connectors/<id>/credential` (write-only),
//! decrypted ONLY at launch in [`crate::sessions::connector_config`] to be
//! injected as an env var into the granted session's `claude` child.
//!
//! iCloud keeps its own [`super::icloud`] card/credential path untouched (back-
//! compat); this module adds Gmail-IMAP, Outlook/Office 365, and Fastmail. A
//! fully generic host-as-a-field `generic-imap` card is deferred — its host/port
//! would be user-entered `${IMAP_HOST}` placeholders rather than the baked-in
//! literals these fixed-host cards use, a different manifest shape.

use serde_json::json;

use crate::db::connectors;
use crate::state::AppState;

use super::manifest::{
    AuthDescriptor, AuthKind, CredentialField, Manifest, ToolDecl, KIND_AGENT_AUTHORED,
};

/// Env-var names the emit block references and the vault injects at launch. These
/// double as the credential field KEYS. Shared across every provider (each
/// connector is its own vault namespace, so one name is unambiguous).
pub const ENV_ADDRESS: &str = "MAIL_ADDRESS";
pub const ENV_APP_PW: &str = "MAIL_APP_PW";

/// The shared, generalized MCP server (host/port from env). Embedded so the
/// family ships as a single unit — no pip install, no external fetch.
pub const SERVER_PY: &str = include_str!("imap_mail_server.py");

/// A small envelope icon (data-URI SVG) for the store card. Theme-neutral stroke.
const ICON: &str = "data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' \
stroke='%233b82f6' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>\
<rect x='3' y='5' width='18' height='14' rx='2'/><path d='m3 7 9 6 9-6'/></svg>";

/// One provider row — everything that distinguishes a fixed-host app-password
/// mailbox. Adding a provider is a one-line table addition.
pub struct Provider {
    pub id: &'static str,
    pub display_name: &'static str,
    pub imap_host: &'static str,
    pub imap_port: u16,
    pub smtp_host: &'static str,
    pub smtp_port: u16,
    pub help_url: &'static str,
    pub help_text: &'static str,
}

/// The seeded providers. iCloud is intentionally ABSENT — it keeps its own
/// shipped [`super::icloud`] card/credential path. `generic-imap` is deferred
/// (see the module docs).
pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "gmail-imap",
        display_name: "Gmail (IMAP)",
        imap_host: "imap.gmail.com",
        imap_port: 993,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        help_url: "https://myaccount.google.com/apppasswords",
        help_text: "Turn on 2-Step Verification, then create an app password at \
            myaccount.google.com/apppasswords — not your Google account password.",
    },
    Provider {
        id: "outlook-mail",
        display_name: "Outlook / Office 365",
        imap_host: "outlook.office365.com",
        imap_port: 993,
        smtp_host: "smtp.office365.com",
        smtp_port: 587,
        help_url: "https://account.microsoft.com/security",
        help_text: "Create an app password with MFA on. Note: some corporate \
            Microsoft 365 tenants disable IMAP and app passwords.",
    },
    Provider {
        id: "fastmail",
        display_name: "Fastmail",
        imap_host: "imap.fastmail.com",
        imap_port: 993,
        smtp_host: "smtp.fastmail.com",
        smtp_port: 465,
        help_url: "https://app.fastmail.com/settings/security/apppasswords",
        help_text: "Create an app password in Fastmail → Settings → Privacy & \
            Security → App passwords.",
    },
];

/// Is `id` one of the IMAP/SMTP mail connectors (this family OR the shipped
/// iCloud card)? The Cloudflare agent-inbox read path uses this to decide whether
/// to inject `MAIL_TO_FILTER` into a granted mail connector's launch env, so the
/// bot's `list_inbox` shows only its own `agent@<domain>` mail.
pub fn is_mail_connector(id: &str) -> bool {
    id == super::icloud::ICLOUD_ID || PROVIDERS.iter().any(|p| p.id == id)
}

/// The three tools the shared server exposes (for the card's tool list/count).
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
            description: "Send an email from the connected account.".into(),
        },
    ]
}

/// The credential SCHEMA — the address IDENTITY (non-secret, surfaced as the
/// account label) plus the SENSITIVE app-specific password (masked, vaulted).
/// Copies the [`super::icloud`] shape with generic keys.
fn credential_fields(display_name: &str) -> Vec<CredentialField> {
    vec![
        CredentialField {
            key: ENV_ADDRESS.into(),
            title: format!("{display_name} email address"),
            field_type: "string".into(),
            sensitive: false,
            required: true,
            identity: true,
            default: None,
            file_env: None,
        },
        CredentialField {
            key: ENV_APP_PW.into(),
            title: "App-specific password (NOT your account password)".into(),
            field_type: "string".into(),
            sensitive: true,
            required: true,
            identity: false,
            default: None,
            file_env: None,
        },
    ]
}

/// Build a provider's manifest whose `emit` launches the shared (absolute)
/// server-script path via `python3`, with the fixed host/port baked in as
/// non-secret env and the credential injected only via `${VAR}` placeholders.
pub fn manifest(p: &Provider, server_path: &str) -> Manifest {
    let emit = json!({
        "command": "python3",
        "args": [server_path],
        "env": {
            "IMAP_HOST": p.imap_host,
            "IMAP_PORT": p.imap_port.to_string(),
            "SMTP_HOST": p.smtp_host,
            "SMTP_PORT": p.smtp_port.to_string(),
            ENV_ADDRESS: format!("${{{ENV_ADDRESS}}}"),
            ENV_APP_PW: format!("${{{ENV_APP_PW}}}"),
        }
    });
    Manifest {
        id: p.id.into(),
        kind: KIND_AGENT_AUTHORED.into(),
        display_name: p.display_name.into(),
        icon: ICON.into(),
        description: format!(
            "Read and send mail from a {} account over IMAP/SMTP. Agent-authored \
             MCP connector; auth is an app-specific password held in the supermux \
             vault and injected only into a granted session.",
            p.display_name
        ),
        tools: tool_decls(),
        credentials: credential_fields(p.display_name),
        // Lane C (form): an identity address + a sealed app-specific password.
        auth: AuthDescriptor {
            kind: AuthKind::Form,
            help_url: Some(p.help_url.into()),
            help_text: Some(p.help_text.into()),
            token_field: Some(ENV_APP_PW.into()),
            ..Default::default()
        },
        emit,
        categories: vec!["mail".into()],
    }
}

/// `<data_dir>/connectors/imap-mail/server.py` — where the ONE shared server is
/// materialized (all providers point their emit at this single path).
pub fn server_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir
        .join("connectors")
        .join("imap-mail")
        .join("server.py")
}

/// Boot-time seed (idempotent): write the shared MCP server once and upsert a
/// manifest per [`PROVIDERS`] row so the store lists a grantable card for each.
/// Called once from `main` after the pool is up, next to the iCloud seed.
/// Best-effort — a failure is logged, never fatal (a broken seed must not block
/// boot).
pub async fn seed(state: &AppState) {
    let data_dir = &state.config.data_dir;
    let path = server_path(data_dir);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            tracing::warn!(error = %e, "imap-mail: could not create connector dir; skipping seed");
            return;
        }
    }
    // Rewrite the shared script each boot so a shipped update lands; content is
    // embedded, never user-supplied.
    if let Err(e) = tokio::fs::write(&path, SERVER_PY).await {
        tracing::warn!(error = %e, "imap-mail: could not write server.py; skipping seed");
        return;
    }
    let server_path = path.to_string_lossy().to_string();

    for p in PROVIDERS {
        let manifest = manifest(p, &server_path);
        let cols = manifest.to_columns();
        // Fold the declared Lane C (form) auth descriptor into provenance so the
        // card layer surfaces it (the "Get your key →" help link) instead of only
        // shape-deriving a bare `form`. Same fold `icloud::seed` does.
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
            tracing::warn!(connector = p.id, error = %e, "imap-mail: manifest upsert failed");
            continue;
        }
        tracing::info!(connector = p.id, "seeded agent-authored IMAP mail connector");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str) -> &'static Provider {
        PROVIDERS.iter().find(|p| p.id == id).unwrap()
    }

    #[test]
    fn seeds_the_expected_providers_without_icloud() {
        let ids: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect();
        assert!(ids.contains(&"gmail-imap"));
        assert!(ids.contains(&"outlook-mail"));
        assert!(ids.contains(&"fastmail"));
        // iCloud keeps its OWN shipped card — never re-seeded here.
        assert!(!ids.contains(&"icloud-mail"));
    }

    #[test]
    fn manifest_is_form_lane_with_env_placeholders_and_baked_hosts() {
        let m = manifest(provider("gmail-imap"), "/data/connectors/imap-mail/server.py");
        assert_eq!(m.id, "gmail-imap");
        assert_eq!(m.kind, KIND_AGENT_AUTHORED);
        assert_eq!(m.categories, vec!["mail".to_string()], "shows under the Mail chip");

        // Lane C (form): an identity address + a sensitive app password.
        assert_eq!(m.auth.kind, AuthKind::Form);
        assert_eq!(m.auth.token_field.as_deref(), Some(ENV_APP_PW));
        assert!(m.auth.help_url.as_deref().unwrap().contains("google.com"));
        assert_eq!(m.credentials.len(), 2);
        let addr = m.credentials.iter().find(|c| c.key == ENV_ADDRESS).unwrap();
        assert!(addr.identity && !addr.sensitive, "address is the non-secret identity");
        let pw = m.credentials.iter().find(|c| c.key == ENV_APP_PW).unwrap();
        assert!(pw.sensitive && pw.required, "app password is sensitive + required");

        // emit: python3 launching the shared server, with the FIXED host/port baked
        // in as non-secret env and the credential ONLY as ${VAR} placeholders.
        assert_eq!(m.emit["command"], json!("python3"));
        assert_eq!(m.emit["args"][0], json!("/data/connectors/imap-mail/server.py"));
        assert_eq!(m.emit["env"]["IMAP_HOST"], json!("imap.gmail.com"));
        assert_eq!(m.emit["env"]["IMAP_PORT"], json!("993"));
        assert_eq!(m.emit["env"]["SMTP_HOST"], json!("smtp.gmail.com"));
        assert_eq!(m.emit["env"]["SMTP_PORT"], json!("587"));
        assert_eq!(m.emit["env"][ENV_ADDRESS], json!("${MAIL_ADDRESS}"));
        assert_eq!(m.emit["env"][ENV_APP_PW], json!("${MAIL_APP_PW}"));

        // No plaintext secret anywhere in the serialized manifest.
        let s = serde_json::to_string(&m).unwrap();
        assert!(!s.contains("secret-value"));
        m.validate().unwrap();
    }

    #[test]
    fn each_provider_bakes_its_own_host_and_port() {
        // Fastmail uses implicit-TLS SMTP on 465; Outlook uses the Office 365 hosts.
        let fm = manifest(provider("fastmail"), "/x/server.py");
        assert_eq!(fm.emit["env"]["IMAP_HOST"], json!("imap.fastmail.com"));
        assert_eq!(fm.emit["env"]["SMTP_HOST"], json!("smtp.fastmail.com"));
        assert_eq!(fm.emit["env"]["SMTP_PORT"], json!("465"));

        let ol = manifest(provider("outlook-mail"), "/x/server.py");
        assert_eq!(ol.emit["env"]["IMAP_HOST"], json!("outlook.office365.com"));
        assert_eq!(ol.emit["env"]["SMTP_HOST"], json!("smtp.office365.com"));
        assert_eq!(ol.emit["env"]["SMTP_PORT"], json!("587"));
    }

    #[test]
    fn shared_server_reads_env_and_exposes_the_three_tools() {
        // The embedded shared server is real and generic: three tools, host/port +
        // credentials from env only, and the optional To-filter for the CF inbox.
        assert!(SERVER_PY.contains("def tool_list_inbox"));
        assert!(SERVER_PY.contains("def tool_read_message"));
        assert!(SERVER_PY.contains("def tool_send_message"));
        assert!(SERVER_PY.contains("tools/call"));
        // Host/port are read from env (defaulting to iCloud for back-compat).
        assert!(SERVER_PY.contains("IMAP_HOST"));
        assert!(SERVER_PY.contains("SMTP_PORT"));
        assert!(SERVER_PY.contains("imap.mail.me.com"), "iCloud default retained");
        // Generic credential env names + the optional inbox filter.
        assert!(SERVER_PY.contains("MAIL_ADDRESS"));
        assert!(SERVER_PY.contains("MAIL_APP_PW"));
        assert!(SERVER_PY.contains("MAIL_TO_FILTER"));
        // No hardcoded account address baked into the script.
        assert!(!SERVER_PY.contains("@gmail.com\""), "no hardcoded account");
    }
}
