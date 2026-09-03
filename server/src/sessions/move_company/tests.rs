//! Bot-move tests (`spec §7`), all thirteen cases.
//!
//! Each test is hermetic: it pins `CLAUDE_CONFIG_DIR` and `HOME` at temp dirs so
//! `project_dir_for` / `dirs::home_dir()` never touch the real home. Because those
//! are PROCESS-WIDE env vars, the tests serialize on [`ENV_LOCK`] (poison-tolerant
//! — a panicking test must not cascade-fail the rest).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::*;
use crate::auth_human::AuthContext;
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Acquire the process-env lock, tolerating a prior panic's poison.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// A unique temp base with `.claude/` and `home/` seeded, and the two env vars
/// pointed at them. Held for the whole test; `drop` restores nothing (each test
/// sets its own before use) but removes the tree.
struct Env {
    base: PathBuf,
}

impl Env {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("supermux-move-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join(".claude")).unwrap();
        std::fs::create_dir_all(base.join("home")).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", base.join(".claude"));
        std::env::set_var("HOME", base.join("home"));
        Env { base }
    }
    fn home(&self) -> PathBuf {
        self.base.join("home")
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // Best-effort: some tests chmod the projects dir read-only — restore it so
        // removal can proceed.
        let projects = self.base.join(".claude").join("projects");
        if projects.exists() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755));
        }
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

async fn mk_state(base: &Path) -> AppState {
    let config = crate::config::Config {
        swarm_reaper: Default::default(),
        data_dir: base.join("data"),
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
        company_isolation: Vec::new(),
        human_auth: Default::default(),
        extra_origins: Vec::new(),
    };
    std::fs::create_dir_all(&config.data_dir).unwrap();
    let pool = crate::db::init(&config).await.expect("init pool");
    AppState::new(pool, config)
}

/// Create company `slug` with a real temp `root_dir`; return `(id, root_dir)`.
async fn seed_company(state: &AppState, base: &Path, slug: &str) -> (i64, String) {
    let root = base.join("companies").join(slug);
    std::fs::create_dir_all(&root).unwrap();
    let root = root.display().to_string();
    let c = db::companies::create(&state.pool, slug, slug, &root)
        .await
        .unwrap();
    (c.id, root)
}

/// Seed a bot row with `dir` (created on disk) and `company_id` — the latter via
/// the new [`db::sessions::set_company_id`] helper, so the tests exercise it.
async fn seed_bot(state: &AppState, name: &str, dir: &str, company_id: Option<i64>) {
    std::fs::create_dir_all(dir).unwrap();
    db::sessions::insert_minimal(&state.pool, name, dir, "claude")
        .await
        .unwrap();
    db::sessions::set_company_id(&state.pool, name, company_id)
        .await
        .unwrap();
}

/// Write a one-line transcript for `dir` under the current `CLAUDE_CONFIG_DIR`,
/// with the given `cwd`. Returns the project dir it landed in.
fn seed_transcript(dir: &str, sid: &str, cwd: &str) -> PathBuf {
    let proj = super::project_dir_for("", dir);
    std::fs::create_dir_all(&proj).unwrap();
    let line = serde_json::json!({ "type": "user", "cwd": cwd, "msg": "hi" });
    std::fs::write(proj.join(format!("{sid}.jsonl")), format!("{line}\n")).unwrap();
    proj
}

/// Read the `cwd` field back out of the first transcript line.
fn read_cwd(proj: &Path, sid: &str) -> String {
    let content = std::fs::read_to_string(proj.join(format!("{sid}.jsonl"))).unwrap();
    let first = content.lines().next().unwrap();
    let v: serde_json::Value = serde_json::from_str(first).unwrap();
    v["cwd"].as_str().unwrap().to_string()
}

async fn row(state: &AppState, name: &str) -> db::sessions::Session {
    db::sessions::get(&state.pool, name).await.unwrap().unwrap()
}

