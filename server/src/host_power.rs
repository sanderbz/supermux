//! **Restart this Mac, or supermux-server itself, from the app** — owner/admin
//! only (`require_admin_mw` on the whole router, see `http.rs`).
//!
//! ```text
//! GET  /api/host/power            what this host supports + a pending restart
//! POST /api/host/restart          {password}  → checked now, Mac restarts in 30 s
//! POST /api/host/restart/cancel   → the pending Mac restart is called off
//! POST /api/host/restart-server   → supermux-server stops; its supervisor restarts it
//! ```
//!
//! **Why a password.** Restarting a Mac needs root, and the owner is often on
//! the phone with no terminal. The osascript route (System Events /
//! loginwindow) hangs on a locked screen, and an agent's shell has no tty for
//! `sudo` to prompt on. So the app asks for the Mac's login password and hands
//! it to `sudo -S` on STDIN — never in argv, never in a log or the audit row,
//! never on disk. It is checked at once (`sudo -v`), so a typo fails before the
//! countdown starts, then held in memory for the countdown only and wiped
//! ([`Zeroizing`]) when the restart runs or is cancelled.
//!
//! **Where it works.** The Mac restart is macOS-only: the Linux systemd unit
//! runs with `NoNewPrivileges=true`, under which `sudo` cannot work by design.
//! Restarting the server needs a supervisor that brings it back (launchd
//! `KeepAlive`, systemd `Restart=always`); a bare binary would just stop, so
//! there the button is not offered. Session panes survive either way — their
//! pty holders are detached from the server (the same path every deploy takes).
//!
//! The countdown is broadcast as a `host-power` SSE frame (owner-only, being
//! unstamped), so every open app shows it with a Cancel button.

use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use zeroize::Zeroizing;

use crate::db;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

/// How long the Mac waits after a confirmed restart, so it can be called off.
pub const RESTART_DELAY: Duration = Duration::from_secs(30);
/// A `sudo` that has not answered by now is killed and reported as a failure.
const SUDO_TIMEOUT: Duration = Duration::from_secs(20);
/// Wrong passwords allowed per window before the route answers 429.
const MAX_FAILED: usize = 5;
const FAILED_WINDOW: Duration = Duration::from_secs(15 * 60);

const SUDO: &str = "/usr/bin/sudo";
const SHUTDOWN: &str = "/sbin/shutdown";

pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/host/power", get(power_handler))
        .route("/api/host/restart", post(restart_handler))
        .route("/api/host/restart/cancel", post(cancel_handler))
        .route("/api/host/restart-server", post(restart_server_handler))
        .with_state(state)
}

/// One action's availability on THIS host, with the reason when it is not.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Support {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Support {
    fn yes() -> Self {
        Support {
            supported: true,
            reason: None,
        }
    }
    fn no(reason: &str) -> Self {
        Support {
            supported: false,
            reason: Some(reason.to_string()),
        }
    }
}

/// A Mac restart that has been confirmed and is counting down.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PendingView {
    /// Unix seconds at which the restart runs.
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PowerView {
    pub host_restart: Support,
    pub server_restart: Support,
    pub pending: Option<PendingView>,
}

struct Pending {
    at: i64,
    task: tokio::task::AbortHandle,
}

static PENDING: Lazy<Mutex<Option<Pending>>> = Lazy::new(|| Mutex::new(None));
static FAILED: Lazy<Mutex<Vec<Instant>>> = Lazy::new(|| Mutex::new(Vec::new()));

// ── what this host supports ─────────────────────────────────────────────────

/// The Mac restart: macOS, a `sudo` + `shutdown` to call, and not already root
/// (a root server has no password to ask for and is not a setup this targets).
pub fn host_restart_support() -> Support {
    if !cfg!(target_os = "macos") {
        return Support::no(
            "Restarting the machine is available on macOS only. On Linux the supermux \
             service runs without sudo rights by design.",
        );
    }
    if !std::path::Path::new(SUDO).exists() || !std::path::Path::new(SHUTDOWN).exists() {
        return Support::no("This Mac has no sudo or shutdown command to call.");
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        return Support::no("supermux-server runs as root here; restart the machine directly.");
    }
    Support::yes()
}

/// The server restart: only under a supervisor that starts it again.
pub fn server_restart_support() -> Support {
    server_restart_support_from(
        std::env::var("XPC_SERVICE_NAME").ok().as_deref(),
        std::env::var("INVOCATION_ID").ok().as_deref(),
        std::path::Path::new("/.dockerenv").exists(),
    )
}

