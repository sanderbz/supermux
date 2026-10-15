//! `asks` table — the durable "an agent is waiting on a human" records.
//!
//! Every write takes the next value of the global `ask_rev` counter inside the
//! same transaction, so `rev` is a total order over all changes and a client can
//! resume from the highest rev it has seen (`list` with `since`).

use sqlx::{Sqlite, SqlitePool, Transaction};

/// One `asks` row, verbatim.
#[derive(Debug, Clone, sqlx::FromRow, PartialEq)]
pub struct AskRow {
    pub id: String,
    pub session: String,
    pub kind: String,
    pub state: String,
    pub match_key: String,
    pub detail: String,
    pub resolution: Option<String>,
    pub hook_attached: i64,
    pub issue_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub resolved_at: Option<i64>,
    pub rev: i64,
}

const COLS: &str = "id, session, kind, state, match_key, detail, resolution, hook_attached, \
                    issue_id, created_at, updated_at, resolved_at, rev";

/// Take the next rev inside `tx`.
async fn next_rev(tx: &mut Transaction<'_, Sqlite>) -> sqlx::Result<i64> {
    sqlx::query_scalar("UPDATE ask_rev SET n = n + 1 WHERE id = 1 RETURNING n")
        .fetch_one(&mut **tx)
        .await
}

/// The highest rev handed out so far (0 on a fresh install).
pub async fn current_rev(pool: &SqlitePool) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT n FROM ask_rev WHERE id = 1")
        .fetch_one(pool)
        .await
}

/// Fields of a brand-new ask.
pub struct NewAsk<'a> {
    pub id: &'a str,
    pub session: &'a str,
    pub kind: &'a str,
    pub match_key: &'a str,
    pub detail: &'a str,
    pub issue_id: Option<&'a str>,
    pub now: i64,
}

pub async fn insert(pool: &SqlitePool, a: &NewAsk<'_>) -> sqlx::Result<AskRow> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    sqlx::query(
        "INSERT INTO asks (id, session, kind, state, match_key, detail, issue_id, \
                           created_at, updated_at, rev) \
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)",
    )
    .bind(a.id)
    .bind(a.session)
    .bind(a.kind)
    .bind(a.match_key)
    .bind(a.detail)
    .bind(a.issue_id)
    .bind(a.now)
    .bind(a.now)
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    let row = get_tx(&mut tx, a.id).await?.expect("row just inserted");
    tx.commit().await?;
    Ok(row)
}

async fn get_tx(tx: &mut Transaction<'_, Sqlite>, id: &str) -> sqlx::Result<Option<AskRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM asks WHERE id = ?"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
}

pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<AskRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM asks WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// The open asks of one session (optionally of one kind), oldest first.
pub async fn open_for_session(
    pool: &SqlitePool,
    session: &str,
    kind: Option<&str>,
) -> sqlx::Result<Vec<AskRow>> {
    match kind {
        Some(k) => {
            sqlx::query_as(&format!(
                "SELECT {COLS} FROM asks WHERE session = ? AND kind = ? AND state = 'open' \
                 ORDER BY created_at, rev"
            ))
            .bind(session)
            .bind(k)
            .fetch_all(pool)
            .await
        }
        None => {
            sqlx::query_as(&format!(
                "SELECT {COLS} FROM asks WHERE session = ? AND state = 'open' \
                 ORDER BY created_at, rev"
            ))
            .bind(session)
            .fetch_all(pool)
            .await
        }
    }
}

/// The open ask of `issue_id` (a board needs-input), if any.
pub async fn open_for_issue(pool: &SqlitePool, issue_id: &str) -> sqlx::Result<Vec<AskRow>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM asks WHERE issue_id = ? AND kind = 'needs_input' AND state = 'open' \
         ORDER BY created_at, rev"
    ))
    .bind(issue_id)
    .fetch_all(pool)
    .await
}

/// Replace an open ask's detail (a re-raised dialog whose content changed).
/// `None` when the row is gone or no longer open.
pub async fn update_detail(
    pool: &SqlitePool,
    id: &str,
    detail: &str,
    now: i64,
) -> sqlx::Result<Option<AskRow>> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let n = sqlx::query(
        "UPDATE asks SET detail = ?, updated_at = ?, rev = ? WHERE id = ? AND state = 'open'",
    )
    .bind(detail)
    .bind(now)
    .bind(rev)
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        tx.rollback().await?;
        return Ok(None);
    }
    let row = get_tx(&mut tx, id).await?;
    tx.commit().await?;
    Ok(row)
}

