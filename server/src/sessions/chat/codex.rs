//! Codex rollout dialect for the chat data plane.
//!
//! The chat renderer was built around Claude Code's project transcript. Codex
//! writes a different file, in a different place, with a different vocabulary —
//! but the pipeline behind the renderer ([`super::store`], [`super::tailer`],
//! [`super::ws`]) is provider-neutral: it moves [`ChatEntry`]s. So the ONLY
//! Codex-specific code is this module: **where the file is** ([`locate`]) and
//! **what a line means** ([`entries_from_object`]). Everything downstream —
//! the byte cursor, the oversize/partial-line/malformed rules, the ring, the
//! per-entry wire cap, and every React component — is reused unchanged.
//!
//! # Which of Codex's three streams this reads, and why
//!
//! A rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`) is an
//! append-only JSONL carrying three overlapping streams. Measured across the 91
//! rollouts on this box (2026-09-07, codex-cli 0.151.0):
//!
//! * `response_item` — the RAW model-API mirror. Present in 91/91 files, and the
//!   obvious first choice, which is why it is worth writing down why it is the
//!   wrong one: it REPLAYS. Each turn re-sends the whole prompt array, so the
//!   injected context blocks repeat verbatim on every request — in the worst
//!   file measured, 509 user messages expand to 6348 blocks of which only 1822
//!   are distinct, one block recurring 502 times. Rendering that stream is a
//!   chat log that repeats itself hundreds of times.
//! * `event_msg` — the HUMAN-VISIBLE UI stream, the one the Codex TUI itself
//!   draws. No replay: one event per thing that actually happened. This is what
//!   we read, and it is the same choice [`crate::sessions::recall::codex`]
//!   already made for the prompt-history popover.
//! * top-level `session_meta` / `world_state` / `turn_context` / `compacted` —
//!   header + telemetry. Skipped.
//!
//! # The two `event_msg` shapes
//!
//! Codex changed its event vocabulary mid-flight, and both shapes are on disk:
//!
//! * **older** (89/91 files): flat `user_message` / `agent_message` events.
//! * **newer** (2/91, codex-cli 0.151.0): a single `item_completed` event
//!   carrying a typed `item` (`UserMessage`, `AgentMessage`, `Reasoning`,
//!   `CommandExecution`, `Extension`, `ContextCompaction`).
//!
//! They never co-occur in one file (measured: zero files carry both), so the
//! dispatch below stays STATELESS — no "which format is this file?" flag to keep
//! across polls, and no way to double-render a turn. An older rollout therefore
//! renders prompts and replies but no tool activity (its tool calls live only in
//! the replaying `response_item` stream); a current one renders reasoning and
//! shell commands too. That asymmetry is deliberate and honest: it costs nothing
//! on the sessions people are actually running.
//!
//! # Nothing is dropped
//!
//! An event this module does not model becomes [`Kind::Unknown`] carrying its own
//! payload and label — never a silent drop and never a parse failure, exactly as
//! [`super::parser`] treats an unmodelled Claude line. The renderer turns those
//! into the visible "open the terminal" row, which is the whole point: Codex may
//! do something the chat view cannot draw, and the user must be TOLD that rather
//! than shown a gap.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::model::{ChatEntry, Kind};
use super::parser::{parse_ts_ms, str_at};

/// `event_msg` payload types that are pure telemetry/lifecycle noise: they carry
/// no conversation content, fire thousands of times (`token_count` alone is
/// 14 398 of the 39 023 events on this box), and have no useful rendering. These
/// are the ONLY events skipped outright — everything else either maps to a kind
/// or becomes [`Kind::Unknown`].
const NOISE_EVENTS: &[&str] = &[
    "token_count",
    "task_started",
    "task_complete",
    "thread_settings_applied",
    "sub_agent_activity",
];

/// Top-level line types that are not the conversation: the rollout header, the
/// replaying raw-API mirror (see the module note), and per-turn telemetry.
const SKIP_TOP_LEVEL: &[&str] = &[
    "response_item",
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
        "AgentMessage" => vec![base.entry(0, Kind::Assistant, blocks_text(item), None)],
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
            out.ok = Some(exit.map(|c| c == 0).unwrap_or(true));
            vec![call, out]
        }

        "Extension" => {
            let mut e = base.entry(
                0,
                Kind::ToolUse,
                serde_json::json!({
                    "input": {
                        "action": item.get("action").cloned().unwrap_or(Value::Null),
                        "query": item.get("query").cloned().unwrap_or(Value::Null),
                    },
                }),
                Some(str_at(item, &["kind"]).unwrap_or("extension")),
            );
            e.tool_use_id = id.map(str::to_string);
            vec![e]
        }

        "ContextCompaction" => vec![base.entry(
            0,
            Kind::CompactBoundary,
            serde_json::json!({ "content": Value::Null }),
            Some("compact_boundary"),
        )],

        _ => vec![base.entry(0, Kind::Unknown, Value::Object(item.clone()), Some(ty))],
    }
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
/// **Why by `cwd` and not by id:** the `codex_session_id` column exists in the
/// schema but nothing has ever written it (grep: zero assignments), so it is
/// always empty. Codex keeps no project index either, so the only honest
/// pointer is the one `recall::codex` already uses: the newest rollout whose
/// `session_meta.payload.cwd` is this session's directory. "Newest" is by mtime,
/// read from the directory entry alone — a header is only opened for a
/// candidate that could still win.
pub fn locate(dir: &str) -> Option<(PathBuf, String)> {
    locate_in_root(&codex_home().join("sessions"), dir)
}

/// [`locate`] against an explicit sessions root, so tests do not need a real
/// `$CODEX_HOME`.
fn locate_in_root(root: &Path, dir: &str) -> Option<(PathBuf, String)> {
    let want = std::fs::canonicalize(dir).unwrap_or_else(|_| PathBuf::from(dir));

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    collect_rollouts(root, 0, &mut candidates);
    // Newest first, so the first cwd match is the newest one and the rest are
    // never opened.
    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, path) in candidates {
        if rollout_cwd(&path).is_some_and(|cwd| {
            std::fs::canonicalize(&cwd).unwrap_or(PathBuf::from(&cwd)) == want
        }) {
            let stem = path.file_stem()?.to_str()?.to_string();
            let parent = path.parent()?.to_path_buf();
            return Some((parent, stem));
        }
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
fn rollout_cwd(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines().take(4).map_while(Result::ok) {
        if !line.contains("\"session_meta\"") {
            continue;
        }
        let v: Value = serde_json::from_str(&line).ok()?;
        return v
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
                "payload":{"type":"turn_aborted","reason":"interrupted"}}"#,
        );
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].kind, Kind::Unknown);
        assert_eq!(e[0].label.as_deref(), Some("turn_aborted"));
        assert_eq!(e[0].body["reason"], "interrupted", "the payload is kept whole");

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

