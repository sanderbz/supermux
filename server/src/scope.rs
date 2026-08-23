//! P3b — per-company scoping primitives.
//!
//! This is the single place that turns an [`AuthContext`] into a company fence,
//! so every surface (REST session handlers, SSE, the pty/chat/team WS, the files
//! jail, `delegate`) reaches the SAME decision the same way. The security
//! invariants (design §0):
//!
//!   * **Owner / admin-all bypass.** `AuthContext::Owner`, and a
//!     `Human { company_id: None }` (admin-all), see everything — [`Scope::All`].
//!   * **A scoped human is fenced** to `company_id = Some(c)` — [`Scope::Company`].
//!   * **Uniform refusal.** A cross-company session access returns
//!     `AppError::NotFound(format!("session '{name}'"))` — byte-identical to the
//!     404 a nonexistent slug gets ([`authorize_session_for_human`]), so a member
//!     cannot enumerate other companies' sessions by probing names.
//!   * **Fail-closed.** An UNSTAMPED resource (`company_id = None`, e.g. a global
//!     SSE frame) is visible ONLY to [`Scope::All`] ([`Scope::sees`]); a scoped
//!     human whose own company row is missing is confined to a jail that admits
//!     nothing ([`company_jail`]).
//!
//! **Behaviour-neutral today.** With human-auth disabled every authenticated
//! request is the owner ([`Scope::All`]), so none of these gates bite until a
//! real scoped `Human` exists — exactly the P3a→P3b handoff.

use std::path::PathBuf;

use axum::extract::{FromRequestParts, Request};
use axum::http::request::Parts;
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;

use crate::auth_human::AuthContext;
use crate::db;
use crate::db::connectors::{ALL_AGENTS, COMPANY_PREFIX};
use crate::error::AppError;
use crate::state::AppState;

/// An optional-`AuthContext` extractor for the handful of name-addressed handlers
/// that live OUTSIDE the sessions sub-router (and so are not covered by its
/// [`crate::sessions`] scope layer) — e.g. `/api/sessions/{name}/connectors` and
/// `/api/agents/{name}/wait`. It never rejects: in production the auth layer has
/// always stamped an identity by the time a protected handler runs, and in a
/// unit test that invokes the handler directly with no extension it resolves to
/// `None` (⇒ [`Scope::All`], the owner-equivalent default).
#[derive(Debug, Clone)]
pub struct OptCtx(pub Option<AuthContext>);

impl<S> FromRequestParts<S> for OptCtx
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(OptCtx(parts.extensions.get::<AuthContext>().cloned()))
    }
}

/// A resolved viewer scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Owner, admin-all human, or (in a unit test with no middleware) no context
    /// — sees every company and every unstamped resource.
    All,
    /// A human fenced to exactly this company id.
    Company(i64),
}

impl Scope {
    /// Derive the scope from an optional request `AuthContext`. `None` (a handler
    /// invoked directly in a unit test, before any middleware stamped an identity)
    /// resolves to [`Scope::All`] — the pre-P3b, owner-equivalent default, which
    /// is why enabling human-auth is the only thing that makes these gates bite.
    pub fn of(ctx: Option<&AuthContext>) -> Scope {
        match ctx {
            Some(AuthContext::Human {
                company_id: Some(c),
                ..
            }) => Scope::Company(*c),
            // Owner, admin-all Human (company_id None), or no ctx → unrestricted.
            _ => Scope::All,
        }
    }

    /// Is a resource stamped with `company` visible to this scope?
    ///
    /// An UNSTAMPED resource (`None`) is visible ONLY to [`Scope::All`] — the
    /// fail-closed rule for SSE frames whose producer did not know a company.
    pub fn sees(&self, company: Option<i64>) -> bool {
        match self {
            Scope::All => true,
            Scope::Company(c) => company == Some(*c),
        }
    }
}

