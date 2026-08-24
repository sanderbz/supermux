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
use crate::db::connectors::{self, Account, Grant, ALL_AGENTS, COMPANY_PREFIX};
use crate::error::AppError;
use crate::external_access::store::OauthApp;
use crate::scope::Scope;
use crate::state::AppState;
use crate::vault::Vault;

use super::catalog;
use super::manifest::{valid_connector_id, CredentialField, Manifest};

/// Shape one connector row into a secret-free store card (the credential SCHEMA
/// is safe — field names/types/flags, never values).
///
/// `oauth_apps` + `scope` are threaded through so the P2a context-aware
/// [`derive_auth`] can flip a provider-backed connector to `oauth_device` when an
/// OAuth app is registered for the caller's scope (else it keeps its current lane).
pub(crate) fn card(oauth_apps: &[OauthApp], scope: Scope, c: &connectors::Connector) -> Value {
    json!({
        "id": c.id,
        "kind": c.kind,
        "display_name": c.display_name,
        "icon": c.icon,
        "description": c.description,
        "tools": serde_json::from_str::<Value>(&c.tools_json).unwrap_or_else(|_| json!([])),
        "credentials": serde_json::from_str::<Value>(&c.credentials_json).unwrap_or_else(|_| json!([])),
        // The per-connector auth DESCRIPTOR (`{ kind, help_url?, … }`) — so the card
        // stops guessing its lane from a brand regex and starts reading the real
        // auth method. Derived (installed catalog card keeps its Lane; a local
        // connector derives from its own schema). Was dropped here entirely.
        "auth": derive_auth(oauth_apps, scope, c),
        // Store-taxonomy tags for the category chip rail. A local row carries none on
        // the wire; recover them from the folded provenance (seeded) or the curated
        // card (installed catalog card) — else it vanishes from EVERY category tab
        // (the "Mail tab is empty" bug).
        "categories": card_categories(c),
        // Provenance tag so the merged grid (local rows + catalog mirror) can be
        // filtered by `?source=`. Catalog cards carry `"catalog"`.
        "source": "local",
        // Un-drop the provenance block (kind/imported/builtin markers) — secret-free
        // (source_json never holds a value), lets the Installed tab show the KIND.
        "provenance": serde_json::from_str::<Value>(&c.source_json).unwrap_or_else(|_| json!({})),
        "created_at": c.created_at,
    })
}

