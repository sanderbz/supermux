-- Asks: the durable record of "an agent is waiting on a human".
--
-- Until now every live ask (a permission dialog, an AskUserQuestion, an MCP
-- elicitation form, a board needs-input, a needs-you Notification) lived only
-- in memory on the session's activity snapshot: a restart forgot it, and a
-- client that was not connected at the moment it was raised never saw it. One
-- row per ask, with a stable id and a lifecycle, fixes both.
--
-- What is stored is the same display-grade, secret-conscious detail the
-- `sessions` SSE delta already carries (the permission summary, the agent's own
-- question and options, the MCP server's form). The raw hook payload — a full
-- Bash command, a file's content — is never written here; the decision hook
-- holds it in memory only for as long as it is waiting.
CREATE TABLE asks (
    id            TEXT PRIMARY KEY,
    -- NULL once the session is deleted. Not CASCADE: supermux closes a deleted
    -- session's open asks first (each close takes a rev), and the closed rows
    -- must survive so a client resuming with `since` learns they closed. The
    -- retention prune removes them later like any closed ask.
    session       TEXT REFERENCES sessions(name) ON DELETE SET NULL ON UPDATE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('permission','question','elicitation','needs_input','waiting')),
    state         TEXT NOT NULL CHECK (state IN ('open','answered','dismissed','resolved')),
    -- Identity of the thing being asked about, so a re-fired hook (Claude
    -- re-raises the same dialog; the decision hook reconnects after a restart)
    -- lands on the SAME row instead of a duplicate. A hash, never content.
    match_key     TEXT NOT NULL DEFAULT '',
    -- Kind-specific JSON (see `asks::detail`).
    detail        TEXT NOT NULL DEFAULT '{}',
    -- JSON: who/what closed it, and how. NULL while open.
    resolution    TEXT,
    -- 1 while a decision hook is connected and waiting for this ask, i.e. while
    -- the API can answer it. Reset to 0 for every row at boot.
    hook_attached INTEGER NOT NULL DEFAULT 0,
    -- The board issue a needs_input ask belongs to.
    issue_id      TEXT,
    created_at    INTEGER NOT NULL,  -- epoch ms
    updated_at    INTEGER NOT NULL,  -- epoch ms
    resolved_at   INTEGER,           -- epoch ms
    -- Monotonic change counter across ALL asks: every insert/update takes the
    -- next value from `ask_rev`. A client that remembers the highest rev it has
    -- applied asks `GET /api/asks?since=<rev>` and misses nothing.
    rev           INTEGER NOT NULL
);
CREATE UNIQUE INDEX asks_by_rev ON asks(rev);
CREATE INDEX asks_open_by_session ON asks(session, kind) WHERE state = 'open';
CREATE INDEX asks_by_resolved_at ON asks(resolved_at) WHERE resolved_at IS NOT NULL;

-- The rev counter lives in its own row so a deleted row (retention prune,
-- session purge) can never hand its rev out a second time.
CREATE TABLE ask_rev (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    n  INTEGER NOT NULL
);
INSERT INTO ask_rev (id, n) VALUES (1, 0);
