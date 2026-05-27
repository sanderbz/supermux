//! Web push notifications — VAPID keypair, subscription endpoints, and the
//! server-side `send_push` fan-out (PUSH milestone; spec TRACK 2).
//!
//! **What this gives the user.** Their phone (or any installed PWA / desktop
//! browser) gets a notification the moment an agent needs them — it transitions
//! to `Waiting` (blocked on the user) or hits an error — even when the app is
//! closed. The trigger fires once per transition (see
//! [`crate::sessions::auto_actions`]); this module is the transport.
//!
//! **VAPID keypair (§ once, persisted).** A P-256 (ES256) keypair is generated
//! ONCE on first start and persisted to `<data_dir>/vapid_private.key` as the
//! raw 32-byte private scalar, base64url-encoded, mode `0o600`. The PUBLIC key
//! (uncompressed point, base64url) is what the browser needs as
//! `applicationServerKey`; it is derived from the private key and served by
//! `GET /api/push/key`. The PRIVATE key is NEVER served, NEVER logged.
//!
//! **No native TLS.** `web-push` is pulled in with `default-features = false`
//! (no isahc/curl, no openssl): we build the RFC8291-encrypted message here and
//! POST it with the project's rustls `reqwest`, matching the rest of the TLS
//! stack.
//!
//! **Subscriptions are user data.** A stored `PushSubscription` is a capability
//! to push to a device — `endpoint`/`p256dh`/`auth` are never logged. A push
//! endpoint the service reports `404`/`410 Gone` for is pruned automatically so
//! dead devices don't accumulate.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use web_push::{
    ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushMessageBuilder,
};

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

/// Filename of the persisted raw VAPID private key (base64url of 32 bytes).
const VAPID_KEY_FILE: &str = "vapid_private.key";

/// Fallback VAPID `sub` claim when `config.push_sub` is unset. `example.com` is
/// RFC 2606-reserved so this parses cleanly through every known push service's
/// JWT validator (including Apple's APNs, which is the strict one), while
/// being clearly bogus — `init_vapid` logs a warning so any real iPhone
/// deployment notices it and sets `push_sub` to a real contact mailto.
const DEFAULT_VAPID_SUB: &str = "mailto:noreply@example.com";

/// TTL handed to the push service: how long it should hold an undelivered
/// notification (the user's phone is offline). 4h is plenty for an "agent needs
/// you" ping — beyond that the prompt is stale and silent expiry is fine.
const PUSH_TTL_SECS: u32 = 4 * 60 * 60;

/// The resolved VAPID keypair, computed once at startup and shared via
/// [`AppState`]. Holds the raw private key (base64url) used to sign every push
/// and the derived public key (base64url) handed to the browser.
#[derive(Clone)]
pub struct Vapid {
    /// Raw private scalar, base64url (no padding). Signing material — NEVER
    /// served to a client, NEVER logged.
    private_b64: String,
    /// Uncompressed public point, base64url (no padding). The browser's
    /// `applicationServerKey`. Safe to serve.
    pub public_b64: String,
    /// VAPID JWT `sub` claim used on every signed push (RFC 8292). APNs
    /// (iPhone) rejects bogus mailtos like `@localhost` with 400 — operators
    /// set this via `config.toml` (`push_sub = "mailto:you@example.org"`) or
    /// the `SUPERMUX_PUSH_SUB` env override.
    sub: String,
}

impl Vapid {
    /// Load the persisted VAPID keypair, generating + persisting one on first
    /// run (mode `0o600`). Called once from `main`/`AppState::new`.
    pub fn load_or_generate(data_dir: &Path, sub: String) -> anyhow::Result<Self> {
        let path = data_dir.join(VAPID_KEY_FILE);
        let private_b64 = if path.exists() {
            std::fs::read_to_string(&path)
                .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?
                .trim()
                .to_string()
        } else {
            let generated = generate_private_b64();
            write_0600(&path, &generated)
                .map_err(|e| anyhow::anyhow!("writing {}: {e}", path.display()))?;
            generated
        };
        let public_b64 = derive_public_b64(&private_b64)
            .map_err(|e| anyhow::anyhow!("deriving VAPID public key: {e}"))?;
        Ok(Self {
            private_b64,
            public_b64,
            sub,
        })
    }
}

