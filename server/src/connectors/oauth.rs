//! P2a — connector-OAuth **device-code** sign-in (RFC 8628) + guided per-company
//! OAuth-app registration.
//!
//! Two independent things, mirroring the P3 human-login concepts:
//!
//!   * **The OAuth app** the box owns (`client_id` + `client_secret`) for a
//!     `(provider, company)`. The user self-registers it through a guided in-app
//!     flow (`POST /api/oauth/apps`) — no owner CLI pre-step, open-source-friendly.
//!     The non-secret `client_id` + `scopes` ride the companion
//!     `companies_config.toml` (via [`crate::external_access::store`]); the
//!     `client_secret` lives 0600 in its OWN per-provider/company file
//!     ([`client_secret_path`]). Hot-reloaded into
//!     [`AppState::oauth_apps`](crate::state::AppState::oauth_apps) — no restart.
//!   * **The grant** (per bot) — a real device-code sign-in ("go to
//!     github.com/login/device, enter CODE") whose resulting `access_token` seals
//!     into the SAME vault + account + grant path an api_key paste uses
//!     ([`crate::connectors::api::put_credential`]), auto-granted to the target
//!     session. The bot's MCP env then receives the token IDENTICALLY.
//!
//! **Secret hygiene (load-bearing).** `client_secret` is 0600, never in the
//! companion TOML, never in any response, never logged. `access_token` /
//! `refresh_token` seal into the AES-256-GCM vault and only ever surface as MCP
//! launch env. `device_code` lives server-side in a [`DeviceHandle`] only; the
//! client holds only an opaque v4-UUID handle. Any provider-error diagnostic runs
//! through [`crate::log_redact::redact_secrets`] before it can reach a log line.
//!
//! **Member scoping.** Registration is owner/admin-only (`require_admin` first,
//! AND the new `/api/oauth/apps` prefix is absent from the member allowlist, so
//! the deny-by-default backstop denies members too). Device start/poll are
//! member-reachable via the existing `/api/connectors` blanket, but fenced
//! in-handler by [`authorize_session_for_human`] + [`authorize_connector_target`]
//! to the member's OWN company (`*`/cross-company/foreign → uniform 404).

use std::collections::BTreeMap;
use std::path::{Path as FsPath, PathBuf};

use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use dashmap::DashMap;

use crate::config::{read_secret_file, write_token_0600};
use crate::connectors::catalog;
use crate::db::connectors;
use crate::error::AppError;
use crate::external_access::store::{self, OauthApp};
use crate::scope::{
    authorize_connector_target, authorize_session_for_human, require_admin, OptCtx, Scope,
};
use crate::state::AppState;
use crate::vault::Vault;

use super::manifest::valid_connector_id;

/// Per-provider 0600 client-secret file prefix under `<data_dir>`.
pub const OAUTH_SECRET_PREFIX: &str = "oauth_client_secret";

// ── provider map + endpoints ────────────────────────────────────────────────────

/// Map a connector id onto its OAuth **provider**, or `None` for a connector that
/// cannot upgrade to device sign-in.
///
/// Only these ids can flip to `oauth_device`. `mcp_oauth` connectors
/// (pmcp-google-drive, pmcp-slack, pmcp-notion…) are deliberately EXCLUDED and
/// untouched; pmcp-google-maps stays `api_key` (a Maps key, not a user OAuth).
/// Extend the google arm as device-capable Google MCP ids are curated — a
/// not-registered provider always falls back to the api_key paste, so extending
/// the map is safe with zero dead ends.
pub fn connector_provider(id: &str) -> Option<&'static str> {
    match id {
        "pmcp-github" => Some("github"),
        "pmcp-google" | "pmcp-gmail" | "pmcp-google-calendar" => Some("google"),
        _ => None,
    }
}

// ── catalog resolution + install parity (mirrors api::get_one / store_manifest) ──

/// The catalog-mirror card for `id` (curated ∪ last-good live) — the SAME cache
/// [`crate::connectors::api::get_one`] falls back to. `cached_cards()` always folds
/// the curated set in (`merge_featured`), so a cold mirror still resolves
/// `pmcp-github`.
async fn catalog_card(id: &str) -> Option<Value> {
    catalog::mirror()
        .cached_cards()
        .await
        .into_iter()
        .find(|c| c.get("id").and_then(Value::as_str) == Some(id))
}

/// True when `id` resolves to a catalog card even with no installed DB row yet.
async fn catalog_has(id: &str) -> bool {
    catalog_card(id).await.is_some()
}

