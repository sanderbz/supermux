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
use crate::db::connectors::{self, ALL_AGENTS};
use crate::error::AppError;
use crate::state::AppState;
use crate::vault::Vault;

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
        "created_at": c.created_at,
    })
}

/// `GET /api/connectors` — the store card grid (secret-free).
pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = connectors::list(&state.pool).await.map_err(db_err)?;
    let cards: Vec<Value> = rows.iter().map(card).collect();
    Ok(Json(json!({ "connectors": cards })))
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
    Path(name): Path<String>,
) -> Result<Json<Value>, AppError> {
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

/// Map the friendly "all" alias onto the `*` all-agents sentinel; pass a real
/// slug through unchanged.
fn normalize_session(s: &str) -> String {
    let t = s.trim();
    if t == "all" || t == ALL_AGENTS {
        ALL_AGENTS.to_string()
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
