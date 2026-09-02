//! supermux-brokered **authorization-code + PKCE** sign-in for remote (hosted)
//! MCP servers — the `mcp_oauth` lane (RFC 6749/7636/7591/8414/8707/9207/9728).
//!
//! Before this, every `mcp_oauth` card (InhouseSEO, Slack, Notion, …) launched as
//! a bare `{ "url" }` entry and told the owner to "approve the sign-in in the
//! bot's terminal": Claude Code's own OAuth redirects to `http://localhost:<port>`
//! (unreachable from the phone) and stores the token box-wide, outside the vault
//! and outside per-company grants. Now supermux **is** the OAuth client:
//!
//!   1. `POST /api/connectors/{id}/oauth/start` — discovers the server's
//!      authorization server (RFC 9728 protected-resource metadata → RFC 8414 AS
//!      metadata), registers a client (RFC 7591, cached per `(issuer,
//!      redirect_uri)` in the 0600 companion store), mints PKCE + `state`, and
//!      hands the SPA an `authorize_url` to `location.assign` to (same tab, so
//!      the iOS PWA comes back to itself).
//!   2. `GET /api/oauth/callback` — PUBLIC. Exchanges the code and **stashes the
//!      tokens in RAM only**; it writes no row, because a public callback has no
//!      proof of who is holding the browser. Every failure is a uniform 302 with
//!      `connect_error=<code>` (never a body that reveals whether a state existed).
//!   3. `POST /api/connectors/{id}/oauth/complete { state }` — the authenticated
//!      finishing step: the finishing identity must equal the flow's initiator,
//!      then the tokens seal into the vault (one row per account, re-sealed in
//!      place on a re-sign-in), the grant lands, and a REAL JSON-RPC `initialize`
//!      probe with the minted bearer writes the account's health. Every green in
//!      this lane is a probe answer, never "the exchange succeeded".
//!
//! At launch ([`apply_to_launch`], called from
//! `sessions::connector_config::assemble`) the sealed token is refreshed when it
//! is about to expire ([`ensure_fresh`], under a per-secret lock) and injected as
//! `headers.Authorization = "Bearer ${SUPERMUX_MCP_TOKEN_<ID>}"` — Claude Code
//! expands `${VAR}` inside `headers` of an inline `--mcp-config` (verified on the
//! pinned build 2.1.258 against a local listener: the literal bearer arrived).
//! Only the short-lived access token enters the child env; the refresh token, the
//! expiry and the meta never leave the vault.
//!
//! **Secret hygiene.** `CodeFlow`/`TokenResponse` print `<redacted>` for every
//! secret field; DCR responses and token-endpoint error bodies go through
//! [`crate::log_redact::redact_secrets`] before any log line; the authorize URL is
//! returned to the caller and never logged.
//!
//! **SSRF policy.** Every URL the broker fetches — the MCP url, the metadata
//! URLs, every AS endpoint — passes [`UrlPolicy::check`] (https only, DNS name,
//! no userinfo/fragment) AND the broker's `reqwest` client resolves names through
//! a filter that refuses loopback / RFC 1918 / link-local / CGNAT answers, so a
//! public name that resolves privately is refused too. Redirects are never
//! followed (a bearer is never forwarded). The only relaxation is the test-only
//! `allow_loopback_http`, settable through `AppState::set_oauth_url_policy_for_tests`
//! (never from config or env).

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::auth_human::AuthContext;
use crate::db::connectors;
use crate::error::AppError;
use crate::external_access::store::{self, McpOauthClient};
use crate::log_redact::redact_secrets;
use crate::scope::{authorize_connector_target, require_admin, OptCtx};
use crate::state::AppState;
use crate::vault::Vault;

use super::manifest::valid_connector_id;
use super::oauth::{audit, catalog_card, db_err, ensure_connector_installed, normalize_session};

/// Vault field keys — fixed, one vault row per account, forever.
pub const ACCESS_TOKEN_FIELD: &str = "MCP_OAUTH_ACCESS_TOKEN";
pub const REFRESH_TOKEN_FIELD: &str = "MCP_OAUTH_REFRESH_TOKEN";
pub const EXPIRES_AT_FIELD: &str = "MCP_OAUTH_EXPIRES_AT";
pub const META_FIELD: &str = "MCP_OAUTH_META";

/// A flow (either stage) lives this long before the sweep drops it.
pub const FLOW_TTL_SECS: i64 = 600;
/// At most this many live flows per initiator (oldest evicted).
pub const MAX_FLOWS_PER_INITIATOR: usize = 5;
/// Env-var prefix for the injected access token.
pub const ENV_PREFIX: &str = "SUPERMUX_MCP_TOKEN_";
/// The `session_locks` key prefix for the per-secret refresh/seal lock.
const LOCK_PREFIX: &str = "oauth:";

const BODY_CAP: usize = 256 * 1024;
const MAX_TOKEN_LEN: usize = 8 * 1024;
const MAX_EXPIRES_IN: u64 = 30 * 86_400;
const REFRESH_SKEW_SECS: i64 = 300;
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const USER_AGENT: &str = "supermux-oauth/1";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

// ── URL policy (SSRF fence) ─────────────────────────────────────────────────────

/// The broker's outbound-URL policy. `Default` is the production policy; the
/// only relaxation exists for the in-process mock in tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UrlPolicy {
    /// TEST ONLY: admit `http://127.0.0.1:<port>` / `http://localhost` so an
    /// in-process mock authorization server can be reached. Never set from
    /// config or env — only `AppState::set_oauth_url_policy_for_tests`.
    pub allow_loopback_http: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlError {
    NotAbsolute,
    Scheme,
    Userinfo,
    Fragment,
    NoHost,
    IpLiteral,
    PrivateHost,
}

impl fmt::Display for UrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            UrlError::NotAbsolute => "not an absolute URL",
            UrlError::Scheme => "scheme must be https",
            UrlError::Userinfo => "userinfo is not allowed",
            UrlError::Fragment => "fragment is not allowed",
            UrlError::NoHost => "no host",
            UrlError::IpLiteral => "IP literals are not allowed",
            UrlError::PrivateHost => "private / loopback hosts are not allowed",
        };
        f.write_str(s)
    }
}

/// Is `ip` a loopback / private / link-local / CGNAT / unspecified address — the
/// set the broker must never talk to (textually AND after DNS resolution)?
pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                // CGNAT 100.64.0.0/10 (covers Tailscale's 100.x range).
                || (o[0] == 100 && (o[1] & 0xC0) == 64)
                // 0.0.0.0/8
                || o[0] == 0
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_ip(IpAddr::V4(v4));
            }
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                // fe80::/10 link-local
                || (s[0] & 0xffc0) == 0xfe80
                // fc00::/7 unique-local
                || (s[0] & 0xfe00) == 0xfc00
        }
    }
}

fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v| v.is_loopback()),
    }
}

impl UrlPolicy {
    /// Pure check of a parsed URL against the policy.
    pub fn check(&self, u: &Url) -> Result<(), UrlError> {
        if u.cannot_be_a_base() {
            return Err(UrlError::NotAbsolute);
        }
        if !u.username().is_empty() || u.password().is_some() {
            return Err(UrlError::Userinfo);
        }
        if u.fragment().is_some() {
            return Err(UrlError::Fragment);
        }
        let host = u.host().ok_or(UrlError::NoHost)?;
        match u.scheme() {
            "https" => {}
            "http" if self.allow_loopback_http => {}
            _ => return Err(UrlError::Scheme),
        }
        match host {
            url::Host::Domain(d) => {
                let d = d.to_ascii_lowercase();
                let is_local = d == "localhost" || d.ends_with(".localhost");
                if is_local && !self.allow_loopback_http {
                    return Err(UrlError::PrivateHost);
                }
                if d.is_empty() {
                    return Err(UrlError::NoHost);
                }
            }
            url::Host::Ipv4(ip) => {
                if self.allow_loopback_http && is_loopback_ip(IpAddr::V4(ip)) {
                    return Ok(());
                }
                return Err(UrlError::IpLiteral);
            }
            url::Host::Ipv6(ip) => {
                if self.allow_loopback_http && is_loopback_ip(IpAddr::V6(ip)) {
                    return Ok(());
                }
                return Err(UrlError::IpLiteral);
            }
        }
        Ok(())
    }

    /// Parse + check in one step.
    pub fn parse(&self, s: &str) -> Result<Url, UrlError> {
        let u = Url::parse(s.trim()).map_err(|_| UrlError::NotAbsolute)?;
        self.check(&u)?;
        Ok(u)
    }

    /// The broker's HTTP client: no redirects, 8 s timeout, fixed UA, and (in
    /// production) a DNS filter that refuses private answers.
    pub fn client(&self) -> Result<reqwest::Client, reqwest::Error> {
        let mut b = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HTTP_TIMEOUT)
            .user_agent(USER_AGENT);
        if !self.allow_loopback_http {
            b = b.dns_resolver(Arc::new(PublicOnlyResolver));
        }
        b.build()
    }
}

/// A `reqwest` DNS resolver that fails any name resolving to a private range —
/// the resolve-time half of the SSRF fence (the textual half is `UrlPolicy::check`).
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                .collect();
            if addrs.is_empty() {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no addresses",
                )) as Box<dyn std::error::Error + Send + Sync>);
            }
            if addrs.iter().any(|a| is_private_ip(a.ip())) {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "host resolves to a private address",
                )) as Box<dyn std::error::Error + Send + Sync>);
            }
            let it: reqwest::dns::Addrs = Box::new(addrs.into_iter());
            Ok(it)
        })
    }
}

// ── discovery ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoverError {
    Url(UrlError),
    /// Any 3xx from the server — never followed.
    Redirect,
    /// The MCP endpoint answered 2xx without auth: the card is mis-laned.
    NoAuthRequired,
    NoMetadata,
    /// `resource_metadata` points at a different host than the MCP url.
    ForeignMetadata,
    /// `prm.resource` names another API.
    ResourceMismatch,
    /// AS metadata `issuer` ≠ the URL it was fetched for.
    IssuerMismatch,
    /// `S256` missing from `code_challenge_methods_supported`.
    NoS256,
    NoRegistration,
    BadEndpoint(&'static str),
    Http(String),
    Parse(String),
}

impl fmt::Display for DiscoverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DiscoverError::Url(e) => write!(f, "url rejected: {e}"),
            DiscoverError::Redirect => f.write_str("server redirected (not followed)"),
            DiscoverError::NoAuthRequired => f.write_str("This server didn't ask for a sign-in"),
            DiscoverError::NoMetadata => f.write_str("no OAuth metadata published"),
            DiscoverError::ForeignMetadata => f.write_str("resource metadata on a foreign host"),
            DiscoverError::ResourceMismatch => f.write_str("protected-resource metadata names another resource"),
            DiscoverError::IssuerMismatch => f.write_str("authorization-server issuer mismatch"),
            DiscoverError::NoS256 => f.write_str("authorization server does not support PKCE S256"),
            DiscoverError::NoRegistration => {
                f.write_str("This server needs a pre-registered app — not supported yet")
            }
            DiscoverError::BadEndpoint(which) => write!(f, "{which} endpoint rejected by policy"),
            DiscoverError::Http(s) => write!(f, "http: {s}"),
            DiscoverError::Parse(s) => write!(f, "parse: {s}"),
        }
    }
}

impl From<UrlError> for DiscoverError {
    fn from(e: UrlError) -> Self {
        DiscoverError::Url(e)
    }
}

/// The parsed `WWW-Authenticate: Bearer …` challenge.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WwwAuth {
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
}

/// Parse a `WWW-Authenticate` header value. `None` for a non-Bearer scheme.
pub fn parse_www_authenticate(v: &str) -> Option<WwwAuth> {
    let v = v.trim();
    let (scheme, rest) = match v.find(|c: char| c.is_whitespace()) {
        Some(i) => (&v[..i], v[i..].trim()),
        None => (v, ""),
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let mut out = WwwAuth::default();
    for (k, val) in parse_auth_params(rest) {
        match k.to_ascii_lowercase().as_str() {
            "resource_metadata" => out.resource_metadata = Some(val),
            "scope" => out.scope = Some(val),
            _ => {}
        }
    }
    Some(out)
}

/// `key="quoted, value", key2=bare` → pairs (commas inside quotes are kept).
fn parse_auth_params(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = s;
    loop {
        rest = rest.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
        if rest.is_empty() {
            break;
        }
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq].trim().to_string();
        let after = &rest[eq + 1..];
        if let Some(q) = after.strip_prefix('"') {
            let mut val = String::new();
            let mut chars = q.char_indices();
            let mut end = q.len();
            while let Some((i, c)) = chars.next() {
                if c == '\\' {
                    if let Some((_, n)) = chars.next() {
                        val.push(n);
                    }
                } else if c == '"' {
                    end = i + 1;
                    break;
                } else {
                    val.push(c);
                }
            }
            out.push((key, val));
            rest = &q[end.min(q.len())..];
        } else {
            let end = after.find(',').unwrap_or(after.len());
            out.push((key, after[..end].trim().to_string()));
            rest = &after[end..];
        }
    }
    out
}

