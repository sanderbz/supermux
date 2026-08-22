//! The bot's ARCHIVAL memory as a read-only HTTP surface — browse + search.
//!
//! **Why it exists.** [`crate::bot_memory`] owns two tiers on disk (the bot's
//! private `bots/<name>/` and its role's shared `roles/<role_id>/`) that only two
//! processes could reach: the recall hook (per-turn, top-3, budgeted) and the
//! `supermux-memory` write CLI. The owner had NO way to see what their bot had
//! learned. These three routes are that window.
//!
//! **Read-only on purpose.** The bot writes its own notes; the owner reads them.
//! No POST/PATCH/DELETE here — editing a bot's own memory is a separate decision
//! with its own consequences (a hand-edited note the bot then re-saves is silently
//! overwritten by [`store::save`]'s dedup), not something to smuggle in behind a
//! browse feature.
//!
//! **Same union, same scorer.** The list unions the two tiers exactly as recall
//! does — bot-private wins a slug collision, specific over general
//! ([`recall::visible_notes`]) — and search ranks with [`recall::rank`], the very
//! function the per-turn hook selects with. So what the owner sees ranked in the
//! Memory panel IS what the bot itself would recall for that prompt; a search box
//! that scored differently would quietly lie about the bot's mind.
//!
//! **404 means "not a bot".** A session with no role, no core notes and no
//! archival store is a plain pane, not a bot with an empty memory, and says so
//! ([`bot_memory::session_has_memory`]). A real bot that simply hasn't written
//! anything yet returns `200` with an empty list — the panel's empty state.
//!
//! Disk work runs under `spawn_blocking`, the same shape as [`super::recall`].

use std::path::{Path as FsPath, PathBuf};

use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::bot_memory::{self, recall, store, Scope};
use crate::db;
use crate::db::sessions::Session;
use crate::error::AppError;
use crate::state::AppState;

/// Hard cap on how many notes one browse response loads off disk. Far above any
/// real store (the write CLI dedups aggressively), low enough that a pathological
/// directory cannot define the response size.
const LIST_CAP: usize = 200;
/// Candidate load cap for search — wider than the hook's 12, because the owner is
/// scanning a whole store rather than paying per-turn tokens for the top 3.
const SEARCH_LOAD_CAP: usize = 60;
/// Default / max number of ranked hits returned.
const SEARCH_LIMIT_DEFAULT: usize = 20;
const SEARCH_LIMIT_MAX: usize = 50;
/// Preview length of a note body on a list row (the full body comes from the
/// per-note route when the row is expanded).
const SNIPPET_MAX_CHARS: usize = 200;

// ── wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct Envelope<T> {
    ok: bool,
    data: T,
}

