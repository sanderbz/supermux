//! Issue-ID generation (feature-extract §2.3, TECH_PLAN M6 prompt).
//!
//! The id is `<PREFIX>-<N>` where `PREFIX` derives from the assignee session
//! name and `N` comes from an atomic per-prefix counter.

use sqlx::SqlitePool;

/// Derive the id prefix from a session name (feature-extract §2.3):
///
/// * no session → `SUPERMUX`
/// * single word (no separators) → first 5 uppercase alphanumeric chars
/// * multi-word → first letter of each word, uppercased, capped at 5
///
/// Separators are any non-alphanumeric run (`-`, `_`, `.`, space, …). A name
/// with no usable alphanumerics also falls back to `SUPERMUX`.
pub fn prefix_from_session(session: Option<&str>) -> String {
    let name = match session {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => return "SUPERMUX".to_string(),
    };

    let words: Vec<&str> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();

    let prefix = match words.as_slice() {
        [] => String::new(),
        [single] => single
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(5)
            .collect::<String>()
            .to_uppercase(),
        many => many
            .iter()
            .filter_map(|w| w.chars().next())
            .take(5)
            .collect::<String>()
            .to_uppercase(),
    };

    if prefix.is_empty() {
        "SUPERMUX".to_string()
    } else {
        prefix
    }
}

/// Allocate the next sequential id for `prefix`, atomically.
///
/// Per the M6 prompt: `INSERT OR IGNORE` seeds `next_n = 1` for a brand-new
/// prefix, then a single `UPDATE ... RETURNING` increments and returns the
/// number to assign. Wrapped in a transaction so two concurrent creates with the
/// same prefix never collide on the counter.
pub async fn next_id(pool: &SqlitePool, prefix: &str) -> sqlx::Result<String> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT OR IGNORE INTO issue_counters (prefix, next_n) VALUES (?, 1)")
        .bind(prefix)
        .execute(&mut *tx)
        .await?;
    // `next_n` is the next number to assign; bump it and return the value we just
    // consumed (`next_n - 1` post-increment), so the first id is `<PREFIX>-1`.
    let assigned: i64 = sqlx::query_scalar(
        "UPDATE issue_counters SET next_n = next_n + 1 WHERE prefix = ? RETURNING next_n - 1",
    )
    .bind(prefix)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(format!("{prefix}-{assigned}"))
}

#[cfg(test)]
mod tests {
    use super::prefix_from_session;

    #[test]
    fn no_session_is_supermux() {
        assert_eq!(prefix_from_session(None), "SUPERMUX");
        assert_eq!(prefix_from_session(Some("   ")), "SUPERMUX");
    }

    #[test]
    fn single_word_takes_first_five() {
        assert_eq!(prefix_from_session(Some("frontend")), "FRONT");
        assert_eq!(prefix_from_session(Some("api")), "API");
    }

    #[test]
    fn multi_word_takes_initials_capped_at_five() {
        assert_eq!(prefix_from_session(Some("my-cool-thing")), "MCT");
        assert_eq!(prefix_from_session(Some("web-app")), "WA");
        assert_eq!(prefix_from_session(Some("a_b_c_d_e_f_g")), "ABCDE");
    }

    #[test]
    fn mixed_separators_and_case() {
        assert_eq!(prefix_from_session(Some("foo.bar baz")), "FBB");
        assert_eq!(prefix_from_session(Some("WebApp")), "WEBAP");
    }
}