/// The normalised resource identifier for an MCP url (RFC 8707/9728): fragment
/// stripped, lowercase scheme + host, no trailing slash; query kept.
pub fn normalize_resource(u: &Url) -> String {
    let scheme = u.scheme().to_ascii_lowercase();
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let port = match (u.port(), scheme.as_str()) {
        (Some(443), "https") | (Some(80), "http") | (None, _) => String::new(),
        (Some(p), _) => format!(":{p}"),
    };
    let path = u.path().trim_end_matches('/');
    let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
    format!("{scheme}://{host}{port}{path}{query}")
}

/// Does the PRM's `resource` name the MCP url (equal after normalisation, or the
/// same origin with a path prefix of it)?
pub fn resource_matches(prm_resource: &str, mcp_url: &Url) -> bool {
    let Ok(pu) = Url::parse(prm_resource) else { return false };
    let want = normalize_resource(mcp_url);
    let have = normalize_resource(&pu);
    if have == want {
        return true;
    }
    if pu.origin() != mcp_url.origin() {
        return false;
    }
    let hp = pu.path().trim_end_matches('/');
    let mp = mcp_url.path().trim_end_matches('/');
    hp.is_empty() || mp == hp || mp.starts_with(&format!("{hp}/"))
}

/// The protected-resource metadata (RFC 9728 §2).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Prm {
    #[serde(default)]
    pub resource: String,
    #[serde(default)]
    pub authorization_servers: Vec<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

/// The authorization-server metadata (RFC 8414 §2) — the fields the broker uses.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AsMetadata {
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub authorization_endpoint: String,
    #[serde(default)]
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub userinfo_endpoint: Option<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Option<Vec<String>>,
    #[serde(default)]
    pub token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    pub authorization_response_iss_parameter_supported: bool,
}

/// RFC 8414 §3 well-known URLs for an issuer: `oauth-authorization-server` with
/// path insertion, then `openid-configuration` (appended, then path-inserted).
pub fn well_known_urls(issuer: &Url) -> Vec<String> {
    let origin = format!(
        "{}://{}{}",
        issuer.scheme(),
        issuer.host_str().unwrap_or(""),
        issuer.port().map(|p| format!(":{p}")).unwrap_or_default()
    );
    let path = issuer.path().trim_end_matches('/');
    let mut out = vec![format!("{origin}/.well-known/oauth-authorization-server{path}")];
    if path.is_empty() {
        out.push(format!("{origin}/.well-known/openid-configuration"));
    } else {
        out.push(format!("{origin}{path}/.well-known/openid-configuration"));
        out.push(format!("{origin}/.well-known/openid-configuration{path}"));
    }
    out
}

/// Validate AS metadata against the issuer it was fetched for + the URL policy.
pub fn validate_as_metadata(
    meta: &AsMetadata,
    issuer: &str,
    policy: &UrlPolicy,
) -> Result<(), DiscoverError> {
    if meta.issuer.trim().trim_end_matches('/') != issuer.trim().trim_end_matches('/') {
        return Err(DiscoverError::IssuerMismatch);
    }
    policy
        .parse(&meta.authorization_endpoint)
        .map_err(|_| DiscoverError::BadEndpoint("authorization"))?;
    policy
        .parse(&meta.token_endpoint)
        .map_err(|_| DiscoverError::BadEndpoint("token"))?;
    if let Some(r) = meta.registration_endpoint.as_deref().filter(|s| !s.is_empty()) {
        policy.parse(r).map_err(|_| DiscoverError::BadEndpoint("registration"))?;
    }
    if let Some(u) = meta.userinfo_endpoint.as_deref().filter(|s| !s.is_empty()) {
        policy.parse(u).map_err(|_| DiscoverError::BadEndpoint("userinfo"))?;
    }
    if let Some(methods) = &meta.code_challenge_methods_supported {
        if !methods.iter().any(|m| m == "S256") {
            return Err(DiscoverError::NoS256);
        }
    }
    Ok(())
}

/// Clamp a scope string: ≤ 512 chars of `[\x21-\x7e ]`, else `None`.
pub fn clamp_scope(s: Option<String>) -> Option<String> {
    let s = s?.trim().to_string();
    if s.is_empty() || s.len() > 512 {
        return None;
    }
    if !s.chars().all(|c| c == ' ' || ('\x21'..='\x7e').contains(&c)) {
        return None;
    }
    Some(s)
}

/// What discovery resolved for an MCP url.
#[derive(Debug, Clone)]
pub struct Discovered {
    /// The normalised MCP url — also the RFC 8707 `resource`.
    pub resource: String,
    pub issuer: String,
    pub as_meta: AsMetadata,
    pub scope: Option<String>,
}

/// A bounded HTTP response: status, headers, ≤ 256 KiB body.
struct Bounded {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

async fn bounded(resp: reqwest::Response) -> Result<Bounded, DiscoverError> {
    let status = resp.status();
    let headers = resp.headers().clone();
    let mut body = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| DiscoverError::Http(masked_err(&e)))? {
        if body.len() + chunk.len() > BODY_CAP {
            return Err(DiscoverError::Http("response body over 256 KiB".into()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Bounded { status, headers, body })
}

fn masked_err(e: &reqwest::Error) -> String {
    // reqwest errors carry the URL (no secret in ours), never a body.
    let s = e.to_string();
    crate::log_redact::redact(&s)
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| {
            let ct = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            ct == "application/json" || ct.ends_with("+json")
        })
        .unwrap_or(false)
}

/// `GET url` expecting a JSON body (no redirects, bounded, JSON content-type).
async fn get_json(client: &reqwest::Client, url: &Url) -> Result<Value, DiscoverError> {
    let resp = client
        .get(url.clone())
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| DiscoverError::Http(masked_err(&e)))?;
    let b = bounded(resp).await?;
    if b.status.is_redirection() {
        return Err(DiscoverError::Redirect);
    }
    if !b.status.is_success() {
        return Err(DiscoverError::Http(format!("HTTP {}", b.status.as_u16())));
    }
    if !is_json(&b.headers) {
        return Err(DiscoverError::Parse("not application/json".into()));
    }
    serde_json::from_slice(&b.body).map_err(|e| DiscoverError::Parse(e.to_string()))
}

/// The minimal JSON-RPC `initialize` body used by discovery + the health probe.
pub fn initialize_body(client_name: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": client_name, "version": "1" }
        }
    })
}

/// Run discovery for an MCP url (RFC 9728 → RFC 8414). Network happens here;
/// every parse/validate step is a pure fn above.
pub async fn discover(mcp_url: &str, policy: &UrlPolicy) -> Result<Discovered, DiscoverError> {
    let mcp = policy.parse(mcp_url)?;
    let client = policy.client().map_err(|e| DiscoverError::Http(masked_err(&e)))?;

    // (b) POST initialize without auth → expect a 401 Bearer challenge.
    let resp = client
        .post(mcp.clone())
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header(header::CONTENT_TYPE, "application/json")
        .body(initialize_body("supermux-oauth").to_string())
        .send()
        .await
        .map_err(|e| DiscoverError::Http(masked_err(&e)))?;
    let b = bounded(resp).await?;
    if b.status.is_redirection() {
        return Err(DiscoverError::Redirect);
    }
    if b.status.is_success() {
        return Err(DiscoverError::NoAuthRequired);
    }
    let www = b
        .headers
        .get(header::WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_www_authenticate)
        .unwrap_or_default();

    // Candidate PRM urls: the challenge's `resource_metadata` (same host only),
    // then the RFC 9728 §3.1 well-known locations.
    let mcp_origin = format!(
        "{}://{}{}",
        mcp.scheme(),
        mcp.host_str().unwrap_or(""),
        mcp.port().map(|p| format!(":{p}")).unwrap_or_default()
    );
    let mut candidates: Vec<Url> = Vec::new();
    if let Some(rm) = www.resource_metadata.as_deref() {
        let u = policy.parse(rm)?;
        if u.host_str().map(|h| h.to_ascii_lowercase()) != mcp.host_str().map(|h| h.to_ascii_lowercase()) {
            return Err(DiscoverError::ForeignMetadata);
        }
        candidates.push(u);
    }
    let path = mcp.path().trim_end_matches('/');
    if !path.is_empty() {
        if let Ok(u) = policy.parse(&format!("{mcp_origin}/.well-known/oauth-protected-resource{path}")) {
            candidates.push(u);
        }
    }
    if let Ok(u) = policy.parse(&format!("{mcp_origin}/.well-known/oauth-protected-resource")) {
        candidates.push(u);
    }

    // (c) Fetch the PRM.
    let mut prm: Option<Prm> = None;
    let mut last_err = DiscoverError::NoMetadata;
    for c in &candidates {
        match get_json(&client, c).await {
            Ok(v) => match serde_json::from_value::<Prm>(v) {
                Ok(p) => {
                    prm = Some(p);
                    break;
                }
                Err(e) => last_err = DiscoverError::Parse(e.to_string()),
            },
            Err(DiscoverError::Redirect) => return Err(DiscoverError::Redirect),
            Err(e) => last_err = e,
        }
    }
    let prm = prm.ok_or(last_err)?;
    if !resource_matches(&prm.resource, &mcp) {
        return Err(DiscoverError::ResourceMismatch);
    }
    let issuer_str = prm
        .authorization_servers
        .first()
        .cloned()
        .ok_or(DiscoverError::NoMetadata)?;
    let issuer = policy.parse(&issuer_str)?;

    // (d) AS metadata.
    let mut meta: Option<AsMetadata> = None;
    let mut last_err = DiscoverError::NoMetadata;
    for wk in well_known_urls(&issuer) {
        let Ok(u) = policy.parse(&wk) else { continue };
        match get_json(&client, &u).await {
            Ok(v) => match serde_json::from_value::<AsMetadata>(v) {
                Ok(m) => {
                    meta = Some(m);
                    break;
                }
                Err(e) => last_err = DiscoverError::Parse(e.to_string()),
            },
            Err(DiscoverError::Redirect) => return Err(DiscoverError::Redirect),
            Err(e) => last_err = e,
        }
    }
    let meta = meta.ok_or(last_err)?;
    validate_as_metadata(&meta, &issuer_str, policy)?;

    // (f) scope: challenge ▷ PRM ▷ AS ▷ none.
    let scope = clamp_scope(
        www.scope
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| (!prm.scopes_supported.is_empty()).then(|| prm.scopes_supported.join(" ")))
            .or_else(|| (!meta.scopes_supported.is_empty()).then(|| meta.scopes_supported.join(" "))),
    );

    Ok(Discovered {
        resource: normalize_resource(&mcp),
        issuer: meta.issuer.trim_end_matches('/').to_string(),
        as_meta: meta,
        scope,
    })
}

// ── PKCE + state ────────────────────────────────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

/// The S256 challenge for a verifier (RFC 7636 §4.2).
pub fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// `(verifier, challenge)`: the verifier is base64url of 32 random bytes (43
/// chars), the challenge `base64url(sha256(verifier))`.
pub fn pkce_pair() -> (String, String) {
    let verifier = b64url(&random_bytes(32));
    let challenge = pkce_challenge(&verifier);
    (verifier, challenge)
}

/// A fresh `state`: 32 random bytes base64url.
pub fn new_state() -> String {
    b64url(&random_bytes(32))
}

// ── return_to + redirect host ───────────────────────────────────────────────────

