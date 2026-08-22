//! The companies onboarding-wizard backend: external access (Cloudflare wildcard
//! tunnel + Google login) and colleague invites, all OWNER/ADMIN-ONLY.
//!
//! # The endpoints (every one `require_admin`; a member gets a uniform 404)
//!
//! | Method + path | Purpose |
//! |---|---|
//! | `POST /api/external-access/cf-token`       | Validate + store the Cloudflare API token (0600, never returned). |
//! | `POST /api/external-access/provision-tunnel` | One-time idempotent wildcard tunnel + DNS + connector unit. |
//! | `GET  /api/external-access/status`         | Live-verify source the wizard polls. |
//! | `POST /api/external-access/google`         | Save the Google client id + secret (0600), hot-reload. |
//! | `POST /api/companies/{id}/host`            | Derive + write this company's `company_hosts` entry, hot-reload. |
//! | `POST /api/companies/{id}/verify-login`    | Surface the exact redirect URI to register (redirect_uri_mismatch). |
//! | `POST /api/companies/{id}/humans`          | Seed a colleague `human_users` row; returns the login url. |
//! | `GET  /api/companies/{id}/humans`          | List invitees + Invited/Pending/Active status. |
//! | `DELETE /api/companies/{id}/humans/{hid}`  | Revoke an invite (delete row + revoke sessions). |
//!
//! # Architecture (design §0)
//!
//! ONE wildcard tunnel per box (`*.s.iwd.nl → http://localhost:<port>`), so
//! adding a company after box setup is just a `company_hosts` entry + a
//! `human_users` row — ZERO further Cloudflare calls. Cloudflare sits behind
//! [`cf::CfApi`] and the connector unit behind [`systemd::ConnectorHost`] so the
//! whole flow is unit-testable without a live token or `systemctl --user`.
//!
//! # Secrets
//!
//! CF API token `<data_dir>/cf_api_token`, Google secret
//! `<data_dir>/google_client_secret`, connector token `<data_dir>/cloudflared_token`
//! — all 0600, never returned after save, all added to [`crate::log_redact`]. The
//! non-secret config (`google_client_id`, `company_hosts`) lives in the companion
//! [`store`] (`companies_config.toml`), NEVER the checked-in `config.toml`.

pub mod cf;
pub mod store;
pub mod systemd;

use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::{company_canonical_host, company_redirect_uri, COMPANY_HOST_SUFFIX};
use crate::error::AppError;
use crate::scope::OptCtx;
use crate::state::AppState;

use cf::{CfApi, RealCfApi};
use systemd::{ConnectorHost, ConnectorPlan, ConnectorState, RealConnectorHost};

/// The one tunnel name per box.
pub const TUNNEL_NAME: &str = "supermux";

/// The 0600 secret file basenames (added to `log_redact`).
pub const CF_TOKEN_FILE: &str = "cf_api_token";
pub const CONNECTOR_TOKEN_FILE: &str = "cloudflared_token";
pub const GOOGLE_SECRET_FILE: &str = "google_client_secret";
/// A tiny non-secret record of the provisioned tunnel id, so `status` can poll
/// health without re-discovering it every time.
pub const TUNNEL_ID_FILE: &str = "cloudflared_tunnel_id";

/// The swappable Cloudflare + connector-runtime seams, held on [`AppState`] so
/// tests can inject mocks the same way the OIDC verifier is swapped.
pub struct ExternalAccess {
    cf: Mutex<Arc<dyn CfApi>>,
    host: Mutex<Arc<dyn ConnectorHost>>,
}

impl Default for ExternalAccess {
    fn default() -> Self {
        Self::new()
    }
}

impl ExternalAccess {
    pub fn new() -> Self {
        Self {
            cf: Mutex::new(Arc::new(RealCfApi::new())),
            host: Mutex::new(Arc::new(RealConnectorHost)),
        }
    }

