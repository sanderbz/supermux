//! Embedded frontend assets + SPA serving.
//!
//! The built web app (`web/dist`, copied to `server/static` by `scripts/build.sh`
//! and `build.rs`) is embedded into the binary at compile time via `rust-embed`,
//! so the single `supermux-server` binary serves the *whole* product — not just
//! `/api` + `/ws`. Without this layer the deployed binary 404s on `GET /` and
//! the SPA never receives its auth token.
//!
//! **Routes (PUBLIC — no bearer layer).** Mounted on the public router in
//! `http::router` AFTER the protected `.layer(...)` so no auth middleware wraps
//! them. The HTML body itself is public; the inline `window._SUPERMUX_AUTH_TOKEN` is
//! the documented trade-off (token-in-HTML, acceptable because the
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
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::{CompressionLayer, CompressionLevel};

use crate::state::AppState;

/// The embedded frontend bundle. `scripts/build.sh` / `build.rs` copy
/// `web/dist` → `server/static` before `cargo build`, and `rust-embed` reads
/// that directory at compile time (the dir is gitignored — that is fine, the
/// embed is a compile-time read, not a runtime one).
#[derive(RustEmbed)]
#[folder = "static/"]
struct Assets;

/// The git sha of the EMBEDDED frontend bundle, read at runtime from the
/// `version.json` that `web/vite.config.ts` stamps into `web/dist` (the SAME sha
/// baked into the bundle's `__APP_BUILD_SHA__`). This is the client-reload
/// freshness signal the version-guard reads via `/api/version` `data.frontend_sha`:
/// it is byte-identical across a backend-only deploy (the embedded dist is
/// unchanged, so no false reload bar) and changes only when the frontend is
/// genuinely rebuilt. `None` when the asset is absent (a build produced without
/// the stamp) or unparseable — the guard then surfaces no bar (safe).
pub fn embedded_frontend_sha() -> Option<String> {
    Assets::get("version.json").and_then(|f| parse_frontend_sha(&f.data))
}

/// Pure JSON parse of a `version.json` body → its `sha` (trimmed, non-empty).
/// Unit-testable without the embed. `None` on malformed JSON, a missing `sha`,
/// a non-string `sha`, or an empty/whitespace `sha`.
fn parse_frontend_sha(bytes: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let sha = v.get("sha")?.as_str()?.trim();
    (!sha.is_empty()).then(|| sha.to_string())
}

/// Build the public (no-auth) static-asset sub-router: the SPA shell at `/` and
/// a catch-all fallback that serves hashed assets or falls back to the shell.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .fallback(get(asset_or_index))
        .layer(compression())
        .with_state(state)
}

/// Wire compression for the embedded bundle.
///
/// The frontend size budget (`web/scripts/size-budget.mjs`) is stated in
/// GZIPPED bytes, but until this layer existed the binary sent no
/// `Content-Encoding` at all: the entry chunk went out at ~551 KB and the
/// stylesheet at ~121 KB, i.e. the gate policed ~147 KB while a real visitor
/// downloaded 551 KB. A reverse proxy in front of the binary would have fixed
/// it, but `deploy.sh` only *suggests* one — the shipped default is the binary
/// on its own, so the binary has to do it.
///
/// Notes on the knobs:
///
///   * **br + gzip.** `CompressionLayer` negotiates from `Accept-Encoding`
///     (q-values included) and sets `Vary: accept-encoding`, so a client that
///     asks for neither still gets the identity bytes.
///   * **Quality 4, not the default.** async-compression's default brotli
///     quality is 11, which spends on the order of a second on a 550 KB chunk
///     — on this class of host that is a request-time stall, not a saving.
///     q4 lands within a few percent of q11 on minified JS at a fraction of
///     the CPU.
///   * **Never fonts.** `/fonts/*.woff2` is already Brotli-compressed inside
///     the container format; re-compressing it burns CPU to add bytes. The
///     `DefaultPredicate` already excludes images, gRPC, `text/event-stream`
///     (the SSE plane) and bodies under 32 bytes.
/// Shared with `http::protected_router` — the `/api` plane wants the exact same
/// negotiation, quality and predicate (notably `DefaultPredicate`'s
/// `text/event-stream` exclusion, which keeps the SSE stream un-buffered).
pub fn compression() -> CompressionLayer<impl Predicate + Clone> {
    CompressionLayer::new()
        .gzip(true)
        .br(true)
        .quality(CompressionLevel::Precise(4))
        .compress_when(DefaultPredicate::new().and(NotForContentType::const_new("font/")))
}

