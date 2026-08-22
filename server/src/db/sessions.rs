//! Session row access (`sessions` + `session_runtime` tables).
//!
//! Queries are runtime-checked (`sqlx::query_as::<_, T>`) rather than the
//! compile-time `query_as!` macro: the macro requires a live `DATABASE_URL` (or
//! a committed `.sqlx` offline cache) at build time, which would make the
//! orchestrator's hermetic `cargo build`/`cargo test` non-deterministic and add
//! a hidden coupling for every downstream query addition. The `FromRow`
//! structs still give us typed rows.

use serde::Serialize;
use sqlx::SqlitePool;

/// A row of the `sessions` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Session {
    pub name: String,
    /// Mutable human label (migration 0019). Empty on rows created before the
    /// column existed / via the test-only `insert_minimal`; callers fall back to
    /// `name`. The slug `name` stays the immutable identity.
    #[serde(default)]
    pub display_name: String,
    pub dir: String,
    pub desc: String,
    pub provider: String,
    pub flags: String,
    pub pinned: i64,
    pub archived: i64,
    pub auto_continue: i64,
    pub auto_continue_msg: String,
    pub rate_limit_resume_text: String,
    pub tags: String,
    pub creator: String,
    pub branch: String,
    pub worktree: i64,
    pub worktree_repo: String,
    pub mcp: String,
    pub created_at: i64,
    pub start_count: i64,
    pub last_started: i64,
    pub last_send: i64,
    pub last_send_text: String,
    pub task_summary: String,
    pub cc_session_name: String,
    pub cc_conversation_id: String,
    pub codex_session_id: String,
    pub start_error: String,
    /// The Claude team this session currently hosts (NULL when none). Populated
    /// by `teams::watcher` on each successful team→host resolution, consumed by
    /// `sessions::lifecycle::{archive,unarchive}` to move the team's on-disk
    /// config to / from `~/.claude/teams/.archived/` so an archived team can't
    /// shadow a new team that lands in the same cwd.
    pub team_name: Option<String>,
    /// FK into `hosts(id)` for remote sessions, `NULL` for local (migration
    /// 0018). The entire pre-remote-host fleet backfills to `NULL` so existing
    /// call sites that don't yet pass a host_id keep their local-only semantics.
    pub host_id: Option<i64>,
    /// The company this session belongs to (migration 0032), or `NULL` for a
    /// main/PA/tech-admin bot. A plain nullable filter attribute (no inline FK);
    /// the whole pre-companies fleet backfills to `NULL` = byte-identical
    /// behaviour. Fixed at create — there is no reassignment path.
    pub company_id: Option<i64>,
    /// The user's explicit identity-mark override (migration 0027), as
    /// `"<silhouette>:<hue>"`. `NULL` for every session that has never been
    /// rerolled — which is almost all of them: the face is DERIVED from the slug
    /// (`web/src/lib/roster-marks.ts`) and this column exists only so an
    /// explicit choice outlives a reload.
    pub mark_pin: Option<String>,
    /// Which terminal backend drives this session (migration 0024):
    /// `"tmux"` (the historical `supermux-<name>` tmux session) or `"native"`
    /// (the tmux-less pty holder in `sessions::native`). The whole pre-existing
    /// fleet backfills to `"tmux"` via the column DEFAULT, so every call site
    /// that resolves a runtime keeps its exact behaviour. Validated on create
    /// (`sessions::create`), never mutated afterwards — a session cannot switch
    /// backends under a live pane.
    #[serde(default)]
    pub runtime: String,
    /// This bot's own notification policy (migration 0028): `inherit` | `all` |
    /// `attention` | `off`. `#[serde(default)]` so a row read by a binary that
    /// predates the column still deserialises; `notify::NotifPolicy::parse`
    /// reads an empty or unrecognised value as `inherit`, which is the same
    /// thing the column DEFAULT gives every backfilled row.
    #[serde(default)]
    pub notif: String,
    /// Cross-device seen cursor (migration 0029) — server-clock **ms** at which
    /// this session was last read. `None` = never seen, which `tierFor`
    /// already treats as "not unread".
    #[serde(default)]
    pub seen_ts: Option<i64>,
    /// `chat_tail.entry_count` when [`Self::seen_ts`] was recorded — the SEQ
    /// domain, not the ring length.
    #[serde(default)]
    pub seen_count: Option<i64>,
    /// The chat-store epoch [`Self::seen_count`] was recorded under. Counts are
    /// only comparable within one epoch; across a mismatch the client renders a
    /// dot rather than a number.
    #[serde(default)]
    pub seen_epoch: Option<i64>,
    /// The launch-line model selection (migration 0030), e.g. `"opus"`. Injected
    /// as `--model <id>` at launch (`sessions::lifecycle::build_launch_command`).
    /// ALLOWLIST-validated on every write (create / config PATCH), so a value on
    /// record is already one of the provider's accepted ids; empty = provider
    /// default (the whole pre-0030 fleet). `#[serde(default)]` so a binary that
    /// predates the column still deserialises.
    #[serde(default)]
    pub model: String,
    /// The bot's "Notes it keeps" (migration 0030): free text injected READ-ONLY
    /// into the agent's system prompt at launch, after the role (`desc`). v1 is
    /// read-only — the agent writing back here is a later phase. Empty for the
    /// whole pre-0030 fleet.
    #[serde(default)]
    pub memory: String,
    /// Reserved per-bot skills selection (migration 0030): a JSON-array string,
    /// `"[]"` by default. Nothing consumes it yet — carried so the column exists
    /// when per-bot skills land.
    #[serde(default)]
    pub skills: String,
    /// The shared-tier key for bot memory (migration 0031, provisioned by the
    /// connector phase): every bot with the same `role_id` sees the same
    /// `roles/<role_id>/` archival notes. `None` ⇒ private-only bot (recall reads
    /// only its own `bots/<name>/` tier). Consumed by
    /// [`crate::bot_memory`] / [`crate::sessions::connector_config`].
    #[serde(default)]
    pub role_id: Option<String>,
}