    pub fn cf(&self) -> Arc<dyn CfApi> {
        self.cf.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn host(&self) -> Arc<dyn ConnectorHost> {
        self.host.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[cfg(test)]
    pub fn set_cf(&self, v: Arc<dyn CfApi>) {
        *self.cf.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }

    #[cfg(test)]
    pub fn set_host(&self, v: Arc<dyn ConnectorHost>) {
        *self.host.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }
}

// ── envelope ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

/// Build the wizard sub-router. Merged on `http::protected_router` (owner-only;
/// NOT added to the deny-by-default member allowlist).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::{delete, get, post};
    Router::new()
        .route("/api/external-access/cf-token", post(cf_token_handler))
        .route(
            "/api/external-access/provision-tunnel",
            post(provision_tunnel_handler),
        )
        .route("/api/external-access/status", get(status_handler))
        .route("/api/external-access/google", post(google_handler))
        .route("/api/companies/{id}/host", post(host_handler))
        .route(
            "/api/companies/{id}/verify-login",
            post(verify_login_handler),
        )
        .route(
            "/api/companies/{id}/humans",
            get(list_humans_handler).post(add_human_handler),
        )
        .route(
            "/api/companies/{id}/humans/{hid}",
            delete(delete_human_handler),
        )
        .with_state(state)
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Map a [`cf::CfError`] to a human-readable 400 (a token/scope problem is the
/// caller's to fix, not a server fault).
fn cf_err(e: cf::CfError) -> AppError {
    AppError::BadRequest(e.to_string())
}

/// The wildcard ingress host for this box.
fn wildcard_host() -> String {
    format!("*.{COMPANY_HOST_SUFFIX}")
}

/// `http://localhost:<bind-port>` — where the wildcard ingress points.
fn local_service(state: &AppState) -> String {
    format!("http://localhost:{}", state.config.bind.port())
}

fn read_cf_token(state: &AppState) -> Option<String> {
    crate::config::read_secret_file(&state.config.data_dir.join(CF_TOKEN_FILE))
}

// ── 1. POST /api/external-access/cf-token ────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CfTokenInput {
    token: String,
}

#[derive(Debug, Serialize)]
struct CfTokenResult {
    valid: bool,
    account_id: String,
    zone_id: String,
}

async fn cf_token_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Json(input): Json<CfTokenInput>,
) -> Result<Json<Envelope<CfTokenResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/cf-token")?;
    let token = input.token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::BadRequest("token is required".into()));
    }
    let api = state.external_access.cf();
    // Verify active + discover account + zone (proves the scopes by construction).
    let tc = cf::discover(api.as_ref(), &token, COMPANY_HOST_SUFFIX)
        .await
        .map_err(cf_err)?;
    // Store 0600 — NEVER returned to the client after this point.
    crate::config::write_token_0600(&state.config.data_dir.join(CF_TOKEN_FILE), &token)
        .map_err(AppError::Internal)?;
    Ok(ok(CfTokenResult {
        valid: true,
        account_id: tc.account_id,
        zone_id: tc.zone_id,
    }))
}

// ── 2. POST /api/external-access/provision-tunnel ────────────────────────────

#[derive(Debug, Serialize)]
struct ProvisionResult {
    tunnel_id: String,
    /// Whether the connector user-unit actually started, or a degrade reason.
    connector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    connector_detail: Option<String>,
    reachable_host: String,
}

