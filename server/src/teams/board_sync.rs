//! Wire a detected team's on-disk tasks onto its OWN board.
//!
//! The boards entity + the idempotent register-team UPSERT exist elsewhere;
//! detection parses each team's `~/.claude/tasks/{team}/NN.json` files into
//! [`Team::tasks`]. This module is the missing wire between the two: every detect
//! tick it (1) registers a `kind='team'` board for each detected team and (2)
//! mirrors the team's task files onto that board as cards — a READ-THROUGH
//! mirror, file → board, idempotent across ticks.
//!
//! ## Why in-process, not self-HTTP
//! The watcher already holds the [`AppState`] (the pool + SSE tx), so it calls
//! the same `db::boards` / `board::boards` functions the HTTP handlers call —
//! no loopback request, no auth dance, no extra failure mode.
//!
//! ## The dedupe / link scheme (idempotency)
//! Each team card carries a STABLE backlink to the on-disk task it mirrors:
//! `issues.team_task_id` = the parsed task's `id`, UNIQUE per board (migration
//! 0016 `idx_issues_team_task (board_id, team_task_id)`). Reconcile is a 3-way
//! diff against that key:
//!   * a task with no card yet → INSERT a card (with `team_task_id` set);
//!   * a task whose card exists → PATCH only the fields that drifted
//!     (status/lane, title, description, assignee colour tag);
//!   * a card whose task vanished from the files → HARD-DELETE the card.
//! Re-running the same files is therefore a no-op (no duplicate cards).
//!
//! ## Lane mapping (task status → board lane)
//! The board's three fixed lanes are `todo|doing|done` (migration 0013). Tasks
//! map: `pending → todo`, `in_progress → doing`, `completed → done`; any other
//! / unknown status falls back to `todo` (defensive — an experimental schema
//! WILL drift). A user who manually drags a team card to a different lane will
//! see it snapped back on the next tick (the files are the source of truth);
//! board→file write-back is a documented follow-up (see module tail).
//!
//! ## Deregister policy (team ended)
//! Removing a team's board is driven by the WATCHER's consecutive-absence
//! counter — see [`super::watcher`]. This module exposes [`deregister_team`] for
//! it to call once a team has been absent for enough consecutive ticks that a
//! transient FS glitch is ruled out; deleting the board CASCADE-deletes its
//! cards.
//!
//! ## Defensive by construction
//! A task with an empty `id` is skipped (it has no stable key to mirror on). A
//! DB error on one team is logged and skipped — it never panics and never blocks
//! the other teams' sync or the SSE broadcast.

use crate::board::boards::{emit_boards, insert_unique};
use crate::db;
use crate::db::board::{IssueField, NewIssue};

use super::model::{Team, TeamTask};

/// Map an on-disk task status to one of the board's three fixed lanes
/// (`todo|doing|done`, migration 0013). Case-insensitive; anything unrecognised
/// (or empty) defends to `todo` so a drifted Claude schema never produces an
/// invalid lane that the board's `status` FK / lane filter would drop.
pub(crate) fn lane_for_status(status: &str) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "completed" | "done" | "complete" => "done",
        "in_progress" | "in-progress" | "doing" | "active" => "doing",
        _ => "todo", // pending + unknown
    }
}

/// The card title for a task: its `subject`, or a stable `Task <id>` fallback so
/// a subject-less task still renders a heading instead of a blank card.
fn card_title(task: &TeamTask) -> String {
    let subject = task.subject.trim();
    if subject.is_empty() {
        format!("Task {}", task.id.trim())
    } else {
        subject.to_string()
    }
}

/// The tag set carried onto a team card so the existing BoardCard renders the
/// assignee tinted by the teammate colour with no special-casing.
/// We piggy-back on the existing `issue_tags` surface: a `team:<assignee>` tag
/// and a `color:<color>` tag, derived from the task's assignee + that member's
/// configured colour. Empty values are dropped (no blank tags).
fn card_tags(team: &Team, task: &TeamTask) -> Vec<String> {
    let mut tags = Vec::new();
    let assignee = task.assigned_to.trim();
    if !assignee.is_empty() {
        tags.push(format!("team:{assignee}"));
        // Carry the teammate's colour so the card can tint by member.
        if let Some(color) = member_color(team, assignee) {
            if !color.trim().is_empty() {
                tags.push(format!("color:{}", color.trim()));
            }
        }
    }
    tags
}

/// The configured colour of the member an assignee string refers to (match on
/// member name OR `agent_id`), or `None` when unattributable.
fn member_color(team: &Team, assignee: &str) -> Option<String> {
    let a = assignee.trim();
    team.members
        .iter()
        .find(|m| m.name.trim().eq_ignore_ascii_case(a) || m.agent_id.trim().eq_ignore_ascii_case(a))
        .map(|m| m.color.clone())
}

