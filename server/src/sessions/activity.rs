//! Hook-payload → live "current activity" + error derivation.
//!
//! Claude Code's hooks carry rich JSON on STDIN (tool_name, tool_input.command /
//! file_path / pattern, message, error_type, …). supermux's hook command forwards
//! a size-capped slice of that JSON to `/api/_internal/hook` as the `payload`
//! field; this module turns it into the tiny, human display strings the overview
//! card + focus header show under the status dot:
//!
//!   * [`activity_label`] — a `PreToolUse` payload → `("✎ tile.tsx", "edit")` etc.
//!   * [`failed_label`]    — a `PostToolUseFailure` payload → `"✗ Bash failed"`.
//!   * [`permission_ask`]  — a `PermissionRequest` payload → the live
//!     [`PermissionAsk`]: what Claude is asking to do + the permission mode.
//!   * [`HookPayload`]     — the LENIENT (every field optional) parse of `payload`.
//!
//! **Security.** Everything here is in-memory only and display
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
    /// Claude's CURRENT conversation UUID (the transcript file stem
    /// `<session_id>.jsonl`). Every Claude Code hook carries it. We capture it on
    /// `SessionStart`/`UserPromptSubmit` to keep the session's `cc_conversation_id`
    /// pointing at the LIVE conversation, so "this session" prompt-recall reads the
    /// current transcript instead of a stale one from an earlier resume. Aliased to
    /// cover the camelCase form some payload shapes use.
    #[serde(default, alias = "sessionId")]
    pub session_id: Option<String>,
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
    /// `SessionEnd`'s stated cause (`clear` / `logout` / `prompt_input_exit` /
    /// `other`). B5/T1.5 reads it to tell a session the USER ended from one
    /// that died on its own — only the latter is worth ringing a phone about.
    /// Absent on a killed pane, which is exactly why absence counts as a death.
    #[serde(default)]
    pub reason: Option<String>,
    /// Claude's CURRENT permission mode (`default` / `acceptEdits` / `plan` /
    /// `bypassPermissions`). EVERY Claude hook stdin carries it — and the
    /// statusLine JSON does NOT (verified on 2.1.227 + 2.1.231), so hooks are the
    /// only live source of the mode. Surfaced on the `PermissionRequest` ask so
    /// the UI can say *which* mode the pending dialog is being asked under.
    #[serde(default)]
    pub permission_mode: Option<String>,
}

/// The live "Claude is asking permission to do X" state, derived from a
/// `PermissionRequest` hook payload. In-memory only, display only — same posture
/// as the activity line (see the module docs): the dialog's *content* is
/// deliberately a short summary, never the raw tool input, so a long
/// secret-bearing command can't be surfaced in full.
///
/// This is a "the dialog is UP" signal, not a decision: the `PermissionRequest`
/// hook fires when the dialog DISPLAYS, before any choice, and no hook ever
/// reports the outcome. It is therefore cleared by the next event that can only
/// happen once the dialog resolved (`PostToolUse*` / `Stop` / `SessionEnd` /
/// `UserPromptSubmit` / `SessionStart`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PermissionAsk {
    /// The tool being asked about, verbatim (`Bash`, `Edit`, `mcp__a__b`, …).
    pub tool: String,
    /// The same short, secret-conscious summary the activity line uses
    /// (`⚡ run the test suite`, `✎ tile.tsx`) so both read identically.
    pub summary: String,
    /// The activity class of [`summary`](Self::summary) (`bash`/`edit`/…), for
    /// styling without re-parsing the emoji.
    pub kind: String,
    /// The permission mode the dialog is being raised under, when the payload
    /// carried one.
    pub mode: Option<String>,
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
    /// `AskUserQuestion`'s questions (B5/T1.5). The only large-ish field we
    /// admit, because it IS the payload's point: the agent's own sentence, which
    /// the notification relays verbatim rather than paraphrasing.
    #[serde(default)]
    pub questions: Option<Vec<QuestionEntry>>,
}

/// One entry of `AskUserQuestion`'s `questions` array. Only the question text is
/// modelled; the options/header live alongside it in Claude's payload and are
/// not something a lock-screen banner can usefully show.
#[derive(Debug, Default, Deserialize)]
pub struct QuestionEntry {
    #[serde(default)]
    pub question: Option<String>,
}

/// The agent's FIRST question from an `AskUserQuestion` payload, verbatim
/// (whitespace-trimmed). `None` when the payload carries no question text —
/// including when Claude's shape differs from the one modelled here.
///
/// Deliberately NOT truncated here: the notification layer caps it with the
/// same function the chat tile uses, so both show the identical string.
pub fn first_question(p: &HookPayload) -> Option<String> {
    p.tool_input
        .as_ref()?
        .questions
        .as_ref()?
        .iter()
        .find_map(|q| q.question.as_deref())
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_string)
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
/// Mapping:
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

/// The transient "a tool just failed" label for a `PostToolUseFailure` payload:
/// `✗ {tool} failed`. Falls back to a generic when no tool name.
pub fn failed_label(p: &HookPayload) -> String {
    match p.tool_name.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(tool) => format!("✗ {} failed", truncate(tool)),
        None => "✗ tool failed".to_string(),
    }
}

