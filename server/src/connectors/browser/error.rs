//! Typed errors for the shared-browser connector.
//!
//! Phase 3 turns these into MCP tool errors an agent reads, so each variant is
//! a *distinct actionable outcome*, not a stringly-typed blob. In particular
//! [`BrowserError::HumanDriving`] is the one an agent is expected to see and
//! handle (back off, or wait for the human to hand control back).

use thiserror::Error;

pub type Result<T> = std::result::Result<T, BrowserError>;

#[derive(Debug, Error)]
pub enum BrowserError {
    /// The pinned `chrome-headless-shell` is not installed at the resolved path.
    #[error("chrome-headless-shell not found at {0} (set SUPERMUX_CHROME_BIN)")]
    ChromeMissing(String),

    /// Spawning chrome, or waiting for its CDP endpoint, failed.
    #[error("browser launch failed: {0}")]
    Launch(String),

    /// The CDP WebSocket could not be established or has gone away.
    #[error("CDP transport: {0}")]
    Transport(String),

    /// Chrome answered a command with a protocol error.
    #[error("CDP {method} failed: {message}")]
    Protocol { method: String, message: String },

    /// A CDP command did not answer within the deadline.
    #[error("CDP {0} timed out")]
    Timeout(String),

    /// A `Runtime.evaluate` threw inside the page.
    #[error("page evaluation threw: {0}")]
    Evaluate(String),

    /// The agent tried to drive a page a human has taken over.
    /// **This is the lock refusal** — expected, not exceptional.
    ///
    /// `subject` is what the lock is scoped to: a session name for a scratch
    /// context, a `tb_…` tab id for a workspace tab (one lock per tab, so a
    /// human on tab A never blocks an agent on tab B).
    #[error("browser subject '{subject}' is under HUMAN control; agent input is refused")]
    HumanDriving { subject: String },

    /// Waiting for the human to hand control back exceeded the caller's budget.
    #[error("timed out waiting for human takeover of '{subject}' to end")]
    TakeoverWait { subject: String },

    /// The per-service context cap would be exceeded.
    #[error("browser context limit reached ({max}); close a session's context first")]
    TooManyContexts { max: usize },

    /// A named session has no browser context.
    #[error("no browser context for session '{0}'")]
    NoSuchContext(String),

    /// The service has been shut down (idle-reaped or on server exit).
    #[error("browser service is shut down")]
    ShuttingDown,

    // ── shared-browser v1: the workspace-tab surface ────────────────────────
    //
    // `NoSuchTab` and `NotGrantedForTab` are BOTH rendered 403 to an agent
    // caller (see `tools::browser_err`), deliberately: an ungranted bot must not
    // learn whether a tab id exists. The distinction survives only in the logs
    // and on the human surface.
    /// No `browser_tabs` row with this id.
    #[error("no such browser tab '{0}'")]
    NoSuchTab(String),

    /// The session holds the connector grant but not a grant on THIS tab.
    /// **The R2 refusal** — it gates reads and screenshots too, because on an
    /// authenticated tab reading IS the exfiltration.
    #[error("session '{session}' has no grant on browser tab '{tab}'")]
    NotGrantedForTab { session: String, tab: String },

    /// The per-service workspace-tab cap would be exceeded.
    #[error("browser tab limit reached ({max}); close or unpin a tab first")]
    TooManyTabs { max: usize },

    /// The tab's login has lapsed. **Honest expiry**: an agent scraping a login
    /// wall and reporting it as data is worse than an agent that errors.
    #[error("browser tab '{tab}' needs the human to sign in again")]
    TabNeedsLogin { tab: String },

    /// An agent tried to navigate a tab off its per-tab origin allowlist. A
    /// cookie-bearing tab pointed at an attacker-chosen host is an exfil chain.
    ///
    /// **The message names the remedy, because a bare refusal is what sent a bot
    /// off to patch the allowlist itself.** Measured: a Google sign-in hops to
    /// `accounts.google.com`, the tab was scoped to `search.google.com`, and the
    /// agent — told only "not allowed to visit" — went and PATCHed the tab's
    /// `origins` with the owner's bearer token to get on with its task. The
    /// widening is a HUMAN act (the grant sheet's "Agents may open" list is where
    /// it lives), so the refusal has to say who to ask and for what, or the next
    /// agent will route around it again.
    #[error("browser tab '{tab}' is not allowed to visit '{host}' — this is the human's allowlist, not yours to widen. Ask them to add '{host}' under \"Agents may open\" in the tab's sheet (a sign-in hop to an identity provider is the usual reason), then retry.")]
    OriginNotAllowed { tab: String, host: String },

    /// Another supermux instance already owns the durable profile (§8.6).
    #[error("the browser profile is already open by another supermux instance (pid {by_pid:?})")]
    ProfileLocked { by_pid: Option<u32> },
}
