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
use crate::connectors::manifest::CredentialField;
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
    /// a no-secret connector. A FILE credential (see [`files`]) is NEVER here — its
    /// raw content must not become an env value.
    pub secrets: BTreeMap<String, String>,
    /// Decrypted FILE credentials to materialize at launch: each is written to a
    /// 0600 file in the session's own dir and its `env_var` is set to that file's
    /// PATH (not the content). Empty for the common (no-file) connector.
    pub files: Vec<FileCredential>,
}

/// A decrypted FILE credential to materialize at launch. The `content` is written
/// to a 0600 file inside the session's runtime dir and `env_var` is pointed at the
/// resulting path — the raw content is never exported as an env value, never logged.
#[derive(Debug, Clone)]
pub struct FileCredential {
    /// The env var to set to the materialized file's PATH (e.g.
    /// `GOOGLE_APPLICATION_CREDENTIALS`).
    pub env_var: String,
    /// The credential field key the content was vaulted under — the filename stem
    /// (`<connector>-<field_key>`) so the file is deterministic per connector/field.
    pub field_key: String,
    /// The decrypted file content (e.g. a service-account JSON blob).
    pub content: String,
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

        // FILE credentials are materialized under `<session dir>/creds`. Clear it
        // once per launch (deterministic overwrite) so a revoked file-credential
        // connector never leaves its secret file behind for the next launch.
        let creds_dir = self.settings_dir.join("creds");
        if grants.iter().any(|g| !g.files.is_empty()) {
            let _ = std::fs::remove_dir_all(&creds_dir);
        }

