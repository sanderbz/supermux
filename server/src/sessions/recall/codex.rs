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
    modified: SystemTime,
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
    let mut rollouts = discover_rollouts(root)
        .into_iter()
        .filter(|r| same_dir(&r.cwd, dir))
        .collect::<Vec<_>>();

    rollouts.sort_by(|a, b| b.modified.cmp(&a.modified));
    if scope == super::Scope::Session {
        let selected = if !session_id.is_empty() {
            rollouts.iter().position(|r| r.id == session_id)
        } else if last_started > 0 {
            // The DB has carried `codex_session_id` since v1 but older launchers
            // never populated it. Match the rollout whose creation time is
            // closest to this supermux start; this is deterministic and avoids
            // incorrectly taking the newest thread in the same project.
            rollouts
                .iter()
                .enumerate()
                .min_by_key(|(_, r)| r.started_at.abs_diff(last_started))
                .map(|(i, _)| i)
        } else {
            (!rollouts.is_empty()).then_some(0)
        };
        rollouts = selected
            .and_then(|i| (i < rollouts.len()).then(|| vec![rollouts.remove(i)]))
            .unwrap_or_default();
    }

    let search = (!search.is_empty()).then(|| search.to_lowercase());
    let cursor = before.and_then(decode_cursor);
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

fn discover_rollouts(root: &Path) -> Vec<Rollout> {
    let mut paths = Vec::new();
    collect_jsonl(root, &mut paths);
    paths.into_iter().filter_map(read_meta).collect()
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
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
            out.push(path);
        }
    }
}

fn read_meta(path: PathBuf) -> Option<Rollout> {
    let file = fs::File::open(&path).ok()?;
    let modified = file
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for line in BufReader::new(file).lines().map_while(Result::ok).take(20) {
        if !line.contains("\"type\":\"session_meta\"") {
            continue;
        }
        let value: Value = serde_json::from_str(&line).ok()?;
        let payload = value.get("payload")?;
        return Some(Rollout {
            path,
            id: payload.get("id")?.as_str()?.to_string(),
            cwd: payload.get("cwd")?.as_str()?.to_string(),
            started_at: parse_ts(value.get("timestamp").and_then(Value::as_str)),
            modified,
        });
    }
    None
}

fn same_dir(a: &str, b: &str) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
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
}
