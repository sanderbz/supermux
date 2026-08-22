//! **The whole login flow, end to end, through the real server and a real pty.**
//!
//! `tests/fixtures/login/fake-login.py` is a fake OAuth provider: it prints the
//! captured Claude Code `/login` dialog verbatim, waits on a masked raw-mode
//! field, rejects a bad code with the CLI's own rejection line and re-prompts IN
//! PLACE, then prints `Login successful. Press Enter to continue…` and waits for
//! the Enter. It runs on a genuine pty under the native runtime, driven through
//! `POST /api/sessions/{name}/login` on the real router.
//!
//! What this proves that a unit test cannot:
//!
//! * the URL the card shows is the URL the provider printed — reassembled from a
//!   grid that hard-wrapped it, at whatever width the pty happens to be;
//! * the code arrives as ONE bracketed-paste burst, so the `c` trap (a lone `c`
//!   in the buffer copies the URL and CLEARS the field) cannot fire;
//! * a rejected code is re-prompted in the SAME process — the PKCE verifier
//!   would not survive a respawn;
//! * the mandatory Enter after success is actually sent (the provider records
//!   it), because that keypress is what writes the onboarding flags;
//! * the credential is nowhere afterwards: not in the pty spool, not in
//!   `last_send_text`;
//! * and the freeze is real — while it is up, `send_text` refuses and `auto_heal`
//!   returns `Frozen` instead of restarting the process holding the verifier.

use std::path::PathBuf;
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::sessions::NewSession;
use supermux_server::sessions::auto_actions::{auto_heal, Heal};
use supermux_server::sessions::{lifecycle, login};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const TOKEN: &str = "login-e2e-secret";
/// The good code. Starts with `c` on purpose: that is the `c` trap's shape, and
/// a char-at-a-time writer would deliver it alone and clear the field.
const GOOD_CODE: &str = "cQfTy2QK9nZ8vLpR3sWx7mBd4gHj1kAe#hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa";
const BAD_CODE: &str = "badQfTy2QK9nZ8vLpR3sWx#hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa";

struct Harness {
    app: axum::Router,
    state: AppState,
    /// Unique per test: the freeze registry and the heal maps are PROCESS-global
    /// (they are keyed by session name, and there is one server per host), so
    /// two tests sharing a name would share a freeze.
    name: String,
    data_dir: PathBuf,
    work_dir: PathBuf,
    result: PathBuf,
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("supermux-logine2e-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn fake_login() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/login/fake-login.py")
}

fn python() -> Option<PathBuf> {
    which::which("python3").ok()
}

/// The native runtime re-execs `supermux-server pty-holder` to own the pty, and
/// it finds that binary with `current_exe()` — which inside a test binary is the
/// TEST. `SUPERMUX_HOLDER_BIN` is the documented override (`runtime.rs`), so
/// point it at the real bin `cargo test` has already built beside our deps dir.
/// Returns false when it is not there (a `--no-run`/doc build), and the tests
/// skip rather than fail.
fn holder_bin_ready() -> bool {
    static ONCE: std::sync::Once = std::sync::Once::new();
    static OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    ONCE.call_once(|| {
        let bin = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().and_then(|d| d.parent()).map(|d| d.join("supermux-server")))
            .filter(|p| p.exists());
        if let Some(bin) = bin {
            std::env::set_var("SUPERMUX_HOLDER_BIN", &bin);
            OK.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    });
    OK.load(std::sync::atomic::Ordering::SeqCst)
}

