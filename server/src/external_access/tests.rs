//! Unit tests for the onboarding-wizard backend. Every Cloudflare call runs
//! through [`super::cf::MockCfApi`] and the connector unit through
//! [`super::connector::MockConnectorHost`], so the whole flow is exercised WITHOUT a
//! live token or `systemctl --user`.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;

use super::cf::MockCfApi;
use super::quick::MockQuickTunnelHost;
use super::connector::MockConnectorHost;
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

/// Inject a quick-tunnel mock returning `url`, so provisioning never starts a real
/// tunnel or touches the network.
/// Inject a connector mock that reports NOT running, with a reason — the state
/// the wizard must render honestly instead of spinning forever.
fn inject_dead_host(state: &AppState, reason: &str) -> Arc<MockConnectorHost> {
    let host = Arc::new(MockConnectorHost::unavailable(reason));
    state.external_access.set_host(host.clone());
    host
}

fn inject_quick(state: &AppState, url: &str) -> Arc<MockQuickTunnelHost> {
    let q = Arc::new(MockQuickTunnelHost::with_url(url));
    state.external_access.set_quick(q.clone());
    q
}

/// A HeaderMap carrying an `Origin` (for the WS-origin gate assertions).
fn origin_headers(origin: &str) -> axum::http::HeaderMap {
    use axum::http::header::{HeaderValue, ORIGIN};
    let mut h = axum::http::HeaderMap::new();
    h.insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
    h
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
        // The message must NAME the permission to add — "something went wrong"
        // is what sent the owner back to Cloudflare guessing.
        Err(AppError::BadRequest(msg)) => assert!(
            msg.contains("missing a permission") && msg.contains("Cloudflare Tunnel"),
            "msg: {msg}"
        ),
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
    // ZERO DNS on a box with no company hosts yet — and NEVER a wildcard: the
    // operator's zone gets a record only when a company actually needs one.
    assert!(first.0.data.dns_records.is_empty(), "no records: {:?}", first.0.data.dns_records);
    assert_eq!(first.0.data.reachable_host, "");
    assert!(cf.dns_names().is_empty(), "provision wrote DNS: {:?}", cf.dns_names());
    assert!(
        cf.ingress_hosts().is_empty(),
        "ingress should be the 404 catch-all only: {:?}",
        cf.ingress_hosts()
    );
    assert_eq!(cf.create_count(), 1, "created exactly once");

    // Re-run: the existing tunnel is reused, no second create.
    let second = provision_tunnel_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("second provision ok");
    assert_eq!(second.0.data.tunnel_id, "tunnel-xyz");
    assert_eq!(cf.create_count(), 1, "idempotent — no re-create");
    assert_eq!(host.provision_count(), 2, "connector re-provisioned (idempotent)");

    // Connector token written 0600, in the `TUNNEL_TOKEN=…` env-file format the
    // BOOT RESUME reads back — that file is the only reason a reboot can bring
    // external access up again without the wizard.
    let tok_path = dir.join(super::CONNECTOR_TOKEN_FILE);
    let tok_body = std::fs::read_to_string(&tok_path).unwrap();
    assert_eq!(
        super::connector::parse_token_env(&tok_body).as_deref(),
        Some("connector-token-secret")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&tok_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "connector token must be 0600");
    }
    // The connector the handler asked for is the tunnel's own token.
    assert_eq!(host.last_token().as_deref(), Some("connector-token-secret"));
    // The tunnel id is persisted (non-secret) so status can poll it.
    assert_eq!(
        std::fs::read_to_string(dir.join(super::TUNNEL_ID_FILE)).unwrap().trim(),
        "tunnel-xyz"
    );
    cleanup(state, dir).await;
}

/// Bug 1, the wire half: when the connector does NOT come up, `provision` says
/// so — with the reason — instead of reporting a started connector nobody ran.
#[tokio::test]
async fn provision_reports_a_dead_connector_with_its_reason() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    let host = inject_dead_host(&state, "could not start /home/x/bin/cloudflared: No such file");
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;

    let r = provision_tunnel_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("provision ok");
    assert_eq!(r.0.data.connector, "unavailable");
    assert!(
        r.0.data
            .connector_detail
            .as_deref()
            .unwrap_or("")
            .contains("could not start"),
        "the reason must reach the wizard: {:?}",
        r.0.data.connector_detail
    );
    assert_eq!(host.provision_count(), 1);
    cleanup(state, dir).await;
}

/// **Boot resume.** A provisioned box (tunnel id + token env-file on disk) must
/// start its connector on server boot — a reboot used to leave external access
/// down until someone ran `cloudflared` by hand.
#[tokio::test]
async fn boot_resume_starts_the_connector_on_a_provisioned_box() {
    let (state, dir) = test_state().await;
    let host = inject_host(&state);
    crate::config::write_token_0600(&dir.join(super::TUNNEL_ID_FILE), "tunnel-xyz").unwrap();
    crate::config::write_token_0600(
        &dir.join(super::CONNECTOR_TOKEN_FILE),
        &super::connector::token_env_body("boot-token-secret"),
    )
    .unwrap();

    super::resume_connector_on_boot(&state).await;

    assert_eq!(host.provision_count(), 1, "the connector is started on boot");
    assert_eq!(
        host.last_token().as_deref(),
        Some("boot-token-secret"),
        "with the token from the 0600 env-file"
    );
    cleanup(state, dir).await;
}

