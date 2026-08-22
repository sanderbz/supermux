//! The Cloudflare API seam.
//!
//! Every Cloudflare call the wizard makes goes through [`CfApi`] so token
//! validation, tunnel provisioning and status polling are unit/integration
//! testable WITHOUT a live token — [`MockCfApi`] drives valid / invalid /
//! missing-scope / idempotent-reuse cases deterministically. [`RealCfApi`] is the
//! `reqwest` implementation hitting `api.cloudflare.com`.
//!
//! The zone `s.iwd.nl` is fronted by ONE wildcard tunnel per box: a single
//! remote-managed `cfd_tunnel` (`config_src:"cloudflare"`), one wildcard ingress
//! rule `*.s.iwd.nl → http://localhost:<port>`, one wildcard proxied CNAME. Every
//! subsequent company slug is then reachable with ZERO further Cloudflare calls —
//! only a new `company_hosts` allowlist entry.

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
    /// could not read the `s.iwd.nl` zone → Zone:Read/DNS:Edit missing).
    #[error("cloudflare token missing scope: {0}")]
    MissingScope(String),
    /// No `s.iwd.nl` zone was visible to this token.
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

/// The result of validating a token: which account + zone it can see. Proves the
/// scopes are present by construction (we could reach both).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenContext {
    pub account_id: String,
    pub zone_id: String,
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
    /// CNAME `*.s.iwd.nl → {tunnel_id}.cfargotunnel.com`.
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
}

/// Discover the account + zone a token can reach, verifying the token is active
/// first. Reused by `cf-token` (save) and `status` (live re-verify).
pub async fn discover(api: &dyn CfApi, token: &str, zone: &str) -> Result<TokenContext, CfError> {
    api.verify_token(token).await?;
    let account_id = api.account_id(token).await?;
    let zone_id = api.zone_id(token, zone).await?;
    Ok(TokenContext { account_id, zone_id })
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
    /// The tunnel state, shared so `provision-tunnel` re-runs observe the prior
    /// create (idempotency).
    pub existing_tunnel: std::sync::Mutex<Option<Tunnel>>,
    pub create_calls: std::sync::atomic::AtomicUsize,
    /// The status `tunnel_status` reports.
    pub status: std::sync::Mutex<String>,
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
            existing_tunnel: std::sync::Mutex::new(None),
            create_calls: std::sync::atomic::AtomicUsize::new(0),
            status: std::sync::Mutex::new("healthy".to_string()),
        }
    }
}

#[cfg(test)]
impl MockCfApi {
    pub fn create_count(&self) -> usize {
        self.create_calls.load(std::sync::atomic::Ordering::SeqCst)
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
}
