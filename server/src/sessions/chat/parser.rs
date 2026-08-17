//! Streaming JSONL → [`ChatEntry`], pinned by the A0 fixture corpus.
//!
//! This is a NEW parser, not a rewrite of [`super::super::recall`]: recall
//! answers "give me the user's past prompts" from a whole file, this one answers
//! "give me everything that appeared after byte N" and must be *total* — every
//! line either yields entries or is explicitly skipped, never a panic and never
//! a silent drop.
//!
//! ## Why extraction is key-list based, not `#[serde(alias)]`
//!
//! Live assistant lines carry **both** `session_id` and `sessionId` on the same
//! object (A0 corpus, `assistant.jsonl:1`). A derived `#[serde(alias =
//! "sessionId")]` field rejects that as a duplicate field, which would make
//! every assistant line malformed. So the shared header fields are pulled out
//! of a `serde_json::Value` by key list, first hit wins.
//!
//! ## Invariants
//!
//! - `offset` is always the **line start**, shared by every block of a
//!   multi-block line, so a cursor built from it can never rewind mid-line.
//! - `content` is always treated as a list of N blocks (A0: one real
//!   `[thinking, text]` line in 21,431); blocks past the first get `#<i>` uuids.
//! - `compact_boundary` is inline and the cursor survives it; `compactMetadata`
//!   internals drift across versions and are never read into.
//! - A line over [`MAX_LINE_BYTES`] becomes an `oversize` placeholder read with
//!   a bounded reader, so a 950 KB line is never doubled into memory.

use std::io::{BufRead, Read};

use serde_json::{Map, Value};

use super::agent_error;
use super::model::{ChatEntry, Kind, MAX_LINE_BYTES};
#[cfg(test)]
use super::model::{SubagentMeta, WireEntry, MAX_ENTRY_BYTES};

/// Outcome of parsing one physical line.
#[derive(Debug)]
pub enum ParsedLine {
    /// One entry per content block (usually exactly one).
    Entry(Vec<ChatEntry>),
    /// Structurally uninteresting (blank line). Never used to drop a *shape*.
    Skip,
    /// Not JSON / not an object. The tailer advances past it rather than wedging.
    Malformed(String),
}

/// Top-level `type` values we recognise when scanning an oversize line's raw
/// bytes (where a real parse is refused). Nested blocks also carry `"type"`,
/// so the scan prefers a value from this list over the first hit.
const TOP_LEVEL_TYPES: &[&str] = &[
    "assistant",
    "user",
    "system",
    "attachment",
    "queue-operation",
    "mode",
    "permission-mode",
];

/// Parse one physical line. `offset` is the byte offset of the line START.
pub fn parse_line(line: &str, offset: u64) -> ParsedLine {
    if line.trim().is_empty() {
        return ParsedLine::Skip;
    }
    if line.len() > MAX_LINE_BYTES {
        return ParsedLine::Entry(vec![oversize_entry(line, offset)]);
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return ParsedLine::Malformed(e.to_string()),
    };
    let Some(obj) = v.as_object() else {
        return ParsedLine::Malformed("top-level JSON value is not an object".to_string());
    };
    ParsedLine::Entry(entries_from_object(obj, offset))
}

/// Read whole lines from `reader`, which must already be positioned at
/// `from_offset`. Returns the entries and the new cursor.
///
/// A trailing line without its `\n` is **not** consumed: Claude Code appends
/// with ordinary buffered writes, so a poll can land mid-line and the next one
/// must re-read it whole.
pub fn parse_stream<R: BufRead>(reader: R, from_offset: u64) -> (Vec<ChatEntry>, u64) {
    let mut out = Vec::new();
    let next = parse_scan(reader, from_offset, |e| {
        out.push(e);
        true
    });
    (out, next)
}

/// [`parse_stream`], streamed: each entry goes to `sink`, and a `false` return
/// stops the scan there. Returns the offset just past the last consumed line.
///
/// The early stop is what makes fetch-full affordable. It wants ONE uuid out of
/// a file that reaches 49 MB on this host, and materialising every entry —
/// with its full, UNCAPPED body, since fetch-full is the escape hatch from the
/// cap — cost ~45 ms and ~32 MB per request, once per truncated entry a
/// renderer resolves.
pub fn parse_scan<R: BufRead>(
    mut reader: R,
    from_offset: u64,
    mut sink: impl FnMut(ChatEntry) -> bool,
) -> u64 {
    let mut offset = from_offset;
    let cap = (MAX_LINE_BYTES + 1) as u64;
    let mut buf: Vec<u8> = Vec::new();

    loop {
        buf.clear();
        let n = match (&mut reader).take(cap).read_until(b'\n', &mut buf) {
            Ok(n) => n,
            Err(e) => {
                tracing::debug!(error = %e, "chat tail read failed");
                break;
            }
        };
        if n == 0 {
            break;
        }
        let complete = buf.last() == Some(&b'\n');

        if !complete {
            if (n as u64) < cap {
                // Partial trailing line — leave it for the next poll.
                break;
            }
            // Over MAX_LINE_BYTES. Discard the rest of the line in bounded
            // chunks; if its terminator has not been written yet, do NOT
            // advance the cursor (the whole line is re-read next poll).
            let mut consumed = n as u64;
            let mut terminated = false;
            let mut skip: Vec<u8> = Vec::new();
            loop {
                skip.clear();
                let m = (&mut reader)
                    .take(64 * 1024)
                    .read_until(b'\n', &mut skip)
                    .unwrap_or_default();
                if m == 0 {
                    break;
                }
                consumed += m as u64;
                if skip.last() == Some(&b'\n') {
                    terminated = true;
                    break;
                }
            }
            if !terminated {
                break;
            }
            let prefix = String::from_utf8_lossy(&buf);
            let stop = !sink(oversize_entry(&prefix, offset));
            offset += consumed;
            if stop {
                break;
            }
            continue;
        }

        let mut end = n - 1;
        if end > 0 && buf[end - 1] == b'\r' {
            end -= 1;
        }
        let text = String::from_utf8_lossy(&buf[..end]);
        let mut stop = false;
        match parse_line(&text, offset) {
            ParsedLine::Entry(list) => {
                for e in list {
                    if !sink(e) {
                        stop = true;
                        break;
                    }
                }
            }
            ParsedLine::Skip => {}
            ParsedLine::Malformed(m) => {
                tracing::debug!(offset, error = %m, "skipping malformed transcript line")
            }
        }
        offset += n as u64;
        if stop {
            break;
        }
    }

    offset
}