/// Validate the SPA's `return_to` path: ASCII, ≤ 512, charset
/// `[A-Za-z0-9/_.\-?=&%~]`, starts with `/` (not `//`), no `..` segment; resolved
/// against a dummy origin it must stay on that origin. Empty → `/store`.
pub fn validate_return_to(s: &str) -> Result<String, AppError> {
    let s = s.trim();
    if s.is_empty() {
        return Ok("/store".to_string());
    }
    let bad = || AppError::BadRequest("invalid return_to".into());
    if s.len() > 512 || !s.is_ascii() {
        return Err(bad());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || "/_.-?=&%~".contains(c)) {
        return Err(bad());
    }
    let mut chars = s.chars();
    if chars.next() != Some('/') {
        return Err(bad());
    }
    if matches!(chars.next(), Some('/') | Some('\\')) {
        return Err(bad());
    }
    let path_part = s.split('?').next().unwrap_or("");
    if path_part.split('/').any(|seg| seg == "..") {
        return Err(bad());
    }
    if s.contains("%2e%2e") || s.contains("%2E%2E") || s.contains("%5c") || s.contains("%5C") || s.contains("%2f") || s.contains("%2F") {
        return Err(bad());
    }
    let base = Url::parse("https://example.invalid").expect("static base");
    let resolved = base.join(s).map_err(|_| bad())?;
    if resolved.origin() != base.origin() {
        return Err(bad());
    }
    Ok(s.to_string())
}

/// Append `kv` to a path: `&` when it already has a query, else `?`.
pub fn append_query(path: &str, kv: &str) -> String {
    if path.contains('?') {
        format!("{path}&{kv}")
    } else {
        format!("{path}?{kv}")
    }
}

/// Normalise a raw `Host` header: lowercase, default port stripped.
pub fn normalize_host(raw: &str) -> String {
    let h = raw.trim().to_ascii_lowercase();
    let is_loop = host_is_loopback(&h);
    if is_loop {
        h.strip_suffix(":80").map(str::to_string).unwrap_or(h)
    } else {
        h.strip_suffix(":443").map(str::to_string).unwrap_or(h)
    }
}

fn host_is_loopback(lowered: &str) -> bool {
    let bare = if let Some(rest) = lowered.strip_prefix('[') {
        rest.split(']').next().unwrap_or(lowered)
    } else {
        lowered.split(':').next().unwrap_or(lowered)
    };
    bare == "127.0.0.1" || bare == "::1" || bare == "localhost"
}

/// The scheme a fronting proxy declares in `X-Forwarded-Proto`: the FIRST value
/// (RFC 7239 leaves the list left-to-right), lowercased, and ONLY when it is
/// exactly `http` or `https`. Anything else — a third scheme, an injected list,
/// junk — is `None` so the caller keeps its own rule.
pub fn forwarded_scheme(raw: Option<&str>) -> Option<&'static str> {
    let first = raw?.split(',').next()?.trim();
    if first.eq_ignore_ascii_case("http") {
        Some("http")
    } else if first.eq_ignore_ascii_case("https") {
        Some("https")
    } else {
        None
    }
}

/// Derive the callback base (`scheme://host`) from the raw `Host` header, fail
/// closed: the host must be a trusted owner transport (loopback / `*.ts.net` /
/// `owner_hosts`) or a NON-ephemeral company host. `?host=` overrides and
/// `X-Forwarded-Host` are never consulted.
///
/// The SCHEME is not guessed when the transport tells us: once the host has
/// passed the allowlist above, `X-Forwarded-Proto` (which both `tailscale serve`
/// and a Cloudflare tunnel set) decides it — otherwise a trusted transport that
/// terminates in plain http could never complete a sign-in, because the callback
/// URI we registered would name a scheme the browser never lands on. An
/// untrusted host is refused before this point, so a forwarded header from one
/// is never consulted at all; absent/unparseable, today's rule stands (http for
/// loopback, https elsewhere).
pub fn redirect_base(
    cfg: &crate::config::HumanAuthConfig,
    raw_host: Option<&str>,
    forwarded_proto: Option<&str>,
) -> Result<String, AppError> {
    let refuse = || AppError::BadRequest("sign-in is not available on this address".into());
    let raw = raw_host.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(refuse)?;
    if raw.chars().any(|c| c.is_whitespace() || c == '/' || c == '\\' || c == '@' || c == '?' || c == '#') {
        return Err(refuse());
    }
    let host = normalize_host(raw);
    let trusted = crate::static_assets::is_trusted_owner_transport(cfg, &host)
        || cfg.host_entry(&host).is_some_and(|e| !e.ephemeral);
    if !trusted {
        return Err(refuse());
    }
    let guess = if host_is_loopback(&host) { "http" } else { "https" };
    // `trusted` is true here by construction — the forwarded header is only ever
    // honoured for a host that already cleared the same allowlist.
    let scheme = forwarded_scheme(forwarded_proto).unwrap_or(guess);
    Ok(format!("{scheme}://{host}"))
}

/// The redirect URI for a callback base.
pub fn redirect_uri_for(base: &str) -> String {
    format!("{base}/api/oauth/callback")
}

// ── flows ───────────────────────────────────────────────────────────────────────

/// A token-endpoint success (RFC 6749 §5.1). Secrets print `<redacted>`.
#[derive(Clone)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: Option<u64>,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
    /// The OIDC id_token when the AS returned one. Kept ONLY to read its
    /// `sub`/`email` claim as the account's stable identity key — never
    /// verified, never trusted for authentication, never sealed.
    pub id_token: Option<String>,
}

impl fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenResponse")
            .field("access_token", &"<redacted>")
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "<redacted>"))
            .field("scope", &self.scope)
            .field("id_token", &self.id_token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// A token-endpoint failure, reduced to a safe shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenError {
    /// An OAuth error body (`error` clamped to `[a-z_]{1,32}`).
    Oauth { error: String, invalid_client: bool },
    /// A non-JSON / unparseable body at `status`.
    Malformed(u16),
}

impl TokenError {
    pub fn is_invalid_client(&self) -> bool {
        matches!(self, TokenError::Oauth { invalid_client: true, .. })
    }
    /// A 4xx OAuth error (the token/grant is dead) vs a transport/5xx blip.
    pub fn is_grant_dead(&self) -> bool {
        matches!(self, TokenError::Oauth { .. })
    }
}

/// Clamp an OAuth `error` code for logging: `[a-z_]{1,32}`, else `unknown`.
pub fn clamp_error_code(s: &str) -> String {
    let c: String = s
        .chars()
        .take(32)
        .filter(|c| c.is_ascii_lowercase() || *c == '_')
        .collect();
    if c.is_empty() {
        "unknown".to_string()
    } else {
        c
    }
}

/// Pure mapping of a token-endpoint `(status, body)` onto a result. Any 4xx body
/// is read as OAuth error JSON (InhouseSEO answers 401 on `invalid_grant`).
pub fn parse_token_response(status: u16, body: &[u8]) -> Result<TokenResponse, TokenError> {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return Err(TokenError::Malformed(status)),
    };
    if (200..300).contains(&status) {
        let at = v.get("access_token").and_then(Value::as_str).unwrap_or("");
        if at.is_empty() || at.len() > MAX_TOKEN_LEN {
            return Err(TokenError::Malformed(status));
        }
        let rt = v
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= MAX_TOKEN_LEN)
            .map(String::from);
        let expires_in = v
            .get("expires_in")
            .and_then(|e| e.as_u64().or_else(|| e.as_f64().map(|f| f.max(0.0) as u64)))
            .map(|e| e.min(MAX_EXPIRES_IN));
        return Ok(TokenResponse {
            access_token: at.to_string(),
            token_type: v.get("token_type").and_then(Value::as_str).unwrap_or("Bearer").to_string(),
            expires_in,
            refresh_token: rt,
            scope: v.get("scope").and_then(Value::as_str).map(String::from),
            id_token: v
                .get("id_token")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= MAX_TOKEN_LEN)
                .map(String::from),
        });
    }
    if (400..500).contains(&status) {
        let code = clamp_error_code(v.get("error").and_then(Value::as_str).unwrap_or("unknown"));
        let invalid_client = code == "invalid_client";
        return Err(TokenError::Oauth { error: code, invalid_client });
    }
    Err(TokenError::Malformed(status))
}

/// Where a flow is: started (awaiting the callback) or exchanged (awaiting the
/// authenticated `complete`).
#[derive(Clone)]
pub enum FlowStage {
    Started,
    Exchanged { tokens: TokenResponse, identity: Identity },
}

impl fmt::Debug for FlowStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FlowStage::Started => f.write_str("Started"),
            FlowStage::Exchanged { identity, .. } => {
                f.debug_struct("Exchanged").field("label", &identity.label).finish()
            }
        }
    }
}

/// One in-flight authorization-code flow. RAM only.
#[derive(Clone)]
pub struct CodeFlow {
    pub connector_id: String,
    /// Normalised grant target.
    pub session: String,
    pub company_id: Option<i64>,
    pub issuer: String,
    pub token_endpoint: String,
    pub userinfo_endpoint: Option<String>,
    pub client_id: String,
    /// RAM only.
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    pub resource: String,
    pub scope: Option<String>,
    pub require_iss: bool,
    /// RAM only.
    pub code_verifier: String,
    /// Validated path.
    pub return_to: String,
    /// The ONLY identity allowed to complete.
    pub initiator: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub stage: FlowStage,
}

impl fmt::Debug for CodeFlow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CodeFlow")
            .field("connector_id", &self.connector_id)
            .field("session", &self.session)
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("client_secret", &self.client_secret.as_ref().map(|_| "<redacted>"))
            .field("redirect_uri", &self.redirect_uri)
            .field("resource", &self.resource)
            .field("code_verifier", &"<redacted>")
            .field("return_to", &self.return_to)
            .field("initiator", &self.initiator)
            .field("expires_at", &self.expires_at)
            .field("stage", &self.stage)
            .finish()
    }
}

/// Drop every flow (either stage) whose window has closed.
pub fn sweep_expired(flows: &DashMap<String, CodeFlow>, now: i64) {
    flows.retain(|_, f| f.expires_at > now);
}

/// Keep at most `MAX_FLOWS_PER_INITIATOR - 1` flows for `initiator` so one more
/// can be inserted (oldest evicted).
pub fn cap_initiator(flows: &DashMap<String, CodeFlow>, initiator: &str) {
    let mut mine: Vec<(String, i64)> = flows
        .iter()
        .filter(|e| e.value().initiator == initiator)
        .map(|e| (e.key().clone(), e.value().created_at))
        .collect();
    if mine.len() < MAX_FLOWS_PER_INITIATOR {
        return;
    }
    mine.sort_by_key(|(_, t)| *t);
    let drop_n = mine.len() + 1 - MAX_FLOWS_PER_INITIATOR;
    for (k, _) in mine.into_iter().take(drop_n) {
        flows.remove(&k);
    }
}

/// The identity string a flow is bound to.
pub fn identity_of(ctx: Option<&AuthContext>) -> String {
    match ctx {
        None | Some(AuthContext::Owner) => "owner".to_string(),
        Some(AuthContext::Human { user_id, .. }) => format!("human:{user_id}"),
    }
}

// ── which connectors qualify ────────────────────────────────────────────────────

