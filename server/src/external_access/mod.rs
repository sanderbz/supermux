//! The companies onboarding-wizard backend: external access (Cloudflare wildcard
//! tunnel + Google login) and colleague invites, all OWNER/ADMIN-ONLY.
//!
//! # The endpoints (every one `require_admin`; a member gets a uniform 404)
//!
//! | Method + path | Purpose |
//! |---|---|
//! | `POST /api/external-access/cf-token`       | Validate + store the Cloudflare API token (0600, never returned). |
//! | `POST /api/external-access/provision-tunnel` | One-time idempotent tunnel + supervised connector child (+ a record per configured company host). |
//! | `POST /api/external-access/tighten-dns`    | Replace a legacy `*.<base>` wildcard with per-company records. |
//! | `GET  /api/external-access/status`         | Live-verify source the wizard polls. |
//! | `GET  /api/external-access/zones`          | List the saved CF token's zones (the base-domain choices). |
//! | `POST /api/external-access/base-domain`    | Set the operator's base domain (must be a controlled zone), hot-reload. |
//! | `POST /api/external-access/google`         | Save the Google client id + secret (0600), hot-reload. |
//! | `POST /api/external-access/agent-inbox`    | Mint `agent@<domain>` via CF Email Routing → a connected mailbox. |
//! | `DELETE /api/external-access/agent-inbox`  | Remove a company's agent-inbox (rule + record). |
//! | `POST /api/companies/{id}/host`            | Write this company's `company_hosts` entry — optional `{subdomain}`, else keep the current label, else the slug — hot-reload. |
//! | `POST /api/companies/{id}/verify-login`    | Surface the exact redirect URI to register (redirect_uri_mismatch). |
//! | `POST /api/companies/{id}/humans`          | Seed a colleague `human_users` row; returns the login url. |
//! | `GET  /api/companies/{id}/humans`          | List invitees + Invited/Pending/Active status. |
//! | `DELETE /api/companies/{id}/humans/{hid}`  | Revoke an invite (delete row + revoke sessions). |
//!
//! # Architecture (design §0)
//!
//! ONE tunnel per box, and the SMALLEST DNS footprint that can work: one proxied
//! CNAME `<label>.<base_domain> → <tunnel>.cfargotunnel.com` per company host,
//! one matching ingress rule, and the `http_status:404` catch-all. Adding a
//! company writes exactly one record; renaming its address moves that one record;
//! deleting the company removes it.
//!
//! It used to be a WILDCARD (`*.<base_domain>` ingress + a `*.<base_domain>`
//! CNAME) — which was cheap for us and expensive for the operator: every
//! undefined name under their real domain resolved to this box. Boxes provisioned
//! by those builds still have that record; `status.wildcard_dns` surfaces it and
//! `tighten-dns` replaces it with per-company records ON REQUEST. supermux never
//! deletes it implicitly, and never touches a DNS record that does not point at
//! its own tunnel. Cloudflare sits behind
//! [`cf::CfApi`] and the connector process behind [`connector::ConnectorHost`] so the
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
pub mod connector;
pub mod quick;
pub mod store;

use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::{company_canonical_host, company_redirect_uri, is_dns_label};
use crate::error::AppError;
use crate::scope::OptCtx;
use crate::state::AppState;

