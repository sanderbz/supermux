//! Codex rollout dialect for the shared chat data plane.
//!
//! `event_msg` carries human-visible conversation events. The raw
//! `response_item` mirror can replay prompt context, so it is not rendered.
//! Flat messages and completed typed items both map to stable line-offset IDs.
//! Shell, file, MCP and collaboration calls retain their result/failure status;
//! an unfinished call does not receive a success receipt.
//!
//! Verified usage/settings telemetry is skipped. Lifecycle records become
//! explicit system entries; they do not override live PTY status. Unmodeled
//! actions retain their payload as `Unknown` for the terminal fallback.
//!
//! Transcript ownership is resolved in `source`: the current foreground
//! process tree is stronger evidence than a persisted ID or directory match.
//! Directory discovery excludes subagents and uses launch time when available.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::model::{ChatEntry, Kind};
use super::parser::{parse_ts_ms, str_at};

/// `event_msg` payload types that are pure telemetry noise: they carry
/// no conversation content, fire thousands of times (`token_count` alone is
/// 14 398 of the 39 023 events on this box), and have no useful rendering. These
/// are the ONLY events skipped outright — everything else either maps to a kind
/// or becomes [`Kind::Unknown`].
const NOISE_EVENTS: &[&str] = &[
    "token_count",
    "token_usage_record",
    "thread_settings_applied",
    "sub_agent_activity",
];

/// Top-level line types that are not the conversation: the rollout header, the
/// replaying raw-API mirror (see the module note), and per-turn telemetry.
const SKIP_TOP_LEVEL: &[&str] = &[
    "response_item",
    // Current Codex also writes usage as a top-level ledger record. It is
    // telemetry, not an action or a source-liveness signal.
    "token_usage_record",
    "session_meta",
    "world_state",
    "turn_context",
    "compacted",
    // Pure metadata: its whole payload is `{"trigger_turn": <bool>}` (measured
    // over all 393 occurrences on this box — no other key ever appears). Caught
    // by probing the dialect against real rollouts, where it was 99 of the 237
    // entries of one session: without this line every one of them became an
    // "open the terminal" row, which is precisely the noise that affordance
    // stops being believed if it cries wolf.
    "inter_agent_communication_metadata",
];

// ── line → entries ───────────────────────────────────────────────────────────