/// …and starts NOTHING on a box that was never provisioned (or whose token file
/// is missing/unreadable). Booting must never spawn a token-less connector.
#[tokio::test]
async fn boot_resume_is_a_no_op_without_a_provisioned_tunnel() {
    let (state, dir) = test_state().await;
    let host = inject_host(&state);

    // Nothing on disk at all.
    super::resume_connector_on_boot(&state).await;
    assert_eq!(host.provision_count(), 0);

    // A tunnel id but no connector token ⇒ still nothing (never an empty token).
    crate::config::write_token_0600(&dir.join(super::TUNNEL_ID_FILE), "tunnel-xyz").unwrap();
    super::resume_connector_on_boot(&state).await;
    assert_eq!(host.provision_count(), 0);

    // A token file that carries no TUNNEL_TOKEN line is not a token either.
    crate::config::write_token_0600(&dir.join(super::CONNECTOR_TOKEN_FILE), "# nothing here").unwrap();
    super::resume_connector_on_boot(&state).await;
    assert_eq!(host.provision_count(), 0);
    cleanup(state, dir).await;
}

/// Bug 2's server half: `status` reports the connector PROCESS, running or not,
/// and always says why not. Without this the wizard could only guess.
#[tokio::test]
async fn status_reports_the_connector_process_honestly() {
    let (state, dir) = test_state().await;
    set_base(&state).await;

    // Dead connector → running:false WITH a reason.
    inject_dead_host(&state, "the connector exited (exit status: 1); restarting");
    let s = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: None }),
    )
    .await
    .expect("status ok");
    let c = &s.0.data.box_status.connector;
    assert!(!c.running, "a dead connector is never reported as running");
    assert_eq!(c.via, "none");
    assert!(
        c.detail.as_deref().unwrap_or("").contains("exited"),
        "status must say WHY it is down: {:?}",
        c.detail
    );

    // Live connector → running:true, how, and which pid.
    inject_host(&state);
    let s2 = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: None }),
    )
    .await
    .unwrap();
    let c2 = &s2.0.data.box_status.connector;
    assert!(c2.running);
    assert_eq!(c2.via, "child");
    assert_eq!(c2.pid, Some(4242));
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
    let res = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
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
    assert!(e.is_valid_for(co.id, "example.com"));
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
    let res = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None).await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
    assert!(
        state.human_auth_cfg().company_hosts.is_empty(),
        "no allowlist entry written without a base domain"
    );
    cleanup(state, dir).await;
}

/// The owner's own label wins over the slug — the whole point of an editable
/// subdomain. The entry, the redirect URI and every downstream read (status,
/// verify, the invite link) follow the label, not `companies.slug`.
#[tokio::test]
async fn company_host_accepts_an_owner_chosen_subdomain() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "enverder", "Enverder", "/tmp/enverder")
        .await
        .unwrap();
    let res = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("  Team  ".into()),
        })),
    )
    .await
    .expect("owner label accepted");
    assert_eq!(res.0.data.host, "team.example.com", "trimmed + lower-cased");
    assert_eq!(res.0.data.redirect_uri, "https://team.example.com/auth/callback");
    assert!(res.0.data.previous_host.is_none(), "nothing moved on a first write");

    // The live allowlist resolves the CHOSEN host (and only it) to this company.
    let cfg = state.human_auth_cfg();
    assert!(cfg.host_entry("team.example.com").is_some());
    assert!(cfg.host_entry("enverder.example.com").is_none(), "slug host never written");
    assert!(cfg.company_entry(co.id).unwrap().is_valid_for(co.id, "example.com"));

    // Status reports the published address, not a slug-derived guess.
    let st = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery {
            company_id: Some(co.id),
        }),
    )
    .await
    .unwrap();
    let company = st.0.data.company.expect("company block");
    assert_eq!(company.host, "team.example.com");
    assert_eq!(company.redirect_uri, "https://team.example.com/auth/callback");
    assert_eq!(company.redirect_registered, "ok");
    assert!(company.company_host_written);

    // …and so does the invite link.
    let added = add_human_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Json(AddHumanInput {
            email: "bob@enverder.test".into(),
            role: "member".into(),
            display_name: None,
        }),
    )
    .await
    .expect("add ok");
    assert_eq!(added.0.data.login_url, "https://team.example.com");
    cleanup(state, dir).await;
}

/// A rename REPLACES the entry (one address per company) and reports what moved,
/// so the wizard can say the old link stops working.
#[tokio::test]
async fn company_host_rename_replaces_the_entry_and_reports_the_old_address() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let _ = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    let renamed = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("hq".into()),
        })),
    )
    .await
    .expect("rename ok");
    assert_eq!(renamed.0.data.host, "hq.example.com");
    assert_eq!(renamed.0.data.previous_host.as_deref(), Some("acme.example.com"));

    let cfg = state.human_auth_cfg();
    assert!(cfg.host_entry("acme.example.com").is_none(), "old host retired");
    assert!(cfg.host_entry("hq.example.com").is_some());
    assert_eq!(
        cfg.company_hosts.iter().filter(|h| h.company_id == co.id).count(),
        1,
        "exactly one permanent entry per company"
    );

    // A BODYLESS re-assert (the Google mini-step) KEEPS the owner's label — it
    // must never silently rename the address back to the slug.
    let again = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    assert_eq!(again.0.data.host, "hq.example.com");
    assert!(again.0.data.previous_host.is_none(), "no move ⇒ no previous_host");
    cleanup(state, dir).await;
}