/// Pure half of [`server_restart_support`]: launchd stamps `XPC_SERVICE_NAME`
/// with the job label (`"0"` outside a job), systemd sets `INVOCATION_ID` in a
/// unit's processes. Docker's restart policy is unknown, so it is not offered.
pub fn server_restart_support_from(
    xpc_service: Option<&str>,
    invocation_id: Option<&str>,
    in_docker: bool,
) -> Support {
    if in_docker {
        return Support::no("supermux runs in Docker here; restart the container instead.");
    }
    let launchd = xpc_service.is_some_and(|s| !s.is_empty() && s != "0");
    let systemd = invocation_id.is_some_and(|s| !s.is_empty());
    if launchd || systemd {
        Support::yes()
    } else {
        Support::no(
            "supermux-server is not running under launchd or systemd, so nothing would \
             start it again.",
        )
    }
}

fn pending_view() -> Option<PendingView> {
    PENDING
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| PendingView { at: p.at })
}

fn view() -> PowerView {
    PowerView {
        host_restart: host_restart_support(),
        server_restart: server_restart_support(),
        pending: pending_view(),
    }
}

fn broadcast(state: &AppState) {
    let _ = state
        .sse_tx
        // Spelled out (not a const): `web/tests/unit/sse-events.test.ts` scrapes
        // the literal to prove the app subscribes to every channel we emit.
        .send(SseEvent::global(
            "host-power",
            json!({ "pending": pending_view() }),
        ));
}

// ── the wrong-password limit ────────────────────────────────────────────────

fn too_many_failures(now: Instant) -> bool {
    let mut f = FAILED.lock().unwrap();
    f.retain(|t| now.duration_since(*t) < FAILED_WINDOW);
    f.len() >= MAX_FAILED
}

fn record_failure(now: Instant) {
    FAILED.lock().unwrap().push(now);
}

// ── sudo ────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub enum SudoError {
    WrongPassword,
    NotAllowed,
    TimedOut,
    Failed(String),
}

/// Map a failed `sudo` to what the owner should read. Pure.
pub fn classify_sudo_failure(stderr: &str) -> SudoError {
    let s = stderr.to_ascii_lowercase();
    if s.contains("not in the sudoers") || s.contains("not allowed to") {
        SudoError::NotAllowed
    } else if s.contains("incorrect password")
        || s.contains("sorry, try again")
        || s.contains("no password was provided")
        || s.contains("password attempt")
    {
        SudoError::WrongPassword
    } else {
        // `sudo` writes nothing secret here (the prompt is suppressed and the
        // password only ever went in on stdin), but keep it short.
        SudoError::Failed(
            stderr
                .lines()
                .next()
                .unwrap_or("sudo failed")
                .chars()
                .take(200)
                .collect(),
        )
    }
}

/// Drop every cached `sudo` credential of this user. A successful `sudo`
/// leaves a timestamp behind for a few minutes; nothing here relies on it, so
/// it is removed straight away rather than left for any other process to reuse.
async fn forget_sudo() {
    let _ = tokio::process::Command::new(SUDO)
        .arg("-K")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

/// `sudo -S -k -p '' <args>` with `password` on stdin. `-k` ignores any cached
/// credential so the password is always what decides; `-p ''` keeps the prompt
/// out of stderr.
async fn sudo(password: &str, args: &[&str]) -> Result<(), SudoError> {
    let mut child = tokio::process::Command::new(SUDO)
        .args(["-S", "-k", "-p", ""])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| SudoError::Failed(format!("could not run sudo: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let line = Zeroizing::new(format!("{password}\n"));
        let _ = stdin.write_all(line.as_bytes()).await;
        // Dropping stdin closes it, so a wrong password meets EOF on the retry
        // instead of waiting for a second line.
    }
    let waited = tokio::time::timeout(SUDO_TIMEOUT, child.wait_with_output()).await;
    forget_sudo().await;
    let out = match waited {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(SudoError::Failed(e.to_string())),
        Err(_) => return Err(SudoError::TimedOut),
    };
    if out.status.success() {
        Ok(())
    } else {
        Err(classify_sudo_failure(&String::from_utf8_lossy(&out.stderr)))
    }
}

// ── handlers ────────────────────────────────────────────────────────────────

async fn power_handler() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "data": view() }))
}

#[derive(Deserialize)]
pub struct RestartInput {
    password: Zeroizing<String>,
}