// ── 1. HQ → company ──────────────────────────────────────────────────────────
#[tokio::test]
async fn hq_to_company_moves_dir_and_stamps_company() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;

    let old_dir = env.home().join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, None).await;
    seed_transcript(&old_dir, "s1", &std::fs::canonicalize(&old_dir).unwrap().display().to_string());

    let res = super::move_to_company(&state, "bot", Some(acme)).await.unwrap();
    assert!(res.ok && res.restart_required);

    let r = row(&state, "bot").await;
    let want = Path::new(&acme_root).join("bot").display().to_string();
    assert_eq!(r.company_id, Some(acme));
    assert_eq!(r.dir, want, "dir now under the company root");
    assert!(Path::new(&want).is_dir(), "the dir moved on disk");
    assert!(!Path::new(&old_dir).exists(), "old dir is gone");
    // Transcript rehomed under the NEW encoded path.
    let new_proj = super::project_dir_for("", &want);
    assert!(new_proj.join("s1.jsonl").exists(), "transcript rehomed");
    assert_eq!(res.moved_files, serde_json::json!("moved"));
}

// ── 2. company → company ─────────────────────────────────────────────────────
#[tokio::test]
async fn company_to_company_rehomes_and_rescopes() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    let res = super::move_to_company(&state, "bot", Some(beta)).await.unwrap();
    assert!(res.restart_required);

    let r = row(&state, "bot").await;
    let want = Path::new(&beta_root).join("bot").display().to_string();
    assert_eq!(r.company_id, Some(beta));
    assert_eq!(r.dir, want);
    assert!(Path::new(&want).is_dir());
    assert!(!Path::new(&old_dir).exists());
    // The old company is named in the honest warnings.
    assert!(
        res.warnings.iter().any(|w| w.contains(&format!("#{acme}"))),
        "leaves the old group chat, surfaced: {:?}",
        res.warnings
    );
}

// ── 3. company → HQ ──────────────────────────────────────────────────────────
#[tokio::test]
async fn company_to_hq_drops_scoping_and_homes_the_dir() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    let res = super::move_to_company(&state, "bot", None).await.unwrap();
    assert!(res.restart_required);

    let r = row(&state, "bot").await;
    let want = env.home().join("bot").display().to_string();
    assert_eq!(r.company_id, None, "confinement dropped");
    assert_eq!(r.dir, want, "dir homed under $HOME/<name>");
    assert!(Path::new(&want).is_dir());
    assert!(!Path::new(&old_dir).exists());
}

// ── 4. no-op ─────────────────────────────────────────────────────────────────
#[tokio::test]
async fn no_op_when_target_equals_current_company() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &dir, Some(acme)).await;

    let res = super::move_to_company(&state, "bot", Some(acme)).await.unwrap();
    assert!(res.ok && !res.restart_required, "no-op requires no restart");
    assert_eq!(res.moved_files, serde_json::json!("skipped"));

    // Zero writes: the row is untouched.
    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(acme));
    assert_eq!(r.dir, dir);
}

// ── 5. dest collision ────────────────────────────────────────────────────────
#[tokio::test]
async fn dest_collision_refuses_without_writes() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    // A DISTINCT occupant already sits at the destination.
    let dest = Path::new(&beta_root).join("bot");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("someone-elses.txt"), b"hi").unwrap();

    let err = super::move_to_company(&state, "bot", Some(beta)).await.unwrap_err();
    match &err {
        AppError::Conflict(m) => assert!(m.contains(&dest.display().to_string()), "names the path: {m}"),
        other => panic!("expected Conflict, got {other:?}"),
    }
    // No writes, both dirs intact.
    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(acme));
    assert_eq!(r.dir, old_dir);
    assert!(dest.join("someone-elses.txt").exists(), "destination untouched");
    assert!(Path::new(&old_dir).exists(), "source untouched");
}

// ── 6. archived target ───────────────────────────────────────────────────────
#[tokio::test]
async fn archived_target_is_refused() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;
    db::companies::set_archived(&state.pool, beta, true).await.unwrap();

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    let err = super::move_to_company(&state, "bot", Some(beta)).await.unwrap_err();
    match &err {
        AppError::Conflict(m) => assert!(m.contains("archived"), "{m}"),
        other => panic!("expected Conflict(archived), got {other:?}"),
    }
    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(acme), "no write on refusal");
}

