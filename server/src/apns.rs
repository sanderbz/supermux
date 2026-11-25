//! Native iOS push via APNs — devices, payload mapping and the sender.
//!
//! **What this gives the user.** The native iOS app cannot receive Web Push
//! (that only works for home-screen PWAs), so without this it can only notify
//! while it is open. With it, every notification the server sends through Web
//! Push is ALSO delivered to registered iPhones through Apple's push service.
//!
//! **One gate, two transports.** Nothing here decides WHETHER to push: the
//! global category prefs, the per-bot `notif` policy and the 30 s seen
//! suppression all run before [`crate::push`]'s fan-out, and that fan-out calls
//! [`send`] next to the Web Push sender. So every place that sends Web Push also
//! reaches APNs devices, with the same mutes, and nowhere else.
//!
//! **Token-based auth.** One `.p8` auth key (ES256) signs a short JWT
//! (`iss` = team id, `iat`, header `kid` = key id) that is reused for up to
//! [`JWT_MAX_AGE`] (Apple accepts a token for 60 min and rejects refreshing it
//! more than once per 20 min). Requests go over HTTP/2 to the host that matches
//! each device's environment.
//!
//! **Not configured is a normal state.** Without a key the server still stores
//! registrations (so the app can register before the key lands), reports
//! `configured: false`, and sends nothing — silently, no per-push log line.
//!
//! **Secrets.** The `.p8` key, the JWT and device tokens are never logged and
//! never returned by the API. Payloads carry only what Web Push already shows.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use jwt_simple::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::error::AppError;
use crate::notify::{PushPayload, Tier};
use crate::state::AppState;

/// The app's bundle id, used as `apns-topic` when `apns_topic` is not set.
pub const DEFAULT_TOPIC: &str = "com.supermux.app";

/// APNs production host (TestFlight and App Store builds).
pub const PRODUCTION_HOST: &str = "https://api.push.apple.com";
/// APNs sandbox host (Xcode development builds).
pub const SANDBOX_HOST: &str = "https://api.sandbox.push.apple.com";

/// Reuse a signed provider token this long. Apple accepts one for 60 min and
/// answers `TooManyProviderTokenUpdates` when it is refreshed more often than
/// every 20 min, so 50 min sits safely between the two.
pub const JWT_MAX_AGE: Duration = Duration::from_secs(50 * 60);

/// How long APNs should keep trying to deliver an undelivered notification.
/// Mirrors the Web Push TTL (`push::PUSH_TTL_SECS`): past 4 h the ping is stale.
const EXPIRATION_SECS: i64 = 4 * 60 * 60;

/// Per-request bounds. The fan-out runs inside the callers' spawned push task,
/// so these only bound how long that task lives — no request handler waits.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How long an attention push waits for the matching ask row to become
/// answerable before it goes out as a plain `BOT` notification. The push is
/// raised by the hook ~ms before the ask row is written and its decision hook
/// attaches; only a push with a live dialog waits, and only this long.
const ASK_WAIT: Duration = Duration::from_millis(1500);
const ASK_POLL: Duration = Duration::from_millis(150);

/// `apns-collapse-id` may be at most 64 bytes.
const COLLAPSE_ID_MAX: usize = 64;

pub const ENV_SANDBOX: &str = "sandbox";
pub const ENV_PRODUCTION: &str = "production";

/// `client_ref` budget (chars), from the iOS contract.
pub const CLIENT_REF_MAX: usize = 64;
const DEVICE_NAME_MAX: usize = 100;
const APP_VERSION_MAX: usize = 32;
/// Hex device-token length bounds. Apple's tokens are 32 bytes (64 hex) today,
/// and Apple says not to hard-code that, so allow up to 100 bytes.
const TOKEN_HEX_MIN: usize = 64;
const TOKEN_HEX_MAX: usize = 200;

// ── config ───────────────────────────────────────────────────────────────────

/// The four APNs settings, from top-level keys in `<data_dir>/config.toml`
/// (`apns_key_path`, `apns_key_id`, `apns_team_id`, `apns_topic`), each
/// overridable by `SUPERMUX_APNS_KEY_PATH` / `_KEY_ID` / `_TEAM_ID` / `_TOPIC`.
/// Read on its own like `[asks]`: the main config parser ignores unknown keys,
/// so this needs no change to [`crate::config::Config`].
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct ApnsConfig {
    #[serde(default)]
    pub apns_key_path: Option<String>,
    #[serde(default)]
    pub apns_key_id: Option<String>,
    #[serde(default)]
    pub apns_team_id: Option<String>,
    #[serde(default)]
    pub apns_topic: Option<String>,
}

impl ApnsConfig {
    /// File values, then env overrides. A config.toml that does not parse is
    /// the main loader's problem; here it just means "no APNs config".
    pub fn load(data_dir: &Path) -> Self {
        let file = std::fs::read_to_string(data_dir.join("config.toml"))
            .ok()
            .and_then(|t| toml::from_str::<ApnsConfig>(&t).ok())
            .unwrap_or_default();
        Self::with_env(file, |k| std::env::var(k).ok())
    }