/// The `url` a card/connector emit launches against, when it is a hosted remote.
pub fn emit_url_of(card: &Value) -> Option<String> {
    card.get("emit")
        .and_then(|e| e.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Is this card a supermux-brokered remote OAuth connector: derived auth kind
/// `mcp_oauth` AND a `url` emit that passes the URL policy? `card` must carry
/// its `emit` (a catalog card, or [`resolve_card`]'s merged shape).
pub fn is_remote_oauth(card: &Value, policy: &UrlPolicy) -> bool {
    let kind = card.get("auth").and_then(|a| a.get("kind")).and_then(Value::as_str).unwrap_or("");
    if kind != "mcp_oauth" {
        return false;
    }
    emit_url_of(card).is_some_and(|u| policy.parse(&u).is_ok())
}

/// The card JSON for `id` WITH its emit: an installed row (shaped by
/// `api::card`, which carries no `emit`, so the row's `emit_json` is folded in)
/// else the catalog mirror (which already carries `emit`).
async fn resolve_card(state: &AppState, ctx: Option<&AuthContext>, id: &str) -> Option<Value> {
    if let Ok(Some(c)) = connectors::get(&state.pool, id).await {
        let apps = state.oauth_apps.load();
        let mut card = super::api::card(&apps, crate::scope::Scope::of(ctx), &c);
        if let Some(obj) = card.as_object_mut() {
            obj.insert(
                "emit".to_string(),
                serde_json::from_str(&c.emit_json).unwrap_or_else(|_| json!({})),
            );
        }
        return Some(card);
    }
    catalog_card(id).await
}

// ── router ──────────────────────────────────────────────────────────────────────

/// The PROTECTED routes (merged inside `oauth::router_for`).
pub fn protected_routes(state: AppState) -> Router {
    Router::new()
        .route("/api/connectors/{id}/oauth/start", post(start))
        .route("/api/connectors/{id}/oauth/complete", post(complete))
        .with_state(state)
}

/// The PUBLIC callback (merged in `http::router` outside the bearer layer).
pub fn public_router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/oauth/callback", get(callback))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct StartBody {
    #[serde(default)]
    pub session_name: String,
    #[serde(default)]
    pub return_to: String,
}

/// `POST /api/connectors/{id}/oauth/start`.
pub async fn start(
    State(state): State<AppState>,
    ctx: OptCtx,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<StartBody>,
) -> Result<Json<Value>, AppError> {
    require_admin(ctx.0.as_ref(), &format!("/api/connectors/{id}/oauth/start"))?;
    if !valid_connector_id(&id) {
        return Err(AppError::BadRequest("invalid connector id".into()));
    }
    let now = chrono::Utc::now().timestamp();
    sweep_expired(&state.oauth_code_flows, now);

    // 1. target + fence + cap.
    let session = normalize_session(&body.session_name);
    if session.is_empty() {
        return Err(AppError::BadRequest("session_name is required".into()));
    }
    authorize_connector_target(&state, ctx.0.as_ref(), &session).await?;
    let initiator = identity_of(ctx.0.as_ref());
    cap_initiator(&state.oauth_code_flows, &initiator);

    // 2. the card must be a remote OAuth connector.
    let policy = state.oauth_url_policy();
    let card = resolve_card(&state, ctx.0.as_ref(), &id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    if !is_remote_oauth(&card, &policy) {
        return Err(AppError::BadRequest("this connector does not sign in through supermux".into()));
    }
    let mcp_url = emit_url_of(&card).unwrap_or_default();

    // 3. redirect host (allowlisted, fail-closed) + return_to.
    let raw_host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    // The fronting transport's own scheme (tailscale-serve / cloudflared set it);
    // only honoured once the Host has cleared the allowlist inside redirect_base.
    let fwd_proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok());
    let base = redirect_base(&state.human_auth_cfg(), raw_host, fwd_proto)?;
    let redirect_uri = redirect_uri_for(&base);
    let return_to = validate_return_to(&body.return_to)?;

    // 4. discovery.
    let disc = discover(&mcp_url, &policy).await.map_err(|e| {
        tracing::info!(connector = %id, error = %e, "oauth start: discovery failed");
        match e {
            DiscoverError::NoAuthRequired | DiscoverError::NoRegistration => AppError::BadRequest(e.to_string()),
            other => AppError::BadRequest(format!("Couldn't reach the sign-in server: {other}")),
        }
    })?;

    // 5. client id (cached DCR).
    let client = client_for(&state, &disc.as_meta, &redirect_uri, disc.scope.as_deref(), &policy)
        .await
        .map_err(|e| match e {
            DiscoverError::NoRegistration => AppError::BadRequest(e.to_string()),
            other => AppError::BadRequest(format!("Couldn't register with the sign-in server: {other}")),
        })?;

    // 6. PKCE + state.
    let (verifier, challenge) = pkce_pair();
    let st = new_state();
    let company_id = connectors::company_of_grant_target(&state.pool, &session).await;
    state.oauth_code_flows.insert(
        st.clone(),
        CodeFlow {
            connector_id: id.clone(),
            session: session.clone(),
            company_id,
            issuer: disc.issuer.clone(),
            token_endpoint: disc.as_meta.token_endpoint.clone(),
            userinfo_endpoint: disc.as_meta.userinfo_endpoint.clone().filter(|s| !s.is_empty()),
            client_id: client.client_id.clone(),
            client_secret: client.client_secret.clone(),
            redirect_uri: redirect_uri.clone(),
            resource: disc.resource.clone(),
            scope: disc.scope.clone(),
            require_iss: disc.as_meta.authorization_response_iss_parameter_supported,
            code_verifier: verifier,
            return_to,
            initiator: initiator.clone(),
            created_at: now,
            expires_at: now + FLOW_TTL_SECS,
            stage: FlowStage::Started,
        },
    );

    // 7. authorize URL.
    let mut auth = Url::parse(&disc.as_meta.authorization_endpoint)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("authorize endpoint unparseable")))?;
    {
        let mut q = auth.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", &client.client_id);
        q.append_pair("redirect_uri", &redirect_uri);
        q.append_pair("code_challenge", &challenge);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("state", &st);
        q.append_pair("resource", &disc.resource);
        if let Some(s) = &disc.scope {
            q.append_pair("scope", s);
        }
    }
    audit(
        &state,
        "connector.oauth.start",
        &id,
        json!({ "target": session, "issuer": disc.issuer, "initiator": initiator }),
    )
    .await;
    Ok(Json(json!({
        "authorize_url": auth.to_string(),
        "state": st,
        "expires_in": FLOW_TTL_SECS,
    })))
}

