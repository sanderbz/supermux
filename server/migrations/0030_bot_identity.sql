-- Bot identity columns (additive, backfill-safe).
--
-- Three per-session columns that give a session a durable "bot" identity beyond
-- its slug/label:
--   * model  — the launch-line model selection (e.g. "opus"). Injected as
--              `--model <id>` at launch (sessions::lifecycle::build_launch_command),
--              ALLOWLIST-validated on every write so a shell-meta value can never
--              reach the command line. Empty = provider default (the whole
--              existing fleet).
--   * memory — the bot's "Notes it keeps": free text injected READ-ONLY into the
--              agent's system prompt at launch, after the role (`desc`). v1 is
--              read-only; the agent WRITING back to this column is a later phase.
--   * skills — reserved. A JSON array (default '[]') for a future per-bot skills
--              selection; nothing consumes it yet.
--
-- All three carry a NOT NULL DEFAULT so every pre-existing row backfills to the
-- empty/neutral value and no read path changes behaviour.
ALTER TABLE sessions ADD COLUMN model  TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN memory TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
