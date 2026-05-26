# FEAT-CONVERT-TEAM — UX design notes

## Goal
Let the user "spin up a team on this session right here" without manually
stopping and re-creating it via the Start-a-team sheet. The session keeps its
name, its directory, its DB row, its tags / desc / pin / order; it just
becomes a team lead.

## Action name (the most natural)
Candidates considered:
- "Convert to team" — accurate, sounds engineery / heavy.
- "Restart as team" — accurate (we do restart), reads as procedural.
- "Add teammates" — invites the right mental model but understates the restart.
- "Make it a team" — calm, native, builder voice. Reads as "promote this
  session into a team-lead." Pairs naturally with our existing "Start a team"
  (one for new sessions, one for existing — same family).

**Pick: "Make it a team"**, with the contextualised variant in the sheet
title `Make <name> a team`. Reasons:
1. One short verb-phrase, sentence-case. Matches `Start a team`, `Stop`, `Restart`, `Archive`.
2. Doesn't lie about restart (the confirm/sheet body spells that out plainly).
3. Reads as the natural answer to "I have this session and I want to add a team."

## Action placement (no extra clicks — see user feedback)
Three surfaces, calm and contextual:

### A) Mobile — quick-peek modal action row
Next to `Restart`, before `Stop`/`Archive`. Uses the same `<PeekAction>` chip,
44pt hit target, `Users` icon. Visible whenever the session is NOT already a
team lead (we hide it on a team lead — no-op).

### B) Desktop — focus header overflow
The desktop focus header today is tight: Mode pill, Claude tools, Detach,
Stop. We do NOT cram a fourth icon — instead we add it as a calm action
adjacent to the right cluster, before the Stop button (so the destructive
button stays last, matching iOS). Same 44pt button, `Users` icon, tooltip
`Make this a team`.

### C) Stopped-session view
This is a natural home — when the session is already stopped, the
`<StoppedSessionActions>` row offers Start / Resume / Archive. "Make it a
team" lives there too as a secondary ghost button next to Archive (clear
disclosure that this is a path forward, not just restart). Same 44pt button.

Rationale for three surfaces: each is where the user is *thinking about
lifecycle actions for this session*. The action is discoverable wherever
Restart/Stop/Archive are. We do not add a brand-new top-level entrypoint.

## In-place vs replace semantics for ACTIVE sessions
A Claude session can't be told mid-flight to enable the teams env — the
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var + `teammateMode:"tmux"`
settings are picked up at process launch. So conversion REQUIRES stop +
start with teams env injected.

Decision for v1: **fresh start, not `--resume`**. Reasons:
- The user is asking the agent to take on a new framing ("you are now a team
  lead with N teammates") — the seed prompt has to be the first turn for the
  agent to honour it. Mid-conversation it would be a fight against context.
- Resume would mean injecting the seed mid-thread (or appending) which is
  weaker priming AND clashes with whatever the agent was doing.
- The session metadata (name, dir, tags, pin, branch) is preserved — that's
  the actual ask. Conversation context can be re-introduced by the user
  pasting in what they want preserved.

Called out plainly in the sheet body / confirm copy:
> "Stops <name> and restarts it as the lead of a team of N agents in <dir>.
>  The team starts fresh — paste any context you want it to keep."

v2 (deferred): a checkbox "Resume same conversation" that picks the latest
project transcript for the dir and injects the seed AFTER a `/resume`.

## Sheet design (variant of Start-a-team)
Reuses `StartTeamSheet` internals via a `mode: 'create' | 'convert'` prop,
keeping ONE form (DRY) — only:
- Title becomes `Make <name> a team` in convert mode.
- The Directory field is **hidden** (we ALWAYS use the existing session's
  dir; conversion-of-this-session means we are NOT picking a path). Shown
  instead as a muted footnote `In: <dir>` under the title so the user sees
  WHERE the team will run without being able to wander away from it.
- Confirmation framing in the cost note: "Stops <name>, then restarts it as
  the lead of N agents."
- Submit button copy: `Make it a team` (vs `Start team` in create mode).
- The submit calls `teamsStartApi.convert(name, body)` instead of `.start(body)`.

Fields the user fills (unchanged from create):
- Goal/task (textarea, required) — autoFocus.
- Teammates (stepper, default 3, clamped 1..=8).
- Model (optional).

## Edge cases
- Session is already a team lead → action is hidden (no-op).
- Session is archived → action hidden (archived sessions can't be made into
  teams; they need to be unarchived first).
- Session is stopped → skip the stop call, proceed straight to set-flag +
  start (the server handles this).
- Name collision → impossible (we're reusing the existing row).
- Backend 409 (already a lead) → toast `Already a team — nothing to do.`

## Backend endpoint
**`POST /api/teams/start-from-existing`** — a NEW endpoint (not a `replace`
param on `/api/teams/start`).

Why a new endpoint vs a `replace` param on the existing `/api/teams/start`:
- Different invariants: `start` requires a NAME to be either generated or
  unused (409 if taken). `start-from-existing` requires the name TO
  already exist (404 if not). Same body would mean the server has to
  dispatch on presence of `replace` — that's a semantic fork, cleanest as
  two paths.
- Different error shape: `start` 404s nothing; the new endpoint 404s on
  unknown session, 409 on already-lead, 422 on archived.
- Keeps `/api/teams/start` totally unchanged — zero blast radius on the
  existing flow (and on AT-D's tests).

Signature:
```
POST /api/teams/start-from-existing
Body: { name: string, task: string, teammates?: u32, model?: string }
   → 201 Created
   { ok: true, data: { team: true, teammates: u32, lead: SessionView } }
   404 — session not found
   409 — session is already a team lead
   422 — session is archived
   400 — empty/oversize task
```

Note: `dir` from the body is REJECTED (or, more kindly, ignored). The
existing session's `dir` is authoritative.

## Implementation notes (server)
1. Look up the session row by name — 404 if missing.
2. Refuse archived (422).
3. If the row already corresponds to a detected team lead, 409. We detect this
   by scanning ~/.claude teams: any team whose `lead_supermux_session == name`
   means we're a lead. (Cheap — the watcher already builds this map.)
4. If `tmux::Tmux::new(name).exists()` → call `lifecycle::stop`, poll briefly
   until tmux is gone.
5. `state.set_force_agent_teams(name)`.
6. Update the session row's `desc` to `Team lead — <short_desc(task)>` and
   tags to include `"team"` (idempotent), so the row reads as a team lead
   even before AT-B detects it.
7. Call `lifecycle::start(state, name, Some(&seed))` with the same seed
   prompt builder.
8. Return the post-boot `SessionView`.

A focused server unit test covers: 404 on unknown, 409 on already-a-lead,
422 on archived, happy path (existing row gets started with the teams flag
set + seed delivered).
