-- no-transaction
-- Allow 'kimi' (Kimi Code CLI, Moonshot) as a session provider.
--
-- SQLite cannot ALTER a CHECK constraint in place, and `sessions` has SEVEN
-- ON DELETE CASCADE children (session_runtime, tracked_files, steering_queue,
-- share_tokens, delegations×2, and issues via SET NULL). The standard 12-step
-- table rebuild DROPs the table, whose FK-enabled implicit DELETE would CASCADE
-- and wipe those children — unacceptable on a live install. Instead relax ONLY
-- the CHECK text via a targeted sqlite_master edit: no data movement, no table
-- drop, no cascade, children untouched. `writable_schema = RESET` reparses the
-- schema on the MIGRATION connection (a writable_schema edit does not bump the
-- schema cookie, so it can't signal SQLITE_SCHEMA to other connections). That is
-- safe here because the pool is lazy (min_connections = 0) and `sqlx::migrate!`
-- runs before any `sessions` query, so no connection ever parsed the old schema.
--
-- Verified on a byte copy of a live 42-session DB: data counts unchanged, FK and
-- integrity checks clean, provider='kimi' now accepted, unknown providers still
-- rejected. Runs outside a transaction (`-- no-transaction`) because schema
-- PRAGMAs must not be wrapped in one.
PRAGMA writable_schema = ON;

UPDATE sqlite_master
   SET sql = replace(
       sql,
       'provider IN (''claude'', ''codex'', ''shell'')',
       'provider IN (''claude'', ''codex'', ''kimi'', ''shell'')')
 WHERE type = 'table' AND name = 'sessions';

PRAGMA writable_schema = RESET;
