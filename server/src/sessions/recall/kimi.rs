//! Kimi Code prompt-history reader.
//!
//! Kimi keeps one append-only *wire* JSONL per session at
//! `$KIMI_CODE_HOME/sessions/wd_<slug>/session_<uuid>/agents/main/wire.jsonl`.
//! We read only the user-initiated `turn.prompt` events (the human-visible
//! conversation stream) and pair each with the first assistant text the model
//! streams back — mirroring [`super::codex`]'s `user_message` / `agent_message`
//! pairing.
//!
//! Session → project mapping comes from the global index
//! `$KIMI_CODE_HOME/session_index.jsonl` (one `{sessionId, sessionDir, workDir}`
//! per line). The index carries no timestamps, so "newest" is decided by the
//! wire file's mtime — obtained from a `stat`, without opening the file — which
//! also lets Session scope pick the target wire without reading every session.
//!
//! Source choice: we parse `wire.jsonl`, not the flat composer history at
//! `$KIMI_CODE_HOME/user-history/*.jsonl`. The latter is a single global
//! up-arrow buffer with no session id, no timestamp, no reply, and no reliable
//! working-dir association — it cannot support Session/Project scope, the
//! `(session_id, uuid)` cursor, or reply pairing. `wire.jsonl` is the faithful
//! analogue of Codex's per-thread rollout.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;

use super::{
    clamp, decode_cursor, encode_cursor, Kind, RecallEntry, RecallResponse, REPLY_MAX_CHARS,
};
use crate::ws::sanitise_text;

/// One session that ran in the query directory: its id plus the path + mtime of
/// its wire log. The mtime comes from a `stat` on the wire file — no open — so
/// ordering and Session-scope selection cost nothing beyond the directory read
/// of the (small) index.
struct Candidate {
    session_id: String,
    wire: PathBuf,
    modified: SystemTime,
}

/// One line of `$KIMI_CODE_HOME/session_index.jsonl`.
struct IndexEntry {
    session_id: String,
    session_dir: PathBuf,
    work_dir: String,
}

// Counts `read_wire` calls (each opens a wire log) so tests can assert Session
// scope reads exactly the target session, not every session in the project.
#[cfg(test)]
thread_local! {
    static WIRE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Entry point mirroring [`super::codex::gather`]. `last_started` is accepted
/// for dispatch symmetry but unused: the index has no per-session timestamp, so
/// Session scope without an id resolves to the newest wire by mtime (see the
/// module doc).
pub(super) fn gather(
    dir: &str,
    session_id: &str,
    last_started: i64,
    scope: super::Scope,
    search: &str,
    before: Option<&str>,
    limit: usize,
) -> RecallResponse {
    let _ = last_started;
    let home = kimi_home();
    gather_in_home(&home, dir, session_id, scope, search, before, limit)
}

fn kimi_home() -> PathBuf {
    std::env::var_os("KIMI_CODE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".kimi-code")))
        .unwrap_or_else(|| PathBuf::from(".kimi-code"))
}

#[allow(clippy::too_many_arguments)]
fn gather_in_home(
    home: &Path,
    dir: &str,
    session_id: &str,
    scope: super::Scope,
    search: &str,
    before: Option<&str>,
    limit: usize,
) -> RecallResponse {
    // Read the index once; keep only sessions that ran in `dir`; attach each
    // one's wire path + mtime (a `stat`, no open). Newest wire first.
    let target = resolve_dir(dir);
    let mut candidates: Vec<Candidate> = read_index(home)
        .into_iter()
        .filter(|e| same_dir(&e.work_dir, &target))
        .map(candidate_for)
        .collect();
    candidates.sort_by(|a, b| b.modified.cmp(&a.modified));

    let search = (!search.is_empty()).then(|| search.to_lowercase());
    let cursor = before.and_then(decode_cursor);

    match scope {
        super::Scope::Session => {
            let selected = select_session(&candidates, session_id);
            collect_entries(selected.into_iter(), &search, &cursor, limit)
        }
        super::Scope::Project => {
            // `collect_entries` pulls candidates lazily and stops once the page
            // (limit + 1) is full, so we only `read_wire` as far as this page
            // needs — not every session in the project.
            collect_entries(candidates.iter(), &search, &cursor, limit)
        }
    }
}

/// Pick the single session Session scope should return.
///
/// With an id, match it against the index (no wire opens). Without one — the
/// current reality, since the DB carries no `kimi_session_id` — fall back to the
/// newest wire, i.e. the first candidate (already sorted mtime-desc).
fn select_session<'a>(candidates: &'a [Candidate], session_id: &str) -> Option<&'a Candidate> {
    if !session_id.is_empty() {
        if let Some(found) = candidates
            .iter()
            .find(|c| id_matches(&c.session_id, session_id))
        {
            return Some(found);
        }
    }
    candidates.first()
}

