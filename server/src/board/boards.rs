//! Multi-board HTTP surface (AT-C, plan §5.5). The single Kanban board became
//! MULTIPLE boards selectable via a switcher; this module is the boards-entity
//! CRUD + the team-board register endpoint.
//!
//! Endpoints (all under the protected bearer layer, mounted by
//! [`super::router_for`]):
//!   - `GET    /api/boards`                — list boards (switcher options).
//!   - `POST   /api/boards`                — create a board.
//!   - `POST   /api/boards/register-team`  — UPSERT a `kind='team'` board for an
//!                                           on-disk team (the AT-D/AT-F3 hook).
//!   - `PATCH  /api/boards/{id}`           — rename a board (main is fixed).
//!   - `DELETE /api/boards/{id}`           — delete a board + CASCADE its cards
//!                                           (main is fixed).
//!   - `GET    /api/boards/{id}/cards`     — that board's cards (or `all` for the
//!                                           cross-board aggregate).
//!
//! The fixed `main` board ([`db::boards::MAIN_BOARD_ID`]) is non-renameable and
//! non-deletable — those two paths 409 for it.
//!
//! ## How AT-D / AT-F3 create + populate a TEAM board (design intent)
//! A team's tasks live on a `kind='team'` board whose `team_name` is the on-disk
//! team id under `~/.claude/teams/{team}/` + `~/.claude/tasks/{team}/`. The flow:
//!   1. `POST /api/boards/register-team { team_name, name? }` — idempotent UPSERT:
//!      returns the existing board for that team, or creates one (id derived from
//!      the team name, deterministically). Safe to call every detect tick.
//!   2. Populate it by creating cards scoped to that board: `POST /api/board`
//!      with `board_id: "<that board's id>"` (the create handler accepts an
//!      optional `board_id`, defaulting to `main`). One card per
//!      `~/.claude/tasks/{team}/NN.json` task, mapping the task `status`
//!      (pending|in_progress|completed) → lane (todo|doing|done) and the
//!      assignee/teammate colour onto the card. Subsequent ticks reconcile by
//!      patching existing cards (the read-through mirror) — the board domain (drag,
//!      reply, lanes) keeps working unchanged because a team card is an ordinary
//!      issue row that merely carries a non-`main` `board_id`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router};
use serde::Deserialize;

use crate::db;
use crate::db::boards::{Board, MAIN_BOARD_ID};
use crate::error::AppError;
use crate::state::AppState;

use super::{load_board_scoped, ok, IssueView};

/// Build the protected boards sub-router (merged into [`super::router_for`], so it
/// inherits the bearer layer from `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, patch, post};
    Router::new()
        .route("/api/boards", get(list_handler).post(create_handler))
        .route("/api/boards/register-team", post(register_team_handler))
        .route(
            "/api/boards/{id}",
            patch(rename_handler).delete(delete_handler),
        )
        .route("/api/boards/{id}/cards", get(cards_handler))
        .with_state(state)
}

/// The id used by the switcher's optional "All" aggregate — NOT a real board row;
/// the cards endpoint special-cases it to a read-through across every board.
pub const ALL_BOARD_ID: &str = "all";

// ── list ──────────────────────────────────────────────────────────────────────

async fn list_handler(
    State(state): State<AppState>,
) -> Result<Json<super::Envelope<Vec<Board>>>, AppError> {
    Ok(ok(db::boards::list(&state.pool).await?))
}

// ── create ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CreateBoardInput {
    name: String,
    /// Optional explicit kind; defaults to `team` (a manually-created sibling
    /// board). The fixed `main` board is seeded by the migration and can't be
    /// re-created here.
    #[serde(default)]
    kind: Option<String>,
    /// For a `team` board, the on-disk team id (optional for a plain custom board).
    #[serde(default)]
    team_name: Option<String>,
}

async fn create_handler(
    State(state): State<AppState>,
    Json(input): Json<CreateBoardInput>,
) -> Result<impl IntoResponse, AppError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("board name is required".into()));
    }
    // Only `team` boards are creatable via the API; `main` is the single fixed
    // board seeded by the migration. Reject an attempt to mint a second `main`.
    let kind = input.kind.unwrap_or_else(|| "team".into());
    if kind != "team" {
        return Err(AppError::BadRequest(
            "only team boards can be created (main is fixed)".into(),
        ));
    }
    let team_name = normalize_team(input.team_name.as_deref());
    if let Some(t) = team_name.as_deref() {
        if db::boards::get_by_team(&state.pool, t).await?.is_some() {
            return Err(AppError::Conflict(format!(
                "a board already exists for team '{t}'"
            )));
        }
    }
    let board = insert_unique(&state, &name, &kind, team_name.as_deref()).await?;
    emit_boards(&state).await;
    Ok((StatusCode::CREATED, ok(board)))
}

// ── register team (idempotent UPSERT — the AT-D/AT-F3 entry point) ──────────────

