# Grok-UI debt register — canonical

**origin/main HEAD:** `6caafdf (#87) — verified 2026-08-17 after `git fetch origin``  
**Generated:** 2026-08-17

> **Premise correction.** The task brief said PRs #78–#89 are merged. VERIFIED FALSE: #88 (login) and #89 (pty-lens) are state=open, merged_at=null. #78–#87 are merged.

> **Method.** Every row below was checked against code on `origin/main` (finding 23 rule: a checked box is not evidence). The `Evidence` column records what the code actually showed — including where a PR-body claim does not hold.

## Counts

| Status | Items |
|---|---|
| 🔴 OPEN | 47 |
| 🟠 OPEN (on an unmerged branch) | 2 |
| 🟡 PARTIAL | 1 |
| ⚪ UNVERIFIED | 1 |
| 🟢 CLOSED (verified) | 2 |
| **Total** | **53** |

## Register

| ID | Layer | Item | Status | Sev | PR |
|---|---|---|---|---|---|
| `WIRE-01` | chat-wire | `chat_store()` is non-creating, so a limit banner reaches the tile tail only while a chat client is attached | 🔴 OPEN | minor | #87 |
| `WIRE-02` | chat-wire | LastSendBar hard-codes 'You ·' for delegated and scheduled prompts | 🔴 OPEN | minor | #82 |
| `WIRE-03` | chat-wire | 'Terminal died' shown beside 'Idle' + a green dot (the cosmetic half of the dead-pane blocker) | 🔴 OPEN | minor | #82 |
| `WIRE-04` | chat-wire | force_stopped_on_death status broadcast on the DEATH_SEEN edge | 🔴 OPEN | minor | — |
| `WIRE-05` | chat-wire | Finding 7 follow-up: 'escalate past the boot window' | 🔴 OPEN | unknown | — |
| `WIRE-06` | chat-wire | #87 shipped 3 commits rather than one per state family | 🔴 OPEN | cosmetic | #87 |
| `PTY-00` | pty-lens | The whole pty dialog-lens + roster-banks wave (PR #89) is NOT on origin/main | 🟠 OPEN (on an unmerged branch) | blocker | #89 |
| `PTY-01` | pty-lens | `AppState::statusline()` still has ZERO callers — the rate_limits headroom signal is built and dark | 🔴 OPEN | major | #89 |
| `PTY-02` | pty-lens | rate_limits is not on the debounced sessions-SSE delta (even on the branch) | 🔴 OPEN | minor | #89 |
| `PTY-03` | pty-lens | `startup.trust` accept path is never live key-driven | 🔴 OPEN | minor | #89 |
| `PTY-04` | pty-lens | AskUserQuestion free-text pass-through | 🔴 OPEN | should | #89 |
| `PTY-05` | pty-lens | AskUserQuestion answered-state via the TRANSCRIPT sibling (chat plane) | 🔴 OPEN | minor | #89 |
| `PTY-06` | pty-lens | `auth.transcript_saving_off` as a fifth `pty_state::WEDGES` entry | 🔴 OPEN | minor | #89 |
| `PTY-07` | pty-lens | Unmapped needs-input state families that were never scheduled (26 catalogued gaps) | 🔴 OPEN | major | — |
| `LOGIN-00` | login | The whole OAuth-login product feature (PR #88) is NOT on origin/main | 🟠 OPEN (on an unmerged branch) | blocker | #88 |
| `LOGIN-01` | login | QR code on the login card | 🔴 OPEN | minor | #88 |
| `LOGIN-02` | login | Pipe lane: `claude auth login --claudeai` over non-TTY pipes as a second flow | 🔴 OPEN | should | #88 |
| `LOGIN-03` | login | Codex device-code + API-key-paste login: full automation | 🔴 OPEN | should | #88 |
| `LOGIN-04` | login | Routes INTO the login flow: auth.status_json, the auth.dead 'Sign in' affordance, expiry warning | 🔴 OPEN | should | #88 |
| `LOGIN-05` | login | method_select arrow-driving is fixture-verified only — no e2e drives the selector | 🔴 OPEN | minor | #88 |
| `LOGIN-06` | login | `claude setup-token` writes a year-long OAuth credential into persisted pty scrollback | 🔴 OPEN | should | — |
| `LOGIN-07` | login | auth.401_zombie_exit reads as a generic 'Terminal died' | 🔴 OPEN | should | — |
| `PAL-01` | palette | The recall sheet's search is a keyboard dead end — no listbox/option roles, ArrowDown/Enter inert | 🔴 OPEN | major | #80 |
| `PAL-02` | palette | `focus-mode/session-picker-sheet.tsx` is still 251 lines off `EntityPickerView` | 🔴 OPEN | major | #80 |
| `PAL-03` | palette | No shortcut registry and no `?` cheatsheet | 🔴 OPEN | major | #80 |
| `PAL-04` | palette | Transcript search as a palette mode | 🔴 OPEN | should | #75 |
| `PAL-05` | palette | Deep-link to a transcript entry (`/focus/:name?entry=<uuid>`) | 🔴 OPEN | should | #75 |
| `PAL-06` | palette | B3 T5.3 — sort / density / view rows as thin palette mirrors | ⚪ UNVERIFIED | minor | #75 |
| `ROST-01` | roster | The mark deduper's silhouette-similarity cost (three rounded shapes on hue 158) | 🔴 OPEN | minor | #83 |
| `ROST-02` | roster | No desktop right-click context menu for the roster action set | 🔴 OPEN | minor | #83 |
| `ROST-03` | roster | B5 leftovers: 7 sheet migrations, 22 empty-states, the RosterRow migration | 🔴 OPEN | minor | #78 |
| `SHELL-01` | shell-theme | White-on-systemBlue at 3.65:1 on the primary Save button (settings#schedules) | 🔴 OPEN | minor | #85 |
| `SHELL-02` | shell-theme | SGR-2 dim runs (opacity 0.6) are not contrast-clamped | 🔴 OPEN | cosmetic | #85 |
| `A11Y-01` | perf-a11y | T8.5 — the keyboard-only walkthrough e2e spec | 🔴 OPEN | major | #84 |
| `A11Y-02` | perf-a11y | nav-morph-pill.spec.ts's assertion gap — CLOSED, contrary to the deferral note | 🟢 CLOSED (verified) | n/a | #85 |
| `A11Y-03` | perf-a11y | The app-JS size ceiling ratchet was deliberately NOT taken | 🔴 OPEN | major | #88 |
| `A11Y-04` | perf-a11y | A6 T9.1–T9.5 — the mobile-simulation battery | 🔴 OPEN | should | #76 |
| `A11Y-05` | perf-a11y | A6 T4.4 — sweep for the CLASS of chat affordances that fetch, can 404, or sit behind a flag | 🔴 OPEN | minor | #76 |
| `SRV-01` | server-lifecycle | `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is never exported at launch | 🟡 PARTIAL | major | #87 |
| `SRV-02` | server-lifecycle | `config.statusline_tap` default-flip decision | 🔴 OPEN | should | — |
| `SEC-01` | security | `POST /api/sessions` interpolates the caller-supplied `flags` string UNQUOTED into the launch shell line | 🔴 OPEN | major | #87 |
| `SEC-02` | security | Codex 'Hooks need review' trust lets hooks run OUTSIDE the sandbox — and supermux installs hooks itself | 🔴 OPEN | should | #89 |
| `INFRA-01` | infra/e2e | Playwright `--single-process`: the SECOND test in a specfile dies with 'Target closed' | 🔴 OPEN | major | — |
| `INFRA-02` | infra/e2e | Claude Code version drift: agents ran 2.1.233, the program pinned 2.1.227 | 🔴 OPEN | should | — |
| `INFRA-03` | infra/e2e | Working-copy hygiene constraints that bit this program | 🔴 OPEN | cosmetic | — |
| `DOC-01` | docs/plans | Most of the program's plans — including the master plan — were NEVER COMMITTED | 🔴 OPEN | major | — |
| `DOC-02` | docs/plans | The A6 ledger on origin/main has 34 unchecked boxes that no longer describe reality | 🔴 OPEN | major | #76 |
| `DOC-03` | docs/plans | The B3 ledger on origin/main has 26 unchecked boxes, several of which ARE shipped | 🔴 OPEN | major | #75 |
| `DOC-04` | docs/plans | `docs/REAL_DEVICE_CHECKLIST.md` (A6 T12.1–T12.4) | 🔴 OPEN | should | #76 |
| `SHOW-01` | showcase | A6 T10.1–T10.4 — the human dogfood pass on a side-by-side instance | 🔴 OPEN | major | #76 |
| `SHOW-02` | showcase | A6 T11.1–T11.8 — the showcase capture programme | 🔴 OPEN | major | #76 |
| `SHOW-03` | showcase | A6 T13.1–T13.5 — the A7-readiness checklist, full gate and hand-off | 🔴 OPEN | should | #76 |
| `SHOW-04` | showcase | A7 (the default flip) appears ALREADY SHIPPED — confirm this is intended before the showcase | 🟢 CLOSED (verified) | n/a | — |

---

## Per-item detail

### chat-wire

#### `WIRE-01` — `chat_store()` is non-creating, so a limit banner reaches the tile tail only while a chat client is attached

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #87
- **Sources (deduped):** PR #87 deferred[chat_tail.chat_store_non_creating]; states matrix limit.hit.session_5h.transcript; followup-debt.md
- **Evidence on origin/main:** Design state unchanged on origin/main.
- **Detail:** `tail_summary` now carries an AgentError when a store DOES exist, but reversing the non-creating decision ('must not spin up a store for a session nobody is watching' — and a roster is exactly that list) is a memory/perf change with its own design argument. The roster's real answer is the StopFailure path, which #87 fixed end to end. ACTION: document the design argument, or solve it.

#### `WIRE-02` — LastSendBar hard-codes 'You ·' for delegated and scheduled prompts

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #82
- **Sources (deduped):** audit finding 24.3; PR #82 deferred; collector wf_85091bd0_4
- **Evidence on origin/main:** CONFIRMED OPEN: `web/src/components/focus-mode/last-send-recall.tsx:902` still renders `You · {formatRecallTime(...)}`.
- **Detail:** Needs the sender recorded alongside `last_send_text` — a schema column + migration, judged out of proportion to a minor. #82's 24.2 removed the strip from the chat surface where the lie was most visible; it remains under the terminal.

#### `WIRE-03` — 'Terminal died' shown beside 'Idle' + a green dot (the cosmetic half of the dead-pane blocker)

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #82
- **Sources (deduped):** audit finding 24.6; PR #82 deferred; audit finding 3 (fixed in #79)
- **Evidence on origin/main:** `web/src/components/chat/agent-error.ts:226` produces the 'Terminal died' label; `focus-header.tsx` still renders StatusDot + STATUS_LABEL[status] with no dead-pane pre-emption in the same slot.
- **Detail:** Deliberately left to the owner of the focus-header status slot: two agents editing it in one wave would collide. Now unblocked — finding 3 shipped in #79.

#### `WIRE-04` — force_stopped_on_death status broadcast on the DEATH_SEEN edge

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** —
- **Sources (deduped):** followup-debt.md (earlier-wave leftovers); collector wf_85091bd0_1 notes (#79)
- **Evidence on origin/main:** Not present on origin/main.
- **Detail:** Belt-and-braces beside the client-side `paneIsDead` clause that #79 shipped: either make the auto-heal path (which already gates auto-heal) broadcast on the persisted-status edge, or make pty.rs's stream-dead path broadcast. #79's client clause stays correct and complementary either way.

#### `WIRE-05` — Finding 7 follow-up: 'escalate past the boot window'

- **Status:** 🔴 OPEN · **Severity:** unknown · **PR:** —
- **Sources (deduped):** followup-debt.md (earlier-wave leftovers)
- **Evidence on origin/main:** Unverified in code — carried forward from an earlier wave's leftovers list.
- **Detail:** The empty-transcript honesty fix (#82) landed; the escalation-past-boot-window refinement was never scheduled. NEEDS TRIAGE: the exact behaviour is described only in the earlier wave's notes.

#### `WIRE-06` — #87 shipped 3 commits rather than one per state family

- **Status:** 🔴 OPEN · **Severity:** cosmetic · **PR:** #87
- **Sources (deduped):** PR #87 deferred[commit.per_state_family]
- **Evidence on origin/main:** Process note; no code impact.
- **Detail:** The limit, system-subtype, question-pair and denial fixes all land in parser.rs + wire-entries.ts, so splitting further would have needed patch surgery and produced non-compiling intermediates. Recorded so the reviewer is not surprised.

### pty-lens

#### `PTY-00` — The whole pty dialog-lens + roster-banks wave (PR #89) is NOT on origin/main

- **Status:** 🟠 OPEN (on an unmerged branch) · **Severity:** blocker · **PR:** #89
- **Sources (deduped):** PR #89 body; collector wf_f0fe237d_3 (area 2); followup-debt.md; GitHub API state
- **Evidence on origin/main:** `server/tests/fixtures/pty/` absent on origin/main; no `question.ask` registry entry; GitHub API says PR #89 state=open, merged_at=null.
- **Detail:** 13 claimed-fixed items live only on branch fix/states-pty-lens: the AskUserQuestion `question` lens family + registry entry (live-driven on CC 2.1.233), finding-8 readOptions description fold, perm.trust_folder + auth.apikey_approval startup gates, first-run/codex-hooks startup wedges, limit.hard_block on the live plane (SessionView.blocked), limit warning chips, rate_limits wiring, BlockedBadge + 6th attention cause, the honest unmapped-dialog card, the dialog-question composer refusal, the caret-settle fix, and the 11-capture parity corpus.

#### `PTY-01` — `AppState::statusline()` still has ZERO callers — the rate_limits headroom signal is built and dark

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #89
- **Sources (deduped):** states matrix finding 'rate_limits captured and read by nobody'; research gaps limit.statusline_rate_limits; PR #89 body claims it FIXED; followup-debt.md
- **Evidence on origin/main:** CLAIMED-DONE-FALSE against origin/main: `git grep 'statusline()' origin/main -- server/src` returns only a test fn name; `git grep -rn 'rate_limits|rateLimits' origin/main -- web/src` → ZERO hits.
- **Detail:** 900 lines of well-tested statusline tap exist; nothing broadcasts it. Last mile = a sessions-SSE delta key + a focus-header/roster usage pill + a decision on the triple-gated `config.statusline_tap` default (still `bool`, absent key = OFF on main). #89 implements this but is unmerged.

#### `PTY-02` — rate_limits is not on the debounced sessions-SSE delta (even on the branch)

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #89
- **Sources (deduped):** PR #89 deferred[rate_limits on the sessions SSE delta]
- **Evidence on origin/main:** n/a
- **Detail:** Published on SessionView (so GET /api/sessions and the focus fetch carry it) but not on the SSE delta: the tap is per-turn and default-off, so the fan-out was judged not worth it. Revisit if statusline_tap is ever flipped on.

#### `PTY-03` — `startup.trust` accept path is never live key-driven

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #89
- **Sources (deduped):** PR #89 deferred[startup.trust — live key-drive]; MEMORY: re-verify subagent 'live' claims
- **Evidence on origin/main:** n/a
- **Detail:** actOn rests on the production spool's own accept frame, not a run driven by the branch's code. Two attempts to provoke the gate died at `spawn pty holder`. The AskUserQuestion drive proves the sequencer; what is unproven is only that Enter-on-row-1 does what the spool shows. Esc deliberately unmapped (a second Esc exits CC — issue #75649).

#### `PTY-04` — AskUserQuestion free-text pass-through

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #89
- **Sources (deduped):** PR #89 deferred[AskUserQuestion free-text]; research gaps q.ask_user_question
- **Evidence on origin/main:** n/a
- **Detail:** a0 §3 live-verified that a `send_text` PASTE into an open dialog is ignored and the appended Enter picks the caret's row — i.e. free text would silently answer with an option the user never chose. Honest route is a two-stage sequence (navigate to `N. Type something.`, Enter, then paste) whose second screen nobody has captured. Currently a refusal that names the mechanism.

#### `PTY-05` — AskUserQuestion answered-state via the TRANSCRIPT sibling (chat plane)

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #89
- **Sources (deduped):** PR #89 deferred[answered-state via transcript sibling]
- **Evidence on origin/main:** n/a
- **Detail:** Confirmed on the PTY plane instead. Adding `questions` to `wire-entries.ts::toolLine` + a dedicated answered row is chat-content-plane work that overlaps #82 territory; skipped to avoid a merge conflict over the same arm.

#### `PTY-06` — `auth.transcript_saving_off` as a fifth `pty_state::WEDGES` entry

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #89
- **Sources (deduped):** PR #89 deferred[auth.transcript_saving_off]; research gaps (must)
- **Evidence on origin/main:** Chat-side detection DID land (#87): `web/tests/unit/chat-transcript-off.test.ts` + the peek-lens `transcriptOff` field are on main. The pty-wedge half is not.
- **Detail:** A must-priority gap in the same family; the pty is its only witness on the live plane. One line of tokens plus a corpus row would cover it.

#### `PTY-07` — Unmapped needs-input state families that were never scheduled (26 catalogued gaps)

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** —
- **Sources (deduped):** collector wf_92a294f0_5 research gaps (132 states catalogued); states matrix (45 rows)
- **Evidence on origin/main:** None of these has any handling on origin/main.
- **Detail:** MUST-priority, unscheduled: mcp.elicitation_form (typed JSON-Schema form mid-tool-call; hard-hangs with a green dot), mcp.task_input_required, limit.overage_consent_dialog ('Session paused' billing consent), err.refusal_fallback_dialog (carries retractedMessageUuids → already-streamed messages must be EVICTED; the append-only ring has no mechanism), err.stream_stalled ('will retry in {t}' — turn is still live but drifts to Idle), err.safeguards_refusal (stop_reason=refusal, 844 matching issues), limit.grace_window (CC injects a wrap-up instruction as an isMeta user entry — supermux would render it as if the USER typed it). SHOULD: generic.armed_keys (must land BEFORE any auto-Esc/Ctrl-C recovery), generic.queued_input_hazard, generic.unsaved_work_stash, generic.permission_mode_enum (6 modes vs supermux's 4 — 'dontAsk'/'auto' fall through to Normal), perm.deny_with_feedback (the 'No' option is often a TEXT INPUT), plan.exit_plan_mode's 7 outcomes, hook.notification_types (9 subtypes collapsed to 1 tier), hook.dialog_status_labels, err.prompt_too_long, err.model_refusal_fallback, codex.request_user_input (AUTO-RESOLVES ON A TIMER — a decision is silently made for the absent user), codex.hooks_review, codex.usage_limit, perm.bypass_consent (SessionEnd `reason` unmodelled). NICE: q.peer_inbound_approval, perm.worker_network, mcp.server_health, limit.fast_mode_disabled, update.self_restart_managed_settings, generic.cloud_session_gaps. MOOT: kimi.sweep_missing (provider removed in #86).

### login

#### `LOGIN-00` — The whole OAuth-login product feature (PR #88) is NOT on origin/main

- **Status:** 🟠 OPEN (on an unmerged branch) · **Severity:** blocker · **PR:** #88
- **Sources (deduped):** PR #88 body; collector wf_f0fe237d_2 (area 3); followup-debt.md; GitHub API state
- **Evidence on origin/main:** `git ls-tree origin/main -- server/src/sessions/login.rs` → empty; `server/tests/fixtures/login/` absent; GitHub API says PR #88 state=open, merged_at=null.
- **Detail:** 15 claimed-fixed items (pty login lens, 5-stage classifier, URL reassembly across wrap widths, bracketed-paste burst, retry-in-place, mandatory Enter, supervision freeze + Heal::Frozen, redaction of the code out of last_send_text/SSE/logs, roster dot pre-emption, login-card.tsx, 18-case fixture parity on both planes, 2 e2e suites, codex device-auth cards, harness startBackend({env}) seam) exist only on branch feat/login-flow. Nothing of it is in the product until #88 merges.

#### `LOGIN-01` — QR code on the login card

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #88
- **Sources (deduped):** PR #88 deferred[auth.login.qr_code]; followup-debt.md
- **Evidence on origin/main:** n/a — feature never landed anywhere.
- **Detail:** Dropped on purpose: a hand-rolled QR encoder is Reed-Solomon + mask evaluation and this box has no decoder (no pyzbar/cv2) to verify it decodes; an unverifiable QR on a credential flow is worse than none. Shipped fallback = tappable link + Copy + selectable URL. Revisit with a vendored, test-vectored encoder; costs bytes against a ceiling already at ~100%.

#### `LOGIN-02` — Pipe lane: `claude auth login --claudeai` over non-TTY pipes as a second flow

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #88
- **Sources (deduped):** PR #88 deferred[auth.login.pipe_lane]; research gaps auth.login.paste_prompt; followup-debt.md
- **Evidence on origin/main:** n/a
- **Detail:** The research contract calls the pipe lane the cleaner lane (3 stable ANSI-free stdout lines, keep stdin open, write `<code>#<state>\n`), but it cannot keep a LIVE session alive — which is the case the feature exists for — and it is forbidden when forceLoginMethod=gateway. A separate feature: a signed-out session with no pane.

#### `LOGIN-03` — Codex device-code + API-key-paste login: full automation

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #88
- **Sources (deduped):** PR #88 deferred[codex.login.*]; research gaps
- **Evidence on origin/main:** n/a
- **Detail:** Detected, classified `waiting` on both planes and given an honest card with link + one-time code (on the branch). Not driven: device lifecycle/expiry/confirm are their own, and the API-key screen is a long-lived secret whose storage rules were never designed.

#### `LOGIN-04` — Routes INTO the login flow: auth.status_json, the auth.dead 'Sign in' affordance, expiry warning

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #88
- **Sources (deduped):** PR #88 deferred[auth.status_json/auth.dead/auth.expiry_warning]; PR #87 body (Sign-in affordance opens the terminal); research gaps auth.status_json, auth.expiry_warning, auth.dead
- **Evidence on origin/main:** `useLogin` does not exist on origin/main; #87's auth card offers only 'Sign in from the terminal'.
- **Detail:** `claude auth status --json` is never called — supermux has no notion of 'signed out'. The branch exposes `useLogin.start(design?)` as the entry point and NOTHING calls it. Expiry warning ('login expires in N days') self-clears after 15 s in the statusline so a poll-based wrapper misses it; the startup box + /status row are the durable signals.

#### `LOGIN-05` — method_select arrow-driving is fixture-verified only — no e2e drives the selector

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #88
- **Sources (deduped):** PR #88 deferred[auth.login.method_select]
- **Evidence on origin/main:** n/a
- **Detail:** `choose_method` sends N×Down + Enter and is fixture-tested for the READING only. The fake provider skips straight to the URL block. Needs a second fake screen.

#### `LOGIN-06` — `claude setup-token` writes a year-long OAuth credential into persisted pty scrollback

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** —
- **Sources (deduped):** research gaps auth.setup_token
- **Evidence on origin/main:** No redaction on the capture path on origin/main (grep for setup-token in server/src: none).
- **Detail:** Needs redaction on the capture path regardless of whether the flow is ever driven — supermux persists scrollback, so one `claude setup-token` run stores a long-lived secret in plaintext.

#### `LOGIN-07` — auth.401_zombie_exit reads as a generic 'Terminal died'

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** —
- **Sources (deduped):** research gaps auth.401_zombie_exit
- **Evidence on origin/main:** No handling on origin/main.
- **Detail:** In a remote child session, 10 min of unrecovered 401s makes CC call process.exit(1) on purpose. Related hazard: the silent 401 recovery chain can stall 60 s with no output and must not be killed as a hang.

### palette

#### `PAL-01` — The recall sheet's search is a keyboard dead end — no listbox/option roles, ArrowDown/Enter inert

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #80
- **Sources (deduped):** audit finding 26 (3/5); PR #80 deferred; followup-debt.md; B3 plan T8.1
- **Evidence on origin/main:** CONFIRMED OPEN: `git show origin/main:web/src/components/focus-mode/last-send-recall.tsx | grep 'role="listbox"|role="option"|aria-activedescendant'` → ZERO hits.
- **Detail:** The palette itself became a proper combobox in #80 (verified: command-palette.tsx:685 role=combobox, :689 aria-activedescendant); the recall sheet did not follow. B3 T8.1 wanted it rebuilt on EntityPickerView — `grep -c EntityPickerView` in that file → 0.

#### `PAL-02` — `focus-mode/session-picker-sheet.tsx` is still 251 lines off `EntityPickerView`

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #80
- **Sources (deduped):** audit finding 26 (4/5); PR #80 deferred; B3 plan T7.1; followup-debt.md
- **Evidence on origin/main:** CONFIRMED OPEN: file is 251 lines on origin/main with 0 references to EntityPickerView.
- **Detail:** Not a fix — a B-fase-sized change: moving it would lose team grouping, teammate colour rails, lead badges and read-only rows unless the primitive grows those affordances first.

#### `PAL-03` — No shortcut registry and no `?` cheatsheet

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #80
- **Sources (deduped):** audit finding 26 (5/5); PR #80 deferred; B3 plan T6.1–T6.4; followup-debt.md
- **Evidence on origin/main:** CONFIRMED ABSENT: `git ls-tree origin/main -- web/src/lib/shortcuts.ts web/tests/unit/shortcuts-registry.test.ts` → empty.
- **Detail:** Four unshipped tasks: the frozen registry array (T6.1), the anti-rot test that reads every entry (T6.2), the cheatsheet as a palette mode + `?` binding (T6.3), and the ⌘K `Kbd` hint in the search affordance (T6.4). Stated out of scope even then: rewiring the fifteen `addEventListener`s to dispatch FROM the registry.

#### `PAL-04` — Transcript search as a palette mode

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #75
- **Sources (deduped):** B3 plan T8.2/T8.3
- **Evidence on origin/main:** CONFIRMED ABSENT: `grep -c transcript` in command-palette.tsx on origin/main → 0.
- **Detail:** 'Search this session's transcript…' as a palette mode; rows remain insert-into-composer (today's behaviour). Making them jump-to-entry depends on PAL-05.

#### `PAL-05` — Deep-link to a transcript entry (`/focus/:name?entry=<uuid>`)

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #75
- **Sources (deduped):** B3 plan T9.2–T9.6
- **Evidence on origin/main:** CONFIRMED ABSENT: no `data-entry-uuid`, no `useScrollToEntry` anywhere in web/src on origin/main.
- **Detail:** Five unshipped steps: preserve `offset`/`seq` through `toChatEntries`, a DOM anchor on TranscriptItem, `useScrollToEntry(uuid)` in chat-panel, the read-once-then-stripped query param, and the honesty line saying how far back the entry is. Stated out of scope: an FTS5 index and an `around=`/`after=` chat API.

#### `PAL-06` — B3 T5.3 — sort / density / view rows as thin palette mirrors

- **Status:** ⚪ UNVERIFIED · **Severity:** minor · **PR:** #75
- **Sources (deduped):** B3 plan T5.3
- **Evidence on origin/main:** Partially verified: the 'Go to' group (T5.1) and 'New group'/creation verbs (T5.2) ARE on origin/main (command-palette.tsx:265,:291,:341,:510). No clear evidence of the sort/density/view mirror rows.
- **Detail:** Needs a targeted read of command-palette.tsx before the orchestrator treats it as open or closed.

### roster

#### `ROST-01` — The mark deduper's silhouette-similarity cost (three rounded shapes on hue 158)

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #83
- **Sources (deduped):** audit finding 25.7; PR #83 deferred
- **Evidence on origin/main:** Unchanged on origin/main.
- **Detail:** Changes brand-mark assignment, which has its own VR battery and its own owner; re-rolling every user's roster of faces inside a keyboard/attention fix wave was judged unsafe as a slip-in.

#### `ROST-02` — No desktop right-click context menu for the roster action set

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #83
- **Sources (deduped):** PR #83 deferred
- **Evidence on origin/main:** Hover kebab + always-on coarse-pointer trigger shipped (session-actions-menu.tsx on main).
- **Detail:** The shipped affordances close the reachability gap the audit measured; a second event path layered over a dnd-kit drag surface is its own change.

#### `ROST-03` — B5 leftovers: 7 sheet migrations, 22 empty-states, the RosterRow migration

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #78
- **Sources (deduped):** followup-debt.md
- **Evidence on origin/main:** Not individually re-verified in this pass.
- **Detail:** Consistency debt carried out of fase B5 (#78). NEEDS ENUMERATION before scheduling — the counts come from the B5 ledger, not from a code scan.

### shell-theme

#### `SHELL-01` — White-on-systemBlue at 3.65:1 on the primary Save button (settings#schedules)

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #85
- **Sources (deduped):** PR #85 body 'NOT FIXED, DELIBERATELY'; collector wf_85091bd0_6
- **Evidence on origin/main:** Still the only low-contrast row; shows as '2' in the PR's after-numbers.
- **Detail:** Fails in BOTH themes, so it is a `--primary` brand decision, not the light-theme gap finding 17 named. Needs an owner decision on the brand token.

#### `SHELL-02` — SGR-2 dim runs (opacity 0.6) are not contrast-clamped

- **Status:** 🔴 OPEN · **Severity:** cosmetic · **PR:** #85
- **Sources (deduped):** PR #85 body 'NOT FIXED, DELIBERATELY'
- **Evidence on origin/main:** Unchanged.
- **Detail:** Dim is a SEMANTIC that peek-lens.ts reads to tell a model-predicted ghost from typed text; clamping it would break that read. The contrast walk does not count dim runs in either theme. Documented non-fix, not an oversight.

### perf-a11y

#### `A11Y-01` — T8.5 — the keyboard-only walkthrough e2e spec

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #84
- **Sources (deduped):** audit finding 23(a); PR #84 deferred; A6 plan T8.5 (unchecked on main)
- **Evidence on origin/main:** CONFIRMED ABSENT: no chat keyboard-walkthrough spec in `web/tests/e2e/smoke/` (palette-keyboard-only.spec.ts and roster-keyboard.spec.ts exist but cover B3/roster, not the cold-load→chat→send walk).
- **Detail:** Carried BY NAME rather than implemented because it was blocked on finding 0 (composer focus dropping to <body> after a Chat↔Terminal toggle). Finding 0 shipped in #79 — so this is now UNBLOCKED and is the cheapest remaining green-net item.

#### `A11Y-02` — nav-morph-pill.spec.ts's assertion gap — CLOSED, contrary to the deferral note

- **Status:** 🟢 CLOSED (verified) · **Severity:** n/a · **PR:** #85
- **Sources (deduped):** audit finding 23(b); PR #84 deferred (said deliberately not touched)
- **Evidence on origin/main:** VERIFIED CLOSED on origin/main: nav-morph-pill.spec.ts now samples peak `currentTime` per ::view-transition animation and asserts it passes half the duration ('only a currentTime that advances proves it ANIMATED').
- **Detail:** #84 deferred the property assertion to whichever PR fixed the transition; #85 fixed the transition AND landed the assertion. No action — recorded so the orchestrator does not re-open it.

#### `A11Y-03` — The app-JS size ceiling ratchet was deliberately NOT taken

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #88
- **Sources (deduped):** PR #88 deferred[size-budget ceiling ratchet]; audit finding 29; web/scripts/size-budget.mjs history
- **Evidence on origin/main:** On origin/main the ceiling has been ratcheted per fase up to 217 KB (palette/pickers wave); #88 measures 222.86 against a 223 ceiling — 0.14 KB of headroom, the exact pathology the script documents.
- **Detail:** #88 refused to apply the `measured × 1.02` rule because three fix-wave PRs are in flight against the same ceiling: the ratchet should be taken ONCE against the integrated measurement, not three times against three partial ones. THIS IS AN INTEGRATION ACTION for whoever merges #88/#89. Note LOGIN-01 (QR) also costs bytes against it.

#### `A11Y-04` — A6 T9.1–T9.5 — the mobile-simulation battery

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #76
- **Sources (deduped):** A6 plan T9.1–T9.5 (unchecked on main)
- **Evidence on origin/main:** Unshipped; `/dev/shell?keyboard=1` (the shim these depend on) DOES exist on main (dev-shell.tsx:15).
- **Detail:** Five items: soft-keyboard simulation, IME composition (compositionstart/update/end in the composer), PWA standalone shape with a simulated notch, touch physics via harness `touchDragY()`, and both orientations + the 375 px small-phone width (not only 430 px).

#### `A11Y-05` — A6 T4.4 — sweep for the CLASS of chat affordances that fetch, can 404, or sit behind a flag

- **Status:** 🔴 OPEN · **Severity:** minor · **PR:** #76
- **Sources (deduped):** A6 plan T4.4 (unchecked on main)
- **Evidence on origin/main:** The single instance (issue-list.tsx's guaranteed 404) was fixed as finding 29 in #84; the class sweep was never done.
- **Detail:** One-instance fix ≠ the sweep the ledger asked for.

### server-lifecycle

#### `SRV-01` — `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is never exported at launch

- **Status:** 🟡 PARTIAL · **Severity:** major · **PR:** #87
- **Sources (deduped):** PR #87 deferred[lifecycle.env_scrub]; followup-debt.md; research gaps auth.transcript_saving_off
- **Evidence on origin/main:** HALF SHIPPED, verified: `AGENT_NESTING_ENV` + `scrub_inherited_agent_env()` are on origin/main (lifecycle.rs:139-140 lists CLAUDE_CODE_CHILD_SESSION / _SESSION_ID / _MESSAGING_TOKEN / _SOCKET, scrubbed once at startup in main.rs). HALF MISSING: `git grep FORCE_SESSION_PERSISTENCE origin/main` hits ONLY test fixtures — it is never exported.
- **Detail:** The scrub covers the inheritance path (a supermux started from inside a Claude pane). The belt-and-braces export — which also protects against a user who turned persistence off themselves — is not there. Detection DID ship (#87's peek-lens `transcriptOff` + `transcript-blind` attention cause).

#### `SRV-02` — `config.statusline_tap` default-flip decision

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** —
- **Sources (deduped):** PR #87 deferred[limit.statusline.rate_limits]; PR #89 body; research gaps
- **Evidence on origin/main:** `server/src/config.rs:172` — 'Absent key = OFF' on origin/main.
- **Detail:** A capability whose whole value is EARLY WARNING is off by default and only installable via POST /api/claude/statusline. Blocked on PTY-01 landing first; then it is an owner decision (settings surface), not a bugfix.

### security

#### `SEC-01` — `POST /api/sessions` interpolates the caller-supplied `flags` string UNQUOTED into the launch shell line

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #87
- **Sources (deduped):** states matrix finding (minor, shell injection); PR #87 deferred[sessions.create.flags_shell_injection]; followup-debt.md (prioritair)
- **Evidence on origin/main:** CONFIRMED OPEN on origin/main, and the hazard is DOCUMENTED IN THE CODE: `server/src/sessions/mod.rs:742` and `:823` both read '`flags` is interpolated unquoted into the launch line'; lifecycle.rs:341-342 / :398-399 push `s.flags` verbatim into the parts joined into a shell string. `create` validates name/provider/runtime — never flags.
- **Detail:** Repro from the audit: POST with flags="--version >/dev/null; echo INJECTED; claude --model haiku", start, peek — the injected command runs in the pane. Fix: validate `flags` against a conservative charset at the HTTP boundary the way `valid_cc_id` already does, or build the launch line as argv and exec without a shell for the `{agent}` portion. Deferred out of #87 on scope grounds (lifecycle + HTTP boundary, not the wire plane). Mitigation today: the web client sends a typed `bypass_permissions` boolean, never raw flags — so this is an authenticated-API-caller privilege-shape bug, not a web-UI hole.

#### `SEC-02` — Codex 'Hooks need review' trust lets hooks run OUTSIDE the sandbox — and supermux installs hooks itself

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #89
- **Sources (deduped):** research gaps codex.hooks_review
- **Evidence on origin/main:** No handling on origin/main (#89 reports it as a startup-wedge notice; unmerged).
- **Detail:** supermux INSTALLS hooks into sessions, so it triggers this gate itself. It blocks before any turn output, so a renderer that starts at the first assistant token hangs forever. The security half — what 'Trust all and continue' actually grants — has not been designed.

### infra/e2e

#### `INFRA-01` — Playwright `--single-process`: the SECOND test in a specfile dies with 'Target closed'

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** —
- **Sources (deduped):** followup-debt.md (Infra)
- **Evidence on origin/main:** `--single-process` is in web/playwright.config.ts:42 and playwright.screens.config.ts:25 on origin/main.
- **Detail:** Pre-existing, not introduced by this program. Workaround in force: run specs individually. It silently caps every multi-test spec file the green net relies on — worth an owner decision before the showcase.

#### `INFRA-02` — Claude Code version drift: agents ran 2.1.233, the program pinned 2.1.227

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** —
- **Sources (deduped):** followup-debt.md; MEMORY grok-ui-masterplan (CC pinned 2.1.227)
- **Evidence on origin/main:** #89's lens versions include 2.1.233 for permission.bash — but #89 is unmerged, so origin/main's pins are 2.1.227-era.
- **Detail:** Transcript/TUI drift must be re-checked in the showcase pass. The label map #87 transcribed comes from CC 2.1.227's own Kzt/KZe.

#### `INFRA-03` — Working-copy hygiene constraints that bit this program

- **Status:** 🔴 OPEN · **Severity:** cosmetic · **PR:** —
- **Sources (deduped):** followup-debt.md; MEMORY concurrent-agents-in-repo
- **Evidence on origin/main:** n/a — process.
- **Detail:** `git stash` must NEVER be used (it is shared across the ~20 worktrees); a grep-watchdog runs at ~/.local/var/grep-watchdog.log because `-oE` with `{0,N}` on long-line HTML can OOM the box. Keep both in every agent brief.

### docs/plans

#### `DOC-01` — Most of the program's plans — including the master plan — were NEVER COMMITTED

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** —
- **Sources (deduped):** git ls-tree origin/main; MEMORY planner-must-write-file; git status (untracked)
- **Evidence on origin/main:** CONFIRMED: origin/main carries only 6 files under docs/superpowers/plans/ (a6-polish, b3-pickers, b4-fabric, a6-triage, b4-security-checklist, research-2026-08-13/a0-findings.md). The A2/A3/A4/A5/B1/B2/B5 fase plans and 2026-08-16-harness-features-plan.md exist ONLY as untracked files in the working copy; the master plan (2026-08-13-claude-chat-renderer.md) is on NEITHER — it survives only as scratchpad/master.md.
- **Detail:** The program's design record is one `rm -rf` from gone and is invisible to any reviewer of the repo. Cheapest high-value close-out item.

#### `DOC-02` — The A6 ledger on origin/main has 34 unchecked boxes that no longer describe reality

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #76
- **Sources (deduped):** A6 plan on origin/main; PR #77 (five reconnect specs); cross-check against web/tests/e2e/smoke/
- **Evidence on origin/main:** DRIFT IN BOTH DIRECTIONS. Example of stale-unchecked: T3.1–T3.6 (the reconnect e2e battery) are unchecked, yet chat-ws-foreground-redial / restart-reseeds / resync-epoch / staleness-ceiling / stopped-handover / holder-death-handover / chat-toggle-thrash all exist on main (#77).
- **Detail:** The audit's finding 23 was 'checked boxes that do not exist'; the inverse is now also true. Either the ledgers get one honest reconciliation pass or they must be marked non-authoritative — as of today an unchecked A6 box is NOT evidence of open work.

#### `DOC-03` — The B3 ledger on origin/main has 26 unchecked boxes, several of which ARE shipped

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #75
- **Sources (deduped):** B3 plan on origin/main; PR #80; code verification
- **Evidence on origin/main:** VERIFIED STALE-UNCHECKED: T4.4 (mobile ⌘K entry point) is unchecked yet layout.tsx:249-266 ships a Search item in the BottomNav with the reason written in; T5.1/T5.2 are unchecked yet the 'Go to' group and 'New group' rows exist (command-palette.tsx:265,:291,:341,:510); T10.5 ('open the PR') is unchecked yet #75 merged.
- **Detail:** Genuinely-open B3 boxes are tracked here as PAL-03/04/05 and PAL-02. The rest of the unchecked set is bookkeeping.

#### `DOC-04` — `docs/REAL_DEVICE_CHECKLIST.md` (A6 T12.1–T12.4)

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #76
- **Sources (deduped):** A6 plan T12.1–T12.4 (unchecked on main)
- **Evidence on origin/main:** CONFIRMED ABSENT: `git ls-tree origin/main -- docs/REAL_DEVICE_CHECKLIST.md` → empty.
- **Detail:** A ten-minute owner-runnable checklist covering what simulation cannot: install to Home Screen and launch standalone, real touch physics, real IME, real notch. Each step names the mechanism it tests and what to do if it fails, plus a 'what we already proved' preamble linking the T11 verdict.

### showcase

#### `SHOW-01` — A6 T10.1–T10.4 — the human dogfood pass on a side-by-side instance

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #76
- **Sources (deduped):** A6 plan T10.1–T10.4 (unchecked on main); MEMORY never-restart-this-instance-unasked
- **Evidence on origin/main:** Never executed as specified.
- **Detail:** Bring the debug binary up on :8829 with the §0.7 launcher, create four neutral sessions (a6-web/api/docs/review), use it as the working surface for a real session — not a script — and tear it down (instance stopped, ~/.supermux-a6 removed, :8824 uptime confirmed). HARD CONSTRAINT: never restart the :8824 instance that hosts the owner's chat.

#### `SHOW-02` — A6 T11.1–T11.8 — the showcase capture programme

- **Status:** 🔴 OPEN · **Severity:** major · **PR:** #76
- **Sources (deduped):** A6 plan T11.1–T11.8 (unchecked on main); MEMORY README hero video pipeline
- **Evidence on origin/main:** Never executed. `docs/showcase/supermux-showcase.{gif,mp4}` on main are from the EARLIER launch-video programme, not from this one.
- **Detail:** Eight items: the SCENARIOS.md register, the per-platform capture rig on harness.ts against :8829, the matrix with a stated reduction rule, keyboard-driven use as a first-class scenario (S24), the visual jury on the existing rubric, the fix→re-capture→re-judge loop, VERDICT.md (one row per scenario × platform × theme), and the single hand-off page the owner opens. THIS IS THE 'PERFECT FINISH' DELIVERABLE the owner is waiting on.

#### `SHOW-03` — A6 T13.1–T13.5 — the A7-readiness checklist, full gate and hand-off

- **Status:** 🔴 OPEN · **Severity:** should · **PR:** #76
- **Sources (deduped):** A6 plan T13.1–T13.5 (unchecked on main)
- **Evidence on origin/main:** #76 merged, so a hand-off happened; the ledger boxes were never reconciled and the A7-readiness checklist has not been re-assembled against the post-#79..#89 state.
- **Detail:** Needs re-running now that eight more PRs have landed: full gate (lint / unit / e2e / size budget), the evidence-backed readiness lines, and the statement that A7 is a separate PR.

#### `SHOW-04` — A7 (the default flip) appears ALREADY SHIPPED — confirm this is intended before the showcase

- **Status:** 🟢 CLOSED (verified) · **Severity:** n/a · **PR:** —
- **Sources (deduped):** code verification; A6 plan framing ('A6 changes no default')
- **Evidence on origin/main:** VERIFIED ON ORIGIN/MAIN: `web/src/components/chat/renderer-pref.ts:46` sets `defaultRenderer: 'chat'`, and :176 parses anything that is not the literal 'terminal' back to 'chat'.
- **Detail:** The A6 plan states A6 changes no default and that A7 is a separate PR — yet the shipped default IS chat. Either A7 landed inside a later fase or the plan text is stale. NOT DEBT, but the orchestrator should confirm which, because the showcase narrative depends on it.