// ── 7. own-slug credential-leak drop ─────────────────────────────────────────
#[tokio::test]
async fn leaking_own_slug_connector_grant_is_revoked_global_kept() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    // Two connectors: one wired to an ACME-scoped account (leaks), one to a
    // GLOBAL/HQ account (kept).
    db::connectors::upsert(&state.pool, "notion", "mcp_catalog", "Notion", "", "", "[]", "[]", "{}", "{}").await.unwrap();
    db::connectors::upsert(&state.pool, "slack", "mcp_catalog", "Slack", "", "", "[]", "[]", "{}", "{}").await.unwrap();
    let acme_acct = db::connectors::account_add(&state.pool, "notion", "notion@acme", None, Some(acme)).await.unwrap();
    let global_acct = db::connectors::account_add(&state.pool, "slack", "slack@hq", None, None).await.unwrap();
    db::connectors::grant_with_account(&state.pool, "bot", "notion", None, true, Some(&acme_acct)).await.unwrap();
    db::connectors::grant_with_account(&state.pool, "bot", "slack", None, true, Some(&global_acct)).await.unwrap();

    let res = super::move_to_company(&state, "bot", Some(beta)).await.unwrap();

    // The acme-account grant is dropped and listed with its display name.
    assert_eq!(res.dropped_grants.len(), 1, "exactly the leaking grant");
    assert_eq!(res.dropped_grants[0].connector_id, "notion");
    assert_eq!(res.dropped_grants[0].connector_name, "Notion");

    // Verify against the DB: notion revoked, slack kept.
    let grants = db::connectors::grants_for_session(&state.pool, "bot").await.unwrap();
    let ids: Vec<&str> = grants.iter().map(|g| g.connector_id.as_str()).collect();
    assert!(!ids.contains(&"notion"), "leaking grant revoked");
    assert!(ids.contains(&"slack"), "global grant kept");
}

// ── 8. dead own-slug tab grant ───────────────────────────────────────────────
#[tokio::test]
async fn dead_own_slug_tab_grant_is_revoked_hq_tab_kept() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    // An ACME tab (dies on the move) and an HQ tab (global — kept), both granted
    // to the bot's own slug.
    db::browser_tabs::create(&state.pool, "tab_acme", "https://a.example", Some(acme), &[]).await.unwrap();
    db::browser_tabs::create(&state.pool, "tab_hq", "https://hq.example", None, &[]).await.unwrap();
    db::browser_tabs::grant(&state.pool, "tab_acme", "bot", true).await.unwrap();
    db::browser_tabs::grant(&state.pool, "tab_hq", "bot", true).await.unwrap();

    let res = super::move_to_company(&state, "bot", Some(beta)).await.unwrap();

    assert_eq!(res.dead_tab_grants.len(), 1, "only the acme-tab grant dies");
    assert_eq!(res.dead_tab_grants[0].tab_id, "tab_acme");

    // DB: acme-tab grant gone, hq-tab grant kept.
    let acme_grants = db::browser_tabs::grants_for_tab(&state.pool, "tab_acme").await.unwrap();
    assert!(acme_grants.iter().all(|g| g.grantee != "bot"), "acme-tab own grant revoked");
    let hq_grants = db::browser_tabs::grants_for_tab(&state.pool, "tab_hq").await.unwrap();
    assert!(hq_grants.iter().any(|g| g.grantee == "bot"), "hq-tab own grant kept");
}