/// One row of the browse/search list — everything needed to render it without
/// fetching the body.
#[derive(Debug, Serialize)]
pub struct NoteSummary {
    /// The note's filename stem; the id the per-note route takes.
    pub slug: String,
    /// The one-line gist (frontmatter `description`) — the note's headline, and
    /// the text recall scores against.
    pub description: String,
    /// Which tier it lives in: `bot` (private) or `role` (shared).
    pub tier: &'static str,
    pub note_type: &'static str,
    /// RFC3339 `modified` stamp; empty on a hand-authored note that omitted it.
    pub modified: String,
    /// First ~200 chars of the body, whitespace-collapsed.
    pub snippet: String,
    /// The recall score — present on search results only, so the UI can show
    /// (or debug) the ranking. Absent on a plain browse listing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

/// One note in full — the expanded read view.
#[derive(Debug, Serialize)]
pub struct NoteDetail {
    pub slug: String,
    pub description: String,
    pub tier: &'static str,
    pub note_type: &'static str,
    pub modified: String,
    /// The raw Markdown body (Why / How-to-apply / `[[links]]`), rendered
    /// client-side by the same Markdown renderer chat uses.
    pub body: String,
}

#[derive(Debug, Serialize, Default)]
pub struct NotesResponse {
    pub notes: Vec<NoteSummary>,
    /// How many of the returned notes are private vs role-shared — lets the panel
    /// state the split without counting chips.
    pub bot_count: usize,
    pub role_count: usize,
    /// The role key whose shared tier was unioned in, if any.
    pub role: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct TierQuery {
    /// Optional tier hint (`bot` | `role`). Omitted → bot-private first, then the
    /// role tier: the same precedence recall applies.
    #[serde(default)]
    pub tier: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

// ── handlers ─────────────────────────────────────────────────────────────────

/// `GET /api/sessions/{name}/memory/notes`
///
/// The browsable index: every archival note visible to this bot (private ∪ role),
/// freshest first. `404` when the session isn't a bot at all.
pub async fn list_handler(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Envelope<NotesResponse>>, AppError> {
    let tiers = tiers_for(&state, &name).await?;
    let data = tokio::task::spawn_blocking(move || {
        let found = recall::visible_notes(&tiers.bot, tiers.role.as_deref(), LIST_CAP);
        let notes: Vec<NoteSummary> = found.iter().map(|s| summary(&s.note, s.bot_private, None)).collect();
        response(notes, tiers.role_key)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    Ok(Json(Envelope { ok: true, data }))
}

/// `GET /api/sessions/{name}/memory/notes/{slug}`
///
/// One note in full. `?tier=bot|role` pins the tier; without it the bot-private
/// copy wins, matching recall's precedence.
pub async fn note_handler(
    State(state): State<AppState>,
    AxumPath((name, slug)): AxumPath<(String, String)>,
    Query(q): Query<TierQuery>,
) -> Result<Json<Envelope<NoteDetail>>, AppError> {
    // A slug is a filename stem by construction (`bot_memory::slugify`); refuse
    // anything that could escape the tier dir rather than trusting the path.
    if !is_safe_slug(&slug) {
        return Err(AppError::BadRequest(format!("invalid note id '{slug}'")));
    }
    let tiers = tiers_for(&state, &name).await?;
    let want = q.tier.as_deref().and_then(Scope::parse);
    let slug_for_err = slug.clone();
    let found = tokio::task::spawn_blocking(move || {
        let bot_first = !matches!(want, Some(Scope::Role));
        let mut order: Vec<(bool, PathBuf)> = Vec::new();
        if bot_first {
            order.push((true, tiers.bot.clone()));
        }
        if let Some(rd) = tiers.role.clone() {
            if want != Some(Scope::Bot) {
                order.push((false, rd));
            }
        }
        if !bot_first {
            order.push((true, tiers.bot.clone()));
        }
        order
            .into_iter()
            .find_map(|(bot_private, dir)| store::load_note(&dir, &slug).map(|n| (bot_private, n)))
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    let (bot_private, note) =
        found.ok_or_else(|| AppError::NotFound(format!("note '{slug_for_err}'")))?;
    Ok(Json(Envelope {
        ok: true,
        data: NoteDetail {
            slug: note.slug.clone(),
            description: note.description.clone(),
            tier: tier_str(bot_private),
            note_type: note.note_type.as_str(),
            modified: note.modified.clone(),
            body: note.body,
        },
    }))
}

/// `GET /api/sessions/{name}/memory/search?q=…`
///
/// The same lexical ranking the per-turn recall hook selects with, minus its
/// top-3 / token budget. An empty `q` degrades to the freshness baseline (what
/// `SessionStart` priming would pick), so the box is never a dead end.
pub async fn search_handler(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Envelope<NotesResponse>>, AppError> {
    let tiers = tiers_for(&state, &name).await?;
    let limit = q.limit.unwrap_or(SEARCH_LIMIT_DEFAULT).clamp(1, SEARCH_LIMIT_MAX);
    let query = q.q;
    let data = tokio::task::spawn_blocking(move || {
        let ranked = recall::rank(&tiers.bot, tiers.role.as_deref(), &query, SEARCH_LOAD_CAP);
        let notes: Vec<NoteSummary> = ranked
            .iter()
            .take(limit)
            .map(|s| summary(&s.note, s.bot_private, Some(s.score)))
            .collect();
        response(notes, tiers.role_key)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    Ok(Json(Envelope { ok: true, data }))
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// The tier dirs a session's memory spans.
struct Tiers {
    bot: PathBuf,
    /// `None` for a private-only bot (no `role_id`).
    role: Option<PathBuf>,
    role_key: String,
}

/// Look the session up and resolve its tier dirs, or `404`: the row must exist
/// AND be a bot ([`bot_memory::session_has_memory`]).
async fn tiers_for(state: &AppState, name: &str) -> Result<Tiers, AppError> {
    let session = db::sessions::get(&state.pool, name)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    let data_dir = state.config.data_dir.clone();
    if !bot_memory::session_has_memory(&session, &data_dir) {
        return Err(AppError::NotFound(format!("memory for session '{name}'")));
    }
    Ok(tiers_of(&session, &data_dir))
}

/// Pure tier resolution, split out so tests can build it without a router.
fn tiers_of(session: &Session, data_dir: &FsPath) -> Tiers {
    let root = bot_memory::root(data_dir);
    let role_key = session
        .role_id
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    Tiers {
        bot: bot_memory::bot_dir(&root, &session.name),
        role: (!role_key.is_empty()).then(|| bot_memory::role_dir(&root, &role_key)),
        role_key,
    }
}

fn tier_str(bot_private: bool) -> &'static str {
    if bot_private {
        "bot"
    } else {
        "role"
    }
}

fn summary(note: &store::Note, bot_private: bool, score: Option<f64>) -> NoteSummary {
    NoteSummary {
        slug: note.slug.clone(),
        description: note.description.clone(),
        tier: tier_str(bot_private),
        note_type: note.note_type.as_str(),
        modified: note.modified.clone(),
        snippet: snippet(&note.body),
        score,
    }
}

fn response(notes: Vec<NoteSummary>, role_key: String) -> NotesResponse {
    let bot_count = notes.iter().filter(|n| n.tier == "bot").count();
    NotesResponse {
        role_count: notes.len() - bot_count,
        bot_count,
        notes,
        role: role_key,
    }
}

/// A one-line body preview: whitespace collapsed, cut on a char boundary.
fn snippet(body: &str) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= SNIPPET_MAX_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(SNIPPET_MAX_CHARS).collect();
    format!("{}…", cut.trim_end())
}

/// Slugs are `[a-z0-9-]` by construction. Anything else (a `/`, a `..`, a dot)
/// is refused before it reaches the filesystem.
fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 120
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    //! Fixture-driven: a temp `data_dir`, a real session row, and notes written
    //! through [`store::save`] (the same path the bot's write CLI takes), so the
    //! tests exercise the true on-disk format rather than a hand-built one.

    use super::*;
    use crate::bot_memory::NoteType;
    use crate::db::sessions::NewSession;

    async fn fixture(role: Option<&str>) -> (AppState, PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("supermux-mem-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
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
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        let name = "memo-bot".to_string();
        db::sessions::create(
            &pool,
            &NewSession {
                name: name.clone(),
                display_name: name.clone(),
                dir: "/tmp".into(),
                desc: String::new(),
                provider: "shell".into(),
                creator: String::new(),
                flags: String::new(),
                tags: "[]".into(),
                branch: String::new(),
                mcp: String::new(),
                worktree: false,
                worktree_repo: String::new(),
                host_id: None,
                runtime: "native".into(),
                model: String::new(),
                company_id: None,
            },
        )
        .await
        .expect("create session");
        if let Some(r) = role {
            set_role(&pool, &name, r).await;
        }
        (AppState::new(pool, config), dir, name)
    }

    /// `sessions.role_id` has no setter yet (migration 0031 provisions it in a
    /// later phase), so the fixture writes it directly — the routes only ever
    /// READ it.
    async fn set_role(pool: &sqlx::SqlitePool, name: &str, role: &str) {
        sqlx::query("UPDATE sessions SET role_id = ? WHERE name = ?")
            .bind(role)
            .bind(name)
            .execute(pool)
            .await
            .expect("set role_id");
    }

    fn seed(dir: &FsPath, scope: Scope, ty: NoteType, title: &str, body: &str, when: &str) {
        store::save(dir, scope, ty, title, body, when).expect("seed note");
    }

    fn teardown(state: AppState, dir: PathBuf) {
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The list unions BOTH tiers, tags each row with the tier it came from, and
    /// orders freshest-first.
    #[tokio::test]
    async fn list_unions_bot_and_role_tiers() {
        let (state, dir, name) = fixture(Some("reviewer")).await;
        let root = bot_memory::root(&dir);
        seed(
            &bot_memory::bot_dir(&root, &name),
            Scope::Bot,
            NoteType::Bugfix,
            "grep OOM defense on long-line files",
            "**Why:** bounded quantifiers thrash.\n\n**How:** use -F.",
            "2026-08-18T00:00:00Z",
        );
        seed(
            &bot_memory::role_dir(&root, "reviewer"),
            Scope::Role,
            NoteType::Decision,
            "reviewers never auto-merge",
            "The owner reviews every merge.",
            "2026-08-10T00:00:00Z",
        );

        let out = list_handler(State(state.clone()), AxumPath(name.clone()))
            .await
            .expect("list")
            .0
            .data;
        assert_eq!(out.notes.len(), 2, "both tiers are unioned: {:?}", out.notes);
        assert_eq!(out.bot_count, 1);
        assert_eq!(out.role_count, 1);
        assert_eq!(out.role, "reviewer");
        // Freshest first, and each row carries its tier + type + a body snippet.
        assert_eq!(out.notes[0].tier, "bot");
        assert_eq!(out.notes[0].note_type, "bugfix");
        assert!(out.notes[0].snippet.contains("bounded quantifiers"), "{:?}", out.notes[0]);
        assert_eq!(out.notes[1].tier, "role");
        assert_eq!(out.notes[1].note_type, "decision");
        // A browse listing carries no score — only search does.
        assert!(out.notes[0].score.is_none());
        teardown(state, dir);
    }

    /// Search ranks by the recall scorer: the lexically-matching note wins, and
    /// notes sharing no tokens with the query are dropped entirely.
    #[tokio::test]
    async fn search_ranks_with_the_recall_scorer() {
        let (state, dir, name) = fixture(Some("reviewer")).await;
        let root = bot_memory::root(&dir);
        let bot = bot_memory::bot_dir(&root, &name);
        seed(&bot, Scope::Bot, NoteType::Reference, "deploy via the in-app updater", "cut a release", "2026-08-18T00:00:00Z");
        seed(&bot, Scope::Bot, NoteType::Bugfix, "grep OOM defense on long-line files", "use -F", "2026-08-17T00:00:00Z");
        seed(
            &bot_memory::role_dir(&root, "reviewer"),
            Scope::Role,
            NoteType::Reference,
            "board issues are marked done by id",
            "PATCH the issue",
            "2026-08-16T00:00:00Z",
        );

        let q = SearchQuery { q: "how do I avoid a grep OOM on long-line files?".into(), limit: None };
        let out = search_handler(State(state.clone()), AxumPath(name.clone()), Query(q))
            .await
            .expect("search")
            .0
            .data;
        assert_eq!(out.notes.len(), 1, "unrelated notes score 0 and drop: {:?}", out.notes);
        assert!(out.notes[0].description.contains("grep OOM"), "{:?}", out.notes[0]);
        assert!(out.notes[0].score.unwrap_or(0.0) > 0.0, "search rows carry their score");

        // An empty query is the freshness baseline, not an error or an empty list.
        let all = search_handler(
            State(state.clone()),
            AxumPath(name.clone()),
            Query(SearchQuery { q: String::new(), limit: None }),
        )
        .await
        .expect("baseline search")
        .0
        .data;
        assert_eq!(all.notes.len(), 3, "empty q primes by freshness over the whole union");
        assert!(all.notes[0].description.contains("in-app updater"), "freshest first");

        // `limit` is honoured and clamped.
        let one = search_handler(
            State(state.clone()),
            AxumPath(name.clone()),
            Query(SearchQuery { q: String::new(), limit: Some(1) }),
        )
        .await
        .expect("limited search")
        .0
        .data;
        assert_eq!(one.notes.len(), 1);
        teardown(state, dir);
    }

    /// Bot-private wins a slug collision, and the detail route serves the full
    /// Markdown body (with `?tier=role` able to pin the shared copy).
    #[tokio::test]
    async fn note_detail_prefers_bot_private_and_tier_pins() {
        let (state, dir, name) = fixture(Some("reviewer")).await;
        let root = bot_memory::root(&dir);
        seed(&bot_memory::bot_dir(&root, &name), Scope::Bot, NoteType::Reference, "shared topic", "BOT VERSION", "2026-08-18T00:00:00Z");
        seed(&bot_memory::role_dir(&root, "reviewer"), Scope::Role, NoteType::Reference, "shared topic", "ROLE VERSION", "2026-08-18T00:00:00Z");

        let d = note_handler(
            State(state.clone()),
            AxumPath((name.clone(), "shared-topic".to_string())),
            Query(TierQuery::default()),
        )
        .await
        .expect("note")
        .0
        .data;
        assert_eq!(d.tier, "bot");
        assert_eq!(d.body.trim(), "BOT VERSION");

        let d = note_handler(
            State(state.clone()),
            AxumPath((name.clone(), "shared-topic".to_string())),
            Query(TierQuery { tier: Some("role".into()) }),
        )
        .await
        .expect("note")
        .0
        .data;
        assert_eq!(d.tier, "role");
        assert_eq!(d.body.trim(), "ROLE VERSION");

        // An unknown slug is a 404; a traversal attempt is a 400, never a read.
        let err = note_handler(
            State(state.clone()),
            AxumPath((name.clone(), "nope".to_string())),
            Query(TierQuery::default()),
        )
        .await
        .expect_err("unknown slug");
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
        let err = note_handler(
            State(state.clone()),
            AxumPath((name.clone(), "../../etc/passwd".to_string())),
            Query(TierQuery::default()),
        )
        .await
        .expect_err("traversal");
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
        teardown(state, dir);
    }

    /// A plain pane — no role, no core notes, no archival store — is not a bot
    /// with an empty memory. It 404s; a real bot with nothing written yet gets a
    /// `200` and an empty list (the panel's empty state).
    #[tokio::test]
    async fn plain_session_404s_but_an_empty_bot_lists_nothing() {
        let (state, dir, name) = fixture(None).await;
        let err = list_handler(State(state.clone()), AxumPath(name.clone()))
            .await
            .expect_err("a plain pane has no memory surface");
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");

        let err = list_handler(State(state.clone()), AxumPath("ghost".to_string()))
            .await
            .expect_err("unknown session");
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");

        // Give it a role → it is a bot, with an empty archival store.
        set_role(&state.pool, &name, "reviewer").await;
        let out = list_handler(State(state.clone()), AxumPath(name.clone()))
            .await
            .expect("a bot with no notes still answers")
            .0
            .data;
        assert!(out.notes.is_empty());
        assert_eq!(out.bot_count, 0);
        teardown(state, dir);
    }
}