        // Accumulate into the shared inline mcp-config + allow list; `finish`
        // emits the single `--mcp-config`/`--strict-mcp-config` pair and writes
        // `permissions.allow` once (so the `connect` affordance and the memory
        // write-CLI grant can join the SAME strict config / allow list).
        for g in grants {
            // Materialize any FILE credentials FIRST. Fail-safe: if a file can't be
            // written, skip this connector's launch entirely (no server, no allow
            // rule, no env) rather than leaking a secret or wiring a half-broken
            // connector — a broken file-credential must not brick the session.
            let mut file_env: Vec<(String, String)> = Vec::with_capacity(g.files.len());
            let mut file_failed = false;
            for f in &g.files {
                match materialize_cred_file(&creds_dir, &g.connector_id, f) {
                    Ok(path) => file_env.push((f.env_var.clone(), path)),
                    Err(e) => {
                        // Never log the content — only the connector id + io error.
                        tracing::warn!(connector = %g.connector_id, error = %e, "connector launch: could not materialize credential file; skipping connector");
                        file_failed = true;
                        break;
                    }
                }
            }
            if file_failed {
                continue;
            }

            self.active = true;
            self.mcp_servers.insert(g.connector_id.clone(), g.emit.clone());
            self.allow_rules
                .push(Value::String(format!("mcp__{}__*", g.connector_id)));
            // Point each file-credential's env var at the materialized PATH (never
            // the raw content).
            for (k, v) in file_env {
                self.env.insert(k, v);
            }
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
        // Allow-list BOTH tools: the interactive `connect` (still stops for the human
        // via its `requiresUserInteraction` marker) and the NON-interactive
        // `list_connectors` (P2d — a plain read that auto-approves, never routed to
        // the human).
        for rule in ["mcp__connect__connect", "mcp__connect__list_connectors"] {
            let r = Value::String(rule.to_string());
            if !self.allow_rules.contains(&r) {
                self.allow_rules.push(r);
            }
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

    /// Point the recall hook at this session's pre-rendered SessionStart
    /// capability briefing (fase C). The briefing text is built server-side (it
    /// needs the DB for the company + peer roster) and written to `path` by
    /// [`assemble`]; here we only export the env var the hook reads on
    /// `SessionStart`. Coupled to the memory tier because the recall hook is the
    /// vehicle that emits it — a session with no memory has no hook and so no
    /// briefing (its launch stays byte-identical).
    pub fn set_briefing_env(&mut self, path: &Path) {
        self.env.insert(
            crate::agents::briefing::BRIEFING_FILE_ENV.to_string(),
            path.to_string_lossy().into_owned(),
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

        // CF agent-inbox read path: if this session's company has an agent-inbox
        // (`agent@<domain>`), a granted MAIL connector's `list_inbox` is filtered
        // to only that address via `MAIL_TO_FILTER` — so the bot reads only its
        // own mail inside a shared mailbox. Non-secret address, resolved once.
        let agent_inbox_addr = agent_inbox_address(state, session_name).await;

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
            let mut emit: Value =
                serde_json::from_str(&connector.emit_json).unwrap_or_else(|_| json!({}));
            // Inject the agent-inbox To-filter into a MAIL connector's emit env
            // (non-secret literal). Baked here rather than at seed time because it
            // is per-session (the bot's company), not a property of the card.
            if let Some(addr) = &agent_inbox_addr {
                if crate::connectors::imap_connector::is_mail_connector(&g.connector_id) {
                    if let Some(env) = emit.get_mut("env").and_then(|e| e.as_object_mut()) {
                        env.insert("MAIL_TO_FILTER".to_string(), Value::String(addr.clone()));
                    }
                }
            }
            let secrets = resolve_secret(state, vault.as_ref(), g).await;
            // Peel FILE credentials out of the env map using the connector's schema:
            // a `file_env` field is materialized to a 0600 file at launch and its env
            // var points at the PATH — the content is never an env value.
            let (secrets, files) = split_file_credentials(&connector.credentials_json, secrets);
            resolved.push(ResolvedGrant {
                connector_id: g.connector_id.clone(),
                emit,
                secrets,
                files,
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

            // SessionStart capability briefing (fase C). Render it here (this is
            // the seam that has the pool for the company + peer roster) and write
            // it to the session's private config dir; the recall hook reads
            // `SUPERMUX_BRIEFING_FILE` and emits it ONCE at SessionStart, so it is
            // zero per-turn cost. Best-effort: a write failure just omits the env
            // var (the hook then emits no briefing) rather than failing the launch.
            let briefing = crate::agents::briefing::build(state, &session).await;
            if !briefing.is_empty() {
                let dir = state
                    .config
                    .data_dir
                    .join("session-config")
                    .join(session_name);
                let path = dir.join("briefing.md");
                match tokio::fs::create_dir_all(&dir).await {
                    Ok(()) => match tokio::fs::write(&path, &briefing).await {
                        Ok(()) => cfg.set_briefing_env(&path),
                        Err(e) => tracing::warn!(
                            session = %session_name,
                            error = %e,
                            "could not write the SessionStart briefing; skipping it"
                        ),
                    },
                    Err(e) => tracing::warn!(
                        session = %session_name,
                        error = %e,
                        "could not create the session-config dir for the briefing; skipping it"
                    ),
                }
            }
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
        if let Some(server) =
            crate::connectors::connect_server::ensure(&state.config.data_dir).await
        {
            // P2d — inject a secret-free, company-scoped catalog SNAPSHOT the bot's
            // `list_connectors` tool reads. Scope comes from the bot's OWN session
            // row: a company bot (company_id Some) resolves its company's oauth-app
            // effects; an HQ/omniscient bot (NULL) resolves the global set. This is
            // the ONLY place that knows the session AND its company, and it is under
            // `is_active()`, so a plain pane never gets a snapshot (invariant holds).
            let scope = match crate::db::sessions::get(&state.pool, session_name).await? {
                Some(s) => match s.company_id {
                    Some(c) => crate::scope::Scope::Company(c),
                    None => crate::scope::Scope::All,
                },
                None => crate::scope::Scope::All,
            };
            let snapshot = crate::connectors::connect_server::build_snapshot(state, scope).await;
            let session_dir = state
                .config
                .data_dir
                .join("session-config")
                .join(session_name);
            let snap_path =
                crate::connectors::connect_server::write_snapshot(&session_dir, &snapshot).await;
            cfg.apply_connect_affordance(crate::connectors::connect_server::emit(
                &server,
                snap_path.as_deref(),
            ));
        }
    }

    cfg.finish().await
}

/// This session's company agent-inbox address (`agent@<domain>`), if one is
/// configured — the `MAIL_TO_FILTER` value for its granted mail connectors. A
/// plain (company-less) session, or a company with no agent-inbox, yields `None`,
/// so mail launches stay byte-identical unless the owner opted in. Best-effort:
/// any read failure is `None` (never blocks a launch).
async fn agent_inbox_address(state: &AppState, session_name: &str) -> Option<String> {
    let session = crate::db::sessions::get(&state.pool, session_name).await.ok()??;
    let company_id = session.company_id?;
    let cfg = crate::external_access::store::read_or_default(&state.config.data_dir).ok()?;
    crate::external_access::store::agent_inbox_for(&cfg, company_id).map(|a| a.address.clone())
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

/// Split a decrypted vault field-map into (plain env secrets, file credentials),
/// using the connector's credential SCHEMA to identify FILE fields. A field with
/// `file_env` set whose key has a value in the map is moved OUT of the env map into
/// a [`FileCredential`] — so its raw content is never exported as an env value.
/// Every non-file field stays in the plain map, byte-identical to before.
fn split_file_credentials(
    credentials_json: &str,
    mut secrets: BTreeMap<String, String>,
) -> (BTreeMap<String, String>, Vec<FileCredential>) {
    let fields: Vec<CredentialField> = serde_json::from_str(credentials_json).unwrap_or_default();
    let mut files = Vec::new();
    for field in fields {
        let Some(env_var) = field.file_env.filter(|s| !s.is_empty()) else {
            continue;
        };
        if let Some(content) = secrets.remove(&field.key) {
            files.push(FileCredential {
                env_var,
                field_key: field.key,
                content,
            });
        }
    }
    (secrets, files)
}

/// Write one file credential's content to a 0600 file under `creds_dir`, named
/// `<connector>-<field_key>`, and return its path. The directory is created 0700
/// and the file opened 0600 from the start (no world-readable window). Inside the
/// session's own runtime dir — never a shared/world-readable location.
#[cfg(unix)]
fn materialize_cred_file(
    creds_dir: &Path,
    connector_id: &str,
    f: &FileCredential,
) -> std::io::Result<String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    std::fs::create_dir_all(creds_dir)?;
    // Lock the creds dir down so a sibling can't traverse/list it.
    std::fs::set_permissions(creds_dir, std::fs::Permissions::from_mode(0o700))?;
    let path = creds_dir.join(format!("{connector_id}-{}", f.field_key));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(f.content.as_bytes())?;
    file.sync_all()?;
    // Enforce 0600 even if the file pre-existed with other permissions.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Non-unix fallback (the server targets Linux; kept so the crate still compiles
/// elsewhere). Best-effort plain write — no mode bits available.
#[cfg(not(unix))]
fn materialize_cred_file(
    creds_dir: &Path,
    connector_id: &str,
    f: &FileCredential,
) -> std::io::Result<String> {
    std::fs::create_dir_all(creds_dir)?;
    let path = creds_dir.join(format!("{connector_id}-{}", f.field_key));
    std::fs::write(&path, f.content.as_bytes())?;
    Ok(path.to_string_lossy().into_owned())
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
            files: Vec::new(),
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

    /// Seed a mail connector card whose emit carries an `env` block (the shared
    /// IMAP server reads host/creds/filter from env).
    async fn seed_mail_card(state: &crate::state::AppState, id: &str) {
        connectors::upsert(
            &state.pool,
            id,
            "agent_authored",
            "Gmail (IMAP)",
            "",
            "",
            "[]",
            "[]",
            &json!({
                "command": "python3",
                "args": ["s.py"],
                "env": { "IMAP_HOST": "imap.gmail.com", "MAIL_ADDRESS": "${MAIL_ADDRESS}" }
            })
            .to_string(),
            "{}",
        )
        .await
        .unwrap();
    }

    /// Configure `company_id`'s agent-inbox in the companion store.
    fn seed_agent_inbox(dir: &Path, company_id: i64, address: &str) {
        let mut cfg = crate::external_access::store::read_or_default(dir).unwrap();
        crate::external_access::store::upsert_agent_inbox(
            &mut cfg,
            crate::external_access::store::AgentInbox {
                company_id,
                address: address.to_string(),
                destination: "owner@example.com".to_string(),
                verified: true,
                rule_tag: None,
            },
        );
        crate::external_access::store::write_atomic(dir, &cfg).unwrap();
    }

    /// CF agent-inbox read path: a granted MAIL connector for a company that HAS an
    /// agent-inbox gets `MAIL_TO_FILTER=<agent@domain>` baked into its launch env,
    /// so the bot's `list_inbox` shows only its own mail.
    #[tokio::test]
    async fn mail_connector_gets_agent_inbox_to_filter_when_configured() {
        let (state, dir) = browser_state().await;
        seed_mail_card(&state, "gmail-imap").await;
        crate::db::sessions::insert_minimal(&state.pool, "crm-bot", "/tmp", "claude")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = 7 WHERE name = 'crm-bot'")
            .execute(&state.pool)
            .await
            .unwrap();
        seed_agent_inbox(&dir, 7, "agent@example.com");
        connectors::grant(&state.pool, "crm-bot", "gmail-imap", None, true)
            .await
            .unwrap();

        let fin = assemble(&state, "crm-bot").await.unwrap().expect("active");
        let cfg = mcp_config_json(&fin);
        assert_eq!(
            cfg["mcpServers"]["gmail-imap"]["env"]["MAIL_TO_FILTER"],
            json!("agent@example.com"),
            "the bot's own address is injected as the To-filter"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The filter is injected ONLY when the company has an agent-inbox. No record →
    /// no `MAIL_TO_FILTER`, and a NON-mail connector is never touched even when one
    /// exists.
    #[tokio::test]
    async fn no_to_filter_without_an_agent_inbox_and_never_on_non_mail() {
        let (state, dir) = browser_state().await;
        seed_mail_card(&state, "gmail-imap").await;
        // A non-mail connector that also carries an env block.
        connectors::upsert(
            &state.pool,
            "pmcp-notion",
            "mcp_catalog",
            "Notion",
            "",
            "",
            "[]",
            "[]",
            &json!({ "command": "npx", "args": ["notion"], "env": { "X": "1" } }).to_string(),
            "{}",
        )
        .await
        .unwrap();
        crate::db::sessions::insert_minimal(&state.pool, "co-bot", "/tmp", "claude")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = 9 WHERE name = 'co-bot'")
            .execute(&state.pool)
            .await
            .unwrap();
        connectors::grant(&state.pool, "co-bot", "gmail-imap", None, true)
            .await
            .unwrap();
        connectors::grant(&state.pool, "co-bot", "pmcp-notion", None, true)
            .await
            .unwrap();

        // Company 9 has NO agent-inbox → no filter anywhere.
        let fin = assemble(&state, "co-bot").await.unwrap().expect("active");
        let cfg = mcp_config_json(&fin);
        assert!(
            cfg["mcpServers"]["gmail-imap"]["env"].get("MAIL_TO_FILTER").is_none(),
            "no agent-inbox ⇒ no To-filter on the mail connector"
        );

        // Now give company 9 an inbox: the mail connector gets the filter, the
        // non-mail connector never does.
        seed_agent_inbox(&dir, 9, "agent@example.com");
        let fin = assemble(&state, "co-bot").await.unwrap().expect("active");
        let cfg = mcp_config_json(&fin);
        assert_eq!(
            cfg["mcpServers"]["gmail-imap"]["env"]["MAIL_TO_FILTER"],
            json!("agent@example.com")
        );
        assert!(
            cfg["mcpServers"]["pmcp-notion"]["env"].get("MAIL_TO_FILTER").is_none(),
            "a non-mail connector is never given the To-filter"
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
        let acct = connectors::account_add(&state.pool, "gmail", "sander@acme.com", None, None)
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

    /// A memory bot's launch renders the SessionStart capability briefing to its
    /// private config dir and points the recall hook at it via
    /// `SUPERMUX_BRIEFING_FILE` — so the briefing is emitted ONCE at SessionStart,
    /// never per turn. A company bot's briefing names its company + peer roster.
    #[tokio::test]
    async fn a_memory_company_bot_gets_a_briefing_file_and_env() {
        let (state, dir) = browser_state().await;
        let acme = crate::db::companies::create(&state.pool, "acme", "acme", "/srv/acme")
            .await
            .unwrap()
            .id;
        // Two same-company bots so the roster is non-empty; the subject has CORE
        // memory (so `session_has_memory` is true and the recall hook is wired).
        crate::db::sessions::insert_minimal(&state.pool, "acme-a", "/tmp", "claude")
            .await
            .unwrap();
        crate::db::sessions::insert_minimal(&state.pool, "acme-b", "/tmp", "claude")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ?, memory = 'standing note' WHERE name = 'acme-a'")
            .bind(acme)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = 'acme-b'")
            .bind(acme)
            .execute(&state.pool)
            .await
            .unwrap();

        let fin = assemble(&state, "acme-a").await.unwrap().expect("active");
        let path = fin
            .env
            .get("SUPERMUX_BRIEFING_FILE")
            .expect("the recall hook is pointed at the briefing file");
        let text = std::fs::read_to_string(path).expect("briefing file written");
        assert!(text.contains("You are the supermux agent \"acme-a\" in company \"acme\"."));
        assert!(text.contains("supermux-memory save"));
        assert!(text.contains("/supermux-notify"));
        // The peer roster names the same-company peer (and not itself) + the
        // message affordance.
        assert!(text.contains("acme-b"), "peer roster names the same-company peer");
        assert!(!text.contains("teammates: acme-a"), "the roster excludes the bot itself");
        assert!(text.contains("/supermux-message"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A plain (non-bot) pane has no memory ⇒ no recall hook ⇒ no briefing, and
    /// its launch stays byte-identical (no config dir at all).
    #[tokio::test]
    async fn a_plain_pane_gets_no_briefing() {
        let (state, dir) = browser_state().await;
        crate::db::sessions::insert_minimal(&state.pool, "plain", "/tmp", "claude")
            .await
            .unwrap();
        let fin = assemble(&state, "plain").await.unwrap();
        assert!(fin.is_none(), "a plain pane stays byte-identical (no briefing)");
        assert!(
            !dir.join("session-config/plain/briefing.md").exists(),
            "no briefing file for a plain pane"
        );
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

    /// THE FILE-CREDENTIAL MECHANISM: a granted connector with a file credential
    /// materializes a 0600 file holding the EXACT content inside the session's own
    /// dir, and sets the target env var to that file's PATH — the raw content is
    /// NEVER an env value and never lands in settings.json.
    #[tokio::test]
    async fn a_file_credential_materializes_a_0600_file_and_env_points_at_it() {
        let dir = temp_dir();
        let content = r#"{"type":"service_account","private_key":"TOP-SECRET-KEY"}"#;
        let mut cfg = SessionConfig::new(&dir, "ga-bot");
        cfg.apply_connectors(&[ResolvedGrant {
            connector_id: "pmcp-google-analytics".to_string(),
            emit: json!({
                "command": "uvx",
                "args": ["analytics-mcp"],
                "env": { "GOOGLE_APPLICATION_CREDENTIALS": "${GOOGLE_APPLICATION_CREDENTIALS}" }
            }),
            secrets: BTreeMap::new(),
            files: vec![FileCredential {
                env_var: "GOOGLE_APPLICATION_CREDENTIALS".to_string(),
                field_key: "GA_SERVICE_ACCOUNT_JSON".to_string(),
                content: content.to_string(),
            }],
        }]);
        let fin = cfg.finish().await.unwrap().expect("active");

        // The env points at a file PATH inside the session's OWN dir — not content.
        let path = fin
            .env
            .get("GOOGLE_APPLICATION_CREDENTIALS")
            .expect("file env set to the path");
        assert!(
            path.ends_with("session-config/ga-bot/creds/pmcp-google-analytics-GA_SERVICE_ACCOUNT_JSON"),
            "file lives under the session dir: {path}"
        );

        // Exact content on disk.
        assert_eq!(std::fs::read_to_string(path).unwrap(), content);

        // 0600.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "credential file must be 0600");
        }

        // The raw content is NEVER an env value.
        for (k, v) in &fin.env {
            assert!(!v.contains("TOP-SECRET-KEY"), "raw content leaked into env {k}");
        }
        // …and never written into the settings.json overlay on disk.
        let text =
            std::fs::read_to_string(dir.join("session-config/ga-bot/settings.json")).unwrap();
        assert!(!text.contains("TOP-SECRET-KEY"), "content must never reach settings.json");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A NON-file connector is byte-identical: its secret stays a plain env value and
    /// NO `creds` dir is created.
    #[tokio::test]
    async fn a_non_file_connector_env_is_unchanged_and_writes_no_creds_dir() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "plainc");
        cfg.apply_connectors(&[resolved("icloud-mail", Some(("ICLOUD_APP_PW", "sekret")))]);
        let fin = cfg.finish().await.unwrap().expect("active");
        assert_eq!(fin.env.get("ICLOUD_APP_PW").map(String::as_str), Some("sekret"));
        assert!(
            !dir.join("session-config/plainc/creds").exists(),
            "no creds dir for a connector without a file credential"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `split_file_credentials` peels a `file_env` field OUT of the plain env map
    /// (so the content is never exported as env), while leaving every non-file
    /// secret in place.
    #[test]
    fn split_file_credentials_moves_only_file_fields() {
        let schema = json!([
            { "key": "GA_SERVICE_ACCOUNT_JSON", "sensitive": true, "file_env": "GOOGLE_APPLICATION_CREDENTIALS" },
            { "key": "PLAIN_TOKEN", "sensitive": true }
        ])
        .to_string();
        let mut vault_map = BTreeMap::new();
        vault_map.insert("GA_SERVICE_ACCOUNT_JSON".to_string(), "JSON-BLOB".to_string());
        vault_map.insert("PLAIN_TOKEN".to_string(), "tok".to_string());

        let (secrets, files) = split_file_credentials(&schema, vault_map);
        // The plain token remains an env secret; the file blob is peeled out.
        assert_eq!(secrets.get("PLAIN_TOKEN").map(String::as_str), Some("tok"));
        assert!(!secrets.contains_key("GA_SERVICE_ACCOUNT_JSON"), "file field removed from env map");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].env_var, "GOOGLE_APPLICATION_CREDENTIALS");
        assert_eq!(files[0].field_key, "GA_SERVICE_ACCOUNT_JSON");
        assert_eq!(files[0].content, "JSON-BLOB");
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
        let emit = crate::connectors::connect_server::emit(
            std::path::Path::new("/data/connectors/connect/server.py"),
            None,
        );
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
        // P2d: the NON-interactive discovery read is allow-listed alongside connect.
        assert!(
            allow.contains(&json!("mcp__connect__list_connectors")),
            "list_connectors tool allow-listed: {allow:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// P2d: `apply_connect_affordance` allow-lists BOTH the interactive `connect`
    /// and the non-interactive `list_connectors`, and adds each only once.
    #[tokio::test]
    async fn connect_affordance_allow_lists_both_tools() {
        let dir = temp_dir();
        let mut cfg = SessionConfig::new(&dir, "ada");
        cfg.apply_connect_affordance(crate::connectors::connect_server::emit(
            std::path::Path::new("/x/server.py"),
            Some(std::path::Path::new("/x/connect/catalog.json")),
        ));
        // Idempotent-ish: re-applying doesn't duplicate the rules.
        cfg.apply_connect_affordance(crate::connectors::connect_server::emit(
            std::path::Path::new("/x/server.py"),
            Some(std::path::Path::new("/x/connect/catalog.json")),
        ));
        let fin = cfg.finish().await.unwrap().expect("active");
        // The snapshot path rides argv[1] of the connect server.
        let v = mcp_config_json(&fin);
        assert_eq!(
            v["mcpServers"]["connect"]["args"][1],
            json!("/x/connect/catalog.json"),
            "snapshot path is args[1]"
        );
        assert!(
            v["mcpServers"]["connect"].get("env").is_none(),
            "connect still carries no env (catalog path is argv, not env)"
        );
        let text = std::fs::read_to_string(dir.join("session-config/ada/settings.json")).unwrap();
        let s: Value = serde_json::from_str(&text).unwrap();
        let allow = s["permissions"]["allow"].as_array().unwrap();
        let both = |r: &str| allow.iter().filter(|x| *x == &json!(r)).count();
        assert_eq!(both("mcp__connect__connect"), 1, "connect once: {allow:?}");
        assert_eq!(both("mcp__connect__list_connectors"), 1, "list_connectors once: {allow:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// P2d: a bot launch writes the secret-free snapshot at
    /// `session-config/<name>/connect/catalog.json` (0600), and the connect
    /// server's `args[1]` points at it.
    #[tokio::test]
    async fn assemble_writes_snapshot_only_for_a_bot() {
        let (state, dir) = browser_state().await;
        // A memory bot (no connector grants) is active → gets the connect affordance
        // + snapshot. Seed a sensitive-credential connector so the snapshot has a row
        // to project (and we can prove it stays secret-free).
        connectors::upsert(
            &state.pool,
            "pmcp-github",
            "mcp_catalog",
            "GitHub",
            "",
            "",
            "[]",
            &json!([{ "key": "GITHUB_TOKEN", "sensitive": true }]).to_string(),
            "{}",
            &json!({ "imported": true }).to_string(),
        )
        .await
        .unwrap();
        // Insert a bot session with memory so `assemble` activates.
        crate::db::sessions::insert_minimal(&state.pool, "botly", "/tmp", "claude")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET memory = 1 WHERE name = 'botly'")
            .execute(&state.pool)
            .await
            .unwrap();

        let fin = assemble(&state, "botly")
            .await
            .unwrap()
            .expect("a memory bot is active");

        // The connect server rides argv with args[1] = the snapshot path.
        let cfg = mcp_config_json(&fin);
        let snap_arg = cfg["mcpServers"]["connect"]["args"][1]
            .as_str()
            .expect("connect server carries a snapshot path");
        let snap_path = dir.join("session-config/botly/connect/catalog.json");
        assert_eq!(snap_arg, snap_path.to_string_lossy());
        assert!(snap_path.exists(), "snapshot written to disk");

        // 0600.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&snap_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "snapshot must be 0600");
        }

        // Secret-free + concierge shape.
        let raw = std::fs::read_to_string(&snap_path).unwrap();
        assert!(!raw.contains("secret_ref"), "no secret_ref in snapshot: {raw}");
        // Key-match: a help_url may legitimately contain the word "credentials".
        assert!(!raw.contains("\"credentials\""), "no credentials schema in snapshot");
        assert!(!raw.contains("GITHUB_TOKEN"), "no token field name in snapshot");
        let snap: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(snap["version"], json!(1));
        assert_eq!(snap["scope"], json!("hq"), "an HQ bot (company_id NULL) is hq-scoped");
        let gh = snap["connectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == json!("pmcp-github"))
            .expect("github projected into the snapshot");
        // Only the concierge keys — never a secret.
        for k in gh.as_object().unwrap().keys() {
            assert!(
                ["id", "name", "description", "tool_count", "auth_kind", "ease", "help_url", "help_text", "how_to"]
                    .contains(&k.as_str()),
                "unexpected snapshot key {k}"
            );
        }
        assert_eq!(gh["auth_kind"], json!("api_key"), "no oauth app → api_key");
        assert_eq!(gh["ease"], json!("key"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// P2d byte-identical invariant: a no-grant/no-memory pane gets NO snapshot,
    /// no session-config dir, and `assemble` returns `None`.
    #[tokio::test]
    async fn no_snapshot_for_a_plain_pane() {
        let (state, dir) = browser_state().await;
        crate::db::sessions::insert_minimal(&state.pool, "plainpane", "/tmp", "claude")
            .await
            .unwrap();
        let fin = assemble(&state, "plainpane").await.unwrap();
        assert!(fin.is_none(), "a plain pane stays byte-identical");
        assert!(
            !dir.join("session-config").exists(),
            "no session-config dir, so no connect/catalog.json"
        );
        assert!(!dir.join("session-config/plainpane/connect/catalog.json").exists());
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
            None,
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