/// `GET /` — the SPA shell with the runtime config injected.
async fn index(State(state): State<AppState>, headers: HeaderMap) -> Response {
    serve_index(&state, should_splice_admin_token(&state, &headers))
}

/// Decide whether the served SPA shell should carry the admin bearer
/// (`window._SUPERMUX_AUTH_TOKEN`). Returns `true` to splice the token.
///
/// **Fail-closed allowlist (the P3a CRITICAL escalation fix).** The admin bearer
/// is the crown jewel and the static-asset router lives OUTSIDE the bearer layer,
/// so the shell is readable by anyone who can reach a Host that points at this
/// server. When human-auth is enabled we therefore splice the token ONLY for a
/// **trusted owner transport** — everything else (company hosts, public hosts,
/// unknown/forged Hosts, and a missing/unparseable `Host` header) gets a
/// cookie-only shell with NO token.
///
/// Trusted owner transports (see [`is_trusted_owner_transport`]): loopback
/// (`127.0.0.1` / `::1` / `localhost`, any port), tailnet MagicDNS names
/// (`*.ts.net`), and any Host explicitly listed in
/// `config.human_auth.owner_hosts`.
///
/// When human-auth is **disabled** this always returns `true`, so token
/// injection is byte-identical to the pre-P3a behavior (the owner's
/// tailnet/localhost transport always received the token).
fn should_splice_admin_token(state: &AppState, headers: &HeaderMap) -> bool {
    let cfg = state.human_auth_cfg();
    // No human surface at all ⇒ byte-identical to pre-P3a: always splice the
    // token (the owner's loopback / tailnet transport always received it).
    //
    // CRITICAL: the gate is `human_surface_active()`, NOT `enabled()`. The
    // zero-config quick-tunnel path deliberately leaves Google UNCONFIGURED
    // (`enabled()` stays false) while exposing a PUBLIC `*.trycloudflare.com`
    // host. Gating on `enabled()` here would splice the omniscient owner bearer
    // into the SPA served on that public host — a full compromise. Once ANY human
    // surface is live (Google OIDC OR the magic-link invite), the splice becomes
    // host-restricted to trusted owner transports (loopback / `*.ts.net` /
    // configured `owner_hosts`) — and a quick-tunnel host is none of those, so no
    // admin token ever reaches the public host.
    if !cfg.human_surface_active() {
        return true;
    }
    // Defense-in-depth over the Host check: a request that arrived through a
    // Cloudflare tunnel ALWAYS carries Cloudflare edge headers (`Cf-Ray`,
    // `Cf-Connecting-Ip`) — injected at the edge, so a client cannot strip them,
    // and a genuine loopback/tailnet owner request never has them. Empirically
    // Cloudflare's edge already 403s any `Host` that doesn't match the tunnel
    // hostname (so a `Host: localhost` spoof never reaches this origin), but we do
    // NOT want the owner bearer to depend on that single guarantee: if ANY
    // Cloudflare edge header is present, the request is public — never splice,
    // whatever the Host says.
    if headers.contains_key("cf-ray") || headers.contains_key("cf-connecting-ip") {
        return false;
    }
    match headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        Some(host) => is_trusted_owner_transport(&cfg, host),
        // A missing / HeaderParse-failing `Host` is NOT a recognised owner
        // transport ⇒ fail closed, withhold the token.
        None => false,
    }
}

