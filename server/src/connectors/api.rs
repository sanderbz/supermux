//! Connector store HTTP surface: manifest CRUD + `.mcpb` import, the write-only
//! credential→vault endpoint, and the per-session grant/revoke (spec §§4-6, 8).
//!
//! Every response is secret-free: credential VALUES never come back out — a
//! credential write echoes only the field KEYS with the [`crate::claude_tools::MASKED`]
//! sentinel, exactly like the MCP manager's reveal path.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::claude_tools::MASKED;
use crate::db::connectors::{self, ALL_AGENTS, COMPANY_PREFIX};
use crate::error::AppError;
use crate::state::AppState;
use crate::vault::Vault;

use super::catalog;
use super::manifest::{valid_connector_id, Manifest};

/// Shape one connector row into a secret-free store card (the credential SCHEMA
/// is safe — field names/types/flags, never values).
fn card(c: &connectors::Connector) -> Value {
    json!({
        "id": c.id,
        "kind": c.kind,
        "display_name": c.display_name,
        "icon": c.icon,
        "description": c.description,
        "tools": serde_json::from_str::<Value>(&c.tools_json).unwrap_or_else(|_| json!([])),
        "credentials": serde_json::from_str::<Value>(&c.credentials_json).unwrap_or_else(|_| json!([])),
        // Provenance tag so the merged grid (local rows + catalog mirror) can be
        // filtered by `?source=`. Catalog cards carry `"catalog"`.
        "source": "local",
        "created_at": c.created_at,
    })
}

/// Query for the merged store grid.
#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    /// `local` | `catalog` | `all` (default `all`).
    #[serde(default)]
    pub source: Option<String>,
    /// Free-text search over id / display_name / description.
    #[serde(default)]
    pub q: Option<String>,
    /// A category tag (or `featured`) a card must carry.
    #[serde(default)]
    pub category: Option<String>,
    /// Only featured cards.
    #[serde(default)]
    pub featured: Option<bool>,
}

impl ListQuery {
    fn to_filter(&self) -> catalog::CardFilter {
        catalog::CardFilter {
            source: self.source.clone(),
            q: self.q.clone(),
            category: self.category.clone(),
            featured_only: self.featured.unwrap_or(false),
        }
    }
}

/// `GET /api/connectors` — the store card grid (secret-free): locally-created /
/// agent-authored connectors merged with the PulseMCP catalog mirror.
///
/// The catalog half is read from the in-memory cache only (never blocks on the
/// network); if that cache is stale a refresh is kicked off in the background so
/// the next request is warm. Filters: `?source=local|catalog|all` (default
/// `all`), `?q=`, `?category=`, `?featured=true`.
pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let filter = q.to_filter();
    let want_catalog = filter.source.as_deref().map(|s| s != "local").unwrap_or(true);

    let rows = connectors::list(&state.pool).await.map_err(db_err)?;
    let local: Vec<Value> = rows.iter().map(card).collect();

    let catalog_cards = if want_catalog {
        let mirror = catalog::mirror();
        if mirror.is_stale().await {
            // Warm the cache off the request path — this response is instant.
            let data_dir = state.config.data_dir.clone();
            tokio::spawn(async move {
                let _ = catalog::mirror().refresh(&data_dir).await;
            });
        }
        mirror.cached_cards().await
    } else {
        Vec::new()
    };

    let cards = catalog::merge_and_filter(local, catalog_cards, &filter);
    Ok(Json(json!({ "connectors": cards })))
}

/// `GET /api/connectors/catalog` — the PulseMCP mirror on its own (secret-free).
/// Fetches on-demand when the cache is cold/stale (bounded timeout; degrades to
/// the curated + last-good set on failure). Same `?q=`/`?category=`/`?featured=`
/// filters as the merged list.
pub async fn catalog(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let cards = catalog::mirror().cards(&state.config.data_dir).await;
    let mut filter = q.to_filter();
    filter.source = Some("catalog".to_string());
    let cards = catalog::merge_and_filter(Vec::new(), cards, &filter);
    Ok(Json(json!({ "connectors": cards, "source": "catalog" })))
}

/// `POST /api/connectors/catalog/refresh` — force a mirror refetch now.
pub async fn catalog_refresh(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    match catalog::mirror().refresh(&state.config.data_dir).await {
        Ok(cards) => Ok(Json(json!({ "ok": true, "count": cards.len() }))),
        Err(e) => Err(AppError::Internal(anyhow::anyhow!("catalog refresh failed: {e}"))),
    }
}

