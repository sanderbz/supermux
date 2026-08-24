//! The supermux connector manifest — the runtime/listing format — and `.mcpb`
//! (MCP Bundle) import (spec §4).
//!
//! A manifest is: card fields (id/icon/display_name/description), a declared
//! `tools[]` list, a credential SCHEMA (mirroring `.mcpb`'s `user_config` field
//! vocabulary), and an `emit` block — the `mcpServers` entry template with
//! `${VAR}` placeholders that our launch-scoping engine drops into the inline
//! `--mcp-config`. The vault fills the placeholders at launch; the manifest
//! itself NEVER carries a secret value.
//!
//! `.mcpb` is the interchange format: [`Manifest::from_mcpb`] reads a bundle's
//! `manifest.json` and maps `display_name`/`icon`/`description`/`tools[]` → card,
//! `user_config[*]` → credential fields, and `server.mcp_config` → `emit` — with
//! `${user_config.KEY}` placeholders rewritten to plain `${KEY}` env references
//! (the form Claude Code expands at launch from the process environment).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;

/// Connector kinds (mirrors `connectors.kind`).
pub const KIND_MCP_CATALOG: &str = "mcp_catalog";
pub const KIND_AGENT_AUTHORED: &str = "agent_authored";
pub const KIND_BUILTIN_BROWSER: &str = "builtin_browser";

/// One declared tool, for the card's tool-count + list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolDecl {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// One credential field — the `.mcpb` `user_config` vocabulary. `key` doubles as
/// the env-var NAME the emit block references via `${key}` and the vault
/// field-map key; a `sensitive` field goes to the vault, a non-sensitive one may
/// be collected via the ordinary elicitation form.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CredentialField {
    pub key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_field_type", rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub sensitive: bool,
    #[serde(default)]
    pub required: bool,
    /// Marks this NON-secret field as the connector's connected-account IDENTITY
    /// (e.g. iCloud `ICLOUD_EMAIL`). Its value is captured at connect time and
    /// surfaced in cleartext as the account's `account_label` ("Connected as
    /// sander@acme.com") — the vault still stays write-only for the sensitive
    /// fields. At most one field per connector should carry this.
    #[serde(default)]
    pub identity: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// Marks this as a FILE credential. When set, the field's (vaulted, write-only)
    /// content is NOT exported as an env value; instead it is materialized AT LAUNCH
    /// to a 0600 file inside the granted session's own runtime dir, and the env var
    /// named here is set to that file's PATH. For MCP servers that authenticate with
    /// a credential FILE rather than an env value — e.g. GA4's `analytics-mcp`, which
    /// reads a Google service-account JSON via `GOOGLE_APPLICATION_CREDENTIALS`. The
    /// raw content therefore never becomes an env value and is never logged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_env: Option<String>,
}

fn default_field_type() -> String {
    "string".to_string()
}

/// How a connector authenticates — the per-connector **auth descriptor** the card
/// UI branches on to render the RIGHT lane instead of guessing from a brand-name
/// regex. Carried onto the store card (see [`crate::connectors::catalog`]) and
/// derived for every card by [`crate::connectors::api::card`].
///
/// `Unspecified` is the pre-descriptor default (a manifest that never declared its
/// auth): the card layer then *derives* the kind from the catalog + the credential
/// schema rather than trusting a blank. The five real lanes mirror the design:
///   * `None`          — no sign-in needed (Filesystem, Time, Fetch).
///   * `ApiKey`        — one secret to paste (GitHub PAT, Stripe secret key).
///   * `Form`          — identity + secret + non-secret fields (iCloud, a DSN).
///   * `OauthDevice` / `OauthRedirect` — supermux-driven OAuth (wired in P2).
///   * `McpOauth`      — a hosted remote MCP that runs its OWN OAuth in the bot's
///     terminal (Slack/Notion/Linear/Sentry …); supermux holds no token and shows
///     an honest "signs in when first used" note, never a fake key field.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    /// Not declared — the card layer derives the real kind (catalog + schema).
    #[default]
    Unspecified,
    None,
    ApiKey,
    Form,
    OauthDevice,
    OauthRedirect,
    McpOauth,
}

