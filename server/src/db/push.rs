//! Web push subscription row access (PUSH milestone).
//!
//! Backs the `/api/push/*` endpoints and the server-side `send_push` fan-out
//! (see [`crate::push`]). One row per subscribed device, keyed by the browser-
//! issued push `endpoint`. The stored `p256dh` / `auth` keys are USER DATA (a
//! capability to push to that device) — callers MUST NOT log them.

use sqlx::SqlitePool;

/// A stored browser `PushSubscription` (one per device).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// Upsert a subscription, keyed by `endpoint`. Re-subscribing the same device
/// (e.g. after a key rotation) overwrites the prior keys rather than erroring.
pub async fn upsert(
    pool: &SqlitePool,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth",
    )
    .bind(endpoint)
    .bind(p256dh)
    .bind(auth)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove a subscription by endpoint (the Settings toggle's disable path, and
/// the `send_push` prune of a 404/410-Gone endpoint). Returns rows removed.
pub async fn delete(pool: &SqlitePool, endpoint: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?")
        .bind(endpoint)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Every stored subscription — the `send_push` fan-out target set.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<PushSubscription>> {
    sqlx::query_as::<_, PushSubscription>(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions",
    )
    .fetch_all(pool)
    .await
}

/// How many subscriptions are stored (drives the Settings "enabled" state and
/// lets the trigger skip all work when nobody is subscribed).
pub async fn count(pool: &SqlitePool) -> sqlx::Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM push_subscriptions")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-push-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn upsert_list_delete_roundtrip() {
        let (pool, dir) = test_pool().await;
        assert_eq!(count(&pool).await.unwrap(), 0);

        upsert(&pool, "https://push.example/abc", "pk1", "auth1").await.unwrap();
        upsert(&pool, "https://push.example/def", "pk2", "auth2").await.unwrap();
        assert_eq!(count(&pool).await.unwrap(), 2);

        // Re-subscribing the same endpoint updates the keys (no duplicate row).
        upsert(&pool, "https://push.example/abc", "pk1b", "auth1b").await.unwrap();
        assert_eq!(count(&pool).await.unwrap(), 2);
        let rows = list(&pool).await.unwrap();
        let abc = rows.iter().find(|r| r.endpoint.ends_with("/abc")).unwrap();
        assert_eq!(abc.p256dh, "pk1b");
        assert_eq!(abc.auth, "auth1b");

        assert_eq!(delete(&pool, "https://push.example/abc").await.unwrap(), 1);
        assert_eq!(count(&pool).await.unwrap(), 1);
        // Deleting an unknown endpoint is a no-op (0 rows).
        assert_eq!(delete(&pool, "https://nope").await.unwrap(), 0);

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
