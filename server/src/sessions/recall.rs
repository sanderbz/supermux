//! Rich prompt history for the focus-mode recall popover.
//!
//! Surfaces a paginated, searchable list of the user's past prompts (and the
//! assistant's first-line reply) by streaming Claude Code's own on-disk JSONL
//! transcripts. The single-prompt recall (`last_send_text` on the session
//! row) is unchanged; this endpoint is what the popover lazy-loads when the
//! user opens it.
//!
//! Reuses [`super::resumable`]'s `claude_config_dir()` + `project_dir_for()`
//! helpers and its streaming-parse-with-substring-gate pattern. The on-disk
//! work runs under `spawn_blocking` — same shape as the resumable list at
//! `sessions::mod::resumable_list_handler` — so the async runtime stays cool
//! even on multi-MB transcripts.

mod codex;

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::agents::delegate::DELEGATION_TAG;
use crate::scheduler::runner::{unescape_attr, CONFIRM_FOOTER_SENTINEL, SCHEDULE_TAG};
use crate::db;
use crate::error::AppError;
use crate::state::AppState;
use crate::ws::sanitise_text;

use super::resumable;

/// Cap on the per-entry prompt text. Mirrors `db::sessions::LAST_SEND_TEXT_MAX_CHARS`
/// — same shape as the bar/popover already render today.
const PROMPT_MAX_CHARS: usize = 8_000;
/// Cap on an ASSISTANT entry's prose in the chat view. The prompt cap above is
/// a PREVIEW budget for the recall popover; the chat view renders the message
/// itself, so reusing 8 000 silently cut real answers mid-word (assistant text
/// blocks over that length exist in this host's own transcripts). Wide enough
/// that no realistic answer is touched, still bounded so one pathological
/// block cannot define the response size. Whenever it does bite, the entry
/// carries `truncated: true` so the client can say so instead of pretending
/// the message ended there.
const ASSISTANT_MAX_CHARS: usize = 64_000;
/// Cap on the reply preview. Big enough for `line-clamp-3` on the widest popover.
const REPLY_MAX_CHARS: usize = 600;
/// Hard cap on the user-requested `limit`. Keeps a single response bounded
/// regardless of malicious or buggy clients.
const LIMIT_MAX: usize = 100;
/// Default page size when the client does not specify one.
const LIMIT_DEFAULT: usize = 20;

// ── wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Session,
    Project,
}

#[derive(Debug, Deserialize)]
pub struct RecallQuery {
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub include_sidechains: bool,
    /// When `false` (default) the response only includes user-initiated turns
    /// (prompts, slash commands, teammate routing). When `true` we also
    /// include harness-injected events (`<task-notification>`,
    /// `<system-reminder>`, tool results, …) so power users can audit the
    /// full conversation flow.
    #[serde(default)]
    pub include_system_events: bool,
    /// Chat view (fase A1): emit the full-fidelity chronological tail — user
    /// prompts + assistant `text` blocks (FULL text, not the 600-char reply
    /// preview) + `tool_use`/`tool_result` pairs — instead of the legacy
    /// prompt+reply pairing. Additive: absent/false keeps the popover shape
    /// byte-identical.
    #[serde(default)]
    pub chat: bool,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    LIMIT_DEFAULT
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RecallEntry {
    pub uuid: String,
    pub ts: i64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sessionTitle", skip_serializing_if = "Option::is_none")]
    pub session_title: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    pub sidechain: bool,
    /// Classifier for what kind of "user" turn this is. Drives the badge
    /// in the recall popover and the default include/exclude filter.
    pub kind: Kind,
    /// Optional kind-specific label (slash name, teammate id, etc). Free-form
    /// so future wrappers can carry their own short identifier without a
    /// schema migration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Chat view only: success flag of the paired `tool_result` (`Some(false)`
    /// = `is_error`). `None` until the result lands / for non-tool entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    /// `Some(true)` when `text` was clipped by the wire cap. Absent (the
    /// common case) means the text is complete. The client renders a marker;
    /// without it a clipped message is indistinguishable from one that simply
    /// ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// What flavour of "user" turn the transcript line represents. The JSONL
/// stores all of these as `role: "user"`, but Claude Code injects synthetic
/// turns for tool results, slash-command echoes, harness reminders, and
/// background-agent completions — none of which the user typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The human typed this (or it's prose with no harness marker).
    Prompt,
    /// `<command-name>/slash</command-name>` echo from a slash invocation.
    Command,
    /// `<teammate-message teammate_id="…">…</teammate-message>` routing
    /// envelope from the supermux teammate fleet.
    Teammate,
    /// `<task-notification>…</task-notification>` background subagent
    /// completion event.
    Notification,
    /// supermux delegate delivery — `<supermux-delegation from>` wrapper.
    /// `label` is the sending session's slug.
    Delegation,
    /// supermux scheduled delivery — `<supermux-schedule id title>` wrapper.
    /// `label` is the schedule's title. The schedule is its own speaker in the
    /// transcript: a 03:00 fire is not the owner typing at 03:00.
    Schedule,
    /// Harness reminders, command caveats, compact restores, `isMeta=true`
    /// auxiliary content. Also a catch-all for unrecognised leading
    /// `<wrapper-tag>` content so new Claude Code wrappers degrade
    /// gracefully into the system bucket instead of leaking as prompts.
    System,
    /// `message.content` is a tool-result array (assistant's tool ran;
    /// the result comes back wrapped in a user-role message per Claude
    /// API convention).
    Tool,
    /// Image-only attachment (`[Image: WxH, displayed at …]`).
    Image,
    /// Chat view only: an assistant `text` block, full text (wire-clamped).
    Assistant,
    /// Chat view only: an assistant `tool_use` block; `reply`/`ok` carry the
    /// paired `tool_result` preview + success flag.
    ToolUse,
}

impl Kind {
    /// Whether this kind is shown in the default "Your prompts" view — and,
    /// since the chat tail reads the same list, whether it reaches the chat
    /// transcript. Prompts, commands, teammate routing, delegated prompts and
    /// scheduled ones are somebody's deliberate request (a schedule is the
    /// owner's own request, made earlier); the rest are surfaced only when the
    /// "Show system events" toggle is on.
    ///
    /// This is the ONE site: the chat-tail path used to carry a copy-pasted
    /// `matches!` list, which meant every new kind had to be added twice or it
    /// half-landed.
    pub fn is_user_initiated(self) -> bool {
        matches!(
            self,
            Kind::Prompt | Kind::Command | Kind::Teammate | Kind::Delegation | Kind::Schedule
        )
    }
}

/// The result of classifying a user-role BODY — the half of [`classify_user`]
/// that depends on nothing but the text itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapperClass {
    pub kind: Kind,
    pub text: String,
    pub label: Option<String>,
}

/// **The classification parity seam.**
///
/// There are two independent user-line classifiers in this codebase. This one
/// serves the recall plane (`GET /recall?chat=true`); the other is
/// `web/src/components/chat/wire-entries.ts::classifyPrompt`, which the chat
/// WebSocket renderer rides. The chat wire carries the body and *none* of the
/// record's flags (`promptSource`, `isMeta`), so the TS side could only port
/// this half — steps 6, 7 and 9 of [`classify_user`], which is exactly what
/// this function is, called from there so the two can never be separate code.
///
/// It is `pub` for one reason: `server/tests/wrapper_parity.rs` and
/// `web/tests/unit/chat-wrapper-parity.test.ts` hold both planes against ONE
/// corpus, `server/tests/fixtures/chat/supermux-wrappers.jsonl`. **Neither
/// language's `match` on its kind enum is exhaustive** — every one has a `_`
/// arm — so adding a wrapper to one plane and forgetting the other produces no
/// compiler error in Rust *or* TypeScript. That corpus is the only thing that
/// can catch the drift, and a delegated prompt that only one plane understands
/// is a delegated prompt that is invisible in the app that ships.
pub fn classify_prompt_body(body: &str) -> WrapperClass {
    let trimmed = body.trim();

    // 6) A known leading wrapper wins outright.
    if let Some(c) = classify_by_wrapper(trimmed) {
        return WrapperClass {
            kind: c.kind,
            text: c.text,
            label: c.label,
        };
    }

    // 7) `[Image: …]` placeholder — no leading XML tag.
    if trimmed.starts_with("[Image: ") {
        return WrapperClass {
            kind: Kind::Image,
            text: trimmed.lines().next().unwrap_or(trimmed).to_string(),
            label: None,
        };
    }

    // 9) Everything else is a real user prompt.
    WrapperClass {
        kind: Kind::Prompt,
        text: sanitise_text(trimmed),
        label: None,
    }
}

