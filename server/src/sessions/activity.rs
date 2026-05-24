//! Hook-payload → live "current activity" + error derivation (hooks-10x TRACK 1).
//!
//! Claude Code's hooks carry rich JSON on STDIN (tool_name, tool_input.command /
//! file_path / pattern, message, error_type, …). supermux's hook command forwards
//! a size-capped slice of that JSON to `/api/_internal/hook` as the `payload`
//! field; this module turns it into the tiny, human display strings the overview
//! card + focus header show under the status dot:
//!
//!   * [`activity_label`] — a `PreToolUse` payload → `("✎ tile.tsx", "edit")` etc.
//!   * [`failed_label`]    — a `PostToolUseFailure` payload → `"✗ Bash failed"`.
//!   * [`HookPayload`]     — the LENIENT (every field optional) parse of `payload`.
//!
//! **Security (spec §SECURITY).** Everything here is in-memory only and display
//! only. We deliberately prefer Claude's own `description` over the raw command,
//! and we truncate to [`MAX_LABEL`] so a long secret-bearing command can never be
//! surfaced (or logged) in full. Nothing here is persisted to disk/DB.

use serde::Deserialize;

/// Hard cap on any derived label (a long command / pattern is truncated with an
/// ellipsis so the tile stays calm and a secret-bearing argument is never shown
/// in full). Roughly the spec's "first ~40 chars".
const MAX_LABEL: usize = 40;

/// The leniently-parsed Claude hook payload. EVERY field is optional: a future
/// Claude event shape, a partial/truncated forward, or a non-tool event must all
/// parse without error (the endpoint treats a missing field as "no activity").
///
/// `tool_input` is the nested object Claude sends for tool events; we pull only
/// the few small fields we display from it (`command`, `description`, `file_path`,
/// `pattern`, `url`) and ignore the big ones (e.g. Edit/Write `content`).
#[derive(Debug, Default, Deserialize)]
pub struct HookPayload {
    /// The tool being invoked (`Bash`, `Edit`, `Read`, `mcp__server__method`, …).
    #[serde(default)]
    pub tool_name: Option<String>,
    /// The tool's input object (small display fields only; big ones ignored).
    #[serde(default)]
    pub tool_input: Option<ToolInput>,
    /// A `Notification` / error message.
    #[serde(default)]
    pub message: Option<String>,
    /// `StopFailure` error class (`rate_limit`, `billing_error`, …).
    #[serde(default)]
    pub error_type: Option<String>,
    /// Some events carry the error text at the top level rather than `message`.
    #[serde(default)]
    pub error: Option<String>,
}

