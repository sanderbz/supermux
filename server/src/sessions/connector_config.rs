//! The per-session config-dir + settings.json writer — THE shared seam.
//!
//! **One component owns creating the per-session private config dir.** This
//! module is that component. It computes, for one session, everything the launch
//! path needs to run that session's `claude` child with an ISOLATED
//! `CLAUDE_CONFIG_DIR`, its granted connectors wired in, and their secrets
//! injected as env — and nothing else. When a session has NO connector grants
//! (and, later, no memory), [`assemble`] returns `None` and the launch is
//! BYTE-IDENTICAL to the pre-connector fleet.
//!
//! **How it composes with role/notes.** `lifecycle::build_launch_command` already
//! appends the read-only role/notes block via its OWN `--append-system-prompt`
//! flag pair. This seam contributes a SEPARATE, independent `--mcp-config <json>
//! --strict-mcp-config` flag pair (through [`SessionConfig::launch_flags`]) and a
//! set of env vars (through [`SessionConfig::env`], merged over
//! `build_env`'s map). Neither clobbers the other — both flag pairs sit side by
//! side in the launch line, and the env slots are disjoint.
//!
//! **The extension seam (memory phase).** [`SessionConfig`] is a builder: the
//! connector phase calls [`SessionConfig::apply_connectors`]. The memory phase
//! will add a sibling `apply_memory` that merges a `hooks` block into
//! [`SessionConfig::settings`] and adds env vars to [`SessionConfig::env`] — the
//! same struct, the same `finish` writer, the same `CLAUDE_CONFIG_DIR`. See the
//! marked seam in [`SessionConfig`].

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::claude_tools::atomic::write_json_atomic;
use crate::db::connectors::{self, Grant};
use crate::state::AppState;
use crate::vault::Vault;

/// One granted connector, resolved to what the launch needs: its inline
/// `mcpServers` entry (`emit`) and any decrypted secret field-map to inject.
#[derive(Debug, Clone)]
pub struct ResolvedGrant {
    pub connector_id: String,
    /// The `mcpServers` entry template (`${VAR}` placeholders intact).
    pub emit: Value,
    /// Decrypted secret fields to inject as env (env-var-name → value). Empty for
    /// a no-secret connector.
    pub secrets: BTreeMap<String, String>,
}

/// The assembled per-session config: a private `CLAUDE_CONFIG_DIR`, the settings
/// JSON to write into it, the env to inject, and the launch flags to append.
/// Build it, apply the tiers ([`apply_connectors`] now; `apply_memory` later),
/// then [`finish`] to write settings.json and hand the launch path what it needs.
pub struct SessionConfig {
    /// `<data_dir>/session-config/<name>` — becomes `CLAUDE_CONFIG_DIR`.
    config_dir: PathBuf,
    /// The settings.json body under construction. The memory phase merges a
    /// `hooks` block here.
    settings: Map<String, Value>,
    /// Extra env for the launch child (secrets + `CLAUDE_CONFIG_DIR` + the
    /// account-connector kill switch). The memory phase adds its own vars here.
    env: HashMap<String, String>,
    /// Extra launch-line flag WORDS (raw; `build_launch_command` shell-escapes
    /// each). The connector tier appends `--mcp-config <json> --strict-mcp-config`.
    launch_flags: Vec<String>,
    /// True once any tier contributed something requiring the private dir. Gates
    /// the whole thing off for a plain session (byte-identical launch).
    active: bool,
}

impl SessionConfig {
    /// A fresh, inactive config for `session_name` under `data_dir`.
    pub fn new(data_dir: &Path, session_name: &str) -> Self {
        let config_dir = data_dir.join("session-config").join(session_name);
        Self {
            config_dir,
            settings: Map::new(),
            env: HashMap::new(),
            launch_flags: Vec::new(),
            active: false,
        }
    }