/// The store-category tags for a LOCAL (installed) row. Authoritative order:
/// explicit tags folded into `source_json` (a seeded manifest declared its
/// `categories`) → the curated catalog's tags for this id (so an installed catalog
/// card keeps its chip) → empty (uncategorized, still under "All").
pub(crate) fn card_categories(c: &connectors::Connector) -> Vec<String> {
    if let Some(cats) = serde_json::from_str::<Value>(&c.source_json)
        .ok()
        .and_then(|v| v.get("categories").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
    {
        if !cats.is_empty() {
            return cats;
        }
    }
    catalog::curated_categories(&c.id).unwrap_or_default()
}

/// The per-connector auth descriptor for a LOCAL (installed) row. Authoritative
/// order: an explicit descriptor folded into `source_json` (an imported manifest
/// that declared its lane) → the curated catalog's descriptor for this id (so an
/// installed catalog card keeps its Lane even though the install didn't carry it)
/// → a shape-derivation from the credential schema (identity+secret ⇒ `form`, a
/// lone secret ⇒ `api_key`, nothing to seal ⇒ `none` — no fake sign-in).
pub(crate) fn derive_auth(oauth_apps: &[OauthApp], scope: Scope, c: &connectors::Connector) -> Value {
    // 0) P2a — a provider-backed, non-`mcp_oauth` connector upgrades to a
    //    supermux-driven device sign-in WHEN an OAuth app is registered for the
    //    caller's scope (their active company, else the HQ/global app). If none is
    //    registered, fall through to the current api_key paste — never a dead end.
    //    `mcp_oauth` connectors are excluded (the provider map returns `None`).
    if let Some(provider) = super::oauth::connector_provider(&c.id) {
        let want_company = match scope {
            Scope::Company(cid) => Some(cid),
            Scope::All => None,
        };
        if let Some(app) = super::oauth::resolve_app(oauth_apps, provider, want_company) {
            return super::oauth::oauth_device_descriptor(provider, &app.scopes);
        }
    }
    // 1) An explicit, non-`unspecified` descriptor persisted with the manifest.
    if let Some(auth) = serde_json::from_str::<Value>(&c.source_json)
        .ok()
        .and_then(|v| v.get("auth").cloned())
    {
        let kind = auth.get("kind").and_then(Value::as_str).unwrap_or("");
        if !kind.is_empty() && kind != "unspecified" {
            return auth;
        }
    }
    // 2) The curated catalog's descriptor (installed catalog card keeps its Lane).
    if let Some(auth) = catalog::curated_auth(&c.id) {
        return auth;
    }
    // 3) Derive from the credential schema.
    let creds: Vec<CredentialField> = serde_json::from_str(&c.credentials_json).unwrap_or_default();
    let has_secret = creds.iter().any(|f| f.sensitive);
    let has_plain = creds.iter().any(|f| !f.sensitive);
    let kind = if has_secret && has_plain {
        "form"
    } else if has_secret {
        "api_key"
    } else {
        "none"
    };
    json!({ "kind": kind })
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
    ctx: crate::scope::OptCtx,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let filter = q.to_filter();
    let want_catalog = filter.source.as_deref().map(|s| s != "local").unwrap_or(true);

    let rows = connectors::list(&state.pool).await.map_err(db_err)?;
    // P2a — the registered OAuth apps + caller scope decide whether a
    // provider-backed card shows `oauth_device` (read once from the in-RAM
    // ArcSwap, never per-row from disk).
    let oauth_apps = state.oauth_apps.load();
    let scope = Scope::of(ctx.0.as_ref());
    // Enrich each local (installed) card with its connected ACCOUNTS + per-account
    // grant-level — the Installed tab's data — filtered to what the caller may see.
    let mut local: Vec<Value> = Vec::with_capacity(rows.len());
    for c in &rows {
        let mut v = card(&oauth_apps, scope, c);
        let accts = accounts_json(&state, ctx.0.as_ref(), &c.id).await?;
        if let Value::Object(ref mut o) = v {
            o.insert("accounts".into(), Value::Array(accts));
        }
        local.push(v);
    }

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
///
/// An INSTALLED connector resolves from its DB row. An UN-installed catalog id
/// (never turned into a local row) falls back to the catalog mirror, so the chat
/// Connect card and the store detail still resolve its real schema + auth
/// descriptor instead of 404-ing and degrading to a hardcoded generic API-key
/// field. Secret-free either way.
pub async fn get_one(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if let Some(c) = connectors::get(&state.pool, &id).await.map_err(db_err)? {
        let oauth_apps = state.oauth_apps.load();
        let scope = Scope::of(ctx.0.as_ref());
        return Ok(Json(card(&oauth_apps, scope, &c)));
    }
    // Catalog-mirror fallback (curated ∪ last-good live), which already carries the
    // per-connector auth descriptor + Lane B/C paste schema.
    let found = catalog::mirror()
        .cached_cards()
        .await
        .into_iter()
        .find(|c| c.get("id").and_then(Value::as_str) == Some(id.as_str()));
    match found {
        Some(v) => Ok(Json(v)),
        None => Err(AppError::NotFound(format!("connector '{id}'"))),
    }
}

/// `POST /api/connectors` — create or update a connector from a supermux
/// manifest (the runtime/listing format).
pub async fn upsert(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Json(manifest): Json<Manifest>,
) -> Result<Json<Value>, AppError> {
    // P3d: a connector DEFINITION is GLOBAL (no company column); creating/editing
    // one is owner/admin-only. A member is confined to GRANTING existing
    // connectors into their own company scope, never authoring global rows.
    crate::scope::require_admin(ctx.0.as_ref(), "/api/connectors")?;
    store_manifest(&state, manifest).await
}

/// `POST /api/connectors/import` — import a `.mcpb` `manifest.json` → a connector.
pub async fn import_mcpb(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Json(bundle): Json<Value>,
) -> Result<Json<Value>, AppError> {
    // P3d: same global-definition rule as `upsert` — owner/admin-only.
    crate::scope::require_admin(ctx.0.as_ref(), "/api/connectors/import")?;
    let manifest = Manifest::from_mcpb(&bundle)?;
    store_manifest(&state, manifest).await
}

/// Shared validate → columns → upsert → audit for both the direct manifest POST
/// and the `.mcpb` import.
async fn store_manifest(state: &AppState, manifest: Manifest) -> Result<Json<Value>, AppError> {
    manifest.validate()?;
    let cols = manifest.to_columns();
    // Provenance blob (secret-free). When the manifest DECLARED its auth lane, fold
    // the descriptor in so it survives the round-trip and `derive_auth` prefers it
    // over the shape-derivation. `Unspecified` stays out (the card layer derives).
    let mut provenance = json!({ "imported": true });
    if !manifest.auth.is_unspecified() {
        if let Ok(a) = serde_json::to_value(&manifest.auth) {
            provenance["auth"] = a;
        }
    }
    // Fold declared store-taxonomy tags so the card surfaces under the right chip.
    if !manifest.categories.is_empty() {
        provenance["categories"] = json!(manifest.categories);
    }
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
        &serde_json::to_string(&provenance).unwrap_or_else(|_| "{}".into()),
    )
    .await
    .map_err(db_err)?;
    audit(state, "connector.upsert", &manifest.id, json!({ "kind": manifest.kind })).await;
    Ok(Json(json!({ "ok": true, "id": manifest.id })))
}

/// `DELETE /api/connectors/{id}` — remove a connector (grants + vault CASCADE).
pub async fn remove(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    // P3d: deleting a GLOBAL connector definition is owner/admin-only.
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/connectors/{id}"))?;
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
    /// The connected-account's NON-secret display identity (e.g. `sander@acme.com`).
    /// When omitted, the value of the connector's `identity:true` credential field
    /// (e.g. `ICLOUD_EMAIL`) is used. Drives multi-account: a new label mints a new
    /// [`Account`]; re-using a label updates it.
    #[serde(default)]
    pub account_label: Option<String>,
    /// REPLACE an existing account in place — swap its identity/secret while keeping
    /// every grant wired (the safe key-rotation path). Mutually informs `account_label`.
    #[serde(default)]
    pub account_ref: Option<String>,
}

/// `POST /api/connectors/{id}/credential` — seal a credential into the vault
/// (write-only) and, if `session_name` is given, grant it to that session.
/// The response NEVER contains a value — only masked field keys + the secret_ref.
pub async fn put_credential(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    Json(body): Json<CredentialBody>,
) -> Result<Json<Value>, AppError> {
    // P3d: a member may seal a credential ONLY when attaching it to their own
    // company scope (an own-company grant target). A bare seal (no target) or a
    // global/cross-company target is a uniform 404 — a member can't mint a global
    // credential. Owner/admin (Scope::All) are unrestricted.
    if matches!(
        crate::scope::Scope::of(ctx.0.as_ref()),
        crate::scope::Scope::Company(_)
    ) {
        match body.session_name.as_deref().filter(|s| !s.is_empty()) {
            Some(t) => {
                crate::scope::authorize_connector_target(&state, ctx.0.as_ref(), &normalize_session(t))
                    .await?
            }
            None => return Err(AppError::NotFound(format!("connector '{id}'"))),
        }
    }
    // Connector must exist (the vault row FK-references it). Keep the row — its
    // credential schema names the identity field.
    let connector = connectors::get(&state.pool, &id)
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

    // ── account identity (multi-account, 0035) ──────────────────────────────────
    // The connected-account label is NON-secret: an explicit `account_label`, else
    // the value of the connector's identity-flagged credential field (e.g.
    // ICLOUD_EMAIL). Surfaced in cleartext; the vault still holds only the secrets.
    let identity_label: Option<String> = body
        .account_label
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            identity_field_key(&connector.credentials_json)
                .and_then(|k| body.fields.get(&k).cloned())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });

    let account_ref: Option<String> = if let Some(aref) =
        body.account_ref.as_deref().map(str::trim).filter(|s| !s.is_empty())
    {
        // REPLACE / reconnect-with-new-key an existing account in place (keep grants).
        let existing = connectors::account_get(&state.pool, aref).await.map_err(db_err)?;
        // Must belong to this connector — uniform 404 otherwise (hide existence).
        let existing = match existing {
            Some(a) if a.connector_id == id => a,
            _ => return Err(AppError::NotFound(format!("account '{aref}'"))),
        };
        // P2b parity fence: a scoped MEMBER may rotate ONLY an account in their own
        // company. account_replace re-points the row's SHARED secret_ref, so a
        // foreign account_ref would otherwise let a member swap another company's
        // token (the same cross-company class the label branch scopes). Owner
        // (Scope::All) is unrestricted — owner-neutral, like every other guard; the
        // mismatch collapses to the same uniform 404 as a nonexistent ref.
        if let Scope::Company(hc) = Scope::of(ctx.0.as_ref()) {
            if existing.company_id != Some(hc) {
                return Err(AppError::NotFound(format!("account '{aref}'")));
            }
        }
        let label = identity_label
            .clone()
            .unwrap_or(existing.account_label);
        connectors::account_replace(&state.pool, aref, &label, Some(&secret_ref))
            .await
            .map_err(db_err)?;
        Some(aref.to_string())
    } else if let Some(label) = identity_label.clone() {
        // ADD-account, idempotent by (connector, label, company): the account's
        // scope = the grant target's company (HQ/NULL for a bare owner seal).
        // A same-label account is reused ONLY within the same company scope, so
        // company A's "alice" and company B's "alice" never share a row /
        // secret_ref (P2b). Members can only reach here with an own-company
        // target (the P3d fence above), so their derived company is their own.
        let account_company = match body
            .session_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(t) => {
                connectors::company_of_grant_target(&state.pool, &normalize_session(t)).await
            }
            None => None,
        };
        let existing =
            connectors::account_find_by_label(&state.pool, &id, &label, account_company)
                .await
                .map_err(db_err)?;
        match existing {
            Some(a) => {
                connectors::account_replace(&state.pool, &a.id, &label, Some(&secret_ref))
                    .await
                    .map_err(db_err)?;
                Some(a.id)
            }
            None => Some(
                connectors::account_add(&state.pool, &id, &label, Some(&secret_ref), account_company)
                    .await
                    .map_err(db_err)?,
            ),
        }
    } else {
        // Identity-less connector (no label, no identity field) — a legacy
        // account-less grant, exactly as before multi-account.
        None
    };

    // Optional one-tap grant — now account-aware.
    if let Some(session) = body.session_name.as_deref().filter(|s| !s.is_empty()) {
        let session = normalize_session(session);
        connectors::grant_with_account(
            &state.pool,
            &session,
            &id,
            Some(&secret_ref),
            true,
            account_ref.as_deref(),
        )
        .await
        .map_err(db_err)?;
        audit(&state, "connector.grant", &id, json!({ "session": session })).await;
    }

    // Audit records the KEYS only, never the values.
    let keys: Vec<&String> = body.fields.keys().collect();
    audit(&state, "connector.credential", &id, json!({ "fields": keys, "rotate": rotate })).await;

    // Masked echo — keys survive, values are the sentinel. `account_label` is
    // deliberately cleartext (it is non-secret, display-only).
    let masked: Map<String, Value> = body
        .fields
        .keys()
        .map(|k| (k.clone(), Value::String(MASKED.to_string())))
        .collect();
    Ok(Json(json!({
        "ok": true,
        "secret_ref": secret_ref,
        "account_ref": account_ref,
        "account_label": identity_label,
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
    /// Optional [`Account`] this grant uses (multi-account). When present the grant
    /// is written account-aware; when absent a re-grant KEEPS whatever account the
    /// row already had (so a legacy grant path never clobbers it to NULL).
    #[serde(default)]
    pub account_ref: Option<String>,
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
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    Json(body): Json<GrantBody>,
) -> Result<Json<Value>, AppError> {
    if !valid_connector_id(&id) {
        return Err(AppError::BadRequest("invalid connector id".into()));
    }
    let session = normalize_session(&body.session_name);
    // P3d: confine a member's grant target to their own company scope
    // (`@company:<their id>` or an own-company session). `*` (global) / another
    // company / a foreign session all collapse to a uniform 404. Owner/admin: no-op.
    crate::scope::authorize_connector_target(&state, ctx.0.as_ref(), &session).await?;
    connectors::get(&state.pool, &id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    match body.account_ref.as_deref().filter(|s| !s.is_empty()) {
        // Account-aware grant (pins which account this grant feeds).
        Some(aref) => connectors::grant_with_account(
            &state.pool,
            &session,
            &id,
            body.secret_ref.as_deref(),
            body.enabled,
            Some(aref),
        )
        .await
        .map_err(db_err)?,
        // Legacy path — preserves any existing account_ref on a re-grant.
        None => connectors::grant(&state.pool, &session, &id, body.secret_ref.as_deref(), body.enabled)
            .await
            .map_err(db_err)?,
    }
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
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    Query(q): Query<RevokeQuery>,
) -> Result<Json<Value>, AppError> {
    let session = normalize_session(&q.session_name);
    // P3d: a member may only revoke within their own company scope (uniform 404
    // otherwise). Owner/admin: no-op.
    crate::scope::authorize_connector_target(&state, ctx.0.as_ref(), &session).await?;
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
    let oauth_apps = state.oauth_apps.load();
    let scope = Scope::of(ctx.0.as_ref());
    let mut out = Vec::new();
    for g in &grants {
        let c = connectors::get(&state.pool, &g.connector_id).await.map_err(db_err)?;
        out.push(json!({
            "connector_id": g.connector_id,
            "has_secret": g.secret_ref.is_some(),
            "enabled": g.enabled != 0,
            "card": c.as_ref().map(|c| card(&oauth_apps, scope, c)),
        }));
    }
    Ok(Json(json!({ "session_name": name, "connectors": out })))
}

// ── consumers / blast-radius + account lifecycle ────────────────────────────────

/// `GET /api/connectors/{id}/grants` — the CONSUMERS of a connector (blast-radius):
/// every grant, with its scope resolved (`*`→All agents, `@company:<id>`→company
/// name/slug, else the bot's display label) and the account it uses. Secret-free.
///
/// A scoped **member** sees only the grants their company can see (via
/// [`Scope::sees`]): their `@company:<id>` grants and their own bots' grants. Global
/// all-agents grants (company-neutral) and other companies' grants are omitted —
/// the same isolation the SSE stream and grant-target guard already apply.
pub async fn connector_grants(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !valid_connector_id(&id) {
        return Err(AppError::BadRequest("invalid connector id".into()));
    }
    connectors::get(&state.pool, &id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    let scope = Scope::of(ctx.0.as_ref());
    let grants = connectors::grants_for_connector(&state.pool, &id)
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    for g in &grants {
        let (desc, company) = resolve_grant(&state, g).await;
        if scope.sees(company) {
            out.push(desc);
        }
    }
    Ok(Json(json!({ "connector_id": id, "grants": out })))
}

#[derive(Debug, Deserialize)]
pub struct AccountBody {
    /// Which [`Account`] (the `account_ref`) to act on.
    pub account_ref: String,
    /// reconnect only: optionally re-grant to this session/scope using the KEPT
    /// secret. Ignored by disconnect.
    #[serde(default)]
    pub session_name: Option<String>,
}

/// `POST /api/connectors/{id}/disconnect` — revoke every grant an account feeds,
/// but KEEP the sealed secret + the account row (status → `disconnected`) so a
/// reconnect is one tap. Owner/admin-only (an account spans scopes).
pub async fn disconnect_account(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    Json(body): Json<AccountBody>,
) -> Result<Json<Value>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/connectors/{id}/disconnect"))?;
    let account = account_of(&state, &id, &body.account_ref).await?;
    let revoked = connectors::revoke_by_account(&state.pool, &id, &account.id)
        .await
        .map_err(db_err)?;
    connectors::account_set_status(&state.pool, &account.id, "disconnected")
        .await
        .map_err(db_err)?;
    audit(&state, "connector.disconnect", &id, json!({ "account_ref": account.id, "revoked": revoked })).await;
    Ok(Json(json!({
        "ok": true,
        "id": id,
        "account_ref": account.id,
        "status": "disconnected",
        "revoked": revoked,
        "restartHint": true,
    })))
}

/// `POST /api/connectors/{id}/reconnect` — flip a disconnected account back to
/// `active` and (optionally) re-grant it to a session/scope, REUSING the kept
/// `secret_ref` (no re-entry of the secret). Owner/admin-only.
pub async fn reconnect_account(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    Json(body): Json<AccountBody>,
) -> Result<Json<Value>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/connectors/{id}/reconnect"))?;
    let account = account_of(&state, &id, &body.account_ref).await?;
    connectors::account_set_status(&state.pool, &account.id, "active")
        .await
        .map_err(db_err)?;
    if let Some(session) = body.session_name.as_deref().filter(|s| !s.is_empty()) {
        let session = normalize_session(session);
        connectors::grant_with_account(
            &state.pool,
            &session,
            &id,
            account.secret_ref.as_deref(),
            true,
            Some(&account.id),
        )
        .await
        .map_err(db_err)?;
        audit(&state, "connector.grant", &id, json!({ "session": session, "reconnect": true })).await;
    }
    audit(&state, "connector.reconnect", &id, json!({ "account_ref": account.id })).await;
    Ok(Json(json!({
        "ok": true,
        "id": id,
        "account_ref": account.id,
        "status": "active",
        "restartHint": true,
    })))
}

/// `POST /api/connectors/{id}/test` — run a per-kind liveness probe for one account
/// and record the honest verdict (`ok` / `expired` / `error`, or leave health
/// untouched when the connector is untestable). Owner/admin-only (it decrypts the
/// sealed credential to probe, and an account spans scopes — same guard as
/// disconnect/reconnect).
///
/// The response carries the verdict + a human message; the persisted `health` also
/// rides the store grid so the Installed row/detail repaint. NEVER returns a secret
/// value — the decrypted fields are read only to feed the probe.
pub async fn test_account(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<String>,
    Json(body): Json<AccountBody>,
) -> Result<Json<Value>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/connectors/{id}/test"))?;
    let account = account_of(&state, &id, &body.account_ref).await?;
    let connector = connectors::get(&state.pool, &id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;

    // Decrypt this account's sealed fields ONLY to feed the probe (never returned,
    // never logged). A missing/undecryptable secret yields an empty map — the probe
    // then reports an honest error, never a fake green.
    let secrets = decrypt_account_secret(&state, &account).await;

    let outcome = super::health::run_probe(&connector, &secrets).await;
    let now = chrono::Utc::now().timestamp();
    // Persist ONLY a real verdict; an untestable connector keeps its prior health.
    if outcome.testable {
        connectors::account_set_health(
            &state.pool,
            &account.id,
            outcome.health,
            outcome.last_error.as_deref(),
            now,
        )
        .await
        .map_err(db_err)?;
    }
    audit(
        &state,
        "connector.test",
        &id,
        json!({ "account_ref": account.id, "health": outcome.health, "testable": outcome.testable }),
    )
    .await;

    // Report the freshly-stored verdict, or (untestable) the prior stored state.
    let reported_health: Option<String> = if outcome.testable {
        outcome.health.map(str::to_string)
    } else {
        account.health.clone()
    };
    Ok(Json(json!({
        "ok": true,
        "id": id,
        "account_ref": account.id,
        "testable": outcome.testable,
        "health": reported_health,
        "last_error": outcome.last_error,
        "last_checked_at": if outcome.testable { now } else { account.last_checked_at },
        "message": outcome.message,
    })))
}

/// Open this account's sealed field-map (env-var name → value) from the vault, or an
/// empty map on any miss/failure (logged, never fatal, never logs the secret). Used
/// only to feed a health probe.
async fn decrypt_account_secret(state: &AppState, account: &Account) -> BTreeMap<String, String> {
    let Some(secret_ref) = account.secret_ref.as_deref() else {
        return BTreeMap::new();
    };
    let vault = match Vault::open(&state.config.data_dir) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "connector test: vault unavailable");
            return BTreeMap::new();
        }
    };
    match connectors::vault_get(&state.pool, secret_ref).await {
        Ok(Some(row)) => vault.open_fields(&row.fields_enc, &row.nonce).unwrap_or_default(),
        _ => BTreeMap::new(),
    }
}