/// Walk the selected candidates (already ordered) and build the page. Consumes
/// the iterator lazily so an early `break` skips unread wires.
fn collect_entries<'a>(
    candidates: impl Iterator<Item = &'a Candidate>,
    search: &Option<String>,
    cursor: &Option<(String, String)>,
    limit: usize,
) -> RecallResponse {
    let mut cursor_consumed = cursor.is_none();
    let mut entries = Vec::new();

    'files: for candidate in candidates {
        for entry in read_wire(candidate) {
            if !cursor_consumed {
                if let Some((ref sid, ref uuid)) = cursor {
                    if entry.session_id == *sid && entry.uuid == *uuid {
                        cursor_consumed = true;
                    }
                }
                continue;
            }
            if let Some(ref needle) = search {
                if !entry.text.to_lowercase().contains(needle) {
                    continue;
                }
            }
            entries.push(entry);
            if entries.len() > limit {
                break 'files;
            }
        }
    }

    let has_more = entries.len() > limit;
    if has_more {
        entries.truncate(limit);
    }
    for entry in &mut entries {
        if entry.text.chars().count() > super::PROMPT_MAX_CHARS {
            entry.text = clamp(&entry.text, super::PROMPT_MAX_CHARS);
        }
    }
    let next_before = has_more.then(|| {
        let entry = entries.last().expect("a paginated page is non-empty");
        encode_cursor(&entry.session_id, &entry.uuid)
    });

    RecallResponse {
        entries,
        has_more,
        next_before,
    }
}

fn read_index(home: &Path) -> Vec<IndexEntry> {
    let path = home.join("session_index.jsonl");
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (Some(session_id), Some(session_dir), Some(work_dir)) = (
            value.get("sessionId").and_then(Value::as_str),
            value.get("sessionDir").and_then(Value::as_str),
            value.get("workDir").and_then(Value::as_str),
        ) else {
            continue;
        };
        out.push(IndexEntry {
            session_id: session_id.to_string(),
            session_dir: PathBuf::from(session_dir),
            work_dir: work_dir.to_string(),
        });
    }
    out
}

fn candidate_for(entry: IndexEntry) -> Candidate {
    let wire = entry.session_dir.join("agents/main/wire.jsonl");
    let modified = fs::metadata(&wire)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    Candidate {
        session_id: entry.session_id,
        wire,
        modified,
    }
}

/// Compare an index `sessionId` against a wanted id, tolerating the `session_`
/// prefix on either side (the index stores `session_<uuid>`; a future DB field
/// might store the bare uuid).
fn id_matches(index_id: &str, wanted: &str) -> bool {
    fn norm(s: &str) -> &str {
        s.strip_prefix("session_").unwrap_or(s)
    }
    index_id == wanted || norm(index_id) == norm(wanted)
}