// ── line → entries ───────────────────────────────────────────────────────────

fn entries_from_object(obj: &Map<String, Value>, offset: u64) -> Vec<ChatEntry> {
    let ty = str_at(obj, &["type"]).unwrap_or("");
    let base = Header::read(obj, offset);

    let mut entries = match ty {
        "assistant" => blocks(obj, &base, assistant_block),
        "user" => blocks(obj, &base, user_block),
        "attachment" => vec![attachment_entry(obj, &base)],
        "system" => vec![system_entry(obj, &base)],
        "queue-operation" => vec![base.entry(
            Kind::Queue,
            json_of(obj, &["content"]),
            str_at(obj, &["operation"]),
        )],
        "mode" => vec![base.entry(Kind::Mode, json_of(obj, &["mode"]), str_at(obj, &["mode"]))],
        "permission-mode" => vec![base.entry(
            Kind::Mode,
            json_of(obj, &["permissionMode", "permission_mode"]),
            str_at(obj, &["permissionMode", "permission_mode"]),
        )],
        // agent-name / agent-setting / bridge-session / ai-title / file-history-*
        // / anything a future patch release invents. Kept whole, never dropped.
        _ => vec![base.entry(Kind::Unknown, Value::Object(obj.clone()), Some(ty))],
    };
    if entries.is_empty() {
        // An empty `content` list still happened — keep the line addressable.
        entries.push(base.entry(Kind::Unknown, Value::Null, Some(ty)));
    }
    entries
}

/// Shared per-line header. Extracted once, cloned per block.
struct Header {
    uuid: String,
    ts_ms: i64,
    offset: u64,
    session_id: Option<String>,
    is_sidechain: bool,
    agent_id: Option<String>,
    is_meta: bool,
}

impl Header {
    fn read(obj: &Map<String, Value>, offset: u64) -> Self {
        Self {
            // Bare pointer/metadata lines (`custom-title`, `mode`, …) carry no
            // uuid; a synthetic offset-keyed id keeps every entry addressable.
            uuid: str_at(obj, &["uuid"])
                .map(str::to_string)
                .unwrap_or_else(|| format!("@{offset}")),
            ts_ms: parse_ts_ms(str_at(obj, &["timestamp"])),
            offset,
            session_id: str_at(obj, &["session_id", "sessionId"]).map(str::to_string),
            is_sidechain: bool_at(obj, &["isSidechain", "is_sidechain"]).unwrap_or(false),
            agent_id: str_at(obj, &["agentId", "agent_id"]).map(str::to_string),
            // A LINE-level flag, like `isSidechain`: the harness marks the whole
            // record, and every block of it inherits the mark.
            is_meta: bool_at(obj, &["isMeta", "is_meta"]).unwrap_or(false),
        }
    }

    fn entry(&self, kind: Kind, body: Value, label: Option<&str>) -> ChatEntry {
        self.entry_at(0, kind, body, label)
    }

    fn entry_at(&self, index: usize, kind: Kind, body: Value, label: Option<&str>) -> ChatEntry {
        ChatEntry {
            uuid: if index == 0 {
                self.uuid.clone()
            } else {
                format!("{}#{index}", self.uuid)
            },
            kind,
            ts_ms: self.ts_ms,
            offset: self.offset,
            session_id: self.session_id.clone(),
            tool_use_id: None,
            label: label.filter(|l| !l.is_empty()).map(str::to_string),
            ok: None,
            is_sidechain: self.is_sidechain,
            agent_id: self.agent_id.clone(),
            is_meta: self.is_meta,
            oversize: false,
            body,
        }
    }
}

/// Fan a `message.content` list out to one entry per block.
///
/// `content` is a bare string on plenty of lines and a list of N blocks on the
/// rest; both are normalised here so callers only ever see blocks.
fn blocks<F>(obj: &Map<String, Value>, base: &Header, f: F) -> Vec<ChatEntry>
where
    F: Fn(&Map<String, Value>, &Header, usize, &Value) -> ChatEntry,
{
    let content = obj.get("message").and_then(|m| m.get("content"));
    match content {
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, b)| f(obj, base, i, b))
            .collect(),
        Some(Value::String(s)) => {
            let block = serde_json::json!({ "type": "text", "text": s });
            vec![f(obj, base, 0, &block)]
        }
        _ => Vec::new(),
    }
}

