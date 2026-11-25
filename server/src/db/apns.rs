//! Native iOS push (APNs) device rows (migration 0049).
//!
//! Backs `/api/push/apns*` and the APNs half of the push fan-out
//! ([`crate::apns`]). `device_token` is a capability to push to a phone:
//! callers MUST NOT log it, and the API never returns it.

use sqlx::SqlitePool;

/// A stored APNs device.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ApnsDevice {
    pub id: i64,
    pub device_token: String,
    pub environment: String,
    pub bundle_id: String,
    pub device_name: String,
    pub app_version: Option<String>,
    pub client_ref: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

/// What `POST /api/push/apns/register` stores (already validated).
#[derive(Debug, Clone)]
pub struct NewDevice<'a> {
    pub device_token: &'a str,
    pub environment: &'a str,
    pub bundle_id: &'a str,
    pub device_name: &'a str,
    pub app_version: Option<&'a str>,
    pub client_ref: &'a str,
}

const COLS: &str = "id, device_token, environment, bundle_id, device_name, app_version, \
                    client_ref, created_at, last_seen_at";

/// Insert or refresh a device, keyed by `device_token`. A re-register keeps the
/// row's `id` and `created_at` and refreshes everything else (the app may move
/// between sandbox and production, or rename the phone). Returns the row id.
pub async fn upsert(pool: &SqlitePool, d: &NewDevice<'_>, now_ms: i64) -> sqlx::Result<i64> {
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO apns_devices
             (device_token, environment, bundle_id, device_name, app_version, client_ref,
              created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_token) DO UPDATE SET
             environment  = excluded.environment,
             bundle_id    = excluded.bundle_id,
             device_name  = excluded.device_name,
             app_version  = excluded.app_version,
             client_ref   = excluded.client_ref,
             last_seen_at = excluded.last_seen_at
         RETURNING id",
    )
    .bind(d.device_token)
    .bind(d.environment)
    .bind(d.bundle_id)
    .bind(d.device_name)
    .bind(d.app_version)
    .bind(d.client_ref)
    .bind(now_ms)
    .bind(now_ms)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// Remove a device by token (the app's unregister, and the sender's prune of a
/// token APNs reports as gone). Returns rows removed.
pub async fn delete(pool: &SqlitePool, device_token: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM apns_devices WHERE device_token = ?")
        .bind(device_token)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Every stored device, oldest first — the fan-out target set and the
/// `GET /api/push/apns` list.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<ApnsDevice>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM apns_devices ORDER BY id"))
        .fetch_all(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-apns-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            swarm_reaper: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            company_isolation: Vec::new(),
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    fn dev<'a>(token: &'a str, env: &'a str, name: &'a str) -> NewDevice<'a> {
        NewDevice {
            device_token: token,
            environment: env,
            bundle_id: "com.supermux.app",
            device_name: name,
            app_version: Some("1.0"),
            client_ref: "srv-a",
        }
    }

    #[tokio::test]
    async fn upsert_keeps_the_id_and_refreshes_the_rest() {
        let (pool, dir) = test_pool().await;
        let id = upsert(&pool, &dev("aa", "sandbox", "old"), 1).await.unwrap();
        let again = upsert(&pool, &dev("aa", "production", "new"), 2).await.unwrap();
        assert_eq!(id, again, "re-register of the same token keeps its id");
        let rows = list(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].environment, "production");
        assert_eq!(rows[0].device_name, "new");
        assert_eq!(rows[0].created_at, 1);
        assert_eq!(rows[0].last_seen_at, 2);

        let other = upsert(&pool, &dev("bb", "sandbox", "x"), 3).await.unwrap();
        assert_ne!(other, id);
        assert_eq!(delete(&pool, "aa").await.unwrap(), 1);
        assert_eq!(delete(&pool, "aa").await.unwrap(), 0);
        assert_eq!(list(&pool).await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
