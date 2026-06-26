-- migrations/0021_schedule_bypass_permissions.sql
-- Boot bypass-permissions for scheduled "Boot session" jobs. When a boot
-- schedule has this set, the runner launches the Claude session with
-- `--permission-mode bypassPermissions` (the same trusted flag the create-
-- session panel and the runtime Shift+Tab toggle use) so the booted agent runs
-- tools without asking.
--
-- Defaults to 0 so every existing schedule keeps the normal permission prompts.

ALTER TABLE schedules ADD COLUMN bypass_permissions INTEGER NOT NULL DEFAULT 0;
