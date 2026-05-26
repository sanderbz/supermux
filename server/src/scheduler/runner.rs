//! Schedule execution (TECH_PLAN §3.8; feature-extract §4.5).
//!
//! [`run`] dispatches one due (or manually-triggered) schedule. For a tick
//! dispatch it FIRST claims the `(schedule_id, scheduled_for_ts)` idempotency key
//! so a restart can't double-fire (Codex #6); a duplicate is logged and skipped.
//! Three job kinds — `tmux` (send to a session), `shell` (`bash -c`, 600s cap),
//! and `boot` (spawn a fresh session, with a dirty-worktree pre-flight). Every
//! run records a `schedule_runs` row and an `audit_log` entry, then recomputes
//! `next_run` (or disables a finished one-shot).

use chrono::{DateTime, Utc};
use serde_json::json;

use crate::db;
use crate::db::schedules::Schedule;
use crate::sessions;
use crate::state::{AppState, SseEvent};

use super::parser;
use super::watch;

/// What caused this run — distinguishes the idempotent tick path from a manual
/// "run now" (which neither gates on the fire-key nor advances `next_run`).
#[derive(Debug, Clone, Copy)]
pub enum Trigger {
    /// The 10s tick fired this; carries the scheduled fire-time (Unix seconds).
    Tick { scheduled_for_ts: i64 },
    /// `POST /api/schedules/{id}/run` — explicit user request.
    Manual,
}

/// Outcome of executing a job body.
struct JobOutcome {
    status: &'static str,
    note: String,
    /// Pre-send capture for watch-mode delta detection (tmux + watch only).
    pre_output: Option<String>,
}

/// Recompute the next fire time for `sched` relative to `now`, anchored at the
/// last fire (or the just-missed `next_run`). `None` disables (one-shot, or
/// unparseable recurrence).
pub fn recompute_next(sched: &Schedule, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if sched.sched_type == "once" {
        return None;
    }
    let expr = sched.schedule_expr.as_deref().unwrap_or("");
    let parsed = parser::parse(expr, now).ok()?;
    let anchor = sched
        .last_run
        .as_deref()
        .or(sched.next_run.as_deref())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or(now);
    parsed.recurrence.next_after(anchor, now)
}

/// Run one schedule end-to-end.
pub async fn run(state: AppState, sched: Schedule, trigger: Trigger) {
    // Idempotency gate (tick path only).
    if let Trigger::Tick { scheduled_for_ts } = trigger {
        match db::schedules::claim_run_key(&state.pool, &sched.id, scheduled_for_ts).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::debug!(schedule = %sched.id, scheduled_for_ts, "duplicate fire skipped");
                return;
            }
            Err(e) => {
                tracing::warn!(schedule = %sched.id, error = %e, "fire-key claim failed");
                return;
            }
        }
    }

    let now = Utc::now();
    let outcome = execute(&state, &sched).await;

    // Ledger + audit (best-effort; logging is the only feedback channel).
    let _ = db::schedules::insert_run(
        &state.pool,
        &sched.id,
        now.timestamp(),
        outcome.status,
        &outcome.note,
    )
    .await;
    let actor = match trigger {
        Trigger::Tick { .. } => "scheduler",
        Trigger::Manual => "user",
    };
    let _ = db::audit::log(
        &state.pool,
        actor,
        "schedule.run",
        &sched.id,
        json!({ "kind": sched.kind, "status": outcome.status, "manual": matches!(trigger, Trigger::Manual) }),
    )
    .await;

    // Surface the run to clients (anti-vision: push, never poll).
    let _ = state.sse_tx.send(SseEvent {
        event: "alerts".to_string(),
        payload: json!({
            "level": if outcome.status == "error" { "error" } else { "info" },
            "source": "scheduler",
            "schedule": sched.id,
            "detail": format!("Ran schedule: {}", sched.title),
        }),
    });

    // Persist cadence.
    match trigger {
        Trigger::Tick { .. } => {
            let next = recompute_next(&sched, now);
            let _ = db::schedules::record_fire(&state.pool, &sched.id, now, next).await;
        }
        Trigger::Manual => {
            let _ = db::schedules::record_manual(&state.pool, &sched.id, now).await;
        }
    }

    // Watch mode: poll the session for the done-pattern (tmux + ok only).
    if sched.watch == 1 && sched.kind == "tmux" && outcome.status == "ok" {
        watch::spawn(state, sched, outcome.pre_output.unwrap_or_default());
    }
}

