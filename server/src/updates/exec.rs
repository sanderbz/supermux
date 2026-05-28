//! Update execution: spawn the update task, broadcast progress to SSE subscribers.
//!
//! The actual `git fetch + reset + build + install + verify + rollback`
//! pipeline lives in `scripts/update.sh` on the host (so an OSS user can read
//! exactly what the 1-click button runs). This module's job:
//!   1. Refuse the request when preflight has any blocked_reason.
//!   2. Write a marker file under `<data>/deploy/` that the root-side
//!      `supermux-deploy.path` unit watches; that unit invokes `update.sh`.
//!   3. Spawn a tokio task that tails the runner's log file and re-emits each
//!      structured `[update] step=<name>` line as an `UpdateEvent` on a
//!      per-job broadcast channel the `/api/update/progress/:job_id` SSE
//!      handler subscribes to.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use dashmap::DashMap;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::broadcast;

/// Capacity of each per-job broadcast channel. A normal update emits ~10 events
/// (one per phase). 128 absorbs a chatty `update.sh` plus a slow late-joining
/// SSE subscriber without dropping any.
const CHANNEL_CAP: usize = 128;

/// One step in the update timeline. The frontend renders them in order; a
/// `failed` or `rolled_back` event terminates the stream from the UI's PoV.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStep {
    Queued,
    Fetching,
    Building,
    Installing,
    Verifying,
    Done,
    Failed,
    RolledBack,
}

/// One event on the per-job SSE stream. `ts` is server-side epoch seconds so
/// the client can compute "X seconds ago".
#[derive(Debug, Clone, Serialize)]
pub struct UpdateEvent {
    pub job_id: String,
    pub step: UpdateStep,
    pub message: String,
    pub ts: i64,
}

/// Per-job state: the broadcast sender + the latest event (so a new subscriber
/// can render the current state immediately without waiting for the next step).
struct Job {
    tx: broadcast::Sender<UpdateEvent>,
    latest: tokio::sync::RwLock<Option<UpdateEvent>>,
}

impl Job {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAP);
        Self { tx, latest: tokio::sync::RwLock::new(None) }
    }
}

