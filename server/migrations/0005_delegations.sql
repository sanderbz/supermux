-- migrations/0005_delegations.sql (NEW v2 — Eng + Codex finding #5)
-- Cross-session delegation edges. `from` is a SQL keyword → column aliased
-- `from_session`. Cascading delete cleans rows when either side disappears.
-- Created here in the DB-layer milestone so M9 can reference (not invent) it.

CREATE TABLE delegations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    to_session   TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    prompt       TEXT NOT NULL,
    ts           INTEGER NOT NULL
);
CREATE INDEX idx_delegations_from ON delegations(from_session, ts DESC);
CREATE INDEX idx_delegations_to   ON delegations(to_session, ts DESC);