async fn provision_tunnel_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
) -> Result<Json<Envelope<ProvisionResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/provision-tunnel")?;
    let token = read_cf_token(&state)
        .ok_or_else(|| AppError::BadRequest("save a Cloudflare API token first".into()))?;
    let api = state.external_access.cf();

    let tc = cf::discover(api.as_ref(), &token, COMPANY_HOST_SUFFIX)
        .await
        .map_err(cf_err)?;

    // Idempotent: reuse an existing tunnel of this name, else create ONE.
    let tunnel = match api
        .find_tunnel(&token, &tc.account_id, TUNNEL_NAME)
        .await
        .map_err(cf_err)?
    {
        Some(t) => t,
        None => api
            .create_tunnel(&token, &tc.account_id, TUNNEL_NAME)
            .await
            .map_err(cf_err)?,
    };

    // Wildcard ingress `*.s.iwd.nl → http://localhost:<port>` + 404 catch-all.
    api.put_tunnel_config(
        &token,
        &tc.account_id,
        &tunnel.id,
        &wildcard_host(),
        &local_service(&state),
    )
    .await
    .map_err(cf_err)?;

    // Wildcard proxied CNAME `*.s.iwd.nl → {id}.cfargotunnel.com`.
    api.upsert_dns_cname(
        &token,
        &tc.zone_id,
        &wildcard_host(),
        &format!("{}.cfargotunnel.com", tunnel.id),
    )
    .await
    .map_err(cf_err)?;

    // Persist the (non-secret) tunnel id so `status` can poll health.
    crate::config::write_token_0600(
        &state.config.data_dir.join(TUNNEL_ID_FILE),
        &tunnel.id,
    )
    .map_err(AppError::Internal)?;

    // Write the connector unit + start it (behind the mockable seam).
    let host = state.external_access.host();
    let plan = ConnectorPlan {
        connector_token: tunnel.token.clone(),
        token_path: state.config.data_dir.join(CONNECTOR_TOKEN_FILE),
        unit_path: connector_unit_path(),
        cloudflared_bin: cloudflared_bin_path(),
    };
    let (connector, connector_detail) = match host.provision(&plan) {
        ConnectorState::Started => ("started".to_string(), None),
        ConnectorState::Unavailable(reason) => ("unavailable".to_string(), Some(reason)),
    };

    Ok(ok(ProvisionResult {
        tunnel_id: tunnel.id,
        connector,
        connector_detail,
        reachable_host: wildcard_host(),
    }))
}

fn connector_unit_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".config/systemd/user/cloudflared.service")
}

fn cloudflared_bin_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("bin/cloudflared")
}

// ── 3. GET /api/external-access/status ───────────────────────────────────────

#[derive(Debug, Deserialize)]
struct StatusQuery {
    company_id: Option<i64>,
}

#[derive(Debug, Serialize)]
struct BoxStatus {
    /// `none` | `valid`.
    cf_token: String,
    /// `none` | `connecting` | `healthy`.
    tunnel: String,
    dns_ok: bool,
    /// `unset` | `configured`.
    google: String,
}

#[derive(Debug, Serialize)]
struct CompanyStatus {
    company_id: i64,
    company_host_written: bool,
    /// `unknown` | `ok` | `mismatch`.
    redirect_registered: String,
    reachable: bool,
    host: String,
    redirect_uri: String,
}

#[derive(Debug, Serialize)]
struct StatusResult {
    box_status: BoxStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    company: Option<CompanyStatus>,
}

async fn status_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Envelope<StatusResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/status")?;

    let cfg = state.human_auth_cfg();
    let has_cf = read_cf_token(&state).is_some();
    let tunnel_id =
        crate::config::read_secret_file(&state.config.data_dir.join(TUNNEL_ID_FILE));

    // Tunnel health: poll CF only when we have both a token and a tunnel id.
    let tunnel_state = match (read_cf_token(&state), &tunnel_id) {
        (Some(token), Some(tid)) => {
            let api = state.external_access.cf();
            match cf::discover(api.as_ref(), &token, COMPANY_HOST_SUFFIX).await {
                Ok(tc) => match api.tunnel_status(&token, &tc.account_id, tid).await {
                    Ok(s) if s == "healthy" => "healthy",
                    Ok(_) => "connecting",
                    Err(_) => "connecting",
                },
                Err(_) => "connecting",
            }
        }
        _ => "none",
    };

    let box_status = BoxStatus {
        cf_token: if has_cf { "valid" } else { "none" }.to_string(),
        tunnel: tunnel_state.to_string(),
        dns_ok: tunnel_id.is_some(),
        google: if cfg.google_client_id.is_some() {
            "configured"
        } else {
            "unset"
        }
        .to_string(),
    };

    let company = match q.company_id {
        Some(id) => {
            let co = crate::db::companies::get(&state.pool, id)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
            let host = company_canonical_host(&co.slug);
            let redirect_uri = company_redirect_uri(&co.slug);
            let entry = cfg.host_entry(&host);
            let written = entry.is_some();
            let redirect_registered = match entry {
                Some(e) if e.is_canonical_for(&co.slug, id) => "ok",
                Some(_) => "mismatch",
                None => "unknown",
            };
            Some(CompanyStatus {
                company_id: id,
                company_host_written: written,
                redirect_registered: redirect_registered.to_string(),
                reachable: written && tunnel_state == "healthy",
                host,
                redirect_uri,
            })
        }
        None => None,
    };

    Ok(ok(StatusResult { box_status, company }))
}

