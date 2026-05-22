//! Audit-log and delegation row access (TECH_PLAN §3.3 `audit_log`,
//! `delegations`).
//!
//! Stub for M1 — structs mirror the tables so M6/M8/M9 can attach queries.
//! Runtime-checked queries — see the note in [`super::sessions`].

use serde::Serialize;

/// A row of the `audit_log` table (§6.4).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: i64,
    pub actor: String,
    pub action: String,
    pub target: String,
    /// JSON string; never contains secrets (§6.4).
    pub detail: String,
}

/// A row of the `delegations` table (cross-session edges; §3.3 0005).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Delegation {
    pub id: i64,
    pub from_session: String,
    pub to_session: String,
    pub prompt: String,
    pub ts: i64,
}
