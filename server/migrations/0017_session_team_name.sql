-- migrations/0017_session_team_name.sql
-- Persistent backlink from a supermux session to the Claude team it currently
-- hosts. Populated by teams::watcher each tick after the host-session resolves;
-- consumed by sessions::lifecycle::{archive,unarchive} to move the team's
-- on-disk config to / from `~/.claude/teams/.archived/` so an archived team
-- can't shadow a new team that lands in the same cwd. NULL when the session
-- has never hosted a team (the common case for non-team sessions).
ALTER TABLE sessions ADD COLUMN team_name TEXT;
