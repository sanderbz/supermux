# Fase B4 — Transcript-as-log: entity chips, delegation, conversational schedules

## ADDENDUM — execution re-audit, 2026-08-16 (executor)

**G1 is CLEARED, option (b).** The fabric spine was squash-landed on `main` as **#71 (`c1e7053`)**:
*"feat(fabric): land the delegation/schedule spine — ledger events, wrappers, parity-fixed rendering"*.
`main` also carries B1 (**#69** `ef19402`) and the perf-gate reform (**#70** `d9eca32`, entry ≤160 KB strict,
total ≤232 KB temporary). Worktree base is therefore **`origin/main` = `c1e7053`**, not the integration branch, and
§0.1's "merge `main` in" step does not apply.

**G2 is CLEARED, with conditions.** Agents MAY create schedules through the hook-token endpoint, with:
- a **per-session cap of 20 live (non-archived, enabled *or* disabled but not deleted) schedules** — the plan's own
  proposed number; over it the endpoint answers **429**;
- **`done_action: "command:…"` REJECTED on the hook path** (400). Hook-created schedules may only `disable` or
  `notify`. The bearer path is unchanged.

**Already done by the spine PR — do not rebuild:**

| plan item | state on `main` @ `c1e7053` | evidence |
|---|---|---|
| **T1 (all of T1.1–T1.6)** | **DONE** | shared corpus `server/tests/fixtures/chat/supermux-wrappers.jsonl` consumed by `server/tests/wrapper_parity.rs` (via a public `recall::classify_prompt_body` seam) **and** `web/tests/unit/chat-wrapper-parity.test.ts`; `wire-entries.ts` classifies `delegation`/`schedule` and the survives-filter keeps them; `grouping.ts` maps them to `teammate:`/`schedule:` speakers |
| **T2.1 + T2.2** | **DONE** | `delegate.rs::wrapper_markup` + `attr_safe`; `wrap_delegation` returns `Err`; the handler rejects wrapper markup with **400 pre-delivery, on every provider path**; `scheduler/runner.rs::escape_attr` covers the schedule attribute mirror |
| **T2.3 (doc + 3 of 4 cases)** | **PARTLY DONE** | module doc + `actor_human_audits_as_user` / `actor_absent…` / `unknown_actor…`; the `"HUMAN"` and `"user"` cases and the §0.4 "not an authentication result" sentence are still owed |
| **T3.2 (`onOpenSession`)** | **DONE** | `chat-panel.tsx:127` → `conversation.tsx` → `transcript-item.tsx:139` → `HarnessLine`'s `MentionChip` |
| migration 0026 | inherited | `server/migrations/0026_audit_target_idx.sql` |

**Renumbering:** T1 and the T2.1/T2.2 checkboxes are ticked as *inherited*. The rest keep their numbers so the plan
stays diffable against the PR body. T2 now starts at T2.3.

**Migration re-verification at land time (T0.4):** highest on `main` = `0026_audit_target_idx.sql`. `0025` remains
double-claimed (`0025_archive_on_stop.sql` on two branches, `0025_session_notif.sql` on the integration branch).
The first genuinely free number across every branch is **`0027`**. **B4 still adds no migration** — schedule
provenance rides `audit_log.detail` and the T8.3 retention prune is a `DELETE`, not a schema change.

**Pre-existing red recorded before T1 (T0.3):** `cargo test --lib` 787 pass / 0 fail; `bun test tests/unit` 1034 pass
/ 0 fail; **`eslint` reports 6 pre-existing errors** (all `react-hooks/set-state-in-effect`) in
`focus-mode/last-send-recall.tsx` ×2, `session-tile/where-picker.tsx`, `settings/updates-panel.tsx`,
`files/file-list.tsx`, `chat/attention-card.tsx` — none in files B4 owns, none introduced here, and B4 adds zero new
lint errors.

**Security note carried in from the spine agent (feeds T10):** `audit_harness` broadcasts the `harness` frame on the
**GLOBAL** SSE channel; the `sessions` array in the payload is a **client-side filtering hint, not an authorization
boundary**. Any SSE subscriber sees that a delegation happened and between which slugs. The payload carries no prompt
body — but the fact and the participants leak to every authenticated SSE listener. Covered explicitly in T10.1's
matrix.

---

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> This plan was written against the REAL repo on 2026-08-16 (`origin/main` = `ea642df`, `origin/feat/grok-ui-integration`
> = `81f6eb3`). **Read §0 before Task 0.** A large part of what the master plan lists under B4 has *already been built*
> on an unmerged branch, and one of the two chat planes cannot see it. Re-implementing it would be the worst possible
> outcome of this plan.

