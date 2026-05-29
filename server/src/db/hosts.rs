//! Host row access (migration `0017_hosts.sql`).
//!
//! Mirrors the pattern in [`crate::db::sessions`]: runtime-checked
//! `sqlx::query_as::<_, T>` rather than the compile-time `query_as!` macro, so
//! a hermetic `cargo build`/`cargo test` (no `DATABASE_URL`, no committed
//! `.sqlx` cache) stays deterministic for the orchestrator. The `FromRow`
//! struct still gives typed rows.
//!
//! `host_id` on `sessions` is NULLable; a session with `host_id IS NULL` is
//! LOCAL — the entire pre-remote-host behavior. Soft-deleted hosts keep their
//! row so historical sessions can still resolve their host name, but `list()`
//! filters them out.

use serde::Serialize;
use sqlx::SqlitePool;

/// Lifecycle/reachability state for a host. Persisted as a TEXT column with a
/// `CHECK` constraint in migration 0017 — the three variants here are the
/// only legal values, so a round-trip through [`HostStatus::from_str`] +
/// [`HostStatus::as_str`] is total against the DB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostStatus {
    /// Never probed (default for a fresh row) or probe outcome is stale.
    Unknown,
    /// Last `ssh ... -- echo ok` succeeded; `last_seen` is set.
    Reachable,
    /// Last probe failed (or HostPool backoff gave up).
    Unreachable,
}

impl HostStatus {
    /// SQL-text form, matching the `CHECK (status IN (...))` literals in 0017.
    pub fn as_str(self) -> &'static str {
        match self {
            HostStatus::Unknown => "unknown",
            HostStatus::Reachable => "reachable",
            HostStatus::Unreachable => "unreachable",
        }
    }

    /// Parse a status string read back from the DB. Returns `None` on an
    /// unknown variant so callers can decide whether to treat it as an error
    /// or silently coerce to [`HostStatus::Unknown`] (the CHECK constraint
    /// makes this unreachable in practice; the strict parse is for the test
    /// surface).
    pub fn from_str(s: &str) -> Option<HostStatus> {
        Some(match s {
            "unknown" => HostStatus::Unknown,
            "reachable" => HostStatus::Reachable,
            "unreachable" => HostStatus::Unreachable,
            _ => return None,
        })
    }
}

/// A row of the `hosts` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Host {
    pub id: i64,
    /// User-facing label, e.g. `"ml-rig"`. `UNIQUE` in the schema.
    pub name: String,
    /// SSH connection target, e.g. `"user@ml-rig.tailnet.ts.net"`.
    pub ssh_target: String,
    /// Optional explicit identity file; `None` means rely on `~/.ssh/config`
    /// and the running ssh-agent.
    pub ssh_key_path: Option<String>,
    /// One of `unknown` / `reachable` / `unreachable`. Use
    /// [`HostStatus::from_str`] to lift back to the enum.
    pub status: String,
    /// Unix seconds of the last successful reachability probe (NULL until the
    /// first `update_status(Reachable)`).
    pub last_seen: Option<i64>,
    /// Unix seconds when the row was inserted.
    pub created_at: i64,
    /// Unix seconds when [`soft_delete`] tombstoned the row. `NULL` for live
    /// hosts; [`list`] filters non-NULL out.
    pub deleted_at: Option<i64>,
}

/// List live (non-soft-deleted) hosts, alphabetically by name. Use this for
/// the FE host-picker / HostPool warm-up; soft-deleted rows survive so a
/// historical session's `host_id` still resolves via [`get`].
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Host>> {
    sqlx::query_as::<_, Host>(
        "SELECT id, name, ssh_target, ssh_key_path, status, last_seen, created_at, deleted_at \
         FROM hosts WHERE deleted_at IS NULL ORDER BY name ASC",
    )
    .fetch_all(pool)
    .await
}

/// Fetch one host by id. Returns soft-deleted rows too — the caller decides
/// whether tombstones are meaningful (e.g. resolving a historical session).
pub async fn get(pool: &SqlitePool, id: i64) -> sqlx::Result<Option<Host>> {
    sqlx::query_as::<_, Host>(
        "SELECT id, name, ssh_target, ssh_key_path, status, last_seen, created_at, deleted_at \
         FROM hosts WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// Fetch one host by its user-facing `name`. Returns soft-deleted rows too —
/// this is intentional so the historical-session lookup path doesn't lose its
/// label after a delete. Callers that only want live hosts must filter on
/// `deleted_at.is_none()` themselves (or use [`list`]).
pub async fn get_by_name(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<Host>> {
    sqlx::query_as::<_, Host>(
        "SELECT id, name, ssh_target, ssh_key_path, status, last_seen, created_at, deleted_at \
         FROM hosts WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(pool)
    .await
}

/// Insert a fresh host row with `status = 'unknown'`, `created_at = now()`,
/// and return the freshly-inserted [`Host`]. The `UNIQUE(name)` constraint
/// surfaces a duplicate-name attempt as a `sqlx::Error::Database` with the
/// SQLite UNIQUE error code; the test suite asserts this.
pub async fn create(
    pool: &SqlitePool,
    name: &str,
    ssh_target: &str,
    ssh_key_path: Option<&str>,
) -> sqlx::Result<Host> {
    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO hosts (name, ssh_target, ssh_key_path, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(name)
    .bind(ssh_target)
    .bind(ssh_key_path)
    .bind(now)
    .execute(pool)
    .await?;
    let id = res.last_insert_rowid();
    // The SELECT round-trip returns the canonical defaults (status='unknown',
    // last_seen=NULL, deleted_at=NULL) so callers don't have to reconstruct
    // the row in-memory.
    get(pool, id)
        .await?
        .ok_or_else(|| sqlx::Error::RowNotFound)
}

/// Update a host's reachability `status`. When `status == Reachable` we also
/// bump `last_seen` to now — the reachability probe
/// (`POST /api/hosts/{id}/check`) is the canonical writer. Other transitions
/// leave `last_seen` alone so the UI can still show "last reachable Xm ago"
/// after a host goes down.
pub async fn update_status(
    pool: &SqlitePool,
    id: i64,
    status: HostStatus,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    if matches!(status, HostStatus::Reachable) {
        sqlx::query("UPDATE hosts SET status = ?, last_seen = ? WHERE id = ?")
            .bind(status.as_str())
            .bind(now)
            .bind(id)
            .execute(pool)
            .await?;
    } else {
        sqlx::query("UPDATE hosts SET status = ? WHERE id = ?")
            .bind(status.as_str())
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Tombstone a host: stamp `deleted_at = now()` (idempotent — re-deleting an
/// already-deleted row is a no-op the SQL silently absorbs). The row survives
/// so any session referencing this host via `host_id` can still resolve its
/// label and ssh_target for archived/historical views; [`list`] filters
/// tombstones out so the FE picker never offers them.
pub async fn soft_delete(pool: &SqlitePool, id: i64) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE hosts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
