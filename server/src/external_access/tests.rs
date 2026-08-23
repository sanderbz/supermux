//! Unit tests for the onboarding-wizard backend. Every Cloudflare call runs
//! through [`super::cf::MockCfApi`] and the connector unit through
//! [`super::systemd::MockConnectorHost`], so the whole flow is exercised WITHOUT a
//! live token or `systemctl --user`.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;

use super::cf::MockCfApi;
use super::systemd::MockConnectorHost;
use super::*;
use crate::auth_human::AuthContext;
use crate::config::{company_canonical_host, Config};
use crate::error::AppError;
use crate::scope::OptCtx;
use crate::state::AppState;

async fn test_state() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-ea-{}", uuid::Uuid::new_v4()));
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

/// Inject the deterministic Cloudflare mock, returning the concrete handle so a
/// test can read its call counters.
fn inject_cf(state: &AppState) -> Arc<MockCfApi> {
    let cf = Arc::new(MockCfApi::default());
    state.external_access.set_cf(cf.clone());
    cf
}

fn inject_host(state: &AppState) -> Arc<MockConnectorHost> {
    let host = Arc::new(MockConnectorHost::default());
    state.external_access.set_host(host.clone());
    host
}

/// Seed the chosen base domain (`example.com`) into the companion store and
/// hot-reload, so the host-deriving handlers have a base to resolve. Mirrors what
/// the `base-domain` endpoint does, without needing a CF token in every test.
async fn set_base(state: &AppState) {
    let mut cfg = store::read_or_default(&state.config.data_dir).unwrap();
    cfg.base_domain = Some("example.com".into());
    store::write_atomic(&state.config.data_dir, &cfg).unwrap();
    state.reload_human_auth().unwrap();
}

fn member() -> OptCtx {
    OptCtx(Some(AuthContext::Human {
        user_id: 9,
        company_id: Some(1),
        role: "member".into(),
    }))
}

async fn cleanup(state: AppState, dir: std::path::PathBuf) {
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

// ── cf-token ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn cf_token_valid_stores_0600_and_never_returns_the_token() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    let res = cf_token_handler(
        State(state.clone()),
        OptCtx(None),
        Json(CfTokenInput {
            token: "valid-cf-token".into(),
        }),
    )
    .await
    .expect("valid token accepted");
    assert!(res.0.data.valid);
    assert_eq!(res.0.data.account_id, "acct-123");
    // Stored 0600, and the RESPONSE carries no token field at all.
    let token_path = dir.join(super::CF_TOKEN_FILE);
    assert_eq!(
        std::fs::read_to_string(&token_path).unwrap().trim(),
        "valid-cf-token"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "cf token must be 0600");
    }
    let body = serde_json::to_string(&res.0.data).unwrap();
    assert!(!body.contains("valid-cf-token"), "token echoed in response: {body}");
    cleanup(state, dir).await;
}

#[tokio::test]
async fn cf_token_invalid_is_rejected_and_not_stored() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    let res = cf_token_handler(
        State(state.clone()),
        OptCtx(None),
        Json(CfTokenInput {
            token: "wrong-token".into(),
        }),
    )
    .await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    assert!(!dir.join(super::CF_TOKEN_FILE).exists(), "invalid token was stored");
    cleanup(state, dir).await;
}

#[tokio::test]
async fn cf_token_missing_scope_is_rejected() {
    let (state, dir) = test_state().await;
    let cf = Arc::new(MockCfApi {
        scopes_ok: false,
        ..Default::default()
    });
    state.external_access.set_cf(cf);
    let res = cf_token_handler(
        State(state.clone()),
        OptCtx(None),
        Json(CfTokenInput {
            token: "valid-cf-token".into(),
        }),
    )
    .await;
    match res {
        Err(AppError::BadRequest(msg)) => assert!(msg.contains("scope"), "msg: {msg}"),
        other => panic!("expected missing-scope BadRequest, got {other:?}"),
    }
    cleanup(state, dir).await;
}

// ── provision-tunnel (idempotent) ────────────────────────────────────────────