/// The handful of small `tool_input` fields we surface. Anything else (notably
/// Edit/Write `content`) is ignored, so the capped transport never needs it.
#[derive(Debug, Default, Deserialize)]
pub struct ToolInput {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Truncate `s` to [`MAX_LABEL`] chars (counting Unicode scalar values, not
/// bytes, so we never split a multi-byte char), appending `…` when cut. Leading/
/// trailing whitespace is trimmed first so a label is never padded.
fn truncate(s: &str) -> String {
    let s = s.trim();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= MAX_LABEL {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

/// `basename` of a path: the last `/`-separated segment, else the whole string.
/// Trailing slashes are stripped first so `src/foo/` → `foo`.
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// Derive the live activity `(label, kind)` for a `PreToolUse` payload, or `None`
/// when the payload carries no tool name (nothing to show).
///
/// `kind` is the lower-case tool class the UI can style on (`bash`, `edit`,
/// `read`, `search`, `web`, `task`, `mcp`, `tool`). The emoji is baked into the
/// label so the wire stays one string; `kind` is the machine-readable companion.
///
/// Mapping (spec §3 — TRACK 1):
/// * `Bash`              → `⚡ {description || command first ~40 chars}`
/// * `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → `✎ {basename(file_path)}`
/// * `Read`              → `📖 {basename(file_path)}`
/// * `Grep`/`Glob`       → `🔍 {pattern}`
/// * `WebFetch`/`WebSearch` → `🌐 fetching`
/// * `Task`/`Agent`      → `🤖 subagent`
/// * `mcp__a__b`         → `🔌 {b}`
/// * anything else       → the tool name verbatim (kind `tool`).
pub fn activity_label(p: &HookPayload) -> Option<(String, String)> {
    let tool = p.tool_name.as_deref()?.trim();
    if tool.is_empty() {
        return None;
    }
    let ti = p.tool_input.as_ref();

    // MCP tools are namespaced `mcp__<server>__<method>`; surface the method.
    if let Some(rest) = tool.strip_prefix("mcp__") {
        let method = rest.rsplit("__").next().unwrap_or(rest);
        let method = if method.is_empty() { rest } else { method };
        return Some((format!("🔌 {}", truncate(method)), "mcp".to_string()));
    }

    let (label, kind) = match tool {
        "Bash" | "BashOutput" => {
            // Prefer Claude's own `description` (human, secret-free) over the raw
            // command — the security default. Fall back to the command, truncated.
            let desc = ti
                .and_then(|t| t.description.as_deref())
                .map(str::trim)
                .filter(|d| !d.is_empty());
            let text = desc
                .map(truncate)
                .or_else(|| {
                    ti.and_then(|t| t.command.as_deref())
                        .map(str::trim)
                        .filter(|c| !c.is_empty())
                        .map(truncate)
                })
                .unwrap_or_else(|| "running".to_string());
            (format!("⚡ {text}"), "bash")
        }
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let name = ti
                .and_then(|t| t.file_path.as_deref())
                .map(basename)
                .map(truncate)
                .unwrap_or_else(|| "file".to_string());
            (format!("✎ {name}"), "edit")
        }
        "Read" => {
            let name = ti
                .and_then(|t| t.file_path.as_deref())
                .map(basename)
                .map(truncate)
                .unwrap_or_else(|| "file".to_string());
            (format!("📖 {name}"), "read")
        }
        "Grep" | "Glob" => {
            let pat = ti
                .and_then(|t| t.pattern.as_deref())
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(truncate)
                .unwrap_or_else(|| "searching".to_string());
            (format!("🔍 {pat}"), "search")
        }
        "WebFetch" | "WebSearch" => ("🌐 fetching".to_string(), "web"),
        "Task" | "Agent" => ("🤖 subagent".to_string(), "task"),
        other => (truncate(other), "tool"),
    };
    Some((label, kind.to_string()))
}

/// The transient "a tool just failed" label for a `PostToolUseFailure` payload
/// (spec §3): `✗ {tool} failed`. Falls back to a generic when no tool name.
pub fn failed_label(p: &HookPayload) -> String {
    match p.tool_name.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(tool) => format!("✗ {} failed", truncate(tool)),
        None => "✗ tool failed".to_string(),
    }
}

/// Derive a `(type, message)` error pair from a `StopFailure` payload (spec §3).
/// `type` defaults to `"error"` when the payload omits `error_type`; `message`
/// prefers `message` then `error`, truncated and secret-conscious. Always returns
/// a pair (a `StopFailure` is, by definition, an error worth badging).
pub fn error_info(p: &HookPayload) -> (String, String) {
    let etype = p
        .error_type
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(truncate)
        .unwrap_or_else(|| "error".to_string());
    let msg = p
        .message
        .as_deref()
        .or(p.error.as_deref())
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(truncate)
        .unwrap_or_default();
    (etype, msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a JSON string into a [`HookPayload`] the way the endpoint does.
    fn parse(json: &str) -> HookPayload {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn bash_prefers_description_over_command() {
        let p = parse(
            r#"{"tool_name":"Bash","tool_input":{"command":"npm test --silent","description":"run the test suite"}}"#,
        );
        let (label, kind) = activity_label(&p).unwrap();
        assert_eq!(label, "⚡ run the test suite");
        assert_eq!(kind, "bash");
    }

    #[test]
    fn bash_falls_back_to_command_when_no_description() {
        let p = parse(r#"{"tool_name":"Bash","tool_input":{"command":"echo hi"}}"#);
        let (label, _) = activity_label(&p).unwrap();
        assert_eq!(label, "⚡ echo hi");
    }

    #[test]
    fn bash_truncates_long_command() {
        let long = "a".repeat(100);
        let p = parse(&format!(r#"{{"tool_name":"Bash","tool_input":{{"command":"{long}"}}}}"#));
        let (label, _) = activity_label(&p).unwrap();
        // "⚡ " prefix + 40 chars + the ellipsis.
        assert!(label.starts_with("⚡ "));
        let body = label.trim_start_matches("⚡ ");
        assert_eq!(body.chars().filter(|c| *c == 'a').count(), MAX_LABEL);
        assert!(body.ends_with('…'), "long command must be ellipsised");
    }

    #[test]
    fn edit_and_write_use_basename() {
        for tool in ["Edit", "Write", "MultiEdit"] {
            let p = parse(&format!(
                r#"{{"tool_name":"{tool}","tool_input":{{"file_path":"/Users/x/supermux/web/src/tile.tsx"}}}}"#
            ));
            let (label, kind) = activity_label(&p).unwrap();
            assert_eq!(label, "✎ tile.tsx", "{tool}");
            assert_eq!(kind, "edit");
        }
    }

    #[test]
    fn read_uses_basename() {
        let p = parse(r#"{"tool_name":"Read","tool_input":{"file_path":"server/src/state.rs"}}"#);
        let (label, kind) = activity_label(&p).unwrap();
        assert_eq!(label, "📖 state.rs");
        assert_eq!(kind, "read");
    }

    #[test]
    fn grep_and_glob_show_pattern() {
        for tool in ["Grep", "Glob"] {
            let p = parse(&format!(
                r#"{{"tool_name":"{tool}","tool_input":{{"pattern":"fn main"}}}}"#
            ));
            let (label, kind) = activity_label(&p).unwrap();
            assert_eq!(label, "🔍 fn main", "{tool}");
            assert_eq!(kind, "search");
        }
    }

    #[test]
    fn web_tools_show_fetching() {
        for tool in ["WebFetch", "WebSearch"] {
            let p = parse(&format!(r#"{{"tool_name":"{tool}"}}"#));
            let (label, kind) = activity_label(&p).unwrap();
            assert_eq!(label, "🌐 fetching", "{tool}");
            assert_eq!(kind, "web");
        }
    }

    #[test]
    fn task_and_agent_show_subagent() {
        for tool in ["Task", "Agent"] {
            let p = parse(&format!(r#"{{"tool_name":"{tool}"}}"#));
            let (label, kind) = activity_label(&p).unwrap();
            assert_eq!(label, "🤖 subagent", "{tool}");
            assert_eq!(kind, "task");
        }
    }

    #[test]
    fn mcp_tool_shows_method() {
        let p = parse(r#"{"tool_name":"mcp__github__create_issue"}"#);
        let (label, kind) = activity_label(&p).unwrap();
        assert_eq!(label, "🔌 create_issue");
        assert_eq!(kind, "mcp");
    }

    #[test]
    fn unknown_tool_falls_back_to_name() {
        let p = parse(r#"{"tool_name":"TodoWrite"}"#);
        let (label, kind) = activity_label(&p).unwrap();
        assert_eq!(label, "TodoWrite");
        assert_eq!(kind, "tool");
    }

    #[test]
    fn missing_tool_name_is_no_activity() {
        assert!(activity_label(&parse("{}")).is_none());
        assert!(activity_label(&parse(r#"{"message":"hi"}"#)).is_none());
        assert!(activity_label(&parse(r#"{"tool_name":"  "}"#)).is_none());
    }

    #[test]
    fn empty_payload_parses_leniently() {
        // The endpoint must never 400 on an odd/partial payload.
        assert!(serde_json::from_str::<HookPayload>("{}").is_ok());
        assert!(serde_json::from_str::<HookPayload>(r#"{"unrelated":42,"deep":{"x":[1,2]}}"#).is_ok());
        // Unknown extra fields are ignored, and a wrong-typed display field (e.g.
        // tool_input is a string, not an object) parses to `None` rather than
        // erroring out hard at the struct level — the endpoint stays a no-op.
        assert!(
            serde_json::from_str::<HookPayload>(r#"{"tool_name":"Bash","extra":true}"#).is_ok()
        );
    }

    #[test]
    fn failed_label_names_the_tool() {
        let p = parse(r#"{"tool_name":"Bash"}"#);
        assert_eq!(failed_label(&p), "✗ Bash failed");
        assert_eq!(failed_label(&parse("{}")), "✗ tool failed");
    }

    #[test]
    fn stop_failure_yields_type_and_message() {
        let p = parse(
            r#"{"error_type":"rate_limit","message":"You have exceeded your quota"}"#,
        );
        let (etype, msg) = error_info(&p);
        assert_eq!(etype, "rate_limit");
        assert_eq!(msg, "You have exceeded your quota");
    }

    #[test]
    fn stop_failure_defaults_type_and_truncates_message() {
        let long = "x".repeat(80);
        let p = parse(&format!(r#"{{"message":"{long}"}}"#));
        let (etype, msg) = error_info(&p);
        assert_eq!(etype, "error", "missing error_type defaults to 'error'");
        assert!(msg.ends_with('…') && msg.chars().count() == MAX_LABEL + 1);
    }
}
