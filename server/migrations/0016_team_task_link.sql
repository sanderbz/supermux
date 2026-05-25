-- migrations/0016_team_task_link.sql
-- Wire a team's on-disk task files to its board cards (Agent Teams AT-G,
-- plan §5.5). AT-C built the boards entity + the idempotent register-team UPSERT;
-- AT-B detects teams + parses their `~/.claude/tasks/{team}/NN.json` task files.
-- AT-G populates each team board from those files as a READ-THROUGH MIRROR.
--
-- To make that mirror idempotent across detect ticks (so re-reading the same
-- files never duplicates a card), each team card carries a STABLE LINK back to
-- the on-disk task it mirrors: `team_task_id` = the parsed task's `id`. The
-- watcher UPSERTs on `(board_id, team_task_id)`: insert when new, patch
-- status/desc/assignee when changed, and close/remove cards whose task vanished.
--
-- The column is NULLABLE: an ordinary (non-team) card has no linked task, so
-- `team_task_id` is NULL for every existing card and every user-created card.
-- SQLite treats NULLs as DISTINCT in a UNIQUE index, so the unique constraint
-- only binds the team cards that actually carry a task id — main-board cards are
-- unaffected and can coexist freely.

-- The stable backlink to the team's on-disk task (NULL for ordinary cards).
ALTER TABLE issues ADD COLUMN team_task_id TEXT;

-- One card per (board, task): the read-through mirror's upsert key. Scoped by
-- board_id so the same task id under two different teams never collides, and so
-- the constraint is naturally a no-op for the NULL (non-team) cards.
CREATE UNIQUE INDEX idx_issues_team_task ON issues(board_id, team_task_id);