/// The REST funnel every name-addressed session handler runs through.
///
/// **Owner-neutral by construction.** For [`Scope::All`] (owner / admin-all, or
/// no context) this is a pure no-op — it does NOT even load the row, so the
/// owner path is byte-identical to before P3b (a handler's own existence /
/// validation logic decides its response, unchanged). It only bites a scoped
/// human: it loads the row and, if the row is absent OR belongs to another
/// company, returns the identical `AppError::NotFound(format!("session '{name}'"))`
/// — the uniform 404 that a nonexistent slug gets, so a member cannot tell "not
/// yours" from "does not exist".
pub async fn authorize_session_for_human(
    state: &AppState,
    ctx: Option<&AuthContext>,
    name: &str,
) -> Result<(), AppError> {
    if let Scope::Company(hc) = Scope::of(ctx) {
        let sess = db::sessions::get(&state.pool, name)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
        if sess.company_id != Some(hc) {
            return Err(AppError::NotFound(format!("session '{name}'")));
        }
    }
    Ok(())
}

// ── admin-router gating (P3d) ───────────────────────────────────────────────────

/// The shared owner/admin guard for the global-admin routers (companies mutate,
/// hosts, scheduler, prefs writes, updates, audit, push).
///
/// **Owner-neutral by construction.** `None` (a handler/middleware invoked with no
/// stamped identity — the pre-P3a owner-equivalent default) and any
/// [`is_admin_or_owner`](AuthContext::is_admin_or_owner) identity pass unchanged.
/// A scoped **member** gets a uniform [`AppError::NotFound`] echoing only the path
/// they themselves requested — byte-identical in shape to a route that does not
/// exist, so a member cannot even confirm the surface is there (the same
/// hide-existence discipline as [`authorize_session_for_human`]).
pub fn require_admin(ctx: Option<&AuthContext>, path: &str) -> Result<(), AppError> {
    match ctx {
        None => Ok(()),
        Some(c) if c.is_admin_or_owner() => Ok(()),
        Some(_) => Err(AppError::NotFound(path.to_string())),
    }
}

/// Router middleware that gates EVERY method of a sub-router behind
/// [`require_admin`] (hosts, scheduler, updates, audit, push). Reads the
/// `AuthContext` the outer `auth_context_middleware` stamped; a request with no
/// stamped identity (unit-level router tests, or human-auth disabled where the
/// owner bearer already resolved to [`AuthContext::Owner`]) passes.
pub async fn require_admin_mw(req: Request, next: Next) -> Result<Response, AppError> {
    let path = req.uri().path().to_string();
    require_admin(req.extensions().get::<AuthContext>(), &path)?;
    Ok(next.run(req).await)
}

/// Router middleware that gates only the **state-changing** methods
/// (POST/PUT/PATCH/DELETE) behind [`require_admin`], leaving GET reads open. Used
/// by the prefs router, where a member may READ account prefs but not WRITE them.
pub async fn require_admin_writes_mw(req: Request, next: Next) -> Result<Response, AppError> {
    if matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        let path = req.uri().path().to_string();
        require_admin(req.extensions().get::<AuthContext>(), &path)?;
    }
    Ok(next.run(req).await)
}

// ── deny-by-default member backstop (P3d) ───────────────────────────────────────

/// Path-segment prefix test: `path` is `base` exactly, or a proper descendant of
/// it (`base` + `/…`). Deliberately NOT a bare `starts_with`, so `"/api/file"`
/// does not spuriously admit `"/api/files"` (segment boundary required).
fn under(path: &str, base: &str) -> bool {
    path == base
        || (path.len() > base.len()
            && path.as_bytes()[base.len()] == b'/'
            && path.starts_with(base))
}

