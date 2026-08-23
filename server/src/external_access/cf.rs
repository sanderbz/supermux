//! The Cloudflare API seam.
//!
//! Every Cloudflare call the wizard makes goes through [`CfApi`] so token
//! validation, tunnel provisioning and status polling are unit/integration
//! testable WITHOUT a live token — [`MockCfApi`] drives valid / invalid /
//! missing-scope / idempotent-reuse cases deterministically. [`RealCfApi`] is the
//! `reqwest` implementation hitting `api.cloudflare.com`.
//!
//! The operator's chosen zone (their `base_domain`, e.g. `example.com`) is
//! fronted by ONE wildcard tunnel per box: a single remote-managed `cfd_tunnel`
//! (`config_src:"cloudflare"`), one wildcard ingress rule
//! `*.<base_domain> → http://localhost:<port>`, one wildcard proxied CNAME. Every
//! subsequent company slug is then reachable with ZERO further Cloudflare calls —
//! only a new `company_hosts` allowlist entry. The zone is discovered from the
//! token via [`CfApi::list_zones`] and picked in the wizard — nothing is
//! hardcoded.

use async_trait::async_trait;

/// The canonical Cloudflare API base. `RealCfApi` allows an override purely so a
/// wiremock-style integration test can point it at a local server.
pub const CF_API_BASE: &str = "https://api.cloudflare.com/client/v4";

/// A structured Cloudflare error the handlers translate into a human message.
#[derive(Debug, thiserror::Error)]
pub enum CfError {
    /// The token verified as inactive / invalid (`GET /user/tokens/verify`).
    #[error("cloudflare token is not active")]
    TokenInactive,
    /// The token is active but lacks a scope the wizard needs (e.g. the box
    /// could not read the operator's zone → Zone:Read/DNS:Edit missing).
    #[error("cloudflare token missing scope: {0}")]
    MissingScope(String),
    /// The chosen base-domain zone was not visible to this token.
    #[error("zone '{0}' not found for this token")]
    ZoneNotFound(String),
    /// Any transport / decode / non-2xx failure.
    #[error("cloudflare api error: {0}")]
    Api(String),
}

/// A minted (or re-fetched) tunnel: its id and its connector run token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tunnel {
    pub id: String,
    /// The `cloudflared tunnel run --token …` value. Secret — 0600 on disk,
    /// referenced by the user unit's `EnvironmentFile`, never echoed to a client.
    pub token: String,
}

/// The verification state of a Cloudflare Email-Routing **destination** address
/// (the real mailbox forwarding lands in). Cloudflare only forwards to a
/// destination the owner has verified by clicking the link CF emails — so a fresh
/// destination is `verified:false` until they do.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DestinationStatus {
    pub email: String,
    pub verified: bool,
}

/// The zone's Email-Routing enablement (`GET /zones/{z}/email/routing`). `enabled`
/// is true once the MX+SPF records are provisioned and routing is on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EmailRoutingStatus {
    pub enabled: bool,
}

/// One DNS zone the token can read: its Cloudflare id + apex name. `zone_name`
/// (e.g. `example.com`) is what the operator picks as their `base_domain`;
/// `zone_id` is re-derived at provision time via [`CfApi::zone_id`] for the DNS
/// write (so the non-secret store never has to carry it).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ZoneInfo {
    pub zone_id: String,
    pub zone_name: String,
}

