-- migrations/0019_session_display_name.sql
-- Split a session's identity: `name` stays the IMMUTABLE slug (the PK referenced
-- by every child table, the tmux session name, $SUPERMUX_SESSION, the route, and
-- the per-pane hook token) while `display_name` is the MUTABLE human label that
-- the "rename" action now edits. Decoupling them removes the whole rename-
-- staleness bug class: a running pane's frozen $SUPERMUX_SESSION can never drift
-- because the slug it carries is never changed after creation.
--
-- Additive + backfilled so an existing deployment upgrades with zero touch: the
-- ADD COLUMN is a metadata-only change (constant default), and the backfill makes
-- every existing session's label equal its slug — i.e. exactly what was shown
-- before — so nothing changes visually until the user renames.
ALTER TABLE sessions ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
UPDATE sessions SET display_name = name WHERE display_name = '';
