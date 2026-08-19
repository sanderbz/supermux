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

    /// The agent tried to drive a context a human has taken over.
    /// **This is the lock refusal** — expected, not exceptional.
    #[error("browser context '{session}' is under HUMAN control; agent input is refused")]
    HumanDriving { session: String },

    /// Waiting for the human to hand control back exceeded the caller's budget.
    #[error("timed out waiting for human takeover of '{session}' to end")]
    TakeoverWait { session: String },

    /// The per-service context cap would be exceeded.
    #[error("browser context limit reached ({max}); close a session's context first")]
    TooManyContexts { max: usize },

    /// A named session has no browser context.
    #[error("no browser context for session '{0}'")]
    NoSuchContext(String),

    /// The service has been shut down (idle-reaped or on server exit).
    #[error("browser service is shut down")]
    ShuttingDown,
}