/// The mockable Cloudflare surface.
#[async_trait]
pub trait CfApi: Send + Sync {
    /// `GET /user/tokens/verify` — is the token active? `Err(TokenInactive)` when
    /// not.
    async fn verify_token(&self, token: &str) -> Result<(), CfError>;
    /// `GET /accounts` — the first account id the token can see (proves the
    /// account-scoped Tunnel:Edit reach).
    async fn account_id(&self, token: &str) -> Result<String, CfError>;
    /// `GET /zones` (paginated) — every zone this token can read. Proves Zone:Read
    /// by construction; `FORBIDDEN ⇒ MissingScope("Zone:Read")`. An empty vec ⇒
    /// the token controls no zones (surfaced to the wizard as "no domains found").
    /// The wizard maps `zone_name`s to the operator's base-domain choice.
    async fn list_zones(&self, token: &str) -> Result<Vec<ZoneInfo>, CfError>;
    /// `GET /zones?name=<zone>` — the zone id for `zone` (proves Zone:Read reach).
    async fn zone_id(&self, token: &str, zone: &str) -> Result<String, CfError>;
    /// `GET /accounts/{a}/cfd_tunnel?name=<name>&is_deleted=false` — an existing
    /// live tunnel with this name, if any (idempotency probe).
    async fn find_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Option<Tunnel>, CfError>;
    /// `POST /accounts/{a}/cfd_tunnel {name,config_src:"cloudflare"}` — create the
    /// remote-managed tunnel; returns id + connector token.
    async fn create_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Tunnel, CfError>;
    /// `GET /accounts/{a}/cfd_tunnel/{id}/token` — re-fetch the connector token for
    /// an already-existing tunnel (idempotent re-run).
    async fn tunnel_token(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError>;
    /// `PUT /accounts/{a}/cfd_tunnel/{id}/configurations` — the wildcard ingress
    /// (`hostname → service`) plus the `http_status:404` catch-all.
    async fn put_tunnel_config(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
        ingress_hostname: &str,
        service: &str,
    ) -> Result<(), CfError>;
    /// `POST /zones/{z}/dns_records` (idempotent upsert) — the wildcard proxied
    /// CNAME `*.<base_domain> → {tunnel_id}.cfargotunnel.com`.
    async fn upsert_dns_cname(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        content: &str,
    ) -> Result<(), CfError>;
    /// `GET /accounts/{a}/cfd_tunnel/{id}` `status` — `inactive|degraded|healthy`
    /// (mapped by the caller to none/connecting/healthy).
    async fn tunnel_status(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError>;

    // ── Email Routing (the agent-inbox surface) ────────────────────────────────
    //
    // These three writes need the token's **Email Routing Rules: Edit** scope (the
    // MX/SPF records enable writes reuse the existing DNS:Edit). A `FORBIDDEN` from
    // any of them surfaces as `MissingScope("Email Routing Rules:Edit")` so the
    // wizard can tell the operator to re-mint the token with that scope. Idempotent
    // by construction — re-running a provision is a no-op that returns live state.

    /// `POST /zones/{z}/email/routing/enable` — provision MX+SPF and turn routing
    /// on. Idempotent: an already-enabled zone is treated as success.
    async fn enable_email_routing(&self, token: &str, zone_id: &str) -> Result<(), CfError>;

    /// `POST /accounts/{a}/email/routing/addresses` — register a destination
    /// mailbox (Cloudflare emails it a verification link). Idempotent: an
    /// already-registered address returns its current verified state rather than
    /// erroring. Returns whether Cloudflare has seen the owner verify it.
    async fn add_destination_address(
        &self,
        token: &str,
        account_id: &str,
        email: &str,
    ) -> Result<DestinationStatus, CfError>;

    /// `POST /zones/{z}/email/routing/rules` — a `to:<agent@domain> → forward
    /// <destination>` rule. Idempotent by matcher: an existing rule for the same
    /// `to` address is reused (its `tag` returned) rather than duplicated.
    async fn create_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        to_address: &str,
        forward_to: &str,
    ) -> Result<String, CfError>;

    /// `DELETE /zones/{z}/email/routing/rules/{tag}` — remove a rule by its tag.
    async fn delete_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        rule_tag: &str,
    ) -> Result<(), CfError>;

    /// `GET /zones/{z}/email/routing` — the zone's routing enablement, to reflect
    /// enabled/pending in status.
    async fn email_routing_status(
        &self,
        token: &str,
        zone_id: &str,
    ) -> Result<EmailRoutingStatus, CfError>;
}