// ── 4. POST /api/external-access/google ──────────────────────────────────────

/// A Google Web-application client id ends in `.apps.googleusercontent.com`.
static GOOGLE_CLIENT_ID_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$").unwrap());

#[derive(Debug, Deserialize)]
struct GoogleInput {
    client_id: String,
    client_secret: String,
}

#[derive(Debug, Serialize)]
struct GoogleResult {
    configured: bool,
}

async fn google_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Json(input): Json<GoogleInput>,
) -> Result<Json<Envelope<GoogleResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/google")?;
    let client_id = input.client_id.trim().to_string();
    let client_secret = input.client_secret.trim().to_string();
    if !GOOGLE_CLIENT_ID_RE.is_match(&client_id) {
        return Err(AppError::BadRequest(
            "client_id must be a Google Web client id (…apps.googleusercontent.com)".into(),
        ));
    }
    if client_secret.is_empty() {
        return Err(AppError::BadRequest("client_secret is required".into()));
    }

    // Secret 0600 at the existing loader path — never echoed, never logged.
    crate::config::write_token_0600(
        &state.config.data_dir.join(GOOGLE_SECRET_FILE),
        &client_secret,
    )
    .map_err(AppError::Internal)?;

    // Non-secret client id → the companion store (atomic), then hot-reload.
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    cfg.google_client_id = Some(client_id);
    store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;
    state.reload_human_auth().map_err(AppError::Internal)?;

    Ok(ok(GoogleResult { configured: true }))
}

// ── 5. POST /api/companies/{id}/host ─────────────────────────────────────────

#[derive(Debug, Serialize)]
struct HostResult {
    host: String,
    redirect_uri: String,
}

async fn host_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<HostResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/host"))?;
    let co = crate::db::companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    let host = company_canonical_host(&co.slug);
    let redirect_uri = company_redirect_uri(&co.slug);

    // Upsert this company's company_hosts entry into the companion store.
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    cfg.company_hosts.retain(|h| h.company_id != id);
    cfg.company_hosts.push(crate::config::CompanyHost {
        host: host.clone(),
        company_id: id,
        redirect_uri: redirect_uri.clone(),
    });
    store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;
    state.reload_human_auth().map_err(AppError::Internal)?;

    Ok(ok(HostResult { host, redirect_uri }))
}

// ── 6. POST /api/companies/{id}/verify-login ─────────────────────────────────

#[derive(Debug, Serialize)]
struct VerifyLoginResult {
    ok: bool,
    detail: String,
    redirect_uri: String,
}

