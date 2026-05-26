//! Embedded frontend assets + SPA serving (TECH_PLAN §3.2 lines 134/153/2530, §8.1).
//!
//! The built web app (`web/dist`, copied to `server/static` by `scripts/build.sh`
//! and `build.rs`) is embedded into the binary at compile time via `rust-embed`,
//! so the single `supermux-server` binary serves the *whole* product — not just
//! `/api` + `/ws`. Without this layer the deployed binary 404s on `GET /` and
//! the SPA never receives its auth token (§3.2 line 153, R4-01).
//!
//! **Routes (PUBLIC — no bearer layer).** Mounted on the public router in
//! `http::router` AFTER the protected `.layer(...)` so no auth middleware wraps
//! them. The HTML body itself is public; the inline `window._SUPERMUX_AUTH_TOKEN` is
//! the §1.4/§6.1 documented trade-off (token-in-HTML, acceptable because the
//! server binds 127.0.0.1 + Tailscale and Tailscale provides device auth).
//!
//!   * `GET /`                — `index.html` with the runtime config injected.
//!   * `GET /{*path}` fallback — a hashed asset if it exists, else `index.html`
//!     (SPA client-side routing). `/api/*` and `/ws/*` are denylisted so a
//!     missing API route still 404s as JSON instead of silently serving HTML.
//!
//! **Token injection.** `index.html` carries no placeholder; the served HTML has
//! an inline
//! `<script>window._SUPERMUX_AUTH_TOKEN=…;window._SUPERMUX_VERSION=…;window._SUPERMUX_HOME_DIR=…</script>`
//! spliced in immediately before `<div id="root">`, which is where the SPA
//! (`web/src/env.ts`) reads them. `_SUPERMUX_HOME_DIR` lets the New-session form
//! pre-fill its working-directory field so a session boots in one click.
//!
//! **No `_SUPERMUX_BASE_URL` injection.** The server-served SPA is *always*
//! same-origin with its own API — whatever host/scheme the user reached the
//! page on (localhost, or the https Tailscale hostname via `tailscale serve`)
//! IS the API origin. The server's `bind` address (e.g. `127.0.0.1:8823`) is an
//! internal detail and is NEVER a correct client base URL: injecting it makes
//! the SPA fire all HTTP + SSE requests cross-origin, which the browser
//! CORS-blocks (the connection banner then sticks on "Reconnecting…"). So we do
//! NOT set `window._SUPERMUX_BASE_URL`; the SPA (`env.ts` `baseUrl()`) falls back to
//! `import.meta.env.BASE_URL` → relative, same-origin requests. `_SUPERMUX_BASE_URL`
//! is reserved for the future Capacitor native-wrap case (a WebView with no
//! same-origin server), where the native bootstrap script sets it explicitly.

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;

use crate::state::AppState;

/// The embedded frontend bundle. `scripts/build.sh` / `build.rs` copy
/// `web/dist` → `server/static` before `cargo build`, and `rust-embed` reads
/// that directory at compile time (the dir is gitignored — that is fine, the
/// embed is a compile-time read, not a runtime one).
#[derive(RustEmbed)]
#[folder = "static/"]
struct Assets;

/// Build the public (no-auth) static-asset sub-router: the SPA shell at `/` and
/// a catch-all fallback that serves hashed assets or falls back to the shell.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .fallback(get(asset_or_index))
        .with_state(state)
}

/// `GET /` — the SPA shell with the runtime config injected.
async fn index(State(state): State<AppState>) -> Response {
    serve_index(&state)
}

/// SPA fallback: serve the request path as an embedded asset if it exists,
/// otherwise the injected `index.html` (client-side routing). `/api/*` and
/// `/ws/*` are NOT served as HTML — a missing API route must 404 as itself, not
/// the SPA shell.
///
/// The path is read from the request [`Uri`], not a `Path` extractor: a
/// `.fallback` route has no path pattern, so `Path<String>` would be a
/// rejection (HTTP 500). The `Uri` always carries the literal request path.
async fn asset_or_index(State(state): State<AppState>, uri: Uri) -> Response {
    let trimmed = uri.path().trim_start_matches('/');

    // Denylist the backend route namespaces: a request that fell through to the
    // fallback under /api or /ws is a genuine 404, not a page navigation.
    if trimmed == "api"
        || trimmed == "ws"
        || trimmed.starts_with("api/")
        || trimmed.starts_with("ws/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }

    match Assets::get(trimmed) {
        Some(file) => {
            let mime = file.metadata.mimetype();
            let mut resp = Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, cache_control(trimmed))
                .body(Body::from(file.data.into_owned()))
                .unwrap();
            // rust-embed exposes a content hash; surface it as a weak ETag.
            if let Some(hash) = hex_etag(&file.metadata.sha256_hash()) {
                resp.headers_mut()
                    .insert(header::ETAG, HeaderValue::from_str(&hash).unwrap());
            }
            resp
        }
        // Unknown path with no file extension → an SPA client-route; serve the
        // shell so the front-end router can resolve it.
        None => serve_index(&state),
    }
}

