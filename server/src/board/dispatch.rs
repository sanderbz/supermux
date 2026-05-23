//! Board→agent dispatch payload (TECH_PLAN board-integration §C.1; S3).
//!
//! When an agent-owned issue is claimed for (or assigned to) a session, we inject
//! the issue's full context into that session via the existing steering
//! deliver-loop (`db::steering::enqueue` → `sessions::steering::deliver_loop` →
//! `lifecycle::send_text`). The payload assembled here is a self-describing
//! message: it carries the issue title + acceptance items + description + linked
//! branch/files + recent comments, and a footer that teaches the agent how to
//! report back through the agent→board hook endpoints (AB1). No new delivery
//! machinery — we only build the text the deliver-loop will send.

use sqlx::SqlitePool;

use crate::db;
use crate::db::board::Issue;

/// How many recent comments to fold into the dispatch (keep the steer compact).
const RECENT_COMMENTS: usize = 5;

/// Build the dispatch message for `issue` assigned to `session`. Pulls the
/// acceptance checklist, recent comments, the session's branch + tracked files,
/// then appends the "report back with the board hooks" footer.
pub async fn build_payload(
    pool: &SqlitePool,
    issue: &Issue,
    session: &str,
) -> sqlx::Result<String> {
    let acceptance = db::board::acceptance_for(pool, &issue.id).await?;
    let comments = db::board::comments_for(pool, &issue.id).await?;
    let files = db::tracked_files::list(pool, session).await.unwrap_or_default();
    let branch = db::sessions::get(pool, session)
        .await?
        .map(|s| s.branch)
        .unwrap_or_default();

    let mut out = String::new();
    out.push_str(&format!(
        "You have been assigned supermux board issue {}.\n\n",
        issue.id
    ));
    out.push_str(&format!("Title: {}\n", issue.title));

    if !acceptance.is_empty() {
        out.push_str("Acceptance criteria:\n");
        for item in &acceptance {
            let mark = if item.done != 0 { "x" } else { " " };
            out.push_str(&format!("  - [{mark}] (#{}) {}\n", item.id, item.body));
        }
    }

    if !issue.desc.trim().is_empty() {
        out.push_str("Description:\n");
        out.push_str(issue.desc.trim());
        out.push('\n');
    }

    if !branch.trim().is_empty() {
        out.push_str(&format!("Branch: {}\n", branch.trim()));
    }
    if !files.is_empty() {
        out.push_str(&format!("Linked files: {}\n", files.join(", ")));
    }

    if !comments.is_empty() {
        out.push_str("Recent comments:\n");
        let start = comments.len().saturating_sub(RECENT_COMMENTS);
        for c in &comments[start..] {
            out.push_str(&format!("  {}: {}\n", c.author, c.body));
        }
    }

    out.push('\n');
    out.push_str(&footer(&issue.id));
    Ok(out)
}

/// The self-describing "how to report back" footer. Uses the per-session
/// `$SUPERMUX_HOOK_TOKEN` / `$SUPERMUX_SESSION` / `$SUPERMUX_URL` already in the
/// pane env (lifecycle.rs), so the curls are copy-pasteable as-is. The endpoints
/// are the AB1 hook router (`/api/hook/board/*`), which scope every write to the
/// authenticated session's own issue.
fn footer(id: &str) -> String {
    format!(
        "When you finish, report progress onto this card with:\n\
         \n\
         # add a comment\n\
         curl -fsS -H \"X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN\" \\\n\
         \x20 \"$SUPERMUX_URL/api/hook/board/comment\" \\\n\
         \x20 -d '{{\"session\":\"'$SUPERMUX_SESSION'\",\"body\":\"<your update>\"}}'\n\
         \n\
         # move the card (e.g. review or done) — you have full status authority\n\
         curl -fsS -H \"X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN\" \\\n\
         \x20 \"$SUPERMUX_URL/api/hook/board/status\" \\\n\
         \x20 -d '{{\"session\":\"'$SUPERMUX_SESSION'\",\"status\":\"done\"}}'\n\
         \n\
         # tick an acceptance item, or attach a PR/commit link:\n\
         #   /api/hook/board/check  -d '{{\"session\":..., \"item_id\":N, \"done\":true}}'\n\
         #   /api/hook/board/link   -d '{{\"session\":..., \"kind\":\"pr\", \"ref\":\"<url>\"}}'\n\
         \n\
         Issue: {id}. Work in this session.\n"
    )
}
