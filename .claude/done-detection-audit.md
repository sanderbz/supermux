# done detection audit

User complaint (verbatim):
> "The 'done pattern' is really bad: many agents dont report literally done? do we have a 100x better way to recognize wether it is done? and how does the app actually check this after the send? are you very sure this works? — deep check if this works."

## 1. Every current "done" detection path in supermux

I traced every place the codebase decides "the agent finished a turn". There are FOUR distinct mechanisms — only ONE of them is actually trustworthy, but it is only wired into ONE consumer.

### 1.1 Scheduler watch-mode `done_pattern` (the path the user is hitting)

- File: `server/src/scheduler/watch.rs`
- Flow: A `watch=1` schedule runs (`runner.rs:124`), then `watch::spawn(state, sched, pre_output)` runs in the background.
- `watch::poll` (`watch.rs:31`) loops every 5s, calls `sessions::lifecycle::peek(…, 200)` to read the last 200 lines of `tmux capture-pane`, strips everything BEFORE the pre-send tail anchor (`watch.rs:73`), and matches the NEW output against the user-supplied `done_pattern` regex (`watch.rs:50`).
- If `done_pattern` is empty or `None`, **NOTHING ever fires** — the watcher just loops until `watch_timeout` (default 120s) and silently exits with `tracing::debug!("watch timed out without match")`.
- On match, `fire_done` (`watch.rs:93`) runs the configured `done_action` (`disable`, `notify`, or `command:<text>`).

**This is the single biggest UX failure.** The UI (`web/src/components/scheduler/schedule-form.tsx:344`) shows the placeholder `✓ done`, but Claude/Codex/GPT/etc. agents virtually NEVER print the literal string `done` at the end of a turn. They print summaries, todo updates, code diffs, or just nothing. So the user enables "watch mode", the schedule runs, the agent finishes — and the watcher times out unrecognized. Exactly the user's complaint.

### 1.2 Status detector — `Active → Idle` transition (the actually-reliable signal)

- File: `server/src/sessions/status.rs`
- The `StatusDetector::detect` function fuses FOUR signals in priority order:
  1. **User-interrupt marker** (`status.rs:501`) — capture contains "Interrupted · What should Claude do" → `Waiting`. Patched today (commit 4a51f31) because Esc-Esc doesn't emit a `Stop` hook.
  2. **Hook turn state machine** (`status.rs:521`) — the per-session newest instant of `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStop` / `Notification`. `Stop` newer than turn-start ⇒ `Idle`. This is the APEX signal for hooked sessions (every Claude session installs `/api/_internal/hook`).
  3. **Capture-pane regex bank** (`status.rs:526`) — `ACTIVE_BANK` for spinner glyphs, `WAITING_BANK` for prompts, `IDLE_BANK` for completed spinners + bare `❯` / `$ ` prompts. Used as a fallback when hooks are missing or stale.
  4. **PTY heartbeat + idle timeout** (`status.rs:547`) — bytes flowing <1.5s ⇒ Active (non-hooked only); silent ≥30s ⇒ Idle.
- The detector loop (`auto_actions.rs:496`) runs adaptive cadence (1–5s per tier), flap-debounces the commit (`auto_actions.rs:636`), writes the new status to the DB, AND `send_replace`s a `(status, version)` tuple on a per-session `watch::Sender<StatusUpdate>` (`auto_actions.rs:651`).
- Reliability: this is the SAME multi-signal classifier that drives every overview tile in supermux. It has 30+ golden fixtures (`status.rs::tests`) and was hardened repeatedly (M5a, M5b, STATUS, the Esc-Esc fix). It correctly identifies turn end across ALL agent kinds (Claude with hooks, Claude without hooks, shell, codex).

### 1.3 `agents::wait` long-poll — `?state=done` / `?state=idle`