/// Stream one wire log forward, pair each user `turn.prompt` with the first
/// assistant text that follows, then reverse so the caller gets newest-first.
///
/// The prompt has no uuid of its own, so — like Codex — we stamp a per-file
/// sequence number; the cursor `(session_id, sequence)` is stable within a
/// session. Assistant `think` parts and tool events are skipped, so the reply
/// is the first human-visible text block of the turn.
fn read_wire(candidate: &Candidate) -> Vec<RecallEntry> {
    #[cfg(test)]
    WIRE_READS.with(|c| c.set(c.get() + 1));

    let Ok(file) = fs::File::open(&candidate.wire) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    let mut pending: Option<usize> = None;
    let mut sequence = 0usize;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // Cheap substring gate before any JSON parse.
        let is_prompt = line.contains("\"type\":\"turn.prompt\"");
        let is_part = line.contains("\"content.part\"");
        if !is_prompt && !is_part {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "turn.prompt" => {
                // Only user-initiated turns; harness/compaction prompts carry a
                // different `origin.kind`.
                let origin = value
                    .get("origin")
                    .and_then(|o| o.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if origin != "user" {
                    continue;
                }
                let raw = join_text_parts(value.get("input"));
                let clean = sanitise_text(raw.trim());
                if clean.is_empty() {
                    continue;
                }
                sequence += 1;
                let slash = clean
                    .strip_prefix('/')
                    .and_then(|s| s.split_whitespace().next())
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("/{s}"));
                entries.push(RecallEntry {
                    uuid: sequence.to_string(),
                    ts: ms_to_secs(value.get("time")),
                    session_id: candidate.session_id.clone(),
                    session_title: None,
                    text: clean,
                    reply: None,
                    sidechain: false,
                    kind: if slash.is_some() {
                        Kind::Command
                    } else {
                        Kind::Prompt
                    },
                    label: slash,
                });
                pending = Some(entries.len() - 1);
            }
            "context.append_loop_event" => {
                // The assistant's reply text is streamed as `content.part`
                // events with `part.type == "text"` (a `think` part is the
                // model's private reasoning — skip it). First text block wins.
                let Some(part) = value
                    .get("event")
                    .filter(|e| e.get("type").and_then(Value::as_str) == Some("content.part"))
                    .and_then(|e| e.get("part"))
                    .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                else {
                    continue;
                };
                if let Some(index) = pending {
                    let text = part.get("text").and_then(Value::as_str).unwrap_or("");
                    let reply = clamp(&sanitise_text(text.trim()), REPLY_MAX_CHARS);
                    if !reply.is_empty() {
                        entries[index].reply = Some(reply);
                        pending = None;
                    }
                }
            }
            _ => {}
        }
    }

    entries.reverse();
    entries
}