/// Idempotent server-side install of a catalog connector into the local registry —
/// the device-flow analogue of the store's client `actions.install`
/// (`POST /api/connectors` → `store_manifest`). No-op when the row already exists.
///
/// Deliberately bypasses the `require_admin` HTTP gate: the caller already passed
/// the member fence (`authorize_session_for_human` + `authorize_connector_target`,
/// own-company only) and `id` is a curated/mirror-resolved id (never arbitrary
/// member input), so no member can author an arbitrary global definition here.
/// Provenance = `{ imported:true }` only (secret-free, same as `store_manifest`):
/// `derive_auth` STEP 0 re-derives the `oauth_device` lane from the registered app,
/// so no auth descriptor needs persisting.
async fn ensure_connector_installed(state: &AppState, id: &str) -> Result<(), AppError> {
    if connectors::get(&state.pool, id).await.map_err(db_err)?.is_some() {
        return Ok(());
    }
    let card = catalog_card(id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    let s = |k: &str| card.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let j = |k: &str, d: &str| {
        card.get(k)
            .filter(|v| !v.is_null())
            .map(|v| v.to_string())
            .unwrap_or_else(|| d.to_string())
    };
    let kind = card
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or(super::manifest::KIND_MCP_CATALOG);
    connectors::upsert(
        &state.pool,
        id,
        kind,
        &s("display_name"),
        &s("icon"),
        &s("description"),
        &j("tools", "[]"),
        &j("credentials", "[]"),
        &j("emit", "{}"),
        r#"{"imported":true}"#,
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Drop every device handle whose window has closed. Pure over the map + a clock so
/// the sweep is unit-testable without the network. Handles hold a `client_secret` +
/// `device_code` in RAM and are otherwise pruned only on a poll, so an abandoned
/// flow would leak until process exit without this.
fn sweep_expired(handles: &DashMap<String, DeviceHandle>, now: i64) {
    handles.retain(|_, h| h.expires_at > now);
}

/// `(device_url, token_url, token_field)` for a validated provider.
fn provider_endpoints(provider: &str) -> (&'static str, &'static str, &'static str) {
    match provider {
        "google" => (
            "https://oauth2.googleapis.com/device/code",
            "https://oauth2.googleapis.com/token",
            "GOOGLE_OAUTH_TOKEN",
        ),
        // github (and any validated-but-unmatched provider defaults to github's
        // public endpoints; callers only ever pass a normalized provider).
        _ => (
            "https://github.com/login/device/code",
            "https://github.com/login/oauth/access_token",
            "GITHUB_TOKEN",
        ),
    }
}

/// Validate a provider string to the supported set, returning its `&'static`
/// canonical form so no user-controlled bytes ever reach a file path.
fn normalize_provider(raw: &str) -> Result<&'static str, AppError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "github" => Ok("github"),
        "google" => Ok("google"),
        _ => Err(AppError::BadRequest(
            "provider must be one of: github, google".into(),
        )),
    }
}

/// Human display name for a provider (fallback account label).
fn provider_display(provider: &str) -> String {
    match provider {
        "google" => "Google",
        _ => "GitHub",
    }
    .to_string()
}

/// The one-line steer shown under the card for a device-sign-in connector.
fn device_help_text(provider: &str) -> String {
    match provider {
        "google" => "Sign in with Google — no token to paste.",
        _ => "Sign in with GitHub — no token to paste.",
    }
    .to_string()
}

/// Recommended least-privilege scopes when the registration omits them.
fn default_scopes(provider: &str) -> Vec<String> {
    match provider {
        "google" => vec![
            "https://www.googleapis.com/auth/userinfo.email".into(),
            "openid".into(),
        ],
        _ => vec!["repo".into(), "read:org".into()],
    }
}

// ── companion + secret storage ──────────────────────────────────────────────────

/// `<data_dir>/oauth_client_secret_<provider>_<scope>` — the 0600 client-secret
/// file. `scope` is the `company_id` or the literal `global`. `provider` is
/// validated to `github|google` BEFORE this is called, so the filename can never
/// traverse (no `/`, `..`, metachars).
pub fn client_secret_path(data_dir: &FsPath, provider: &str, company_id: Option<i64>) -> PathBuf {
    let scope = company_id
        .map(|i| i.to_string())
        .unwrap_or_else(|| "global".into());
    data_dir.join(format!("{OAUTH_SECRET_PREFIX}_{provider}_{scope}"))
}

/// Active-company app wins, else the global (`company_id = None`) app.
pub fn resolve_app<'a>(
    apps: &'a [OauthApp],
    provider: &str,
    want_company: Option<i64>,
) -> Option<&'a OauthApp> {
    apps.iter()
        .find(|a| a.provider == provider && a.company_id == want_company)
        .or_else(|| apps.iter().find(|a| a.provider == provider && a.company_id.is_none()))
}

/// Show only the tail of a client id so a list/echo carries no full credential
/// (a client id is low-sensitivity but there is no reason to echo it in full).
fn mask_client_id(id: &str) -> String {
    let n = id.chars().count();
    if n <= 6 {
        return "•".repeat(n);
    }
    let tail: String = id.chars().skip(n.saturating_sub(6)).collect();
    format!("…{tail}")
}

// ── auth descriptor (context-aware derive_auth STEP 0) ──────────────────────────

/// Build the `oauth_device` [`AuthDescriptor`](super::manifest::AuthDescriptor)
/// JSON for a provider-backed connector that HAS a registered app. Fills the P2
/// fields reserved on the descriptor (`device_url`/`token_url`/`scopes`/
/// `token_field`).
pub fn oauth_device_descriptor(provider: &str, scopes: &[String]) -> Value {
    let (device_url, token_url, token_field) = provider_endpoints(provider);
    json!({
        "kind": "oauth_device",
        "help_text": device_help_text(provider),
        "token_field": token_field,
        "scopes": scopes,
        "device_url": device_url,
        "token_url": token_url,
    })
}

// ── device-flow ephemeral handle ────────────────────────────────────────────────

/// One in-flight RFC-8628 device grant. Held ONLY in
/// [`AppState::oauth_device_handles`](crate::state::AppState::oauth_device_handles),
/// keyed by an opaque v4-UUID handle. The `client_secret` + `device_code` are
/// in-RAM only and are NEVER serialized, returned, or logged.
pub struct DeviceHandle {
    pub connector_id: String,
    pub provider: &'static str,
    /// Normalized grant target (the auto-grant destination), re-checked on poll.
    pub session: String,
    /// Resolved scope of the app used, re-checked on poll.
    pub company_id: Option<i64>,
    pub token_url: &'static str,
    /// Vault field key the token seals under (GITHUB_TOKEN / GOOGLE_OAUTH_TOKEN).
    pub token_field: String,
    pub client_id: String,
    /// In-RAM only; NEVER serialized/returned/logged.
    pub client_secret: String,
    /// In-RAM only; NEVER returned/logged.
    pub device_code: String,
    /// Seconds between polls; grows on a provider `slow_down`.
    pub interval: i64,
    /// Unix seconds; a poll at/after this expires the handle.
    pub expires_at: i64,
    /// Unix seconds of the last provider poll (local rate-guard).
    pub last_poll: i64,
}

/// The terminal/transient outcome of a token-endpoint poll — a PURE mapping of a
/// provider response, unit-testable without the network.
#[derive(Debug, PartialEq, Eq)]
enum PollOutcome {
    Pending,
    SlowDown,
    Denied,
    Expired,
    Authorized {
        access_token: String,
        refresh_token: Option<String>,
    },
}

/// Map a token-endpoint JSON body onto a [`PollOutcome`]. GitHub returns HTTP 200
/// with an `error` field while pending; Google uses 4xx — either way the body is
/// what we branch on. `access_token` present ⇒ authorized.
fn map_token_response(v: &Value) -> PollOutcome {
    if let Some(at) = v.get("access_token").and_then(Value::as_str) {
        if !at.is_empty() {
            return PollOutcome::Authorized {
                access_token: at.to_string(),
                refresh_token: v
                    .get("refresh_token")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            };
        }
    }
    match v.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => PollOutcome::Pending,
        Some("slow_down") => PollOutcome::SlowDown,
        Some("access_denied") => PollOutcome::Denied,
        Some("expired_token") => PollOutcome::Expired,
        // Unknown/absent error with no token: keep polling (expiry will prune),
        // never mint a false success.
        _ => PollOutcome::Pending,
    }
}