**Worktree** `/opt/projects/supermux-b4` · **branch** `feat/b4-fabric`
**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` on the unmerged branch `docs/grok-ui-plan` —
read with `git show origin/docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`.
B4 scope = master plan **§13** (the transcript as management log + cross-session fabric), the **§4.2 system line**
row, **§14**'s chip mechanic, and the **§17 B4 row**.
**Format model** `docs/superpowers/plans/2026-08-16-fase-b1-shell.md`.

> One sentence of scope: **the transcript stops being a record of one agent talking and becomes the place the fleet's
> work is visible and steerable** — every cross-session event the app already writes to `audit_log` becomes a
> navigable sentence in the conversation where it happened, `@colleague` in the composer actually hands work over,
> and an agent can create its own schedule with a token that can only ever schedule for itself.

---

## 0. Ground truth — read this first

Everything below was checked against real git objects on 2026-08-16. **Do not "fix" these back to the master plan's
wording, and do not build anything §0.2 says already exists.**

### 0.1 The stack reality (the thing the master plan cannot know)

`origin/feat/grok-ui-integration` is the de-facto trunk of the Grok-UI stack: A2/A3/A4/B0 were merged into it, then
squash-landed on `main` as PRs #60–#63, #66–#68. It is currently **behind main by 10 squashed commits** and **ahead of
main by ~40**, of which the top nine are B4 work already written and *never reviewed or merged*:

| commit | what it shipped | B4 line item it satisfies |
|---|---|---|
| `b97c408` | `DelegateInput.actor` + `audit_actor()` — `actor:"human"` audits as `user`, anything else as `agent:<from>` | delegate API `actor` |
| `2cf712a` | `<supermux-delegation from="X">` wrapper on delivery (`DELEGATION_TAG`, `wrap_delegation`, `wraps_for_provider`), `send_text_with_preview`, `recall.rs` classification | the wrapper mechanism |
| `43ce4f8` | recall popover survives a delegated prompt | — |
| `f10f527` | `<supermux-schedule id title>` wrapper on scheduled fires + `Kind::Schedule` + the curl footer leaves the chat | §13.3 "which schedule ran it" |
| `74e93d5` | the recall wire-kind mirror names every default-shown kind | — |
| `58fa3da` | `grouping.ts`: a delegated prompt gets its sender's divider, not the owner's bubble | arrival divider |
| `01911fb` | **`GET /api/sessions/{name}/events`** — replayable per-session harness feed over `audit_log`, `harness` SSE as the invalidation echo, `SURFACED_ACTIONS`, migration `0026_audit_target_idx.sql`, `audit_harness()` | first-class delegation event + audit surfacing |
| `667ae2a` | the `$.from` feed arm scoped to `session.delegate` so a rename can't land in a stranger's transcript | — |
| `81f6eb3` | `HarnessLine` + `use-harness-events.ts` + `lib/api/harness.ts` + grouping merge — **durable system lines for delegate / rename / schedule** | §13.1 system lines |

**Consequence:** B4 is *not* a greenfield fase. It is **(a) land and harden that spine, (b) close the four gaps it
deliberately left, (c) fix the one thing the merge with main breaks.**

### 0.2 What already exists vs. what the master-plan B4 row asks for

| §17 B4 row item | reality | B4 does |
|---|---|---|
| system-line entity chips | `SystemLine`/`SystemSep`/`SystemEntity`/`MentionChip` shipped in B0 (`web/src/components/chat/ui/system-line.tsx`), chip mechanic exact (negative margins cancel padding, 120ms hover). `HarnessLine` renders four sentences. **`onClick` is unwired on every `SystemEntity`** and on `MentionChip` in prose — the code says so in `HarnessLine`'s schedule branch ("No `onClick` yet — the Schedules sheet that would receive it is a later slice", `transcript-item.tsx:477` on the integration branch) | **T3** wires navigation |
| delegate API `actor` | **DONE** (`b97c408`). `audit_actor(Some("human"), _) == "user"` | **T2** hardens (it is *caller-declared*, see §0.4) |
| first-class `delegation` event | **DONE, but not as the master plan drew it.** The plan said "emit a `delegation` event on SSE/chat-WS that the renderer joins to the transcript entry". The branch built something **better and deliberately different**: a durable, replayable, cursor-paged feed over the existing audit ledger (`GET /api/sessions/{name}/events`) with the `harness` SSE frame as a pure invalidation tick — the hook doc says *"SSE IS THE ECHO, THE LEDGER IS THE TRUTH"* (`use-harness-events.ts:8`). A live-only SSE event would vanish on reload | **adopt the ledger design.** Do NOT add a chat-WS frame or an SSE-carried delegation payload |
| `Kind::Delegation` if a wrapper is used | **DONE in the recall plane** (`recall.rs:149`), and a wrapper *is* used | **T1** — the chat-WS plane is the problem, see §0.3 |
| `@session` composer flow | **NOT DONE.** The `@` picker already lists sessions (`slash.ts:362`) and a comment at `slash.ts:335` explicitly defers dispatch to "Track B §13" | **T4** |
| handoff pill | pill primitive exists (`ui/delegation-pill.tsx`), but it is driven by a **heuristic**: `delegationTarget(session.activity, mentions, self)` (`live-layer.tsx:503`) greps the activity string for a known session name | **T5** replaces the heuristic with the real dispatch + ledger |
| arrival divider | **DONE** (`58fa3da` + `TeammateRow`/`ArrivalDivider`/`FaceName`) | **T1** keeps it working across the merge |
| `/supermux-schedule` command | **NOT DONE.** The mechanism exists: `MANAGED_COMMANDS` in `server/src/agents/skills.rs:113` seeds `~/.claude/commands/<name>.md`; `supermux-task.md` is the model | **T7** |
| hook-token-scoped create endpoint | **NOT DONE.** Only `POST /api/hook/schedule/done` exists (`scheduler/hook.rs:40`). All ten `/api/schedules*` routes are bearer-only (`http.rs:152`) | **T6** |
| composer affordance | **NOT DONE** | **T9** |
| per-session schedule detail | **NOT DONE.** `session-info-panel.tsx:500` has a read-only `SchedulesList` that links out to `/scheduler`. No sheet, no create, no Test-run, no failure history | **T8** |
| audit surfacing | feed + four `SURFACED_ACTIONS` done; `GET /api/audit?limit=N` + `settings/audit-log.tsx` predate B4 | **T2/T8** extend the surfaced set and give the schedule chip a destination |

### 0.3 THE MERGE HAZARD — two planes, one wrapper, and only one of them can see it

There are **two independent user-line classifiers** in this codebase, and the fabric spine only taught one of them
about supermux's wrappers:

| plane | classifier | knows `<supermux-delegation>` / `<supermux-schedule>`? |
|---|---|---|
| **recall (A1)** — `GET /recall?chat=true` | `server/src/sessions/recall.rs::classify_user`, `Kind` enum `:136` | **YES** — `Kind::Delegation` `:149`, `Kind::Schedule` `:153`, `is_user_initiated()` allowlist `:186` |
| **chat WS (A2, what main's renderer actually rides since #67)** | `web/src/components/chat/wire-entries.ts::classifyPrompt` `:128`, then a three-kind survives-filter `:311` | **NO** |

`origin/feat/grok-ui-integration` does not contain `web/src/components/chat/wire-entries.ts` at all — the fabric
commits were written against the recall plane, *before* #67 moved the renderer onto the chat WebSocket. On main today,
a delegated prompt reaches `classifyPrompt`, falls to the `default:` arm (`wire-entries.ts:167`) → `kind:'system'`,
label `supermux-delegation` → and is then **dropped** by `if (c.kind !== 'prompt' && c.kind !== 'command' && c.kind
!== 'teammate') continue` (`wire-entries.ts:311`).

**A delegated prompt is invisible in the chat renderer on main.** Same for a scheduled fire. Merging the two branches
without T1 produces a fase that demos green on the old plane and is silently dead on the shipped one. T1 exists for
exactly this and runs before anything else.

Note also (from the A2 map): **no `match` on either `Kind` enum is exhaustive** — every one has a `_` arm. Adding or
missing a kind produces **no compiler error** in Rust or TS. The parity test in T1 is the only thing that can catch it.

### 0.4 Security ground truth (feeds T10, and constrains T4/T6)

- **`POST /api/agents/delegate` is bearer-only and `from` is caller-declared.** It sits in `protected_router`
  (`http.rs:155`), so today an agent delegating calls it with the *dashboard bearer* (`~/.supermux/auth_token`) —
  admin-equivalent. Nothing proves the caller is `from`. `audit_actor` then writes `agent:<from>` from that unproven
  claim, and `b97c408` adds `actor:"human"` → audits as `user`, from the same unproven claim. **The `actor` field is a
  hint from an already-admin caller, not an authentication result** — it is honest labelling for the composer, not a
  privilege boundary, and the plan must say so in the code doc rather than implying otherwise.
- **The hook-token pattern is the real boundary.** `X-Supermux-Hook-Token` → `db::sessions::runtime(pool, session)
  .hook_token` → `constant_time_eq` → 401. Four near-identical copies exist (`board/hook.rs:59`,
  `scheduler/hook.rs:46`, `hooks.rs:59` `verify_hook_token`, `external_edit.rs:252`). Hook routers are merged
  **outside** the bearer layer (`http.rs:49/54/58/63`). The token reaches the agent via the pane env
  (`lifecycle.rs:150`). The scope rule to copy verbatim: *authentication proves which session you are; the object you
  may act on is then constrained to one whose `session` equals the authenticated session* (`scheduler/hook.rs:88-93`,
  `board/hook.rs:83`).
- **Prompt text is an injection surface in three new ways**: (1) `wrap_delegation` interpolates `from` and `prompt`
  into an XML-ish tag with **no escaping** — a prompt containing `</supermux-delegation>` can close the tag early and
  a `from` containing `"` can inject attributes; (2) the wrapper is *deliberately visible to the receiving agent*, so
  its content is untrusted instruction text arriving in another agent's context; (3) a hook-created schedule's
  `title`/`prompt` become a `SystemEntity`'s text and a fired prompt.
