//! HTTP router registry.
//!
//! **Router-registry pattern.** The top-level [`router`] is composed from
//! per-module `router_for(state) -> Router` functions plus the public router.
//! Each backend module (sessions, board, files, scheduler, agents) adds exactly
//! ONE module file and ONE `.merge(...)` line on the protected router — so the
//! "parallel" backend work never produces a 3-way merge conflict on this file.
//!
//! Auth split: the protected router carries the bearer-token middleware;
//! the public router (manifest, sw, icons, `/api/health`) is merged AFTER and is
//! NOT wrapped by it (layers apply only to routes present when `.layer` runs).

use axum::http::{header, HeaderName, HeaderValue};
use axum::middleware::from_fn_with_state;
use axum::Router;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::agents;
use crate::audit;
use crate::auth;
use crate::board;
use crate::claude_tools;
use crate::external_edit;
use crate::files;
use crate::hooks;
use crate::hosts;
use crate::prefs;
use crate::public;
use crate::push;
use crate::scheduler;
use crate::sessions;
use crate::sse;
use crate::state::AppState;
use crate::static_assets;
use crate::teams;
use crate::updates;
use crate::ws;

/// Build the application router from `state`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(protected_router(state.clone()))
        // PUBLIC (no auth): `/api/health` plus the board iCal feed.
        .merge(board::public_router_for(state.clone()))
        // WS pty stream — NO bearer layer; auth is in-band first-frame.
        .merge(ws::router_for(state.clone()))
        // Claude hook ingestion — NO bearer layer; auth is the per-session
        // `X-Supermux-Hook-Token` validated in the handler.
        .merge(hooks::router_for(state.clone()))
        // The `$EDITOR` bridge's open/result endpoints
        // — NO bearer layer; SAME per-session `X-Supermux-Hook-Token` auth as the
        // status hook (the bridge runs inside the pane, never holds the bearer).
        // The dashboard-side `submit` is bearer-gated, on the sessions router.
        .merge(external_edit::router_for(state.clone()))
        // Agent→board hook endpoints — NO bearer layer; SAME per-session
        // `X-Supermux-Hook-Token` auth as the status hook, plus the scope rule
        // (an agent may only mutate its own session's issue).
        .merge(board::hook_router_for(state.clone()))
        // Agent→scheduler hook (`/api/hook/schedule/done`) — NO bearer layer; SAME
        // per-session `X-Supermux-Hook-Token` auth + scope (an agent may only
        // confirm a schedule that targets its own session). The agent-confirmed
        // finish tier for "notify me when done" schedules.
        .merge(scheduler::hook_router_for(state.clone()))
        .merge(public::router_for(state.clone()))
        // Embedded SPA — PUBLIC, no bearer layer. Merged
        // LAST: it owns `GET /` and a catch-all `.fallback` that serves hashed
        // assets or the SPA shell (with `window._SUPERMUX_AUTH_TOKEN` injected). The
        // fallback only fires for paths no other router claimed; `/api/*` and
        // `/ws/*` are explicitly denylisted inside it so a missing API route
        // still 404s as itself rather than silently returning HTML.
        .merge(static_assets::router_for(state))
        // ── Baseline security response headers ──
        // Applied on the OUTERMOST router so they cover every response —
        // protected /api, public endpoints, the SPA shell, and (critically)
        // error responses synthesized by inner middleware (auth 401s, CORS
        // rejects, body-limit 413s). `SetResponseHeaderLayer::overriding`
        // gives us a single consistent value per header regardless of whether
        // an inner handler already set one.
        //
        // CSP rationale: we ship a self-hosted SPA + JSON API on the same
        // origin and never embed third-party iframes/scripts.
        //   - `default-src 'self'` is the floor.
        //   - `img-src 'self' data: blob:` covers icons, generated previews,
        //     and the file-preview blob URLs.
        //   - `media-src 'self' blob:` covers audio/video preview blobs.
        //   - `style-src 'self' 'unsafe-inline'` is REQUIRED: Tailwind output
        //     plus framer-motion inject inline `style="..."` attributes,
        //     which CSP3's `'unsafe-inline'` allows but a nonce does not.
        //   - `script-src 'self' 'unsafe-inline'` is REQUIRED because the
        //     SPA shell carries a server-spliced `<script>` setting
        //     `window._SUPERMUX_AUTH_TOKEN` / `_VERSION` / `_HOME_DIR` /
        //     `_PROJECT_DIR` (see static_assets::splice_runtime_config).
        //     A nonce would be cleaner but requires per-request HTML rewrite
        //     AND per-request CSP — out of scope for this baseline. The
        //     spliced token is JSON-encoded by `json_encode_for_script`, so
        //     the inline payload is constant-shape and trusted.
        //   - `connect-src 'self' ws: wss:` covers fetch + the WS pty stream.
        //   - `frame-ancestors 'none'` is the modern X-Frame-Options.
        //   - `base-uri 'self'` + `form-action 'self'` close the standard
        //     CSP escape hatches.
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; \
                 img-src 'self' data: blob:; \
                 media-src 'self' blob:; \
                 style-src 'self' 'unsafe-inline'; \
                 script-src 'self' 'unsafe-inline'; \
                 connect-src 'self' ws: wss:; \
                 frame-ancestors 'none'; \
                 base-uri 'self'; \
                 form-action 'self'",
            ),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("interest-cohort=()"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
}

/// All bearer-token-protected routes.
///
/// Backend modules merge their sub-routers here before the `.layer(...)`:
/// ```ignore
/// .merge(sessions::router_for(state.clone()))
/// .merge(board::router_for(state.clone()))
/// .merge(files::router_for().with_state(state.clone()))
/// .merge(scheduler::router_for(state.clone()))
/// .merge(agents::router_for(state.clone()))
/// ```
fn protected_router(state: AppState) -> Router {
    Router::new()
        .merge(sessions::router_for(state.clone()))
        .merge(board::router_for(state.clone()))
        .merge(hosts::router_for(state.clone())) // hosts CRUD + bootstrap
        // `files::router_for()` returns a `Router<AppState>` (state not yet
        // provided); `.with_state` resolves it to `Router<()>` so it merges
        // alongside the already-stateful sessions router.
        .merge(files::router_for().with_state(state.clone()))
        .merge(scheduler::router_for(state.clone()))
        .merge(sse::router_for(state.clone())) // GET /api/events SSE stream
        .merge(teams::router_for(state.clone())) // GET /api/teams + settings
        .merge(agents::router_for(state.clone()))
        // Claude tools registry + MCP CRUD (bearer-protected).
        .merge(claude_tools::router_for(state.clone()))
        .merge(prefs::router_for(state.clone())) // snippets + kbd-groups
        .merge(audit::router_for(state.clone())) // audit log read
        // Web-push VAPID key + subscribe/unsubscribe (single-user dashboard,
        // so bearer-gated like the rest of /api).
        .merge(push::router_for(state.clone()))
        // In-UI updater (`/api/version*` + `/api/update/*`). Same bearer
        // gate as the rest of /api — auto-update is admin-equivalent.
        .merge(updates::router_for(state.clone()))
        .layer(from_fn_with_state(state, auth::auth_middleware))
}