#[tokio::test]
async fn provision_tunnel_creates_once_and_reuses_on_rerun() {
    let (state, dir) = test_state().await;
    let cf = inject_cf(&state);
    let host = inject_host(&state);
    // Save a token + choose a base domain first (both required preconditions).
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;

    let first = provision_tunnel_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("first provision ok");
    assert_eq!(first.0.data.tunnel_id, "tunnel-xyz");
    assert_eq!(first.0.data.connector, "started");
    // The wildcard reachable host is derived from the chosen base domain.
    assert_eq!(first.0.data.reachable_host, "*.example.com");
    assert_eq!(cf.create_count(), 1, "created exactly once");

    // Re-run: the existing tunnel is reused, no second create.
    let second = provision_tunnel_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("second provision ok");
    assert_eq!(second.0.data.tunnel_id, "tunnel-xyz");
    assert_eq!(cf.create_count(), 1, "idempotent — no re-create");
    assert_eq!(host.provision_count(), 2, "connector re-provisioned (idempotent)");

    // Connector token written 0600, and the unit references it via
    // EnvironmentFile — the secret is NEVER inline in the unit.
    let tok_path = dir.join(super::CONNECTOR_TOKEN_FILE);
    let tok_body = std::fs::read_to_string(&tok_path).unwrap();
    assert!(tok_body.contains("connector-token-secret"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&tok_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "connector token must be 0600");
    }
    let unit = host.recorded_unit_body().expect("unit recorded");
    assert!(unit.contains("EnvironmentFile="), "unit must reference the token file");
    assert!(
        !unit.contains("connector-token-secret"),
        "connector secret must NOT be inline in the unit: {unit}"
    );
    // The tunnel id is persisted (non-secret) so status can poll it.
    assert_eq!(
        std::fs::read_to_string(dir.join(super::TUNNEL_ID_FILE)).unwrap().trim(),
        "tunnel-xyz"
    );
    cleanup(state, dir).await;
}

#[tokio::test]
async fn provision_tunnel_without_a_saved_token_is_rejected() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    // Base is chosen but NO token saved → the token precondition fails.
    set_base(&state).await;
    let res = provision_tunnel_handler(State(state.clone()), OptCtx(None)).await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    cleanup(state, dir).await;
}

/// FAIL-CLOSED: a token is saved but the operator never chose a base domain, so
/// provisioning is refused — no tunnel, no DNS, no allowlist entry.
#[tokio::test]
async fn provision_without_a_base_domain_is_rejected() {
    let (state, dir) = test_state().await;
    let cf = inject_cf(&state);
    let _host = inject_host(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    // No set_base → require_base_domain rejects.
    let res = provision_tunnel_handler(State(state.clone()), OptCtx(None)).await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    assert_eq!(cf.create_count(), 0, "nothing provisioned without a base domain");
    assert!(
        !dir.join(super::TUNNEL_ID_FILE).exists(),
        "no tunnel id persisted"
    );
    cleanup(state, dir).await;
}

// ── zones + base-domain (the wizard's Choose-your-domain step) ────────────────

#[tokio::test]
async fn zones_lists_the_tokens_zones() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    let res = zones_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("zones ok");
    assert_eq!(res.0.data.zones, vec!["example.com".to_string()]);
    cleanup(state, dir).await;
}

#[tokio::test]
async fn zones_without_a_saved_token_is_rejected() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    let res = zones_handler(State(state.clone()), OptCtx(None)).await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    cleanup(state, dir).await;
}

#[tokio::test]
async fn set_base_domain_persists_and_hot_reloads() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    assert!(state.human_auth_cfg().base_domain.is_none(), "starts unset");

    let res = base_domain_handler(
        State(state.clone()),
        OptCtx(None),
        Json(BaseDomainInput {
            base_domain: "Example.com".into(),
        }),
    )
    .await
    .expect("base-domain ok");
    assert_eq!(res.0.data.base_domain, "example.com", "lower-cased");

    // Persisted to the companion store.
    let stored = store::read(&dir).unwrap().unwrap();
    assert_eq!(stored.base_domain.as_deref(), Some("example.com"));
    // Hot-reloaded into the live config (no restart).
    assert_eq!(
        state.human_auth_cfg().base_domain.as_deref(),
        Some("example.com")
    );
    cleanup(state, dir).await;
}