- **Audit hygiene:** the prompt body is deliberately NOT logged (`delegate.rs` module doc). Keep it that way.
  `EVENTS_SQL` interpolates only compile-time literals; all user values are bound (`db/audit.rs`).
- **`GET /api/sessions/{name}/events` is bearer-protected** (it is on the sessions router), returns rows where the
  session is the subject through four arms, and clamps `limit`. `667ae2a` already fixed the one cross-session leak
  (`$.from` scoped to `session.delegate`).

### 0.5 Facts the tasks depend on

| thing | where | note |
|---|---|---|
| `SURFACED_ACTIONS` | `db/audit.rs:80` (integration) | `["session.delegate","session.rename","schedule.create","schedule.run"]`. Explicit allowlist so a new destructive action can't narrate itself into a chat by accident — **keep it explicit** |
| `audit_harness(state, actor, action, target, detail, sessions)` | `sessions/mod.rs:553` | writes the ledger row **and** fires the `harness` SSE tick for a named set of sessions, in one step |
| `EntityRow` | `web/src/components/chat/slash.ts:288` | `{id,kind:'file'|'session'|'command',value,label,meta?,warn?}`. `kind` is display-only; the slug lives in `id` (`session:<slug>`) and `meta`. `onPick` is typed `(value: string) => void` (`entity-picker.tsx:47`) — this is the single line standing between the picker and a delegate flow |
| picker accept contract | `use-composer.ts:321` / `:594` | `accept()` returns `boolean`; `false` falls through to submit. A side-effecting accept **must** return `true` or Enter also sends the draft |
| composer submit + the precedent for rerouting | `use-composer.ts:410`, slash gate at `:430` | network-free pre-peek classification that can refuse or reroute; `ComposerNotice` (`:132`) is the receipt mechanism |
| scheduler API + validation | `scheduler/mod.rs:166` router, `CreateScheduleInput` `:200`, `create()` `:252` | all bearer. `kind∈{tmux,shell,boot}`, tmux requires `session`, `parser::parse(&expr, now)` gates the cadence |
| schedule expression grammar | `scheduler/parser.rs:124` | a hand-rolled DSL: `in <N><unit>`, `every <N><unit>`, `every weekday at <t>`, `daily at <t>`, `weekly on <day> at <t>`, `monthly on <N> at <t>`, `every <dayname> at <t>`, bare 5-field cron. **No NL parsing** — and B4 adds none: the agent parses the sentence, the server takes a concrete expression |
| managed commands | `agents/skills.rs:113` `MANAGED_COMMANDS`, `MANAGED_MARKER` `:99`, `supermux-task.md` | seeded to `~/.claude/commands/<name>.md` on boot, idempotent, never clobbers a user command of the same name. Drift-guarded by `web/tests/unit/chat-slash.test.ts:34` which parses `skills.rs` from disk |
| scheduler components | `web/src/components/scheduler/*` | `ScheduleDetailSheet` (already `ResponsiveSheet`), `ScheduleForm`, `ScheduleEditor`, `FireLog`, `EnableToggle`, `helpers.ts`. **B1 does not touch any of them** |
| run history | `schedule_runs` table (`0003`), `GET /api/schedules/{id}/runs`, `FireLog` | no retention policy exists; §13.3 asks for keep-last-20 |
| client tests | `bun test tests/unit`, `renderToStaticMarkup`, **no jsdom** | pure modules must stay import-free. VR = the dev bench routes (`/dev/chat-live`, `/dev/chat-ui`) + `?mock&state=<id>&surface=phone&theme=dark`, fixtures in `routes/dev-chat-live.fixture.ts` (`STATE_IDS:838` is coverage-tested) |
| server tests | `server/tests/chat_ws.rs` harness (`spawn_harness`, `make_session`, `connect_authed`, `get`) | full-sentence test names; `$CLAUDE_CONFIG_DIR` is process-global → serialise env-mutating tests on `ENV_LOCK` |

### 0.6 Coordination with B1 (in flight) — and why B4 is immune to its outcome

B1 (`origin/feat/b1-shell`, plan `2026-08-16-fase-b1-shell.md` T8/T9, tasks already marked done in that plan) deletes
`web/src/routes/scheduler.tsx`, adds `web/src/components/settings/schedules-section.tsx` + `.helpers.ts`, redirects
`/scheduler` → `/settings#schedules`, and retargets onboarding step 3. **It re-homes the scheduler without touching a
single file under `web/src/components/scheduler/`** — `SchedulesSection` imports `ScheduleDetailSheet`, `EnableToggle`
and `formatFull` unchanged.

**The rule for every B4 client task: depend only on `web/src/components/scheduler/*` and on
`web/src/lib/api/scheduler.ts` + `web/src/hooks/use-scheduler.ts`. Never import from `routes/scheduler.tsx`, never
from `components/settings/schedules-section.tsx`, never hard-code `/scheduler` or `/settings#schedules`.** Under that
rule B4 compiles and behaves identically whether B1 lands first, after, or never.

The one place the outcomes differ is the **destination of the `⏱ <title>` schedule chip**. B4 resolves this by not
depending on either route: the chip opens **T8's per-session Schedules sheet**, which exists in both worlds. A "manage
all schedules" link inside that sheet goes through one helper, `scheduleAdminHref()`, that returns
`/settings#schedules` when the `SchedulesSection` anchor is present in the built app and `/scheduler` otherwise —
one function, one unit test with both branches, no other file knows.

### 0.7 Migration numbering

`main`'s highest is `0024_session_runtime.sql`. `0025` is **double-claimed** (`0025_archive_on_stop.sql` on
`feat/schedule-archive-on-stop` *and* `worktree-on-demand-spawn`; `0025_session_notif.sql` on the integration branch).
`0026_audit_target_idx.sql` is claimed by the integration branch and **B4 inherits it — it does not write a new one**.
**B4 adds no migration.** If T6 or T8 turns out to need a column (it should not — schedule provenance rides
`audit_log.detail`), it takes `0028` and Task 0 re-verifies the claim first. Never edit or renumber a merged
migration: `sqlx` checksums, and a `VersionMismatch` bricks deployed installs.

---

## 1. Files