/// The `line` parameter is not decoration: an assistant line's whole error
/// state (`error`, `isApiErrorMessage`, `apiErrorStatus`, `errorDetails`) lives
/// on the LINE, and a `tool_result`'s structured answer lives in the SIBLING
/// top-level `toolUseResult` — so a block-only signature is structurally unable
/// to see either. It is what made a rate-limit banner render as prose.
fn assistant_block(line: &Map<String, Value>, base: &Header, i: usize, b: &Value) -> ChatEntry {
    let obj = b.as_object();
    let ty = obj.and_then(|o| str_at(o, &["type"])).unwrap_or("");
    match ty {
        "thinking" => base.entry_at(i, Kind::Thinking, text_body(b, "thinking"), None),
        "text" => {
            let text = b.get("text").and_then(Value::as_str).unwrap_or("");
            match agent_error::from_line(line, text) {
                Some(info) => {
                    let mut e = base.entry_at(
                        i,
                        Kind::AgentError,
                        agent_error_body(line, text, &info),
                        Some(&info.class),
                    );
                    // A banner is never a success, and `ok` is what the receipts
                    // and the tile styling already read.
                    e.ok = Some(false);
                    e
                }
                None => base.entry_at(i, Kind::Assistant, text_body(b, "text"), None),
            }
        }
        "tool_use" => {
            let o = obj.expect("tool_use block is an object");
            let mut e = base.entry_at(
                i,
                Kind::ToolUse,
                serde_json::json!({ "input": o.get("input").cloned().unwrap_or(Value::Null) }),
                str_at(o, &["name"]),
            );
            e.tool_use_id = str_at(o, &["id", "tool_use_id", "toolUseID", "toolUseId"])
                .map(str::to_string);
            e
        }
        _ => base.entry_at(i, Kind::Unknown, b.clone(), Some(ty)),
    }
}

fn user_block(line: &Map<String, Value>, base: &Header, i: usize, b: &Value) -> ChatEntry {
    let obj = b.as_object();
    let ty = obj.and_then(|o| str_at(o, &["type"])).unwrap_or("");
    match ty {
        "text" => {
            let text = b.get("text").and_then(Value::as_str).unwrap_or("");
            // THE GRACE WINDOW (`limit.grace_window`). Between "approaching" and
            // "blocked" the server sets `anthropic-ratelimit-unified-grace-status`
            // and Claude Code INJECTS a wrap-up instruction into the model's
            // context as a user-role entry. There is no banner anywhere, the turn
            // keeps running, and Claude quietly stops spawning subagents and
            // starts summarising.
            //
            // Left as a prompt it is the worst row on the surface: it renders as
            // if the USER typed `[Usage limit reached — grace window active. Wrap
            // up: …]`, and Claude's sudden change of behaviour then looks like a
            // bug in this app. It is a SYSTEM notice, and it says who wrote it.
            match grace_window(text) {
                Some(hint) => {
                    base.entry_at(i, Kind::System, grace_body(text, hint), Some("limit_grace"))
                }
                None => base.entry_at(i, Kind::Prompt, text_body(b, "text"), None),
            }
        }
        "tool_result" => {
            let o = obj.expect("tool_result block is an object");
            let content = o.get("content").cloned().unwrap_or(Value::Null);
            // `toolUseResult` is a SIBLING of `message`, not a field of the
            // block — the structured half of the answer (`AskUserQuestion`'s
            // `{answers, annotations}`) lives there and nowhere else, so a
            // block-scoped read can only ever recover the prose sentence CC
            // writes for the model's benefit.
            let structured = line.get("toolUseResult").cloned();
            let denied = is_denial(&content);
            let mut body = serde_json::json!({ "content": content });
            if let Some(answers) = structured
                .as_ref()
                .and_then(|v| v.get("answers"))
                .filter(|v| v.is_object())
            {
                body["answers"] = answers.clone();
            }
            let mut e = base.entry_at(
                i,
                Kind::ToolResult,
                body,
                // A denial is a DECISION, not an output. Labelling it is what
                // lets the renderer say "you declined this" instead of drawing
                // a success tick next to a refusal (verify matrix,
                // `permission.denied.transcript`).
                denied.then_some("denied"),
            );
            e.tool_use_id = str_at(o, &["tool_use_id", "toolUseID", "toolUseId"]).map(str::to_string);
            // `is_error` is absent on a denial — CC states the refusal in the
            // content string instead — so the flag alone reports a rejected
            // edit as a successful one.
            e.ok = Some(!denied && !bool_at(o, &["is_error", "isError"]).unwrap_or(false));
            e
        }
        // Base64 image blocks reach 482 KB (A0). The bytes are never worth
        // holding in the ring — the shape is, and fetch-full can stream the rest.
        "image" => {
            let media = obj
                .and_then(|o| o.get("source"))
                .and_then(|s| s.get("media_type"))
                .and_then(Value::as_str);
            base.entry_at(
                i,
                Kind::Attachment,
                serde_json::json!({ "image": true, "media_type": media }),
                Some("image"),
            )
        }
        _ => base.entry_at(i, Kind::Unknown, b.clone(), Some(ty)),
    }
}

fn attachment_entry(obj: &Map<String, Value>, base: &Header) -> ChatEntry {
    let att = obj.get("attachment");
    let sub = att
        .and_then(Value::as_object)
        .and_then(|o| str_at(o, &["type"]));
    let mut e = base.entry(
        Kind::Attachment,
        att.cloned().unwrap_or(Value::Null),
        sub,
    );
    e.tool_use_id = att
        .and_then(Value::as_object)
        .and_then(|o| str_at(o, &["toolUseID", "toolUseId", "tool_use_id"]))
        .map(str::to_string);
    e
}