/// FAIL-CLOSED: a domain the token does NOT control is rejected, and neither the
/// store nor the live config is touched — a typo can never open the allowlist.
#[tokio::test]
async fn set_base_domain_rejects_a_domain_not_in_the_token_zones() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();

    let res = base_domain_handler(
        State(state.clone()),
        OptCtx(None),
        Json(BaseDomainInput {
            base_domain: "evil.example".into(),
        }),
    )
    .await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    assert!(
        store::read(&dir).unwrap().and_then(|c| c.base_domain).is_none(),
        "store not written for an uncontrolled domain"
    );
    assert!(
        state.human_auth_cfg().base_domain.is_none(),
        "live config unchanged"
    );
    cleanup(state, dir).await;
}

/// A syntactically-bogus base domain is rejected before any zone lookup.
#[tokio::test]
async fn set_base_domain_rejects_a_malformed_domain() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    for bad in ["nodot", "*.example.com", "https://example.com", "a b.com"] {
        let res = base_domain_handler(
            State(state.clone()),
            OptCtx(None),
            Json(BaseDomainInput {
                base_domain: bad.into(),
            }),
        )
        .await;
        assert!(matches!(res, Err(AppError::BadRequest(_))), "{bad}: {res:?}");
    }
    cleanup(state, dir).await;
}

// ── google config (0600 secret + hot-reload) ─────────────────────────────────

#[tokio::test]
async fn google_save_writes_0600_secret_and_hot_reloads_client_id() {
    let (state, dir) = test_state().await;
    assert!(state.human_auth_cfg().google_client_id.is_none(), "starts unconfigured");

    let res = google_handler(
        State(state.clone()),
        OptCtx(None),
        Json(GoogleInput {
            client_id: "cid-123.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-shh".into(),
        }),
    )
    .await
    .expect("google save ok");
    assert!(res.0.data.configured);

    // Secret 0600 at the loader path, never echoed.
    let sec_path = dir.join(super::GOOGLE_SECRET_FILE);
    assert_eq!(std::fs::read_to_string(&sec_path).unwrap().trim(), "GOCSPX-shh");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&sec_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "google secret must be 0600");
    }
    let body = serde_json::to_string(&res.0.data).unwrap();
    assert!(!body.contains("GOCSPX-shh"), "secret echoed: {body}");

    // Hot-reload: the live config now carries the client id (no restart).
    assert_eq!(
        state.human_auth_cfg().google_client_id.as_deref(),
        Some("cid-123.apps.googleusercontent.com")
    );
    cleanup(state, dir).await;
}

#[tokio::test]
async fn google_save_rejects_a_non_google_client_id() {
    let (state, dir) = test_state().await;
    let res = google_handler(
        State(state.clone()),
        OptCtx(None),
        Json(GoogleInput {
            client_id: "not-a-google-id".into(),
            client_secret: "GOCSPX-shh".into(),
        }),
    )
    .await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    assert!(!dir.join(super::GOOGLE_SECRET_FILE).exists(), "secret written for bad id");
    cleanup(state, dir).await;
}

// ── company host derive (+ hot-reload) ───────────────────────────────────────

#[tokio::test]
async fn company_host_derives_slug_dot_base_domain_and_reloads() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let res = host_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .expect("host derive ok");
    assert_eq!(res.0.data.host, "acme.example.com");
    assert_eq!(res.0.data.redirect_uri, "https://acme.example.com/auth/callback");
    // Hot-reloaded: the live config resolves the canonical host to this company.
    let e = state
        .human_auth_cfg()
        .host_entry("acme.example.com")
        .cloned()
        .expect("host entry live");
    assert!(e.is_canonical_for("acme", co.id, "example.com"));
    cleanup(state, dir).await;
}

/// FAIL-CLOSED: deriving a company host without a chosen base domain is refused,
/// so no `company_hosts` entry is ever written (and the WS Origin gate stays shut).
#[tokio::test]
async fn company_host_without_a_base_domain_is_rejected() {
    let (state, dir) = test_state().await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let res = host_handler(State(state.clone()), OptCtx(None), Path(co.id)).await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    assert!(
        state.human_auth_cfg().company_hosts.is_empty(),
        "no allowlist entry written without a base domain"
    );
    cleanup(state, dir).await;
}