/// Does a scoped **member** (`is_admin_or_owner() == false`) have permission to
/// reach `method path` at all? This is the DENY-BY-DEFAULT allowlist that
/// [`member_allowlist_mw`] enforces as a route-layer over the WHOLE
/// `protected_router`: a route not named here is UNREACHABLE for a member
/// (uniform 404), so a newly-merged sub-router defaults to denied until it is
/// deliberately added.
///
/// Every entry is a route whose handler ALSO does its own company scoping as
/// defense-in-depth — the sessions scope layer (`scope_session_middleware`), the
/// connector-target check ([`authorize_connector_target`]), the files jail
/// ([`company_jail`]), the SSE per-subscriber filter ([`Scope::sees`]), the
/// `delegate` company gate, and the companies own-filter. The allowlist is the
/// OUTER fence, not the only one.
///
/// Owner / admin-all / no-human never reach here — [`member_allowlist_mw`] passes
/// them byte-identically BEFORE consulting this.
pub fn member_may_reach(method: &Method, path: &str) -> bool {
    // The whole sessions surface: the roster list (company-filtered in
    // `list_handler`), `POST` create (company-defaulted), `/api/sessions/archived`,
    // every `/api/sessions/{name}/…` op (the sessions scope layer 404s a foreign
    // session), AND `/api/sessions/{name}/connectors` (connector target scoped).
    if under(path, "/api/sessions") {
        return true;
    }
    // Connector store — grants/credentials are company-scoped via
    // `authorize_connector_target`; the definition CRUD / `.mcpb` import is
    // `require_admin` INSIDE (404s a member), so the router is member-reachable
    // while its admin bits are not.
    if under(path, "/api/connectors") {
        return true;
    }
    // Company-jailed file browser (`company_jail` confines every resolve). The
    // GLOBAL project-root lister `/api/projects/repos` is deliberately NOT here —
    // company-neutral config a member has no use for (it already returns an empty
    // list to a member); fail closed.
    if under(path, "/api/file")
        || under(path, "/api/fs")
        || under(path, "/api/ls")
        || under(path, "/api/autocomplete")
        || under(path, "/api/uploads")
    {
        return true;
    }
    // The composer's base64 attachment upload. It writes to the server data-dir
    // scratch `uploads/` — NOT tied to any company session or company dir (the
    // body is just `{name, data}`; files land in `<data_dir>/uploads/`, are
    // served back via the already-allowlisted `/api/uploads/{file}`, and purge
    // after 24h) — so allowlisting alone is company-safe. POST only, exact path:
    // no phantom sub-path, and the GET `/api/uploads` plural (serve) stays its
    // own separate entry above.
    if *method == Method::POST && path == "/api/upload" {
        return true;
    }
    // SSE — the per-subscriber stream drops every non-own-company (and unstamped)
    // frame.
    if path == "/api/events" {
        return true;
    }
    // Delegate WITHIN the member's company (`delegate` refuses a spoofed/foreign
    // `from` and a cross-company `to`), and long-poll `wait` on a session (the
    // wait handler runs it through `authorize_session_for_human`). NOT
    // `/api/agents/delegations` (the global delegation log) nor `/api/skills`.
    if *method == Method::POST && path == "/api/agents/delegate" {
        return true;
    }
    if *method == Method::GET && path.starts_with("/api/agents/") && path.ends_with("/wait") {
        return true;
    }
    // Companies: READ only, and only the two OWN-company reads — the list
    // `/api/companies` (own-filtered) and the `/api/companies/{id}` fetch (404s a
    // foreign id). Deeper `/api/companies/{id}/**` subpaths (`humans` invitee list,
    // `host`, `verify-login` — all owner/admin wizard endpoints) are NOT admitted
    // here: `require_admin` inside already 404s a member, and the OUTER fence denies
    // them too (defense-in-depth). The POST/PATCH/DELETE lifecycle is likewise
    // `require_admin`, denied here by admitting only GET.
    if *method == Method::GET {
        if path == "/api/companies" {
            return true;
        }
        if let Some(rest) = path.strip_prefix("/api/companies/") {
            // Exactly ONE segment — the `{id}` — no deeper. A trailing `/`, an empty
            // `{id}`, or any `{id}/subpath` all fall through to deny.
            if !rest.is_empty() && !rest.contains('/') {
                return true;
            }
        }
    }
    // Everything else — hosts, scheduler, audit, push, updates, claude_tools (the
    // MCP registry), skills, slash-commands, agents/delegations, teams/* (start,
    // start-from-existing, dismiss, members, agent-teams pref), board/*,
    // `/api/claude/statusline*`, prefs (kbd-groups / snippets / prefs writes), and
    // settings/experimental/* — is DENIED (uniform 404). Fail closed.
    false
}