/// Is `host` (a raw `Host` header value) a **trusted owner transport** — one
/// that may receive the admin bearer when human-auth is enabled?
///
/// Trusted IFF, after lowercasing + stripping any `:port`:
///   * loopback — `127.0.0.1`, `::1` (bracketed `[::1]` in the header), or
///     `localhost`; OR
///   * a tailnet MagicDNS name ending in `.ts.net` (covers the owner's
///     `supermux-*.tailXXXX.ts.net`); OR
///   * an explicit `config.human_auth.owner_hosts` entry.
///
/// Everything else — company hosts, public hosts, unknown/forged Hosts — is
/// untrusted (no token).
fn is_trusted_owner_transport(cfg: &crate::config::HumanAuthConfig, host: &str) -> bool {
    let lowered = host.trim().to_ascii_lowercase();
    // Strip the port. IPv6 literals arrive bracketed (`[::1]:8824`); pull the
    // address out of the brackets, otherwise split on the single `:port`.
    let bare = if let Some(rest) = lowered.strip_prefix('[') {
        rest.split(']').next().unwrap_or(&lowered)
    } else {
        lowered.split(':').next().unwrap_or(&lowered)
    };
    if bare == "127.0.0.1" || bare == "::1" || bare == "localhost" {
        return true;
    }
    if bare.ends_with(".ts.net") {
        return true;
    }
    cfg.is_owner_host(host)
}

/// SPA fallback: serve the request path as an embedded asset if it exists,
/// otherwise the injected `index.html` (client-side routing). `/api/*` and
/// `/ws/*` are NOT served as HTML — a missing API route must 404 as itself, not
/// the SPA shell.
///
/// The path is read from the request [`Uri`], not a `Path` extractor: a
/// `.fallback` route has no path pattern, so `Path<String>` would be a
/// rejection (HTTP 500). The `Uri` always carries the literal request path.
async fn asset_or_index(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
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
        None => serve_index(&state, should_splice_admin_token(&state, &headers)),
    }
}