/// Verify the token is active and reach an account (proves account-scoped
/// Tunnel:Edit). Zone-FREE: the zone is no longer known at token-verify time —
/// the operator picks their `base_domain` from [`CfApi::list_zones`] afterwards,
/// and provision re-derives the DNS `zone_id` via [`CfApi::zone_id`]. Reused by
/// `cf-token` (save) and `status` (live re-verify).
pub async fn discover_account(api: &dyn CfApi, token: &str) -> Result<String, CfError> {
    api.verify_token(token).await?;
    api.account_id(token).await
}

// ── real reqwest implementation ──────────────────────────────────────────────

/// The live Cloudflare implementation. Each call is a bearer-authenticated JSON
/// request; a non-`success` envelope is surfaced as [`CfError::Api`].
pub struct RealCfApi {
    http: reqwest::Client,
    base: String,
}

impl Default for RealCfApi {
    fn default() -> Self {
        Self::new()
    }
}

impl RealCfApi {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            base: CF_API_BASE.to_string(),
        }
    }

    /// Point at an alternate base (integration tests against a local mock server).
    pub fn with_base(base: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: base.into(),
        }
    }

    fn req(&self, method: reqwest::Method, token: &str, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(token)
    }
}

/// Minimal decode of the Cloudflare `{success, result, errors}` envelope.
///
/// The explicit `bound` keeps serde from adding a spurious `T: Default` bound
/// (which the field-level `#[serde(default)]` on `result` would otherwise
/// generate); `Option::<T>::default()` is `None` for any `T`, so no such bound is
/// actually needed at runtime.
#[derive(serde::Deserialize)]
#[serde(bound(deserialize = "T: serde::Deserialize<'de>"))]
struct CfEnvelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    result: Option<T>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

impl<T> CfEnvelope<T> {
    fn into_result(self, ctx: &str) -> Result<T, CfError> {
        if self.success {
            self.result
                .ok_or_else(|| CfError::Api(format!("{ctx}: success with no result")))
        } else {
            Err(CfError::Api(format!("{ctx}: {:?}", self.errors)))
        }
    }
}