/// Uniform 400s for anything that is not a single DNS label — a name that could
/// not get a record (or a Universal SSL certificate) never reaches the store.
#[tokio::test]
async fn company_host_refuses_an_illegal_subdomain() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    for bad in ["", "-hq", "hq-", "hq.eu", "hq_eu", "hq eu", "a b", &"a".repeat(64)] {
        let res = host_handler(
            State(state.clone()),
            OptCtx(None),
            Path(co.id),
            Some(Json(HostInput {
                subdomain: Some(bad.to_string()),
            })),
        )
        .await;
        assert!(matches!(res, Err(AppError::BadRequest(_))), "{bad:?} → {res:?}");
    }
    assert!(
        state.human_auth_cfg().company_hosts.is_empty(),
        "no entry written by a refused label"
    );
    cleanup(state, dir).await;
}

/// Two companies cannot publish the same address: the Host header is what binds a
/// login cookie to a company, so a collision is a clean 409, not a silent steal.
#[tokio::test]
async fn company_host_refuses_a_label_another_company_already_uses() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let one = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let two = crate::db::companies::create(&state.pool, "beta", "Beta", "/tmp/beta")
        .await
        .unwrap();
    let _ = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(one.id),
        Some(Json(HostInput {
            subdomain: Some("hq".into()),
        })),
    )
    .await
    .unwrap();
    let clash = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(two.id),
        Some(Json(HostInput {
            subdomain: Some("HQ".into()),
        })),
    )
    .await;
    assert!(matches!(clash, Err(AppError::Conflict(_))), "got {clash:?}");
    // The winner keeps the address; the loser wrote nothing.
    let cfg = state.human_auth_cfg();
    assert_eq!(cfg.host_entry("hq.example.com").unwrap().company_id, one.id);
    assert!(cfg.company_entry(two.id).is_none());
    // Re-asserting the SAME label for the company that owns it is not a clash.
    let same = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(one.id),
        Some(Json(HostInput {
            subdomain: Some("hq".into()),
        })),
    )
    .await;
    assert!(same.is_ok(), "idempotent re-assert: {same:?}");
    cleanup(state, dir).await;
}

/// A slug that is not a legal hostname label cannot be a silent default — the
/// owner is told to pick a subdomain instead of getting an address that would
/// never resolve.
#[tokio::test]
async fn company_host_refuses_an_unusable_slug_as_the_default() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme_eu", "Acme EU", "/tmp/acme-eu")
        .await
        .unwrap();
    let res = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None).await;
    match res {
        Err(AppError::BadRequest(m)) => assert!(m.contains("choose a subdomain"), "{m}"),
        other => panic!("expected a 400 telling the owner to choose: {other:?}"),
    }
    // …and choosing one works.
    let fixed = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("acme-eu".into()),
        })),
    )
    .await
    .expect("explicit label accepted");
    assert_eq!(fixed.0.data.host, "acme-eu.example.com");
    cleanup(state, dir).await;
}

/// The FALLBACK: with no entry written yet, every reader still shows the
/// slug-derived suggestion (nothing regresses for a company mid-wizard).
#[tokio::test]
async fn status_falls_back_to_the_slug_when_no_entry_exists() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let st = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery {
            company_id: Some(co.id),
        }),
    )
    .await
    .unwrap();
    let company = st.0.data.company.expect("company block");
    assert_eq!(company.host, "acme.example.com", "the wizard's suggestion");
    assert_eq!(company.redirect_uri, "https://acme.example.com/auth/callback");
    assert!(!company.company_host_written);
    assert_eq!(company.redirect_registered, "unknown");
    cleanup(state, dir).await;
}

/// An entry under a STALE base domain stays not-ok (fail-closed): the base
/// changed, so the address must be re-derived rather than trusted.
#[tokio::test]
async fn a_stale_base_domain_de_canonicalises_the_entry() {
    let (state, dir) = test_state().await;
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let _ = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("hq".into()),
        })),
    )
    .await
    .unwrap();
    // The operator moves the box to another zone.
    let mut cfg = store::read_or_default(&state.config.data_dir).unwrap();
    cfg.base_domain = Some("other.test".into());
    store::write_atomic(&state.config.data_dir, &cfg).unwrap();
    state.reload_human_auth().unwrap();

    let st = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery {
            company_id: Some(co.id),
        }),
    )
    .await
    .unwrap();
    let company = st.0.data.company.expect("company block");
    assert_eq!(company.redirect_registered, "mismatch", "stale base ⇒ not ok");
    assert_eq!(company.host, "acme.other.test", "re-derived under the new base");
    let v = verify_login_handler(State(state.clone()), OptCtx(None), Path(co.id))
        .await
        .unwrap();
    assert!(!v.0.data.ok, "verify must not be green under a stale base");
    cleanup(state, dir).await;
}