/// The registered client for `(issuer, redirect_uri)`: the companion-store cache,
/// else RFC 7591 dynamic registration persisted 0600.
pub async fn client_for(
    state: &AppState,
    meta: &AsMetadata,
    redirect_uri: &str,
    scope: Option<&str>,
    policy: &UrlPolicy,
) -> Result<McpOauthClient, DiscoverError> {
    let issuer = meta.issuer.trim_end_matches('/').to_string();
    let cfg = store::read_or_default(&state.config.data_dir).map_err(|e| DiscoverError::Http(e.to_string()))?;
    if let Some(c) = store::find_mcp_oauth_client(&cfg, &issuer, redirect_uri) {
        return Ok(c.clone());
    }
    let reg = meta
        .registration_endpoint
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(DiscoverError::NoRegistration)?;
    let reg_url = policy.parse(reg)?;
    let client = policy.client().map_err(|e| DiscoverError::Http(masked_err(&e)))?;
    let mut body = json!({
        "client_name": "supermux",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if let Some(s) = scope {
        body["scope"] = json!(s);
    }
    let resp = client
        .post(reg_url)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| DiscoverError::Http(masked_err(&e)))?;
    let b = bounded(resp).await?;
    if b.status.is_redirection() {
        return Err(DiscoverError::Redirect);
    }
    let text = String::from_utf8_lossy(&b.body).to_string();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let client_id = v.get("client_id").and_then(Value::as_str).unwrap_or("").to_string();
    let client_secret = v
        .get("client_secret")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if !b.status.is_success() || client_id.is_empty() {
        let scrubbed = redact_secrets(&text.chars().take(300).collect::<String>(), &[client_secret.as_deref().unwrap_or("")]);
        tracing::info!(status = b.status.as_u16(), body = %scrubbed, "oauth: dynamic client registration refused");
        return Err(DiscoverError::Http(format!("registration refused (HTTP {})", b.status.as_u16())));
    }
    let entry = McpOauthClient {
        issuer: issuer.clone(),
        redirect_uri: redirect_uri.to_string(),
        client_id,
        client_secret,
    };
    let mut cfg = store::read_or_default(&state.config.data_dir).map_err(|e| DiscoverError::Http(e.to_string()))?;
    store::upsert_mcp_oauth_client(&mut cfg, entry.clone());
    store::write_atomic(&state.config.data_dir, &cfg).map_err(|e| DiscoverError::Http(e.to_string()))?;
    tracing::info!(issuer = %issuer, "oauth: registered a dynamic client");
    Ok(entry)
}

/// Forget the cached client for `(issuer, redirect_uri)` (a token endpoint said
/// `invalid_client`), so the next `start` re-registers.
pub fn evict_client(state: &AppState, issuer: &str, redirect_uri: &str) {
    if let Ok(mut cfg) = store::read_or_default(&state.config.data_dir) {
        if store::remove_mcp_oauth_client(&mut cfg, issuer, redirect_uri) {
            let _ = store::write_atomic(&state.config.data_dir, &cfg);
            tracing::info!(issuer = %issuer, "oauth: evicted a dynamic client after invalid_client");
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub iss: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

fn redirect_to(path: &str) -> Response {
    let loc = if path.starts_with('/') && !path.starts_with("//") { path.to_string() } else { "/store".to_string() };
    (
        StatusCode::FOUND,
        [
            (header::LOCATION, loc),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
    )
        .into_response()
}

fn error_redirect(return_to: &str, code: &str) -> Response {
    redirect_to(&append_query(return_to, &format!("connect_error={code}")))
}

/// `GET /api/oauth/callback` — PUBLIC; uniform 302 on every failure.
pub async fn callback(State(state): State<AppState>, Query(q): Query<CallbackQuery>) -> Response {
    let now = chrono::Utc::now().timestamp();
    sweep_expired(&state.oauth_code_flows, now);
    let Some(st) = q.state.as_deref().filter(|s| !s.is_empty() && s.len() <= 128) else {
        return error_redirect("/store", "state");
    };
    // Snapshot under a short lock (never held across an await).
    let snap = match state.oauth_code_flows.get(st) {
        Some(f) if matches!(f.stage, FlowStage::Started) => f.clone(),
        _ => return error_redirect("/store", "state"),
    };
    if snap.expires_at < now {
        state.oauth_code_flows.remove(st);
        return error_redirect(&snap.return_to, "expired");
    }
    if let Some(err) = q.error.as_deref() {
        state.oauth_code_flows.remove(st);
        tracing::info!(connector = %snap.connector_id, error = %clamp_error_code(err), "oauth callback: provider returned an error");
        return error_redirect(&snap.return_to, "denied");
    }
    // RFC 9207.
    match q.iss.as_deref() {
        Some(iss) if iss.trim_end_matches('/') != snap.issuer.trim_end_matches('/') => {
            state.oauth_code_flows.remove(st);
            return error_redirect(&snap.return_to, "issuer");
        }
        None if snap.require_iss => {
            state.oauth_code_flows.remove(st);
            return error_redirect(&snap.return_to, "issuer");
        }
        _ => {}
    }
    let Some(code) = q.code.as_deref().filter(|c| !c.is_empty() && c.len() <= 4096) else {
        state.oauth_code_flows.remove(st);
        return error_redirect(&snap.return_to, "exchange");
    };
    // Exchange.
    let policy = state.oauth_url_policy();
    let tokens = match exchange_code(&snap, code, &policy).await {
        Ok(t) => t,
        Err(e) => {
            state.oauth_code_flows.remove(st);
            if e.is_invalid_client() {
                evict_client(&state, &snap.issuer, &snap.redirect_uri);
            }
            tracing::info!(connector = %snap.connector_id, error = ?e, "oauth callback: token exchange failed");
            return error_redirect(&snap.return_to, "exchange");
        }
    };
    let identity = fetch_identity(&snap, &tokens, &policy).await;
    // Stash (RAM only): Started → Exchanged in place.
    let mut ok = false;
    if let Some(mut f) = state.oauth_code_flows.get_mut(st) {
        if matches!(f.stage, FlowStage::Started) {
            f.stage = FlowStage::Exchanged { tokens, identity };
            f.expires_at = now + FLOW_TTL_SECS;
            ok = true;
        }
    }
    if !ok {
        return error_redirect(&snap.return_to, "state");
    }
    redirect_to(&append_query(&snap.return_to, "oauth_pending=1"))
}

/// `POST token_endpoint` with the authorization code (+ PKCE verifier + resource
/// + the DCR secret when present).
async fn exchange_code(flow: &CodeFlow, code: &str, policy: &UrlPolicy) -> Result<TokenResponse, TokenError> {
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", flow.redirect_uri.as_str()),
        ("client_id", flow.client_id.as_str()),
        ("code_verifier", flow.code_verifier.as_str()),
        ("resource", flow.resource.as_str()),
    ];
    if let Some(s) = flow.client_secret.as_deref() {
        form.push(("client_secret", s));
    }
    token_request(&flow.token_endpoint, &form, policy, &[flow.client_secret.as_deref().unwrap_or(""), code]).await
}

/// One bounded, redirect-free POST to a token endpoint; the body is parsed by
/// [`parse_token_response`] and any error body is redacted before logging.
async fn token_request(
    token_endpoint: &str,
    form: &[(&str, &str)],
    policy: &UrlPolicy,
    secrets: &[&str],
) -> Result<TokenResponse, TokenError> {
    let url = policy.parse(token_endpoint).map_err(|_| TokenError::Malformed(0))?;
    let client = policy.client().map_err(|_| TokenError::Malformed(0))?;
    let resp = client
        .post(url)
        .header(header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| {
            tracing::info!(error = %masked_err(&e), "oauth: token request failed");
            TokenError::Malformed(0)
        })?;
    let b = bounded(resp).await.map_err(|_| TokenError::Malformed(0))?;
    if b.status.is_redirection() {
        return Err(TokenError::Malformed(b.status.as_u16()));
    }
    let r = parse_token_response(b.status.as_u16(), &b.body);
    if r.is_err() {
        let preview: String = String::from_utf8_lossy(&b.body).chars().take(200).collect();
        tracing::info!(status = b.status.as_u16(), body = %redact_secrets(&preview, secrets), "oauth: token endpoint error");
    }
    r
}

/// Who signed in: the NON-secret display `label`, plus the provider's STABLE
/// `key` when one can be read. The two are deliberately separate — the label is
/// what the owner reads ("sander@acme.com", or the bare resource host when the
/// provider exposes nothing), the key is what the ACCOUNT ROW is deduped on.
/// Keying on the label alone collapsed two identities into one account (the
/// second sign-in re-pointed the shared secret under the first one's grants).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub label: String,
    /// `sub` ▷ `id` ▷ `email` from userinfo, else the same out of the id_token.
    /// `None` when the provider gives us nothing stable to key on.
    pub key: Option<String>,
}

/// The stable subject in a userinfo / id_token claims object: `sub` ▷ `id` ▷
/// `email`. A numeric `id` (GitHub-shaped) counts. Clamped like a label.
pub fn identity_key_of(v: &Value) -> Option<String> {
    ["sub", "id", "email"].iter().find_map(|k| {
        let c = v.get(*k)?;
        let raw = match c {
            Value::String(s) => s.trim().to_string(),
            Value::Number(n) => n.to_string(),
            _ => return None,
        };
        let clamped = clamp_label(&raw);
        (!clamped.trim().is_empty()).then_some(clamped)
    })
}

/// The claims of a JWT, decoded WITHOUT verification. The id_token here rides a
/// direct, TLS-pinned, PKCE-bound response from the token endpoint we just
/// discovered, and its claims are used for exactly one thing: an opaque dedup key
/// for the account row. Nothing is authenticated on the strength of it, so no
/// signature check is implied — and a malformed token simply yields `None`.
fn jwt_claims(token: &str) -> Option<Value> {
    if token.len() > MAX_TOKEN_LEN {
        return None;
    }
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Best-effort identity: the `userinfo` document when the AS advertises one
/// (`email` ▷ `preferred_username` ▷ `name` ▷ `sub` for the label, `sub` ▷ `id`
/// ▷ `email` for the key), else the id_token's claims, else the resource host as
/// a label with NO key. Never fatal — a sign-in is never blocked on it.
pub async fn fetch_identity(flow: &CodeFlow, tokens: &TokenResponse, policy: &UrlPolicy) -> Identity {
    // The id_token's claims are the floor: they stand in when userinfo is absent
    // or unusable, and they never override a live userinfo answer.
    let from_id_token = tokens.id_token.as_deref().and_then(jwt_claims);
    let fallback = || {
        let key = from_id_token.as_ref().and_then(identity_key_of);
        let label = from_id_token
            .as_ref()
            .and_then(|v| {
                ["email", "preferred_username", "name", "sub"]
                    .iter()
                    .find_map(|k| v.get(*k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()))
                    .map(clamp_label)
            })
            .unwrap_or_else(|| {
                Url::parse(&flow.resource)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_string))
                    .unwrap_or_else(|| flow.connector_id.clone())
            });
        Identity { label, key }
    };
    let Some(ep) = flow.userinfo_endpoint.as_deref() else { return fallback() };
    let Ok(url) = policy.parse(ep) else { return fallback() };
    let Ok(client) = policy.client() else { return fallback() };
    let fut = client
        .get(url)
        .header(header::ACCEPT, "application/json")
        .bearer_auth(&tokens.access_token)
        .send();
    let Ok(Ok(resp)) = tokio::time::timeout(Duration::from_secs(5), fut).await else { return fallback() };
    let Ok(b) = bounded(resp).await else { return fallback() };
    if !b.status.is_success() {
        return fallback();
    }
    let v: Value = serde_json::from_slice(&b.body).unwrap_or(Value::Null);
    let key = identity_key_of(&v).or_else(|| from_id_token.as_ref().and_then(identity_key_of));
    let pick = ["email", "preferred_username", "name", "sub"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()));
    match pick {
        Some(s) => Identity { label: clamp_label(s), key },
        // Userinfo answered but named nobody: keep its key (if any) on the
        // id_token / resource-host label.
        None => Identity { label: fallback().label, key },
    }
}

/// ≤ 120 chars, control chars stripped.
pub fn clamp_label(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(120).collect()
}

#[derive(Debug, Deserialize)]
pub struct CompleteBody {
    pub state: String,
}

/// `POST /api/connectors/{id}/oauth/complete { state }` — seal, grant, probe.
pub async fn complete(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(id): Path<String>,
    Json(body): Json<CompleteBody>,
) -> Result<Json<Value>, AppError> {
    require_admin(ctx.0.as_ref(), &format!("/api/connectors/{id}/oauth/complete"))?;
    let now = chrono::Utc::now().timestamp();
    let not_found = || AppError::NotFound("sign-in not found".into());
    let identity = identity_of(ctx.0.as_ref());
    // Single-use: remove first, then check every binding; any miss is uniform.
    let Some((_, flow)) = state.oauth_code_flows.remove(&body.state) else { return Err(not_found()) };
    let FlowStage::Exchanged { tokens, identity: account_identity } = flow.stage.clone() else {
        return Err(not_found());
    };
    let label = account_identity.label.clone();
    if flow.connector_id != id || flow.expires_at < now || flow.initiator != identity {
        return Err(not_found());
    }
    authorize_connector_target(&state, ctx.0.as_ref(), &flow.session).await.map_err(|_| not_found())?;

    let (account_ref, secret_ref) = seal_and_grant(&state, &flow, &tokens, &account_identity).await?;

    // Probe with the bearer once — the only source of a green.
    let connector = connectors::get(&state.pool, &id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::NotFound(format!("connector '{id}'")))?;
    let mut secrets = BTreeMap::new();
    secrets.insert(ACCESS_TOKEN_FIELD.to_string(), tokens.access_token.clone());
    let outcome = super::health::run_probe(&connector, &secrets).await;
    let (health, error) = if outcome.testable {
        (outcome.health, outcome.last_error.clone())
    } else {
        (None, None)
    };
    if outcome.testable {
        let stored = if health == Some("expired") {
            Some("Server refused the new sign-in")
        } else {
            error.as_deref()
        };
        connectors::account_set_health(&state.pool, &account_ref, health, stored, now)
            .await
            .map_err(db_err)?;
        // The count this probe really enumerated, kept on the account (0043) so
        // "Connected as … — N tools" is server truth on the next read instead of
        // dying with this response's React state.
        super::api::store_tool_count(&state, &account_ref, &outcome).await;
    }
    audit(
        &state,
        "connector.oauth.connected",
        &id,
        json!({
            "account_ref": account_ref,
            "target": flow.session,
            "company_id": flow.company_id,
            "initiator": identity,
            "health": health,
            "tool_count": outcome.tool_count,
        }),
    )
    .await;
    let _ = secret_ref;
    Ok(Json(json!({
        "ok": true,
        "account_ref": account_ref,
        "label": label,
        "health": {
            "status": health,
            "error": if health == Some("expired") { Some("Server refused the new sign-in".to_string()) } else { error },
            // The probe's line + the count its real `tools/list` returned (null
            // when the probe never got that far — never invented).
            "message": outcome.message,
            "tool_count": outcome.tool_count,
        },
        "target": flow.session,
    })))
}

/// The sealed field map for a token response.
fn seal_fields(flow: &CodeFlow, tokens: &TokenResponse, now: i64) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    fields.insert(ACCESS_TOKEN_FIELD.to_string(), tokens.access_token.clone());
    if let Some(rt) = &tokens.refresh_token {
        fields.insert(REFRESH_TOKEN_FIELD.to_string(), rt.clone());
    }
    let exp = tokens.expires_in.map(|e| now + e as i64).unwrap_or(0);
    fields.insert(EXPIRES_AT_FIELD.to_string(), exp.to_string());
    fields.insert(
        META_FIELD.to_string(),
        json!({
            "issuer": flow.issuer,
            "token_endpoint": flow.token_endpoint,
            "client_id": flow.client_id,
            "resource": flow.resource,
            "scope": tokens.scope.clone().or_else(|| flow.scope.clone()),
            "redirect_uri": flow.redirect_uri,
        })
        .to_string(),
    );
    fields
}

/// Seal the tokens into the vault (one row per account, re-sealed in place on a
/// re-sign-in) + account + grant. Returns `(account_ref, secret_ref)`.
///
/// The account is keyed on the STABLE identity (`identity.key`), not on the
/// display label: the label falls back to the resource host, so two distinct
/// people on the same connector used to collapse into one row — and the second
/// sign-in's `account_replace` re-pointed the shared `secret_ref` while the
/// first one's grants still referenced it, silently swapping their token. Same
/// identity ⇒ rotate in place (every grant stays wired); a DIFFERENT identity ⇒
/// a NEW row, existing grants untouched. With no key at all (a provider that
/// exposes neither userinfo nor an id_token) the label stays the key, which is
/// exactly today's behaviour.
async fn seal_and_grant(
    state: &AppState,
    flow: &CodeFlow,
    tokens: &TokenResponse,
    identity: &Identity,
) -> Result<(String, String), AppError> {
    ensure_connector_installed(state, &flow.connector_id).await?;
    let now = chrono::Utc::now().timestamp();
    let label = identity.label.as_str();
    let fields = seal_fields(flow, tokens, now);
    let vault = Vault::open(&state.config.data_dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("vault unavailable: {e}")))?;
    let account_company = connectors::company_of_grant_target(&state.pool, &flow.session).await;
    let existing = match identity.key.as_deref() {
        // Keyed: the row carrying this identity, else an UN-KEYED row with the
        // same label (a pre-0042 / paste-minted account this identity adopts —
        // the key is stamped below). A row already carrying a DIFFERENT key is
        // never matched, so a second identity gets its own row.
        Some(key) => {
            match connectors::account_find_by_identity(&state.pool, &flow.connector_id, key, account_company)
                .await
                .map_err(db_err)?
            {
                Some(a) => Some(a),
                None => connectors::account_find_unkeyed_by_label(
                    &state.pool,
                    &flow.connector_id,
                    label,
                    account_company,
                )
                .await
                .map_err(db_err)?,
            }
        }
        // No stable identity to key on — today's label dedup, unchanged.
        None => connectors::account_find_by_label(&state.pool, &flow.connector_id, label, account_company)
            .await
            .map_err(db_err)?,
    };
    let (account_ref, secret_ref) = match existing {
        Some(a) => {
            let secret_ref = a.secret_ref.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let lock = state.lock_for(&format!("{LOCK_PREFIX}{secret_ref}"));
            let _g = lock.lock().await;
            let sealed = vault
                .seal(&fields)
                .map_err(|e| AppError::Internal(anyhow::anyhow!("sealing token: {e}")))?;
            connectors::vault_put(&state.pool, &secret_ref, &flow.connector_id, &sealed.fields_enc, &sealed.nonce, true)
                .await
                .map_err(db_err)?;
            connectors::account_replace(&state.pool, &a.id, label, Some(&secret_ref))
                .await
                .map_err(db_err)?;
            (a.id, secret_ref)
        }
        None => {
            let secret_ref = uuid::Uuid::new_v4().to_string();
            let sealed = vault
                .seal(&fields)
                .map_err(|e| AppError::Internal(anyhow::anyhow!("sealing token: {e}")))?;
            connectors::vault_put(&state.pool, &secret_ref, &flow.connector_id, &sealed.fields_enc, &sealed.nonce, false)
                .await
                .map_err(db_err)?;
            let id = connectors::account_add(&state.pool, &flow.connector_id, label, Some(&secret_ref), account_company)
                .await
                .map_err(db_err)?;
            (id, secret_ref)
        }
    };
    // Stamp the identity on the row (mint OR adopt) so the NEXT sign-in — this
    // identity's or another's — keys on it instead of the display label.
    if let Some(key) = identity.key.as_deref() {
        connectors::account_set_identity(&state.pool, &account_ref, key)
            .await
            .map_err(db_err)?;
    }
    connectors::grant_with_account(&state.pool, &flow.session, &flow.connector_id, Some(&secret_ref), true, Some(&account_ref))
        .await
        .map_err(db_err)?;
    Ok((account_ref, secret_ref))
}

