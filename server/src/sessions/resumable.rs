//! Resumable Claude conversations for a session's working dir
//! (feat-resume-picker).
//!
//! Starting a stopped session always launched a *clean* `claude`. The Resume
//! affordance lets the user reopen a PAST conversation for that session's dir
//! and resume it (`claude --resume <id>`). This module enumerates the
//! conversation transcripts Claude Code persists on disk and surfaces the
//! cheap metadata the picker needs.
//!
//! ── Where Claude stores conversations (verified empirically on this host) ──
//! `~/.claude/projects/<ENCODED_CWD>/<conversation-uuid>.jsonl` — one JSONL
//! file per conversation. The filename UUID IS the resume id: it equals the
//! `sessionId` field inside the transcript, and `claude --resume <uuid>` (the
//! launch builder already turns `cc_conversation_id` into `--resume <id>`).
//!
//! ── Path encoding (verified both directions against real dirs) ──
//! Claude maps the *resolved* absolute working dir to the project folder name
//! by replacing every `/` AND every `.` with `-`. The leading `/` becomes a
//! leading `-`. Examples confirmed on this machine:
//!   `/private/tmp/nltest`
//!     → `-private-tmp-nltest`
//!   `/private/var/www/my-app/.claude/worktrees/feature-x`
//!     → `-private-var-www-my-app--claude-worktrees-feature-x`
//!       (note the `--`: the `/` before `.claude` → `-`, the `.` → `-`).
//! The cwd is symlink-resolved first (macOS `/tmp` → `/private/tmp`), so we
//! `canonicalize()` before encoding and fall back to the raw dir if that fails
//! (e.g. the dir no longer exists). The encoding is lossy in reverse (a literal
//! `-` in a path component is indistinguishable from an encoded `/`/`.`), but
//! it is unambiguous in the forward direction — which is all we need: we encode
//! the session's cwd, then look up the folder.
//!
//! ── Conversation metadata (verified by inspecting real `*.jsonl` lines) ──
//! - **id**: the filename UUID (`<uuid>.jsonl`).
//! - **summary/title**: Claude writes `{"type":"ai-title","aiTitle":"…"}` lines
//!   (present in 119/153 transcripts on this host; re-emitted as the chat
//!   evolves — the LAST one is the freshest). We prefer the latest `aiTitle`,
//!   else the first user message text (its `message.content` is a string OR an
//!   array of typed blocks — we join the `text` blocks), else a placeholder.
//!   No `{"type":"summary"}` lines exist on this host (0/153), so we don't rely
//!   on them.
//! - **updated_at**: the file's mtime (RFC3339) — robust and parse-free.
//! - **message_count**: count of `user`/`assistant` (non-sidechain) lines.
//!
//! A single streaming pass reads each transcript once, JSON-parsing only the
//! lines we actually need (cheap substring pre-filter); mtime comes from the
//! dir entry's metadata. Even a 78 MB transcript scans in well under a second.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

/// One resumable conversation surfaced to the picker.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Resumable {
    /// The conversation UUID — the `claude --resume <id>` argument.
    pub id: String,
    /// Human title: latest `aiTitle`, else first user message, else a fallback.
    pub summary: String,
    /// RFC3339 last-activity timestamp (the transcript file's mtime).
    pub updated_at: String,
    /// Count of user + assistant messages (non-sidechain).
    pub message_count: usize,
}

/// Resolve Claude's config directory: `$CLAUDE_CONFIG_DIR` (Claude Code's own
/// override — also what tests target) else `$HOME/.claude`. Mirrors
/// [`crate::claude_config`]'s resolver so the two stay in lockstep. We read
/// transcripts from the SERVICE user's HOME (the server already runs with HOME
/// set).
fn claude_config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

