//! **Shared Browser — the connector.** Phase 3's store card + the embedded MCP
//! server that gives a granted agent real browser tools.
//!
//! This is the *store-facing* half of the shared browser: the `shared-browser`
//! connector row (kind [`KIND_BUILTIN_BROWSER`], so the store renders it as a
//! **Built-in** card), and the tiny stdlib-only Python MCP stdio server
//! ([`SERVER_PY`], embedded) that a granted bot launches. It mirrors
//! [`crate::connectors::connect_server`] exactly — one embedded file,
//! materialized at launch, wired into the bot's inline `--mcp-config` — and
//! [`crate::connectors::icloud`] for the boot-time [`seed`].
//!
//! **The server drives nothing.** Every acting tool in [`SERVER_PY`] forwards to
//! [`super::tools`]'s local endpoint, which drives [`super::BrowserService`]
//! through the [`super::lock::DriveLock`]. That indirection is the whole point:
//! the lock gates the ONLY path to the page, so a human takeover really does
//! pause the agent's browser actions rather than merely asking it to stop.
//!
//! **Credential-free, session-scoped.** The connector declares no credentials —
//! there is nothing to vault. Scoping is the pane's own per-session
//! `$SUPERMUX_HOOK_TOKEN` (the same secret the status/board/scheduler hooks use):
//! bot A's token authenticates only bot A, so bot A cannot drive bot B's context.
//! The dashboard bearer token is never handed to an agent.

use serde_json::{json, Value};

use crate::db::connectors;
use crate::state::AppState;

use super::super::manifest::{AuthDescriptor, AuthKind, Manifest, ToolDecl, KIND_BUILTIN_BROWSER};

/// The connector id / store slug (spec: `kind = builtin_browser`).
pub const BROWSER_ID: &str = "shared-browser";

/// The MCP server key a granted bot's `--mcp-config` uses. Claude names the
/// tools `mcp__<key>__<tool>`, so this is what the allow-rule
/// (`mcp__browser__*`) and the takeover detector's tool-name match key on. It is
/// deliberately NOT the connector id: `shared-browser` carries a hyphen, and the
/// tool names read better without it.
pub const SERVER_KEY: &str = "browser";

/// The `permissions.allow` glob that auto-approves this connector's tools.
pub const ALLOW_RULE: &str = "mcp__browser__*";

/// The tool an agent calls to hand the wheel to a human. Carries the
/// `requiresUserInteraction` marker, so Claude routes it to the human prompt and
/// [`crate::sessions::takeover_ask`] raises the in-chat card.
pub const TAKEOVER_TOOL: &str = "request_human_takeover";

/// The embedded MCP server script (materialized to disk at launch/boot).
pub const SERVER_PY: &str = include_str!("mcp_server.py");

/// A browser-window glass icon (data-URI SVG) for the store card. Theme-neutral
/// stroke, same posture as the iCloud card's envelope.
const ICON: &str = "data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' \
stroke='%230284c7' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>\
<rect x='2.5' y='4' width='19' height='16' rx='2.5'/><path d='M2.5 9h19'/>\
<circle cx='6' cy='6.5' r='.7' fill='%230284c7' stroke='none'/>\
<circle cx='8.6' cy='6.5' r='.7' fill='%230284c7' stroke='none'/>\
<path d='M8 13.5h8M8 16.5h5'/></svg>";

/// The five tools the server exposes (the card's tool list + count).
pub fn tool_decls() -> Vec<ToolDecl> {
    vec![
        ToolDecl {
            name: "browser_navigate".into(),
            description: "Open a URL in the shared browser and wait for it to load.".into(),
        },
        ToolDecl {
            name: "browser_click".into(),
            description: "Click an element (CSS selector) or viewport coordinates.".into(),
        },
        ToolDecl {
            name: "browser_read".into(),
            description: "Read the page — visible text or HTML, whole page or one element.".into(),
        },
        ToolDecl {
            name: "browser_screenshot".into(),
            description: "See the viewport as an image.".into(),
        },
        ToolDecl {
            name: TAKEOVER_TOOL.into(),
            description:
                "Ask the human to take the wheel (login, 2FA, CAPTCHA) and wait for the hand-back."
                    .into(),
        },
    ]
}

/// `<data_dir>/connectors/shared-browser/server.py` — where the embedded server
/// is materialized.
pub fn server_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir
        .join("connectors")
        .join(BROWSER_ID)
        .join("server.py")
}