/// Register (idempotently) a team's board and reconcile its cards from the
/// team's on-disk tasks. Called for every detected team on every watcher tick.
///
/// Returns `true` when the board or its cards changed (so the watcher can
/// re-publish the board over SSE once per tick rather than per-team). Errors are
/// swallowed-with-log here so one bad team never derails the others; the watcher
/// passes a `&AppState`.
pub async fn reconcile_team(state: &crate::state::AppState, team: &Team) -> bool {
    match reconcile_team_inner(state, team).await {
        Ok(changed) => changed,
        Err(e) => {
            tracing::debug!(team = %team.team_name, error = %e, "team board reconcile skipped");
            false
        }
    }
}

async fn reconcile_team_inner(
    state: &crate::state::AppState,
    team: &Team,
) -> Result<bool, crate::error::AppError> {
    // 1. Register the team board IDEMPOTENTLY (the start-team entry point, run
    //    in-process). get_by_team is the dedupe key (UNIQUE team_name backstop);
    //    a brand-new team gets a board whose id is a stable slug of its name.
    let mut changed = false;
    let board = match db::boards::get_by_team(&state.pool, &team.team_name).await? {
        Some(b) => b,
        None => {
            let b = insert_unique(state, &team.team_name, "team", Some(&team.team_name)).await?;
            emit_boards(state).await;
            changed = true;
            b
        }
    };

    // 2. Reconcile cards = 3-way diff on (board_id, team_task_id).
    let existing = db::board::team_cards_for_board(&state.pool, &board.id).await?;
    // The set of task ids the files currently describe (skip id-less tasks — no
    // stable key to mirror on).
    let mut desired_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for task in &team.tasks {
        let task_id = task.id.trim();
        if task_id.is_empty() {
            continue;
        }
        desired_ids.insert(task_id.to_string());

        let lane = lane_for_status(&task.status);
        let title = card_title(task);
        let desc = task.description.clone();
        let tags = card_tags(team, task);

        match db::board::get_team_card(&state.pool, &board.id, task_id).await? {
            // UPSERT: card exists → PATCH only the fields that drifted.
            Some(card) => {
                let mut fields: Vec<IssueField> = Vec::new();
                if card.status != lane {
                    fields.push(IssueField::Status(lane.to_string()));
                }
                if card.title != title {
                    fields.push(IssueField::Title(title));
                }
                if card.desc != desc {
                    fields.push(IssueField::Desc(desc));
                }
                if !fields.is_empty() {
                    db::board::patch_issue(&state.pool, &card.id, &fields).await?;
                    changed = true;
                }
                // Re-sync tags (assignee/colour) if they drifted. `tags_for`
                // returns them alphabetically, so compare order-insensitively
                // (a sorted clone of the desired set) — otherwise an identical
                // tag set in a different build order falsely reads as drift and
                // breaks idempotency.
                let current = db::board::tags_for(&state.pool, &card.id).await?;
                let mut desired_sorted = tags.clone();
                desired_sorted.sort();
                if current != desired_sorted {
                    db::board::set_tags(&state.pool, &card.id, &tags).await?;
                    changed = true;
                }
            }
            // INSERT: new task → a new card scoped to the team board, linked back
            // to the on-disk task so the next tick upserts instead of dupes.
            None => {
                let id = crate::board::prefix::next_id(&state.pool, &board_prefix(&team.team_name))
                    .await
                    .map_err(|e| crate::error::AppError::Internal(e.into()))?;
                let pos = db::board::min_pos_in_board_status(&state.pool, &board.id, lane).await?
                    - 1024.0;
                db::board::insert_issue(
                    &state.pool,
                    &NewIssue {
                        id: id.clone(),
                        title,
                        desc,
                        status: lane.to_string(),
                        session: None,
                        creator: String::new(),
                        due: None,
                        due_time: None,
                        owner_type: "agent".into(),
                        pos,
                        notified: 0,
                        board_id: board.id.clone(),
                        team_task_id: Some(task_id.to_string()),
                    },
                )
                .await?;
                if !tags.is_empty() {
                    db::board::set_tags(&state.pool, &id, &tags).await?;
                }
                changed = true;
            }
        }
    }

    // 3. Remove cards whose on-disk task disappeared from the files. A HARD
    //    delete (not soft) so the unique (board_id, team_task_id) row is freed —
    //    a re-created task with a reused id must be able to mirror cleanly.
    for card in existing {
        let Some(tid) = card.team_task_id.as_deref() else {
            continue;
        };
        if !desired_ids.contains(tid) {
            db::board::hard_delete(&state.pool, &card.id).await?;
            changed = true;
        }
    }

    Ok(changed)
}