/// The per-connector auth descriptor (additive to the manifest; `credentials[]`
/// still carries the Lane B/C field schema). The OAuth URL fields are RESERVED for
/// P2 (supermux-driven OAuth) and stay `None` in P0/P1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct AuthDescriptor {
    #[serde(default)]
    pub kind: AuthKind,
    /// "Get your key →" deep link (Lane A/B).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help_url: Option<String>,
    /// One-line steer shown under the field (where to get the key / what happens).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help_text: Option<String>,
    /// The vault field-map key the token/secret seals under (Lane A/B).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_field: Option<String>,
    /// Least-privilege scopes to request (Lane A, reserved for P2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    /// OAuth endpoints — reserved for P2 (supermux-driven device/redirect grant).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorize_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_url: Option<String>,
}

impl AuthDescriptor {
    /// Is this descriptor unset (a manifest that never declared its auth)? The card
    /// layer treats `Unspecified` as "derive me", not as an authoritative answer.
    pub fn is_unspecified(&self) -> bool {
        self.kind == AuthKind::Unspecified
    }
}

/// The full connector manifest (parsed form of a `connectors` row's `*_json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tools: Vec<ToolDecl>,
    #[serde(default)]
    pub credentials: Vec<CredentialField>,
    /// The per-connector auth descriptor (Lane taxonomy). `Unspecified` when the
    /// manifest never declared one — the card layer then derives it.
    #[serde(default)]
    pub auth: AuthDescriptor,
    /// The `mcpServers` entry template (`{ command|url, args?, env?, headers? }`)
    /// with `${VAR}` placeholders — the SAME shape `claude_tools::mcp::add`
    /// accepts.
    #[serde(default)]
    pub emit: Value,
    /// Coarse store-taxonomy tags (e.g. `["mail"]`, `["browser"]`) matched against
    /// the store's category chip rail. A local/seeded connector declares its own; an
    /// installed CATALOG card inherits the curated card's tags in the card layer.
    /// Empty ⇒ uncategorized (still listed under "All").
    #[serde(default)]
    pub categories: Vec<String>,
}

fn default_kind() -> String {
    KIND_MCP_CATALOG.to_string()
}

/// Slug rule shared with the MCP manager: no path separators / shell metachars,
/// so a connector id can never traverse a file or be smuggled into a CLI arg.
pub fn valid_connector_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

impl Manifest {
    /// Validate the manifest for storage: a safe id and a plausible emit block
    /// (an object with a `command` or a `url`, or empty for a builtin whose emit
    /// is supplied elsewhere).
    pub fn validate(&self) -> Result<(), AppError> {
        if !valid_connector_id(&self.id) {
            return Err(AppError::BadRequest(
                "invalid connector id (allowed: letters, digits, '_', '.', '-')".into(),
            ));
        }
        if !self.emit.is_null() && !self.emit.is_object() {
            return Err(AppError::BadRequest("connector 'emit' must be a JSON object".into()));
        }
        Ok(())
    }

    /// Serialize the manifest's list/schema/emit fields to the `connectors` row's
    /// `*_json` columns.
    pub fn to_columns(&self) -> ManifestColumns {
        ManifestColumns {
            tools_json: serde_json::to_string(&self.tools).unwrap_or_else(|_| "[]".into()),
            credentials_json: serde_json::to_string(&self.credentials)
                .unwrap_or_else(|_| "[]".into()),
            emit_json: serde_json::to_string(&self.emit).unwrap_or_else(|_| "{}".into()),
        }
    }