// ── per-host DNS (the wildcard replacement) ──────────────────────────────────

/// Token + base domain + a provisioned tunnel: the state every DNS test needs.
/// Returns the CF mock so the zone's records can be seeded and asserted.
async fn provisioned_box(state: &AppState, dir: &std::path::Path) -> Arc<MockCfApi> {
    let cf = inject_cf(state);
    inject_host(state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(state).await;
    provision_tunnel_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("provision ok");
    cf
}

const OUR_TARGET: &str = "tunnel-xyz.cfargotunnel.com";

/// The core of the footprint change: ONE record and ONE ingress rule for the
/// company's own address — never `*.<base>`, which would have pointed every
/// undefined name on the operator's domain at this box.
#[tokio::test]
async fn company_host_creates_one_record_and_one_ingress_rule() {
    let (state, dir) = test_state().await;
    let cf = provisioned_box(&state, &dir).await;
    let co = crate::db::companies::create(&state.pool, "enverder", "Enverder", "/tmp/enverder")
        .await
        .unwrap();
    let res = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("team".into()),
        })),
    )
    .await
    .expect("host ok");
    assert_eq!(res.0.data.host, "team.example.com");
    assert_eq!(res.0.data.dns, "created");
    assert_eq!(cf.dns_names(), vec!["team.example.com".to_string()]);
    assert_eq!(cf.ingress_hosts(), vec!["team.example.com".to_string()]);
    assert!(
        !cf.dns_names().iter().any(|n| n.starts_with('*')),
        "no wildcard may ever be written"
    );

    // Re-asserting the same address is idempotent: no second record, no error.
    let again = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .expect("re-assert ok");
    assert_eq!(again.0.data.dns, "exists");
    assert_eq!(cf.created_names().len(), 1, "created exactly once");

    // A SECOND company adds its own record and joins the ingress document.
    let two = crate::db::companies::create(&state.pool, "beta", "Beta", "/tmp/beta")
        .await
        .unwrap();
    host_handler(State(state.clone()), OptCtx(None), Path(two.id), None)
        .await
        .expect("second company ok");
    assert_eq!(
        cf.ingress_hosts(),
        vec!["beta.example.com".to_string(), "team.example.com".to_string()],
        "ingress enumerates every company host"
    );
    cleanup(state, dir).await;
}

/// A rename moves the record: the new name is created, the OLD one is deleted
/// (it pointed at our tunnel), and the ingress document follows.
#[tokio::test]
async fn company_host_rename_moves_the_record_and_the_ingress() {
    let (state, dir) = test_state().await;
    let cf = provisioned_box(&state, &dir).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    assert_eq!(cf.dns_names(), vec!["acme.example.com".to_string()]);

    let renamed = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("hq".into()),
        })),
    )
    .await
    .expect("rename ok");
    assert_eq!(renamed.0.data.host, "hq.example.com");
    assert_eq!(renamed.0.data.dns, "created");
    assert!(renamed.0.data.previous_dns_removed, "the old record must go");
    assert_eq!(cf.dns_names(), vec!["hq.example.com".to_string()]);
    assert_eq!(cf.ingress_hosts(), vec!["hq.example.com".to_string()]);
    cleanup(state, dir).await;
}

/// The guard that makes this safe to point at someone's real domain: a name the
/// OPERATOR already uses is refused, never re-pointed — and nothing is persisted.
#[tokio::test]
async fn company_host_refuses_a_name_the_operator_already_uses() {
    let (state, dir) = test_state().await;
    let cf = provisioned_box(&state, &dir).await;
    cf.seed_dns("team.example.com", "someone-elses-app.pages.dev");
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let res = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("team".into()),
        })),
    )
    .await;
    match res {
        Err(AppError::Conflict(m)) => {
            assert!(m.contains("team.example.com"), "{m}");
            assert!(m.contains("someone-elses-app.pages.dev"), "names the current target: {m}");
        }
        other => panic!("expected a conflict naming the existing record, got {other:?}"),
    }
    // Untouched, and no allowlist entry written on a refusal.
    assert_eq!(
        cf.dns.lock().unwrap()[0].content,
        "someone-elses-app.pages.dev",
        "the operator's record must be left exactly as it was"
    );
    assert!(cf.dns_deleted.lock().unwrap().is_empty(), "nothing deleted");
    assert!(state.human_auth_cfg().company_entry(co.id).is_none());
    cleanup(state, dir).await;
}