/// `GET /api/connectors/catalog/icon/{id}` — the locally-mirrored icon bytes for
/// a catalog card (never a hotlink to the upstream). 404 when not mirrored.
pub async fn catalog_icon(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    let path = catalog::icon_path(&state.config.data_dir, &id)
        .ok_or_else(|| AppError::BadRequest("invalid icon id".into()))?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound(format!("icon for '{id}'")))?;
    let ctype = sniff_image_type(&bytes);
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, ctype),
            (axum::http::header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

/// Cheap magic-byte sniff so a mirrored icon serves with a plausible type.
fn sniff_image_type(b: &[u8]) -> &'static str {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.starts_with(b"RIFF") && b.len() > 11 && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.starts_with(b"<svg") || b.starts_with(b"<?xml") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

/// `GET /api/connectors/{id}` — one card (secret-free).
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let c = connectors::get(&state.pool, &id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    Ok(Json(card(&c)))
}

/// `POST /api/connectors` — create or update a connector from a supermux
/// manifest (the runtime/listing format).
pub async fn upsert(
    State(state): State<AppState>,
    Json(manifest): Json<Manifest>,
) -> Result<Json<Value>, AppError> {
    store_manifest(&state, manifest).await
}

/// `POST /api/connectors/import` — import a `.mcpb` `manifest.json` → a connector.
pub async fn import_mcpb(
    State(state): State<AppState>,
    Json(bundle): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let manifest = Manifest::from_mcpb(&bundle)?;
    store_manifest(&state, manifest).await
}

/// Shared validate → columns → upsert → audit for both the direct manifest POST
/// and the `.mcpb` import.
async fn store_manifest(state: &AppState, manifest: Manifest) -> Result<Json<Value>, AppError> {
    manifest.validate()?;
    let cols = manifest.to_columns();
    connectors::upsert(
        &state.pool,
        &manifest.id,
        &manifest.kind,
        &manifest.display_name,
        &manifest.icon,
        &manifest.description,
        &cols.tools_json,
        &cols.credentials_json,
        &cols.emit_json,
        &serde_json::to_string(&json!({ "imported": true })).unwrap_or_else(|_| "{}".into()),
    )
    .await
    .map_err(db_err)?;
    audit(state, "connector.upsert", &manifest.id, json!({ "kind": manifest.kind })).await;
    Ok(Json(json!({ "ok": true, "id": manifest.id })))
}

/// `DELETE /api/connectors/{id}` — remove a connector (grants + vault CASCADE).
pub async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let removed = connectors::delete(&state.pool, &id).await.map_err(db_err)?;
    if !removed {
        return Err(AppError::NotFound(format!("connector '{id}'")));
    }
    audit(&state, "connector.delete", &id, json!({})).await;
    Ok(Json(json!({ "ok": true, "id": id })))
}

// ── credential → vault (write-only) ───────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CredentialBody {
    /// The credential field-map (env-var-name → secret value). Write-only.
    pub fields: BTreeMap<String, String>,
    /// When present, also grant the connector to this session (or `*`) pointing
    /// at the freshly-sealed secret — the one-tap Connect-card flow.
    #[serde(default)]
    pub session_name: Option<String>,
    /// Reuse this `secret_ref` (rotation) instead of minting a new one; a shared
    /// grant then keeps working with the rotated value.
    #[serde(default)]
    pub secret_ref: Option<String>,
}

/// `POST /api/connectors/{id}/credential` — seal a credential into the vault
/// (write-only) and, if `session_name` is given, grant it to that session.
/// The response NEVER contains a value — only masked field keys + the secret_ref.
pub async fn put_credential(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CredentialBody>,
) -> Result<Json<Value>, AppError> {
    // Connector must exist (the vault row FK-references it).
    connectors::get(&state.pool, &id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    if body.fields.is_empty() {
        return Err(AppError::BadRequest("no credential fields provided".into()));
    }

    let vault = Vault::open(&state.config.data_dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("vault unavailable: {e}")))?;
    let sealed = vault
        .seal(&body.fields)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("sealing credential: {e}")))?;

    let rotate = body.secret_ref.is_some();
    let secret_ref = body.secret_ref.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    connectors::vault_put(
        &state.pool,
        &secret_ref,
        &id,
        &sealed.fields_enc,
        &sealed.nonce,
        rotate,
    )
    .await
    .map_err(db_err)?;

    // Optional one-tap grant.
    if let Some(session) = body.session_name.as_deref().filter(|s| !s.is_empty()) {
        let session = normalize_session(session);
        connectors::grant(&state.pool, &session, &id, Some(&secret_ref), true)
            .await
            .map_err(db_err)?;
        audit(&state, "connector.grant", &id, json!({ "session": session })).await;
    }

    // Audit records the KEYS only, never the values.
    let keys: Vec<&String> = body.fields.keys().collect();
    audit(&state, "connector.credential", &id, json!({ "fields": keys, "rotate": rotate })).await;

    // Masked echo — keys survive, values are the sentinel.
    let masked: Map<String, Value> = body
        .fields
        .keys()
        .map(|k| (k.clone(), Value::String(MASKED.to_string())))
        .collect();
    Ok(Json(json!({
        "ok": true,
        "secret_ref": secret_ref,
        "fields": masked,
        "restartHint": true,
    })))
}

