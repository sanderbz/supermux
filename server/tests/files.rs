//! Integration tests for the files subsystem (TECH_PLAN M7, §3.2.11).
//!
//! Driven through the full router (`http::router`) via `oneshot`, so every call
//! also exercises the bearer-auth layer. Covers: directory listing, creating a
//! brand-new file (Codex #3 regression), text round-trip, Range serving, and
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
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    TestEnv { app: http::router(state), data_dir, work_dir }
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
    // Codex #3 regression: PUT to a not-yet-existing nested path must not 500.
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