    fn with_env(mut self, env: impl Fn(&str) -> Option<String>) -> Self {
        let pick = |cur: Option<String>, key: &str| {
            env(key)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| cur.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        };
        self.apns_key_path = pick(self.apns_key_path, "SUPERMUX_APNS_KEY_PATH");
        self.apns_key_id = pick(self.apns_key_id, "SUPERMUX_APNS_KEY_ID");
        self.apns_team_id = pick(self.apns_team_id, "SUPERMUX_APNS_TEAM_ID");
        self.apns_topic = pick(self.apns_topic, "SUPERMUX_APNS_TOPIC");
        self
    }

    /// The topic in effect (the configured bundle id, else the default).
    pub fn topic(&self) -> String {
        self.apns_topic
            .clone()
            .unwrap_or_else(|| DEFAULT_TOPIC.to_string())
    }

    /// The key path, relative paths resolved against `data_dir`.
    fn key_path(&self, data_dir: &Path) -> Option<PathBuf> {
        let p = PathBuf::from(self.apns_key_path.as_deref()?);
        Some(if p.is_absolute() { p } else { data_dir.join(p) })
    }
}

// ── the sender's state ───────────────────────────────────────────────────────

/// The signing half: the `.p8` key plus the ids the JWT names.
struct Signer {
    key: ES256KeyPair,
    team_id: String,
}

/// Where each environment's requests go. Production code always uses the two
/// Apple hosts; tests point both at a local mock.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub production: String,
    pub sandbox: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            production: PRODUCTION_HOST.to_string(),
            sandbox: SANDBOX_HOST.to_string(),
        }
    }
}

/// Shared APNs state on [`AppState`]: config, key, cached provider token and
/// one HTTP/2 client (Apple asks providers to keep connections open).
pub struct Apns {
    topic: String,
    signer: Option<Signer>,
    jwt: Mutex<Option<(String, Instant)>>,
    client: reqwest::Client,
    endpoints: Endpoints,
}

impl Apns {
    /// Build from config. A missing or unreadable key leaves APNs unconfigured
    /// (logged once, here) and never fails the boot.
    pub fn init(data_dir: &Path) -> Arc<Self> {
        let cfg = ApnsConfig::load(data_dir);
        let signer = load_signer(&cfg, data_dir);
        let client = reqwest::Client::builder()
            .http2_prior_knowledge()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        Arc::new(Self::new(cfg.topic(), signer, client, Endpoints::default()))
    }

    fn new(
        topic: String,
        signer: Option<Signer>,
        client: reqwest::Client,
        endpoints: Endpoints,
    ) -> Self {
        Self {
            topic,
            signer,
            jwt: Mutex::new(None),
            client,
            endpoints,
        }
    }

    /// A configured sender for tests: the given key, a plain HTTP/1 client and
    /// a mock host for both environments.
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test(key_pem: &str, key_id: &str, team_id: &str, topic: &str, base: &str) -> Self {
        let key = ES256KeyPair::from_pem(key_pem)
            .expect("test key")
            .with_key_id(key_id);
        Self::new(
            topic.to_string(),
            Some(Signer {
                key,
                team_id: team_id.to_string(),
            }),
            reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .unwrap(),
            Endpoints {
                production: base.to_string(),
                sandbox: base.to_string(),
            },
        )
    }

    /// Can this server send? True once a readable key, key id and team id are
    /// all set.
    pub fn configured(&self) -> bool {
        self.signer.is_some()
    }

    /// The `apns-topic` in effect (also the bundle id a device must register
    /// with).
    pub fn topic(&self) -> &str {
        &self.topic
    }

    /// The provider token, signed fresh only when the cached one is older than
    /// [`JWT_MAX_AGE`] (or was rejected as expired).
    fn jwt(&self) -> Result<String, String> {
        let signer = self.signer.as_ref().ok_or("not configured")?;
        let mut slot = self.jwt.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((tok, at)) = slot.as_ref() {
            if at.elapsed() < JWT_MAX_AGE {
                return Ok(tok.clone());
            }
        }
        let tok = sign_jwt(&signer.key, &signer.team_id).map_err(|e| format!("sign: {e}"))?;
        *slot = Some((tok.clone(), Instant::now()));
        Ok(tok)
    }

    /// Drop the cached token (APNs said it expired or is invalid), so the next
    /// push signs a new one.
    fn forget_jwt(&self) {
        *self.jwt.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn host_for(&self, environment: &str) -> &str {
        if environment == ENV_SANDBOX {
            &self.endpoints.sandbox
        } else {
            &self.endpoints.production
        }
    }
}

fn load_signer(cfg: &ApnsConfig, data_dir: &Path) -> Option<Signer> {
    let (Some(path), Some(key_id), Some(team_id)) = (
        cfg.key_path(data_dir),
        cfg.apns_key_id.as_deref(),
        cfg.apns_team_id.as_deref(),
    ) else {
        if cfg.apns_key_path.is_some() || cfg.apns_key_id.is_some() || cfg.apns_team_id.is_some() {
            tracing::warn!(
                "apns: incomplete config — apns_key_path, apns_key_id and apns_team_id are all \
                 required; native iOS push stays off"
            );
        } else {
            tracing::debug!("apns: not configured; native iOS push stays off");
        }
        return None;
    };
    let pem = match std::fs::read_to_string(&path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "apns: cannot read the .p8 key; native iOS push stays off");
            return None;
        }
    };
    match ES256KeyPair::from_pem(&pem) {
        Ok(key) => {
            tracing::info!(topic = %cfg.topic(), "apns: configured");
            Some(Signer {
                key: key.with_key_id(key_id),
                team_id: team_id.to_string(),
            })
        }
        Err(_) => {
            // Never echo the key or the parser's view of it.
            tracing::warn!(path = %path.display(), "apns: the .p8 key is not a valid P-256 PKCS#8 key; native iOS push stays off");
            None
        }
    }
}