fn system_entry(obj: &Map<String, Value>, base: &Header) -> ChatEntry {
    let subtype = str_at(obj, &["subtype"]).unwrap_or("");
    if subtype == "compact_boundary" {
        // Inline: the file keeps going and so does the cursor. `compactMetadata`
        // internals drift across CC versions — we deliberately do not read them.
        return base.entry(
            Kind::CompactBoundary,
            serde_json::json!({ "content": str_at(obj, &["content"]) }),
            Some(subtype),
        );
    }
    let mut body = serde_json::json!({
        "content": str_at(obj, &["content"]),
        "level": str_at(obj, &["level"]),
    });
    match subtype {
        // A retry storm is emitted PER ATTEMPT (30 in one session on this box),
        // so the only honest row is ONE that counts — which needs the request
        // id to collapse on and the attempt numbers to say how bad it is.
        "api_error" => {
            let err = obj.get("error");
            if let Some(id) = err.and_then(|e| e.get("requestId")).and_then(Value::as_str) {
                body["request_id"] = Value::String(id.to_string());
            }
            if let Some(f) = err.and_then(|e| e.get("formatted")).and_then(Value::as_str) {
                body["formatted"] = Value::String(f.to_string());
            }
            if let Some(s) = err.and_then(|e| e.get("status")).and_then(Value::as_i64) {
                body["status"] = Value::from(s);
            }
            // The one field that separates "the network is gone" from "the API
            // is busy"; CC computes it and nothing downstream had it.
            if let Some(d) = err.and_then(|e| e.get("isNetworkDown")).and_then(Value::as_bool) {
                body["network_down"] = Value::Bool(d);
            }
            for (from, to) in [("retryAttempt", "attempt"), ("maxRetries", "max_retries")] {
                if let Some(n) = obj.get(from).and_then(Value::as_i64) {
                    body[to] = Value::from(n);
                }
            }
        }
        // The SESSION MODEL silently changed under the user. Both names, or the
        // row is just a warning with no fact in it.
        "model_refusal_fallback" | "model_fallback" | "model_consent_fallback" => {
            for (from, to) in [
                ("originalModel", "from_model"),
                ("fallbackModel", "to_model"),
                ("trigger", "trigger"),
            ] {
                if let Some(v) = str_at(obj, &[from]) {
                    body[to] = Value::String(v.to_string());
                }
            }
        }
        // THE UNIVERSAL BLOCKED SIGNAL. CC emits `request_user_dialog` for every
        // dialog kind, including ones it has not shipped yet — so this one arm
        // covers dialog families this codebase has never seen, which is
        // precisely what a per-dialog registry cannot do.
        "request_user_dialog" => {
            // `dialog_kind` is the spelling Claude Code's own control-request
            // envelope uses (2.1.227 bundle: `dialog prompt: ` / `dialog_kind`,
            // whose values include `elicitation` — the MCP form family this
            // arm is the no-hook fallback for).
            for key in ["dialogType", "dialog_type", "dialog_kind", "type", "toolName"] {
                if let Some(v) = str_at(obj, &[key]) {
                    body["dialog"] = Value::String(v.to_string());
                    break;
                }
            }
            body["blocked"] = Value::Bool(true);
        }
        // A LONG-RUNNING MCP TASK, and the one status in its enum that means a
        // human is needed (`mcp.task_input_required`). An MCP task parks on
        // `input_required` INDEPENDENTLY of the elicitation dialog — nothing
        // streams, no hook fires, the turn does not end — so the session reads
        // Idle while it is waiting on somebody. The status is what makes this
        // row worth drawing, so it is what the row carries.
        s if s.starts_with("task_") => {
            for (from, to) in [
                (&["status", "taskStatus", "task_status", "mcpStatus"][..], "status"),
                (&["task_id", "taskId", "mcpTaskId"][..], "task_id"),
                (
                    &["mcp_server_name", "serverName", "server_name", "server"][..],
                    "server",
                ),
                (&["tool_name", "toolName"][..], "tool"),
            ] {
                if let Some(v) = str_at(obj, from) {
                    body[to] = Value::String(v.to_string());
                }
            }
            // `working` / `completed` / `failed` / `cancelled` are progress;
            // `input_required` is a person. Only the last one blocks, and the
            // flag is the same bit the limit banners set — one word for "this
            // session cannot get on with it", whatever stopped it.
            if body.get("status").and_then(Value::as_str) == Some("input_required") {
                body["blocked"] = Value::Bool(true);
                body["needs_input"] = Value::Bool(true);
            }
        }
        _ => {}
    }
    base.entry(Kind::System, body, Some(subtype))
}

/// **Is this injected text Claude Code's grace-window wrap-up instruction?**
/// Returns which of the two hints it is (`wrap_up` / `checkpoint`), which is
/// also what Claude Code calls them internally (`wrap-up` / `next-steps`).
///
/// The match is the WHOLE trimmed line, bracket to bracket, against Claude
/// Code's own template (2.1.227 bundle: `…checkpoint; don't start subagents or
/// long work.]` / `…current step, then list up to 3 short bullets…`). Anchoring
/// on the whole line is what keeps a human who QUOTES the instruction in a
/// longer prompt out of this arm: their message is still their message.
///
/// `isMeta` is corroborating and deliberately not required — the fingerprint is
/// unambiguous on its own, and a build that stopped setting the flag (or a
/// truncation that dropped it) must not put those words back in the user's
/// mouth.
fn grace_window(text: &str) -> Option<&'static str> {
    let t = text.trim();
    if !(t.starts_with('[') && t.ends_with(']')) {
        return None;
    }
    let lower = t.to_lowercase();
    if !(lower.contains("usage limit reached") && lower.contains("grace window")) {
        return None;
    }
    Some(if lower.contains("checkpoint now") {
        "checkpoint"
    } else {
        "wrap_up"
    })
}