use cf::{CfApi, RealCfApi};
use connector::{ConnectorHost, ConnectorPlan, ConnectorState, RealConnectorHost};
use quick::{QuickTunnelHandle, QuickTunnelHost, RealQuickTunnelHost};

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
    /// The mockable quick-tunnel child seam.
    quick: Mutex<Arc<dyn QuickTunnelHost>>,
    /// The LIVE quick-tunnel child handle (in-memory only — the child is not
    /// serializable). `None` ⇒ no quick tunnel running in this process.
    quick_handle: tokio::sync::Mutex<Option<QuickTunnelHandle>>,
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
            host: Mutex::new(Arc::new(RealConnectorHost::new())),
            quick: Mutex::new(Arc::new(RealQuickTunnelHost)),
            quick_handle: tokio::sync::Mutex::new(None),
        }
    }

    pub fn cf(&self) -> Arc<dyn CfApi> {
        self.cf.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn host(&self) -> Arc<dyn ConnectorHost> {
        self.host.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn quick(&self) -> Arc<dyn QuickTunnelHost> {
        self.quick.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Lock the live quick-tunnel child handle (provision/teardown/status).
    pub async fn quick_handle(&self) -> tokio::sync::MutexGuard<'_, Option<QuickTunnelHandle>> {
        self.quick_handle.lock().await
    }

    /// Is a quick-tunnel child running AND still alive? Best-effort, for `status`.
    pub async fn quick_handle_alive(&self) -> bool {
        match self.quick_handle.lock().await.as_mut() {
            Some(h) => h.is_alive(),
            None => false,
        }
    }

    #[cfg(test)]
    pub fn set_cf(&self, v: Arc<dyn CfApi>) {
        *self.cf.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }

    #[cfg(test)]
    pub fn set_host(&self, v: Arc<dyn ConnectorHost>) {
        *self.host.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }

    #[cfg(test)]
    pub fn set_quick(&self, v: Arc<dyn QuickTunnelHost>) {
        *self.quick.lock().unwrap_or_else(|e| e.into_inner()) = v;
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
        .route(
            "/api/external-access/tighten-dns",
            post(tighten_dns_handler),
        )
        .route("/api/external-access/zones", get(zones_handler))
        .route(
            "/api/external-access/base-domain",
            post(base_domain_handler),
        )
        .route("/api/external-access/google", post(google_handler))
        .route(
            "/api/external-access/agent-inbox",
            post(agent_inbox_handler).delete(agent_inbox_delete_handler),
        )
        .route(
            "/api/external-access/quick-tunnel",
            post(quick_tunnel_handler).delete(quick_tunnel_teardown_handler),
        )
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

/// The configured base domain, or a clean 400 telling the operator to choose one.
///
/// This is the ONLY gate that turns "unset" into an error — every host-deriving
/// handler goes through it, so an unconfigured box can NEVER emit an external
/// host, write a `company_hosts` entry, or provision an uncontrolled domain. This
/// is the fail-closed invariant: with no base domain there is nothing for the WS
/// Origin gate to match, so cross-site origins are rejected.
fn require_base_domain(state: &AppState) -> Result<String, AppError> {
    state
        .human_auth_cfg()
        .base_domain
        .clone()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest(
                "choose your domain first (the wizard's Domain step)".into(),
            )
        })
}

/// A company's LIVE public host + redirect URI.
///
/// The persisted `company_hosts` entry is AUTHORITATIVE: the wizard SUGGESTS
/// `<slug>.<base>` but the owner may pick any label, so re-deriving from the slug
/// at each call site (as every one of these used to) would silently disagree with
/// the address colleagues actually sign in on. The slug-derived default is only
/// the fallback — before any entry is written, or when the stored one no longer
/// sits under the current base domain (a base change must re-derive, fail-closed).
fn resolve_company_host(
    cfg: &crate::config::HumanAuthConfig,
    company_id: i64,
    slug: &str,
    base_domain: &str,
) -> (String, String) {
    match cfg
        .company_entry(company_id)
        .filter(|e| e.is_valid_for(company_id, base_domain))
    {
        Some(e) => (
            e.host.trim().to_ascii_lowercase(),
            e.redirect_uri.trim().to_string(),
        ),
        None => (
            company_canonical_host(slug, base_domain),
            company_redirect_uri(slug, base_domain),
        ),
    }
}

/// The LEGACY wildcard host under a base domain: `*.<base_domain>`.
///
/// supermux no longer creates this. It exists only so a box provisioned by an
/// older build can be RECOGNISED (status) and TIGHTENED (the explicit
/// `tighten-dns` action) — a wildcard record makes every undefined name under
/// the operator's own domain resolve to this box, which is far more of their zone
/// than a couple of company hostnames needs. It is never deleted implicitly.
fn wildcard_host(base_domain: &str) -> String {
    format!("*.{base_domain}")
}

/// The CNAME content every supermux-owned record points at. A record whose
/// content is anything else belongs to the OPERATOR — never overwritten, never
/// deleted (the "only if it is ours" guard).
fn tunnel_cname_target(tunnel_id: &str) -> String {
    format!("{tunnel_id}.cfargotunnel.com")
}

/// The tunnel id this box provisioned, if provisioning has run.
fn read_tunnel_id(state: &AppState) -> Option<String> {
    crate::config::read_secret_file(&state.config.data_dir.join(TUNNEL_ID_FILE))
}

/// Every PERMANENT company hostname this box serves under `base_domain` — the
/// ingress document, and exactly the set of DNS records that should exist.
/// Sorted + de-duplicated so the ingress write is stable (no spurious PUTs) and
/// ephemeral quick-tunnel hosts (which live on `trycloudflare.com` and need no
/// DNS of ours) are skipped.
fn company_hostnames(cfg: &crate::config::HumanAuthConfig, base_domain: &str) -> Vec<String> {
    let mut hosts: Vec<String> = cfg
        .company_hosts
        .iter()
        .filter(|h| !h.ephemeral && h.label_under(base_domain).is_some())
        .map(|h| h.host.trim().to_ascii_lowercase())
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

/// Everything a Cloudflare DNS write needs, resolved once.
///
/// `None` from [`cf_dns_ctx`] means this box has no CF token — it cannot touch
/// DNS at all, which is a legitimate state (a hand-configured box, or a company
/// on a quick tunnel), not an error. `tunnel` is `None` before provisioning has
/// run: the name can still be CHECKED for a foreign record, but the record itself
/// is created by provisioning, which is when a tunnel target first exists.
struct CfDns {
    token: String,
    account_id: String,
    zone_id: String,
    /// `(tunnel_id, cname_target)` once provisioning has run.
    tunnel: Option<(String, String)>,
}

async fn cf_dns_ctx(state: &AppState, base_domain: &str) -> Result<Option<CfDns>, AppError> {
    let Some(token) = read_cf_token(state) else {
        return Ok(None);
    };
    let api = state.external_access.cf();
    let account_id = cf::discover_account(api.as_ref(), &token)
        .await
        .map_err(cf_err)?;
    let zone_id = api.zone_id(&token, base_domain).await.map_err(cf_err)?;
    let tunnel = read_tunnel_id(state).map(|id| {
        let target = tunnel_cname_target(&id);
        (id, target)
    });
    Ok(Some(CfDns {
        token,
        account_id,
        zone_id,
        tunnel,
    }))
}

/// What a company host's DNS record did (surfaced to the wizard so it can say
/// exactly what happened in the operator's zone).
const DNS_CREATED: &str = "created";
const DNS_EXISTS: &str = "exists";
const DNS_PENDING: &str = "pending";
const DNS_UNAVAILABLE: &str = "unavailable";

/// Ensure ONE proxied CNAME `<host> → <tunnel>.cfargotunnel.com`.
///
/// The probe before the write is the whole point: a name that already resolves to
/// something else is the OPERATOR'S record, and a product that silently
/// re-pointed it would be taking over a domain it was only lent. That case is an
/// honest refusal with the current target named, never an upsert.
async fn ensure_host_record(
    state: &AppState,
    dns: &CfDns,
    host: &str,
) -> Result<&'static str, AppError> {
    let api = state.external_access.cf();
    let existing = api
        .find_dns_cname(&dns.token, &dns.zone_id, host)
        .await
        .map_err(cf_err)?;
    let target = dns.tunnel.as_ref().map(|(_, t)| t.clone());
    match (existing, target) {
        // Already ours — nothing to do (idempotent re-run).
        (Some(r), Some(t)) if r.content.trim().eq_ignore_ascii_case(&t) => Ok(DNS_EXISTS),
        // Someone else's record on that exact name. Refuse; never overwrite.
        (Some(r), _) => Err(AppError::Conflict(format!(
            "{host} already has a DNS record in your Cloudflare zone (it points at {}). \
             supermux will not change a record you made yourself — remove it there, or \
             pick a different subdomain.",
            r.content.trim()
        ))),
        // Free name, and we know where to point it.
        (None, Some(t)) => {
            api.create_dns_cname(&dns.token, &dns.zone_id, host, &t)
                .await
                .map_err(cf_err)?;
            Ok(DNS_CREATED)
        }
        // Free name, but no tunnel yet — provisioning creates the record.
        (None, None) => Ok(DNS_PENDING),
    }
}

/// Remove `host`'s record ONLY when it points at our tunnel. A record the
/// operator made (or one belonging to another tunnel) is left exactly as it is —
/// teardown removes what supermux created, and nothing else. Returns whether a
/// record was actually deleted.
async fn remove_our_record(state: &AppState, dns: &CfDns, host: &str) -> Result<bool, AppError> {
    let Some((_, target)) = dns.tunnel.as_ref() else {
        return Ok(false);
    };
    let api = state.external_access.cf();
    let Some(rec) = api
        .find_dns_cname(&dns.token, &dns.zone_id, host)
        .await
        .map_err(cf_err)?
    else {
        return Ok(false);
    };
    if !rec.content.trim().eq_ignore_ascii_case(target) {
        return Ok(false); // not ours — hands off
    }
    api.delete_dns_record(&dns.token, &dns.zone_id, &rec.id)
        .await
        .map_err(cf_err)?;
    Ok(true)
}

/// Does a legacy `*.<base>` CNAME pointing at OUR tunnel still exist? Drives both
/// the status flag and the ingress document (the wildcard rule stays while its
/// record does, so tightening is never implicit).
async fn wildcard_is_ours(state: &AppState, dns: &CfDns, base_domain: &str) -> bool {
    let Some((_, target)) = dns.tunnel.as_ref() else {
        return false;
    };
    let api = state.external_access.cf();
    match api
        .find_dns_cname(&dns.token, &dns.zone_id, &wildcard_host(base_domain))
        .await
    {
        Ok(Some(r)) => r.content.trim().eq_ignore_ascii_case(target),
        _ => false,
    }
}

/// Rewrite the tunnel ingress to EXACTLY the company hostnames this box serves
/// (plus the legacy wildcard while its record still exists), each pointing at the
/// local service, closed by the `http_status:404` catch-all. Cloudflare's remote
/// config is a whole-document PUT, so adding and removing a hostname are the same
/// call with a different list. Returns the hostnames written.
async fn sync_ingress(
    state: &AppState,
    dns: &CfDns,
    base_domain: &str,
) -> Result<Vec<String>, AppError> {
    let Some((tunnel_id, _)) = dns.tunnel.as_ref() else {
        return Ok(Vec::new());
    };
    let mut hosts = company_hostnames(&state.human_auth_cfg(), base_domain);
    if wildcard_is_ours(state, dns, base_domain).await {
        hosts.insert(0, wildcard_host(base_domain));
    }
    state
        .external_access
        .cf()
        .put_tunnel_config(
            &dns.token,
            &dns.account_id,
            tunnel_id,
            &hosts,
            &local_service(state),
        )
        .await
        .map_err(cf_err)?;
    Ok(hosts)
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
    // Verify active + reach an account. The zone is UNKNOWN at this point — the
    // operator picks their base domain from `list_zones` in the next wizard step —
    // so this proves Tunnel:Edit reach only; Zone:Read is proven by `list_zones`.
    let account_id = cf::discover_account(api.as_ref(), &token)
        .await
        .map_err(cf_err)?;
    // Store 0600 — NEVER returned to the client after this point.
    crate::config::write_token_0600(&state.config.data_dir.join(CF_TOKEN_FILE), &token)
        .map_err(AppError::Internal)?;
    Ok(ok(CfTokenResult {
        valid: true,
        account_id,
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
    /// The hostnames now reachable, comma-joined (was: the `*.<base>` wildcard).
    reachable_host: String,
    /// Exactly the DNS records this box owns in the operator's zone after this
    /// call — one per company host, and nothing else.
    dns_records: Vec<String>,
}

async fn provision_tunnel_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
) -> Result<Json<Envelope<ProvisionResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/provision-tunnel")?;
    // FAIL-CLOSED: no base domain ⇒ no tunnel, no DNS, no allowlist entry.
    let base = require_base_domain(&state)?;
    let token = read_cf_token(&state)
        .ok_or_else(|| AppError::BadRequest("save a Cloudflare API token first".into()))?;
    let api = state.external_access.cf();

    // Account (Tunnel:Edit) is zone-free; the DNS zone id is resolved separately
    // for the CHOSEN base domain (proves Zone:Read for exactly that zone).
    let account_id = cf::discover_account(api.as_ref(), &token)
        .await
        .map_err(cf_err)?;
    // Resolve the zone up front: it proves Zone:Read for exactly the chosen base
    // (a missing DNS scope should fail HERE, with a message naming the permission,
    // not later inside the per-host record write).
    let _zone_id = api.zone_id(&token, &base).await.map_err(cf_err)?;

    // Idempotent: reuse an existing tunnel of this name, else create ONE.
    let tunnel = match api
        .find_tunnel(&token, &account_id, TUNNEL_NAME)
        .await
        .map_err(cf_err)?
    {
        Some(t) => t,
        None => api
            .create_tunnel(&token, &account_id, TUNNEL_NAME)
            .await
            .map_err(cf_err)?,
    };

    // Persist the (non-secret) tunnel id BEFORE the DNS sync — it is what makes a
    // record "ours", so nothing may be written while it is unknown.
    crate::config::write_token_0600(
        &state.config.data_dir.join(TUNNEL_ID_FILE),
        &tunnel.id,
    )
    .map_err(AppError::Internal)?;

    // NO WILDCARD. Provisioning creates the tunnel and the connector; the only DNS
    // it writes is one proxied CNAME per company host ALREADY configured on this
    // box (the wizard's address step runs first, so that is normally exactly one)
    // — and a name the operator already uses is refused, never re-pointed. A box
    // with no companies configured yet gets zero records and an ingress of just
    // the 404 catch-all.
    let dns_ctx = cf_dns_ctx(&state, &base).await?;
    let mut dns_records: Vec<String> = Vec::new();
    if let Some(dns) = &dns_ctx {
        for host in company_hostnames(&state.human_auth_cfg(), &base) {
            ensure_host_record(&state, dns, &host).await?;
            dns_records.push(host);
        }
        sync_ingress(&state, dns, &base).await?;
    }

    // Start (or adopt) the connector CHILD — the supervised process that makes
    // the tunnel actually connect. Behind the mockable seam.
    let (connector, connector_detail) =
        provision_connector(&state, &tunnel.token).await;

    Ok(ok(ProvisionResult {
        tunnel_id: tunnel.id,
        connector,
        connector_detail,
        // Honest: the hosts this box is actually reachable at, not a wildcard that
        // would have claimed every name under the operator's domain.
        reachable_host: dns_records.join(", "),
        dns_records,
    }))
}

/// Write the 0600 token env-file and make sure the connector process is running,
/// returning the `(connector, connector_detail)` pair the wizard renders.
/// Shared by `provision-tunnel` and the boot resume so they can never drift.
async fn provision_connector(state: &AppState, token: &str) -> (String, Option<String>) {
    let plan = ConnectorPlan {
        connector_token: token.to_string(),
        token_path: state.config.data_dir.join(CONNECTOR_TOKEN_FILE),
        cloudflared_bin: cloudflared_bin_path(),
    };
    match state.external_access.host().provision(&plan).await {
        ConnectorState::Started { via, pid } => (
            "started".to_string(),
            Some(match pid {
                Some(pid) => format!("the connector is running ({via}, pid {pid})"),
                None => format!("the connector is running ({via})"),
            }),
        ),
        ConnectorState::Unavailable(reason) => ("unavailable".to_string(), Some(reason)),
    }
}

/// Read the 0600 connector-token env-file (`TUNNEL_TOKEN=…`) written at provision.
fn read_connector_token(state: &AppState) -> Option<String> {
    crate::config::read_secret_file(&state.config.data_dir.join(CONNECTOR_TOKEN_FILE))
        .as_deref()
        .and_then(connector::parse_token_env)
}

/// **Boot resume.** A provisioned box must come back with its connector running:
/// the tunnel + DNS survive a reboot, but the connector process does not, and
/// nothing else ever started it — which is why a reboot used to take external
/// access down until someone ran `cloudflared` by hand.
///
/// Runs only when this box IS provisioned (a tunnel id AND a readable token);
/// otherwise a no-op. Never fatal: a failure is logged and surfaced by `status`.
pub async fn resume_connector_on_boot(state: &AppState) {
    let Some(tunnel_id) = read_tunnel_id(state) else {
        return;
    };
    let Some(token) = read_connector_token(state) else {
        tracing::warn!(
            "external-access: tunnel {tunnel_id} is provisioned but its connector token \
             is missing or unreadable — re-run Set up access"
        );
        return;
    };
    match provision_connector(state, &token).await {
        (c, detail) if c == "started" => {
            tracing::info!("external-access: connector resumed on boot ({detail:?})")
        }
        (_, detail) => tracing::warn!(
            "external-access: connector did not start on boot: {}",
            detail.unwrap_or_default()
        ),
    }
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
    /// The configured base domain, or `None` when the Domain step hasn't run.
    /// The wizard keys its "Choose your domain" sub-step off this.
    #[serde(skip_serializing_if = "Option::is_none")]
    base_domain: Option<String>,
    /// The active zero-config quick tunnel, if any (ephemeral/temporary). Omitted
    /// when no quick trial is configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    quick_tunnel: Option<QuickTunnelStatus>,
    /// TRUE when a legacy `*.<base_domain>` CNAME pointing at this box's tunnel
    /// still exists — i.e. every undefined name under the operator's domain still
    /// resolves here, because this box was provisioned by a build that wrote a
    /// wildcard. Surfaced (never acted on implicitly) so the wizard can offer the
    /// one-click `tighten-dns`.
    wildcard_dns: bool,
    /// The DNS records supermux owns in the operator's zone right now — one per
    /// company host. What the wizard shows so the footprint is never a surprise.
    dns_records: Vec<String>,
    /// The connector PROCESS on this box — running (how, which pid) or not, and
    /// WHY not. Cloudflare can only report a tunnel healthy while this is up, so
    /// a wizard that shows "Connecting…" without checking it is guessing.
    connector: ConnectorStatusOut,
}

/// The wire shape of [`connector::ConnectorStatus`].
#[derive(Debug, Serialize)]
struct ConnectorStatusOut {
    running: bool,
    /// `child` | `adopted` | `none`.
    via: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    /// How it is running, or why it is not — never omitted while it is down.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl From<connector::ConnectorStatus> for ConnectorStatusOut {
    fn from(s: connector::ConnectorStatus) -> Self {
        Self {
            running: s.running,
            via: s.via,
            pid: s.pid,
            detail: s.detail,
        }
    }
}

#[derive(Debug, Serialize)]
struct QuickTunnelStatus {
    /// The child is running AND still alive (honest — a crashed child ⇒ false).
    active: bool,
    url: String,
    host: String,
    company_id: i64,
    /// Always true — the honesty flag the wizard renders.
    ephemeral: bool,
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
    /// The company's Cloudflare agent-inbox, if one has been provisioned. Absent
    /// when the owner hasn't given this company's bots their own email yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_inbox: Option<AgentInboxStatus>,
}

#[derive(Debug, Serialize)]
struct AgentInboxStatus {
    /// The bot's address, e.g. `agent@example.com`.
    address: String,
    /// The destination mailbox mail forwards to.
    destination: String,
    /// Whether Cloudflare has seen the owner verify the destination.
    verified: bool,
    /// `true` while the destination still needs its one-click verification.
    verification_pending: bool,
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
            // `tunnel_status` needs only the account (zone-free).
            match cf::discover_account(api.as_ref(), &token).await {
                Ok(account_id) => match api.tunnel_status(&token, &account_id, tid).await {
                    Ok(s) if s == "healthy" => "healthy",
                    Ok(_) => "connecting",
                    Err(_) => "connecting",
                },
                Err(_) => "connecting",
            }
        }
        _ => "none",
    };

    let base_domain = cfg
        .base_domain
        .clone()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());

    // Quick-tunnel status: ephemeral/temporary, `active` from the live child.
    let quick_tunnel = match store::read_or_default(&state.config.data_dir)
        .ok()
        .and_then(|s| s.quick_tunnel)
    {
        Some(q) => {
            let active = state.external_access.quick_handle_alive().await;
            Some(QuickTunnelStatus {
                active,
                url: format!("https://{}", q.host),
                host: q.host,
                company_id: q.company_id,
                ephemeral: true,
            })
        }
        None => None,
    };

    // The zone's actual footprint: which records are ours, and whether a legacy
    // wildcard is still claiming every name under the operator's domain.
    //
    // The zone lookup runs ONLY on a healthy tunnel — which is exactly when this
    // query stops polling (the wizard re-polls every 1.5s while `connecting`, and
    // three more Cloudflare calls on every one of those ticks would push a busy
    // box toward the API rate limit for an answer nothing can act on yet).
    let (wildcard_dns, dns_records) = match (&base_domain, &tunnel_id) {
        (Some(base), Some(_)) if tunnel_state == "healthy" => match cf_dns_ctx(&state, base).await {
            Ok(Some(dns)) => (
                wildcard_is_ours(&state, &dns, base).await,
                company_hostnames(&cfg, base),
            ),
            // A Cloudflare hiccup must not fail the whole status read — the wizard
            // polls this. Report "no wildcard seen" rather than inventing one.
            _ => (false, company_hostnames(&cfg, base)),
        },
        // Not provisioned (or still connecting): nothing has been looked up, so
        // claim nothing about the zone beyond the hosts this box is configured for.
        (Some(base), _) => (false, company_hostnames(&cfg, base)),
        _ => (false, Vec::new()),
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
        base_domain: base_domain.clone(),
        quick_tunnel,
        wildcard_dns,
        dns_records,
        connector: state.external_access.host().status().await.into(),
    };

    let company = match q.company_id {
        Some(id) => {
            let co = crate::db::companies::get(&state.pool, id)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
            // Without a chosen base domain external access is not configured — a
            // benign "not configured" block (never a fake host). Fail-closed.
            // The agent-inbox (if provisioned) is surfaced from the companion
            // store — a cheap, side-effect-free read, so status polling never
            // hits Cloudflare for it. `verified` is refreshed by re-running the
            // provision endpoint (the wizard's "Check again").
            let agent_inbox = store::read_or_default(&state.config.data_dir)
                .ok()
                .and_then(|s| store::agent_inbox_for(&s, id).cloned())
                .map(|a| AgentInboxStatus {
                    address: a.address,
                    destination: a.destination,
                    verified: a.verified,
                    verification_pending: !a.verified,
                });
            match &base_domain {
                Some(base) => {
                    // Entry-authoritative: report the address this company ACTUALLY
                    // publishes (the owner may have renamed the subdomain), and
                    // only fall back to the slug-derived suggestion when nothing is
                    // written yet.
                    let (host, redirect_uri) = resolve_company_host(&cfg, id, &co.slug, base);
                    let entry = cfg.company_entry(id);
                    let written = entry.is_some();
                    let redirect_registered = match entry {
                        Some(e) if e.is_valid_for(id, base) => "ok",
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
                        agent_inbox,
                    })
                }
                None => Some(CompanyStatus {
                    company_id: id,
                    company_host_written: false,
                    redirect_registered: "unknown".to_string(),
                    reachable: false,
                    host: String::new(),
                    redirect_uri: String::new(),
                    agent_inbox,
                }),
            }
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

// ── 4d. POST/DELETE /api/external-access/agent-inbox ─────────────────────────

/// A Cloudflare Email-Routing local part (the bit before `@`): ASCII lowercase
/// letters/digits with interior `.`/`_`/`-`. Validated in code (no regex) so it
/// can never carry a space, an `@`, or a path segment into the address we build.
fn valid_local_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        && !s.starts_with(['.', '-'])
        && !s.ends_with(['.', '-'])
}