// ── 9. transcript rehome + cwd rewrite ───────────────────────────────────────
#[tokio::test]
async fn transcript_is_rehomed_and_cwd_rewritten() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    let old_canonical = std::fs::canonicalize(&old_dir).unwrap().display().to_string();
    let old_proj = seed_transcript(&old_dir, "conv1", &old_canonical);
    assert!(old_proj.join("conv1.jsonl").exists());

    super::move_to_company(&state, "bot", Some(beta)).await.unwrap();

    let new_dir = Path::new(&beta_root).join("bot").display().to_string();
    let new_proj = super::project_dir_for("", &new_dir);
    assert!(new_proj.join("conv1.jsonl").exists(), "transcript at new encoded path");
    assert!(!old_proj.exists(), "old transcript dir gone");
    let new_canonical = std::fs::canonicalize(&new_dir).unwrap().display().to_string();
    assert_eq!(read_cwd(&new_proj, "conv1"), new_canonical, "cwd rewritten to the new dir");
}

// ── 10. rollback on a forced transcript failure ──────────────────────────────
#[tokio::test]
async fn rollback_reverses_fs_when_transcript_step_fails() {
    use std::os::unix::fs::PermissionsExt;
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    let old_canonical = std::fs::canonicalize(&old_dir).unwrap().display().to_string();
    let old_proj = seed_transcript(&old_dir, "conv1", &old_canonical);

    // Force the transcript rename to fail: make the `projects` dir read-only, so
    // renaming a child within it is denied (EACCES) — but the session-dir move
    // (under the writable company roots) has already happened and must be undone.
    let projects = env.base.join(".claude").join("projects");
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o555)).unwrap();

    let err = super::move_to_company(&state, "bot", Some(beta)).await.unwrap_err();
    assert!(matches!(err, AppError::Internal(_)), "{err:?}");

    // Restore so we can inspect / clean up.
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();

    // DB unchanged, and the session dir was reversed back to the old root.
    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(acme), "DB not committed");
    assert_eq!(r.dir, old_dir, "dir column unchanged");
    assert!(Path::new(&old_dir).exists(), "session dir reversed to old root");
    assert!(!Path::new(&beta_root).join("bot").exists(), "no dir left at the destination");
    assert!(old_proj.join("conv1.jsonl").exists(), "transcript still at old proj");
}

// ── 11. idempotent re-run of a partially-applied move ────────────────────────
#[tokio::test]
async fn idempotent_rerun_after_partial_move() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    // Simulate a crash AFTER the FS move but BEFORE the DB commit: the row still
    // says acme + old dir, but on disk the dir already sits at the beta root and
    // the old dir is gone.
    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    db::sessions::insert_minimal(&state.pool, "bot", &old_dir, "claude").await.unwrap();
    db::sessions::set_company_id(&state.pool, "bot", Some(acme)).await.unwrap();
    let new_dir = Path::new(&beta_root).join("bot");
    std::fs::create_dir_all(&new_dir).unwrap(); // dir already at destination
    // (old dir intentionally absent)

    let res = super::move_to_company(&state, "bot", Some(beta)).await.unwrap();
    assert_eq!(res.moved_files, serde_json::json!("skipped"), "fs move no-ops");
    assert!(res.restart_required);

    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(beta), "the DB catches up cleanly");
    assert_eq!(r.dir, new_dir.display().to_string());
}

// ── 12. member forbidden ─────────────────────────────────────────────────────
#[tokio::test]
async fn member_is_forbidden_from_moving_a_bot() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;
    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    let member = AuthContext::Human {
        user_id: 7,
        company_id: Some(acme),
        role: "member".into(),
    };
    // The Ok variant (`Json<Envelope>`) is not `Debug`, so match rather than
    // `unwrap_err`.
    match super::handler(
        axum::extract::State(state.clone()),
        crate::scope::OptCtx(Some(member)),
        axum::extract::Path("bot".to_string()),
        axum::Json(super::MoveInput { company_id: Some(beta) }),
    )
    .await
    {
        Err(AppError::Forbidden(_)) => {}
        Err(other) => panic!("expected Forbidden, got {other:?}"),
        Ok(_) => panic!("a member must be forbidden from moving a bot"),
    }

    // And nothing moved.
    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(acme));

    // The owner (no stamped ctx) is allowed through the same handler.
    let owner = super::handler(
        axum::extract::State(state.clone()),
        crate::scope::OptCtx(None),
        axum::extract::Path("bot".to_string()),
        axum::Json(super::MoveInput { company_id: Some(beta) }),
    )
    .await;
    assert!(owner.is_ok(), "owner may move");
    assert_eq!(row(&state, "bot").await.company_id, Some(beta));
}