    /// Import a `.mcpb` `manifest.json` (already parsed) into a supermux manifest.
    /// Maps the bundle's card fields, `tools[]`, `user_config[*]`, and
    /// `server.mcp_config`.
    pub fn from_mcpb(bundle: &Value) -> Result<Self, AppError> {
        let obj = bundle
            .as_object()
            .ok_or_else(|| AppError::BadRequest("manifest.json must be a JSON object".into()))?;

        // id: prefer an explicit `name` slug (the .mcpb identity), slugified.
        let raw_name = obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let id = slugify(raw_name);
        if id.is_empty() {
            return Err(AppError::BadRequest(
                "manifest.json needs a non-empty 'name' to derive the connector id".into(),
            ));
        }

        let display_name = obj
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(raw_name)
            .to_string();
        let description = obj
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let icon = obj.get("icon").and_then(Value::as_str).unwrap_or("").to_string();

        // tools[]: name + description.
        let tools = obj
            .get("tools")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        let name = t.get("name").and_then(Value::as_str)?.to_string();
                        let description = t
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        Some(ToolDecl { name, description })
                    })
                    .collect()
            })
            .unwrap_or_default();

        // user_config: an object keyed by field name → { type, title, sensitive, ... }.
        let credentials = obj
            .get("user_config")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(key, spec)| CredentialField {
                        key: key.clone(),
                        title: spec.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                        field_type: spec
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("string")
                            .to_string(),
                        sensitive: spec.get("sensitive").and_then(Value::as_bool).unwrap_or(false),
                        required: spec.get("required").and_then(Value::as_bool).unwrap_or(false),
                        identity: spec.get("identity").and_then(Value::as_bool).unwrap_or(false),
                        default: spec.get("default").cloned(),
                        file_env: spec.get("file_env").and_then(Value::as_str).map(str::to_string),
                    })
                    .collect()
            })
            .unwrap_or_default();

        // server.mcp_config → emit, with ${user_config.X} → ${X}.
        let emit = obj
            .get("server")
            .and_then(|s| s.get("mcp_config"))
            .cloned()
            .map(|v| rewrite_user_config_placeholders(&v))
            .unwrap_or_else(|| json!({}));

        // Optional per-connector auth descriptor (forward-compat: a `.mcpb` may
        // declare its lane). Absent → `Unspecified`, and the card layer derives it.
        let auth = obj
            .get("auth")
            .cloned()
            .and_then(|v| serde_json::from_value::<AuthDescriptor>(v).ok())
            .unwrap_or_default();

        let manifest = Manifest {
            id,
            kind: KIND_MCP_CATALOG.to_string(),
            display_name,
            icon,
            description,
            tools,
            credentials,
            auth,
            emit,
            categories: Vec::new(),
        };
        manifest.validate()?;
        Ok(manifest)
    }
}

/// The `*_json` columns derived from a manifest.
pub struct ManifestColumns {
    pub tools_json: String,
    pub credentials_json: String,
    pub emit_json: String,
}

