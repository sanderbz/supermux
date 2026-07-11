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
    /// A malformed request → 400, and we write NOTHING: the `agent_id`'s embedded
    /// team suffix doesn't match this team, or no such member is in the roster.
    /// Either way, recording the dismissal would only persist a junk
    /// `(team_name, agent_id)` row that can never match a real member.
    Invalid(String),
    /// The member has a LIVE pane on a mapped lead → kill it, THEN dismiss.
    KillThenDismiss { lead: String, pane_id: String },
    /// The member IS in the roster but has no live pane / no mapped lead → just
    /// dismiss (the dead-offline-teammate case this whole feature targets). Also
    /// the ambiguous case a transient tmux hiccup can fake, which
    /// [`resolve_remove_action`] disambiguates with a fresh re-scan.
    DismissOnly,
}

/// Does `agent_id` (`"{name}@{team}"`) belong to `team_name`? The team is the
/// segment after the LAST `@` (member names are `@`-free, and team dir names are
/// sanitized so they never contain `@` either). A missing `@` or a mismatched
/// suffix means the caller addressed a member of a DIFFERENT team through this
/// team's URL — a junk request we must never persist as a dismissal.
fn agent_id_in_team(agent_id: &str, team_name: &str) -> bool {
    matches!(agent_id.rsplit_once('@'), Some((_, team)) if team == team_name)
}