/// A row of the `session_runtime` table (ephemeral, persisted across restarts).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct SessionRuntime {
    pub name: String,
    pub rate_limit_reset_at: i64,
    pub hibernated: i64,
    pub restarting: i64,
    pub last_claude_alive_pid: i64,
    pub last_status: String,
    pub last_status_at: i64,
    pub last_capture: String,
    /// Same tail as `last_capture`, with SGR escapes preserved (colour-true
    /// preview source — see migration 0008). Empty until the first capture.
    #[serde(default)]
    pub last_capture_ansi: String,
    /// Per-session hook auth token. Never the dashboard bearer.
    pub hook_token: String,
}

/// List active (non-archived) sessions in the overview sort order.
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Session>> {
    sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE archived = 0 ORDER BY pinned DESC, last_send DESC, name ASC",
    )
    .fetch_all(pool)
    .await
}

/// List archived (soft-deleted) sessions, most-recently-touched first. The
/// mirror of [`list`] for the Archived sheet: `archive` only flips `archived = 1`
/// (never DELETEs), so every column survives and these rows are fully
/// restore-able. There is no `archived_at` column, so "most-recently-archived"
/// is approximated by the newest of the activity timestamps (a session is
/// usually archived right after its last send/start), with `name` as a stable
/// tiebreak.
pub async fn list_archived(pool: &SqlitePool) -> sqlx::Result<Vec<Session>> {
    sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE archived = 1 \
         ORDER BY MAX(last_send, last_started, created_at) DESC, name ASC",
    )
    .fetch_all(pool)
    .await
}

/// Live (non-archived) session name → last_status, for the board's per-card
/// status dot. One query joins `sessions` (the liveness filter) with
/// `session_runtime` (the status), so the board loader gets every card's dot
/// in O(1) round-trips instead of one probe per card. Sessions with no runtime
/// row default to `unknown`.
pub async fn live_statuses(
    pool: &SqlitePool,
) -> sqlx::Result<std::collections::HashMap<String, String>> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT s.name, r.last_status
           FROM sessions s
           LEFT JOIN session_runtime r ON r.name = s.name
          WHERE s.archived = 0",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(name, status)| (name, status.unwrap_or_else(|| "unknown".to_string())))
        .collect())
}

