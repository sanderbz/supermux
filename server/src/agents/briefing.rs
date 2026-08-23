//! The SessionStart capability briefing.
//!
//! A bot's `claude` process is composed with real, reachable supermux
//! affordances — a memory-write CLI, a self-schedule hook, the connector store,
//! and (fase C) a notify + peer-message hook — but nothing in its launch context
//! ever NAMES them, so a bot almost never uses them on its own initiative (the
//! "built but invisible" gap the audit flagged for memory-write and delegation).
//!
//! This module renders ONE concise `<system-reminder>` that lists those
//! affordances by their concrete mechanism (`supermux-memory save`,
//! `/supermux-schedule`, …), interpolating the bot's own identity + company +
//! same-company peer roster so the message tells it who it is and who it can
//! reach. It is emitted by the bot-memory recall hook on **`SessionStart` only**
//! (`bot_memory::run::run_recall_hook`), so it is paid ONCE per session and adds
//! ZERO per-turn cost.
//!
//! **Where the data comes from.** The recall hook is a DB-less subprocess, so it
//! cannot read the roster itself. Instead [`build`] runs at launch (inside
//! `sessions::connector_config::assemble`, which HAS the pool), writes the
//! rendered text to the session's private config dir, and points the hook at it
//! via the `SUPERMUX_BRIEFING_FILE` env var. The roster is therefore a snapshot
//! taken at launch — good enough for "who are my teammates", and never stale
//! within a session.

use crate::db;
use crate::db::sessions::Session;
use crate::state::AppState;

/// Env var the launch sets to the briefing file's path; the recall hook reads it
/// on SessionStart. One const, two readers (writer here, reader in
/// `bot_memory::run`).
pub const BRIEFING_FILE_ENV: &str = "SUPERMUX_BRIEFING_FILE";

/// Gather this bot's identity + company + peers and render the briefing. Returns
/// the `<system-reminder>` block, or an empty string if the session row is
/// somehow unreadable (the caller then simply omits the env var). Best-effort:
/// a failed company / peer lookup degrades to the company-less shape rather than
/// failing a launch.
pub async fn build(state: &AppState, session: &Session) -> String {
    let name = if session.name.trim().is_empty() {
        return String::new();
    } else {
        session.name.trim()
    };

    // Company name + same-company peers (slugs — the exact addressees
    // `/supermux-message` and the delegate hook take as `to`). Best-effort: any
    // read failure collapses to "no company", never blocks the launch.
    let (company, peers) = match session.company_id {
        Some(cid) => {
            let company_name = db::companies::get(&state.pool, cid)
                .await
                .ok()
                .flatten()
                .map(|c| {
                    if c.display_name.trim().is_empty() {
                        c.slug
                    } else {
                        c.display_name
                    }
                });
            let mut peers = db::companies::names_in_company(&state.pool, cid)
                .await
                .unwrap_or_default();
            peers.retain(|n| n != name);
            peers.sort();
            (company_name, peers)
        }
        None => (None, Vec::new()),
    };

    render(name, company.as_deref(), &peers)
}

/// Render the briefing from already-resolved facts. Pure (no IO), so a test can
/// pin the exact wording and the peer-line gating.
///
/// The peer/message line appears ONLY when the bot is in a company AND has at
/// least one same-company peer to address — an HQ/company-less bot, or the sole
/// bot in its company, gets the core five lines and no addressee-less message
/// line.
pub fn render(name: &str, company: Option<&str>, peers: &[String]) -> String {
    let mut s = String::new();
    s.push_str("<system-reminder>\n");
    match company {
        Some(co) if !co.trim().is_empty() => {
            s.push_str(&format!(
                "You are the supermux agent \"{name}\" in company \"{co}\". "
            ));
        }
        _ => {
            s.push_str(&format!("You are the supermux agent \"{name}\". "));
        }
    }
    s.push_str(
        "Beyond your normal tools you have these supermux affordances ($SUPERMUX_URL / \
         $SUPERMUX_SESSION / $SUPERMUX_HOOK_TOKEN are already set in your shell):\n",
    );
    s.push_str(
        "- Remember something durable: `supermux-memory save --type <t> --title \"…\" \
         --body \"…\"` (persists across your sessions; relevant notes are recalled automatically).\n",
    );
    s.push_str("- Schedule a follow-up/recurring check for yourself: /supermux-schedule.\n");
    s.push_str("- Report progress on your board issue: /supermux-task.\n");
    s.push_str(
        "- Reach an external service: call list_connectors, then connect(<id>); \
         build a NEW connector into the store with /supermux-connector.\n",
    );
    s.push_str("- Ping the human when you need them or finish while away: /supermux-notify.\n");
    if company.is_some() && !peers.is_empty() {
        s.push_str(&format!(
            "- Same-company teammates: {}. Message or hand off to one: /supermux-message.\n",
            peers.join(", ")
        ));
    }
    s.push_str("Use these on your own initiative when they fit; don't ask the human to do them for you.\n");
    s.push_str("</system-reminder>\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_bot_briefing_names_identity_company_and_peers() {
        let out = render(
            "crm-bot",
            Some("Acme"),
            &["billing-bot".to_string(), "support-bot".to_string()],
        );
        assert!(out.contains("You are the supermux agent \"crm-bot\" in company \"Acme\"."));
        // Every core affordance is named by its concrete mechanism.
        assert!(out.contains("supermux-memory save"));
        assert!(out.contains("/supermux-schedule"));
        assert!(out.contains("/supermux-task"));
        assert!(out.contains("list_connectors"));
        assert!(out.contains("/supermux-connector"));
        assert!(out.contains("/supermux-notify"));
        // The peer roster + the message affordance (there ARE addressees).
        assert!(out.contains("Same-company teammates: billing-bot, support-bot."));
        assert!(out.contains("/supermux-message"));
        assert!(out.starts_with("<system-reminder>\n"));
        assert!(out.trim_end().ends_with("</system-reminder>"));
    }

    #[test]
    fn hq_bot_briefing_omits_company_and_peer_lines() {
        // A company-less HQ/PA bot: no company clause, no message line (no roster
        // to address), but still every core affordance.
        let out = render("pa", None, &[]);
        assert!(out.contains("You are the supermux agent \"pa\". "));
        assert!(!out.contains("company"));
        assert!(!out.contains("/supermux-message"));
        assert!(!out.contains("teammates"));
        assert!(out.contains("supermux-memory save"));
        assert!(out.contains("/supermux-notify"));
    }

    #[test]
    fn lone_company_bot_gets_no_addressee_less_message_line() {
        // In a company but the only bot in it: the message line would have no
        // addressee, so it is omitted while the company identity clause stays.
        let out = render("solo-bot", Some("Globex"), &[]);
        assert!(out.contains("company \"Globex\""));
        assert!(!out.contains("/supermux-message"));
        assert!(!out.contains("teammates"));
    }

    #[test]
    fn briefing_stays_tight() {
        // A ballooning guard, not a hard budget: the SessionStart briefing is paid
        // ONCE per session (zero per-turn), and names six affordances + the roster.
        // `chars/4` OVERESTIMATES real BPE tokens (this is mostly whole words), so
        // the true cost sits well under this ceiling — the assertion exists so a
        // future edit that doubles the length trips a test rather than shipping.
        let out = render(
            "crm-bot",
            Some("Acme"),
            &["billing-bot".to_string(), "support-bot".to_string()],
        );
        assert!(out.len() / 4 < 240, "briefing token estimate too high: {}", out.len() / 4);
    }
}