#[async_trait]
impl CfApi for RealCfApi {
    async fn verify_token(&self, token: &str) -> Result<(), CfError> {
        #[derive(serde::Deserialize)]
        struct Verify {
            status: String,
        }
        let resp = self
            .req(reqwest::Method::GET, token, "/user/tokens/verify")
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CfError::TokenInactive);
        }
        let env: CfEnvelope<Verify> = resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let v = env.into_result("verify")?;
        if v.status == "active" {
            Ok(())
        } else {
            Err(CfError::TokenInactive)
        }
    }

    async fn account_id(&self, token: &str) -> Result<String, CfError> {
        #[derive(serde::Deserialize)]
        struct Account {
            id: String,
        }
        let resp = self
            .req(reqwest::Method::GET, token, "/accounts?per_page=1")
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<Vec<Account>> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let accounts = env.into_result("accounts")?;
        accounts
            .into_iter()
            .next()
            .map(|a| a.id)
            .ok_or_else(|| CfError::MissingScope("Account (no account visible to token)".into()))
    }

    async fn list_zones(&self, token: &str) -> Result<Vec<ZoneInfo>, CfError> {
        #[derive(serde::Deserialize)]
        struct Zone {
            id: String,
            name: String,
        }
        const PER_PAGE: usize = 50;
        let mut out: Vec<ZoneInfo> = Vec::new();
        let mut page = 1usize;
        loop {
            let resp = self
                .req(
                    reqwest::Method::GET,
                    token,
                    &format!("/zones?per_page={PER_PAGE}&page={page}"),
                )
                .send()
                .await
                .map_err(|e| CfError::Api(e.to_string()))?;
            if resp.status() == reqwest::StatusCode::FORBIDDEN {
                return Err(CfError::MissingScope("Zone:Read".into()));
            }
            let env: CfEnvelope<Vec<Zone>> =
                resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
            let zones = env.into_result("list_zones")?;
            let n = zones.len();
            out.extend(zones.into_iter().map(|z| ZoneInfo {
                zone_id: z.id,
                zone_name: z.name,
            }));
            // Stop when the last page returned fewer than a full page (or none).
            if n < PER_PAGE {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    async fn zone_id(&self, token: &str, zone: &str) -> Result<String, CfError> {
        #[derive(serde::Deserialize)]
        struct Zone {
            id: String,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/zones?name={zone}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Zone:Read".into()));
        }
        let env: CfEnvelope<Vec<Zone>> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let zones = env.into_result("zones")?;
        zones
            .into_iter()
            .next()
            .map(|z| z.id)
            .ok_or_else(|| CfError::ZoneNotFound(zone.to_string()))
    }

    async fn find_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Option<Tunnel>, CfError> {
        #[derive(serde::Deserialize)]
        struct T {
            id: String,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel?name={name}&is_deleted=false"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<Vec<T>> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let tunnels = env.into_result("find_tunnel")?;
        match tunnels.into_iter().next() {
            Some(t) => {
                let token_val = self.tunnel_token(token, account_id, &t.id).await?;
                Ok(Some(Tunnel {
                    id: t.id,
                    token: token_val,
                }))
            }
            None => Ok(None),
        }
    }

    async fn create_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Tunnel, CfError> {
        #[derive(serde::Deserialize)]
        struct Created {
            id: String,
            token: String,
        }
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel"),
            )
            .json(&serde_json::json!({ "name": name, "config_src": "cloudflare" }))
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<Created> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let c = env.into_result("create_tunnel")?;
        Ok(Tunnel {
            id: c.id,
            token: c.token,
        })
    }

    async fn tunnel_token(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError> {
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<String> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        env.into_result("tunnel_token")
    }

    async fn put_tunnel_config(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
        ingress_hostname: &str,
        service: &str,
    ) -> Result<(), CfError> {
        let body = serde_json::json!({
            "config": {
                "ingress": [
                    { "hostname": ingress_hostname, "service": service },
                    { "service": "http_status:404" }
                ]
            }
        });
        let resp = self
            .req(
                reqwest::Method::PUT,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<serde_json::Value> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        env.into_result("put_tunnel_config").map(|_| ())
    }

    async fn upsert_dns_cname(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        content: &str,
    ) -> Result<(), CfError> {
        let body = serde_json::json!({
            "type": "CNAME",
            "name": name,
            "content": content,
            "proxied": true
        });
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/zones/{zone_id}/dns_records"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        // A pre-existing identical record returns 400/409; treat that as success
        // (idempotent). Anything else with a non-success envelope is a real error.
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let env: CfEnvelope<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| CfError::Api(format!("{status}: {e}")))?;
        // 81057 = "record already exists".
        let already = env
            .errors
            .iter()
            .any(|e| e.get("code").and_then(|c| c.as_i64()) == Some(81057));
        if already {
            Ok(())
        } else {
            env.into_result("upsert_dns_cname").map(|_| ())
        }
    }

    async fn tunnel_status(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError> {
        #[derive(serde::Deserialize)]
        struct T {
            #[serde(default)]
            status: String,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<T> = resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        Ok(env.into_result("tunnel_status")?.status)
    }

    async fn enable_email_routing(&self, token: &str, zone_id: &str) -> Result<(), CfError> {
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/zones/{zone_id}/email/routing/enable"),
            )
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        if resp.status().is_success() {
            return Ok(());
        }
        // Non-2xx: routing is very likely already enabled (a re-provision). Confirm
        // idempotently rather than surfacing an error.
        let already = self
            .email_routing_status(token, zone_id)
            .await
            .map(|s| s.enabled)
            .unwrap_or(false);
        if already {
            Ok(())
        } else {
            let status = resp.status();
            let env: CfEnvelope<serde_json::Value> = resp
                .json()
                .await
                .map_err(|e| CfError::Api(format!("{status}: {e}")))?;
            env.into_result("enable_email_routing").map(|_| ())
        }
    }

    async fn add_destination_address(
        &self,
        token: &str,
        account_id: &str,
        email: &str,
    ) -> Result<DestinationStatus, CfError> {
        // A destination address carries a `verified` timestamp (null until the
        // owner clicks Cloudflare's verification link).
        #[derive(serde::Deserialize)]
        struct Addr {
            #[serde(default)]
            email: String,
            #[serde(default)]
            verified: Option<serde_json::Value>,
        }
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/accounts/{account_id}/email/routing/addresses"),
            )
            .json(&serde_json::json!({ "email": email }))
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        if resp.status().is_success() {
            let env: CfEnvelope<Addr> =
                resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
            let a = env.into_result("add_destination_address")?;
            return Ok(DestinationStatus {
                email: if a.email.is_empty() { email.to_string() } else { a.email },
                verified: a.verified.map(|v| !v.is_null()).unwrap_or(false),
            });
        }
        // Already registered (idempotent): re-fetch the list and read its state.
        #[derive(serde::Deserialize)]
        struct AddrRow {
            #[serde(default)]
            email: String,
            #[serde(default)]
            verified: Option<serde_json::Value>,
        }
        let list = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/email/routing/addresses?per_page=50"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<Vec<AddrRow>> =
            list.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let rows = env.into_result("list_destination_addresses")?;
        let found = rows
            .into_iter()
            .find(|r| r.email.eq_ignore_ascii_case(email));
        Ok(DestinationStatus {
            email: email.to_string(),
            verified: found
                .and_then(|r| r.verified)
                .map(|v| !v.is_null())
                .unwrap_or(false),
        })
    }

    async fn create_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        to_address: &str,
        forward_to: &str,
    ) -> Result<String, CfError> {
        #[derive(serde::Deserialize)]
        struct Rule {
            #[serde(default)]
            tag: String,
            #[serde(default)]
            matchers: Vec<Matcher>,
        }
        #[derive(serde::Deserialize)]
        struct Matcher {
            #[serde(default)]
            field: String,
            #[serde(default)]
            value: String,
        }
        // Idempotent by matcher: reuse an existing `to:<address>` rule if present.
        let list = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/zones/{zone_id}/email/routing/rules?per_page=50"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if list.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        if list.status().is_success() {
            let env: CfEnvelope<Vec<Rule>> =
                list.json().await.map_err(|e| CfError::Api(e.to_string()))?;
            if let Ok(rules) = env.into_result("list_routing_rules") {
                if let Some(existing) = rules.into_iter().find(|r| {
                    r.matchers.iter().any(|m| {
                        m.field == "to" && m.value.eq_ignore_ascii_case(to_address)
                    })
                }) {
                    if !existing.tag.is_empty() {
                        return Ok(existing.tag);
                    }
                }
            }
        }
        // None yet — create it.
        let body = serde_json::json!({
            "name": name,
            "enabled": true,
            "matchers": [{ "type": "literal", "field": "to", "value": to_address }],
            "actions": [{ "type": "forward", "value": [forward_to] }],
        });
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/zones/{zone_id}/email/routing/rules"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        let env: CfEnvelope<Rule> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        Ok(env.into_result("create_routing_rule")?.tag)
    }

    async fn delete_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        rule_tag: &str,
    ) -> Result<(), CfError> {
        let resp = self
            .req(
                reqwest::Method::DELETE,
                token,
                &format!("/zones/{zone_id}/email/routing/rules/{rule_tag}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        // A 404 (rule already gone) is a benign no-op for a delete.
        if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let status = resp.status();
        let env: CfEnvelope<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| CfError::Api(format!("{status}: {e}")))?;
        env.into_result("delete_routing_rule").map(|_| ())
    }

    async fn email_routing_status(
        &self,
        token: &str,
        zone_id: &str,
    ) -> Result<EmailRoutingStatus, CfError> {
        #[derive(serde::Deserialize)]
        struct Routing {
            #[serde(default)]
            enabled: bool,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/zones/{zone_id}/email/routing"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        let env: CfEnvelope<Routing> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        Ok(EmailRoutingStatus {
            enabled: env.into_result("email_routing_status")?.enabled,
        })
    }
}

