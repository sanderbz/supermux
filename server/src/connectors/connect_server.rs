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
pub fn emit(server_path: &std::path::Path) -> Value {
    json!({
        "command": "python3",
        "args": [server_path.to_string_lossy()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_server_is_a_python_mcp_stdio_server() {
        assert!(SERVER_PY.starts_with("#!/usr/bin/env python3"));
        // Serves the connect tool with the interaction marker, over MCP stdio.
        assert!(SERVER_PY.contains("\"name\": \"connect\""));
        assert!(SERVER_PY.contains(super::super::REQUIRES_USER_INTERACTION_META));
        assert!(SERVER_PY.contains("tools/list"));
        assert!(SERVER_PY.contains("tools/call"));
        assert!(SERVER_PY.contains("\"service\""));
    }

    #[test]
    fn emit_launches_python_with_the_server_path_and_no_secret() {
        let p = std::path::Path::new("/data/connectors/connect/server.py");
        let e = emit(p);
        assert_eq!(e["command"], json!("python3"));
        assert_eq!(e["args"][0], json!("/data/connectors/connect/server.py"));
        assert!(e.get("env").is_none(), "connect carries no credentials");
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

        // tools/call — returns a text result naming the service, no secret.
        let call = roundtrip(json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "connect", "arguments": { "service": "pmcp-notion" } }
        }));
        let text = call["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("pmcp-notion"), "names the requested service: {text}");

        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(&dir).ok();
    }
}
