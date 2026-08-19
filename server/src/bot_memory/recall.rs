//! Recall: score the archival index against the current prompt, load the top-k
//! winning note bodies within a token budget, and render them (each with a
//! freshness stamp) for the `UserPromptSubmit`/`SessionStart` hook to inject.
//!
//! **Scoring is lexical, no embeddings** (v1). A note's `description` is tokenized
//! and its overlap with the prompt tokens is the base score, multiplied by the
//! note `type` weight (a decision/bugfix outranks a bare reference on a tie).
//!
//! **Union + precedence.** Candidates are the bot-private index ∪ the role-shared
//! index; a slug present in both resolves to the bot-private note (specific over
//! general), and bot-private also wins score ties.
//!
//! **Budget.** At most [`TOP_K`] notes, and only while the cumulative body token
//! estimate stays under [`TOKEN_BUDGET`] — so cost scales with relevance, not with
//! total store size.
//!
//! **SessionStart priming.** With an empty prompt (the `SessionStart` fire) there
//! is no lexical signal, so recall falls back to the freshest notes to prime a
//! baseline.

use std::path::Path;

use chrono::{DateTime, Utc};

use super::store::{self, IndexEntry, Note};

/// Hard cap on how many notes one recall injects.
pub const TOP_K: usize = 3;
/// Token budget for the injected bodies (rough `chars/4` estimate). Cost tracks
/// relevance, never total store size.
pub const TOKEN_BUDGET: usize = 1200;
/// How many lexical candidates to load from disk before final type-weighted
/// ranking. Bounds per-turn file reads without loading the whole store.
const CANDIDATE_LOAD_CAP: usize = 12;

/// A scored, loaded candidate.
///
/// Public because the archival browse/search HTTP routes
/// ([`crate::sessions::memory`]) rank with the SAME scorer the hook uses — what
/// the owner sees in the Memory panel is what the bot would actually recall.
pub struct Scored {
    pub note: Note,
    pub score: f64,
    /// Bot-private sorts before role-shared on a tie.
    pub bot_private: bool,
}

/// Run recall for one prompt. `bot` and `role` are the tier dirs (role may be
/// missing/empty). Returns the rendered injection text, or an empty string when
/// nothing is relevant (the hook then injects nothing).
pub fn recall(bot_dir: &Path, role_dir: Option<&Path>, prompt: &str, now: DateTime<Utc>) -> String {
    let selected = select(bot_dir, role_dir, prompt);
    render(&selected, now)
}

/// The two tier indexes unioned, bot-private winning a slug collision
/// (specific over general). The one place that union rule lives — recall's
/// selection, the browse list and the search route all go through it.
fn union_index(bot_dir: &Path, role_dir: Option<&Path>) -> Vec<(bool, IndexEntry)> {
    let mut candidates: Vec<(bool, IndexEntry)> = Vec::new();
    for e in store::read_index(bot_dir) {
        candidates.push((true, e));
    }
    if let Some(rd) = role_dir {
        for e in store::read_index(rd) {
            if candidates.iter().any(|(_, c)| c.slug == e.slug) {
                continue; // bot-private already covers this slug
            }
            candidates.push((false, e));
        }
    }
    candidates
}

/// Every note visible to a bot — the union above, loaded and freshness-ordered,
/// with NO query narrowing and no token budget. The browse list's data source;
/// `cap` bounds how many files one request reads.
pub fn visible_notes(bot_dir: &Path, role_dir: Option<&Path>, cap: usize) -> Vec<Scored> {
    let mut out: Vec<Scored> = Vec::new();
    for (bot_private, entry) in union_index(bot_dir, role_dir).into_iter().take(cap) {
        let dir = tier_of(bot_dir, role_dir, bot_private);
        let Some(note) = store::load_note(dir, &entry.slug) else {
            continue;
        };
        out.push(Scored { note, score: 0.0, bot_private });
    }
    out.sort_by(|a, b| {
        b.note
            .modified
            .cmp(&a.note.modified)
            .then(b.bot_private.cmp(&a.bot_private))
    });
    out
}

/// Which tier dir a candidate came from.
fn tier_of<'a>(bot_dir: &'a Path, role_dir: Option<&'a Path>, bot_private: bool) -> &'a Path {
    if bot_private {
        bot_dir
    } else {
        role_dir.unwrap_or(bot_dir)
    }
}

