-- migrations/0004_runtime_state.sql
-- Prefs / skills / snippets / kbd_groups. Verbatim from TECH_PLAN §3.3.
-- Note: kbd_groups is table-backed, NOT a prefs blob (Eng schema gap; resolves
-- Codex contradiction E).

CREATE TABLE prefs (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE skills (
    name    TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated INTEGER NOT NULL
);

CREATE TABLE snippets (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT NOT NULL,
    body    TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
);

CREATE TABLE kbd_groups (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    keys     TEXT NOT NULL,                              -- JSON: [{label,key},…] length 4
    position INTEGER NOT NULL DEFAULT 0
);
