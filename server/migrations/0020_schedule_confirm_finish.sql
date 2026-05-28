-- migrations/0020_schedule_confirm_finish.sql
-- Agent-confirmed finish (the high-reliability "notify when done" tier). When a
-- tmux schedule has this set, the runner appends a completion-call footer to the
-- delivered prompt instructing the agent to curl `/api/hook/schedule/done` when
-- the work is genuinely finished — so completion is agent-declared rather than
-- inferred from idle detection (which remains the fallback).
--
-- Defaults to 0 so every existing schedule keeps the pure idle-detection
-- behaviour, unchanged.

ALTER TABLE schedules ADD COLUMN confirm_finish INTEGER NOT NULL DEFAULT 0;
