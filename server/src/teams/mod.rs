//! Claude Code **Agent Teams** detection.
//!
//! A LEAD Claude session spawns N TEAMMATE sessions as tmux split-panes inside
//! the lead's window on supermux's process-pinned socket. Claude Code writes the
//! team's truth to disk under `~/.claude` (`teams/<team>/config.json`,
//! `tasks/<team>/NN.json`, `teams/<team>/inboxes/<member>.json`) REGARDLESS of
//! supermux. Teammate panes are NOT supermux-created → they have no hook token /
//! DB row, so their status CANNOT come from supermux hooks (they'd 401) — it is
//! derived entirely from those files.
//!
//! This module:
//!   * [`model`] — the on-disk schema + the supermux [`Team`]/[`Member`]/
//!     [`TeamTask`] DTO (the SSE + `GET /api/teams` wire shape).
//!   * [`scan`] — the pure file→`Team` parser (+ `%id` validation helper).
//!   * [`watcher`] — the background loop: FS-watch + slow safety poll, `%id`
//!     re-validation each tick, lead→supermux mapping, SSE broadcast.
//!   * [`router_for`] — `GET /api/teams` for the initial load.

pub mod board_sync;
pub mod model;
pub mod scan;
pub mod start;
pub mod watcher;

pub use model::{Member, MemberStatus, Team, TeamTask};
pub use start::{
    convert_to_team, start_team, ConvertToTeamInput, StartTeamInput, StartTeamResult,
};
pub use watcher::{scan_and_enrich, spawn};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

/// The teams sub-router (bearer-protected by `http::router`'s layer).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/teams", get(list_teams))
        // "Start a team": create + boot a Claude LEAD with Agent Teams
        // enabled for it + a seed prompt that forms the team. DISTINCT path from
        // `GET /api/teams` (the detected-teams list) so the two never collide.
        .route("/api/teams/start", post(start_team_handler))
        // Convert an EXISTING session into a team lead in
        // place. Distinct path from `/api/teams/start` so each endpoint has one
        // unambiguous contract (start = new lead row; convert = reuse a row).
        .route(
            "/api/teams/start-from-existing",
            post(convert_to_team_handler),
        )
        // Dismiss an UNMAPPED team card: park its on-disk config under
        // `.archived/` so the watcher stops surfacing it. The only way to clear a
        // team whose lead no longer maps to a live session (there's no session to
        // archive through the normal lifecycle).
        .route("/api/teams/{name}/dismiss", post(dismiss_team_handler))
        // Remove ONE teammate from supermux's team view (the trash icon on a
        // teammate chip/card). A LIVE teammate is killed (its tmux pane) THEN
        // dismissed; a dead/offline one is just dismissed. Supermux-side hide
        // only. Claude's config.json is never touched. `{agent_id}` is the
        // URL-encoded `"{name}@{team}"` id (contains `@`).
        .route(
            "/api/teams/{team_name}/members/{agent_id}",
            axum::routing::delete(remove_member_handler),
        )
        // The single global experimental gate. GET reads the current
        // value; PUT flips it. Default OFF (experimental + ~7× token cost).
        .route(
            "/api/settings/experimental/agent-teams",
            get(get_agent_teams).put(put_agent_teams),
        )
        .with_state(state)
}

/// `GET /api/teams` — the current detected-teams snapshot for the initial load
/// (the SSE `teams` event keeps it live thereafter). Same shape as the SSE
/// payload's `teams` array, wrapped in the dashboard's `{ ok, data }` envelope.
///
/// Performs a fresh scan + live `%id` validation so a hard reload never serves a
/// stale cached snapshot. Defensive: a scan that hits a malformed file skips
/// only that team (never errors the request).
async fn list_teams(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let teams = scan_and_enrich(&state).await;
    Ok(Json(json!({ "ok": true, "data": teams })))
}

/// `POST /api/teams/start` — create + boot a Claude LEAD session with
/// Agent Teams enabled for it and a seed prompt that instructs the lead to form a
/// team of N teammates working on the given goal. Returns 201 with the LEAD
/// `SessionView` so the UI can navigate to `/focus/<name>`; the TEAM CARD then
/// appears via detection once the lead has spawned its panes.
///
/// Body: `{ task, teammates?, model?, dir?, name? }` (see [`start::StartTeamInput`]).
/// `task` (the goal) is required; everything else is optional + defensively
/// clamped/sanitized in [`start::start_team`].
async fn start_team_handler(
    State(state): State<AppState>,
    Json(input): Json<start::StartTeamInput>,
) -> Result<impl IntoResponse, AppError> {
    let result = start::start_team(&state, input).await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "data": result }))))
}