/// One rollout line → zero or more [`ChatEntry`]s.
///
/// The signature mirrors `parser::entries_from_object` so the tailer can pick a
/// dialect without knowing anything else about either.
///
/// Unlike the Claude dialect, an empty result is a real "nothing to show" (a
/// `token_count` tick) rather than something to placeholder, so noise does not
/// get an [`Kind::Unknown`] row.
pub fn entries_from_object(obj: &Map<String, Value>, offset: u64) -> Vec<ChatEntry> {
    let ty = str_at(obj, &["type"]).unwrap_or("");
    let ts_ms = parse_ts_ms(str_at(obj, &["timestamp"]));
    let base = Header { ts_ms, offset };

    if SKIP_TOP_LEVEL.contains(&ty) {
        return Vec::new();
    }
    if ty != "event_msg" {
        // A top-level type this module has never seen. Keep it whole.
        return vec![base.entry(0, Kind::Unknown, Value::Object(obj.clone()), Some(ty))];
    }

    let Some(payload) = obj.get("payload").and_then(Value::as_object) else {
        return vec![base.entry(0, Kind::Unknown, Value::Object(obj.clone()), Some(ty))];
    };
    let pt = str_at(payload, &["type"]).unwrap_or("");
    if NOISE_EVENTS.contains(&pt) {
        return Vec::new();
    }

    match pt {
        "task_started" | "task_complete" | "turn_aborted" => {
            let (label, state, text) = match pt {
                "task_started" => ("turn_started", "active", "Turn started"),
                "task_complete" => ("turn_complete", "idle", "Turn completed"),
                _ => ("turn_aborted", "interrupted", "Turn interrupted"),
            };
            vec![base.entry(0, Kind::System, serde_json::json!({
                "content": text, "state": state, "turn_id": payload.get("turn_id"),
                "reason": payload.get("reason"),
            }), Some(label))]
        }
        "error" => vec![base.entry(0, Kind::AgentError, serde_json::json!({
            "text": str_at(payload, &["message"]).unwrap_or("Agent error"), "error": payload.get("error"),
        }), Some("codex_error"))],
        // ── older rollouts: flat message events ──
        "user_message" => vec![base.entry(0, Kind::Prompt, text_body(payload, "message"), None)],
        "agent_message" => {
            vec![base.entry(0, Kind::Assistant, text_body(payload, "message"), None)]
        }

        // ── current rollouts: one typed item per completed thing ──
        "item_completed" => match payload.get("item").and_then(Value::as_object) {
            Some(item) => item_entries(item, &base),
            None => vec![base.entry(0, Kind::Unknown, Value::Object(payload.clone()), Some(pt))],
        },

        // ── events that carry real activity in both shapes ──
        "web_search_end" => {
            let mut e = base.entry(
                0,
                Kind::ToolUse,
                serde_json::json!({ "input": { "query": str_at(payload, &["query"]).unwrap_or("") } }),
                Some("web_search"),
            );
            e.tool_use_id = str_at(payload, &["call_id"]).map(str::to_string);
            e
        }
        .into_vec(),
        "patch_apply_end" => {
            let ok = payload.get("success").and_then(Value::as_bool).unwrap_or(false);
            let detail = str_at(payload, &["stderr"])
                .filter(|s| !s.trim().is_empty())
                .or_else(|| str_at(payload, &["stdout"]))
                .unwrap_or("");
            let mut e = base.entry(
                0,
                Kind::ToolResult,
                serde_json::json!({ "content": detail }),
                Some("apply_patch"),
            );
            e.tool_use_id = str_at(payload, &["call_id"]).map(str::to_string);
            e.ok = Some(ok);
            e
        }
        .into_vec(),
        "context_compacted" => vec![base.entry(
            0,
            Kind::CompactBoundary,
            serde_json::json!({ "content": Value::Null }),
            Some("compact_boundary"),
        )],

        // Everything else — `turn_aborted`, `thread_rolled_back`,
        // `image_generation_end`, `mcp_tool_call_end`, and whatever the next
        // codex release invents. Kept, labelled, and surfaced.
        _ => vec![base.entry(0, Kind::Unknown, Value::Object(payload.clone()), Some(pt))],
    }
}

