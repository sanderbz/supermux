# UX Notes

A collection of design rationale behind some of the less-obvious UX choices in
this project. Captured here so future contributors understand *why* a flow
looks the way it does, not just *what* it does.

---

## Promoting an existing session into a team lead

When a user is already working in a session and decides they want a small
team of agents helping out, we want them to be able to do that *in place* —
without manually stopping the session, going to a "start a team" form, and
re-creating it. The session should keep its name, its directory, its row in
the database, and its tags / description / pin / sort order. It just becomes
a team lead.

### Naming the action

We considered several phrasings:

- **"Convert to team"** — accurate, but sounds engineery and heavy.
- **"Restart as team"** — accurate (we do restart it), but reads as procedural.
- **"Add teammates"** — invites the right mental model but understates the
  fact that the underlying process is restarted.
- **"Make it a team"** — calm, native, builder voice. Reads as "promote this
  session into a team lead." Pairs naturally with the existing "Start a team"
  flow (one for new sessions, one for existing — same family).

We picked **"Make it a team"**, with a contextualised variant `Make <name> a
team` in the sheet title. Reasons:

1. One short verb-phrase, sentence-case. Matches the visual rhythm of the
   existing lifecycle actions (`Start a team`, `Stop`, `Restart`, `Archive`).
2. It doesn't lie about the restart — the confirm/sheet body spells that out
   plainly so the user is never surprised.
3. It reads as the natural answer to "I have this session and I want to add
   a team."

### Placement — calm and contextual, no new top-level entry point

Discoverability matters more than novelty. We placed the action wherever the
user is *already thinking about lifecycle actions for this session*:

**Mobile — quick-peek modal action row.** Next to `Restart`, before
`Stop` / `Archive`. Uses the same action-chip component as its neighbours,
with a 44pt hit target and a `Users` icon. Visible whenever the session is
not already a team lead (it would be a no-op there).

**Desktop — focus header.** The desktop focus header is already tight (mode
pill, agent tools, detach, stop), so we don't cram in a fourth icon
indiscriminately. Instead we add it as a calm action adjacent to the right
cluster, *before* the Stop button — so the destructive button stays last,
matching the platform convention. Same 44pt button, `Users` icon, tooltip
`Make this a team`.

**Stopped-session view.** When a session is already stopped, the lifecycle
action row offers Start / Resume / Archive. "Make it a team" lives here too
as a secondary ghost button next to Archive — clear disclosure that this is
a path forward, not just a restart. Same 44pt button.

The principle: each of these is a place where the user is already considering
lifecycle actions. The new action sits where Restart / Stop / Archive sit.
We deliberately *do not* introduce a new top-level entry point for it.

### Fresh start vs resume — be honest about the seam

The underlying agent runtime can't be told mid-flight to enable team-mode —
the relevant environment variable and settings are picked up at process
launch. So promotion to a team *requires* a stop + start with the team flags
injected.

For v1 we chose a **fresh start, not a resume**. Reasons:

- The user is asking the agent to take on a new framing ("you are now a team
  lead with N teammates"). The seed prompt has to be the first turn for the
  agent to honour it — mid-conversation it would be a fight against
  established context.
- Resume would mean injecting the seed mid-thread (or appending it), which
  is weaker priming *and* clashes with whatever the agent was doing.
- Session metadata (name, directory, tags, pin, branch) is preserved —
  that's the actual ask. Conversation context can be re-introduced by the
  user pasting in what they want preserved.

We call this out plainly in the sheet body and confirm copy:

> Stops `<name>` and restarts it as the lead of a team of N agents in
> `<dir>`. The team starts fresh — paste any context you want it to keep.

A future iteration could offer a "Resume same conversation" checkbox that
picks the latest project transcript for the directory and injects the seed
after a `/resume`. We deferred that to keep v1 honest and predictable.

### Sheet design — one form, two modes

The promotion sheet reuses the "Start a team" sheet internals via a
`mode: 'create' | 'convert'` prop. One form, two modes — DRY, and the user
sees a familiar shape. The differences in `convert` mode:

- Title becomes `Make <name> a team`.
- The **Directory field is hidden.** We always use the existing session's
  directory; this flow is explicitly about *this* session, not about picking
  a path. The directory is shown instead as a muted footnote (`In: <dir>`)
  under the title — visible context, but the user can't wander away from it.
- The cost / consequence note is reframed: "Stops `<name>`, then restarts it
  as the lead of N agents."
- Submit button copy: `Make it a team` (vs `Start team` in create mode).

Fields the user fills out are otherwise identical to the create flow: goal
(textarea, required, autofocus), teammates (stepper, default 3, clamped
1..=8), and an optional model override.

### Edge cases — keep the action honest

- **Session is already a team lead** → action is hidden (no-op).
- **Session is archived** → action hidden (archived sessions can't be
  promoted directly; they need to be unarchived first).
- **Session is stopped** → skip the stop call, proceed straight to set-flag
  + start.
- **Name collision** → impossible by construction; we're reusing the
  existing row.
- **Backend reports "already a lead"** → toast `Already a team — nothing
  to do.`

### API shape — a separate endpoint, not a flag

The promotion is exposed as a distinct endpoint
(`POST /api/teams/start-from-existing`) rather than as a `replace` flag on
the existing `/api/teams/start`. Reasons:

- **Different invariants.** `start` requires a name that is either generated
  or unused (it 409s if taken). `start-from-existing` requires the name to
  *already* exist (it 404s if not). Routing both through one endpoint would
  mean the server has to fork its semantics on the presence of a flag —
  cleanest as two paths.
- **Different error shape.** `start` has nothing to 404 on; the promotion
  endpoint 404s on unknown session, 409 on already-a-lead, 422 on archived.
- **Zero blast radius.** Keeps `/api/teams/start` totally unchanged — both
  its behaviour and its tests.

The `dir` field is rejected (or, more kindly, ignored) on the promotion
endpoint. The existing session's directory is authoritative.

---

## General principles surfacing in the above

A few principles that recur across this project's UX decisions and are worth
stating plainly:

- **Calm, sentence-case verbs over engineery nouns.** "Make it a team" beats
  "Convert to team."
- **Honest copy at the seam.** When an action has a non-obvious consequence
  (a restart, loss of in-memory context, etc.), say so in the confirm body.
  Don't hide it behind a friendly verb.
- **Discoverability where the user is already thinking.** New lifecycle
  actions go next to existing lifecycle actions, not in a new top-level
  menu.
- **Destructive actions stay last.** Stop / Archive sit at the end of an
  action row. New non-destructive actions slot in *before* them.
- **One form, two modes** beats two near-identical forms. Use a `mode` prop
  and hide the fields that don't apply, rather than maintaining a parallel
  copy.
- **Separate endpoints for separate invariants.** When two operations look
  similar but have different preconditions and error shapes, give them
  distinct URLs. Flags-that-change-semantics are a code smell.