// ── grants ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GrantBody {
    /// Session slug, or the `*` sentinel / the string `"all"` for all agents.
    pub session_name: String,
    /// Optional vault secret to attach to the grant.
    #[serde(default)]
    pub secret_ref: Option<String>,
    /// Soft toggle; defaults to enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// `POST /api/connectors/{id}/grant` — grant a connector to one session or all.
pub async fn grant(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<GrantBody>,
) -> Result<Json<Value>, AppError> {
    if !valid_connector_id(&id) {
        return Err(AppError::BadRequest("invalid connector id".into()));
    }
    connectors::get(&state.pool, &id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    let session = normalize_session(&body.session_name);
    connectors::grant(&state.pool, &session, &id, body.secret_ref.as_deref(), body.enabled)
        .await
        .map_err(db_err)?;
    audit(&state, "connector.grant", &id, json!({ "session": session, "enabled": body.enabled })).await;
    Ok(Json(json!({ "ok": true, "id": id, "session_name": session, "restartHint": true })))
}

#[derive(Debug, Deserialize)]
pub struct RevokeQuery {
    pub session_name: String,
}

/// `DELETE /api/connectors/{id}/grant?session_name=` — revoke a grant.
pub async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RevokeQuery>,
) -> Result<Json<Value>, AppError> {
    let session = normalize_session(&q.session_name);
    let removed = connectors::revoke(&state.pool, &session, &id).await.map_err(db_err)?;
    if !removed {
        return Err(AppError::NotFound(format!(
            "grant of '{id}' to '{session}'"
        )));
    }
    audit(&state, "connector.revoke", &id, json!({ "session": session })).await;
    Ok(Json(json!({ "ok": true, "id": id, "session_name": session, "restartHint": true })))
}

/// `GET /api/sessions/{name}/connectors` — the enabled grants that apply to this
/// session (own + all-agents), each carrying its connector card. Secret-free.
pub async fn session_connectors(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(name): Path<String>,
) -> Result<Json<Value>, AppError> {
    // P3b — this `{name}` route lives on the connectors router, so it is not
    // covered by the sessions scope layer; funnel it explicitly. A scoped human
    // asking for another company's session's grants gets the uniform 404.
    crate::scope::authorize_session_for_human(&state, ctx.0.as_ref(), &name).await?;
    let grants = connectors::grants_for_session(&state.pool, &name)
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    for g in &grants {
        let c = connectors::get(&state.pool, &g.connector_id).await.map_err(db_err)?;
        out.push(json!({
            "connector_id": g.connector_id,
            "has_secret": g.secret_ref.is_some(),
            "enabled": g.enabled != 0,
            "card": c.as_ref().map(card),
        }));
    }
    Ok(Json(json!({ "session_name": name, "connectors": out })))
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Normalize a grant scope string onto its stored `session_connectors.session_name`:
///   * `"all"` / `"*"`            → the `*` all-agents sentinel,
///   * `"company:<id>"`           → the `@company:<id>` company sentinel,
///   * an already-`@company:<id>` value passes through unchanged,
///   * any real slug passes through unchanged.
fn normalize_session(s: &str) -> String {
    let t = s.trim();
    if t == "all" || t == ALL_AGENTS {
        ALL_AGENTS.to_string()
    } else if let Some(id) = t.strip_prefix("company:") {
        format!("{COMPANY_PREFIX}{id}")
    } else {
        t.to_string()
    }
}

fn db_err(e: sqlx::Error) -> AppError {
    AppError::Internal(anyhow::anyhow!(e))
}

/// Audit row — NEVER includes secret values (keys + ids only).
async fn audit(state: &AppState, action: &str, id: &str, detail: Value) {
    crate::db::audit::log(&state.pool, "user", action, id, detail)
        .await
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_session_maps_aliases() {
        // all-agents aliases
        assert_eq!(normalize_session("all"), ALL_AGENTS);
        assert_eq!(normalize_session("*"), ALL_AGENTS);
        // company alias → @company:<id> grant key
        assert_eq!(normalize_session("company:7"), format!("{COMPANY_PREFIX}7"));
        assert_eq!(normalize_session("  company:42  "), format!("{COMPANY_PREFIX}42"));
        // an already-normalized company key passes through unchanged
        assert_eq!(
            normalize_session("@company:7"),
            format!("{COMPANY_PREFIX}7")
        );
        // a real slug is untouched
        assert_eq!(normalize_session("acme-bot"), "acme-bot");
    }
}