async fn restart_handler(
    State(state): State<AppState>,
    Json(input): Json<RestartInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let support = host_restart_support();
    if !support.supported {
        return Err(AppError::BadRequest(support.reason.unwrap_or_default()));
    }
    if pending_view().is_some() {
        return Err(AppError::Conflict(
            "a restart is already counting down".into(),
        ));
    }
    if input.password.is_empty() {
        return Err(AppError::BadRequest(
            "enter this Mac's login password".into(),
        ));
    }
    let now = Instant::now();
    if too_many_failures(now) {
        return Err(AppError::TooManyRequests(
            "too many wrong passwords — try again in 15 minutes".into(),
        ));
    }
    // Check the password NOW, so a typo fails here and not after the countdown.
    if let Err(e) = sudo(&input.password, &["-v"]).await {
        return Err(match e {
            SudoError::WrongPassword => {
                record_failure(now);
                AppError::Forbidden("that password didn't work".into())
            }
            SudoError::NotAllowed => {
                AppError::Forbidden("this Mac user is not allowed to use sudo".into())
            }
            SudoError::TimedOut => AppError::Conflict("sudo did not answer in time".into()),
            SudoError::Failed(m) => AppError::Conflict(format!("sudo failed: {m}")),
        });
    }

    let at = chrono::Utc::now().timestamp() + RESTART_DELAY.as_secs() as i64;
    let password = input.password;
    let st = state.clone();
    let task = tokio::spawn(async move {
        tokio::time::sleep(RESTART_DELAY).await;
        let _ = db::audit::log(&st.pool, "user", "host.restart", "host", json!({})).await;
        tracing::warn!("restarting this Mac now (requested from the app)");
        if let Err(e) = sudo(&password, &[SHUTDOWN, "-r", "now"]).await {
            tracing::error!(error = ?e, "host restart failed");
            PENDING.lock().unwrap().take();
            broadcast(&st);
            let _ =
                db::audit::log(&st.pool, "user", "host.restart.failed", "host", json!({})).await;
        }
        // `password` drops here and is wiped.
    });
    *PENDING.lock().unwrap() = Some(Pending {
        at,
        task: task.abort_handle(),
    });
    db::audit::log(
        &state.pool,
        "user",
        "host.restart.requested",
        "host",
        json!({ "at": at }),
    )
    .await?;
    broadcast(&state);
    Ok(Json(json!({ "ok": true, "data": view() })))
}

async fn cancel_handler(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Aborting the task drops it, and with it the password it held.
    let cancelled = PENDING
        .lock()
        .unwrap()
        .take()
        .map(|p| p.task.abort())
        .is_some();
    if cancelled {
        db::audit::log(
            &state.pool,
            "user",
            "host.restart.cancelled",
            "host",
            json!({}),
        )
        .await?;
        broadcast(&state);
    }
    Ok(Json(json!({ "ok": true, "data": view() })))
}

async fn restart_server_handler(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let support = server_restart_support();
    if !support.supported {
        return Err(AppError::BadRequest(support.reason.unwrap_or_default()));
    }
    db::audit::log(
        &state.pool,
        "user",
        "server.restart",
        "supermux-server",
        json!({}),
    )
    .await?;
    // Answer first, then stop: SIGTERM is exactly what `launchctl kickstart -k`
    // and `systemctl restart` send, and the supervisor starts us again. Session
    // panes keep running — their pty holders are not our children's group.
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        tracing::warn!("restarting supermux-server (requested from the app)");
        let _ = nix::sys::signal::kill(nix::unistd::Pid::this(), nix::sys::signal::Signal::SIGTERM);
    });
    Ok(Json(json!({ "ok": true, "data": { "restarting": true } })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_restart_needs_a_supervisor() {
        assert!(server_restart_support_from(Some("com.supermux.server"), None, false).supported);
        assert!(server_restart_support_from(None, Some("abc123"), false).supported);
        // launchd's "not a job" marker and an empty systemd id are not supervisors.
        assert!(!server_restart_support_from(Some("0"), None, false).supported);
        assert!(!server_restart_support_from(None, Some(""), false).supported);
        assert!(!server_restart_support_from(None, None, false).supported);
        // Docker's restart policy is unknown — never offered.
        assert!(!server_restart_support_from(Some("x"), Some("y"), true).supported);
    }

    #[test]
    fn sudo_failures_read_as_what_went_wrong() {
        assert_eq!(
            classify_sudo_failure("Sorry, try again.\nsudo: 1 incorrect password attempt"),
            SudoError::WrongPassword
        );
        assert_eq!(
            classify_sudo_failure("sudo: no password was provided"),
            SudoError::WrongPassword
        );
        assert_eq!(
            classify_sudo_failure("bob is not in the sudoers file."),
            SudoError::NotAllowed
        );
        assert!(matches!(
            classify_sudo_failure("sudo: something odd"),
            SudoError::Failed(_)
        ));
    }

    #[test]
    fn the_password_is_never_serialized_back() {
        // The view carries no input field at all; the input type cannot be
        // serialized (it only derives Deserialize), so a password cannot be
        // echoed by accident.
        let v = serde_json::to_string(&view()).unwrap();
        assert!(!v.contains("password"));
    }

    #[test]
    fn the_wrong_password_limit_resets_after_its_window() {
        let t0 = Instant::now();
        FAILED.lock().unwrap().clear();
        for _ in 0..MAX_FAILED {
            record_failure(t0);
        }
        assert!(too_many_failures(t0));
        assert!(!too_many_failures(
            t0 + FAILED_WINDOW + Duration::from_secs(1)
        ));
        FAILED.lock().unwrap().clear();
    }
}
