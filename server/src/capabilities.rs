//! `GET /api/capabilities` — what THIS build can do, for clients that talk to
//! servers of different versions (the native iOS app talks to two hosts).
//!
//! `/api/health` reports the Cargo version (the same on every build) and
//! `/api/version` is admin-only, so before this a client had to probe features
//! by 404. This route is readable by the owner AND by company members, does no
//! I/O, and answers with the build identity, a flat list of capability strings
//! and the few hard limits a client must respect. A 404 on this route itself
//! means "older server": the client falls back to probing by behaviour.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

/// One client-visible feature a client may gate on.
pub struct Capability {
    /// Stable snake_case name.
    pub name: &'static str,
    /// Whether this server offers it right now. Most entries are [`always`]; a
    /// feature that also needs runtime setup (a key, a config switch) supplies
    /// its own check. Must stay cheap and I/O-free: it runs on every request.
    pub enabled: fn(&AppState) -> bool,
}

/// For capabilities that ship unconditionally with the build.
const fn always(_: &AppState) -> bool {
    true
}

/// APNs can actually deliver: a readable key was configured at boot.
fn apns_configured(state: &AppState) -> bool {
    state.apns.configured()
}

/// THE registry — the only place capability strings are spelled.
///
/// APPEND-ONLY: add a string when a client-visible feature ships; never rename
/// or remove one (clients in the field match on these exact strings, and a
/// rename reads to them as the feature disappearing). A feature that needs
/// runtime setup gets its own `enabled` check instead of a different name.
pub const REGISTRY: &[Capability] = &[
    // This probe itself.
    Capability { name: "capabilities", enabled: always },
    // #243: every session row carries `host_id` (null = this host).
    Capability { name: "session_host_id", enabled: always },
    // #263: `POST /api/sessions` accepts the connectors to grant at creation.
    Capability { name: "create_session_connectors", enabled: always },
    // #268: native iOS push. `/api/push/apns/register` exists on every build; this
    // says pushes can really be SENT (an APNs key is configured).
    Capability { name: "apns", enabled: apns_configured },
    // #267: the chat WS accepts `{"type":"live",...}` and streams live frames.
    Capability { name: "chat_live", enabled: always },
    // #279: OAuth accepts `return_to=supermux://oauth/return` (the callback lands
    // back in the native app) and `complete` answers `status:"pending"` while the
    // callback has not arrived, so the app can poll it.
    Capability { name: "oauth_app_return", enabled: always },
];

/// The capability names this server offers right now, in registry order.
pub fn enabled(state: &AppState) -> Vec<&'static str> {
    REGISTRY
        .iter()
        .filter(|c| (c.enabled)(state))
        .map(|c| c.name)
        .collect()
}

pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/capabilities", get(get_capabilities))
        .with_state(state)
}

/// `GET /api/capabilities` — build identity (the same compile-time values as
/// `/api/version`), capabilities and limits. Compile-time and in-memory values
/// only: no DB, no disk, no network.
async fn get_capabilities(State(state): State<AppState>) -> Json<Value> {
    let v = crate::updates::version::VersionInfo::current();
    Json(json!({
        "ok": true,
        "data": {
            "tag": v.tag,
            "sha": v.sha,
            "build_time": v.build_time,
            "capabilities": enabled(&state),
            "limits": {
                // Largest decoded file `POST /api/upload` (base64 JSON) accepts.
                "upload_json_max_bytes": crate::files::UPLOAD_MAX,
                // Concurrent WebSocket subscribers per session (terminal and
                // chat); the next one is closed with 1013 "subscriber limit".
                "ws_subscribers_per_session": state.config.ws.subscribers_per_session,
            },
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth_human::AuthContext;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::middleware::from_fn;
    use tower::ServiceExt;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-caps-{}", uuid::Uuid::new_v4()));
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

    /// The capabilities route behind the same member backstop the protected
    /// router applies, plus an admin-only route to prove the layer is live.
    fn app(state: &AppState) -> Router {
        Router::new()
            .merge(router_for(state.clone()))
            .merge(
                crate::updates::router_for(state.clone())
                    .route_layer(from_fn(crate::scope::require_admin_mw)),
            )
            .route_layer(from_fn(crate::scope::member_allowlist_mw))
    }

    async fn get_as(state: &AppState, uri: &str, ctx: Option<AuthContext>) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        if let Some(ctx) = ctx {
            req.extensions_mut().insert(ctx);
        }
        let resp = app(state).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn member() -> AuthContext {
        AuthContext::Human {
            user_id: 9,
            company_id: Some(3),
            role: "member".into(),
        }
    }

    #[tokio::test]
    async fn the_route_shape_is_what_clients_decode() {
        let (state, dir) = test_state().await;
        let (s, v) = get_as(&state, "/api/capabilities", Some(AuthContext::Owner)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["ok"], true);
        let d = &v["data"];
        let info = crate::updates::version::VersionInfo::current();
        assert_eq!(d["sha"], info.sha.as_str());
        assert_eq!(d["build_time"], info.build_time.as_str());
        assert_eq!(d["tag"], json!(info.tag));
        let caps: Vec<&str> = d["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap())
            .collect();
        // No APNs key in the test config → no `apns`.
        assert_eq!(
            caps,
            vec!["capabilities", "session_host_id", "create_session_connectors", "chat_live", "oauth_app_return"]
        );
        assert_eq!(d["limits"]["upload_json_max_bytes"], 20 * 1024 * 1024);
        assert_eq!(d["limits"]["ws_subscribers_per_session"], 32);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_member_can_read_it_but_not_the_admin_version_route() {
        let (state, dir) = test_state().await;
        let (s, v) = get_as(&state, "/api/capabilities", Some(member())).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert!(v["data"]["capabilities"].is_array());
        // The same layer stack still hides the admin-only version route.
        let (s, _) = get_as(&state, "/api/version", Some(member())).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn apns_is_offered_only_once_a_key_is_configured() {
        let (mut state, dir) = test_state().await;
        assert!(!enabled(&state).contains(&"apns"));
        let pem = jwt_simple::prelude::ES256KeyPair::generate().to_pem().unwrap();
        state.apns = std::sync::Arc::new(crate::apns::Apns::for_test(
            &pem,
            "KEYID12345",
            "TEAMID1234",
            "com.supermux.app",
            "http://127.0.0.1:9",
        ));
        let caps = enabled(&state);
        assert!(caps.contains(&"apns"), "{caps:?}");
        assert_eq!(caps.last(), Some(&"oauth_app_return"), "registry order is kept");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn registry_names_are_unique_snake_case() {
        let mut seen = std::collections::HashSet::new();
        for c in REGISTRY {
            assert!(seen.insert(c.name), "duplicate capability '{}'", c.name);
            assert!(
                !c.name.is_empty()
                    && c.name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                "'{}' is not snake_case",
                c.name
            );
        }
    }
}