/// Render `index.html` with `window._SUPERMUX_*` runtime config spliced in before
/// `<div id="root">`.
fn serve_index(state: &AppState, splice_token: bool) -> Response {
    let Some(raw) = Assets::get("index.html") else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "frontend bundle missing from binary (build.sh did not embed web/dist)",
        )
            .into_response();
    };
    let html = String::from_utf8_lossy(&raw.data);
    let injected = inject_runtime_config(&html, state, splice_token);

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
fn inject_runtime_config(html: &str, state: &AppState, splice_token: bool) -> String {
    // `_SUPERMUX_HOME_DIR`: the server's home directory. The New-session form
    // pre-fills its working-directory field with this so a session can be
    // created in one click without typing a path. Empty string if unresolved
    // (the create handler then falls back to the home dir server-side anyway).
    let home_dir = dirs::home_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    // `_SUPERMUX_PROJECT_DIR`: the FIRST project directory from the deploy-time
    // `SUPERMUX_PROJECT_DIRS` env var (smart default `<home>/projects`;
    // multi-project deployments commonly set it to `/opt/projects`).
    // Start-a-team pre-fills its directory field with this (with a trailing
    // slash) so the autocomplete on focus immediately surfaces the project
    // repos — making "pick a repo" one click. Empty string when the var is
    // unset (the form falls back to home).
    let projects_dir = std::env::var("SUPERMUX_PROJECT_DIRS")
        .ok()
        .and_then(|s| s.split(':').next().map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    // CRITICAL (P3a): the admin bearer is spliced into the shell for EVERY
    // viewer, and the static-asset router is OUTSIDE the bearer layer. Anyone
    // who can reach a Host pointing at this server would otherwise read the
    // omniscient Owner token straight out of the page's JS. So the splice is
    // FAIL-CLOSED (`should_splice_admin_token`): when human-auth is enabled only
    // a TRUSTED OWNER TRANSPORT (loopback / `*.ts.net` / configured
    // `owner_hosts`) carries the token; every other Host — company, public,
    // unknown/forged, or missing — gets a cookie-only shell and authenticates
    // via the session cookie + `/auth/me`. When human-auth is disabled the token
    // is always spliced (byte-identical to pre-P3a).
    let token_line = if splice_token {
        format!(
            "window._SUPERMUX_AUTH_TOKEN={token};",
            token = json_string(&state.config.auth_token),
        )
    } else {
        String::new()
    };
    let script = format!(
        "<script>{token_line}window._SUPERMUX_VERSION={version};window._SUPERMUX_HOME_DIR={home};window._SUPERMUX_PROJECT_DIR={projects};</script>",
        version = json_string(env!("CARGO_PKG_VERSION")),
        home = json_string(&home_dir),
        projects = json_string(&projects_dir),
    );

    // `<div id="root">` is the documented injection anchor.
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
    } else if path == "sw.js"
        || path == "registerSW.js"
        || path == "manifest.webmanifest"
        || path == "index.html"
        || path.ends_with(".html")
    {
        // The service-worker script, its registration shim, the web manifest —
        // AND every HTML document, `index.html` above all — gate every update: a
        // stale copy pinned by the HTTP cache (or a proxy / odd WebKit state)
        // can keep a freshly deployed SW from ever being seen by
        // `registration.update()`. Serve them `no-cache` so the browser always
        // revalidates the bytes that decide whether a new build is waiting.
        //
        // Why `index.html` specifically, and why this was the permanent-reload-bar
        // bug: `index.html` is the shell the service worker fetches — as the
        // navigateFallback target and as the NetworkFirst HTML copy — to decide
        // which bundle is running. It references the content-hashed chunk URLs
        // for a given build. A `max-age=3600` copy of it pins the SW (and thus
        // the WHOLE app) on the OLD chunk URLs for the TTL: the running bundle's
        // baked `__APP_BUILD_SHA__` stays behind the server's live `/api/version`
        // sha, so the version-guard shows the reload bar FOREVER, and each tap's
        // `location.reload()` is served the same stale cached `index.html` and
        // never escapes. `no-cache` makes every navigation revalidate → the
        // fresh `index.html`, the fresh chunk URLs, the current bundle. This also
        // un-wedges an ALREADY-installed bundle with no reinstall: it changes
        // what the running SW's own network fetches receive. Hashed `assets/` and
        // `fonts/` stay immutable — only the entry documents flip to `no-cache`.
        "no-cache"
    } else {
        "public, max-age=3600"
    }
}

#[cfg(test)]
mod tests {
    use super::{cache_control, parse_frontend_sha};

    // ── frontend-sha parse (the client-reload freshness signal) ────────────────

    #[test]
    fn parse_frontend_sha_reads_a_valid_stamp() {
        let sha = "a".repeat(40);
        let body = format!("{{\"sha\":\"{sha}\"}}");
        assert_eq!(parse_frontend_sha(body.as_bytes()), Some(sha));
    }

    #[test]
    fn parse_frontend_sha_trims_surrounding_whitespace() {
        assert_eq!(
            parse_frontend_sha(b"{\"sha\":\"  abc1234  \"}"),
            Some("abc1234".to_string())
        );
    }

    #[test]
    fn parse_frontend_sha_rejects_malformed_missing_and_empty() {
        // Malformed JSON.
        assert_eq!(parse_frontend_sha(b"not json"), None);
        assert_eq!(parse_frontend_sha(b""), None);
        // Missing `sha` key.
        assert_eq!(parse_frontend_sha(b"{\"other\":\"x\"}"), None);
        // Non-string `sha`.
        assert_eq!(parse_frontend_sha(b"{\"sha\":123}"), None);
        // Empty / whitespace-only `sha`.
        assert_eq!(parse_frontend_sha(b"{\"sha\":\"\"}"), None);
        assert_eq!(parse_frontend_sha(b"{\"sha\":\"   \"}"), None);
    }