/// Map a Cloudflare error from the Email-Routing calls to a human 400 — a
/// `MissingScope` is the actionable "re-mint the token with the Email Routing
/// scope" case the wizard shows.
fn agent_inbox_cf_err(e: cf::CfError) -> AppError {
    match e {
        cf::CfError::MissingScope(_) => AppError::BadRequest(
            "your Cloudflare token is missing the Email Routing scope — re-mint it with \
             \"Email Routing Rules: Edit\" (keep the existing DNS: Edit for the MX records) \
             and save the new token, then try again."
                .into(),
        ),
        other => cf_err(other),
    }
}

#[derive(Debug, Deserialize)]
struct AgentInboxInput {
    company_id: i64,
    #[serde(default)]
    local_part: Option<String>,
    destination_email: String,
}

#[derive(Debug, Serialize)]
struct AgentInboxResult {
    /// The bot's freshly-minted address, e.g. `agent@example.com`.
    address: String,
    destination: String,
    /// True while the destination still needs its one CF verification click.
    verification_pending: bool,
    /// The zone's routing enablement (reflected from `email_routing_status`).
    routing_enabled: bool,
}

/// `POST /api/external-access/agent-inbox` — give a company's bots their own
/// address on the connected domain. Enables Cloudflare Email Routing on the zone,
/// registers + (re)checks the destination mailbox, creates the
/// `<local_part>@<base_domain> → destination` forward rule, and persists the
/// non-secret record. Idempotent: re-running refreshes the destination's verified
/// state (the wizard's "Check again") without duplicating the rule. FAIL-CLOSED —
/// requires a chosen base domain (the connected zone) and a saved CF token.
async fn agent_inbox_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Json(input): Json<AgentInboxInput>,
) -> Result<Json<Envelope<AgentInboxResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/agent-inbox")?;
    // The connected domain is the zone email routing runs on (fail-closed).
    let base = require_base_domain(&state)?;
    let id = input.company_id;
    crate::db::companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    let local_part = input
        .local_part
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("agent")
        .to_ascii_lowercase();
    if !valid_local_part(&local_part) {
        return Err(AppError::BadRequest(
            "local part must be lowercase letters/digits with interior . _ - (e.g. \"agent\")".into(),
        ));
    }
    let destination = input.destination_email.trim().to_ascii_lowercase();
    if !EMAIL_RE.is_match(&destination) {
        return Err(AppError::BadRequest("destination email is not a valid address".into()));
    }
    let address = format!("{local_part}@{base}");

    // Reject an address another company already claimed (each bot address is
    // globally unique on the zone — two companies can't share one inbox).
    {
        let cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
        if cfg
            .agent_inboxes
            .iter()
            .any(|a| a.company_id != id && a.address.eq_ignore_ascii_case(&address))
        {
            return Err(AppError::Conflict(format!(
                "{address} is already used by another company — pick a different local part"
            )));
        }
    }

    let token = read_cf_token(&state)
        .ok_or_else(|| AppError::BadRequest("save a Cloudflare API token first".into()))?;
    let api = state.external_access.cf();
    let account_id = cf::discover_account(api.as_ref(), &token)
        .await
        .map_err(cf_err)?;
    let zone_id = api.zone_id(&token, &base).await.map_err(cf_err)?;

    // Enable routing (MX+SPF), register the destination, create the forward rule.
    // A 403 from any of these ⇒ the token lacks the Email Routing scope.
    api.enable_email_routing(&token, &zone_id)
        .await
        .map_err(agent_inbox_cf_err)?;
    let dest = api
        .add_destination_address(&token, &account_id, &destination)
        .await
        .map_err(agent_inbox_cf_err)?;
    let rule_tag = api
        .create_routing_rule(
            &token,
            &zone_id,
            &format!("supermux agent-inbox: {address}"),
            &address,
            &destination,
        )
        .await
        .map_err(agent_inbox_cf_err)?;
    let routing_enabled = api
        .email_routing_status(&token, &zone_id)
        .await
        .map(|s| s.enabled)
        .unwrap_or(true);

    // Persist the non-secret record (idempotent upsert by company).
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    store::upsert_agent_inbox(
        &mut cfg,
        store::AgentInbox {
            company_id: id,
            address: address.clone(),
            destination: destination.clone(),
            verified: dest.verified,
            rule_tag: Some(rule_tag),
        },
    );
    store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;

    Ok(ok(AgentInboxResult {
        address,
        destination,
        verification_pending: !dest.verified,
        routing_enabled,
    }))
}