/// Idempotently write the embedded server to disk and return its absolute path.
/// Best-effort: on a write failure it returns `None` and the caller omits the
/// connector rather than failing the whole launch (same posture as
/// [`crate::connectors::connect_server::ensure`]).
pub async fn ensure(data_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let path = server_path(data_dir);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            tracing::warn!(error = %e, "shared-browser: could not create server dir; omitting the connector");
            return None;
        }
    }
    if let Err(e) = tokio::fs::write(&path, SERVER_PY).await {
        tracing::warn!(error = %e, "shared-browser: could not write server.py; omitting the connector");
        return None;
    }
    Some(path)
}

/// The `mcpServers` entry that launches the browser server via `python3`.
///
/// The env carries NO secret value — only `${VAR}` references the host expands
/// from the pane environment at launch: the session name and its per-session
/// hook token (already exported by `sessions::lifecycle::build_env`) plus the
/// callback URL. That is exactly how the pane's own hook curls authenticate, and
/// it is what scopes the tools to ONE session.
pub fn emit(server_path: &std::path::Path) -> Value {
    json!({
        "command": "python3",
        "args": [server_path.to_string_lossy()],
        "env": {
            "SUPERMUX_URL": "${SUPERMUX_URL}",
            "SUPERMUX_SESSION": "${SUPERMUX_SESSION}",
            "SUPERMUX_HOOK_TOKEN": "${SUPERMUX_HOOK_TOKEN}",
        }
    })
}

/// The store manifest for the Shared Browser card.
pub fn manifest(server_path: &str) -> Manifest {
    Manifest {
        id: BROWSER_ID.into(),
        kind: KIND_BUILTIN_BROWSER.into(),
        display_name: "Shared Browser".into(),
        icon: ICON.into(),
        description: "One real Chrome, shared between you and your agents. A granted bot browses \
            in its own isolated context — cookies and logins survive between turns — and when it \
            hits a login, a 2FA prompt or a CAPTCHA it asks you to take the wheel: the live page \
            opens on your phone, you finish the step, and the agent picks up where you left it. \
            No credentials to store; nothing to sign in to."
            .into(),
        tools: tool_decls(),
        credentials: Vec::new(),
        // Lane E: nothing to sign in to (the takeover handles per-site logins live).
        auth: AuthDescriptor { kind: AuthKind::None, ..Default::default() },
        emit: emit(std::path::Path::new(server_path)),
        categories: vec!["browser".into()],
    }
}

