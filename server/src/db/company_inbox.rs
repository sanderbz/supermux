//! Which main (company-less) bots accept messages from company bots — the
//! `company_inbox` rows (migration 0047).
//!
//! A company bot reaches only its own company ([`crate::agents::delegate`]).
//! A row here is the owner's per-bot exception: "this HQ bot takes
//! `/supermux-message` from these companies". No row is the default and means
//! closed. The row says nothing about what the receiver DOES with a message —
//! it arrives wrapped as `<supermux-delegation from="…">`, and treating it as
//! information rather than an order is the receiver's own policy.

use sqlx::SqlitePool;

/// The stored `companies` value for "every company".
const ALL: &str = "*";

/// Which companies an HQ bot accepts messages from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Accepts {
    /// Every company, including ones created later.
    All,
    /// Only these company ids. Never empty — closing is deleting the row.
    Only(Vec<i64>),
}

impl Accepts {
    pub fn admits(&self, company_id: i64) -> bool {
        match self {
            Accepts::All => true,
            Accepts::Only(ids) => ids.contains(&company_id),
        }
    }

    fn encode(&self) -> String {
        match self {
            Accepts::All => ALL.to_string(),
            Accepts::Only(ids) => serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()),
        }
    }

    /// A value this module did not write (hand-edited, or a future shape) reads
    /// as an empty list: fail closed, never "everyone".
    fn decode(s: &str) -> Accepts {
        if s.trim() == ALL {
            return Accepts::All;
        }
        Accepts::Only(serde_json::from_str(s).unwrap_or_default())
    }
}

pub async fn get(pool: &SqlitePool, session: &str) -> sqlx::Result<Option<Accepts>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT companies FROM company_inbox WHERE session = ?")
            .bind(session)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(c,)| Accepts::decode(&c)))
}

pub async fn set(pool: &SqlitePool, session: &str, accepts: &Accepts) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO company_inbox (session, companies, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session) DO UPDATE SET companies = excluded.companies,
                                            updated_at = excluded.updated_at",
    )
    .bind(session)
    .bind(accepts.encode())
    .bind(chrono::Utc::now().timestamp())
    .execute(pool)
    .await?;
    Ok(())
}

/// Close the inbox. `true` when there was one to close.
pub async fn clear(pool: &SqlitePool, session: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM company_inbox WHERE session = ?")
        .bind(session)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// The main bots whose inbox admits `company_id`, sorted. Joins on the session
/// row so a bot that has since moved INTO a company — whose row is inert, the
/// gate only opens company-less targets — or is archived never shows up.
pub async fn hq_bots_admitting(pool: &SqlitePool, company_id: i64) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT i.session, i.companies FROM company_inbox i
         JOIN sessions s ON s.name = i.session
         WHERE s.company_id IS NULL AND s.archived = 0
         ORDER BY i.session",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, c)| Accepts::decode(c).admits(company_id))
        .map(|(n, _)| n)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_fails_closed_on_garbage() {
        assert_eq!(Accepts::decode(&Accepts::All.encode()), Accepts::All);
        let only = Accepts::Only(vec![3, 7]);
        assert_eq!(Accepts::decode(&only.encode()), only);
        assert!(only.admits(7) && !only.admits(4));
        assert!(Accepts::All.admits(4));
        // Anything unreadable admits nobody.
        assert!(!Accepts::decode("everyone").admits(1));
        assert!(!Accepts::decode("").admits(1));
    }
}