/// Fetch an account and assert it belongs to `connector_id` (else a uniform 404).
async fn account_of(state: &AppState, connector_id: &str, account_ref: &str) -> Result<Account, AppError> {
    let account = connectors::account_get(&state.pool, account_ref)
        .await
        .map_err(db_err)?
        .filter(|a| a.connector_id == connector_id)
        .ok_or_else(|| AppError::NotFound(format!("account '{account_ref}'")))?;
    Ok(account)
}

/// The connected accounts of a connector, each with its per-account grant-level,
/// filtered to what the caller may see. A member with no visible grant for an
/// account does not see that account (its label may be another company's identity).
async fn accounts_json(
    state: &AppState,
    ctx: Option<&crate::auth_human::AuthContext>,
    connector_id: &str,
) -> Result<Vec<Value>, AppError> {
    let scope = Scope::of(ctx);
    let accounts = connectors::accounts_for_connector(&state.pool, connector_id)
        .await
        .map_err(db_err)?;
    let grants = connectors::grants_for_connector(&state.pool, connector_id)
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    for a in &accounts {
        let mut resolved: Vec<Value> = Vec::new();
        for g in grants.iter().filter(|g| g.account_ref.as_deref() == Some(a.id.as_str())) {
            let (desc, company) = resolve_grant(state, g).await;
            if scope.sees(company) {
                resolved.push(desc);
            }
        }
        // Hide an account a member has no visible grant for (identity privacy).
        if matches!(scope, Scope::Company(_)) && resolved.is_empty() {
            continue;
        }
        out.push(json!({
            "id": a.id,
            "account_label": a.account_label,
            "status": a.status,
            "has_secret": a.secret_ref.is_some(),
            "last_used_at": a.last_used_at,
            // Active health (0036) — the "Test connection" verdict. `last_checked_at`
            // is 0 until first probed; `last_error` is masked/human. All secret-free.
            "health": a.health,
            "last_checked_at": a.last_checked_at,
            "last_error": a.last_error,
            "grant_level": grant_level(&resolved),
        }));
    }
    Ok(out)
}

