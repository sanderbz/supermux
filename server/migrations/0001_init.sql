-- migrations/0001_init.sql
-- Core session tables. Schema is verbatim from TECH_PLAN §3.3 — every column,
-- index, and CHECK constraint included.

CREATE TABLE sessions (
    name             TEXT PRIMARY KEY,                          -- slug
    dir              TEXT NOT NULL,
    desc             TEXT NOT NULL DEFAULT '',
    provider         TEXT NOT NULL DEFAULT 'claude',            -- 'claude'|'codex'
    flags            TEXT NOT NULL DEFAULT '',                  -- shlex-style
    pinned           INTEGER NOT NULL DEFAULT 0,                -- 0|1
    archived         INTEGER NOT NULL DEFAULT 0,
    auto_continue    INTEGER NOT NULL DEFAULT 0,
    auto_continue_msg TEXT NOT NULL DEFAULT 'continue',
    rate_limit_resume_text TEXT NOT NULL DEFAULT 'continue',
    tags             TEXT NOT NULL DEFAULT '[]',                -- JSON array
    creator          TEXT NOT NULL DEFAULT '',
    branch           TEXT NOT NULL DEFAULT '',
    worktree         INTEGER NOT NULL DEFAULT 0,
    worktree_repo    TEXT NOT NULL DEFAULT '',
    mcp              TEXT NOT NULL DEFAULT '',                  -- '' or 'chrome'
    created_at       INTEGER NOT NULL,
    start_count      INTEGER NOT NULL DEFAULT 0,
    last_started     INTEGER NOT NULL DEFAULT 0,
    last_send        INTEGER NOT NULL DEFAULT 0,
    last_send_text   TEXT NOT NULL DEFAULT '',
    task_summary     TEXT NOT NULL DEFAULT '',
    cc_session_name  TEXT NOT NULL DEFAULT '',
    cc_conversation_id TEXT NOT NULL DEFAULT '',
    codex_session_id TEXT NOT NULL DEFAULT '',
    start_error      TEXT NOT NULL DEFAULT '',
    CHECK (provider IN ('claude', 'codex', 'shell'))   -- 'shell' added v2 for test-only sessions (fix contradiction B from Codex)
);
CREATE INDEX idx_sessions_pinned ON sessions(pinned DESC, last_send DESC);
-- Partial index for the common overview query that filters archived=0 (Eng schema gap)
CREATE INDEX idx_sessions_active ON sessions(pinned DESC, last_send DESC) WHERE archived = 0;

CREATE TABLE session_runtime (    -- ephemeral but persisted across restarts
    name                  TEXT PRIMARY KEY REFERENCES sessions(name) ON DELETE CASCADE,
    rate_limit_reset_at   INTEGER NOT NULL DEFAULT 0,
    hibernated            INTEGER NOT NULL DEFAULT 0,
    restarting            INTEGER NOT NULL DEFAULT 0,
    last_claude_alive_pid INTEGER NOT NULL DEFAULT 0,
    last_status           TEXT NOT NULL DEFAULT 'unknown',
    last_status_at        INTEGER NOT NULL DEFAULT 0,
    -- Added v2 for hero tile-tail preview (CEO #1): last 30 lines of capture-pane output, ANSI stripped
    last_capture          TEXT NOT NULL DEFAULT '',
    -- Added v2 for per-session hook auth scoping (Eng P1 #3): random 32-byte base64url per session
    hook_token            TEXT NOT NULL DEFAULT '',
    CHECK (last_status IN ('active','waiting','idle','stopped','unknown'))
);

CREATE TABLE tracked_files (
    session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    path    TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (session, path)
);

CREATE TABLE steering_queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session   TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    text      TEXT NOT NULL,
    queued_at INTEGER NOT NULL
);
-- Added v2 (Eng schema gap): cover SELECT id,text FROM steering_queue WHERE session=? ORDER BY id LIMIT 1
CREATE INDEX idx_steering_session ON steering_queue(session, id);

CREATE TABLE share_tokens (
    token     TEXT PRIMARY KEY,
    session   TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    perms     TEXT NOT NULL,                       -- 'output'|'output+files'|'output+files+notes'
    label     TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,                            -- nullable
    created_at INTEGER NOT NULL,
    CHECK (perms IN ('output','output+files','output+files+notes'))
);
-- Added v2 (Eng schema gap): cover DELETE WHERE session=? on session delete
CREATE INDEX idx_share_tokens_session ON share_tokens(session);
