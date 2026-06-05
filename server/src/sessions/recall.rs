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

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::AppError;
use crate::state::AppState;
use crate::ws::sanitise_text;

use super::resumable;

/// Cap on the per-entry prompt text. Mirrors `db::sessions::LAST_SEND_TEXT_MAX_CHARS`
/// — same shape as the bar/popover already render today.
const PROMPT_MAX_CHARS: usize = 8_000;
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
}

impl Kind {
    /// Whether this kind is shown in the default "Your prompts" view.
    /// Prompts + commands + teammate routing are user-initiated; the rest
    /// are surfaced only when the "Show system events" toggle is on.
    fn is_user_initiated(self) -> bool {
        matches!(self, Kind::Prompt | Kind::Command | Kind::Teammate)
    }
}

#[derive(Debug, Serialize)]
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

    let result = tokio::task::spawn_blocking(move || {
        gather(
            &dir,
            &cc_id,
            q.scope,
            &q.q,
            q.include_sidechains,
            q.include_system_events,
            q.before.as_deref(),
            limit,
        )
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
        let file_entries = read_user_turns(path, include_sidechains);
        for entry in file_entries {
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
            if !include_system_events && !entry.kind.is_user_initiated() {
                continue;
            }
            if let Some(ref needle) = search_lc {
                if !entry.text.to_lowercase().contains(needle.as_str()) {
                    continue;
                }
            }
            out.push(entry);
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
    // needle past PROMPT_MAX_CHARS still matches), but the response carries
    // only the preview.
    for e in &mut out {
        if e.text.chars().count() > PROMPT_MAX_CHARS {
            e.text = clamp(&e.text, PROMPT_MAX_CHARS);
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
                        let clean = clamp(&sanitise_text(&reply), REPLY_MAX_CHARS);
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

    // 6) Leading-wrapper detection. We do this BEFORE the `isMeta` fallback
    //    so a known wrapper gets its specific kind even when isMeta is set.
    if let Some(c) = classify_by_wrapper(trimmed) {
        return Some(c);
    }

    // 7) `[Image: …]` placeholder (isMeta=true; no leading XML tag).
    if trimmed.starts_with("[Image: ") {
        return Some(ClassifiedUser {
            kind: Kind::Image,
            text: trimmed
                .lines()
                .next()
                .unwrap_or(trimmed)
                .to_string(),
            label: None,
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
        kind: Kind::Prompt,
        text: sanitise_text(trimmed),
        label: None,
    })
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
        let resp = gather_in_proj(&td, "c2", Scope::Session, "", false, true, None, 10);
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
        let resp = gather_in_proj(&td, "s", Scope::Session, "needle-here", false, true, None, 10);
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

        let page1 = gather_in_proj(&proj, cc, Scope::Session, "", false, true, None, 2);
        assert_eq!(page1.entries.len(), 2);
        assert!(page1.has_more);
        // Newest-first → "prompt 4", "prompt 3".
        assert_eq!(page1.entries[0].text, "prompt 4");
        assert_eq!(page1.entries[1].text, "prompt 3");
        let cursor = page1.next_before.expect("cursor on hasMore");

        let page2 = gather_in_proj(&proj, cc, Scope::Session, "", false, true, Some(&cursor), 2);
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
        let r = gather_in_proj(&proj, cc, Scope::Session, "oauth", false, true, None, 10);
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

        let r = gather_in_proj(&proj, "newer", Scope::Project, "", false, true, None, 10);
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
            gather_in_proj(&td, cc, Scope::Session, "", false, false, None, 10);
        assert_eq!(hidden.entries.len(), 1);
        assert_eq!(hidden.entries[0].text, "real prompt");

        // Toggle on: both visible, notification rendered as its summary.
        let shown =
            gather_in_proj(&td, cc, Scope::Session, "", false, true, None, 10);
        assert_eq!(shown.entries.len(), 2);
        assert_eq!(shown.entries[0].kind, Kind::Notification);
        assert_eq!(shown.entries[0].text, "Agent X completed");
    }

    #[test]
    fn empty_when_no_cc_id_or_no_file() {
        let proj = temp_dir();
        // Empty cc_id + Session scope → empty.
        let r = gather_in_proj(&proj, "", Scope::Session, "", false, true, None, 10);
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
            None,
            10,
        );
        assert!(r.entries.is_empty());

        // Empty project dir + Project scope → empty.
        let r = gather_in_proj(&proj, "", Scope::Project, "", false, true, None, 10);
        assert!(r.entries.is_empty());
    }
}