// ── test double ──────────────────────────────────────────────────────────────

/// A deterministic mock driving every provisioning branch without a live token.
///
/// Configure the failure modes via the public flags; the create/find calls are
/// counted so an idempotency test can assert "created exactly once".
#[cfg(test)]
pub struct MockCfApi {
    pub valid_token: String,
    pub scopes_ok: bool,
    pub zone_present: bool,
    pub account_id: String,
    pub zone_id: String,
    /// The zones the token "controls". Default is a single `example.com` so the
    /// wizard's single-zone auto-select+confirm path is exercised; a multi-zone
    /// test sets two. `list_zones` returns `MissingScope` when `scopes_ok=false`.
    pub zones: Vec<ZoneInfo>,
    /// The tunnel state, shared so `provision-tunnel` re-runs observe the prior
    /// create (idempotency).
    pub existing_tunnel: std::sync::Mutex<Option<Tunnel>>,
    pub create_calls: std::sync::atomic::AtomicUsize,
    /// The status `tunnel_status` reports.
    pub status: std::sync::Mutex<String>,
    // ── Email Routing knobs (agent-inbox) ──
    /// When false, the routing writes return `MissingScope` (the token lacks the
    /// Email Routing Rules:Edit scope) — drives the missing-scope test.
    pub email_scope_ok: bool,
    /// The verified state `add_destination_address` reports (default false so the
    /// happy-path test sees the honest pending state a fresh destination has).
    pub destination_verified: bool,
    /// Zone routing enablement, shared so a re-provision observes the enable.
    pub routing_enabled: std::sync::Mutex<bool>,
    /// Counts `create_routing_rule` bodies actually POSTed (idempotency assert).
    pub rule_create_calls: std::sync::atomic::AtomicUsize,
    /// The single routing rule this mock "holds" (its tag), shared so a re-run
    /// reuses it and a delete clears it.
    pub existing_rule: std::sync::Mutex<Option<String>>,
}