// ── 13. busy pane moves without a kill ───────────────────────────────────────
#[tokio::test]
async fn busy_pane_moves_and_requires_restart_without_kill() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;

    // Stand in for a "live" pane: a cached isolation level the move must NOT tear
    // the process down over — it only invalidates the cache so the NEXT spawn
    // re-reads confinement. (The move never calls any stop/kill path.)
    state.isolation_applied.insert(
        "bot".to_string(),
        crate::isolation::IsolationLevel::None,
    );

    let res = super::move_to_company(&state, "bot", Some(beta)).await.unwrap();
    assert!(res.restart_required, "a live pane keeps the old cwd/inode until restart");

    // The move happened and the session STILL EXISTS (was not killed/deleted).
    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(beta));
    assert_eq!(r.dir, Path::new(&beta_root).join("bot").display().to_string());
    assert!(db::sessions::exists(&state.pool, "bot").await.unwrap(), "session not destroyed");
    // The isolation cache was invalidated (re-read on next spawn), not left stale.
    assert!(state.isolation_applied.get("bot").is_none(), "isolation cache invalidated");
}

// ── 14. a stopped bot whose dir was never created on disk ────────────────────
// Regression: the dir is created lazily on first start, so a STOPPED bot can have
// a row whose `dir` does not exist. The FS step must skip (not 500 on a cross-fs
// copy of a missing tree) while the DB still flips.
#[tokio::test]
async fn stopped_bot_with_no_dir_on_disk_moves_cleanly() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    // Row only — no `seed_bot`, so the directory is NEVER created on disk.
    let old_dir = Path::new(&acme_root).join("ghost").display().to_string();
    db::sessions::insert_minimal(&state.pool, "ghost", &old_dir, "claude").await.unwrap();
    db::sessions::set_company_id(&state.pool, "ghost", Some(acme)).await.unwrap();
    assert!(!Path::new(&old_dir).exists(), "precondition: nothing on disk");

    let res = super::move_to_company(&state, "ghost", Some(beta)).await.unwrap();
    assert!(res.ok && res.restart_required);
    assert_eq!(res.moved_files, serde_json::json!("skipped"), "no fs work");
    assert!(
        res.warnings.iter().any(|w| w.contains("not on disk yet")),
        "the skip is surfaced, never silent: {:?}",
        res.warnings
    );

    // The DB still moved.
    let r = row(&state, "ghost").await;
    let want = Path::new(&beta_root).join("ghost").display().to_string();
    assert_eq!(r.company_id, Some(beta));
    assert_eq!(r.dir, want, "dir column points at the new company root");
    assert!(!Path::new(&want).exists(), "no empty dir conjured at the destination");
}

// ── 15. cross-fs move + a FAILING commit must NOT lose the source ────────────
// The data-loss bug: the old code removed the source right after the copy, so a
// later DB failure left the directory gone. The source may only be removed AFTER
// the commit; a failed commit rolls back by deleting the DESTINATION copy.
#[tokio::test]
async fn cross_fs_move_keeps_the_source_when_the_commit_fails() {
    use std::sync::atomic::Ordering;
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    std::fs::write(Path::new(&old_dir).join("work.txt"), b"precious").unwrap();

    // Force the commit tx to fail mid-flight (the grant sweep needs this table),
    // and force step 1 down the cross-filesystem (EXDEV) branch.
    sqlx::query("DROP TABLE session_connectors").execute(&state.pool).await.unwrap();
    super::FORCE_EXDEV.store(true, Ordering::SeqCst);
    let out = super::move_to_company(&state, "bot", Some(beta)).await;
    super::FORCE_EXDEV.store(false, Ordering::SeqCst);

    let err = out.unwrap_err();
    assert!(matches!(err, AppError::Internal(_)), "{err:?}");

    // THE REGRESSION: the source directory and its contents survive.
    assert!(Path::new(&old_dir).is_dir(), "source dir NOT lost on a failed commit");
    assert_eq!(
        std::fs::read_to_string(Path::new(&old_dir).join("work.txt")).unwrap(),
        "precious",
        "source contents intact"
    );
    // And the half-applied destination copy was rolled back.
    assert!(
        !Path::new(&beta_root).join("bot").exists(),
        "destination copy removed on rollback"
    );
    // DB unchanged (the tx is all-or-nothing).
    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(acme), "DB not committed");
    assert_eq!(r.dir, old_dir, "dir column unchanged");
}