#[derive(Debug, Default, Serialize)]
pub struct RecallResponse {
    pub entries: Vec<RecallEntry>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    #[serde(rename = "nextBefore", skip_serializing_if = "Option::is_none")]
    pub next_before: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Envelope<T> {
    ok: bool,
    data: T,
}

// ── handler ──────────────────────────────────────────────────────────────────

/// `GET /api/sessions/{name}/recall`
///
/// Look up the session row, hand off to [`gather`] on a blocking thread, wrap
/// the result in the standard `{ ok: true, data }` envelope. The session row
/// must exist; missing `cc_conversation_id`/`dir` is treated as "no history
/// yet" (returns an empty list, not an error) so the popover renders an empty
/// state instead of an error toast.
pub async fn handler(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Query(q): Query<RecallQuery>,
) -> Result<Json<Envelope<RecallResponse>>, AppError> {
    let session = db::sessions::get(&state.pool, &name)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?
        .ok_or_else(|| AppError::NotFound(format!("session {name}")))?;

    // Clamp limit before crossing the thread boundary.
    let limit = q.limit.clamp(1, LIMIT_MAX);
    let dir = session.dir.clone();
    let cc_id = session.cc_conversation_id.clone();
    let codex_id = session.codex_session_id.clone();
    let provider = session.provider.clone();
    let last_started = session.last_started;

    // A RETIRED provider's row keeps answering (no 500, no panic) but has no
    // transcript reader left to answer WITH. Return the empty list rather than
    // falling through to the Claude reader, which would hand back some other
    // agent's conversations for the same directory — an honest empty state
    // beats a confident wrong one.
    if crate::sessions::is_retired_provider(&provider) {
        return Ok(Json(Envelope {
            ok: true,
            data: RecallResponse::default(),
        }));
    }

    let result = tokio::task::spawn_blocking(move || {
        if provider == "codex" {
            codex::gather(
                &dir,
                &codex_id,
                last_started,
                q.scope,
                &q.q,
                q.before.as_deref(),
                limit,
            )
        } else {
            gather(
                &dir,
                &cc_id,
                q.scope,
                &q.q,
                q.include_sidechains,
                q.include_system_events,
                q.chat,
                q.before.as_deref(),
                limit,
            )
        }
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    Ok(Json(Envelope {
        ok: true,
        data: result,
    }))
}

// ── core (blocking) ──────────────────────────────────────────────────────────

/// Build the response from a session's working dir. Thin wrapper over
/// [`gather_in_proj`] that resolves the cwd to its Claude project folder.
fn gather(
    dir: &str,
    cc_id: &str,
    scope: Scope,
    search: &str,
    include_sidechains: bool,
    include_system_events: bool,
    chat: bool,
    before: Option<&str>,
    limit: usize,
) -> RecallResponse {
    let proj = resumable::project_dir_for(dir);
    gather_in_proj(
        &proj,
        cc_id,
        scope,
        search,
        include_sidechains,
        include_system_events,
        chat,
        before,
        limit,
    )
}

/// Scope decides which files we open; everything else is shared filtering +
/// pagination. Factored out so tests can target an already-resolved project
/// folder without touching `CLAUDE_CONFIG_DIR`.
fn gather_in_proj(
    proj: &Path,
    cc_id: &str,
    scope: Scope,
    search: &str,
    include_sidechains: bool,
    include_system_events: bool,
    chat: bool,
    before: Option<&str>,
    limit: usize,
) -> RecallResponse {
    let files = files_for_scope(proj, cc_id, scope);
    let search_lc = if search.is_empty() {
        None
    } else {
        Some(search.to_lowercase())
    };

    // Walk files newest-first; stop as soon as we have one MORE than `limit`
    // (we need the +1 to know whether `hasMore` is true without doing a second
    // pass). The cursor is `(session_id, uuid)` joined by `:` so that
    // concurrent writes that reorder Project-scope files by mtime can't make
    // the cursor match the same uuid in a different file. We skip forward
    // through the merged stream until we see the exact (session, uuid) pair.
    let cursor = before.and_then(decode_cursor);
    let mut out: Vec<RecallEntry> = Vec::new();
    let mut cursor_consumed = cursor.is_none();
    let target = limit + 1;

    'files: for path in &files {
        // `read_user_turns` walks the file FORWARD and reverses its own output
        // so the file's own entries arrive newest-first.
        // `Arc` on both arms so the cached vector is never deep-cloned just to
        // be iterated; only the <= `limit + 1` entries that survive the
        // filters are cloned.
        let file_entries = if chat {
            read_chat_turns_cached(path)
        } else {
            std::sync::Arc::new(read_user_turns(path, include_sidechains))
        };
        for entry in file_entries.iter() {
            if !cursor_consumed {
                if let Some((ref c_sid, ref c_uuid)) = cursor {
                    if entry.session_id == *c_sid && entry.uuid == *c_uuid {
                        cursor_consumed = true;
                    }
                }
                continue;
            }
            // Kind filter: hide harness-injected events unless the caller asks
            // for the full audit view. The cursor still consumes them above —
            // omitting from the response only changes what the popover renders,
            // not what counts toward pagination position.
            if !chat && !include_system_events && !entry.kind.is_user_initiated() {
                continue;
            }
            if let Some(ref needle) = search_lc {
                if !entry.text.to_lowercase().contains(needle.as_str()) {
                    continue;
                }
            }
            out.push(entry.clone());
            if out.len() >= target {
                break 'files;
            }
        }
    }

    let has_more = out.len() > limit;
    if has_more {
        out.truncate(limit);
    }
    let next_before = if has_more {
        out.last().map(|e| encode_cursor(&e.session_id, &e.uuid))
    } else {
        None
    };

    // Final wire-shape clamp: search ran over the full sanitised text (so a
    // needle past the cap still matches), but the response carries only the
    // preview. The cap is PER KIND — an assistant message is content, not a
    // preview of one, so it gets `ASSISTANT_MAX_CHARS`; every other kind keeps
    // the popover's `PROMPT_MAX_CHARS` budget. Anything actually clipped is
    // flagged.
    for e in &mut out {
        let cap = if e.kind == Kind::Assistant {
            ASSISTANT_MAX_CHARS
        } else {
            PROMPT_MAX_CHARS
        };
        if e.text.chars().count() > cap {
            e.text = clamp(&e.text, cap);
            e.truncated = Some(true);
        }
    }

    RecallResponse {
        entries: out,
        has_more,
        next_before,
    }
}

/// Resolve which JSONL files to open, in the order we should walk them.
///
/// - `Session`: at most one file, `<proj>/<cc_id>.jsonl`. Missing → empty.
/// - `Project`: every `*.jsonl` under `<proj>`, newest-mtime first.
fn files_for_scope(proj: &Path, cc_id: &str, scope: Scope) -> Vec<PathBuf> {
    match scope {
        Scope::Session => {
            if cc_id.is_empty() {
                return Vec::new();
            }
            let path = proj.join(format!("{cc_id}.jsonl"));
            if path.is_file() {
                vec![path]
            } else {
                Vec::new()
            }
        }
        Scope::Project => {
            let read = match fs::read_dir(proj) {
                Ok(r) => r,
                Err(_) => return Vec::new(),
            };
            let mut with_mtime: Vec<(SystemTime, PathBuf)> = Vec::new();
            for entry in read.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                with_mtime.push((mtime, path));
            }
            with_mtime.sort_by(|a, b| b.0.cmp(&a.0));
            with_mtime.into_iter().map(|(_, p)| p).collect()
        }
    }
}

/// Stream one transcript forward, pair every user turn with the next
/// assistant turn's first text block, then reverse so the caller gets
/// newest-first. Stamps every entry with the file's session uuid + the file's
/// AI title (when present anywhere in the file — last writer wins, mirroring
/// `resumable.rs`).
fn read_user_turns(path: &Path, include_sidechains: bool) -> Vec<RecallEntry> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let reader = BufReader::new(file);

    let mut entries: Vec<RecallEntry> = Vec::new();
    let mut pending_idx: Option<usize> = None; // index in `entries` awaiting a reply
    let mut latest_title: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Cheap substring gate before any JSON parse. ai-title is also tracked.
        let is_user = line.contains("\"type\":\"user\"");
        let is_assistant = line.contains("\"type\":\"assistant\"");
        let is_title = line.contains("\"ai-title\"");
        if !is_user && !is_assistant && !is_title {
            continue;
        }

        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match ty {
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        latest_title = Some(t.to_string());
                    }
                }
            }
            "user" => {
                let sidechain = v
                    .get("isSidechain")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                // Sidechain (sub-agent) turns we're hiding: skip cleanly without
                // disturbing `pending_idx`. The previous main user is still
                // legitimately awaiting a main assistant — clearing here would
                // drop its reply (a `Task` flow's sub-conversation regularly
                // interleaves before the parent's text reply arrives).
                if sidechain && !include_sidechains {
                    continue;
                }
                let Some(classified) = classify_user(&v) else {
                    pending_idx = None;
                    continue;
                };
                let uuid = v
                    .get("uuid")
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                if uuid.is_empty() {
                    pending_idx = None;
                    continue;
                }
                let ts = parse_ts(v.get("timestamp").and_then(|t| t.as_str()));
                entries.push(RecallEntry {
                    uuid,
                    ts,
                    session_id: session_id.clone(),
                    session_title: None, // filled below from `latest_title`
                    text: classified.text,
                    reply: None,
                    sidechain,
                    kind: classified.kind,
                    label: classified.label,
                    ok: None,
                    truncated: None,
                });
                // Non-prompt turns aren't a "user asking a question" — don't
                // arm a reply pairing on them. (A `<task-notification>` is
                // followed by the model's continuation, not a "reply".)
                pending_idx = if classified.kind == Kind::Prompt {
                    Some(entries.len() - 1)
                } else {
                    None
                };
            }
            "assistant" => {
                let sidechain = v
                    .get("isSidechain")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                // Same rationale as the user branch: don't touch `pending_idx`
                // for invisible turns — the next visible assistant is the
                // genuine reply.
                if sidechain && !include_sidechains {
                    continue;
                }
                if let Some(idx) = pending_idx.take() {
                    if let Some(reply) = extract_message_text(&v) {
                        let clean = preview(&reply, REPLY_MAX_CHARS);
                        if !clean.is_empty() {
                            entries[idx].reply = Some(clean);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(title) = latest_title {
        for e in &mut entries {
            e.session_title = Some(title.clone());
        }
    }

    entries.reverse();
    entries
}

/// Chat-view reader (fase A1): stream one transcript forward and emit the
/// full-fidelity chronological tail — user turns (prompt/command/teammate
/// only), assistant `text` blocks as their OWN entries (full text), and
/// assistant `tool_use` blocks paired with their `tool_result` (matched by
/// `tool_use_id`, folded into `reply`/`ok` — a result is never its own
/// entry). Sidechains are always hidden (subagent detail is a later fase);
/// `thinking` and image blocks are skipped in A1. Newest-first on return,
/// mirroring `read_user_turns`.
fn read_chat_turns(path: &Path) -> Vec<RecallEntry> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let reader = BufReader::new(file);

    let mut entries: Vec<RecallEntry> = Vec::new();
    // tool_use id → index in `entries`, so the wrapped user-role tool_result
    // can fold into its receipt.
    let mut tool_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut latest_title: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let is_user = line.contains("\"type\":\"user\"");
        let is_assistant = line.contains("\"type\":\"assistant\"");
        let is_title = line.contains("\"ai-title\"");
        if !is_user && !is_assistant && !is_title {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if v.get("isSidechain")
            .and_then(|b| b.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        let ts = parse_ts(v.get("timestamp").and_then(|t| t.as_str()));
        let uuid = v
            .get("uuid")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string();

        match ty {
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        latest_title = Some(t.to_string());
                    }
                }
            }
            "user" => {
                // A tool_result carrier folds into its pending receipt and is
                // never its own entry.
                if let Some(blocks) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    let mut folded = false;
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                            continue;
                        }
                        folded = true;
                        let id = b.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("");
                        if let Some(&idx) = tool_idx.get(id) {
                            let is_err =
                                b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                            entries[idx].ok = Some(!is_err);
                            let text = tool_result_text(b, preview_budget(REPLY_MAX_CHARS));
                            let preview = preview(&text, REPLY_MAX_CHARS);
                            if !preview.is_empty() {
                                entries[idx].reply = Some(preview);
                            }
                        }
                    }
                    if folded {
                        continue;
                    }
                }
                if uuid.is_empty() {
                    continue;
                }
                let Some(c) = classify_user(&v) else { continue };
                // Chat tail shows only user-initiated turns — system noise
                // (reminders, notifications, caveats) stays out of the calm view.
                if !c.kind.is_user_initiated() {
                    continue;
                }
                entries.push(RecallEntry {
                    uuid,
                    ts,
                    session_id: session_id.clone(),
                    session_title: None,
                    text: c.text,
                    reply: None,
                    sidechain: false,
                    kind: c.kind,
                    label: c.label,
                    ok: None,
                    truncated: None,
                });
            }
            "assistant" => {
                if uuid.is_empty() {
                    continue;
                }
                let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
                    continue;
                };
                // BORROW the block array. Cloning it duplicated every `text`
                // and `thinking` block on the line (a0 measured single lines
                // up to ~950 KB) purely so the loop could own a `Vec`, which
                // only ever reads `b` by reference. The `String` form is the
                // rare one, so materialising a single block for it is fine.
                let owned_single;
                let blocks: &[serde_json::Value] = match content {
                    serde_json::Value::String(s) => {
                        owned_single = [serde_json::json!({"type": "text", "text": s})];
                        &owned_single
                    }
                    serde_json::Value::Array(a) => a.as_slice(),
                    _ => continue,
                };
                for (i, b) in blocks.iter().enumerate() {
                    // A0 fact: one block per line is TYPICAL, not guaranteed
                    // (1 multi-block in 21,431) — suffix uuids keep cursor
                    // identity unique either way.
                    let buuid = if i == 0 {
                        uuid.clone()
                    } else {
                        format!("{uuid}#{i}")
                    };
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let text = sanitise_text(
                                b.get("text").and_then(|t| t.as_str()).unwrap_or("").trim(),
                            );
                            if text.is_empty() {
                                continue;
                            }
                            entries.push(RecallEntry {
                                uuid: buuid,
                                ts,
                                session_id: session_id.clone(),
                                session_title: None,
                                text,
                                reply: None,
                                sidechain: false,
                                kind: Kind::Assistant,
                                label: None,
                                ok: None,
                                truncated: None,
                            });
                        }
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            if let Some(id) = b.get("id").and_then(|x| x.as_str()) {
                                tool_idx.insert(id.to_string(), entries.len());
                            }
                            entries.push(RecallEntry {
                                uuid: buuid,
                                ts,
                                session_id: session_id.clone(),
                                session_title: None,
                                text: tool_line(name, b.get("input")),
                                reply: None,
                                sidechain: false,
                                kind: Kind::ToolUse,
                                label: Some(name.to_string()),
                                ok: None,
                                truncated: None,
                            });
                        }
                        // thinking / image / unknown block types: skipped in A1.
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(title) = latest_title {
        for e in &mut entries {
            e.session_title = Some(title.clone());
        }
    }
    entries.reverse();
    entries
}