/// Encode an absolute working dir to Claude's project-folder name: every `/`
/// and every `.` becomes `-`. (The leading `/` → leading `-`.)
pub fn encode_project_dir(abs_dir: &str) -> String {
    abs_dir
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

/// Resolve a session's working dir to its `~/.claude/projects/<encoded>` folder.
/// The cwd is symlink-canonicalized first (Claude records the resolved path);
/// if canonicalization fails (dir gone), we encode the raw dir as a fallback.
fn project_dir_for(dir: &str) -> PathBuf {
    let resolved = std::fs::canonicalize(dir)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.to_string());
    claude_config_dir()
        .join("projects")
        .join(encode_project_dir(&resolved))
}

/// Enumerate resumable Claude conversations for a working dir, newest-first.
///
/// Returns an empty list (never an error) when the dir has no project folder or
/// no transcripts — the picker just hides Resume. Per-file read/parse failures
/// are skipped rather than failing the whole listing.
pub fn list_for_dir(dir: &str) -> Vec<Resumable> {
    let proj = project_dir_for(dir);
    list_in_project_dir(&proj)
}

/// Core enumeration over an already-resolved project folder. Factored out so
/// tests can target a temp `<encoded>` dir directly.
fn list_in_project_dir(proj: &Path) -> Vec<Resumable> {
    let entries = match std::fs::read_dir(proj) {
        Ok(e) => e,
        Err(_) => return Vec::new(), // no project folder yet → empty
    };

    let mut out: Vec<(SystemTime, Resumable)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // Only top-level `*.jsonl` files (skip the `memory/` subdir etc.).
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);

        let parsed = parse_transcript(&path);
        out.push((
            mtime,
            Resumable {
                id,
                summary: parsed.summary,
                updated_at: system_time_to_rfc3339(mtime),
                message_count: parsed.message_count,
            },
        ));
    }

    // Newest-first by mtime.
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, r)| r).collect()
}

struct Parsed {
    summary: String,
    message_count: usize,
}

/// Stream a transcript once, extracting only the cheap metadata. JSON parsing is
/// gated behind a substring pre-filter so we never parse the bulk tool/result
/// lines — only `ai-title` lines and the first user line.
fn parse_transcript(path: &Path) -> Parsed {
    use std::io::{BufRead, BufReader};

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return Parsed {
                summary: fallback_summary(None, None),
                message_count: 0,
            }
        }
    };
    let reader = BufReader::new(file);

    let mut latest_ai_title: Option<String> = None;
    let mut first_user_text: Option<String> = None;
    let mut message_count: usize = 0;

    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Cheap substring gate: only the lines we care about reach serde.
        let is_title = line.contains("\"ai-title\"");
        let is_user = line.contains("\"type\":\"user\"");
        let is_assistant = line.contains("\"type\":\"assistant\"");

        if !is_title && !is_user && !is_assistant {
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
                        latest_ai_title = Some(t.to_string());
                    }
                }
            }
            "user" | "assistant" => {
                // Skip sub-agent (sidechain) turns from the count + summary.
                if v.get("isSidechain").and_then(|b| b.as_bool()) == Some(true) {
                    continue;
                }
                message_count += 1;
                if ty == "user" && first_user_text.is_none() {
                    if let Some(t) = extract_user_text(&v) {
                        first_user_text = Some(t);
                    }
                }
            }
            _ => {}
        }
    }

    Parsed {
        summary: fallback_summary(latest_ai_title, first_user_text),
        message_count,
    }
}

/// Pull the text of a user message. `message.content` is either a string or an
/// array of typed blocks — we join the `text` blocks (ignoring images/tool
/// results). Returns `None` when there's no usable text.
fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            parts.join(" ").trim().to_string()
        }
        _ => return None,
    };
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Compose the display summary: latest `aiTitle` → first user message (trimmed)
/// → placeholder. The first-user-message fallback is collapsed to a single line.
fn fallback_summary(ai_title: Option<String>, first_user: Option<String>) -> String {
    if let Some(t) = ai_title {
        return t;
    }
    if let Some(u) = first_user {
        let collapsed: String = u.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            return collapsed;
        }
    }
    "Untitled conversation".to_string()
}

