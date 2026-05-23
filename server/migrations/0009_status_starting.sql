-- migrations/0009_status_starting.sql
-- Add 'starting' to the `session_runtime.last_status` CHECK constraint.
--
-- The new short-lived state is emitted by `sessions::lifecycle::start` between
-- session create and the first stable detector classification, so the overview
-- tile can render a distinct "booting" affordance instead of flashing
-- idle/unknown/active during the spawn window. SQLite cannot ALTER a CHECK
-- constraint in-place, so this is the standard rebuild-and-swap dance: create
-- the table afresh with the broadened CHECK, copy every row over, drop, rename.
-- Sibling tables that FK into `session_runtime.name` are unaffected (the column
-- they reference is `sessions.name`, not `session_runtime.name`).
CREATE TABLE session_runtime_new (
    name                  TEXT PRIMARY KEY REFERENCES sessions(name) ON DELETE CASCADE,
    rate_limit_reset_at   INTEGER NOT NULL DEFAULT 0,
    hibernated            INTEGER NOT NULL DEFAULT 0,
    restarting            INTEGER NOT NULL DEFAULT 0,
    last_claude_alive_pid INTEGER NOT NULL DEFAULT 0,
    last_status           TEXT NOT NULL DEFAULT 'unknown',
    last_status_at        INTEGER NOT NULL DEFAULT 0,
    last_capture          TEXT NOT NULL DEFAULT '',
    hook_token            TEXT NOT NULL DEFAULT '',
    last_capture_ansi     TEXT NOT NULL DEFAULT '',
    CHECK (last_status IN ('active','waiting','idle','stopped','starting','unknown'))
);

INSERT INTO session_runtime_new (
    name, rate_limit_reset_at, hibernated, restarting, last_claude_alive_pid,
    last_status, last_status_at, last_capture, hook_token, last_capture_ansi
)
SELECT
    name, rate_limit_reset_at, hibernated, restarting, last_claude_alive_pid,
    last_status, last_status_at, last_capture, hook_token, last_capture_ansi
FROM session_runtime;

DROP TABLE session_runtime;
ALTER TABLE session_runtime_new RENAME TO session_runtime;
