//! Web push subscription row access (PUSH milestone).
//!
//! Backs the `/api/push/*` endpoints and the server-side `send_push` fan-out
//! (see [`crate::push`]). One row per subscribed device, keyed by the browser-
//! issued push `endpoint`. The stored `p256dh` / `auth` keys are USER DATA (a
//! capability to push to that device) — callers MUST NOT log them.
//!
//! Per-category notification preferences (which kinds of events the user wants
//! to be pinged about) live in the existing `prefs` k/v table under
//! [`PREF_KEYS`]; see [`get_pref_on`] and [`set_pref`].

use serde::{Deserialize, Serialize};
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

// ── per-category notification prefs (reuses the existing prefs k/v table) ────

/// The four user-facing notification categories. Each is a discrete event the
/// user can mute independently (Settings → Notifications). Keep this list short
/// — every new variant is a new toggle the user has to think about, and the
/// "didn't I get a ping for X?" diagnostic surface (the attempts ring) gets
/// noisier the more types we add.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifCategory {
    /// Agent transitioned to Waiting OR posted a board needs-input — the user
    /// is being asked a question. The original PUSH-milestone trigger.
    AgentWaiting,
    /// Agent went from Active/Waiting → Idle (turn finished, ready for
    /// review). The "groene status" the user explicitly asked for.
    AgentFinished,
    /// Session ended unexpectedly (tmux pane gone). Low-frequency, high-signal.
    AgentStopped,
    /// A scheduled run produced `status == "error"`. Success runs intentionally
    /// do NOT push (would be noisy for periodic schedules).
    ScheduleError,
}

impl NotifCategory {
    /// The wire-format identifier (matches the JSON enum tag — used as both the
    /// API field name AND the prefs key suffix, so the storage and the API
    /// can never drift out of sync).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AgentWaiting => "agent_waiting",
            Self::AgentFinished => "agent_finished",
            Self::AgentStopped => "agent_stopped",
            Self::ScheduleError => "schedule_error",
        }
    }

    /// The set of categories, iterated in display order (matches the Settings
    /// UI order).
    pub const ALL: [NotifCategory; 4] = [
        Self::AgentWaiting,
        Self::AgentFinished,
        Self::AgentStopped,
        Self::ScheduleError,
    ];

    /// Parse a wire-format identifier (the JSON enum tag) — `None` is an
    /// unknown category, which the caller turns into a 400.
    pub fn from_str(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|c| c.as_str() == s)
    }

    /// The prefs k/v table key for this category.
    fn prefs_key(self) -> String {
        format!("notif.{}", self.as_str())
    }
}

/// Read the on/off state for one category. Defaults to ON (the user just
/// enabled push — they want pings) when the prefs row is absent. A DB error is
/// treated as ON: notifications are NOT a cost-control gate (cf. agent-teams),
/// so the safe fallback is to keep delivering rather than to silently mute the
/// user. The user can always toggle off in Settings if a category is too noisy.
pub async fn pref_enabled(pool: &SqlitePool, cat: NotifCategory) -> bool {
    match super::prefs::get_pref(pool, &cat.prefs_key()).await {
        // `"off"` (any case) → muted; everything else (including absent /
        // `"on"` / a junk value from a manual sqlite edit) → enabled.
        Ok(Some(v)) => !v.trim().eq_ignore_ascii_case("off"),
        _ => true,
    }
}

/// Set the on/off state for one category. Stored as the literal string
/// `"on"`/`"off"` in the prefs k/v table.
pub async fn set_pref(
    pool: &SqlitePool,
    cat: NotifCategory,
    on: bool,
) -> sqlx::Result<()> {
    super::prefs::put_pref(pool, &cat.prefs_key(), if on { "on" } else { "off" }).await
}

/// Snapshot every category's on/off state in one call. The Settings UI fetches
/// this on mount to render every toggle's initial position.
pub async fn list_prefs(pool: &SqlitePool) -> Vec<(NotifCategory, bool)> {
    let mut out = Vec::with_capacity(NotifCategory::ALL.len());
    for cat in NotifCategory::ALL {
        out.push((cat, pref_enabled(pool, cat).await));
    }
    out
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
            push_sub: None,
            github_token: None,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn pref_defaults_on_and_round_trips() {
        // The notification prefs MUST default ON — the user just enabled push,
        // they want pings. They also MUST round-trip cleanly through the prefs
        // k/v table. And the "fail open" rule: a junk value reads as ON (the
        // notifications gate is NOT a cost-control gate; the safe default is
        // to keep delivering rather than silently mute the user).
        let (pool, dir) = test_pool().await;

        // 1. Absent row → ON for every category.
        for cat in NotifCategory::ALL {
            assert!(
                pref_enabled(&pool, cat).await,
                "category {} must default ON when absent",
                cat.as_str()
            );
        }

        // 2. Round-trip OFF then ON for each category — independent rows.
        for cat in NotifCategory::ALL {
            set_pref(&pool, cat, false).await.unwrap();
            assert!(!pref_enabled(&pool, cat).await, "{} OFF after set", cat.as_str());
            set_pref(&pool, cat, true).await.unwrap();
            assert!(pref_enabled(&pool, cat).await, "{} ON after set", cat.as_str());
        }

        // 3. Categories are independent — flipping one MUST NOT flip another.
        set_pref(&pool, NotifCategory::AgentWaiting, false).await.unwrap();
        assert!(!pref_enabled(&pool, NotifCategory::AgentWaiting).await);
        assert!(pref_enabled(&pool, NotifCategory::AgentFinished).await);

        // 4. Fail OPEN on garbage — a manual sqlite edit putting "maybe" in
        //    the row reads as ON, never silently mutes the user.
        crate::db::prefs::put_pref(&pool, "notif.agent_finished", "maybe")
            .await
            .unwrap();
        assert!(
            pref_enabled(&pool, NotifCategory::AgentFinished).await,
            "junk pref value MUST read as ON (fail-open for notifications)",
        );

        // 5. list_prefs returns every category exactly once.
        let snapshot = list_prefs(&pool).await;
        assert_eq!(snapshot.len(), NotifCategory::ALL.len());

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn category_string_round_trips() {
        // Wire-format identifiers must survive the round trip — a typo here
        // would silently disconnect the API JSON from the prefs storage key.
        for cat in NotifCategory::ALL {
            assert_eq!(NotifCategory::from_str(cat.as_str()), Some(cat));
        }
        assert_eq!(NotifCategory::from_str("not_a_category"), None);
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
