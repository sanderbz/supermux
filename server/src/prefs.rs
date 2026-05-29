//! Snippets + keyboard-accessory groups CRUD.
//!
//! Two table-backed CRUDs consumed by the mobile composer:
//!   * `/api/snippets`    — saved-command picker.
//!   * `/api/kbd-groups`  — the swipeable accessory bar. Table-backed ONLY
//!     (the legacy "prefs-blob" alternative is removed).
//!
//! **First-GET seeding.** On the very first `GET /api/kbd-groups` (empty
//! table), the four default groups are inserted AND returned, so the frontend
//! never has to ship a hardcoded default that could drift from the backend.
//!
//! **Router-registry pattern.** [`router_for`] returns this module's
//! sub-router; `http::router` merges it under the bearer layer additively.

use axum::extract::{Path, State};
use axum::Json;
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

/// Build the prefs sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{get, patch};
    Router::new()
        .route("/api/snippets", get(snippets_list).post(snippets_create))
        .route(
            "/api/snippets/{id}",
            patch(snippets_patch).delete(snippets_delete),
        )
        // GET (list/seed), POST (add one), PUT (replace the whole ordered list —
        // the manage-sheet's single canonical write).
        .route(
            "/api/kbd-groups",
            get(kbd_list).post(kbd_create).put(kbd_replace),
        )
        .route("/api/kbd-groups/{id}", patch(kbd_patch).delete(kbd_delete))
        // Bare DELETE on the collection path is not exposed; deletions are by id.
        //
        // Generic key/value prefs. Account-wide settings that need to follow the
        // user across devices (e.g. overview sort + custom groups). The key set
        // is curated by [`is_known_pref_key`] so a typo or hostile client can't
        // fill the table with junk. PUT emits an `sse:prefs` event so other tabs
        // / devices reconcile live without a poll (anti-vision: WebSocket-only).
        .route(
            "/api/prefs/{key}",
            get(pref_get).put(pref_put),
        )
        .with_state(state)
}

// ── prefs (key/value) ────────────────────────────────────────────────────────

/// Allowlist of pref keys that may be read/written via `/api/prefs/:key`. New
/// keys MUST be added here — drift between client and server keys is then a
/// compile-time/test surface rather than a silent bag-of-strings.
fn is_known_pref_key(key: &str) -> bool {
    // `quick_keys` — the mobile quick-keys tap-to-send selection (an ordered id
    // list). Account-wide so the user's curated keys follow them phone↔desktop,
    // same rationale as `overview_layout`.
    matches!(key, "overview_layout" | "quick_keys")
}

/// Maximum bytes accepted for a single pref value. Generous (50 KB) — enough
/// for hundreds of sessions/groups in `overview_layout` — but bounded so a
/// runaway client can't grow the prefs table without limit.
const MAX_PREF_VALUE_BYTES: usize = 50 * 1024;

#[derive(Debug, Deserialize)]
struct PrefPutBody {
    /// Opaque string the client controls (typically JSON). Server stores it
    /// verbatim and never parses it — single source of truth lives in the UI.
    value: String,
}

/// `GET /api/prefs/:key` — `{ ok, data: { key, value: string | null } }`.
async fn pref_get(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    if !is_known_pref_key(&key) {
        return Err(AppError::NotFound(format!("pref {key}")));
    }
    let value = db::prefs::get_pref(&state.pool, &key).await?;
    Ok(Json(json!({
        "ok": true,
        "data": { "key": key, "value": value }
    })))
}

/// `PUT /api/prefs/:key` — body `{ value }`. Upserts the row and broadcasts an
/// SSE `prefs` event so peer tabs reconcile live (per the WebSocket-only
/// anti-vision; no polling).
async fn pref_put(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(input): Json<PrefPutBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    if !is_known_pref_key(&key) {
        return Err(AppError::NotFound(format!("pref {key}")));
    }
    if input.value.len() > MAX_PREF_VALUE_BYTES {
        return Err(AppError::BadRequest(format!(
            "value too large ({} bytes; max {})",
            input.value.len(),
            MAX_PREF_VALUE_BYTES
        )));
    }
    db::prefs::put_pref(&state.pool, &key, &input.value).await?;
    // Best-effort SSE fan-out so other tabs / devices reconcile without a poll.
    let _ = state.sse_tx.send(SseEvent {
        event: "prefs".to_string(),
        payload: json!({ "key": key, "value": input.value }),
    });
    Ok(Json(json!({
        "ok": true,
        "data": { "key": key, "value": input.value }
    })))
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

/// The four default accessory groups seeded on first GET. Each is
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
    // First read on an empty table seeds the defaults, then returns them.
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
struct KbdReplaceGroup {
    name: String,
    /// Length-4 array of `{label, key}` objects.
    keys: Vec<KbdKey>,
}

#[derive(Debug, Deserialize)]
struct KbdReplace {
    groups: Vec<KbdReplaceGroup>,
}

/// `PUT /api/kbd-groups` — replace the WHOLE ordered list in one transaction.
/// The manage-sheet funnels reorder / add / remove through this single
/// canonical write so the table is never observed half-edited. Returns the new
/// list (same envelope as `kbd_list`) so the client can reconcile its cache.
async fn kbd_replace(
    State(state): State<AppState>,
    Json(input): Json<KbdReplace>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut rows: Vec<(String, String)> = Vec::with_capacity(input.groups.len());
    for g in &input.groups {
        if g.name.trim().is_empty() {
            return Err(AppError::BadRequest("'name' is required".into()));
        }
        if g.keys.len() != 4 {
            return Err(AppError::BadRequest("a group must have exactly 4 keys".into()));
        }
        let keys_json = serde_json::to_string(&g.keys).unwrap_or_else(|_| "[]".into());
        rows.push((g.name.trim().to_string(), keys_json));
    }
    db::prefs::replace_kbd_groups(&state.pool, &rows).await?;
    let listing = db::prefs::list_kbd_groups(&state.pool).await?;
    Ok(Json(json!({ "ok": true, "data": listing })))
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