/// Flip `hook_attached` on an open ask. `None` when nothing changed (already at
/// that value, gone, or closed) — so the caller emits an SSE frame only on a
/// real change.
pub async fn set_hook_attached(
    pool: &SqlitePool,
    id: &str,
    attached: bool,
    now: i64,
) -> sqlx::Result<Option<AskRow>> {
    let v = i64::from(attached);
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let n = sqlx::query(
        "UPDATE asks SET hook_attached = ?, updated_at = ?, rev = ? \
         WHERE id = ? AND state = 'open' AND hook_attached != ?",
    )
    .bind(v)
    .bind(now)
    .bind(rev)
    .bind(id)
    .bind(v)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        tx.rollback().await?;
        return Ok(None);
    }
    let row = get_tx(&mut tx, id).await?;
    tx.commit().await?;
    Ok(row)
}

/// Close an OPEN ask: `state` is `answered` / `dismissed` / `resolved`.
/// `None` when it was not open any more (someone else closed it first).
pub async fn close(
    pool: &SqlitePool,
    id: &str,
    state: &str,
    resolution: &str,
    now: i64,
) -> sqlx::Result<Option<AskRow>> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let n = sqlx::query(
        "UPDATE asks SET state = ?, resolution = ?, hook_attached = 0, updated_at = ?, \
                         resolved_at = ?, rev = ? \
         WHERE id = ? AND state = 'open'",
    )
    .bind(state)
    .bind(resolution)
    .bind(now)
    .bind(now)
    .bind(rev)
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        tx.rollback().await?;
        return Ok(None);
    }
    let row = get_tx(&mut tx, id).await?;
    tx.commit().await?;
    Ok(row)
}

/// Put an `answered` ask back to `open` — the answer could not be delivered
/// (e.g. typing the reply into a session failed), so it is still owed.
pub async fn reopen(pool: &SqlitePool, id: &str, now: i64) -> sqlx::Result<Option<AskRow>> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let n = sqlx::query(
        "UPDATE asks SET state = 'open', resolution = NULL, resolved_at = NULL, \
                         updated_at = ?, rev = ? \
         WHERE id = ? AND state = 'answered'",
    )
    .bind(now)
    .bind(rev)
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        tx.rollback().await?;
        return Ok(None);
    }
    let row = get_tx(&mut tx, id).await?;
    tx.commit().await?;
    Ok(row)
}

/// List filter. Every field optional.
#[derive(Debug, Default, Clone)]
pub struct Filter {
    /// `open` / `answered` / `dismissed` / `resolved`; `None` = every state.
    pub state: Option<String>,
    pub session: Option<String>,
    pub kind: Option<String>,
    /// Only rows changed after this rev; the result is then ordered by rev.
    pub since: Option<i64>,
    pub limit: i64,
}

pub async fn list(pool: &SqlitePool, f: &Filter) -> sqlx::Result<Vec<AskRow>> {
    let mut sql = format!("SELECT {COLS} FROM asks WHERE 1 = 1");
    if f.state.is_some() {
        sql.push_str(" AND state = ?");
    }
    if f.session.is_some() {
        sql.push_str(" AND session = ?");
    }
    if f.kind.is_some() {
        sql.push_str(" AND kind = ?");
    }
    if f.since.is_some() {
        sql.push_str(" AND rev > ? ORDER BY rev ASC");
    } else {
        sql.push_str(" ORDER BY created_at DESC, rev DESC");
    }
    sql.push_str(" LIMIT ?");
    let mut q = sqlx::query_as::<_, AskRow>(&sql);
    if let Some(s) = &f.state {
        q = q.bind(s);
    }
    if let Some(s) = &f.session {
        q = q.bind(s);
    }
    if let Some(k) = &f.kind {
        q = q.bind(k);
    }
    if let Some(r) = f.since {
        q = q.bind(r);
    }
    q.bind(f.limit).fetch_all(pool).await
}

/// Boot: no decision hook survives a restart in this process's memory, so no
/// ask can claim one. A reconnecting hook re-attaches within seconds.
pub async fn detach_all(pool: &SqlitePool, now: i64) -> sqlx::Result<u64> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM asks WHERE hook_attached != 0")
        .fetch_all(pool)
        .await?;
    let mut n = 0;
    for id in ids {
        if set_hook_attached(pool, &id, false, now).await?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

/// Retention: drop CLOSED asks resolved before `cutoff` (epoch ms). Open asks
/// are never pruned.
pub async fn prune_closed_before(pool: &SqlitePool, cutoff: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM asks WHERE state != 'open' AND resolved_at IS NOT NULL AND resolved_at < ?",
    )
    .bind(cutoff)
    .execute(pool)
    .await?
    .rows_affected())
}