#[derive(Debug, Deserialize)]
struct RegisterTeamInput {
    /// The on-disk team id (`~/.claude/teams/{team}/`). Required.
    team_name: String,
    /// Optional display label; defaults to `team_name` when omitted.
    #[serde(default)]
    name: Option<String>,
}

/// Idempotent: return the existing team board, or create one. Safe to call on
/// every team-detect tick (AT-D/AT-F3) — never duplicates a team's board.
async fn register_team_handler(
    State(state): State<AppState>,
    Json(input): Json<RegisterTeamInput>,
) -> Result<impl IntoResponse, AppError> {
    let team = normalize_team(Some(&input.team_name))
        .ok_or_else(|| AppError::BadRequest("team_name is required".into()))?;
    if let Some(existing) = db::boards::get_by_team(&state.pool, &team).await? {
        // Already registered — return it (no-op), 200.
        return Ok((StatusCode::OK, ok(existing)));
    }
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&team)
        .to_string();
    let board = insert_unique(&state, &name, "team", Some(&team)).await?;
    emit_boards(&state).await;
    Ok((StatusCode::CREATED, ok(board)))
}

// ── rename ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RenameBoardInput {
    name: String,
}

async fn rename_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RenameBoardInput>,
) -> Result<Json<super::Envelope<Board>>, AppError> {
    if id == MAIN_BOARD_ID {
        return Err(AppError::Conflict(
            "the Main board can't be renamed".into(),
        ));
    }
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("board name is required".into()));
    }
    let renamed = db::boards::rename(&state.pool, &id, &name).await?;
    if !renamed {
        return Err(AppError::NotFound(format!("board '{id}'")));
    }
    emit_boards(&state).await;
    let board = db::boards::get(&state.pool, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("board '{id}'")))?;
    Ok(ok(board))
}

// ── delete ─────────────────────────────────────────────────────────────────────

async fn delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<super::Envelope<serde_json::Value>>, AppError> {
    if id == MAIN_BOARD_ID {
        return Err(AppError::Conflict(
            "the Main board can't be deleted".into(),
        ));
    }
    let deleted = db::boards::delete(&state.pool, &id).await?;
    if !deleted {
        return Err(AppError::NotFound(format!("board '{id}'")));
    }
    // A board delete CASCADE-removes its cards — re-publish both the board list
    // and the (now-smaller) card set.
    emit_boards(&state).await;
    super::emit_board(&state).await;
    Ok(ok(serde_json::json!({ "ok": true, "deleted": id })))
}

// ── cards (per-board, or the "all" aggregate) ──────────────────────────────────

async fn cards_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<super::Envelope<Vec<IssueView>>>, AppError> {
    // The "all" aggregate is a read-through across every board (plan §5.5). The
    // card view carries `board_id`, so the client groups by board for the
    // overview.
    if id == ALL_BOARD_ID {
        return Ok(ok(super::load_board(&state, 0).await?));
    }
    // A real board id must exist (so a stale switcher selection 404s cleanly
    // rather than silently returning an empty board).
    if !db::boards::exists(&state.pool, &id).await? {
        return Err(AppError::NotFound(format!("board '{id}'")));
    }
    Ok(ok(load_board_scoped(&state, &id, 0).await?))
}

// ── helpers ────────────────────────────────────────────────────────────────────