/// Generate a fresh ES256 (P-256) private key, returned as the raw 32-byte
/// scalar base64url-encoded — the form `VapidSignatureBuilder::from_base64`
/// expects.
fn generate_private_b64() -> String {
    let key = jwt_simple::algorithms::ES256KeyPair::generate();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.to_bytes())
}

/// Derive the uncompressed public key (base64url) from the raw base64url private
/// key — the value handed to the browser as `applicationServerKey`.
fn derive_public_b64(private_b64: &str) -> Result<String, web_push::WebPushError> {
    let builder = VapidSignatureBuilder::from_base64_no_sub(private_b64)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(builder.get_public_key()))
}

/// Write `contents` to `path` with `0o600` perms on Unix (the VAPID private key
/// must never be world-readable). Mirrors `config::write_token_0600`.
fn write_0600(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(contents.as_bytes())?;
        f.write_all(b"\n")?;
        f.flush()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, format!("{contents}\n"))?;
    }
    Ok(())
}

/// Build the push sub-router. Mounted INSIDE the bearer layer (single-user
/// dashboard) by [`crate::http::protected_router`].
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/push/key", get(get_key))
        .route("/api/push/subscribe", post(subscribe))
        .route("/api/push/unsubscribe", post(unsubscribe))
        .route("/api/push/test", post(test_push))
        .with_state(state)
}

/// `GET /api/push/key` — the VAPID PUBLIC key (base64url) the browser passes to
/// `pushManager.subscribe({ applicationServerKey })`. Also reports whether any
/// device is currently subscribed so Settings can render the enabled state. The
/// private key is never part of this (or any) response.
async fn get_key(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let subscribed = db::push::count(&state.pool).await? > 0;
    Ok(Json(json!({
        "ok": true,
        "data": { "key": state.vapid.public_b64, "subscribed": subscribed }
    })))
}

/// The browser `PushSubscription` shape POSTed by the client. Matches
/// `subscription.toJSON()` (`{ endpoint, keys: { p256dh, auth } }`).
#[derive(Debug, Deserialize)]
struct SubscribeBody {
    endpoint: String,
    keys: SubscribeKeys,
}

#[derive(Debug, Deserialize)]
struct SubscribeKeys {
    p256dh: String,
    auth: String,
}

/// `POST /api/push/subscribe` — store (upsert) a browser PushSubscription.
async fn subscribe(
    State(state): State<AppState>,
    Json(body): Json<SubscribeBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    if body.endpoint.trim().is_empty()
        || body.keys.p256dh.trim().is_empty()
        || body.keys.auth.trim().is_empty()
    {
        return Err(AppError::BadRequest(
            "subscription endpoint and keys are required".into(),
        ));
    }
    db::push::upsert(&state.pool, &body.endpoint, &body.keys.p256dh, &body.keys.auth).await?;
    // Subscription fields are a push capability — never log them.
    tracing::info!("push subscription stored");
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/push/unsubscribe` — body `{ endpoint }`. Remove a stored
/// subscription (the Settings toggle's disable path).
#[derive(Debug, Deserialize)]
struct UnsubscribeBody {
    endpoint: String,
}

async fn unsubscribe(
    State(state): State<AppState>,
    Json(body): Json<UnsubscribeBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    db::push::delete(&state.pool, &body.endpoint).await?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/push/test` — fire a "supermux push test" notification at every
/// stored subscription. The whole point: let an operator who just enabled the
/// Settings toggle verify the path end-to-end without scripting a Claude
/// session into `Waiting` or triggering a board `needs-input`. The transition
/// hooks are the only OTHER paths that call `send_push`, so before this
/// endpoint there was literally no way for an iPhone user to confirm anything
/// after the permission popup. Reports the number of devices the push reached
/// — `0` here on a fresh enable is a clear signal that the VAPID `sub`
/// (`config.push_sub`) is wrong for the user's push service (notably APNs).
async fn test_push(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let delivered = send_push(
        &state,
        "supermux test",
        "Push notifications work — tap to open the dashboard.",
        "/",
    )
    .await;
    Ok(Json(json!({ "ok": true, "data": { "delivered": delivered } })))
}

/// Notification payload delivered to the service worker. The SW reads `title` /
/// `body` for the notification and `url` for the `notificationclick` deep-link.
#[derive(serde::Serialize)]
struct PushPayload<'a> {
    title: &'a str,
    body: &'a str,
    url: &'a str,
}