```
server/src/agents/delegate.rs          harden: escape/reject in wrap_delegation, actor doc honesty, size cap
server/src/agents/skills.rs            + SUPERMUX_SCHEDULE_NAME/SKILL in MANAGED_COMMANDS
server/src/agents/supermux-schedule.md NEW — the managed /supermux-schedule command
server/src/scheduler/hook.rs           + POST /api/hook/schedule/create (session-scoped), shared authenticate()
server/src/scheduler/mod.rs            hook_router_for + create() reuse for the hook path
server/src/db/audit.rs                 SURFACED_ACTIONS review; retention helper for schedule_runs
server/src/db/schedules.rs             run-history retention (keep last 20)
server/src/sessions/recall.rs          (verify only — Kind::Delegation/Schedule already there)

web/src/components/chat/wire-entries.ts        T1: classify the two supermux wrappers + let them survive
web/src/components/chat/grouping.ts            T1/T5: delegation + schedule speakers on the WS plane
web/src/components/chat/transcript-item.tsx    T3: chip onClick chain; T5 pill source
web/src/components/chat/live-layer.tsx         T5: pill from real dispatch/ledger, heuristic deleted
web/src/components/chat/chat-panel.tsx         T3/T4/T5: onOpenSession + onOpenSchedule + delegate plumbing
web/src/components/chat/entity-picker.tsx      T4: onPick widens to (row: EntityRow)
web/src/components/chat/slash.ts               T4: delegate intent helpers (pure)
web/src/components/chat/use-composer.ts        T4: delegate branch beside the slash gate
web/src/components/chat/delegate-intent.ts     NEW (pure) — draft → delegate intent, T4
web/src/lib/api/agents.ts                      NEW — POST /api/agents/delegate, GET /api/agents/delegations
web/src/components/session-schedules/          NEW — SessionSchedulesSheet + schedule-href helper (T8)
web/src/components/focus-mode/session-info-panel.tsx  T8: SchedulesList row opens the sheet
web/src/routes/dev-chat-live.fixture.ts        T3/T4/T5/T9 bench states (STATE_IDS coverage test)

server/tests/delegate_fabric.rs        NEW — actor, wrapper escaping, feed scoping, injection corpus
server/tests/schedule_hook_create.rs   NEW — auth-scope matrix for the create hook
server/tests/wrapper_parity.rs         NEW — the T1 contract corpus, Rust half
web/tests/unit/chat-wrapper-parity.test.ts   NEW — the T1 contract corpus, TS half
web/tests/unit/chat-delegate-intent.test.ts  NEW
web/tests/unit/chat-chip-navigation.test.tsx NEW
web/tests/unit/session-schedules.test.tsx    NEW
web/tests/unit/schedule-href.test.ts         NEW
web/tests/e2e/smoke/delegate-handoff.spec.ts NEW — the two-session E2E (T11)
docs/superpowers/plans/b4-security-checklist.md  NEW — T10's filled-in checklist
web/src/brand/BRAND.md                 + entity-chip navigation vocabulary
```

## 2. Global constraints

- **Worktree, never the main checkout.** Other agents build in `/opt/projects/supermux` — no commits, branches or
  stashes there.
- **Never `cargo build/test --release`.** Debug only; in-sandbox needs `OPENSSL_NO_VENDOR=1
  OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu`.
- **Never edit an existing `server/migrations/*` file.** B4 adds none (§0.7).
- **Never restart the instance on :8824** — it hosts the owner's chat. All live testing happens side-by-side on
  another port (T11).
- **The user reviews all merges.** The final step opens a PR and hands off. Never auto-merge, never deploy.
- **Additive wire.** New endpoint, new optional request fields, new client module. Every existing test passes
  unmodified except where a struct literal gains a field.
- **The chat renderer flag stays default-OFF.** B4 changes content, not defaults.
- **No new SSE payload carrying transcript content.** The ledger is the truth; SSE is an invalidation tick (§0.2).
- **`SURFACED_ACTIONS` stays an explicit allowlist.** Never a denylist, never "everything except".

## 3. Owner gates

- **G1 — base branch (blocks Task 0).** B4 sits on nine unmerged, unreviewed commits. The owner decides: (a) B4
  branches off `feat/grok-ui-integration` with `main` merged in and the PR carries the whole fabric spine, or (b) the
  spine is squash-landed on `main` as its own reviewable PR first and B4 branches off the result. **(b) is
  recommended** — it keeps the review unit at one idea per PR and it is the only option under which T1's parity fix is
  reviewable in isolation. Do not start without a written answer.
- **G2 — agent-created schedules (blocks T6/T7).** T6 gives every running agent the ability to create a recurring job
  on the host with no human in the loop. That is a real capability increase. The owner signs off on: it exists at all,
  the per-session cap (proposed: 20 live schedules per session), and whether `done_action: "command:…"` is
  permitted on the hook path (proposed: **no** — hook-created schedules may only `disable` or `notify`).

---

## 4. Tasks

Thirteen entries: **T0** is setup, **T1–T11** are the work, **T12** is the hand-off. TDD wherever there is anything
to assert: the failing parity/scope test first, then the code that satisfies it. Every task ends green on `cargo test` (debug) and/or `bun run test:unit` **and** `bun run lint`.
**T1 lands before everything else — the plane that ships must be able to see the fase before the fase grows.**

### T0 — Base, worktree, and the two gates

**Files:** none (setup only)

- [x] **T0.1** Clear **G1** in writing. Record the answer at the top of the PR body.
- [x] **T0.2** Create the worktree per G1's answer:
  ```bash
  cd /opt/projects/supermux && git fetch origin
  git worktree add /opt/projects/supermux-b4 -b feat/b4-fabric <base>   # <base> per G1
  cd /opt/projects/supermux-b4 && git merge origin/main                 # if base is the integration branch
  git log --oneline -1
  ```
- [x] **T0.3** Prove the inherited spine is present and green *before adding anything*:
  ```bash
  git log --oneline | grep -E '81f6eb3|01911fb|2cf712a|b97c408' # or their squashed equivalent
  OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server
  cd web && bun run test:unit && bun run lint
  ```
  Anything red here is **pre-existing** and must be reported before T1, not silently fixed inside a B4 task.
- [x] **T0.4** Re-verify the migration claim: `0026_audit_target_idx.sql` inherited, no new migration
  (§0.7). Record the highest number seen across all branches at execution time.
- [x] **T0.5** Clear **G2** in writing (blocks T6/T7 only — T1–T5 may proceed).

**Verification:** the worktree exists on `feat/b4-fabric`, both suites green, G1 answered in the PR body draft.

---

### T1 — Classification parity: one wrapper, two planes, one contract (THE merge fix)

The riskiest task in the fase (§0.3). A delegated or scheduled prompt is currently **invisible** in the chat-WS
renderer that main actually ships. Nothing in either language will error when the two planes disagree — a shared
corpus is the only guard.

**Files:** `web/src/components/chat/wire-entries.ts`, `web/src/components/chat/grouping.ts`,
`server/tests/wrapper_parity.rs` (new), `web/tests/unit/chat-wrapper-parity.test.ts` (new),
`server/tests/fixtures/chat/supermux-wrappers.jsonl` (new)

