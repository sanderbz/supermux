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
                // NO silent drop. A newline-terminated line that is not
                // parseable JSON used to only debug-log and advance the cursor,
                // so a malformed blocked/error record vanished entirely and the
                // stated no-silent-loss / totality property was violated. Emit a
                // visible placeholder instead — the reader sees an 'unparseable
                // line' marker rather than a hole in the transcript.
                tracing::debug!(offset, error = %m, "malformed transcript line — emitting placeholder");
                if !sink(malformed_entry(&text, offset)) {
                    stop = true;
                }
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
                // THE FLAG HALF, at last (`recall.rs::classify_user` step 5).
                //
                // A user-role line whose `promptSource` is `"system"` was
                // INJECTED BY THE HARNESS. Nobody typed it, and the live chat
                // plane — unlike the older history plane, which has read this
                // flag for as long as `classify_user` has existed — read it as a
                // prompt and put Claude Code's own plumbing in the user's mouth.
                //
                // Claude Code 2.1.25x made that visible every time a background
                // agent finishes: it writes a `type:"user"` line with
                // `promptSource:"system"`, `origin:{kind:"task-notification"}`
                // and a `<task-notification>…</task-notification>` XML body, and
                // the chat drew that raw envelope as a message from the human
                // sitting in front of it. The terminal renders the same event as
                // one calm line (`● Agent "…" finished · 1m 45s`), which is what
                // this row is for.
                None => match harness_notice(line, text) {
                    Some((label, body)) => base.entry_at(i, Kind::System, body, Some(label)),
                    None => base.entry_at(i, Kind::Prompt, text_body(b, "text"), None),
                },
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
        // Inline: the file keeps going and so does the cursor.
        //
        // THREE FIELDS OF `compactMetadata`, and no more. The internals drift
        // across CC versions, so this reads the three that answer the reader's
        // only question — was this automatic, and how much went away — and reads
        // them DEFENSIVELY: each is optional, a missing or wrongly-typed one is
        // simply absent, and nothing downstream requires any of them. Rendered,
        // the row is the difference between "earlier turns are summarised" and
        // "…automatically · 1.0M → 17k tokens", which is the only thing that
        // explains why the model forgot something.
        let meta = obj.get("compactMetadata").and_then(Value::as_object);
        let mut body = serde_json::json!({ "content": str_at(obj, &["content"]) });
        if let Some(m) = meta {
            if let Some(t) = str_at(m, &["trigger"]) {
                body["trigger"] = Value::String(t.to_string());
            }
            if let Some(n) = m.get("preTokens").and_then(Value::as_i64) {
                body["pre_tokens"] = Value::from(n);
            }
            if let Some(n) = m.get("postTokens").and_then(Value::as_i64) {
                body["post_tokens"] = Value::from(n);
            }
        }
        return base.entry(Kind::CompactBoundary, body, Some(subtype));
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
            // WHICH retry this is. `stalled` is its own kind in CC's retry-banner
            // builder and it means something the other kinds do not: the request
            // was SENT and the stream never started, so there is no error to
            // report and nothing prints — the pty goes quiet and every surface
            // reads the turn as finished (catalog `err.stream_stalled`). A row
            // that says "API error · retrying" about it would be wrong twice
            // over: nothing errored, and the turn is still live.
            for key in ["kind", "retryKind", "retry_kind"] {
                if let Some(k) = err
                    .and_then(|e| e.get(key))
                    .and_then(Value::as_str)
                    .or_else(|| str_at(obj, &[key]))
                {
                    body["retry_kind"] = Value::String(k.to_string());
                    break;
                }
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
    // THE RETRACTION, and why it is read on EVERY subtype rather than one.
    //
    // `retractedMessageUuids` rides on the refusal-fallback payload (catalog
    // `err.refusal_fallback_dialog`): once the user answers that dialog, the
    // assistant messages Claude Code already streamed are withdrawn — they were
    // produced by a prompt its safeguards flagged, and they are no longer part
    // of the conversation the model will see. A renderer that keeps drawing them
    // as live is showing text nobody will act on, attributed to Claude, in a
    // thread that has moved on.
    //
    // It is read subtype-agnostically because the FIELD is the contract and the
    // subtype is not: this app has never captured the line that carries it, only
    // the payload shape, and CC has shipped the same field under
    // `model_refusal_fallback`, `request_user_dialog` and a bare `refusal`
    // depending on which half of the flow writes it. An unknown subtype carrying
    // the field is exactly the case worth surviving.
    //
    // Nothing is deleted or rewritten here — the transcript is append-only and
    // so is the wire. This entry NAMES the uuids; `wire-entries.ts` collapses
    // those rows behind a tombstone when it folds the ring for display, which is
    // recomputed from the same append-only list every time.
    if let Some(uuids) = retracted_uuids(obj) {
        body["retracted"] = Value::Array(uuids);
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

/// A user-role line the HARNESS wrote, not the human — the flag half of
/// `recall.rs::classify_user` (step 5), ported to the live chat plane.
///
/// Returns `(label, body)` for a line to be published as [`Kind::System`], or
/// `None` for a real prompt.
///
/// TWO SIGNALS, EITHER ONE SUFFICIENT, because Claude Code sets them in
/// different releases: `promptSource: "system"` (present since ~2.1.20x) and
/// `origin: {kind: "…"}` (2.1.24x+). `origin.kind: "human"` is the harness
/// saying a person typed it, so it is never a notice; every other non-human
/// origin is plumbing.
///
/// SUPERMUX'S OWN WRAPPERS ARE NEVER SWALLOWED. A delegation, a colleague's
/// message and a scheduled fire are all typed into the pty, so Claude Code
/// stamps them `promptSource: "typed"` and they never reach here — but the
/// refusal is written down rather than assumed, because a future send path that
/// injected instead of typing would otherwise make every teammate message
/// vanish into a grey system row. `classify_by_wrapper` outranking the system
/// bucket is exactly the shape `recall.rs` already has.
fn harness_notice(line: &Map<String, Value>, text: &str) -> Option<(&'static str, Value)> {
    let origin_kind = line
        .get("origin")
        .and_then(Value::as_object)
        .and_then(|o| str_at(o, &["kind"]));
    // AN ORIGIN THAT NAMES A SPEAKER IS NEVER PLUMBING, whatever else the line
    // says. `human` is Claude Code stating a person typed it; `peer` is ANOTHER
    // CLAUDE SESSION's message, which arrives as `Another Claude session sent a
    // message:` + `<teammate-message>` blocks and is this app's whole bot-mode
    // group chat (`wire-entries.ts` intercepts it as `teammate`/`coordination`
    // rows before `classifyPrompt` ever runs). Observed on this host carrying
    // `isMeta: true` and NO `promptSource` — so an arm that keyed on "any
    // non-human origin" would have turned every teammate message into a grey
    // notice. The allow-list is inverted for exactly that reason: only signals
    // that positively mean HARNESS count.
    if matches!(origin_kind, Some("human") | Some("peer")) {
        return None;
    }
    let system_source = str_at(line, &["promptSource", "prompt_source"]) == Some("system");
    let task_notification = origin_kind == Some("task-notification")
        || text.trim_start().starts_with("<task-notification");
    if !system_source && !task_notification {
        return None;
    }
    // …and neither is a line that speaks FOR somebody: supermux's own
    // authorship wrappers, and the cross-session envelope above.
    if speaks_for_somebody(text) {
        return None;
    }
    if task_notification {
        return Some(("agent_notification", task_notification_body(text)));
    }
    Some((
        "harness_notice",
        serde_json::json!({
            "notice": "Claude Code injected this into the conversation",
            "content": text.trim(),
            "level": "info",
            "origin": origin_kind,
        }),
    ))
}

/// Does `text` carry an AUTHORSHIP claim — somebody's message, wrapped?
///
/// Two families, both of which outrank the harness bucket:
///   · supermux's own `<supermux-delegation>` / `<supermux-human>` /
///     `<supermux-schedule>` wrappers, which are the only thing standing between
///     a colleague's name and a faceless row, and
///   · Claude Code's cross-session envelope (`Another Claude session sent a
///     message:` + `<teammate-message>` / `<cross-session-message>` blocks) —
///     the transport this app's company group chat runs on.
///
/// `recall.rs::classify_user` reaches the same verdict by letting
/// `classify_by_wrapper` outrank `promptSource: "system"`; this is that rule,
/// stated for the live plane.
fn speaks_for_somebody(text: &str) -> bool {
    if crate::agents::delegate::wrapper_markup(text) {
        return true;
    }
    let head = &text[..text.len().min(4096)];
    head.contains("<teammate-message")
        || head.contains("<cross-session-message")
        || head.contains("Another Claude session sent a message")
}

/// The wire body of a background-agent completion notice.
///
/// The XML envelope is Claude Code's message TO THE MODEL — an id, a path, a
/// status and a one-line summary — and the only parts a reader wants are the
/// last two. They are pulled out defensively (a missing or reshaped tag simply
/// goes absent) and the raw envelope is kept alongside them, so a build that
/// renames a tag degrades to "the notice, verbatim" rather than to nothing.
fn task_notification_body(text: &str) -> Value {
    let mut body = serde_json::json!({
        "notice": "A background agent finished",
        "content": text.trim(),
        "level": "info",
        "task_notification": true,
    });
    for (tag, key) in [("summary", "summary"), ("status", "status"), ("task-id", "task_id")] {
        if let Some(v) = xml_tag(text, tag) {
            body[key] = Value::String(v);
        }
    }
    body
}

/// The text between `<tag>` and `</tag>`, trimmed. First occurrence only, and
/// `None` for anything that is not a well-formed pair — this reads a fixed
/// envelope, it is not an XML parser.
fn xml_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    let inner = text[start..end].trim();
    (!inner.is_empty()).then(|| inner.to_string())
}

/// The uuids a system line says are withdrawn, as a non-empty array of strings.
fn retracted_uuids(obj: &Map<String, Value>) -> Option<Vec<Value>> {
    let raw = obj
        .get("retractedMessageUuids")
        .or_else(|| obj.get("retracted_message_uuids"))
        .or_else(|| obj.get("retractedMessageIds"))?
        .as_array()?;
    let uuids: Vec<Value> = raw
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| Value::String(s.to_string()))
        .collect();
    (!uuids.is_empty()).then_some(uuids)
}

