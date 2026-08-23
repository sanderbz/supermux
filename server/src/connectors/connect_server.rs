//! The `connect` MCP server — the store's one-tap credential affordance, injected
//! into every bot launch so a real agent actually HAS a `connect(service)` tool
//! in its toolset (spec §8 step 2; round-2 jury, claim 5 — the tool-exposure half).
//!
//! **What it is.** A tiny, credential-free, stdlib-only Python MCP stdio server
//! (`connect_server.py`, embedded) that serves ONE tool, `connect`, carrying the
//! [`super::REQUIRES_USER_INTERACTION_META`] marker. When a bot calls it, Claude
//! Code routes the call to the human prompt (never auto-running it) and supermux's
//! PreToolUse detector ([`crate::sessions::connect_ask`]) raises the inline
//! Connect card. The secret never travels this server — the card POSTs it straight
//! to the vault.
//!
//! **Why a whole server and not an inline descriptor.** Claude Code exposes MCP
//! tools ONLY through spawned MCP servers (a `mcpServers` command it talks to over
//! stdio); there is no inline tool-list injection. So the `connect` tool must be a
//! real process. This mirrors the agent-authored iCloud server exactly, minus the
//! credentials — it ships as one embedded file, needs no network, no pip.
//!
//! **Where it is wired.** [`crate::sessions::connector_config::assemble`] adds a
//! `connect` entry to a bot's inline `--mcp-config` (alongside any granted
//! connectors) and allow-lists `mcp__connect__connect`. A plain (non-bot) pane
//! with no grants and no memory never activates the overlay, so it never gets the
//! server — the byte-identical-launch invariant holds.

use serde_json::{json, Value};

use crate::scope::Scope;
use crate::state::AppState;

/// The embedded MCP server script (materialized to disk at launch).
pub const SERVER_PY: &str = include_str!("connect_server.py");

/// The MCP server key under which the tool is exposed. Claude names the tool
/// `mcp__<key>__connect`, so this MUST stay `connect` for the detector's
/// `mcp__connect__connect` to match ([`crate::sessions::connect_ask`]).
pub const SERVER_KEY: &str = "connect";

/// `<data_dir>/connectors/connect/server.py` — where the embedded server is
/// materialized.
pub fn server_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir
        .join("connectors")
        .join("connect")
        .join("server.py")
}

/// Idempotently write the embedded server to disk and return its absolute path.
/// Called from the launch path so the file is guaranteed present regardless of
/// boot ordering; the content is embedded (never user-supplied), so rewriting it
/// each launch just lands any shipped update. Best-effort: on a write failure it
/// returns `None` and the caller simply omits the connect affordance rather than
/// failing the whole launch.
pub async fn ensure(data_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let path = server_path(data_dir);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            tracing::warn!(error = %e, "connect: could not create server dir; omitting connect affordance");
            return None;
        }
    }
    if let Err(e) = tokio::fs::write(&path, SERVER_PY).await {
        tracing::warn!(error = %e, "connect: could not write server.py; omitting connect affordance");
        return None;
    }
    Some(path)
}

/// The `mcpServers` entry that launches the connect server via `python3`. No env,
/// no secret — the connect tool carries no credentials.
///
/// `snapshot_path`, when present, is appended as `args[1]` so the embedded server's
/// `list_connectors` tool can `json.load` the secret-free catalog snapshot (P2d).
/// It is passed as ARGV, never as `env`, so a plain pane's launch keeps `env`
/// absent and the catalog path (a non-secret) never sits in an env slot.
pub fn emit(server_path: &std::path::Path, snapshot_path: Option<&std::path::Path>) -> Value {
    let mut args: Vec<Value> = vec![Value::String(server_path.to_string_lossy().into_owned())];
    if let Some(snap) = snapshot_path {
        args.push(Value::String(snap.to_string_lossy().into_owned()));
    }
    json!({
        "command": "python3",
        "args": args,
    })
}

// ── P2d: the secret-free, company-scoped catalog snapshot ─────────────────────

