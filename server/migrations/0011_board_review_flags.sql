-- migrations/0011_board_review_flags.sql
-- Session→board reaction flags (plan §C.3, milestone R1). Two additive boolean
-- columns on `issues` that the auto_actions side-effect sets when the agent that
-- OWNS a `doing` issue changes turn state, and that the board UI reads to badge
-- the card:
--   needs_review   — set when the owning agent goes idle (its turn finished).
--                    The board shows a "needs review" badge. Default behaviour is
--                    FLAG ONLY: the card is NOT auto-moved out of `doing` and the
--                    next issue is NOT auto-picked (plan §C open-question 5, safe
--                    default). A human clears it when they pick the work up.
--   awaiting_input — set when the owning agent sits in a sustained `waiting`
--                    state (it asked the user something). The board badges
--                    "needs you" so a human knows to reply.
-- Both are additive with a DEFAULT so every existing row reads `0` (no flag).
-- No existing column/table is touched.

ALTER TABLE issues ADD COLUMN needs_review   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issues ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0;
