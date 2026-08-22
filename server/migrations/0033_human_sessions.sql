-- 0033_human_sessions.sql
-- P3a: the human identity plane. The first request identity that is NOT the
-- owner bearer. A cookie-backed session for a non-owner human colleague, minted
-- only after a verified Google-OIDC login, resolved to an allowlisted
-- `human_users` row and scoped to exactly one company.
--
-- IMMUTABLE ONCE SHIPPED (checksummed). Never edit this file — add a new
-- migration on top of it.
--
-- SECURITY: we store ONLY a SHA-256 hash of the opaque cookie token
-- (`token_hash`), never the raw value, so a DB read (backup, dump, SQL-injection
-- readout) cannot be replayed as a cookie — the same discipline the per-session
-- hook-token model uses. Lookup is by `token_hash`; the raw token lives only in
-- the browser's Secure/HttpOnly cookie.

CREATE TABLE human_sessions (
    id          INTEGER PRIMARY KEY,
    -- The authenticated human. ON DELETE CASCADE so revoking a colleague
    -- (deleting their human_users row) instantly invalidates every live cookie.
    user_id     INTEGER NOT NULL REFERENCES human_users(id) ON DELETE CASCADE,
    -- SHA-256 hex of the opaque 256-bit cookie token. UNIQUE: a token maps to at
    -- most one session. NEVER the raw token.
    token_hash  TEXT    NOT NULL UNIQUE,
    -- Snapshot of the user's company at mint time (NULL = owner / admin-all).
    -- The scope is derived here, server-side, never from anything the client claims.
    company_id  INTEGER,
    -- HMAC-SHA256 hex of the double-submit CSRF token minted at login. Compared
    -- constant-time to sha/HMAC of the X-Supermux-CSRF header on state-changing
    -- requests. NULL only for legacy/degenerate rows.
    csrf_hash   TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    -- Non-NULL once revoked (logout / rotation). A revoked or expired row never
    -- authenticates (fail-closed).
    revoked_at  INTEGER
);

-- Hot path: every cookie-bearing request resolves by token_hash.
CREATE INDEX idx_human_sessions_token ON human_sessions(token_hash);