/// Deleting a company releases its address: allowlist entry, DNS record, ingress
/// rule — and NOTHING that is not ours.
#[tokio::test]
async fn releasing_a_company_removes_only_our_record() {
    let (state, dir) = test_state().await;
    let cf = provisioned_box(&state, &dir).await;
    // A record the operator owns, on a name supermux never claimed.
    cf.seed_dns("www.example.com", "their-site.pages.dev");
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let two = crate::db::companies::create(&state.pool, "beta", "Beta", "/tmp/beta")
        .await
        .unwrap();
    host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    host_handler(State(state.clone()), OptCtx(None), Path(two.id), None)
        .await
        .unwrap();

    let warning = super::release_company_host(&state, co.id).await;
    assert!(warning.is_none(), "clean release: {warning:?}");
    // Ours is gone; the other company's and the operator's own record remain.
    let mut names = cf.dns_names();
    names.sort();
    assert_eq!(
        names,
        vec!["beta.example.com".to_string(), "www.example.com".to_string()]
    );
    assert_eq!(cf.ingress_hosts(), vec!["beta.example.com".to_string()]);
    // …and the login surface is retired with it.
    assert!(state.human_auth_cfg().company_entry(co.id).is_none());
    assert!(state.human_auth_cfg().host_entry("acme.example.com").is_none());
    cleanup(state, dir).await;
}

/// A record that is NOT ours survives a release of the company that claimed that
/// name — supermux deletes what it created and nothing else.
#[tokio::test]
async fn releasing_a_company_never_deletes_a_foreign_record() {
    let (state, dir) = test_state().await;
    let cf = provisioned_box(&state, &dir).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    // The operator re-points that name at their own thing behind our back.
    {
        let mut dns = cf.dns.lock().unwrap();
        dns[0].content = "their-own-thing.example.net".to_string();
    }
    let warning = super::release_company_host(&state, co.id).await;
    assert!(warning.is_none(), "{warning:?}");
    assert_eq!(cf.dns_names(), vec!["acme.example.com".to_string()], "left alone");
    assert!(cf.dns_deleted.lock().unwrap().is_empty(), "no delete issued");
    cleanup(state, dir).await;
}

/// Back-compat: a box provisioned by the old build still has `*.<base>`. It is
/// SURFACED, kept working (its ingress rule stays), and only replaced when the
/// operator asks — never implicitly.
#[tokio::test]
async fn a_legacy_wildcard_is_surfaced_then_tightened_on_request() {
    let (state, dir) = test_state().await;
    let cf = provisioned_box(&state, &dir).await;
    cf.seed_dns("*.example.com", OUR_TARGET); // what an older build wrote
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    // The wildcard KEEPS its ingress rule until it is explicitly tightened — a
    // company reachable only through it must not go dark behind our back.
    assert_eq!(
        cf.ingress_hosts(),
        vec!["*.example.com".to_string(), "acme.example.com".to_string()]
    );

    // Status says so, so the wizard can offer the one-click fix.
    let st = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: None }),
    )
    .await
    .unwrap();
    assert!(st.0.data.box_status.wildcard_dns, "the wildcard must be surfaced");
    assert_eq!(st.0.data.box_status.dns_records, vec!["acme.example.com".to_string()]);

    // Tighten: per-company records first, then the narrowed ingress, then the
    // wildcard record last.
    let t = tighten_dns_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("tighten ok");
    assert!(t.0.data.wildcard_removed);
    assert_eq!(t.0.data.records, vec!["acme.example.com".to_string()]);
    assert_eq!(cf.dns_names(), vec!["acme.example.com".to_string()]);
    assert_eq!(cf.ingress_hosts(), vec!["acme.example.com".to_string()]);

    let after = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: None }),
    )
    .await
    .unwrap();
    assert!(!after.0.data.box_status.wildcard_dns, "gone after tightening");
    cleanup(state, dir).await;
}

/// A `*.<base>` record that points somewhere ELSE is the operator's own wildcard.
/// Tightening narrows OUR ingress but must not delete their record.
#[tokio::test]
async fn tighten_never_deletes_a_wildcard_that_is_not_ours() {
    let (state, dir) = test_state().await;
    let cf = provisioned_box(&state, &dir).await;
    cf.seed_dns("*.example.com", "their-catch-all.pages.dev");
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    let t = tighten_dns_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("tighten ok");
    assert!(!t.0.data.wildcard_removed, "not ours ⇒ not deleted");
    assert!(
        cf.dns_names().contains(&"*.example.com".to_string()),
        "the operator's wildcard survives: {:?}",
        cf.dns_names()
    );
    // And it was never treated as ours in the ingress either.
    assert_eq!(cf.ingress_hosts(), vec!["acme.example.com".to_string()]);
    cleanup(state, dir).await;
}