/// One-line receipt label for a `tool_use` block: tool name + its most salient
/// input field, clipped. Mirrors `activity::activity_label`'s field priorities
/// WITHOUT the emoji taxonomy (chat receipts are icon-free — master plan §4.2 P3).
fn tool_line(name: &str, input: Option<&serde_json::Value>) -> String {
    let detail = input.and_then(|i| {
        for key in [
            "file_path",
            "command",
            "pattern",
            "url",
            "description",
            "prompt",
        ] {
            if let Some(s) = i.get(key).and_then(|v| v.as_str()) {
                let s = s.trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    });
    match detail {
        Some(d) => format!("{name} {}", clamp(&sanitise_text(&d), 120)),
        None => name.to_string(),
    }
}

/// Printable text of a `tool_result` block: string content verbatim, array
/// content = concatenated `text` sub-blocks. Anything else → empty.
///
/// Bounded on purpose. The output is only ever a `REPLY_MAX_CHARS` preview,
/// but a `tool_result` carries the WHOLE tool output — a `Read` of a 5 MB file
/// is a 5 MB JSON string. Copying that, then regex-scanning and re-collecting
/// it in `sanitise_text`, then keeping 600 chars, cost three full-length
/// allocations per tool result on every parse. `budget` is the number of
/// SOURCE chars worth taking; see [`preview`].
fn tool_result_text(b: &serde_json::Value, budget: usize) -> String {
    match b.get("content") {
        Some(serde_json::Value::String(s)) => clamp(s, budget),
        Some(serde_json::Value::Array(parts)) => {
            let mut out = String::new();
            for p in parts
                .iter()
                .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            {
                if out.chars().count() >= budget {
                    break;
                }
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&clamp(p, budget));
            }
            out
        }
        _ => String::new(),
    }
}

/// Source-char budget for a `max`-char preview: clamp BEFORE sanitising so the
/// expensive scan runs over a bounded slice, with generous headroom for the
/// escape sequences and control bytes `sanitise_text` removes. 16× covers the
/// pathological shape (`ESC[31m` + one char + `ESC[0m` = 9 source chars per
/// visible char, pinned by `ansi_dense_result_still_yields_a_full_preview`)
/// and still bounds the work at ~10 KB per tool result instead of the whole
/// multi-MB output.
fn preview_budget(max: usize) -> usize {
    max.saturating_mul(16).saturating_add(64)
}

/// `max`-char preview of `s`: bounded clamp → sanitise → final clamp.
fn preview(s: &str, max: usize) -> String {
    clamp(&sanitise_text(&clamp(s, preview_budget(max))), max)
}

/// Parse cache for the chat view (the A1 poll-cost guard): the A1 client
/// re-pulls the FOCUSED session's tail on every SSE tick, and
/// `read_chat_turns` otherwise re-streams the entire JSONL each time (a0
/// measured 21k+ line transcripts with single lines up to ~950 KB). Keyed on
/// (path, mtime, len).
///
/// Entries are handed out as an `Arc`, never deep-cloned. The single-slot
/// version cloned the whole `Vec<RecallEntry>` on a HIT — while holding the
/// mutex — and cloned it a second time to store it on a miss, so a big
/// conversation moved ~9 MB per poll to deliver 30 rows, and two concurrent
/// pollers serialised on the copy rather than on the lookup.
///
/// A handful of slots (LRU, front = most recent), not one: two clients on two
/// sessions alternated paths and turned every poll into a miss, and
/// `scope=project` walks every file in the project dir, so a single request
/// evicted the focused session's entry on its way past.
///
/// Still a full re-parse whenever the file has GROWN — the tailer that reads
/// only the appended bytes is fase A2's chat data plane, which replaces this
/// read path wholesale.
const CHAT_CACHE_SLOTS: usize = 4;

struct ChatCacheSlot {
    path: PathBuf,
    mtime: SystemTime,
    len: u64,
    entries: std::sync::Arc<Vec<RecallEntry>>,
}

static CHAT_PARSE_CACHE: std::sync::Mutex<Vec<ChatCacheSlot>> =
    std::sync::Mutex::new(Vec::new());

/// Cache lookup, LRU-promoting the hit. Split out from the global so the
/// slot policy is testable without racing the process-wide static.
fn cache_get(
    slots: &mut Vec<ChatCacheSlot>,
    path: &Path,
    mtime: SystemTime,
    len: u64,
) -> Option<std::sync::Arc<Vec<RecallEntry>>> {
    let i = slots
        .iter()
        .position(|s| s.path == path && s.mtime == mtime && s.len == len)?;
    // Refcount bump only — the payload is never copied.
    let hit = slots[i].entries.clone();
    let slot = slots.remove(i);
    slots.insert(0, slot);
    Some(hit)
}

/// Store (replacing any stale generation of the same path) at the front,
/// dropping the least-recently-used slot past the cap.
fn cache_put(
    slots: &mut Vec<ChatCacheSlot>,
    path: &Path,
    mtime: SystemTime,
    len: u64,
    entries: &std::sync::Arc<Vec<RecallEntry>>,
) {
    slots.retain(|s| s.path != path);
    slots.insert(
        0,
        ChatCacheSlot {
            path: path.to_path_buf(),
            mtime,
            len,
            entries: entries.clone(),
        },
    );
    slots.truncate(CHAT_CACHE_SLOTS);
}

fn read_chat_turns_cached(path: &Path) -> std::sync::Arc<Vec<RecallEntry>> {
    let key = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok().map(|t| (t, m.len())));
    if let Some((mtime, len)) = key {
        if let Ok(mut slots) = CHAT_PARSE_CACHE.lock() {
            if let Some(hit) = cache_get(&mut slots, path, mtime, len) {
                return hit;
            }
        }
    }
    let parsed = std::sync::Arc::new(read_chat_turns(path));
    if let Some((mtime, len)) = key {
        if let Ok(mut slots) = CHAT_PARSE_CACHE.lock() {
            cache_put(&mut slots, path, mtime, len, &parsed);
        }
    }
    parsed
}

// ── small helpers ────────────────────────────────────────────────────────────

/// Compose a pagination cursor: `<session_id>:<uuid>`. UUIDs are hex/dash so
/// the separator `:` is unambiguous; session_id is the file stem (also
/// uuid-shaped today, but we don't rely on the shape).
fn encode_cursor(session_id: &str, uuid: &str) -> String {
    format!("{session_id}:{uuid}")
}

/// Decode the cursor; pre-fix the wire used bare uuids so older clients (or
/// the very first page emitted by this version) won't carry a `:`. Treat any
/// such cursor as uuid-only by leaving the session_id empty — that will only
/// match if the corresponding file's session_id is also empty, i.e. nothing,
/// and effectively returns the first page. The trade-off is one page of
/// awkward results on a single deploy, vs. cursor stability under reorder.
fn decode_cursor(raw: &str) -> Option<(String, String)> {
    let (sid, uuid) = raw.split_once(':')?;
    if uuid.is_empty() {
        return None;
    }
    Some((sid.to_string(), uuid.to_string()))
}