/// Format a `SystemTime` as an RFC3339 string (UTC) — matches the wire format
/// the rest of the sessions API uses (`to_rfc3339`).
fn system_time_to_rfc3339(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "supermux-resumable-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_jsonl(dir: &Path, id: &str, lines: &[&str]) -> PathBuf {
        let path = dir.join(format!("{id}.jsonl"));
        let mut f = std::fs::File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path
    }

    #[test]
    fn encoding_matches_real_claude_layout() {
        // Verified against this host's `~/.claude/projects`.
        assert_eq!(
            encode_project_dir("/private/tmp/nltest"),
            "-private-tmp-nltest"
        );
        // The `.claude` dot AND the slash before it both → `-` (the `--`).
        assert_eq!(
            encode_project_dir("/private/var/www/my-app/.claude/worktrees/feature-x"),
            "-private-var-www-my-app--claude-worktrees-feature-x"
        );
        // Literal dashes in components survive unchanged.
        assert_eq!(
            encode_project_dir("/Users/me/my-cool-project"),
            "-Users-me-my-cool-project"
        );
    }

    #[test]
    fn parses_title_count_and_sorts_newest_first() {
        let proj = temp_dir();

        // Conversation A: has an ai-title (latest wins over the earlier one).
        write_jsonl(
            &proj,
            "aaaaaaaa-0000-0000-0000-000000000001",
            &[
                r#"{"type":"ai-title","aiTitle":"Early guess","sessionId":"aaaaaaaa-0000-0000-0000-000000000001"}"#,
                r#"{"type":"user","message":{"role":"user","content":"hello there"},"isSidechain":false}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":"hi"}}"#,
                r#"{"type":"ai-title","aiTitle":"Refined title","sessionId":"aaaaaaaa-0000-0000-0000-000000000001"}"#,
            ],
        );

        // Sleep so B's mtime is strictly later than A's (APFS/ext4 carry
        // sub-second mtimes; a small gap makes the newest-first sort
        // deterministic without a `filetime` dev-dependency).
        std::thread::sleep(std::time::Duration::from_millis(20));

        // Conversation B: no ai-title → falls back to first user message; user
        // content is an ARRAY of typed blocks (text + image). A sidechain turn
        // must NOT count.
        write_jsonl(
            &proj,
            "bbbbbbbb-0000-0000-0000-000000000002",
            &[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"  array first user  "},{"type":"image"}]},"isSidechain":false}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":"ok"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"sidechain noise"},"isSidechain":true}"#,
            ],
        );

        let list = list_in_project_dir(&proj);
        assert_eq!(list.len(), 2);

        // Newest-first → B then A.
        assert_eq!(list[0].id, "bbbbbbbb-0000-0000-0000-000000000002");
        assert_eq!(list[0].summary, "array first user");
        assert_eq!(list[0].message_count, 2); // sidechain excluded

        assert_eq!(list[1].id, "aaaaaaaa-0000-0000-0000-000000000001");
        assert_eq!(list[1].summary, "Refined title"); // latest ai-title wins
        assert_eq!(list[1].message_count, 2);

        // updated_at is a parseable RFC3339 timestamp.
        assert!(chrono::DateTime::parse_from_rfc3339(&list[0].updated_at).is_ok());
    }

    #[test]
    fn empty_when_no_project_folder() {
        let missing = temp_dir().join("does-not-exist");
        assert!(list_in_project_dir(&missing).is_empty());
    }

    #[test]
    fn ignores_non_jsonl_and_subdirs() {
        let proj = temp_dir();
        std::fs::create_dir_all(proj.join("memory")).unwrap();
        std::fs::write(proj.join("notes.txt"), b"nope").unwrap();
        write_jsonl(
            &proj,
            "cccccccc-0000-0000-0000-000000000003",
            &[r#"{"type":"ai-title","aiTitle":"Only one"}"#],
        );
        let list = list_in_project_dir(&proj);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].summary, "Only one");
    }
}