/// Boot-time seed (idempotent): write the embedded MCP server to disk and upsert
/// the connector row so the store lists a **Shared Browser** card, grantable
/// per-agent through the ordinary grant path. Called once from `main` after the
/// pool is up. Best-effort — a failure is logged, never fatal.
///
/// Seeding the row does NOT start a browser: chrome is spawned lazily on the
/// first `context_for` call, which only a GRANTED session's tool call reaches.
pub async fn seed(state: &AppState) {
    let Some(path) = ensure(&state.config.data_dir).await else {
        return;
    };
    let manifest = manifest(&path.to_string_lossy());
    let cols = manifest.to_columns();
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
        &serde_json::to_string(&json!({ "builtin": true, "browser": true, "categories": manifest.categories }))
            .unwrap_or_else(|_| "{}".into()),
    )
    .await
    {
        tracing::warn!(error = %e, "shared-browser: manifest upsert failed");
        return;
    }
    tracing::info!(connector = BROWSER_ID, "seeded the built-in Shared Browser connector");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_a_credential_free_builtin_browser_card() {
        let m = manifest("/data/connectors/shared-browser/server.py");
        assert_eq!(m.id, BROWSER_ID);
        assert_eq!(m.kind, KIND_BUILTIN_BROWSER);
        assert_eq!(m.display_name, "Shared Browser");
        assert_eq!(m.categories, vec!["browser".to_string()], "shows under the Browser chip");
        assert_eq!(m.tools.len(), 5, "five tools on the card");
        let names: Vec<&str> = m.tools.iter().map(|t| t.name.as_str()).collect();
        for want in [
            "browser_navigate",
            "browser_click",
            "browser_read",
            "browser_screenshot",
            TAKEOVER_TOOL,
        ] {
            assert!(names.contains(&want), "card declares {want}");
        }
        // Nothing to vault: the connector is credential-free by construction.
        assert!(m.credentials.is_empty(), "no credential fields");
        m.validate().unwrap();
    }

    #[test]
    fn emit_launches_python_with_placeholder_env_and_no_secret_value() {
        let e = emit(std::path::Path::new("/data/connectors/shared-browser/server.py"));
        assert_eq!(e["command"], json!("python3"));
        assert_eq!(e["args"][0], json!("/data/connectors/shared-browser/server.py"));
        // Only `${VAR}` references — never a resolved token.
        assert_eq!(e["env"]["SUPERMUX_HOOK_TOKEN"], json!("${SUPERMUX_HOOK_TOKEN}"));
        assert_eq!(e["env"]["SUPERMUX_SESSION"], json!("${SUPERMUX_SESSION}"));
        assert_eq!(e["env"]["SUPERMUX_URL"], json!("${SUPERMUX_URL}"));
        let s = serde_json::to_string(&e).unwrap();
        assert!(!s.contains("Bearer"), "the dashboard bearer never reaches an agent");
    }

    #[test]
    fn embedded_server_is_a_stdlib_only_python_mcp_stdio_server() {
        assert!(SERVER_PY.starts_with("#!/usr/bin/env python3"));
        assert!(SERVER_PY.contains("tools/list"));
        assert!(SERVER_PY.contains("tools/call"));
        for t in [
            "browser_navigate",
            "browser_click",
            "browser_read",
            "browser_screenshot",
            TAKEOVER_TOOL,
        ] {
            assert!(SERVER_PY.contains(t), "server serves {t}");
        }
        // The takeover tool carries the human-in-the-loop marker, like connect.
        assert!(SERVER_PY.contains(crate::connectors::REQUIRES_USER_INTERACTION_META));
        // It forwards to the lock-gated endpoint; it never speaks CDP itself.
        assert!(SERVER_PY.contains("/api/hook/browser/tool"));
        assert!(!SERVER_PY.contains("websocket"), "no direct CDP transport");
        // Stdlib only — no pip, no vendored client.
        assert!(!SERVER_PY.contains("import requests"));
        assert!(SERVER_PY.contains("import urllib.request"));
    }

    /// FUNCTIONAL: spawn the real server and drive it over MCP stdio the way
    /// Claude Code does — `initialize`, `tools/list` — and assert the five tools
    /// are really advertised by a live process, with the interaction marker on
    /// the takeover tool. Skipped when `python3` is absent.
    #[test]
    fn live_server_advertises_the_five_tools_with_the_takeover_marker() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};

        if Command::new("python3").arg("--version").output().is_err() {
            eprintln!("python3 not available — skipping live browser-server test");
            return;
        }
        let dir = std::env::temp_dir().join(format!("supermux-browser-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("server.py");
        std::fs::write(&script, SERVER_PY).unwrap();

        let mut child = Command::new("python3")
            .arg(&script)
            // The test host may itself BE a supermux pane. Strip the wiring so
            // the probe can never post a real tool call at a live server.
            .env_remove("SUPERMUX_SESSION")
            .env_remove("SUPERMUX_HOOK_TOKEN")
            .env_remove("SUPERMUX_URL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn browser mcp server");
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut roundtrip = |req: Value| -> Value {
            stdin.write_all((req.to_string() + "\n").as_bytes()).unwrap();
            stdin.flush().unwrap();
            let mut line = String::new();
            out.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };

        let init = roundtrip(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" }
        }));
        assert_eq!(init["result"]["serverInfo"]["name"], json!("browser"));

        let list = roundtrip(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
        let takeover = tools
            .iter()
            .find(|t| t["name"] == json!(TAKEOVER_TOOL))
            .expect("takeover tool advertised");
        assert_eq!(
            takeover["_meta"][crate::connectors::REQUIRES_USER_INTERACTION_META],
            json!(true),
            "the takeover tool always reaches the human"
        );
        assert_eq!(takeover["inputSchema"]["required"][0], json!("reason"));

        // A tool call with NO supermux env is a readable refusal, not a crash.
        let call = roundtrip(json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "browser_read", "arguments": {} }
        }));
        let text = call["result"]["content"][0]["text"].as_str().unwrap_or_default();
        assert!(!text.is_empty(), "an unwired session still gets an answer: {text}");

        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(&dir).ok();
    }
}
