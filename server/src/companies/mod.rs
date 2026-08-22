//! Companies CRUD HTTP surface (migration `0032_companies.sql`).
//!
//! **Router-registry pattern.** [`router_for`] returns this module's sub-router;
//! [`crate::http::protected_router`] merges it under the bearer auth layer with
//! one `.merge(...)` line. Mounting under `/api/` is enough — `auth_middleware`
//! has no path carve-outs.
//!
//! **Scope.** Five routes wrap the `db::companies` surface:
//!   * `GET  /api/companies`        — list live companies (`?archived=1` includes archived).
//!   * `POST /api/companies`        — create ({slug, display_name, root_dir}); mkdir root_dir.
//!   * `GET  /api/companies/{id}`   — fetch one (404 on miss).
//!   * `PATCH /api/companies/{id}`  — set display_name and/or archived.
//!   * `DELETE /api/companies/{id}` — hard-delete; refuses (409) if active sessions remain.
//!
//! **Slug soft-reject.** A company slug lives in its own namespace and can never
//! collide with a `sessions.name` at the PK level, but for folder/URL legibility
//! the create handler additionally rejects (409) a slug equal to an existing
//! session slug.
//!
//! **Delete guard.** `DELETE` refuses while the company has any active
//! (non-archived) session; the `trg_company_delete_sessions` trigger then NULLs
//! any lingering (archived) sessions, but the `root_dir` folder on disk is NOT
//! removed — the response returns the retained path.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::db::companies::{self, Company};
use crate::error::AppError;
use crate::state::AppState;

/// Build the companies sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::get;
    Router::new()
        .route("/api/companies", get(list_handler).post(create_handler))
        .route(
            "/api/companies/{id}",
            get(get_handler).patch(patch_handler).delete(delete_handler),
        )
        .with_state(state)
}

// ── HTTP envelope ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

// ── validation ───────────────────────────────────────────────────────────────

/// `slug` rule: letters, digits, `_`, `.`, `-`, length 1..=64. No shell meta —
/// it becomes a folder-path segment and a URL segment.
static SLUG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9._-]{1,64}$").unwrap());

fn valid_slug(slug: &str) -> bool {
    SLUG_RE.is_match(slug)
}

/// The authoritative company-jail namespace root: `<projects_root>/companies`.
///
/// `<projects_root>` is the FIRST `SUPERMUX_PROJECT_DIRS` entry — the SAME notion
/// the files-repos handler (`files::projects_repos`) and the start-a-team
/// pre-fill (`static_assets`) already read, so there is one source of truth —
/// tilde-expanded. When the var is unset/empty we fall back to `$HOME` (and `/`
/// only if even that is unknown). Every company's `root_dir` is derived under
/// here (`<companies_root>/<slug>`) so a client can never supply an arbitrary
/// jail root.
fn companies_root() -> std::path::PathBuf {
    let projects_root = std::env::var("SUPERMUX_PROJECT_DIRS")
        .ok()
        .and_then(|s| s.split(':').next().map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| std::path::PathBuf::from(shellexpand::tilde(&s).into_owned()))
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    projects_root.join("companies")
}

// ── query / body types ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ListParams {
    /// `?archived=1` (or `true`/`yes`) includes archived companies. Absent =
    /// live only.
    #[serde(default)]
    archived: Option<String>,
}

fn is_truthy(v: &str) -> bool {
    matches!(v.trim(), "1" | "true" | "TRUE" | "yes" | "on")
}

