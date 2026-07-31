-- migrations/0025_archive_on_stop.sql
-- Auto-archive-on-stop for scheduler-booted sessions.
--
-- schedules.archive_on_stop: per-schedule preference (boot kind only). When 1,
-- the runner stamps the spawned session so it archives itself the moment it
-- stops (explicit Stop, or a Claude SessionEnd). Defaults to 0, and stays 0
-- unless the user opts in per schedule — existing and new schedules alike keep
-- today's behavior (backward compatible).
--
-- sessions.archive_on_stop: the disposable marker copied onto the spawned row.
-- Read by the stop hook. Defaults to 0 so manual / board / team sessions are
-- never auto-archived.

ALTER TABLE schedules ADD COLUMN archive_on_stop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions  ADD COLUMN archive_on_stop INTEGER NOT NULL DEFAULT 0;