// ── router ──────────────────────────────────────────────────────────────────────

/// The P2a sub-router. Merged into `http::protected_router`. Registration routes
/// self-guard via `require_admin` (members also denied by the deny-by-default
/// backstop, since `/api/oauth/apps` is a new prefix). Device routes live under
/// `/api/connectors`, already member-reachable, fenced in-handler.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/oauth/apps", get(list_apps).post(register_app))
        .route("/api/oauth/apps/{provider}", delete(delete_app_global))
        .route(
            "/api/oauth/apps/{provider}/{company_id}",
            delete(delete_app_scoped),
        )
        .route(
            "/api/connectors/{id}/oauth/device/start",
            post(device_start),
        )
        .route("/api/connectors/{id}/oauth/device/poll", post(device_poll))
        .with_state(state)
}

// ── registration (owner/admin only) ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RegisterAppBody {
    provider: String,
    #[serde(default)]
    company_id: Option<i64>,
    client_id: String,
    client_secret: String,
    #[serde(default)]
    scopes: Option<Vec<String>>,
}

/// The per-provider "how to create the app" guidance the wizard renders.
fn guidance(provider: &str) -> Value {
    match provider {
        "google" => json!({
            "create_url": "https://console.cloud.google.com/apis/credentials  (OAuth client ID → Application type: TV and Limited Input devices)",
            "device_flow_note": "Create a 'TV and Limited Input' OAuth client. Configure the OAuth consent screen with the scopes below and add the human as a Test user (or publish the app), or they will hit access_denied. Device flow uses NO redirect URI.",
            "redirect_uri": Value::Null,
            "recommended_scopes": default_scopes("google"),
        }),
        _ => json!({
            "create_url": "https://github.com/settings/developers  (New OAuth App)",
            "device_flow_note": "Register an OAuth App (NOT a GitHub App) and enable 'Device Flow' on it. The Authorization callback URL is required by the form but UNUSED by device flow — any https URL (e.g. your dashboard origin) is fine.",
            "redirect_uri": Value::Null,
            "recommended_scopes": default_scopes("github"),
        }),
    }
}

/// `POST /api/oauth/apps` — idempotent upsert of a `(provider, company)` OAuth
/// app. Owner/admin-only. Writes the `client_secret` 0600, the non-secret bits to
/// the companion store, hot-reloads. NEVER returns the secret.
async fn register_app(
    State(state): State<AppState>,
    ctx: OptCtx,
    Json(body): Json<RegisterAppBody>,
) -> Result<Json<Value>, AppError> {
    require_admin(ctx.0.as_ref(), "/api/oauth/apps")?;
    let provider = normalize_provider(&body.provider)?;
    let client_id = body.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(AppError::BadRequest("client_id is required".into()));
    }
    if provider == "google" && !client_id.ends_with(".apps.googleusercontent.com") {
        return Err(AppError::BadRequest(
            "google client_id must be a Google OAuth client id (…apps.googleusercontent.com)".into(),
        ));
    }
    let client_secret = body.client_secret.trim().to_string();
    if client_secret.is_empty() {
        return Err(AppError::BadRequest("client_secret is required".into()));
    }
    // A per-company app must reference a real company (hide-existence 404 parity).
    if let Some(cid) = body.company_id {
        crate::db::companies::get(&state.pool, cid)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("company id={cid}")))?;
    }
    let scopes = body
        .scopes
        .map(|s| s.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>())
        .filter(|s: &Vec<String>| !s.is_empty())
        .unwrap_or_else(|| default_scopes(provider));

    // Secret 0600 first (re-tightened on rewrite → rotation-safe).
    write_token_0600(
        &client_secret_path(&state.config.data_dir, provider, body.company_id),
        &client_secret,
    )
    .map_err(AppError::Internal)?;

    // Non-secret bits → the companion store (atomic), then hot-reload.
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    store::upsert_oauth_app(
        &mut cfg,
        OauthApp {
            provider: provider.to_string(),
            company_id: body.company_id,
            client_id: client_id.clone(),
            scopes: scopes.clone(),
        },
    );
    store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;
    state.reload_oauth_apps().map_err(AppError::Internal)?;

    audit(
        &state,
        "oauth.app.register",
        provider,
        json!({ "company_id": body.company_id }),
    )
    .await;

    Ok(Json(json!({
        "provider": provider,
        "company_id": body.company_id,
        "client_id_masked": mask_client_id(&client_id),
        "scopes": scopes,
        "registered": true,
        "guidance": guidance(provider),
    })))
}

/// `GET /api/oauth/apps` — list registered apps (no secrets). Owner/admin-only.
async fn list_apps(State(state): State<AppState>, ctx: OptCtx) -> Result<Json<Value>, AppError> {
    require_admin(ctx.0.as_ref(), "/api/oauth/apps")?;
    let apps = state.oauth_apps.load();
    let out: Vec<Value> = apps
        .iter()
        .map(|a| {
            json!({
                "provider": a.provider,
                "company_id": a.company_id,
                "client_id_masked": mask_client_id(&a.client_id),
                "scopes": a.scopes,
            })
        })
        .collect();
    Ok(Json(json!({ "apps": out })))
}

async fn delete_app_global(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(provider): Path<String>,
) -> Result<Json<Value>, AppError> {
    delete_app_inner(state, ctx, provider, None).await
}

async fn delete_app_scoped(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path((provider, company_id)): Path<(String, i64)>,
) -> Result<Json<Value>, AppError> {
    delete_app_inner(state, ctx, provider, Some(company_id)).await
}

/// `DELETE /api/oauth/apps/{provider}/{company_id?}` — remove an app + its 0600
/// secret. Owner/admin-only.
async fn delete_app_inner(
    state: AppState,
    ctx: OptCtx,
    provider: String,
    company_id: Option<i64>,
) -> Result<Json<Value>, AppError> {
    require_admin(ctx.0.as_ref(), "/api/oauth/apps")?;
    let provider = normalize_provider(&provider)?;
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    let removed = store::remove_oauth_app(&mut cfg, provider, company_id);
    if removed {
        store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;
        state.reload_oauth_apps().map_err(AppError::Internal)?;
        // Best-effort unlink of the 0600 secret (a leftover is harmless but tidy).
        let _ = std::fs::remove_file(client_secret_path(
            &state.config.data_dir,
            provider,
            company_id,
        ));
        audit(
            &state,
            "oauth.app.remove",
            provider,
            json!({ "company_id": company_id }),
        )
        .await;
    }
    Ok(Json(json!({ "removed": removed })))
}