/// Map an `auth_kind` onto the store's ease label (same order as the store's
/// `connectorEaseRank`, zero-setup first): `mcp_oauth`→`easiest`,
/// `oauth_device`→`one-tap`, `api_key`/`form`→`key`, else `none`.
fn ease_for(auth_kind: &str) -> &'static str {
    match auth_kind {
        "mcp_oauth" => "easiest",
        "oauth_device" => "one-tap",
        "api_key" | "form" => "key",
        _ => "none",
    }
}

/// One plain-language sign-in line for a connector. Prefers the card's own
/// `help_text` when present, else synthesizes an honest per-lane instruction.
fn how_to_for(auth_kind: &str, help_url: Option<&str>, help_text: Option<&str>) -> String {
    if let Some(t) = help_text.map(str::trim).filter(|s| !s.is_empty()) {
        return t.to_string();
    }
    match auth_kind {
        "mcp_oauth" => "Signs in the first time your bot uses it, right in the bot's terminal. Nothing to paste here.".to_string(),
        "oauth_device" => "One-tap sign-in: you'll get a short code to approve in your browser.".to_string(),
        "api_key" => match help_url {
            Some(u) => format!("Paste an API key/token — get one at {u}."),
            None => "Paste an API key/token.".to_string(),
        },
        "form" => match help_url {
            Some(u) => format!("Paste the connection details — details at {u}."),
            None => "Paste the connection details.".to_string(),
        },
        _ => "No sign-in needed — just connect it.".to_string(),
    }
}