#[derive(Debug, Deserialize)]
struct AgentInboxDeleteQuery {
    company_id: i64,
}

#[derive(Debug, Serialize)]
struct AgentInboxDeleteResult {
    deleted: bool,
}

/// `DELETE /api/external-access/agent-inbox?company_id=<id>` — remove a company's
/// agent-inbox: best-effort delete of the Cloudflare routing rule (by its stored
/// tag), then drop the store record. The destination address (which the owner may
/// use elsewhere) is intentionally left registered.
async fn agent_inbox_delete_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Query(q): Query<AgentInboxDeleteQuery>,
) -> Result<Json<Envelope<AgentInboxDeleteResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/agent-inbox")?;
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    let existing = store::agent_inbox_for(&cfg, q.company_id).cloned();
    let Some(inbox) = existing else {
        return Ok(ok(AgentInboxDeleteResult { deleted: false }));
    };

    // Best-effort CF rule teardown. A missing token/base or a CF hiccup must not
    // block dropping the local record (fail-closed: no dangling allowlist).
    if let Some(tag) = &inbox.rule_tag {
        if let (Some(token), Ok(base)) = (read_cf_token(&state), require_base_domain(&state)) {
            let api = state.external_access.cf();
            if let Ok(zone_id) = api.zone_id(&token, &base).await {
                if let Err(e) = api.delete_routing_rule(&token, &zone_id, tag).await {
                    tracing::warn!(error = %e, "agent-inbox: CF rule delete failed; dropping record anyway");
                }
            }
        }
    }

    store::remove_agent_inbox(&mut cfg, q.company_id);
    store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;
    Ok(ok(AgentInboxDeleteResult { deleted: true }))
}