// ── device-code grant (member may use for an own-company target) ────────────────

#[derive(Debug, Deserialize)]
struct DeviceStartBody {
    session: String,
    #[serde(default)]
    company_id: Option<i64>,
}

/// `POST /api/connectors/{id}/oauth/device/start` — begin an RFC-8628 device
/// grant. Returns the human-facing `user_code`/`verification_uri` + an opaque
/// `handle`. The `device_code`/`client_secret`/`token_url` NEVER leave the server.
async fn device_start(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<String>,
    Json(body): Json<DeviceStartBody>,
) -> Result<Json<Value>, AppError> {
    if !valid_connector_id(&id) {
        return Err(AppError::BadRequest("invalid connector id".into()));
    }
    // Opportunistic sweep: drop any handles whose window has closed (they hold a
    // client_secret + device_code in RAM; a poll normally prunes them, but an
    // abandoned flow never polls). O(n) over a handful of in-flight entries.
    sweep_expired(&state.oauth_device_handles, chrono::Utc::now().timestamp());

    let provider = connector_provider(&id)
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    // The connector must be RESOLVABLE (installed DB row OR a catalog-mirror card),
    // exactly like `api::get_one`. A curated connector like pmcp-github is not a DB
    // row until installed — the row is FK-created later in `seal_and_grant`
    // (`ensure_connector_installed` before `vault_put`), so an abandoned flow leaves
    // no orphan row. A genuinely-unknown id still 404s.
    let installed = connectors::get(&state.pool, &id).await.map_err(db_err)?.is_some();
    if !installed && !catalog_has(&id).await {
        return Err(AppError::NotFound(format!("connector '{id}'")));
    }

    // Member fence: own-company session target only (uniform 404 otherwise).
    let session = normalize_session(&body.session);
    authorize_session_for_human(&state, ctx.0.as_ref(), &session).await?;
    authorize_connector_target(&state, ctx.0.as_ref(), &session).await?;

    // Resolve the app: a member is pinned to their own company; an owner may name
    // a company (else the global app).
    let want_company = match Scope::of(ctx.0.as_ref()) {
        Scope::Company(cid) => Some(cid),
        Scope::All => body.company_id,
    };
    let apps = state.oauth_apps.load();
    let app = resolve_app(&apps, provider, want_company)
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    let app_company = app.company_id;
    let client_id = app.client_id.clone();
    let scope_str = app.scopes.join(" ");
    drop(apps);

    // Load the 0600 client secret for the RESOLVED app scope (RAM-only).
    let client_secret = read_secret_file(&client_secret_path(
        &state.config.data_dir,
        provider,
        app_company,
    ))
    .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;

    let (device_url, token_url, token_field) = provider_endpoints(provider);
    let http = reqwest::Client::new();
    let resp = http
        .post(device_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "supermux")
        .form(&[("client_id", client_id.as_str()), ("scope", scope_str.as_str())])
        .send()
        .await
        .map_err(|e| provider_error("device start request failed", &e.to_string(), &[&client_secret]))?;
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);
    if !status.is_success() || parsed.get("device_code").is_none() {
        let err = parsed
            .get("error_description")
            .or_else(|| parsed.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("device authorization failed")
            .to_string();
        return Err(provider_error(
            "device start rejected",
            &format!("{status}: {err}"),
            &[&client_secret],
        ));
    }

    let device_code = parsed
        .get("device_code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let user_code = parsed
        .get("user_code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // github → `verification_uri`; google → `verification_url` (accept both).
    let verification_uri = parsed
        .get("verification_uri")
        .or_else(|| parsed.get("verification_url"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let verification_uri_complete = parsed
        .get("verification_uri_complete")
        .and_then(Value::as_str)
        .map(String::from);
    let expires_in = parsed.get("expires_in").and_then(Value::as_i64).unwrap_or(900);
    let interval = parsed.get("interval").and_then(Value::as_i64).unwrap_or(5).max(1);

    let now = chrono::Utc::now().timestamp();
    let handle = uuid::Uuid::new_v4().to_string();
    state.oauth_device_handles.insert(
        handle.clone(),
        DeviceHandle {
            connector_id: id,
            provider,
            session,
            company_id: app_company,
            token_url,
            token_field: token_field.to_string(),
            client_id,
            client_secret,
            device_code,
            interval,
            expires_at: now + expires_in,
            last_poll: 0,
        },
    );

    let mut out = json!({
        "user_code": user_code,
        "verification_uri": verification_uri,
        "expires_in": expires_in,
        "interval": interval,
        "handle": handle,
    });
    if let Some(vc) = verification_uri_complete {
        out["verification_uri_complete"] = json!(vc);
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
struct DevicePollBody {
    handle: String,
}

/// `POST /api/connectors/{id}/oauth/device/poll` — poll the provider token
/// endpoint. On `authorized` seals the token into the vault + auto-grants to the
/// bound session, returning `{ status:"authorized", account_ref }`. The token is
/// NEVER returned.
async fn device_poll(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<String>,
    Json(body): Json<DevicePollBody>,
) -> Result<Json<Value>, AppError> {
    // Snapshot the handle under a short-lived lock (never held across the await).
    let snap = match state.oauth_device_handles.get(&body.handle) {
        Some(h) => {
            // The handle must be for THIS connector route.
            if h.connector_id != id {
                return Ok(Json(json!({ "status": "expired" })));
            }
            (
                h.connector_id.clone(),
                h.provider,
                h.session.clone(),
                h.token_url,
                h.token_field.clone(),
                h.client_id.clone(),
                h.client_secret.clone(),
                h.device_code.clone(),
                h.interval,
                h.expires_at,
                h.last_poll,
            )
        }
        None => return Ok(Json(json!({ "status": "expired" }))),
    };
    let (connector_id, provider, session, token_url, token_field, client_id, client_secret, device_code, interval, expires_at, last_poll) =
        snap;

    let now = chrono::Utc::now().timestamp();
    if now >= expires_at {
        state.oauth_device_handles.remove(&body.handle);
        return Ok(Json(json!({ "status": "expired" })));
    }

    // Re-authorize the BOUND session against the CURRENT caller, so a leaked/
    // guessed handle used by another member still 404s (defense in depth).
    authorize_session_for_human(&state, ctx.0.as_ref(), &session).await?;
    authorize_connector_target(&state, ctx.0.as_ref(), &session).await?;

    // Local rate-guard: don't hit the provider more often than `interval`.
    if last_poll != 0 && now - last_poll < interval {
        return Ok(Json(json!({ "status": "slow_down" })));
    }

    let http = reqwest::Client::new();
    let resp = http
        .post(token_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "supermux")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("device_code", device_code.as_str()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code",
            ),
        ])
        .send()
        .await
        .map_err(|e| {
            provider_error(
                "device poll request failed",
                &e.to_string(),
                &[&client_secret, &device_code],
            )
        })?;
    let body_text = resp.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);

    match map_token_response(&parsed) {
        PollOutcome::Pending => {
            if let Some(mut h) = state.oauth_device_handles.get_mut(&body.handle) {
                h.last_poll = now;
            }
            Ok(Json(json!({ "status": "pending" })))
        }
        PollOutcome::SlowDown => {
            if let Some(mut h) = state.oauth_device_handles.get_mut(&body.handle) {
                h.interval += 5; // RFC-8628 §3.5
                h.last_poll = now;
            }
            Ok(Json(json!({ "status": "slow_down" })))
        }
        PollOutcome::Denied => {
            state.oauth_device_handles.remove(&body.handle);
            Ok(Json(json!({ "status": "denied" })))
        }
        PollOutcome::Expired => {
            state.oauth_device_handles.remove(&body.handle);
            Ok(Json(json!({ "status": "expired" })))
        }
        PollOutcome::Authorized {
            access_token,
            refresh_token,
        } => {
            // Drop the handle FIRST (single-purpose, terminal).
            state.oauth_device_handles.remove(&body.handle);
            let account_ref = seal_and_grant(
                &state,
                provider,
                &connector_id,
                &session,
                &token_field,
                &access_token,
                refresh_token.as_deref(),
            )
            .await?;
            audit(
                &state,
                "connector.oauth_device",
                &connector_id,
                json!({ "session": session, "provider": provider }),
            )
            .await;
            Ok(Json(json!({ "status": "authorized", "account_ref": account_ref })))
        }
    }
}

/// Seal the granted token into the vault + auto-grant to the bound session —
/// byte-identical plumbing to the api_key paste path
/// ([`crate::connectors::api::put_credential`]). Returns the minted `account_ref`.
/// The token is NEVER returned or logged.
async fn seal_and_grant(
    state: &AppState,
    provider: &str,
    connector_id: &str,
    session: &str,
    token_field: &str,
    access_token: &str,
    refresh_token: Option<&str>,
) -> Result<String, AppError> {
    // FK-safe + paste parity: the vault row references connectors(id), and a catalog
    // connector has no DB row until now. Install it exactly like the store paste path
    // (client `actions.install` → store_manifest) does before its own vault_put.
    ensure_connector_installed(state, connector_id).await?;

    let mut fields: BTreeMap<String, String> = BTreeMap::new();
    fields.insert(token_field.to_string(), access_token.to_string());
    if let Some(rt) = refresh_token {
        fields.insert(format!("{token_field}_REFRESH"), rt.to_string());
    }

    let vault = Vault::open(&state.config.data_dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("vault unavailable: {e}")))?;
    let sealed = vault
        .seal(&fields)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("sealing token: {e}")))?;
    let secret_ref = uuid::Uuid::new_v4().to_string();
    connectors::vault_put(
        &state.pool,
        &secret_ref,
        connector_id,
        &sealed.fields_enc,
        &sealed.nonce,
        false,
    )
    .await
    .map_err(db_err)?;

    // Best-effort, non-secret display label (identity), else the provider name.
    let label = fetch_identity_label(provider, access_token)
        .await
        .unwrap_or_else(|| provider_display(provider));
    // Company scope of the account = the grant target's company (own > company >
    // all). `session` is the already-normalized DeviceHandle target; an HQ bot
    // (company_id NULL) or `*` target → None. A same-label account is reused ONLY
    // within the same scope, so company A and company B never share the row /
    // secret_ref (P2b).
    let account_company = connectors::company_of_grant_target(&state.pool, session).await;
    // Idempotent-by-(label, company), mirroring the paste path (api::put_credential):
    // a same-label same-scope account is re-pointed at the fresh secret_ref in place
    // (keeping every grant wired) instead of minting a duplicate on each re-sign-in.
    let account_ref = match connectors::account_find_by_label(
        &state.pool,
        connector_id,
        &label,
        account_company,
    )
    .await
    .map_err(db_err)?
    {
        Some(a) => {
            connectors::account_replace(&state.pool, &a.id, &label, Some(&secret_ref))
                .await
                .map_err(db_err)?;
            a.id
        }
        None => {
            connectors::account_add(&state.pool, connector_id, &label, Some(&secret_ref), account_company)
                .await
                .map_err(db_err)?
        }
    };
    connectors::grant_with_account(
        &state.pool,
        session,
        connector_id,
        Some(&secret_ref),
        true,
        Some(&account_ref),
    )
    .await
    .map_err(db_err)?;
    Ok(account_ref)
}

