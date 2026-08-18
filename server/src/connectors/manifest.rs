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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}

fn default_field_type() -> String {
    "string".to_string()
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
    /// The `mcpServers` entry template (`{ command|url, args?, env?, headers? }`)
    /// with `${VAR}` placeholders — the SAME shape `claude_tools::mcp::add`
    /// accepts.
    #[serde(default)]
    pub emit: Value,
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
                        default: spec.get("default").cloned(),
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

        let manifest = Manifest {
            id,
            kind: KIND_MCP_CATALOG.to_string(),
            display_name,
            icon,
            description,
            tools,
            credentials,
            emit,
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
    fn to_columns_roundtrips_tools() {
        let m = Manifest {
            id: "x".into(),
            kind: KIND_MCP_CATALOG.into(),
            display_name: "X".into(),
            icon: "".into(),
            description: "".into(),
            tools: vec![ToolDecl { name: "t".into(), description: "d".into() }],
            credentials: vec![],
            emit: json!({ "command": "npx" }),
        };
        let cols = m.to_columns();
        let tools: Vec<ToolDecl> = serde_json::from_str(&cols.tools_json).unwrap();
        assert_eq!(tools, m.tools);
        assert_eq!(cols.emit_json, r#"{"command":"npx"}"#);
    }
}