/// A typed `item_completed.item` → entries.
fn item_entries(item: &Map<String, Value>, base: &Header) -> Vec<ChatEntry> {
    let ty = str_at(item, &["type"]).unwrap_or("");
    let id = str_at(item, &["id"]);
    match ty {
        "UserMessage" => vec![base.entry(0, Kind::Prompt, blocks_text(item), None)],
        "AgentMessage" => {
            let mut entries = vec![base.entry(0, Kind::Assistant, blocks_text(item), None)];
            if item.get("questions").and_then(Value::as_array).is_some_and(|q| !q.is_empty()) {
                let mut question = base.entry(1, Kind::ToolUse, serde_json::json!({ "input": { "questions": item.get("questions") }, "state": "waiting" }), Some("AskUserQuestion"));
                question.tool_use_id = id.map(str::to_string);
                entries.push(question);
            }
            entries
        },
        "Reasoning" => vec![base.entry(0, Kind::Thinking, text_body(item, "summary_text"), None)],

        // A shell run is a call AND its output. Emitting both, joined by
        // `tool_use_id`, is what lets the renderer fold them into the one
        // receipt row it already draws for a Claude `Bash` — no new component.
        "CommandExecution" => {
            let mut call = base.entry(
                0,
                Kind::ToolUse,
                serde_json::json!({
                    "input": { "command": str_at(item, &["command"]).unwrap_or("") },
                }),
                Some("shell"),
            );
            call.tool_use_id = id.map(str::to_string);
            let exit = item.get("exit_code").and_then(Value::as_i64);
            let mut out = base.entry(
                1,
                Kind::ToolResult,
                serde_json::json!({
                    "content": str_at(item, &["aggregated_output", "formatted_output", "stdout"])
                        .unwrap_or(""),
                }),
                None,
            );
            out.tool_use_id = id.map(str::to_string);
            // No exit code yet (a still-running command) is not a failure.
            out.ok = exit.map(|c| c == 0).or_else(|| completed_ok(item));
            if out.ok.is_some() { vec![call, out] } else { vec![call] }
        }

        "FileChange" => tool_pair(item, base, "apply_patch", serde_json::json!({ "changes": item.get("changes"), "file_path": item.get("changes").and_then(Value::as_object).and_then(|c| c.keys().next()) })),
        "McpToolCall" => tool_pair(item, base, str_at(item, &["tool"]).unwrap_or("mcp"), item.get("arguments").cloned().unwrap_or(Value::Null)),
        "CollabAgentToolCall" => tool_pair(item, base, str_at(item, &["tool"]).unwrap_or("collaboration"), serde_json::json!({ "receiver_agents": item.get("receiver_agents"), "receiver_thread_ids": item.get("receiver_thread_ids") })),
        "ImageView" => {
            let mut e = base.entry(0, Kind::ToolUse, serde_json::json!({ "input": { "file_path": item.get("path") } }), Some("view_image"));
            e.tool_use_id = id.map(str::to_string);
            vec![e]
        }
        "SubAgentActivity" => vec![base.entry(0, Kind::Subagent, serde_json::json!({ "content": item.get("kind"), "agent_path": item.get("agent_path"), "agent_thread_id": item.get("agent_thread_id") }), Some(str_at(item, &["kind"]).unwrap_or("subagent_activity")))],
        "Extension" => tool_pair(item, base, str_at(item, &["kind"]).unwrap_or("extension"), serde_json::json!({ "action": item.get("action"), "query": item.get("query") })),

        "ContextCompaction" => vec![base.entry(
            0,
            Kind::CompactBoundary,
            serde_json::json!({ "content": Value::Null }),
            Some("compact_boundary"),
        )],

        _ => vec![base.entry(0, Kind::Unknown, Value::Object(item.clone()), Some(ty))],
    }
}

/// An item is successful only after a terminal status or explicit result. A
/// still-running call must not acquire a success receipt before it has finished.
fn completed_ok(item: &Map<String, Value>) -> Option<bool> {
    if item.get("failure").is_some_and(|v| !v.is_null()) {
        return Some(false);
    }
    if item
        .get("result")
        .and_then(|r| r.get("isError"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Some(false);
    }
    match str_at(item, &["status"])
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "completed" | "complete" | "succeeded" | "success" => Some(true),
        "failed" | "error" | "declined" | "denied" | "interrupted" | "cancelled" => Some(false),
        _ => None,
    }
}

fn tool_pair(item: &Map<String, Value>, base: &Header, name: &str, input: Value) -> Vec<ChatEntry> {
    let mut call = base.entry(
        0,
        Kind::ToolUse,
        serde_json::json!({ "input": input }),
        Some(name),
    );
    call.tool_use_id = str_at(item, &["id", "call_id"]).map(str::to_string);
    let Some(ok) = completed_ok(item) else {
        return vec![call];
    };
    let mut out = base.entry(1, Kind::ToolResult, serde_json::json!({
        "content": item.get("result").or_else(|| item.get("results")).cloned()
            .unwrap_or_else(|| Value::String(str_at(item, &["stderr", "stdout"]).unwrap_or("").to_string())),
        "status": item.get("status"), "failure": item.get("failure"),
    }), None);
    out.tool_use_id = call.tool_use_id.clone();
    out.ok = Some(ok);
    vec![call, out]
}

/// `{ "text": <o[key] as string> }` — the body shape every text kind on the wire
/// already uses (`parser::text_body`'s contract; the frontend reads `body.text`
/// for `prompt`, `assistant` and `thinking` alike).
fn text_body(o: &Map<String, Value>, key: &str) -> Value {
    serde_json::json!({ "text": str_at(o, &[key]).unwrap_or("") })
}

/// `{ "text": … }` from an item's `content` block list (`[{type, text}, …]`).
/// Measured as always a single block, but joined rather than indexed so a
/// multi-block message cannot silently lose its tail.
fn blocks_text(item: &Map<String, Value>) -> Value {
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    serde_json::json!({ "text": text })
}

