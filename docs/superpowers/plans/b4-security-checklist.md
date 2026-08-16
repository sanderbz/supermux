# B4 security checklist — filled in

**Fase** B4 (transcript-as-log: delegation, entity chips, conversational schedules)
**Branch** `feat/b4-fabric` · **base** `origin/main` = `c1e7053` (the fabric spine, PR #71)
**Filled in** 2026-08-16, during execution, against real git objects and a running instance.

B4 adds a **write endpoint outside the bearer layer**, gives every running agent a **new
capability** (arming a recurring job on the host), and puts **untrusted prompt text into another
agent's context**. This file is not a checklist for its own sake: every row ends in a test that
exists and is green, or in a decision written down with its reason.

Every "proves the negative" cell names a test by file and name. Every one of them was run.

---

## T10.1 — Token-scoping matrix

| endpoint | authenticated by | scoped to | proves the negative |
|---|---|---|---|
| `POST /api/agents/delegate` | **dashboard bearer** (`protected_router`, `http.rs`) | *nothing* — `from` is caller-declared (see the finding below) | `delegate_fabric.rs::the_delegate_route_is_bearer_only_and_a_hook_token_buys_nothing_there` — no credential → 401, the session's OWN hook token → 401, and the ledger stays empty in both |
| `GET /api/agents/delegations` | dashboard bearer | `?session=` is a filter, not a boundary — any bearer caller may read any session's edges | same router-level test; **accepted**: the bearer is admin-equivalent, so there is nothing here it could not read elsewhere |
| `GET /api/sessions/{name}/events` | dashboard bearer | four subject arms (`target` on a session-targeting action · `detail.from` on `session.delegate` · `detail.session` · `actor = 'agent:'‖name`) | `delegate_fabric.rs`: `a_delegation_reaches_both_ends_feeds_and_no_third_sessions`, `a_schedule_fire_is_visible_only_to_the_session_named_in_its_detail`, `the_agent_actor_arm_matches_exactly_and_never_by_prefix`, `since_id_is_exclusive_and_limit_clamps_the_page`, `an_unsurfaced_action_never_narrates_itself_into_a_transcript` |
| `POST /api/hook/schedule/create` | **per-session hook token** (`X-Supermux-Hook-Token`, `constant_time_eq`) — merged OUTSIDE the bearer layer | the row's `session` **is** the authenticated one; the payload's `session` authenticates and is then discarded | `schedule_hook_create.rs` — 14 tests, the whole matrix (below) |
| `POST /api/hook/schedule/done` | per-session hook token | a schedule whose `session` equals the caller (`scheduler/hook.rs:88-93`) | pre-existing (`hook_auth_scope.rs`); unchanged by B4 |
| `GET /api/audit?limit=N` | dashboard bearer | none — the whole ledger, newest first | **accepted**: operator forensics for an admin-equivalent caller. What matters is that nothing sensitive is IN it — see T10.4 |
| SSE `harness` frame | dashboard bearer (the shared `/api/events` stream) | **NOT scoped** — see the finding below | `sse-events.test.ts` covers the channel's *registration*, not its scoping; the scoping is the accepted finding |

### Finding 1 (documented, not fixed) — `from` and `actor` on `/api/agents/delegate` are unproven claims

The route sits in the bearer layer, so every caller has already presented the dashboard token,
which is **admin-equivalent**. Nothing proves the caller is `from`, and `actor` is likewise a label
chosen by that already-authenticated caller.

**Decision: accepted, and written at the source.** `delegate.rs`'s module doc now says it in those
words — *"`actor` is not an authentication result… it distinguishes the composer path from the curl
path for the reader of the ledger, and it is not a privilege boundary"*. It is honest labelling, and
the one thing that must hold is that a near-miss cannot quietly become "the owner did this":
`only_the_exact_string_human_can_name_the_owner` asserts that `"HUMAN"`, `"Human"`, `" human"`,
`"user"`, `"agent"`, `"owner"`, `""` and `None` all audit as `agent:<from>`.

### Finding 2 (documented, not fixed) — the `harness` SSE frame is broadcast globally

`sessions::emit_harness` sends on the **global** SSE channel. The `sessions: [slug…]` array in the
payload is a **client-side filtering hint, not an authorization boundary**
(`use-harness-events.ts::affects`). Any authenticated SSE subscriber therefore learns *that* a
delegation happened and *between which slugs*, regardless of which session they are looking at.

**Decision: accepted for this fase.** Every SSE subscriber already holds the dashboard bearer, which
can read the same facts from `GET /api/sessions/{name}/events` for any session it likes. The frame
carries **no prompt body** (it ships the `audit_log` row, whose `detail` is metadata only — T10.4).
The follow-up shape, if per-session SSE scoping is ever wanted: a per-session stream keyed by the
hook token, which is the only credential in this codebase that identifies a session rather than an
operator. Recorded here rather than left implicit.

---

## T10.2 — Cross-session privilege

Asserted explicitly. A session's hook token **cannot**:

| attempt | result | test |
|---|---|---|
| create a schedule for another session | **401** (not 404 — the session exists, the caller isn't it) | `a_session_may_not_schedule_for_another_session` |
| create a schedule with no token at all | 401 | `no_token_no_schedule` |
| create a schedule with a one-byte-short / one-byte-long / empty token | 401 (constant-time **and** length-sensitive) | `a_prefix_of_the_real_token_is_not_the_real_token` |
| authenticate as a session whose stored token is empty | 401 (no "unconfigured means unrequired") | `a_session_with_no_stored_token_can_never_be_authenticated_as` |
| list / create / preview / read / patch / delete / run / read-runs any schedule | **401 on all eight `/api/schedules*` routes** | `the_hook_route_is_outside_the_bearer_layer_and_the_admin_routes_are_not` |
| delegate at all | 401 | `the_delegate_route_is_bearer_only_and_a_hook_token_buys_nothing_there` |

And a **dashboard bearer cannot** drive the hook route (`the_dashboard_bearer_buys_nothing_on_a_hook_route`)
— the property `board/hook.rs`'s module doc states, now asserted for this endpoint too.

**KNOWN LIMITATION, recorded rather than left as a silent gap.** An agent that wants to *delegate*
still needs the **dashboard bearer**: `/api/agents/delegate` is bearer-only in this fase, so an agent
performing a hand-off from its pty is using an admin-equivalent credential to do it. That is a real
privilege asymmetry with the schedule path, which is properly scoped.

*Follow-up shape, written down:* add `POST /api/hook/agents/delegate` on the hook router, with `from`
**forced** to the authenticated session (structurally, exactly as T6.2 does it), the recipient
constrained to an existing session, the same `PROMPT_MAX_BYTES` cap and the same wrapper-markup
refusal. `audit_actor` then becomes a *result* rather than a claim on that path, and the bearer path
can keep its `actor` hint for the composer. Not done here because it is a new capability decision of
the same size as G2 and belongs to its own gate.

---

## T10.3 — Injection

The corpus is the artefact, and it is shared: `server/tests/fixtures/chat/supermux-wrappers.jsonl`
is read by **both** `server/tests/wrapper_parity.rs` and `web/tests/unit/chat-wrapper-parity.test.ts`,
so a fix on one plane cannot regress the other.

| attack | outcome | where |
|---|---|---|
| wrapper break-out — a delegate prompt containing `</supermux-delegation>` | **400 pre-delivery**, never escaped | `delegate.rs::wrapper_markup`; `a_prompt_that_could_forge_a_wrapper_is_refused_before_anything_is_delivered_or_recorded` (asserts the ledger stays EMPTY — a 400 that had already delivered still reads as a 400) |
| nested wrapper — a prompt containing a whole second `<supermux-delegation from="root">` block | 400 | same |
| a prompt forging a `<supermux-schedule>` opener | 400 | same |
| case variation (`</SUPERMUX-DELEGATION>`) | 400 — the check lowercases | same |
| attribute injection via `from` (`a" evil="`, `a<b`, `a>b`, `a&b`, newline, quote) | `wrap_delegation` returns `Err` → 400; never mangled into something the sender did not write | `a_from_that_could_inject_an_attribute_is_refused` |
| a HUMAN pasting `<supermux-delegation from="ceo">…` into the composer | 400 — the same server-side rule. This is T1.6's mitigation: the WS plane cannot see `promptSource: "typed"`, so the guarantee is **structural** (the wrapper is unforgeable by construction) rather than a flag | the corpus line + `a_prompt_that_could_forge_a_wrapper_…` |
| a hook-created schedule's `title` or `prompt` containing wrapper markup | 400, by the **same** `wrapper_markup` rule (now `pub` — one rule, two callers) | `wrapper_markup_is_refused_in_the_title_and_in_the_prompt` |
| a schedule `title` containing markup or a `·` that could fake a system line | inert: the title is rendered as **text** inside a `SystemEntity`, and the `·` is a separate `<span aria-hidden>` element, not part of the string | `chat-chip-navigation.test.tsx`, `chat-harness-line.test.tsx` |
| an honest prompt that merely says the word "supermux-delegation" | **allowed** — the rule is markup, not vocabulary | `an_honest_prompt_that_merely_mentions_the_word_delegation_is_fine` |

**Rendering is text on every new surface.** `dangerouslySetInnerHTML` appears **nowhere** in
`web/src/components/chat/**` or `web/src/components/session-schedules/**` (verified by grep over the
branch). Schedule titles, prompts, session names and ledger details all reach the DOM as React
children.

**Live confirmation** (T11, real server): `</supermux-schedule>` in a hook-created prompt → 400
*"'prompt' may not contain supermux wrapper markup"*; the same on the delegate path → 400.

---

## T10.4 — Audit completeness + hygiene

**Completeness** — every path that mutates cross-session state writes a ledger row:

| action | actor | writer | test |
|---|---|---|---|
| `session.delegate`, composer path | `user` | `delegate.rs` via `audit_harness` | `every_surfaced_action_writes_a_row_whose_detail_holds_no_prompt_body` |
| `session.delegate`, agent path | `agent:<from>` | same | same |
| `schedule.create`, bearer path | `user` | `scheduler::audit_schedule_create` | same |
| `schedule.create`, **hook path** | `agent:<session>` | same, called by `scheduler/hook.rs` | `a_session_scheduling_its_own_prompt_lands_and_narrates_itself` |
| `schedule.run`, ok **and** failure | `scheduler` / `user` | `scheduler/runner.rs` | `every_surfaced_action_writes_a_row_whose_detail_holds_no_prompt_body` (both status branches) |

**Hygiene** — the prompt body, the hook token and the bearer reach **none** of:

- `audit_log.detail` — asserted directly: the completeness test plants a sentinel
  (`SECRET-PROMPT-BODY-DO-NOT-LOG`) as a schedule prompt and a delegate prompt and asserts it is
  absent from **every** row written. `delegate.rs::audit_detail()` is the one function that decides
  what a delegation logs, and `the_ledger_detail_carries_the_sender_and_never_the_prompt_body`
  pins it to exactly one key.
- the SSE `harness` payload — it ships the `audit_log` row as written, so the same guarantee.
- log lines — `tracing` calls in the new code carry `schedule = %id` / `error = %e` only.
- **the new error messages** (checked explicitly, because a refusal is the easiest place to echo the
  input back): `'{field}' is not permitted…`, `done_action must be…`, `'{field}' may not contain
  supermux wrapper markup`, `this session already owns {n} schedules…`, `'prompt' is too large ({n}
  bytes, max …)`. Each names the **field** or a **count**, never the value. The cap message quotes a
  byte length, not a prefix of the prompt.

`EVENTS_SQL` interpolates only compile-time literals (`SURFACED_ACTIONS`, `TARGET_IS_A_SESSION`);
every user value is bound.

### Finding 3 (fixed) — the harness feed's `target` arm was namespace-blind

`session.delegate` / `session.rename` put a **session name** in `audit_log.target`; the two schedule
actions put a **schedule id** there. The feed's `target = ?` arm was unscoped, so a session literally
named after a schedule id became the subject of that schedule's events — two namespaces sharing one
column, i.e. one session reading another's transcript for the price of a name.

**Fixed by construction**: the arm is scoped to `TARGET_IS_A_SESSION`. Schedule rows still reach
their feed through `detail.session`, the arm they were always meant to use. Regression test:
`a_schedule_fire_is_visible_only_to_the_session_named_in_its_detail` (which now asserts a session
named `SCHED-aaaabbbb` sees nothing).

---

## T10.5 — Denial of service

| surface | limit | where | test |
|---|---|---|---|
| delegate prompt size | **64 KiB** (`PROMPT_MAX_BYTES`), 400 above it, refused **before** `send_text` | `delegate.rs` | `an_oversized_prompt_is_refused_rather_than_pasted_into_another_agents_pane`, `the_prompt_ceiling_is_a_documented_number_not_a_vibe` |
| schedules per session (hook path) | **20** (`MAX_SCHEDULES_PER_SESSION`), 429 with an actionable message; counted per session so one agent cannot starve another | `scheduler/hook.rs` | `the_per_session_cap_holds_at_the_boundary_and_is_scoped_to_the_session` |
| harness feed page size | **200** (`EVENTS_LIMIT_MAX`), `clamp(1, 200)` on the query param | `sessions/mod.rs:483` | `since_id_is_exclusive_and_limit_clamps_the_page` (asserts the HTTP layer answers `limit=100000` with what exists, never an error) |
| harness feed refetch rate | **1200 ms trailing debounce** — a fan-out that writes six rows in one breath costs one refetch | `use-harness-events.ts` | the debounce is structural (a single `setTimeout` guard); its cost model is documented at the source |
| `schedule_runs` growth | **keep last 20 per schedule** (`RUN_HISTORY_KEEP`), pruned on insert, scoped by `schedule_id` | `db/schedules.rs` | `scheduler.rs::run_history_keeps_the_newest_twenty_per_schedule` (25 in → 20 kept, newest, and a busy schedule does not evict a quiet one's rows) |
| delegate wrapper cost | the wrapper adds a fixed ~60 bytes; `wraps_for_provider` restricts it to `claude` | `delegate.rs` | `only_claude_targets_get_the_wrapper` |

Not capped, and deliberately: the number of delegations per unit time. A delegation requires the
dashboard bearer, and an admin-equivalent caller has many cheaper ways to be noisy. Recorded so the
absence is a decision.

---

## T10.6 — `/security-review` over the finished diff

Run over the branch diff against `origin/main` (76 files, +4606/−3261), by a reviewer given the
repo's own established patterns to compare against (`board/hook.rs`, `hooks.rs`, `http.rs`,
`db/audit.rs`, `recall.rs`) and told to drop anything below confidence 8.

**Result: no findings at confidence ≥ 8.** The negative is auditable — what was traced and cleared:

| traced | verdict |
|---|---|
| the new hook `authenticate()` vs the three existing copies | **behaviourally identical**: DB is the source of truth with a bound `WHERE name = ?`; a missing session and a missing runtime row both 401 (no existence oracle); an empty stored token short-circuits to 401; `constant_time_eq` over bytes is length-sensitive; a non-UTF-8 header degrades to `""` and cannot match. The one delta — `body.session.trim()` — can only canonicalise toward an existing row on an exact-match lookup, never redirect |
| are the "forced" fields really forced? | **yes.** `session` / `kind` / `schedule_expr` / `done_action` are set positionally and the rest is `..Default::default()`; the payload's `session` is consumed by `authenticate` and dropped. `CreateBody` is narrow, so serde discards anything not named (`boot_dir`, `watch`, `confirm_finish`, `recurrence`, `run_at`), and the six privileged fields that ARE named are refused on `is_some()` — so `"kind": null` and `"_test_fire": false` are not bypasses either. Traced downstream: with `command == ""` and `kind == "tmux"`, `execute_tmux` only calls `send_text_with_preview` into `sched.session`, i.e. the caller's own pane |
| SQL injection in the changed `EVENTS_SQL` and the new prune | **cleared.** `EVENTS_SQL` interpolates only `SURFACED_ACTIONS` / `TARGET_IS_A_SESSION`, both compile-time `const [&str; N]`; all five session/limit/cursor values stay bound. The prune is fully parameterised. The reviewer independently noted that the `target`-arm change CLOSES a cross-session read (Finding 3) |
| command injection / process spawn | **cleared** — nothing in the diff reaches `Command::new`, and the `shell` kind (the only `bash -c` path) is unreachable from the hook endpoint |
| path traversal | **cleared** — the one new `MANAGED_COMMANDS` row is a `const &str` name; the only `join()`/`fs` calls in the diff are `#[cfg(test)]` |
| **wrapper forgery — a real bypass attempt** | **cleared, with the reason.** `wrapper_markup` lowercases and rejects `<tag` / `</tag` for both tags anywhere in the string; the READER (`recall.rs::leading_tag`, `tag_inner`, `attr_value`) matches only exact-lowercase openers/closers with no whitespace-in-tag and no entity tolerance — so the writer's blunt rule is a **strict superset** of what the reader will parse, which is why a blunt rule is sufficient here. `attr_value` reads the first `from=`, always the server-written opener at offset 0. `from` also passes `attr_safe`. The schedule wrapper's `title` goes through `escape_attr`. No bypass could be constructed |
| sensitive-data exposure in the new responses and logs | **cleared** — `audit_detail()` emits one key; the new 400/429 sentences name a field, a byte count or the caller's own schedule count, never a token or a body; `TooManyRequests` routes through the same `IntoResponse` that suppresses internal error text |
| client surfaces | **cleared** — no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or dynamic `href` in the web diff; `agents.ts` reads the bearer at call time and sends it only same-origin; `schedule-href.ts` returns two static strings; the `use-sse.ts` change adds a listener and crosses no trust boundary |
| `actor: "human"` | **cleared as not-a-boundary** — Finding 1 above; `audit_actor` matches the exact string only and no privilege attaches to it |

**Design note the reviewer recorded, explicitly not as a finding:** the genuinely new capability is that
a per-session hook token can persist a recurring prompt into its own pane. That is not a privilege
escalation — reaching the endpoint requires shell execution inside that pane (the token lives in the
pane's env), and anything that can run `curl` there can already run `at`, `cron` or a background
process on the same host. The endpoint cannot target another session, cannot run a command, cannot
boot a session, and cannot bypass permissions.

**Also caught during T11 and fixed** (not a security bug, but a correctness one of the same
"silently wrong, nothing red" class): the `harness` SSE channel was never registered on the client,
so the durable ledger only rendered after a reload. Fixed by deriving `SseEventType` from the
subscription array and adding `sse-events.test.ts`, which reads the server's own emitters from disk.

---

## Live verification (T11, real server, two real Claude sessions)

Every negative in the matrix was also run against a running instance, not only in tests:

```
A's token for B:          401
no token:                 401
dashboard bearer:         401
done_action command:…     400  done_action must be 'disable' or 'notify' on this endpoint
kind shell:               400  'kind' is not permitted on this endpoint
wrapper markup in prompt: 400  'prompt' may not contain supermux wrapper markup
bad grammar:              400  unrecognized schedule expression 'sometime next week'
delegate w/ hook token:   401
delegate wrapper markup:  400  prompt may not contain supermux wrapper markup
```

And the positive: a session's own token created one schedule (201, `kind=tmux`, `command=""`,
`done_action=disable`), which fired two minutes later and left `Created schedule ⏱ …` /
`Ran schedule ⏱ …` in that session's transcript, attributed to `agent:b4-receiver`.

**No empty cells.**