fn parse_ts(raw: Option<&str>) -> i64 {
    raw.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp())
        .unwrap_or(0)
}

/// Extract the human-readable text from a Claude Code `message` block.
/// Content is either a bare string or an array of typed blocks; we
/// concatenate every `text` block in order with paragraph breaks so the
/// user's typed separators survive intact. Non-text blocks (`tool_use`,
/// `tool_result`, image data) are skipped here — the user-side classifier
/// handles those upstream; for the assistant reply we only want prose.
fn extract_message_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            // Paragraph join — `" "` would erase the user's empty-line
            // separators between code blocks, file pastes, and prose.
            parts.join("\n\n").trim().to_string()
        }
        _ => return None,
    };
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Output of [`classify_user`]: what kind of user-role turn this is, the
/// text to display (already cleaned + summary-extracted where appropriate),
/// and a short kind-specific label (slash name, teammate id, …) when one
/// is meaningful.
struct ClassifiedUser {
    kind: Kind,
    text: String,
    label: Option<String>,
}

/// Decide what flavour of "user" turn a JSONL record represents and produce
/// the display text for it. Returns `None` for entries that carry no usable
/// content (image-only attachments are kept as `Kind::Image` with a
/// placeholder, but a truly empty body returns `None`).
///
/// Robustness contract: this MUST stay loose. Claude Code adds harness
/// wrappers over time; any leading `<unknown-tag>` we don't recognise falls
/// into `Kind::System` with the tag name as the label, so new wrappers
/// degrade into the system-events bucket instead of leaking as raw
/// prompts.
fn classify_user(v: &serde_json::Value) -> Option<ClassifiedUser> {
    // 1) Explicit flags from the harness — most reliable signals.
    let is_meta = v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false);
    let prompt_source = v
        .get("promptSource")
        .and_then(|s| s.as_str())
        .unwrap_or("");

    // 2) Content shape.
    let content = v.get("message")?.get("content")?;

    // Array content with any `tool_result` block is a tool return, not a
    // user prompt — Claude API wraps tool outputs in role:user messages.
    if let serde_json::Value::Array(blocks) = content {
        let has_tool_result = blocks
            .iter()
            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
        if has_tool_result {
            return Some(ClassifiedUser {
                kind: Kind::Tool,
                text: "(tool result)".to_string(),
                label: None,
            });
        }
    }

    // 3) Extract the body text from string / text-blocks.
    let raw = match content {
        serde_json::Value::String(s) => s.to_string(),
        serde_json::Value::Array(_) => extract_message_text(v).unwrap_or_default(),
        _ => return None,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 4) `promptSource: "typed"` — the harness's own positive signal that
    //    the human typed this. Honour it as a hard override: the user may
    //    have pasted XML / HTML / a quoted `<task-notification>` (literally
    //    the use case that prompted this whole feature) and we must NOT
    //    swallow that into the system bucket.
    if prompt_source == "typed" {
        // …with one carve-out: wrappers supermux itself authors on delivery
        // ride the pty like a keystroke, so Claude Code stamps them "typed"
        // too (verified against a real delegation's JSONL row). Without this
        // the wrapper would be dead on arrival and a delegated prompt would
        // render as the owner's own bubble. Scoped to the `supermux-`
        // namespace, so a human pasting a quoted `<task-notification>` — the
        // case the hard override exists for — is untouched.
        if is_supermux_wrapper(trimmed) {
            if let Some(c) = classify_by_wrapper(trimmed) {
                return Some(c);
            }
        }
        return Some(ClassifiedUser {
            kind: Kind::Prompt,
            text: sanitise_text(trimmed),
            label: None,
        });
    }

    // 5) `promptSource: "system"` — definitely harness-injected, regardless
    //    of how nice the body looks. Treat as a system event.
    if prompt_source == "system" {
        return Some(classify_by_wrapper(trimmed).unwrap_or(ClassifiedUser {
            kind: Kind::System,
            text: short_summary(trimmed),
            label: None,
        }));
    }

    // 6/7/9) Wrapper → image → plain prompt. Delegated to the parity seam so
    //    the chat-WS plane's TypeScript port has exactly one thing to mirror
    //    (see [`classify_prompt_body`]). `isMeta` (step 8) is checked between
    //    7 and 9 below, because the seam cannot see it.
    let body = classify_prompt_body(trimmed);
    if body.kind != Kind::Prompt {
        return Some(ClassifiedUser {
            kind: body.kind,
            text: body.text,
            label: body.label,
        });
    }

    // 8) `isMeta = true` without a recognised prefix — caveat / compact
    //    restore / similar harness aside.
    if is_meta {
        return Some(ClassifiedUser {
            kind: Kind::System,
            text: short_summary(trimmed),
            label: None,
        });
    }

    // 9) Everything else is a real user prompt — older transcripts that
    //    predate `promptSource` end up here.
    Some(ClassifiedUser {
        kind: body.kind,
        text: body.text,
        label: body.label,
    })
}

/// Whether `body` opens with a wrapper supermux authored itself (as opposed to
/// one Claude Code injects). Only these outrank `promptSource: "typed"`.
fn is_supermux_wrapper(body: &str) -> bool {
    matches!(leading_tag(body), Some(DELEGATION_TAG) | Some(SCHEDULE_TAG))
}

/// Inspect the leading tag (if any) and produce a classified entry for the
/// known harness wrappers. Returns `None` when the string doesn't start with
/// a tag we want to special-case.
fn classify_by_wrapper(body: &str) -> Option<ClassifiedUser> {
    let tag = leading_tag(body)?;

    match tag {
        "task-notification" => {
            // `<summary>` is the one-line description the harness embedded
            // for human consumption. Fall back to the status field, then to a
            // generic label.
            let summary = tag_inner(body, "summary")
                .or_else(|| tag_inner(body, "status").map(|s| format!("Agent run — {s}")))
                .unwrap_or_else(|| "Subagent task completed".to_string());
            let task_id = tag_inner(body, "task-id");
            Some(ClassifiedUser {
                kind: Kind::Notification,
                text: summary.trim().to_string(),
                label: task_id,
            })
        }
        "command-name" => {
            let slash = tag_inner(body, "command-name").unwrap_or_default();
            let args = tag_inner(body, "command-args").unwrap_or_default();
            let args = args.trim();
            let display = if args.is_empty() {
                slash.clone()
            } else {
                format!("{slash} {args}")
            };
            Some(ClassifiedUser {
                kind: Kind::Command,
                text: display.trim().to_string(),
                label: Some(slash),
            })
        }
        "teammate-message" => {
            // `<teammate-message teammate_id="X">…</teammate-message>` —
            // pull the attribute + the inner text.
            let teammate_id = attr_value(body, "teammate_id");
            let inner = tag_inner(body, "teammate-message").unwrap_or_default();
            let cleaned = inner.trim();
            Some(ClassifiedUser {
                kind: Kind::Teammate,
                text: sanitise_text(cleaned),
                label: teammate_id,
            })
        }
        DELEGATION_TAG => {
            // `<supermux-delegation from="X">…</supermux-delegation>` — a
            // prompt another session handed to this one (`agents/delegate.rs`
            // writes it). Same parse shape as the teammate envelope above.
            let from = attr_value(body, "from").filter(|f| !f.trim().is_empty());
            let inner = tag_inner(body, DELEGATION_TAG).unwrap_or_default();
            let cleaned = inner.trim();
            match from {
                // No sender means no provenance, and an unattributed body must
                // never leak into the transcript as somebody's bare prompt.
                None => Some(ClassifiedUser {
                    kind: Kind::System,
                    text: short_summary(cleaned),
                    label: Some(DELEGATION_TAG.to_string()),
                }),
                Some(from) => Some(ClassifiedUser {
                    kind: Kind::Delegation,
                    text: or_unreadable(sanitise_text(cleaned)),
                    label: Some(from),
                }),
            }
        }
        SCHEDULE_TAG => {
            // `<supermux-schedule id="…" title="…">…</supermux-schedule>` — a
            // prompt one of this session's own schedules fired
            // (`scheduler/runner.rs` writes it). Unlike a delegation — whose
            // whole provenance IS the `from` attribute — the tag itself already
            // says a schedule sent this, so a title-less schedule stays a
            // schedule turn (unnamed) instead of degrading into a system line
            // that would hide the prompt from the transcript.
            let title = attr_value(body, "title")
                .map(|t| unescape_attr(&t))
                .filter(|t| !t.trim().is_empty());
            let inner = tag_inner(body, SCHEDULE_TAG).unwrap_or_default();
            let cleaned = strip_confirm_footer(inner.trim());
            Some(ClassifiedUser {
                kind: Kind::Schedule,
                text: or_unreadable(sanitise_text(&cleaned)),
                label: title,
            })
        }
        "system-reminder" => {
            let inner = tag_inner(body, "system-reminder").unwrap_or_default();
            Some(ClassifiedUser {
                kind: Kind::System,
                text: short_summary(inner.trim()),
                label: Some("reminder".to_string()),
            })
        }
        "local-command-caveat" | "local-command-stdout" => Some(ClassifiedUser {
            kind: Kind::System,
            text: short_summary(body),
            label: Some(tag.to_string()),
        }),
        // Unknown wrapper: degrade gracefully into the system bucket with the
        // tag name as the badge, so a brand-new Claude Code wrapper never
        // leaks as a fake prompt and reviewers can see "huh, what's that".
        other => Some(ClassifiedUser {
            kind: Kind::System,
            text: short_summary(body),
            label: Some(other.to_string()),
        }),
    }
}

