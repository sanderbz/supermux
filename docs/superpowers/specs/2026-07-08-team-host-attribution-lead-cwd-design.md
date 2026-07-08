# Team host attribution: resolve by the lead's cwd, not a teammate's

Date: 2026-07-08

## Problem

A live team was rendering as a "Lead / done / dead-subagent" card on the **wrong**
supermux session. Concretely: the team `session-37a40788` is led by the running
`Mobsters-United-Full` session (dir `/home/supermux/projects/mobsters-united`), but
it was showing up attached to the `Mobsters-United-Game` session (display name
"Mobsters United App", dir `/home/supermux/projects/mobsters-united/game.mobsters-united.com/`).

Because the team is not actually the App's, clearing / stopping / restarting the App
never cleared the card — the team lives on under Full, and its stale-paned teammate
(`fix-644`) kept rendering as an offline ("dead") chip with a green "done" roll-up.

This is a **mis-attribution** bug, not a stale-directory / orphan bug. The team dir
is legitimately live and must NOT be archived or deleted.

## Root cause

Host resolution happens in `server/src/teams/watcher.rs::resolve_host_session`, which
tries, in order: (1) `leadSessionId` as a supermux name, (2) `team_name` as a supermux
name, (3) pane-id intersection with live tmux windows, (4) `cwd_match_session` — a
last-resort match of a team member's `cwd` against a live session's `dir`.

For this team, signals 1-3 all miss:
- `leadSessionId` is a Claude UUID, not a supermux session name.
- `team_name` (`session-37a40788`) is not a supermux session name.
- pane-id intersection fails: the only teammate carrying a `%id` (`fix-644`, pane `%0`)
  has a dead pane, so nothing intersects the live windows.

So resolution falls to `cwd_match_session`. That function collects the cwds of
`team.members` and returns the first session whose `dir` matches any of them. The
critical flaw: **the lead row has already been filtered out of `team.members`**
(`server/src/teams/scan.rs::scan_one_team` -> `is_lead_entry`, the FIX-TEAMS
phantom-chip fix). The lead's cwd — `/home/supermux/projects/mobsters-united`, which
is the authoritative host directory — is therefore not in the candidate set. The only
remaining cwd is the teammate `fix-644`'s worktree cwd
`/home/supermux/projects/mobsters-united/game.mobsters-united.com`, which happens to
equal the **App** session's `dir`. So the team pins to the App.

In short: `cwd_match_session` resolves the host from a **teammate's** working
directory, but a teammate can legitimately work in a worktree/subdir that coincides
with a *different* supermux session's directory. Only the **lead's** cwd is the
team's host directory, and that cwd is thrown away before resolution runs.

## Fix

Resolve the host by the lead's cwd.

1. `server/src/teams/model.rs` — add a field to `Team`:
   ```rust
   /// The lead's working directory (from the filtered-out lead members[] entry).
   /// The authoritative host directory for cwd-based host resolution: a teammate
   /// may work in a worktree/subdir that collides with an UNRELATED session's dir,
   /// so teammate cwds must never win host attribution over the lead's own cwd.
   /// Empty when the lead entry had no cwd (in-process lead / schema drift).
   #[serde(skip_serializing)]
   pub lead_cwd: String,
   ```

2. `server/src/teams/scan.rs` — in `scan_one_team`, while partitioning the roster,
   capture the cwd of the entry that `is_lead_entry` matches into `team.lead_cwd`
   (take the first lead-entry hit; leads are singular in practice). Keep the existing
   teammate materialization unchanged.

3. `server/src/teams/watcher.rs::cwd_match_session` — match on `team.lead_cwd` first
   (the authoritative host dir). Only if `lead_cwd` is empty, fall back to the current
   teammate-cwd scan (defensive: in-process lead or drifted config with no lead cwd).
   Reuse the existing normalization (`trim`, `trim_end_matches('/')`, case-insensitive
   compare) and the existing `provider == "claude"` filter.

Signals 1-3 in `resolve_host_session` are untouched — they remain the primary
resolvers; this only corrects the cwd fallback. No schema migration, no archiving,
no lifecycle changes.

### Result

- `session-37a40788` resolves to `Mobsters-United-Full` (its true host).
- The App (`Mobsters-United-Game`) stops rendering the ghost Lead/done/dead card.
- Nothing is archived or deleted; the live team is preserved and now shows on Full.

## Testing

Unit tests in `server/src/teams/` (pure, no tmux/DB where possible):

1. **scan captures lead cwd**: a `config.json` with a `team-lead` member (cwd = dir A)
   plus a teammate (cwd = dir B) materializes a `Team` with `lead_cwd == A` and
   `members` containing only the teammate (cwd B). Guards the capture + the existing
   filter together.

2. **cwd match prefers lead cwd** (the regression test for this bug): given a team
   whose `lead_cwd` = session Full's dir and whose only teammate cwd = session App's
   dir, `cwd_match_session` (or a thin, testable seam over its matching logic)
   resolves to Full, not App. Assert it does NOT return App.

3. **fallback when lead_cwd empty**: `lead_cwd == ""` and a teammate cwd matches a
   session — resolution still finds that session (preserves the pre-fix behavior for
   in-process/drifted leads).

4. **no match**: neither lead nor teammate cwd matches any session dir -> `None`
   (team surfaced unmapped, the existing calm state).

If `cwd_match_session`'s DB dependency makes direct unit testing awkward, extract the
pure matching core (given a list of `(session_name, dir, provider)` and a `Team`,
return the matched name) and test that; the DB call stays a thin wrapper.

## Edge cases / non-goals

- **Multiple lead entries**: not expected; take the first `is_lead_entry` match's cwd.
- **Lead cwd matches multiple sessions**: only `Mobsters-United-Full` has that exact
  dir today; if a future collision exists, first-match wins (same semantics as today,
  just keyed on the correct cwd).
- **Out of scope**: the separate observation that a stopped session can still be
  cwd-matched, and that orphaned team dirs are only cleaned on archive. Those are real
  but distinct hardening items; this fix deliberately does not touch cleanup/lifecycle
  and does not delete anything, because the triggering case is a LIVE team.