/// A short, stable issue-id prefix for a team's cards, derived from the team
/// name (reuses the board prefix machinery so ids read `<TEAM>-N`).
fn board_prefix(team_name: &str) -> String {
    crate::board::prefix::prefix_from_session(Some(team_name))
}

/// Delete a team's board (and CASCADE its cards) when the team has ended. Called
/// by the watcher only after the team has been absent for enough consecutive
/// ticks to rule out a transient FS glitch (see [`super::watcher`]). Idempotent:
/// a team with no board is a clean no-op. Returns `true` when a board was
/// actually removed (so the watcher re-publishes the boards list + cards).
///
/// Also EVICTS the team's teammate pane-stream entries from the [`PtyStreamer`]
/// (resource hygiene): each teammate WS caches a per-pane `PtyStream` keyed by
/// `{team}/{member}` that is otherwise NEVER removed, so the
/// registry would grow unbounded across many team starts. We compute the SAME
/// `{team}/{member}` keys the WS uses and `forget` them — best-effort (a missing
/// config / already-gone key is a clean no-op) and scoped to teammate keys only,
/// so bare-session streams are untouched.
///
/// [`PtyStreamer`]: crate::ws::streamer::PtyStreamer
pub async fn deregister_team(state: &crate::state::AppState, team_name: &str) -> bool {
    match db::boards::get_by_team(&state.pool, team_name).await {
        Ok(Some(board)) => match db::boards::delete(&state.pool, &board.id).await {
            Ok(true) => {
                evict_teammate_streams(state, team_name);
                emit_boards(state).await;
                crate::board::emit_board(state).await;
                true
            }
            Ok(false) => false,
            Err(e) => {
                tracing::debug!(team = %team_name, error = %e, "team board deregister failed");
                false
            }
        },
        Ok(None) => false,
        Err(e) => {
            tracing::debug!(team = %team_name, error = %e, "team board deregister lookup failed");
            false
        }
    }
}

/// Evict the teammate pane-stream entries for an ended team from the PtyStreamer
/// (resource hygiene; see [`deregister_team`]). Reads the team's on-disk config
/// FRESH to recover its member keys, then forgets each `{team}/{member}` stream
/// key — the EXACT key the WS builds via `teams::teammate_stream_key`. Keying on
/// the stable team name (not the lead's `leadSessionId`, often a Claude UUID)
/// is what makes evict actually match the live entry. Best-effort: a deleted /
/// unreadable config (the common case for an ended team) just means nothing to
/// evict, and never panics. Only teammate `{team}/{member}` keys are touched —
/// the lead IS a normal session whose stream is owned by the session lifecycle.
fn evict_teammate_streams(state: &crate::state::AppState, team_name: &str) {
    let cfg = match crate::sessions::teams::read_team_config(team_name) {
        Ok(c) => c,
        Err(e) => {
            // Expected once the team's files are gone — nothing left to evict.
            tracing::debug!(team = %team_name, error = %e, "no team config to evict pane streams from");
            return;
        }
    };
    for member in &cfg.members {
        if let Some(key) = member.key() {
            // SAME key the WS builds via `teams::teammate_stream_key`: `{team}/{member}`.
            let stream_key = crate::sessions::teams::teammate_stream_key(team_name, key);
            state.forget_teammate_stream(&stream_key);
        }
    }
}

