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
use axum::middleware::{from_fn, from_fn_with_state};
use axum::Router;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::agents;
use crate::audit;
use crate::auth_human;
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
        // Shared-browser HUMAN TAKEOVER socket (`/ws/browser/{session}/takeover`)
        // — same reason it sits outside the bearer layer as the pty stream: a
        // browser `WebSocket` cannot send an `Authorization` header, so auth is
        // the identical in-band first frame.
        .merge(crate::connectors::browser::takeover::router_for(state.clone()))
        // Shared-browser AGENT TOOL endpoint (`/api/hook/browser/tool`) — NO
        // bearer layer; SAME per-session `X-Supermux-Hook-Token` auth as the
        // status hook (the caller is an MCP server inside the pane, which must
        // never hold the dashboard bearer), plus the grant check and the drive
        // lock inside the handler.
        .merge(crate::connectors::browser::tools::router_for(state.clone()))
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
        // Bot→app capability hooks (`/api/hook/notify`, `/api/hook/delegate`) —
        // NO bearer layer; SAME per-session `X-Supermux-Hook-Token` auth, each
        // scope-locked to the calling session's own pane / same-company peers.
        .merge(agents::hook_router_for(state.clone()))
        .merge(public::router_for(state.clone()))
        // P3a — PUBLIC human-auth login surface (`/auth/login|callback|logout|me`).
        // Merged OUTSIDE the bearer layer, beside the public router. Inert unless
        // `config.human_auth` is configured (routes 404 / return not-authenticated).
        .merge(auth_human::router::router_for(state.clone()))
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
    use crate::scope::{member_allowlist_mw, require_admin_mw, require_admin_writes_mw};
    Router::new()
        .merge(sessions::router_for(state.clone()))
        .merge(board::router_for(state.clone()))
        // hosts CRUD + bootstrap — P3d: owner/admin-only. A scoped member never
        // reaches these (uniform 404, hides existence), enforced by the shared
        // `require_admin` guard as a route-layer over the whole sub-router.
        .merge(hosts::router_for(state.clone()).route_layer(from_fn(require_admin_mw)))
        // `files::router_for()` returns a `Router<AppState>` (state not yet
        // provided); `.with_state` resolves it to `Router<()>` so it merges
        // alongside the already-stateful sessions router.
        .merge(files::router_for().with_state(state.clone()))
        // Scheduler CRUD — P3d owner/admin-only (the agent→scheduler HOOK router,
        // merged outside the bearer layer in `router`, is unaffected).
        .merge(scheduler::router_for(state.clone()).route_layer(from_fn(require_admin_mw)))
        .merge(sse::router_for(state.clone())) // GET /api/events SSE stream
        .merge(teams::router_for(state.clone())) // GET /api/teams + settings
        .merge(agents::router_for(state.clone()))
        // Claude tools registry + MCP CRUD — P3d owner/admin-only. The MCP
        // mutators write GLOBAL config (`~/.claude.json` `mcpServers`) that Claude
        // loads into EVERY subsequently-spawned agent across ALL companies, so an
        // ungated member POST here is cross-company MCP-injection (RCE) and a
        // DELETE/disable is cross-company sabotage. Gate the WHOLE sub-router (the
        // registry GET included): a member has no need for the global MCP registry
        // — their connectors are company-scoped via the connectors store — so the
        // safer choice hides its existence entirely (uniform 404). Same shared
        // guard, same route-layer, as hosts/scheduler/audit/push/updates.
        .merge(claude_tools::router_for(state.clone()).route_layer(from_fn(require_admin_mw)))
        // Connector store: manifest CRUD + .mcpb import + per-agent grants +
        // write-only credential→vault (bearer-protected). P3d: the mutation
        // handlers gate a member to their company scope INSIDE the handlers
        // (a member may grant `@company:<their id>` / an own-company session, but
        // not `*` / another company / a global connector definition).
        .merge(crate::connectors::router_for(state.clone()))
        // P2a connector-OAuth: guided per-company OAuth-app REGISTRATION
        // (`/api/oauth/apps`, owner/admin-only via `require_admin` INSIDE each
        // handler — a NEW prefix, deliberately absent from `member_may_reach`, so
        // the deny-by-default backstop also 404s members) + the device-code grant
        // (`/api/connectors/{id}/oauth/device/{start,poll}`, member-reachable via
        // the existing `/api/connectors` blanket and fenced in-handler by
        // `authorize_session_for_human` + `authorize_connector_target` to the
        // member's own company). Secrets 0600 / vault, never returned/logged.
        .merge(crate::connectors::oauth::router_for(state.clone()))
        // Companies — P3d: GET returns only a member's own company; POST/PATCH/
        // DELETE are owner/admin-only. Gated INSIDE the handlers so the member GET
        // can still return their one company (a blanket route-layer would 404 it).
        .merge(crate::companies::router_for(state.clone()))
        // Companies onboarding wizard — external access (Cloudflare wildcard tunnel
        // + Google login) + colleague invites. EVERY endpoint is `require_admin`
        // INSIDE the handler (owner/admin `Scope::All` only); a member is a uniform
        // 404. Deliberately NOT added to `crate::scope::member_may_reach`, so the
        // deny-by-default backstop also blocks members at the route layer.
        .merge(crate::external_access::router_for(state.clone()))
        // Prefs — P3d: a member may READ account prefs but not WRITE them; only the
        // state-changing methods are owner/admin-gated.
        .merge(prefs::router_for(state.clone()).route_layer(from_fn(require_admin_writes_mw)))
        // Audit log read — P3d owner/admin-only.
        .merge(audit::router_for(state.clone()).route_layer(from_fn(require_admin_mw)))
        // Web-push VAPID key + subscribe/unsubscribe (single-user dashboard,
        // so bearer-gated like the rest of /api). P3d owner/admin-only.
        .merge(push::router_for(state.clone()).route_layer(from_fn(require_admin_mw)))
        // In-UI updater (`/api/version*` + `/api/update/*`). Same bearer
        // gate as the rest of /api — auto-update is admin-equivalent. P3d
        // owner/admin-only.
        .merge(updates::router_for(state.clone()).route_layer(from_fn(require_admin_mw)))
        // ── P3d DENY-BY-DEFAULT MEMBER BACKSTOP ──
        // The class fix: a route-layer over EVERY merged protected route, INNER to
        // the `auth_context_middleware` below (so `AuthContext` is already stamped
        // when it runs) and OUTER to the handlers (so it blocks before any of them
        // execute). For [`Scope::All`] — owner, admin-all human, or the no-human
        // world (human-auth disabled ⇒ `AuthContext::Owner`) — it is a
        // byte-identical pass-through. A scoped MEMBER is admitted only for the
        // routes in `crate::scope::member_may_reach` (the audited allowlist) and
        // gets a uniform `AppError::NotFound` on everything else — so a sub-router
        // merged in the future defaults to DENIED for members until it is
        // deliberately allowlisted. Each allowlisted route still does its OWN
        // company scoping (defense-in-depth); this is the outer fence.
        .layer(from_fn(member_allowlist_mw))
        // ── Compress the JSON plane too ──
        // #84 gave the *static* sub-router br/gzip and stopped there, so every
        // `/api/*` body shipped identity: `GET /api/sessions` is ~50 KB of JSON
        // on the hero path (refetched on a 30s staleTime plus every SSE-driven
        // invalidate) and gzips to ~5.6 KB — 8.9x, and 0.25s of a Fast-3G
        // time-to-content. Same layer, same knobs, on purpose: `DefaultPredicate`
        // excludes `text/event-stream`, so `/api/events` (SSE) is untouched and
        // still streams frame-by-frame. Placed INSIDE the auth layer so a 401
        // synthesized by the middleware is not worth a compressor pass.
        .layer(static_assets::compression())
        // P3a: the AuthContext resolver SUPERSEDES the bearer-only middleware. It
        // resolves the owner bearer (byte-identical to before) OR a valid human
        // session cookie, stamps an `AuthContext` request extension, and enforces
        // CSRF on cookie-borne state changes. A request with neither → 401.
        .layer(from_fn_with_state(
            state,
            auth_human::auth_context_middleware,
        ))
}