/// Process-wide table of in-flight update jobs.
pub struct JobRegistry {
    jobs: DashMap<String, Arc<Job>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self { jobs: DashMap::new() }
    }

    /// Create a fresh job slot, returning the job id. The slot lives until
    /// [`forget`] is called (the API hands the job id back to the client and
    /// drops the slot 10 minutes after the terminal event).
    pub fn create(&self) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.jobs.insert(id.clone(), Arc::new(Job::new()));
        id
    }

    /// Look up an in-flight job. `None` for unknown ids (the SSE handler 404s).
    fn get(&self, id: &str) -> Option<Arc<Job>> {
        self.jobs.get(id).map(|r| r.value().clone())
    }

    /// Subscribe to a job's event stream. Caller also gets the LATEST event
    /// (if any) so a freshly-mounted UI sees the current state immediately.
    pub async fn subscribe(
        &self,
        id: &str,
    ) -> Option<(broadcast::Receiver<UpdateEvent>, Option<UpdateEvent>)> {
        let job = self.get(id)?;
        let rx = job.tx.subscribe();
        let latest = job.latest.read().await.clone();
        Some((rx, latest))
    }

    /// Publish an event for `id` (broadcasts + stashes as latest).
    pub async fn publish(&self, id: &str, ev: UpdateEvent) {
        let Some(job) = self.get(id) else { return };
        {
            let mut w = job.latest.write().await;
            *w = Some(ev.clone());
        }
        // Ignore send failure: every subscriber's receiver dropped → we still
        // want to keep the latest event in the slot for the next subscriber.
        let _ = job.tx.send(ev);
    }

    /// Drop a job's slot. Called from the spawned task ~10 minutes after the
    /// terminal event so a slow late client still has a chance to read it.
    pub fn forget(&self, id: &str) {
        self.jobs.remove(id);
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Where the deploy request file lives. Mirrors `scripts/deploy-self.sh`'s
/// resolution: `$SUPERMUX_DATA_DIR/deploy/request` (default `~/.supermux/deploy/...`).
pub fn deploy_request_path() -> PathBuf {
    let data = std::env::var("SUPERMUX_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".supermux")))
        .unwrap_or_else(|| PathBuf::from("/var/lib/supermux"));
    data.join("deploy").join("request")
}

/// Where the root-side runner streams its log. We tail this for SSE events.
pub fn deploy_log_path() -> PathBuf {
    let data = std::env::var("SUPERMUX_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".supermux")))
        .unwrap_or_else(|| PathBuf::from("/var/lib/supermux"));
    data.join("deploy").join("log")
}

/// Kick off the update for `job_id` from `source_dir`. Atomically writes the
/// deploy request (request.tmp → mv → request) and spawns a tail task that
/// reads the runner's log and re-emits each `[update] step=<name>` line as an
/// SSE event. Returns immediately. The SSE endpoint is the progress surface.
pub async fn spawn_update_task(
    registry: Arc<JobRegistry>,
    job_id: String,
    source_dir: PathBuf,
    current_sha: String,
) -> Result<(), String> {
    // Initial "queued" event so the UI never shows a blank progress bar.
    registry
        .publish(
            &job_id,
            UpdateEvent {
                job_id: job_id.clone(),
                step: UpdateStep::Queued,
                message: "Update queued. Waiting for the root runner to pick it up.".into(),
                ts: Utc::now().timestamp(),
            },
        )
        .await;

    let req_path = deploy_request_path();
    let req_dir = req_path
        .parent()
        .ok_or_else(|| "deploy request path has no parent".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&req_dir)
        .map_err(|e| format!("create {}: {}", req_dir.display(), e))?;

    // Best-effort: blank the prior run's status/log so a tail doesn't latch
    // onto a stale `DEPLOY_RESULT=` line.
    let log_path = deploy_log_path();
    let status_path = req_dir.join("status");
    let _ = std::fs::write(&log_path, b"");
    let _ = std::fs::write(&status_path, b"");

    let nonce = Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let body = format!(
        "source_dir={}\nsha={}\nnonce={}\n",
        source_dir.display(),
        current_sha,
        nonce
    );
    let tmp = req_dir.join("request.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, &req_path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), req_path.display(), e))?;

    // Spawn the log tailer.
    let reg_clone = registry.clone();
    let id_clone = job_id.clone();
    tokio::spawn(async move {
        tail_runner_log(reg_clone, id_clone, log_path).await;
    });

    Ok(())
}

/// Tail the runner's log, re-emitting structured lines as SSE events. Terminates
/// on a `DEPLOY_RESULT=` line (or the 15-minute safety deadline). The post-
/// terminal "forget job after 10min" sweep runs from the same task.
async fn tail_runner_log(registry: Arc<JobRegistry>, job_id: String, log: PathBuf) {
    // Wait up to 60s for the log to appear. The path-unit can take a few
    // seconds to fire on a busy host.
    let mut opened = None;
    for _ in 0..60 {
        if let Ok(f) = tokio::fs::File::open(&log).await {
            opened = Some(f);
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let file = match opened {
        Some(f) => f,
        None => {
            registry
                .publish(
                    &job_id,
                    UpdateEvent {
                        job_id: job_id.clone(),
                        step: UpdateStep::Failed,
                        message:
                            "Root runner did not start. Check `journalctl -u supermux-deploy` on the server."
                                .into(),
                        ts: Utc::now().timestamp(),
                    },
                )
                .await;
            schedule_forget(registry, job_id, Duration::from_secs(60)).await;
            return;
        }
    };

    let reader = BufReader::new(file);
    let mut lines = reader.lines();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
    let mut terminal: Option<UpdateStep> = None;

    loop {
        if tokio::time::Instant::now() >= deadline {
            registry
                .publish(
                    &job_id,
                    UpdateEvent {
                        job_id: job_id.clone(),
                        step: UpdateStep::Failed,
                        message: "Update timed out after 15 minutes.".into(),
                        ts: Utc::now().timestamp(),
                    },
                )
                .await;
            break;
        }
        match tokio::time::timeout(Duration::from_secs(2), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                if let Some(ev) = parse_event_line(&line, &job_id) {
                    let step = ev.step;
                    registry.publish(&job_id, ev).await;
                    if matches!(
                        step,
                        UpdateStep::Done | UpdateStep::Failed | UpdateStep::RolledBack
                    ) {
                        terminal = Some(step);
                        break;
                    }
                } else if let Some(result) = line.strip_prefix("DEPLOY_RESULT=") {
                    // Final line written by the deploy runner. Map to a step
                    // so the UI can render a clean terminal state even if the
                    // update.sh script forgot to emit one explicitly.
                    let (step, msg) = match result.trim() {
                        "ok" => (UpdateStep::Done, "Update complete.".to_string()),
                        "failed" => (
                            UpdateStep::RolledBack,
                            "Update failed. The previous version has been restored.".to_string(),
                        ),
                        other => (
                            UpdateStep::Failed,
                            format!("Unknown deploy result: {other}"),
                        ),
                    };
                    registry
                        .publish(
                            &job_id,
                            UpdateEvent {
                                job_id: job_id.clone(),
                                step,
                                message: msg,
                                ts: Utc::now().timestamp(),
                            },
                        )
                        .await;
                    terminal = Some(step);
                    break;
                }
            }
            Ok(Ok(None)) => {
                // EOF (the runner hasn't appended yet). Brief wait, then poll.
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "tail: read error");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(_elapsed) => {
                // Timeout: no new line in 2s; loop and check the deadline.
                continue;
            }
        }
    }

    let _ = terminal; // already published; just signal to drop the registry slot.
    schedule_forget(registry, job_id, Duration::from_secs(10 * 60)).await;
}

/// Parse a `[update] step=<name> [msg=<text>]` log line into an [`UpdateEvent`].
/// Returns `None` for lines we don't recognise (most of the runner's output is
/// raw cargo / bun chatter we deliberately don't forward to the UI).
fn parse_event_line(line: &str, job_id: &str) -> Option<UpdateEvent> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("[update]")?.trim();
    let fields = parse_kv(rest);
    let step_str = fields.get("step")?.as_str();
    let step = match step_str {
        "fetching" => UpdateStep::Fetching,
        "building" => UpdateStep::Building,
        "installing" => UpdateStep::Installing,
        "verifying" => UpdateStep::Verifying,
        "done" => UpdateStep::Done,
        "failed" => UpdateStep::Failed,
        "rolled_back" => UpdateStep::RolledBack,
        _ => return None,
    };
    let message = fields
        .get("msg")
        .cloned()
        .unwrap_or_else(|| default_message(step).to_string());
    Some(UpdateEvent {
        job_id: job_id.to_string(),
        step,
        message,
        ts: Utc::now().timestamp(),
    })
}

/// Minimal `k=v k="v with spaces"` parser. The runner's lines are simple, so
/// we don't pull a shell-parsing crate.
fn parse_kv(s: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                break;
            }
            key.push(c);
            chars.next();
        }
        if chars.peek() != Some(&'=') {
            continue;
        }
        chars.next(); // consume '='
        let mut val = String::new();
        let quoted = chars.peek() == Some(&'"');
        if quoted {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '"' {
                    break;
                }
                val.push(c);
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                val.push(c);
                chars.next();
            }
        }
        out.insert(key, val);
    }
    out
}

