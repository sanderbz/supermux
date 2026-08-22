//! **The opt-in pin for the Claude statusline tap (fase A2, Task 6).**
//!
//! "Opt-in" is worthless as an intention. This file makes it a property of the
//! build: it drives the REAL create + start path against a throwaway
//! `CLAUDE_CONFIG_DIR` and asserts the settings file supermux writes there never
//! grows a `statusLine` key — while proving the assertion is not vacuous by
//! checking, in the same file, that the `hooks` supermux DOES install landed.
//!
//! It also pins the second gate: with the default `statusline_tap = false`,
//! `POST /api/claude/statusline/install` is a 403 and the settings file is still
//! untouched. Only an operator who edits `config.toml` AND calls that endpoint
//! can ever put a `statusLine` key on a host.
//!
//! Single test on purpose: it sets `CLAUDE_CONFIG_DIR` for THIS test binary's
//! process (cargo runs each integration file in its own process), so there is no
//! cross-test env race.

use std::fs;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt; // for `oneshot`

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::sessions::{self, CreateInput};
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "statusline-optin-token";

fn tmux_available() -> bool {
    std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn session_create_and_start_never_install_the_statusline() {
    if !tmux_available() {
        eprintln!("skipping statusline opt-in pin: tmux not on PATH");
        return;
    }
    // A throwaway Claude config dir — the live `~/.claude/settings.json` is
    // never in play, here or in any other statusline test.
    let cfg = std::env::temp_dir().join(format!("sm-slopt-cfg-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&cfg).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &cfg);
    let settings = cfg.join("settings.json");

    let data_dir = std::env::temp_dir().join(format!("sm-slopt-data-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&data_dir).unwrap();
    let work_dir = std::env::temp_dir().join(format!("sm-slopt-work-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&work_dir).unwrap();

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
        // THE DEFAULT. Not a test convenience — `config.toml` with no
        // `statusline_tap` key resolves to exactly this.
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());

    // ── the real create + start path, for a CLAUDE session ───────────────────
    // Claude is the only provider whose start writes `~/.claude/settings.json`
    // at all, so it is the only one that could possibly slip a statusLine in.
    let name = format!("sl{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    sessions::create(
        &state,
        CreateInput {
            name: name.clone(),
            display_name: None,
            dir: Some(work_dir.display().to_string()),
            desc: None,
            provider: Some("claude".into()),
            creator: None,
            flags: None,
            tags: None,
            branch: None,
            mcp: None,
            worktree: None,
            host_id: None,
            bypass_permissions: None,
            // tmux, so the pin does not depend on a native holder binary.
            runtime: Some("tmux".into()),
            model: None,
            company_id: None,
        },
    )
    .await
    .expect("create the session");
    sessions::lifecycle::start(&state, &name, None)
        .await
        .expect("start the session");

    // The start path DID write this file — without this the statusLine
    // assertion below would pass vacuously on a file that never existed.
    let after_start: Value =
        serde_json::from_str(&fs::read_to_string(&settings).expect("start must write settings.json"))
            .expect("settings.json parses");
    assert!(
        after_start.get("hooks").is_some(),
        "precondition: the create+start path installs the status hooks"
    );
    assert!(
        after_start.get("statusLine").is_none(),
        "create+start must NEVER install the statusline tap; got {}",
        serde_json::to_string(&after_start["statusLine"]).unwrap_or_default()
    );

    // ── gate 2: the explicit endpoint refuses while the config flag is off ───
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/claude/statusline/install")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::FORBIDDEN,
        "install must refuse while `statusline_tap` is false"
    );
    let refused: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
    assert!(
        refused.get("statusLine").is_none(),
        "a refused install must not have written anything"
    );

    // Unauthenticated callers never reach the handler at all.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/claude/statusline/install")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // Uninstall is NOT gated (it is the safety valve) and is a clean no-op on a
    // host that never installed the tap.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri("/api/claude/statusline")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let after_uninstall: Value =
        serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(
        after_uninstall, after_start,
        "an uninstall with nothing installed must leave the settings file alone"
    );

    let _ = sessions::lifecycle::stop(&state, &name).await;
    let _ = fs::remove_dir_all(&cfg);
    let _ = fs::remove_dir_all(&data_dir);
    let _ = fs::remove_dir_all(&work_dir);
}