/// Summarize an account's resolved grants into a single grant-level chip descriptor:
/// all-agents wins; else one grant shows its scope; else same-company shows the
/// company; else `N agents`.
fn grant_level(resolved: &[Value]) -> Value {
    if resolved.is_empty() {
        return json!({ "scope": "none", "label": "Not granted", "count": 0 });
    }
    let count = resolved.len();
    if let Some(all) = resolved.iter().find(|d| d["scope"] == "all") {
        return json!({ "scope": "all", "label": all["label"].clone(), "count": count });
    }
    if count == 1 {
        let d = &resolved[0];
        return json!({
            "scope": d["scope"].clone(),
            "label": d["label"].clone(),
            "company_id": d.get("company_id").cloned().unwrap_or(Value::Null),
            "count": 1,
        });
    }
    let first_company = resolved[0].get("company_id").cloned();
    let same_company = resolved
        .iter()
        .all(|d| d["scope"] == "company" && d.get("company_id").cloned() == first_company);
    if same_company {
        return json!({ "scope": "company", "label": resolved[0]["label"].clone(), "count": count });
    }
    json!({ "scope": "bots", "label": format!("{count} agents"), "count": count })
}

/// Resolve a full grant into its consumer descriptor (scope + account), returning
/// the descriptor and the company id used for member-visibility filtering.
async fn resolve_grant(state: &AppState, g: &Grant) -> (Value, Option<i64>) {
    let (mut desc, company) = resolve_grant_scope(state, &g.session_name).await;
    let account_label = match g.account_ref.as_deref() {
        Some(aref) => connectors::account_get(&state.pool, aref)
            .await
            .ok()
            .flatten()
            .map(|a| a.account_label),
        None => None,
    };
    if let Value::Object(ref mut o) = desc {
        o.insert("enabled".into(), json!(g.enabled != 0));
        o.insert("has_secret".into(), json!(g.secret_ref.is_some()));
        o.insert("account_ref".into(), json!(g.account_ref));
        o.insert("account_label".into(), json!(account_label));
        o.insert("granted_at".into(), json!(g.granted_at));
    }
    (desc, company)
}

