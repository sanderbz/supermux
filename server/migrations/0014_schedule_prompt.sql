-- migrations/0014_schedule_prompt.sql
-- A scheduled job may now deliver an optional slash COMMAND and/or an optional
-- free-text PROMPT in one fire (at least one is required, enforced in the handler
-- layer). The existing `command` column keeps the slash command; this adds the
-- free-text prompt sent right after it. Nullable + defaults to '' so every
-- existing row is a pure-command job, unchanged.

ALTER TABLE schedules ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