/// The per-line constants an entry needs. Codex lines carry no uuid of their
/// own, so identity is the line's byte offset (plus a block index) — the same
/// synthetic `@<offset>` scheme `parser::Header` uses for Claude's uuid-less
/// lines, and stable because the tailer never rewinds into a line's middle.
struct Header {
    ts_ms: i64,
    offset: u64,
}

impl Header {
    fn entry(&self, index: usize, kind: Kind, body: Value, label: Option<&str>) -> ChatEntry {
        ChatEntry {
            uuid: if index == 0 {
                format!("@{}", self.offset)
            } else {
                format!("@{}#{index}", self.offset)
            },
            kind,
            ts_ms: self.ts_ms,
            offset: self.offset,
            session_id: None,
            tool_use_id: None,
            label: label.filter(|l| !l.is_empty()).map(str::to_string),
            ok: None,
            is_sidechain: false,
            agent_id: None,
            is_meta: false,
            oversize: false,
            body,
        }
    }
}

/// `entry` builders that produce exactly one entry read better as an expression
/// than as a `vec![…]` wrapped around a block.
trait IntoVec {
    fn into_vec(self) -> Vec<ChatEntry>;
}
impl IntoVec for ChatEntry {
    fn into_vec(self) -> Vec<ChatEntry> {
        vec![self]
    }
}

// ── finding the file ─────────────────────────────────────────────────────────

/// `$CODEX_HOME`, or `~/.codex`.
fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join(".codex")
        })
}

/// Locate the rollout for the session working in `dir`, as
/// `(parent_dir, file_stem)`.
///
/// Returned split rather than whole so the caller can hand it straight to the
/// existing `tailer::transcript_path(project_dir, conversation_id)` — which
/// joins `<parent>/<stem>.jsonl` — and arm the existing directory watcher on the
/// parent. The tailer therefore needs no notion of "a codex path" at all.
///
/// Legacy discovery entry point. Production uses verified process ownership,
/// then a stable source pin, explicit persisted ID, or launch-time matching.
pub fn locate(dir: &str) -> Option<(PathBuf, String)> {
    locate_session(dir, "")
}

/// Validate a process-owned rollout without revealing or trusting its filename alone.
pub fn source_from_paths(
    paths: impl IntoIterator<Item = PathBuf>,
    dir: &str,
) -> Option<(PathBuf, String)> {
    let want = std::fs::canonicalize(dir).unwrap_or_else(|_| PathBuf::from(dir));
    let mut roots = Vec::new();
    for path in paths {
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl")
            || !path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with("rollout-"))
        {
            continue;
        }
        let Some(meta) = rollout_header(&path) else {
            continue;
        };
        let Some(cwd) = meta.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        if std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd)) != want {
            continue;
        }
        if meta
            .get("source")
            .is_some_and(|s| s.get("subagent").is_some())
            || meta.get("parent_thread_id").is_some_and(|p| !p.is_null())
        {
            continue;
        }
        roots.push(path);
    }
    roots.sort();
    roots.dedup();
    // Several root files open at once is ambiguous, never newest-file adoption.
    if roots.len() != 1 {
        return None;
    }
    let path = roots.pop()?;
    Some((
        path.parent()?.to_path_buf(),
        path.file_stem()?.to_str()?.to_string(),
    ))
}

/// [`locate`] against an explicit sessions root, so tests do not need a real
/// `$CODEX_HOME`.
pub fn locate_session(dir: &str, session_id: &str) -> Option<(PathBuf, String)> {
    locate_session_started(dir, session_id, 0)
}

#[cfg(test)]
fn locate_in_root(root: &Path, dir: &str) -> Option<(PathBuf, String)> {
    locate_session_in_root(root, dir, "")
}

pub fn locate_session_started(
    dir: &str,
    session_id: &str,
    last_started: i64,
) -> Option<(PathBuf, String)> {
    locate_started_in_root(
        &codex_home().join("sessions"),
        dir,
        session_id,
        last_started,
    )
}

