-- migrations/0013_board_three_lanes.sql
-- Board redesign — reduce to three agent-task lanes (board-redesign-spec §5).
--
-- The board's only job is to instruct agents and stay in the loop. The legacy
-- generic-kanban columns (backlog / review / discarded) and the human/agent
-- owner toggle are dropped. This migration is CONSERVATIVE: it relocates every
-- existing card and never deletes a card row.
--
-- 1. add the `archived` column for soft discard (data preserved, hidden from the
--    default board list; restorable). Distinct from `deleted` (hard delete).
-- 2. relocate cards out of the columns being removed:
--      backlog        → todo
--      review         → doing + needs_review = 1   (safety-net "Review?" state)
--      discarded      → archived (hidden, never deleted)
--      any custom col → todo                       (fold into todo)
-- 3. default owner_type to 'agent' and migrate existing human rows → agent
--    (every card is an agent task now; the column is kept for one cycle but is
--    no longer branched on).
-- 4. leave the builtin statuses as exactly todo / doing / done, relabelled to
--    "To do" / "Doing" / "Done" and re-positioned 0/1/2.

-- 1. soft-discard flag (additive; every existing row reads 0 = visible).
ALTER TABLE issues ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- 2a. backlog → todo.
UPDATE issues SET status = 'todo' WHERE status = 'backlog';

-- 2b. review → doing, flagged needs_review (the "Review?" safety state in Doing).
UPDATE issues SET status = 'doing', needs_review = 1 WHERE status = 'review';

-- 2c. discarded → archived + parked in todo (the lane is removed; archived hides
--     it from the default list). The row + all its history are preserved.
UPDATE issues SET archived = 1, status = 'todo' WHERE status = 'discarded';

-- 2d. fold any card sitting in a column that is NOT one of the three survivors
--     (custom user columns) into todo, so no card is orphaned when the column
--     row is deleted below.
UPDATE issues SET status = 'todo'
 WHERE status NOT IN ('todo', 'doing', 'done');

-- 3. every card is an agent task now: default + migrate existing human rows.
UPDATE issues SET owner_type = 'agent' WHERE owner_type = 'human';

-- 4. statuses table: drop every non-survivor column (builtin + custom), keep
--    exactly the three lanes, relabel + reposition them.
DELETE FROM statuses WHERE id NOT IN ('todo', 'doing', 'done');

UPDATE statuses SET label = 'To do', position = 0, is_builtin = 1 WHERE id = 'todo';
UPDATE statuses SET label = 'Doing', position = 1, is_builtin = 1 WHERE id = 'doing';
UPDATE statuses SET label = 'Done',  position = 2, is_builtin = 1 WHERE id = 'done';

-- Idempotent safety net: if an upgrade DB somehow lacks one of the three lanes,
-- recreate it (a fresh DB seeds them in 0002, then 0002's extras are removed
-- above; this INSERT OR IGNORE is a no-op there).
INSERT OR IGNORE INTO statuses (id, label, position, is_builtin) VALUES
    ('todo', 'To do', 0, 1),
    ('doing', 'Doing', 1, 1),
    ('done', 'Done', 2, 1);