/// Fetch one session by name.
pub async fn get(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<Session>> {
    sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await
}

/// Fetch a session's runtime row.
pub async fn runtime(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<SessionRuntime>> {
    sqlx::query_as::<_, SessionRuntime>("SELECT * FROM session_runtime WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await
}

/// Insert a minimal session row (used by tests and as a building block for the
/// full `sessions::create` path). `created_at` is set to now.
pub async fn insert_minimal(
    pool: &SqlitePool,
    name: &str,
    dir: &str,
    provider: &str,
) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("INSERT INTO sessions (name, dir, provider, created_at) VALUES (?, ?, ?, ?)")
        .bind(name)
        .bind(dir)
        .bind(provider)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

/// Create or refresh the runtime row for `name`, storing `hook_token`.
pub async fn ensure_runtime(
    pool: &SqlitePool,
    name: &str,
    hook_token: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO session_runtime (name, hook_token) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET hook_token = excluded.hook_token",
    )
    .bind(name)
    .bind(hook_token)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete a session. `session_runtime` and child rows cascade via FK.
///
/// `schedules` does NOT — its `session` column is a bare `TEXT` with no foreign
/// key (`0003_schedules.sql`) — so the disposition is enforced in code here
/// (B5/T7.1). Without it a deleted session's schedules kept firing, failing,
/// and pushing an error notification to the user's phone every tick. Soft, so
/// the `schedule_runs` ledger (which DOES cascade) survives.
pub async fn delete(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    let disposed = super::schedules::soft_delete_for_session(pool, name).await?;
    if disposed > 0 {
        tracing::info!(session = %name, schedules = disposed, "disposed of schedules with their session");
    }
    sqlx::query("DELETE FROM sessions WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Permanently DELETE an ARCHIVED session row (the "Delete forever" path), in a
/// single guarded statement: `WHERE name = ? AND archived = 1`. Returns the
/// number of rows removed so the caller can refuse (404/409) when the row is
/// either missing or still live (`archived = 0`) — purge must never nuke a
/// running/visible session. `session_runtime` + child rows cascade via FK.
pub async fn purge_archived(pool: &SqlitePool, name: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM sessions WHERE name = ? AND archived = 1")
        .bind(name)
        .execute(pool)
        .await?;
    // Schedules have no FK to cascade on (see [`delete`]), so dispose of them
    // explicitly (B5/T7.1) — but only if the guarded DELETE actually removed
    // the row. A purge that raced an unarchive removes nothing, and must
    // therefore destroy nothing either.
    if res.rows_affected() > 0 {
        let disposed = super::schedules::soft_delete_for_session(pool, name).await?;
        if disposed > 0 {
            tracing::info!(session = %name, schedules = disposed, "disposed of schedules with their purged session");
        }
    }
    Ok(res.rows_affected())
}

/// Is this session row ARCHIVED (`archived = 1`)? Used by purge to refuse a
/// live session with a clean 409 (vs the row simply not existing → 404).
pub async fn is_archived(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<bool>> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT archived FROM sessions WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(a,)| a != 0))
}

/// All runtime rows, fetched once so [`list`] can join in-memory instead of an
/// N+1 per-session lookup.
pub async fn list_runtimes(pool: &SqlitePool) -> sqlx::Result<Vec<SessionRuntime>> {
    sqlx::query_as::<_, SessionRuntime>("SELECT * FROM session_runtime")
        .fetch_all(pool)
        .await
}

/// This bot's own notification setting (migration 0028).
///
/// Fails toward `Inherit`: a missing row, a DB error or a hand-edited junk
/// value must never silently mute a session. Read on every send, so it is one
/// indexed lookup on the primary key.
pub async fn notif_policy(pool: &SqlitePool, name: &str) -> crate::notify::NotifPolicy {
    let row: Option<(String,)> = sqlx::query_as("SELECT notif FROM sessions WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
    row.map(|(v,)| crate::notify::NotifPolicy::parse(&v))
        .unwrap_or(crate::notify::NotifPolicy::Inherit)
}

/// Set this bot's notification setting (the four-way in its detail sheet).
pub async fn set_notif_policy(
    pool: &SqlitePool,
    name: &str,
    policy: crate::notify::NotifPolicy,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET notif = ? WHERE name = ?")
        .bind(policy.as_str())
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Advance this session's seen cursor — **monotonically** (B5/T4.2).
///
/// The `WHERE seen_ts IS NULL OR seen_ts < ?` guard is the whole contract, and
/// it is enforced in SQL rather than read-modify-write on purpose: two devices
/// can PATCH concurrently, and a compare-in-Rust would have a window where the
/// older one wins. A cursor older than the stored one is a no-op, so a stale tab
/// waking up from sleep cannot un-read a session on the phone.
///
/// Returns whether a row was actually advanced, so the handler can report the
/// no-op honestly instead of implying a write.
pub async fn set_seen(
    pool: &SqlitePool,
    name: &str,
    ts: i64,
    count: Option<i64>,
    epoch: Option<i64>,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE sessions SET seen_ts = ?, seen_count = ?, seen_epoch = ?
         WHERE name = ? AND (seen_ts IS NULL OR seen_ts < ?)",
    )
    .bind(ts)
    .bind(count)
    .bind(epoch)
    .bind(name)
    .bind(ts)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Does a session row exist? Used for clean 404/409 mapping before mutating.
///
/// NOTE: an *archived* row still satisfies this (it is not DELETEd by
/// `archive`). Per-session background loops MUST use [`exists_active`] for their
/// lifetime check so an archived session terminates them.
pub async fn exists(pool: &SqlitePool, name: &str) -> sqlx::Result<bool> {
    let row = sqlx::query("SELECT 1 FROM sessions WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

/// Does a *live* (non-archived) session row exist? This is the lifetime anchor
/// for per-session background tasks (the 2s status detector and the steering
/// deliver loop): `archive` sets `archived = 1` without DELETEing the row, so a
/// guard on bare [`exists`] would never see an archived session as gone and the
/// loops would tick forever. Filtering on `archived = 0` makes an archived
/// session terminate its loops just like a deleted one.
pub async fn exists_active(pool: &SqlitePool, name: &str) -> sqlx::Result<bool> {
    let row = sqlx::query("SELECT 1 FROM sessions WHERE name = ? AND archived = 0")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

/// Config fields for a brand-new session (the tmux-free create path). Runtime
/// counters and timestamps default to 0; `created_at` is set by [`create`].
#[derive(Debug, Clone)]
pub struct NewSession {
    pub name: String,
    /// Human label shown in the UI (migration 0019). The create path defaults it
    /// to the slug when the client doesn't supply one.
    pub display_name: String,
    pub dir: String,
    pub desc: String,
    pub provider: String,
    pub creator: String,
    pub flags: String,
    /// JSON-array string (the `tags` column is a JSON array).
    pub tags: String,
    pub branch: String,
    pub mcp: String,
    pub worktree: bool,
    pub worktree_repo: String,
    /// FK into `hosts(id)` (migration 0018) for remote sessions; `None` = local.
    /// The full create path (CreateInput → NewSession → INSERT) carries this
    /// through so the API's `POST /api/sessions {host_id: N}` actually persists.
    pub host_id: Option<i64>,
    /// The company a new session is created into (migration 0032); `None` = a
    /// main bot. Carried CreateInput → NewSession → INSERT so the create path
    /// persists it in one INSERT.
    pub company_id: Option<i64>,
    /// Terminal backend for this session (migration 0024): `"tmux"` or
    /// `"native"`. Validated by `sessions::create` BEFORE it reaches here, so
    /// this is already one of the two literals. Mirrors `host_id`: the create
    /// path (CreateInput → NewSession → INSERT) carries it end-to-end.
    pub runtime: String,
    /// The launch-line model selection (migration 0030), already ALLOWLIST-mapped
    /// to a real provider model id by `sessions::create` before it reaches here
    /// (empty = provider default). Mirrors `runtime`: carried end-to-end so the
    /// create path persists it in one INSERT.
    pub model: String,
}

/// Insert a full session config row. `created_at` is set to now.
pub async fn create(pool: &SqlitePool, s: &NewSession) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO sessions
            (name, display_name, dir, desc, provider, creator, flags, tags, branch, mcp,
             worktree, worktree_repo, host_id, company_id, runtime, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.name)
    .bind(&s.display_name)
    .bind(&s.dir)
    .bind(&s.desc)
    .bind(&s.provider)
    .bind(&s.creator)
    .bind(&s.flags)
    .bind(&s.tags)
    .bind(&s.branch)
    .bind(&s.mcp)
    .bind(s.worktree as i64)
    .bind(&s.worktree_repo)
    .bind(s.host_id)
    .bind(s.company_id)
    .bind(&s.runtime)
    .bind(&s.model)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Read just the `runtime` column (migration 0024) for `name`. The runtime
/// resolver ([`crate::state::AppState::runtime_for`]) calls this on a cache
/// miss, so it stays a single narrow column read rather than a full row fetch.
/// `Ok(None)` = no such session row.
/// Durably set the session's runtime kind. Callers must also invalidate the
/// AppState runtime cache (`runtime_invalidate`) or the daemon keeps serving
/// the old backend until restart.
pub async fn set_runtime(pool: &SqlitePool, name: &str, runtime: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET runtime = ? WHERE name = ?")
        .bind(runtime)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn runtime_kind(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT runtime FROM sessions WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// Copy a session's CONFIG (not its runtime/counters) under `new_name`. Pinned
/// is reset and `created_at` refreshed; the caller seeds a fresh runtime row.
/// The clone's `display_name` is set to its own new slug (not the source's
/// label) so two sessions never share a confusing identical title.
///
/// The column list is EXPLICIT, not `SELECT *`, so a new column is opt-in: a
/// copy silently inheriting something it should not is worse than one missing a
/// field. `notif` (migration 0028) is opted in — a bot you have muted should
/// stay muted in its copy, which is what "a bot is its own template" means
/// (B5/T1.6). `mark_pin` (0027) likewise: §10 names "the copy carries the
/// avatar" as one of the reasons that column is persisted at all, and the
/// explicit column list had quietly omitted it (B5/T6.3).
pub async fn duplicate(pool: &SqlitePool, src: &str, new_name: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO sessions
            (name, display_name, dir, desc, provider, flags, pinned, auto_continue, auto_continue_msg,
             rate_limit_resume_text, tags, creator, branch, worktree, worktree_repo, mcp,
             host_id, company_id, runtime, notif, mark_pin, model, memory, skills, created_at)
         SELECT ?, ?, dir, desc, provider, flags, 0, auto_continue, auto_continue_msg,
                rate_limit_resume_text, tags, creator, branch, worktree, worktree_repo, mcp,
                host_id, company_id, runtime, notif, mark_pin, model, memory, skills, ?
         FROM sessions WHERE name = ?",
    )
    .bind(new_name)
    .bind(new_name)
    .bind(now)
    .bind(src)
    .execute(pool)
    .await?;
    Ok(())
}

/// Rename a session (its name is the PK and is referenced by several child
/// tables). Done in one transaction with `defer_foreign_keys` so the parent PK
/// and every child FK are updated atomically and only re-checked at COMMIT —
/// otherwise the immediate FK check would reject the parent update.
pub async fn rename(pool: &SqlitePool, old: &str, new: &str) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sessions SET name = ? WHERE name = ?")
        .bind(new)
        .bind(old)
        .execute(&mut *tx)
        .await?;
    for stmt in [
        "UPDATE session_runtime SET name = ? WHERE name = ?",
        "UPDATE tracked_files SET session = ? WHERE session = ?",
        "UPDATE steering_queue SET session = ? WHERE session = ?",
        "UPDATE issues SET session = ? WHERE session = ?",
        "UPDATE delegations SET from_session = ? WHERE from_session = ?",
        "UPDATE delegations SET to_session = ? WHERE to_session = ?",
        "UPDATE share_tokens SET session = ? WHERE session = ?",
        // schedules.session has NO foreign key (migrations/0003), so deferred-FK
        // does not auto-migrate it — a rename would otherwise orphan every job.
        "UPDATE schedules SET session = ? WHERE session = ?",
    ] {
        sqlx::query(stmt)
            .bind(new)
            .bind(old)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Set the human description.
pub async fn set_desc(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "desc", value).await
}
/// Set the mutable display label (migration 0019). The slug `name` is unchanged.
pub async fn set_display_name(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "display_name", value).await
}
/// Set the work directory.
pub async fn set_dir(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "dir", value).await
}
/// Set the git branch label.
pub async fn set_branch(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "branch", value).await
}
/// Set the MCP selection (`''` or `'chrome'`).
pub async fn set_mcp(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "mcp", value).await
}
/// Set the launch flags string (mode-shift bypass relaunch toggles
/// `--permission-mode bypassPermissions` on/off here before re-`start`-ing).
pub async fn set_flags(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "flags", value).await
}
/// Set the tags column (JSON-array string).
pub async fn set_tags(pool: &SqlitePool, name: &str, json: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "tags", json).await
}
/// Set the launch-line model selection (migration 0030). The value is
/// ALLOWLIST-mapped to a real provider model id by the caller
/// (`sessions::config_patch`) before it lands here, and injected as
/// `--model <id>` at the next launch — so a change takes effect on restart, not
/// under a live agent (the PATCH returns `restart_required`).
pub async fn set_model(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "model", value).await
}
/// Set the bot's "Notes it keeps" (migration 0030). Injected READ-ONLY into the
/// agent's system prompt at the next launch, so like `model`/`desc` a change is a
/// launch-line change (the PATCH returns `restart_required`).
pub async fn set_memory(pool: &SqlitePool, name: &str, value: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "memory", value).await
}
/// Set the reserved per-bot skills selection (migration 0030), a JSON-array
/// string. Nothing consumes it yet, so unlike model/memory it is NOT a
/// launch-line change.
pub async fn set_skills(pool: &SqlitePool, name: &str, json: &str) -> sqlx::Result<()> {
    set_text_field(pool, name, "skills", json).await
}

/// Set / clear the `team_name` backlink (None → NULL). NULL means "this session
/// does not currently host a team"; populated by `teams::watcher` whenever a
/// team's host-resolution lands on this session.
pub async fn set_team_name(
    pool: &SqlitePool,
    name: &str,
    value: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET team_name = ? WHERE name = ?")
        .bind(value)
        .bind(name)
        .execute(pool)
        .await
        .map(|_| ())
}

/// Clear the `team_name` backlink on every session that still points at `team`
/// EXCEPT `keep` (the currently-resolved host). Returns the number of rows
/// cleared so a caller can skip a no-op log.
///
/// Guards a mis-attribution → archive hazard: when host resolution MOVES a team
/// to a new session, the OLD host would otherwise keep `team_name` pointing at
/// the (still-live) team, and a later `lifecycle::archive` of that old session
/// would read the stale backlink and park the LIVE team's config under
/// `.archived/` — vanishing it from the UI. Idempotent + cheap: a steady-state
/// team (only its host points at it) matches 0 rows.
pub async fn clear_team_name_except(pool: &SqlitePool, team: &str, keep: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("UPDATE sessions SET team_name = NULL WHERE team_name = ? AND name <> ?")
        .bind(team)
        .bind(keep)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Read the `team_name` backlink. `Ok(None)` covers both "no such session" and
/// "session exists but no team mapped" — the caller treats both the same way.
pub async fn team_name(pool: &SqlitePool, name: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT team_name FROM sessions WHERE name = ?")
            .bind(name)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(v,)| v))
}