// ── 16. cross-fs move that COMMITS removes the source (post-commit cleanup) ──
#[tokio::test]
async fn cross_fs_move_removes_the_source_after_a_successful_commit() {
    use std::sync::atomic::Ordering;
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, beta_root) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    std::fs::write(Path::new(&old_dir).join("work.txt"), b"precious").unwrap();
    std::fs::create_dir_all(Path::new(&old_dir).join("sub")).unwrap();
    std::fs::write(Path::new(&old_dir).join("sub").join("nested.txt"), b"deep").unwrap();
    let old_canonical = std::fs::canonicalize(&old_dir).unwrap().display().to_string();
    let old_proj = seed_transcript(&old_dir, "conv1", &old_canonical);

    super::FORCE_EXDEV.store(true, Ordering::SeqCst);
    let out = super::move_to_company(&state, "bot", Some(beta)).await;
    super::FORCE_EXDEV.store(false, Ordering::SeqCst);
    let res = out.unwrap();

    assert_eq!(res.moved_files, serde_json::json!({ "copied": 2 }), "both files copied");
    let new_dir = Path::new(&beta_root).join("bot");
    assert_eq!(
        std::fs::read_to_string(new_dir.join("work.txt")).unwrap(),
        "precious",
        "contents landed at the destination"
    );
    assert!(new_dir.join("sub").join("nested.txt").exists(), "nested tree copied");
    assert!(!Path::new(&old_dir).exists(), "source removed AFTER the commit");

    // The transcript rehome stayed consistent with the copy path.
    let new_proj = super::project_dir_for("", &new_dir.display().to_string());
    assert!(new_proj.join("conv1.jsonl").exists(), "transcript rehomed");
    assert!(!old_proj.exists(), "old transcript dir gone");
    assert_eq!(
        read_cwd(&new_proj, "conv1"),
        std::fs::canonicalize(&new_dir).unwrap().display().to_string(),
        "cwd rewritten"
    );

    let r = row(&state, "bot").await;
    assert_eq!(r.company_id, Some(beta));
    assert_eq!(r.dir, new_dir.display().to_string());
}