/// Order-independence: choosing the address BEFORE the tunnel exists is the
/// wizard's actual flow. The record is `pending` then, and provisioning creates
/// exactly it — still no wildcard.
#[tokio::test]
async fn an_address_chosen_before_provisioning_gets_its_record_at_provision() {
    let (state, dir) = test_state().await;
    let cf = inject_cf(&state);
    inject_host(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let res = host_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Some(Json(HostInput {
            subdomain: Some("team".into()),
        })),
    )
    .await
    .expect("host ok before provisioning");
    assert_eq!(res.0.data.dns, "pending", "no tunnel yet ⇒ nothing written");
    assert!(cf.dns_names().is_empty());

    let p = provision_tunnel_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("provision ok");
    assert_eq!(p.0.data.dns_records, vec!["team.example.com".to_string()]);
    assert_eq!(cf.dns_names(), vec!["team.example.com".to_string()]);
    assert_eq!(cf.ingress_hosts(), vec!["team.example.com".to_string()]);
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
    let _ = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
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
    assert_404!(agent_inbox_handler(
        State(state.clone()),
        member(),
        Json(AgentInboxInput {
            company_id: co.id,
            local_part: None,
            destination_email: "x@acme.test".into(),
        })
    ));
    assert_404!(agent_inbox_delete_handler(
        State(state.clone()),
        member(),
        Query(AgentInboxDeleteQuery { company_id: co.id })
    ));
    assert_404!(host_handler(State(state.clone()), member(), Path(co.id), None));
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
    let _ = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
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

// ── quick tunnel (zero-config, no Google, no Cloudflare) ─────────────────────

/// Provisioning a quick tunnel writes an EPHEMERAL company host + a `quick_tunnel`
/// record, makes the surface invite-enabled (no Google), and touches Cloudflare
/// ZERO times. `host_entry` + `origin_allowed` both resolve the ephemeral host.
#[tokio::test]
async fn quick_tunnel_provision_registers_ephemeral_host_and_makes_no_cf_calls() {
    let (state, dir) = test_state().await;
    let cf = inject_cf(&state);
    let quick = inject_quick(&state, "https://calm-frog-1234.trycloudflare.com");
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    let res = quick_tunnel_handler(
        State(state.clone()),
        OptCtx(None),
        Json(QuickTunnelInput { company_id: co.id }),
    )
    .await
    .expect("quick tunnel provisioned");
    assert_eq!(res.0.data.url, "https://calm-frog-1234.trycloudflare.com");
    assert_eq!(res.0.data.host, "calm-frog-1234.trycloudflare.com");
    assert!(res.0.data.ephemeral);
    assert_eq!(quick.start_count(), 1, "child started once");

    // Ephemeral CompanyHost entry + quick_tunnel record persisted.
    let stored = store::read(&dir).unwrap().unwrap();
    let qt = stored.quick_tunnel.expect("quick_tunnel record");
    assert_eq!(qt.company_id, co.id);
    assert_eq!(qt.host, "calm-frog-1234.trycloudflare.com");
    let entry = stored
        .company_hosts
        .iter()
        .find(|h| h.host == "calm-frog-1234.trycloudflare.com")
        .expect("ephemeral host entry");
    assert!(entry.ephemeral, "host marked ephemeral");
    assert_eq!(entry.company_id, co.id);

    // Live config: host_entry resolves it, the surface is invite-enabled (NO
    // Google), and signing keys were generated.
    let cfg = state.human_auth_cfg();
    assert!(cfg.host_entry("calm-frog-1234.trycloudflare.com").is_some());
    assert!(!cfg.enabled(), "no Google on the quick-tunnel path");
    assert!(cfg.invite_enabled(), "invite surface live");
    assert!(!cfg.invite_key.is_empty(), "invite key generated");

    // The WS Origin gate accepts the ephemeral host (it is a company_hosts entry).
    assert!(crate::ws::origin_allowed(
        &state,
        &origin_headers("https://calm-frog-1234.trycloudflare.com")
    ));

    // ZERO Cloudflare calls on this path.
    assert_eq!(cf.create_count(), 0, "quick tunnel makes no Cloudflare calls");

    // The live child handle is stashed + reported alive by status.
    assert!(state.external_access.quick_handle_alive().await);
    cleanup(state, dir).await;
}

/// One active quick tunnel per box: provisioning for a DIFFERENT company tears the
/// first down (stop + replace) — the old host is gone, the new one bound.
#[tokio::test]
async fn quick_tunnel_rebind_replaces_the_prior_company() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    let co1 = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let co2 = crate::db::companies::create(&state.pool, "beta", "Beta", "/tmp/beta")
        .await
        .unwrap();

    let q1 = inject_quick(&state, "https://host-one.trycloudflare.com");
    quick_tunnel_handler(
        State(state.clone()),
        OptCtx(None),
        Json(QuickTunnelInput { company_id: co1.id }),
    )
    .await
    .unwrap();

    // Rebind to a second company with a different URL.
    let q2 = inject_quick(&state, "https://host-two.trycloudflare.com");
    quick_tunnel_handler(
        State(state.clone()),
        OptCtx(None),
        Json(QuickTunnelInput { company_id: co2.id }),
    )
    .await
    .unwrap();

    assert_eq!(q2.start_count(), 1, "second child started");
    assert_eq!(q2.stop_count(), 1, "prior child torn down on rebind");

    let stored = store::read(&dir).unwrap().unwrap();
    let qt = stored.quick_tunnel.unwrap();
    assert_eq!(qt.company_id, co2.id, "now bound to the second company");
    assert_eq!(qt.host, "host-two.trycloudflare.com");
    // The FIRST host is gone; only the second resolves.
    let cfg = state.human_auth_cfg();
    assert!(cfg.host_entry("host-one.trycloudflare.com").is_none(), "old host removed");
    assert!(cfg.host_entry("host-two.trycloudflare.com").is_some());
    let _ = q1;
    cleanup(state, dir).await;
}

