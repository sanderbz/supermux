//! The per-session settings-overlay writer — THE shared seam.
//!
//! **One component owns building the per-session settings overlay.** This module
//! is that component. It computes, for one session, everything the launch path
//! needs to run that session's `claude` child with its granted connectors wired
//! in, its bot-memory recall hook fired, its secrets injected as env, and the
//! account/Claude.ai connector kill switch on — and nothing else. When a session
//! has NO connector grants and no memory, [`assemble`] returns `None` and the
//! launch is BYTE-IDENTICAL to the pre-connector fleet.
//!
//! **It layers OVER `~/.claude`, it does NOT repoint the config dir.** The overlay
//! is a private `settings.json` handed to the child via Claude Code's `--settings
//! <file>` flag, which MERGES it over the real config dir. We deliberately do NOT
//! set `CLAUDE_CONFIG_DIR`: repointing the child at a fresh, near-empty dir would
//! strand every subsystem that resolves against the server's `~/.claude` — the
//! transcript tailer / recall / chat plane (`resumable::project_dir_for`), the
//! statusline tap, teams config, `--resume`, and auth/trust — for exactly the bot
//! sessions that have connectors or memory. Transcripts, auth, statusline, teams,
//! and resume therefore stay pointed at the real `~/.claude`; only our hooks,
//! permissions, and the kill switch are layered on top.
//!
//! **How it composes with role/notes.** `lifecycle::build_launch_command` already
//! appends the read-only role/notes block via its OWN `--append-system-prompt`
//! flag pair. This seam contributes a SEPARATE `--mcp-config <json>
//! --strict-mcp-config` pair for connectors, plus a `--settings <file>` flag for
//! the hooks/permissions/kill-switch overlay (both through
//! [`SessionConfig::launch_flags`]) and a set of env vars (through
//! [`SessionConfig::env`], merged over `build_env`'s map). None clobbers another —
//! the flag pairs sit side by side in the launch line, and the env slots are
//! disjoint.
//!
//! **The extension seam (memory phase).** [`SessionConfig`] is a builder: the
//! connector phase calls [`SessionConfig::apply_connectors`], the memory phase
//! [`SessionConfig::apply_memory`] — both merge into the SAME
//! [`SessionConfig::settings`] overlay and the SAME [`SessionConfig::env`], written
//! by the SAME `finish`. The account-connector kill switch is applied by `finish`
//! for EVERY active launch (connectors OR memory), so an ungranted bot never
//! silently inherits account connectors.

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

/// The assembled per-session config: the settings-overlay JSON to write, the env
/// to inject, and the launch flags to append (`--mcp-config`/`--strict-mcp-config`
/// for connectors, `--settings <file>` for the overlay). Build it, apply the tiers
/// ([`apply_connectors`] and/or [`apply_memory`]), then [`finish`] to write the
/// overlay and hand the launch path what it needs.
pub struct SessionConfig {
    /// `<data_dir>/session-config/<name>` — holds this session's private
    /// `settings.json` overlay (passed via `--settings`, NOT as `CLAUDE_CONFIG_DIR`).
    settings_dir: PathBuf,
    /// The settings.json overlay body under construction. Merged OVER `~/.claude`
    /// by `--settings`; the memory phase adds a `hooks` block, `finish` adds the
    /// account-connector kill switch.
    settings: Map<String, Value>,
    /// Extra env for the launch child (secrets + the account-connector kill
    /// switch). The memory phase adds its own vars here.
    env: HashMap<String, String>,
    /// Extra launch-line flag WORDS (raw; `build_launch_command` shell-escapes
    /// each). `finish` appends `--mcp-config <json> --strict-mcp-config` (when any
    /// MCP server was accumulated) then `--settings <overlay path>`.
    launch_flags: Vec<String>,
    /// The inline `mcpServers` map under construction: granted connectors (keyed
    /// by connector id) PLUS the ambient `connect` affordance. Emitted as ONE
    /// `--mcp-config`/`--strict-mcp-config` pair by `finish` — so the connect
    /// server rides the same strict config as the grants, never a second pair.
    mcp_servers: Map<String, Value>,
    /// `permissions.allow` rules under construction — the connector tool globs,
    /// the `connect` tool, and the memory write-CLI grant all MERGE here and are
    /// written to `settings.permissions.allow` once by `finish` (no tier clobbers
    /// another's rules).
    allow_rules: Vec<Value>,
    /// True once any tier contributed something requiring the overlay. Gates the
    /// whole thing off for a plain session (byte-identical launch).
    active: bool,
}