/// The selection core, split out for testing: union → score → rank → budget.
fn select(bot_dir: &Path, role_dir: Option<&Path>, prompt: &str) -> Vec<Scored> {
    let mut scored = rank(bot_dir, role_dir, prompt, CANDIDATE_LOAD_CAP);

    // Apply top-k + token budget.
    let mut out = Vec::new();
    let mut used = 0usize;
    for s in scored.drain(..) {
        if out.len() >= TOP_K {
            break;
        }
        let cost = est_tokens(&s.note.body);
        if !out.is_empty() && used + cost > TOKEN_BUDGET {
            continue; // skip an over-budget note but keep trying smaller ones
        }
        used += cost;
        out.push(s);
    }
    out
}

/// Union → lexical score → type weight → rank, WITHOUT the hook's top-k/token
/// budget. Shared by the recall hook (which then applies those caps) and the
/// HTTP search route (which does not), so the owner's search results are ranked
/// by exactly what the bot itself would recall. `load_cap` bounds the per-call
/// file reads. An empty query ranks by freshness — the same baseline the
/// `SessionStart` prime falls back to.
pub fn rank(
    bot_dir: &Path,
    role_dir: Option<&Path>,
    prompt: &str,
    load_cap: usize,
) -> Vec<Scored> {
    let candidates = union_index(bot_dir, role_dir);
    if candidates.is_empty() {
        return Vec::new();
    }

    let prompt_tokens = tokenize(prompt);
    let baseline = prompt_tokens.is_empty(); // SessionStart / empty prompt

    // Lexical prefilter on the cheap index descriptions.
    let mut prelim: Vec<(bool, IndexEntry, usize)> = candidates
        .into_iter()
        .map(|(bot, e)| {
            let base = if baseline {
                1 // everything is a baseline candidate; freshness decides later
            } else {
                lexical_overlap(&prompt_tokens, &e.description)
            };
            (bot, e, base)
        })
        .filter(|(_, _, base)| *base > 0)
        .collect();
    // Highest lexical base first; keep only enough to load.
    prelim.sort_by(|a, b| b.2.cmp(&a.2));
    prelim.truncate(load_cap);

    // Load the surviving notes and apply type weighting.
    let mut scored: Vec<Scored> = Vec::new();
    for (bot_private, entry, base) in prelim {
        let dir = tier_of(bot_dir, role_dir, bot_private);
        let Some(note) = store::load_note(dir, &entry.slug) else {
            continue;
        };
        let score = base as f64 * note.note_type.weight();
        scored.push(Scored {
            note,
            score,
            bot_private,
        });
    }

    // Final ranking.
    if baseline {
        // Freshness-first for the SessionStart prime.
        scored.sort_by(|a, b| {
            b.note
                .modified
                .cmp(&a.note.modified)
                .then(b.bot_private.cmp(&a.bot_private))
        });
    } else {
        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.bot_private.cmp(&a.bot_private))
                .then(b.note.modified.cmp(&a.note.modified))
        });
    }
    scored
}

/// Render the selected notes into the hook's stdout injection. Empty selection →
/// empty string (inject nothing).
fn render(selected: &[Scored], now: DateTime<Utc>) -> String {
    if selected.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "<system-reminder>\nRelevant notes recalled from your memory for this turn. \
Bot-private notes outrank role-shared ones; each carries an age stamp — verify a \
stale note before asserting it.\n\n",
    );
    for s in selected {
        let tier = if s.bot_private { "bot" } else { "role" };
        out.push_str(&format!(
            "## {}  ({} · {} · {})\n{}\n\n",
            s.note.description,
            tier,
            s.note.note_type.as_str(),
            freshness(&s.note.modified, now),
            s.note.body.trim_end(),
        ));
    }
    out.push_str("</system-reminder>\n");
    out
}

/// A human age stamp for the note's `modified` time, in the auto-memory style.
fn freshness(modified: &str, now: DateTime<Utc>) -> String {
    let Ok(ts) = DateTime::parse_from_rfc3339(modified) else {
        return "age unknown — verify before asserting".to_string();
    };
    let age = now.signed_duration_since(ts.with_timezone(&Utc));
    let days = age.num_days();
    if days <= 0 {
        "written today".to_string()
    } else if days == 1 {
        "1 day old — verify before asserting".to_string()
    } else {
        format!("{days} days old — verify before asserting")
    }
}

/// Rough token estimate for budgeting: ~4 chars/token plus a small per-note
/// header overhead.
fn est_tokens(body: &str) -> usize {
    body.chars().count() / 4 + 16
}

