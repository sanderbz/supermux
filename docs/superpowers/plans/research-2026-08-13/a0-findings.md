# Fase A0 — Definitive findings (gate + ground truth)

Synthesis of the four A0 probes against master plan `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` (§2, §3, §4.3, §7). Date 2026-08-13. Everything downstream (A1–A7, B-track where it touches chat) cites this document. Where probes disagreed or lacked evidence it is stated, not smoothed over.

**Provenance caveat (latency):** the latency probe agent died mid-run (its tailer process was killed with it; no log written). The synthesis agent re-ran the identical instrumented probe (`scratchpad/probe.py`, 5 ms-poll JSONL tailer + 100 ms status poller) to completion against the same live session `spike-a0-latency` and analyzed with `scratchpad/analyze.py`. Raw log: `scratchpad/a0-latency-log.json`. All other probes completed normally.

**Version ground truth (all four probes agree):** plan says "2.1.227 at plan time" — already stale. The CLI auto-updated **2.1.227 → 2.1.231 mid-probe** (symlink mtime 2026-08-13 20:12). Running sessions keep their boot binary (verified: spike-a0-perm ran 2.1.227 while disk had 2.1.231). Consequence, three places: transcript re-verification keys on the per-entry `version` field; statusline captures key on the payload `version` field; the modal-registry self-test pins on the **session's boot banner** (`╭─── Claude Code vX.Y.Z ───╮` via peek), never `claude --version`.

---

## 1. GATE VERDICT

**VERDICT: FAIL.** Both required turn classes miss the p50 budget; the long text-only class misses both budgets by roughly an order of magnitude. The pre-agreed fail branch (plan §7) is **ACTIVATED** — exact A3 scope delta and the blocking A1 stop/go are spelled out below.

### Method + the proxy (documented, as the gate requires)

Instrumented live against session `spike-a0-latency` (native runtime, Claude 2.1.231 boot banner): a 5 ms-poll JSONL tailer on the conversation dir + a 100 ms status poller + a 250 ms `GET /peek` poller, driving real turns through `POST /api/sessions/{name}/send`. Tooling `scratchpad/probe.py` (+ `probe2/3/4/5.py`, crash-safe periodic flush after the first run was lost with its agent), analysis `analyze.py` / `gate-stats.txt`. Raw: `a0-latency-log.json` (10 turns incl. the queue test), `a0-latency-log-tools.json` (3 genuine tool turns), `a0-peek-log.json`, `a0-steer-log.json`.