/// Sign an APNs provider token: header `{alg: ES256, kid}`, claims
/// `{iss: <team id>, iat}` and nothing else (APNs needs no `exp`).
fn sign_jwt(key: &ES256KeyPair, team_id: &str) -> Result<String, jwt_simple::Error> {
    let mut claims = Claims::create(jwt_simple::prelude::Duration::from_hours(1)).with_issuer(team_id);
    claims.expires_at = None;
    claims.invalid_before = None;
    key.sign(claims)
}

// ── payload mapping (pure) ───────────────────────────────────────────────────

/// The open, answerable ask a push is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskRef {
    pub id: String,
    pub kind: String,
}

/// The notification category the app registers actions for.
pub fn category_for(ask: Option<&AskRef>) -> &'static str {
    match ask.map(|a| a.kind.as_str()) {
        Some(crate::asks::KIND_PERMISSION) => "ASK_PERMISSION",
        Some(crate::asks::KIND_QUESTION | crate::asks::KIND_ELICITATION) => "ASK_QUESTION",
        _ => "BOT",
    }
}

/// `apns-collapse-id` from the payload's coalescing tag. Tags fit in 64 bytes
/// for every real slug; a longer one is replaced by its SHA-256 hex (64 chars),
/// which keeps one slot per tag instead of truncating two tags into one.
pub fn collapse_id(tag: &str) -> String {
    if tag.len() <= COLLAPSE_ID_MAX {
        return tag.to_string();
    }
    use sha2::Digest;
    let digest = sha2::Sha256::digest(tag.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The APNs JSON body for one device. PURE.
///
/// `session` is the session the push is about: the payload's own, else the one
/// the caller gated on (the board and agent pings build a session-less payload
/// but are about a bot).
pub fn build_payload(
    p: &PushPayload,
    session: Option<&str>,
    client_ref: &str,
    ask: Option<&AskRef>,
) -> Value {
    let session = p.session.as_deref().or(session);
    let mut aps = json!({
        "alert": { "title": p.title, "body": p.body },
        "badge": p.badge,
        "thread-id": session.unwrap_or("supermux"),
        "interruption-level": if p.tier == Tier::Attention { "time-sensitive" } else { "active" },
        "category": category_for(ask),
        "mutable-content": 1,
    });
    if matches!(p.tier, Tier::Attention | Tier::Error) {
        aps["sound"] = json!("default");
    }
    let mut smx = json!({
        "ref": client_ref,
        "url": p.url,
        "tier": p.tier.as_str(),
        "badge": p.badge,
    });
    if let Some(s) = session {
        smx["session"] = json!(s);
    }
    if let Some(a) = ask {
        smx["ask_id"] = json!(a.id);
        smx["ask_kind"] = json!(a.kind);
    }
    json!({ "aps": aps, "smx": smx })
}

/// The request headers for one alert push (besides `authorization`). PURE.
pub fn alert_headers(topic: &str, p: &PushPayload, now_secs: i64) -> Vec<(&'static str, String)> {
    vec![
        ("apns-push-type", "alert".to_string()),
        ("apns-topic", topic.to_string()),
        ("apns-collapse-id", collapse_id(&p.tag)),
        ("apns-priority", "10".to_string()),
        ("apns-expiration", (now_secs + EXPIRATION_SECS).to_string()),
    ]
}

// ── APNs responses ───────────────────────────────────────────────────────────

/// What one device's response means for the fan-out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    /// The token is dead (`410`, or `400 BadDeviceToken`): drop the row.
    Prune(String),
    /// Our provider token was refused: count a failure and re-sign next time.
    TokenRejected(String),
    /// Anything else: count a failure, keep the device.
    Failed(String),
}

/// Classify an APNs response by status and its JSON `reason`. PURE.
pub fn classify(status: u16, body: &str) -> Outcome {
    if (200..300).contains(&status) {
        return Outcome::Delivered;
    }
    let reason = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("reason").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let label = if reason.is_empty() {
        format!("apns {status}")
    } else {
        format!("apns {status} {reason}")
    };
    match (status, reason.as_str()) {
        (410, _) | (400, "BadDeviceToken") => Outcome::Prune(label),
        (403, "ExpiredProviderToken" | "InvalidProviderToken") => Outcome::TokenRejected(label),
        _ => Outcome::Failed(label),
    }
}

/// Per-fan-out APNs counts, folded into the push attempt ring.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Tally {
    pub attempted: usize,
    pub delivered: usize,
    pub pruned: usize,
    pub failed: usize,
    /// The last failure's APNs status + reason (`apns 403 InvalidProviderToken`),
    /// the rollout diagnostic. Never a token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

// ── the fan-out ──────────────────────────────────────────────────────────────

/// Deliver `payload` to every registered APNs device. Called ONLY from the push
/// fan-out in [`crate::push`], after its mute gate, so it never decides whether
/// to send. Returns a zero tally (and does no network I/O) when APNs is not
/// configured or nobody registered.
pub async fn send(state: &AppState, payload: &PushPayload, session: Option<&str>) -> Tally {
    let apns = state.apns.clone();
    if !apns.configured() {
        return Tally::default();
    }
    let devices = match db::apns::list(&state.pool).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "apns: listing devices failed");
            return Tally::default();
        }
    };
    if devices.is_empty() {
        return Tally::default();
    }
    let mut tally = Tally {
        attempted: devices.len(),
        ..Tally::default()
    };
    let jwt = match apns.jwt() {
        Ok(t) => t,
        Err(e) => {
            tally.failed = devices.len();
            tally.last_error = Some(format!("apns token: {e}"));
            tracing::warn!(reason = %e, "apns: cannot sign a provider token");
            return tally;
        }
    };
    let session = payload.session.as_deref().or(session);
    let ask = resolve_ask(state, session, payload.tier).await;
    let now = chrono::Utc::now().timestamp();

    let sends = devices.iter().map(|d| {
        let body = build_payload(payload, session, &d.client_ref, ask.as_ref());
        send_one(&apns, &jwt, d, payload, body, now)
    });
    let outcomes = futures_util::future::join_all(sends).await;

    for (device, outcome) in devices.iter().zip(outcomes) {
        match outcome {
            Outcome::Delivered => tally.delivered += 1,
            Outcome::Prune(why) => {
                let _ = db::apns::delete(&state.pool, &device.device_token).await;
                tally.pruned += 1;
                tracing::info!(device = device.id, reason = %why, "apns: pruned a dead device token");
            }
            Outcome::TokenRejected(why) => {
                apns.forget_jwt();
                tally.failed += 1;
                tracing::warn!(device = device.id, reason = %why, "apns: provider token rejected");
                tally.last_error = Some(why);
            }
            Outcome::Failed(why) => {
                tally.failed += 1;
                tracing::warn!(device = device.id, reason = %why, "apns: delivery to one device failed");
                tally.last_error = Some(why);
            }
        }
    }
    tally
}