    // ── P3a CRITICAL: withhold the admin bearer on company tunnel hosts ─────────

    use super::{asset_or_index, index, is_trusted_owner_transport};
    use crate::config::{CompanyHost, Config, HumanAuthConfig};
    use crate::state::AppState;
    use axum::extract::State;
    use axum::http::{header, HeaderMap, HeaderValue, Uri};

    const OWNER_TOKEN: &str = "sk-owner-admin-bearer-secret";
    const COMPANY_HOST: &str = "acme.supermux.example";
    /// A tailnet MagicDNS owner transport (`*.ts.net`) — always trusted.
    const OWNER_HOST: &str = "owner-box.taild681cb.ts.net";
    /// The real strato owner box, to prove the `*.ts.net` rule covers it.
    const TAILNET_OWNER_HOST: &str = "supermux-strato.taild681cb.ts.net";
    /// A loopback owner transport (any port).
    const LOOPBACK_HOST: &str = "127.0.0.1:8824";
    /// An explicit `owner_hosts` allowlist entry (neither loopback nor ts.net).
    const OWNER_HOST_CFG: &str = "my-owner-box.internal";
    /// A company/untrusted tunnel Host under the configured base domain.
    const COMPANY_UNTRUSTED_HOST: &str = "acme.example.com";
    /// A PUBLIC zero-config quick-tunnel Host — must NEVER receive the bearer.
    const QUICK_TUNNEL_HOST: &str = "calm-frog-1234.trycloudflare.com";
    /// A random forged/unknown Host — must fail closed.
    const EVIL_HOST: &str = "evil.example.com";

    /// Build an `AppState`; `human_auth` is enabled with a single `company_hosts`
    /// entry for `COMPANY_HOST` when `enable_human_auth` is set, otherwise inert.
    async fn state_with(enable_human_auth: bool) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("supermux-static-p3a-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let human_auth = if enable_human_auth {
            HumanAuthConfig {
                google_client_id: Some("test-client-id".into()),
                google_client_secret: Some("test-client-secret".into()),
                owner_email: None,
                company_hosts: vec![CompanyHost {
                    host: COMPANY_HOST.into(),
                    company_id: 1,
                    redirect_uri: format!("https://{COMPANY_HOST}/auth/callback"),
                    ephemeral: false,
                }],
                owner_hosts: vec![OWNER_HOST_CFG.into()],
                cookie_key: b"cookie-key".to_vec(),
                csrf_key: b"csrf-key".to_vec(),
                invite_key: b"invite-key".to_vec(),
                session_ttl_secs: 0,
                base_domain: Some("example.com".into()),
            }
        } else {
            HumanAuthConfig::default()
        };
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: OWNER_TOKEN.to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// Build an `AppState` on the ZERO-CONFIG quick-tunnel / invite path:
    /// `invite_enabled()` is true (a public `*.trycloudflare.com` host in
    /// `company_hosts` + the signing keys) but Google is UNCONFIGURED so
    /// `enabled()` is false. This is exactly the state in which the pre-fix gate
    /// (`!enabled()`) would have spliced the owner bearer into the public host.
    async fn invite_only_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("supermux-static-quick-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let human_auth = HumanAuthConfig {
            google_client_id: None,
            google_client_secret: None,
            owner_email: None,
            company_hosts: vec![CompanyHost {
                host: QUICK_TUNNEL_HOST.into(),
                company_id: 1,
                redirect_uri: format!("https://{QUICK_TUNNEL_HOST}/auth/callback"),
                ephemeral: true,
            }],
            owner_hosts: vec![],
            cookie_key: b"cookie-key".to_vec(),
            csrf_key: b"csrf-key".to_vec(),
            invite_key: b"invite-key".to_vec(),
            session_ttl_secs: 0,
            base_domain: None,
        };
        // Sanity: the very condition that makes the fix load-bearing.
        assert!(!human_auth.enabled(), "Google must be unconfigured on this path");
        assert!(human_auth.invite_enabled(), "the invite surface is live");
        assert!(human_auth.human_surface_active());
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: OWNER_TOKEN.to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn headers_with_host(host: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        h
    }