#[cfg(test)]
fn locate_session_in_root(root: &Path, dir: &str, session_id: &str) -> Option<(PathBuf, String)> {
    locate_started_in_root(root, dir, session_id, 0)
}

fn locate_started_in_root(
    root: &Path,
    dir: &str,
    session_id: &str,
    last_started: i64,
) -> Option<(PathBuf, String)> {
    let want = std::fs::canonicalize(dir).unwrap_or_else(|_| PathBuf::from(dir));

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    collect_rollouts(root, 0, &mut candidates);
    // Newest first, so the first cwd match is the newest one and the rest are
    // never opened.
    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    let mut closest: Option<(u64, PathBuf)> = None;
    for (_, path) in candidates {
        if !session_id.is_empty()
            && !path
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.ends_with(session_id))
        {
            continue;
        }
        let Some(meta) = rollout_header(&path) else {
            continue;
        };
        let Some(cwd) = meta.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        if std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd)) != want {
            continue;
        }
        if meta
            .get("source")
            .is_some_and(|s| s.get("subagent").is_some())
            || meta.get("parent_thread_id").is_some_and(|p| !p.is_null())
        {
            continue;
        }
        if session_id.is_empty() && meta.get("source").and_then(Value::as_str) == Some("vscode") {
            continue;
        }
        if last_started > 0 && session_id.is_empty() {
            let created = parse_ts_ms(meta.get("timestamp").and_then(Value::as_str)) / 1000;
            // An older root in the same directory is not proof that a freshly
            // launched session has a transcript. Do not pin that old root.
            if created == 0 || created < last_started.saturating_sub(120) {
                continue;
            }
            let distance = created.abs_diff(last_started);
            if closest.as_ref().is_none_or(|(best, _)| distance < *best) {
                closest = Some((distance, path));
            }
            continue;
        }
        return Some((
            path.parent()?.to_path_buf(),
            path.file_stem()?.to_str()?.to_string(),
        ));
    }
    if let Some((_, path)) = closest {
        return Some((
            path.parent()?.to_path_buf(),
            path.file_stem()?.to_str()?.to_string(),
        ));
    }
    None
}

/// Rollouts live at `<root>/YYYY/MM/DD/rollout-*.jsonl`. Bounded at depth 3 so a
/// stray directory cannot turn discovery into a full-tree walk.
fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if depth < 3 {
                collect_rollouts(&e.path(), depth + 1, out);
            }
            continue;
        }
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-"))
        {
            continue;
        }
        if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
            out.push((m, path));
        }
    }
}