// ── refresh ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreshOutcome {
    Fresh,
    Refreshed,
    NoRefreshToken,
    /// Masked reason.
    RefreshFailed(String),
}

/// The non-secret meta sealed beside the tokens.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SealedMeta {
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub token_endpoint: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub resource: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub redirect_uri: String,
}

pub fn parse_meta(fields: &BTreeMap<String, String>) -> Option<SealedMeta> {
    serde_json::from_str(fields.get(META_FIELD)?).ok()
}

/// Is the sealed token still fresh (unknown expiry counts as fresh)?
pub fn is_fresh(fields: &BTreeMap<String, String>, now: i64) -> bool {
    let exp: i64 = fields.get(EXPIRES_AT_FIELD).and_then(|s| s.parse().ok()).unwrap_or(0);
    exp == 0 || exp - now > REFRESH_SKEW_SECS
}

/// Refresh the sealed access token when it is about to expire, re-sealing the
/// vault row IN PLACE under the per-secret lock. Never panics; the returned map
/// is always usable (the stale one on failure).
pub async fn ensure_fresh(
    state: &AppState,
    vault: &Vault,
    secret_ref: &str,
    fields: BTreeMap<String, String>,
) -> (BTreeMap<String, String>, FreshOutcome) {
    let now = chrono::Utc::now().timestamp();
    if is_fresh(&fields, now) {
        return (fields, FreshOutcome::Fresh);
    }
    let lock = state.lock_for(&format!("{LOCK_PREFIX}{secret_ref}"));
    let _g = lock.lock().await;
    // Re-read under the lock: another launch may have refreshed meanwhile.
    let fields = match connectors::vault_get(&state.pool, secret_ref).await {
        Ok(Some(row)) => vault.open_fields(&row.fields_enc, &row.nonce).unwrap_or(fields),
        _ => fields,
    };
    let now = chrono::Utc::now().timestamp();
    if is_fresh(&fields, now) {
        return (fields, FreshOutcome::Fresh);
    }
    let Some(rt) = fields.get(REFRESH_TOKEN_FIELD).cloned().filter(|s| !s.is_empty()) else {
        return (fields, FreshOutcome::NoRefreshToken);
    };
    let Some(meta) = parse_meta(&fields) else {
        return (fields, FreshOutcome::RefreshFailed("sealed meta unreadable".into()));
    };
    let policy = state.oauth_url_policy();
    let client_secret = store::read_or_default(&state.config.data_dir)
        .ok()
        .and_then(|cfg| store::find_mcp_oauth_client(&cfg, &meta.issuer, &meta.redirect_uri).cloned())
        .and_then(|c| c.client_secret);
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", rt.as_str()),
        ("client_id", meta.client_id.as_str()),
        ("resource", meta.resource.as_str()),
    ];
    if let Some(s) = meta.scope.as_deref().filter(|s| !s.is_empty()) {
        form.push(("scope", s));
    }
    if let Some(cs) = client_secret.as_deref() {
        form.push(("client_secret", cs));
    }
    let account = connectors::account_by_secret_ref(&state.pool, secret_ref).await.ok().flatten();
    match token_request(&meta.token_endpoint, &form, &policy, &[rt.as_str(), client_secret.as_deref().unwrap_or("")]).await {
        Ok(tokens) => {
            let mut next = fields.clone();
            next.insert(ACCESS_TOKEN_FIELD.to_string(), tokens.access_token.clone());
            if let Some(nrt) = &tokens.refresh_token {
                next.insert(REFRESH_TOKEN_FIELD.to_string(), nrt.clone());
            }
            let exp = tokens.expires_in.map(|e| now + e as i64).unwrap_or(0);
            next.insert(EXPIRES_AT_FIELD.to_string(), exp.to_string());
            match vault.seal(&next) {
                Ok(sealed) => {
                    if let Err(e) = connectors::vault_put(
                        &state.pool,
                        secret_ref,
                        &account.as_ref().map(|a| a.connector_id.clone()).unwrap_or_default(),
                        &sealed.fields_enc,
                        &sealed.nonce,
                        true,
                    )
                    .await
                    {
                        tracing::warn!(error = %e, "oauth refresh: could not re-seal the vault row");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "oauth refresh: seal failed"),
            }
            if let Some(a) = &account {
                if a.status != "active" {
                    let _ = connectors::account_set_status(&state.pool, &a.id, "active").await;
                }
            }
            (next, FreshOutcome::Refreshed)
        }
        Err(e) => {
            let host = Url::parse(&meta.token_endpoint)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| "the sign-in server".into());
            if e.is_invalid_client() {
                evict_client(state, &meta.issuer, &meta.redirect_uri);
            }
            if e.is_grant_dead() {
                if let Some(a) = &account {
                    let _ = connectors::account_set_status(&state.pool, &a.id, "disconnected").await;
                    let _ = connectors::account_set_health(
                        &state.pool,
                        &a.id,
                        Some("expired"),
                        Some("Sign-in expired — reconnect"),
                        now,
                    )
                    .await;
                }
                (fields, FreshOutcome::RefreshFailed("Sign-in expired — reconnect".into()))
            } else {
                if let Some(a) = &account {
                    let _ = connectors::account_set_health(
                        &state.pool,
                        &a.id,
                        Some("error"),
                        Some(&format!("Couldn't reach {host} to refresh the sign-in")),
                        now,
                    )
                    .await;
                }
                (fields, FreshOutcome::RefreshFailed(format!("Couldn't reach {host} to refresh the sign-in")))
            }
        }
    }
}

// ── launch injection ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OauthLaunch {
    NotOauth,
    Injected,
    /// The entry is still emitted (stale token); the account row carries why.
    NeedsSignIn,
}

/// `SUPERMUX_MCP_TOKEN_` + the id uppercased, every char outside `[A-Z0-9]` → `_`,
/// a leading digit prefixed with `_`. A collision with a name already `taken`
/// appends `_<sha256(id)[..6]>` (deterministic).
pub fn env_var_for(connector_id: &str, taken: &HashSet<String>) -> String {
    let mut body: String = connector_id
        .chars()
        .map(|c| {
            let u = c.to_ascii_uppercase();
            if u.is_ascii_uppercase() || u.is_ascii_digit() { u } else { '_' }
        })
        .collect();
    if body.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        body.insert(0, '_');
    }
    let name = format!("{ENV_PREFIX}{body}");
    if !taken.contains(&name) {
        return name;
    }
    let hash = Sha256::digest(connector_id.as_bytes());
    let hex: String = hash.iter().take(3).map(|b| format!("{b:02x}")).collect();
    format!("{name}_{hex}")
}

/// Rewrite a granted remote-OAuth connector's launch: refresh-at-launch, stamp
/// `last_used_at`, replace the secrets with exactly `{ env_var: access_token }`,
/// and point `headers.Authorization` at `${env_var}`. Non-OAuth grants pass
/// through untouched.
pub async fn apply_to_launch(
    state: &AppState,
    vault: Option<&Vault>,
    grant: &connectors::Grant,
    mut emit: Value,
    secrets: BTreeMap<String, String>,
    taken: &mut HashSet<String>,
) -> (Value, BTreeMap<String, String>, OauthLaunch) {
    let has_url = emit.get("url").and_then(Value::as_str).is_some_and(|u| !u.trim().is_empty());
    if !has_url || !secrets.contains_key(ACCESS_TOKEN_FIELD) {
        return (emit, secrets, OauthLaunch::NotOauth);
    }
    let (fields, outcome) = match (vault, grant.secret_ref.as_deref()) {
        (Some(v), Some(sr)) => ensure_fresh(state, v, sr, secrets).await,
        _ => (secrets, FreshOutcome::NoRefreshToken),
    };
    if let Some(aref) = grant.account_ref.as_deref() {
        let now = chrono::Utc::now().timestamp();
        let _ = connectors::account_mark_used(&state.pool, aref, now).await;
    }
    let env_var = env_var_for(&grant.connector_id, taken);
    taken.insert(env_var.clone());
    let token = fields.get(ACCESS_TOKEN_FIELD).cloned().unwrap_or_default();
    let mut only = BTreeMap::new();
    only.insert(env_var.clone(), token);
    if let Some(obj) = emit.as_object_mut() {
        let headers = obj
            .entry("headers".to_string())
            .or_insert_with(|| json!({}));
        if let Some(h) = headers.as_object_mut() {
            h.insert("Authorization".to_string(), Value::String(format!("Bearer ${{{env_var}}}")));
        }
        if obj.get("type").is_none() {
            obj.insert("type".to_string(), Value::String("http".to_string()));
        }
    }
    let now = chrono::Utc::now().timestamp();
    let launch = match outcome {
        FreshOutcome::Fresh | FreshOutcome::Refreshed => OauthLaunch::Injected,
        FreshOutcome::NoRefreshToken if is_fresh(&fields, now) => OauthLaunch::Injected,
        _ => OauthLaunch::NeedsSignIn,
    };
    (emit, only, launch)
}