/// Best-effort NON-secret identity label for the connected account (github login
/// / google email). Never fatal: any failure yields `None` and the caller falls
/// back to the provider name. The access token is used only as a bearer here and
/// is never logged.
async fn fetch_identity_label(provider: &str, access_token: &str) -> Option<String> {
    let http = reqwest::Client::new();
    match provider {
        "github" => {
            let v: Value = http
                .get("https://api.github.com/user")
                .header(reqwest::header::USER_AGENT, "supermux")
                .header(reqwest::header::ACCEPT, "application/vnd.github+json")
                .bearer_auth(access_token)
                .send()
                .await
                .ok()?
                .json()
                .await
                .ok()?;
            v.get("login").and_then(Value::as_str).map(String::from)
        }
        "google" => {
            let v: Value = http
                .get("https://www.googleapis.com/oauth2/v3/userinfo")
                .bearer_auth(access_token)
                .send()
                .await
                .ok()?
                .json()
                .await
                .ok()?;
            v.get("email").and_then(Value::as_str).map(String::from)
        }
        _ => None,
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/// Build a redacted-diagnostic 502 from a provider error. The message is scrubbed
/// of every known secret BEFORE it becomes an `AppError` (whose `Display` may be
/// logged), so a secret read from a 0600 file / the vault can never survive.
fn provider_error(context: &str, detail: &str, secrets: &[&str]) -> AppError {
    let scrubbed = crate::log_redact::redact_secrets(detail, secrets);
    AppError::Internal(anyhow::anyhow!("{context}: {scrubbed}"))
}

/// Normalize a grant scope string onto its stored `session_connectors.session_name`
/// (mirrors the api.rs helper): `all`/`*` → `*`, `company:<id>` → `@company:<id>`,
/// else pass-through.
fn normalize_session(s: &str) -> String {
    let t = s.trim();
    if t == "all" || t == connectors::ALL_AGENTS {
        connectors::ALL_AGENTS.to_string()
    } else if let Some(id) = t.strip_prefix("company:") {
        format!("{}{id}", connectors::COMPANY_PREFIX)
    } else {
        t.to_string()
    }
}

fn db_err(e: sqlx::Error) -> AppError {
    AppError::Internal(anyhow::anyhow!(e))
}

/// Audit row — KEYS / ids only, NEVER a secret value.
async fn audit(state: &AppState, action: &str, id: &str, detail: Value) {
    crate::db::audit::log(&state.pool, "user", action, id, detail)
        .await
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_provider_maps_only_intended_ids() {
        assert_eq!(connector_provider("pmcp-github"), Some("github"));
        assert_eq!(connector_provider("pmcp-gmail"), Some("google"));
        assert_eq!(connector_provider("pmcp-google-calendar"), Some("google"));
        // mcp_oauth + api_key connectors are NEVER remapped.
        assert_eq!(connector_provider("pmcp-slack"), None);
        assert_eq!(connector_provider("pmcp-google-drive"), None);
        assert_eq!(connector_provider("pmcp-google-maps"), None);
        assert_eq!(connector_provider("icloud-mail"), None);
    }

    #[test]
    fn resolve_app_prefers_company_then_global() {
        let apps = vec![
            OauthApp {
                provider: "github".into(),
                company_id: None,
                client_id: "gh-global".into(),
                scopes: vec![],
            },
            OauthApp {
                provider: "github".into(),
                company_id: Some(7),
                client_id: "gh-c7".into(),
                scopes: vec![],
            },
        ];
        // A company with its own app gets it.
        assert_eq!(resolve_app(&apps, "github", Some(7)).unwrap().client_id, "gh-c7");
        // A company WITHOUT its own app falls back to the global app.
        assert_eq!(resolve_app(&apps, "github", Some(9)).unwrap().client_id, "gh-global");
        // Owner (None) gets the global app.
        assert_eq!(resolve_app(&apps, "github", None).unwrap().client_id, "gh-global");
        // A different provider with no app → None (never a dead end; caller falls
        // back to api_key).
        assert!(resolve_app(&apps, "google", Some(7)).is_none());
    }

    #[test]
    fn resolve_app_company_only_does_not_leak_to_others() {
        // ONLY a company-7 app exists (no global).
        let apps = vec![OauthApp {
            provider: "github".into(),
            company_id: Some(7),
            client_id: "gh-c7".into(),
            scopes: vec![],
        }];
        assert!(resolve_app(&apps, "github", Some(7)).is_some());
        // Company 8 and the owner (None) get nothing — no cross-company leak.
        assert!(resolve_app(&apps, "github", Some(8)).is_none());
        assert!(resolve_app(&apps, "github", None).is_none());
    }

    #[test]
    fn oauth_device_descriptor_fills_reserved_fields() {
        let d = oauth_device_descriptor("github", &["repo".to_string()]);
        assert_eq!(d["kind"], json!("oauth_device"));
        assert_eq!(d["token_field"], json!("GITHUB_TOKEN"));
        assert_eq!(d["device_url"], json!("https://github.com/login/device/code"));
        assert_eq!(d["token_url"], json!("https://github.com/login/oauth/access_token"));
        assert_eq!(d["scopes"], json!(["repo"]));

        let g = oauth_device_descriptor("google", &[]);
        assert_eq!(g["token_field"], json!("GOOGLE_OAUTH_TOKEN"));
        assert_eq!(g["device_url"], json!("https://oauth2.googleapis.com/device/code"));
    }

    #[test]
    fn client_secret_path_is_scoped_and_traversal_free() {
        let dd = std::path::Path::new("/data");
        assert_eq!(
            client_secret_path(dd, "github", None),
            std::path::Path::new("/data/oauth_client_secret_github_global")
        );
        assert_eq!(
            client_secret_path(dd, "google", Some(7)),
            std::path::Path::new("/data/oauth_client_secret_google_7")
        );
    }

    #[test]
    fn normalize_provider_validates_the_set() {
        assert_eq!(normalize_provider("github").unwrap(), "github");
        assert_eq!(normalize_provider(" GOOGLE ").unwrap(), "google");
        // A traversal attempt / unknown provider is rejected before any path use.
        assert!(normalize_provider("../etc").is_err());
        assert!(normalize_provider("gitlab").is_err());
    }

    #[test]
    fn map_token_response_status_machine() {
        assert_eq!(
            map_token_response(&json!({ "error": "authorization_pending" })),
            PollOutcome::Pending
        );
        assert_eq!(
            map_token_response(&json!({ "error": "slow_down" })),
            PollOutcome::SlowDown
        );
        assert_eq!(
            map_token_response(&json!({ "error": "access_denied" })),
            PollOutcome::Denied
        );
        assert_eq!(
            map_token_response(&json!({ "error": "expired_token" })),
            PollOutcome::Expired
        );
        // Success mints Authorized with the token + optional refresh.
        match map_token_response(&json!({ "access_token": "tok", "refresh_token": "rt" })) {
            PollOutcome::Authorized { access_token, refresh_token } => {
                assert_eq!(access_token, "tok");
                assert_eq!(refresh_token.as_deref(), Some("rt"));
            }
            other => panic!("expected authorized, got {other:?}"),
        }
        // An empty access_token is NOT a success (never a false green).
        assert_eq!(
            map_token_response(&json!({ "access_token": "" })),
            PollOutcome::Pending
        );
        // Unknown error keeps polling (expiry prunes) rather than faking success.
        assert_eq!(
            map_token_response(&json!({ "error": "weird" })),
            PollOutcome::Pending
        );
    }

    #[test]
    fn mask_client_id_hides_the_bulk() {
        assert_eq!(mask_client_id("abcdef123456"), "…123456");
        assert_eq!(mask_client_id("short"), "•••••");
    }

    // ── integration: member scoping + handle binding (no network reached) ──────

    use crate::auth_human::AuthContext;
    use crate::config::Config;
    use crate::state::AppState;
    use axum::extract::State;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-oauth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:8823".parse().unwrap(),
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

    async fn cleanup(state: AppState, dir: std::path::PathBuf) {
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Seed a session row with an explicit company_id (bypassing the fuller create
    /// path — the scoping guards only read `sessions.company_id`).
    async fn seed_session(state: &AppState, name: &str, company_id: i64) {
        sqlx::query("INSERT INTO sessions (name, dir, provider, company_id, created_at) VALUES (?, ?, 'claude', ?, ?)")
            .bind(name)
            .bind("/tmp")
            .bind(company_id)
            .bind(chrono::Utc::now().timestamp())
            .execute(&state.pool)
            .await
            .unwrap();
    }

    async fn seed_github_connector(state: &AppState) {
        connectors::upsert(
            &state.pool,
            "pmcp-github",
            "mcp_catalog",
            "GitHub",
            "",
            "",
            "[]",
            "[]",
            "{}",
            "{}",
        )
        .await
        .unwrap();
    }

    fn member(company_id: i64) -> OptCtx {
        OptCtx(Some(AuthContext::Human {
            user_id: 1,
            company_id: Some(company_id),
            role: "member".into(),
        }))
    }

    #[tokio::test]
    async fn member_cannot_start_device_for_another_companys_session() {
        let (state, dir) = test_state().await;
        seed_github_connector(&state).await;
        // A session that belongs to company 2.
        seed_session(&state, "bot2", 2).await;
        // A member of company 1 tries to start a device grant targeting it.
        let res = device_start(
            State(state.clone()),
            member(1),
            Path("pmcp-github".into()),
            Json(DeviceStartBody {
                session: "bot2".into(),
                company_id: None,
            }),
        )
        .await;
        // Uniform 404 — byte-identical to a missing session, no network reached.
        assert!(matches!(res, Err(AppError::NotFound(_))), "got {res:?}");
        cleanup(state, dir).await;
    }

    #[tokio::test]
    async fn member_cannot_start_device_for_the_global_all_agents_scope() {
        let (state, dir) = test_state().await;
        seed_github_connector(&state).await;
        // Targeting `*` (the global all-agents scope) is refused for a member.
        let res = device_start(
            State(state.clone()),
            member(1),
            Path("pmcp-github".into()),
            Json(DeviceStartBody {
                session: "*".into(),
                company_id: None,
            }),
        )
        .await;
        assert!(matches!(res, Err(AppError::NotFound(_))), "got {res:?}");
        cleanup(state, dir).await;
    }

    #[tokio::test]
    async fn poll_with_a_forged_or_foreign_handle_is_rejected() {
        let (state, dir) = test_state().await;
        seed_github_connector(&state).await;

        // (a) A forged/unknown handle → `expired` (never a bearer of anything).
        let res = device_poll(
            State(state.clone()),
            OptCtx(None),
            Path("pmcp-github".into()),
            Json(DevicePollBody { handle: "does-not-exist".into() }),
        )
        .await
        .expect("forged handle answered");
        assert_eq!(res.0["status"], json!("expired"));

        // (b) A real handle bound to a company-2 session, polled by a company-1
        // member → uniform 404 (the handle carries no cross-company authority).
        seed_session(&state, "bot2", 2).await;
        state.oauth_device_handles.insert(
            "h-foreign".into(),
            DeviceHandle {
                connector_id: "pmcp-github".into(),
                provider: "github",
                session: "bot2".into(),
                company_id: Some(2),
                token_url: "https://github.com/login/oauth/access_token",
                token_field: "GITHUB_TOKEN".into(),
                client_id: "cid".into(),
                client_secret: "shh".into(),
                device_code: "dc".into(),
                interval: 5,
                expires_at: chrono::Utc::now().timestamp() + 900,
                last_poll: 0,
            },
        );
        let res = device_poll(
            State(state.clone()),
            member(1),
            Path("pmcp-github".into()),
            Json(DevicePollBody { handle: "h-foreign".into() }),
        )
        .await;
        assert!(matches!(res, Err(AppError::NotFound(_))), "got {res:?}");

        // (c) A handle used on the WRONG connector route → `expired`.
        let res = device_poll(
            State(state.clone()),
            OptCtx(None),
            Path("pmcp-gmail".into()),
            Json(DevicePollBody { handle: "h-foreign".into() }),
        )
        .await
        .expect("wrong-route handle answered");
        assert_eq!(res.0["status"], json!("expired"));

        cleanup(state, dir).await;
    }

    fn handle_expiring_at(expires_at: i64) -> DeviceHandle {
        DeviceHandle {
            connector_id: "pmcp-github".into(),
            provider: "github",
            session: "botX".into(),
            company_id: None,
            token_url: "https://github.com/login/oauth/access_token",
            token_field: "GITHUB_TOKEN".into(),
            client_id: "cid".into(),
            client_secret: "shh".into(),
            device_code: "dc".into(),
            interval: 5,
            expires_at,
            last_poll: 0,
        }
    }

    #[test]
    fn sweep_expired_drops_only_closed_windows() {
        let handles: DashMap<String, DeviceHandle> = DashMap::new();
        handles.insert("past".into(), handle_expiring_at(100));
        handles.insert("future".into(), handle_expiring_at(10_000_000_000));
        // now = 1000: the past handle's window has closed, the future one has not.
        sweep_expired(&handles, 1000);
        assert!(!handles.contains_key("past"), "expired handle (holding a secret) must be swept");
        assert!(handles.contains_key("future"), "a live handle must survive the sweep");
        assert_eq!(handles.len(), 1);
    }

    #[tokio::test]
    async fn ensure_connector_installed_mirrors_paste_and_is_idempotent() {
        let (state, dir) = test_state().await;
        // A curated catalog connector resolves via the mirror even with no DB row…
        assert!(
            connectors::get(&state.pool, "pmcp-github").await.unwrap().is_none(),
            "precondition: no installed row (catalog-only)"
        );
        assert!(catalog_has("pmcp-github").await, "curated connector must resolve");
        assert!(!catalog_has("pmcp-not-a-real-connector").await, "unknown id must not resolve");

        // …and the device path installs it byte-identically to the store paste path.
        ensure_connector_installed(&state, "pmcp-github").await.unwrap();
        let row = connectors::get(&state.pool, "pmcp-github")
            .await
            .unwrap()
            .expect("device flow installs the catalog row before vault_put");
        assert_eq!(row.display_name, "GitHub");
        assert_eq!(row.source_json, r#"{"imported":true}"#);

        // Idempotent: a second call is a no-op (early-returns on the existing row).
        ensure_connector_installed(&state, "pmcp-github").await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM connectors WHERE id = 'pmcp-github'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(n, 1, "no duplicate row on re-install");
        cleanup(state, dir).await;
    }

    #[tokio::test]
    async fn seal_and_grant_is_idempotent_by_label() {
        let (state, dir) = test_state().await;
        // No pre-seeded connector row: seal_and_grant must install it (FK parity) and
        // seal + grant. The identity fetch uses an invalid token, so the label
        // deterministically falls back to the provider display ("GitHub").
        let a1 = seal_and_grant(
            &state, "github", "pmcp-github", "botX", "GITHUB_TOKEN", "tok-1", None,
        )
        .await
        .expect("first sign-in seals + grants");
        // A re-sign-in of the SAME identity must update the one account, not mint a dup.
        let a2 = seal_and_grant(
            &state, "github", "pmcp-github", "botX", "GITHUB_TOKEN", "tok-2", None,
        )
        .await
        .expect("re-sign-in seals + grants");
        assert_eq!(a1, a2, "same-label account is reused (account_replace), not duplicated");
        let accounts = connectors::accounts_for_connector(&state.pool, "pmcp-github")
            .await
            .unwrap();
        assert_eq!(accounts.len(), 1, "one account row, not one-per-sign-in");
        cleanup(state, dir).await;
    }

    #[tokio::test]
    async fn seal_and_grant_scopes_account_per_company() {
        // The device path scopes the account atom by the grant target's company:
        // botA (company 1) and botB (company 2) both sign in with the SAME identity
        // label ("GitHub", the invalid-token fallback) → TWO distinct rows with
        // DISTINCT secret_refs (no cross-company token swap, P2b).
        let (state, dir) = test_state().await;
        seed_session(&state, "botA", 1).await;
        seed_session(&state, "botB", 2).await;
        let a = seal_and_grant(
            &state, "github", "pmcp-github", "botA", "GITHUB_TOKEN", "tok-A", None,
        )
        .await
        .expect("company-1 sign-in");
        let b = seal_and_grant(
            &state, "github", "pmcp-github", "botB", "GITHUB_TOKEN", "tok-B", None,
        )
        .await
        .expect("company-2 sign-in");
        assert_ne!(a, b, "two companies, same label → two account rows");

        let accounts = connectors::accounts_for_connector(&state.pool, "pmcp-github")
            .await
            .unwrap();
        assert_eq!(accounts.len(), 2, "one row per company scope, not collapsed");
        let acct_a = connectors::account_get(&state.pool, &a).await.unwrap().unwrap();
        let acct_b = connectors::account_get(&state.pool, &b).await.unwrap().unwrap();
        assert_eq!(acct_a.company_id, Some(1));
        assert_eq!(acct_b.company_id, Some(2));
        assert_ne!(
            acct_a.secret_ref, acct_b.secret_ref,
            "distinct secret_refs — company A's grant never re-points to company B's token"
        );

        // Re-sign-in of botA (same scope) reuses A's row, never touches B's.
        let a2 = seal_and_grant(
            &state, "github", "pmcp-github", "botA", "GITHUB_TOKEN", "tok-A2", None,
        )
        .await
        .expect("company-1 re-sign-in");
        assert_eq!(a2, a, "same company + label → the same row updated in place");
        assert_eq!(
            connectors::accounts_for_connector(&state.pool, "pmcp-github").await.unwrap().len(),
            2,
            "still two rows (A updated, B untouched)"
        );
        cleanup(state, dir).await;
    }

    #[tokio::test]
    async fn register_app_writes_0600_secret_and_never_returns_it() {
        let (state, dir) = test_state().await;
        // Owner (no ctx) registers a github app.
        let res = register_app(
            State(state.clone()),
            OptCtx(None),
            Json(RegisterAppBody {
                provider: "github".into(),
                company_id: None,
                client_id: "Iv1.abcdef123456".into(),
                client_secret: "gh-super-secret".into(),
                scopes: None,
            }),
        )
        .await
        .expect("register accepted");
        // The response masks the client id and NEVER carries the secret.
        assert_eq!(res.0["registered"], json!(true));
        assert_eq!(res.0["client_id_masked"], json!("…123456"));
        let body = serde_json::to_string(&res.0).unwrap();
        assert!(!body.contains("gh-super-secret"), "secret echoed: {body}");
        // The secret is on disk 0600, and the companion store carries only the id.
        let secret_path = client_secret_path(&dir, "github", None);
        assert_eq!(
            std::fs::read_to_string(&secret_path).unwrap().trim(),
            "gh-super-secret"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "client secret must be 0600");
        }
        let toml = std::fs::read_to_string(store::path(&dir)).unwrap();
        assert!(toml.contains("Iv1.abcdef123456"), "client id in companion store");
        assert!(!toml.contains("gh-super-secret"), "secret must NEVER be in the companion store");
        // The in-RAM snapshot hot-reloaded — the card would now flip to device.
        assert!(resolve_app(&state.oauth_apps.load(), "github", None).is_some());

        // A member is refused registration (owner/admin-only), uniform 404.
        let res = register_app(
            State(state.clone()),
            member(1),
            Json(RegisterAppBody {
                provider: "github".into(),
                company_id: None,
                client_id: "Iv1.zzz".into(),
                client_secret: "x".into(),
                scopes: None,
            }),
        )
        .await;
        assert!(matches!(res, Err(AppError::NotFound(_))), "member registration got {res:?}");
        cleanup(state, dir).await;
    }
}