async fn spawn_harness(name: &str) -> Harness {
    let data_dir = tmp("data");
    let work_dir = tmp("work");
    let result = work_dir.join("result");
    let config = Config {
        data_dir: data_dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    Harness {
        app,
        state,
        name: name.to_string(),
        data_dir,
        work_dir,
        result,
    }
}

impl Harness {
    async fn create_session(&self) {
        db::sessions::create(
            &self.state.pool,
            &NewSession {
                name: self.name.clone(),
                display_name: self.name.clone(),
                dir: self.work_dir.to_string_lossy().to_string(),
                desc: String::new(),
                provider: "shell".to_string(),
                creator: "test".to_string(),
                flags: String::new(),
                tags: "[]".to_string(),
                branch: String::new(),
                mcp: String::new(),
                worktree: false,
                worktree_repo: String::new(),
                host_id: None,
                runtime: "native".to_string(),
                model: String::new(),
                company_id: None,
            },
        )
        .await
        .expect("create session");
    }

    fn route(&self) -> String {
        format!("/api/sessions/{}/login", self.name)
    }

    async fn req(&self, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
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
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    async fn login_state(&self) -> Value {
        let (s, v) = self.req(Method::GET, &self.route(), None).await;
        assert_eq!(s, StatusCode::OK, "GET login: {v}");
        v["data"].clone()
    }

    /// Poll `GET /login` until it reports `stage`, or fail with what it saw.
    async fn await_stage(&self, stage: &str) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let mut last = Value::Null;
        while tokio::time::Instant::now() < deadline {
            last = self.login_state().await;
            if last["login"]["stage"] == json!(stage) {
                return last["login"].clone();
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        panic!("never reached stage {stage}; last read was {last}");
    }

    fn spool(&self) -> String {
        let p = self.data_dir.join("native").join(&self.name).join("out.raw");
        std::fs::read(&p)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    }

    async fn cleanup(self) {
        let _ = lifecycle::stop(&self.state, &self.name).await;
        login::unfreeze(&self.name);
        for d in [self.data_dir, self.work_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

#[tokio::test]
async fn the_login_flow_completes_against_a_real_pty() {
    let Some(py) = python() else {
        eprintln!("skipping: python3 is not on PATH");
        return;
    };
    if !holder_bin_ready() {
        eprintln!("skipping: the supermux-server binary is not built beside the test");
        return;
    }
    let h = spawn_harness("login-e2e-flow").await;
    let name = h.name.clone();
    h.create_session().await;
    lifecycle::start(&h.state, &name, None).await.expect("start");

    // Freeze first, exactly as `login::start` does — the window that matters
    // opens at the keystroke, not at the URL.
    login::freeze(&name, "login");
    let rt = h.state.runtime_for(&name).await.unwrap();
    rt.send_text(&format!(
        "FAKE_LOGIN_RESULT={} {} {}",
        h.result.display(),
        py.display(),
        fake_login().display()
    ))
    .await
    .unwrap();
    rt.send_key("Enter").await.unwrap();

    // ── 1. the card's inputs ────────────────────────────────────────────────
    let sighting = h.await_stage("paste_prompt").await;
    assert_eq!(sighting["flow"], json!("account"));
    let url = sighting["url"].as_str().expect("a URL on the card").to_string();
    assert!(
        url.starts_with("https://claude.com/cai/oauth/authorize?")
            && url.ends_with("&state=hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa"),
        "the URL must survive the grid's wrapping whole: {url}"
    );
    assert!(h.login_state().await["frozen"] == json!(true));

    // ── 2. the freeze is not decorative ─────────────────────────────────────
    let refused = lifecycle::send_text(&h.state, &name, "hello").await;
    assert!(
        matches!(refused, Err(ref e) if e.to_string().contains("signing in")),
        "an automatic writer must be refused mid-login, got {refused:?}"
    );
    assert_eq!(
        auto_heal(&h.state, &name, "test").await,
        Heal::Frozen,
        "a restart mid-login kills the PKCE verifier"
    );

    // ── 3. a malformed code never reaches the pty at all ────────────────────
    let (status, _) = h
        .req(
            Method::POST,
            &h.route(),
            Some(json!({ "action": "code", "code": "no-hash-here" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a code without its state nonce is rejected before it is written"
    );

    // ── 4. rejection, re-prompted IN PLACE (same process, same verifier) ────
    let pid_before = rt.pane_pid().await.unwrap();
    let (status, _) = h
        .req(
            Method::POST,
            &h.route(),
            Some(json!({ "action": "code", "code": BAD_CODE })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let invalid = h.await_stage("invalid").await;
    assert_eq!(
        invalid["message"],
        json!("Invalid code. Please make sure the full code was copied")
    );
    assert_eq!(
        rt.pane_pid().await.unwrap(),
        pid_before,
        "the retry must not respawn anything"
    );

    // ── 5. the good code, cleared first because the field was used ──────────
    let (status, _) = h
        .req(
            Method::POST,
            &h.route(),
            Some(json!({ "action": "code", "code": GOOD_CODE, "clear": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let success = h.await_stage("success").await;
    assert_eq!(success["email"], json!("sander@example.com"));

    assert_eq!(
        std::fs::read_to_string(&h.result).unwrap(),
        GOOD_CODE,
        "the provider must receive the code byte for byte, unbroken"
    );

    // ── 6. the mandatory Enter, and the release ─────────────────────────────
    let confirmed = PathBuf::from(format!("{}.confirmed", h.result.display()));
    assert!(!confirmed.exists(), "nothing has confirmed yet");
    let (status, _) = h
        .req(
            Method::POST,
            &h.route(),
            Some(json!({ "action": "confirm" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !confirmed.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        confirmed.exists(),
        "the Enter after 'Login successful' is what writes the onboarding flags — it must be sent"
    );
    assert!(!login::is_frozen(&name), "the freeze is released on confirm");
    assert!(
        lifecycle::send_text(&h.state, &name, "echo unfrozen").await.is_ok(),
        "writes resume once the login is done"
    );

    // ── 7. the credential is nowhere ────────────────────────────────────────
    let spool = h.spool();
    assert!(!spool.is_empty(), "the spool should have the session's output");
    assert!(
        !spool.contains(GOOD_CODE),
        "the pasted code must never reach the persisted pty spool"
    );
    assert!(
        !spool.contains(BAD_CODE),
        "not even the rejected one"
    );
    let row = db::sessions::get(&h.state.pool, &name).await.unwrap().unwrap();
    assert!(
        !row.last_send_text.contains(GOOD_CODE),
        "the code must never reach last_send_text: {}",
        row.last_send_text
    );

    h.cleanup().await;
}

/// The generic paste box was the only way to drive this flow before the login
/// card existed, and it persists what it pastes. Anyone who does it the old way
/// must not leave a live credential in the database.
#[tokio::test]
async fn a_code_pasted_through_the_generic_box_is_masked_in_what_is_stored() {
    if !holder_bin_ready() {
        eprintln!("skipping: the supermux-server binary is not built beside the test");
        return;
    }
    let h = spawn_harness("login-e2e-paste").await;
    let name = h.name.clone();
    h.create_session().await;
    lifecycle::start(&h.state, &name, None).await.expect("start");

    lifecycle::paste(&h.state, &name, GOOD_CODE, false)
        .await
        .expect("paste");
    let row = db::sessions::get(&h.state.pool, &name).await.unwrap().unwrap();
    assert!(
        !row.last_send_text.contains(GOOD_CODE),
        "stored preview still carries the credential: {}",
        row.last_send_text
    );
    assert!(row.last_send_text.contains(login::REDACTED_CODE));

    h.cleanup().await;
}
