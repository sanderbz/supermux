//! Integration tests for the files subsystem.
//!
//! Driven through the full router (`http::router`) via `oneshot`, so every call
//! also exercises the bearer-auth layer. Covers: directory listing, creating a
//! brand-new file (regression: this used to 500), text round-trip, Range serving, and
//! the path-safety blocklist incl. macOS case-insensitivity and a TOCTOU
//! symlink swap.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "files-test-token";

struct TestEnv {
    app: axum::Router,
    /// Kept so a test can read the audit ledger / seed a company row through
    /// the same pool the handlers write to.
    state: AppState,
    data_dir: std::path::PathBuf,
    work_dir: std::path::PathBuf,
}

async fn setup() -> TestEnv {
    let uniq = uuid::Uuid::new_v4();
    let data_dir = std::env::temp_dir().join(format!("supermux-files-data-{uniq}"));
    let work_dir = std::env::temp_dir().join(format!("supermux-files-work-{uniq}"));
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&work_dir).unwrap();
    let config = Config {
        data_dir: data_dir.clone(),
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
    TestEnv { app: http::router(state.clone()), state, data_dir, work_dir }
}

/// True iff the audit ledger holds a row with this action + target.
async fn audited(env: &TestEnv, action: &str, target: &str) -> bool {
    db::audit::list(&env.state.pool, 200)
        .await
        .expect("audit list")
        .iter()
        .any(|e| e.action == action && e.target == target)
}

/// One audit row's `detail` JSON for an action + target.
async fn audit_detail(env: &TestEnv, action: &str, target: &str) -> Value {
    let rows = db::audit::list(&env.state.pool, 200).await.expect("audit list");
    let row = rows
        .iter()
        .find(|e| e.action == action && e.target == target)
        .unwrap_or_else(|| panic!("no audit row for {action} on {target}"));
    serde_json::from_str(&row.detail).unwrap_or(Value::Null)
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
        let _ = std::fs::remove_dir_all(&self.work_dir);
    }
}

fn authed(method: Method, uri: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .unwrap()
}

fn authed_json(method: Method, uri: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn json_body(resp: axum::http::Response<Body>) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn enc(path: &std::path::Path) -> String {
    urlencode(&path.to_string_lossy())
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tokio::test]
async fn ls_lists_entries_and_hides_dotfiles() {
    let env = setup().await;
    std::fs::write(env.work_dir.join("a.txt"), b"a").unwrap();
    std::fs::write(env.work_dir.join("b.txt"), b"bb").unwrap();
    std::fs::write(env.work_dir.join(".secret"), b"x").unwrap();
    std::fs::create_dir(env.work_dir.join("sub")).unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, &format!("/api/ls?path={}", enc(&env.work_dir))))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    let names: Vec<&str> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"a.txt"));
    assert!(names.contains(&"b.txt"));
    assert!(names.contains(&"sub"));
    assert!(!names.contains(&".secret"), "dotfiles hidden by default");
    // Directory sorts first.
    assert_eq!(body["entries"][0]["name"], "sub");
}

#[tokio::test]
async fn put_creates_brand_new_file_then_get_roundtrips() {
    // Regression: PUT to a not-yet-existing nested path must not 500.
    let env = setup().await;
    let target = env.work_dir.join("nested/dir/new.md");
    let content = "# hello\nworld\n";

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({ "path": target.to_string_lossy(), "content": content }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "PUT to brand-new file succeeds");
    let body = json_body(resp).await;
    assert_eq!(body["ok"], true);

    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, &format!("/api/file?path={}", enc(&target))))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["content"], content);
    assert_eq!(body["is_markdown"], true);
}

#[tokio::test]
async fn raw_range_returns_206_with_correct_bytes() {
    let env = setup().await;
    let target = env.work_dir.join("data.bin");
    let data: Vec<u8> = (0u8..=255).collect();
    std::fs::write(&target, &data).unwrap();

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/file/raw?path={}", enc(&target)))
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::RANGE, "bytes=10-19")
        .body(Body::empty())
        .unwrap();
    let resp = env.app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(resp.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 10-19/256");
    assert_eq!(resp.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], &data[10..=19]);
}