// ── 4a. POST/DELETE /api/external-access/quick-tunnel ────────────────────────

#[derive(Debug, Deserialize)]
struct QuickTunnelInput {
    company_id: i64,
}

#[derive(Debug, Serialize)]
struct QuickTunnelResult {
    url: String,
    host: String,
    /// Always true — a quick tunnel is inherently ephemeral. The honesty flag the
    /// wizard renders ("this link changes on restart").
    ephemeral: bool,
    company_id: i64,
}

/// The canonical redirect URI for a quick-tunnel host (parity shape with the
/// Google path, even though the invite flow does not use it).
fn quick_redirect_uri(host: &str) -> String {
    format!("https://{host}/auth/callback")
}

/// `POST /api/external-access/quick-tunnel` — start a zero-config Cloudflare quick
/// tunnel for ONE company (design §4.5). Ensures signing keys, spawns the child,
/// captures the ephemeral `*.trycloudflare.com` URL, registers it as an EPHEMERAL
/// `CompanyHost` entry + a `quick_tunnel` record, hot-reloads human-auth.
///
/// Single active quick tunnel per box: starting one for a DIFFERENT company tears
/// the prior one down first (stop child + drop its host entry). Idempotent — an
/// existing, still-alive tunnel for the SAME company is reused unchanged.
async fn quick_tunnel_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Json(input): Json<QuickTunnelInput>,
) -> Result<Json<Envelope<QuickTunnelResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/quick-tunnel")?;
    let company_id = input.company_id;
    // The company must exist (404 parity with the rest of the surface).
    crate::db::companies::get(&state.pool, company_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={company_id}")))?;

    let mut guard = state.external_access.quick_handle().await;
    let mut store = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;

    // Idempotent reuse: a live tunnel already bound to THIS company.
    if let Some(existing) = &store.quick_tunnel {
        if existing.company_id == company_id {
            let alive = match guard.as_mut() {
                Some(h) => h.is_alive(),
                None => false,
            };
            if alive {
                let host = existing.host.clone();
                return Ok(ok(QuickTunnelResult {
                    url: format!("https://{host}"),
                    host,
                    ephemeral: true,
                    company_id,
                }));
            }
        }
    }

    // Otherwise (re)bind: tear down any prior child + its ephemeral host entry.
    if let Some(prev) = guard.take() {
        state.external_access.quick().stop(prev).await;
    }
    if let Some(prev) = store.quick_tunnel.take() {
        let prev_host = prev.host.trim().to_ascii_lowercase();
        store
            .company_hosts
            .retain(|h| h.host.trim().to_ascii_lowercase() != prev_host);
    }

    // Signing keys must exist so `invite_enabled()` becomes true even with no
    // Google (idempotent; read-or-generate the 0600 files).
    crate::config::ensure_signing_keys(&state.config.data_dir).map_err(AppError::Internal)?;

    // Spawn the child + capture the ephemeral URL (behind the mockable seam).
    let handle = state
        .external_access
        .quick()
        .start(&cloudflared_bin_path(), &local_service(&state))
        .await
        .map_err(|e| AppError::BadRequest(format!("could not start quick tunnel: {e}")))?;
    let host = handle.host.clone();
    let url = handle.url.clone();
    let created_at = handle.started_at;

    // Register the ephemeral CompanyHost entry (drives login / WS-origin / cookie
    // scoping) + the quick_tunnel record, atomically, then hot-reload.
    // Only drop a prior EPHEMERAL host for this company — a permanent BYO-domain
    // host (`ephemeral:false`) must survive so a quick trial never wipes the
    // company's real, Google-backed login surface (they can coexist; `host_entry`
    // resolves either host to the same company).
    store
        .company_hosts
        .retain(|h| !(h.company_id == company_id && h.ephemeral));
    store.company_hosts.push(crate::config::CompanyHost {
        host: host.clone(),
        company_id,
        redirect_uri: quick_redirect_uri(&host),
        ephemeral: true,
    });
    store.quick_tunnel = Some(store::QuickTunnel {
        company_id,
        host: host.clone(),
        created_at,
    });
    store::write_atomic(&state.config.data_dir, &store).map_err(AppError::Internal)?;
    state.reload_human_auth().map_err(AppError::Internal)?;

    // Stash the live child in memory.
    *guard = Some(handle);

    Ok(ok(QuickTunnelResult {
        url,
        host,
        ephemeral: true,
        company_id,
    }))
}