/// Count how many of a description's tokens appear in the prompt token set.
fn lexical_overlap(prompt_tokens: &std::collections::BTreeSet<String>, description: &str) -> usize {
    tokenize(description)
        .iter()
        .filter(|t| prompt_tokens.contains(*t))
        .count()
}

/// Lowercase, split on non-alphanumerics, drop short tokens and a tiny stopword
/// list. Deliberately simple — the whole point of v1 is no embeddings.
fn tokenize(s: &str) -> std::collections::BTreeSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3 && !is_stopword(t))
        .map(|t| t.to_string())
        .collect()
}

fn is_stopword(t: &str) -> bool {
    matches!(
        t,
        "the" | "and" | "for" | "you" | "your" | "with" | "this" | "that" | "are" | "was"
            | "has" | "had" | "not" | "but" | "how" | "why" | "what" | "when" | "who" | "can"
            | "will" | "should" | "would" | "could" | "from" | "into" | "our" | "out"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bot_memory::Scope;
    use std::fs;
    use std::path::PathBuf;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bm-recall-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed(dir: &Path, ty: crate::bot_memory::NoteType, title: &str, body: &str, modified: &str) {
        store::save(dir, Scope::Bot, ty, title, body, modified).unwrap();
    }

    #[test]
    fn picks_top_k_by_lexical_score() {
        let d = tmp();
        seed(&d, crate::bot_memory::NoteType::Reference, "grep OOM defense on long-line files", "use -F", "2026-08-18T00:00:00Z");
        seed(&d, crate::bot_memory::NoteType::Reference, "deploy via in-app updater", "cut a release", "2026-08-18T00:00:00Z");
        seed(&d, crate::bot_memory::NoteType::Reference, "board issues marked done by id", "PATCH", "2026-08-18T00:00:00Z");

        let now = "2026-08-18T00:00:00Z".parse().unwrap();
        let picked = select(&d, None, "how do I avoid a grep OOM on long-line files?");
        assert!(!picked.is_empty());
        assert!(
            picked[0].note.description.contains("grep OOM"),
            "the grep note wins: {}",
            picked[0].note.description
        );
        // Only the relevant note should surface (deploy/board share no tokens).
        assert_eq!(picked.len(), 1, "unrelated notes score 0 and are dropped");
        let _ = render(&picked, now);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn budget_caps_the_selection() {
        let d = tmp();
        let big = "alpha ".repeat(2000); // ~12k chars → ~3000 tokens, over budget alone
        seed(&d, crate::bot_memory::NoteType::Reference, "alpha topic one", &big, "2026-08-18T00:00:00Z");
        seed(&d, crate::bot_memory::NoteType::Reference, "alpha topic two", &big, "2026-08-18T00:00:00Z");
        let picked = select(&d, None, "alpha");
        assert_eq!(picked.len(), 1, "budget admits only the first oversized note");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn bot_private_wins_over_role_on_slug_conflict() {
        let bot = tmp();
        let role = tmp();
        store::save(&bot, Scope::Bot, crate::bot_memory::NoteType::Reference, "shared topic", "BOT VERSION", "2026-08-18T00:00:00Z").unwrap();
        store::save(&role, Scope::Role, crate::bot_memory::NoteType::Reference, "shared topic", "ROLE VERSION", "2026-08-18T00:00:00Z").unwrap();
        let picked = select(&bot, Some(&role), "shared topic");
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].note.body.trim(), "BOT VERSION");
        assert!(picked[0].bot_private);
        fs::remove_dir_all(&bot).ok();
        fs::remove_dir_all(&role).ok();
    }

    #[test]
    fn empty_prompt_primes_by_freshness() {
        let d = tmp();
        seed(&d, crate::bot_memory::NoteType::Reference, "old note", "x", "2026-01-01T00:00:00Z");
        seed(&d, crate::bot_memory::NoteType::Reference, "new note", "y", "2026-08-18T00:00:00Z");
        let picked = select(&d, None, "");
        assert_eq!(picked[0].note.description, "new note", "freshest primes first");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn freshness_stamp_reads_naturally() {
        let now: DateTime<Utc> = "2026-08-18T00:00:00Z".parse().unwrap();
        assert_eq!(freshness("2026-08-18T00:00:00Z", now), "written today");
        assert_eq!(freshness("2026-08-17T00:00:00Z", now), "1 day old — verify before asserting");
        assert_eq!(freshness("2026-08-14T00:00:00Z", now), "4 days old — verify before asserting");
    }
}