async fn send_one(
    apns: &Apns,
    jwt: &str,
    device: &db::apns::ApnsDevice,
    payload: &PushPayload,
    body: Value,
    now: i64,
) -> Outcome {
    let url = format!("{}/3/device/{}", apns.host_for(&device.environment), device.device_token);
    let mut req = apns
        .client
        .post(url)
        .header("authorization", format!("bearer {jwt}"))
        .json(&body);
    for (k, v) in alert_headers(apns.topic(), payload, now) {
        req = req.header(k, v);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            classify(status, &text)
        }
        // `without_url`: the URL carries the device token.
        Err(e) => Outcome::Failed(format!("apns request: {}", e.without_url())),
    }
}

/// The open, answerable ask an ATTENTION push is about, if any.
///
/// The hook raises the push a few ms before the ask row exists and before its
/// decision hook attaches, so when the session shows a live dialog this polls
/// for up to [`ASK_WAIT`]. Without a dialog it looks once and moves on.
async fn resolve_ask(state: &AppState, session: Option<&str>, tier: Tier) -> Option<AskRef> {
    let session = session?;
    if tier != Tier::Attention {
        return None;
    }
    let expect = state
        .session_activity(session)
        .map(|a| a.permission.is_some() || a.question_request.is_some() || a.elicitation.is_some())
        .unwrap_or(false);
    let deadline = Instant::now() + ASK_WAIT;
    loop {
        if let Some(found) = answerable_ask(state, session).await {
            return Some(found);
        }
        if !expect || Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(ASK_POLL).await;
    }
}

/// The newest open ask of `session` that the app can answer from a
/// notification action (`permission`, `question`, `elicitation`, with its
/// decision hook attached).
async fn answerable_ask(state: &AppState, session: &str) -> Option<AskRef> {
    let rows = db::asks::open_for_session(&state.pool, session, None).await.ok()?;
    rows.iter()
        .rev()
        .map(crate::asks::view)
        .find(|v| {
            v.answerable
                && matches!(
                    v.kind.as_str(),
                    crate::asks::KIND_PERMISSION
                        | crate::asks::KIND_QUESTION
                        | crate::asks::KIND_ELICITATION
                )
        })
        .map(|v| AskRef { id: v.id, kind: v.kind })
}

// ── routes (mounted inside the admin-only /api/push router) ──────────────────

pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/push/apns", get(get_apns))
        .route("/api/push/apns/register", post(register))
        .route("/api/push/apns/unregister", post(unregister))
        .with_state(state)
}

/// `GET /api/push/apns` — whether this server can send, the topic devices must
/// register with, and the registered devices (never their tokens).
async fn get_apns(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let devices = db::apns::list(&state.pool)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("list apns devices: {e}")))?;
    let devices: Vec<Value> = devices
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "device_name": d.device_name,
                "environment": d.environment,
                "app_version": d.app_version,
                "last_seen_ms": d.last_seen_at,
            })
        })
        .collect();
    Ok(Json(json!({
        "ok": true,
        "data": {
            "configured": state.apns.configured(),
            "topic": state.apns.topic(),
            "devices": devices,
        }
    })))
}

#[derive(Debug, Deserialize)]
pub struct RegisterBody {
    pub device_token: String,
    pub environment: String,
    pub bundle_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub app_version: Option<String>,
    pub client_ref: String,
}