// ── 17. the pieces the two fixes hang on, unit-tested directly ───────────────
#[test]
fn copy_tree_treats_a_missing_source_as_nothing_to_copy() {
    let base = std::env::temp_dir().join(format!("supermux-move-unit-{}", uuid::Uuid::new_v4()));
    let src = base.join("never-created");
    let dst = base.join("dst");
    // A source that isn't on disk copies zero files instead of erroring with
    // ENOENT (the live 500: "cross-fs copy … No such file or directory").
    assert_eq!(super::copy_tree(&src, &dst).unwrap(), 0);
    assert!(super::verify_copy(&src, &dst).is_ok(), "0 == 0 verifies");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn cross_fs_source_is_removed_only_by_the_post_commit_finish() {
    let base = std::env::temp_dir().join(format!("supermux-move-unit-{}", uuid::Uuid::new_v4()));
    let src = base.join("src");
    let dst = base.join("dst");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("f.txt"), b"data").unwrap();
    assert_eq!(super::copy_tree(&src, &dst).unwrap(), 1);
    super::verify_copy(&src, &dst).unwrap();

    // A FAILED commit: the destination copy goes, the source stays.
    super::rollback_dir_move(super::DirMove::Copied, &dst, &src);
    assert!(!dst.exists(), "destination copy removed");
    assert!(src.join("f.txt").exists(), "source survives a failed commit");

    // A SUCCESSFUL commit: only now is the source removed.
    std::fs::create_dir_all(&dst).unwrap();
    super::finish_dir_move(super::DirMove::Copied, &src).unwrap();
    assert!(!src.exists(), "source removed post-commit");
    // Finishing a plain rename (or a no-op) never deletes anything.
    std::fs::create_dir_all(&src).unwrap();
    super::finish_dir_move(super::DirMove::Renamed, &src).unwrap();
    super::finish_dir_move(super::DirMove::None, &src).unwrap();
    assert!(src.exists(), "a rename needs no post-commit removal");
    // A double-finish (already-removed source) is not an error.
    std::fs::remove_dir_all(&src).unwrap();
    super::finish_dir_move(super::DirMove::Copied, &src).unwrap();

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn verify_copy_rejects_a_truncated_copy() {
    let base = std::env::temp_dir().join(format!("supermux-move-unit-{}", uuid::Uuid::new_v4()));
    let src = base.join("src");
    let dst = base.join("dst");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(src.join("f.txt"), b"full-size").unwrap();
    std::fs::write(dst.join("f.txt"), b"trunc").unwrap();
    assert!(super::verify_copy(&src, &dst).is_err(), "size mismatch is caught");
    let _ = std::fs::remove_dir_all(&base);
}

// ── 18. workflows.company_id follows the bot on a move (0038 §1 derived cache) ─
// A move re-stamps every workflow of the bot with the DESTINATION company, in
// the SAME tx as the `sessions` flip, so the derived cache can never diverge.
// Before this fix a moved bot's workflows kept their OLD scope and rendered
// under the wrong company (`ipc` → company 4 but its flow stuck in HQ).

/// Insert a workflow owned by `session`. `company_id` on the struct is IGNORED
/// and re-derived from `sessions` (see [`db::workflows::insert`]), so seed the
/// bot's company FIRST — the workflow then lands with the bot's company.
async fn seed_workflow(state: &AppState, id: &str, session: &str, trigger_kind: &str) {
    // `recurring`/`once` require a non-null schedule_expr (CHECK in 0038);
    // `manual` requires a null one.
    let (schedule_expr, next_run) = if trigger_kind == "manual" {
        (None, None)
    } else {
        (
            Some("0 9 * * *".to_string()),
            Some("2026-01-01T09:00:00Z".to_string()),
        )
    };
    db::workflows::insert(
        &state.pool,
        &db::workflows::Workflow {
            id: id.to_string(),
            title: "flow".into(),
            session: session.to_string(),
            company_id: Some(9999), // a lie; re-derived from sessions on insert
            enabled: 1,
            trigger_kind: trigger_kind.to_string(),
            schedule_expr,
            next_run,
            last_run: None,
            run_count: 0,
            on_complete: r#"{"kind":"none"}"#.into(),
            created: 1000,
            updated: 1000,
            deleted: None,
        },
    )
    .await
    .unwrap();
}

/// The `company_id` a single workflow currently carries.
async fn wf_company(state: &AppState, session: &str, id: &str) -> Option<i64> {
    db::workflows::list_for_session(&state.pool, session)
        .await
        .unwrap()
        .into_iter()
        .find(|w| w.id == id)
        .unwrap_or_else(|| panic!("workflow {id} not found for {session}"))
        .company_id
}

// (a) company → company re-stamps the workflow's cache to the destination.
#[tokio::test]
async fn move_restamps_workflow_company_id_company_to_company() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    seed_workflow(&state, "WF-aaaaaaaa", "bot", "manual").await;
    // Precondition: the workflow inherited the bot's company at insert.
    assert_eq!(wf_company(&state, "bot", "WF-aaaaaaaa").await, Some(acme));

    super::move_to_company(&state, "bot", Some(beta)).await.unwrap();

    assert_eq!(
        wf_company(&state, "bot", "WF-aaaaaaaa").await,
        Some(beta),
        "workflow cache re-stamped to the destination"
    );
    // Atomic invariant: the cache equals the committed `sessions.company_id`.
    assert_eq!(row(&state, "bot").await.company_id, Some(beta));
}

