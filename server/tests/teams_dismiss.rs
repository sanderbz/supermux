//! `POST /api/teams/{name}/dismiss` HTTP-wiring coverage.
//!
//! The move semantics + name safety live in `teams::scan::archive_team_config_in`
//! (unit-tested there: round-trip + rejects-unsafe-names). This pins only the
//! route → handler → helper wiring: a 200 `{ok:true}` parks the on-disk team
//! under `.archived/` (where `scan_teams` can't resurface it).
//!
//! Single test on purpose: it sets `CLAUDE_CONFIG_DIR` for THIS test binary's
//! process (cargo runs each integration file in its own process), so there is no
//! cross-test env race.

use std::fs;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "dismiss-test-token";

#[tokio::test]
async fn dismiss_parks_unmapped_team_under_archived() {
    // Isolated Claude config dir with one orphaned team on disk.
    let cfg = std::env::temp_dir().join(format!("sm-dismiss-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(cfg.join("teams").join("ghost-team")).unwrap();
    fs::write(cfg.join("teams/ghost-team/config.json"), "{}").unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &cfg);

    let data_dir = std::env::temp_dir().join(format!("sm-dismiss-data-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&data_dir).unwrap();
    let config = Config {
        data_dir: data_dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let app = http::router(AppState::new(pool, config));

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/teams/ghost-team/dismiss")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], br#"{"ok":true}"#);

    assert!(
        !cfg.join("teams/ghost-team").exists(),
        "source team dir must be moved out of the live teams root"
    );
    assert!(
        cfg.join("teams/.archived/ghost-team").exists(),
        "team must be parked under .archived/"
    );

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = fs::remove_dir_all(&cfg);
    let _ = fs::remove_dir_all(&data_dir);
}
