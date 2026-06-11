//! Update execution: spawn the update task, broadcast progress to SSE subscribers.
//!
//! The actual `build + install + verify + rollback` pipeline lives in the
//! root-side `supermux-deploy-runner` (so an OSS user can read exactly what
//! the 1-click button runs). This module's job:
//!   1. Refuse the request when preflight has any blocked_reason (done in `api`).
//!   2. Fast-forward the source clone to `origin/main` so the build is of the
//!      target release, NOT whatever commit happens to be checked out. This is
//!      done HERE (in the backend, as the service user) because the runner
//!      builds the source dir as-is; without this step the in-UI update would
//!      rebuild the currently-deployed commit and never reach the new release.
//!   3. Write a marker file under `<data>/deploy/` that the root-side
//!      `supermux-deploy.path` unit watches; that unit builds + installs the
//!      now-fast-forwarded clone.
//!   4. Spawn a tokio task that tails the runner's log file and re-emits each
//!      structured `[update] step=<name>` line as an `UpdateEvent` on a
//!      per-job broadcast channel the `/api/update/progress/:job_id` SSE
//!      handler subscribes to.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
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

/// Kick off the update for `job_id` from `source_dir`.
///
/// Sequence (the critical ordering):
///   1. emit `Queued`, then `Fetching` so the UI leaves "Queued" immediately;
///   2. `git fetch --tags origin` + fast-forward `source_dir` to the
///      `target_tag` commit, so the clone is on EXACTLY the release the UI
///      advertised before the runner builds it (the runner builds the source
///      dir as-is and does NOT pull). Pinning to the tag, not `origin/main`,
///      is the whole contract: detection is tag-based, so installing the
///      branch tip would silently ship unreleased commits. On any fetch/ff
///      failure we emit `Failed` and return WITHOUT writing the request, so a
///      stale (or past-the-release) checkout is never built;
///   3. resolve the new HEAD sha and write THAT as the request `sha=` (the
///      target the runner records), atomically (request.tmp → mv → request);
///   4. spawn a tail task that reads the runner's log and re-emits each
///      `[update] step=<name>` line (building/installing/verifying/done) as an
///      SSE event. Returns immediately. The SSE endpoint is the progress surface.
///
/// `current_sha` is the currently-deployed commit; it is used only as a logged
/// fallback if reading the new HEAD fails (it should not, after a clean ff).
///
/// NOTE: this runs as the supermux service user, the SAME uid the runner builds
/// the clone as, so the fetch+ff touches the very tree the runner will build.
/// `scripts/deploy-self.sh` (dev self-deploy of LOCAL commits) writes its own
/// request and never calls this function, so that path is unaffected.
pub async fn spawn_update_task(
    registry: Arc<JobRegistry>,
    job_id: String,
    source_dir: PathBuf,
    current_sha: String,
    target_tag: String,
) -> Result<(), String> {
    // Initial "queued" event so the UI never shows a blank progress bar.
    registry
        .publish(
            &job_id,
            UpdateEvent {
                job_id: job_id.clone(),
                step: UpdateStep::Queued,
                message: "Update queued.".into(),
                ts: Utc::now().timestamp(),
            },
        )
        .await;

    // ── fast-forward the clone to the release tag BEFORE the build ───────────
    // The runner builds source_dir AS-IS; without this it would rebuild the
    // currently-checked-out commit and never reach the new release. We emit
    // `Fetching` first so the UI advances off "Queued" while git runs.
    registry
        .publish(
            &job_id,
            UpdateEvent {
                job_id: job_id.clone(),
                step: UpdateStep::Fetching,
                message: format!("Fetching release {target_tag} from GitHub."),
                ts: Utc::now().timestamp(),
            },
        )
        .await;

    let target_sha = match fetch_and_fast_forward(&source_dir, &target_tag) {
        Ok(sha) => sha,
        Err(e) => {
            // Surface a clear terminal failure and do NOT write the request:
            // we must never trigger a build of a stale (or diverged) checkout.
            registry
                .publish(
                    &job_id,
                    UpdateEvent {
                        job_id: job_id.clone(),
                        step: UpdateStep::Failed,
                        message: format!(
                            "Could not fast-forward to release {target_tag}, so the update was not started: {e}"
                        ),
                        ts: Utc::now().timestamp(),
                    },
                )
                .await;
            schedule_forget(registry, job_id, Duration::from_secs(60)).await;
            // Return Ok: the failure is already reported on the SSE stream, and
            // /api/update/start already handed the client a job_id. A 500 here
            // would race the SSE event and confuse the UI.
            return Ok(());
        }
    };

    // Log the transition for ops; `current_sha` is the pre-update commit.
    tracing::info!(
        from = %current_sha,
        to = %target_sha,
        tag = %target_tag,
        "update: fast-forwarded source clone to the release tag"
    );

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
    // Write the TARGET sha (origin/main's HEAD we just fast-forwarded to), not
    // the pre-update commit, so the runner records the version it actually builds.
    let body = format!(
        "source_dir={}\nsha={}\nnonce={}\n",
        source_dir.display(),
        target_sha,
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

/// Fetch `origin` (with tags) and fast-forward `source_dir` to the `tag`
/// commit, returning the new HEAD sha on success.
///
/// The target is the RELEASE TAG, not `origin/main`: update detection is
/// tag-based (current binary tag vs the latest GitHub release), so building
/// the branch tip would install commits past the release the UI advertised.
///
/// `--ff-only` is safe here because `/api/update/start`'s preflight (re-run at
/// call time) already guarantees: on branch `main`, clean working tree, and NOT
/// ahead of origin. So this can only ever fast-forward, never rewrite local
/// commits. If the tree is already on the tag the merge is a no-op.
///
/// One git subtlety makes the final HEAD check load-bearing: `merge --ff-only
/// <commit>` SUCCEEDS as a silent no-op when `<commit>` is an ancestor of
/// HEAD ("Already up to date"). A clone sitting past the release (a dev
/// checkout that pulled main) would therefore "succeed" while still pointing
/// at unreleased commits, which is exactly the bug this function exists to
/// prevent. So: after the merge, HEAD must equal the tag commit, or we refuse.
fn fetch_and_fast_forward(source_dir: &Path, tag: &str) -> Result<String, String> {
    let fetch = Command::new("git")
        .args(["fetch", "--tags", "--quiet", "origin"])
        .current_dir(source_dir)
        .output()
        .map_err(|e| format!("could not run git fetch: {e}"))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch origin failed (is the host offline?): {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }

    // Resolve the tag to its commit (`^{{commit}}` peels annotated tags).
    let tag_ref = format!("refs/tags/{tag}^{{commit}}");
    let resolve = Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", &tag_ref])
        .current_dir(source_dir)
        .output()
        .map_err(|e| format!("could not run git rev-parse: {e}"))?;
    if !resolve.status.success() {
        return Err(format!(
            "release tag {tag} was not found on origin. The GitHub release exists but its tag isn't fetchable; was the tag pushed?"
        ));
    }
    let tag_sha = String::from_utf8_lossy(&resolve.stdout).trim().to_string();

    let merge = Command::new("git")
        .args(["merge", "--ff-only", &tag_sha])
        .current_dir(source_dir)
        .output()
        .map_err(|e| format!("could not run git merge: {e}"))?;
    if !merge.status.success() {
        return Err(format!(
            "git merge --ff-only to release {tag} failed (diverged history?): {}",
            String::from_utf8_lossy(&merge.stderr).trim()
        ));
    }

    let head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(source_dir)
        .output()
        .map_err(|e| format!("could not run git rev-parse: {e}"))?;
    if !head.status.success() {
        return Err(format!(
            "git rev-parse HEAD failed: {}",
            String::from_utf8_lossy(&head.stderr).trim()
        ));
    }
    let head_sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if head_sha.is_empty() {
        return Err("git rev-parse HEAD returned an empty sha".to_string());
    }
    if head_sha != tag_sha {
        return Err(format!(
            "the clone is ahead of release {tag} (a development checkout?). The in-UI updater only installs published releases; use scripts/deploy-self.sh to deploy local commits, or reset the clone to the release tag."
        ));
    }
    Ok(head_sha)
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

    #[test]
    fn parses_every_runner_step_marker() {
        // These are the EXACT step strings the root path-unit runner
        // (etc/supermux-deploy-runner) emits to the log this module tails.
        // The contract is load-bearing: if the runner's step() names and this
        // parser ever drift, the in-UI progress bar silently sticks on
        // "Queued" (the original bug). Pin the full set here so a rename on
        // either side fails the build.
        let cases: &[(&str, UpdateStep)] = &[
            ("[update] step=fetching", UpdateStep::Fetching),
            ("[update] step=building", UpdateStep::Building),
            ("[update] step=installing", UpdateStep::Installing),
            ("[update] step=verifying", UpdateStep::Verifying),
            ("[update] step=done", UpdateStep::Done),
            ("[update] step=failed", UpdateStep::Failed),
            ("[update] step=rolled_back", UpdateStep::RolledBack),
        ];
        for (line, want) in cases {
            let ev = parse_event_line(line, "j1")
                .unwrap_or_else(|| panic!("runner line should parse: {line:?}"));
            assert_eq!(ev.step, *want, "wrong step for {line:?}");
            assert!(!ev.message.is_empty(), "empty default message for {line:?}");
        }
    }

    #[test]
    fn parses_runner_step_with_message() {
        // The runner emits `[update] step=<name> msg="<text>"`; the msg must
        // come through verbatim so the UI shows the runner's own copy.
        let ev = parse_event_line(
            r#"[update] step=installing msg="Installing the new binary and restarting the service.""#,
            "j1",
        )
        .unwrap();
        assert_eq!(ev.step, UpdateStep::Installing);
        assert_eq!(ev.message, "Installing the new binary and restarting the service.");
    }

    // ── fetch + fast-forward ─────────────────────────────────────────────────
    // These build two real git repos (a "remote" and a "clone" of it on main),
    // advance the remote, and assert the in-UI fetch+ff lands the clone on
    // EXACTLY the release tag's commit — not the clone's old commit (the
    // original bug) and not the tip of main (the second bug: detection is
    // tag-based but the install used to build origin/main, silently shipping
    // unreleased commits).

    use std::process::Command;

    /// A self-cleaning scratch dir (avoids pulling in the `tempfile` crate just
    /// for these two tests). Removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "supermux-ff-test-{}-{}-{}",
                tag,
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Build a bare "remote" with one commit on `main` (tagged `v0.0.1`) and a
    /// working clone of it. Returns (remote_dir, clone_dir, scratch_guard).
    fn make_remote_and_clone() -> (PathBuf, PathBuf, Scratch) {
        let tmp = Scratch::new("repo");
        let seed = tmp.path().join("seed");
        let remote = tmp.path().join("remote.git");
        let clone = tmp.path().join("clone");

        // Seed repo on main with one tagged commit, then push into a bare remote.
        std::fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        std::fs::write(seed.join("file.txt"), b"v1\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-q", "-m", "v1"]);
        git(&seed, &["tag", "v0.0.1"]);
        git(&seed, &["clone", "-q", "--bare", ".", remote.to_str().unwrap()]);

        // The clone the in-UI updater operates on; on branch main tracking origin.
        git(
            tmp.path(),
            &["clone", "-q", remote.to_str().unwrap(), clone.to_str().unwrap()],
        );
        git(&clone, &["checkout", "-q", "main"]);

        (remote, clone, tmp)
    }

    /// Push a commit to the remote's `main` from a fresh working clone and
    /// return its sha. Tags it when `tag` is `Some`.
    fn push_remote_commit(remote: &Path, name: &str, content: &str, tag: Option<&str>) -> String {
        let pusher = remote.parent().unwrap().join(format!("pusher-{name}"));
        git(
            remote.parent().unwrap(),
            &["clone", "-q", remote.to_str().unwrap(), pusher.to_str().unwrap()],
        );
        git(&pusher, &["checkout", "-q", "main"]);
        std::fs::write(pusher.join("file.txt"), content).unwrap();
        git(&pusher, &["add", "."]);
        git(&pusher, &["commit", "-q", "-m", name]);
        if let Some(t) = tag {
            git(&pusher, &["tag", t]);
            git(&pusher, &["push", "-q", "origin", t]);
        }
        git(&pusher, &["push", "-q", "origin", "main"]);
        git(&pusher, &["rev-parse", "HEAD"])
    }

    #[test]
    fn fast_forward_advances_clone_to_the_release_tag() {
        let (remote, clone, _tmp) = make_remote_and_clone();

        // The clone starts on v1.
        let old = git(&clone, &["rev-parse", "HEAD"]);

        // A new release lands on the remote: a commit tagged v0.0.2.
        let tagged = push_remote_commit(&remote, "v2", "v2\n", Some("v0.0.2"));

        // The fix: fetch + ff lands the clone on the TAG commit and returns it
        // as the target sha (this is what gets written as request sha=).
        let target = super::fetch_and_fast_forward(&clone, "v0.0.2").expect("ff succeeds");
        assert_eq!(target, tagged, "target sha must be the release tag's commit");
        assert_ne!(target, old, "clone must have advanced past its old commit");
        assert_eq!(
            git(&clone, &["rev-parse", "HEAD"]),
            tagged,
            "the working tree HEAD must now be the release tag"
        );
    }

    #[test]
    fn fast_forward_pins_to_the_tag_not_the_branch_tip() {
        // THE regression this module exists to prevent: detection said
        // "update to v0.0.2" but the install used to build origin/main, which
        // here carries an extra unreleased commit past the tag.
        let (remote, clone, _tmp) = make_remote_and_clone();
        let tagged = push_remote_commit(&remote, "v2", "v2\n", Some("v0.0.2"));
        let tip = push_remote_commit(&remote, "wip", "unreleased\n", None);
        assert_ne!(tagged, tip);

        let target = super::fetch_and_fast_forward(&clone, "v0.0.2").expect("ff succeeds");
        assert_eq!(target, tagged, "must install the tag commit");
        assert_eq!(
            git(&clone, &["rev-parse", "HEAD"]),
            tagged,
            "HEAD must be the tag, not origin/main's tip"
        );
    }

    #[test]
    fn fast_forward_is_a_noop_when_already_on_the_tag() {
        // A clone already sitting on the release: ff-only is a no-op that must
        // succeed and return the same HEAD (no error, no double-pull pain).
        let (_remote, clone, _tmp) = make_remote_and_clone();
        let head = git(&clone, &["rev-parse", "HEAD"]);
        let target = super::fetch_and_fast_forward(&clone, "v0.0.1").expect("noop ff succeeds");
        assert_eq!(target, head);
    }

    #[test]
    fn fast_forward_refuses_a_clone_ahead_of_the_release() {
        // `merge --ff-only <ancestor>` "succeeds" as a no-op, so a dev clone
        // sitting PAST the release would silently keep its unreleased commits;
        // the explicit HEAD==tag check must turn that into a refusal.
        let (_remote, clone, _tmp) = make_remote_and_clone();
        std::fs::write(clone.join("file.txt"), b"local wip\n").unwrap();
        git(&clone, &["add", "."]);
        git(&clone, &["commit", "-q", "-m", "local wip"]);

        let err = super::fetch_and_fast_forward(&clone, "v0.0.1")
            .expect_err("a clone past the tag must be refused");
        assert!(err.contains("ahead of release v0.0.1"), "unexpected error: {err}");
    }

    #[test]
    fn fast_forward_refuses_a_missing_tag() {
        // GitHub shows a release whose tag was never pushed (or was deleted):
        // refuse with a message naming the tag instead of building anything.
        let (_remote, clone, _tmp) = make_remote_and_clone();
        let err = super::fetch_and_fast_forward(&clone, "v9.9.9")
            .expect_err("a missing tag must be refused");
        assert!(err.contains("v9.9.9"), "unexpected error: {err}");
    }
}
