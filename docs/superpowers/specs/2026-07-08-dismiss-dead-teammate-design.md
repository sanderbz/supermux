# Dismiss / remove a teammate from a team (supermux-side)

Date: 2026-07-08

## Problem

A teammate that has finished (or been killed) stays in the team roster forever as an
offline "dead" chip, with no way to remove it. Example: `fix-644` in team
`session-37a40788`. The existing trash button (`KillTeammateButton`, commits #28/#29)
only appears for a teammate with a LIVE tmux pane and only kills that pane
(`tmux kill-pane`). Killing a live teammate does NOT remove it — on the next watcher
tick it flips to offline and lingers as a dead chip, and the trash then disappears
(gated on a live pane). So there is currently no action, in any state, that removes a
teammate from supermux's team view. Claude Code leaves finished teammates in
`~/.claude/teams/<team>/config.json` until the whole lead session ends, and supermux
only reads that file.

## Constraint

supermux never writes Claude's team files (invariant, `server/src/teams/model.rs:5-7`).
So "remove" must be a supermux-side hide, not an edit of `config.json`.

## Behavior (approved)

One trash icon on every teammate, live or dead. Click -> confirm -> the teammate
disappears from supermux immediately.

- Live teammate: kill its tmux pane, then record a dismissal -> gone at once (no
  lingering dead chip). Confirm label: "Kill & remove".
- Dead/offline teammate: just record a dismissal. Confirm label: "Remove".

A dismissal hides the teammate from supermux's team view and survives restarts. Claude's
`config.json` is untouched.

## Backend

### 1. Storage — new table

Migration `server/migrations/00NN_dismissed_teammates.sql`:

```sql
CREATE TABLE dismissed_teammates (
    team_name    TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (team_name, agent_id)
);
```

`agent_id` (`"{name}@{team}"`, `model.rs:49`) is the stable member identity. Pick the
next free migration number by inspecting `server/migrations/`.

New module `server/src/db/teams_dismissed.rs` (wire into `server/src/db/mod.rs`):
- `dismiss(pool, team_name, agent_id, now)` — INSERT OR IGNORE (idempotent).
- `list_for_team(pool, team_name) -> Vec<String>` — the dismissed agent_ids.
- `prune_team(pool, team_name)` — DELETE all rows for a team (called when a team is
  deregistered/archived so the table stays bounded).

Match the style of an existing simple db module (e.g. `server/src/db/boards.rs` or
`server/src/db/prefs.rs`): `sqlx` queries, the crate's error type, unit-tested against an
in-memory / temp sqlite the way sibling modules test.

### 2. Endpoint

`DELETE /api/teams/{team_name}/members/{agent_id}` (mirror the existing team route shape
at `server/src/teams/mod.rs`; the team-level `/api/teams/{name}/dismiss` handler is the
reference for auth + wiring). Handler:

1. Scan/resolve the team `team_name` (reuse the same scan the watcher uses). Find the
   member with this `agent_id`. If the team or member is unknown, still record the
   dismissal (idempotent, harmless) OR 404 — pick 404 for a genuinely unknown team, but
   treat an already-gone member as success (idempotent remove).
2. If the member currently has a LIVE pane (resolve the lead supermux session +
   validate the pane against live tmux, same logic the watcher/kill path uses), kill it
   via the existing pane-kill primitive (`lifecycle::kill_teammate_pane` /
   `tmux.kill_pane`). If the kill FAILS, return the error and do NOT record the
   dismissal — never hide a still-running agent.
3. Record the dismissal (`teams_dismissed::dismiss`). Return success.

Keep the existing `DELETE /api/sessions/{name}/teammates/{pane_id}` kill endpoint as-is
(it may still be used); the new endpoint is the "remove from list" action. If it's
cleaner to have the new endpoint delegate to the existing kill primitive for the
live-pane case, do that rather than duplicating tmux logic.

### 3. Filter in the watcher

In `server/src/teams/watcher.rs::scan_and_enrich` (has `state.pool`), after a team's
members are resolved for the tick, drop any member whose `agent_id` is in
`teams_dismissed::list_for_team(team_name)`. Unconditional drop (regardless of
live/offline) so the live-case removal sticks across the tick before the killed pane
fully dies. Load the dismissed set once per team per tick (cheap; small tables).

### 4. Cleanup

When a team is deregistered (`reconcile_deregistrations` in `watcher.rs`) or its config
archived (`sessions::lifecycle::archive` -> `archive_team_config`), call
`teams_dismissed::prune_team(team_name)` so dismissals don't accumulate for teams that
no longer exist.

### Non-goal: auto re-arm

A dismissal is sticky for the life of the team. The only case it wrongly hides is Claude
re-spawning a NEW teammate with the exact same `name@team` id (uncommon — spawn names are
unique). Not handled in v1; a future "show dismissed" escape hatch can re-arm. Document
this in the module doc comment so it's a known, chosen limitation, not a silent bug.

## Frontend

`web/src/components/team/kill-teammate-button.tsx`:
- Remove the `!paneId` gate so the button renders for offline members too. Keep rendering
  whenever the team + member are identifiable (needs `team.team_name` + `member.agent_id`).
- Call the new endpoint: `teamsApi.removeTeammate(team_name, agent_id)` ->
  `DELETE /api/teams/{team_name}/members/{agent_id}` (add to `web/src/lib/api/teams.ts`
  alongside `killTeammate`). Invalidate `TEAMS_KEY` on success.
- State-aware confirm label: member has a live pane -> "Kill & remove"; offline -> "Remove".
- Adjust the button's tooltip/aria-label similarly.

Render sites unchanged (they already pass `team` + `member`):
`teammate-chip.tsx`, `teammate-card.tsx`, `focus-mode/team-strip-group.tsx`.
`teammate-card.tsx` already shows a "No live pane right now" placeholder for `gone`
members; that stays.

## Testing

Backend (unit, sibling-module style):
- `teams_dismissed`: dismiss is idempotent; `list_for_team` returns only that team's ids;
  `prune_team` clears them.
- watcher filter: given a scanned team with members [A, B] and B dismissed, the enriched
  team exposes only [A]; nothing dismissed -> both survive.
- endpoint: dead member -> dismissed, no kill attempted; live member -> kill primitive
  invoked then dismissed; simulated kill failure -> dismissal NOT recorded + error
  returned. (Test at the handler/lifecycle seam; mock/inject the tmux kill where the
  existing kill-endpoint tests do.)
- cleanup: prune-on-deregister removes the team's dismissals (extend the existing
  deregister test if practical).

Frontend: follow existing component-test patterns if present; at minimum confirm the
button renders for an offline member and calls `removeTeammate` with the right args, and
that the confirm label switches on pane presence. If there's no component-test harness
for this button, a Playwright screens/smoke assertion is acceptable, else rely on the
manual/live check.

## Verification

Deploy to the host and confirm on real data: the offline `fix-644` chip in team
`session-37a40788` now shows a trash affordance; clicking it removes the chip and it
stays gone across a refresh / restart; `~/.claude/teams/session-37a40788/config.json`
still contains `fix-644` (file untouched).

## Out of scope

- Editing Claude's `config.json`.
- Auto re-arm / "show dismissed" UI.
- Any change to the team-level `/dismiss` (whole-team park) behavior.