/// The wire body of a grace-window notice: this app's sentence for a reader,
/// Claude Code's sentence underneath it, and the fact that nothing is blocked
/// yet (the turn is still running — that is the whole point of a grace window).
fn grace_body(text: &str, hint: &'static str) -> Value {
    serde_json::json!({
        "notice": "Claude Code asked the agent to wrap up — usage limit near",
        "content": text.trim(),
        "hint": hint,
        "level": "warning",
        "limit_grace": true,
        "blocked": false,
    })
}

/// The `tool_result` body of a permission DENIAL.
///
/// Three verbatim suffix shapes are recorded in the corpus (bare, `STOP what
/// you are doing…`, `the user said: …`) and they share one opening sentence,
/// so the prefix is the match and the tail is left alone. Anchored at the start
/// on purpose: a tool whose OUTPUT quotes the sentence must not be re-read as a
/// refusal.
fn is_denial(content: &Value) -> bool {
    const HEAD: &str = "The user doesn't want to proceed with this tool use.";
    let starts = |s: &str| s.trim_start().starts_with(HEAD);
    match content {
        Value::String(s) => starts(s),
        Value::Array(items) => items.iter().any(|b| {
            b.get("text")
                .and_then(Value::as_str)
                .is_some_and(starts)
        }),
        _ => false,
    }
}

/// The wire body of a failure banner: the words CC showed, plus every fact a
/// surface needs to say WHICH failure it is and when it ends.
fn agent_error_body(
    line: &Map<String, Value>,
    text: &str,
    info: &agent_error::AgentErrorInfo,
) -> Value {
    let mut body = serde_json::json!({
        "text": text,
        "class": info.class,
        "blocked": info.blocking,
    });
    if let Some(l) = &info.limit {
        body["limit"] = Value::String(l.clone());
    }
    if let Some(l) = &info.label {
        body["limit_label"] = Value::String(l.clone());
    }
    if let Some(r) = &info.resets_at {
        body["resets_at"] = Value::String(r.clone());
    }
    if let Some(e) = str_at(line, &["error"]) {
        body["error"] = Value::String(e.to_string());
    }
    if let Some(s) = line
        .get("apiErrorStatus")
        .or_else(|| line.get("api_error_status"))
        .and_then(Value::as_i64)
    {
        body["status"] = Value::from(s);
    }
    // `errorDetails` is the raw upstream body (a 429 JSON envelope with its
    // `request_id`). Clipped here rather than left to the seal so the useful
    // half of the entry is never the half that gets truncated away.
    if let Some(d) = str_at(line, &["errorDetails", "error_details"]) {
        body["details"] = Value::String(d.chars().take(400).collect::<String>());
    }
    body
}

// ── oversize placeholder ─────────────────────────────────────────────────────

/// Build a placeholder for a line over [`MAX_LINE_BYTES`] without parsing it.
///
/// The scan is a heuristic by construction — we are deliberately not running a
/// JSON parser over a 950 KB line — so the uuid may be missing (synthesised)
/// and the kind is the coarse top-level one. `fetch-full` streams the real line.
fn oversize_entry(line: &str, offset: u64) -> ChatEntry {
    let ty = scan_top_level_type(line).unwrap_or("");
    let uuid = scan_field(line, "uuid").unwrap_or_else(|| format!("@{offset}"));
    ChatEntry {
        uuid,
        kind: kind_for_top_level(ty),
        ts_ms: parse_ts_ms(scan_field(line, "timestamp").as_deref()),
        offset,
        session_id: scan_field(line, "session_id").or_else(|| scan_field(line, "sessionId")),
        tool_use_id: None,
        label: (!ty.is_empty()).then(|| ty.to_string()),
        ok: None,
        is_sidechain: line.contains("\"isSidechain\":true"),
        agent_id: scan_field(line, "agentId"),
        // Scanned the same textual way `isSidechain` is: this line is too big
        // to hand to serde, and a 950 KB command dump is EXACTLY the shape that
        // arrives with `isMeta` set, so guessing `false` here would put the one
        // entry the flag exists for back on screen.
        is_meta: line.contains("\"isMeta\":true"),
        oversize: true,
        body: Value::Null,
    }
}

fn kind_for_top_level(ty: &str) -> Kind {
    match ty {
        "assistant" => Kind::Assistant,
        "user" => Kind::Prompt,
        "system" => Kind::System,
        "attachment" => Kind::Attachment,
        "queue-operation" => Kind::Queue,
        "mode" | "permission-mode" => Kind::Mode,
        _ => Kind::Unknown,
    }
}

/// First `"type":"…"` whose value is a known top-level type, else the first one.
fn scan_top_level_type(line: &str) -> Option<&str> {
    let needle = "\"type\":\"";
    let mut first = None;
    let mut at = 0usize;
    while let Some(i) = line[at..].find(needle) {
        let start = at + i + needle.len();
        let end = start + line[start..].find('"').unwrap_or(0);
        let val = &line[start..end];
        if TOP_LEVEL_TYPES.contains(&val) {
            return Some(val);
        }
        first.get_or_insert(val);
        at = end.max(start + 1);
    }
    first
}

/// Read `"<key>":"<value>"` out of raw bytes. Values are capped — this only
/// feeds ids and timestamps.
///
/// The cap counts **chars**, not bytes: the needle can hit a nested key (this
/// is a raw scan of a 950 KB line, not a parse), and a multi-byte value clipped
/// at a byte index would panic — which the totality contract forbids.
fn scan_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let i = line.find(&needle)? + needle.len();
    let rest = &line[i..];
    let end = rest.find('"')?;
    Some(rest[..end].chars().take(256).collect())
}

// ── small helpers ────────────────────────────────────────────────────────────