#[cfg(test)]
impl Default for MockCfApi {
    fn default() -> Self {
        Self {
            valid_token: "valid-cf-token".to_string(),
            scopes_ok: true,
            zone_present: true,
            account_id: "acct-123".to_string(),
            zone_id: "zone-abc".to_string(),
            zones: vec![ZoneInfo {
                zone_id: "zone-abc".to_string(),
                zone_name: "example.com".to_string(),
            }],
            existing_tunnel: std::sync::Mutex::new(None),
            create_calls: std::sync::atomic::AtomicUsize::new(0),
            status: std::sync::Mutex::new("healthy".to_string()),
            email_scope_ok: true,
            destination_verified: false,
            routing_enabled: std::sync::Mutex::new(false),
            rule_create_calls: std::sync::atomic::AtomicUsize::new(0),
            existing_rule: std::sync::Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl MockCfApi {
    pub fn create_count(&self) -> usize {
        self.create_calls.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn rule_create_count(&self) -> usize {
        self.rule_create_calls
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
#[async_trait]
impl CfApi for MockCfApi {
    async fn verify_token(&self, token: &str) -> Result<(), CfError> {
        if token == self.valid_token {
            Ok(())
        } else {
            Err(CfError::TokenInactive)
        }
    }

    async fn account_id(&self, _token: &str) -> Result<String, CfError> {
        if !self.scopes_ok {
            return Err(CfError::MissingScope("Cloudflare Tunnel:Edit".into()));
        }
        Ok(self.account_id.clone())
    }

    async fn list_zones(&self, _token: &str) -> Result<Vec<ZoneInfo>, CfError> {
        if !self.scopes_ok {
            return Err(CfError::MissingScope("Zone:Read".into()));
        }
        Ok(self.zones.clone())
    }

    async fn zone_id(&self, _token: &str, zone: &str) -> Result<String, CfError> {
        if !self.scopes_ok {
            return Err(CfError::MissingScope("DNS:Edit / Zone:Read".into()));
        }
        if !self.zone_present {
            return Err(CfError::ZoneNotFound(zone.to_string()));
        }
        Ok(self.zone_id.clone())
    }

    async fn find_tunnel(
        &self,
        _token: &str,
        _account_id: &str,
        _name: &str,
    ) -> Result<Option<Tunnel>, CfError> {
        Ok(self.existing_tunnel.lock().unwrap().clone())
    }

    async fn create_tunnel(
        &self,
        _token: &str,
        _account_id: &str,
        _name: &str,
    ) -> Result<Tunnel, CfError> {
        self.create_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let t = Tunnel {
            id: "tunnel-xyz".to_string(),
            token: "connector-token-secret".to_string(),
        };
        *self.existing_tunnel.lock().unwrap() = Some(t.clone());
        Ok(t)
    }

    async fn tunnel_token(
        &self,
        _token: &str,
        _account_id: &str,
        _tunnel_id: &str,
    ) -> Result<String, CfError> {
        Ok(self
            .existing_tunnel
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| t.token.clone())
            .unwrap_or_else(|| "connector-token-secret".to_string()))
    }

    async fn put_tunnel_config(
        &self,
        _token: &str,
        _account_id: &str,
        _tunnel_id: &str,
        _ingress_hostname: &str,
        _service: &str,
    ) -> Result<(), CfError> {
        Ok(())
    }

    async fn upsert_dns_cname(
        &self,
        _token: &str,
        _zone_id: &str,
        _name: &str,
        _content: &str,
    ) -> Result<(), CfError> {
        Ok(())
    }

    async fn tunnel_status(
        &self,
        _token: &str,
        _account_id: &str,
        _tunnel_id: &str,
    ) -> Result<String, CfError> {
        Ok(self.status.lock().unwrap().clone())
    }

    async fn enable_email_routing(&self, _token: &str, _zone_id: &str) -> Result<(), CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        *self.routing_enabled.lock().unwrap() = true;
        Ok(())
    }

    async fn add_destination_address(
        &self,
        _token: &str,
        _account_id: &str,
        email: &str,
    ) -> Result<DestinationStatus, CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        Ok(DestinationStatus {
            email: email.to_string(),
            verified: self.destination_verified,
        })
    }

    async fn create_routing_rule(
        &self,
        _token: &str,
        _zone_id: &str,
        _name: &str,
        _to_address: &str,
        _forward_to: &str,
    ) -> Result<String, CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        // Idempotent by matcher: reuse the held rule, only counting real creates.
        let mut held = self.existing_rule.lock().unwrap();
        if let Some(tag) = held.as_ref() {
            return Ok(tag.clone());
        }
        self.rule_create_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let tag = "rule-tag-abc".to_string();
        *held = Some(tag.clone());
        Ok(tag)
    }

    async fn delete_routing_rule(
        &self,
        _token: &str,
        _zone_id: &str,
        _rule_tag: &str,
    ) -> Result<(), CfError> {
        *self.existing_rule.lock().unwrap() = None;
        Ok(())
    }

    async fn email_routing_status(
        &self,
        _token: &str,
        _zone_id: &str,
    ) -> Result<EmailRoutingStatus, CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        Ok(EmailRoutingStatus {
            enabled: *self.routing_enabled.lock().unwrap(),
        })
    }
}