/// Send a notification to EVERY stored subscription. Best-effort: each device is
/// sent independently, a per-device failure is logged at debug, and an endpoint
/// the push service reports `404`/`410 Gone` for is pruned from the DB so dead
/// devices don't accumulate. Returns the number of devices the push reached.
///
/// `url` is an app-relative path (e.g. `/focus/<session>`) the SW opens on tap.
/// No-op (no DB scan beyond a count, no network) when nobody is subscribed.
pub async fn send_push(state: &AppState, title: &str, body: &str, url: &str) -> usize {
    let subs = match db::push::list(&state.pool).await {
        Ok(subs) => subs,
        Err(e) => {
            // Failing to list subs means NO push goes out — surface at warn so it's
            // visible at default log level (the user's only diagnosis channel).
            tracing::warn!(error = %e, "send_push: listing subscriptions failed");
            return 0;
        }
    };
    if subs.is_empty() {
        return 0;
    }

    let total = subs.len();
    let payload = serde_json::to_vec(&PushPayload { title, body, url }).unwrap_or_default();
    let client = reqwest::Client::new();
    let mut delivered = 0usize;
    let mut pruned = 0usize;
    let mut failed = 0usize;

    for sub in subs {
        // Per-device origin (the push-service host, NOT user data: APNs is
        // `web.push.apple.com`, FCM is `fcm.googleapis.com`, etc) — useful to
        // diagnose service-specific failures without ever exposing the per-device
        // path or keys.
        let origin = sub
            .endpoint
            .splitn(4, '/')
            .nth(2)
            .unwrap_or("")
            .to_string();
        match send_one(&client, &state.vapid, &sub, &payload).await {
            Ok(()) => delivered += 1,
            Err(SendError::Gone) => {
                // The device unsubscribed / uninstalled — prune the dead endpoint.
                let _ = db::push::delete(&state.pool, &sub.endpoint).await;
                pruned += 1;
                tracing::info!(origin = %origin, "send_push: pruned a gone push endpoint");
            }
            Err(SendError::Other(msg)) => {
                failed += 1;
                // Surface at warn — a silent debug log here is exactly why "I
                // never got a notification" had no diagnosable trail. The
                // reason carries the push-service status / encryption error,
                // never the subscription fields (those are user data).
                tracing::warn!(
                    origin = %origin,
                    reason = %msg,
                    "send_push: delivery to one device failed",
                );
            }
        }
    }
    // One-line fan-out summary at INFO so any push attempt is observable in the
    // default-level service journal (matches the existing "push subscription
    // stored" cadence — one info per user-visible event).
    tracing::info!(
        attempted = total,
        delivered,
        pruned,
        failed,
        "send_push: fan-out complete",
    );
    delivered
}

/// Outcome of a single-device push that the caller branches on.
enum SendError {
    /// The push service says this endpoint is gone (404/410) — prune it.
    Gone,
    /// Any other failure (encryption, network, server error) — log + skip.
    Other(String),
}