    /// Wire the session's granted connectors in (spec §5):
    ///   * an inline `--mcp-config '{"mcpServers":{...}}'` computed from the
    ///     grants, plus `--strict-mcp-config` so the launch uses ONLY this config
    ///     (ignoring `~/.claude.json`, project `.mcp.json`, and Claude.ai
    ///     connectors);
    ///   * `permissions.allow = ["mcp__<connector>__*", ...]` so the granted tools
    ///     auto-approve. Default-deny of UNGRANTED connectors is enforced by
    ///     `--strict-mcp-config` itself — an ungranted connector's server is not
    ///     in the config at all, so its tools cannot be named, which is stricter
    ///     than a `deny` rule (and avoids the deny>allow precedence that would
    ///     clobber a blanket `mcp__*` deny against the specific allows);
    ///   * `disableClaudeAiConnectors: true` + `ENABLE_CLAUDEAI_MCP_SERVERS=false`
    ///     so account-global connectors can never silently inherit;
    ///   * each connector's decrypted secret fields injected as env vars the emit
    ///     block references via `${VAR}` — so the raw secret is NEVER written into
    ///     `~/.claude.json` on disk and never reaches the transcript.
    ///
    /// A no-grant call leaves the config inactive.
    pub fn apply_connectors(&mut self, grants: &[ResolvedGrant]) {
        if grants.is_empty() {
            return;
        }
        self.active = true;

        // Inline mcp-config: { "mcpServers": { "<id>": <emit>, ... } }.
        let mut servers = Map::new();
        let mut allow: Vec<Value> = Vec::new();
        for g in grants {
            servers.insert(g.connector_id.clone(), g.emit.clone());
            allow.push(Value::String(format!("mcp__{}__*", g.connector_id)));
            // Inject decrypted secrets as env; the emit block's ${VAR} refs
            // resolve from the process environment at Claude startup.
            for (k, v) in &g.secrets {
                self.env.insert(k.clone(), v.clone());
            }
        }
        let inline = json!({ "mcpServers": Value::Object(servers) });
        self.launch_flags.push("--mcp-config".to_string());
        self.launch_flags
            .push(serde_json::to_string(&inline).unwrap_or_else(|_| "{}".into()));
        self.launch_flags.push("--strict-mcp-config".to_string());

        // Auto-allow the granted tools; forbid account connectors.
        let perms = self
            .settings
            .entry("permissions".to_string())
            .or_insert_with(|| json!({}));
        if let Some(obj) = perms.as_object_mut() {
            obj.insert("allow".to_string(), Value::Array(allow));
        }
        self.settings
            .insert("disableClaudeAiConnectors".to_string(), Value::Bool(true));
        self.settings
            .insert("enableAllProjectMcpServers".to_string(), Value::Bool(false));
        self.env
            .insert("ENABLE_CLAUDEAI_MCP_SERVERS".to_string(), "false".to_string());
    }

    // ── memory-phase seam ─────────────────────────────────────────────────────
    // The memory phase adds `pub fn apply_memory(&mut self, ...)` HERE: it sets
    // `self.active = true`, merges a `hooks` object into `self.settings`, and adds
    // its own env vars via `self.env`. It reuses this exact `config_dir` +
    // `finish` writer — do NOT create a second per-session config dir.

    /// Materialize the config: if any tier contributed, create the private dir,
    /// atomically write its `settings.json`, and return the launch inputs
    /// (`CLAUDE_CONFIG_DIR` set in the returned env). Otherwise return `None` and
    /// leave the launch untouched.
    pub async fn finish(mut self) -> Result<Option<FinishedConfig>> {
        if !self.active {
            return Ok(None);
        }
        let settings_path = self.config_dir.join("settings.json");
        write_json_atomic(&settings_path, &Value::Object(self.settings)).await?;
        self.env.insert(
            "CLAUDE_CONFIG_DIR".to_string(),
            self.config_dir.to_string_lossy().into_owned(),
        );
        Ok(Some(FinishedConfig {
            env: self.env,
            launch_flags: self.launch_flags,
        }))
    }
}

/// What [`SessionConfig::finish`] hands the launch path.
#[derive(Debug, Clone)]
pub struct FinishedConfig {
    /// Merge over `build_env`'s map (adds `CLAUDE_CONFIG_DIR`, the secret
    /// `${VAR}` values, and the account-connector kill switch).
    pub env: HashMap<String, String>,
    /// Append to the claude launch line (raw words; `build_launch_command`
    /// shell-escapes each).
    pub launch_flags: Vec<String>,
}

/// Resolve one session's connector grants into a [`FinishedConfig`] (or `None`
/// when it has no enabled grants). This is the DB+vault-backed entry point the
/// launch path calls; it reads the enabled grants (own + all-agents), looks up
/// each connector's emit block, decrypts any granted secret, then drives the
/// [`SessionConfig`] builder.
///
/// Best-effort per grant: a grant whose connector row is gone, or whose secret
/// fails to decrypt, is SKIPPED with a warning rather than failing the whole
/// launch — a broken connector must not brick a session's start.
pub async fn assemble(state: &AppState, session_name: &str) -> Result<Option<FinishedConfig>> {
    let grants = connectors::grants_for_session(&state.pool, session_name).await?;
    if grants.is_empty() {
        return Ok(None);
    }

    // Open the vault once (only if some grant carries a secret_ref).
    let needs_vault = grants.iter().any(|g| g.secret_ref.is_some());
    let vault = if needs_vault {
        match Vault::open(&state.config.data_dir) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!(error = %e, "connector launch: vault unavailable; connectors with secrets will be skipped");
                None
            }
        }
    } else {
        None
    };

    let mut resolved: Vec<ResolvedGrant> = Vec::new();
    for g in &grants {
        let Some(connector) = connectors::get(&state.pool, &g.connector_id).await? else {
            tracing::warn!(connector = %g.connector_id, "connector launch: grant references a missing connector; skipping");
            continue;
        };
        let emit: Value = serde_json::from_str(&connector.emit_json).unwrap_or_else(|_| json!({}));
        let secrets = resolve_secret(state, vault.as_ref(), g).await;
        resolved.push(ResolvedGrant {
            connector_id: g.connector_id.clone(),
            emit,
            secrets,
        });
    }

    let mut cfg = SessionConfig::new(&state.config.data_dir, session_name);
    cfg.apply_connectors(&resolved);
    cfg.finish().await
}

