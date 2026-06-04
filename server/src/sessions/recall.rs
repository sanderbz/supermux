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
    before: Option<&str>,
    limit: usize,
) -> RecallResponse {
    let proj = resumable::project_dir_for(dir);
    gather_in_proj(&proj, cc_id, scope, search, include_sidechains, before, limit)
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
                let Some(text) = extract_message_text(&v) else {
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
                let raw = sanitise_text(&text);
                entries.push(RecallEntry {
                    uuid,
                    ts,
                    session_id: session_id.clone(),
                    session_title: None, // filled below from `latest_title`
                    // Keep the FULL sanitised text in memory so substring search
                    // can match needles past PROMPT_MAX_CHARS; the clamp is
                    // applied on the wire by `gather_in_proj`'s response build.
                    text: raw,
                    reply: None,
                    sidechain,
                });
                pending_idx = Some(entries.len() - 1);
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

/// Extract the human-readable text from a Claude Code `message` block (either
/// `user` or `assistant`). Content is either a bare string or an array of typed
/// blocks; we concatenate every `text` block in order with paragraph breaks so
/// the user's typed separators survive intact. Non-text blocks (`tool_use`,
/// `tool_result`, image data) are skipped — they're machine artefacts the
/// recall popover never wants to show.
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
        let resp = gather_in_proj(&td, "c2", Scope::Session, "", false, None, 10);
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
        let resp = gather_in_proj(&td, "s", Scope::Session, "needle-here", false, None, 10);
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

        let page1 = gather_in_proj(&proj, cc, Scope::Session, "", false, None, 2);
        assert_eq!(page1.entries.len(), 2);
        assert!(page1.has_more);
        // Newest-first → "prompt 4", "prompt 3".
        assert_eq!(page1.entries[0].text, "prompt 4");
        assert_eq!(page1.entries[1].text, "prompt 3");
        let cursor = page1.next_before.expect("cursor on hasMore");

        let page2 = gather_in_proj(&proj, cc, Scope::Session, "", false, Some(&cursor), 2);
        assert_eq!(page2.entries.len(), 2);
        assert_eq!(page2.entries[0].text, "prompt 2");
        assert_eq!(page2.entries[1].text, "prompt 1");

        let page3 = gather_in_proj(
            &proj,
            cc,
            Scope::Session,
            "",
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
        let r = gather_in_proj(&proj, cc, Scope::Session, "oauth", false, None, 10);
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

        let r = gather_in_proj(&proj, "newer", Scope::Project, "", false, None, 10);
        assert_eq!(r.entries.len(), 2);
        // Newer file first.
        assert_eq!(r.entries[0].text, "newer prompt");
        assert_eq!(r.entries[0].session_id, "newer");
        assert_eq!(r.entries[1].text, "older prompt");
        assert_eq!(r.entries[1].session_id, "older");
    }

    #[test]
    fn empty_when_no_cc_id_or_no_file() {
        let proj = temp_dir();
        // Empty cc_id + Session scope → empty.
        let r = gather_in_proj(&proj, "", Scope::Session, "", false, None, 10);
        assert!(r.entries.is_empty());
        assert!(!r.has_more);

        // Non-existent file → empty, no error.
        let r = gather_in_proj(
            &proj,
            "does-not-exist",
            Scope::Session,
            "",
            false,
            None,
            10,
        );
        assert!(r.entries.is_empty());

        // Empty project dir + Project scope → empty.
        let r = gather_in_proj(&proj, "", Scope::Project, "", false, None, 10);
        assert!(r.entries.is_empty());
    }
}