/// Derive the live [`PermissionAsk`] for a `PermissionRequest` payload, or
/// `None` when the payload names no tool (nothing to show — the endpoint stays a
/// no-op rather than surfacing an empty card).
///
/// The summary reuses [`activity_label`] verbatim so the pending-permission line
/// and the activity line are the same sentence about the same tool call.
pub fn permission_ask(p: &HookPayload) -> Option<PermissionAsk> {
    let (summary, kind) = activity_label(p)?;
    // activity_label already established a non-empty tool name.
    let tool = truncate(p.tool_name.as_deref().unwrap_or_default());
    let mode = p
        .permission_mode
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(truncate);
    Some(PermissionAsk {
        tool,
        summary,
        kind,
        mode,
    })
}

/// Derive a `(type, message)` error pair from a `StopFailure` payload.
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
    fn captures_session_id_for_conversation_tracking() {
        // Claude's hook carries the live conversation UUID as `session_id`; the
        // hook handler stores it as `cc_conversation_id` so "this session" recall
        // reads the CURRENT transcript. Accept the camelCase alias too.
        let p = parse(r#"{"session_id":"d93e672d-8080-49db-ad69-5e1bcc647291","cwd":"/x"}"#);
        assert_eq!(p.session_id.as_deref(), Some("d93e672d-8080-49db-ad69-5e1bcc647291"));
        let c = parse(r#"{"sessionId":"abc123"}"#);
        assert_eq!(c.session_id.as_deref(), Some("abc123"));
        // Absent → None (a no-op, never clobbers a stored id).
        assert_eq!(parse(r#"{"tool_name":"Bash"}"#).session_id, None);
    }

    /// VERBATIM `PermissionRequest` stdin, captured live off Claude Code 2.1.227
    /// (byte-identical on 2.1.231). The parse + derivation must hold on the real
    /// shape, not a hand-written approximation.
    const LIVE_PERMISSION_REQUEST: &str = r#"{"session_id":"a2a3a5c5-02de-4f07-93a4-98dc74507d0c","transcript_path":"/tmp/ccfg/projects/-home-supermux-spike-a0-hookprobe/a2a3a5c5.jsonl","cwd":"/home/supermux/spike-a0/hookprobe","prompt_id":"ea0e1860-1175-4005-810b-ae005b85e6a6","permission_mode":"default","effort":{"level":"high"},"hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/nonexistent-a0-probe.txt"},"permission_suggestions":[]}"#;

    /// VERBATIM `PostToolUseFailure` stdin from the same live capture. Note the
    /// four fields that distinguish it from `PermissionRequest`: `tool_use_id`,
    /// `error` (a plain string), `is_interrupt`, `duration_ms`.
    const LIVE_POST_TOOL_FAILURE: &str = r#"{"session_id":"a2a3a5c5-02de-4f07-93a4-98dc74507d0c","transcript_path":"/tmp/ccfg/x.jsonl","cwd":"/home/supermux/spike-a0/hookprobe","prompt_id":"ea0e1860-1175-4005-810b-ae005b85e6a6","permission_mode":"default","effort":{"level":"high"},"hook_event_name":"PostToolUseFailure","tool_name":"Read","tool_input":{"file_path":"/nonexistent-a0-probe.txt"},"tool_use_id":"toolu_01XvHoKvEax8CniDEibaznWN","error":"File does not exist. Note: your current working directory is /home/supermux/spike-a0/hookprobe.","is_interrupt":false,"duration_ms":34}"#;

    #[test]
    fn permission_ask_from_the_live_payload() {
        let ask = permission_ask(&parse(LIVE_PERMISSION_REQUEST))
            .expect("a permission dialog for a named tool is an ask");
        assert_eq!(ask.tool, "Read");
        // Same derivation as the activity line, so the two read identically.
        assert_eq!(ask.summary, "📖 nonexistent-a0-probe.txt");
        assert_eq!(ask.kind, "read");
        // Hooks are the ONLY source of the permission mode (the statusline JSON
        // does not carry it) — it must survive the parse.
        assert_eq!(ask.mode.as_deref(), Some("default"));
    }

    #[test]
    fn permission_ask_needs_a_tool_name() {
        // A payload with nothing to name has nothing to show → no ask (the
        // endpoint stays a no-op rather than surfacing an empty card).
        assert!(permission_ask(&parse("{}")).is_none());
        assert!(permission_ask(&parse(r#"{"permission_mode":"plan"}"#)).is_none());
    }

    #[test]
    fn permission_ask_without_a_mode_is_still_an_ask() {
        let ask = permission_ask(&parse(r#"{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}"#))
            .expect("tool name is enough");
        assert_eq!(ask.tool, "Bash");
        assert_eq!(ask.summary, "⚡ rm -rf /");
        assert_eq!(ask.mode, None);
    }

    #[test]
    fn live_post_tool_failure_payload_parses_and_labels() {
        // The dedicated PostToolUseFailure event: `tool_use_id`/`is_interrupt`/
        // `duration_ms` are unknown-to-us extras and must not break the lenient
        // parse, `error` lands at the TOP level (not `message`), and the label
        // comes off `tool_name`.
        let p = parse(LIVE_POST_TOOL_FAILURE);
        assert_eq!(failed_label(&p), "✗ Read failed");
        assert!(p.error.as_deref().unwrap().starts_with("File does not exist."));
        let (etype, msg) = error_info(&p);
        assert_eq!(etype, "error", "no error_type on this event → the default class");
        assert!(msg.starts_with("File does not exist."));
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
