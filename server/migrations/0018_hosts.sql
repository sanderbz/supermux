-- migrations/0018_hosts.sql
-- Remote-host registry for the remote-SSH feature. The supermux server gains
-- a `hosts` table that catalogs every machine the user wants to run Claude
-- sessions on. `host_id = NULL` on a session row means LOCAL — that preserves
-- the existing one-machine behavior unchanged (every pre-existing row
-- backfills to NULL via SQLite's default-NULL ADD COLUMN).
--
-- Status is constrained to a small enum so the FE can render a deterministic
-- badge without inventing values; the values mirror what `HostPool` (RT2)
-- writes via `update_status`. `last_seen` is bumped each time a successful
-- reachability probe completes so the UI can show "checked 5m ago".
--
-- `soft_delete` (RT8 DELETE /api/hosts/{id}) stamps `deleted_at` instead of
-- DROPping the row so referencing session rows still resolve their host name
-- for archived/historical views.

CREATE TABLE hosts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    ssh_target   TEXT NOT NULL,
    ssh_key_path TEXT,
    status       TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','reachable','unreachable')),
    last_seen    INTEGER,
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);

-- NULL = local (the entire pre-RT4 fleet). SQLite's ALTER TABLE ADD COLUMN
-- defaults nullable columns to NULL on every existing row, so this is a safe
-- no-op for existing dbs and the regression test exercises it explicitly.
ALTER TABLE sessions ADD COLUMN host_id INTEGER REFERENCES hosts(id);

CREATE INDEX idx_sessions_host_id ON sessions(host_id);