#[derive(Debug, Deserialize)]
pub struct CreateCompanyInput {
    pub slug: String,
    pub display_name: String,
    /// **Ignored — never trusted.** The company jail root is derived
    /// AUTHORITATIVELY server-side as `<projects_root>/companies/<slug>` (see
    /// [`companies_root`] + [`create_handler`]), so a client can never point a
    /// company's jail at an arbitrary path. Kept optional purely so an older
    /// client may still send it as a hint; the value is discarded.
    #[serde(default)]
    pub root_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchCompanyInput {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
}

/// DELETE response body: the row is gone, but the `root_dir` folder is retained
/// on disk — hand the owner the path so they can remove it deliberately.
#[derive(Debug, Serialize)]
struct DeleteResult {
    deleted: bool,
    /// The retained on-disk `root_dir` (NOT removed by this delete).
    retained_root_dir: String,
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn list_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Query(params): Query<ListParams>,
) -> Result<Json<Envelope<Vec<Company>>>, AppError> {
    let include_archived = params.archived.as_deref().map(is_truthy).unwrap_or(false);
    let rows = companies::list(&state.pool, include_archived).await?;
    // P3d: a scoped MEMBER sees ONLY their own company (so the switcher shows just
    // theirs) — never the whole roster. Owner/admin (Scope::All) see everything.
    let rows = match crate::scope::Scope::of(ctx.0.as_ref()) {
        crate::scope::Scope::All => rows,
        crate::scope::Scope::Company(hc) => {
            rows.into_iter().filter(|c| c.id == hc).collect()
        }
    };
    Ok(ok(rows))
}

async fn get_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<Company>>, AppError> {
    // P3d: a member may fetch ONLY their own company; any other id is a uniform
    // 404 (byte-identical to a nonexistent id — no cross-company enumeration).
    if let crate::scope::Scope::Company(hc) = crate::scope::Scope::of(ctx.0.as_ref()) {
        if id != hc {
            return Err(AppError::NotFound(format!("company id={id}")));
        }
    }
    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

async fn create_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Json(input): Json<CreateCompanyInput>,
) -> Result<impl IntoResponse, AppError> {
    // P3d: creating a company is owner/admin-only company-management. A member is
    // refused with the uniform hide-existence 404.
    crate::scope::require_admin(ctx.0.as_ref(), "/api/companies")?;
    let slug = input.slug.trim();
    let display_name = input.display_name.trim();

    if slug.is_empty() {
        return Err(AppError::BadRequest("slug is required".into()));
    }
    if !valid_slug(slug) {
        return Err(AppError::BadRequest(
            "invalid slug (allowed: letters, digits, '_', '.', '-', 1..=64 chars)".into(),
        ));
    }
    if display_name.is_empty() {
        return Err(AppError::BadRequest("display_name is required".into()));
    }

    // AUTHORITATIVE derivation — the jail root is NEVER taken from the client
    // (`input.root_dir` is ignored). The slug is already unique + charset-validated,
    // so `<companies_root>/<slug>` is a safe, namespaced folder that a client can
    // never redirect. This closes the "client sets an arbitrary jail root"
    // weakness and namespaces companies under `<projects>/companies/`.
    let root_path = companies_root().join(slug);
    let root_dir = root_path.display().to_string();
    // Safety still applies to the FINAL derived path — a company folder is a fixed
    // absolute jail root, not a cwd-relative one.
    if !root_path.is_absolute() {
        return Err(AppError::BadRequest(
            "derived root_dir is not absolute (misconfigured SUPERMUX_PROJECT_DIRS)".into(),
        ));
    }
    if root_dir.bytes().any(|b| b == 0 || b == b'\n' || b == b'\r') {
        return Err(AppError::BadRequest("invalid root_dir (NUL / newline)".into()));
    }
    let root_dir = root_dir.as_str();

    // Slug soft-reject: never collide with an existing SESSION slug (folder /
    // URL legibility) — same 409 shape as a duplicate company slug.
    if crate::db::sessions::exists(&state.pool, slug).await? {
        return Err(AppError::Conflict(format!(
            "slug '{slug}' collides with an existing session slug — choose another"
        )));
    }
    // Duplicate company slug → clean 409 (instead of leaking the SQLite UNIQUE).
    if companies::get_by_slug(&state.pool, slug).await?.is_some() {
        return Err(AppError::Conflict(format!("company '{slug}' already exists")));
    }

    // mkdir the company root up front so the first agent lands in an existing
    // tree.
    std::fs::create_dir_all(root_dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("mkdir {root_dir}: {e}")))?;