fn default_message(step: UpdateStep) -> &'static str {
    match step {
        UpdateStep::Queued => "Update queued.",
        UpdateStep::Fetching => "Fetching the latest commit from GitHub.",
        UpdateStep::Building => "Building the new binary (this usually takes about a minute).",
        UpdateStep::Installing => "Installing the new binary.",
        UpdateStep::Verifying => "Verifying the new build came up healthy.",
        UpdateStep::Done => "Update complete.",
        UpdateStep::Failed => "Update failed.",
        UpdateStep::RolledBack => "Update failed. The previous version has been restored.",
    }
}

async fn schedule_forget(registry: Arc<JobRegistry>, id: String, delay: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        registry.forget(&id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_step_line() {
        let ev = parse_event_line("[update] step=building", "j1").unwrap();
        assert_eq!(ev.step, UpdateStep::Building);
        assert!(!ev.message.is_empty());
    }

    #[test]
    fn parses_quoted_message() {
        let ev = parse_event_line(
            r#"[update] step=verifying msg="Probing /api/health …""#,
            "j1",
        )
        .unwrap();
        assert_eq!(ev.step, UpdateStep::Verifying);
        assert_eq!(ev.message, "Probing /api/health …");
    }

    #[test]
    fn ignores_non_update_lines() {
        assert!(parse_event_line("warning: openssl-sys re-running", "j1").is_none());
        assert!(parse_event_line("[deploy-runner] OK", "j1").is_none());
    }

    #[test]
    fn rejects_unknown_step() {
        assert!(parse_event_line("[update] step=teleporting", "j1").is_none());
    }
}