async fn verify_login_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<VerifyLoginResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/verify-login"))?;
    let co = crate::db::companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    let redirect_uri = company_redirect_uri(&co.slug);
    let host = company_canonical_host(&co.slug);

    let cfg = state.human_auth_cfg();
    if cfg.google_client_id.is_none() {
        return Ok(ok(VerifyLoginResult {
            ok: false,
            detail: "Google login is not configured yet — add the client id and secret first."
                .to_string(),
            redirect_uri,
        }));
    }
    // The host must be an allowlisted, canonical company_hosts entry for the exact
    // redirect URI to be the one Google will see. When it is missing/non-canonical
    // the actionable failure is a redirect_uri_mismatch: hand back the exact URI to
    // register in the Google console.
    match cfg.host_entry(&host) {
        Some(e) if e.is_canonical_for(&co.slug, id) => Ok(ok(VerifyLoginResult {
            ok: true,
            detail: format!("Ready — colleagues can sign in at https://{host}."),
            redirect_uri,
        })),
        _ => Ok(ok(VerifyLoginResult {
            ok: false,
            detail: format!(
                "redirect_uri_mismatch: Google doesn't recognise {redirect_uri} yet — \
                 add it under Authorized redirect URIs and press Check again."
            ),
            redirect_uri,
        })),
    }
}

// ── 7. companies humans (invite / list / revoke) ─────────────────────────────

const VALID_ROLES: [&str; 3] = ["owner", "admin", "member"];

/// A light email sanity check (presence of a single `@` with non-empty local +
/// domain and a dot in the domain). Deliberately permissive — the real gate is
/// the verified Google email at login; this only rejects obvious typos.
static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").unwrap());

#[derive(Debug, Deserialize)]
struct AddHumanInput {
    email: String,
    role: String,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct AddHumanResult {
    user: crate::db::human_users::HumanUser,
    login_url: String,
}

async fn add_human_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<i64>,
    Json(input): Json<AddHumanInput>,
) -> Result<Json<Envelope<AddHumanResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/humans"))?;
    let co = crate::db::companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    let email = input.email.trim().to_ascii_lowercase();
    let role = input.role.trim().to_ascii_lowercase();
    if !EMAIL_RE.is_match(&email) {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    if !VALID_ROLES.contains(&role.as_str()) {
        return Err(AppError::BadRequest(
            "role must be one of owner, admin, member".into(),
        ));
    }
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| email.split('@').next().unwrap_or("colleague").to_string());

    // Reject a duplicate email up front with a clean 409 (instead of leaking the
    // UNIQUE constraint).
    if crate::db::human_users::get_by_email(&state.pool, &email)
        .await?
        .is_some()
    {
        return Err(AppError::Conflict(format!("{email} is already invited")));
    }

    let new_id =
        crate::db::human_users::insert(&state.pool, &email, &display_name, Some(id), &role)
            .await?;
    let user = crate::db::human_users::get(&state.pool, new_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("inserted human vanished")))?;

    Ok(ok(AddHumanResult {
        user,
        login_url: format!("https://{}", company_canonical_host(&co.slug)),
    }))
}

async fn list_humans_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<Vec<crate::db::human_users::HumanInvitee>>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/humans"))?;
    // 404 an unknown company (hide-existence parity with the rest of the surface).
    crate::db::companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    let now = chrono::Utc::now().timestamp();
    let rows = crate::db::human_users::list_by_company(&state.pool, id, now).await?;
    Ok(ok(rows))
}

#[derive(Debug, Serialize)]
struct DeleteHumanResult {
    deleted: bool,
    sessions_revoked: u64,
}

async fn delete_human_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path((id, hid)): Path<(i64, i64)>,
) -> Result<Json<Envelope<DeleteHumanResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/humans/{hid}"))?;
    // Revoke any live sessions FIRST so a just-removed colleague cannot ride an
    // existing cookie, then delete the allowlist row (fenced to this company).
    let now = chrono::Utc::now().timestamp();
    let sessions_revoked =
        crate::db::human_sessions::revoke_all_for_user(&state.pool, hid, now).await?;
    let deleted = crate::db::human_users::delete_in_company(&state.pool, hid, id).await?;
    if !deleted {
        return Err(AppError::NotFound(format!("human id={hid}")));
    }
    Ok(ok(DeleteHumanResult {
        deleted,
        sessions_revoked,
    }))
}

#[cfg(test)]
mod tests;