/// Decrypt a grant's secret field-map, or return an empty map (no secret / a
/// decrypt failure — logged, never fatal, never logs the secret itself).
async fn resolve_secret(
    state: &AppState,
    vault: Option<&Vault>,
    grant: &Grant,
) -> BTreeMap<String, String> {
    let Some(secret_ref) = grant.secret_ref.as_deref() else {
        return BTreeMap::new();
    };
    let Some(vault) = vault else {
        return BTreeMap::new();
    };
    match connectors::vault_get(&state.pool, secret_ref).await {
        Ok(Some(row)) => match vault.open_fields(&row.fields_enc, &row.nonce) {
            Ok(fields) => fields,
            Err(e) => {
                tracing::warn!(connector = %grant.connector_id, error = %e, "connector launch: secret failed to decrypt; skipping");
                BTreeMap::new()
            }
        },
        Ok(None) => {
            tracing::warn!(connector = %grant.connector_id, "connector launch: grant references a missing vault row; skipping secret");
            BTreeMap::new()
        }
        Err(e) => {
            tracing::warn!(connector = %grant.connector_id, error = %e, "connector launch: vault read failed; skipping secret");
            BTreeMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-sc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn resolved(id: &str, secret: Option<(&str, &str)>) -> ResolvedGrant {
        let mut secrets = BTreeMap::new();
        if let Some((k, v)) = secret {
            secrets.insert(k.to_string(), v.to_string());
        }
        ResolvedGrant {
            connector_id: id.to_string(),
            emit: json!({ "command": "python", "args": ["s.py"], "env": { "K": "${K}" } }),
            secrets,
        }
    }

    #[tokio::test]
    async fn inactive_when_no_grants() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "alpha");
        cfg.apply_connectors(&[]);
        assert!(cfg.finish().await.unwrap().is_none(), "no grants => byte-identical launch");
        // Nothing written.
        assert!(!dir.join("session-config").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn connectors_produce_flags_env_and_settings() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "alpha");
        cfg.apply_connectors(&[resolved("icloud-mail", Some(("ICLOUD_APP_PW", "sekret")))]);
        let fin = cfg.finish().await.unwrap().expect("active");

        // --mcp-config + --strict-mcp-config present.
        assert!(fin.launch_flags.iter().any(|w| w == "--mcp-config"));
        assert!(fin.launch_flags.iter().any(|w| w == "--strict-mcp-config"));
        let json_arg = &fin.launch_flags[1];
        assert!(json_arg.contains("\"icloud-mail\""));

        // Secret + CLAUDE_CONFIG_DIR + kill switch injected as env.
        assert_eq!(fin.env.get("ICLOUD_APP_PW").map(String::as_str), Some("sekret"));
        assert!(fin.env.contains_key("CLAUDE_CONFIG_DIR"));
        assert_eq!(fin.env.get("ENABLE_CLAUDEAI_MCP_SERVERS").map(String::as_str), Some("false"));

        // settings.json written with the allowlist + kill switch, no plaintext secret.
        let settings_path = dir.join("session-config").join("alpha").join("settings.json");
        let text = std::fs::read_to_string(&settings_path).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["permissions"]["allow"][0], json!("mcp__icloud-mail__*"));
        assert_eq!(v["disableClaudeAiConnectors"], json!(true));
        assert!(!text.contains("sekret"), "secret must NEVER be written to settings.json on disk");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Two sessions with different grants must get DIFFERENT inline --mcp-config
    /// (isolation): alpha sees icloud-mail, beta sees github, neither sees both.
    #[tokio::test]
    async fn two_sessions_get_different_mcp_config() {
        let dir = temp_dir();

        let mut a = SessionConfig::new(&dir, "alpha");
        a.apply_connectors(&[resolved("icloud-mail", None)]);
        let fa = a.finish().await.unwrap().unwrap();

        let mut b = SessionConfig::new(&dir, "beta");
        b.apply_connectors(&[resolved("github", None)]);
        let fb = b.finish().await.unwrap().unwrap();

        let ja = &fa.launch_flags[1];
        let jb = &fb.launch_flags[1];
        assert_ne!(ja, jb, "distinct sessions get distinct inline mcp-config");
        assert!(ja.contains("icloud-mail") && !ja.contains("github"));
        assert!(jb.contains("github") && !jb.contains("icloud-mail"));
        // Distinct CLAUDE_CONFIG_DIRs too.
        assert_ne!(fa.env.get("CLAUDE_CONFIG_DIR"), fb.env.get("CLAUDE_CONFIG_DIR"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