#[tokio::test]
async fn raw_if_none_match_returns_304() {
    let env = setup().await;
    let target = env.work_dir.join("etag.txt");
    std::fs::write(&target, b"cacheable").unwrap();

    // First request to learn the ETag.
    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, &format!("/api/file/raw?path={}", enc(&target))))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let etag = resp.headers().get(header::ETAG).unwrap().to_str().unwrap().to_string();

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/file/raw?path={}", enc(&target)))
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::IF_NONE_MATCH, &etag)
        .body(Body::empty())
        .unwrap();
    let resp = env.app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn put_to_etc_shadow_is_403() {
    let env = setup().await;
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({ "path": "/etc/shadow", "content": "pwned" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN, "blocked path → 403");
}

#[tokio::test]
async fn put_to_uppercase_etc_shadow_is_403() {
    // macOS HFS+/APFS case-insensitivity: /ETC/SHADOW canonicalizes onto the
    // blocked /private/etc/shadow; the lowercase compare must catch it.
    let env = setup().await;
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({ "path": "/ETC/SHADOW", "content": "pwned" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn put_through_symlink_to_blocked_path_is_403() {
    // TOCTOU: a symlink pointing at a blocked secret. If the target exists it
    // canonicalizes onto the blocklist; if not, O_NOFOLLOW refuses the swap.
    // Either way the write must be refused with 403.
    #[cfg(unix)]
    {
        let env = setup().await;
        let blocked_target = ["/etc/sudoers", "/etc/master.passwd", "/etc/shadow"]
            .into_iter()
            .find(|p| std::path::Path::new(p).exists())
            .unwrap_or("/etc/shadow");
        let link = env.work_dir.join("link");
        std::os::unix::fs::symlink(blocked_target, &link).unwrap();

        let resp = env
            .app
            .clone()
            .oneshot(authed_json(
                Method::PUT,
                "/api/file",
                &json!({ "path": link.to_string_lossy(), "content": "pwned" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "symlink to blocked → 403");
        // The real secret must be untouched.
        if std::path::Path::new(blocked_target).exists() {
            let on_disk = std::fs::read_to_string(blocked_target).unwrap_or_default();
            assert_ne!(on_disk, "pwned");
        }
    }
}

#[tokio::test]
async fn unauthenticated_files_call_is_401() {
    // Every files route lives behind the bearer layer — no loopback bypass.
    let env = setup().await;
    let resp = env
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/ls?path={}", enc(&env.work_dir)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn delete_removes_file_and_audits() {
    let env = setup().await;
    let target = env.work_dir.join("trash.txt");
    std::fs::write(&target, b"bye").unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::DELETE,
            "/api/fs/delete",
            &json!({ "path": target.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(!target.exists(), "file removed");
}

#[tokio::test]
async fn put_non_writable_extension_is_403() {
    let env = setup().await;
    let target = env.work_dir.join("evil.exe");
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({ "path": target.to_string_lossy(), "content": "x" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert!(!target.exists());
}

#[tokio::test]
async fn base64_upload_rejects_fake_image_and_serves_real_one() {
    let env = setup().await;

    // A .png whose bytes are not a PNG → rejected by magic-byte check.
    let fake = json!({ "name": "fake.png", "data": "aGVsbG8gd29ybGQ=" }); // "hello world"
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(Method::POST, "/api/upload", &fake))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "fake image rejected");

    // A real 1x1 PNG.
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52,
    ];
    let real = json!({
        "name": "real.png",
        "data": base64_std(png),
    });
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(Method::POST, "/api/upload", &real))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    let url = body["url"].as_str().unwrap().to_string();

    // The returned url is fetchable.
    let resp = env.app.clone().oneshot(authed(Method::GET, &url)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], png);
}

fn base64_std(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ── "Where" autocomplete: dotfile filter + projects/repos ────────────────────

/// `GET /api/autocomplete/dir?q=…&hidden=0` filters dotfile subdirs.
#[tokio::test]
async fn autocomplete_hidden_filter() {
    let env = setup().await;
    // Seed two normal dirs and two dotfile dirs.
    for name in ["alpha", "beta", ".git", ".cache"] {
        std::fs::create_dir_all(env.work_dir.join(name)).unwrap();
    }
    let q = format!("{}/", env.work_dir.display());
    let q_enc = urlencode(&q);

    // Default (no hidden param): legacy behaviour — dotfiles INCLUDED.
    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, &format!("/api/autocomplete/dir?q={q_enc}")))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    let names: Vec<String> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            std::path::Path::new(v.as_str().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(names.contains(&".git".to_string()), "default keeps dotfiles");
    assert!(names.contains(&"alpha".to_string()));

    // hidden=0 → dotfiles dropped.
    let resp = env
        .app
        .clone()
        .oneshot(authed(
            Method::GET,
            &format!("/api/autocomplete/dir?q={q_enc}&hidden=0"),
        ))
        .await
        .unwrap();
    let body = json_body(resp).await;
    let names: Vec<String> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            std::path::Path::new(v.as_str().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(!names.contains(&".git".to_string()), "hidden=0 drops dotfiles");
    assert!(!names.contains(&".cache".to_string()));
    assert!(names.contains(&"alpha".to_string()));
    assert!(names.contains(&"beta".to_string()));
}

/// Process-global serial guard around `SUPERMUX_PROJECT_DIRS` env-mutating
/// tests so the two below can't race each other (cargo test runs tests in
/// parallel by default).
static PROJECTS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `GET /api/projects/repos` reads `SUPERMUX_PROJECT_DIRS`, returns subdirs
/// with `is_git_repo` set per `.git` presence (directory OR file). Hidden
/// entries filtered.
#[tokio::test]
async fn projects_repos_lists_git_subdirs() {
    let _guard = PROJECTS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = setup().await;
    // Seed a fake projects root with: a real git dir (.git as dir), a worktree-
    // style entry (.git as file), a non-repo, and a dotfile dir (must be hidden).
    let proj_root = env.work_dir.join("projects-root");
    std::fs::create_dir_all(&proj_root).unwrap();
    let repo_a = proj_root.join("repo-a");
    std::fs::create_dir_all(repo_a.join(".git")).unwrap();
    let wt_b = proj_root.join("worktree-b");
    std::fs::create_dir_all(&wt_b).unwrap();
    std::fs::write(wt_b.join(".git"), "gitdir: /tmp/elsewhere\n").unwrap();
    let plain = proj_root.join("plain-folder");
    std::fs::create_dir_all(&plain).unwrap();
    let hidden = proj_root.join(".hidden");
    std::fs::create_dir_all(&hidden).unwrap();

    // SAFETY: env mutation is process-global; the `set_var`/`remove_var` calls
    // are unsafe in current std but our test process owns the env entirely.
    unsafe {
        std::env::set_var("SUPERMUX_PROJECT_DIRS", proj_root.display().to_string());
    }
    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, "/api/projects/repos"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    unsafe { std::env::remove_var("SUPERMUX_PROJECT_DIRS") };

    // `root` field surfaces the configured path.
    assert_eq!(body["root"].as_str().unwrap(), proj_root.display().to_string());

    let entries = body["entries"].as_array().unwrap();
    let by_name: std::collections::HashMap<String, &Value> = entries
        .iter()
        .map(|e| (e["name"].as_str().unwrap().to_string(), e))
        .collect();

    // .hidden filtered.
    assert!(!by_name.contains_key(".hidden"));
    // Real git dir → is_git_repo=true.
    assert_eq!(by_name["repo-a"]["is_git_repo"].as_bool().unwrap(), true);
    // Worktree-style .git FILE also counts as a repo.
    assert_eq!(by_name["worktree-b"]["is_git_repo"].as_bool().unwrap(), true);
    // Non-repo → false.
    assert_eq!(by_name["plain-folder"]["is_git_repo"].as_bool().unwrap(), false);

    // Alphabetical order.
    let names: Vec<&str> = entries.iter().map(|e| e["name"].as_str().unwrap()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "entries are alphabetical");
}

/// When `SUPERMUX_PROJECT_DIRS` is unset, the endpoint returns empty `root` +
/// `entries` (the UI then hides the Projects section gracefully).
#[tokio::test]
async fn projects_repos_unset_returns_empty() {
    let _guard = PROJECTS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let env = setup().await;
    unsafe { std::env::remove_var("SUPERMUX_PROJECT_DIRS") };
    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, "/api/projects/repos"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["root"].as_str().unwrap(), "");
    assert_eq!(body["entries"].as_array().unwrap().len(), 0);
}

// ──────────────── namespace verbs: mkdir / rename(move) / copy ────────────────

#[tokio::test]
async fn mkdir_creates_nested_dir_and_audits() {
    let env = setup().await;
    let target = env.work_dir.join("reports/2026/q3");

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/mkdir",
            &json!({ "path": target.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "mkdir creates parents");
    let body = json_body(resp).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["path"], target.to_string_lossy().into_owned());
    assert!(target.is_dir(), "the directory really exists on disk");
    assert!(
        audited(&env, "dir.create", &target.to_string_lossy()).await,
        "mkdir writes a dir.create audit row"
    );
}

#[tokio::test]
async fn mkdir_on_existing_path_is_409() {
    // Idempotent-mkdir would silently swallow a typo on a shared drive.
    let env = setup().await;
    let target = env.work_dir.join("already");
    std::fs::create_dir(&target).unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/mkdir",
            &json!({ "path": target.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT, "existing target → 409");

    // A pre-existing FILE at the target is equally a conflict.
    let file = env.work_dir.join("taken.txt");
    std::fs::write(&file, b"x").unwrap();
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/mkdir",
            &json!({ "path": file.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT, "existing file at target → 409");
}

#[tokio::test]
async fn rename_moves_file_across_dirs_and_audits() {
    let env = setup().await;
    let from = env.work_dir.join("draft.md");
    std::fs::write(&from, b"# draft\n").unwrap();
    std::fs::create_dir(env.work_dir.join("archive")).unwrap();
    let to = env.work_dir.join("archive/final.md");

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["from"], from.to_string_lossy().into_owned());
    assert_eq!(body["to"], to.to_string_lossy().into_owned());
    assert!(!from.exists(), "source is gone");
    assert_eq!(std::fs::read(&to).unwrap(), b"# draft\n", "destination has the bytes");
    assert!(audited(&env, "file.rename", &from.to_string_lossy()).await);
    assert_eq!(
        audit_detail(&env, "file.rename", &from.to_string_lossy()).await["to"],
        to.to_string_lossy().into_owned()
    );
}

#[tokio::test]
async fn rename_to_existing_dest_is_409_unless_overwrite() {
    let env = setup().await;
    let from = env.work_dir.join("a.txt");
    let to = env.work_dir.join("b.txt");
    std::fs::write(&from, b"aaa").unwrap();
    std::fs::write(&to, b"bbb").unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT, "silent clobber is refused");
    assert_eq!(std::fs::read(&to).unwrap(), b"bbb", "destination untouched");
    assert!(from.exists(), "source untouched");

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({
                "from": from.to_string_lossy(),
                "to": to.to_string_lossy(),
                "overwrite": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "explicit overwrite is allowed");
    assert_eq!(std::fs::read(&to).unwrap(), b"aaa");
    assert!(!from.exists());
}

#[tokio::test]
async fn rename_dir_into_itself_is_400_but_a_sibling_prefix_is_fine() {
    let env = setup().await;
    let acme = env.work_dir.join("acme");
    std::fs::create_dir(&acme).unwrap();

    // `to` inside `from` — the classic move-a-dir-into-itself.
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({
                "from": acme.to_string_lossy(),
                "to": acme.join("inner").to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "dir into itself → 400");
    assert!(acme.is_dir(), "nothing moved");

    // `from` == `to` is the same refusal.
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({ "from": acme.to_string_lossy(), "to": acme.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "from == to → 400");

    // …but `/acme-corp` is NOT inside `/acme`: the prefix compare is
    // `/`-delimited, so this must succeed.
    let sibling = env.work_dir.join("acme-corp");
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({ "from": acme.to_string_lossy(), "to": sibling.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "a sibling-prefix name is not 'inside'");
    assert!(sibling.is_dir());
    assert!(!acme.exists());
}

#[tokio::test]
async fn rename_of_a_company_root_is_403() {
    // Renaming a company root desynchronizes `companies.root_dir` from disk and
    // silently re-points a member's jail.
    let env = setup().await;
    let root = env.work_dir.join("acme-root");
    std::fs::create_dir(&root).unwrap();
    db::companies::create(&env.state.pool, "acme", "Acme", &root.to_string_lossy())
        .await
        .expect("company row");

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({
                "from": root.to_string_lossy(),
                "to": env.work_dir.join("renamed-root").to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN, "a company root cannot be moved");
    assert!(root.is_dir(), "the root is still where the DB says it is");

    // A path INSIDE the root is of course movable.
    let inside = root.join("note.md");
    std::fs::write(&inside, b"hi").unwrap();
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({
                "from": inside.to_string_lossy(),
                "to": root.join("note2.md").to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "files inside a company root move freely");
}

/// BLOCKER regression: `safe_path_scoped` only asserts `abs.starts_with(jail)`,
/// and a jail ROOT trivially satisfies that on ITSELF — so a scoped member could
/// `DELETE /api/fs/delete` their own company's `root_dir` and `remove_dir_all`
/// the entire Drive in one request. The root is not secret either: `GET
/// /api/companies` hands `root_dir` to the member. Same 403 as rename.
#[tokio::test]
async fn delete_of_a_company_root_is_403() {
    let env = setup().await;
    let root = env.work_dir.join("acme-root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("keep.md"), b"the whole drive").unwrap();
    db::companies::create(&env.state.pool, "acme", "Acme", &root.to_string_lossy())
        .await
        .expect("company row");

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::DELETE,
            "/api/fs/delete",
            &json!({ "path": root.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN, "a company root cannot be deleted");
    assert!(root.is_dir(), "the Drive is still there");
    assert_eq!(
        std::fs::read(root.join("keep.md")).unwrap(),
        b"the whole drive",
        "and so is its content"
    );

    // Everything INSIDE the root still deletes freely — this is a guard on one
    // path, not a blanket deny.
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::DELETE,
            "/api/fs/delete",
            &json!({ "path": root.join("keep.md").to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "files inside a company root delete freely");
    assert!(!root.join("keep.md").exists());
}

#[tokio::test]
async fn copy_file_leaves_source_intact() {
    let env = setup().await;
    let from = env.work_dir.join("orig.txt");
    let to = env.work_dir.join("orig (copy).txt");
    std::fs::write(&from, b"payload").unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/copy",
            &json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(std::fs::read(&from).unwrap(), b"payload", "source intact");
    assert_eq!(std::fs::read(&to).unwrap(), b"payload", "copy has the bytes");
    assert!(audited(&env, "file.copy", &from.to_string_lossy()).await);

    // A second copy onto the same destination is a 409 (the Duplicate flow's
    // "name (copy 2)" retry hangs off exactly this).
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/copy",
            &json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn copy_of_a_directory_is_400() {
    let env = setup().await;
    let from = env.work_dir.join("adir");
    std::fs::create_dir(&from).unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/copy",
            &json!({
                "from": from.to_string_lossy(),
                "to": env.work_dir.join("bdir").to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "recursive copy is v2");
    assert!(!env.work_dir.join("bdir").exists());
}

// ───────────────── PUT /api/file — the `if_modified` lost-update guard ─────────

/// `GET /api/file`'s TEXT branch must carry `modified` — without it the client
/// has nothing to hand back as `if_modified`.
#[tokio::test]
async fn get_file_text_envelope_carries_modified() {
    let env = setup().await;
    let target = env.work_dir.join("notes.md");
    std::fs::write(&target, b"# hi\n").unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, &format!("/api/file?path={}", enc(&target))))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert!(
        body["modified"].as_i64().unwrap_or(0) > 0,
        "text envelope carries a real mtime: {body}"
    );
    assert_eq!(body["size"].as_u64(), Some(5));
}

#[tokio::test]
async fn put_with_stale_if_modified_is_409_and_leaves_bytes_untouched() {
    let env = setup().await;
    let target = env.work_dir.join("shared.md");
    std::fs::write(&target, b"bot wrote this\n").unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({
                "path": target.to_string_lossy(),
                "content": "human clobber\n",
                "if_modified": 1,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT, "stale mtime → 409");
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"bot wrote this\n",
        "the file on disk is byte-identical"
    );
}

#[tokio::test]
async fn put_with_matching_if_modified_writes() {
    let env = setup().await;
    let target = env.work_dir.join("shared.md");
    std::fs::write(&target, b"v1\n").unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, &format!("/api/file?path={}", enc(&target))))
        .await
        .unwrap();
    let modified = json_body(resp).await["modified"].as_i64().unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({
                "path": target.to_string_lossy(),
                "content": "v2\n",
                "if_modified": modified,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "matching mtime writes");
    assert_eq!(std::fs::read(&target).unwrap(), b"v2\n");
    assert_eq!(
        audit_detail(&env, "file.put", &target.to_string_lossy()).await["if_modified"],
        json!(modified),
        "the audit row records the check that ran"
    );
}

#[tokio::test]
async fn put_with_if_modified_zero_on_existing_file_is_409() {
    let env = setup().await;
    let target = env.work_dir.join("exists.md");
    std::fs::write(&target, b"already here\n").unwrap();

    // `0` is the "I am creating a NEW file" assertion.
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({
                "path": target.to_string_lossy(),
                "content": "overwrite\n",
                "if_modified": 0,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    assert_eq!(std::fs::read(&target).unwrap(), b"already here\n");

    // …and on a genuinely absent path it writes.
    let fresh = env.work_dir.join("fresh.md");
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({
                "path": fresh.to_string_lossy(),
                "content": "new\n",
                "if_modified": 0,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "if_modified=0 creates a new file");
    assert_eq!(std::fs::read(&fresh).unwrap(), b"new\n");
}

#[tokio::test]
async fn put_with_if_modified_on_a_vanished_file_is_409() {
    let env = setup().await;
    let gone = env.work_dir.join("gone.md");

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({
                "path": gone.to_string_lossy(),
                "content": "resurrect\n",
                "if_modified": 1_700_000_000i64,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT, "file no longer exists → 409");
    assert!(!gone.exists());
}

#[tokio::test]
async fn put_without_if_modified_is_still_a_blind_write() {
    // Every existing caller keeps working, byte-for-byte.
    let env = setup().await;
    let target = env.work_dir.join("legacy.md");
    std::fs::write(&target, b"old\n").unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({ "path": target.to_string_lossy(), "content": "new\n" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(std::fs::read(&target).unwrap(), b"new\n");
}

#[tokio::test]
async fn text_limit_is_one_megabyte() {
    let env = setup().await;
    let target = env.work_dir.join("big.log");
    let body_text = "x".repeat(900 * 1024);
    std::fs::write(&target, &body_text).unwrap();

    let resp = env
        .app
        .clone()
        .oneshot(authed(Method::GET, &format!("/api/file?path={}", enc(&target))))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["truncated"], false, "900 KB is inside the 1 MB text limit");
    assert_eq!(body["content"].as_str().unwrap().len(), 900 * 1024);
}

// ───────────────────── the company-stamped `files` SSE frame ──────────────────

/// R6 — the `files` frame is this app's FIRST company-routed producer, so this
/// is the first end-to-end proof that `SseEvent::for_company` routing works
/// against a real subscriber. A frame for a path under company A's root must be
/// stamped A: unstamped would be a missing update (safe), but a frame stamped
/// with the WRONG company leaks another company's filenames to a member and
/// nothing downstream would catch it.
#[tokio::test]
async fn files_frame_is_company_stamped_by_path() {
    use supermux_server::scope::Scope;

    let env = setup().await;
    let root_a = env.work_dir.join("acme");
    let root_b = env.work_dir.join("beta");
    std::fs::create_dir(&root_a).unwrap();
    std::fs::create_dir(&root_b).unwrap();
    let a = db::companies::create(&env.state.pool, "acme", "Acme", &root_a.to_string_lossy())
        .await
        .expect("company A");
    let b = db::companies::create(&env.state.pool, "beta", "Beta", &root_b.to_string_lossy())
        .await
        .expect("company B");

    let mut rx = env.state.sse_tx.subscribe();

    let target = root_a.join("reports/q3");
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/mkdir",
            &json!({ "path": target.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let frame = rx.try_recv().expect("a files frame was published");
    assert_eq!(frame.event, "files");
    assert_eq!(frame.payload["op"], "mkdir");
    assert_eq!(frame.payload["path"], target.to_string_lossy().into_owned());
    assert_eq!(
        frame.payload["dir"],
        root_a.join("reports").to_string_lossy().into_owned(),
        "`dir` is computed server-side — the FE never dirname()s"
    );
    assert_eq!(frame.company_id, Some(a.id), "stamped with the OWNING company");
    assert!(Scope::Company(a.id).sees(frame.company_id), "company A sees it");
    assert!(
        !Scope::Company(b.id).sees(frame.company_id),
        "company B must NEVER see company A's filenames"
    );
    assert!(Scope::All.sees(frame.company_id), "the owner sees everything");
}

/// A path under NO company root (HQ) stays unstamped → owner/admin only, because
/// `Scope::sees(None)` is fail-closed for a scoped human. A missing update is the
/// safe failure mode.
#[tokio::test]
async fn files_frame_outside_any_company_root_is_unstamped() {
    use supermux_server::scope::Scope;

    let env = setup().await;
    let root_a = env.work_dir.join("acme");
    std::fs::create_dir(&root_a).unwrap();
    let a = db::companies::create(&env.state.pool, "acme", "Acme", &root_a.to_string_lossy())
        .await
        .expect("company A");

    let mut rx = env.state.sse_tx.subscribe();

    // `…/acme-corp` is a SIBLING of the company root, not inside it — the
    // prefix match is `/`-delimited.
    let target = env.work_dir.join("acme-corp/notes");
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/mkdir",
            &json!({ "path": target.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let frame = rx.try_recv().expect("a files frame was published");
    assert_eq!(frame.company_id, None, "an HQ path is unstamped");
    assert!(!Scope::Company(a.id).sees(frame.company_id), "fail-closed for a member");
    assert!(Scope::All.sees(frame.company_id), "the owner still sees it");
}

/// Every mutating file handler emits, not just the new verbs.
#[tokio::test]
async fn put_delete_and_rename_all_emit_files_frames() {
    let env = setup().await;
    let target = env.work_dir.join("live.md");

    let mut rx = env.state.sse_tx.subscribe();

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::PUT,
            "/api/file",
            &json!({ "path": target.to_string_lossy(), "content": "hi\n" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let f = rx.try_recv().expect("put emits");
    assert_eq!((f.event.as_str(), &f.payload["op"]), ("files", &json!("put")));

    let moved = env.work_dir.join("live2.md");
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({ "from": target.to_string_lossy(), "to": moved.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let f = rx.try_recv().expect("rename emits");
    assert_eq!(f.payload["op"], "rename");
    assert_eq!(f.payload["path"], moved.to_string_lossy().into_owned());
    assert_eq!(
        f.payload["from"],
        target.to_string_lossy().into_owned(),
        "rename carries the old path"
    );

    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::DELETE,
            "/api/fs/delete",
            &json!({ "path": moved.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let f = rx.try_recv().expect("delete emits");
    assert_eq!(f.payload["op"], "delete");
}

/// An OWNER can rename ACROSS company roots (jail `None`). The destination
/// company's members legitimately learn the new filename — but the frame also
/// carried `from` verbatim, so company A's naming leaked into company B's
/// stream. A cross-company `from` is dropped.
#[tokio::test]
async fn cross_company_rename_frame_drops_the_foreign_from_path() {
    let env = setup().await;
    let root_a = env.work_dir.join("acme");
    let root_b = env.work_dir.join("beta");
    std::fs::create_dir(&root_a).unwrap();
    std::fs::create_dir(&root_b).unwrap();
    let _a = db::companies::create(&env.state.pool, "acme", "Acme", &root_a.to_string_lossy())
        .await
        .expect("company A");
    let b = db::companies::create(&env.state.pool, "beta", "Beta", &root_b.to_string_lossy())
        .await
        .expect("company B");

    let from = root_a.join("acme-secret-codename.md");
    std::fs::write(&from, b"x").unwrap();
    let to = root_b.join("moved.md");

    let mut rx = env.state.sse_tx.subscribe();
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "the owner may move across roots");

    let frame = rx.try_recv().expect("a files frame was published");
    assert_eq!(frame.company_id, Some(b.id), "stamped with the DESTINATION's company");
    assert_eq!(frame.payload["path"], to.to_string_lossy().into_owned());
    assert_eq!(
        frame.payload["from"],
        Value::Null,
        "company A's path must not ride into company B's stream"
    );

    // Within ONE company the `from` is kept — it is what lets the client drop
    // the old row instead of refetching.
    let inside_from = root_b.join("moved.md");
    let inside_to = root_b.join("moved2.md");
    let resp = env
        .app
        .clone()
        .oneshot(authed_json(
            Method::POST,
            "/api/fs/rename",
            &json!({ "from": inside_from.to_string_lossy(), "to": inside_to.to_string_lossy() }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let frame = rx.try_recv().expect("a files frame was published");
    assert_eq!(frame.company_id, Some(b.id));
    assert_eq!(
        frame.payload["from"],
        inside_from.to_string_lossy().into_owned(),
        "a same-company from is preserved"
    );
}
