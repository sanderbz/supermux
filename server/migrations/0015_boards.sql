-- migrations/0015_boards.sql
-- Multi-board model (Agent Teams AT-C, plan §5.5). The single Kanban board
-- becomes MULTIPLE boards selectable via a board-switcher. Each board owns its
-- own cards; a team's tasks live on its own `kind='team'` board.
--
-- This migration is CONSERVATIVE and LOSSLESS:
--   1. introduce the `boards` entity.
--   2. seed exactly one fixed `kind='main'` board ("Main") — the user's existing
--      single board. It is non-deletable / non-renameable (enforced in the API,
--      not the schema — SQLite can't express "row is immutable").
--   3. add `board_id` to `issues` (NOT NULL, defaulting to the main board) and
--      backfill EVERY existing card onto the main board, so a single-board user
--      upgrades with all their cards intact, on a board now named "Main".
--
-- A board's `kind` is 'main' (the fixed user board, exactly one) or 'team' (one
-- per Claude Code agent team). A team board carries `team_name` (the on-disk
-- team id under ~/.claude/teams/{team}/ and ~/.claude/tasks/{team}/) so a sibling
-- milestone (AT-D / AT-F3) can create + populate it from the team's task files.

-- 1. the boards entity.
CREATE TABLE boards (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    -- 'main' = the user's fixed board (exactly one, id 'main'); 'team' = a board
    -- auto-created for a Claude Code agent team.
    kind       TEXT NOT NULL DEFAULT 'main',
    -- The on-disk team id for a kind='team' board (NULL for main). UNIQUE so a
    -- team maps to at most one board (AT-D/AT-F3 upsert key).
    team_name  TEXT,
    created_at INTEGER NOT NULL,
    -- Display / switcher order. Main is pinned first (position 0); team boards
    -- append after it.
    position   REAL NOT NULL DEFAULT 0,
    CHECK (kind IN ('main','team'))
);
-- One board per team (the upsert/register key for AT-D/AT-F3). NULLs are allowed
-- to repeat (SQLite treats NULLs as distinct in a UNIQUE index), so the single
-- main board with team_name NULL is fine alongside it.
CREATE UNIQUE INDEX idx_boards_team_name ON boards(team_name);

-- 2. seed the fixed main board (id 'main') — the existing single board. The API
--    treats id 'main' as non-deletable / non-renameable.
INSERT INTO boards (id, name, kind, team_name, created_at, position)
VALUES ('main', 'Main', 'main', NULL, CAST(strftime('%s','now') AS INTEGER), 0);

-- 3. add `board_id` to issues and backfill every existing card onto 'main'.
--    `DEFAULT 'main'` covers the backfill in one ALTER (every existing row reads
--    'main'); new inserts that omit board_id also land on 'main'. The FK keeps a
--    card's board valid and CASCADE-cleans a deleted team board's cards.
ALTER TABLE issues
    ADD COLUMN board_id TEXT NOT NULL DEFAULT 'main'
    REFERENCES boards(id) ON DELETE CASCADE;

-- Explicit backfill belt-and-braces: any row whose board_id somehow isn't 'main'
-- (it can't be, given the DEFAULT, but this guards a re-applied/odd state) is
-- pinned to the seeded main board so no card is ever orphaned off a board.
UPDATE issues SET board_id = 'main' WHERE board_id IS NULL OR board_id = '';

-- Index the new scoping column: the board list query filters by board_id, so the
-- per-board load stays indexed (mirrors idx_issues_status / idx_issues_session).
CREATE INDEX idx_issues_board ON issues(board_id, status, deleted, pos);