    let created = match companies::create(&state.pool, slug, display_name, root_dir).await {
        Ok(c) => c,
        Err(sqlx::Error::Database(db_err)) if is_unique_violation(db_err.as_ref()) => {
            // Race lost the get_by_slug check — still a 409.
            return Err(AppError::Conflict(format!("company '{slug}' already exists")));
        }
        Err(e) => return Err(AppError::from(e)),
    };
    Ok((StatusCode::CREATED, ok(created)))
}

async fn patch_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
    Json(input): Json<PatchCompanyInput>,
) -> Result<Json<Envelope<Company>>, AppError> {
    // P3d: renaming/archiving a company is owner/admin-only.
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}"))?;
    // 404 if the row is gone.
    companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    if let Some(dn) = input.display_name.as_deref() {
        let dn = dn.trim();
        if dn.is_empty() {
            return Err(AppError::BadRequest("display_name cannot be empty".into()));
        }
        companies::set_display_name(&state.pool, id, dn).await?;
    }
    // Unarchive needs no fresh collision check: the slug is immutable and its
    // UNIQUE row survived archival, so it cannot have been re-created.
    if let Some(archived) = input.archived {
        companies::set_archived(&state.pool, id, archived).await?;
    }

    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

async fn delete_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    // P3d: deleting a company is owner/admin-only company-management.
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}"))?;
    let company = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    // Guard: refuse while any active (non-archived) session still belongs to
    // this company (parallels the archived-only purge guard on sessions).
    let active = companies::active_session_count(&state.pool, id).await?;
    if active > 0 {
        return Err(AppError::Conflict(format!(
            "company '{}' still has {active} active session(s) — archive or delete them first",
            company.slug
        )));
    }

    // The trigger NULLs any lingering (archived) sessions. The `root_dir` folder
    // on disk is deliberately NOT removed (data safety) — hand back the retained
    // path.
    companies::delete(&state.pool, id).await?;
    Ok(ok(DeleteResult {
        deleted: true,
        retained_root_dir: company.root_dir,
    }))
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// SQLite surfaces a `UNIQUE` violation through the generic `DatabaseError`
/// path; the cheapest match is on the message.
fn is_unique_violation(err: &dyn sqlx::error::DatabaseError) -> bool {
    let msg = err.message();
    msg.contains("UNIQUE constraint failed") || msg.contains("UNIQUE")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-companies-http-{}", uuid::Uuid::new_v4()));
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
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn root_under(dir: &std::path::Path, name: &str) -> String {
        dir.join(name).display().to_string()
    }

    /// Serializes the tests that mutate the process-global `SUPERMUX_PROJECT_DIRS`
    /// (the create handler now DERIVES `root_dir` from it), so parallel test
    /// threads don't clobber each other's env.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn post_company_rejects_slug_colliding_with_session_slug() {
        let (state, dir) = test_state().await;
        // Seed a session slug "acme".
        crate::db::sessions::insert_minimal(&state.pool, "acme", "/tmp/acme", "shell")
            .await
            .unwrap();
        let r = create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                root_dir: None,
            }),
        )
        .await;
        match r {
            Err(AppError::Conflict(_)) => {}
            other => panic!("expected Conflict, got {:?}", other.err()),
        }
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The SERVER derives `root_dir = <projects_root>/companies/<slug>` and
    /// IGNORES any client-supplied value — closing the "client picks an arbitrary
    /// jail root" weakness AND namespacing companies under `companies/`.
    #[tokio::test]
    async fn create_derives_root_dir_server_side_and_ignores_client_value() {
        let _env = ENV_LOCK.lock().unwrap();
        let (state, dir) = test_state().await;
        // Point the projects root at this test's isolated temp dir.
        std::env::set_var("SUPERMUX_PROJECT_DIRS", &dir);

        let created = create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                // A BOGUS client-supplied jail root — must NOT be honored.
                root_dir: Some("/home/supermux".into()),
            }),
        )
        .await
        .expect("create should succeed")
        .into_response();
        assert_eq!(created.status(), StatusCode::CREATED);

        // The stored + returned root_dir is the server-derived path, NOT the
        // client's bogus one.
        let want = dir.join("companies").join("acme").display().to_string();
        let listed = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams { archived: None }),
        )
        .await
        .unwrap();
        assert_eq!(listed.data.len(), 1);
        assert_eq!(listed.data[0].root_dir, want, "root_dir is server-derived");
        assert_ne!(listed.data[0].root_dir, "/home/supermux", "client value ignored");
        // The folder (and its `companies/` parent) were created under the namespace.
        assert!(dir.join("companies").join("acme").is_dir(), "namespaced folder mkdir'd");

        // The P0 dir-forcing (sessions::create) reads companies.root_dir from the
        // DB and joins `<name>` — so a company session lands under
        // `<projects>/companies/<slug>/<agent>`. Mirror that join here to pin the
        // shape the derived root produces (the forcing code itself is covered by
        // the `company_session_dir_is_forced_*` sessions tests).
        let agent_dir = std::path::Path::new(&listed.data[0].root_dir).join("bot-a");
        assert_eq!(
            agent_dir.display().to_string(),
            dir.join("companies").join("acme").join("bot-a").display().to_string(),
            "agent dir forced under <projects>/companies/<slug>/<agent>"
        );

        state.pool.close().await;
        std::env::remove_var("SUPERMUX_PROJECT_DIRS");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn delete_company_refused_when_active_sessions_present() {
        let (state, dir) = test_state().await;
        let c = companies::create(&state.pool, "acme", "Acme", &root_under(&dir, "acme"))
            .await
            .unwrap();
        // An active (archived=0) member session.
        crate::db::sessions::insert_minimal(&state.pool, "bot-a", "/tmp/bot-a", "shell")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = 'bot-a'")
            .bind(c.id)
            .execute(&state.pool)
            .await
            .unwrap();

        let r = delete_handler(State(state.clone()), crate::scope::OptCtx(None), Path(c.id)).await;
        match r {
            Err(AppError::Conflict(_)) => {}
            other => panic!("expected Conflict, got {:?}", other.err()),
        }
        // The row survives the refused delete.
        assert!(companies::get(&state.pool, c.id).await.unwrap().is_some());
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn create_then_list_roundtrip_over_http() {
        let _env = ENV_LOCK.lock().unwrap();
        let (state, dir) = test_state().await;
        std::env::set_var("SUPERMUX_PROJECT_DIRS", &dir);
        let r = create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                root_dir: None,
            }),
        )
        .await;
        assert!(r.is_ok(), "create should succeed");
        // The server-derived root_dir (`<projects>/companies/acme`) was mkdir'd.
        assert!(dir.join("companies").join("acme").is_dir());

        // GET lists it.
        let listed = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams { archived: None }),
        )
        .await
        .unwrap();
        assert_eq!(listed.data.len(), 1);
        let id = listed.data[0].id;

        // PATCH archived=1 hides it from the default list.
        patch_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Path(id),
            Json(PatchCompanyInput {
                display_name: None,
                archived: Some(true),
            }),
        )
        .await
        .unwrap();
        let default_list = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams { archived: None }),
        )
        .await
        .unwrap();
        assert_eq!(default_list.data.len(), 0, "archived hidden by default");
        let with_archived = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams {
                archived: Some("1".into()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(with_archived.data.len(), 1, "included when asked");

        state.pool.close().await;
        std::env::remove_var("SUPERMUX_PROJECT_DIRS");
        let _ = std::fs::remove_dir_all(dir);
    }
}