/// The deny-by-default backstop. Applied as a route-layer on `protected_router`
/// INNER to `auth_context_middleware` (so `AuthContext` is already stamped when
/// this runs).
///
///   * [`Scope::All`] — owner, admin-all human, or NO stamped identity (human-auth
///     disabled / unit tests) — passes BYTE-IDENTICALLY (never consults the
///     allowlist), so the owner world is unchanged.
///   * a scoped **member** passes only when [`member_may_reach`] allows the
///     `method path`; otherwise a uniform [`AppError::NotFound`] echoing only the
///     requested path — the same shape a missing route returns, so a member
///     cannot distinguish "denied" from "does not exist".
pub async fn member_allowlist_mw(req: Request, next: Next) -> Result<Response, AppError> {
    let is_member = matches!(
        Scope::of(req.extensions().get::<AuthContext>()),
        Scope::Company(_)
    );
    if is_member {
        let method = req.method().clone();
        let path = req.uri().path().to_string();
        if !member_may_reach(&method, &path) {
            return Err(AppError::NotFound(path));
        }
    }
    Ok(next.run(req).await)
}

/// Confine a **member**'s connector grant/edit target to their own company.
///
/// For [`Scope::All`] (owner/admin, or no context) this is a pure no-op. For a
/// scoped member the grant target — the normalized
/// `session_connectors.session_name` — must be one of:
///   * their own company sentinel `@company:<their id>`, or
///   * a real session slug that belongs to their company (checked via
///     [`authorize_session_for_human`]).
///
/// The all-agents sentinel `*` (a GLOBAL grant), another company's
/// `@company:<id>`, and any foreign/nonexistent session all collapse to a uniform
/// [`AppError::NotFound`] — a member can neither reach nor enumerate the global /
/// cross-company connector scope (design §P3d).
pub async fn authorize_connector_target(
    state: &AppState,
    ctx: Option<&AuthContext>,
    target: &str,
) -> Result<(), AppError> {
    let hc = match Scope::of(ctx) {
        Scope::All => return Ok(()),
        Scope::Company(hc) => hc,
    };
    // A member may never touch the global (all-agents) connector scope.
    if target == ALL_AGENTS {
        return Err(AppError::NotFound(format!("connector scope '{target}'")));
    }
    // A company sentinel must be the member's OWN company.
    if let Some(rest) = target.strip_prefix(COMPANY_PREFIX) {
        return match rest.parse::<i64>() {
            Ok(id) if id == hc => Ok(()),
            _ => Err(AppError::NotFound(format!("connector scope '{target}'"))),
        };
    }
    // Otherwise it is a real session slug — it must belong to the member's company
    // (uniform 404 otherwise, byte-identical to a nonexistent slug).
    authorize_session_for_human(state, ctx, target).await
}

/// A sentinel jail root used only when a scoped human's OWN company row cannot be
/// loaded (a broken invariant). It does not exist and is not a directory prefix
/// of anything real, so `resolve_safe` admits no path under it — fail-closed.
const NO_COMPANY_JAIL: &str = "/dev/null/__supermux_no_company_root__";