    async fn body_of(resp: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// A catch-all SPA client-route Uri (no file extension), so `asset_or_index`
    /// falls through `Assets::get` to the injected shell.
    fn spa_uri() -> Uri {
        "/some/spa/route".parse().unwrap()
    }

    // (a) A company / untrusted Host receives NO admin token — proven through
    // BOTH entry points: `GET /` (`index`) AND the catch-all fallback
    // (`asset_or_index` on an SPA client-route). The fallback is a real leak path
    // because it also serves the injected shell.
    #[tokio::test]
    async fn company_host_shell_has_no_admin_token_via_index_and_fallback() {
        let (state, dir) = state_with(true).await;

        let resp = index(State(state.clone()), headers_with_host(COMPANY_UNTRUSTED_HOST)).await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "index(): company/untrusted host must NOT leak the admin bearer, got: {html:?}"
        );
        assert!(html.contains("_SUPERMUX_VERSION"), "runtime config still injected");

        // Same host, through the fallback catch-all on an SPA route.
        let resp = asset_or_index(
            State(state.clone()),
            headers_with_host(COMPANY_UNTRUSTED_HOST),
            spa_uri(),
        )
        .await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "asset_or_index() fallback: company/untrusted host must NOT leak the admin bearer"
        );
        assert!(html.contains("_SUPERMUX_VERSION"), "runtime config still injected via fallback");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // (b) A tailnet owner transport (`*.ts.net`, e.g. supermux-strato) STILL
    // receives the token — the `*.ts.net` rule covers the owner's box.
    #[tokio::test]
    async fn tailnet_owner_host_still_carries_the_admin_token() {
        let (state, dir) = state_with(true).await;
        for host in [OWNER_HOST, TAILNET_OWNER_HOST] {
            let resp = index(State(state.clone()), headers_with_host(host)).await;
            let html = body_of(resp).await;
            assert!(
                html.contains("_SUPERMUX_AUTH_TOKEN") && html.contains(OWNER_TOKEN),
                "tailnet owner host must still receive the token (host={host})"
            );
        }
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // (c) A loopback transport (127.0.0.1, any port) receives the token.
    #[tokio::test]
    async fn loopback_host_carries_the_admin_token() {
        let (state, dir) = state_with(true).await;
        let resp = index(State(state.clone()), headers_with_host(LOOPBACK_HOST)).await;
        let html = body_of(resp).await;
        assert!(
            html.contains("_SUPERMUX_AUTH_TOKEN") && html.contains(OWNER_TOKEN),
            "loopback owner transport must receive the token"
        );
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // An explicitly configured `owner_hosts` entry (neither loopback nor
    // ts.net) also receives the token.
    #[tokio::test]
    async fn configured_owner_host_carries_the_admin_token() {
        let (state, dir) = state_with(true).await;
        let resp = index(State(state.clone()), headers_with_host(OWNER_HOST_CFG)).await;
        let html = body_of(resp).await;
        assert!(
            html.contains("_SUPERMUX_AUTH_TOKEN") && html.contains(OWNER_TOKEN),
            "configured owner_hosts entry must receive the token"
        );
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // (d) A random unknown / forged Host fails CLOSED — no token, even though it
    // is not a configured company host either.
    #[tokio::test]
    async fn unknown_forged_host_fails_closed_no_token() {
        let (state, dir) = state_with(true).await;
        let resp = index(State(state.clone()), headers_with_host(EVIL_HOST)).await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "unknown/forged host must fail closed (NO token), got: {html:?}"
        );
        // Same through the fallback catch-all.
        let resp = asset_or_index(State(state.clone()), headers_with_host(EVIL_HOST), spa_uri()).await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "unknown/forged host must fail closed through the fallback too"
        );
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // (e) A MISSING Host header fails CLOSED — no token.
    #[tokio::test]
    async fn missing_host_header_fails_closed_no_token() {
        let (state, dir) = state_with(true).await;
        // `index` with an empty HeaderMap (no Host).
        let resp = index(State(state.clone()), HeaderMap::new()).await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "missing Host must fail closed (NO token), got: {html:?}"
        );
        // And through the fallback.
        let resp = asset_or_index(State(state.clone()), HeaderMap::new(), spa_uri()).await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "missing Host must fail closed through the fallback too"
        );
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // (f) Human-auth DISABLED ⇒ the token is spliced for ALL hosts (including a
    // company host, a forged host, and even a missing Host) — byte-identical to
    // pre-P3a behavior.
    #[tokio::test]
    async fn human_auth_disabled_always_splices_the_token() {
        let (state, dir) = state_with(false).await;
        for host in [COMPANY_HOST, COMPANY_UNTRUSTED_HOST, OWNER_HOST, EVIL_HOST] {
            let resp = index(State(state.clone()), headers_with_host(host)).await;
            let html = body_of(resp).await;
            assert!(
                html.contains("_SUPERMUX_AUTH_TOKEN") && html.contains(OWNER_TOKEN),
                "human-auth disabled must always inject the token (host={host})"
            );
        }
        // Even a missing Host still gets the token when the feature is off.
        let resp = index(State(state.clone()), HeaderMap::new()).await;
        let html = body_of(resp).await;
        assert!(
            html.contains("_SUPERMUX_AUTH_TOKEN") && html.contains(OWNER_TOKEN),
            "human-auth disabled + missing Host must still inject the token"
        );
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── §7.1 CRITICAL: the quick-tunnel splice hole is closed ───────────────────
    //
    // The zero-config quick-tunnel path leaves Google unconfigured, so the OLD
    // gate (`!cfg.enabled()`) would return `true` and splice the owner bearer into
    // the SPA on the PUBLIC trycloudflare host = full compromise. With the gate on
    // `human_surface_active()`, the public quick host gets a cookie-only shell
    // (NO token) while the owner's loopback transport STILL receives it.
    #[tokio::test]
    async fn quick_tunnel_public_host_gets_no_admin_token_but_loopback_still_does() {
        let (state, dir) = invite_only_state().await;

        // The public quick-tunnel host — NO admin token, via BOTH entry points.
        let resp = index(State(state.clone()), headers_with_host(QUICK_TUNNEL_HOST)).await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "public quick-tunnel host must NOT leak the admin bearer, got: {html:?}"
        );
        assert!(html.contains("_SUPERMUX_VERSION"), "runtime config still injected");
        let resp = asset_or_index(
            State(state.clone()),
            headers_with_host(QUICK_TUNNEL_HOST),
            spa_uri(),
        )
        .await;
        let html = body_of(resp).await;
        assert!(
            !html.contains("_SUPERMUX_AUTH_TOKEN"),
            "quick-tunnel host must fail closed through the fallback too"
        );

        // The owner's loopback transport STILL carries the token (not broken).
        let resp = index(State(state.clone()), headers_with_host(LOOPBACK_HOST)).await;
        let html = body_of(resp).await;
        assert!(
            html.contains("_SUPERMUX_AUTH_TOKEN") && html.contains(OWNER_TOKEN),
            "loopback owner transport must still receive the token on the invite path"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // Defense-in-depth: a request carrying a Cloudflare edge header (`Cf-Ray`)
    // arrived through the tunnel and must NEVER splice the admin token — EVEN if it
    // spoofs a trusted `Host: localhost`. (Cloudflare's edge already 403s a Host
    // that doesn't match the tunnel hostname, so this never reaches us in practice,
    // but the owner bearer must not depend on that single guarantee.)
    #[tokio::test]
    async fn cloudflare_edge_header_withholds_the_token_even_with_a_spoofed_local_host() {
        let (state, dir) = invite_only_state().await;
        for cf in ["cf-ray", "cf-connecting-ip"] {
            let mut h = headers_with_host(LOOPBACK_HOST); // a trusted-looking Host…
            h.insert(cf, HeaderValue::from_static("spoofed")); // …but it came via CF.
            let resp = index(State(state.clone()), h).await;
            let html = body_of(resp).await;
            assert!(
                !html.contains("_SUPERMUX_AUTH_TOKEN"),
                "a {cf}-bearing request must not get the admin token despite Host: localhost"
            );
        }
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // The owner bearer is never accepted FROM the quick host as an owner transport
    // (a trycloudflare host is neither loopback, `*.ts.net`, nor an owner_hosts
    // entry) — the direct `is_trusted_owner_transport` unit assertion.
    #[test]
    fn quick_tunnel_host_is_not_a_trusted_owner_transport() {
        let cfg = HumanAuthConfig {
            company_hosts: vec![CompanyHost {
                host: QUICK_TUNNEL_HOST.into(),
                company_id: 1,
                redirect_uri: format!("https://{QUICK_TUNNEL_HOST}/auth/callback"),
                ephemeral: true,
            }],
            cookie_key: b"c".to_vec(),
            csrf_key: b"s".to_vec(),
            invite_key: b"i".to_vec(),
            ..Default::default()
        };
        assert!(!is_trusted_owner_transport(&cfg, QUICK_TUNNEL_HOST));
        // Loopback / tailnet remain trusted.
        assert!(is_trusted_owner_transport(&cfg, "127.0.0.1:8824"));
        assert!(is_trusted_owner_transport(&cfg, "box.taild681cb.ts.net"));
    }

    #[test]
    fn index_html_is_no_cache_so_the_sw_is_never_pinned_on_a_stale_bundle() {
        // The permanent-reload-bar regression: a max-age copy of the shell pins
        // the SW on the old hashed chunks. index.html (and any *.html) must
        // revalidate on every navigation.
        assert_eq!(cache_control("index.html"), "no-cache");
        assert_eq!(cache_control("offline.html"), "no-cache");
    }

    #[test]
    fn update_gating_files_stay_no_cache() {
        assert_eq!(cache_control("sw.js"), "no-cache");
        assert_eq!(cache_control("registerSW.js"), "no-cache");
        assert_eq!(cache_control("manifest.webmanifest"), "no-cache");
    }

    #[test]
    fn hashed_assets_and_fonts_stay_immutable() {
        assert_eq!(
            cache_control("assets/index-abc123.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_control("assets/style-def456.css"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_control("fonts/JetBrainsMono.woff2"),
            "public, max-age=31536000, immutable"
        );
    }
}

/// Format the rust-embed sha256 content hash as a quoted hex ETag.
///
/// **Weak** (`W/"…"`) on purpose. The hash identifies the *resource*, not the
/// *representation*: with `compression()` in front of this handler the same
/// URL is served as identity, gzip or brotli bytes depending on
/// `Accept-Encoding`, and a strong validator promises byte-for-byte identity
/// across all of them — which would be a lie the moment a cache holds one
/// encoding and revalidates for another.
fn hex_etag(hash: &[u8]) -> Option<String> {
    if hash.is_empty() {
        return None;
    }
    let mut s = String::with_capacity(hash.len() * 2 + 4);
    s.push_str("W/\"");
    for b in hash {
        s.push_str(&format!("{b:02x}"));
    }
    s.push('"');
    Some(s)
}
