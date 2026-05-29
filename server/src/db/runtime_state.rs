//! Audit-log and delegation row access (`audit_log`, `delegations` tables).
//!
//! Structs mirror the tables so callers can attach queries.
//! Runtime-checked queries — see the note in [`super::sessions`].

use serde::Serialize;

/// A row of the `audit_log` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: i64,
    pub actor: String,
    pub action: String,
    pub target: String,
    /// JSON string; never contains secrets.
    pub detail: String,
}

/// A row of the `delegations` table (cross-session edges; migration 0005).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Delegation {
    pub id: i64,
    pub from_session: String,
    pub to_session: String,
    pub prompt: String,
    pub ts: i64,
}
