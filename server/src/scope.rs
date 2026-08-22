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