// ── write-back follow-up (OUT OF SCOPE) ──────────────────────────────
//
// This module mirrors file → board. The reverse (a user edits a team card on the board
// and supermux rewrites the agent's `~/.claude/tasks/{team}/NN.json`) is a
// DOCUMENTED FOLLOW-UP, not built here: it needs a safe write path into Claude's
// task files (lock-aware, schema-faithful, conflict-aware against the agent's
// own writes) plus the team→file status verbs. Until then a manual board edit on
// a team card is transient — the next tick re-mirrors from the files. The
// existing `/api/hook/board/*` claim/reply infra still works on a team card (it
// is an ordinary issue row), so agent→board signals already flow; only the
// board→file task-JSON rewrite is deferred.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::state::AppState;
    use std::path::PathBuf;

    async fn test_state() -> (AppState, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-teamsync-test-{}", uuid::Uuid::new_v4()));
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

    /// Build a minimal Team fixture (the parsed detector shape) for the sync tests.
    fn team_fixture(name: &str, tasks: Vec<TeamTask>) -> Team {
        use super::super::model::{Member, MemberStatus};
        Team {
            team_name: name.to_string(),
            lead_session: "lead".into(),
            lead_supermux_session: None,
            lead_cwd: String::new(),
            members: vec![Member {
                name: "alice".into(),
                agent_id: "alice@sq".into(),
                model: "opus".into(),
                color: "blue".into(),
                tmux_pane_id: Some("%1".into()),
                is_active: true,
                status: MemberStatus::Working,
                cwd: String::new(),
            }],
            tasks,
        }
    }

    fn task(id: &str, subject: &str, status: &str, assignee: &str) -> TeamTask {
        TeamTask {
            id: id.into(),
            subject: subject.into(),
            description: format!("desc for {id}"),
            status: status.into(),
            assigned_to: assignee.into(),
            blocks: vec![],
            blocked_by: vec![],
        }
    }

    #[test]
    fn lane_mapping_covers_the_three_lanes_and_defends_unknown() {
        assert_eq!(lane_for_status("pending"), "todo");
        assert_eq!(lane_for_status("in_progress"), "doing");
        assert_eq!(lane_for_status("completed"), "done");
        // Case-insensitive + drift-tolerant.
        assert_eq!(lane_for_status("IN_PROGRESS"), "doing");
        assert_eq!(lane_for_status("Completed"), "done");
        // Unknown / empty → todo (never an invalid lane).
        assert_eq!(lane_for_status("garbage"), "todo");
        assert_eq!(lane_for_status(""), "todo");
    }

    /// First reconcile creates the board + one card per task with the right lane;
    /// a SECOND reconcile of the SAME files is a no-op (no duplicate cards) — the
    /// idempotency property of this module.
    #[tokio::test]
    async fn reconcile_creates_then_is_idempotent() {
        let (state, dir) = test_state().await;
        let team = team_fixture(
            "alpha",
            vec![
                task("01", "build api", "in_progress", "alice"),
                task("02", "write docs", "pending", ""),
                task("03", "ship it", "completed", "alice"),
            ],
        );

        // 1st tick: board registered + 3 cards created, mapped to lanes.
        assert!(reconcile_team(&state, &team).await, "first tick changes state");
        let board = db::boards::get_by_team(&state.pool, "alpha")
            .await
            .unwrap()
            .expect("team board registered");
        assert_eq!(board.kind, "team");

        let cards = db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap();
        assert_eq!(cards.len(), 3, "one card per task");
        let lane = |tid: &str| {
            cards
                .iter()
                .find(|c| c.team_task_id.as_deref() == Some(tid))
                .map(|c| c.status.clone())
                .unwrap()
        };
        assert_eq!(lane("01"), "doing");
        assert_eq!(lane("02"), "todo");
        assert_eq!(lane("03"), "done");

        // 2nd tick on identical files: NO change, still exactly 3 cards.
        assert!(
            !reconcile_team(&state, &team).await,
            "re-tick on identical files is a no-op"
        );
        let cards2 = db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap();
        assert_eq!(cards2.len(), 3, "no duplicate cards on re-tick");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A task that moves status (file edit) PATCHes the existing card's lane in
    /// place — same card id, same team_task_id, no new row.
    #[tokio::test]
    async fn reconcile_patches_status_in_place() {
        let (state, dir) = test_state().await;
        let mut team = team_fixture("alpha", vec![task("01", "build", "pending", "alice")]);
        reconcile_team(&state, &team).await;
        let board = db::boards::get_by_team(&state.pool, "alpha")
            .await
            .unwrap()
            .unwrap();
        let card_id = db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap()[0]
            .id
            .clone();

        // The agent advances the task → in_progress.
        team.tasks[0].status = "in_progress".into();
        assert!(reconcile_team(&state, &team).await, "status drift changes state");

        let cards = db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap();
        assert_eq!(cards.len(), 1, "still one card (patched, not duplicated)");
        assert_eq!(cards[0].id, card_id, "same card id (in-place patch)");
        assert_eq!(cards[0].status, "doing", "lane followed the file");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A task that disappears from the files removes its card on the next tick
    /// (hard delete), leaving the survivors intact.
    #[tokio::test]
    async fn reconcile_removes_vanished_task_cards() {
        let (state, dir) = test_state().await;
        let team = team_fixture(
            "alpha",
            vec![
                task("01", "keep", "pending", "alice"),
                task("02", "drop", "pending", "alice"),
            ],
        );
        reconcile_team(&state, &team).await;
        let board = db::boards::get_by_team(&state.pool, "alpha")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            db::board::team_cards_for_board(&state.pool, &board.id)
                .await
                .unwrap()
                .len(),
            2
        );

        // Task 02 deleted from disk → only task 01 remains in the files.
        let shrunk = team_fixture("alpha", vec![task("01", "keep", "pending", "alice")]);
        assert!(reconcile_team(&state, &shrunk).await, "removal changes state");
        let cards = db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap();
        assert_eq!(cards.len(), 1, "vanished task's card removed");
        assert_eq!(cards[0].team_task_id.as_deref(), Some("01"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The assignee + teammate colour are carried onto the card as tags.
    #[tokio::test]
    async fn reconcile_carries_assignee_color_tags() {
        let (state, dir) = test_state().await;
        let team = team_fixture("alpha", vec![task("01", "build", "pending", "alice")]);
        reconcile_team(&state, &team).await;
        let board = db::boards::get_by_team(&state.pool, "alpha")
            .await
            .unwrap()
            .unwrap();
        let card = &db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap()[0];
        let tags = db::board::tags_for(&state.pool, &card.id).await.unwrap();
        assert!(tags.contains(&"team:alice".to_string()), "assignee tag present");
        assert!(tags.contains(&"color:blue".to_string()), "teammate colour tag present");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// deregister_team deletes the board + CASCADE its cards; a second call (or a
    /// call for an unknown team) is a clean no-op.
    #[tokio::test]
    async fn deregister_removes_board_and_cards_idempotently() {
        let (state, dir) = test_state().await;
        let team = team_fixture("alpha", vec![task("01", "x", "pending", "alice")]);
        reconcile_team(&state, &team).await;
        let board = db::boards::get_by_team(&state.pool, "alpha")
            .await
            .unwrap()
            .unwrap();
        let card_id = db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap()[0]
            .id
            .clone();

        assert!(deregister_team(&state, "alpha").await, "board removed");
        assert!(
            db::boards::get_by_team(&state.pool, "alpha")
                .await
                .unwrap()
                .is_none(),
            "board gone"
        );
        assert!(
            db::board::get_issue(&state.pool, &card_id)
                .await
                .unwrap()
                .is_none(),
            "card cascade-deleted"
        );

        // Idempotent: deregistering again (or an unknown team) is a no-op.
        assert!(!deregister_team(&state, "alpha").await);
        assert!(!deregister_team(&state, "never-existed").await);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Resource hygiene: evicting a team's teammate pane streams
    /// drops ONLY the `{team}/{member}` keys from the PtyStreamer — a bare SESSION
    /// stream (owned by the session lifecycle) is left untouched. This pins the
    /// fix for "teammate pane streams are cached forever, growing the registry
    /// unbounded across many team starts."
    #[tokio::test]
    async fn forget_teammate_stream_evicts_pane_keys_only() {
        let (state, dir) = test_state().await;

        // Seed two teammate pane streams under `{team}/{member}` keys + one bare
        // session stream (the registry slots a real run would create on attach).
        let _ = state.pty.for_pane("lead-x/worker-1", "%11");
        let _ = state.pty.for_pane("lead-x/worker-2", "%12");
        let _ = state.pty.for_session("lead-x");
        assert!(state.pty.is_cached("lead-x/worker-1"));
        assert!(state.pty.is_cached("lead-x/worker-2"));
        assert!(state.pty.is_cached("lead-x"), "bare session stream cached");

        // Evict the teammate keys (the deregister path's primitive).
        state.forget_teammate_stream("lead-x/worker-1");
        state.forget_teammate_stream("lead-x/worker-2");

        assert!(!state.pty.is_cached("lead-x/worker-1"), "teammate stream evicted");
        assert!(!state.pty.is_cached("lead-x/worker-2"), "teammate stream evicted");
        assert!(
            state.pty.is_cached("lead-x"),
            "bare session stream survives teammate eviction"
        );

        // Idempotent: a second evict (or an unknown key) is a clean no-op.
        state.forget_teammate_stream("lead-x/worker-1");
        state.forget_teammate_stream("never/existed");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An id-less task is skipped (no stable mirror key) and never creates a card.
    #[tokio::test]
    async fn reconcile_skips_idless_tasks() {
        let (state, dir) = test_state().await;
        let team = team_fixture(
            "alpha",
            vec![task("", "no id", "pending", "alice"), task("01", "ok", "pending", "alice")],
        );
        reconcile_team(&state, &team).await;
        let board = db::boards::get_by_team(&state.pool, "alpha")
            .await
            .unwrap()
            .unwrap();
        let cards = db::board::team_cards_for_board(&state.pool, &board.id)
            .await
            .unwrap();
        assert_eq!(cards.len(), 1, "only the task with a stable id became a card");
        assert_eq!(cards[0].team_task_id.as_deref(), Some("01"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
