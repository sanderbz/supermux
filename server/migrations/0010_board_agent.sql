-- migrations/0010_board_agent.sql
-- Board↔agent integration foundation (plan §C.2). Three additive tables that let
-- an agent report progress back onto its card and a card carry richer state:
--   issue_comments   — an activity stream of comments per issue.
--   acceptance_items — checklist items the human edits and the agent ticks.
--   issue_links      — PR/commit refs the agent attaches as it works.
-- All three FK→issues ON DELETE CASCADE so they vanish when an issue is hard-
-- deleted. Additive only — no existing column/table is touched.

CREATE TABLE issue_comments (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author   TEXT NOT NULL,           -- 'agent:<session>' | 'user' | 'human:<name>'
    body     TEXT NOT NULL,
    created  INTEGER NOT NULL
);
CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id, id);

CREATE TABLE acceptance_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    body     TEXT NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    pos      REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_acceptance_issue ON acceptance_items(issue_id, pos);

CREATE TABLE issue_links (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,           -- 'pr' | 'commit'
    ref      TEXT NOT NULL,           -- url or sha
    label    TEXT NOT NULL DEFAULT '',
    created  INTEGER NOT NULL,
    CHECK (kind IN ('pr','commit'))
);
CREATE INDEX idx_issue_links_issue ON issue_links(issue_id, id);