/// Encrypt + POST one notification to a single subscription. Splits out so the
/// fan-out can branch on the Gone vs transient outcome.
async fn send_one(
    client: &reqwest::Client,
    vapid: &Vapid,
    sub: &db::push::PushSubscription,
    payload: &[u8],
) -> Result<(), SendError> {
    let info = SubscriptionInfo::new(&sub.endpoint, &sub.p256dh, &sub.auth);

    // VAPID signature for THIS endpoint. The `sub` claim is required by every
    // push service per RFC 8292 — Apple's APNs is strictest and rejects
    // syntactically valid but non-routable values like `mailto:user@localhost`
    // with 400 BadRequest. The value comes from `config.push_sub` (or the
    // SUPERMUX_PUSH_SUB env override) and is set up in `init_vapid`.
    let mut sig_builder = VapidSignatureBuilder::from_base64(&vapid.private_b64, &info)
        .map_err(|e| SendError::Other(format!("vapid builder: {e}")))?;
    sig_builder.add_claim("sub", vapid.sub.as_str());
    let signature = sig_builder
        .build()
        .map_err(|e| SendError::Other(format!("vapid sign: {e}")))?;

    let mut msg_builder = WebPushMessageBuilder::new(&info);
    msg_builder.set_vapid_signature(signature);
    msg_builder.set_payload(ContentEncoding::Aes128Gcm, payload);
    msg_builder.set_ttl(PUSH_TTL_SECS);
    let message = msg_builder
        .build()
        .map_err(|e| SendError::Other(format!("encrypt: {e}")))?;

    // Build the outbound request from the encrypted message (we POST it
    // ourselves via rustls reqwest rather than the crate's bundled client).
    let mut req = client
        .post(message.endpoint.to_string())
        .header("TTL", message.ttl.to_string());

    if let Some(payload) = message.payload {
        req = req
            .header("Content-Encoding", payload.content_encoding.to_str())
            .header("Content-Type", "application/octet-stream");
        for (k, v) in payload.crypto_headers.into_iter() {
            req = req.header(k, v);
        }
        req = req.body(payload.content);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| SendError::Other(format!("request: {e}")))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
        Err(SendError::Gone)
    } else {
        Err(SendError::Other(format!("push service status {status}")))
    }
}

/// Build the shared [`Vapid`] for `AppState`. A failure to load/generate the
/// keypair is non-fatal for the rest of the server — push simply stays disabled
/// (the key endpoint returns an empty key and `send_push` no-ops because nobody
/// can subscribe without one), so the dashboard still boots.
pub fn init_vapid(data_dir: &Path, push_sub: Option<&str>) -> Arc<Vapid> {
    let sub = push_sub
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            // Operators with real iPhone subscribers should set this to a valid
            // contact mailto. Logging at `warn` so a real deploy notices it.
            tracing::warn!(
                fallback = DEFAULT_VAPID_SUB,
                "config.push_sub unset — using a placeholder VAPID `sub` claim. iPhone (APNs) \
                 may silently reject pushes signed with this value. Set `push_sub = \
                 \"mailto:you@example.org\"` in config.toml or export SUPERMUX_PUSH_SUB."
            );
            DEFAULT_VAPID_SUB.to_string()
        });
    match Vapid::load_or_generate(data_dir, sub) {
        Ok(v) => Arc::new(v),
        Err(e) => {
            tracing::warn!(error = %e, "VAPID keypair unavailable — web push disabled");
            Arc::new(Vapid {
                private_b64: String::new(),
                public_b64: String::new(),
                sub: DEFAULT_VAPID_SUB.to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keypair_roundtrips_to_a_public_key() {
        // A freshly generated private key must derive a non-empty uncompressed
        // public key (the browser's applicationServerKey). The uncompressed P-256
        // point is 65 bytes → 87 base64url chars (no padding).
        let priv_b64 = generate_private_b64();
        let pub_b64 = derive_public_b64(&priv_b64).expect("derive public key");
        assert!(!pub_b64.is_empty());
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&pub_b64)
            .expect("public key is valid base64url");
        assert_eq!(raw.len(), 65, "uncompressed P-256 point is 65 bytes");
        assert_eq!(raw[0], 0x04, "uncompressed point prefix");
    }

    #[test]
    fn load_or_generate_persists_and_is_stable() {
        let dir = std::env::temp_dir().join(format!("supermux-vapid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let first = Vapid::load_or_generate(&dir).expect("first load generates");
        // The key file exists with 0o600 perms (Unix).
        let path = dir.join(VAPID_KEY_FILE);
        assert!(path.exists(), "private key persisted");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "private key is 0600");
        }

        // A second load reads the SAME persisted key (stable public key across
        // restarts — existing subscriptions keep working).
        let second = Vapid::load_or_generate(&dir).expect("second load reads file");
        assert_eq!(first.public_b64, second.public_b64);
        assert!(!first.public_b64.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }
}