#[derive(Debug, Serialize)]
struct QuickTunnelTeardownResult {
    torn_down: bool,
}

/// `DELETE /api/external-access/quick-tunnel` — stop the child, remove the
/// ephemeral `CompanyHost` entry + the `quick_tunnel` record, hot-reload.
async fn quick_tunnel_teardown_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
) -> Result<Json<Envelope<QuickTunnelTeardownResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/quick-tunnel")?;
    let mut guard = state.external_access.quick_handle().await;
    if let Some(handle) = guard.take() {
        state.external_access.quick().stop(handle).await;
    }
    let mut store = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    let torn_down = store.quick_tunnel.is_some();
    if let Some(prev) = store.quick_tunnel.take() {
        let prev_host = prev.host.trim().to_ascii_lowercase();
        store
            .company_hosts
            .retain(|h| h.host.trim().to_ascii_lowercase() != prev_host);
        store::write_atomic(&state.config.data_dir, &store).map_err(AppError::Internal)?;
        state.reload_human_auth().map_err(AppError::Internal)?;
    }
    Ok(ok(QuickTunnelTeardownResult { torn_down }))
}

// ── 4b. GET /api/external-access/zones ───────────────────────────────────────

#[derive(Debug, Serialize)]
struct ZonesResult {
    /// The zone apex names the saved CF token can read (never the ids/token).
    zones: Vec<String>,
}

/// List the DNS zones the saved Cloudflare token controls, so the wizard's
/// "Choose your domain" step can offer them. Returns zone NAMES only — the DNS
/// `zone_id` is re-derived at provision via [`cf::CfApi::zone_id`], keeping the
/// non-secret store minimal and never echoing the token.
async fn zones_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
) -> Result<Json<Envelope<ZonesResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/zones")?;
    let token = read_cf_token(&state)
        .ok_or_else(|| AppError::BadRequest("save a Cloudflare API token first".into()))?;
    let api = state.external_access.cf();
    let zones = api.list_zones(&token).await.map_err(cf_err)?;
    Ok(ok(ZonesResult {
        zones: zones.into_iter().map(|z| z.zone_name).collect(),
    }))
}

// ── 4c. POST /api/external-access/base-domain ────────────────────────────────

#[derive(Debug, Deserialize)]
struct BaseDomainInput {
    base_domain: String,
}

#[derive(Debug, Serialize)]
struct BaseDomainResult {
    base_domain: String,
}