/// Turn a free-form `.mcpb` `name` into a connector-id slug.
fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if matches!(c, '_' | '.' | '-') || c.is_whitespace() {
            if !prev_dash && !out.is_empty() {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(100);
    out
}

/// Recursively rewrite `${user_config.KEY}` → `${KEY}` in every string leaf, so
/// an imported `.mcpb` emit block references plain env vars the vault injects.
fn rewrite_user_config_placeholders(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("${user_config.", "${")),
        Value::Array(a) => Value::Array(a.iter().map(rewrite_user_config_placeholders).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, val)| (k.clone(), rewrite_user_config_placeholders(val)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_slug_rejects_traversal_and_meta() {
        assert!(!valid_connector_id("../x"));
        assert!(!valid_connector_id("a/b"));
        assert!(!valid_connector_id("a b"));
        assert!(!valid_connector_id("."));
        assert!(valid_connector_id("icloud-mail"));
        assert!(valid_connector_id("notion.v1_0"));
    }

    #[test]
    fn slugify_normalizes() {
        assert_eq!(slugify("iCloud Mail"), "icloud-mail");
        assert_eq!(slugify("  Notion!! "), "notion");
        assert_eq!(slugify("a__b--c"), "a-b-c");
    }

    #[test]
    fn from_mcpb_maps_all_fields() {
        let bundle = json!({
            "manifest_version": "0.3",
            "name": "iCloud Mail",
            "display_name": "iCloud Mail",
            "description": "IMAP/SMTP for iCloud",
            "icon": "data:image/png;base64,AAAA",
            "tools": [
                { "name": "list_inbox", "description": "list messages" },
                { "name": "send_message" }
            ],
            "user_config": {
                "ICLOUD_APP_PW": { "type": "string", "title": "App password", "sensitive": true, "required": true },
                "ICLOUD_USER": { "type": "string", "title": "Address" }
            },
            "server": {
                "type": "python",
                "mcp_config": {
                    "command": "python",
                    "args": ["server.py"],
                    "env": { "ICLOUD_APP_PW": "${user_config.ICLOUD_APP_PW}", "ICLOUD_USER": "${user_config.ICLOUD_USER}" }
                }
            }
        });
        let m = Manifest::from_mcpb(&bundle).unwrap();
        assert_eq!(m.id, "icloud-mail");
        assert_eq!(m.display_name, "iCloud Mail");
        assert_eq!(m.tools.len(), 2);
        assert_eq!(m.tools[1].name, "send_message");
        assert_eq!(m.credentials.len(), 2);
        let secret = m.credentials.iter().find(|c| c.key == "ICLOUD_APP_PW").unwrap();
        assert!(secret.sensitive && secret.required);
        // Placeholders rewritten to plain env refs.
        assert_eq!(m.emit["env"]["ICLOUD_APP_PW"], json!("${ICLOUD_APP_PW}"));
        assert_eq!(m.emit["command"], json!("python"));
    }

    #[test]
    fn from_mcpb_requires_name() {
        assert!(Manifest::from_mcpb(&json!({ "description": "x" })).is_err());
    }

    #[test]
    fn manifest_auth_defaults_to_unspecified() {
        // A manifest with no `auth` block parses to the derive-me sentinel.
        let m: Manifest = serde_json::from_value(json!({ "id": "x" })).unwrap();
        assert_eq!(m.auth.kind, AuthKind::Unspecified);
        assert!(m.auth.is_unspecified());
    }

    #[test]
    fn from_mcpb_parses_an_auth_descriptor() {
        let bundle = json!({
            "name": "Acme",
            "auth": {
                "kind": "api_key",
                "help_url": "https://acme.example/keys",
                "help_text": "Create a restricted key.",
                "token_field": "ACME_TOKEN"
            },
            "server": { "mcp_config": { "url": "https://mcp.acme.example" } }
        });
        let m = Manifest::from_mcpb(&bundle).unwrap();
        assert_eq!(m.auth.kind, AuthKind::ApiKey);
        assert_eq!(m.auth.help_url.as_deref(), Some("https://acme.example/keys"));
        assert_eq!(m.auth.token_field.as_deref(), Some("ACME_TOKEN"));
        // The descriptor round-trips through the card JSON shape.
        let v = serde_json::to_value(&m.auth).unwrap();
        assert_eq!(v["kind"], json!("api_key"));
    }

    #[test]
    fn to_columns_roundtrips_tools() {
        let m = Manifest {
            id: "x".into(),
            kind: KIND_MCP_CATALOG.into(),
            display_name: "X".into(),
            icon: "".into(),
            description: "".into(),
            tools: vec![ToolDecl { name: "t".into(), description: "d".into() }],
            credentials: vec![],
            auth: AuthDescriptor::default(),
            emit: json!({ "command": "npx" }),
            categories: vec![],
        };
        let cols = m.to_columns();
        let tools: Vec<ToolDecl> = serde_json::from_str(&cols.tools_json).unwrap();
        assert_eq!(tools, m.tools);
        assert_eq!(cols.emit_json, r#"{"command":"npx"}"#);
    }
}