/// Map a stored `session_connectors.session_name` onto a human scope descriptor
/// (`scope`/`label`/…), plus the company id for visibility filtering:
///   * `*`               → `all`  (company None),
///   * `@company:<id>`    → `company` + name/slug (company Some(id)),
///   * a real slug        → `bot` + display label (company = the bot's company_id).
async fn resolve_grant_scope(state: &AppState, session_name: &str) -> (Value, Option<i64>) {
    if session_name == ALL_AGENTS {
        return (json!({ "scope": "all", "label": "All agents" }), None);
    }
    if let Some(ids) = session_name.strip_prefix(COMPANY_PREFIX) {
        let cid: Option<i64> = ids.parse().ok();
        let (label, slug) = match cid {
            Some(c) => match crate::db::companies::get(&state.pool, c).await.ok().flatten() {
                Some(co) => (co.display_name, Some(co.slug)),
                None => (format!("company {ids}"), None),
            },
            None => (format!("company {ids}"), None),
        };
        return (
            json!({ "scope": "company", "company_id": cid, "slug": slug, "label": label }),
            cid,
        );
    }
    let (label, company) = match crate::db::sessions::get(&state.pool, session_name)
        .await
        .ok()
        .flatten()
    {
        Some(s) => (
            if s.display_name.trim().is_empty() {
                session_name.to_string()
            } else {
                s.display_name
            },
            s.company_id,
        ),
        None => (session_name.to_string(), None),
    };
    (
        json!({ "scope": "bot", "session_name": session_name, "label": label }),
        company,
    )
}