/// Normalise an on-disk team id: trim, empty → None.
fn normalize_team(team: Option<&str>) -> Option<String> {
    team.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Insert a board with a deterministic, collision-resistant id. The id is a
/// slug of the team name / display name (so it's stable across register-team
/// calls when derived from `team_name`), suffixed if a slug already exists.
///
/// `pub(crate)` so the AT-G teams watcher can register a team board IN-PROCESS
/// (never self-HTTP) on each detect tick — the idempotency is handled by the
/// caller checking [`db::boards::get_by_team`] first (the UNIQUE `team_name`
/// index is the backstop).
pub(crate) async fn insert_unique(
    state: &AppState,
    name: &str,
    kind: &str,
    team_name: Option<&str>,
) -> Result<Board, AppError> {
    let base = slugify(team_name.unwrap_or(name));
    let base = if base.is_empty() { "board".to_string() } else { base };
    // The main id is reserved.
    let mut candidate = if base == MAIN_BOARD_ID {
        "board".to_string()
    } else {
        base.clone()
    };
    let mut n = 2;
    while db::boards::exists(&state.pool, &candidate).await? {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    let position = db::boards::max_position(&state.pool).await? + 1024.0;
    Ok(db::boards::insert(&state.pool, &candidate, name, kind, team_name, position).await?)
}

/// Lowercase, ascii-alnum-or-`-` slug (collapse runs, trim dashes). Bounded to a
/// reasonable length for a clean id.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // collapse leading dashes
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// Re-publish the boards list over SSE so an open switcher updates without a
/// poll (mirrors `emit_board`). Best-effort.
pub(crate) async fn emit_boards(state: &AppState) {
    if let Ok(boards) = db::boards::list(&state.pool).await {
        let _ = state.sse_tx.send(crate::state::SseEvent {
            event: "boards".to_string(),
            payload: serde_json::to_value(&boards).unwrap_or(serde_json::Value::Null),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-boards-test-{}", uuid::Uuid::new_v4()));
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
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// register-team is idempotent: the first call creates a team board, a second
    /// call for the SAME team returns that same board (no duplicate). This is the
    /// AT-D/AT-F3 per-tick entry point, so it MUST be safe to call repeatedly.
    #[tokio::test]
    async fn register_team_is_idempotent() {
        let (state, dir) = test_state().await;

        let first = insert_unique(&state, "alpha", "team", Some("alpha"))
            .await
            .unwrap();
        // Simulate a second register tick: get_by_team finds the existing board.
        let again = db::boards::get_by_team(&state.pool, "alpha")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.id, again.id, "same team → same board, never duplicated");
        assert_eq!(again.kind, "team");
        assert_eq!(again.team_name.as_deref(), Some("alpha"));

        // Only the main + this team board exist.
        let boards = db::boards::list(&state.pool).await.unwrap();
        assert_eq!(boards.len(), 2);
        assert_eq!(boards[0].id, MAIN_BOARD_ID, "main pinned first");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A team-board id is a STABLE slug of the team name (so AT-D/AT-F3 can derive
    /// it deterministically), reserving the `main` id.
    #[tokio::test]
    async fn team_board_id_is_a_stable_slug() {
        let (state, dir) = test_state().await;
        let b = insert_unique(&state, "Frontend Crew", "team", Some("Frontend Crew"))
            .await
            .unwrap();
        assert_eq!(b.id, "frontend-crew");

        // A second board whose slug collides gets a numeric suffix (no clobber).
        let c = insert_unique(&state, "frontend-crew", "team", Some("frontend-crew-2nd"))
            .await
            .unwrap();
        assert_ne!(b.id, c.id);
        assert!(c.id.starts_with("frontend-crew"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The slug never reuses the reserved `main` id.
    #[tokio::test]
    async fn slug_never_collides_with_main() {
        let (state, dir) = test_state().await;
        let b = insert_unique(&state, "main", "team", Some("main-team"))
            .await
            .unwrap();
        assert_ne!(b.id, MAIN_BOARD_ID, "a team named 'main' must not get id 'main'");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Per-board card scoping: a card created on a team board does NOT appear on
    /// the main board, but DOES appear in the "all" aggregate.
    #[tokio::test]
    async fn cards_scope_per_board_and_all_aggregates() {
        let (state, dir) = test_state().await;
        let team = insert_unique(&state, "alpha", "team", Some("alpha"))
            .await
            .unwrap();

        // One card on main, one on the team board.
        seed_card(&state, "MAIN-1", MAIN_BOARD_ID).await;
        seed_card(&state, "TEAM-1", &team.id).await;

        let main_cards = load_board_scoped(&state, MAIN_BOARD_ID, 0).await.unwrap();
        let main_ids: Vec<&str> = main_cards.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(main_ids, vec!["MAIN-1"], "main board shows only its card");

        let team_cards = load_board_scoped(&state, &team.id, 0).await.unwrap();
        let team_ids: Vec<&str> = team_cards.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(team_ids, vec!["TEAM-1"], "team board shows only its card");

        // The "all" aggregate (the cross-board overview) carries both, each tagged
        // with its board_id so the client can group by board.
        let all = super::super::load_board(&state, 0).await.unwrap();
        let all_ids: std::collections::HashSet<&str> =
            all.iter().map(|c| c.id.as_str()).collect();
        assert!(all_ids.contains("MAIN-1") && all_ids.contains("TEAM-1"));
        let team_card = all.iter().find(|c| c.id == "TEAM-1").unwrap();
        assert_eq!(team_card.board_id, team.id);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Deleting a team board cascades its cards (so the aggregate no longer shows
    /// them); the main board id is reserved as non-deletable at the API layer.
    #[tokio::test]
    async fn deleting_team_board_cascades_its_cards() {
        let (state, dir) = test_state().await;
        let team = insert_unique(&state, "alpha", "team", Some("alpha"))
            .await
            .unwrap();
        seed_card(&state, "TEAM-1", &team.id).await;
        assert!(db::boards::delete(&state.pool, &team.id).await.unwrap());
        let all = super::super::load_board(&state, 0).await.unwrap();
        assert!(all.iter().all(|c| c.id != "TEAM-1"), "cards cascade-deleted");
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    async fn seed_card(state: &AppState, id: &str, board_id: &str) {
        db::board::insert_issue(
            &state.pool,
            &db::board::NewIssue {
                id: id.to_string(),
                title: format!("issue {id}"),
                desc: String::new(),
                status: "todo".into(),
                session: None,
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
                board_id: board_id.to_string(),
                team_task_id: None,
            },
        )
        .await
        .expect("insert card");
    }
}