// (b) company → HQ re-stamps the workflow's cache to NULL.
#[tokio::test]
async fn move_restamps_workflow_company_id_company_to_hq() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    seed_workflow(&state, "WF-bbbbbbbb", "bot", "manual").await;
    assert_eq!(wf_company(&state, "bot", "WF-bbbbbbbb").await, Some(acme));

    super::move_to_company(&state, "bot", None).await.unwrap();

    assert_eq!(
        wf_company(&state, "bot", "WF-bbbbbbbb").await,
        None,
        "moving to HQ nulls the workflow cache"
    );
    assert_eq!(row(&state, "bot").await.company_id, None);
}

// (c) HQ → company re-stamps the workflow's cache from NULL to the company.
#[tokio::test]
async fn move_restamps_workflow_company_id_hq_to_company() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;

    let old_dir = env.home().join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, None).await;
    seed_workflow(&state, "WF-cccccccc", "bot", "manual").await;
    assert_eq!(wf_company(&state, "bot", "WF-cccccccc").await, None);

    super::move_to_company(&state, "bot", Some(beta)).await.unwrap();

    assert_eq!(
        wf_company(&state, "bot", "WF-cccccccc").await,
        Some(beta),
        "an HQ bot's workflow gains the destination company"
    );
    assert_eq!(row(&state, "bot").await.company_id, Some(beta));
}

// (d) MULTI-workflow (incl. a schedule-kind row) all re-stamp; another bot's
//     workflow is untouched (keying is `WHERE session = ?`, not company-wide).
#[tokio::test]
async fn move_restamps_all_of_the_bots_workflows_only() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    seed_workflow(&state, "WF-d0000001", "bot", "manual").await;
    seed_workflow(&state, "WF-d0000002", "bot", "recurring").await; // schedule-kind
    seed_workflow(&state, "WF-d0000003", "bot", "once").await;

    // A DIFFERENT bot in the same company, which does NOT move.
    let other_dir = Path::new(&acme_root).join("other").display().to_string();
    seed_bot(&state, "other", &other_dir, Some(acme)).await;
    seed_workflow(&state, "WF-other01", "other", "manual").await;

    super::move_to_company(&state, "bot", Some(beta)).await.unwrap();

    for id in ["WF-d0000001", "WF-d0000002", "WF-d0000003"] {
        assert_eq!(
            wf_company(&state, "bot", id).await,
            Some(beta),
            "{id} re-stamped (schedule-kind rows included)"
        );
    }
    assert_eq!(
        wf_company(&state, "other", "WF-other01").await,
        Some(acme),
        "a bystander bot's workflow is never touched by another bot's move"
    );
}

// (e) A bot with ZERO workflows moves cleanly — the UPDATE is a no-op.
#[tokio::test]
async fn move_with_no_workflows_is_a_clean_no_op() {
    let _g = env_lock();
    let env = Env::new();
    let state = mk_state(&env.base).await;
    let (acme, acme_root) = seed_company(&state, &env.base, "acme").await;
    let (beta, _) = seed_company(&state, &env.base, "beta").await;

    let old_dir = Path::new(&acme_root).join("bot").display().to_string();
    seed_bot(&state, "bot", &old_dir, Some(acme)).await;
    assert_eq!(db::workflows::count_for_session(&state.pool, "bot").await.unwrap(), 0);

    let res = super::move_to_company(&state, "bot", Some(beta)).await.unwrap();
    assert!(res.restart_required);

    assert_eq!(row(&state, "bot").await.company_id, Some(beta), "the move still commits");
    assert_eq!(
        db::workflows::count_for_session(&state.pool, "bot").await.unwrap(),
        0,
        "no workflows conjured"
    );
}