/// The KEY of the connector's `identity:true` credential field (e.g. `ICLOUD_EMAIL`),
/// whose value doubles as the connected-account label. `None` if the connector
/// declares no identity field.
fn identity_field_key(credentials_json: &str) -> Option<String> {
    serde_json::from_str::<Vec<CredentialField>>(credentials_json)
        .ok()?
        .into_iter()
        // Identity is NON-secret by definition — never surface a `sensitive` field's
        // value as a cleartext label, even if it was mis-flagged `identity:true`.
        .find(|f| f.identity && !f.sensitive)
        .map(|f| f.key)
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

    #[test]
    fn identity_field_key_finds_the_flagged_field() {
        // iCloud-shaped schema: the email is the identity, the password is not.
        let creds = json!([
            { "key": "ICLOUD_EMAIL", "sensitive": false, "identity": true },
            { "key": "ICLOUD_APP_PW", "sensitive": true }
        ])
        .to_string();
        assert_eq!(identity_field_key(&creds).as_deref(), Some("ICLOUD_EMAIL"));
        // No identity flag anywhere → None (identity-less connector).
        let none = json!([{ "key": "TOKEN", "sensitive": true }]).to_string();
        assert_eq!(identity_field_key(&none), None);
        assert_eq!(identity_field_key("not json"), None);
        // A SENSITIVE field mis-flagged identity is refused (never leak a secret).
        let bad = json!([{ "key": "SECRET", "sensitive": true, "identity": true }]).to_string();
        assert_eq!(identity_field_key(&bad), None);
    }

    fn connector_row(id: &str, credentials_json: &str, source_json: &str) -> connectors::Connector {
        connectors::Connector {
            id: id.to_string(),
            kind: "mcp_catalog".to_string(),
            display_name: id.to_string(),
            icon: String::new(),
            description: String::new(),
            tools_json: "[]".to_string(),
            credentials_json: credentials_json.to_string(),
            emit_json: "{}".to_string(),
            source_json: source_json.to_string(),
            created_at: 0,
        }
    }

    #[test]
    fn card_categories_from_provenance_then_curated_then_empty() {
        // 1) A seeded/local connector folds its tags into source_json → used.
        let mail = connector_row("icloud-mail", "[]", &json!({ "categories": ["mail"] }).to_string());
        assert_eq!(card_categories(&mail), vec!["mail".to_string()]);
        // 2) An installed CATALOG card carries none on the row → inherits curated tags.
        let pw = connector_row("pmcp-playwright", "[]", &json!({ "imported": true }).to_string());
        assert!(card_categories(&pw).iter().any(|c| c == "browser"));
        // 3) An unknown local connector with no tags → empty (still under "All").
        assert!(card_categories(&connector_row("random-local", "[]", "{}")).is_empty());
    }

    #[test]
    fn derive_auth_prefers_explicit_then_curated_then_shape() {
        // No OAuth apps registered ⇒ the P2a step-0 never fires; behaviour is the
        // historical explicit→curated→shape chain.
        let no_apps: &[OauthApp] = &[];
        // 1) An explicit descriptor folded into source_json wins outright.
        let explicit = connector_row(
            "anything",
            "[]",
            &json!({ "imported": true, "auth": { "kind": "oauth_device" } }).to_string(),
        );
        assert_eq!(derive_auth(no_apps, Scope::All, &explicit)["kind"], json!("oauth_device"));

        // …but an `unspecified` explicit descriptor is ignored (fall through).
        let unspec = connector_row(
            "icloud-mail",
            &json!([
                { "key": "ICLOUD_EMAIL", "sensitive": false, "identity": true },
                { "key": "ICLOUD_APP_PW", "sensitive": true }
            ])
            .to_string(),
            &json!({ "auth": { "kind": "unspecified" } }).to_string(),
        );
        // 3) Shape-derive: identity(non-secret) + secret ⇒ form.
        assert_eq!(derive_auth(no_apps, Scope::All, &unspec)["kind"], json!("form"));

        // 2) An installed CATALOG id keeps its curated Lane even with empty schema.
        let installed_gh = connector_row("pmcp-github", "[]", &json!({ "imported": true }).to_string());
        assert_eq!(derive_auth(no_apps, Scope::All, &installed_gh)["kind"], json!("api_key"));
        let installed_slack = connector_row("pmcp-slack", "[]", "{}");
        assert_eq!(derive_auth(no_apps, Scope::All, &installed_slack)["kind"], json!("mcp_oauth"));

        // 3) A lone secret ⇒ api_key; no credentials ⇒ none (no fake sign-in).
        let key_only = connector_row("x-key", &json!([{ "key": "TOKEN", "sensitive": true }]).to_string(), "{}");
        assert_eq!(derive_auth(no_apps, Scope::All, &key_only)["kind"], json!("api_key"));
        let no_creds = connector_row("x-none", "[]", "{}");
        assert_eq!(derive_auth(no_apps, Scope::All, &no_creds)["kind"], json!("none"));
    }

    #[test]
    fn derive_auth_flips_to_oauth_device_only_when_app_registered() {
        let gh = connector_row("pmcp-github", "[]", &json!({ "imported": true }).to_string());
        // No app registered → keeps the curated api_key paste (never a dead end).
        assert_eq!(derive_auth(&[], Scope::All, &gh)["kind"], json!("api_key"));

        // A GLOBAL github app registered → the card flips to device sign-in with the
        // reserved descriptor fields populated.
        let apps = vec![OauthApp {
            provider: "github".into(),
            company_id: None,
            client_id: "gh-global".into(),
            scopes: vec!["repo".into(), "read:org".into()],
        }];
        let d = derive_auth(&apps, Scope::All, &gh);
        assert_eq!(d["kind"], json!("oauth_device"));
        assert_eq!(d["token_field"], json!("GITHUB_TOKEN"));
        assert_eq!(d["device_url"], json!("https://github.com/login/device/code"));
        assert_eq!(d["scopes"], json!(["repo", "read:org"]));
        // A member of ANY company still gets device sign-in via the global app.
        assert_eq!(derive_auth(&apps, Scope::Company(7), &gh)["kind"], json!("oauth_device"));

        // An `mcp_oauth` connector is NEVER remapped, even with apps present.
        let slack = connector_row("pmcp-slack", "[]", "{}");
        assert_eq!(derive_auth(&apps, Scope::All, &slack)["kind"], json!("mcp_oauth"));

        // A COMPANY-scoped app is fenced: only that company flips; the owner
        // (no global app) and other companies keep api_key.
        let company_only = vec![OauthApp {
            provider: "github".into(),
            company_id: Some(7),
            client_id: "gh-c7".into(),
            scopes: vec!["repo".into()],
        }];
        assert_eq!(derive_auth(&company_only, Scope::Company(7), &gh)["kind"], json!("oauth_device"));
        assert_eq!(derive_auth(&company_only, Scope::Company(8), &gh)["kind"], json!("api_key"));
        assert_eq!(derive_auth(&company_only, Scope::All, &gh)["kind"], json!("api_key"));
    }

    #[test]
    fn grant_level_summarizes_the_chip() {
        // Nothing granted.
        assert_eq!(grant_level(&[])["scope"], json!("none"));
        // All-agents wins the chip even amid others.
        let all = vec![
            json!({ "scope": "all", "label": "All agents" }),
            json!({ "scope": "bot", "label": "crm-bot" }),
        ];
        assert_eq!(grant_level(&all)["scope"], json!("all"));
        // A single bot grant shows that bot.
        let one = vec![json!({ "scope": "bot", "label": "crm-bot" })];
        assert_eq!(grant_level(&one)["scope"], json!("bot"));
        assert_eq!(grant_level(&one)["label"], json!("crm-bot"));
        // Two grants in the SAME company collapse to the company.
        let same = vec![
            json!({ "scope": "company", "company_id": 7, "label": "Acme" }),
            json!({ "scope": "company", "company_id": 7, "label": "Acme" }),
        ];
        assert_eq!(grant_level(&same)["scope"], json!("company"));
        // Mixed bots → "N agents".
        let mixed = vec![
            json!({ "scope": "bot", "label": "a" }),
            json!({ "scope": "bot", "label": "b" }),
        ];
        assert_eq!(grant_level(&mixed)["scope"], json!("bots"));
        assert_eq!(grant_level(&mixed)["count"], json!(2));
    }

    // ── paste path: company-scoped account dedup (0037, P2b) ────────────────────

    async fn paste_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
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

    async fn seed_session(state: &AppState, name: &str, company_id: Option<i64>) {
        sqlx::query("INSERT INTO sessions (name, dir, created_at, company_id) VALUES (?, ?, ?, ?)")
            .bind(name)
            .bind("/tmp")
            .bind(0i64)
            .bind(company_id)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    /// Owner (unrestricted, Scope::All) seals `label` for `target` (a session slug,
    /// or None for a bare HQ seal) and returns `(account_ref, secret_ref)`.
    async fn owner_seal(
        state: &AppState,
        connector: &str,
        label: &str,
        target: Option<&str>,
    ) -> (String, String) {
        let mut fields = BTreeMap::new();
        fields.insert("TOKEN".to_string(), format!("tok-for-{label}-{target:?}"));
        let res = put_credential(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Path(connector.to_string()),
            Json(CredentialBody {
                fields,
                session_name: target.map(str::to_string),
                secret_ref: None,
                account_label: Some(label.to_string()),
                account_ref: None,
            }),
        )
        .await
        .expect("owner seal accepted");
        (
            res.0["account_ref"].as_str().unwrap().to_string(),
            res.0["secret_ref"].as_str().unwrap().to_string(),
        )
    }

    #[tokio::test]
    async fn put_credential_scopes_account_per_company_target() {
        let (state, dir) = paste_state().await;
        connectors::upsert(&state.pool, "gh", "mcp_catalog", "gh", "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
        seed_session(&state, "bot1", Some(1)).await;
        seed_session(&state, "bot2", Some(2)).await;

        // Same identity label sealed for two different companies' bots.
        let (a_ref, a_secret) = owner_seal(&state, "gh", "alice", Some("bot1")).await;
        let (b_ref, b_secret) = owner_seal(&state, "gh", "alice", Some("bot2")).await;
        assert_ne!(a_ref, b_ref, "two companies, same label → two account rows");
        assert_ne!(a_secret, b_secret, "distinct secret_refs — no cross-company swap");

        let accts = connectors::accounts_for_connector(&state.pool, "gh").await.unwrap();
        assert_eq!(accts.len(), 2, "one row per company scope");
        let a = connectors::account_get(&state.pool, &a_ref).await.unwrap().unwrap();
        let b = connectors::account_get(&state.pool, &b_ref).await.unwrap().unwrap();
        assert_eq!(a.company_id, Some(1));
        assert_eq!(b.company_id, Some(2));

        // Re-seal for bot1 (same scope) reuses A's row; B stays put with its secret.
        let (a2_ref, _) = owner_seal(&state, "gh", "alice", Some("bot1")).await;
        assert_eq!(a2_ref, a_ref, "same company + label → the same row updated");
        let b_after = connectors::account_get(&state.pool, &b_ref).await.unwrap().unwrap();
        assert_eq!(b_after.secret_ref, b.secret_ref, "company B's secret_ref untouched");
        assert_eq!(
            connectors::accounts_for_connector(&state.pool, "gh").await.unwrap().len(),
            2
        );

        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    fn member(company_id: i64) -> crate::scope::OptCtx {
        crate::scope::OptCtx(Some(crate::auth_human::AuthContext::Human {
            user_id: 1,
            company_id: Some(company_id),
            role: "member".into(),
        }))
    }

    /// Seal `label` for `target` while REPLACING an existing account by
    /// `account_ref`, as `ctx` — returns the raw handler result (so a fence can be
    /// asserted as an `Err`).
    async fn seal_replace(
        state: &AppState,
        ctx: crate::scope::OptCtx,
        connector: &str,
        label: &str,
        target: Option<&str>,
        account_ref: &str,
    ) -> Result<Json<Value>, AppError> {
        let mut fields = BTreeMap::new();
        fields.insert("TOKEN".to_string(), format!("rotated-{label}"));
        put_credential(
            State(state.clone()),
            ctx,
            Path(connector.to_string()),
            Json(CredentialBody {
                fields,
                session_name: target.map(str::to_string),
                secret_ref: None,
                account_label: Some(label.to_string()),
                account_ref: Some(account_ref.to_string()),
            }),
        )
        .await
    }

    #[tokio::test]
    async fn member_cannot_rotate_another_companys_account_ref() {
        // P2b parity fence: a company-1 member passes the P3d target fence with an
        // own-company bot, but supplies a FOREIGN (company-2) account_ref. The
        // explicit-REPLACE branch must refuse it (uniform 404) so account_replace
        // never re-points company 2's shared secret_ref to the member's secret.
        let (state, dir) = paste_state().await;
        connectors::upsert(&state.pool, "gh", "mcp_catalog", "gh", "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
        seed_session(&state, "bot1", Some(1)).await;
        seed_session(&state, "bot2", Some(2)).await;

        // Company 2 owns an account for "alice" (owner seals it for bot2).
        let (b_ref, b_secret) = owner_seal(&state, "gh", "alice", Some("bot2")).await;
        let b_before = connectors::account_get(&state.pool, &b_ref).await.unwrap().unwrap();

        // Company-1 member tries to rotate company 2's account_ref (own-company target).
        let res = seal_replace(&state, member(1), "gh", "alice", Some("bot1"), &b_ref).await;
        assert!(
            matches!(res, Err(AppError::NotFound(_))),
            "member must not rotate a foreign company's account_ref"
        );

        // Company 2's account row is untouched — same secret_ref, no swap.
        let b_after = connectors::account_get(&state.pool, &b_ref).await.unwrap().unwrap();
        assert_eq!(b_after.secret_ref.as_deref(), Some(b_secret.as_str()));
        assert_eq!(b_after.secret_ref, b_before.secret_ref, "company 2's secret_ref unchanged");
        assert_eq!(b_after.company_id, Some(2));

        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn member_can_rotate_own_company_account_ref() {
        // No regression: a member rotating THEIR OWN company's account by account_ref
        // succeeds and rotates in place (same row/id, new secret_ref).
        let (state, dir) = paste_state().await;
        connectors::upsert(&state.pool, "gh", "mcp_catalog", "gh", "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
        seed_session(&state, "bot1", Some(1)).await;

        let (a_ref, a_secret) = owner_seal(&state, "gh", "alice", Some("bot1")).await;
        let res = seal_replace(&state, member(1), "gh", "alice", Some("bot1"), &a_ref)
            .await
            .expect("own-company rotation accepted");
        assert_eq!(res.0["account_ref"].as_str(), Some(a_ref.as_str()), "same row rotated");
        let a = connectors::account_get(&state.pool, &a_ref).await.unwrap().unwrap();
        assert_ne!(a.secret_ref.as_deref(), Some(a_secret.as_str()), "secret rotated in place");
        assert_eq!(a.company_id, Some(1), "scope preserved");
        assert_eq!(
            connectors::accounts_for_connector(&state.pool, "gh").await.unwrap().len(),
            1,
            "one row (no dup minted)"
        );

        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn owner_may_rotate_any_account_ref_unfenced() {
        // Owner-neutral: Scope::All rotates any account regardless of its company,
        // byte-identical to before the parity fence.
        let (state, dir) = paste_state().await;
        connectors::upsert(&state.pool, "gh", "mcp_catalog", "gh", "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
        seed_session(&state, "bot2", Some(2)).await;

        let (b_ref, b_secret) = owner_seal(&state, "gh", "alice", Some("bot2")).await;
        // Owner (OptCtx(None) → Scope::All) rotates the company-2 account with a bare
        // (HQ) target — accepted, in place, scope preserved.
        let res = seal_replace(&state, crate::scope::OptCtx(None), "gh", "alice", None, &b_ref)
            .await
            .expect("owner rotation accepted");
        assert_eq!(res.0["account_ref"].as_str(), Some(b_ref.as_str()));
        let b = connectors::account_get(&state.pool, &b_ref).await.unwrap().unwrap();
        assert_ne!(b.secret_ref.as_deref(), Some(b_secret.as_str()), "secret rotated");
        assert_eq!(b.company_id, Some(2), "rotation preserves the account's own company");

        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn put_credential_bare_owner_seal_is_hq_and_dedups() {
        let (state, dir) = paste_state().await;
        connectors::upsert(&state.pool, "gh", "mcp_catalog", "gh", "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();

        // A bare owner seal (no session_name) is HQ/global → company_id None.
        let (r1, _) = owner_seal(&state, "gh", "alice", None).await;
        let a = connectors::account_get(&state.pool, &r1).await.unwrap().unwrap();
        assert_eq!(a.company_id, None, "bare owner seal is HQ/None");

        // A second bare seal of the same label dedups to that one HQ row.
        let (r2, _) = owner_seal(&state, "gh", "alice", None).await;
        assert_eq!(r2, r1, "two HQ seals of the same label → one row (IS NULL dedup)");
        assert_eq!(
            connectors::accounts_for_connector(&state.pool, "gh").await.unwrap().len(),
            1,
            "one HQ account, not a duplicate"
        );

        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }
}
