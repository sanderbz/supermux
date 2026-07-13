//! Codex prompt-history reader.
//!
//! Codex stores one append-only rollout JSONL per thread under
//! `$CODEX_HOME/sessions/YYYY/MM/DD/`. We read only `event_msg` user/agent
//! messages: unlike raw response items, these are already the human-visible
//! conversation stream and exclude developer instructions and tool results.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;

use super::{
    clamp, decode_cursor, encode_cursor, parse_ts, Kind, RecallEntry, RecallResponse,
    REPLY_MAX_CHARS,
};
use crate::ws::sanitise_text;

struct Rollout {
    path: PathBuf,
    id: String,
    cwd: String,
    started_at: i64,
}

/// A discovered rollout file plus its mtime — obtained from the directory
/// entry alone, WITHOUT opening the file. `read_meta` turns one of these into
/// a `Rollout` (which does require reading the file's `session_meta` header).
struct Candidate {
    path: PathBuf,
    modified: SystemTime,
}

// Counts `read_meta` calls (each opens+reads a rollout header) so tests can
// assert Session scope doesn't touch unrelated rollouts. Thread-local so
// parallel tests don't interfere; compiled out of release builds.
#[cfg(test)]
thread_local! {
    static META_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn gather(
    dir: &str,
    session_id: &str,
    last_started: i64,
    scope: super::Scope,
    search: &str,
    before: Option<&str>,
    limit: usize,
) -> RecallResponse {
    let root = codex_home().join("sessions");
    gather_in_root(
        &root,
        dir,
        session_id,
        last_started,
        scope,
        search,
        before,
        limit,
    )
}

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

#[allow(clippy::too_many_arguments)]
fn gather_in_root(
    root: &Path,
    dir: &str,
    session_id: &str,
    last_started: i64,
    scope: super::Scope,
    search: &str,
    before: Option<&str>,
    limit: usize,
) -> RecallResponse {
    // Codex keeps no per-project index — a rollout's project lives in its
    // `cwd`, inside the file — so any project match still needs the header
    // read. What we CAN avoid is reading every file up front: enumerate the
    // rollout paths (with mtimes, no opens) and read headers lazily.
    let target = resolve_dir(dir);
    let mut candidates = Vec::new();
    collect_jsonl(root, &mut candidates);
    // mtime desc, stable. Filtering `same_dir` afterwards preserves this order,
    // so a sorted-then-filtered stream is identical to the previous
    // filtered-then-sorted `Vec` — including the tie order among equal mtimes.
    candidates.sort_by(|a, b| b.modified.cmp(&a.modified));

    let search = (!search.is_empty()).then(|| search.to_lowercase());
    let cursor = before.and_then(decode_cursor);

    match scope {
        super::Scope::Session => {
            let selected = select_session(&candidates, &target, session_id, last_started);
            collect_entries(selected.into_iter(), &search, &cursor, limit)
        }
        super::Scope::Project => {
            // Lazily resolve same-project rollouts in mtime order. `collect_entries`
            // stops pulling once it has `limit + 1` entries (limit ≤ 100), so we
            // only `read_meta` as far as the requested page needs — not the whole
            // sessions tree. (Non-matching files still cost one open apiece to
            // learn their cwd; that's inherent without a project index.)
            let matches = candidates
                .iter()
                .filter_map(read_meta)
                .filter(|r| same_dir(&r.cwd, &target));
            collect_entries(matches, &search, &cursor, limit)
        }
    }
}

/// Pick the single rollout that Session scope should return, cheaply.
///
/// Semantically identical to the old "filter same_dir, sort by mtime desc,
/// then select" — but selects by PATH first so the common case opens one file.
fn select_session(
    candidates: &[Candidate],
    target: &DirMatch,
    session_id: &str,
    last_started: i64,
) -> Option<Rollout> {
    if !session_id.is_empty() {
        // Codex names rollouts `rollout-<ts>-<uuid>.jsonl` and that uuid is the
        // session id (verified: filename uuid == `session_meta.payload.id`), so
        // the target thread is selectable by filename. Read only the file(s)
        // whose name carries the id instead of every rollout in the tree.
        let by_name = candidates
            .iter()
            .filter(|c| name_contains(&c.path, session_id))
            .filter_map(read_meta)
            .find(|r| r.id == session_id && same_dir(&r.cwd, target));
        if by_name.is_some() {
            return by_name;
        }
        // Fallback for a rollout whose filename somehow omits its id (e.g. a
        // hand-written file): preserve the original exhaustive scan so a match
        // is never missed. Never hit by real Codex output.
        return candidates
            .iter()
            .filter_map(read_meta)
            .find(|r| r.id == session_id && same_dir(&r.cwd, target));
    }

    if last_started > 0 {
        // The DB has carried `codex_session_id` since v1 but older launchers
        // never populated it. Match the rollout whose creation time is closest
        // to this supermux start; deterministic, and avoids incorrectly taking
        // the newest thread in the same project.
        //
        // This case is inherently exhaustive: both the `cwd` (for same_dir) and
        // the authoritative `started_at` live inside the file, and the
        // filename's timestamp is local-tz with no offset so it can't stand in
        // for `started_at`. Kept reading every rollout on purpose.
        return candidates
            .iter()
            .filter_map(read_meta)
            .filter(|r| same_dir(&r.cwd, target))
            .min_by_key(|r| r.started_at.abs_diff(last_started));
    }

    // No id and no start time: the newest same-project rollout. Pull in mtime
    // order and stop at the first same-dir hit rather than reading every file.
    candidates
        .iter()
        .filter_map(read_meta)
        .find(|r| same_dir(&r.cwd, target))
}

/// Walk the selected rollouts (already in the right order) and build the page.
/// Consumes the iterator lazily so an early `break` skips unread rollouts.
fn collect_entries(
    rollouts: impl Iterator<Item = Rollout>,
    search: &Option<String>,
    cursor: &Option<(String, String)>,
    limit: usize,
) -> RecallResponse {
    let mut cursor_consumed = cursor.is_none();
    let mut entries = Vec::new();

    'files: for rollout in rollouts {
        for entry in read_rollout(&rollout) {
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

fn collect_jsonl(dir: &Path, out: &mut Vec<Candidate>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_jsonl(&path, out);
        } else if file_type.is_file()
            && path.extension().and_then(|v| v.to_str()) == Some("jsonl")
        {
            // mtime straight from the dir entry — no open. Regular files only
            // (symlinks skipped above), so this is the same value the old code
            // read from the opened file's metadata.
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            out.push(Candidate { path, modified });
        }
    }
}

fn name_contains(path: &Path, needle: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| name.contains(needle))
}

