//! Dismissed-teammate row access (migration 0022 `dismissed_teammates`).
//!
//! A teammate that finished or was killed lingers forever as an offline chip
//! because Claude Code leaves it in `~/.claude/teams/<team>/config.json` until
//! the whole lead session ends, and supermux only READS that file (the invariant
//! in [`crate::teams::model`]). So "remove a teammate" is a supermux-side HIDE,
//! not an edit of Claude's config: a `(team_name, agent_id)` row here, filtered
//! out by the teams watcher on every tick.
//!
//! `agent_id` (`"{name}@{team}"`, see [`crate::teams::model`]) is the stable
//! member identity. Rows are pruned via [`prune_team`] when a team is
//! deregistered or archived so the table stays bounded to live teams.
//!
//! **Known, chosen limitation: no auto re-arm.** A dismissal is sticky for the
//! life of the team. The only case it wrongly hides is Claude re-spawning a NEW
//! teammate with the exact same `name@team` id (uncommon; spawn names are
//! unique). Not handled in v1; a future "show dismissed" escape hatch can re-arm.
//! This is a documented limitation, not a silent bug.
//!
//! Runtime-checked queries; see the note in [`super::sessions`].

use sqlx::SqlitePool;

/// Hide a teammate from supermux's team view. Idempotent: a second dismiss of
/// the same `(team_name, agent_id)` is a clean no-op (INSERT OR IGNORE keeps the
/// original `dismissed_at`). `now` is the caller's timestamp (seconds).
pub async fn dismiss(
    pool: &SqlitePool,
    team_name: &str,
    agent_id: &str,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO dismissed_teammates (team_name, agent_id, dismissed_at)
         VALUES (?, ?, ?)",
    )
    .bind(team_name)
    .bind(agent_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// The dismissed `agent_id`s for one team (empty when none). The watcher loads
/// this once per team per tick and drops any member whose id is in the set.
pub async fn list_for_team(pool: &SqlitePool, team_name: &str) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT agent_id FROM dismissed_teammates WHERE team_name = ?")
            .bind(team_name)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Drop ALL dismissals for a team (called when the team is deregistered or its
/// config archived so the table doesn't accumulate rows for dead teams). Returns
/// the number of rows removed.
pub async fn prune_team(pool: &SqlitePool, team_name: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM dismissed_teammates WHERE team_name = ?")
        .bind(team_name)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("supermux-dismissed-test-{}", uuid::Uuid::new_v4()));
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

    /// Round-trip: dismiss is idempotent, `list_for_team` is scoped to its team,
    /// and `prune_team` clears exactly that team's rows.
    #[tokio::test]
    async fn dismiss_list_prune_round_trip() {
        let (pool, dir) = test_pool().await;

        // Empty to start.
        assert!(list_for_team(&pool, "alpha").await.unwrap().is_empty());

        dismiss(&pool, "alpha", "fix-644@alpha", 100).await.unwrap();
        dismiss(&pool, "alpha", "docs@alpha", 101).await.unwrap();
        // A second dismiss of the same key is a clean no-op (idempotent).
        dismiss(&pool, "alpha", "fix-644@alpha", 999).await.unwrap();

        let mut alpha = list_for_team(&pool, "alpha").await.unwrap();
        alpha.sort();
        assert_eq!(alpha, vec!["docs@alpha", "fix-644@alpha"]);

        // Scoped: a dismissal in another team does not leak into alpha.
        dismiss(&pool, "beta", "fix-644@beta", 200).await.unwrap();
        assert_eq!(list_for_team(&pool, "alpha").await.unwrap().len(), 2);
        assert_eq!(
            list_for_team(&pool, "beta").await.unwrap(),
            vec!["fix-644@beta"]
        );

        // Prune clears only that team.
        let removed = prune_team(&pool, "alpha").await.unwrap();
        assert_eq!(removed, 2, "prune returns the row count it deleted");
        assert!(list_for_team(&pool, "alpha").await.unwrap().is_empty());
        assert_eq!(
            list_for_team(&pool, "beta").await.unwrap(),
            vec!["fix-644@beta"],
            "prune is scoped, beta survives",
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