// ── verify-login (redirect_uri_mismatch) ─────────────────────────────────────

#[tokio::test]
async fn verify_login_surfaces_redirect_uri_mismatch_then_goes_green() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    // Configure Google (so the failure is genuinely the redirect, not "no google").
    let _ = google_handler(
        State(state.clone()),
        OptCtx(None),
        Json(GoogleInput {
            client_id: "cid-123.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-shh".into(),
        }),
    )
    .await
    .unwrap();

    // Before the host entry exists: mismatch, with the EXACT URI to register.
    let miss = verify_login_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .unwrap();
    assert!(!miss.0.data.ok);
    assert!(miss.0.data.detail.contains("redirect_uri_mismatch"));
    assert_eq!(miss.0.data.redirect_uri, "https://acme.example.com/auth/callback");
    assert!(miss.0.data.detail.contains("https://acme.example.com/auth/callback"));

    // After writing the host entry: green.
    let _ = host_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .unwrap();
    let ok = verify_login_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .unwrap();
    assert!(ok.0.data.ok, "verify should be green after host is written: {:?}", ok.0.data.detail);
    cleanup(state, dir).await;
}

// ── humans (insert / list / delete + login_url) ──────────────────────────────

#[tokio::test]
async fn humans_insert_list_delete_roundtrip_with_login_url() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    // Insert a member.
    let added = add_human_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Json(AddHumanInput {
            email: "Bob@Acme.test".into(),
            role: "member".into(),
            display_name: None,
        }),
    )
    .await
    .expect("add ok");
    assert_eq!(added.0.data.user.email, "bob@acme.test", "email lowercased");
    assert_eq!(added.0.data.user.company_id, Some(co.id));
    assert_eq!(
        added.0.data.login_url,
        format!("https://{}", company_canonical_host("acme", "example.com"))
    );
    let hid = added.0.data.user.id;

    // A bad role is rejected.
    let bad = add_human_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Json(AddHumanInput {
            email: "x@acme.test".into(),
            role: "superuser".into(),
            display_name: None,
        }),
    )
    .await;
    assert!(matches!(bad, Err(AppError::BadRequest(_))), "bad role: {bad:?}");

    // A malformed email is rejected.
    let bad_email = add_human_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Json(AddHumanInput {
            email: "not-an-email".into(),
            role: "member".into(),
            display_name: None,
        }),
    )
    .await;
    assert!(matches!(bad_email, Err(AppError::BadRequest(_))), "bad email: {bad_email:?}");

    // List → one invitee, status "invited" (never logged in).
    let listed = list_humans_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .expect("list ok");
    assert_eq!(listed.0.data.len(), 1);
    assert_eq!(listed.0.data[0].status, "invited");

    // Delete → gone.
    let del = delete_human_handler(State(state.clone()), OptCtx(None), Path((co.id, hid)))
        .await
        .expect("delete ok");
    assert!(del.0.data.deleted);
    let after = list_humans_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .unwrap();
    assert!(after.0.data.is_empty(), "row removed");
    cleanup(state, dir).await;
}

// ── member 404 on EVERY wizard endpoint ──────────────────────────────────────

