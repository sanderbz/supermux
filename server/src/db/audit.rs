//! Audit-log writer (migration `0007_audit.sql`).
//!
//! Every destructive HTTP call records a row. Callers write `file.put` and
//! `file.delete`, and reuse [`log`] for `session.delete`, `schedule.run`, etc.
//! The `actor` is `user` for HTTP-originated calls, `scheduler` for
//! tick-originated calls, and `agent:<name>` for cross-session calls.
//!
//! **Secret hygiene.** `detail` must never contain secret values — only
//! metadata (path, byte count, which env var). Callers are responsible for
//! keeping secrets out of the JSON they pass here.

use once_cell::sync::Lazy;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::db::runtime_state::{AuditEntry, Delegation};

/// Insert one audit row. `detail` is serialized to a JSON string column.
pub async fn log(
    pool: &SqlitePool,
    actor: &str,
    action: &str,
    target: &str,
    detail: Value,
) -> sqlx::Result<()> {
    log_entry(pool, actor, action, target, detail).await.map(|_| ())
}

/// [`log`], but hands back the row it just wrote.
///
/// The harness-event feed's SSE echo needs to ship the entry it is announcing,
/// and re-reading the ledger to find the row we just inserted would be a race
/// with every other writer. Building the entry from the same values we bound is
/// exact by construction.
pub async fn log_entry(
    pool: &SqlitePool,
    actor: &str,
    action: &str,
    target: &str,
    detail: Value,
) -> sqlx::Result<AuditEntry> {
    let ts = chrono::Utc::now().timestamp();
    let detail = detail.to_string();
    let res =
        sqlx::query("INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
            .bind(ts)
            .bind(actor)
            .bind(action)
            .bind(target)
            .bind(&detail)
            .execute(pool)
            .await?;
    Ok(AuditEntry {
        id: res.last_insert_rowid(),
        ts,
        actor: actor.to_string(),
        action: action.to_string(),
        target: target.to_string(),
        detail,
    })
}

/// The most-recent `limit` audit rows, newest first (`GET /api/audit?limit=N`).
/// Backed by `idx_audit_ts`.
pub async fn list(pool: &SqlitePool, limit: i64) -> sqlx::Result<Vec<AuditEntry>> {
    sqlx::query_as::<_, AuditEntry>(
        "SELECT id, ts, actor, action, target, detail FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

// ── the per-session harness-event feed ───────────────────────────────────────

/// The audit actions the transcript surfaces as system lines. Everything else
/// in `audit_log` is operator forensics, not conversation: keeping the list
/// explicit here means a new destructive action can never start narrating
/// itself into someone's chat by accident.
pub const SURFACED_ACTIONS: [&str; 4] = [
    DELEGATE_ACTION,
    "session.rename",
    "schedule.create",
    "schedule.run",
];

/// The one surfaced action whose `detail.from` is a session SLUG.
///
/// `session.rename` also writes a `from` key, but it holds the previous
/// *display label* — free text the owner typed. Matching the two against the
/// same arm would put one session's rename in another session's transcript the
/// moment a label collides with a slug, so the arm is scoped to this action.
const DELEGATE_ACTION: &str = "session.delegate";

/// The two surfaced actions whose `target` column is a session NAME.
///
/// The schedule actions target a SCHEDULE ID (`SCHED-<8 hex>`), so an unscoped
/// `target = ?` arm made a session literally named after a schedule id the
/// subject of that schedule's events — two namespaces sharing one column, which
/// is one session reading another's transcript for the price of a name (B4
/// T2.5). Scoping the arm to the actions whose target IS a session closes it by
/// construction; the schedule rows still reach their feed through
/// `detail.session`, which is the arm they were always meant to use.
const TARGET_IS_A_SESSION: [&str; 2] = [DELEGATE_ACTION, "session.rename"];

/// The feed's one SQL statement, with the action list built from
/// [`SURFACED_ACTIONS`] so the filter and the const can never drift. No user
/// input is interpolated — the values are compile-time literals.
static EVENTS_SQL: Lazy<String> = Lazy::new(|| {
    let quoted = |list: &[&str]| {
        list.iter()
            .map(|a| format!("'{a}'"))
            .collect::<Vec<_>>()
            .join(",")
    };
    let actions = quoted(&SURFACED_ACTIONS);
    let target_actions = quoted(&TARGET_IS_A_SESSION);
    format!(
        "SELECT id, ts, actor, action, target, detail FROM audit_log \
         WHERE id > ? \
           AND action IN ({actions}) \
           AND ( (action IN ({target_actions}) AND target = ?) \
              OR (action = '{DELEGATE_ACTION}' AND json_extract(detail,'$.from') = ?) \
              OR json_extract(detail,'$.session') = ? \
              OR actor = 'agent:' || ? ) \
         ORDER BY id ASC LIMIT ?"
    )
});

/// Audit rows where `session` is the *subject*, ascending by id, for
/// `GET /api/sessions/{name}/events`.
///
/// A session is the subject through four columns, because the ledger was never
/// designed as a per-session feed:
/// - `target = ?` **on a session-targeting action** — a delegation landed on
///   it, or it was renamed. Scoped by [`TARGET_IS_A_SESSION`], because the
///   schedule actions put a schedule id in the same column;
/// - `json_extract(detail,'$.from') = ?` on a `session.delegate` row — it
///   delegated OUT (the row's target is the *recipient*). Scoped to that action
///   on purpose: `session.rename`'s `from` is a display label, not a slug;
/// - `json_extract(detail,'$.session') = ?` — schedule rows target the SCHEDULE
///   id, so only the detail ties a fire to the session it fires into;
/// - `actor = 'agent:' || ?` — it acted as an agent.
///
/// `since_id` is EXCLUSIVE (pass `0` for "from the beginning"), so a client can
/// poll with the last id it holds. `limit` is clamped by the caller.
pub async fn events_for_session(
    pool: &SqlitePool,
    session: &str,
    since_id: i64,
    limit: i64,
) -> sqlx::Result<Vec<AuditEntry>> {
    sqlx::query_as::<_, AuditEntry>(EVENTS_SQL.as_str())
        .bind(since_id)
        .bind(session)
        .bind(session)
        .bind(session)
        .bind(session)
        .bind(limit)
        .fetch_all(pool)
        .await
}

// ── delegations (migration 0005) ─────────────────────────────────────────────

/// Record a cross-session delegation edge (`from` sent `prompt` to `to`).
/// Returns the new row id. `from`/`to` are FK-checked against `sessions(name)`.
pub async fn record_delegation(
    pool: &SqlitePool,
    from_session: &str,
    to_session: &str,
    prompt: &str,
) -> sqlx::Result<i64> {
    let ts = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO delegations (from_session, to_session, prompt, ts) VALUES (?, ?, ?, ?)",
    )
    .bind(from_session)
    .bind(to_session)
    .bind(prompt)
    .bind(ts)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Edges OUT of `session` (it delegated to others), newest first. Backed by
/// `idx_delegations_from`.
pub async fn delegations_out(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<Delegation>> {
    sqlx::query_as::<_, Delegation>(
        "SELECT id, from_session, to_session, prompt, ts FROM delegations \
         WHERE from_session = ? ORDER BY ts DESC, id DESC",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

/// Edges INTO `session` (others delegated to it), newest first. Backed by
/// `idx_delegations_to`.
pub async fn delegations_in(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<Delegation>> {
    sqlx::query_as::<_, Delegation>(
        "SELECT id, from_session, to_session, prompt, ts FROM delegations \
         WHERE to_session = ? ORDER BY ts DESC, id DESC",
    )
    .bind(session)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::SqlitePool;

    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-audit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn events_for_session_sees_all_subject_arms_and_only_surfaced_actions() {
        let (pool, _dir) = test_pool().await;
        log(&pool, "user", "session.delegate", "deploy-fix", json!({"from":"web-ui"}))
            .await
            .unwrap();
        log(&pool, "user", "session.rename", "web-ui", json!({"from":"a","to":"b"}))
            .await
            .unwrap();
        // schedule rows target the SCHEDULE id — only detail.session ties them to the session:
        log(
            &pool,
            "system",
            "schedule.run",
            "sched-1",
            json!({"session":"web-ui","title":"Nightly","status":"ok"}),
        )
        .await
        .unwrap();
        log(&pool, "user", "session.delete", "web-ui", json!({}))
            .await
            .unwrap(); // not surfaced
        let out = events_for_session(&pool, "web-ui", 0, 50).await.unwrap();
        assert_eq!(out.len(), 3); // outbound delegate (detail.from) + rename (target) + schedule fire (detail.session)
        let inbound = events_for_session(&pool, "deploy-fix", 0, 50).await.unwrap();
        assert_eq!(inbound.len(), 1);
        // since_id is exclusive and ascending:
        let after = events_for_session(&pool, "web-ui", out[0].id, 50)
            .await
            .unwrap();
        assert_eq!(after.len(), 2);
    }

    #[tokio::test]
    async fn a_rename_never_leaks_into_the_feed_of_the_session_that_owns_the_old_label() {
        let (pool, _dir) = test_pool().await;
        // `detail.from` means two different things: a session SLUG on
        // `session.delegate` (who delegated out) and a free-text DISPLAY LABEL
        // on `session.rename` (what the label used to be). Renaming a session
        // whose old label happens to be another session's slug must not put
        // that rename in the other session's transcript — the feed would be
        // attributing someone else's event to it.
        log(
            &pool,
            "user",
            "session.rename",
            "alpha",
            json!({"from":"web-ui","to":"Alpha"}),
        )
        .await
        .unwrap();
        let leaked = events_for_session(&pool, "web-ui", 0, 50).await.unwrap();
        assert!(leaked.is_empty(), "web-ui was never renamed, got {leaked:?}");
        // …and the session that WAS renamed still sees it (via `target`).
        let own = events_for_session(&pool, "alpha", 0, 50).await.unwrap();
        assert_eq!(own.len(), 1);
    }
}