/// The filesystem jail for a caller.
///
///   * owner / admin-all → `None` (unrestricted — the global file browser);
///   * scoped human → `Some(companies.root_dir)`, confining every `safe_path`
///     resolution under that root (canonicalized, so `..`/symlink escapes fail);
///   * scoped human whose company row is missing → `Some(sentinel)` that admits
///     nothing (fail-closed), surfaced by the caller as a uniform 404.
pub async fn company_jail(
    state: &AppState,
    ctx: Option<&AuthContext>,
) -> Result<Option<PathBuf>, AppError> {
    match Scope::of(ctx) {
        Scope::All => Ok(None),
        Scope::Company(c) => match db::companies::get(&state.pool, c).await? {
            Some(co) => Ok(Some(PathBuf::from(co.root_dir))),
            None => Ok(Some(PathBuf::from(NO_COMPANY_JAIL))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_sees_everything_including_unstamped() {
        let s = Scope::All;
        assert!(s.sees(None));
        assert!(s.sees(Some(1)));
        assert!(s.sees(Some(2)));
    }

    #[test]
    fn company_sees_only_own_and_never_unstamped() {
        let s = Scope::Company(7);
        assert!(s.sees(Some(7)));
        assert!(!s.sees(Some(8)));
        // Fail-closed: an unstamped frame never reaches a scoped human.
        assert!(!s.sees(None));
    }

    fn human(company_id: Option<i64>, role: &str) -> AuthContext {
        AuthContext::Human {
            user_id: 1,
            company_id,
            role: role.into(),
        }
    }

    #[test]
    fn is_admin_or_owner_predicate() {
        // Owner bearer is always admin-or-owner.
        assert!(AuthContext::Owner.is_admin_or_owner());
        // Company-NULL owner/admin humans qualify.
        assert!(human(None, "owner").is_admin_or_owner());
        assert!(human(None, "admin").is_admin_or_owner());
        // A scoped member never does.
        assert!(!human(Some(3), "member").is_admin_or_owner());
        // Defense: a scoped human with a FORGED admin/owner role is still not
        // admin (the company_id.is_none() conjunct keeps role↔scope consistent).
        assert!(!human(Some(3), "admin").is_admin_or_owner());
        assert!(!human(Some(3), "owner").is_admin_or_owner());
        // A company-NULL human with a non-admin role is not admin either.
        assert!(!human(None, "member").is_admin_or_owner());
    }

    #[test]
    fn can_manage_companies_equals_admin_or_owner() {
        assert!(AuthContext::Owner.can_manage_companies());
        assert!(human(None, "admin").can_manage_companies());
        assert!(!human(Some(1), "member").can_manage_companies());
    }

    #[test]
    fn require_admin_gates_member_owner_neutral() {
        // No context (unit/router test, or owner-bearer default) → allowed.
        assert!(require_admin(None, "/api/hosts").is_ok());
        // Owner / admin → allowed.
        assert!(require_admin(Some(&AuthContext::Owner), "/api/hosts").is_ok());
        assert!(require_admin(Some(&human(None, "admin")), "/api/hosts").is_ok());
        // A member → uniform NotFound echoing only the path they requested.
        match require_admin(Some(&human(Some(7), "member")), "/api/hosts") {
            Err(AppError::NotFound(p)) => assert_eq!(p, "/api/hosts"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn member_allowlist_admits_only_company_safe_routes() {
        let get = Method::GET;
        let post = Method::POST;
        let del = Method::DELETE;
        let put = Method::PUT;

        // ── ALLOWED (company-safe, each self-scoping) ──
        assert!(member_may_reach(&get, "/api/sessions"));
        assert!(member_may_reach(&get, "/api/sessions/archived"));
        assert!(member_may_reach(&post, "/api/sessions"));
        assert!(member_may_reach(&post, "/api/sessions/bot/send"));
        assert!(member_may_reach(&get, "/api/sessions/bot/connectors"));
        // The store→chat connect handoff — under `/api/sessions`, scoped by the
        // sessions layer + `authorize_connector_target` in-handler.
        assert!(member_may_reach(&post, "/api/sessions/bot/connect_request"));
        assert!(member_may_reach(&post, "/api/connectors/mail/grant"));
        assert!(member_may_reach(&get, "/api/file/raw"));
        assert!(member_may_reach(&get, "/api/fs/delete"));
        assert!(member_may_reach(&get, "/api/ls"));
        assert!(member_may_reach(&get, "/api/autocomplete/dir"));
        assert!(member_may_reach(&get, "/api/uploads/x.png"));
        // The composer's base64 attachment upload (writes to the data-dir scratch
        // `uploads/`, not company-tied) — POST only.
        assert!(member_may_reach(&post, "/api/upload"));
        assert!(member_may_reach(&get, "/api/events"));
        assert!(member_may_reach(&post, "/api/agents/delegate"));
        assert!(member_may_reach(&get, "/api/agents/bot/wait"));
        assert!(member_may_reach(&get, "/api/companies"));
        assert!(member_may_reach(&get, "/api/companies/1"));

        // ── DENIED (global / admin / not company-scoped in v1) ──
        // Companies writes (require_admin) — only GET is admitted.
        assert!(!member_may_reach(&post, "/api/companies"));
        assert!(!member_may_reach(&put, "/api/companies/1"));
        assert!(!member_may_reach(&del, "/api/companies/2"));
        // Deny-by-default precision: the own-company GET reads stop at
        // `/api/companies` and `/api/companies/{id}`. The `{id}/**` subpaths are
        // owner/admin wizard endpoints — the OUTER fence denies them too, for every
        // method (defense-in-depth; `require_admin` inside also 404s a member).
        assert!(!member_may_reach(&get, "/api/companies/1/humans"));
        assert!(!member_may_reach(&post, "/api/companies/1/humans"));
        assert!(!member_may_reach(&del, "/api/companies/1/humans/2"));
        assert!(!member_may_reach(&post, "/api/companies/1/host"));
        assert!(!member_may_reach(&post, "/api/companies/1/verify-login"));
        // A trailing slash or empty `{id}` is not the `{id}` read either.
        assert!(!member_may_reach(&get, "/api/companies/1/"));
        assert!(!member_may_reach(&get, "/api/companies/"));
        // The global project-root lister is NOT the file jail.
        assert!(!member_may_reach(&get, "/api/projects/repos"));
        // Delegation LOG + skills + slash-commands (agents router, not delegate).
        assert!(!member_may_reach(&get, "/api/agents/delegations"));
        assert!(!member_may_reach(&post, "/api/skills/x"));
        assert!(!member_may_reach(&get, "/api/slash-commands"));
        // `wait` only via GET.
        assert!(!member_may_reach(&post, "/api/agents/bot/wait"));
        // Upload is POST-only and does NOT widen (no GET, no phantom sub-path).
        assert!(!member_may_reach(&get, "/api/upload"));
        assert!(!member_may_reach(&post, "/api/upload/x"));
        // Admin routers.
        assert!(!member_may_reach(&get, "/api/hosts"));
        assert!(!member_may_reach(&get, "/api/schedules"));
        assert!(!member_may_reach(&get, "/api/audit"));
        assert!(!member_may_reach(&get, "/api/push/key"));
        assert!(!member_may_reach(&get, "/api/version"));
        assert!(!member_may_reach(&get, "/api/claude/registry"));
        assert!(!member_may_reach(&post, "/api/claude/mcp"));
        // Global-write leaks this change closes.
        assert!(!member_may_reach(&post, "/api/teams/start"));
        assert!(!member_may_reach(&post, "/api/teams/start-from-existing"));
        assert!(!member_may_reach(&post, "/api/teams/acme/dismiss"));
        assert!(!member_may_reach(&post, "/api/claude/statusline/install"));
        assert!(!member_may_reach(&del, "/api/claude/statusline"));
        assert!(!member_may_reach(&put, "/api/settings/experimental/agent-teams"));
        assert!(!member_may_reach(&get, "/api/settings/experimental/agent-teams"));
        // Board is global in v1 — denied wholesale.
        assert!(!member_may_reach(&get, "/api/board"));
        assert!(!member_may_reach(&post, "/api/board/1/start"));
        assert!(!member_may_reach(&get, "/api/boards"));
        // Prefs (reads AND writes) are denied under deny-by-default.
        assert!(!member_may_reach(&get, "/api/snippets"));
        assert!(!member_may_reach(&put, "/api/prefs/overview_sort"));
    }

    #[test]
    fn under_requires_a_segment_boundary() {
        assert!(under("/api/file", "/api/file"));
        assert!(under("/api/file/raw", "/api/file"));
        // A shared textual prefix that is NOT a path segment must not match.
        assert!(!under("/api/files", "/api/file"));
        assert!(!under("/api/sessionsX", "/api/sessions"));
    }

    #[test]
    fn scope_of_maps_identities() {
        assert_eq!(Scope::of(None), Scope::All);
        assert_eq!(Scope::of(Some(&AuthContext::Owner)), Scope::All);
        assert_eq!(
            Scope::of(Some(&AuthContext::Human {
                user_id: 1,
                company_id: None,
                role: "admin".into(),
            })),
            Scope::All
        );
        assert_eq!(
            Scope::of(Some(&AuthContext::Human {
                user_id: 2,
                company_id: Some(3),
                role: "member".into(),
            })),
            Scope::Company(3)
        );
    }
}