/// Execute the job body for `sched`, returning its status + note + pre-capture.
async fn execute(state: &AppState, sched: &Schedule) -> JobOutcome {
    match sched.kind.as_str() {
        "shell" => execute_shell(sched).await,
        "boot" => execute_boot(state, sched).await,
        // default to tmux
        _ => execute_tmux(state, sched).await,
    }
}

/// `kind='shell'` — `bash -c <command>` with a 600s ceiling.
async fn execute_shell(sched: &Schedule) -> JobOutcome {
    let result = tokio::time::timeout(
        parser::SHELL_TIMEOUT,
        tokio::process::Command::new("/bin/bash")
            .arg("-c")
            .arg(&sched.command)
            .output(),
    )
    .await;

    match result {
        Ok(Ok(out)) if out.status.success() => JobOutcome {
            status: "ok",
            note: truncate(&String::from_utf8_lossy(&out.stdout)),
            pre_output: None,
        },
        Ok(Ok(out)) => {
            let mut note = String::from_utf8_lossy(&out.stderr).to_string();
            if note.trim().is_empty() {
                note = String::from_utf8_lossy(&out.stdout).to_string();
            }
            JobOutcome {
                status: "error",
                note: truncate(&format!("exit {}: {}", out.status, note)),
                pre_output: None,
            }
        }
        Ok(Err(e)) => JobOutcome {
            status: "error",
            note: truncate(&format!("spawn failed: {e}")),
            pre_output: None,
        },
        Err(_) => JobOutcome {
            status: "error",
            note: "timeout after 600s".to_string(),
            pre_output: None,
        },
    }
}

/// `kind='tmux'` — send the optional `command` then the optional free-text
/// `prompt` to the target session (auto-wakes). At least one is non-empty (the
/// create handler guarantees it). Each is a separate submitted line, so a job can
/// run `/supermux-task` and follow it with a prompt, or send just one of the two.
/// Captures pre-send output first when watch-mode is on, for delta detection.
async fn execute_tmux(state: &AppState, sched: &Schedule) -> JobOutcome {
    if sched.session.trim().is_empty() {
        return JobOutcome {
            status: "error",
            note: "tmux schedule has no target session".to_string(),
            pre_output: None,
        };
    }
    let pre_output = if sched.watch == 1 {
        sessions::lifecycle::peek(state, &sched.session, 200).await.ok()
    } else {
        None
    };
    for line in delivery_lines(sched) {
        if let Err(e) = sessions::lifecycle::send_text(state, &sched.session, line).await {
            return JobOutcome {
                status: "error",
                note: truncate(&format!("send failed: {e}")),
                pre_output: None,
            };
        }
    }
    JobOutcome {
        status: "ok",
        note: format!("sent to {}", sched.session),
        pre_output,
    }
}

/// The ordered, non-empty lines a `tmux`/`boot` job delivers: the slash `command`
/// first (when set), then the free-text `prompt` (when set). Each is submitted as
/// its own line. At least one is present (create-handler invariant).
fn delivery_lines(sched: &Schedule) -> Vec<&str> {
    let mut lines = Vec::new();
    let cmd = sched.command.trim();
    if !cmd.is_empty() {
        lines.push(cmd);
    }
    let prompt = sched.prompt.trim();
    if !prompt.is_empty() {
        lines.push(prompt);
    }
    lines
}