/// Render `index.html` with `window._SUPERMUX_*` runtime config spliced in before
/// `<div id="root">`.
fn serve_index(state: &AppState) -> Response {
    let Some(raw) = Assets::get("index.html") else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "frontend bundle missing from binary (build.sh did not embed web/dist)",
        )
            .into_response();
    };
    let html = String::from_utf8_lossy(&raw.data);
    let injected = inject_runtime_config(&html, state);

    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        // The shell must never be cached: the injected token + the hashed-asset
        // references inside it change per build/token.
        .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
        .body(Body::from(injected))
        .unwrap()
}

/// Splice the runtime-config `<script>` in before `<div id="root">`. The SPA
/// (`web/src/env.ts`) reads `window._SUPERMUX_AUTH_TOKEN` / `_VERSION`.
///
/// Deliberately does NOT set `window._SUPERMUX_BASE_URL`: the server-served SPA is
/// same-origin with its own API, so the SPA must use relative URLs. With the
/// global left `undefined`, `env.ts` `baseUrl()` falls back to
/// `import.meta.env.BASE_URL` → same-origin relative requests. Injecting the
/// server's `bind` address here would pin every HTTP + SSE request to a fixed
/// origin and break the app whenever the page is reached via any other host
/// (localhost, the Tailscale hostname) — a cross-origin CORS failure.
fn inject_runtime_config(html: &str, state: &AppState) -> String {
    // `_SUPERMUX_HOME_DIR`: the server's home directory. The New-session form
    // pre-fills its working-directory field with this so a session can be
    // created in one click without typing a path. Empty string if unresolved
    // (the create handler then falls back to the home dir server-side anyway).
    let home_dir = dirs::home_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    // `_SUPERMUX_PROJECT_DIR`: the FIRST project directory from the deploy-time
    // `SUPERMUX_PROJECT_DIRS` env var (smart default `<home>/projects`; clawd-02
    // is `/opt/projects`). Start-a-team pre-fills its directory field with this
    // (with a trailing slash) so the autocomplete on focus immediately surfaces
    // the project repos — making "pick a repo" one click. Empty string when the
    // var is unset (the form falls back to home).
    let projects_dir = std::env::var("SUPERMUX_PROJECT_DIRS")
        .ok()
        .and_then(|s| s.split(':').next().map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let script = format!(
        "<script>window._SUPERMUX_AUTH_TOKEN={token};window._SUPERMUX_VERSION={version};window._SUPERMUX_HOME_DIR={home};window._SUPERMUX_PROJECT_DIR={projects};</script>",
        token = json_string(&state.config.auth_token),
        version = json_string(env!("CARGO_PKG_VERSION")),
        home = json_string(&home_dir),
        projects = json_string(&projects_dir),
    );

    // `<div id="root">` is the documented injection anchor (§3.2 line 153).
    if let Some(idx) = html.find("<div id=\"root\">") {
        let mut out = String::with_capacity(html.len() + script.len());
        out.push_str(&html[..idx]);
        out.push_str(&script);
        out.push_str(&html[idx..]);
        out
    } else if let Some(idx) = html.find("</head>") {
        // Fallback anchor if the bundler ever emits `<div id='root'>` differently.
        let mut out = String::with_capacity(html.len() + script.len());
        out.push_str(&html[..idx]);
        out.push_str(&script);
        out.push_str(&html[idx..]);
        out
    } else {
        format!("{script}{html}")
    }
}

/// JSON-encode a string so it is safe to embed inside an inline `<script>`
/// (escapes quotes, backslashes, and — critically — `<` so a `</script>` in the
/// value can never break out of the script element).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // `<` neutralises any `</script>` / `<!--` breakout attempt.
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Cache policy: content-hashed asset filenames (Vite emits `name-<hash>.ext`)
/// are immutable. The embedded terminal fonts (`/fonts/*.woff2`) are not
/// hashed but rotate only with a server release, so they're safe to mark
/// immutable too — keeps the SW happy and skips revalidation roundtrips on
/// every navigation. Everything else stays short-lived (the HTML doc needs
/// short TTL — auth token rotation, see vite.config.ts PWA notes).
fn cache_control(path: &str) -> &'static str {
    if path.starts_with("assets/") || path.starts_with("fonts/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    }
}

/// Format the rust-embed sha256 content hash as a quoted hex ETag.
fn hex_etag(hash: &[u8]) -> Option<String> {
    if hash.is_empty() {
        return None;
    }
    let mut s = String::with_capacity(hash.len() * 2 + 2);
    s.push('"');
    for b in hash {
        s.push_str(&format!("{b:02x}"));
    }
    s.push('"');
    Some(s)
}