/// A validated registration, ready to store.
#[derive(Debug, PartialEq, Eq)]
pub struct ValidRegistration {
    pub device_token: String,
    pub environment: &'static str,
    pub bundle_id: String,
    pub device_name: String,
    pub app_version: Option<String>,
    pub client_ref: String,
}

/// Normalise a hex device token (lowercase) or say why it is not one.
pub fn normalize_token(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.len() < TOKEN_HEX_MIN || t.len() > TOKEN_HEX_MAX || t.len() % 2 != 0 {
        return Err(format!(
            "device_token must be an even-length hex string of {TOKEN_HEX_MIN}-{TOKEN_HEX_MAX} characters"
        ));
    }
    if !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("device_token must be hex".into());
    }
    Ok(t.to_ascii_lowercase())
}

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

/// Validate a register body against this server's topic. PURE.
pub fn validate_register(b: &RegisterBody, topic: &str) -> Result<ValidRegistration, String> {
    let device_token = normalize_token(&b.device_token)?;
    let environment = match b.environment.trim() {
        ENV_SANDBOX => ENV_SANDBOX,
        ENV_PRODUCTION => ENV_PRODUCTION,
        other => return Err(format!("environment must be 'sandbox' or 'production', not '{other}'")),
    };
    let bundle_id = b.bundle_id.trim();
    if bundle_id != topic {
        return Err(format!(
            "bundle_id '{bundle_id}' does not match this server's APNs topic '{topic}'"
        ));
    }
    let client_ref = b.client_ref.trim();
    if client_ref.is_empty() || client_ref.chars().count() > CLIENT_REF_MAX || has_control(client_ref) {
        return Err(format!("client_ref must be 1-{CLIENT_REF_MAX} printable characters"));
    }
    let device_name = b.device_name.trim();
    if device_name.chars().count() > DEVICE_NAME_MAX || has_control(device_name) {
        return Err(format!("device_name must be at most {DEVICE_NAME_MAX} printable characters"));
    }
    let app_version = b
        .app_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(v) = app_version {
        if v.chars().count() > APP_VERSION_MAX || has_control(v) {
            return Err(format!("app_version must be at most {APP_VERSION_MAX} printable characters"));
        }
    }
    Ok(ValidRegistration {
        device_token,
        environment,
        bundle_id: bundle_id.to_string(),
        device_name: device_name.to_string(),
        app_version: app_version.map(str::to_string),
        client_ref: client_ref.to_string(),
    })
}

/// `POST /api/push/apns/register` — store (upsert on `device_token`) a device.
/// Works whether or not APNs is configured, so the app can register first.
async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<Value>, AppError> {
    let v = validate_register(&body, state.apns.topic()).map_err(AppError::BadRequest)?;
    let id = db::apns::upsert(
        &state.pool,
        &db::apns::NewDevice {
            device_token: &v.device_token,
            environment: v.environment,
            bundle_id: &v.bundle_id,
            device_name: &v.device_name,
            app_version: v.app_version.as_deref(),
            client_ref: &v.client_ref,
        },
        chrono::Utc::now().timestamp_millis(),
    )
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("store apns device: {e}")))?;
    tracing::info!(device = id, environment = v.environment, "apns device registered");
    Ok(Json(json!({ "ok": true, "data": { "id": id } })))
}

#[derive(Debug, Deserialize)]
struct UnregisterBody {
    device_token: String,
}

