-- Extension credentials are capabilities for ONE website + ONE session.
CREATE TABLE browser_feedback_bindings (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE ON UPDATE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX browser_feedback_binding_session ON browser_feedback_bindings(session);
CREATE TABLE browser_feedback_pairings (
    id TEXT PRIMARY KEY,
    code_hash TEXT UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    binding_id TEXT REFERENCES browser_feedback_bindings(id) ON DELETE SET NULL,
    claimed_at INTEGER
);
CREATE TABLE browser_feedback_limits (
    key TEXT PRIMARY KEY,
    window INTEGER NOT NULL,
    attempts INTEGER NOT NULL
);
CREATE TABLE browser_feedback (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES browser_feedback_bindings(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','failed','cancelled')),
    reason TEXT,
    artifact_dir TEXT NOT NULL,
    prompt TEXT NOT NULL,
    bytes_total INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(binding_id, client_id)
);
CREATE INDEX browser_feedback_queue ON browser_feedback(status, created_at);