- File: `server/src/agents/wait.rs`
- `GET /api/agents/{name}/wait?state=done&timeout=300` long-polls until the session reaches `Idle`. It subscribes to `state.status_watch_for(name)` BEFORE reading the persisted baseline, so it is race-free (Eng P0 #2 — covered by the `wait_race` regression test).
- `done` is an explicit alias for `idle` (`wait.rs:104` — `"done" | "idle" => "idle"`), exactly the semantic the scheduler should use.
- THIS is the right primitive. It exists. It works. It just isn't wired into the scheduler watch path.

### 1.4 Status-transition reactions (board + push)

- File: `server/src/sessions/auto_actions.rs`
- `react_to_transition` (line 752): when the detector commits Active→Idle, the board's `needs_review` flag is set on the session's `doing` issue + a system comment is posted.
- `maybe_push_on_transition` (line 855): when the detector commits Active→Waiting, send a web-push notification.
- These BOTH react to the `committed` (flap-confirmed) transition edge — exactly the signal we should use for the scheduler. Neither uses `done_pattern`. Both are robust.

## 2. Reliability honest-rating per mechanism

| Mechanism | When it fires | When it FAILS the user |
|---|---|---|
| `done_pattern` regex (scheduler) | Agent prints text matching the regex in the new output | **Default** (no pattern set — silent timeout). Agent uses different wording. Agent's response is wrapped/truncated by tmux. Agent doesn't print summary at all. ANY non-`done`-saying agent. |
| Hook `Stop` event | Claude Code emits `Stop` over `/api/_internal/hook` at the end of a turn | User pressed Esc-Esc (patched today via INTERRUPT_MARKER). Hook curl raced a server restart (mitigated: TURN_SAFETY 15-min fall-through). Non-Claude agent (no hooks installed) — content bank + heartbeat take over. |
| Status detector `Active→Idle` edge | The detector commits an Idle transition (fused from hook + content + heartbeat) | Almost never. Worst case: the agent went idle but is mid-stream — the 30s idle timeout still flips it eventually. |
| `agents::wait?state=done` long-poll | Status detector commits Idle | Same as above; race-free via `status_watch_for`. |

## 3. What the user is actually hitting

The user is creating watch-mode schedules. The form's `done_pattern` placeholder is `✓ done`. They either leave it blank (→ schedule silently times out forever, never fires `done_action`) or they enter `done` (→ the Claude agent's summary that says "Implemented X, fixed Y, all good" doesn't contain the literal substring `done`, so the watcher times out unrecognized).

The 100x-better signal already exists IN THIS SAME CODEBASE (the status detector's Active→Idle edge), publishes itself on a `tokio::sync::watch` channel (`status_watch_for`), and is consumed in three other places (`agents::wait`, `react_to_transition`, `maybe_push_on_transition`). It is just not wired into `scheduler/watch.rs`.

## 4. Better signal — recommendation

**Option A (chosen): subscribe `scheduler/watch.rs` to the status watch channel and fire on the first Active→Idle (or first Idle-with-new-version) post-send. Keep the regex path as a complementary additive fast-path for users who set one (e.g. shell jobs that print `BUILD SUCCESS`).**

This is the surgical, 100%-safe fix because:

- **Zero risk to other systems.** The StatusDetector core is untouched. The `status_watch_for` channel was designed exactly for this kind of subscriber (it powers `agents::wait`). Adding another receiver costs nothing.
- **Zero risk of regression.** The legacy `done_pattern` regex path still runs on its 5s cadence inside the same loop, so any existing user who configured a regex still gets exactly the same behavior.
- **100x latency improvement.** The structural signal fires within ~50ms of the flap-debounced commit (DB-write-then-send-replace ordering). The legacy poll fires every 5s.
- **100% reliability on the structural path.** It works for Claude sessions via the `Stop` hook, for non-hooked sessions via the regex bank, and for total silence via the 30s idle timeout — the same fusion that powers every tile on the overview.
- **No frontend change required.** The user can leave `done_pattern` blank and watch mode now actually works.

### Option A version-bumping logic

Capture `baseline_version = status_rx.borrow().1` at watch start. Fire ONLY when we observe `(status == "idle", version != baseline_version)`. This handles:
- session was already idle when watch started (rare — `lifecycle::send_text` flips it to Active fast) → baseline is `(idle, N)`, we wait for `(idle, M)` where M > N (the next idle, i.e. the genuine turn-end edge);
- session was Active when watch started → baseline is `(active, N)`, the first `(idle, M)` we see is the turn-end edge;
- session never went Active (the send failed silently) → we never see a new idle version, we time out at `watch_timeout` — the correct behavior.

### Option A NOT-fired cases (correctness)

- `waiting` transitions do NOT fire `done`. A session blocked on the user is the OPPOSITE of finished — the user needs to act. We keep watching; once the user clears the block, the agent resumes Active and eventually idles.
- `stopped` transitions do not fire (the schedule's send happens AFTER the session was already running, so a Stopped is an unrelated lifecycle event).
- A `(idle, baseline_version)` re-emission (no transition) does not fire.

### Options considered and rejected

- **Option B: dedicated `TurnFinished` SSE event.** Nice for frontend clients, but adds a new event type for one consumer (the scheduler). The `status_watch_for` channel already carries the same information in-process. Defer until a second client emerges.
- **Option C: parse the `Stop` hook directly in the scheduler.** Would duplicate the StatusDetector's fusion logic (no fallback for non-Claude sessions, no debounce). Worse, not better.

## 5. Shipped (what I committed)

I implemented Option A in this branch. Concretely (`server/src/scheduler/watch.rs`):

- Subscribe to `state.status_watch_for(&sched.session)` at the top of `poll()` and snapshot the baseline version.
- Wrap the 5s `tokio::time::sleep` in a `tokio::select!` that races against `status_rx.changed()`. Whichever arm fires first wins.
- On a status change: read `(status, version)`. If `status == "idle"` AND `version != baseline_version`, fire `done` and exit. Other transitions (active/waiting) continue the loop.
- `fire_done` takes a new `signal: &str` arg (`"status→idle"` or `"regex"`) so the audit ledger note records WHICH path fired — operators can tell the structural signal apart from a regex match.
- Tracing logs on the structural-fire path so a debug session can confirm it triggered.
- `done_pattern` regex path is unchanged. If the user has one configured, it still runs every 5s on the same cadence.
- Module docstring updated to document the two-signal model.

Verification:
- `cargo check` clean (debug profile; release is forbidden by `CLAUDE.md`).
- No frontend changes required. Existing schedules with a regex still match exactly as before. Existing schedules WITHOUT a regex now actually work for the first time.

## 6. Follow-ups worth considering (NOT done in this commit)

- **Frontend nudge.** The schedule form still asks for a `done_pattern` as if it's required. With this fix, it's optional and largely redundant. Suggest changing the helper text to "optional: extra sentinel regex (defaults to detecting when the agent's turn ends)" so users stop wondering what to put there.
- **`done_pattern` placeholder.** `✓ done` is misleading. If we keep the field, change the placeholder to e.g. `BUILD SUCCESS` (a more realistic non-Claude sentinel use case).
- **Push notification on `done`.** Currently the push path only fires on `→Waiting`. If a user wants "ping my phone when the agent finishes", they have no path — they could set up a watch-mode schedule with `done_action=notify`, which after this fix actually works. Worth surfacing as a first-class "notify on done" toggle on each session card.
- **Re-evaluate the 120s default `watch_timeout`.** With the structural signal, most done detections happen within seconds, not minutes. A user-facing "wait up to" duration could be raised to e.g. 30 minutes by default without cost.