// ── tests ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn prod() -> UrlPolicy {
        UrlPolicy::default()
    }

    #[test]
    fn pkce_pair_shape_and_rfc7636_vector() {
        let (v, c) = pkce_pair();
        assert!(v.len() >= 43 && v.len() <= 128, "{}", v.len());
        assert!(v.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
        assert_eq!(c, pkce_challenge(&v));
        // RFC 7636 appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn www_authenticate_parses_bearer_only() {
        let a = parse_www_authenticate(
            r#"Bearer resource_metadata="https://x/.well-known/oauth-protected-resource", scope="a b""#,
        )
        .unwrap();
        assert_eq!(a.resource_metadata.as_deref(), Some("https://x/.well-known/oauth-protected-resource"));
        assert_eq!(a.scope.as_deref(), Some("a b"));
        let b = parse_www_authenticate(r#"Bearer realm="mcp", resource_metadata="https://x/prm""#).unwrap();
        assert_eq!(b.resource_metadata.as_deref(), Some("https://x/prm"));
        assert_eq!(b.scope, None);
        assert_eq!(parse_www_authenticate("Bearer").unwrap(), WwwAuth::default());
        assert!(parse_www_authenticate(r#"Basic realm="x""#).is_none());
        assert!(parse_www_authenticate("").is_none());
    }

    #[test]
    fn url_policy_negatives_and_positive() {
        let p = prod();
        for bad in [
            "http://app.inhouseseo.ai/mcp",
            "javascript:alert(1)",
            "data:text/plain,hi",
            "https://127.0.0.1/mcp",
            "https://[::1]/mcp",
            "https://10.0.0.1/mcp",
            "https://169.254.169.254/latest",
            "https://100.100.100.100/mcp",
            "https://localhost/mcp",
            "https://user:pw@host.example/mcp",
            "https://host.example/mcp#frag",
            "/relative/path",
        ] {
            assert!(p.parse(bad).is_err(), "{bad} must be refused");
        }
        assert!(p.parse("https://app.inhouseseo.ai/mcp").is_ok());
        // The test-only relaxation admits loopback http and nothing else private.
        let t = UrlPolicy { allow_loopback_http: true };
        assert!(t.parse("http://127.0.0.1:1234/mcp").is_ok());
        assert!(t.parse("http://localhost:1234/mcp").is_ok());
        assert!(t.parse("http://10.0.0.1/mcp").is_err());
        assert!(t.parse("https://169.254.169.254/x").is_err());
    }

    #[test]
    fn private_ip_ranges() {
        for ip in ["127.0.0.1", "10.1.1.1", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.100.100.100", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:10.0.0.1"] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "104.16.1.1", "100.128.0.1", "2606:4700::1"] {
            assert!(!is_private_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn dns_filter_refuses_a_private_answer() {
        use reqwest::dns::Resolve;
        // `localhost` resolves to loopback on every box.
        let name: reqwest::dns::Name = "localhost".parse().unwrap();
        let r = PublicOnlyResolver.resolve(name).await;
        assert!(r.is_err(), "loopback answer must be refused");
    }

    #[test]
    fn resource_normalisation_and_match() {
        let u = Url::parse("HTTPS://App.Example.com:443/api/mcp/#frag").unwrap();
        assert_eq!(normalize_resource(&u), "https://app.example.com/api/mcp");
        let mcp = Url::parse("https://app.example.com/api/mcp").unwrap();
        assert!(resource_matches("https://app.example.com/api/mcp", &mcp));
        assert!(resource_matches("https://app.example.com/api/mcp/", &mcp));
        assert!(resource_matches("https://app.example.com/api", &mcp), "path prefix ok");
        assert!(resource_matches("https://app.example.com", &mcp), "origin prefix ok");
        assert!(!resource_matches("https://other.example.com/api/mcp", &mcp));
        assert!(!resource_matches("https://app.example.com/other", &mcp));
        assert!(!resource_matches("not a url", &mcp));
    }

    #[test]
    fn as_metadata_validation() {
        let p = prod();
        let ok = AsMetadata {
            issuer: "https://as.example".into(),
            authorization_endpoint: "https://as.example/authorize".into(),
            token_endpoint: "https://as.example/token".into(),
            code_challenge_methods_supported: Some(vec!["S256".into()]),
            ..Default::default()
        };
        assert!(validate_as_metadata(&ok, "https://as.example", &p).is_ok());
        assert_eq!(
            validate_as_metadata(&ok, "https://other.example", &p),
            Err(DiscoverError::IssuerMismatch)
        );
        let mut plain = ok.clone();
        plain.code_challenge_methods_supported = Some(vec!["plain".into()]);
        assert_eq!(validate_as_metadata(&plain, "https://as.example", &p), Err(DiscoverError::NoS256));
        let mut js = ok.clone();
        js.authorization_endpoint = "javascript:alert(1)".into();
        assert_eq!(
            validate_as_metadata(&js, "https://as.example", &p),
            Err(DiscoverError::BadEndpoint("authorization"))
        );
        let mut http = ok.clone();
        http.token_endpoint = "http://as.example/token".into();
        assert_eq!(validate_as_metadata(&http, "https://as.example", &p), Err(DiscoverError::BadEndpoint("token")));
        let mut reg = ok.clone();
        reg.registration_endpoint = Some("http://as.example/register".into());
        assert_eq!(
            validate_as_metadata(&reg, "https://as.example", &p),
            Err(DiscoverError::BadEndpoint("registration"))
        );
        // Absent `code_challenge_methods_supported` is tolerated (S256 assumed).
        let mut none = ok.clone();
        none.code_challenge_methods_supported = None;
        assert!(validate_as_metadata(&none, "https://as.example", &p).is_ok());
    }

    #[test]
    fn well_known_path_insertion() {
        let plain = Url::parse("https://as.example").unwrap();
        assert_eq!(
            well_known_urls(&plain),
            vec![
                "https://as.example/.well-known/oauth-authorization-server",
                "https://as.example/.well-known/openid-configuration",
            ]
        );
        let pathy = Url::parse("https://as.example/issuer1").unwrap();
        assert_eq!(well_known_urls(&pathy)[0], "https://as.example/.well-known/oauth-authorization-server/issuer1");
        assert_eq!(well_known_urls(&pathy)[1], "https://as.example/issuer1/.well-known/openid-configuration");
    }

    #[test]
    fn token_response_parsing() {
        let ok = parse_token_response(200, br#"{"access_token":"at","token_type":"Bearer","expires_in":3600,"refresh_token":"rt"}"#).unwrap();
        assert_eq!(ok.access_token, "at");
        assert_eq!(ok.refresh_token.as_deref(), Some("rt"));
        assert_eq!(ok.expires_in, Some(3600));
        match parse_token_response(400, br#"{"error":"invalid_grant"}"#) {
            Err(TokenError::Oauth { error, invalid_client }) => {
                assert_eq!(error, "invalid_grant");
                assert!(!invalid_client);
            }
            other => panic!("{other:?}"),
        }
        // InhouseSEO: a 401 body is still an OAuth error.
        assert!(matches!(
            parse_token_response(401, br#"{"error":"invalid_grant","error_description":"x"}"#),
            Err(TokenError::Oauth { .. })
        ));
        assert_eq!(parse_token_response(500, b"<html>").unwrap_err(), TokenError::Malformed(500));
        let capped = parse_token_response(200, format!(r#"{{"access_token":"a","expires_in":{}}}"#, u64::MAX).as_bytes()).unwrap();
        assert_eq!(capped.expires_in, Some(MAX_EXPIRES_IN));
        let ic = parse_token_response(401, br#"{"error":"invalid_client"}"#).unwrap_err();
        assert!(ic.is_invalid_client());
        let clamped = clamp_error_code("Weird Code!!! with stuff that goes on and on and on");
        assert!(clamped.len() <= 32 && clamped.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{clamped}");
        assert_eq!(clamp_error_code("!!!"), "unknown");
    }

    #[test]
    fn env_var_mapping() {
        let mut taken = HashSet::new();
        assert_eq!(env_var_for("pmcp-inhouseseo", &taken), "SUPERMUX_MCP_TOKEN_PMCP_INHOUSESEO");
        assert_eq!(env_var_for("a.b", &taken), "SUPERMUX_MCP_TOKEN_A_B");
        assert_eq!(env_var_for("1x", &taken), "SUPERMUX_MCP_TOKEN__1X");
        let first = env_var_for("a-b", &taken);
        taken.insert(first.clone());
        let second = env_var_for("a_b", &taken);
        assert_ne!(first, second);
        assert!(second.starts_with("SUPERMUX_MCP_TOKEN_A_B_"));
        assert_eq!(second, env_var_for("a_b", &taken), "deterministic");
    }

    #[test]
    fn return_to_validation() {
        for bad in ["//evil", "/\\evil.com", "/%5Cevil", "https://evil", "/a\rLocation:", "/../x", "/a/../x"] {
            assert!(validate_return_to(bad).is_err(), "{bad:?}");
        }
        assert!(validate_return_to(&format!("/{}", "a".repeat(600))).is_err());
        assert_eq!(validate_return_to("/store/x?y=1").unwrap(), "/store/x?y=1");
        assert_eq!(validate_return_to("/s/bot/tools").unwrap(), "/s/bot/tools");
        assert_eq!(validate_return_to("").unwrap(), "/store");
        assert_eq!(append_query("/store/x?y=1", "connect_error=denied"), "/store/x?y=1&connect_error=denied");
        assert_eq!(append_query("/store", "oauth_pending=1"), "/store?oauth_pending=1");
    }

    fn cfg_with(hosts: Vec<crate::config::CompanyHost>) -> crate::config::HumanAuthConfig {
        crate::config::HumanAuthConfig {
            company_hosts: hosts,
            ..Default::default()
        }
    }

    #[test]
    fn redirect_host_allowlist() {
        let cfg = cfg_with(vec![
            crate::config::CompanyHost {
                host: "acme.example.com".into(),
                company_id: 1,
                redirect_uri: "https://acme.example.com/auth/callback".into(),
                ephemeral: false,
            },
            crate::config::CompanyHost {
                host: "calm-frog-1234.trycloudflare.com".into(),
                company_id: 1,
                redirect_uri: "https://calm-frog-1234.trycloudflare.com/auth/callback".into(),
                ephemeral: true,
            },
        ]);
        assert_eq!(redirect_base(&cfg, Some("box.taild681cb.ts.net"), None).unwrap(), "https://box.taild681cb.ts.net");
        assert_eq!(redirect_base(&cfg, Some("127.0.0.1:8824"), None).unwrap(), "http://127.0.0.1:8824");
        assert_eq!(redirect_base(&cfg, Some("acme.example.com"), None).unwrap(), "https://acme.example.com");
        assert!(redirect_base(&cfg, Some("calm-frog-1234.trycloudflare.com"), None).is_err(), "ephemeral refused");
        assert!(redirect_base(&cfg, Some("unknown.example.net"), None).is_err());
        assert!(redirect_base(&cfg, None, None).is_err());
        assert!(redirect_base(&cfg, Some(""), None).is_err());
        assert!(redirect_base(&cfg, Some("box.taild681cb.ts.net/evil"), None).is_err());
        assert_eq!(
            redirect_uri_for(&redirect_base(&cfg, Some("Box.Taild681cb.ts.net:443"), None).unwrap()),
            redirect_uri_for(&redirect_base(&cfg, Some("box.taild681cb.ts.net"), None).unwrap())
        );
    }

    #[test]
    fn forwarded_proto_decides_the_callback_scheme_on_a_trusted_transport() {
        let cfg = cfg_with(vec![crate::config::CompanyHost {
            host: "acme.example.com".into(),
            company_id: 1,
            redirect_uri: "https://acme.example.com/auth/callback".into(),
            ephemeral: false,
        }]);
        // A plain-http trusted transport can now complete a sign-in…
        assert_eq!(
            redirect_base(&cfg, Some("acme.example.com"), Some("http")).unwrap(),
            "http://acme.example.com"
        );
        assert_eq!(
            redirect_base(&cfg, Some("box.taild681cb.ts.net"), Some("http")).unwrap(),
            "http://box.taild681cb.ts.net"
        );
        // …and a TLS-terminating proxy in front of the loopback listener says https.
        assert_eq!(
            redirect_base(&cfg, Some("127.0.0.1:8824"), Some("https")).unwrap(),
            "https://127.0.0.1:8824"
        );
        // The first list value wins; case is irrelevant.
        assert_eq!(
            redirect_base(&cfg, Some("acme.example.com"), Some("HTTP, https")).unwrap(),
            "http://acme.example.com"
        );
        // Junk / a third scheme is ignored — today's guess stands.
        for junk in ["ftp", "", "  ", "https evil", "javascript"] {
            assert_eq!(
                redirect_base(&cfg, Some("acme.example.com"), Some(junk)).unwrap(),
                "https://acme.example.com",
                "junk proto {junk:?} must not steer the scheme"
            );
        }
        // An UNTRUSTED host is refused outright, so its forwarded header never lands.
        assert!(redirect_base(&cfg, Some("unknown.example.net"), Some("http")).is_err());
        assert!(redirect_base(&cfg, Some("calm-frog-1234.trycloudflare.com"), Some("http")).is_err());
        assert_eq!(forwarded_scheme(None), None);
        assert_eq!(forwarded_scheme(Some(" https ")), Some("https"));
    }

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-oauth-code-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            swarm_reaper: Default::default(),
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
        connectors::upsert(&pool, "pmcp-x", "mcp_remote", "X", "", "", "[]", "[]", "{}", "{}")
            .await
            .unwrap();
        (AppState::new(pool, config), dir)
    }

    async fn cleanup(state: AppState, dir: std::path::PathBuf) {
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tokens_with(access: &str) -> TokenResponse {
        TokenResponse {
            access_token: access.into(),
            token_type: "Bearer".into(),
            expires_in: Some(3600),
            refresh_token: None,
            scope: None,
            id_token: None,
        }
    }

    /// The access token sealed behind an account's `secret_ref`.
    async fn sealed_access(state: &AppState, secret_ref: &str) -> String {
        let vault = Vault::open(&state.config.data_dir).unwrap();
        let row = connectors::vault_get(&state.pool, secret_ref).await.unwrap().expect("vault row");
        let fields = vault.open_fields(&row.fields_enc, &row.nonce).unwrap();
        fields.get(ACCESS_TOKEN_FIELD).cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn two_identities_on_one_connector_never_collapse_into_one_account() {
        let (state, dir) = test_state().await;
        // Both sign-ins carry the SAME display label — the resource-host fallback
        // shape that used to collapse them — but DIFFERENT stable subjects.
        let label = "app.example".to_string();
        let a = Identity { label: label.clone(), key: Some("sub-A".into()) };
        let b = Identity { label: label.clone(), key: Some("sub-B".into()) };

        let mut fa = flow("owner", 0, 10_000_000_000, FlowStage::Started);
        fa.session = "botA".into();
        let mut fb = flow("owner", 0, 10_000_000_000, FlowStage::Started);
        fb.session = "botB".into();

        let (acct_a, sref_a) = seal_and_grant(&state, &fa, &tokens_with("at-A1"), &a).await.unwrap();
        // A RE-sign-in of the SAME identity rotates the one row in place.
        let (acct_a2, sref_a2) = seal_and_grant(&state, &fa, &tokens_with("at-A2"), &a).await.unwrap();
        assert_eq!(acct_a, acct_a2, "same identity must reuse its account row");
        assert_eq!(sref_a, sref_a2, "the secret is rotated IN PLACE (grants stay wired)");
        assert_eq!(sealed_access(&state, &sref_a).await, "at-A2", "token rotated");

        // A DIFFERENT identity mints its OWN row + its own sealed secret.
        let (acct_b, sref_b) = seal_and_grant(&state, &fb, &tokens_with("at-B1"), &b).await.unwrap();
        assert_ne!(acct_b, acct_a, "a second identity must not reuse the first one's row");
        assert_ne!(sref_b, sref_a, "…nor its vault row");
        let accounts = connectors::accounts_for_connector(&state.pool, "pmcp-x").await.unwrap();
        assert_eq!(accounts.len(), 2, "two identities → two account rows");

        // The first identity's grant is untouched: still its account, still its token.
        let grants = connectors::grants_for_connector(&state.pool, "pmcp-x").await.unwrap();
        let ga = grants.iter().find(|g| g.session_name == "botA").expect("botA grant");
        assert_eq!(ga.account_ref.as_deref(), Some(acct_a.as_str()));
        assert_eq!(sealed_access(&state, &sref_a).await, "at-A2", "no cross-identity token swap");
        assert_eq!(sealed_access(&state, &sref_b).await, "at-B1");
        cleanup(state, dir).await;
    }

    #[tokio::test]
    async fn an_unkeyed_account_is_adopted_once_and_a_keyless_provider_keys_on_the_label() {
        let (state, dir) = test_state().await;
        let f = flow("owner", 0, 10_000_000_000, FlowStage::Started);
        // A pre-0042 / paste-minted row: same label, NO identity_key.
        let legacy = connectors::account_add(&state.pool, "pmcp-x", "app.example", Some("legacy-sref"), None)
            .await
            .unwrap();
        let a = Identity { label: "app.example".into(), key: Some("sub-A".into()) };
        let (acct, _) = seal_and_grant(&state, &f, &tokens_with("at-1"), &a).await.unwrap();
        assert_eq!(acct, legacy, "an un-keyed same-label row is ADOPTED, not duplicated");
        let row = connectors::account_get(&state.pool, &acct).await.unwrap().unwrap();
        assert_eq!(row.identity_key.as_deref(), Some("sub-A"), "the key is stamped on adoption");
        // …and only ONCE: a second identity no longer sees an un-keyed row.
        let b = Identity { label: "app.example".into(), key: Some("sub-B".into()) };
        let (acct_b, _) = seal_and_grant(&state, &f, &tokens_with("at-2"), &b).await.unwrap();
        assert_ne!(acct_b, legacy);

        // A provider that exposes NO stable identity keeps today's label dedup.
        let keyless = Identity { label: "keyless.example".into(), key: None };
        let (k1, s1) = seal_and_grant(&state, &f, &tokens_with("at-3"), &keyless).await.unwrap();
        let (k2, s2) = seal_and_grant(&state, &f, &tokens_with("at-4"), &keyless).await.unwrap();
        assert_eq!((k1, s1.clone()), (k2, s2), "no key → same-label reuse, unchanged");
        assert_eq!(sealed_access(&state, &s1).await, "at-4");
        cleanup(state, dir).await;
    }

    #[test]
    fn identity_key_prefers_a_stable_subject_over_a_display_name() {
        assert_eq!(identity_key_of(&json!({"sub": "u-1", "email": "a@b.c"})).as_deref(), Some("u-1"));
        assert_eq!(identity_key_of(&json!({"id": 4711, "name": "Sander"})).as_deref(), Some("4711"));
        assert_eq!(identity_key_of(&json!({"email": " a@b.c "})).as_deref(), Some("a@b.c"));
        // A display name alone is NOT an identity — two people can share one.
        assert_eq!(identity_key_of(&json!({"name": "Sander", "preferred_username": "s"})), None);
        assert_eq!(identity_key_of(&json!({"sub": "   "})), None);
        assert_eq!(identity_key_of(&Value::Null), None);
        // The id_token's claims are read WITHOUT verification (dedup key only).
        let jwt = format!(
            "h.{}.sig",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"jwt-sub","email":"a@b.c"}"#)
        );
        assert_eq!(jwt_claims(&jwt).as_ref().and_then(identity_key_of).as_deref(), Some("jwt-sub"));
        assert!(jwt_claims("not-a-jwt").is_none());
        assert!(jwt_claims("h.!!!not-base64!!!.s").is_none());
    }

    fn flow(initiator: &str, created_at: i64, expires_at: i64, stage: FlowStage) -> CodeFlow {
        CodeFlow {
            connector_id: "pmcp-x".into(),
            session: "bot".into(),
            company_id: None,
            issuer: "https://as.example".into(),
            token_endpoint: "https://as.example/token".into(),
            userinfo_endpoint: None,
            client_id: "cid".into(),
            client_secret: Some("shh-secret".into()),
            redirect_uri: "https://box/api/oauth/callback".into(),
            resource: "https://app.example/mcp".into(),
            scope: None,
            require_iss: true,
            code_verifier: "verifier-secret".into(),
            return_to: "/store".into(),
            initiator: initiator.into(),
            created_at,
            expires_at,
            stage,
        }
    }

    #[test]
    fn sweep_both_stages_and_single_use() {
        let flows: DashMap<String, CodeFlow> = DashMap::new();
        flows.insert("old-started".into(), flow("owner", 1, 100, FlowStage::Started));
        let tokens = TokenResponse { access_token: "at".into(), token_type: "Bearer".into(), expires_in: None, refresh_token: None, scope: None, id_token: None };
        flows.insert("old-exchanged".into(), flow("owner", 1, 100, FlowStage::Exchanged { tokens, identity: Identity { label: "x".into(), key: None } }));
        flows.insert("live".into(), flow("owner", 1, 10_000_000_000, FlowStage::Started));
        sweep_expired(&flows, 1000);
        assert_eq!(flows.len(), 1);
        assert!(flows.contains_key("live"));
        assert!(flows.remove("live").is_some());
        assert!(flows.remove("live").is_none(), "single-use");
    }

    #[test]
    fn per_initiator_cap_evicts_oldest() {
        let flows: DashMap<String, CodeFlow> = DashMap::new();
        for i in 0..5 {
            flows.insert(format!("s{i}"), flow("owner", i, 10_000_000_000, FlowStage::Started));
        }
        flows.insert("other".into(), flow("human:2", 0, 10_000_000_000, FlowStage::Started));
        cap_initiator(&flows, "owner");
        assert!(!flows.contains_key("s0"), "oldest evicted");
        assert!(flows.contains_key("s4"));
        assert!(flows.contains_key("other"), "another initiator untouched");
        let mine = flows.iter().filter(|e| e.value().initiator == "owner").count();
        assert_eq!(mine, MAX_FLOWS_PER_INITIATOR - 1);
    }

    #[test]
    fn debug_output_leaks_no_secret() {
        let tokens = TokenResponse { access_token: "AT-SECRET".into(), token_type: "Bearer".into(), expires_in: Some(1), refresh_token: Some("RT-SECRET".into()), scope: None, id_token: Some("ID-SECRET".into()) };
        let f = flow("owner", 0, 1, FlowStage::Exchanged { tokens: tokens.clone(), identity: Identity { label: "me".into(), key: Some("sub-1".into()) } });
        let s = format!("{f:?} {tokens:?}");
        for secret in ["AT-SECRET", "RT-SECRET", "ID-SECRET", "shh-secret", "verifier-secret"] {
            assert!(!s.contains(secret), "{secret} leaked: {s}");
        }
        assert!(s.contains("<redacted>"));
        let r = crate::log_redact::redact("/cb?code=abc&code_verifier=v&id_token=t&state=s");
        assert!(!r.contains("abc") && !r.contains("=v") && !r.contains("=t"), "{r}");
    }

    #[test]
    fn scope_clamp_and_label_clamp() {
        assert_eq!(clamp_scope(Some(" a b ".into())).as_deref(), Some("a b"));
        assert_eq!(clamp_scope(Some("bad\nscope".into())), None);
        assert_eq!(clamp_scope(Some("x".repeat(600))), None);
        assert_eq!(clamp_label("a\u{0}b\u{7}c"), "abc");
        assert_eq!(clamp_label(&"y".repeat(200)).len(), 120);
    }

    #[test]
    fn identity_strings() {
        assert_eq!(identity_of(None), "owner");
        assert_eq!(identity_of(Some(&AuthContext::Owner)), "owner");
        assert_eq!(
            identity_of(Some(&AuthContext::Human { user_id: 7, company_id: None, role: "admin".into() })),
            "human:7"
        );
    }

    #[test]
    fn is_remote_oauth_requires_lane_and_policy_url() {
        let p = prod();
        let ok = json!({ "auth": { "kind": "mcp_oauth" }, "emit": { "type": "http", "url": "https://app.inhouseseo.ai/api/mcp" } });
        assert!(is_remote_oauth(&ok, &p));
        let key = json!({ "auth": { "kind": "api_key" }, "emit": { "url": "https://x.example/mcp" } });
        assert!(!is_remote_oauth(&key, &p));
        let stdio = json!({ "auth": { "kind": "mcp_oauth" }, "emit": { "command": "npx" } });
        assert!(!is_remote_oauth(&stdio, &p));
        let private = json!({ "auth": { "kind": "mcp_oauth" }, "emit": { "url": "http://127.0.0.1:1/mcp" } });
        assert!(!is_remote_oauth(&private, &p));
    }

    // ── redirect: a 302 from the MCP endpoint is never followed ────────────────

    #[tokio::test]
    async fn discovery_never_follows_a_redirect() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hits = Arc::new(AtomicUsize::new(0));
        let h2 = hits.clone();
        let app = axum::Router::new().fallback(move || {
            let h = h2.clone();
            async move {
                h.fetch_add(1, Ordering::SeqCst);
                (StatusCode::FOUND, [(header::LOCATION, "/elsewhere")]).into_response()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let p = UrlPolicy { allow_loopback_http: true };
        let r = discover(&format!("http://127.0.0.1:{port}/mcp"), &p).await;
        assert_eq!(r.unwrap_err(), DiscoverError::Redirect);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "exactly one request, no follow");
    }

    #[tokio::test]
    async fn foreign_metadata_and_resource_mismatch_are_refused() {
        // A mock whose challenge points at a metadata URL on ANOTHER host.
        let app = axum::Router::new().route(
            "/mcp",
            post(|| async {
                (
                    StatusCode::UNAUTHORIZED,
                    [(header::WWW_AUTHENTICATE, r#"Bearer resource_metadata="http://localhost:9/.well-known/oauth-protected-resource""#)],
                )
                    .into_response()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let p = UrlPolicy { allow_loopback_http: true };
        let r = discover(&format!("http://127.0.0.1:{port}/mcp"), &p).await;
        assert_eq!(r.unwrap_err(), DiscoverError::ForeignMetadata);

        // A mock whose PRM names another origin as the resource.
        let app = axum::Router::new()
            .route("/mcp", post(|| async { (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Bearer")]).into_response() }))
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        json!({ "resource": "https://other.example/api", "authorization_servers": ["https://as.example"] }).to_string(),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let r = discover(&format!("http://127.0.0.1:{port}/mcp"), &p).await;
        assert_eq!(r.unwrap_err(), DiscoverError::ResourceMismatch);
    }

    #[tokio::test]
    async fn a_200_without_auth_is_a_mislaned_card() {
        let app = axum::Router::new().route("/mcp", post(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"jsonrpc":"2.0","id":1,"result":{}}"#) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let p = UrlPolicy { allow_loopback_http: true };
        let r = discover(&format!("http://127.0.0.1:{port}/mcp"), &p).await;
        assert_eq!(r.unwrap_err(), DiscoverError::NoAuthRequired);
    }
}