/// The `cwd` from a rollout's `session_meta` header, read from the first few
/// lines only — the header is line 1 in every rollout measured, and a bounded
/// scan keeps a malformed file from costing a full read.
fn rollout_header(path: &Path) -> Option<Map<String, Value>> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file)
        .lines()
        .take(4)
        .map_while(Result::ok)
    {
        let v: Value = serde_json::from_str(&line).ok()?;
        if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            return v.get("payload").and_then(Value::as_object).cloned();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_lifecycle_is_explicit_and_usage_records_are_quiet() {
        for (event, state) in [
            ("task_started", "active"),
            ("task_complete", "idle"),
            ("turn_aborted", "interrupted"),
        ] {
            let entries=parse(&serde_json::json!({"type":"event_msg","payload":{"type":event,"turn_id":"turn-1","reason":"interrupted"}}).to_string());
            assert_eq!(entries[0].kind, Kind::System);
            assert_eq!(entries[0].body["state"], state);
            assert_eq!(entries[0].body["turn_id"], "turn-1");
        }
        assert!(parse(r#"{"type":"event_msg","payload":{"type":"token_usage_record","usage":{"total_tokens":99}}}"#).is_empty());
    }

    #[test]
    fn current_tools_preserve_failures_and_never_finish_a_running_call() {
        for kind in [
            "FileChange",
            "McpToolCall",
            "CollabAgentToolCall",
            "Extension",
        ] {
            let input = serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":kind,"id":"call-1","status":"failed","tool":"example","stderr":"denied","result":{"isError":true,"content":[]}}}});
            let entries = parse(&input.to_string());
            assert_eq!(entries.len(), 2, "{kind}");
            assert_eq!(entries[0].kind, Kind::ToolUse);
            assert_eq!(entries[1].kind, Kind::ToolResult);
            assert_eq!(entries[1].ok, Some(false));
            assert_eq!(entries[0].tool_use_id, entries[1].tool_use_id);
            assert_ne!(entries[0].uuid, entries[1].uuid);
        }
        let running = parse(
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"running","command":"sleep 3","status":"in_progress"}}}"#,
        );
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].kind, Kind::ToolUse);
    }

    #[test]
    fn process_owned_source_excludes_subagent_and_rejects_ambiguous_roots() {
        let dir = std::env::temp_dir().join(format!("codex-owned-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.join("rollout-root.jsonl");
        let agent = dir.join("rollout-subagent.jsonl");
        let other = dir.join("rollout-other.jsonl");
        for (path, source) in [
            (&root, serde_json::json!("cli")),
            (&other, serde_json::json!("cli")),
            (
                &agent,
                serde_json::json!({"subagent":{"parent_thread_id":"root"}}),
            ),
        ] {
            std::fs::write(
                path,
                serde_json::json!({"type":"session_meta","payload":{"cwd":&dir,"source":source}})
                    .to_string()
                    + "\n",
            )
            .unwrap();
        }
        assert_eq!(
            source_from_paths(vec![agent.clone(), root.clone()], dir.to_str().unwrap())
                .unwrap()
                .1,
            "rollout-root"
        );
        assert!(source_from_paths(vec![root, other], dir.to_str().unwrap()).is_none());
        assert!(source_from_paths(vec![agent], dir.to_str().unwrap()).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unowned_startup_never_pins_an_old_thread_and_explicit_identity_wins() {
        let dir = std::env::temp_dir().join(format!("codex-start-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("rollout-old.jsonl");
        std::fs::write(&old,serde_json::json!({"type":"session_meta","payload":{"id":"old","cwd":&dir,"source":"cli","timestamp":"2026-10-08T10:00:00Z"}}).to_string()+"\n").unwrap();
        let started = parse_ts_ms(Some("2026-10-08T11:00:00Z")) / 1000;
        assert!(locate_started_in_root(&dir, dir.to_str().unwrap(), "", started).is_none());
        assert_eq!(
            locate_started_in_root(&dir, dir.to_str().unwrap(), "old", started)
                .unwrap()
                .1,
            "rollout-old"
        );
        let current = dir.join("rollout-current.jsonl");
        std::fs::write(&current,serde_json::json!({"type":"session_meta","payload":{"id":"current","cwd":&dir,"source":"cli","timestamp":"2026-10-08T11:00:02Z"}}).to_string()+"\n").unwrap();
        assert_eq!(
            locate_started_in_root(&dir, dir.to_str().unwrap(), "", started)
                .unwrap()
                .1,
            "rollout-current"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unmodeled_permission_request_preserves_terminal_fallback() {
        let entry = parse(
            r#"{"type":"event_msg","payload":{"type":"exec_approval_request","call_id":"approval","command":"example"}}"#,
        );
        assert_eq!(entry[0].kind, Kind::Unknown);
        assert_eq!(entry[0].label.as_deref(), Some("exec_approval_request"));
        assert_eq!(entry[0].body["command"], "example");
    }

    fn parse(line: &str) -> Vec<ChatEntry> {
        let v: Value = serde_json::from_str(line).expect("valid json");
        entries_from_object(v.as_object().expect("object"), 0)
    }

    #[test]
    fn flat_message_events_become_prompt_and_assistant() {
        // The shape 89 of the 91 rollouts on this box use.
        let p = parse(
            r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg",
                "payload":{"type":"user_message","message":"ship it"}}"#,
        );
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, Kind::Prompt);
        assert_eq!(p[0].body["text"], "ship it");
        // The wire cap and the whole React tree key off `body.text`, so this is
        // the contract that matters, not the kind alone.

        let a = parse(
            r#"{"timestamp":"2026-09-07T10:00:01.000Z","type":"event_msg",
                "payload":{"type":"agent_message","message":"done"}}"#,
        );
        assert_eq!(a[0].kind, Kind::Assistant);
        assert_eq!(a[0].body["text"], "done");
        assert!(a[0].ts_ms > 0, "the rollout's own clock must survive");
    }

    #[test]
    fn top_level_usage_ledger_does_not_displace_a_reloaded_conversation() {
        let telemetry = r#"{"type":"token_usage_record","ordinal":42,
            "timestamp":"2026-10-08T10:36:00Z","payload":{
            "response_id":"response-fixture","root_turn_id":"root-fixture",
            "session_id":"session-fixture","thread_id":"thread-fixture",
            "thread_token_usage":{"input_tokens":100,"output_tokens":20},
            "turn_id":"turn-fixture","turn_token_usage":{"input_tokens":10},
            "usage":{"total_tokens":120}}}"#;
        assert!(parse(telemetry).is_empty());
        // Filtering this verified ledger shape must not suppress interactive
        // actions or errors whose schema has not yet been modeled.
        let unknown =
            parse(r#"{"type":"future_approval_request","payload":{"requires_action":true}}"#);
        assert_eq!(unknown[0].kind, Kind::Unknown);
        let error =
            parse(r#"{"type":"event_msg","payload":{"type":"error","message":"fixture failure"}}"#);
        assert_eq!(error[0].kind, Kind::AgentError);
    }

    #[test]
    fn item_completed_messages_join_their_content_blocks() {
        let e = parse(
            r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg","payload":{
                "type":"item_completed","item":{"type":"AgentMessage","id":"i1",
                "content":[{"type":"output_text","text":"one"},
                           {"type":"output_text","text":"two"}]}}}"#,
        );
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].kind, Kind::Assistant);
        assert_eq!(e[0].body["text"], "one\ntwo", "a tail block must not be lost");
    }

    #[test]
    fn a_command_becomes_a_call_and_its_result_sharing_one_id() {
        // This is what lets the existing receipts row fold the pair, exactly as
        // it folds a Claude `Bash` tool_use + tool_result.
        let e = parse(
            r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg","payload":{
                "type":"item_completed","item":{"type":"CommandExecution","id":"c1",
                "command":"ls -la","aggregated_output":"total 0","exit_code":0}}}"#,
        );
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].kind, Kind::ToolUse);
        assert_eq!(e[0].label.as_deref(), Some("shell"));
        assert_eq!(e[0].body["input"]["command"], "ls -la");
        assert_eq!(e[1].kind, Kind::ToolResult);
        assert_eq!(e[1].body["content"], "total 0");
        assert_eq!(e[1].ok, Some(true));
        assert_eq!(
            e[0].tool_use_id, e[1].tool_use_id,
            "the pair must share an id or the renderer cannot fold them"
        );
        assert_ne!(e[0].uuid, e[1].uuid, "two entries on one line need two ids");
    }

    #[test]
    fn a_failed_command_reports_not_ok() {
        let e = parse(
            r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg","payload":{
                "type":"item_completed","item":{"type":"CommandExecution","id":"c1",
                "command":"false","aggregated_output":"","exit_code":1}}}"#,
        );
        assert_eq!(e[1].ok, Some(false));
    }

    #[test]
    fn the_replaying_raw_api_stream_is_never_rendered() {
        // THE bug this dialect exists to avoid: `response_item` re-sends the
        // whole prompt array every turn (measured: one block 502 times in a
        // single rollout), so rendering it repeats the conversation.
        for line in [
            r#"{"type":"response_item","payload":{"type":"message","role":"user",
                "content":[{"type":"input_text","text":"replayed"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[]}}"#,
            r#"{"type":"session_meta","payload":{"id":"x","cwd":"/tmp"}}"#,
            r#"{"type":"turn_context","payload":{}}"#,
            r#"{"type":"world_state","payload":{}}"#,
            // Pure metadata — 99 of one real session's 237 entries before it
            // was skipped. See `SKIP_TOP_LEVEL`.
            r#"{"type":"inter_agent_communication_metadata","payload":{"trigger_turn":false}}"#,
        ] {
            assert!(parse(line).is_empty(), "must be skipped: {line}");
        }
    }

    #[test]
    fn telemetry_is_skipped_but_never_becomes_an_unknown_row() {
        // `token_count` alone is 14398 of the 39023 events on this box — one
        // "open the terminal" row each would bury the conversation.
        for pt in NOISE_EVENTS {
            let line = format!(
                r#"{{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg",
                    "payload":{{"type":"{pt}"}}}}"#
            );
            assert!(parse(&line).is_empty(), "{pt} must be silent");
        }
    }

    #[test]
    fn an_unmodelled_event_is_kept_as_unknown_never_dropped() {
        // The totality property: this is what feeds the renderer's visible
        // "Codex did something the chat view can't show yet" row.
        let e = parse(
            r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg",
                "payload":{"type":"future_interactive_action","reason":"interrupted"}}"#,
        );
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].kind, Kind::Unknown);
        assert_eq!(e[0].label.as_deref(), Some("future_interactive_action"));
        assert_eq!(
            e[0].body["reason"], "interrupted",
            "the payload is kept whole"
        );

        // …and so is a top-level type from a future codex release.
        let f = parse(r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"brand_new_thing"}"#);
        assert_eq!(f[0].kind, Kind::Unknown);
        assert_eq!(f[0].label.as_deref(), Some("brand_new_thing"));

        // An unmodelled ITEM inside a modelled event is kept too.
        let g = parse(
            r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg","payload":{
                "type":"item_completed","item":{"type":"SomethingNew","id":"z"}}}"#,
        );
        assert_eq!(g[0].kind, Kind::Unknown);
        assert_eq!(g[0].label.as_deref(), Some("SomethingNew"));
    }

    #[test]
    fn entries_on_one_line_share_its_offset_but_not_its_uuid() {
        // The tailer's cursor invariant: every entry of a line carries the LINE
        // start, so a re-seed can never rewind into a line's middle.
        let v: Value = serde_json::from_str(
            r#"{"timestamp":"2026-09-07T10:00:00.000Z","type":"event_msg","payload":{
                "type":"item_completed","item":{"type":"CommandExecution","id":"c1",
                "command":"ls","aggregated_output":"","exit_code":0}}}"#,
        )
        .unwrap();
        let e = entries_from_object(v.as_object().unwrap(), 4096);
        assert!(e.iter().all(|x| x.offset == 4096));
        assert_eq!(e[0].uuid, "@4096");
        assert_eq!(e[1].uuid, "@4096#1");
    }

    #[test]
    fn locate_picks_the_newest_rollout_for_this_cwd_and_ignores_others() {
        let base = std::env::temp_dir().join(format!("codexloc-{}", std::process::id()));
        let day = base.join("sessions/2026/09/07");
        std::fs::create_dir_all(&day).unwrap();
        let mine = base.join("work");
        let theirs = base.join("other");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();

        let write = |name: &str, cwd: &Path| {
            let line = format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"x\",\"cwd\":{:?}}}}}\n",
                cwd.to_str().unwrap()
            );
            std::fs::write(day.join(name), line).unwrap();
        };
        write("rollout-2026-09-07T09-00-00-aaa.jsonl", &mine);
        write("rollout-2026-09-07T10-00-00-bbb.jsonl", &theirs);
        std::thread::sleep(std::time::Duration::from_millis(20));
        write("rollout-2026-09-07T11-00-00-ccc.jsonl", &mine);
        // A non-rollout file in the same dir must never be picked up.
        std::fs::write(day.join("notes.jsonl"), "{}\n").unwrap();

        let (parent, stem) =
            locate_in_root(&base.join("sessions"), mine.to_str().unwrap()).expect("found");
        assert_eq!(parent, day);
        assert_eq!(
            stem, "rollout-2026-09-07T11-00-00-ccc",
            "the NEWEST rollout for this cwd wins"
        );
        // The stem must rejoin to the real file — this is the contract the
        // tailer relies on (`<parent>/<stem>.jsonl`).
        assert!(parent.join(format!("{stem}.jsonl")).is_file());

        // A directory nothing ran in has no rollout.
        assert!(locate_in_root(&base.join("sessions"), base.join("nope").to_str().unwrap()).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }
}
