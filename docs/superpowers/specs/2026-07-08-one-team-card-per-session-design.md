# One team card per session: dedup host mapping + hide lead-only teams

Date: 2026-07-08

## Problem

A single live supermux session (`Mobsters-United-Full`) rendered as THREE "Lead" team
cards in the sidebar. Clicking one selected all three and interleaved that session's
terminal output three times (garbled).

Three team dirs (`session-0a0af9dd` live, `session-2dbb48ec` + `session-37a40788`
orphaned) all had lead cwd `/home/supermux/projects/mobsters-united` and all resolved
their host to `Mobsters-United-Full`.

## Root cause

Host resolution (`teams::watcher::resolve_host_session`) falls back to a cwd match
(`cwd_match_session`, now keyed on the LEAD's cwd per the prior fix). cwd is not unique:
every time a session is cleared/restarted, Claude Code mints a NEW `session-<uuid>` team
dir and the old dir persists as an orphan with the SAME lead cwd. So the one live team
plus N orphaned dirs all cwd-match the one live session, producing N+1 duplicate cards
that all point at (and select) the same session.

The lead-cwd host fix made lead-only teams mappable by cwd (before it, a lead-only team
had no member cwd to match and stayed unmapped), which exposed this: lead-only orphans
now attach to the live session.

## Fix

Two coordinated changes in the teams watcher. Neither writes Claude's files.

### 1. Hide lead-only (rosterless) teams

A "team" with no teammates is not a team, it is a solo session (which already renders as
a normal session tile). Skip surfacing any team whose roster is EMPTY after the lead
entry is filtered out (`scan_one_team`) AND after dismissed members are removed
(`retain_undismissed`). Apply this in `scan_and_enrich`, right after `retain_undismissed`
runs for the team: if `team.members.is_empty()`, drop the team from the surfaced set.

Effect: the three current all-lead-only cards disappear; `Mobsters-United-Full` renders as
a plain tile. A team card appears only once a team actually has at least one teammate in
its roster (a mid-spawn team surfaces as soon as its first teammate is listed).

Note: `scan_one_team` already skips a team whose RAW config `members` is empty, but that
check is BEFORE the lead-entry + dismissed filtering; this new check is the post-filter
equivalent.

### 2. Dedup: at most one team per host session

Even with (1), a NON-empty orphan (a dead teammate still listed in an old config) could
still cwd-match the live session and duplicate a real team. So enforce the invariant
directly: after every team's `lead_supermux_session` is resolved for the tick, group teams
by their resolved host (ignoring `None`); when 2+ teams share a host, KEEP one and DROP the
rest from the surfaced set.

Winner selection (deterministic), best first:
1. most LIVE members (a member whose `status != Offline`) -- a real team with live
   teammates beats an empty/dead orphan;
2. then most members total;
3. then newest team `created_at`;
4. then lexically smallest `team_name` (final deterministic tiebreak).

This composes with (1): run the empty-roster drop first, then the dedup over what remains.

### Model change

Add `created_at: i64` to `Team` (`teams/model.rs`), populated from the config.json
`createdAt` field (epoch ms; `RawTeamConfig` gains a `created_at` field with
`#[serde(default)]`). `#[serde(skip_serializing)]` -- it is a server-side tiebreak signal,
not part of the wire shape. Every `Team { .. }` construction site (incl. tests) sets it.

## Order of operations in `scan_and_enrich`

Per team, unchanged: `validate_pane_ids`, `map_lead_session` / `resolve_host_session`,
`persist_team_name`, `retain_undismissed`. THEN, over the whole set:
1. drop teams with an empty roster (fix 1);
2. dedup by resolved host, keeping the winner (fix 2).

Both are pure transforms over the `Vec<Team>` and are unit-testable without tmux/DB.
Extract them as pure helpers (`drop_rosterless(teams)` and `dedup_by_host(teams)` or a
combined `collapse_duplicate_hosts`) taking/returning `Vec<Team>` (or mutating in place).

## Testing

Pure unit tests (no tmux/DB):
- hide lead-only: a team whose roster is empty after filtering is dropped; a team with an
  offline-but-present teammate is kept (offline != absent).
- dedup winner: given two teams with the same `lead_supermux_session`, the one with more
  live members wins; with equal live members, more total members wins; then newer
  `created_at`; then `team_name`. The loser is removed; a team mapping to a DIFFERENT host
  is untouched; a team with host `None` is never dropped by dedup.
- combined: three lead-only teams sharing a host all disappear (empty-drop happens first,
  so there is nothing left to dedup) -- the exact reported scenario.
- scan captures `created_at` from `createdAt`.

## Verification

Deploy and confirm on live data: `Mobsters-United-Full` maps to at most one team; after
un-archiving the two orphan dirs parked during triage (`session-2dbb48ec`,
`session-37a40788` under `~/.claude/teams/.archived/`) to re-create the failing condition,
`GET /api/teams` shows Full referenced by 0 or 1 team (never 3), and the sidebar no longer
triples. (Re-archive / leave archived afterward as appropriate.)

## Out of scope

- Cleaning up / deleting orphaned team dirs on disk (a separate hardening item; this fix
  makes orphans harmless to the UI without touching Claude's files).
- Any change to `resolve_host_session`'s per-team signal order or the lead-cwd match.