/// Set the operator's chosen base domain. FAIL-CLOSED: the domain must be a
/// syntactically-sane apex AND an exact member of a fresh `list_zones(token)` —
/// a typo or an uncontrolled domain is rejected with a 400, so it can never open
/// the WS Origin allowlist or provision a zone the token does not own. On success
/// it upserts `CompaniesConfig.base_domain`, writes the companion store
/// atomically, and hot-reloads the live [`HumanAuthConfig`] (no restart).
async fn base_domain_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Json(input): Json<BaseDomainInput>,
) -> Result<Json<Envelope<BaseDomainResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/base-domain")?;
    let base = input.base_domain.trim().to_ascii_lowercase();
    // Syntactic sanity: non-empty, has a dot, no whitespace, no wildcard/scheme/path.
    let sane = !base.is_empty()
        && base.contains('.')
        && !base.contains(char::is_whitespace)
        && !base.contains('*')
        && !base.contains('/')
        && !base.contains(':');
    if !sane {
        return Err(AppError::BadRequest(
            "base_domain must be a bare domain like example.com".into(),
        ));
    }

    // Fail-closed membership check: the chosen domain must be an exact zone the
    // token controls (re-listed fresh — never trust client input for the gate).
    let token = read_cf_token(&state)
        .ok_or_else(|| AppError::BadRequest("save a Cloudflare API token first".into()))?;
    let api = state.external_access.cf();
    let zones = api.list_zones(&token).await.map_err(cf_err)?;
    if !zones
        .iter()
        .any(|z| z.zone_name.trim().eq_ignore_ascii_case(&base))
    {
        return Err(AppError::BadRequest(format!(
            "{base} is not one of the zones this Cloudflare token controls"
        )));
    }

    // Persist to the companion store (atomic) + hot-reload the live config.
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    cfg.base_domain = Some(base.clone());
    store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;
    state.reload_human_auth().map_err(AppError::Internal)?;

    Ok(ok(BaseDomainResult { base_domain: base }))
}

// ── 5. POST /api/companies/{id}/host ─────────────────────────────────────────

/// Optional body for `POST /api/companies/{id}/host`. The endpoint is also
/// called with NO body at all (the wizard's Google mini-step just re-asserts the
/// entry), hence `Option<Json<_>>` at the handler and a defaulted field here.
#[derive(Debug, Default, Deserialize)]
struct HostInput {
    /// The single DNS label the owner wants in front of the base domain. Absent ⇒
    /// KEEP whatever label this company already publishes, and only fall back to
    /// the company slug when there is no entry yet. (Defaulting to the slug
    /// unconditionally would silently rename an owner-chosen address back.)
    #[serde(default)]
    subdomain: Option<String>,
}

#[derive(Debug, Serialize)]
struct HostResult {
    host: String,
    redirect_uri: String,
    /// The address this company published BEFORE this call, when the label
    /// actually changed — so the wizard can say the old link stops working and the
    /// new redirect URI needs registering. `None` ⇒ nothing moved.
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_host: Option<String>,
    /// What happened to this host's DNS record in the operator's zone:
    /// `created` | `exists` | `pending` (no tunnel yet — "Set up access" creates
    /// it) | `unavailable` (no Cloudflare token on this box).
    dns: String,
    /// True when the RENAME deleted the old record (only ever done when that
    /// record pointed at our own tunnel).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    previous_dns_removed: bool,
}

/// The one place a `company_hosts` label is validated. Lower-cases + trims, then
/// pins the single-DNS-label rule; the error text is what the wizard shows.
fn validated_label(raw: &str) -> Result<String, AppError> {
    let label = raw.trim().to_ascii_lowercase();
    if !is_dns_label(&label) {
        return Err(AppError::BadRequest(
            "the subdomain must be 1-63 characters of a-z, 0-9 or -, and cannot start \
             or end with -"
                .into(),
        ));
    }
    Ok(label)
}

async fn host_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<i64>,
    input: Option<Json<HostInput>>,
) -> Result<Json<Envelope<HostResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/host"))?;
    // FAIL-CLOSED: never write a company_hosts entry without a chosen base domain.
    let base = require_base_domain(&state)?;
    let co = crate::db::companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    let live = state.human_auth_cfg();
    let current = live.company_entry(id);
    let current_host = current.map(|e| e.host.trim().to_ascii_lowercase());
    let current_label = current.and_then(|e| e.label_under(&base));

    // The label: what the owner typed, else the one already published, else the
    // slug the wizard suggests. A slug that is not a legal hostname label cannot
    // be a silent default — it would need a DNS record that cannot be made, or a
    // certificate Universal SSL does not issue — so say so instead.
    let label = match input.and_then(|Json(i)| i.subdomain) {
        Some(raw) => validated_label(&raw)?,
        None => match current_label {
            Some(l) => l,
            None => validated_label(&co.slug).map_err(|_| {
                AppError::BadRequest(format!(
                    "\"{}\" cannot be used as a web address - choose a subdomain \
                     (a-z, 0-9 and -) for this company",
                    co.slug.trim()
                ))
            })?,
        },
    };
    let host = company_canonical_host(&label, &base);
    let redirect_uri = company_redirect_uri(&label, &base);

    // Uniform, honest refusal: one address can only serve one company (the Host
    // header is what binds a login cookie to a company).
    if live
        .company_hosts
        .iter()
        .any(|h| h.company_id != id && h.host.trim().eq_ignore_ascii_case(&host))
    {
        return Err(AppError::Conflict(format!(
            "{host} is already used by another company - pick a different subdomain"
        )));
    }

    // DNS FIRST, so a name the operator already uses is refused before anything is
    // persisted: `ensure_host_record` probes the zone and only creates a record on
    // a free name (or reports the one already pointing at our tunnel). No token ⇒
    // this box does not do DNS at all; no tunnel yet ⇒ provisioning creates it.
    let dns_ctx = cf_dns_ctx(&state, &base).await?;
    let dns_state = match &dns_ctx {
        Some(dns) => ensure_host_record(&state, dns, &host).await?,
        None => DNS_UNAVAILABLE,
    };

    // Upsert this company's company_hosts entry into the companion store. A rename
    // REPLACES the old entry (the old address stops resolving to this company).
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(AppError::Internal)?;
    cfg.company_hosts.retain(|h| h.company_id != id);
    cfg.company_hosts.push(crate::config::CompanyHost {
        host: host.clone(),
        company_id: id,
        redirect_uri: redirect_uri.clone(),
        ephemeral: false,
    });
    store::write_atomic(&state.config.data_dir, &cfg).map_err(AppError::Internal)?;
    state.reload_human_auth().map_err(AppError::Internal)?;

    let previous_host = current_host.filter(|h| *h != host);

    // A rename retires the old address: drop its record (ONLY when it points at
    // our tunnel — an operator's own record is never collateral) and rewrite the
    // ingress document, which now enumerates the hostnames this box serves.
    let mut previous_dns_removed = false;
    if let Some(dns) = &dns_ctx {
        if let Some(old) = &previous_host {
            previous_dns_removed = remove_our_record(&state, dns, old).await?;
        }
        sync_ingress(&state, dns, &base).await?;
    }

    Ok(ok(HostResult {
        host,
        redirect_uri,
        previous_host,
        dns: dns_state.to_string(),
        previous_dns_removed,
    }))
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
    // FAIL-CLOSED: the Domain step gates this, so a missing base is a clean 400.
    let base = require_base_domain(&state)?;
    let co = crate::db::companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    let cfg = state.human_auth_cfg();
    // Entry-authoritative (see `resolve_company_host`): verify the address this
    // company actually publishes, not a slug-derived guess.
    let (host, redirect_uri) = resolve_company_host(&cfg, id, &co.slug, &base);

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
    match cfg.company_entry(id) {
        Some(e) if e.is_valid_for(id, &base) => Ok(ok(VerifyLoginResult {
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

// ── 6b. POST /api/external-access/tighten-dns ────────────────────────────────

#[derive(Debug, Serialize)]
struct TightenDnsResult {
    /// The per-company records that exist after this call.
    records: Vec<String>,
    /// Whether the `*.<base>` record was actually removed (false when there was
    /// none, or when the one there did not point at our tunnel).
    wildcard_removed: bool,
}

/// Replace a legacy `*.<base_domain>` wildcard with one record per company host.
///
/// Explicitly operator-driven: a wildcard is never removed as a side effect of
/// something else, because dropping it is the moment any name that was only
/// reachable THROUGH it stops resolving. The order is what makes it safe —
/// per-company records first, then the ingress without the wildcard rule, and the
/// wildcard record itself LAST (and only when it points at our own tunnel).
async fn tighten_dns_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
) -> Result<Json<Envelope<TightenDnsResult>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), "/api/external-access/tighten-dns")?;
    let base = require_base_domain(&state)?;
    let dns = cf_dns_ctx(&state, &base)
        .await?
        .ok_or_else(|| AppError::BadRequest("save a Cloudflare API token first".into()))?;
    if dns.tunnel.is_none() {
        return Err(AppError::BadRequest(
            "set up access first — there is no tunnel for these records to point at".into(),
        ));
    }

    // 1. Every company host gets its own record (a foreign name still refuses).
    let records = company_hostnames(&state.human_auth_cfg(), &base);
    for host in &records {
        ensure_host_record(&state, &dns, host).await?;
    }

    // 2. Ingress WITHOUT the wildcard rule: exactly the company hosts + 404.
    let (tunnel_id, target) = dns.tunnel.as_ref().expect("tunnel present, checked above");
    state
        .external_access
        .cf()
        .put_tunnel_config(
            &dns.token,
            &dns.account_id,
            tunnel_id,
            &records,
            &local_service(&state),
        )
        .await
        .map_err(cf_err)?;

    // 3. The wildcard record itself — last, and only if it is ours.
    let wildcard = wildcard_host(&base);
    let api = state.external_access.cf();
    let existing = api
        .find_dns_cname(&dns.token, &dns.zone_id, &wildcard)
        .await
        .map_err(cf_err)?;
    let wildcard_removed = match existing {
        Some(r) if r.content.trim().eq_ignore_ascii_case(target) => {
            api.delete_dns_record(&dns.token, &dns.zone_id, &r.id)
                .await
                .map_err(cf_err)?;
            true
        }
        _ => false,
    };

    Ok(ok(TightenDnsResult {
        records,
        wildcard_removed,
    }))
}

