-- migrations/0022_dismissed_teammates.sql
-- Supermux-side "dismiss" (hide) for a single teammate. A teammate that has
-- finished or been killed lingers forever as an offline chip because Claude
-- Code leaves it in `~/.claude/teams/<team>/config.json` until the whole lead
-- session ends, and supermux only READS that file (never writes it; the
-- invariant in server/src/teams/model.rs). So "remove a teammate" cannot edit
-- config.json; it must be a supermux-side hide.
--
-- A dismissal is keyed by (team_name, agent_id). `agent_id` ("{name}@{team}",
-- see teams/model.rs) is the stable member identity. The teams watcher drops
-- any member whose agent_id is dismissed on every tick, so the hide survives
-- restarts. Rows are pruned when their team is deregistered or archived so the
-- table stays bounded to live teams.
--
-- Known, chosen limitation (no auto re-arm): a dismissal is sticky for the life
-- of the team. If Claude re-spawns a NEW teammate with the exact same
-- `name@team` id it would stay hidden. Spawn names are unique in practice, so
-- v1 does not handle this; a future "show dismissed" escape hatch can re-arm.

CREATE TABLE dismissed_teammates (
    team_name    TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (team_name, agent_id)
);
