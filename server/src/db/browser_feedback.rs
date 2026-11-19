//! Durable browser-feedback capabilities and outbox. Tokens are SHA-256 only.
use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Pairing {
    pub id: String,
    pub token_hash: String,
    pub origin: String,
    pub expires_at: i64,
    pub binding_id: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Binding {
    pub id: String,
    pub origin: String,
    pub session: String,
    pub token_hash: String,
    pub revoked_at: Option<i64>,
    pub company_id: Option<i64>,
    pub paired_by_user_id: Option<i64>,
    pub paired_by_company_id: Option<i64>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Feedback {
    pub id: String,
    pub binding_id: String,
    pub client_id: String,
    pub status: String,
    pub reason: Option<String>,
    #[serde(skip)]
    pub artifact_dir: String,
    #[serde(skip)]
    pub prompt: String,
}

/// Atomic rolling-minute limit; shared across requests and server restarts.
pub async fn admit(
    tx: &mut Transaction<'_, Sqlite>,
    key: &str,
    max: i64,
    now: i64,
) -> sqlx::Result<bool> {
    let window = now / 60;
    sqlx::query("INSERT INTO browser_feedback_limits(key,window,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END,window=excluded.window")
        .bind(key).bind(window).execute(&mut **tx).await?;
    let n: i64 = sqlx::query_scalar("SELECT attempts FROM browser_feedback_limits WHERE key=?")
        .bind(key)
        .fetch_one(&mut **tx)
        .await?;
    Ok(n <= max)
}

pub async fn pairing(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Pairing>> {
    sqlx::query_as("SELECT id,token_hash,origin,expires_at,binding_id FROM browser_feedback_pairings WHERE id=?").bind(id).fetch_optional(pool).await
}
pub async fn binding(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Binding>> {
    sqlx::query_as(
        "SELECT id,origin,session,token_hash,revoked_at,company_id,paired_by_user_id,paired_by_company_id FROM browser_feedback_bindings WHERE id=?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}
pub async fn binding_for_token(pool: &SqlitePool, hash: &str) -> sqlx::Result<Option<Binding>> {
    sqlx::query_as("SELECT id,origin,session,token_hash,revoked_at,company_id,paired_by_user_id,paired_by_company_id FROM browser_feedback_bindings WHERE token_hash=? AND revoked_at IS NULL").bind(hash).fetch_optional(pool).await
}
pub async fn bindings(pool: &SqlitePool, session: &str) -> sqlx::Result<Vec<Binding>> {
    sqlx::query_as("SELECT id,origin,session,token_hash,revoked_at,company_id,paired_by_user_id,paired_by_company_id FROM browser_feedback_bindings WHERE session=? AND revoked_at IS NULL ORDER BY created_at DESC").bind(session).fetch_all(pool).await
}
pub async fn by_client(
    pool: &SqlitePool,
    binding: &str,
    client: &str,
) -> sqlx::Result<Option<Feedback>> {
    sqlx::query_as("SELECT id,binding_id,client_id,status,reason,artifact_dir,prompt FROM browser_feedback WHERE binding_id=? AND client_id=?").bind(binding).bind(client).fetch_optional(pool).await
}
pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Feedback>> {
    sqlx::query_as("SELECT id,binding_id,client_id,status,reason,artifact_dir,prompt FROM browser_feedback WHERE id=?").bind(id).fetch_optional(pool).await
}
pub async fn queued(pool: &SqlitePool) -> sqlx::Result<Vec<Feedback>> {
    sqlx::query_as("SELECT f.id,f.binding_id,f.client_id,f.status,f.reason,f.artifact_dir,f.prompt FROM browser_feedback f JOIN browser_feedback_bindings b ON b.id=f.binding_id WHERE f.status='queued' AND b.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM browser_feedback earlier JOIN browser_feedback_bindings eb ON eb.id=earlier.binding_id WHERE eb.session=b.session AND eb.revoked_at IS NULL AND earlier.status IN ('queued','sending') AND earlier.rowid<f.rowid) ORDER BY f.updated_at,f.rowid LIMIT 20").fetch_all(pool).await
}
pub async fn transition(
    pool: &SqlitePool,
    id: &str,
    from: &str,
    to: &str,
    reason: Option<&str>,
) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE browser_feedback SET status=?,reason=?,updated_at=? WHERE id=? AND status=?",
    )
    .bind(to)
    .bind(reason)
    .bind(chrono::Utc::now().timestamp())
    .bind(id)
    .bind(from)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n == 1)
}
pub async fn recover(pool: &SqlitePool) -> sqlx::Result<u64> {
    fail_inflight(
        pool,
        "Server restarted during delivery. Check the terminal before resending.",
    )
    .await
}
pub async fn fail_inflight(pool: &SqlitePool, reason: &str) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE browser_feedback SET status='failed',reason=?,updated_at=? WHERE status='sending'",
    )
    .bind(reason)
    .bind(chrono::Utc::now().timestamp())
    .execute(pool)
    .await?
    .rows_affected())
}