impl SessionConfig {
    /// A fresh, inactive config for `session_name` under `data_dir`.
    pub fn new(data_dir: &Path, session_name: &str) -> Self {
        let settings_dir = data_dir.join("session-config").join(session_name);
        Self {
            settings_dir,
            settings: Map::new(),
            env: HashMap::new(),
            launch_flags: Vec::new(),
            mcp_servers: Map::new(),
            allow_rules: Vec::new(),
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

        // Accumulate into the shared inline mcp-config + allow list; `finish`
        // emits the single `--mcp-config`/`--strict-mcp-config` pair and writes
        // `permissions.allow` once (so the `connect` affordance and the memory
        // write-CLI grant can join the SAME strict config / allow list).
        for g in grants {
            self.mcp_servers.insert(g.connector_id.clone(), g.emit.clone());
            self.allow_rules
                .push(Value::String(format!("mcp__{}__*", g.connector_id)));
            // Inject decrypted secrets as env; the emit block's ${VAR} refs
            // resolve from the process environment at Claude startup. This keeps
            // the plaintext out of `~/.claude.json`, the transcript, and the
            // MCP stream — but it is resident in the granted child's
            // `/proc/<pid>/environ` for the session lifetime. THREAT-MODEL NOTE
            // (v1, accepted): all sessions run under ONE service uid, and Linux
            // exposes `environ` to the owning uid, so a sibling agent's own Bash
            // can read it. Closing that gap needs OS-level process isolation
            // (a per-agent uid, a PID/user namespace, or `/proc` mounted
            // `hidepid=2`) — all of which require root/sudo this host does not
            // have — or an fd/socket secret broker (a larger architecture change).
            // The vault, disk, and transcript boundaries all hold; the residual
            // exposure is same-uid `/proc` only, and is documented here rather
            // than silently relied upon.
            for (k, v) in &g.secrets {
                self.env.insert(k.clone(), v.clone());
            }
        }
        // The inline `--mcp-config`/`--strict-mcp-config` flags and the
        // `permissions.allow` array are emitted by `finish` from the accumulated
        // `mcp_servers` / `allow_rules` — so the `connect` affordance and the
        // memory write-CLI grant join the SAME strict config / allow list.
        // Ungranted connectors are denied by `--strict-mcp-config` itself (their
        // server is not in the config at all). The account/Claude.ai kill switch is
        // applied by `finish` to EVERY active launch.
    }

    // ── connect-affordance seam ────────────────────────────────────────────────
    /// Wire the store's `connect(service)` tool into this bot's launch (spec §8
    /// step 2): add the `connect` MCP server to the SAME inline `--mcp-config`
    /// (under `--strict-mcp-config`) and allow-list `mcp__connect__connect` so the
    /// call reaches the PreToolUse detector rather than being dropped. The server's
    /// tool carries the `requiresUserInteraction` marker, so the call always stops
    /// for the human and supermux raises the inline Connect card — the credential
    /// never travels the tool. `emit` is [`crate::connectors::connect_server::emit`]
    /// (no env, no secret). Idempotent-ish: only added to already-active bots, so a
    /// plain pane never gets it.
    pub fn apply_connect_affordance(&mut self, emit: Value) {
        self.active = true;
        self.mcp_servers
            .insert(crate::connectors::connect_server::SERVER_KEY.to_string(), emit);
        let rule = Value::String("mcp__connect__connect".to_string());
        if !self.allow_rules.contains(&rule) {
            self.allow_rules.push(rule);
        }
    }

    // ── shared-browser seam ───────────────────────────────────────────────────
    /// Wire the built-in **Shared Browser** connector into this bot's launch
    /// (phase 3): add the browser MCP server to the SAME inline `--mcp-config`
    /// (under `--strict-mcp-config`) and allow-list `mcp__browser__*` so its five
    /// tools auto-approve — except `request_human_takeover`, whose descriptor
    /// carries the `requiresUserInteraction` marker and therefore always reaches
    /// the human regardless of any allow rule.
    ///
    /// Called ONLY for a session holding an enabled `shared-browser` grant, so an
    /// ungranted bot gets no server, no tools, and no browser. The server key is
    /// `browser` (not the `shared-browser` connector id): Claude names tools
    /// `mcp__<key>__<tool>`, and a hyphen there would read badly and would not
    /// match the detector.
    ///
    /// `emit` is [`crate::connectors::browser::mcp::emit`] — `${VAR}` references
    /// only (the session name, its per-session hook token, the callback URL); no
    /// credential exists for this connector at all.
    pub fn apply_browser_connector(&mut self, emit: Value) {
        self.active = true;
        self.mcp_servers.insert(
            crate::connectors::browser::mcp::SERVER_KEY.to_string(),
            emit,
        );
        let rule = Value::String(crate::connectors::browser::mcp::ALLOW_RULE.to_string());
        if !self.allow_rules.contains(&rule) {
            self.allow_rules.push(rule);
        }
    }

    /// True once any tier has contributed — the launch will carry the overlay.
    pub fn is_active(&self) -> bool {
        self.active
    }

    // ── memory-phase seam ─────────────────────────────────────────────────────
    /// Wire this session's BOT MEMORY into the SAME per-session config dir the
    /// connector tier uses (design §3). This is ONE more entry in the union — it
    /// does NOT create a second config dir, does NOT touch the connector
    /// `--mcp-config`/`--strict-mcp-config` flags, and does NOT touch the
    /// role/notes `--append-system-prompt` block. All three compose:
    ///
    ///   * merges a `hooks` object into `settings` firing the recall hook on
    ///     `UserPromptSubmit` (per-turn) and `SessionStart` (baseline prime) — so
    ///     recall is injected, never dependent on the agent remembering to look;
    ///   * APPENDS `Bash(supermux-memory *)` to `permissions.allow` (merging with
    ///     any connector allowlist already there, never clobbering it) so the bot
    ///     may write its own archival notes;
    ///   * exports `BOT_MEMORY_NAME` / `BOT_MEMORY_ROLE` / `BOT_MEMORY_DIR` so the
    ///     hook + CLI resolve this bot's private + role tiers.
    pub fn apply_memory(&mut self, params: crate::bot_memory::MemoryParams) {
        self.active = true;

        // hooks: fire the recall wrapper on both context-injecting events.
        let hook_cmd = params.hook_bin.to_string_lossy().into_owned();
        let group = json!([{ "hooks": [ { "type": "command", "command": hook_cmd } ] }]);
        let hooks = self
            .settings
            .entry("hooks".to_string())
            .or_insert_with(|| json!({}));
        if let Some(obj) = hooks.as_object_mut() {
            obj.insert("UserPromptSubmit".to_string(), group.clone());
            obj.insert("SessionStart".to_string(), group);
        }

        // permissions.allow: MERGE the write-CLI grant into the shared allow list
        // (the connector globs + the connect tool live there too); `finish` writes
        // the array once, so no tier clobbers another's rules.
        let entry = Value::String("Bash(supermux-memory *)".to_string());
        if !self.allow_rules.contains(&entry) {
            self.allow_rules.push(entry);
        }

        // env: the hook + CLI read these to resolve the store + identity.
        self.env.insert(
            "BOT_MEMORY_NAME".to_string(),
            params.session_name.clone(),
        );
        self.env
            .insert("BOT_MEMORY_ROLE".to_string(), params.role_key.clone());
        self.env.insert(
            "BOT_MEMORY_DIR".to_string(),
            params.memory_dir.to_string_lossy().into_owned(),
        );
    }

    /// The account/Claude.ai connector kill switch — applied to EVERY active
    /// launch (connectors OR memory), never coupled to having ≥1 grant. Without
    /// this an ungranted-but-active bot (memory-only, or connector-less) would
    /// inherit the account's ambient Claude.ai connectors, bypassing the per-agent
    /// grant model. `disableClaudeAiConnectors` blocks the Claude.ai account
    /// connectors; the env var is the belt-and-suspenders twin.
    fn apply_account_connector_killswitch(&mut self) {
        self.settings
            .insert("disableClaudeAiConnectors".to_string(), Value::Bool(true));
        self.env
            .insert("ENABLE_CLAUDEAI_MCP_SERVERS".to_string(), "false".to_string());
    }

    /// Materialize the config: if any tier contributed, atomically write the
    /// private `settings.json` overlay and return the launch inputs — the overlay
    /// handed to the child via `--settings <file>` (which MERGES over the real
    /// `~/.claude`, leaving transcripts/auth/statusline/teams/resume intact),
    /// plus the secret env. Otherwise return `None` and leave the launch untouched.
    pub async fn finish(mut self) -> Result<Option<FinishedConfig>> {
        if !self.active {
            return Ok(None);
        }

        // Emit the ONE inline mcp-config pair from the accumulated servers (granted
        // connectors + the `connect` affordance). `--strict-mcp-config` makes the
        // launch use ONLY this config (ignoring `~/.claude.json`, project
        // `.mcp.json`, and account connectors); `enableAllProjectMcpServers=false`
        // is the belt-and-suspenders twin. Kept BEFORE `--settings` so
        // `launch_flags[1]` stays the inline JSON.
        if !self.mcp_servers.is_empty() {
            let inline = json!({ "mcpServers": Value::Object(self.mcp_servers.clone()) });
            self.launch_flags.push("--mcp-config".to_string());
            self.launch_flags
                .push(serde_json::to_string(&inline).unwrap_or_else(|_| "{}".into()));
            self.launch_flags.push("--strict-mcp-config".to_string());
            self.settings
                .insert("enableAllProjectMcpServers".to_string(), Value::Bool(false));
        }

        // Write the merged allow list once (connector globs + connect + memory).
        if !self.allow_rules.is_empty() {
            let perms = self
                .settings
                .entry("permissions".to_string())
                .or_insert_with(|| json!({}));
            if let Some(obj) = perms.as_object_mut() {
                obj.insert("allow".to_string(), Value::Array(self.allow_rules.clone()));
            }
        }

        // Every active launch gets the kill switch, decoupled from grants.
        self.apply_account_connector_killswitch();
        let settings_path = self.settings_dir.join("settings.json");
        write_json_atomic(&settings_path, &Value::Object(self.settings)).await?;
        // Layer the overlay OVER ~/.claude via --settings (Claude Code merges it),
        // instead of repointing CLAUDE_CONFIG_DIR at a near-empty dir.
        self.launch_flags.push("--settings".to_string());
        self.launch_flags
            .push(settings_path.to_string_lossy().into_owned());
        Ok(Some(FinishedConfig {
            env: self.env,
            launch_flags: self.launch_flags,
        }))
    }
}

/// What [`SessionConfig::finish`] hands the launch path.
#[derive(Debug, Clone)]
pub struct FinishedConfig {
    /// Merge over `build_env`'s map (adds the secret `${VAR}` values and the
    /// `ENABLE_CLAUDEAI_MCP_SERVERS=false` kill switch). Note: this does NOT set
    /// `CLAUDE_CONFIG_DIR` — the overlay rides `--settings` instead (see
    /// `launch_flags`).
    pub env: HashMap<String, String>,
    /// Append to the claude launch line (raw words; `build_launch_command`
    /// shell-escapes each): the connector `--mcp-config <json> --strict-mcp-config`
    /// pair and the `--settings <overlay path>` flag.
    pub launch_flags: Vec<String>,
}

/// Resolve one session's private launch config — connector grants AND bot memory —
/// into a [`FinishedConfig`], or `None` when the session has NEITHER (then the
/// launch is byte-identical to the pre-connector/pre-memory fleet). This is the
/// DB+vault-backed entry point the launch path calls; it reads the enabled grants
/// (own + all-agents), looks up each connector's emit block, decrypts any granted
/// secret, then — for a session that is a "bot" — wires in the recall hook + write
/// CLI grant + `BOT_MEMORY_*` env, all through the ONE [`SessionConfig`] builder
/// and its single `finish` writer.
///
/// Best-effort per grant: a grant whose connector row is gone, or whose secret
/// fails to decrypt, is SKIPPED with a warning rather than failing the whole
/// launch — a broken connector must not brick a session's start.
pub async fn assemble(state: &AppState, session_name: &str) -> Result<Option<FinishedConfig>> {
    let mut cfg = SessionConfig::new(&state.config.data_dir, session_name);
    // Set when this session holds an enabled `shared-browser` grant — the ONE
    // connector whose MCP server is built from the binary rather than a stored
    // emit block (see the loop below).
    let mut wants_browser = false;

    // ── connector tier ─────────────────────────────────────────────────────────
    let grants = connectors::grants_for_session(&state.pool, session_name).await?;
    if !grants.is_empty() {
        // Passive freshness (Slice 3): this launch is RESOLVING these grants, so
        // stamp `last_used_at = now` on every account they feed. Best-effort — a
        // stamp failure (or a legacy account-less grant) must never disturb a
        // launch; the "last used Nd ago" line is advisory, not load-bearing.
        let now = chrono::Utc::now().timestamp();
        for g in &grants {
            if let Some(aref) = g.account_ref.as_deref() {
                if let Err(e) = connectors::account_mark_used(&state.pool, aref, now).await {
                    tracing::debug!(connector = %g.connector_id, error = %e, "last_used_at stamp failed");
                }
            }
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
            // THE BUILT-IN SHARED BROWSER is not a stored-emit connector: its MCP
            // server is materialized from the binary at launch (so a shipped
            // update lands) and its server key / allow rule differ from the
            // id-derived defaults. Flag it here and wire it below.
            if connector.kind == crate::connectors::manifest::KIND_BUILTIN_BROWSER
                || g.connector_id == crate::connectors::browser::mcp::BROWSER_ID
            {
                wants_browser = true;
                continue;
            }
            let emit: Value =
                serde_json::from_str(&connector.emit_json).unwrap_or_else(|_| json!({}));
            let secrets = resolve_secret(state, vault.as_ref(), g).await;
            resolved.push(ResolvedGrant {
                connector_id: g.connector_id.clone(),
                emit,
                secrets,
            });
        }
        cfg.apply_connectors(&resolved);
    }

    // ── shared-browser tier ────────────────────────────────────────────────────
    // A granted bot gets the browser MCP server (five tools, lock-gated through
    // the local endpoint). An UNGRANTED bot never reaches this line, so its
    // launch carries no browser server, no browser tools, and spawns no chrome.
    if wants_browser {
        if let Some(path) = crate::connectors::browser::mcp::ensure(&state.config.data_dir).await {
            cfg.apply_browser_connector(crate::connectors::browser::mcp::emit(&path));
        }
    }

    // ── memory tier ─────────────────────────────────────────────────────────────
    // The bot-memory recall hook + write-CLI grant + BOT_MEMORY_* env, merged into
    // the SAME config dir. Gated on `session_has_memory` so a plain (non-bot) pane
    // stays byte-identical (no hook, no private dir); a bot activates the dir even
    // with zero connector grants. Best-effort: a missing session row just skips it.
    if let Some(session) = crate::db::sessions::get(&state.pool, session_name).await? {
        if crate::bot_memory::session_has_memory(&session, &state.config.data_dir) {
            cfg.apply_memory(crate::bot_memory::memory_params(
                &session,
                &state.config.data_dir,
            ));
        }
    }

    // ── connect affordance ───────────────────────────────────────────────────────
    // Give every ACTIVE bot launch (grants and/or memory) the store's
    // `connect(service)` tool, so a real agent actually HAS it in its toolset (spec
    // §8 step 2). Gated on `is_active()` so a plain (non-bot) pane with no grants
    // and no memory stays byte-identical — it never gets the connect server. The
    // server is materialized best-effort; a write failure just omits the affordance
    // rather than failing the launch.
    if cfg.is_active() {
        if let Some(path) =
            crate::connectors::connect_server::ensure(&state.config.data_dir).await
        {
            cfg.apply_connect_affordance(crate::connectors::connect_server::emit(&path));
        }
    }

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

    /// The path passed to `claude` via `--settings` (the overlay), if present.
    fn settings_flag(fin: &FinishedConfig) -> Option<&str> {
        let i = fin.launch_flags.iter().position(|w| w == "--settings")?;
        fin.launch_flags.get(i + 1).map(String::as_str)
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

    // ── the shared-browser grant, end to end through `assemble` ──────────────

    async fn browser_state() -> (crate::state::AppState, PathBuf) {
        let dir = temp_dir();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (crate::state::AppState::new(pool, config), dir)
    }

    /// Seed the `shared-browser` card the way boot does.
    async fn seed_browser_card(state: &crate::state::AppState) {
        let m = crate::connectors::browser::mcp::manifest("/tmp/server.py");
        let cols = m.to_columns();
        connectors::upsert(
            &state.pool,
            &m.id,
            &m.kind,
            &m.display_name,
            &m.icon,
            &m.description,
            &cols.tools_json,
            &cols.credentials_json,
            &cols.emit_json,
            "{}",
        )
        .await
        .unwrap();
    }

    fn mcp_config_json(fin: &FinishedConfig) -> Value {
        let i = fin
            .launch_flags
            .iter()
            .position(|w| w == "--mcp-config")
            .expect("--mcp-config present");
        serde_json::from_str(&fin.launch_flags[i + 1]).unwrap()
    }

    /// GRANTED: the launch carries the browser MCP server + its allow rule, with
    /// `${VAR}` scope references and no secret.
    #[tokio::test]
    async fn a_granted_session_launches_with_the_browser_mcp_server() {
        let (state, dir) = browser_state().await;
        seed_browser_card(&state).await;
        crate::db::sessions::insert_minimal(&state.pool, "alice", "/tmp", "claude")
            .await
            .unwrap();
        connectors::grant(&state.pool, "alice", "shared-browser", None, true)
            .await
            .unwrap();

        let fin = assemble(&state, "alice")
            .await
            .unwrap()
            .expect("a granted session has an active config");

        // The server rides the SAME strict inline config as every other grant,
        // under the `browser` key (so tools are `mcp__browser__*`).
        let cfg = mcp_config_json(&fin);
        let entry = &cfg["mcpServers"]["browser"];
        assert_eq!(entry["command"], json!("python3"));
        assert!(
            entry["args"][0].as_str().unwrap().ends_with("shared-browser/server.py"),
            "materialized from the binary: {entry}"
        );
        assert_eq!(entry["env"]["SUPERMUX_HOOK_TOKEN"], json!("${SUPERMUX_HOOK_TOKEN}"));
        assert_eq!(entry["env"]["SUPERMUX_SESSION"], json!("${SUPERMUX_SESSION}"));
        // The connector id is NOT used as a server key (no `mcp__shared-browser__*`).
        assert!(cfg["mcpServers"].get("shared-browser").is_none());
        assert!(fin.launch_flags.iter().any(|w| w == "--strict-mcp-config"));

        // …and the tools are allow-listed in the overlay.
        let settings: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("session-config/alice/settings.json")).unwrap(),
        )
        .unwrap();
        let allow = settings["permissions"]["allow"].as_array().unwrap();
        assert!(
            allow.contains(&json!("mcp__browser__*")),
            "browser tools auto-approve: {allow:?}"
        );

        // The script really is on disk where the emit points.
        let path = crate::connectors::browser::mcp::server_path(&dir);
        assert!(path.exists(), "the embedded server was materialized");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// UNGRANTED: byte-identical launch — no config at all, no browser server,
    /// and nothing materialized.
    #[tokio::test]
    async fn an_ungranted_session_gets_no_browser_server_at_all() {
        let (state, dir) = browser_state().await;
        seed_browser_card(&state).await;
        crate::db::sessions::insert_minimal(&state.pool, "bob", "/tmp", "claude")
            .await
            .unwrap();

        let fin = assemble(&state, "bob").await.unwrap();
        assert!(
            fin.is_none(),
            "a plain pane with no grants and no memory stays byte-identical"
        );
        assert!(!dir.join("session-config").exists(), "nothing written");
        assert!(
            !crate::connectors::browser::mcp::server_path(&dir).exists(),
            "the browser server is not even materialized for an ungranted session"
        );
        assert!(
            !state.browser.is_running().await,
            "assembling a launch must never spawn chrome"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A DIFFERENT connector's grant must not smuggle the browser in.
    #[tokio::test]
    async fn another_connectors_grant_does_not_carry_the_browser() {
        let (state, dir) = browser_state().await;
        seed_browser_card(&state).await;
        crate::db::sessions::insert_minimal(&state.pool, "carol", "/tmp", "claude")
            .await
            .unwrap();
        connectors::upsert(
            &state.pool,
            "pmcp-notion",
            "mcp_catalog",
            "Notion",
            "",
            "",
            "[]",
            "[]",
            &json!({ "command": "npx", "args": ["notion"] }).to_string(),
            "{}",
        )
        .await
        .unwrap();
        connectors::grant(&state.pool, "carol", "pmcp-notion", None, true)
            .await
            .unwrap();

        let fin = assemble(&state, "carol").await.unwrap().expect("active");
        let cfg = mcp_config_json(&fin);
        assert!(cfg["mcpServers"]["pmcp-notion"].is_object());
        assert!(
            cfg["mcpServers"].get("browser").is_none(),
            "no browser server without the shared-browser grant"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Passive freshness: assembling a launch that resolves an account-bearing
    /// grant stamps that account's `last_used_at` (Slice 3, task a). A legacy
    /// account-less grant is untouched (nothing to stamp) and never errors.
    #[tokio::test]
    async fn launch_stamps_last_used_on_the_resolved_account() {
        let (state, dir) = browser_state().await;
        connectors::upsert(
            &state.pool,
            "gmail",
            "mcp_catalog",
            "Gmail",
            "",
            "",
            "[]",
            "[]",
            &json!({ "command": "npx", "args": ["gmail"] }).to_string(),
            "{}",
        )
        .await
        .unwrap();
        crate::db::sessions::insert_minimal(&state.pool, "crm-bot", "/tmp", "claude")
            .await
            .unwrap();
        let acct = connectors::account_add(&state.pool, "gmail", "sander@acme.com", None)
            .await
            .unwrap();
        // Fresh account: never used.
        assert_eq!(
            connectors::account_get(&state.pool, &acct).await.unwrap().unwrap().last_used_at,
            0
        );
        connectors::grant_with_account(&state.pool, "crm-bot", "gmail", None, true, Some(&acct))
            .await
            .unwrap();

        let _ = assemble(&state, "crm-bot").await.unwrap().expect("active launch");

        let a = connectors::account_get(&state.pool, &acct).await.unwrap().unwrap();
        assert!(a.last_used_at > 0, "launch stamps last_used_at on the resolved account");
        std::fs::remove_dir_all(&dir).ok();
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

        // Secret + kill-switch env injected; the overlay rides --settings, NOT
        // a repointed CLAUDE_CONFIG_DIR.
        assert_eq!(fin.env.get("ICLOUD_APP_PW").map(String::as_str), Some("sekret"));
        assert!(!fin.env.contains_key("CLAUDE_CONFIG_DIR"), "must NOT repoint the config dir");
        assert_eq!(fin.env.get("ENABLE_CLAUDEAI_MCP_SERVERS").map(String::as_str), Some("false"));

        // --settings points at the written overlay.
        let settings_path = dir.join("session-config").join("alpha").join("settings.json");
        assert_eq!(settings_flag(&fin), Some(settings_path.to_string_lossy().as_ref()));
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
        // Distinct per-session overlays too (and neither repoints the config dir).
        assert_ne!(settings_flag(&fa), settings_flag(&fb));
        assert!(!fa.env.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(!fb.env.contains_key("CLAUDE_CONFIG_DIR"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The store's `connect(service)` tool is EXPOSED to a bot: the connect MCP
    /// server rides the same strict inline config, and `mcp__connect__connect` is
    /// allow-listed so the call reaches the PreToolUse detector (round-2 claim 5,
    /// tool-exposure half). The server carries no secret.
    #[tokio::test]
    async fn connect_affordance_exposes_the_connect_tool() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "ada");
        // A bot with one granted connector AND the connect affordance.
        cfg.apply_connectors(&[resolved("pmcp-notion", None)]);
        let emit = crate::connectors::connect_server::emit(std::path::Path::new(
            "/data/connectors/connect/server.py",
        ));
        cfg.apply_connect_affordance(emit);
        let fin = cfg.finish().await.unwrap().expect("active");

        // ONE strict mcp-config pair carrying BOTH the granted connector AND connect.
        assert!(fin.launch_flags.iter().any(|w| w == "--strict-mcp-config"));
        let json_arg = &fin.launch_flags[1];
        let v: Value = serde_json::from_str(json_arg).unwrap();
        assert!(v["mcpServers"]["pmcp-notion"].is_object(), "grant present");
        assert_eq!(
            v["mcpServers"]["connect"]["command"],
            json!("python3"),
            "connect server injected into the SAME strict config"
        );
        assert!(
            v["mcpServers"]["connect"].get("env").is_none(),
            "connect carries no credentials"
        );

        // The connect tool is allow-listed so the call reaches PreToolUse.
        let text = std::fs::read_to_string(
            dir.join("session-config").join("ada").join("settings.json"),
        )
        .unwrap();
        let s: Value = serde_json::from_str(&text).unwrap();
        let allow = s["permissions"]["allow"].as_array().unwrap();
        assert!(allow.contains(&json!("mcp__pmcp-notion__*")), "grant allow kept: {allow:?}");
        assert!(
            allow.contains(&json!("mcp__connect__connect")),
            "connect tool allow-listed: {allow:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A memory-only bot (zero connector grants) still gets the connect tool — so
    /// it can connect its first connector — and that is the ONLY server in its
    /// strict config.
    #[tokio::test]
    async fn connect_affordance_alone_produces_a_strict_config() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "solo");
        cfg.apply_memory(mem_params(&dir, "solo", "reviewer"));
        // No grants, but active (memory) → connect is added.
        assert!(cfg.is_active());
        cfg.apply_connect_affordance(crate::connectors::connect_server::emit(
            std::path::Path::new("/x/server.py"),
        ));
        let fin = cfg.finish().await.unwrap().expect("active");
        let json_arg = &fin.launch_flags[1];
        let v: Value = serde_json::from_str(json_arg).unwrap();
        assert!(v["mcpServers"]["connect"].is_object());
        assert!(v["mcpServers"].as_object().unwrap().len() == 1, "connect is the only server");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A plain (non-bot) pane never activates, so `apply_connect_affordance` is
    /// never reached in `assemble` — the launch stays byte-identical. Proven here
    /// by the activeness gate the assembler checks.
    #[tokio::test]
    async fn inactive_pane_is_not_given_connect() {
        let dir = temp_dir();
        let cfg = SessionConfig::new(&dir, "plain");
        assert!(!cfg.is_active(), "a fresh pane is inactive → assemble skips connect");
        assert!(cfg.finish().await.unwrap().is_none(), "byte-identical launch");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn mem_params(dir: &Path, name: &str, role: &str) -> crate::bot_memory::MemoryParams {
        crate::bot_memory::MemoryParams {
            session_name: name.to_string(),
            role_key: role.to_string(),
            memory_dir: dir.join("bot-memory"),
            hook_bin: dir.join("bin/bot-memory-recall"),
        }
    }

    /// THE COEXISTENCE INVARIANT (design §3): connectors + bot memory land in ONE
    /// settings.json / one env / one config dir without either clobbering the
    /// other. The connector allowlist and the memory write-CLI grant MERGE into a
    /// single `permissions.allow`; the recall hooks and the connector kill switch
    /// both survive; the mcp-config flag pair and the BOT_MEMORY_* env coexist.
    /// (The role/notes `--append-system-prompt` block is the THIRD injection — it
    /// rides its own launch flag pair in `build_launch_command`, proven disjoint
    /// there; here we pin the two that share this file.)
    #[tokio::test]
    async fn connectors_and_memory_coexist_in_one_config() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "alpha");
        cfg.apply_connectors(&[resolved("github", Some(("GH_TOKEN", "sekret")))]);
        cfg.apply_memory(mem_params(&dir, "alpha", "reviewer"));
        let fin = cfg.finish().await.unwrap().expect("active");

        // Both flag pairs / env slots coexist, disjoint.
        assert!(fin.launch_flags.iter().any(|w| w == "--mcp-config"));
        assert_eq!(fin.env.get("GH_TOKEN").map(String::as_str), Some("sekret"));
        assert_eq!(fin.env.get("BOT_MEMORY_NAME").map(String::as_str), Some("alpha"));
        assert_eq!(fin.env.get("BOT_MEMORY_ROLE").map(String::as_str), Some("reviewer"));
        assert!(fin.env.contains_key("BOT_MEMORY_DIR"));
        assert!(settings_flag(&fin).is_some(), "overlay rides --settings");
        assert!(!fin.env.contains_key("CLAUDE_CONFIG_DIR"), "no config-dir repoint");

        let text =
            std::fs::read_to_string(dir.join("session-config").join("alpha").join("settings.json"))
                .unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        // permissions.allow carries BOTH the connector tool + the write-CLI grant.
        let allow = v["permissions"]["allow"].as_array().unwrap();
        assert!(allow.contains(&json!("mcp__github__*")), "connector allow kept: {allow:?}");
        assert!(allow.contains(&json!("Bash(supermux-memory *)")), "memory grant merged: {allow:?}");
        // Connector kill switch survives the memory merge.
        assert_eq!(v["disableClaudeAiConnectors"], json!(true));
        // Recall hooks fire on both context-injecting events.
        assert!(v["hooks"]["UserPromptSubmit"].is_array());
        assert!(v["hooks"]["SessionStart"].is_array());
        assert_eq!(
            v["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            json!(dir.join("bin/bot-memory-recall").to_string_lossy().into_owned())
        );
        assert!(!text.contains("sekret"), "secret never on disk");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A memory-only bot (no connector grants) still activates the overlay +
    /// hook — a bot's self-writes must be recallable next turn even with zero
    /// connectors — AND still gets the account-connector kill switch, so an
    /// ungranted bot never silently inherits the account's Claude.ai connectors.
    #[tokio::test]
    async fn memory_only_activates_without_connectors() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "solo");
        cfg.apply_memory(mem_params(&dir, "solo", ""));
        let fin = cfg.finish().await.unwrap().expect("memory alone activates");
        let overlay = settings_flag(&fin).expect("overlay rides --settings");
        assert!(!fin.env.contains_key("CLAUDE_CONFIG_DIR"), "no config-dir repoint");
        assert!(!fin.launch_flags.iter().any(|w| w == "--mcp-config"), "no connector flags");
        assert_eq!(fin.env.get("BOT_MEMORY_ROLE").map(String::as_str), Some(""));

        // Kill switch present even with ZERO connector grants (finding: an
        // ungranted bot must not inherit account connectors).
        assert_eq!(fin.env.get("ENABLE_CLAUDEAI_MCP_SERVERS").map(String::as_str), Some("false"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(overlay).unwrap()).unwrap();
        assert_eq!(v["disableClaudeAiConnectors"], json!(true), "account-connector kill switch on");
        std::fs::remove_dir_all(&dir).ok();
    }
}