/// Drop the agent-confirm footer from a scheduled delivery's body.
///
/// The footer is machine-generated and opens with [`CONFIRM_FOOTER_SENTINEL`] on
/// a line of its own, so this cuts on an EXACT line match — the const is the
/// contract between the writer and this reader, never a guess about what a
/// prompt's tail looks like. Bodies without the sentinel come back whole.
fn strip_confirm_footer(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        if line.trim() == CONFIRM_FOOTER_SENTINEL {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// If `s` starts with `<tag>` or `<tag attr=…>`, return `tag`. Conservative
/// matcher: only lowercase letters + `-` (Claude's wrapper-tag character set
/// today). Returns `None` for text that happens to begin with `<` but isn't
/// a wrapper (e.g. a user pasting `<div>`).
fn leading_tag(s: &str) -> Option<&str> {
    let rest = s.strip_prefix('<')?;
    let end = rest
        .find(|c: char| !(c.is_ascii_lowercase() || c == '-'))?;
    if end == 0 {
        return None;
    }
    let tag = &rest[..end];
    // Must close with `>` or whitespace (attributes) — otherwise it isn't a
    // tag boundary, just text that happens to contain `<…>` characters.
    let after = &rest[end..];
    if after.starts_with('>') || after.starts_with(char::is_whitespace) {
        Some(tag)
    } else {
        None
    }
}

/// Return the inner text of the FIRST `<tag>…</tag>` (or `<tag …>…</tag>`)
/// occurrence in `body`, trimmed. Tolerant of attributes and whitespace
/// around the tag name.
fn tag_inner(body: &str, tag: &str) -> Option<String> {
    let open_a = format!("<{tag}>");
    let open_b = format!("<{tag} ");
    let close = format!("</{tag}>");
    let start = body.find(&open_a).or_else(|| body.find(&open_b))?;
    let after_open = body[start..]
        .find('>')
        .map(|i| start + i + 1)?;
    let end = body[after_open..].find(&close)?;
    Some(body[after_open..after_open + end].trim().to_string())
}

/// Pull the value of `attr=` from a tag. Supports both single and double
/// quotes; returns the first match anywhere in the body (the wrappers we
/// care about put attributes only in the opening tag, so this is fine).
fn attr_value(body: &str, attr: &str) -> Option<String> {
    let key = format!("{attr}=");
    let start = body.find(&key)? + key.len();
    let rest = &body[start..];
    let (quote, body) = match rest.chars().next()? {
        '"' => ('"', &rest[1..]),
        '\'' => ('\'', &rest[1..]),
        _ => return None,
    };
    let end = body.find(quote)?;
    Some(body[..end].to_string())
}

/// What a supermux wrapper with nothing readable inside it says out loud.
///
/// A wrapper body reduces to nothing when the delivered text closed the wrapper
/// early — the shape every writer now refuses (`scheduler::create`,
/// `scheduler::hook`, `lifecycle::send_text`) and `wrap_schedule` defangs on the
/// way out. The reader still needs an answer for it, because an EMPTY row is the
/// one outcome that hides the fact that something was sent: the divider says a
/// schedule fired and the body under it says nothing at all. Twin of
/// `wire-entries.ts::UNREADABLE_WRAPPER_BODY`, pinned by the parity corpus.
pub const UNREADABLE_WRAPPER_BODY: &str =
    "This prompt didn’t survive its wrapper — the terminal has what was sent.";

/// `text`, or the sentence above when the wrapper body came back empty.
fn or_unreadable(text: String) -> String {
    if text.trim().is_empty() {
        UNREADABLE_WRAPPER_BODY.to_string()
    } else {
        text
    }
}

/// Collapse a long system-event body to a single human-readable line for the
/// recall list. Strips XML wrappers entirely so we don't ship `<…>` noise
/// into the UI; takes the first non-empty plain line.
fn short_summary(s: &str) -> String {
    let no_tags = strip_tags(s);
    no_tags
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
        .unwrap_or_else(|| "(system event)".to_string())
}

/// Remove every `<…>` span. Cheap, not a real HTML parser; good enough for
/// the harness wrappers (they're well-formed and never nest text-blocks
/// inside attributes).
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir() -> PathBuf {
        // Same shape as `resumable::tests::temp_dir` — process- and
        // nanosecond-tagged so parallel tests never collide.
        let p = std::env::temp_dir().join(format!(
            "supermux-recall-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_jsonl(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        let path = dir.join(format!("{name}.jsonl"));
        let mut f = fs::File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path
    }

    fn append_jsonl(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        let path = dir.join(format!("{name}.jsonl"));
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path
    }

    fn user_line(uuid: &str, ts: &str, text: &str, sidechain: bool) -> String {
        serde_json::json!({
            "type": "user",
            "uuid": uuid,
            "timestamp": ts,
            "isSidechain": sidechain,
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn assistant_line(uuid: &str, ts: &str, text: &str, sidechain: bool) -> String {
        serde_json::json!({
            "type": "assistant",
            "uuid": uuid,
            "timestamp": ts,
            "isSidechain": sidechain,
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
            },
        })
        .to_string()
    }

    fn ai_title_line(title: &str) -> String {
        serde_json::json!({ "type": "ai-title", "aiTitle": title }).to_string()
    }

    #[test]
    fn pairs_user_with_next_assistant_and_reverses() {
        let td = temp_dir();
        let path = write_jsonl(
            &td,
            "abc",
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "first?", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", "first reply.", false),
                &user_line("u2", "2026-01-01T10:01:00Z", "second?", false),
                &assistant_line("a2", "2026-01-01T10:01:05Z", "second reply.", false),
            ],
        );
        let got = read_user_turns(&path, false);
        assert_eq!(got.len(), 2);
        // Newest-first.
        assert_eq!(got[0].text, "second?");
        assert_eq!(got[0].reply.as_deref(), Some("second reply."));
        assert_eq!(got[1].text, "first?");
        assert_eq!(got[1].reply.as_deref(), Some("first reply."));
        assert_eq!(got[0].session_id, "abc");
    }

    #[test]
    fn user_without_following_assistant_has_no_reply() {
        let td = temp_dir();
        let path = write_jsonl(
            &td,
            "x",
            &[&user_line("u1", "2026-01-01T10:00:00Z", "dangling", false)],
        );
        let got = read_user_turns(&path, false);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].reply, None);
    }

    #[test]
    fn sidechain_hidden_by_default_shown_with_flag() {
        let td = temp_dir();
        let path = write_jsonl(
            &td,
            "y",
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "main", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", "main-r", false),
                &user_line("u2", "2026-01-01T10:00:10Z", "sub", true),
                &assistant_line("a2", "2026-01-01T10:00:15Z", "sub-r", true),
            ],
        );
        let hidden = read_user_turns(&path, false);
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0].text, "main");

        let shown = read_user_turns(&path, true);
        assert_eq!(shown.len(), 2);
        assert!(shown.iter().any(|e| e.sidechain && e.text == "sub"));
    }

    #[test]
    fn ai_title_attaches_to_every_entry_in_file() {
        let td = temp_dir();
        let path = write_jsonl(
            &td,
            "t",
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "q", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", "r", false),
                &ai_title_line("My Big Project"),
            ],
        );
        let got = read_user_turns(&path, false);
        assert_eq!(got[0].session_title.as_deref(), Some("My Big Project"));
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let td = temp_dir();
        let path = write_jsonl(
            &td,
            "m",
            &[
                "{ this is not json",
                &user_line("u1", "2026-01-01T10:00:00Z", "ok", false),
                "",
                "{\"type\":\"user\",\"truncated\":",
                &assistant_line("a1", "2026-01-01T10:00:05Z", "fine", false),
            ],
        );
        let got = read_user_turns(&path, false);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "ok");
        assert_eq!(got[0].reply.as_deref(), Some("fine"));
    }

    #[test]
    fn ansi_escapes_are_stripped_defensively() {
        let td = temp_dir();
        let path = write_jsonl(
            &td,
            "ansi",
            &[&user_line(
                "u1",
                "2026-01-01T10:00:00Z",
                "\u{1b}[A\u{1b}[Dweer\u{1b}[C clean",
                false,
            )],
        );
        let got = read_user_turns(&path, false);
        assert_eq!(got[0].text, "weer clean");
    }

    #[test]
    fn reply_is_clamped_in_read_user_turns() {
        // Reply IS clamped at parse time — it's only ever shown, never searched.
        let td = temp_dir();
        let big_reply = "y".repeat(REPLY_MAX_CHARS + 200);
        let path = write_jsonl(
            &td,
            "c",
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "q", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", &big_reply, false),
            ],
        );
        let got = read_user_turns(&path, false);
        assert_eq!(got[0].reply.as_ref().unwrap().chars().count(), REPLY_MAX_CHARS);
    }

    #[test]
    fn prompt_full_text_preserved_until_wire_clamp() {
        // The prompt is NOT clamped during read — that lets substring search
        // match needles past PROMPT_MAX_CHARS. The clamp is applied in
        // `gather_in_proj` once the entry crosses the wire.
        let td = temp_dir();
        let big_prompt = "x".repeat(PROMPT_MAX_CHARS + 200);
        let path = write_jsonl(
            &td,
            "c2",
            &[&user_line("u1", "2026-01-01T10:00:00Z", &big_prompt, false)],
        );
        let got = read_user_turns(&path, false);
        // In-memory: full text survives.
        assert_eq!(got[0].text.chars().count(), PROMPT_MAX_CHARS + 200);

        // Wire: clamp applied.
        let resp = gather_in_proj(&td, "c2", Scope::Session, "", false, true, false, None, 10);
        assert_eq!(resp.entries[0].text.chars().count(), PROMPT_MAX_CHARS);
    }

    #[test]
    fn search_matches_needle_past_prompt_max_chars() {
        // A needle that lives at character > PROMPT_MAX_CHARS in the original
        // prompt still surfaces the entry. Pre-fix, the clamp ran before the
        // substring filter and these prompts silently dropped from search.
        let td = temp_dir();
        let prefix = "x".repeat(PROMPT_MAX_CHARS + 50);
        let prompt = format!("{prefix}needle-here");
        let path = write_jsonl(
            &td,
            "s",
            &[&user_line("u1", "2026-01-01T10:00:00Z", &prompt, false)],
        );
        // Sanity: file actually wrote our 8K+ prompt.
        let _ = path;
        let resp = gather_in_proj(&td, "s", Scope::Session, "needle-here", false, true, false, None, 10);
        assert_eq!(resp.entries.len(), 1, "needle past 8K must still match");
    }

    #[test]
    fn message_text_joins_blocks_with_paragraph_breaks() {
        // Multi-block content joins on "\n\n" so the user's structural
        // separators (code blocks, file pastes, prose) survive.
        let v = serde_json::json!({
            "message": {
                "content": [
                    {"type": "text", "text": "Here is code:"},
                    {"type": "text", "text": "fn main() {}"},
                ]
            }
        });
        assert_eq!(
            extract_message_text(&v).as_deref(),
            Some("Here is code:\n\nfn main() {}")
        );
    }

    #[test]
    fn sidechain_user_does_not_break_main_user_reply_pairing() {
        // Regression: pre-fix, a hidden sidechain user between a main user and
        // its main assistant cleared `pending_idx`, dropping the reply.
        let td = temp_dir();
        let path = write_jsonl(
            &td,
            "pair",
            &[
                &user_line("u-main", "2026-01-01T10:00:00Z", "main q", false),
                &user_line("u-sub", "2026-01-01T10:00:01Z", "sub q", true),
                &assistant_line("a-sub", "2026-01-01T10:00:02Z", "sub r", true),
                &assistant_line("a-main", "2026-01-01T10:00:03Z", "main r", false),
            ],
        );
        let got = read_user_turns(&path, false);
        assert_eq!(got.len(), 1, "main user is the only visible turn");
        assert_eq!(got[0].reply.as_deref(), Some("main r"));
    }

    #[test]
    fn gather_session_scope_paginates_via_cursor() {
        let proj = temp_dir();
        let cc = "sess-uuid";
        let mut lines: Vec<String> = Vec::new();
        for i in 0..5 {
            lines.push(user_line(
                &format!("u{i}"),
                &format!("2026-01-01T10:0{i}:00Z"),
                &format!("prompt {i}"),
                false,
            ));
            lines.push(assistant_line(
                &format!("a{i}"),
                &format!("2026-01-01T10:0{i}:05Z"),
                &format!("reply {i}"),
                false,
            ));
        }
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_jsonl(&proj, cc, &refs);

        let page1 = gather_in_proj(&proj, cc, Scope::Session, "", false, true, false, None, 2);
        assert_eq!(page1.entries.len(), 2);
        assert!(page1.has_more);
        // Newest-first → "prompt 4", "prompt 3".
        assert_eq!(page1.entries[0].text, "prompt 4");
        assert_eq!(page1.entries[1].text, "prompt 3");
        let cursor = page1.next_before.expect("cursor on hasMore");

        let page2 = gather_in_proj(&proj, cc, Scope::Session, "", false, true, false, Some(&cursor), 2);
        assert_eq!(page2.entries.len(), 2);
        assert_eq!(page2.entries[0].text, "prompt 2");
        assert_eq!(page2.entries[1].text, "prompt 1");

        let page3 = gather_in_proj(
            &proj,
            cc,
            Scope::Session,
            "",
            false,
            true,
            false,
            page2.next_before.as_deref(),
            2,
        );
        assert_eq!(page3.entries.len(), 1);
        assert_eq!(page3.entries[0].text, "prompt 0");
        assert!(!page3.has_more);
    }

    #[test]
    fn gather_substring_filter_is_case_insensitive_on_prompt() {
        let proj = temp_dir();
        let cc = "filter-test";
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "Fix OAuth flow", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", "Done.", false),
                &user_line("u2", "2026-01-01T10:01:00Z", "ship it", false),
                &assistant_line("a2", "2026-01-01T10:01:05Z", "OAuth tested.", false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "oauth", false, true, false, None, 10);
        // Only "Fix OAuth flow" matches; the reply mentioning OAuth must NOT
        // surface "ship it" as a hit.
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].text, "Fix OAuth flow");
    }

    #[test]
    fn gather_project_scope_walks_files_newest_mtime_first() {
        let proj = temp_dir();
        write_jsonl(
            &proj,
            "older",
            &[
                &user_line("u-old", "2026-01-01T08:00:00Z", "older prompt", false),
                &assistant_line("a-old", "2026-01-01T08:00:05Z", "older reply", false),
            ],
        );
        // Sleep so the second file's mtime is strictly newer (cheap but
        // reliable on every filesystem we deploy on).
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_jsonl(
            &proj,
            "newer",
            &[
                &user_line("u-new", "2026-01-01T09:00:00Z", "newer prompt", false),
                &assistant_line("a-new", "2026-01-01T09:00:05Z", "newer reply", false),
            ],
        );

        let r = gather_in_proj(&proj, "newer", Scope::Project, "", false, true, false, None, 10);
        assert_eq!(r.entries.len(), 2);
        // Newer file first.
        assert_eq!(r.entries[0].text, "newer prompt");
        assert_eq!(r.entries[0].session_id, "newer");
        assert_eq!(r.entries[1].text, "older prompt");
        assert_eq!(r.entries[1].session_id, "older");
    }

    // ── classifier tests ──────────────────────────────────────────────────

    fn classify_str(content: &str) -> ClassifiedUser {
        let v = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content },
        });
        classify_user(&v).expect("classified")
    }

    #[test]
    fn classify_typed_prompt() {
        let c = classify_str("ship the SEO audit when you're done");
        assert_eq!(c.kind, Kind::Prompt);
        assert_eq!(c.text, "ship the SEO audit when you're done");
        assert!(c.label.is_none());
    }

    #[test]
    fn classify_explicit_typed_prompt_source_overrides_leading_lt() {
        // Real-world: a typed prompt that happens to start with `<`. The
        // wrapper detector must NOT swallow it just because the leading
        // char is `<` — only known harness tags trigger the synthetic
        // bucket. Here the leading text isn't a recognised wrapper, so it
        // stays as Prompt.
        let v = serde_json::json!({
            "type": "user",
            "promptSource": "typed",
            "message": { "role": "user", "content": "<div>hi</div>" },
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::Prompt);
    }

    #[test]
    fn classify_task_notification_extracts_summary() {
        let body = r#"<task-notification>
<task-id>abc123</task-id>
<status>completed</status>
<summary>Agent "Angle A: line-by-line diff scan" completed</summary>
<result>...lots of result text...</result>
</task-notification>"#;
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Notification);
        assert_eq!(
            c.text,
            "Agent \"Angle A: line-by-line diff scan\" completed"
        );
        assert_eq!(c.label.as_deref(), Some("abc123"));
    }

    #[test]
    fn classify_task_notification_without_summary_falls_back_to_status() {
        let body = "<task-notification><status>failed</status></task-notification>";
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Notification);
        assert_eq!(c.text, "Agent run — failed");
    }

    #[test]
    fn classify_slash_command() {
        let body = "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>";
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Command);
        assert_eq!(c.text, "/clear");
        assert_eq!(c.label.as_deref(), Some("/clear"));
    }

    #[test]
    fn classify_slash_command_with_args() {
        let body =
            "<command-name>/code-review</command-name><command-args>high</command-args>";
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Command);
        assert_eq!(c.text, "/code-review high");
    }

    #[test]
    fn classify_teammate_message() {
        let body = r#"<teammate-message teammate_id="git-stacker">
please prepare the next stacked branch
</teammate-message>"#;
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Teammate);
        assert_eq!(c.text, "please prepare the next stacked branch");
        assert_eq!(c.label.as_deref(), Some("git-stacker"));
    }

    #[test]
    fn delegation_wrapper_classifies_with_sender_label() {
        let body = "<supermux-delegation from=\"git-stacker\">\nPlease rebase the stack.\n</supermux-delegation>";
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Delegation);
        assert_eq!(c.label.as_deref(), Some("git-stacker"));
        assert_eq!(c.text, "Please rebase the stack.");
    }

    #[test]
    fn delegation_kind_passes_the_chat_allowlist() {
        assert!(Kind::Delegation.is_user_initiated());
    }

    #[test]
    fn schedule_wrapper_classifies_and_strips_the_confirm_footer() {
        let body = "<supermux-schedule id=\"s1\" title=\"Nightly release watch\">\ncheck the release\n\n— — —\nWhen this scheduled task is FULLY complete… curl…\n</supermux-schedule>";
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Schedule);
        assert_eq!(c.label.as_deref(), Some("Nightly release watch"));
        assert_eq!(c.text, "check the release");
    }

    #[test]
    fn schedule_title_round_trips_through_attribute_escaping() {
        // `wrap_schedule` escapes the title (a schedule title is free text the
        // owner typed); recall decodes it, so the divider names the schedule the
        // way it is named in the scheduler, not `Ship &quot;it&quot;`.
        let body = crate::scheduler::runner::wrap_schedule(
            "s2",
            "Ship \"it\" <now> & later",
            "do the thing",
        );
        let c = classify_str(&body);
        assert_eq!(c.kind, Kind::Schedule);
        assert_eq!(c.label.as_deref(), Some("Ship \"it\" <now> & later"));
        assert_eq!(c.text, "do the thing");
    }

    #[test]
    fn schedule_without_a_title_still_shows_its_prompt() {
        // Unlike a delegation — whose whole provenance IS the `from` attribute —
        // the schedule tag itself proves who sent this, so a title-less schedule
        // stays a schedule turn (unnamed) rather than degrading into a system
        // line that hides the prompt from the transcript.
        let body = "<supermux-schedule id=\"s3\" title=\"\">\nrun the sweep\n</supermux-schedule>";
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::Schedule);
        assert!(c.label.is_none());
        assert_eq!(c.text, "run the sweep");
    }

    #[test]
    fn schedule_kind_passes_the_chat_allowlist() {
        assert!(Kind::Schedule.is_user_initiated());
    }

    #[test]
    fn schedule_wrapper_survives_the_typed_prompt_source() {
        // Same live-verified property as the delegation wrapper: a scheduled
        // prompt rides the pty like a keystroke, so Claude Code stamps it
        // `promptSource: "typed"`. Without the supermux-namespaced escape the
        // typed hard-override would print it as the owner's own bubble — the
        // impersonation this task exists to end.
        let v = serde_json::json!({
            "type": "user",
            "promptSource": "typed",
            "message": {
                "role": "user",
                "content": "<supermux-schedule id=\"s1\" title=\"Nightly\">\ncheck the release\n</supermux-schedule>",
            },
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::Schedule);
        assert_eq!(c.label.as_deref(), Some("Nightly"));
        assert_eq!(c.text, "check the release");
    }

    #[test]
    fn kind_wire_strings_are_the_contract_the_client_mirrors() {
        // `RecallEntryKind` in `web/src/lib/api/sessions.ts` is a hand-written
        // mirror of this enum, and the two ship independently. Pin every wire
        // string here so a `rename_all` change or a variant rename fails HERE,
        // loudly, instead of silently reaching a client that has no chip for it
        // (`components/focus-mode/recall-kind-meta.ts` is the other half).
        let wire = |k: Kind| serde_json::to_value(k).unwrap().as_str().unwrap().to_string();
        assert_eq!(wire(Kind::Prompt), "prompt");
        assert_eq!(wire(Kind::Command), "command");
        assert_eq!(wire(Kind::Teammate), "teammate");
        assert_eq!(wire(Kind::Delegation), "delegation");
        assert_eq!(wire(Kind::Schedule), "schedule");
        assert_eq!(wire(Kind::Notification), "notification");
        assert_eq!(wire(Kind::System), "system");
        assert_eq!(wire(Kind::Tool), "tool");
        assert_eq!(wire(Kind::Image), "image");
        assert_eq!(wire(Kind::Assistant), "assistant");
        assert_eq!(wire(Kind::ToolUse), "tool_use");
    }

    #[test]
    fn delegation_wrapper_survives_the_typed_prompt_source() {
        // Live-verified: a delegated prompt rides the pty like a keystroke, so
        // Claude Code stamps it `promptSource: "typed"`. Without the
        // supermux-namespaced escape the typed hard-override would classify it
        // as the owner's own bubble and the wrapper would be dead on arrival.
        let v = serde_json::json!({
            "type": "user",
            "promptSource": "typed",
            "message": {
                "role": "user",
                "content": "<supermux-delegation from=\"deploy-fix\">\nship it\n</supermux-delegation>",
            },
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::Delegation);
        assert_eq!(c.label.as_deref(), Some("deploy-fix"));
        assert_eq!(c.text, "ship it");
    }

    #[test]
    fn typed_override_still_protects_a_pasted_harness_tag() {
        // The escape is scoped to the `supermux-` namespace: a human pasting a
        // quoted `<task-notification>` stays a prompt (the original reason the
        // typed override is a hard override).
        let v = serde_json::json!({
            "type": "user",
            "promptSource": "typed",
            "message": {
                "role": "user",
                "content": "<task-notification><summary>look at this</summary></task-notification>",
            },
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::Prompt);
    }

    #[test]
    fn delegation_without_a_sender_degrades_to_system() {
        // Never let a malformed wrapper leak as a bare prompt.
        let c = classify_str("<supermux-delegation>\nno sender here\n</supermux-delegation>");
        assert_eq!(c.kind, Kind::System);
    }

    #[test]
    fn classify_is_meta_local_caveat_falls_into_system() {
        let v = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": {
                "role": "user",
                "content": "<local-command-caveat>Caveat: ...</local-command-caveat>"
            }
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::System);
        assert_eq!(c.label.as_deref(), Some("local-command-caveat"));
    }

    #[test]
    fn classify_image_placeholder() {
        let v = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": {
                "role": "user",
                "content": "[Image: original 945x2048, displayed at 480x1040]"
            }
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::Image);
        assert!(c.text.starts_with("[Image:"));
    }

    #[test]
    fn classify_tool_result_array() {
        let v = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    { "type": "tool_result", "tool_use_id": "x", "content": "out" }
                ]
            }
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::Tool);
    }

    #[test]
    fn classify_unknown_wrapper_degrades_to_system() {
        // Robustness: a brand-new harness wrapper Claude Code might add in
        // the future. Must NOT leak as a prompt; must land in `system`
        // with the tag name as the badge label so the UI can render it.
        let body = "<future-event>something happened</future-event>";
        let c = classify_str(body);
        assert_eq!(c.kind, Kind::System);
        assert_eq!(c.label.as_deref(), Some("future-event"));
        assert_eq!(c.text, "something happened");
    }

    #[test]
    fn classify_prompt_source_system_is_synthetic_even_without_wrapper() {
        let v = serde_json::json!({
            "type": "user",
            "promptSource": "system",
            "message": { "role": "user", "content": "session continued from a previous conversation" }
        });
        let c = classify_user(&v).unwrap();
        assert_eq!(c.kind, Kind::System);
    }

    #[test]
    fn gather_default_hides_system_events() {
        // Repro of the bug the user reported: a `<task-notification>` from a
        // background agent must NOT appear in the default view.
        let td = temp_dir();
        let cc = "k";
        write_jsonl(
            &td,
            cc,
            &[
                &user_line("u1", "2026-06-05T10:00:00Z", "real prompt", false),
                &assistant_line("a1", "2026-06-05T10:00:05Z", "ok", false),
                &user_line(
                    "u2",
                    "2026-06-05T10:00:10Z",
                    "<task-notification><summary>Agent X completed</summary></task-notification>",
                    false,
                ),
            ],
        );

        // Default: only the typed prompt.
        let hidden =
            gather_in_proj(&td, cc, Scope::Session, "", false, false, false, None, 10);
        assert_eq!(hidden.entries.len(), 1);
        assert_eq!(hidden.entries[0].text, "real prompt");

        // Toggle on: both visible, notification rendered as its summary.
        let shown =
            gather_in_proj(&td, cc, Scope::Session, "", false, true, false, None, 10);
        assert_eq!(shown.entries.len(), 2);
        assert_eq!(shown.entries[0].kind, Kind::Notification);
        assert_eq!(shown.entries[0].text, "Agent X completed");
    }

    #[test]
    fn empty_when_no_cc_id_or_no_file() {
        let proj = temp_dir();
        // Empty cc_id + Session scope → empty.
        let r = gather_in_proj(&proj, "", Scope::Session, "", false, true, false, None, 10);
        assert!(r.entries.is_empty());
        assert!(!r.has_more);

        // Non-existent file → empty, no error.
        let r = gather_in_proj(
            &proj,
            "does-not-exist",
            Scope::Session,
            "",
            false,
            true,
            false,
            None,
            10,
        );
        assert!(r.entries.is_empty());

        // Empty project dir + Project scope → empty.
        let r = gather_in_proj(&proj, "", Scope::Project, "", false, true, false, None, 10);
        assert!(r.entries.is_empty());
    }

    // ── chat view (fase A1) ─────────────────────────────────────────────────

    fn assistant_tool_use_line(
        uuid: &str,
        ts: &str,
        id: &str,
        name: &str,
        input: serde_json::Value,
    ) -> String {
        serde_json::json!({
            "type": "assistant", "uuid": uuid, "timestamp": ts, "isSidechain": false,
            "message": { "role": "assistant", "content": [
                {"type": "tool_use", "id": id, "name": name, "input": input}
            ]},
        })
        .to_string()
    }

    fn user_tool_result_line(
        uuid: &str,
        ts: &str,
        id: &str,
        text: &str,
        is_error: bool,
    ) -> String {
        serde_json::json!({
            "type": "user", "uuid": uuid, "timestamp": ts, "isSidechain": false,
            "message": { "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": id, "content": text, "is_error": is_error}
            ]},
        })
        .to_string()
    }

    #[test]
    fn chat_view_emits_assistant_and_tool_entries_newest_first() {
        let proj = temp_dir();
        let cc = "chat1";
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "do the thing", false),
                &assistant_tool_use_line("a1", "2026-01-01T10:00:02Z", "tu_1", "Read",
                    serde_json::json!({"file_path": "src/tile.tsx"})),
                &user_tool_result_line("r1", "2026-01-01T10:00:03Z", "tu_1", "file contents here", false),
                &assistant_line("a2", "2026-01-01T10:00:05Z", "done, looks good.", false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        // Newest-first: text, tool_use, prompt. The tool_result is FOLDED, not its own entry.
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[0].kind, Kind::Assistant);
        assert_eq!(r.entries[0].text, "done, looks good.");
        assert_eq!(r.entries[1].kind, Kind::ToolUse);
        assert_eq!(r.entries[1].text, "Read src/tile.tsx");
        assert_eq!(r.entries[1].label.as_deref(), Some("Read"));
        assert_eq!(r.entries[1].reply.as_deref(), Some("file contents here"));
        assert_eq!(r.entries[1].ok, Some(true));
        assert_eq!(r.entries[2].kind, Kind::Prompt);
        assert_eq!(r.entries[2].text, "do the thing");
    }

    /// An assistant message longer than the PROMPT preview cap must arrive
    /// whole. The chat view renders the message itself, so reusing the
    /// popover's 8 000-char preview budget cut real answers mid-word with no
    /// marker and no continuation — the reader could not tell. Assistant text
    /// blocks past 8 000 chars exist in this host's own transcripts.
    #[test]
    fn chat_view_assistant_text_survives_the_prompt_preview_cap() {
        let proj = temp_dir();
        let cc = "chat-longprose";
        let long = "y".repeat(PROMPT_MAX_CHARS + 732);
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "explain", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", &long, false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        let e = r.entries.iter().find(|e| e.kind == Kind::Assistant).unwrap();
        assert_eq!(
            e.text.chars().count(),
            PROMPT_MAX_CHARS + 732,
            "assistant prose must not be clipped at the prompt preview cap"
        );
        assert_eq!(e.truncated, None, "nothing was clipped, so no marker");
    }

    /// A USER prompt keeps the preview budget — the chat view must not become
    /// a licence to ship an unbounded prompt down the popover's wire shape.
    #[test]
    fn chat_view_user_prompt_keeps_the_preview_cap_and_is_flagged() {
        let proj = temp_dir();
        let cc = "chat-longprompt";
        let long = "z".repeat(PROMPT_MAX_CHARS + 500);
        write_jsonl(
            &proj,
            cc,
            &[&user_line("u1", "2026-01-01T10:00:00Z", &long, false)],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        let e = r.entries.iter().find(|e| e.kind == Kind::Prompt).unwrap();
        assert_eq!(e.text.chars().count(), PROMPT_MAX_CHARS);
        assert_eq!(
            e.truncated,
            Some(true),
            "a clipped entry must say so on the wire"
        );
    }

    /// Even the generous assistant cap is a cap — when it bites, the entry is
    /// flagged rather than silently ending mid-sentence.
    #[test]
    fn chat_view_assistant_beyond_its_own_cap_is_flagged() {
        let proj = temp_dir();
        let cc = "chat-hugeprose";
        let huge = "w".repeat(ASSISTANT_MAX_CHARS + 10);
        write_jsonl(
            &proj,
            cc,
            &[&assistant_line("a1", "2026-01-01T10:00:05Z", &huge, false)],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        let e = r.entries.iter().find(|e| e.kind == Kind::Assistant).unwrap();
        assert_eq!(e.text.chars().count(), ASSISTANT_MAX_CHARS);
        assert_eq!(e.truncated, Some(true));
    }

    // ── chat parse cache: slot policy ───────────────────────────────
    //
    // Driven against a local slot vec, not the process-wide static, so the
    // policy is pinned deterministically while tests run in parallel.

    fn slot_entries(tag: &str) -> std::sync::Arc<Vec<RecallEntry>> {
        std::sync::Arc::new(vec![RecallEntry {
            uuid: tag.to_string(),
            ts: 0,
            session_id: tag.to_string(),
            session_title: None,
            text: tag.to_string(),
            reply: None,
            sidechain: false,
            kind: Kind::Assistant,
            label: None,
            ok: None,
            truncated: None,
        }])
    }

    /// A hit hands back the SAME allocation. The previous single-slot cache
    /// deep-cloned the whole entry vector on every hit — while holding the
    /// mutex — to serve at most `limit + 1` rows.
    #[test]
    fn chat_cache_hit_shares_the_allocation_instead_of_cloning_it() {
        let mut slots = Vec::new();
        let t = SystemTime::UNIX_EPOCH;
        let stored = slot_entries("a");
        cache_put(&mut slots, Path::new("/a.jsonl"), t, 10, &stored);
        let hit = cache_get(&mut slots, Path::new("/a.jsonl"), t, 10).expect("hit");
        assert!(
            std::sync::Arc::ptr_eq(&stored, &hit),
            "a cache hit must not copy the entries"
        );
    }

    /// Two clients on two sessions (and every `scope=project` walk) alternate
    /// paths. With one slot each file evicted the other and EVERY poll was a
    /// miss — a full re-parse of the transcript, twice per tick.
    #[test]
    fn chat_cache_keeps_alternating_paths_warm() {
        let mut slots = Vec::new();
        let t = SystemTime::UNIX_EPOCH;
        let a = slot_entries("a");
        let b = slot_entries("b");
        cache_put(&mut slots, Path::new("/a.jsonl"), t, 1, &a);
        cache_put(&mut slots, Path::new("/b.jsonl"), t, 1, &b);
        assert!(cache_get(&mut slots, Path::new("/a.jsonl"), t, 1).is_some());
        assert!(cache_get(&mut slots, Path::new("/b.jsonl"), t, 1).is_some());
    }

    /// A grown/rewritten file (mtime or len changed) must MISS, and must not
    /// leave the stale generation behind.
    #[test]
    fn chat_cache_misses_on_a_changed_file_and_replaces_the_slot() {
        let mut slots = Vec::new();
        let t = SystemTime::UNIX_EPOCH;
        cache_put(&mut slots, Path::new("/a.jsonl"), t, 10, &slot_entries("v1"));
        assert!(
            cache_get(&mut slots, Path::new("/a.jsonl"), t, 20).is_none(),
            "a grown file must not serve the stale parse"
        );
        cache_put(&mut slots, Path::new("/a.jsonl"), t, 20, &slot_entries("v2"));
        assert_eq!(slots.len(), 1, "the stale generation must be replaced");
        let hit = cache_get(&mut slots, Path::new("/a.jsonl"), t, 20).unwrap();
        assert_eq!(hit[0].uuid, "v2");
    }

    /// The cache is bounded, and it evicts the LEAST-recently-used slot — a
    /// `scope=project` walk over a large project dir must not be able to
    /// unbound it.
    #[test]
    fn chat_cache_is_bounded_and_evicts_lru() {
        let mut slots = Vec::new();
        let t = SystemTime::UNIX_EPOCH;
        for i in 0..CHAT_CACHE_SLOTS {
            let p = format!("/f{i}.jsonl");
            cache_put(&mut slots, Path::new(&p), t, 1, &slot_entries(&p));
        }
        // Touch the oldest so it is no longer the LRU victim.
        assert!(cache_get(&mut slots, Path::new("/f0.jsonl"), t, 1).is_some());
        cache_put(&mut slots, Path::new("/new.jsonl"), t, 1, &slot_entries("new"));
        assert_eq!(slots.len(), CHAT_CACHE_SLOTS);
        assert!(
            cache_get(&mut slots, Path::new("/f0.jsonl"), t, 1).is_some(),
            "the recently used slot must survive"
        );
        assert!(
            cache_get(&mut slots, Path::new("/f1.jsonl"), t, 1).is_none(),
            "the least-recently-used slot must be the one evicted"
        );
    }

    // ── preview allocation bound ────────────────────────────────────

    /// A 600-char preview must not cost three copies of the whole tool
    /// result. `tool_result_text` now takes only the budget it can possibly
    /// need, and the preview is byte-identical to the unbounded computation.
    #[test]
    fn tool_result_preview_is_bounded_and_unchanged() {
        let huge = "a".repeat(2_000_000);
        let block = serde_json::json!({"type": "tool_result", "content": huge.clone()});
        let taken = tool_result_text(&block, preview_budget(REPLY_MAX_CHARS));
        assert_eq!(
            taken.chars().count(),
            preview_budget(REPLY_MAX_CHARS),
            "must copy only the preview budget, not the whole 2 MB result"
        );
        assert_eq!(
            preview(&taken, REPLY_MAX_CHARS),
            clamp(&sanitise_text(&huge), REPLY_MAX_CHARS),
            "the bounded path must produce the same preview as the unbounded one"
        );
    }

    /// The headroom is real: an ANSI-dense result (every visible char wrapped
    /// in an escape sequence) still yields a FULL preview after sanitising.
    #[test]
    fn ansi_dense_result_still_yields_a_full_preview() {
        let unit = "\u{1b}[31mx\u{1b}[0m"; // 9 source chars → 1 visible
        let dense = unit.repeat(4_000);
        let block = serde_json::json!({"type": "tool_result", "content": dense.clone()});
        let taken = tool_result_text(&block, preview_budget(REPLY_MAX_CHARS));
        assert_eq!(
            preview(&taken, REPLY_MAX_CHARS).chars().count(),
            REPLY_MAX_CHARS,
            "escape-heavy output must still fill the preview"
        );
        assert_eq!(
            preview(&taken, REPLY_MAX_CHARS),
            clamp(&sanitise_text(&dense), REPLY_MAX_CHARS)
        );
    }

    /// Array-form `tool_result` content is bounded per part AND in total.
    #[test]
    fn array_tool_result_is_bounded_too() {
        let block = serde_json::json!({
            "type": "tool_result",
            "content": [
                {"type": "text", "text": "b".repeat(1_000_000)},
                {"type": "text", "text": "c".repeat(1_000_000)},
            ],
        });
        let budget = preview_budget(REPLY_MAX_CHARS);
        let taken = tool_result_text(&block, budget);
        assert!(
            taken.chars().count() <= budget + 1,
            "array parts must respect the budget, got {}",
            taken.chars().count()
        );
        assert_eq!(preview(&taken, REPLY_MAX_CHARS).chars().count(), REPLY_MAX_CHARS);
    }

    #[test]
    fn chat_view_assistant_text_is_full_not_reply_preview() {
        // The legacy view clamps replies at REPLY_MAX_CHARS (600); the chat view
        // must carry the FULL text (up to the 8K wire clamp).
        let proj = temp_dir();
        let cc = "chat2";
        let long = "x".repeat(REPLY_MAX_CHARS + 500); // 1100 chars — over 600, under 8000
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "q", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", &long, false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        let text_entry = r.entries.iter().find(|e| e.kind == Kind::Assistant).unwrap();
        assert_eq!(text_entry.text.chars().count(), REPLY_MAX_CHARS + 500);
    }

    #[test]
    fn chat_view_tool_result_error_sets_ok_false() {
        let proj = temp_dir();
        let cc = "chat3";
        write_jsonl(
            &proj,
            cc,
            &[
                &assistant_tool_use_line("a1", "2026-01-01T10:00:02Z", "tu_9", "Bash",
                    serde_json::json!({"command": "cargo test"})),
                &user_tool_result_line("r1", "2026-01-01T10:00:04Z", "tu_9", "error: test failed", true),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].ok, Some(false));
        assert_eq!(r.entries[0].reply.as_deref(), Some("error: test failed"));
    }

    #[test]
    fn chat_view_hides_sidechains_and_system_noise() {
        let proj = temp_dir();
        let cc = "chat4";
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "main q", false),
                &user_line("u2", "2026-01-01T10:00:01Z", "sub q", true),
                &assistant_line("a1", "2026-01-01T10:00:02Z", "sub r", true),
                &user_line(
                    "u3",
                    "2026-01-01T10:00:03Z",
                    "<task-notification><summary>Agent X done</summary></task-notification>",
                    false,
                ),
                &assistant_line("a2", "2026-01-01T10:00:05Z", "main r", false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        // Only: main r (assistant), main q (prompt). Sidechains + notification hidden.
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].text, "main r");
        assert_eq!(r.entries[1].text, "main q");
    }

    #[test]
    fn chat_view_paginates_with_cursor_across_mixed_kinds() {
        let proj = temp_dir();
        let cc = "chat5";
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "q1", false),
                &assistant_line("a1", "2026-01-01T10:00:02Z", "r1", false),
                &user_line("u2", "2026-01-01T10:01:00Z", "q2", false),
                &assistant_line("a2", "2026-01-01T10:01:02Z", "r2", false),
            ],
        );
        let p1 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 2);
        assert_eq!(p1.entries.len(), 2);
        assert!(p1.has_more);
        assert_eq!(p1.entries[0].text, "r2");
        assert_eq!(p1.entries[1].text, "q2");
        let cur = p1.next_before.expect("cursor");
        let p2 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, Some(&cur), 2);
        assert_eq!(p2.entries[0].text, "r1");
        assert_eq!(p2.entries[1].text, "q1");
        assert!(!p2.has_more);
    }

    #[test]
    fn chat_view_parse_cache_serves_unchanged_files_and_invalidates_on_append() {
        // The A1 client re-pulls the focused tail on every SSE tick; an
        // unchanged transcript must cost a stat, and an append must invalidate.
        let proj = temp_dir();
        let cc = "chat6";
        write_jsonl(&proj, cc, &[&user_line("u1", "2026-01-01T10:00:00Z", "q1", false)]);
        let r1 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r1.entries.len(), 1);
        // Second read of the unchanged file: identical tail (served from cache).
        let r2 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r2.entries.len(), 1);
        // Append (mtime/len change) → the new entry appears.
        append_jsonl(&proj, cc, &[&assistant_line("a1", "2026-01-01T10:00:05Z", "r1", false)]);
        let r3 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r3.entries.len(), 2);
        assert_eq!(r3.entries[0].text, "r1");
    }
}