/// Concatenate the `text` parts of a `turn.prompt` `input` array (Kimi's prompt
/// is an array of typed parts, same shape as Claude Code content blocks). A bare
/// string is accepted too, defensively.
fn join_text_parts(input: Option<&Value>) -> String {
    match input {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n"),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// Kimi timestamps are epoch milliseconds (`time`, `created_at`); RecallEntry
/// wants epoch seconds.
fn ms_to_secs(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).map(|ms| ms / 1000).unwrap_or(0)
}

/// The query directory resolved once, so `same_dir` need not re-`canonicalize`
/// it per session. Mirrors [`super::codex`]'s `DirMatch`.
struct DirMatch {
    canonical: Option<PathBuf>,
    trimmed: String,
}

fn resolve_dir(dir: &str) -> DirMatch {
    DirMatch {
        canonical: fs::canonicalize(dir).ok(),
        trimmed: dir.trim_end_matches('/').to_string(),
    }
}

fn same_dir(work_dir: &str, target: &DirMatch) -> bool {
    match (fs::canonicalize(work_dir), &target.canonical) {
        (Ok(work_dir), Some(canonical)) => &work_dir == canonical,
        _ => work_dir.trim_end_matches('/') == target.trimmed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a temp `$KIMI_CODE_HOME`.
    fn temp_home() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "supermux-kimi-recall-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Append a session: write its `wire.jsonl` (metadata + prompt + a think
    /// part + a text reply) and add the matching `session_index.jsonl` line.
    fn write_session(
        home: &Path,
        wd_slug: &str,
        session_id: &str,
        work_dir: &str,
        ts_ms: i64,
        prompt: &str,
        reply: &str,
    ) {
        let session_dir = home.join("sessions").join(wd_slug).join(session_id);
        let wire_dir = session_dir.join("agents/main");
        fs::create_dir_all(&wire_dir).unwrap();
        let lines = [
            serde_json::json!({"type": "metadata", "protocol_version": "1.4", "created_at": ts_ms}),
            serde_json::json!({
                "type": "turn.prompt",
                "input": [{"type": "text", "text": prompt}],
                "origin": {"kind": "user"},
                "time": ts_ms,
            }),
            serde_json::json!({
                "type": "context.append_loop_event",
                "event": {"type": "content.part", "part": {"type": "think", "think": "pondering"}},
                "time": ts_ms + 1,
            }),
            serde_json::json!({
                "type": "context.append_loop_event",
                "event": {"type": "content.part", "part": {"type": "text", "text": reply}},
                "time": ts_ms + 2,
            }),
        ];
        let mut f = fs::File::create(wire_dir.join("wire.jsonl")).unwrap();
        for l in &lines {
            writeln!(f, "{l}").unwrap();
        }

        let index_line = serde_json::json!({
            "sessionId": session_id,
            "sessionDir": session_dir.to_str().unwrap(),
            "workDir": work_dir,
        });
        let mut idx = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(home.join("session_index.jsonl"))
            .unwrap();
        writeln!(idx, "{index_line}").unwrap();
    }

    fn candidate(home: &Path, wd_slug: &str, session_id: &str) -> Candidate {
        candidate_for(IndexEntry {
            session_id: session_id.to_string(),
            session_dir: home.join("sessions").join(wd_slug).join(session_id),
            work_dir: String::new(),
        })
    }

    #[test]
    fn read_wire_pairs_prompt_with_first_text_and_stamps_fields() {
        let home = temp_home();
        write_session(
            &home,
            "wd_proj",
            "session_aaa",
            "/tmp/proj",
            1_784_000_000_000,
            "summarize the files",
            "## File Summaries\nhere they are",
        );
        let got = read_wire(&candidate(&home, "wd_proj", "session_aaa"));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "summarize the files");
        assert_eq!(got[0].kind, Kind::Prompt);
        assert!(!got[0].sidechain);
        assert_eq!(got[0].uuid, "1");
        assert_eq!(got[0].session_id, "session_aaa");
        assert_eq!(got[0].ts, 1_784_000_000); // ms → s
        // Reply is the first TEXT part; the `think` part is skipped.
        assert_eq!(
            got[0].reply.as_deref(),
            Some("## File Summaries\nhere they are")
        );
    }

    #[test]
    fn read_wire_classifies_slash_command_and_reverses_newest_first() {
        let home = temp_home();
        let session_dir = home.join("sessions/wd_proj/session_multi/agents/main");
        fs::create_dir_all(&session_dir).unwrap();
        let lines = [
            serde_json::json!({
                "type": "turn.prompt",
                "input": [{"type": "text", "text": "first prompt"}],
                "origin": {"kind": "user"},
                "time": 1_784_000_000_000i64,
            }),
            serde_json::json!({
                "type": "turn.prompt",
                "input": [{"type": "text", "text": "/review the diff"}],
                "origin": {"kind": "user"},
                "time": 1_784_000_100_000i64,
            }),
        ];
        let mut f = fs::File::create(session_dir.join("wire.jsonl")).unwrap();
        for l in &lines {
            writeln!(f, "{l}").unwrap();
        }
        let got = read_wire(&candidate(&home, "wd_proj", "session_multi"));
        assert_eq!(got.len(), 2);
        // Newest-first.
        assert_eq!(got[0].text, "/review the diff");
        assert_eq!(got[0].kind, Kind::Command);
        assert_eq!(got[0].label.as_deref(), Some("/review"));
        assert_eq!(got[1].text, "first prompt");
        assert_eq!(got[1].kind, Kind::Prompt);
    }

    #[test]
    fn read_wire_ignores_non_user_turns() {
        let home = temp_home();
        let session_dir = home.join("sessions/wd_proj/session_sys/agents/main");
        fs::create_dir_all(&session_dir).unwrap();
        let lines = [
            serde_json::json!({
                "type": "turn.prompt",
                "input": [{"type": "text", "text": "compaction summary"}],
                "origin": {"kind": "system"},
                "time": 1i64,
            }),
            serde_json::json!({
                "type": "turn.prompt",
                "input": [{"type": "text", "text": "real prompt"}],
                "origin": {"kind": "user"},
                "time": 2i64,
            }),
        ];
        let mut f = fs::File::create(session_dir.join("wire.jsonl")).unwrap();
        for l in &lines {
            writeln!(f, "{l}").unwrap();
        }
        let got = read_wire(&candidate(&home, "wd_proj", "session_sys"));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "real prompt");
    }

    #[test]
    fn session_scope_selects_newest_session_for_workdir() {
        let home = temp_home();
        write_session(
            &home,
            "wd_proj",
            "session_old",
            "/tmp/proj",
            1_784_000_000_000,
            "older prompt",
            "old reply",
        );
        // Sleep so the second wire's mtime is strictly newer.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_session(
            &home,
            "wd_proj",
            "session_new",
            "/tmp/proj",
            1_784_000_100_000,
            "newer prompt",
            "new reply",
        );

        // No id → newest wins.
        let r = gather_in_home(&home, "/tmp/proj", "", super::super::Scope::Session, "", None, 20);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].session_id, "session_new");
        assert_eq!(r.entries[0].text, "newer prompt");
        assert_eq!(r.entries[0].reply.as_deref(), Some("new reply"));
    }

    #[test]
    fn session_scope_by_id_reads_only_the_target_wire() {
        let home = temp_home();
        for (slug, id, ts, prompt) in [
            ("wd_proj", "session_one", 1_784_000_000_000i64, "prompt one"),
            ("wd_proj", "session_two", 1_784_000_100_000i64, "prompt two"),
            ("wd_proj", "session_three", 1_784_000_200_000i64, "prompt three"),
        ] {
            write_session(&home, slug, id, "/tmp/proj", ts, prompt, "reply");
        }

        WIRE_READS.with(|c| c.set(0));
        let r = gather_in_home(
            &home,
            "/tmp/proj",
            "session_two",
            super::super::Scope::Session,
            "",
            None,
            20,
        );
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].session_id, "session_two");
        assert_eq!(r.entries[0].text, "prompt two");
        // Only the target wire was opened — not the other two.
        assert_eq!(WIRE_READS.with(|c| c.get()), 1);
    }

    #[test]
    fn session_scope_by_id_tolerates_missing_prefix() {
        let home = temp_home();
        write_session(
            &home,
            "wd_proj",
            "session_abc",
            "/tmp/proj",
            1_784_000_000_000,
            "hello",
            "hi",
        );
        // Bare uuid (no `session_` prefix) still matches the index entry.
        let r = gather_in_home(&home, "/tmp/proj", "abc", super::super::Scope::Session, "", None, 20);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].session_id, "session_abc");
    }

    #[test]
    fn project_scope_walks_all_matching_sessions_newest_first() {
        let home = temp_home();
        write_session(
            &home,
            "wd_proj",
            "session_old",
            "/tmp/proj",
            1_784_000_000_000,
            "older prompt",
            "old reply",
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_session(
            &home,
            "wd_proj",
            "session_new",
            "/tmp/proj",
            1_784_000_100_000,
            "newer prompt",
            "new reply",
        );
        // A session in a DIFFERENT workdir must not leak in.
        write_session(
            &home,
            "wd_other",
            "session_other",
            "/tmp/other",
            1_784_000_200_000,
            "other prompt",
            "other reply",
        );

        let r = gather_in_home(&home, "/tmp/proj", "", super::super::Scope::Project, "", None, 20);
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].text, "newer prompt");
        assert_eq!(r.entries[0].session_id, "session_new");
        assert_eq!(r.entries[1].text, "older prompt");
        assert_eq!(r.entries[1].session_id, "session_old");
    }

    #[test]
    fn project_scope_search_filters_across_sessions() {
        let home = temp_home();
        write_session(
            &home,
            "wd_proj",
            "session_a",
            "/tmp/proj",
            1_784_000_000_000,
            "fix the OAuth flow",
            "done",
        );
        write_session(
            &home,
            "wd_proj",
            "session_b",
            "/tmp/proj",
            1_784_000_100_000,
            "ship it",
            "done",
        );
        let r = gather_in_home(
            &home,
            "/tmp/proj",
            "",
            super::super::Scope::Project,
            "oauth",
            None,
            20,
        );
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].text, "fix the OAuth flow");
    }

    #[test]
    fn project_scope_paginates_via_cursor() {
        let home = temp_home();
        // One session, five prompts, so ordering within a wire is exercised.
        let session_dir = home.join("sessions/wd_proj/session_p/agents/main");
        fs::create_dir_all(&session_dir).unwrap();
        let mut f = fs::File::create(session_dir.join("wire.jsonl")).unwrap();
        for i in 0..5 {
            let l = serde_json::json!({
                "type": "turn.prompt",
                "input": [{"type": "text", "text": format!("prompt {i}")}],
                "origin": {"kind": "user"},
                "time": 1_784_000_000_000i64 + i,
            });
            writeln!(f, "{l}").unwrap();
        }
        let index_line = serde_json::json!({
            "sessionId": "session_p",
            "sessionDir": home.join("sessions/wd_proj/session_p").to_str().unwrap(),
            "workDir": "/tmp/proj",
        });
        fs::write(home.join("session_index.jsonl"), format!("{index_line}\n")).unwrap();

        let page1 =
            gather_in_home(&home, "/tmp/proj", "", super::super::Scope::Project, "", None, 2);
        assert_eq!(page1.entries.len(), 2);
        assert!(page1.has_more);
        assert_eq!(page1.entries[0].text, "prompt 4");
        assert_eq!(page1.entries[1].text, "prompt 3");
        let cursor = page1.next_before.expect("cursor on hasMore");

        let page2 = gather_in_home(
            &home,
            "/tmp/proj",
            "",
            super::super::Scope::Project,
            "",
            Some(&cursor),
            2,
        );
        assert_eq!(page2.entries.len(), 2);
        assert_eq!(page2.entries[0].text, "prompt 2");
        assert_eq!(page2.entries[1].text, "prompt 1");

        let page3 = gather_in_home(
            &home,
            "/tmp/proj",
            "",
            super::super::Scope::Project,
            "",
            page2.next_before.as_deref(),
            2,
        );
        assert_eq!(page3.entries.len(), 1);
        assert_eq!(page3.entries[0].text, "prompt 0");
        assert!(!page3.has_more);
    }

    #[test]
    fn empty_when_no_index_or_no_match() {
        let home = temp_home();
        // No index file at all → empty, no error.
        let r = gather_in_home(&home, "/tmp/proj", "", super::super::Scope::Session, "", None, 20);
        assert!(r.entries.is_empty());
        assert!(!r.has_more);

        // Index with a session in a different workdir → no match.
        write_session(
            &home,
            "wd_other",
            "session_x",
            "/tmp/other",
            1_784_000_000_000,
            "hi",
            "yo",
        );
        let r = gather_in_home(&home, "/tmp/proj", "", super::super::Scope::Project, "", None, 20);
        assert!(r.entries.is_empty());
    }
}