/// `POST /api/teams/start-from-existing` — turn the
/// EXISTING session named in the body into a team lead in place. Returns 201
/// with the LEAD `SessionView` (the same supermux name; conversation context is
/// fresh because the env+settings only take effect at process launch).
///
/// Body: `{ name, task, teammates?, model? }` (see [`start::ConvertToTeamInput`]).
/// `name` + `task` are required; everything else is optional + clamped. The
/// existing row's `dir` is authoritative — the body intentionally has no
/// `dir` field so the user can't accidentally move the session.
///
/// Errors:
///   * 404 — `name` does not exist.
///   * 409 — the session is already a team lead / archived.
///   * 400 — bad name / empty task / non-Claude provider.
async fn convert_to_team_handler(
    State(state): State<AppState>,
    Json(input): Json<start::ConvertToTeamInput>,
) -> Result<impl IntoResponse, AppError> {
    let result = start::convert_to_team(&state, input).await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "data": result }))))
}

/// `POST /api/teams/{name}/dismiss` — park an unmapped team's on-disk config in
/// `.archived/` so the watcher stops surfacing it. DRY: the same
/// [`scan::archive_team_config`] move `sessions::lifecycle::archive` performs.
/// The helper already no-ops on empty/dot-prefixed/missing names (never moves an
/// arbitrary path), so the path segment needs no extra guarding here.
async fn dismiss_team_handler(Path(name): Path<String>) -> Result<impl IntoResponse, AppError> {
    scan::archive_team_config(&name).map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /api/teams/{team_name}/members/{agent_id}`: remove ONE teammate
/// from supermux's team view. Live teammate: kill its tmux pane THEN record the
/// dismissal (gone at once, no lingering dead chip). Dead/offline teammate: just
/// record the dismissal. Supermux-side hide only. Claude's `config.json` is
/// never edited (the invariant in [`model`]).
///
/// Responses:
///   * `{ ok: true }`: dismissed (idempotent; an already-gone member succeeds).
///   * 404: the team is unknown (no `~/.claude/teams/<team_name>/` on disk).
///   * the kill error (e.g. 404/400 from [`lifecycle::kill_teammate_pane`]) when
///     a LIVE teammate's pane kill FAILS, in which case the dismissal is NOT
///     recorded, so a still-running agent is never silently hidden.
async fn remove_member_handler(
    State(state): State<AppState>,
    Path((team_name, agent_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    remove_member(&state, &team_name, &agent_id).await?;
    Ok(Json(json!({ "ok": true })))
}

/// The action [`remove_member`] must take, decided PURELY from the resolved team
/// snapshot. Split out from the I/O so the (team, member) → action policy is
/// unit-testable without a real scan or a live tmux.
#[derive(Debug, PartialEq, Eq)]
enum RemoveAction {
    /// The team is unknown → 404 (a genuinely absent on-disk team).
    UnknownTeam,
    /// The member has a LIVE pane on a mapped lead → kill it, THEN dismiss.
    KillThenDismiss { lead: String, pane_id: String },
    /// No live pane (offline / already gone / lead unmapped) → just dismiss.
    /// Also the idempotent path for a member no longer in the roster.
    DismissOnly,
}

/// Decide the removal action from the resolved team (or `None` when the team
/// name matched nothing this scan). A member is "live" only when BOTH its lead
/// maps to a supermux session AND it has a validated `%id` this tick; otherwise
/// there is nothing (and nowhere) to kill and we fall through to a plain dismiss.
fn decide_remove(team: Option<&Team>, agent_id: &str) -> RemoveAction {
    let Some(team) = team else {
        return RemoveAction::UnknownTeam;
    };
    if let Some(member) = team.members.iter().find(|m| m.agent_id == agent_id) {
        if let (Some(lead), Some(pane_id)) = (
            team.lead_supermux_session.as_deref(),
            member.tmux_pane_id.as_deref(),
        ) {
            return RemoveAction::KillThenDismiss {
                lead: lead.to_string(),
                pane_id: pane_id.to_string(),
            };
        }
    }
    RemoveAction::DismissOnly
}

/// Execute a decided [`RemoveAction`]: run the kill (for the live case) BEFORE
/// recording the dismissal, so a kill failure returns the error and leaves NO
/// dismissal behind (never hide a still-running agent). `kill` is injected so
/// the ordering guarantee is testable without a live tmux.
async fn execute_remove<F, Fut>(
    action: RemoveAction,
    pool: &sqlx::SqlitePool,
    team_name: &str,
    agent_id: &str,
    kill: F,
) -> Result<(), AppError>
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<(), AppError>>,
{
    match action {
        RemoveAction::UnknownTeam => {
            return Err(AppError::NotFound(format!("team '{team_name}'")));
        }
        RemoveAction::KillThenDismiss { lead, pane_id } => {
            // `?` short-circuits on a kill failure, so the dismiss below never runs.
            kill(lead, pane_id).await?;
        }
        RemoveAction::DismissOnly => {}
    }
    db::teams_dismissed::dismiss(pool, team_name, agent_id, chrono::Utc::now().timestamp()).await?;
    Ok(())
}

/// Resolve the team from the same scan the watcher uses, decide the action, then
/// execute it against the live tmux + DB. The thin I/O wrapper over the two pure
/// pieces above.
async fn remove_member(
    state: &AppState,
    team_name: &str,
    agent_id: &str,
) -> Result<(), AppError> {
    let teams = scan_and_enrich(state).await;
    let action = decide_remove(teams.iter().find(|t| t.team_name == team_name), agent_id);
    execute_remove(action, &state.pool, team_name, agent_id, |lead, pane_id| async move {
        crate::sessions::lifecycle::kill_teammate_pane(state, &lead, &pane_id).await
    })
    .await
}

/// `PUT /api/settings/experimental/agent-teams` body — `{ "enabled": bool }`.
#[derive(Debug, Deserialize)]
struct AgentTeamsToggle {
    enabled: bool,
}

/// `GET /api/settings/experimental/agent-teams` — `{ ok, data: { enabled } }`.
/// Reads the persisted [`db::prefs::AGENT_TEAMS_PREF_KEY`] (default OFF).
async fn get_agent_teams(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let enabled = db::prefs::agent_teams_enabled(&state.pool).await;
    Ok(Json(json!({ "ok": true, "data": { "enabled": enabled } })))
}

/// `PUT /api/settings/experimental/agent-teams` — persist the global toggle.
/// Takes effect on the NEXT session start (the env var + `teammateMode` are
/// injected at launch; already-running sessions are unaffected). Broadcasts an
/// SSE `settings` event so other tabs reconcile live (no poll).
async fn put_agent_teams(
    State(state): State<AppState>,
    Json(input): Json<AgentTeamsToggle>,
) -> Result<Json<serde_json::Value>, AppError> {
    db::prefs::set_agent_teams_enabled(&state.pool, input.enabled).await?;
    let _ = state.sse_tx.send(SseEvent {
        event: "settings".to_string(),
        payload: json!({ "key": db::prefs::AGENT_TEAMS_PREF_KEY, "enabled": input.enabled }),
    });
    Ok(Json(json!({ "ok": true, "data": { "enabled": input.enabled } })))
}

#[cfg(test)]
mod remove_member_tests {
    //! The remove-a-teammate endpoint's two pure seams: the (team, member) →
    //! action DECISION and the kill-then-dismiss ORDERING (a kill failure must
    //! leave no dismissal behind, and never hide a still-running agent).
    use super::*;
    use crate::config::Config;
    use crate::teams::model::{Member, MemberStatus, Team};

    async fn test_pool() -> (sqlx::SqlitePool, std::path::PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("supermux-remove-member-{}", uuid::Uuid::new_v4()));
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
        (pool, dir)
    }

    fn member(agent_id: &str, pane: Option<&str>) -> Member {
        Member {
            name: agent_id.split('@').next().unwrap_or(agent_id).to_string(),
            agent_id: agent_id.to_string(),
            model: "opus".into(),
            color: "blue".into(),
            tmux_pane_id: pane.map(str::to_string),
            is_active: pane.is_some(),
            status: if pane.is_some() {
                MemberStatus::Working
            } else {
                MemberStatus::Offline
            },
            cwd: String::new(),
        }
    }

    fn team(name: &str, lead: Option<&str>, members: Vec<Member>) -> Team {
        Team {
            team_name: name.to_string(),
            lead_session: "lead-uuid".into(),
            lead_supermux_session: lead.map(str::to_string),
            lead_cwd: String::new(),
            members,
            tasks: vec![],
        }
    }

    #[test]
    fn decide_unknown_team_is_404_action() {
        assert_eq!(decide_remove(None, "x@t"), RemoveAction::UnknownTeam);
    }

    #[test]
    fn decide_live_member_kills_then_dismisses() {
        let t = team(
            "session-37a40788",
            Some("Mobsters-United-Full"),
            vec![member("fix-644@session-37a40788", Some("%7"))],
        );
        assert_eq!(
            decide_remove(Some(&t), "fix-644@session-37a40788"),
            RemoveAction::KillThenDismiss {
                lead: "Mobsters-United-Full".into(),
                pane_id: "%7".into(),
            },
        );
    }

    #[test]
    fn decide_dead_member_dismiss_only_no_kill() {
        // Offline member (no %id) → dismiss only, even with a mapped lead.
        let t = team(
            "t",
            Some("host"),
            vec![member("fix-644@t", None)],
        );
        assert_eq!(decide_remove(Some(&t), "fix-644@t"), RemoveAction::DismissOnly);
    }

    #[test]
    fn decide_unmapped_lead_dismiss_only() {
        // A live %id but no supermux lead to address → nothing to kill.
        let t = team("t", None, vec![member("fix-644@t", Some("%7"))]);
        assert_eq!(decide_remove(Some(&t), "fix-644@t"), RemoveAction::DismissOnly);
    }

    #[test]
    fn decide_already_gone_member_dismiss_only() {
        // Member absent from the roster (already killed/dismissed) → idempotent
        // dismiss, never a 404.
        let t = team("t", Some("host"), vec![member("other@t", Some("%1"))]);
        assert_eq!(decide_remove(Some(&t), "fix-644@t"), RemoveAction::DismissOnly);
    }

    #[tokio::test]
    async fn execute_dismiss_only_records_without_killing() {
        let (pool, dir) = test_pool().await;
        let mut killed = false;
        execute_remove(RemoveAction::DismissOnly, &pool, "t", "fix-644@t", |_, _| {
            killed = true;
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert!(!killed, "dismiss-only must not attempt a kill");
        assert_eq!(
            db::teams_dismissed::list_for_team(&pool, "t").await.unwrap(),
            vec!["fix-644@t"],
        );
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn execute_kill_then_dismiss_on_success() {
        let (pool, dir) = test_pool().await;
        let action = RemoveAction::KillThenDismiss {
            lead: "host".into(),
            pane_id: "%7".into(),
        };
        let mut seen: Option<(String, String)> = None;
        execute_remove(action, &pool, "t", "fix-644@t", |lead, pane| {
            seen = Some((lead, pane));
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert_eq!(seen, Some(("host".to_string(), "%7".to_string())));
        assert_eq!(
            db::teams_dismissed::list_for_team(&pool, "t").await.unwrap(),
            vec!["fix-644@t"],
            "a successful kill is followed by the dismissal",
        );
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn execute_kill_failure_blocks_dismiss() {
        let (pool, dir) = test_pool().await;
        let action = RemoveAction::KillThenDismiss {
            lead: "host".into(),
            pane_id: "%7".into(),
        };
        let res = execute_remove(action, &pool, "t", "fix-644@t", |_, _| async {
            Err(AppError::NotFound("no such pane".into()))
        })
        .await;
        assert!(res.is_err(), "a kill failure propagates as an error");
        assert!(
            db::teams_dismissed::list_for_team(&pool, "t").await.unwrap().is_empty(),
            "a still-running agent whose kill failed is NEVER dismissed",
        );
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn execute_unknown_team_is_404_and_no_dismiss() {
        let (pool, dir) = test_pool().await;
        let res = execute_remove(RemoveAction::UnknownTeam, &pool, "ghost", "x@ghost", |_, _| async {
            Ok(())
        })
        .await;
        assert!(matches!(res, Err(AppError::NotFound(_))));
        assert!(db::teams_dismissed::list_for_team(&pool, "ghost").await.unwrap().is_empty());
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