#[tokio::test]
async fn member_gets_uniform_404_on_every_wizard_endpoint() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    let _host = inject_host(&state);
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    macro_rules! assert_404 {
        ($e:expr) => {
            match $e.await {
                Err(AppError::NotFound(_)) => {}
                other => panic!("expected NotFound for a member, got {:?}", other.map(|_| ())),
            }
        };
    }

    assert_404!(cf_token_handler(
        State(state.clone()),
        member(),
        Json(CfTokenInput { token: "valid-cf-token".into() })
    ));
    assert_404!(provision_tunnel_handler(State(state.clone()), member()));
    assert_404!(status_handler(
        State(state.clone()),
        member(),
        Query(StatusQuery { company_id: None })
    ));
    assert_404!(zones_handler(State(state.clone()), member()));
    assert_404!(base_domain_handler(
        State(state.clone()),
        member(),
        Json(BaseDomainInput { base_domain: "example.com".into() })
    ));
    assert_404!(google_handler(
        State(state.clone()),
        member(),
        Json(GoogleInput {
            client_id: "cid-123.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-shh".into(),
        })
    ));
    assert_404!(host_handler(State(state.clone()), member(), Path(co.id)));
    assert_404!(verify_login_handler(State(state.clone()), member(), Path(co.id)));
    assert_404!(add_human_handler(
        State(state.clone()),
        member(),
        Path(co.id),
        Json(AddHumanInput {
            email: "x@acme.test".into(),
            role: "member".into(),
            display_name: None,
        })
    ));
    assert_404!(list_humans_handler(State(state.clone()), member(), Path(co.id)));
    assert_404!(delete_human_handler(State(state.clone()), member(), Path((co.id, 1))));

    // A member changed NOTHING: no secret files, no store, no live config.
    assert!(!dir.join(super::CF_TOKEN_FILE).exists());
    assert!(!dir.join(super::GOOGLE_SECRET_FILE).exists());
    assert!(state.human_auth_cfg().google_client_id.is_none());
    cleanup(state, dir).await;
}

// ── status ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn status_reports_box_and_company_fields() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    // Base chosen, nothing else configured yet.
    let s = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: Some(co.id) }),
    )
    .await
    .expect("status ok");
    assert_eq!(s.0.data.box_status.cf_token, "none");
    assert_eq!(s.0.data.box_status.tunnel, "none");
    assert_eq!(s.0.data.box_status.google, "unset");
    assert_eq!(s.0.data.box_status.base_domain.as_deref(), Some("example.com"));
    let c = s.0.data.company.expect("company block");
    assert_eq!(c.host, "acme.example.com");
    assert!(!c.company_host_written);

    // Configure google + host → status reflects it live.
    let _ = google_handler(
        State(state.clone()),
        OptCtx(None),
        Json(GoogleInput {
            client_id: "cid-123.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-shh".into(),
        }),
    )
    .await
    .unwrap();
    let _ = host_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .unwrap();
    let s2 = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: Some(co.id) }),
    )
    .await
    .unwrap();
    assert_eq!(s2.0.data.box_status.google, "configured");
    let c2 = s2.0.data.company.unwrap();
    assert!(c2.company_host_written);
    assert_eq!(c2.redirect_registered, "ok");
    cleanup(state, dir).await;
}

/// With no base domain chosen, status returns a benign "not configured" company
/// block (empty host, not written, not reachable) — never a fake host.
#[tokio::test]
async fn status_without_a_base_domain_is_benign() {
    let (state, dir) = test_state().await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let s = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: Some(co.id) }),
    )
    .await
    .expect("status ok");
    assert!(s.0.data.box_status.base_domain.is_none());
    let c = s.0.data.company.expect("company block");
    assert_eq!(c.host, "", "no fake host without a base domain");
    assert!(!c.company_host_written);
    assert!(!c.reachable);
    assert_eq!(c.redirect_registered, "unknown");
    cleanup(state, dir).await;
}

// ── WS Origin fail-closed contract ───────────────────────────────────────────

/// The single source of truth for the WS Origin gate is `company_hosts`. A
/// configured company host is an allowed Origin; with no base domain chosen
/// nothing is ever written there, so the same Origin is REJECTED (fail-closed —
/// a wrong/unset base never widens the allowlist).
#[tokio::test]
async fn ws_origin_honours_the_company_host_only_once_a_base_is_configured() {
    use axum::http::header::{HeaderMap, HeaderValue, ORIGIN};

    let (state, dir) = test_state().await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    let mut headers = HeaderMap::new();
    headers.insert(
        ORIGIN,
        HeaderValue::from_static("https://acme.example.com"),
    );

    // Unset base: no company_hosts entry → the Origin is rejected.
    assert!(
        !crate::ws::origin_allowed(&state, &headers),
        "external origin must be rejected with no base domain (fail-closed)"
    );

    // Choose the base + write the host → the Origin is now allowed.
    set_base(&state).await;
    let _ = host_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .unwrap();
    assert!(
        crate::ws::origin_allowed(&state, &headers),
        "configured company host must be an allowed WS Origin"
    );
    cleanup(state, dir).await;
}