/// The `tool_result` body of a permission DENIAL.
///
/// Three verbatim suffix shapes are recorded in the corpus (bare, `STOP what
/// you are doing…`, `the user said: …`) and they share one opening sentence,
/// so the prefix is the match and the tail is left alone. Anchored at the start
/// on purpose: a tool whose OUTPUT quotes the sentence must not be re-read as a
/// refusal.
fn is_denial(content: &Value) -> bool {
    // Match on a NORMALIZED sentence, not a byte-exact ASCII one. Two things
    // legitimately vary between a test fixture and Claude Code's live copy:
    // letter case, and the apostrophe glyph — CC's UI renders a curly U+2019, so
    // a straight-ASCII `starts_with` silently fails and a refusal is recorded as
    // a SUCCESS (`ok=true`), drawing a green tick next to a declined action.
    // Still anchored at the start: a tool whose OUTPUT quotes the sentence must
    // not be re-read as a refusal.
    const HEAD: &str = "the user doesn't want to proceed with this tool use.";
    let starts = |s: &str| normalize_denial(s.trim_start()).starts_with(HEAD);
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

/// Fold a candidate refusal prefix to lowercase ASCII with a straight
/// apostrophe, so case changes and CC's curly `’` (U+2019) do not defeat the
/// match. Bounded to the sentence length — only the prefix is compared.
fn normalize_denial(s: &str) -> String {
    s.chars()
        .take(80)
        .map(|c| match c {
            '\u{2019}' | '\u{2018}' | '\u{02BC}' => '\'',
            other => other.to_ascii_lowercase(),
        })
        .collect()
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

    // A blocked/failed assistant record must stay blocked even when oversized.
    // The reduction below would otherwise collapse an `isApiErrorMessage` /
    // `error:"rate_limit"` banner (whose `errorDetails` or text pushed it over
    // the cap) into an ordinary `Kind::Assistant` with a null body — losing the
    // class, the `blocked` bit and the reset clause, so a quota-blocked session
    // renders healthy. Classify from the raw bytes FIRST and carry those bits
    // across the size-truncation reduction (fetch-full still streams the rest).
    if ty == "assistant" {
        if let Some(info) = agent_error::from_oversize_line(line) {
            let text = scan_field(line, "text").unwrap_or_default();
            return ChatEntry {
                uuid,
                kind: Kind::AgentError,
                ts_ms: parse_ts_ms(scan_field(line, "timestamp").as_deref()),
                offset,
                session_id: scan_field(line, "session_id").or_else(|| scan_field(line, "sessionId")),
                tool_use_id: None,
                label: Some(info.class.clone()),
                // A banner is never a success — same as the parsed path.
                ok: Some(false),
                is_sidechain: line.contains("\"isSidechain\":true"),
                agent_id: scan_field(line, "agentId"),
                is_meta: line.contains("\"isMeta\":true"),
                oversize: true,
                body: oversize_agent_error_body(&text, &info),
            };
        }
    }

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

/// The blocking bits an oversized failure banner must carry across the
/// size-truncation reduction. Deliberately small — the full line is still
/// streamable via fetch-full — but it names the class, the reset clause and,
/// above all, the `blocked` bit the composer/attention gate reads. Mirrors
/// [`agent_error_body`] for the parsed path.
fn oversize_agent_error_body(text: &str, info: &agent_error::AgentErrorInfo) -> Value {
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
    body
}

/// A visible placeholder for a newline-terminated line that is not parseable
/// JSON (or whose top-level value is not an object). The totality contract
/// forbids a silent drop: without this the cursor advances past the line and a
/// malformed blocked/error record disappears with no trace on the wire. The
/// renderer shows an 'unparseable line' marker; `fetch-full` can still stream
/// the raw bytes for anyone who needs to inspect them.
fn malformed_entry(text: &str, offset: u64) -> ChatEntry {
    // Best-effort id/timestamp recovery so a partially-corrupt line still
    // threads the ring in order; the scan never parses, mirroring the oversize
    // path. A bounded preview lets the reader see WHAT failed.
    let uuid = scan_field(text, "uuid").unwrap_or_else(|| format!("@{offset}"));
    let preview: String = text.chars().take(200).collect();
    ChatEntry {
        uuid,
        kind: Kind::Unknown,
        ts_ms: parse_ts_ms(scan_field(text, "timestamp").as_deref()),
        offset,
        session_id: None,
        tool_use_id: None,
        label: Some("unparseable".to_string()),
        ok: None,
        is_sidechain: false,
        agent_id: None,
        is_meta: false,
        oversize: false,
        body: serde_json::json!({ "unparseable": true, "preview": preview }),
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
        // Unknown metadata shapes are ignored, not guessed at: only the three
        // named fields below are ever read.
        assert!(e[0].body.get("trigger").is_none());
    }

    #[test]
    fn compact_boundary_carries_the_trigger_and_the_token_counts() {
        // WHY THE NUMBERS TRAVEL. Without them the row says "Conversation
        // compacted" and nothing else — it cannot say whether the user asked for
        // it or the context filled up, nor how much history went away, which is
        // the only thing that explains why the model forgot something.
        let l = r#"{"type":"system","subtype":"compact_boundary","uuid":"c2","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","compactMetadata":{"trigger":"auto","preTokens":999996,"postTokens":16752,"cumulativeDroppedTokens":983244,"durationMs":41}}"#;
        let ParsedLine::Entry(e) = parse_line(l, 0) else {
            panic!()
        };
        assert_eq!(e[0].kind, Kind::CompactBoundary);
        assert_eq!(e[0].body["trigger"], "auto");
        assert_eq!(e[0].body["pre_tokens"], 999_996);
        assert_eq!(e[0].body["post_tokens"], 16_752);
        // The fields this reader does not claim to understand stay unread.
        assert!(e[0].body.get("durationMs").is_none());
    }

    #[test]
    fn compact_boundary_metadata_is_optional_and_typed() {
        // A CC version that renames a field, or ships a string where a number
        // was, must produce a row with less on it — never a parse failure and
        // never a wrong number.
        let l = r#"{"type":"system","subtype":"compact_boundary","uuid":"c3","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","compactMetadata":{"trigger":"manual","preTokens":"lots"}}"#;
        let ParsedLine::Entry(e) = parse_line(l, 0) else {
            panic!()
        };
        assert_eq!(e[0].body["trigger"], "manual");
        assert!(e[0].body.get("pre_tokens").is_none());
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
    fn an_oversized_assistant_failure_stays_blocked_not_healthy_prose() {
        // #7 (HIGH): an `isApiErrorMessage` / `error:"rate_limit"` banner whose
        // `errorDetails` pushes the line over MAX_LINE_BYTES used to collapse to
        // an ordinary `Kind::Assistant` with a null body — byte-identical to
        // prose — so a quota-blocked session rendered healthy. The blocked bits
        // must survive the size-truncation reduction.
        let banner = "You've hit your session limit · resets 4:40am (Europe/Amsterdam)";
        let huge = format!(
            r#"{{"type":"assistant","uuid":"blk","timestamp":"2026-01-01T00:00:00Z","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"message":{{"role":"assistant","content":[{{"type":"text","text":"{banner}"}}]}},"errorDetails":"{}"}}"#,
            "x".repeat(MAX_LINE_BYTES)
        );
        assert!(huge.len() > MAX_LINE_BYTES, "line must actually be oversized");
        let ParsedLine::Entry(e) = parse_line(&huge, 0) else {
            panic!("oversize line must still produce a placeholder entry")
        };
        assert_eq!(e.len(), 1);
        let e = &e[0];
        assert!(e.oversize, "still oversized — fetch-full streams the full line");
        assert_eq!(e.kind, Kind::AgentError, "must NOT degrade to Kind::Assistant");
        assert_eq!(e.ok, Some(false), "a banner is never a success");
        assert_eq!(e.uuid, "blk", "the real uuid must survive for fetch-full");
        assert_eq!(
            e.body.get("blocked").and_then(Value::as_bool),
            Some(true),
            "the composer/attention gate reads body.blocked"
        );
        assert_eq!(e.body.get("class").and_then(Value::as_str), Some("limit"));
        assert_eq!(e.body.get("limit").and_then(Value::as_str), Some("session_5h"));
        assert_eq!(
            e.body.get("resets_at").and_then(Value::as_str),
            Some("4:40am (Europe/Amsterdam)"),
            "the reset clause is the whole 'when can I work again' answer"
        );
    }

    #[test]
    fn an_oversized_ordinary_assistant_line_is_not_falsely_blocked() {
        // The failure fast-path must NOT fire on prose: no error discriminators,
        // so it stays the coarse placeholder with a null body.
        let huge = format!(
            r#"{{"type":"assistant","uuid":"ok","timestamp":"2026-01-01T00:00:00Z","message":{{"role":"assistant","content":[{{"type":"text","text":"here is a very long answer {}"}}]}}}}"#,
            "x".repeat(MAX_LINE_BYTES)
        );
        let ParsedLine::Entry(e) = parse_line(&huge, 0) else {
            panic!("oversize line must still produce a placeholder entry")
        };
        assert_eq!(e[0].kind, Kind::Assistant);
        assert!(e[0].oversize);
        assert!(e[0].body.is_null(), "ordinary prose keeps a null oversize body");
        assert_eq!(e[0].ok, None);
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

    // NOTE: "seal is the only constructor" is a property of `model.rs`'s private
    // `mod sealed` — every field is `pub(super)`, so the compiler is the pin.
    // There is no test that can fail for it; a real pin would be a trybuild
    // compile-fail case, not an assertion here.

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
    fn a_malformed_complete_line_emits_a_placeholder_and_is_never_silently_dropped() {
        // #14 (LOW): a newline-terminated line that is not parseable JSON used to
        // only debug-log and advance the cursor, so a malformed blocked/error
        // record vanished with no trace on the wire. The no-silent-loss property
        // requires a visible placeholder, and the cursor must still advance past
        // the good line that follows.
        let bad = r#"{"type":"assistant" NOT JSON blocked=true"#;
        let good = r#"{"type":"user","uuid":"after","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"ok"}}"#;
        let buf = format!("{bad}\n{good}\n");
        let (entries, off) = parse_stream(std::io::Cursor::new(buf.as_bytes()), 0);
        assert_eq!(entries.len(), 2, "the malformed line must still yield an entry");
        assert_eq!(entries[0].kind, Kind::Unknown);
        assert_eq!(entries[0].label.as_deref(), Some("unparseable"));
        assert_eq!(
            entries[0].body.get("unparseable").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(entries[0].offset, 0);
        assert_eq!(entries[1].uuid, "after");
        assert_eq!(entries[1].offset, (bad.len() + 1) as u64);
        assert_eq!(off, buf.len() as u64, "cursor stays aligned past both lines");
    }

    #[test]
    fn a_curly_apostrophe_or_uppercased_refusal_is_still_a_denial_not_a_success() {
        // #15 (LOW): denial detection was byte-exact ASCII, so CC's live copy —
        // which renders a curly U+2019 apostrophe — fell through as ok=true and
        // a declined action got a green success tick. Case and apostrophe glyph
        // must not defeat the match.
        let make = |content: &str| {
            format!(
                r#"{{"type":"user","uuid":"d","timestamp":"2026-01-01T00:00:00Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","content":"{content}"}}]}}}}"#
            )
        };
        // Curly apostrophe (U+2019) — the exact glyph CC's UI emits.
        let curly = make("The user doesn\u{2019}t want to proceed with this tool use.");
        let ParsedLine::Entry(e) = parse_line(&curly, 0) else {
            panic!("must parse")
        };
        assert_eq!(e[0].label.as_deref(), Some("denied"), "curly apostrophe refusal");
        assert_eq!(e[0].ok, Some(false), "a refusal is never a success");

        // Case change in the copy.
        let upper = make("THE USER DOESN'T WANT TO PROCEED WITH THIS TOOL USE. Stopped.");
        let ParsedLine::Entry(e) = parse_line(&upper, 0) else {
            panic!("must parse")
        };
        assert_eq!(e[0].label.as_deref(), Some("denied"), "uppercased refusal");
        assert_eq!(e[0].ok, Some(false));

        // Anchoring preserved: a tool OUTPUT that merely quotes the sentence
        // partway through is NOT a refusal.
        let quoting = make("Docs say: the user doesn't want to proceed with this tool use.");
        let ParsedLine::Entry(e) = parse_line(&quoting, 0) else {
            panic!("must parse")
        };
        assert_ne!(e[0].label.as_deref(), Some("denied"), "mid-string quote is not a denial");
        assert_eq!(e[0].ok, Some(true));
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

    // ── background agents on Claude Code 2.1.25x ────────────────────────────
    //
    // Every line in `background-agent.jsonl` was captured live on this host on
    // 2026-09-02 from cc 2.1.258, driving a real session through
    // `POST /api/sessions/{name}/send`, and anonymized the way the rest of the
    // corpus is (paths, ids and the conversation uuid are synthetic; every
    // enum-like value, key and shape is verbatim).

    /// THE `task-notification` IS NOT A PROMPT.
    ///
    /// This is the line that put Claude Code's plumbing in the user's mouth: a
    /// `type:"user"` record carrying a `<task-notification>` XML envelope, which
    /// the live chat plane drew as a message from the human. Claude Code marks it
    /// twice — `promptSource: "system"` and `origin: {kind: "task-notification"}`
    /// — and `recall.rs::classify_user` has read the first of those for years.
    #[test]
    fn task_notification_is_a_system_row_not_a_user_prompt() {
        let line = fixture("background-agent.jsonl")
            .lines()
            .find(|l| l.contains("task-notification"))
            .expect("fixture carries the notification line")
            .to_string();
        let ParsedLine::Entry(entries) = parse_line(&line, 0) else {
            panic!("notification line must parse");
        };
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.kind, Kind::System, "a harness injection is never a prompt");
        assert_eq!(e.label.as_deref(), Some("agent_notification"));
        // The two fields a reader wants, lifted out of the envelope…
        assert_eq!(
            e.body["summary"].as_str(),
            Some("Agent \"Count words in note file\" finished")
        );
        assert_eq!(e.body["status"].as_str(), Some("completed"));
        // …and the envelope kept whole underneath them.
        assert!(e.body["content"].as_str().unwrap().starts_with("<task-notification>"));
    }

    /// The rest of the turn is untouched: the `Agent` call and its launch
    /// receipt are an ordinary `tool_use`/`tool_result` pair, and BOTH confirm.
    /// This is the half of the reported bug that turned out to be sound, and it
    /// is pinned so a later change to the notification arm cannot break it.
    #[test]
    fn a_backgrounded_agent_call_confirms_as_tool_use_and_result() {
        let lines: Vec<String> = fixture("background-agent.jsonl")
            .lines()
            .map(str::to_string)
            .collect();
        let ParsedLine::Entry(call) = parse_line(&lines[0], 0) else {
            panic!("tool_use line must parse")
        };
        assert_eq!(call[0].kind, Kind::ToolUse);
        assert_eq!(call[0].label.as_deref(), Some("Agent"));
        // `caller` is new on the block in 2.1.25x and must not disturb the id.
        assert_eq!(call[0].tool_use_id.as_deref(), Some("toolu_01AAAAAAAAAAAAAAAAAAAAAA"));

        let ParsedLine::Entry(receipt) = parse_line(&lines[1], 0) else {
            panic!("tool_result line must parse")
        };
        assert_eq!(receipt[0].kind, Kind::ToolResult);
        assert_eq!(receipt[0].ok, Some(true));
        assert_eq!(receipt[0].tool_use_id.as_deref(), Some("toolu_01AAAAAAAAAAAAAAAAAAAAAA"));
    }

    /// `origin.kind: "human"` is Claude Code SAYING a person typed it, so it
    /// outranks everything: a prompt that happens to open with `<` is still a
    /// prompt. Without this the flag half would swallow real messages.
    #[test]
    fn origin_human_is_always_a_prompt() {
        let line = serde_json::json!({
            "type": "user",
            "uuid": "u-human",
            "origin": { "kind": "human" },
            "message": { "role": "user", "content": "<not-a-tag> just a message" },
        });
        let ParsedLine::Entry(entries) = parse_line(&line.to_string(), 0) else {
            panic!("must parse")
        };
        assert_eq!(entries[0].kind, Kind::Prompt);
    }

    /// SUPERMUX'S OWN WRAPPERS SURVIVE. A delegation, a colleague's message and
    /// a scheduled fire are AUTHORSHIP CLAIMS this surface renders as people;
    /// swallowing one into a grey harness row would erase the sender. They are
    /// typed into the pty (so cc stamps them `"typed"` and they never reach the
    /// arm at all) — this pins the refusal anyway, because the day a send path
    /// injects instead of typing is not the day to discover it.
    #[test]
    fn a_supermux_wrapper_is_never_swallowed_by_the_harness_arm() {
        let line = serde_json::json!({
            "type": "user",
            "uuid": "u-wrap",
            "promptSource": "system",
            "message": {
                "role": "user",
                "content": "<supermux-human from=\"sam\">hello</supermux-human>",
            },
        });
        let ParsedLine::Entry(entries) = parse_line(&line.to_string(), 0) else {
            panic!("must parse")
        };
        assert_eq!(entries[0].kind, Kind::Prompt, "authorship wrappers stay prompts");
    }

    /// A CROSS-SESSION TEAMMATE MESSAGE IS SOMEBODY SPEAKING.
    ///
    /// Claude Code delivers another session's message as a user-role line with
    /// `origin:{kind:"peer"}` and `isMeta:true` — and, on this host's corpus, NO
    /// `promptSource` at all. It is the transport this app's company group chat
    /// runs on: `wire-entries.ts` intercepts the envelope and renders
    /// `teammate`/`coordination` rows from it. An arm that read "any non-human
    /// origin is plumbing" would have turned every teammate message into a grey
    /// harness notice — a whole feature, silently faceless. Pinned both ways:
    /// by the origin, and by the envelope on its own.
    #[test]
    fn a_cross_session_teammate_message_is_never_a_harness_notice() {
        for line in [
            serde_json::json!({
                "type": "user",
                "uuid": "u-peer",
                "isMeta": true,
                "origin": { "kind": "peer", "name": "keuze-agent" },
                "message": {
                    "role": "user",
                    "content": "Another Claude session sent a message:\n<teammate-message teammate_id=\"keuze-agent\">{}</teammate-message>",
                },
            }),
            // The same envelope, this time WITH the system stamp — the belt to
            // the origin's braces.
            serde_json::json!({
                "type": "user",
                "uuid": "u-peer2",
                "promptSource": "system",
                "message": {
                    "role": "user",
                    "content": "Another Claude session sent a message:\n<teammate-message teammate_id=\"keuze-agent\">{}</teammate-message>",
                },
            }),
        ] {
            let ParsedLine::Entry(entries) = parse_line(&line.to_string(), 0) else {
                panic!("must parse")
            };
            assert_eq!(
                entries[0].kind,
                Kind::Prompt,
                "a teammate's message must reach the coordination arm intact",
            );
        }
    }

    /// A `promptSource: "system"` line with no recognised envelope is still not
    /// a prompt — it is a notice, and it says so.
    #[test]
    fn a_bare_system_injection_becomes_a_harness_notice() {
        let line = serde_json::json!({
            "type": "user",
            "uuid": "u-inj",
            "promptSource": "system",
            "message": { "role": "user", "content": "Caveat: the messages below were generated…" },
        });
        let ParsedLine::Entry(entries) = parse_line(&line.to_string(), 0) else {
            panic!("must parse")
        };
        assert_eq!(entries[0].kind, Kind::System);
        assert_eq!(entries[0].label.as_deref(), Some("harness_notice"));
    }

    /// THE GRACE WINDOW KEEPS ITS OWN NAME. It is also a system injection, and
    /// it also carries `promptSource: "system"` — but it has a reset clause and
    /// a renderer arm of its own, so the more specific arm must win.
    #[test]
    fn the_grace_window_still_outranks_the_generic_harness_arm() {
        let line = serde_json::json!({
            "type": "user",
            "uuid": "u-grace",
            "promptSource": "system",
            "message": {
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "[Usage limit reached — grace window active. Wrap up your current work.]",
                }],
            },
        });
        let ParsedLine::Entry(entries) = parse_line(&line.to_string(), 0) else {
            panic!("must parse")
        };
        assert_eq!(entries[0].kind, Kind::System);
        assert_eq!(entries[0].label.as_deref(), Some("limit_grace"));
    }

    /// An unknown assistant BLOCK type never stalls the line or swallows its
    /// siblings: it becomes an addressable `unknown` entry beside them. cc keeps
    /// inventing these (`fallback`, and whatever a patch release adds next).
    #[test]
    fn an_unknown_block_type_is_kept_beside_its_siblings() {
        let line = serde_json::json!({
            "type": "assistant",
            "uuid": "a-mixed",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "fallback", "from": { "model": "claude-fable-5" }, "to": { "model": "claude-opus-5" } },
                    { "type": "text", "text": "and here is the answer" },
                ],
            },
        });
        let ParsedLine::Entry(entries) = parse_line(&line.to_string(), 0) else {
            panic!("must parse")
        };
        assert_eq!(entries.len(), 2, "the unknown block must not eat the text one");
        assert_eq!(entries[0].kind, Kind::Unknown);
        assert_eq!(entries[0].label.as_deref(), Some("fallback"));
        assert_eq!(entries[1].kind, Kind::Assistant);
        assert_eq!(entries[1].body["text"].as_str(), Some("and here is the answer"));
    }
}