/// Internal: set one whitelisted TEXT column. The column name comes ONLY from the
/// fixed setters above (never user input), so the inlined identifier is safe.
async fn set_text_field(
    pool: &SqlitePool,
    name: &str,
    column: &str,
    value: &str,
) -> sqlx::Result<()> {
    let sql = format!("UPDATE sessions SET {column} = ? WHERE name = ?");
    sqlx::query(&sql)
        .bind(value)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set (or clear, with an empty string) the identity-mark override.
pub async fn set_mark_pin(pool: &SqlitePool, name: &str, value: Option<&str>) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET mark_pin = ? WHERE name = ?")
        .bind(value)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Flip the pinned flag.
pub async fn toggle_pin(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET pinned = 1 - pinned WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Flip the auto-continue flag.
pub async fn toggle_auto_continue(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET auto_continue = 1 - auto_continue WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

// ── lifecycle mutations ──────────────────────────────────────────────────────

/// Record a successful start: bump `start_count`, stamp `last_started = now`.
pub async fn bump_start(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE sessions SET start_count = start_count + 1, last_started = ? WHERE name = ?")
        .bind(now)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Cap on the stored last_send_text. SQLite TEXT has no schema constraint —
/// this is purely a payload bound: the recall popover/sheet shows the field
/// verbatim, and a runaway paste would otherwise puff every SSE `sessions`
/// delta. 8000 chars covers any realistic human prompt (~1200 words) without
/// punishing the wire on 100-session fleets.
pub const LAST_SEND_TEXT_MAX_CHARS: usize = 8000;

/// Record a send: stamp `last_send = now` and store the truncated preview text.
/// Returns the `(preview, now)` pair the caller can pass to `broadcast_send`
/// so the SSE delta matches what landed in the DB byte-for-byte.
pub async fn set_last_send(
    pool: &SqlitePool,
    name: &str,
    text: &str,
) -> sqlx::Result<(String, i64)> {
    let now = chrono::Utc::now().timestamp();
    let preview: String = text.chars().take(LAST_SEND_TEXT_MAX_CHARS).collect();
    sqlx::query("UPDATE sessions SET last_send = ?, last_send_text = ? WHERE name = ?")
        .bind(now)
        .bind(&preview)
        .bind(name)
        .execute(pool)
        .await?;
    Ok((preview, now))
}

/// Set the archived flag.
pub async fn set_archived(pool: &SqlitePool, name: &str, archived: bool) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET archived = ? WHERE name = ?")
        .bind(archived as i64)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Clear the Claude resume identifiers (used by the resume-picker fallback when
/// `--resume` gets stuck).
pub async fn clear_cc(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET cc_session_name = '', cc_conversation_id = '' WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set the Claude conversation id to resume on the next start (feat-resume-picker).
/// The launch builder turns a non-empty `cc_conversation_id` into
/// `claude --resume <id>`; clearing both is `clear_cc`.
pub async fn set_cc_conversation_id(
    pool: &SqlitePool,
    name: &str,
    id: &str,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET cc_session_name = '', cc_conversation_id = ? WHERE name = ?")
        .bind(id)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Track the LIVE Claude conversation id from a hook (`SessionStart` /
/// `UserPromptSubmit` carry it), WITHOUT touching `cc_session_name`. This keeps
/// "this session" prompt-recall pointed at the current transcript as Claude
/// rotates conversation files (a restart / `/clear` / compaction forks a new
/// `<uuid>.jsonl`), which `set_cc_conversation_id` (resume-only) never did — the
/// stale-recall bug. Conditional so a no-op hook doesn't write: only updates when
/// the id actually changed, and never blanks a known id with an empty hook value.
/// Returns whether a row was updated.
/// Drop the Claude conversation link (B5/T8 — the Reset rung).
///
/// Separate from [`track_cc_conversation_id`], which deliberately treats an
/// empty id as a no-op so a hook payload missing the field can never clobber a
/// good link. Reset needs the opposite: an EXPLICIT clear, so the next start
/// begins a fresh conversation instead of resuming into whatever was wedged.
/// Two callers, two intents, two functions — rather than a flag on one.
pub async fn clear_cc_conversation_id(pool: &SqlitePool, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE sessions SET cc_conversation_id = '' WHERE name = ?")
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn track_cc_conversation_id(
    pool: &SqlitePool,
    name: &str,
    id: &str,
) -> sqlx::Result<bool> {
    if id.is_empty() {
        return Ok(false);
    }
    let res = sqlx::query(
        "UPDATE sessions SET cc_conversation_id = ? \
         WHERE name = ? AND cc_conversation_id <> ?",
    )
    .bind(id)
    .bind(name)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Set the hibernated flag in `session_runtime` (cleared by `wake`).
pub async fn set_hibernated(pool: &SqlitePool, name: &str, hibernated: bool) -> sqlx::Result<()> {
    sqlx::query("UPDATE session_runtime SET hibernated = ? WHERE name = ?")
        .bind(hibernated as i64)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Write `session_runtime.last_capture` (+ the parallel ANSI-preserved capture) —
/// the canonical tile-tail-preview source. The detector loop calls this EVERY
/// 2s tick (classification or not). `capture` is ANSI-stripped (the status
/// detector regex bank reads it); `capture_ansi` keeps the SAME tail with its
/// SGR escapes intact so `SessionView.preview_ansi` can render colour-true.
pub async fn set_last_capture(
    pool: &SqlitePool,
    name: &str,
    capture: &str,
    capture_ansi: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE session_runtime SET last_capture = ?, last_capture_ansi = ? WHERE name = ?",
    )
    .bind(capture)
    .bind(capture_ansi)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(())
}

/// Set the live status + timestamp in `session_runtime`. The detector is the
/// usual writer; the lifecycle path sets `active`/`stopped` on start/stop so
/// the API reflects the lifecycle before the detector lands. Status must be a
/// `last_status` CHECK value.
pub async fn set_last_status(pool: &SqlitePool, name: &str, status: &str) -> sqlx::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "UPDATE session_runtime SET last_status = ?, last_status_at = ? WHERE name = ?",
    )
    .bind(status)
    .bind(now)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(())
}