/// Release everything a company holds on the operator's domain: its
/// `company_hosts` allowlist entry, its DNS record (only when that record points
/// at our tunnel) and its ingress rule.
///
/// Called by the delete-company cascade — a removed company must not keep a live
/// login host, and must not leave a record behind on someone's zone. Best-effort
/// by construction: it returns a human warning instead of an error, because a
/// Cloudflare hiccup must never stop a destructive teardown half-way. `Ok(None)`
/// ⇒ nothing to release.
pub async fn release_company_host(state: &AppState, company_id: i64) -> Option<String> {
    let host = state
        .human_auth_cfg()
        .company_entry(company_id)?
        .host
        .trim()
        .to_ascii_lowercase();

    // The allowlist entry first: whatever Cloudflare does next, this box must stop
    // treating that Host as the company's login surface.
    let mut warning = None;
    match store::read_or_default(&state.config.data_dir) {
        Ok(mut cfg) => {
            cfg.company_hosts
                .retain(|h| !(h.company_id == company_id && !h.ephemeral));
            if let Err(e) = store::write_atomic(&state.config.data_dir, &cfg) {
                warning = Some(format!("company host entry not removed: {e}"));
            } else if let Err(e) = state.reload_human_auth() {
                warning = Some(format!("auth not reloaded after host removal: {e}"));
            }
        }
        Err(e) => warning = Some(format!("companion store unreadable: {e}")),
    }

    let base = match state.human_auth_cfg().base_domain.clone() {
        Some(b) if !b.trim().is_empty() => b.trim().to_ascii_lowercase(),
        _ => return warning,
    };
    match cf_dns_ctx(state, &base).await {
        Ok(Some(dns)) => {
            if let Err(e) = remove_our_record(state, &dns, &host).await {
                warning = Some(format!("DNS record {host} not removed: {e}"));
            }
            if let Err(e) = sync_ingress(state, &dns, &base).await {
                warning = Some(format!("tunnel ingress not updated after removing {host}: {e}"));
            }
        }
        Ok(None) => {}
        Err(e) => warning = Some(format!("cloudflare unreachable while removing {host}: {e}")),
    }
    warning
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

    // Two login paths. A quick-tunnel company (the store's `quick_tunnel` record
    // matches this company) issues a signed magic-link on its ephemeral host and
    // needs NO base domain. Otherwise the permanent Google path REQUIRES a chosen
    // base domain (fail-closed: the login url is only meaningful under one).
    let quick = store::read_or_default(&state.config.data_dir)
        .map_err(AppError::Internal)?
        .quick_tunnel
        .filter(|q| q.company_id == id);
    let base = match &quick {
        Some(_) => None,
        None => Some(require_base_domain(&state)?),
    };

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

    // Build the login url for whichever path this company is on.
    let login_url = match (&quick, &base) {
        // Quick-tunnel: a signed, time-boxed magic link on the ephemeral host.
        (Some(q), _) => {
            let cfg = state.human_auth_cfg();
            if cfg.invite_key.is_empty() {
                return Err(AppError::Internal(anyhow::anyhow!(
                    "invite key missing; cannot mint magic link"
                )));
            }
            let exp = chrono::Utc::now().timestamp()
                + crate::auth_human::invite::DEFAULT_INVITE_TTL_SECS;
            let token =
                crate::auth_human::invite::mint_invite_token(&cfg.invite_key, user.id, id, exp);
            format!("https://{}/auth/invite?token={token}", q.host)
        }
        // Permanent Google path: the company's published host (entry-authoritative,
        // so an owner-renamed subdomain lands in the invite link too).
        (None, Some(base)) => format!(
            "https://{}",
            resolve_company_host(&state.human_auth_cfg(), id, &co.slug, base).0
        ),
        // Unreachable: `base` is `Some` whenever `quick` is `None` (set above).
        (None, None) => unreachable!("base domain resolved on the non-quick path"),
    };

    Ok(ok(AddHumanResult { user, login_url }))
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