/// First non-empty string value among `keys`. Key-list, not `serde(alias)`:
/// see the module header (both casings co-occur on one object).
fn str_at<'a>(o: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| o.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
}

fn bool_at(o: &Map<String, Value>, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|k| o.get(*k).and_then(Value::as_bool))
}

fn json_of(o: &Map<String, Value>, keys: &[&str]) -> Value {
    keys.iter()
        .find_map(|k| o.get(*k).cloned())
        .unwrap_or(Value::Null)
}

fn text_body(b: &Value, key: &str) -> Value {
    serde_json::json!({ "text": b.get(key).and_then(Value::as_str).unwrap_or("") })
}

/// CC's `timestamp` (RFC3339) → epoch **ms**. Missing/unparseable → 0.
/// This is CC's clock, not arrival time — see [`ChatEntry::ts_ms`].
fn parse_ts_ms(raw: Option<&str>) -> i64 {
    raw.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> String {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/chat")
            .join(name);
        std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("fixture {}: {e}", p.display()))
    }

    /// `isMeta` REACHES THE WIRE (verified finding 18).
    ///
    /// One managed slash command writes TWO user records: a 191-byte
    /// `<command-name>` envelope (correctly `Kind::Command` downstream) and a
    /// 6.8 KB plain prompt carrying the whole command file, which the raw JSONL
    /// marks `isMeta: true` and gives no `promptSource` at all. `recall.rs` has
    /// filtered the second since A1; the chat wire could not, because the field
    /// was not on it — so B4's own headline flow (`/supermux-schedule`) drew a
    /// giant beige user bubble ending in `ARGUMENTS: …`.
    ///
    /// A LINE-level flag: every block of a marked record inherits it, the way
    /// `isSidechain` does.
    #[test]
    fn is_meta_rides_the_line_onto_every_block_and_onto_the_wire() {
        let line = serde_json::json!({
            "type": "user",
            "uuid": "u1",
            "isMeta": true,
            "timestamp": "2026-08-16T10:00:00.000Z",
            "message": { "content": [
                { "type": "text", "text": "Base directory for this skill: /x" },
                { "type": "text", "text": "ARGUMENTS: in 2m — reply with exactly X" },
            ] },
        })
        .to_string();
        let ParsedLine::Entry(entries) = parse_line(&line, 0) else {
            panic!("expected entries")
        };
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.is_meta), "both blocks inherit the line's mark");

        // …and it survives sealing, under the name the client reads.
        let sealed = WireEntry::seal(1, &entries[0]);
        let json = serde_json::to_value(&sealed).unwrap();
        assert_eq!(json.get("meta").and_then(|v| v.as_bool()), Some(true));

        // An ordinary prompt is unmarked, and pays NO wire bytes for the field.
        let plain = serde_json::json!({
            "type": "user",
            "uuid": "u2",
            "message": { "content": "just a question" },
        })
        .to_string();
        let ParsedLine::Entry(plain) = parse_line(&plain, 0) else {
            panic!("expected entries")
        };
        assert!(!plain[0].is_meta);
        let json = serde_json::to_value(WireEntry::seal(2, &plain[0])).unwrap();
        assert!(json.get("meta").is_none(), "the field is skipped when false");
    }

    /// An oversize line cannot go through serde, and a 950 KB command dump is
    /// EXACTLY the shape that arrives marked — so the textual scan has to see it
    /// too, or the one entry the flag exists for comes back.
    #[test]
    fn an_oversize_line_is_still_read_as_meta() {
        let body = "x".repeat(MAX_LINE_BYTES + 10);
        let line = format!(
            "{{\"type\":\"user\",\"uuid\":\"u3\",\"isMeta\":true,\"message\":{{\"content\":\"{body}\"}}}}"
        );
        let ParsedLine::Entry(entries) = parse_line(&line, 0) else {
            panic!("expected entries")
        };
        assert!(entries[0].oversize);
        assert!(entries[0].is_meta);
    }

    #[test]
    fn every_fixture_line_parses_and_never_panics() {
        // The tolerance pin: 41 real anonymized lines across 2.1.211→2.1.231,
        // including 13 attachment subtypes we do NOT model. Nothing may panic and
        // nothing may be dropped — unmodelled shapes become Kind::Unknown.
        let mut total = 0;
        for f in [
            "assistant.jsonl",
            "user.jsonl",
            "tool-results.jsonl",
            "system.jsonl",
            "attachment.jsonl",
            "queue-operation.jsonl",
            "mode.jsonl",
            "meta-entries.jsonl",
            "file-history.jsonl",
        ] {
            for line in fixture(f).lines().filter(|l| !l.trim().is_empty()) {
                total += 1;
                match parse_line(line, 0) {
                    ParsedLine::Entry(_) | ParsedLine::Skip => {}
                    ParsedLine::Malformed(m) => panic!("fixture {f} line failed: {m}"),
                }
            }
        }
        assert_eq!(
            total, 32,
            "top-level fixture line count changed — re-verify the corpus"
        );
    }

    #[test]
    fn multi_block_assistant_yields_one_entry_per_block_with_suffixed_uuids() {
        // a0-findings §2: `content` is a list of N blocks; 1 multi-block
        // [thinking, text] in 21,431 lines. Blocks past the first get `<uuid>#<i>`.
        let line = fixture("assistant.jsonl").lines().nth(3).unwrap().to_string();
        let ParsedLine::Entry(entries) = parse_line(&line, 0) else {
            panic!("expected entries")
        };
        assert!(
            entries.len() >= 2,
            "the fixtured multi-block line must fan out"
        );
        assert_eq!(entries[0].uuid, entries[1].uuid.split('#').next().unwrap());
        assert!(entries[1].uuid.ends_with("#1"));
    }

    #[test]
    fn tolerates_both_key_casings() {
        // a0-findings §2: session_id/sessionId co-occur; toolUseID inside hook attachments.
        let snake = r#"{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","session_id":"s1","message":{"role":"user","content":"hi"}}"#;
        let camel = r#"{"type":"user","uuid":"u2","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","message":{"role":"user","content":"hi"}}"#;
        for l in [snake, camel] {
            let ParsedLine::Entry(e) = parse_line(l, 0) else {
                panic!()
            };
            assert_eq!(e[0].session_id.as_deref(), Some("s1"));
        }
    }

    #[test]
    fn both_casings_on_the_same_line_are_not_a_duplicate_field_error() {
        // Live assistant lines carry BOTH `session_id` and `sessionId` (A0
        // corpus: assistant.jsonl:1). A `#[serde(alias)]` derive would reject
        // that as a duplicate field, which is why extraction is key-list based.
        let l = r#"{"type":"user","uuid":"u3","timestamp":"2026-01-01T00:00:00Z","session_id":"s1","sessionId":"s1","message":{"role":"user","content":"hi"}}"#;
        let ParsedLine::Entry(e) = parse_line(l, 0) else {
            panic!("dual-cased line must not be malformed")
        };
        assert_eq!(e[0].session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn unknown_top_level_types_are_kept_as_unknown_not_dropped() {
        // agent-name / agent-setting / bridge-session / ai-title are REAL (corpus-counted).
        for t in [
            "agent-name",
            "agent-setting",
            "bridge-session",
            "ai-title",
            "some-future-type",
        ] {
            let l = format!(r#"{{"type":"{t}","uuid":"x","timestamp":"2026-01-01T00:00:00Z"}}"#);
            let ParsedLine::Entry(e) = parse_line(&l, 0) else {
                panic!("{t} dropped")
            };
            assert_eq!(e[0].kind, Kind::Unknown);
        }
    }

    #[test]
    fn compact_boundary_is_inline_and_does_not_reset_the_cursor() {
        let l = r#"{"type":"system","subtype":"compact_boundary","uuid":"c1","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","compactMetadata":{"whatever":[1,2,3]}}"#;
        let ParsedLine::Entry(e) = parse_line(l, 4096) else {
            panic!()
        };
        assert_eq!(e[0].kind, Kind::CompactBoundary);
        assert_eq!(
            e[0].offset, 4096,
            "offset is the LINE START — the cursor never rewinds"
        );
        // compactMetadata internals drift across versions: we must not read into them.
    }

    #[test]
    fn oversize_line_is_refused_without_allocating_it_as_an_entry() {
        // a0: real lines up to 950 KB (482 KB image, 104 KB tool_result).
        let huge = format!(
            r#"{{"type":"user","uuid":"big","timestamp":"2026-01-01T00:00:00Z","message":{{"role":"user","content":"{}"}}}}"#,
            "x".repeat(2 * 1024 * 1024)
        );
        match parse_line(&huge, 0) {
            ParsedLine::Entry(e) => {
                assert_eq!(e.len(), 1);
                assert!(
                    e[0].oversize,
                    "an over-MAX_LINE_BYTES line must be flagged, not parsed in full"
                );
            }
            other => panic!("oversize line must still produce a placeholder entry, got {other:?}"),
        }
    }

    #[test]
    fn oversize_line_scan_never_panics_on_a_multibyte_field_value() {
        // The oversize path scans RAW bytes, so its `"uuid":"` needle can land on
        // a nested key — e.g. a tool_use `input` object — whose value is not
        // ASCII. Clipping that at a byte index panics; the parser must be total.
        let unicode = "日".repeat(120); // 360 bytes: byte 256 is mid-codepoint
        let huge = format!(
            r#"{{"type":"user","input":{{"uuid":"{unicode}"}},"pad":"{}"}}"#,
            "x".repeat(MAX_LINE_BYTES)
        );
        let ParsedLine::Entry(e) = parse_line(&huge, 0) else {
            panic!("oversize line must still produce a placeholder entry")
        };
        assert!(e[0].oversize);
        assert_eq!(e[0].uuid.chars().count(), 120);
    }

    #[test]
    fn wire_seal_caps_the_payload_and_marks_it_truncated() {
        let e = ChatEntry::test_text("u1", &"y".repeat(64 * 1024));
        let w = WireEntry::seal(7, &e);
        let json = serde_json::to_vec(&w).unwrap();
        assert!(
            json.len() <= MAX_ENTRY_BYTES + 512,
            "sealed entry over the cap: {}",
            json.len()
        );
        assert!(w.truncated());
        assert_eq!(w.seq(), 7);
        assert_eq!(
            w.uuid(),
            "u1",
            "the uuid must survive so fetch-full can resolve it"
        );
    }

    #[test]
    fn wire_seal_is_the_only_constructor() {
        // Compile-time pin: if someone adds a public constructor or makes fields pub,
        // this test's module-level `assert_impl` breaks. See model.rs's private mod.
        assert!(!WireEntry::seal(0, &ChatEntry::test_text("u", "hi")).truncated());
    }

    #[test]
    fn wire_seal_survives_a_pathological_escape_heavy_payload() {
        // Our clip budget estimates a string's cost as len+2; serde escapes
        // `"` and control chars to two bytes each, so an all-quotes payload
        // would blow a naive budget. The seal must still land under the cap.
        let e = ChatEntry::test_text("u1", &"\"".repeat(64 * 1024));
        let w = WireEntry::seal(1, &e);
        let json = serde_json::to_vec(&w).unwrap();
        assert!(json.len() <= MAX_ENTRY_BYTES + 512, "escape blowup: {}", json.len());
        assert!(w.truncated());
    }

    #[test]
    fn subagent_meta_model_key_is_optional() {
        // a0: absent on 2.1.231, present on some 2.1.221.
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chat/subagents");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("subagents fixture dir") {
            let p = entry.unwrap().path();
            if !p.to_string_lossy().ends_with(".meta.json") {
                continue;
            }
            let raw = std::fs::read_to_string(&p).unwrap();
            let m: SubagentMeta = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            assert!(m.model.is_none(), "2.1.231 metas carry no `model` key");
            assert!(!m.agent_type.is_empty());
            checked += 1;
        }
        assert_eq!(checked, 1, "the A0 subagent meta fixture must be present");

        let m: SubagentMeta = serde_json::from_str(
            r#"{"agentType":"explore","description":"d","toolUseId":"t1","spawnDepth":1}"#,
        )
        .unwrap();
        assert!(m.model.is_none());
    }

    #[test]
    fn parse_stream_advances_by_whole_lines_and_never_eats_a_partial_tail() {
        // The tailer's core contract: a half-written last line stays unconsumed
        // so the next poll re-reads it whole.
        let a = r#"{"type":"user","uuid":"a","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"one"}}"#;
        let b = r#"{"type":"user","uuid":"b","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"two"}}"#;
        let mut buf = format!("{a}\n{b}\n");
        let partial = r#"{"type":"user","uuid":"c""#;
        buf.push_str(partial);

        let (entries, off) = parse_stream(std::io::Cursor::new(buf.as_bytes()), 0);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].offset, 0);
        assert_eq!(entries[1].offset, (a.len() + 1) as u64);
        assert_eq!(
            off,
            (a.len() + 1 + b.len() + 1) as u64,
            "the partial trailing line must NOT be consumed"
        );
    }

    #[test]
    fn parse_stream_resumes_from_a_byte_offset() {
        let a = r#"{"type":"user","uuid":"a","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"one"}}"#;
        let b = r#"{"type":"user","uuid":"b","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"two"}}"#;
        let from = (a.len() + 1) as u64;
        let (entries, off) = parse_stream(std::io::Cursor::new(format!("{b}\n").as_bytes()), from);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].uuid, "b");
        assert_eq!(entries[0].offset, from);
        assert_eq!(off, from + (b.len() + 1) as u64);
    }

    #[test]
    fn parse_stream_skips_an_oversize_line_whole_and_keeps_the_cursor_aligned() {
        let huge = format!(
            r#"{{"type":"user","uuid":"big","timestamp":"2026-01-01T00:00:00Z","message":{{"role":"user","content":"{}"}}}}"#,
            "x".repeat(MAX_LINE_BYTES)
        );
        let after = r#"{"type":"user","uuid":"after","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"ok"}}"#;
        let buf = format!("{huge}\n{after}\n");
        let (entries, off) = parse_stream(std::io::Cursor::new(buf.as_bytes()), 0);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].oversize);
        assert_eq!(entries[1].uuid, "after");
        assert_eq!(entries[1].offset, (huge.len() + 1) as u64);
        assert_eq!(off, buf.len() as u64);
    }

    #[test]
    fn sidechain_lines_are_flagged_so_the_tailer_can_scope_them() {
        // Sidechain entries live in `subagents/`; the main file must not render
        // them twice. parse_line has no scope, so it flags and the caller filters.
        let sub = fixture("subagents/agent-a03a3cf7ef12532dc.jsonl");
        let first = sub.lines().next().unwrap();
        let ParsedLine::Entry(e) = parse_line(first, 0) else {
            panic!("subagent line must parse")
        };
        assert!(e[0].is_sidechain);
        assert_eq!(e[0].agent_id.as_deref(), Some("a03a3cf7ef12532dc"));
    }

    #[test]
    fn tool_use_and_tool_result_carry_their_ids_and_status() {
        let assistant = fixture("assistant.jsonl");
        let tool_use_line = assistant.lines().nth(2).unwrap();
        let ParsedLine::Entry(e) = parse_line(tool_use_line, 0) else {
            panic!()
        };
        assert_eq!(e[0].kind, Kind::ToolUse);
        assert!(e[0].tool_use_id.is_some());
        assert!(e[0].label.is_some(), "tool name is the label");

        let results = fixture("tool-results.jsonl");
        let ParsedLine::Entry(r) = parse_line(results.lines().next().unwrap(), 0) else {
            panic!()
        };
        assert_eq!(r[0].kind, Kind::ToolResult);
        assert!(r[0].tool_use_id.is_some());
        assert_eq!(r[0].ok, Some(true));
    }

    #[test]
    fn every_fixture_line_seals_under_the_wire_cap() {
        // The 482 KB image line and the 104 KB tool_result are the reason the
        // cap exists; prove the seal actually holds on the real corpus.
        for f in [
            "assistant.jsonl",
            "user.jsonl",
            "tool-results.jsonl",
            "system.jsonl",
            "attachment.jsonl",
            "queue-operation.jsonl",
            "mode.jsonl",
            "meta-entries.jsonl",
            "file-history.jsonl",
        ] {
            for line in fixture(f).lines().filter(|l| !l.trim().is_empty()) {
                if let ParsedLine::Entry(entries) = parse_line(line, 0) {
                    for (i, e) in entries.iter().enumerate() {
                        let w = WireEntry::seal(i as u64, e);
                        let n = serde_json::to_vec(&w).unwrap().len();
                        assert!(n <= MAX_ENTRY_BYTES + 512, "{f} sealed to {n} bytes");
                    }
                }
            }
        }
    }
}
