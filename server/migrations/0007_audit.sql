-- migrations/0007_audit.sql (NEW v2 — Eng + Codex finding #5)
-- Audit log of destructive actions. Verbatim from TECH_PLAN §3.3.
-- (There is intentionally NO 0006 migration: alerts stay in-process as a
-- 50-entry ring buffer; the number is reserved-empty to keep numbering aligned.)

CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    actor  TEXT NOT NULL,                                -- 'user' | 'scheduler' | 'agent:<name>'
    action TEXT NOT NULL,                                -- e.g. 'session.delete', 'schedule.run', 'file.put'
    target TEXT NOT NULL DEFAULT '',                     -- the affected entity id/path
    detail TEXT NOT NULL DEFAULT '{}'                    -- JSON detail
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