/// Project one merged store card down to the SECRET-FREE concierge shape. ONLY the
/// nine concierge fields are copied — the card's `credentials` schema, `secret_ref`,
/// tokens, `accounts`, and `provenance` are DROPPED (they never reach this).
fn project_card(card: &Value) -> Value {
    let id = card.get("id").and_then(Value::as_str).unwrap_or("");
    let name = card
        .get("display_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(id);
    let description = card.get("description").and_then(Value::as_str).unwrap_or("");
    // A local row carries a real `tools` array; a catalog preview carries `tools:[]`
    // plus a `tool_count` parsed from its blurb. Prefer the array, fall back to the
    // count, else 0.
    let tool_count = card
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .filter(|n| *n > 0)
        .or_else(|| {
            card.get("tool_count")
                .and_then(Value::as_u64)
                .map(|n| n as usize)
        })
        .unwrap_or(0);
    let auth = card.get("auth");
    let auth_kind = auth
        .and_then(|a| a.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("none");
    let help_url = auth
        .and_then(|a| a.get("help_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let help_text = auth
        .and_then(|a| a.get("help_text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let ease = ease_for(auth_kind);
    let how_to = how_to_for(auth_kind, help_url, help_text);

    let mut o = serde_json::Map::new();
    o.insert("id".into(), json!(id));
    o.insert("name".into(), json!(name));
    o.insert("description".into(), json!(description));
    o.insert("tool_count".into(), json!(tool_count));
    o.insert("auth_kind".into(), json!(auth_kind));
    o.insert("ease".into(), json!(ease));
    if let Some(u) = help_url {
        o.insert("help_url".into(), json!(u));
    }
    if let Some(t) = help_text {
        o.insert("help_text".into(), json!(t));
    }
    o.insert("how_to".into(), json!(how_to));
    Value::Object(o)
}

/// Build the secret-free, company-scoped catalog snapshot the bot's
/// `list_connectors` tool reads. Reuses the store's EXACT data path so the bot sees
/// the same grid the human store shows — minus the network and minus every secret:
///
///   1. local rows → [`crate::connectors::api::card`] with the caller `scope`
///      (scope-correct auth: a provider-backed card flips to `oauth_device` when an
///      OAuth app is registered for that scope — the ONLY per-company rule, P2a);
///   2. the catalog mirror's RAM cache (`cached_cards`, never blocks the network);
///   3. the store's own `merge_and_filter` (a local row shadows its catalog preview);
///   4. project each merged card to the nine concierge fields ([`project_card`]).
///
/// `scope` comes from the bot's OWN session row: `Some(cid)` → [`Scope::Company`]
/// (its own company's app + global fallback), `None` → [`Scope::All`] (HQ/global).
pub async fn build_snapshot(state: &AppState, scope: Scope) -> Value {
    let oauth_apps = state.oauth_apps.load();
    let rows = crate::db::connectors::list(&state.pool)
        .await
        .unwrap_or_default();
    let local: Vec<Value> = rows
        .iter()
        .map(|c| crate::connectors::api::card(&oauth_apps, scope, c))
        .collect();
    let catalog_cards = crate::connectors::catalog::mirror().cached_cards().await;
    let merged = crate::connectors::catalog::merge_and_filter(
        local,
        catalog_cards,
        &crate::connectors::catalog::CardFilter::default(),
    );
    let connectors: Vec<Value> = merged.iter().map(project_card).collect();
    let scope_str = match scope {
        Scope::All => "hq".to_string(),
        Scope::Company(c) => format!("company:{c}"),
    };
    json!({
        "version": 1,
        "scope": scope_str,
        "connectors": connectors,
    })
}

/// Write the snapshot to `<session_dir>/connect/catalog.json` at mode 0600,
/// best-effort. On any failure returns `None` (the bot still gets `connect` +
/// `list_connectors`, the latter then returning an empty list) — never fails the
/// launch. Called ONLY for an active bot launch (see
/// [`crate::sessions::connector_config::assemble`]), so a plain pane never writes
/// one — the byte-identical-launch invariant holds.
pub async fn write_snapshot(
    session_dir: &std::path::Path,
    snapshot: &Value,
) -> Option<std::path::PathBuf> {
    let dir = session_dir.join("connect");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!(error = %e, "connect: could not create snapshot dir; omitting catalog");
        return None;
    }
    let path = dir.join("catalog.json");
    let bytes = match serde_json::to_vec_pretty(snapshot) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "connect: could not serialize snapshot; omitting catalog");
            return None;
        }
    };
    // Create the file 0600 FROM THE START (no umask-default 0644 window before a
    // later chmod) — same disk-permission posture as the vault's secret files.
    #[cfg(unix)]
    let write_res = {
        use tokio::io::AsyncWriteExt;
        let mut opts = tokio::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true).mode(0o600);
        match opts.open(&path).await {
            Ok(mut f) => f.write_all(&bytes).await,
            Err(e) => Err(e),
        }
    };
    #[cfg(not(unix))]
    let write_res = tokio::fs::write(&path, &bytes).await;
    if let Err(e) = write_res {
        tracing::warn!(error = %e, "connect: could not write snapshot; omitting catalog");
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_server_advertises_connect_and_list() {
        assert!(SERVER_PY.starts_with("#!/usr/bin/env python3"));
        // Serves the connect tool with the interaction marker, over MCP stdio.
        assert!(SERVER_PY.contains("\"name\": \"connect\""));
        assert!(SERVER_PY.contains(super::super::REQUIRES_USER_INTERACTION_META));
        assert!(SERVER_PY.contains("tools/list"));
        assert!(SERVER_PY.contains("tools/call"));
        assert!(SERVER_PY.contains("\"service\""));
        // P2d — the second, NON-interactive discovery tool.
        assert!(SERVER_PY.contains("\"name\": \"list_connectors\""));
        assert!(SERVER_PY.contains("TOOLS = [CONNECT_TOOL, LIST_TOOL]"));
    }

    #[test]
    fn emit_launches_python_with_the_server_path_and_no_secret() {
        let p = std::path::Path::new("/data/connectors/connect/server.py");
        // No snapshot → single-arg, env absent (back-compat with a no-catalog launch).
        let e = emit(p, None);
        assert_eq!(e["command"], json!("python3"));
        assert_eq!(e["args"][0], json!("/data/connectors/connect/server.py"));
        assert!(e["args"].as_array().unwrap().len() == 1, "no snapshot → one arg");
        assert!(e.get("env").is_none(), "connect carries no credentials");
    }

    #[test]
    fn emit_carries_the_snapshot_path_as_argv_not_env() {
        let p = std::path::Path::new("/data/connectors/connect/server.py");
        let snap = std::path::Path::new("/data/session-config/bot/connect/catalog.json");
        let e = emit(p, Some(snap));
        assert_eq!(e["args"][0], json!("/data/connectors/connect/server.py"));
        assert_eq!(
            e["args"][1],
            json!("/data/session-config/bot/connect/catalog.json"),
            "snapshot rides argv[1]"
        );
        assert!(
            e.get("env").is_none(),
            "the catalog path is argv, never env — connect stays env-free"
        );
    }

    #[test]
    fn ease_map_matches_the_store_rank() {
        assert_eq!(ease_for("mcp_oauth"), "easiest");
        assert_eq!(ease_for("oauth_device"), "one-tap");
        assert_eq!(ease_for("api_key"), "key");
        assert_eq!(ease_for("form"), "key");
        assert_eq!(ease_for("none"), "none");
        assert_eq!(ease_for("anything-else"), "none");
    }

    #[test]
    fn project_card_is_secret_free_and_concierge_shaped() {
        // A local-row card carrying a full credentials schema + provenance — the
        // projector must copy ONLY the nine concierge fields.
        let card = json!({
            "id": "pmcp-github",
            "display_name": "GitHub",
            "description": "Manage repos.",
            "tools": [{ "name": "a" }, { "name": "b" }],
            "credentials": [{ "key": "GITHUB_TOKEN", "sensitive": true }],
            "provenance": { "imported": true },
            "source": "local",
            "auth": {
                "kind": "api_key",
                "help_url": "https://github.com/settings/personal-access-tokens",
                "help_text": "Create a fine-grained PAT.",
                "token_field": "GITHUB_TOKEN"
            }
        });
        let p = project_card(&card);
        let keys: Vec<&str> = p.as_object().unwrap().keys().map(String::as_str).collect();
        for k in &keys {
            assert!(
                ["id", "name", "description", "tool_count", "auth_kind", "ease", "help_url", "help_text", "how_to"]
                    .contains(k),
                "leaked key {k}"
            );
        }
        assert_eq!(p["name"], json!("GitHub"));
        assert_eq!(p["tool_count"], json!(2));
        assert_eq!(p["auth_kind"], json!("api_key"));
        assert_eq!(p["ease"], json!("key"));
        // how_to prefers the card's help_text when present.
        assert_eq!(p["how_to"], json!("Create a fine-grained PAT."));
        // The token field / credentials schema never appear.
        let raw = p.to_string();
        assert!(!raw.contains("token_field"));
        assert!(!raw.contains("credentials"));
        assert!(!raw.contains("provenance"));
    }

    #[test]
    fn project_card_synthesizes_how_to_without_help_text() {
        // A catalog preview: tool_count from the count field, no help_text → synth.
        let card = json!({
            "id": "x", "display_name": "X", "description": "",
            "tools": [], "tool_count": 7,
            "auth": { "kind": "oauth_device" }
        });
        let p = project_card(&card);
        assert_eq!(p["tool_count"], json!(7));
        assert_eq!(p["ease"], json!("one-tap"));
        assert!(p["how_to"].as_str().unwrap().contains("short code"));
        assert!(p.get("help_url").is_none(), "absent help_url is omitted");
        assert!(p.get("help_text").is_none(), "absent help_text is omitted");
    }

    // ── build_snapshot: reuses the store data path, secret-free, scope-threaded ──

    async fn snap_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-connectsnap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        (AppState::new(pool, config), dir)
    }

    /// The snapshot is SECRET-FREE: seeding a sensitive-credential connector + a vault
    /// row must never surface a secret_ref / token / credentials schema; each entry
    /// carries only the concierge keys.
    #[tokio::test]
    async fn build_snapshot_is_secret_free() {
        let (state, dir) = snap_state().await;
        crate::db::connectors::upsert(
            &state.pool,
            "icloud-mail",
            "mcp_catalog",
            "iCloud Mail",
            "",
            "IMAP for iCloud",
            "[]",
            &json!([
                { "key": "ICLOUD_EMAIL", "sensitive": false, "identity": true },
                { "key": "ICLOUD_APP_PW", "sensitive": true }
            ])
            .to_string(),
            "{}",
            "{}",
        )
        .await
        .unwrap();
        // A vault row exists for this connector (the builder must never read it).
        let vault = crate::vault::Vault::open(&state.config.data_dir).unwrap();
        let mut fields = std::collections::BTreeMap::new();
        fields.insert("ICLOUD_APP_PW".to_string(), "super-secret-pw".to_string());
        let sealed = vault.seal(&fields).unwrap();
        crate::db::connectors::vault_put(
            &state.pool,
            "sref-1",
            "icloud-mail",
            &sealed.fields_enc,
            &sealed.nonce,
            false,
        )
        .await
        .unwrap();

        let snap = build_snapshot(&state, Scope::All).await;
        let raw = serde_json::to_string(&snap).unwrap();
        assert!(!raw.contains("secret_ref"), "no secret_ref: {raw}");
        assert!(!raw.contains("sref-1"));
        assert!(!raw.contains("super-secret-pw"), "no secret VALUE");
        // The credentials SCHEMA key must never appear (a benign help_url may still
        // contain the word "credentials", so key-match, not substring-match).
        assert!(!raw.contains("\"credentials\""), "no credentials schema");
        assert!(!raw.contains("ICLOUD_APP_PW"), "no secret field name");

        let entry = snap["connectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == json!("icloud-mail"))
            .expect("the local connector is projected");
        // identity + secret → form / key.
        assert_eq!(entry["auth_kind"], json!("form"));
        assert_eq!(entry["ease"], json!("key"));
        for k in entry.as_object().unwrap().keys() {
            assert!(
                ["id", "name", "description", "tool_count", "auth_kind", "ease", "help_url", "help_text", "how_to"]
                    .contains(&k.as_str()),
                "leaked key {k}"
            );
        }
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// COMPANY SCOPING (no new rule): a company-scoped github OAuth app makes the
    /// company bot's snapshot show pmcp-github as oauth_device/one-tap, while the HQ
    /// snapshot (no global app) shows api_key/key — the two snapshots differ, proving
    /// scope is threaded through the existing `derive_auth` rule (P2a).
    #[tokio::test]
    async fn hq_and_company_snapshots_differ_by_scope() {
        let (state, dir) = snap_state().await;
        crate::db::connectors::upsert(
            &state.pool,
            "pmcp-github",
            "mcp_catalog",
            "GitHub",
            "",
            "",
            "[]",
            "[]",
            "{}",
            &json!({ "imported": true }).to_string(),
        )
        .await
        .unwrap();
        // ONLY a company-7 github app (no global app).
        state.oauth_apps.store(std::sync::Arc::new(vec![
            crate::external_access::store::OauthApp {
                provider: "github".into(),
                company_id: Some(7),
                client_id: "gh-c7".into(),
                scopes: vec!["repo".into()],
            },
        ]));

        let gh_of = |snap: &Value| -> Value {
            snap["connectors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == json!("pmcp-github"))
                .cloned()
                .expect("github in snapshot")
        };

        let company = build_snapshot(&state, Scope::Company(7)).await;
        assert_eq!(company["scope"], json!("company:7"));
        let gh_c = gh_of(&company);
        assert_eq!(gh_c["auth_kind"], json!("oauth_device"), "company app → device sign-in");
        assert_eq!(gh_c["ease"], json!("one-tap"));

        let hq = build_snapshot(&state, Scope::All).await;
        assert_eq!(hq["scope"], json!("hq"));
        let gh_hq = gh_of(&hq);
        assert_eq!(gh_hq["auth_kind"], json!("api_key"), "no global app → api_key paste");
        assert_eq!(gh_hq["ease"], json!("key"));

        assert_ne!(gh_c["auth_kind"], gh_hq["auth_kind"], "scope changed the snapshot");
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// FUNCTIONAL: spawn the real server binary and drive it over MCP stdio the way
    /// Claude Code does — `initialize`, then `tools/list`, then `tools/call` — and
    /// assert it advertises a `connect(service)` tool carrying the
    /// `requiresUserInteraction` marker (round-2 claim 5: prove the tool is really
    /// exposed by a live process, not a hand-written payload). Skipped when
    /// `python3` is absent so it never breaks a minimal CI image.
    #[test]
    fn live_server_advertises_connect_with_the_interaction_marker() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};

        if Command::new("python3").arg("--version").output().is_err() {
            eprintln!("python3 not available — skipping live connect-server test");
            return;
        }

        let dir = std::env::temp_dir().join(format!("supermux-connect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("server.py");
        std::fs::write(&script, SERVER_PY).unwrap();

        let mut child = Command::new("python3")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn connect server");
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());

        let mut roundtrip = |req: Value| -> Value {
            stdin.write_all((req.to_string() + "\n").as_bytes()).unwrap();
            stdin.flush().unwrap();
            let mut line = String::new();
            out.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };

        // initialize
        let init = roundtrip(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" }
        }));
        assert_eq!(init["result"]["serverInfo"]["name"], json!("connect"));

        // tools/list — the connect tool with the interaction marker.
        let list = roundtrip(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let tools = list["result"]["tools"].as_array().unwrap();
        let connect = tools
            .iter()
            .find(|t| t["name"] == json!("connect"))
            .expect("connect tool advertised");
        assert_eq!(
            connect["_meta"][super::super::REQUIRES_USER_INTERACTION_META],
            json!(true),
            "connect tool carries the requiresUserInteraction marker"
        );
        assert_eq!(connect["inputSchema"]["required"][0], json!("service"));

        // P2d — list_connectors is advertised too, and WITHOUT the interaction marker.
        let listc = tools
            .iter()
            .find(|t| t["name"] == json!("list_connectors"))
            .expect("list_connectors tool advertised");
        assert!(
            listc.get("_meta").is_none(),
            "list_connectors is a plain read — NO interaction marker"
        );

        // tools/call — returns a text result naming the service, no secret.
        let call = roundtrip(json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "connect", "arguments": { "service": "pmcp-notion" } }
        }));
        let text = call["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("pmcp-notion"), "names the requested service: {text}");

        // P2d — no snapshot was passed (no argv[1]) → list_connectors degrades to an
        // empty list with a note, never crashing the loop.
        let empty = roundtrip(json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "list_connectors", "arguments": {} }
        }));
        let etext = empty["result"]["content"][0]["text"].as_str().unwrap();
        let ev: Value = serde_json::from_str(etext).unwrap();
        assert_eq!(ev["connectors"], json!([]), "no snapshot → empty list: {etext}");
        assert!(ev.get("note").is_some(), "carries the no-catalog note");

        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// FUNCTIONAL (P2d): spawn the server WITH a snapshot argv[1] and drive
    /// `tools/call list_connectors` — it returns the injected `connectors` array in
    /// the concierge shape (id/name/how_to present) and carries no secret.
    #[test]
    fn live_list_connectors_returns_the_injected_snapshot() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};

        if Command::new("python3").arg("--version").output().is_err() {
            eprintln!("python3 not available — skipping live list_connectors test");
            return;
        }

        let dir = std::env::temp_dir().join(format!("supermux-connectl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("server.py");
        std::fs::write(&script, SERVER_PY).unwrap();
        // A secret-free snapshot, exactly the shape write_snapshot produces.
        let catalog = dir.join("catalog.json");
        std::fs::write(
            &catalog,
            serde_json::to_vec_pretty(&json!({
                "version": 1,
                "scope": "hq",
                "connectors": [
                    {
                        "id": "pmcp-github", "name": "GitHub", "description": "Manage repos.",
                        "tool_count": 26, "auth_kind": "api_key", "ease": "key",
                        "help_url": "https://github.com/settings/personal-access-tokens",
                        "how_to": "Paste an API key/token — get one at the link."
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let mut child = Command::new("python3")
            .arg(&script)
            .arg(&catalog)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn connect server with a snapshot");
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut roundtrip = |req: Value| -> Value {
            stdin.write_all((req.to_string() + "\n").as_bytes()).unwrap();
            stdin.flush().unwrap();
            let mut line = String::new();
            out.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };

        let _ = roundtrip(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" }
        }));
        let call = roundtrip(json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "list_connectors", "arguments": {} }
        }));
        let text = call["result"]["content"][0]["text"].as_str().unwrap();
        let v: Value = serde_json::from_str(text).unwrap();
        let list = v["connectors"].as_array().expect("connectors array");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], json!("pmcp-github"));
        assert_eq!(list[0]["auth_kind"], json!("api_key"));
        assert!(list[0]["how_to"].as_str().unwrap().contains("Paste"));
        // Never leaks a secret plane.
        assert!(!text.contains("secret_ref"), "no secret in list output: {text}");
        assert!(!text.contains("credentials"));

        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(&dir).ok();
    }
}