- **time-to-first-visible** = wall time from t0 to the byte hitting disk for the first assistant entry containing a `text` **or** `tool_use` block (a `thinking`-only entry does not count as visible — it is not rendered as chat content).
- **t0 proxy = the instant the `/send` POST is issued** (operator-perceived turn start). The gate says "after first token"; **no supermux channel can observe first token.** Overheads inside the proxy, measured: HTTP round-trip 52.7–54.0 ms (n=11), CC status flip idle→active **p50 206 ms / max 236 ms** (n=10), own `user` entry on disk **p50 187 ms** (179–225 ms, n=11). The earliest CC-attributed timestamp in a turn is the first entry's own `timestamp` (+2.5–3.4 s, a completed `thinking` block); the earliest *observed* model output anywhere is the pty at **3.24 s**.
- **Anchor sensitivity (stated so the verdict can't be argued away):** re-anchoring t0 on the most generous available first-token proxy (the 3.24 s pty first-text) leaves text-only at p50 ≈28.2 s (**still FAIL**) and would move tool-heavy to ≈1.2 s (would pass). The verdict is anchor-independent for the text class and anchor-sensitive only for the tool class. The operator-anchored number is the one the UI must satisfy, so the FAIL stands.
- Small-n honesty: n=3–4 per class, so **"p95" is reported as the class max** (nearest-rank p95 = max at this n). Spread within each class is tight (text 30.4–32.8 s; tool 4.33–4.54 s), so the classes separate cleanly even at this n.

### Measured (all numbers from `gate-stats.txt`, computed from the raw logs)

| turn class | n | samples (s) | p50 | p95 (=max) | gate (p50 ≤2s / p95 ≤6s) |
|---|---|---|---|---|---|
| **Text-only, ~800 words, no tools** | 4 | 30.43 / 30.88 / 31.96 / 32.76 | **31.42 s** | **32.76 s** | **FAIL** — 15.7× over p50, 5.5× over p95 |
| **Tool-heavy** (2× Read + Bash, files unseen) | 3 | 4.33 / 4.43 / 4.54 | **4.43 s** | **4.54 s** | **FAIL on p50** (2.2× over); p95 inside budget. First-visible block = `tool_use:Read` |
| Short answer, no tools (from-context) | 3 | 3.66 / 5.15 / 6.63 | 5.15 s | 6.63 s | FAIL — 2.6× over p50, max also over p95 |
| all 10 measured turns | 10 | — | 5.89 s | 32.76 s | FAIL |

### Root cause — a flush-granularity fact, not a slow machine

**The transcript is not appended during generation.** Per-entry write lag (entry's own `timestamp` → byte on disk) is only **105–215 ms** — but that holds *only for the last entry of each flush batch*; everything earlier in the batch waits for the batch. Measured:

- Text turn 1: the `thinking` entry's own ts is **+3.32 s**, it hit disk at **+30.43 s** — **27.1 s late**, flushed together with the `text` entry it shares a message with.
- Tool turn 1: the *entire* tool phase — `tool_use:Read` (ts +2.74 s), `tool_result` (+2.81), `tool_use:Read` (+3.46), `tool_result` (+3.51), `tool_use:Bash` (+4.14), `tool_result` (+4.22) — landed in **one batch at +4.33 s** (write lags 1588 / 1520 / 869 / 825 / 197 / 113 ms), followed by the closing `text` 3.7 s later.

So the flush unit is a **completed assistant message / tool phase**, never a block-as-generated. Plan §1's "block-granularity streaming" premise is true for *shape* (one block per line — §2 above) and **false for time**: nothing is observable until the containing message completes. A transcript-only chat therefore shows a blank turn for the whole generation of any prose-heavy answer.

### What *is* fast enough (the material the fail branch is built from)

| signal | measured | channel |
|---|---|---|
| status flip idle→active ("agent started") | p50 **206 ms**, 127–236 ms (n=10) | existing status watch / SSE |
| own `user` entry (P10 echo confirmation) | p50 **187 ms**, 179–225 ms (n=11) | transcript |
| queued-send receipt (`queue-operation` enqueue) | **158 ms** (§5) | transcript |
| **first model text on the pty** | **3.24 s** (250 ms poll) vs **30.88 s** in the transcript for the *same* turn → transcript adds **+27.6 s** | `GET /peek` |

### Fail branch — exact A3 scope delta (all read-only; no new write path)

1. **P12 "working" receipt row — promoted from optional to required primitive.** Driven by the status flip (206 ms p50), never by the transcript. A3's design addendum owes it a numeric spec (height, tone, elapsed-timer format, motion) + mock fixtures + VR states at 0 s / 5 s / 30 s / >120 s, plus the post-hoc "worked for Ns" collapse when the batch lands.
2. **P13 provisional tail — promoted from "optional peek-derived tail" to required.** A visually distinct, explicitly-unconfirmed block rendered from the pty capture. Costs: (a) **A2 pulls the peek capture channel forward** (`?ansi=1` / `rt.capture_ansi`, a small addition per §3); (b) a **reconciliation spec** — provisional text is *discarded and replaced*, never merged, on the first confirmed entry (measured supersede gap: up to 27.6 s), with a crossfade and no scroll jump; (c) A3 perf/VR gates extend to the swap: no duplicate text, no reflow jump.
3. **The hook overlay becomes load-bearing, not belt-and-braces.** A2's hook EVENTS additions ship inside the A1 read-only slice, so tool activity is visible before the +4.4 s batch. A3 must render receipts overlay-first and reconcile to the transcript under the same discard-on-confirm rule. **Unmeasured in A0: hook→UI latency** (expected ≪1 s, hooks are synchronous curls) — A1 must measure it, because the branch now depends on it.
4. **Receipts-first ordering rule.** When a batch lands, tool receipts render before the closing prose; the closing text is never the first thing that appears.
5. **Explicitly not in scope:** token streaming of any kind, any new write surface, ANSI-in-chat beyond the marked provisional block.

### A1 stop/go — blocking, pre-agreed criteria (plan §7 "if that still reads dead, stop before pixels")

At the end of the A1 dogfood week, with deltas 1–3 present, answer in writing:
- **(a)** something session-specific and non-decorative changes within **1 s** of send — the working row at 206 ms satisfies this mechanically;
- **(b)** mid-turn, the user can tell *what* the agent is doing without opening the terminal (overlay receipts);
- **(c)** the provisional→confirmed supersede does not visibly glitch.

All three hold → A2/A3 proceed as planned. Any of them fails → **stop before pixels**: no A3 design addendum spend, chat stays a receipts-only sidecar behind the flag, terminal remains the default renderer.

---

## 2. Confirmed transcript facts vs plan §2.1 (mismatches = plan edits)

| §2.1 assumption | Verdict | Evidence |
|---|---|---|
| Assistant entries: one content block per line | **SOFT invariant — plan overstates.** 21,431 recent assistant lines → 1 multi-block `[thinking, text]` (2.1.224, fixtured `assistant.jsonl:4`). Parse `content` as a list of N blocks; block-granularity streaming holds ~99.995%, not always. | corpus probe, measured |
| Compaction does not rotate the file; `compact_boundary` inline, `sessionId` unchanged | **CONFIRMED** (2.1.211 fixture). New caveat: `compactMetadata` internals drift across versions (2.1.170 ~70 KB preservedMessages arrays vs 2.1.211 1.5 KB) — never depend on its internals. `hooks.rs:130-136` comment ("compaction forks a fresh jsonl") re-verified wrong in current source; the plan's planned correction stands. | corpus probe + repo read |
| Subagents = separate files `<conv-id>/subagents/agent-<id>.jsonl` + meta.json | **CONFIRMED live on 2.1.231** (fresh Task capture, 8 lines, `isSidechain:true`, `agentId`). Correction: meta.json `model` key is **optional** (absent 2.1.231, present some 2.1.221) — plan lists it as a field; treat as `Option`. | corpus probe, live |
| Top-level type list (12 types) | **INCOMPLETE.** Corpus also contains `agent-name` (1792×), `agent-setting` (1326×), `bridge-session` (100×), `ai-title` (97×). The tolerant `unknown` variant is load-bearing today, not insurance. | corpus probe, counted |
| Single lines up to 950 KB → wire cap | **Consistent, no new max found** (worst fixtured: 482 KB image line, 104 KB tool_result). Cap stays justified. | corpus probe |
| `queue-operation` → P9 | **CONFIRMED + timing settled live** — see §5. | corpus + latency probes |
| (new fact) Key-casing hazards | `session_id` and `sessionId` co-occur on one entry; `toolUseID` (capital ID) inside hook attachments. Parser must not assume one casing. | corpus probe |
| (new fact) Attachment subtypes | `hook_success` (~25% of corpus lines — the PR #55 fix targets exactly this), `hook_additional_context`, `queued_command`, `task_reminder` fixtured; 13 more subtypes located but unfixtured (§6 gaps). | corpus probe |

## 3. Dialog registry fixture set (plan §4.3)

Capture channel ground truth: `GET /peek` is **plain-text only** (`lifecycle.rs:1213`) — §4.4's `?ansi=1` gap confirmed. Interim ANSI exists today: sessions-list `preview_ansi` (last 20 ANSI lines per detector tick, `auto_actions.rs:632-651`); `rt.capture_ansi` exists server-side, so `?ansi=1` is a small A2/A4 addition.

### Act-on families (live-verified fingerprints + key maps)

**Family 1 — Permission dialog.** Pinned **v2.1.227**, Bash variant re-verified structurally identical **v2.1.231**. Three variants captured verbatim (Bash / Write "Create file" / Edit "Edit file" — full text in `scratchpad/a0-dialogs.md`).
- Fingerprint anchor: `Do you want to …?` question + option 1 exactly `1. Yes` + footer `Esc to cancel · Tab to amend`. Discriminators: Bash = title `Bash command` and/or `ctrl+e to explain`; Edit/Write = title `Create file`/`Edit file` + `(shift+tab)` in option 2. ANSI: periwinkle RGB(177,185,249) rule/title/caret, grey(153) digits.
- Dynamic tokens (never fingerprint on): command line, model description line, option-2 dir token (= parent dir of target).
- Verified key map: `Down`/`Up` move caret; `Enter` selects; `Escape` cancels → `⎿ Interrupted · What should Claude do instead?` + composer focus; **digits are impossible today** — `POST /keys {"keys":"1"}` → 400, `KEY_ALLOWLIST` (`lifecycle.rs:1667-1682`, re-verified in source) has no `0-9`; pasting a digit is ignored by the dialog (bracketed paste). `BTab` **acts as option 2 on Edit/Write dialogs** (file written + `⏵⏵ accept edits on` — verified).
- Per-option: **1** executes (verified by artifact presence); **3** and **Esc** cancel without executing (verified by artifact absence); free-text branch is **Esc-then-composer** — no in-dialog free-text row exists on 2.1.227/231. **Bash option 2 ("always allow"): executes, but persistence NOT FOUND** (no rule in `~/.claude.json`, no `.claude/settings.local.json`, `~/.claude/settings.json` unchanged; later subdir command re-prompted — inconclusive) and its side-effect rounds were contaminated by a concurrent client. **Registry v1: options 1/3/Esc act-on everywhere; Edit/Write option 2 act-on (BTab-verified); Bash option 2 deferred** until a clean re-run proves what it persists.

**Family 2 — Plan approval (ExitPlanMode).** Pinned **v2.1.231**. Exactly three options — §4.3 confirmed — but the labels are NOT the plan's phrasing: `1. Yes, and use auto mode` / `2. Yes, manually approve edits` / `3. Tell Claude what to change` (+ sub-hint `shift+tab to approve with this feedback`).
- Fingerprint anchor: `Would you like to proceed?` + option-1 text + option-3 text. CAUTION: question differs from Family 1's by two words — discriminate on option-1 text and/or the teal RGB(72,150,140) section rule (vs Family 1's periwinkle).
- Verified: **1** → `⏵⏵ auto mode on`, execution with **no** permission dialogs; **2** → `⏸ manual mode on`, execution immediately raises Edit permission dialogs; **3** → dismissed, plan re-boxed in scrollback, **still `⏸ plan mode on`**, feedback via normal composer (verified round-trip: dialog re-presented). **Esc: UNVERIFIED** (skipped for interference risk; expected ≈ option 3) — A4 self-test must capture it before the registry maps it.
- Bonus for P5: footer exposes the plan's file path `~/.claude/plans/plan-<slug>.md` — the chat card can read full plan markdown from disk. Footer editor label is dynamic ($VISUAL basename) — never fingerprint.

### Attention-card-only families (could NOT be verified / no stable mapping)

**Family 3 — Trust dialog: NOT live-triggerable on this host (3 attempts, v2.1.231** — every fresh dir booted straight to composer with `hasTrustDialogAccepted:true` auto-written; host has `permissions.defaultMode:"auto"`, onboarding complete; skip mechanism unknown — do not assume the dialog is dead in 2.1.2xx). Only available shape is the repo unit fixture (`lifecycle.rs` `detects_claude_trust_dialog`: `Quick safety check` / `Yes, I trust this folder`), version provenance unknown. **Registry: detection-only, flagged `needs-live-recapture`, Attention-card-only.** (Plan already had it read-only — now with the reason on record.)

**Family 4 — Resume picker: detection-only confirmed structurally.** supermux's own resume path is server-side (`POST /resume` → `claude --resume <id>`, `mod.rs:1241-1290`) — the TUI picker appears only when a human types `/resume`. Live-captured on 2.1.227 (empty + populated states, tokens `Resume session` / `⌕ Search…` / `Type to search`); rows are conversations, no stable option→key mapping exists. Attention-card-only.

### Cross-cutting registry requirements (all live-evidenced)

1. **Digit keys need a server change** (A4): add `0-9` to `KEY_ALLOWLIST` so the registry uses CC's native instant-select — P5's "digits 1..N bound 1:1" depends on it. Until then: `Down×(n−1)` + `Enter`.
2. **Verify-caret-before-send** joins verify-after: concurrent-client races observed twice (terminal client attached, resized 80→52, resolved dialogs before probe keys landed). Re-peek between every navigation key; without it, a mis-send is exactly §4.3's wrong-dismissal hazard.
3. **`POST /mode` is dangerous while a dialog is up**: mode convergence presses `BTab`, and BTab inside a permission dialog **accepts it**. Gate mode-chip actions on no-dialog-visible; treat an unexpected `accept_edits` flip as a possibly-swallowed BTab.
4. **Per-session version pin via boot banner** (running sessions keep old binaries across auto-updates).
5. **Whitespace-normalized token fingerprints only** — options wrap at 52 cols (captured); never full-line equality. The `❯` glyph alone is never a fingerprint (live-confirmed collisions: composer caret, echoed prompts, resume rows, trust fixture).
6. **The selected option writes NOTHING to the JSONL** (and a dialog-induced BTab mode change writes no `permission-mode` entry either, while `POST /mode` does). Chat infers accept (tool_result appears) vs deny/esc (`Interrupted…` shape) and reconciles the mode chip from `SessionView.mode` — §2.7's plan for this is now mandatory, not belt-and-braces.

## 4. Hook + statusline verdicts (plan §2.2/§2.3)

Method note: verified in a throwaway `CLAUDE_CONFIG_DIR` on **both** 2.1.227 (pinned binary) and 2.1.231; payload shapes identical. Raw logs: `scratchpad/logs-2.1.227/`, `logs-2.1.231/`.

- **`PermissionRequest`: CONFIRMED** — fires when the dialog displays, before any decision; carries `tool_name`, `tool_input`, `permission_mode`, `permission_suggestions`, `prompt_id`. **Inertness confirmed**: exit-0/no-stdout entry does not auto-decide — the plan's trigger-only global entry (§2.2 item 3) is safe as designed.
- **`PostToolUseFailure`: CONFIRMED** — adds `tool_use_id`, `error` (plain string), `is_interrupt`, `duration_ms`. The `hooks.rs:171-174` "no such event" comment is wrong (re-verified in source); §2.2 item 2 proceeds.
- **Statusline fields**: `context_window.used_percentage` ✓ (int; + full token breakdown), `cost.total_cost_usd` ✓, `model` ✓ **but an object** `{id, display_name}` not a string. **`permission_mode` is ABSENT on both versions** (checked full key set, incl. immediately after a shift+tab that did re-fire the statusline) — **plan §2.3 is wrong on this field**; mode comes from hook payloads (present in every hook stdin) + `SessionView.mode`. `git.branch` **UNVERIFIED** (probe cwd wasn't a git repo; no `git` key appeared — presence in a repo untested). Bonus fields worth surfacing later: `version` (the capture pin), `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, `session_name`, `exceeds_200k_tokens`.
- **Cadence**: event-driven, NOT periodic, NOT per-token — startup / submit / API boundaries / tool events / mode toggle; a 35 s streaming turn fired exactly ONE mid-turn invocation; min gap ~2.0 s; zero while idle. Statusline = per-turn granularity for the header pill; **never a liveness signal** (and per §1, never the fail-branch live layer either).
- **Chaining shape (the §2.3 "fase A0 verifies")**: `statusLine` is a **single global top-level object slot** `{"type":"command","command":"…","padding":0}` — no array, no chaining. Wrap-don't-clobber contract: recognize only `type=="command"` (else refuse, per plan); mutate only `command`, preserve `padding` + unknown keys verbatim; wrapper tees stdin to the supermux tap, pipes the same stdin to the original, passes original stdout through unchanged (first line = rendered status, ANSI ok); marker + embedded original ⇒ idempotent install, exact uninstall. `padding` semantics not live-tested; nonzero exit hides the line.
- **Quick-win shipped**: **PR #55** (`fix/hook-stdout-noise`, commit b52121b, worktree `/opt/projects/supermux-hook-noise` left for review) — `-o /dev/null` on the hook curl + shape-pin test; `cargo test claude_config` 9/9. Verified OPEN, not merged (per the user-reviews-all-merges rule). Kills the ~25% `hook_success` context noise.

## 5. Mid-turn queue semantics → the §3 decision: **`/send`** (decided)

**Decision: the chat composer's mid-turn send uses `POST /send` (CC's own queue). `/steer` is NOT exposed in the composer.** Both paths were measured live mid-turn on `spike-a0-latency`; plan §3's open question and §19 Q1 are closed.

### `/send` mid-turn — CC queues it and records the receipt at SUBMIT (measured)

Sent 6.0 s into a running ~27 s text turn (`a0-latency-log.json`, turn `queue_second`):

| moment | evidence | timing |
|---|---|---|
| submit | `{"type":"queue-operation","operation":"enqueue","timestamp":…,"sessionId":…,"content":"<full prompt text>"}` on disk | **+158 ms** after the POST (entry ts +53 ms, write lag 105 ms) |
| running turn unaffected | main turn's assistant `text` completes normally | ts +26.81 s |
| consumption | `{"type":"queue-operation","operation":"dequeue","timestamp":…,"sessionId":…}` | ts +26.91 s |
| promotion | the real `user` entry with the same text | ts +26.92 s |
| queued turn answers | assistant `text` | +29.70 s |

Two consequences the plan must encode:

- **The enqueue is transcript-backed within ~160 ms — while the assistant message for the running turn is still unflushed.** The transcript file *is* appended mid-turn for queue ops; only assistant messages are batched (§1). So a P9 queued pill is real state, not an optimistic guess: the local optimistic store in plan §3 covers ~160 ms and stays only as the delivery watchdog's backing, not as the primary source.
- **`dequeue` carries no `content` and no id** (138 B: `operation`/`timestamp`/`sessionId` only — verified on the raw lines). A pill therefore **cannot** be matched to its dequeue by payload: match enqueue→consumption by FIFO order, and confirm the promotion against the `user` entry's text. `remove` also exists as a third operation (fixtured in the corpus) — that is the cancel-a-queued-prompt path P9 needs.

### `/steer` — supermux-side queue, invisible to the transcript, boundary-delivered (measured + source-verified)

Same test shape, `POST /api/sessions/{name}/steer` 5.0 s into a running turn (`a0-steer-log.json`):

- `GET /steer` shows it **2.3 ms** later (`{"id":47,"queued_at":…,"text":…}`) — but **zero transcript entries**: no `queue-operation`, nothing at all until delivery.
- The main turn's assistant lines flush at +26.93 s; the queue drains at **+28.07 s** and the text lands as a plain `user` entry at **+28.10 s** — **23.1 s after the operator's action**, indistinguishable in the transcript from a normal send.
- Source (`server/src/sessions/steering/deliver_loop.rs`, re-read): delivery fires only on a transition **into `waiting`/`idle`**, **one message per boundary**, **at-most-once** (the row is deleted inside the pop transaction — a failed `send_text` drops the message), with a **60 s safety tick** for the case where the text is queued while the session is *already* idle.

### Why `/send`

1. **Terminal parity** — identical to what a human at the TUI gets; one queue, one order, visible in both renderers.
2. **A visible receipt in 160 ms** vs *nothing* for `/steer`; with §1's fail branch, a send that produces no visible state for 23 s is exactly the "send vanishes into a modal/queue" risk in plan §8.
3. **Ordering + cancel** are CC's (`enqueue`/`dequeue`/`remove`); `/steer` gives one-per-boundary drip and at-most-once loss.
4. `/steer` keeps its actual job: server-side, fire-and-forget dispatch where no one is watching the screen (board dispatch, agent→agent, scheduler). **No composer exposure** — it would put two competing queues behind one text box.

**Still required with `/send`:** the P10 delivery watchdog. The enqueue proves CC accepted the text, not that it will run; and a send issued while a **permission dialog is open was not tested in A0** (§3 gates dialog-time actions) — undelivered stays a first-class visible state.

## 6. Fixture corpus — coverage + gaps

**Deliverable:** `scratchpad/a0-fixtures/` — 9 fixture .jsonl files + `subagents/` pair + README, 41 anonymized lines, checker-verified 41/41 (structure-preserving deterministic anonymizer; byte-for-byte regeneration proof; forbidden-substring privacy scan clean). Repo-ready for A2's `parser.rs` fixture tests. Private source mapping (`a0-fixture-sources.json`) stays out of the repo. Sources span 2.1.211 → 2.1.231; per-entry `version` verbatim.

**Covered** (source-verified): assistant thinking/text/tool_use single-block + the rare multi-block `[thinking,text]`; user string + block-list; tool_result normal + 104 KB wire-cap case; 482 KB base64 image (user-side); queue-operation enqueue/dequeue/remove; mode + permission-mode; system compact_boundary / local_command / stop_hook_summary / turn_duration; custom-title / last-prompt / pr-link; bonus meta types agent-name / ai-title / agent-setting / bridge-session; attachment hook_success / hook_additional_context / queued_command / task_reminder; file-history-snapshot (both shapes) + delta; fresh 2.1.231 subagent file + meta.json.

**Gaps (explicit):**
- 13 attachment subtypes located in corpus but NOT fixtured (scope cut): `file`, `edited_text_file`, `skill_listing`, `deferred_tools_delta`, `agent_listing_delta`, `mcp_instructions_delta`, `compact_file_reference`, `date_change`, `read_truncation_notice`, `invoked_skills`, `hook_system_message`, `command_permissions`, `workflow_keyword_request`; system subtypes `agents_killed` / `model_refusal_fallback` / `scheduled_task_fire` likewise. All render via the `unknown`/neutral path until fixtured.
- Assistant-side `image` blocks: never observed in corpus — unverified whether they occur.
- Trust-dialog capture: missing (not triggerable — §3).
- No 2.1.227-specific subagent fixture existed on disk (2.1.224 was newest historical; the live capture is 2.1.231) — acceptable given per-version re-verification keys on entry `version`.

## 7. Plan edits required (section → exact change)

1. **§1 (latency note) + §2.1 bullet 1**: replace "one content block per line … never mixed" with "one block per line is the *typical* case (1 multi-block in 21,431 measured); parser treats `content` as a list of N blocks; streaming granularity is per-line flush". Update §1's gate note with the measured numbers from §1 of this doc.
2. **§2.1 type list**: add `agent-name`, `agent-setting`, `bridge-session`, `ai-title` to the known-types list; note `unknown` is exercised by real corpus today.
3. **§2.1 subagent bullet**: mark meta.json `model` optional.
4. **§2.1 (new bullet)**: key-casing hazards — `session_id`/`sessionId` co-occur; `toolUseID` capitalization inside hook attachments; parser must tolerate both.
5. **§2.1 compaction bullet**: add "never depend on `compactMetadata` internals (shape drifts 2.1.170→2.1.211)".
6. **§2.2**: record both hook payloads as confirmed (shapes in `a0-hooks-statusline.md`); note `PermissionRequest` carries `permission_mode` — it becomes the mode source (see edit 7).
7. **§2.3**: strike `permission_mode` from the statusline field list (absent on 2.1.227/231); mode sources = hook payloads + `SessionView.mode`. Note `model` is an object `{id, display_name}`. Mark `git.branch` unverified-in-repo. Add cadence facts (event-driven, ~1 fire mid-turn, never liveness). Record the single-object-slot chaining shape + wrap contract (§4 above).
8. **§3 mid-turn bullet + §19 Q1**: decision recorded — **`/send`**; delete the open question (see §5).
9. **§4.3**: (a) version pin = per-session boot banner, not `claude --version`; (b) add verify-caret-*before*-send to the registry entry contract; (c) plan-approval option labels corrected to the real 2.1.231 strings; (d) registry act-on nuance: Bash option-2 deferred pending persistence verification, plan-dialog Esc unverified pending A4 self-test capture; (e) note digits require the A4 `KEY_ALLOWLIST` change — until then Down×n+Enter.
10. **§3/§2.7 (mode chip)**: gate `POST /mode` (and the chip UI) on no-dialog-visible — BTab-swallow hazard is live-verified. Dialog outcomes write nothing to the transcript; outcome inference (tool_result vs `Interrupted…`) + `SessionView.mode` reconciliation is mandatory.
11. **§4.4**: confirmed `?ansi=1` does not exist (peek is plain-text, `lifecycle.rs:1213`); note the interim channel (`preview_ansi`, 20 lines/tick) for fingerprint color checks until `?ansi=1` ships in A2/A4.
12. **§7 Fase A0 gate paragraph**: record the verdict from §1 (numbers + proxy), activate the fail branch in A3's scope, and add the A1 stop/go checkpoint (§1 below spells out the A3 scope delta).
13. **P5 spec (§4.2)**: the "free-text row" maps to **Esc-then-composer** for the permission family (no in-dialog free-text exists) and to **option 3 → composer** for plan approval; the P5 card should also read the plan file path from the footer for full-markdown rendering.
14. **§2.6 geometry**: strengthen the rationale — at 52 cols dialog options wrap (live-captured); the ≥40-col floor is a *fingerprint* hazard, not just cosmetic; default 120×40 stands.

## 8. Open items for the owner

Everything else in this document is decided and evidenced. These need the owner.

1. **GATE FAILED → go/no-go (the only real decision here).** Transcript-only chat cannot be alive: a long prose turn shows nothing for ~31 s (§1). Options: **(a)** proceed to A1 with the fail branch — working row + hook-driven receipts + marked provisional peek tail — and treat the A1 stop/go criteria (§1) as a genuine stop, not a formality; cost = A2 pulls the peek capture channel + hook EVENTS forward, A3 gains two required primitives (P12/P13) and a reconciliation/perf gate. **(b)** Stop Track A's chat renderer now and keep the terminal as the only renderer. Recommendation: **(a)**, because every ≤1 s signal the branch needs is already measured live (206 ms status flip, 3.24 s pty text, 158 ms queue receipt) — but note (a) means A1 ships *receipts*, and the plan's implicit "chat shows what the agent says, as it says it" is off the table for CC 2.1.2xx.
2. **PR #55 is open and unmerged** (`fix/hook-stdout-noise`, worktree `/opt/projects/supermux-hook-noise`) — needs owner review/merge per the review rule. It is the ~25% context-noise fix; A2's parser work benefits immediately.
3. **A2 will write into your live `~/.claude/settings.json`** to install the statusline wrap (§4). A0 only ever touched a throwaway `CLAUDE_CONFIG_DIR`. Explicit consent needed before the tap goes on this machine, plus a decision on whether the installer is opt-in per host or automatic.
4. **`KEY_ALLOWLIST` widening to `0-9`** (A4, §3 item 1) enlarges a REST-reachable key surface on every session. Needed for native digit-select in the dialog registry; `Down×(n−1)+Enter` works without it. Owner sign-off (or an explicit "keep it narrow").
5. **Three captures are deferred, not failed** — Bash permission option-2 *persistence* (contaminated round, no rule found on disk), plan-dialog **Esc** (skipped for interference risk), and the **trust dialog** (not triggerable on this host at all — needs a clean user/host). Decide: allocate a clean-host slot before A4, or ship registry v1 without those act-ons (Attention-card-only for trust, `Down`+`Enter` for the rest). Nothing downstream is blocked either way.
6. **CC version churn policy.** The CLI moved 2.1.227 → 2.1.231 *during* A0, and running sessions keep their boot binary. The dialog registry is version-pinned per session; someone has to own re-verification on each CC bump (cadence, who runs the A4 self-test, what happens to a session pinned to a version the registry no longer covers — hard-disable is the current design).

*Housekeeping (done, no action):* all `spike-a0-*` sessions archived + purged after the final measurements; every evidence log referenced in the appendix is retained under `scratchpad/`.

---

### Appendix — evidence index

- Latency/gate: `scratchpad/a0-latency-log.json` (10 turns incl. the `/send` queue test), `a0-latency-log-tools.json` (3 genuine tool turns), `a0-peek-log.json` (pty-vs-transcript), `a0-steer-log.json` (`/steer` semantics); tooling `probe.py` + `probe2.py`/`probe3.py`/`probe4.py`/`probe5.py`, `analyze.py`/`analyze_tools.py`, computed stats `gate-stats.txt`, per-turn line dumps `analysis.txt` / `analysis-tools.txt`. Session `spike-a0-latency` archived + purged after the run.
- Dialogs: `scratchpad/a0-dialogs.md` (verbatim captures all families).
- Hooks/statusline: `scratchpad/a0-hooks-statusline.md` + `logs-2.1.227/`, `logs-2.1.231/` (raw stdin captures). PR: https://github.com/sanderbz/supermux/pull/55.
- Corpus: `scratchpad/a0-fixtures/` (deliverable), `a0-fixtures.md` (method + coverage), `a0-fixture-gen.py` / `a0-fixture-check.py`, `a0-fixture-sources.json` (PRIVATE — never check in).
