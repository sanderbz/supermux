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
    pub root_dir: String,
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
    Query(params): Query<ListParams>,
) -> Result<Json<Envelope<Vec<Company>>>, AppError> {
    let include_archived = params.archived.as_deref().map(is_truthy).unwrap_or(false);
    let rows = companies::list(&state.pool, include_archived).await?;
    Ok(ok(rows))
}

async fn get_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<Company>>, AppError> {
    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

async fn create_handler(
    State(state): State<AppState>,
    Json(input): Json<CreateCompanyInput>,
) -> Result<impl IntoResponse, AppError> {
    let slug = input.slug.trim();
    let display_name = input.display_name.trim();
    let root_dir = input.root_dir.trim();

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
    if root_dir.is_empty() {
        return Err(AppError::BadRequest("root_dir is required".into()));
    }
    // `root_dir` must be an absolute path — a company folder is a fixed jail
    // root, not a cwd-relative one.
    if !std::path::Path::new(root_dir).is_absolute() {
        return Err(AppError::BadRequest("root_dir must be an absolute path".into()));
    }
    if root_dir.bytes().any(|b| b == 0 || b == b'\n' || b == b'\r') {
        return Err(AppError::BadRequest("invalid root_dir (NUL / newline)".into()));
    }

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
    Path(id): Path<i64>,
    Json(input): Json<PatchCompanyInput>,
) -> Result<Json<Envelope<Company>>, AppError> {
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
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
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
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn root_under(dir: &std::path::Path, name: &str) -> String {
        dir.join(name).display().to_string()
    }

    #[tokio::test]
    async fn post_company_rejects_slug_colliding_with_session_slug() {
        let (state, dir) = test_state().await;
        // Seed a session slug "acme".
        crate::db::sessions::insert_minimal(&state.pool, "acme", "/tmp/acme", "shell")
            .await
            .unwrap();
        let r = create_handler(
            State(state.clone()),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                root_dir: root_under(&dir, "acme"),
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

        let r = delete_handler(State(state.clone()), Path(c.id)).await;
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
        let (state, dir) = test_state().await;
        let r = create_handler(
            State(state.clone()),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                root_dir: root_under(&dir, "acme"),
            }),
        )
        .await;
        assert!(r.is_ok(), "create should succeed");
        // The root_dir was mkdir'd.
        assert!(dir.join("acme").is_dir());

        // GET lists it.
        let listed = list_handler(State(state.clone()), Query(ListParams { archived: None }))
            .await
            .unwrap();
        assert_eq!(listed.data.len(), 1);
        let id = listed.data[0].id;

        // PATCH archived=1 hides it from the default list.
        patch_handler(
            State(state.clone()),
            Path(id),
            Json(PatchCompanyInput {
                display_name: None,
                archived: Some(true),
            }),
        )
        .await
        .unwrap();
        let default_list = list_handler(State(state.clone()), Query(ListParams { archived: None }))
            .await
            .unwrap();
        assert_eq!(default_list.data.len(), 0, "archived hidden by default");
        let with_archived = list_handler(
            State(state.clone()),
            Query(ListParams {
                archived: Some("1".into()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(with_archived.data.len(), 1, "included when asked");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