/// Teardown stops the child, removes the entry + record; the host no longer
/// resolves and the WS Origin gate rejects it again (fail-closed).
#[tokio::test]
async fn quick_tunnel_teardown_removes_entry_and_record() {
    let (state, dir) = test_state().await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let quick = inject_quick(&state, "https://gone-soon.trycloudflare.com");
    quick_tunnel_handler(
        State(state.clone()),
        OptCtx(None),
        Json(QuickTunnelInput { company_id: co.id }),
    )
    .await
    .unwrap();
    assert!(state
        .human_auth_cfg()
        .host_entry("gone-soon.trycloudflare.com")
        .is_some());

    let res = quick_tunnel_teardown_handler(State(state.clone()), OptCtx(None))
        .await
        .expect("teardown ok");
    assert!(res.0.data.torn_down);
    assert_eq!(quick.stop_count(), 1, "child stopped");

    // Record + entry gone; host no longer resolves; origin rejected.
    let stored = store::read(&dir).unwrap().unwrap();
    assert!(stored.quick_tunnel.is_none(), "record removed");
    assert!(!stored
        .company_hosts
        .iter()
        .any(|h| h.host == "gone-soon.trycloudflare.com"));
    let cfg = state.human_auth_cfg();
    assert!(cfg.host_entry("gone-soon.trycloudflare.com").is_none());
    assert!(!crate::ws::origin_allowed(
        &state,
        &origin_headers("https://gone-soon.trycloudflare.com")
    ));
    assert!(!state.external_access.quick_handle_alive().await);
    cleanup(state, dir).await;
}

/// The quick-tunnel company's `add_human` returns a signed `/auth/invite` magic
/// link on the ephemeral host — NOT a base-domain Google URL — with no base domain
/// configured at all.
#[tokio::test]
async fn add_human_on_quick_company_returns_a_magic_link() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    let _quick = inject_quick(&state, "https://calm-frog-1234.trycloudflare.com");
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    quick_tunnel_handler(
        State(state.clone()),
        OptCtx(None),
        Json(QuickTunnelInput { company_id: co.id }),
    )
    .await
    .unwrap();
    // No base domain on this path.
    assert!(state.human_auth_cfg().base_domain.is_none());

    let added = add_human_handler(
        State(state.clone()),
        OptCtx(None),
        Path(co.id),
        Json(AddHumanInput {
            email: "bob@acme.test".into(),
            role: "member".into(),
            display_name: None,
        }),
    )
    .await
    .expect("add human ok");
    let url = &added.0.data.login_url;
    assert!(
        url.starts_with("https://calm-frog-1234.trycloudflare.com/auth/invite?token="),
        "magic link on the ephemeral host: {url}"
    );
    // The token verifies + binds to this user/company.
    let token = url.rsplit_once("token=").unwrap().1;
    let now = chrono::Utc::now().timestamp();
    let claims = crate::auth_human::invite::verify_invite_token(
        &state.human_auth_cfg().invite_key,
        token,
        now,
    )
    .expect("token verifies");
    assert_eq!(claims.user_id, added.0.data.user.id);
    assert_eq!(claims.company_id, co.id);
    cleanup(state, dir).await;
}

// ── agent-inbox (Cloudflare Email Routing) ───────────────────────────────────

/// Happy path: enable routing → add destination → create the forward rule, persist
/// the record, and surface it (pending) in status. The mock's destination starts
/// UNVERIFIED, so `verification_pending` is honestly true.
#[tokio::test]
async fn agent_inbox_provision_enables_adds_and_creates_rule() {
    let (state, dir) = test_state().await;
    let cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    let res = agent_inbox_handler(
        State(state.clone()),
        OptCtx(None),
        Json(AgentInboxInput {
            company_id: co.id,
            local_part: None, // defaults to "agent"
            destination_email: "Owner@Example.com".into(),
        }),
    )
    .await
    .expect("provision ok");
    assert_eq!(res.0.data.address, "agent@example.com");
    assert_eq!(res.0.data.destination, "owner@example.com", "destination lower-cased");
    assert!(res.0.data.verification_pending, "a fresh destination needs the CF click");
    assert!(res.0.data.routing_enabled, "email routing turned on");
    assert_eq!(cf.rule_create_count(), 1, "rule created exactly once");

    // The non-secret record round-trips through the companion store.
    let stored = store::read(&dir).unwrap().unwrap();
    let a = store::agent_inbox_for(&stored, co.id).expect("record persisted");
    assert_eq!(a.address, "agent@example.com");
    assert_eq!(a.destination, "owner@example.com");
    assert!(!a.verified);
    assert_eq!(a.rule_tag.as_deref(), Some("rule-tag-abc"));

    // Status surfaces the pending inbox on the company block.
    let s = status_handler(
        State(state.clone()),
        OptCtx(None),
        Query(StatusQuery { company_id: Some(co.id) }),
    )
    .await
    .unwrap();
    let ai = s.0.data.company.unwrap().agent_inbox.expect("agent_inbox in status");
    assert_eq!(ai.address, "agent@example.com");
    assert!(ai.verification_pending && !ai.verified);
    cleanup(state, dir).await;
}