/// `POST /api/push/apns/unregister` — body `{device_token}`. Removing a token
/// that is not stored is not an error (`removed: false`).
async fn unregister(
    State(state): State<AppState>,
    Json(body): Json<UnregisterBody>,
) -> Result<Json<Value>, AppError> {
    let token = normalize_token(&body.device_token).map_err(AppError::BadRequest)?;
    let n = db::apns::delete(&state.pool, &token)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("remove apns device: {e}")))?;
    Ok(Json(json!({ "ok": true, "data": { "removed": n > 0 } })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use base64::Engine;
    use tower::ServiceExt;

    const TOPIC: &str = "com.supermux.app";

    fn tok(c: char) -> String {
        std::iter::repeat(c).take(64).collect()
    }

    fn payload(tier: Tier) -> PushPayload {
        PushPayload::simple("reviewer", "Run the tests?", "/agent/reviewer", tier)
            .for_session("reviewer", 2)
    }

    // ── payload mapping ──────────────────────────────────────────────────────

    #[test]
    fn attention_is_time_sensitive_with_sound() {
        let v = build_payload(&payload(Tier::Attention), None, "srv-a", None);
        assert_eq!(v["aps"]["interruption-level"], "time-sensitive");
        assert_eq!(v["aps"]["sound"], "default");
        assert_eq!(v["aps"]["category"], "BOT");
        assert_eq!(v["aps"]["badge"], 2);
        assert_eq!(v["aps"]["mutable-content"], 1);
        assert_eq!(v["aps"]["thread-id"], "reviewer");
        assert_eq!(v["aps"]["alert"]["title"], "reviewer");
        assert_eq!(v["aps"]["alert"]["body"], "Run the tests?");
        assert_eq!(v["smx"]["ref"], "srv-a");
        assert_eq!(v["smx"]["session"], "reviewer");
        assert_eq!(v["smx"]["url"], "/agent/reviewer");
        assert_eq!(v["smx"]["tier"], "attention");
        assert_eq!(v["smx"]["badge"], 2);
        assert!(v["smx"].get("ask_id").is_none());
        assert!(v["smx"].get("ask_kind").is_none());
    }

    #[test]
    fn error_has_sound_but_is_active() {
        let v = build_payload(&payload(Tier::Error), None, "r", None);
        assert_eq!(v["aps"]["interruption-level"], "active");
        assert_eq!(v["aps"]["sound"], "default");
    }

    #[test]
    fn unread_and_schedule_are_silent_and_active() {
        for tier in [Tier::Unread, Tier::Schedule] {
            let v = build_payload(&payload(tier), None, "r", None);
            assert_eq!(v["aps"]["interruption-level"], "active", "{tier:?}");
            assert!(v["aps"].get("sound").is_none(), "{tier:?} must not ring");
            assert_eq!(v["smx"]["tier"], tier.as_str());
        }
    }

    #[test]
    fn categories_follow_the_open_ask() {
        let ask = |kind: &str| AskRef { id: "ask_1".into(), kind: kind.into() };
        assert_eq!(category_for(None), "BOT");
        assert_eq!(category_for(Some(&ask("permission"))), "ASK_PERMISSION");
        assert_eq!(category_for(Some(&ask("question"))), "ASK_QUESTION");
        assert_eq!(category_for(Some(&ask("elicitation"))), "ASK_QUESTION");
        assert_eq!(category_for(Some(&ask("needs_input"))), "BOT");

        let v = build_payload(&payload(Tier::Attention), None, "r", Some(&ask("permission")));
        assert_eq!(v["aps"]["category"], "ASK_PERMISSION");
        assert_eq!(v["smx"]["ask_id"], "ask_1");
        assert_eq!(v["smx"]["ask_kind"], "permission");
    }

    #[test]
    fn a_session_less_payload_threads_under_supermux_or_the_gated_session() {
        let p = PushPayload::simple("workflow 'x' finished", "done", "/workflows", Tier::Schedule);
        let v = build_payload(&p, None, "r", None);
        assert_eq!(v["aps"]["thread-id"], "supermux");
        assert!(v["smx"].get("session").is_none());
        // The board / agent pings build a session-less payload about a bot.
        let p = PushPayload::simple("agent a needs you", "q", "/agent/a", Tier::Attention);
        let v = build_payload(&p, Some("a"), "r", None);
        assert_eq!(v["aps"]["thread-id"], "a");
        assert_eq!(v["smx"]["session"], "a");
    }

    #[test]
    fn headers_carry_type_topic_collapse_and_priority() {
        let h = alert_headers(TOPIC, &payload(Tier::Attention), 1_000);
        let get = |k: &str| h.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(get("apns-push-type").as_deref(), Some("alert"));
        assert_eq!(get("apns-topic").as_deref(), Some(TOPIC));
        assert_eq!(get("apns-collapse-id").as_deref(), Some("session:reviewer"));
        assert_eq!(get("apns-priority").as_deref(), Some("10"));
        assert_eq!(get("apns-expiration").as_deref(), Some("15400"));
    }

    #[test]
    fn a_long_tag_collapses_to_a_64_byte_digest() {
        let long = format!("session:{}", "x".repeat(100));
        let id = collapse_id(&long);
        assert_eq!(id.len(), 64);
        assert_ne!(id, collapse_id(&format!("{long}y")));
        assert_eq!(collapse_id("session:a"), "session:a");
    }

    // ── responses ────────────────────────────────────────────────────────────

    #[test]
    fn responses_classify_as_apple_documents_them() {
        assert_eq!(classify(200, ""), Outcome::Delivered);
        assert!(matches!(classify(410, r#"{"reason":"Unregistered"}"#), Outcome::Prune(_)));
        assert!(matches!(classify(400, r#"{"reason":"BadDeviceToken"}"#), Outcome::Prune(_)));
        assert!(matches!(
            classify(400, r#"{"reason":"DeviceTokenNotForTopic"}"#),
            Outcome::Failed(_)
        ));
        assert!(matches!(
            classify(403, r#"{"reason":"ExpiredProviderToken"}"#),
            Outcome::TokenRejected(_)
        ));
        assert_eq!(
            classify(429, r#"{"reason":"TooManyRequests"}"#),
            Outcome::Failed("apns 429 TooManyRequests".into())
        );
        assert_eq!(classify(503, "not json"), Outcome::Failed("apns 503".into()));
    }

    // ── JWT ──────────────────────────────────────────────────────────────────

    fn b64json(part: &str) -> Value {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part).unwrap();
        serde_json::from_slice(&raw).unwrap()
    }

    #[test]
    fn the_provider_token_is_es256_with_kid_iss_and_iat_only() {
        let key = ES256KeyPair::generate();
        let pem = key.to_pem().unwrap();
        let apns = Apns::for_test(&pem, "KEY123", "TEAM456", TOPIC, "http://unused");
        let jwt = apns.jwt().unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header = b64json(parts[0]);
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "KEY123");
        let claims = b64json(parts[1]);
        let obj = claims.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["iat", "iss"]);
        assert_eq!(claims["iss"], "TEAM456");
        let iat = claims["iat"].as_i64().unwrap();
        assert!((iat - chrono::Utc::now().timestamp()).abs() < 60);
        // The signature verifies with the key's public half.
        key.public_key()
            .verify_token::<NoCustomClaims>(&jwt, None)
            .expect("signature verifies");
        // Cached: the same token until it ages out or is rejected.
        assert_eq!(apns.jwt().unwrap(), jwt);
        apns.forget_jwt();
        assert!(apns.jwt().is_ok());
    }

    #[test]
    fn config_reads_file_keys_and_env_wins() {
        let file: ApnsConfig = toml::from_str(
            "bind = \"127.0.0.1:1\"\napns_key_path = \"AuthKey.p8\"\napns_key_id = \"K\"\napns_team_id = \"T\"\n",
        )
        .unwrap();
        assert_eq!(file.topic(), DEFAULT_TOPIC);
        let env = |k: &str| match k {
            "SUPERMUX_APNS_TOPIC" => Some("com.example.app".to_string()),
            "SUPERMUX_APNS_KEY_ID" => Some("  ".to_string()),
            _ => None,
        };
        let cfg = file.with_env(env);
        assert_eq!(cfg.topic(), "com.example.app");
        assert_eq!(cfg.apns_key_id.as_deref(), Some("K"), "a blank env value does not erase the file value");
        assert_eq!(
            cfg.key_path(Path::new("/data")).unwrap(),
            PathBuf::from("/data/AuthKey.p8"),
            "relative key paths live in the data dir"
        );
    }

    #[test]
    fn a_missing_key_leaves_apns_unconfigured() {
        let dir = std::env::temp_dir().join(format!("supermux-apns-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.toml"),
            "apns_key_path = \"missing.p8\"\napns_key_id = \"K\"\napns_team_id = \"T\"\n",
        )
        .unwrap();
        let cfg = ApnsConfig::with_env(
            toml::from_str(&std::fs::read_to_string(dir.join("config.toml")).unwrap()).unwrap(),
            |_| None,
        );
        assert!(load_signer(&cfg, &dir).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── validation ───────────────────────────────────────────────────────────

    fn body(token: &str, env: &str, bundle: &str, client_ref: &str) -> RegisterBody {
        RegisterBody {
            device_token: token.into(),
            environment: env.into(),
            bundle_id: bundle.into(),
            device_name: "Sander's iPhone".into(),
            app_version: Some("1.0 (3)".into()),
            client_ref: client_ref.into(),
        }
    }

    #[test]
    fn register_validation() {
        let ok = validate_register(&body(&tok('A'), "sandbox", TOPIC, "srv"), TOPIC).unwrap();
        assert_eq!(ok.device_token, tok('a'), "tokens are stored lowercase");
        assert_eq!(ok.environment, "sandbox");

        assert!(validate_register(&body("abcd", "sandbox", TOPIC, "srv"), TOPIC).is_err(), "too short");
        assert!(validate_register(&body(&tok('g'), "sandbox", TOPIC, "srv"), TOPIC).is_err(), "not hex");
        assert!(
            validate_register(&body(&format!("{}a", tok('a')), "sandbox", TOPIC, "srv"), TOPIC).is_err(),
            "odd length"
        );
        assert!(validate_register(&body(&tok('a'), "development", TOPIC, "srv"), TOPIC).is_err());
        assert!(validate_register(&body(&tok('a'), "production", "com.other", "srv"), TOPIC).is_err());
        assert!(validate_register(&body(&tok('a'), "production", TOPIC, ""), TOPIC).is_err());
        assert!(
            validate_register(&body(&tok('a'), "production", TOPIC, &"r".repeat(65)), TOPIC).is_err()
        );
        assert!(validate_register(&body(&tok('a'), "production", TOPIC, &"r".repeat(64)), TOPIC).is_ok());
        assert!(validate_register(&body(&tok('a'), "production", TOPIC, "a\nb"), TOPIC).is_err());
    }

    // ── routes + fan-out against a real AppState ─────────────────────────────

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-apns-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            swarm_reaper: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            company_isolation: Vec::new(),
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    async fn call(state: &AppState, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap();
        let resp = router_for(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn register_list_unregister_without_a_key() {
        let (state, dir) = test_state().await;
        let (s, v) = call(&state, "GET", "/api/push/apns", None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["data"]["configured"], false);
        assert_eq!(v["data"]["topic"], TOPIC);
        assert_eq!(v["data"]["devices"], json!([]));

        let reg = json!({
            "device_token": tok('b'), "environment": "production", "bundle_id": TOPIC,
            "device_name": "iPhone", "app_version": "1.0", "client_ref": "srv-a"
        });
        let (s, v) = call(&state, "POST", "/api/push/apns/register", Some(reg.clone())).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        let id = v["data"]["id"].as_i64().unwrap();
        let (_, v2) = call(&state, "POST", "/api/push/apns/register", Some(reg)).await;
        assert_eq!(v2["data"]["id"].as_i64(), Some(id), "upsert keeps the id");

        let (_, v) = call(&state, "GET", "/api/push/apns", None).await;
        let devs = v["data"]["devices"].as_array().unwrap();
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0]["device_name"], "iPhone");
        assert_eq!(devs[0]["environment"], "production");
        assert!(devs[0].get("device_token").is_none(), "tokens are never served");

        // Unconfigured: a fan-out does nothing, silently.
        let t = send(&state, &payload(Tier::Attention), None).await;
        assert_eq!(t, Tally::default());

        let (s, _) = call(
            &state,
            "POST",
            "/api/push/apns/register",
            Some(json!({"device_token": tok('c'), "environment": "prod", "bundle_id": TOPIC,
                        "device_name": "x", "client_ref": "r"})),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        let (s, v) = call(
            &state,
            "POST",
            "/api/push/apns/unregister",
            Some(json!({"device_token": tok('B')})),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["data"]["removed"], true);
        let (_, v) = call(&state, "GET", "/api/push/apns", None).await;
        assert_eq!(v["data"]["devices"], json!([]));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A stand-in for APNs: device token `bb…` is gone (410 Unregistered),
    /// `cc…` is a bad token (400), anything else is accepted. Records what it
    /// was sent so the test can check headers and body.
    async fn mock_apns() -> (String, Arc<Mutex<Vec<(String, Value, Value)>>>) {
        use axum::extract::Path as AxPath;
        use axum::http::HeaderMap;
        let seen: Arc<Mutex<Vec<(String, Value, Value)>>> = Arc::default();
        let rec = seen.clone();
        let app = Router::new().route(
            "/3/device/{token}",
            post(move |AxPath(token): AxPath<String>, headers: HeaderMap, Json(body): Json<Value>| {
                let rec = rec.clone();
                async move {
                    let h: serde_json::Map<String, Value> = headers
                        .iter()
                        .filter(|(k, _)| k.as_str().starts_with("apns-") || k.as_str() == "authorization")
                        .map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or(""))))
                        .collect();
                    rec.lock().unwrap().push((token.clone(), Value::Object(h), body));
                    if token.starts_with("bb") {
                        (StatusCode::GONE, r#"{"reason":"Unregistered","timestamp":1}"#)
                    } else if token.starts_with("cc") {
                        (StatusCode::BAD_REQUEST, r#"{"reason":"BadDeviceToken"}"#)
                    } else {
                        (StatusCode::OK, "")
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), seen)
    }

    #[tokio::test]
    async fn fan_out_delivers_and_prunes_dead_tokens() {
        let (mut state, dir) = test_state().await;
        let (base, seen) = mock_apns().await;
        let pem = ES256KeyPair::generate().to_pem().unwrap();
        state.apns = Arc::new(Apns::for_test(&pem, "KID", "TEAM", TOPIC, &base));

        for (t, env) in [(tok('a'), "production"), (tok('b'), "sandbox"), (tok('c'), "sandbox")] {
            db::apns::upsert(
                &state.pool,
                &db::apns::NewDevice {
                    device_token: &t,
                    environment: env,
                    bundle_id: TOPIC,
                    device_name: "d",
                    app_version: None,
                    client_ref: "srv-a",
                },
                1,
            )
            .await
            .unwrap();
        }

        let t = send(&state, &payload(Tier::Attention), None).await;
        assert_eq!(t.attempted, 3);
        assert_eq!(t.delivered, 1);
        assert_eq!(t.pruned, 2);
        assert_eq!(t.failed, 0);
        let left = db::apns::list(&state.pool).await.unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].device_token, tok('a'));

        let seen = seen.lock().unwrap().clone();
        let (_, headers, body) = seen.iter().find(|(tk, _, _)| *tk == tok('a')).unwrap();
        assert_eq!(headers["apns-push-type"], "alert");
        assert_eq!(headers["apns-topic"], TOPIC);
        assert_eq!(headers["apns-priority"], "10");
        assert_eq!(headers["apns-collapse-id"], "session:reviewer");
        assert!(headers["authorization"].as_str().unwrap().starts_with("bearer "));
        assert_eq!(body["smx"]["ref"], "srv-a");
        assert_eq!(body["aps"]["interruption-level"], "time-sensitive");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn push_test_reaches_apns_devices_and_records_the_attempt() {
        let (mut state, dir) = test_state().await;
        let (base, seen) = mock_apns().await;
        let pem = ES256KeyPair::generate().to_pem().unwrap();
        state.apns = Arc::new(Apns::for_test(&pem, "KID", "TEAM", TOPIC, &base));
        db::apns::upsert(
            &state.pool,
            &db::apns::NewDevice {
                device_token: &tok('d'),
                environment: "production",
                bundle_id: TOPIC,
                device_name: "d",
                app_version: None,
                client_ref: "r",
            },
            1,
        )
        .await
        .unwrap();
        // The Web Push gate mutes APNs too: a muted category reaches no device.
        db::push::set_pref(&state.pool, db::push::NotifCategory::AgentWaiting, false)
            .await
            .unwrap();
        let muted = crate::push::send_push_for(
            &state,
            db::push::NotifCategory::AgentWaiting,
            &payload(Tier::Attention),
            Some("reviewer"),
        )
        .await;
        assert_eq!(muted, 0);
        assert!(seen.lock().unwrap().is_empty(), "a muted push never reaches APNs");
        assert_eq!(state.push_attempts.snapshot()[0].muted, true);

        let delivered = crate::push::send_push_inner(&state, "test", "supermux test", "works", "/").await;
        assert_eq!(delivered, 1, "no web subscribers, one APNs device");
        assert_eq!(seen.lock().unwrap().len(), 1);
        let attempts = state.push_attempts.snapshot();
        assert_eq!(attempts.len(), 2, "the muted attempt and the test send");
        let a = serde_json::to_value(&attempts[0]).unwrap();
        assert_eq!(a["attempted"], 1);
        assert_eq!(a["delivered"], 1);
        assert_eq!(a["apns"]["delivered"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