/// Decide the removal action from the resolved team (or `None` when the team
/// name matched nothing this scan). A member is "live" only when BOTH its lead
/// maps to a supermux session AND it has a validated `%id` this tick; otherwise
/// there is nothing (and nowhere) to kill and we fall through to a plain dismiss.
fn decide_remove(team: Option<&Team>, agent_id: &str) -> RemoveAction {
    let Some(team) = team else {
        return RemoveAction::UnknownTeam;
    };
    // Reject a request whose `agent_id` belongs to a different team before it can
    // write a junk dismissal row keyed to a member that can never exist here.
    if !agent_id_in_team(agent_id, &team.team_name) {
        return RemoveAction::Invalid(format!(
            "agent_id '{agent_id}' does not belong to team '{}'",
            team.team_name
        ));
    }
    // Member absent from the CURRENT roster but agent_id is well-formed for this
    // team → idempotent DismissOnly, NOT a 400. The removal exit-animation keeps a
    // just-removed row briefly tappable, so a double-tap must not surface a
    // spurious "couldn't remove" error for an action that already succeeded.
    // Recording a dismissal for a same-team agent_id is harmless + idempotent; a
    // cross-team agent_id was already rejected as Invalid above.
    let Some(member) = team.members.iter().find(|m| m.agent_id == agent_id) else {
        return RemoveAction::DismissOnly;
    };
    if let (Some(lead), Some(pane_id)) = (
        team.lead_supermux_session.as_deref(),
        member.tmux_pane_id.as_deref(),
    ) {
        return RemoveAction::KillThenDismiss {
            lead: lead.to_string(),
            pane_id: pane_id.to_string(),
        };
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
        RemoveAction::Invalid(msg) => {
            // 400, and we record NOTHING — never persist a junk dismissal row.
            return Err(AppError::BadRequest(msg));
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

/// Resolve the removal action from a fresh scan, guarding against a transient
/// whole-tick tmux hiccup. A single missed tick can null a LIVE member's `%id`
/// ([`scan::validate_pane_ids`]) AND drop the lead→session mapping at the same
/// time, which would downgrade a genuinely-live teammate to
/// [`RemoveAction::DismissOnly`] and hide it FOR GOOD (dismissals don't
/// auto-re-arm) while its Claude pane keeps running. So whenever the first pass
/// would dismiss WITHOUT a kill, we re-run ONE fresh scan and take its decision:
/// a recovered pane routes to `KillThenDismiss`; a genuinely-gone member stays
/// `DismissOnly`. Only `DismissOnly` is ambiguous — `UnknownTeam` / `Invalid` /
/// `KillThenDismiss` are all returned as-is (a missing team or a cross-team
/// agent_id is a request-shape fact, unaffected by tmux churn; an absent
/// same-team member already resolves to the idempotent `DismissOnly`). `scan` is
/// injected so the guard is unit-testable without a live tmux/filesystem.
async fn resolve_remove_action<F, Fut>(team_name: &str, agent_id: &str, mut scan: F) -> RemoveAction
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Vec<Team>>,
{
    let teams = scan().await;
    let action = decide_remove(teams.iter().find(|t| t.team_name == team_name), agent_id);
    if !matches!(action, RemoveAction::DismissOnly) {
        return action;
    }
    // Ambiguous: the member is in the roster but looked offline this tick. A fresh
    // scan tells a genuinely-offline teammate apart from a one-tick tmux hiccup.
    let teams = scan().await;
    decide_remove(teams.iter().find(|t| t.team_name == team_name), agent_id)
}

/// Resolve the action (with the transient-hiccup re-scan guard), then execute it
/// against the live tmux + DB. The thin I/O wrapper over the pure pieces above.
async fn remove_member(state: &AppState, team_name: &str, agent_id: &str) -> Result<(), AppError> {
    let action = resolve_remove_action(team_name, agent_id, || scan_and_enrich(state)).await;
    execute_remove(
        action,
        &state.pool,
        team_name,
        agent_id,
        |lead, pane_id| async move {
            crate::sessions::lifecycle::kill_teammate_pane(state, &lead, &pane_id).await
        },
    )
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
    fn decide_absent_same_team_member_is_idempotent_dismiss() {
        // Member absent from the CURRENT roster but agent_id belongs to THIS team
        // → idempotent DismissOnly (a re-tap on a row that's already exiting), not
        // a 400. A cross-team agent_id is still rejected — see the 400 test below.
        let t = team("t", Some("host"), vec![member("other@t", Some("%1"))]);
        assert!(matches!(
            decide_remove(Some(&t), "fix-644@t"),
            RemoveAction::DismissOnly
        ));
    }

    #[test]
    fn decide_agent_id_wrong_team_is_400() {
        // The agent_id embeds a DIFFERENT team than the URL → 400, never a junk
        // cross-team dismissal row. Even though a same-named member exists here.
        let t = team(
            "session-A",
            Some("host"),
            vec![member("fix-644@session-A", Some("%7"))],
        );
        assert!(matches!(
            decide_remove(Some(&t), "fix-644@session-B"),
            RemoveAction::Invalid(_)
        ));
    }

    #[test]
    fn agent_id_in_team_matches_suffix() {
        assert!(agent_id_in_team("fix-644@session-A", "session-A"));
        assert!(!agent_id_in_team("fix-644@session-A", "session-B"));
        // No `@` at all → not addressable to any team.
        assert!(!agent_id_in_team("fix-644", "session-A"));
        // Only the trailing segment is the team (member names are `@`-free, but be
        // robust if one ever weren't).
        assert!(agent_id_in_team("odd@name@team", "team"));
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

    #[tokio::test]
    async fn execute_invalid_is_400_and_no_dismiss() {
        // A junk request (wrong team suffix / absent member) is a 400 that writes
        // NOTHING — no junk dismissal row survives.
        let (pool, dir) = test_pool().await;
        let mut killed = false;
        let res = execute_remove(
            RemoveAction::Invalid("bad".into()),
            &pool,
            "t",
            "fix-644@other",
            |_, _| {
                killed = true;
                async { Ok(()) }
            },
        )
        .await;
        assert!(matches!(res, Err(AppError::BadRequest(_))));
        assert!(!killed, "an invalid request never attempts a kill");
        assert!(
            db::teams_dismissed::list_for_team(&pool, "t").await.unwrap().is_empty(),
            "a junk request leaves no dismissal row behind",
        );
        pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── the transient-tmux-hiccup re-resolve guard (Fix: RACE) ──────────────────

    #[tokio::test]
    async fn reresolve_recovers_live_pane_after_transient_miss() {
        // First scan: a transient whole-tick tmux hiccup nulled the LIVE member's
        // pane AND dropped the lead mapping (the member is STILL in the roster) →
        // this pass would be DismissOnly and hide a running agent for good. Second
        // (fresh) scan: tmux recovered, pane + lead are back → KillThenDismiss.
        // The guard MUST take the recovered kill path.
        let scans = std::cell::Cell::new(0u32);
        let action = resolve_remove_action("t", "fix-644@t", || {
            let n = scans.get();
            scans.set(n + 1);
            async move {
                if n == 0 {
                    vec![team("t", None, vec![member("fix-644@t", None)])]
                } else {
                    vec![team("t", Some("host"), vec![member("fix-644@t", Some("%7"))])]
                }
            }
        })
        .await;
        assert_eq!(
            action,
            RemoveAction::KillThenDismiss { lead: "host".into(), pane_id: "%7".into() },
        );
        assert_eq!(scans.get(), 2, "a DismissOnly first pass triggers exactly one re-scan");
    }

    #[tokio::test]
    async fn reresolve_keeps_dismiss_when_still_offline() {
        // A genuinely dead teammate looks offline on BOTH scans → DismissOnly
        // stands (the re-scan just confirms it; it never invents a kill).
        let scans = std::cell::Cell::new(0u32);
        let action = resolve_remove_action("t", "fix-644@t", || {
            scans.set(scans.get() + 1);
            async move { vec![team("t", Some("host"), vec![member("fix-644@t", None)])] }
        })
        .await;
        assert_eq!(action, RemoveAction::DismissOnly);
        assert_eq!(scans.get(), 2, "DismissOnly is re-resolved exactly once");
    }

    #[tokio::test]
    async fn no_reresolve_when_first_pass_is_live() {
        // A live member on the first pass is unambiguous → no second scan.
        let scans = std::cell::Cell::new(0u32);
        let action = resolve_remove_action("t", "fix-644@t", || {
            scans.set(scans.get() + 1);
            async move { vec![team("t", Some("host"), vec![member("fix-644@t", Some("%7"))])] }
        })
        .await;
        assert_eq!(
            action,
            RemoveAction::KillThenDismiss { lead: "host".into(), pane_id: "%7".into() },
        );
        assert_eq!(scans.get(), 1, "a live first pass needs no re-scan");
    }

    #[tokio::test]
    async fn no_reresolve_when_first_pass_is_invalid() {
        // A cross-team agent_id is a request-shape fact (Invalid/400), unaffected
        // by tmux churn → no re-scan. (An absent SAME-team member is now the
        // idempotent DismissOnly path, covered separately.)
        let scans = std::cell::Cell::new(0u32);
        let action = resolve_remove_action("t", "fix-644@other", || {
            scans.set(scans.get() + 1);
            async move { vec![team("t", Some("host"), vec![member("fix-644@t", Some("%1"))])] }
        })
        .await;
        assert!(matches!(action, RemoveAction::Invalid(_)));
        assert_eq!(scans.get(), 1, "an Invalid first pass needs no re-scan");
    }
}
