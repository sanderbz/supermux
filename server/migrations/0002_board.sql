-- migrations/0002_board.sql
-- Kanban board tables. Verbatim from TECH_PLAN §3.3.

CREATE TABLE issues (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    desc        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'todo',
    session     TEXT REFERENCES sessions(name) ON DELETE SET NULL,
    creator     TEXT NOT NULL DEFAULT '',
    due         TEXT,
    due_time    TEXT,
    created     INTEGER NOT NULL,
    updated     INTEGER NOT NULL,
    deleted     INTEGER,
    owner_type  TEXT NOT NULL DEFAULT 'human',
    pinned      INTEGER NOT NULL DEFAULT 0,
    pos         REAL NOT NULL DEFAULT 0,
    notified    INTEGER NOT NULL DEFAULT 0,
    CHECK (owner_type IN ('human','agent'))
);
CREATE INDEX idx_issues_status ON issues(status, deleted, pos);
CREATE INDEX idx_issues_session ON issues(session, status, deleted);

CREATE TABLE issue_tags (
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (issue_id, tag)
);
CREATE INDEX idx_issue_tags_tag ON issue_tags(tag);

CREATE TABLE issue_counters (
    prefix TEXT PRIMARY KEY,
    next_n INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE statuses (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    position   INTEGER NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0
);
INSERT INTO statuses (id, label, position, is_builtin) VALUES
    ('backlog', 'Backlog', 0, 1),
    ('todo', 'To Do', 1, 1),
    ('doing', 'In Progress', 2, 1),
    ('review', 'In Review', 3, 1),
    ('done', 'Done', 4, 1),
    ('discarded', 'Discarded', 5, 1);