fn read_meta(candidate: &Candidate) -> Option<Rollout> {
    #[cfg(test)]
    META_READS.with(|c| c.set(c.get() + 1));
    let file = fs::File::open(&candidate.path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(20) {
        if !line.contains("\"type\":\"session_meta\"") {
            continue;
        }
        let value: Value = serde_json::from_str(&line).ok()?;
        let payload = value.get("payload")?;
        return Some(Rollout {
            path: candidate.path.clone(),
            id: payload.get("id")?.as_str()?.to_string(),
            cwd: payload.get("cwd")?.as_str()?.to_string(),
            started_at: parse_ts(value.get("timestamp").and_then(Value::as_str)),
        });
    }
    None
}

/// The query directory resolved once, so `same_dir` need not re-`canonicalize`
/// it per rollout. Mirrors the old two-branch compare: the canonical form is
/// used only when BOTH sides canonicalize, otherwise a trimmed string compare.
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

fn same_dir(cwd: &str, target: &DirMatch) -> bool {
    match (fs::canonicalize(cwd), &target.canonical) {
        (Ok(cwd), Some(canonical)) => &cwd == canonical,
        _ => cwd.trim_end_matches('/') == target.trimmed,
    }
}

fn read_rollout(rollout: &Rollout) -> Vec<RecallEntry> {
    let Ok(file) = fs::File::open(&rollout.path) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    let mut pending = None;
    let mut sequence = 0usize;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains("\"type\":\"event_msg\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(payload) = value.get("payload") else {
            continue;
        };
        let message_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let text = payload
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if text.is_empty() {
            continue;
        }

        match message_type {
            "user_message" => {
                sequence += 1;
                let clean = sanitise_text(text);
                let slash = clean
                    .strip_prefix('/')
                    .and_then(|s| s.split_whitespace().next())
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("/{s}"));
                entries.push(RecallEntry {
                    uuid: sequence.to_string(),
                    ts: parse_ts(value.get("timestamp").and_then(Value::as_str)),
                    session_id: rollout.id.clone(),
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
            "agent_message" => {
                if let Some(index) = pending.take() {
                    let reply = clamp(&sanitise_text(text), REPLY_MAX_CHARS);
                    if !reply.is_empty() {
                        entries[index].reply = Some(reply);
                    }
                }
            }
            _ => {}
        }
    }

    entries.reverse();
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_rollout(root: &Path, name: &str, id: &str, cwd: &Path, ts: &str, prompt: &str) {
        let dir = root.join("2026/07/13");
        fs::create_dir_all(&dir).unwrap();
        let body = format!(
            "{{\"timestamp\":\"{ts}\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":{cwd:?}}}}}\n\
             {{\"timestamp\":\"{ts}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":{prompt:?}}}}}\n\
             {{\"timestamp\":\"{ts}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"agent_message\",\"message\":\"First reply\"}}}}\n"
        );
        fs::write(dir.join(format!("rollout-{name}.jsonl")), body).unwrap();
    }

    #[test]
    fn session_scope_selects_the_rollout_nearest_the_supermux_start() {
        let root =
            std::env::temp_dir().join(format!("supermux-codex-recall-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        write_rollout(
            &root,
            "old",
            "old-id",
            &project,
            "2026-07-13T10:00:00Z",
            "older prompt",
        );
        write_rollout(
            &root,
            "new",
            "new-id",
            &project,
            "2026-07-13T11:00:00Z",
            "/review now",
        );

        let response = gather_in_root(
            &root,
            project.to_str().unwrap(),
            "",
            chrono::DateTime::parse_from_rfc3339("2026-07-13T11:00:02Z")
                .unwrap()
                .timestamp(),
            super::super::Scope::Session,
            "",
            None,
            20,
        );
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].session_id, "new-id");
        assert_eq!(response.entries[0].kind, Kind::Command);
        assert_eq!(response.entries[0].reply.as_deref(), Some("First reply"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_scope_searches_all_matching_rollouts() {
        let root = std::env::temp_dir().join(format!(
            "supermux-codex-project-recall-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        write_rollout(
            &root,
            "one",
            "one",
            &project,
            "2026-07-13T10:00:00Z",
            "needle one",
        );
        write_rollout(
            &root,
            "two",
            "two",
            &project,
            "2026-07-13T11:00:00Z",
            "other",
        );

        let response = gather_in_root(
            &root,
            project.to_str().unwrap(),
            "",
            0,
            super::super::Scope::Project,
            "needle",
            None,
            20,
        );
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].text, "needle one");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_scope_reads_only_the_target_rollout() {
        let root = std::env::temp_dir().join(format!(
            "supermux-codex-session-fast-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();

        // Real Codex scheme: the filename embeds the session uuid (== payload.id),
        // so `write_rollout(name = "<ts>-<id>", id = "<id>")` yields
        // `rollout-<ts>-<id>.jsonl` — a name that carries the id.
        let ids = [
            "019f0000-0000-7000-8000-000000000001",
            "019f0000-0000-7000-8000-000000000002",
            "019f0000-0000-7000-8000-000000000003",
            "019f0000-0000-7000-8000-000000000004",
        ];
        for (n, id) in ids.iter().enumerate() {
            write_rollout(
                &root,
                &format!("2026-07-13T1{n}-00-00-{id}"),
                id,
                &project,
                &format!("2026-07-13T1{n}:00:00Z"),
                &format!("prompt {n}"),
            );
        }

        let target = ids[1];
        reset_meta_reads();
        let response = gather_in_root(
            &root,
            project.to_str().unwrap(),
            target,
            0,
            super::super::Scope::Session,
            "",
            None,
            20,
        );

        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].session_id, target);
        assert_eq!(response.entries[0].text, "prompt 1");
        // The whole point: only the target rollout's header was read, not the
        // other three. (Old code `read_meta`-d all four before scoping.)
        assert_eq!(meta_reads(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    fn meta_reads() -> usize {
        META_READS.with(|c| c.get())
    }

    fn reset_meta_reads() {
        META_READS.with(|c| c.set(0));
    }
}
