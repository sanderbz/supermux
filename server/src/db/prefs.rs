//! Prefs / snippets / kbd_groups row access (TECH_PLAN §3.3).
//!
//! Stub for M1 — structs mirror the tables so later milestones can attach
//! queries. Runtime-checked queries — see the note in [`super::sessions`].

use serde::Serialize;

/// A row of the `prefs` key/value table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Pref {
    pub key: String,
    pub value: String,
}

/// A row of the `snippets` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Snippet {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub position: i64,
    pub created: i64,
}

/// A row of the `kbd_groups` table (accessory-bar groups; table-backed, not a
/// prefs blob — resolves Codex contradiction E).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct KbdGroup {
    pub id: i64,
    pub name: String,
    pub keys: String,
    pub position: i64,
}
