//! `start` rotates the hook token only when it spawns a new terminal.
//!
//! The token reaches the agent only through its spawn environment
//! (`$SUPERMUX_HOOK_TOKEN`). A start on a terminal that is already up spawns
//! nothing, so rotating there left the running agent with a token the server no
//! longer accepted: every hook 401'd until the next real restart, the
//! conversation pointer froze across `/clear`, and that restart then resumed an
//! old conversation. Spawns a REAL tmux shell session; skips without tmux.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

const TOKEN: &str = "start-hook-token-bearer";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-starttoken-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        swarm_reaper: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        company_isolation: Vec::new(),
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
}

async fn api(app: &axum::Router, method: Method, uri: &str, body: Option<serde_json::Value>) -> StatusCode {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    let req = match body {
        Some(v) => {
            b = b.header(header::CONTENT_TYPE, "application/json");
            b.body(Body::from(v.to_string())).unwrap()
        }
        None => b.body(Body::empty()).unwrap(),
    };
    app.clone().oneshot(req).await.unwrap().status()
}

async fn token(state: &AppState, name: &str) -> String {
    db::sessions::runtime(&state.pool, name)
        .await
        .unwrap()
        .expect("runtime row")
        .hook_token
}

#[tokio::test]
async fn a_fresh_spawn_rotates_the_token_and_a_start_on_a_live_terminal_keeps_it() {
    if which::which("tmux").is_err() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    // Server logs into the test output, so a failing start says why.
    let _ = tracing_subscriber::fmt()
        .with_test_writer()
        .with_max_level(tracing::Level::DEBUG)
        .try_init();
    let (state, app, dir) = setup().await;
    let name = format!("tok{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    assert_eq!(
        api(&app, Method::POST, "/api/sessions", Some(serde_json::json!({
            "name": name, "provider": "shell", "dir": "/tmp", "runtime": "tmux"
        })))
        .await,
        StatusCode::CREATED
    );
    let start = format!("/api/sessions/{name}/start");
    let created_with = token(&state, &name).await;

    // A fresh spawn rotates.
    assert_eq!(api(&app, Method::POST, &start, None).await, StatusCode::OK);
    let spawned_with = token(&state, &name).await;
    assert!(!spawned_with.is_empty());
    assert_ne!(spawned_with, created_with, "a start that spawns a terminal rotates the token");

    // The terminal is up: a second start spawns nothing, so the process keeps
    // the token it was spawned with and the server must keep accepting it.
    assert_eq!(api(&app, Method::POST, &start, None).await, StatusCode::OK);
    assert_eq!(
        token(&state, &name).await,
        spawned_with,
        "a start on a live terminal must not rotate the token out from under it"
    );

    let _ = api(&app, Method::POST, &format!("/api/sessions/{name}/stop"), None).await;
    let _ = std::process::Command::new("tmux")
        .args(["kill-session", "-t", &format!("supermux-{name}")])
        .output();
    let _ = std::fs::remove_dir_all(dir);
}
