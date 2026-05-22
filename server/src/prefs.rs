//! Snippets + keyboard-accessory groups CRUD (TECH_PLAN §3.4, §3.3; M9).
//!
//! Two table-backed CRUDs consumed by the mobile composer:
//!   * `/api/snippets`    — saved-command picker (§4.4.1).
//!   * `/api/kbd-groups`  — the swipeable accessory bar (§4.4.2). Table-backed
//!     ONLY (the v1 "prefs-blob" alternative is removed — Codex contradiction E).
//!
//! **First-GET seeding (§M9).** On the very first `GET /api/kbd-groups` (empty
//! table), the four default groups are inserted AND returned, so the frontend
//! never has to ship a hardcoded default that could drift from the backend.
//!
//! **Router-registry pattern (§3.4).** [`router_for`] returns this module's
//! sub-router; `http::router` merges it under the bearer layer additively.

use axum::extract::{Path, State};
use axum::Json;
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

/// Build the prefs sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, patch};
    Router::new()
        .route("/api/snippets", get(snippets_list).post(snippets_create))
        .route(
            "/api/snippets/{id}",
            patch(snippets_patch).delete(snippets_delete),
        )
        .route("/api/kbd-groups", get(kbd_list).post(kbd_create))
        .route("/api/kbd-groups/{id}", patch(kbd_patch).delete(kbd_delete))
        // Bare DELETE on the collection path is not exposed; deletions are by id.
        .with_state(state)
}

// ── snippets ─────────────────────────────────────────────────────────────────

async fn snippets_list(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows = db::prefs::list_snippets(&state.pool).await?;
    Ok(Json(json!({ "ok": true, "data": rows })))
}

#[derive(Debug, Deserialize)]
struct SnippetCreate {
    title: String,
    body: String,
    #[serde(default)]
    position: Option<i64>,
}

async fn snippets_create(
    State(state): State<AppState>,
    Json(input): Json<SnippetCreate>,
) -> Result<Json<serde_json::Value>, AppError> {
    if input.title.trim().is_empty() {
        return Err(AppError::BadRequest("'title' is required".into()));
    }
    let id = db::prefs::create_snippet(
        &state.pool,
        input.title.trim(),
        &input.body,
        input.position.unwrap_or(0),
    )
    .await?;
    Ok(Json(json!({ "ok": true, "id": id })))
}

#[derive(Debug, Deserialize)]
struct SnippetPatch {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    position: Option<i64>,
}

async fn snippets_patch(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<SnippetPatch>,
) -> Result<Json<serde_json::Value>, AppError> {
    if input.title.is_none() && input.body.is_none() && input.position.is_none() {
        return Err(AppError::BadRequest("no recognized field to patch".into()));
    }
    let changed = db::prefs::update_snippet(
        &state.pool,
        id,
        input.title.as_deref(),
        input.body.as_deref(),
        input.position,
    )
    .await?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("snippet {id}")));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn snippets_delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let removed = db::prefs::delete_snippet(&state.pool, id).await?;
    if removed == 0 {
        return Err(AppError::NotFound(format!("snippet {id}")));
    }
    Ok(Json(json!({ "ok": true })))
}

// ── kbd_groups ───────────────────────────────────────────────────────────────

/// The four default accessory groups seeded on first GET (§M9 / §4.4.2). Each is
/// `(name, [(label, tmux-key), …])`. `key` is the tmux `send-keys` token.
fn default_kbd_groups() -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    vec![
        (
            "Agent",
            vec![("Esc", "Escape"), ("Tab", "Tab"), ("Ctrl-C", "C-c"), ("Ctrl-U", "C-u")],
        ),
        ("Shell", vec![("~", "~"), ("/", "/"), ("|", "|"), ("&", "&")]),
        (
            "Tmux",
            vec![("Ctrl-B", "C-b"), ("p", "p"), ("n", "n"), ("d", "d")],
        ),
        ("Symbols", vec![("$", "$"), ("#", "#"), ("`", "`"), ("*", "*")]),
    ]
}

/// Serialize a group's keys as the `[{label,key}, …]` JSON the table stores.
fn keys_to_json(keys: &[(&str, &str)]) -> String {
    let arr: Vec<serde_json::Value> = keys
        .iter()
        .map(|(label, key)| json!({ "label": label, "key": key }))
        .collect();
    serde_json::Value::Array(arr).to_string()
}

/// Insert the four defaults (called once when the table is empty).
async fn seed_default_kbd_groups(state: &AppState) -> Result<(), AppError> {
    for (pos, (name, keys)) in default_kbd_groups().into_iter().enumerate() {
        db::prefs::create_kbd_group(&state.pool, name, &keys_to_json(&keys), pos as i64).await?;
    }
    Ok(())
}

async fn kbd_list(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    // First read on an empty table seeds the defaults, then returns them (§M9).
    if db::prefs::count_kbd_groups(&state.pool).await? == 0 {
        seed_default_kbd_groups(&state).await?;
    }
    let rows = db::prefs::list_kbd_groups(&state.pool).await?;
    Ok(Json(json!({ "ok": true, "data": rows })))
}

#[derive(Debug, Deserialize)]
struct KbdCreate {
    name: String,
    /// Length-4 array of `{label, key}` objects.
    keys: Vec<KbdKey>,
    #[serde(default)]
    position: Option<i64>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
struct KbdKey {
    label: String,
    key: String,
}

async fn kbd_create(
    State(state): State<AppState>,
    Json(input): Json<KbdCreate>,
) -> Result<Json<serde_json::Value>, AppError> {
    if input.name.trim().is_empty() {
        return Err(AppError::BadRequest("'name' is required".into()));
    }
    if input.keys.len() != 4 {
        return Err(AppError::BadRequest("a group must have exactly 4 keys".into()));
    }
    let keys_json = serde_json::to_string(&input.keys).unwrap_or_else(|_| "[]".into());
    let id =
        db::prefs::create_kbd_group(&state.pool, input.name.trim(), &keys_json, input.position.unwrap_or(0))
            .await?;
    Ok(Json(json!({ "ok": true, "id": id })))
}

#[derive(Debug, Deserialize)]
struct KbdPatch {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    keys: Option<Vec<KbdKey>>,
    #[serde(default)]
    position: Option<i64>,
}

async fn kbd_patch(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<KbdPatch>,
) -> Result<Json<serde_json::Value>, AppError> {
    if input.name.is_none() && input.keys.is_none() && input.position.is_none() {
        return Err(AppError::BadRequest("no recognized field to patch".into()));
    }
    if let Some(keys) = &input.keys {
        if keys.len() != 4 {
            return Err(AppError::BadRequest("a group must have exactly 4 keys".into()));
        }
    }
    let keys_json = input
        .keys
        .as_ref()
        .map(|k| serde_json::to_string(k).unwrap_or_else(|_| "[]".into()));
    let changed = db::prefs::update_kbd_group(
        &state.pool,
        id,
        input.name.as_deref(),
        keys_json.as_deref(),
        input.position,
    )
    .await?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("kbd-group {id}")));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn kbd_delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let removed = db::prefs::delete_kbd_group(&state.pool, id).await?;
    if removed == 0 {
        return Err(AppError::NotFound(format!("kbd-group {id}")));
    }
    Ok(Json(json!({ "ok": true })))
}