/// Idempotent re-provision: running it twice through the SAME Cloudflare mock
/// creates the rule only once (reused by matcher) and keeps a single record.
#[tokio::test]
async fn agent_inbox_reprovision_is_idempotent() {
    let (state, dir) = test_state().await;
    let cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    let call = || {
        agent_inbox_handler(
            State(state.clone()),
            OptCtx(None),
            Json(AgentInboxInput {
                company_id: co.id,
                local_part: Some("agent".into()),
                destination_email: "owner@example.com".into(),
            }),
        )
    };
    call().await.expect("first ok");
    call().await.expect("second ok");
    assert_eq!(cf.rule_create_count(), 1, "idempotent — rule not re-created");
    let stored = store::read(&dir).unwrap().unwrap();
    assert_eq!(stored.agent_inboxes.len(), 1, "single record after re-provision");
    cleanup(state, dir).await;
}

/// A verified destination is not reported pending, and the record stores it.
#[tokio::test]
async fn agent_inbox_verified_destination_is_not_pending() {
    let (state, dir) = test_state().await;
    let cf = Arc::new(MockCfApi {
        destination_verified: true,
        ..Default::default()
    });
    state.external_access.set_cf(cf);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    let res = agent_inbox_handler(
        State(state.clone()),
        OptCtx(None),
        Json(AgentInboxInput {
            company_id: co.id,
            local_part: None,
            destination_email: "owner@example.com".into(),
        }),
    )
    .await
    .expect("provision ok");
    assert!(!res.0.data.verification_pending, "verified destination is not pending");
    assert!(store::agent_inbox_for(&store::read(&dir).unwrap().unwrap(), co.id).unwrap().verified);
    cleanup(state, dir).await;
}

/// A token missing the Email Routing scope surfaces a clear, actionable 400 (never
/// a raw Cloudflare error) — the operator re-mints the token.
#[tokio::test]
async fn agent_inbox_missing_email_routing_scope_is_a_clear_error() {
    let (state, dir) = test_state().await;
    let cf = Arc::new(MockCfApi {
        email_scope_ok: false,
        ..Default::default()
    });
    state.external_access.set_cf(cf);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();

    let res = agent_inbox_handler(
        State(state.clone()),
        OptCtx(None),
        Json(AgentInboxInput {
            company_id: co.id,
            local_part: None,
            destination_email: "owner@example.com".into(),
        }),
    )
    .await;
    match res {
        Err(AppError::BadRequest(msg)) => {
            assert!(msg.contains("Email Routing"), "msg: {msg}");
            assert!(msg.contains("scope"), "msg: {msg}");
        }
        other => panic!("expected a missing-scope BadRequest, got {other:?}"),
    }
    // Nothing persisted on the failure path.
    assert!(
        store::read(&dir).unwrap().map(|c| c.agent_inboxes.is_empty()).unwrap_or(true),
        "no record written when the scope check fails"
    );
    cleanup(state, dir).await;
}

/// DELETE tears down the rule + record; a second delete is a benign no-op.
#[tokio::test]
async fn agent_inbox_delete_removes_the_record() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    set_base(&state).await;
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    agent_inbox_handler(
        State(state.clone()),
        OptCtx(None),
        Json(AgentInboxInput {
            company_id: co.id,
            local_part: None,
            destination_email: "owner@example.com".into(),
        }),
    )
    .await
    .expect("provision ok");
    assert!(store::agent_inbox_for(&store::read(&dir).unwrap().unwrap(), co.id).is_some());

    let del = agent_inbox_delete_handler(
        State(state.clone()),
        OptCtx(None),
        Query(AgentInboxDeleteQuery { company_id: co.id }),
    )
    .await
    .expect("delete ok");
    assert!(del.0.data.deleted);
    assert!(store::agent_inbox_for(&store::read(&dir).unwrap().unwrap(), co.id).is_none());

    // Idempotent: deleting again reports nothing removed.
    let again = agent_inbox_delete_handler(
        State(state.clone()),
        OptCtx(None),
        Query(AgentInboxDeleteQuery { company_id: co.id }),
    )
    .await
    .expect("second delete ok");
    assert!(!again.0.data.deleted);
    cleanup(state, dir).await;
}

/// FAIL-CLOSED: no chosen base domain ⇒ agent-inbox provisioning is refused (no
/// connected zone to route on), and nothing is written.
#[tokio::test]
async fn agent_inbox_without_a_base_domain_is_rejected() {
    let (state, dir) = test_state().await;
    let _cf = inject_cf(&state);
    crate::config::write_token_0600(&dir.join(super::CF_TOKEN_FILE), "valid-cf-token").unwrap();
    let co = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
        .await
        .unwrap();
    let res = agent_inbox_handler(
        State(state.clone()),
        OptCtx(None),
        Json(AgentInboxInput {
            company_id: co.id,
            local_part: None,
            destination_email: "owner@example.com".into(),
        }),
    )
    .await;
    assert!(matches!(res, Err(AppError::BadRequest(_))), "got {res:?}");
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
    let _ = host_handler(State(state.clone()), OptCtx(None), Path(co.id), None)
        .await
        .unwrap();
    assert!(
        crate::ws::origin_allowed(&state, &headers),
        "configured company host must be an allowed WS Origin"
    );
    cleanup(state, dir).await;
}