/// `kind='boot'` — spawn a NEW session in `boot_dir` and send `command` as its
/// first prompt. Pre-flight: if `boot_worktree`, refuse on a dirty parent repo
/// (don't silently pollute it — Eng failure-paths table).
async fn execute_boot(state: &AppState, sched: &Schedule) -> JobOutcome {
    if sched.boot_worktree == 1 {
        match worktree_is_dirty(&sched.boot_dir).await {
            Ok(true) => {
                return JobOutcome {
                    status: "error",
                    note: "parent worktree dirty".to_string(),
                    pre_output: None,
                };
            }
            Ok(false) => {}
            Err(e) => {
                return JobOutcome {
                    status: "error",
                    note: truncate(&format!("worktree check failed: {e}")),
                    pre_output: None,
                };
            }
        }
    }

    let name = boot_session_name(sched);
    let input = sessions::CreateInput {
        name: name.clone(),
        dir: Some(sched.boot_dir.clone()),
        desc: Some(format!("booted by schedule {}", sched.id)),
        provider: Some(sched.boot_provider.clone()),
        creator: Some("scheduler".to_string()),
        flags: None,
        tags: None,
        branch: None,
        mcp: None,
        worktree: Some(sched.boot_worktree == 1),
        host_id: None,
    };
    if let Err(e) = sessions::create(state, input).await {
        return JobOutcome {
            status: "error",
            note: truncate(&format!("boot create failed: {e}")),
            pre_output: None,
        };
    }
    // Start with the FIRST delivery line as the agent's opening prompt (the slash
    // command when set, else the free-text prompt), then send any remaining line
    // as a follow-up. This lets a boot job run e.g. `/cso` and then a prompt — or
    // boot straight into a free-text prompt with no command.
    let lines = delivery_lines(sched);
    let first = lines.first().copied();
    if let Err(e) = sessions::lifecycle::start(state, &name, first).await {
        return JobOutcome {
            status: "error",
            note: truncate(&format!("boot start failed: {e}")),
            pre_output: None,
        };
    }
    for follow in lines.iter().skip(1) {
        if let Err(e) = sessions::lifecycle::send_text(state, &name, follow).await {
            return JobOutcome {
                status: "error",
                note: truncate(&format!("boot follow-up send failed: {e}")),
                pre_output: None,
            };
        }
    }
    JobOutcome {
        status: "ok",
        note: format!("booted session {name}"),
        pre_output: None,
    }
}

/// True if `git status --porcelain` in `dir` reports any change.
async fn worktree_is_dirty(dir: &str) -> Result<bool, std::io::Error> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("status")
        .arg("--porcelain")
        .output()
        .await?;
    if !out.status.success() {
        return Err(std::io::Error::other(format!(
            "git status exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(!out.stdout.is_empty())
}

/// A valid, unique session slug for a boot job (`[A-Za-z0-9_.-]+`).
fn boot_session_name(sched: &Schedule) -> String {
    let base: String = sched
        .title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '-' })
        .collect();
    let base = base.trim_matches('-');
    let base = if base.is_empty() { "boot" } else { base };
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let mut name = format!("{base}-{suffix}");
    name.truncate(100);
    name
}

/// Trim a note to a reasonable column size (matches v2's 500-char cap).
fn truncate(s: &str) -> String {
    let s = s.trim();
    if s.len() <= 500 {
        s.to_string()
    } else {
        format!("{}…", &s[..500])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare Schedule with just the two delivery fields set — the rest is unused
    /// by [`delivery_lines`], so defaults keep the fixture small.
    fn sched_with(command: &str, prompt: &str) -> Schedule {
        Schedule {
            id: "SCHED-test".into(),
            title: "t".into(),
            session: "s".into(),
            command: command.into(),
            prompt: prompt.into(),
            kind: "tmux".into(),
            boot_dir: String::new(),
            boot_provider: "claude".into(),
            boot_worktree: 0,
            sched_type: "recurring".into(),
            recurrence: None,
            run_at: None,
            next_run: None,
            last_run: None,
            enabled: 1,
            run_count: 0,
            schedule_expr: Some("every 1m".into()),
            watch: 0,
            watch_timeout: 120,
            done_pattern: None,
            done_action: "disable".into(),
            created: 0,
            updated: 0,
            deleted: None,
        }
    }

    #[test]
    fn delivery_lines_command_then_prompt() {
        let s = sched_with("/supermux-task", "summarise the board");
        assert_eq!(delivery_lines(&s), vec!["/supermux-task", "summarise the board"]);
    }

    #[test]
    fn delivery_lines_command_only() {
        let s = sched_with("/cso", "");
        assert_eq!(delivery_lines(&s), vec!["/cso"]);
    }

    #[test]
    fn delivery_lines_prompt_only() {
        let s = sched_with("", "check the deploy");
        assert_eq!(delivery_lines(&s), vec!["check the deploy"]);
    }

    #[test]
    fn delivery_lines_trims_and_drops_blank() {
        let s = sched_with("  ", "  do it  ");
        // whitespace-only command is dropped; prompt is trimmed.
        assert_eq!(delivery_lines(&s), vec!["do it"]);
    }
}