- [x] *(inherited #71)* **T1.1 (test first, must fail)** Write the **contract corpus** once and consume it from both languages: a small
      JSONL fixture of real user-role lines — a plain prompt, a `<supermux-delegation from="deploy-fix">`, a
      `<supermux-schedule id="SCHED-1a2b3c4d" title="Nightly release watch">`, a `<teammate-message>`, a
      `<command-name>`, a `<task-notification>`, an unknown `<some-future-wrapper>`, a human who *pastes* the literal
      text `<supermux-delegation …>` into the composer, and a wrapper whose inner body itself contains
      `</supermux-delegation>`. For each line the fixture records the expected `(kind, label, text)`.
- [x] *(inherited #71)* **T1.2** `server/tests/wrapper_parity.rs`: assert `recall::classify_user` produces the corpus' expected triple
      for every line, and that `Kind::Delegation`/`Kind::Schedule` pass `is_user_initiated()`.
- [x] *(inherited #71)* **T1.3** `web/tests/unit/chat-wrapper-parity.test.ts`: assert `classifyPrompt` produces the **same** triple for
      every line, and that the survives-filter keeps `delegation` and `schedule`. Both tests read the *same* fixture
      file, so the two planes cannot drift.
- [x] *(inherited #71)* **T1.4** Make them pass. In `wire-entries.ts`: extend `ClassifiedPrompt['kind']` with `'delegation'` and
      `'schedule'`; add the two `case` arms to `classifyPrompt` (`:146`) mirroring `recall.rs:1208-1244` exactly —
      delegation's `label` is the sender **slug** from the `from` attribute, schedule's `label` is the schedule
      **title**, `text` is the tag's inner body in both; widen the survives-filter (`:311`) to the five kinds. Keep
      the `default:` arm's degrade-to-system behaviour untouched — that is what protects against a brand-new Claude
      wrapper leaking as a fake prompt.
- [x] *(inherited #71)* **T1.5** `grouping.ts` on the WS plane: `speakerOf` maps `badge === 'delegation'` → `teammate:<label>` and
      `badge === 'schedule'` → `schedule:<label>`, matching what `58fa3da`/`f10f527` did on the recall plane, so the
      arrival divider and the schedule speaker render from the WS feed too. Extend
      `web/tests/unit/chat-grouping.test.ts` with the multi-message-handover case: five consecutive messages from one
      colleague announce themselves **once**.
- [x] *(inherited #71)* **T1.6** The **paste-safety** assertion, called out separately because it is the failure mode the recall plane's
      `promptSource: "typed"` flag exists to prevent and the WS plane **cannot see that flag**
      (`wire-entries.ts:117-127` says so): a human who types `<supermux-delegation from="ceo">do X</supermux-delegation>`
      into the composer must not be rendered as an arrival from `ceo`. Since the flag is unavailable, T1's mitigation
      is **server-side and structural** — see T2.2, which makes the wrapper unforgeable by construction. T1.6 is the
      test that proves the mitigation works end-to-end from this corpus line.

**Verification:** both suites green; `bun run test:unit` shows the parity file asserting ≥9 corpus lines on each side;
manually confirm on the bench that a delegation fixture entry renders under an `ArrivalDivider` in `/dev/chat-live`.

---

### T2 — Fabric-spine hardening: the delegate wrapper, the actor, and the feed

The spine works; it has never been attacked. This task is the adversarial pass over inherited code.

**Files:** `server/src/agents/delegate.rs`, `server/tests/delegate_fabric.rs` (new)

- [x] *(inherited #71)* **T2.1 (test first)** `wrap_delegation` interpolates `from` and `prompt` into a tag with **no escaping**
      (`delegate.rs`). Write the failing tests: a prompt containing `</supermux-delegation>`; a prompt containing a
      whole second `<supermux-delegation from="root">` block; a `from` containing `"` or `>`; a prompt containing a
      `<supermux-schedule …>` opener.
- [x] *(inherited #71)* **T2.2** Fix by **construction, not escaping**: `from` is already a validated session slug — assert it against
      the session-name rule and reject (500-with-log, never silently mangle) if it ever isn't; and make the wrapper
      **unforgeable** by having the classifier accept the tag only in the *leading* position of the line with a
      well-formed single `from` attribute (which `leading_tag` already gives us) **and** by neutralising any nested
      closer in the body — the chosen mechanism, documented at the call site, is to reject the delegation with a 400
      (`"prompt may not contain supermux wrapper markup"`) rather than to silently rewrite an agent's words. Mirror
      the same rule for `<supermux-schedule>` in `scheduler/runner.rs`. This is what makes T1.6 hold.
- [x] **T2.3** `actor` honesty. Add to `delegate.rs`'s module doc the sentence §0.4 establishes: *the `actor` field is
      a label chosen by an already-bearer-authenticated caller; it distinguishes the composer path from the curl path
      for the reader of the ledger, and it is not an authentication result.* Add the test:
      `actor:"user"`/`actor:"agent"`/`actor:"HUMAN"`/`actor:null` all fall to `agent:<from>` — only the exact string
      `"human"` maps to `user`, so a typo can never quietly impersonate the owner.
- [x] **T2.4** Cap the prompt: reject a delegate `prompt` over a documented ceiling (proposed 64 KiB) with a 400
      rather than pushing an unbounded string through `send_text` and into another agent's context.
- [x] **T2.5** Feed-scoping tests for `events_for_session` (`667ae2a` fixed the bug and tested the rename arm; the
      other three arms are untested): a delegation appears in **both** ends' feeds and in no third session's; a
      schedule fire appears only in the feed of the session in `detail.session`; `actor = 'agent:<name>'` matches
      exactly, not by prefix (`agent:deploy` must not match `agent:deploy-fix`); `since_id` is exclusive; `limit`
      clamps.
- [x] **T2.6** Audit completeness: assert every path that mutates cross-session state writes a ledger row —
      `delegate` (both actor branches), schedule create (bearer **and**, after T6, hook), `schedule.run` including the
      failure branch. Assert the prompt body is absent from `detail` in all of them.

**Verification:** `cargo test -p supermux-server delegate_fabric` green; the injection corpus from T2.1 is the same
file T1 uses, so a fix on one side cannot regress the other.

---

### T3 — Entity chips become navigation

The chip mechanic is shipped and pixel-exact; `onClick` is unwired everywhere. This task gives every chip a
destination, and gives the surfaces that have no destination yet an honest non-affordance.

**Files:** `web/src/components/chat/transcript-item.tsx`, `chat-panel.tsx`, `conversation.tsx`,
`markdown/chat-components.tsx`, `web/tests/unit/chat-chip-navigation.test.tsx` (new), `web/src/brand/BRAND.md`

- [x] **T3.1 (test first)** Assert: a `HarnessLine` for `session.delegate` renders its `MentionChip` as a `<button>`
      when `onOpenSession` is supplied and as a non-interactive element when it is not; a `MentionChip` in **prose**
      (`ProseText` and the markdown path) is a button when the mentioned slug is in the known-sessions index; a
      `schedule.create`/`schedule.run` `SystemEntity` is a button once `onOpenSchedule` is supplied (T8) and plain
      emphasis before that.
- [x] **T3.2** Plumb one navigation contract down from `chat-panel.tsx`: `onOpenSession(slug)` and
      `onOpenSchedule(idOrTitle)`. `onOpenSession` uses the existing morph navigation to the focus route for that
      session (never a raw `window.location`); it must no-op for the session you are already in.
- [x] **T3.3** Wire `MentionChip.onClick` at both prose call sites (`transcript-item.tsx` `ProseText` and
      `markdown/chat-components.tsx`). A mention only becomes a button when it resolves in `mentionIndex` — the
      existing "no regex over arbitrary words" rule (`grouping.ts` `mentionSegments`) still decides *what* is a
      mention; T3 only decides what happens on click.
- [x] **T3.4** Keep the zero-layout-cost invariant: add a unit assertion that the interactive and non-interactive
      variants render the same negative-margin/padding pair, so a sentence does not shift when a chip becomes
      clickable.
- [x] **T3.5** Document the vocabulary in `BRAND.md`: which entities are chips (session, schedule, board issue, host,
      PR, subagent), which are navigable today, and the rule that a chip with no destination degrades to emphasis
      rather than offering a dead affordance.
- [x] **T3.6** Bench: add `/dev/chat-live` states covering the four `HarnessLine` sentences, both themes, desktop +
      phone; extend `STATE_IDS` (its coverage test will fail otherwise).

**Verification:** `bun run test:unit` green; VR pass over the new bench states in both themes; click-through by hand
in the side-by-side instance from T11.

---

### T4 — `@session` in the composer actually hands work over

**Files:** `web/src/lib/api/agents.ts` (new), `web/src/components/chat/delegate-intent.ts` (new, pure),
`entity-picker.tsx`, `use-composer.ts`, `composer.tsx`, `chat-panel.tsx`,
`web/tests/unit/chat-delegate-intent.test.ts` (new)

- [x] **T4.1 (test first)** `delegate-intent.ts` is a pure, import-free module (the `bun test` constraint):
      `readDelegateIntent(draft, mentions, self) → { to, prompt } | null`. The rule, deliberately narrow: the draft
      **starts** with a single `@<known-session>` token, that session is not self, and there is non-empty text after
      it. A mention in the middle of a sentence stays a mention. Test the negatives as hard as the positives —
      `@unknown`, `@self`, `@session` with no body, two leading mentions, `@session` inside a code fence.
- [x] **T4.2** `web/src/lib/api/agents.ts`: `delegate({from, to, prompt})` → `POST /api/agents/delegate` with
      **`actor: 'human'`**, and `delegations(session)` → `GET /api/agents/delegations`. Uses the existing
      `apiUrl`/`apiToken` client, envelope-unwrapping like its siblings.
- [x] **T4.3** Widen the picker contract: `onPick: (row: EntityRow) => void` (`entity-picker.tsx:46`), collapsing to
      `.value` in the connected component's caller instead. This is a two-line change with a wide blast radius —
      update `composer.tsx:112`, `use-composer.ts:549`, the dev bench and the tests in one commit.
- [x] **T4.4** The flow, chosen so nothing is ever sent by surprise (the deferral comment at `slash.ts:335` is a
      design constraint, not an obstacle): picking a session row **still inserts `@name`** — it never dispatches. The
      dispatch happens at **submit**, in a branch beside the slash gate (`use-composer.ts:430`), when
      `readDelegateIntent` matches. The send button and the Enter affordance relabel to **"Hand to ●name"** while the
      intent holds, so the change of meaning is visible *before* the key is pressed.
- [x] **T4.5** On submit with an intent: `POST /api/agents/delegate` instead of `POST .../send`; on success, clear the
      draft with the existing subtractive `draftAfterSend` and raise a `ComposerNotice` receipt naming the recipient;
      on failure, **restore the draft** and raise the error notice — a handoff that 500s must never eat the text.
      Assert both branches.
- [x] **T4.6** Preserve the accept contract: a picker accept still returns `true` so Enter does not both accept and
      submit (`use-composer.ts:594`).
- [x] **T4.7** Bench states: composer with a live delegate intent (button relabelled), success receipt, failure
      receipt. Extend `STATE_IDS`.

**Verification:** unit green; on the T11 instance, typing `@other-session please rebase` and pressing Enter delivers
to the other session and leaves a `Delegated to ●other-session` line in the sender's transcript.

---

### T5 — The handoff pill stops guessing

**Files:** `web/src/components/chat/live-layer.tsx`, `chat-panel.tsx`, `web/tests/unit/chat-interactive.test.tsx`

- [x] **T5.1 (test first)** Today `delegationTarget(activity, mentions, self)` (`live-layer.tsx:503`) greps the
      session's *activity string* for a known session name — an agent that merely writes "I'll ask deploy-fix about
      this" draws a handoff pill for a delegation that never happened. Write the failing test: activity text naming a
      session with **no** delegation in flight must draw **no** pill; a real in-flight delegation with activity text
      naming nobody **must**.
- [x] **T5.2** Drive the pill from two real sources instead: (a) the optimistic in-flight state of T4's own POST
      (from dispatch until it resolves) and (b) the ledger — a `session.delegate` row in this session's harness feed
      whose `detail.from` is this session, within the live turn's window. Delete `delegationTarget` and its heuristic
      entirely; the surface it fed (`live-layer.tsx:150`) takes the new prop.
- [x] **T5.3** The pill's resolution is a **crossfade into the durable `HarnessLine`**, not a second element: the
      in-flight pill disappears exactly when the ledger line appears, and the same delegation is never drawn twice.
      Assert it (the "one live row" discipline from the daily-driver QA fix at `live-layer.tsx:~155` is the
      precedent).
- [x] **T5.4** The agent-initiated case: a delegation *this* session performed via curl (no optimistic state) still
      draws its ledger line — it simply never shows an in-flight pill, because the app learns about it after the
      fact. Say so in the module doc rather than inventing a pill from a debounced feed.

**Verification:** unit green; the two-session E2E in T11 shows the pill during the send and one — exactly one —
`Delegated to ●x` line after it.

---

### T6 — `POST /api/hook/schedule/create`, scoped to the calling session (**needs G2**)

**Files:** `server/src/scheduler/hook.rs`, `server/src/scheduler/mod.rs`,
`server/tests/schedule_hook_create.rs` (new)

- [x] **T6.1 (test first)** The auth-scope matrix, written before the handler exists. Session A's token creating a
      schedule for A → 201. **Session A's token creating a schedule for B → 401** (not 404 — the session exists, the
      caller simply isn't it). No token → 401. A **dashboard bearer** → 401 (the hook router is outside the bearer
      layer and must not accept one; this is the property `board/hook.rs:10` documents). Empty stored token → 401. A
      token that is a prefix of the real one → 401 (constant-time compare, length-sensitive).
- [x] **T6.2** The handler, mirroring `done_handler` line for line: `authenticate(&state, &headers, &body.session)`
      → then **ignore any `session` in the payload for the row itself and use the authenticated one**, so scope is
      structural rather than a check that a later refactor can drop.
- [x] **T6.3** Constrain the payload to what an agent may safely ask for, and reject the rest with 400:
      `kind` forced to `tmux`; `session` forced (T6.2); `title` + `prompt` required; `schedule_expr` required and
      parsed by the existing `parser::parse` (**no NL parsing on the server** — the agent brings a concrete
      expression, §0.5); `done_action` restricted to `disable` | `notify` per G2 — **`command:…` is rejected on this
      path**, because it would turn a session token into arbitrary host command execution; `boot_*` and
      `bypass_permissions` rejected outright.
- [x] **T6.4** Rate/quantity guard: reject when the session already owns ≥ the G2 cap of live schedules, with a 429
      and a message the agent can act on. Test it at the boundary.
- [x] **T6.5** Reuse `scheduler::create`'s validation body rather than duplicating it — one validator, two callers.
- [x] **T6.6** Write the ledger row + `harness` tick via `audit_harness(actor = "agent:<session>", action =
      "schedule.create", target = <schedule id>, detail = {session, title}, sessions = [session])`, which is exactly
      what `SURFACED_ACTIONS` and `HarnessLine`'s "Created schedule ⏱ <title>" sentence already consume — the
      transcript line falls out for free, and T2.6's completeness test covers it.
- [x] **T6.7** Register on the **existing** `scheduler::hook_router_for` (merged at `http.rs:63`, outside the bearer
      layer). Add a router-shape test asserting the route is reachable without a bearer and that no
      `/api/schedules*` route is.

**Verification:** `cargo test -p supermux-server schedule_hook_create` green with the full matrix; a manual curl from
a real session on the T11 instance creates a schedule and produces the transcript line.

---

### T7 — The `/supermux-schedule` managed command (**needs G2**)

**Files:** `server/src/agents/supermux-schedule.md` (new), `server/src/agents/skills.rs`,
`web/tests/unit/chat-slash.test.ts`

- [x] **T7.1** Write `supermux-schedule.md` on the `supermux-task.md` model: the `supermux-managed: true` frontmatter
      marker, `$SUPERMUX_HOOK_TOKEN` / `$SUPERMUX_SESSION` / `$SUPERMUX_URL` from the pane env, and a scoped `curl`
      per verb. **The command teaches the agent to do the natural-language parsing itself** and to POST a concrete
      `schedule_expr` — the file lists the exact accepted grammar from `scheduler/parser.rs:124` (`in 20m`,
      `every 2h`, `every weekday at 08:00`, `daily at 9am`, `weekly on friday at 17:00`, `monthly on 1 at 09:00`, a
      bare 5-field cron) with a worked example: *"run this every weekday at 8"* → `"every weekday at 08:00"`.
- [x] **T7.2** State the boundaries in the file, in the agent's own terms: it can only schedule **for its own
      session**; `done_action` may only be `disable` or `notify`; there is a cap; a rejected request is a 400/401/429
      with a readable message and it should surface that to the user rather than retrying.
- [x] **T7.3** Add `(SUPERMUX_SCHEDULE_NAME, SUPERMUX_SCHEDULE_SKILL)` to `MANAGED_COMMANDS` (`skills.rs:113`) with
      `include_str!`. Extend the existing seeding tests (`skills.rs:473`, `:512`) to cover the second command:
      idempotent re-seed, never clobbers a same-named user command, contains the three env references and the
      hook-token header.
- [x] **T7.4** The name is `supermux-schedule`, **not** `schedule`: `/schedule` is already a Claude Code built-in
      (`BUILTIN_SLASH_COMMANDS`, `skills.rs`) and `TUI_BUILTINS` in `slash.ts:167` mirrors it. Add a test asserting no
      managed command collides with a built-in.
- [x] **T7.5** The composer's `/` classifier: `supermux-schedule` arrives via `GET /api/slash-commands` and classifies
      `unknown` → passed through as text with the `slash-note` receipt, which is correct behaviour (it *is* a
      Claude-side command). Assert that, so nobody later "fixes" it into `PICKER_OPENING`. The `chat-slash.test.ts`
      drift guard that parses `skills.rs` from disk must stay green.

**Verification:** `cargo test` green; on the T11 instance, `/supermux-schedule every weekday at 8 — check the deploy`
inside a real session creates a schedule and writes `Created schedule ⏱ …` into that session's transcript.

---

### T8 — Per-session Schedules sheet, run history, and the chip's destination

**Files:** `web/src/components/session-schedules/session-schedules-sheet.tsx` (new),
`schedule-href.ts` (new, pure), `web/src/components/focus-mode/session-info-panel.tsx`,
`server/src/db/schedules.rs`, `web/tests/unit/session-schedules.test.tsx` + `schedule-href.test.ts` (new)

- [x] **T8.1** `SessionSchedulesSheet({ session, scheduleId?, onClose })` — a `ResponsiveSheet` listing the schedules
      whose `session` is this one (from `useSchedules()`, the existing hook), each row: title, human cadence
      (`helpers.ts::describeSchedule`), next fire, last fire, `EnableToggle`. Row tap → the **existing, unmodified**
      `ScheduleDetailSheet`; header `+` → the same sheet in `mode="create"` prefilled with this session. **Import
      only from `components/scheduler/*`** (§0.6).
- [x] **T8.2** Surface Test-run and failure history in the detail: `POST /api/schedules/{id}/run` and `FireLog` over
      `GET /api/schedules/{id}/runs` — the plumbing exists (`0020`), only the placement is new.
- [x] **T8.3** Run-history retention (§13.3): keep the last **20** `schedule_runs` rows per schedule, pruned on
      insert in `db/schedules.rs`. Test: 25 inserts leave 20, newest kept, `ON DELETE CASCADE` unaffected. No
      migration — this is a delete, not a schema change.
- [x] **T8.4** `schedule-href.ts`: the single `scheduleAdminHref()` helper from §0.6 with both branches unit-tested.
      Nothing else in the tree may hard-code a scheduler route.
- [x] **T8.5** Give T3's `onOpenSchedule` its destination: the `⏱ <title>` chip opens this sheet, scrolled to that
      schedule when the id resolves and to the list when only a title is known (old ledger rows predate the id in
      `detail`). Flip the chip from emphasis to button in T3's test.
- [x] **T8.6** Re-home `session-info-panel.tsx:500`'s read-only `SchedulesList`: its rows open this sheet instead of
      linking to `/scheduler`, removing the two hard-coded routes B1 would otherwise leave pointing at a redirect.

**Verification:** unit green; VR over the sheet on desktop + iPhone, both themes; works identically with B1's branch
merged and without it (check both in the worktree).

---

### T9 — The human path: a schedule from the composer

**Files:** `web/src/components/chat/composer.tsx`, `chat-panel.tsx`, `web/src/routes/dev-chat-live.fixture.ts`

- [x] **T9.1** A composer affordance (the dock's existing action grammar, not a new chrome slot) that opens T8's sheet
      in `mode="create"` **prefilled**: session = this session, prompt = the current draft when there is one. §13.3
      calls this "the trivial human path" and it should stay trivial — no new form, no new endpoint.
- [x] **T9.2** Opening it must not destroy the draft: the draft is copied, not moved, and cancelling the sheet leaves
      the composer exactly as it was. Assert it.
- [x] **T9.3** Mobile: the affordance lives in the dock (which keeps all non-terminal actions per §5.2), not behind a
      hover.
- [x] **T9.4** Bench state + `STATE_IDS`.

**Verification:** unit green; VR on both surfaces.

---

### T10 — Security review, written down and executable

B4 adds a write endpoint outside the bearer layer, gives agents a new capability, and puts untrusted prompt text into
another agent's context. This task is not a checklist for its own sake; each row ends in a test or a documented
decision.

**Files:** `docs/superpowers/plans/b4-security-checklist.md` (new), plus test additions where a row is red

- [x] **T10.1 Token-scoping matrix.** Fill in, per endpoint: what authenticates it, what it is scoped to, and the test
      that proves the negative. Rows: `POST /api/agents/delegate` (bearer; `from` unproven — documented, §0.4/T2.3),
      `GET /api/agents/delegations` (bearer), `GET /api/sessions/{name}/events` (bearer; four-arm subject scoping,
      T2.5), `POST /api/hook/schedule/create` (hook token; forced session, T6.1), `POST /api/hook/schedule/done`
      (existing), `GET /api/audit` (bearer). Any row without a negative test gets one here.
- [x] **T10.2 Cross-session privilege.** Assert explicitly that a session's hook token cannot: create a schedule for
      another session, run/patch/delete any schedule, delegate at all (the delegate endpoint is bearer-only and must
      stay that way in this fase — an agent delegating still needs the dashboard bearer; record that as a **known
      limitation**, not a silent gap, with the follow-up shape written down).
- [x] **T10.3 Injection.** The T1/T2 corpus is the artefact: wrapper break-out, nested wrappers, attribute injection
      via `from`, a schedule `title` containing markup or a `·` that could fake a system line, a hook-created
      schedule `prompt` containing a wrapper opener. Confirm every one is rejected or rendered inert, and that
      rendering is text — never `dangerouslySetInnerHTML` — on every new surface.
- [x] **T10.4 Audit completeness + hygiene.** T2.6's test is the evidence. Additionally confirm no prompt body,
      hook token, or bearer reaches `audit_log.detail`, the SSE `harness` payload, or a log line — including in the
      new 400/401/429 error messages T6 adds.
- [x] **T10.5 Denial of service.** Prompt cap (T2.4), schedule cap (T6.4), events `limit` clamp, the feed's 1200 ms
      debounce (`use-harness-events.ts`), and the retention prune (T8.3) — one line each with the number and the test.
- [x] **T10.6** Run `/security-review` over the finished branch diff and record its findings (fixed / accepted with
      reason) in the same file.

**Verification:** the checklist file has no empty cells; every "proves the negative" cell names a test that exists and
is green.

---

### T11 — E2E: two real agents, one handoff, on a side-by-side instance

The only test that proves the fase. Everything above is unit- or fixture-level; this one runs two real Claude sessions
against a real server.

**Files:** `web/tests/e2e/smoke/delegate-handoff.spec.ts` (new)

- [x] **T11.1** Stand up the side-by-side instance **on another port** using the existing smoke harness
      (`web/tests/e2e/smoke/harness.ts`). **Never restart :8824** — it hosts the owner's chat.
- [x] **T11.2** Create two real sessions (`b4-sender`, `b4-receiver`), both `provider=claude`, both chat-eligible
      (`ws.rs:97` — claude, no `host_id`, not a real team).
- [x] **T11.3** The **human** path: in `b4-sender`'s chat, type `@b4-receiver <a small, harmless instruction>` and
      submit. Assert, in order: the send button read "Hand to ●b4-receiver" before the key; the in-flight pill
      appeared; `b4-receiver`'s transcript shows the prompt under an **arrival divider** naming `b4-sender` in
      `b4-sender`'s pigment; `b4-sender`'s transcript grows exactly **one** `Delegated to ●b4-receiver` line; the
      pill is gone; clicking the chip navigates to `b4-receiver`.
- [x] **T11.4** The **agent** path: from inside `b4-sender`'s pty, the delegate curl with `actor` absent. Assert the
      ledger row audits as `agent:b4-sender` and the same two transcript lines appear — with **no** in-flight pill
      (T5.4).
- [x] **T11.5** **Durability**: reload both browsers. Both lines survive (they come from the ledger, not a frame).
      This is the single assertion that justifies the whole §0.2 design deviation.
- [x] **T11.6** The schedule half: from `b4-receiver`'s pty, `/supermux-schedule` an `in 2m` one-shot; assert the
      `Created schedule ⏱ …` line, then wait for the fire and assert the prompt arrives under the **schedule
      speaker** (not the owner's bubble) and a `Ran schedule ⏱ …` line follows.
- [x] **T11.7** Tear the two sessions down; leave no schedules armed.

**Verification:** the spec passes against a real backend; capture screenshots of the sender and receiver transcripts
for the PR body.

---

### T12 — PR, hand-off, and the record

- [x] **T12.1** `bun run lint`, `bun run test:unit`, `bun run build:perf` (the chat chunk must not regress — the new
      API module and pure helpers are tiny, but assert it), `cargo test` (debug), `cargo clippy`.
- [x] **T12.2** PR body: G1's answer, the nine inherited commits named as inherited (so the reviewer knows what is new
      in this PR and what is being re-proposed), the §0.2 design deviation stated plainly (ledger, not SSE payload),
      the §0.3 hazard and its fix, T10's checklist link, T11's screenshots, and the known limitation from T10.2.
- [x] **T12.3** Open the PR and **hand off**. Never auto-merge, never deploy, never restart :8824.

---

## 5. Risks

| risk | mitigation |
|---|---|
| **The two-plane classification gap ships silently** — no exhaustive match in either language errors, the old plane demos green, the shipped plane renders nothing | **T1 first**, one shared fixture corpus consumed by a Rust test and a TS test, plus the survives-filter assertion. This is the fase's single largest risk (§0.3) |
| Re-implementing the fabric spine because §0 wasn't read | §0.1/§0.2 name every commit and every file; T0.3 makes "prove it is already there and green" a checkbox before any code |
| The nine inherited commits are unreviewed and land inside a big B4 PR | G1 recommends squash-landing the spine as its own PR first; T12.2 names them as inherited either way |
| `actor` is mistaken for authentication | T2.3 documents it at the source and tests that only the exact `"human"` maps to `user`; T10.1 records it as an unproven claim from an already-admin caller |
| Wrapper break-out — a prompt forging an arrival from another session | T2.2 rejects wrapper markup in delegate prompts by construction (400, never a silent rewrite); T1.6 proves it end-to-end from the paste-a-wrapper corpus line |
| A session token becoming host command execution via `done_action: "command:…"` | T6.3 rejects it on the hook path; G2 makes it an explicit owner decision, not a default |
| Agents scheduling unbounded work | T6.4's per-session cap + G2 sign-off + T8.3 retention |
| The handoff pill keeps false-positiving (the #41/#43 class) | T5 deletes the activity heuristic outright rather than tuning it; the pill is driven only by a dispatch this app made or a ledger row it can point at |
| Picker `onPick` widening breaks the composer's keyboard contract | T4.3 changes all four call sites in one commit; T4.6 asserts accept still returns `true` so Enter can't both accept and send |
| A delegate that 500s eats the user's text | T4.5 restores the draft on failure and tests that branch |
| B1's scheduler fold collides with T8/T9 | §0.6's rule — depend only on `components/scheduler/*`; the chip's destination is B4's own sheet, and the one admin link goes through `scheduleAdminHref()` with both branches tested |
| Ledger feed cost at high delegation volume | the feed is cursor-paged and clamped, the SSE tick is a 1200 ms-debounced invalidation, and `0026_audit_target_idx` indexes the `target` arm; T2.5 covers the other arms' correctness, T10.5 records the numbers |
| E2E flake on two real Claude sessions | T11 asserts transcript **content** (ledger-derived, durable) rather than timing; T11.5's reload assertion is the same evidence a second time |

## 6. Out of scope

Board-issue chips (their destination is B2's issue surface), host/PR/subagent chips (no destination yet), the ⌘K
palette's transcript deep-links (B3), cross-device seen-cursors (§13.4, B5), duplicate/delete-honesty/notifications
(B5), any change to the chat renderer's default (A7), and any NL-parsing of schedule text on the server — the agent
parses, the server validates.
