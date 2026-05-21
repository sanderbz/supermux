# Eng-Manager Review of TECH_PLAN.md

Reviewer: eng-mgr lens. Read TECH_PLAN.md (1993 lines), amux-feature-extract.md, cmux-amux-landscape.md.

## Verdict

**NEEDS-REVISION** (architecture confidence: 7/10)

The bones are right. Rust + axum + sqlx + xterm.js is boring-by-default in the best sense, the module boundaries in §2 are clean, and the multi-signal status detector in §3.6 is the correct response to cmux #1027. But there are five concrete failure paths that will bite in production and three milestone-graph errors that will cause merge conflicts. Fix them before M0 ships and this becomes LGTM.

The plan is implementable. It is not yet executable without ambiguity — several subagent prompts in §10 reference things not defined in §3 (delegations table, audit_log table, kbd_groups storage strategy, AMUX3_AUTH_TOKEN escape hatch behavior on hook auth). A subagent will guess, and the guesses will diverge.

## What's solid

1. **Status detector multi-signal fusion (§3.6).** Hook > regex > pty heartbeat > timeout is the correct precedence — hooks are ground truth, regex is what cmux relies on alone (and got wrong), pty heartbeat catches the spinner-only states the regex misses. Golden fixtures with insta snapshots is the right test shape. This is the single most important reliability bet in v3 and it's well-specified.

2. **Per-session pty fan-out with broadcast::Sender + Lagged-as-close-1013 (§3.2.7, §3.2.9).** The "subscriber too slow → close 1013, never block fan-out" rule is exactly right. Single bytes-channel per session, never blocks the reader, slow consumers self-evict. This is the v2 streamer pattern done correctly in tokio.

3. **Atomic claim via single UPDATE ... RETURNING (§3.2.10).** No transaction needed because SQLite serializes writes. This is the right idiom and the 100-concurrent-callers test in M6 will prove it.

4. **WAL + NORMAL + FK ON (§3.2.4).** Boring pragmas, correct defaults. 5× over FULL with no real durability cost on a single-host app.

5. **Single Rust binary with embedded frontend via include_dir! (§1.5, §8).** Distribution moat preserved from v2's "one file" story. systemd + Tailscale cert + side-by-side coexistence on a different port is the boring deploy that actually works on day one.

6. **`wait` primitive as long-poll + tokio::sync::Notify (§3.7).** Correct primitive choice. Notify with select! against a deadline is the textbook async-Rust pattern. Race semantics analyzed below.

## Architecture concerns (ranked by risk × likelihood)

### 1. [P0] Pipe-pane + FIFO can permanently stall the fan-out on writer reopen — silent data loss (§3.2.7)

The reader task pseudocode says: "on Ok(0) → re-open fifo." That's right for the steady state. But there are two gaps:

- **FIFO write end opens AFTER reader.** If amux-server starts the reader task before `tmux pipe-pane` has actually opened the FIFO for writing, the reader's `open(O_RDONLY)` blocks until a writer appears. `tokio::fs::File::open` calls a blocking `open(2)` under the hood — that blocks a tokio worker thread, not just the task. Spec mandates non-blocking open `O_RDONLY | O_NONBLOCK` and then `EAGAIN` handling, or opening read-write (a Linux trick that satisfies the kernel's "needs a writer" check). Without this, a stale-FIFO scenario can wedge a worker thread.

- **`Ok(0)` ≠ writer closed** when reading with `O_NONBLOCK`. With NONBLOCK you get `EAGAIN` instead, and you have to register the fd with mio/epoll to wake on POLLIN. tokio's `AsyncFd` is the standard pattern. The "re-open fifo" recovery path is fine for a true EOF (when tmux truly drops the pipe), but if NONBLOCK isn't set you can deadlock the worker; if it is, you need AsyncFd.

**Fix**: §3.2.7 should specify `nix::fcntl::open(path, O_RDONLY | O_NONBLOCK)` + wrap in `tokio::io::unix::AsyncFd`. Also: between pipe-pane invocation and FIFO open, race-check that the pipe-pane process exited 0; if not, retry pipe-pane (this is the v2 "idempotent" requirement). Add an integration test in `server/tests/pty_recovery.rs`: stop tmux, restart it, verify the reader recovers without server restart.

### 2. [P0] Status notify race: notify-before-subscribe loses the transition (§3.7)

The wait handler does:
```
1. read current_status
2. if matches → return
3. else compute remaining timeout
4. select! on (notify.notified(), sleep(remaining))
```

Race window: between step 1's `read current_status` and step 4's `notify.notified()` registration, the detector task can fire `notify_waiters()`. The subscriber wasn't registered yet, so the notification is lost. tokio's `Notify` *does* set a permit when notify_one() is called with no waiters — but `notify_waiters()` does NOT. It explicitly wakes only current waiters and drops the event. The plan says the detector calls `notify_waiters()`. So in the race, the wait handler then `.notified().await`s and blocks until the next state change.

This is not theoretical: between an HTTP handler launch and the first `await`, tokio can context-switch and run the detector task once.

**Fix**: either (a) acquire the notified future before reading status (`let n = notify.notified(); tokio::pin!(n); let cur = read(); if cur == want { return }; select!{ _ = n => …}`), or (b) use a versioned status — `tokio::sync::watch::Sender<(Status, u64)>` — and the wait loop checks if version advanced. (b) is more robust and gives free de-dup. Recommend (b). Update §3.7 to specify `watch::Sender` per session in AppState; remove `Notify` from this path.

### 3. [P1] Hook endpoint auth model is undefined and probably broken (§3.6)

The plan says `/api/_internal/hook` is "auth required, but session can call via its own AMUX_TOKEN." Two problems:

- The bearer token in `~/.amux-v3/auth_token` is ONE token shared by all sessions and the dashboard. If a session's `~/.claude/settings.json` is `cat`-able by another local user (or by a captured session whose work_dir leaked), the dashboard's bearer token is leaked. The Claude hook setup writes that token into the user's home dir in plain text inside a JSON file Claude itself reads. If the dashboard token also goes there, you've spread your master key.

- The hook fires via `curl --max-time 1` — what's the failure mode when amux-server is restarting or unreachable? Hook commands that fail can block Claude's tool execution depending on hook config. §3.6 hook spec needs `"abort_on_error": false` (or whatever the Claude hook key is) so a 500 from amux doesn't break Claude.

**Fix**: §3.6 should specify a **per-session hook token**, separate from the dashboard bearer token, stored in `session_runtime.hook_token` (random per session at create time), scoped *only* to `/api/_internal/hook` with the session name from the URL path validated against the token. Add a §6.x sub-section "Hook auth" with this design. Also: explicitly state that hook failures MUST be non-blocking on the Claude side (set the hook's `blocking: false` or equivalent), and document the curl invocation with a fail-silently flag.

### 4. [P1] Subscriber-too-slow → close 1013 will boot the UI on a slow tab; no degraded mode (§3.2.9)

Broadcast channel capacity = 256. A 256-message lag is roughly 256 × 8KB = 2MB of pty data. On mobile Safari backgrounded, this fills in under 5 seconds during a chatty agent. The plan closes that subscriber with 1013, marks 1013 as PERMANENT in §4.5, and shows "Tap to retry" — meaning the mobile user comes back to the foreground and sees a dead terminal that they have to manually re-trigger.

This is the opposite of the Termius "reconnect banner morphs amber → green" promise. The status banner spec in M23 will quietly mask a UX cliff.

**Fix**: 1013 should be treated as **temporarily permanent**: the client doesn't auto-reconnect on a tight backoff, but reload on `visibilitychange → visible` is allowed AND the reconnect should be silent (the WS reconnects, replay buffer paints, banner goes green). Update §4.5: change the "permanent" set so 1013 triggers a one-shot reload on next visibility-visible, with a small ≥2s debounce. Add an integration test where the WS subscriber is artificially slowed to overflow, verify the recovery loop completes within 3s of foregrounding.

Secondary: capacity 256 may be too small for the most chatty agents. Make it config-driven in `config.toml` so we can tune in production without a rebuild.

### 5. [P1] Reconnect storm when the server restarts during a Tailscale handoff (§3.2 + §4.5)

Frontend reconnect: 300ms × 2^n cap 30s. No jitter mentioned (Risk #9 says "jitter ±20%, later"). If 8 tabs are open on one machine across two browsers, all reconnect attempts align. Worse: SSE has the same backoff in §M12 (`use-sse.ts`). On server restart all SSE streams reconnect together, fetch `/api/sessions` and `/api/board` in parallel through the same `useSse` effect, and trample sqlx's 8-connection pool.

This is a `tokio::time::sleep` away from being fine.

**Fix**: §4.5 and §M12 should add jitter on day one, not later. `delay = base * 2^n; delay = delay/2 + random(delay)` (decorrelated jitter). Cap the sqlx pool to 8 but add a `Semaphore(16)` around handler bodies that serve list endpoints so a stampede self-limits. Also: `/api/sessions` returns the same cached value the SSE feed broadcasts — back the HTTP handler with the same broadcast or cache so it's free under load.

### 6. [P2] sqlx compile-time queries vs CI without a real DB (Risk #7, but the mitigation is wrong)

The plan says "use `cargo sqlx prepare` to write .sqlx/query-*.json files into the repo; CI runs offline mode." This works, but it means **every PR that touches a query must regenerate the prepared metadata**, and a subagent that adds a query will commit code that builds locally (because their local pool exists) but fails CI (because their .sqlx didn't update). This is the #1 sqlx footgun.

**Fix**: add a `pre-commit` hook (or a CI check that runs `cargo sqlx prepare --check`) so any unchecked-in metadata fails immediately. Document this in §M1's subagent prompt explicitly. Also: pin sqlx-cli version in CI to match the `sqlx` crate dependency — version skew rewrites all metadata files and creates merge hell.

### 7. [P2] Tokio worker exhaustion from blocking tmux invocations

Every tmux call is `tokio::process::Command::new("tmux").args(...)`. tokio spawns these without blocking workers, but the process spawn itself can take 10-30ms on a busy box (fork/exec). With 20 sessions and a 2s status loop that calls `capture-pane` on each, plus YOLO loop (3s), rate-limit loop (3s), compact loop (60s), the box is doing ~30 tmux spawns/sec at baseline. Add a chatty user typing in the focus terminal and a scheduler firing, and the multi-thread runtime can become tmux-spawn-bound.

The §3.2.6 Tmux struct shells out for every operation. There's no caching, no batching, no in-process tmux client.

**Fix**: either (a) use `tmux -C` (control mode) per session — open one persistent control-mode connection per amux session, send commands over its stdin, parse responses. Replaces N spawns/sec with N fds, one fork per session. (b) batch `capture-pane` calls (run for many sessions in one tmux invocation via `display-message` + `list-windows`). Recommend (a) for sessions you've adopted; cite it explicitly in §3.2.6 as the v3.1 evolution path. For v3.0, at minimum: skip `capture-pane` for status when the FIFO has flowed bytes in the last 2s (the pty heartbeat already says it's active — don't double-pay).

### 8. [P2] Self-contained migrations can't reach v2's data layout

`scripts/migrate-v2.py` (M26) ATTACHes v2's data.db and `INSERT OR IGNORE INTO issues SELECT * FROM old.issues`. v2's schema has columns v3 doesn't (e.g. `gcal_event_id`) and v3 has columns v2 doesn't (e.g. nothing new in issues yet, but the principle holds for sessions where v3 has `created_at`/`task_summary`/`cc_session_name` that may not exist as columns in v2). Bare `SELECT *` will fail or silently drop columns.

**Fix**: M26 prompt should specify column-explicit copies: `INSERT INTO issues (id, title, ...) SELECT id, title, ... FROM old.issues`. Add a dry-run sanity-check that asserts `pragma_table_info(old.X)` is a superset (or close to it) of v3's expected columns and reports diffs.

## Missing invariants / failure paths

| Failure path | What could break | Suggested addition |
|---|---|---|
| FIFO writer (tmux pipe-pane) crashes | reader sits in `re-open fifo` loop forever, no session data | §3.2.7: spec a max-retry then mark session "stream-dead", surface via status |
| Sessions migrated from v2 have no `session_runtime` row | every status query hits NULL on `last_status_at` | §3.3: add `ON CONFLICT DO NOTHING` insert into `session_runtime` whenever a session row is created; M26 should backfill |
| Two amux-servers (v2 + v3) try to `pipe-pane` the same tmux session | `tee` overwrites the v2 fifo or vice-versa, both lose data | §3.5 / §8.4: explicit rule — v3 only attaches to tmux sessions prefixed `amux3-`. v2 keeps `amux-` prefix. Coexistence guarantee. Today the plan says `amux-<name>` for both. |
| Hook curl fires with localhost:8823 but amux-server is bound to a different port via config | every Claude tool use prints curl errors into the UI | §3.6: hook command must read AMUX_URL env var (already injected) — spec this exactly; don't hardcode the port |
| Server restart while a `wait` long-poll is in flight | client gets close, retries, but its `status_notify` is a new one — has it missed transitions? | §3.7: spec that wait handler always reads current status on each iteration (it does), and add explicit test for restart-during-wait |
| Scheduler `next_run` recomputation diverges from `cron::Schedule` rounding | recurring schedule drifts (e.g. fires at 9:00:01 not 9:00:00) | §3.8: spec — `next_run = cron.upcoming(Utc).next()` *not* `now + interval`. Define the rule for "interval-from-now" expressions like "every 5m" — anchored to last fire or to wall-clock 5m boundary? Pick one. |
| Schedule `kind='boot'` with `boot_worktree=true` runs while the parent repo has uncommitted changes | worktree creation fails silently or pollutes the repo | §3.8: spec — boot scheduler must check parent repo cleanliness, log a `schedule_runs` error on failure |
| Status detector restarts and `last_pty_byte_at` is `now()` (no history) | first detector tick after restart classifies every session as "Active" because pty was "recently active" | §3.6: initialize `last_pty_byte_at = Instant::now() - Duration::from_secs(300)` on cold start |
| `archive` writes 50k lines of scrollback synchronously | request blocks for seconds; client times out | §3.2.5: spec — archive runs in `tokio::task::spawn_blocking`, returns 202 with a job id (mirrors v2's stop pool pattern). |
| Steering queue persists across restart but `steering_queue` table not in §3.3 | I see it in 0001_init.sql lines 733-738 — OK | (none — present, just verifying) |

## Schema / API issues

### CHECK constraints

- `sessions.provider IN ('claude', 'codex')` — fine, but v3 may want `'shell'` for testability (M3 subagent prompt mentions "shell" as a test-only provider variant). Either add `'shell'` here or change the M3 prompt to not require schema changes.
- `share_tokens.perms IN (...)` — fine.
- `issues.owner_type IN ('human','agent')` — fine.
- `schedules.kind IN ('tmux','shell','boot')` — fine.
- **Missing CHECK on `schedules.sched_type IN ('once','recurring')`** — add it. The plan says "default 'once'" but doesn't constrain. A typo in a PATCH could land an invalid value.
- **Missing CHECK on `schedules.done_action`** — should be one of `'disable'`, `'notify'`, or `LIKE 'command:%'`. Optional but cheap.
- **Missing CHECK on `session_runtime.last_status`** — should be `IN ('active','waiting','idle','stopped','unknown')`. Forces correctness at the DB layer.

### Missing indices

- **`schedule_runs(schedule_id, ran_at DESC)`** — present, good.
- **`schedules(deleted, enabled, next_run)`** — present, good.
- **`sessions(archived, pinned DESC, last_send DESC)`** — only `pinned, last_send`. Overview filters out archived by default; index should include `archived` first (or a partial index `WHERE archived=0`).
- **`issues(session, status, deleted)`** — present.
- **`steering_queue(session, id)`** — missing. The handler will `SELECT id, text FROM steering_queue WHERE session=? ORDER BY id LIMIT 1`. With many sessions and many queued messages this scans. Add: `CREATE INDEX idx_steering_session ON steering_queue(session, id)`.
- **`tracked_files(session)`** — PK is `(session, path)` so reads by session are covered. OK.
- **`share_tokens(session)`** — missing; `DELETE WHERE session=?` on session delete scans. Add index.

### Missing tables (referenced in §10 but not in §3.3)

- **`delegations`** — M9 subagent prompt says "add a migration `0005_delegations.sql`" with columns `(from, to, prompt, ts)`. Schema not defined in §3.3. Spec it: `id INTEGER PRIMARY KEY AUTOINCREMENT, from_session TEXT NOT NULL, to_session TEXT NOT NULL, prompt TEXT NOT NULL, ts INTEGER NOT NULL, FOREIGN KEY (from_session) REFERENCES sessions(name), FOREIGN KEY (to_session) REFERENCES sessions(name)`. Index on `(from_session, ts DESC)` and `(to_session, ts DESC)`. `from` is a SQL keyword — alias to `from_session`.
- **`audit_log`** — §6.4 promises "every destructive HTTP call writes a row to a NEW `audit_log` table" with columns `(ts, actor, action, target, detail_json)`. Not in migrations. Spec it as `0007_audit.sql`: `id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}'`. Index `(ts DESC)`. Define which routes trigger writes (M22 settings UI reads it; what writes it?).
- **`kbd_groups`** — present in 0004 (lines 862-867), but M16 subagent prompt suggests "OR keep prefs blob-based: store as `prefs[kbd_groups]` JSON." Pick one. If table stays, M9 needs to ship its CRUD endpoints (currently scheduled there per §3.4). If prefs-based, drop the table from 0004. Recommend the table — typed access, easier to reason about, indexable.
- **`alerts`** ring buffer referenced in §3.4 SSE event types but not persisted. v2 keeps it in memory (50 deep). State this explicitly — "alerts are in-process only, lost on restart, not persisted."

### API contract clarity

- **Response envelope**: §3.4 says `{ok: bool, data?: T, error?: string}`. But the SSE event types `{type:"sessions", payload:[...]}` use `payload` not `data`. Two envelopes is a smell. Either harmonize or document the contrast: HTTP uses `data`, SSE uses `payload` because SSE is a stream-of-events, not a request-reply.
- **202 semantics**: `/stop` returns 202 immediately ("stopping"). What does the client see if the stop *fails*? Plan doesn't say. v2 uses a thread pool that just logs. v3 should: emit an `alert` SSE event on stop completion (success or failure) and status should transition `stopped` → `unknown` → `stopped` cleanly. Add to §3.2.5.
- **`/api/_internal/hook`** is in §3.6 but missing from the §3.4 endpoint table. Add it.
- **`/api/audit?limit=200`** referenced in M22 — missing from §3.4. Add it.
- **`/api/health`** referenced in M25 (`curl https://clawd-02.foo.ts.net:8823/api/health`) — undefined elsewhere. Decide: is it `#[public]` (no auth, returns build/version/uptime) or auth-required? Spec it.
- **`/api/sessions/{name}/share`** (GET/POST/DELETE) — present in v2 (`share_tokens` schema is in 0001) but missing from §3.4's "new additions" table and from any milestone. M22 mentions `/api/settings/env` and audit, no share. Either it's in scope (table exists, route needs a milestone) or it's deferred (table is dead code). Pick one. The §13 "Out of scope" mentions "share tokens persist in DB; sharing UI deferred." Then where do the API handlers live? Add a one-liner milestone or explicitly say "no handlers in v3.0."

## Concurrency hazards

### Specific races

1. **Reader task spawn vs first WS subscriber**. `PtyStream::ensure_started` is called from the WS handler (per §3.2.7's "subscribe returns current replay snapshot"). If two WS clients race, both call `ensure_started` and both may try to `mkfifo` and `pipe-pane`. The `DashMap` accessor must use `entry().or_insert_with` with a `tokio::sync::OnceCell` inside, so the spawn-once is enforced. Currently §3.2.7 doesn't spec this. Fix: PtyStream construction goes through `state.streamer.for_session(name)` which returns `Arc<PtyStream>` and `ensure_started` is idempotent and synchronized via `tokio::sync::OnceCell` per session.

2. **Session lock vs status detector**. Status detector runs every 2s on each session, calling `tmux capture-pane`. Send/start/stop hold the per-session lock. `capture-pane` is read-only on tmux — does it need the lock? If not (recommended), state explicitly that the status loop does NOT acquire the lock. If it does, you'll have status-detector starvation under bursty sends.

3. **Steering queue delivery vs new steer POST**. v2 delivers steering "when status becomes waiting or idle." If a POST arrives while the delivery is mid-flight (status snapshot loop iteration), the new message can be delivered same-tick or lost. v2 uses a per-session lock. §3.3 has a `steering_queue` table; §3.2.5 lists `steer` in the API. But where's the delivery loop? Missing from §3.9 task table. Add it: `sessions::steering::deliver_loop`, 60s, single-flight per session per tick, transactional `SELECT id, text ... LIMIT 1; DELETE WHERE id=?` to guarantee exactly-once.

4. **SettingsHook write race**. `claude_config.rs::install_hooks()` writes/merges `~/.claude/settings.json`. If two amux-server processes run (v2 + v3 coexistence in §8.4), both will write to the same file. v2 doesn't write hooks (per feature-extract); v3 does. Still, on user-edited settings.json this read-modify-write loses concurrent edits. Spec: write to `~/.claude/settings.json.amux3-tmp` then `rename(2)` for atomic replace, and merge the hooks under a single `amux3:` key namespace if the schema allows. Document the rule.

5. **`session_locks` map memory leak**. `DashMap<String, Arc<Mutex<()>>>` (per §3.2.5) — entries are added on first lock acquisition but never removed. Deleting a session leaves the lock in the map. Over weeks of session churn this leaks. Add: `session_locks.remove(&name)` in `sessions::delete`.

6. **`status_notify` map same issue**. Same fix.

### Deadlocks

- Status detector holds the session lock (if it does — see hazard 2) AND calls `notify.notify_waiters()`. Wait handler holds `notify.notified()` and queries via `sqlx`. If sqlx pool is exhausted (8 connections), wait handler blocks acquiring a connection. Status detector blocks on lock. Self-deadlock if the same tokio task graph is involved. Unlikely in practice but possible under load — say it explicitly: status detector MUST NOT acquire the session lock for read-only ops, and wait handler must not hold the notify across DB calls.

## Test coverage gaps

§7 lists the right test files but leaves gaps:

- **No test for FIFO reader recovery**. Add `tests/pty_recovery.rs`: kill tmux mid-stream, verify reader recovers within 5s without server restart.
- **No test for status-detector cold start**. After server restart, all sessions should NOT flip to `Active` because pty heartbeat is "now". Add a fixture that simulates a restart and asserts initial status = `Unknown` until either capture-pane confirms or pty bytes flow.
- **No test for `wait` race** (concern #2 above). Spawn 100 wait handlers and one detector tick — assert none get stuck for the wrong reason.
- **No test for subscriber overflow → 1013 → reconnect**. The plan tests "9th gets close 1013" but not "1st-8th lagging by 256 messages gets close 1013, reconnects, gets fresh replay." This is the real bug surface.
- **No test for hook auth model** (concern #3). After this is fixed: assert that a leaked dashboard token cannot call `/api/_internal/hook` for an arbitrary session.
- **No test for scheduler missed-tick recovery**. If amux-server is down for 10 minutes and 3 schedules were due, what fires on restart? v2 fires all immediately (which can be wrong for `kind=shell` — running 3 deploy scripts at once). v3 needs a rule: missed firings within a "catch-up window" (say 60s) fire; older are skipped, logged as `schedule_runs(status='skipped', note='missed window')`. Add this rule to §3.8 and test it.
- **No test for migration column drift**. M26 should round-trip a real v2 dataset, then read every endpoint and assert no 500s.
- **No load test for SSE/HTTP under reconnect storm**. Add a `tests/stress_reconnect.rs`: spawn 50 SSE clients, kill the server, restart, verify all reconnect within 30s without sqlx pool exhaustion errors.
- **Path-safety property test mentioned as "optional"** — make it mandatory. The blocklist is a security boundary; proptest is cheap and catches `..` + symlink + Unicode-normalization shenanigans.
- **Frontend: no test for the LiveTerminal cleanup**. `useLiveTerm` creates an `XTerm.Terminal` and a WebSocket. On rapid session switches (M14: `Cmd+1..9 = jump to N-th session`), is the old terminal disposed? Is the old WS closed? Memory leak risk. Add a Vitest that mounts/unmounts the hook 100 times and asserts WS count returns to 0.

## Milestone dep graph issues

The dep graph in §10 has three problems:

### Issue A: M5 depends on M4 but actually depends on M3 too

§10 says `M5 depends on M3, M4`. Status detector needs `tmux capture-pane` (M3) and pty heartbeat (M4). Correct. But the graph art (§10 dep visual) shows `M5` only off the M4 chain. Cosmetic but a subagent reading the picture vs the prose will get confused. Fix the diagram.

### Issue B: M9 depends on M5 but also on M3 (for delegate's send_text)

M9 includes `delegate.rs::delegate(from, to, prompt)` which "calls `sessions::send_text(to, prompt)`." `send_text` is implemented in M3 (lifecycle). The dep graph shows M9 only off M5. Add M3 dep. Today's prose under M9 doesn't acknowledge this.

### Issue C: M11 depends on M10, then M12 depends on M11, but M12 also needs M2

M12 (overview route) needs `/api/sessions` to actually return sessions, which requires M2. M2 ships the HTTP handler. The graph (`M10 → M11 → M12`) doesn't show this. The graph also doesn't show M12 → M5 (SSE 'status' event types come from M5).

**Merge conflict risks**:

- **M5, M9, M14, M15 all touch `lib/api.ts`** (frontend API client). Each adds new methods. If dispatched in parallel: trivial conflict but many. Fix: M10 should establish the api.ts file structure with stub methods for everything; later milestones fill in implementations. Currently M10 doesn't ship api.ts; M12 implicitly creates it.
- **M5, M9 both touch `agents/` module on backend in parallel** if dispatched concurrently after M3 — yes, M9 deps M5 so they're sequential. OK.
- **M6, M7, M8 all add routes to `http.rs`** in parallel. Each adds `Router::merge(...)`. If three subagents touch `http.rs` simultaneously they will conflict. Fix: M2 should structure `http.rs` as a registry of sub-routers, one per module; M6/M7/M8 add only their own module file plus a one-line registration. Document this in M2's prompt.
- **M16, M17, M18 all touch the dock and accessory bar in parallel.** M16 builds the accessory bar; M17 adds a "Gesture" chip *in* the accessory bar; M18 adds the slash menu *over* the input which lives next to the accessory bar. Three subagents in the same files. Fix: M16's prompt should ship the accessory bar with explicit hook points (e.g., `<AccessoryBar onGestureToggle={...} />` props) so M17 plugs in. M18 stays in `slash-menu/` files. Document the interface in M16's acceptance.
- **M19, M20, M21, M22 are "4-way parallel"** but all read from `useSse` and `useSessions`. If M12 hasn't shipped those hooks, M19-22 each will re-invent them. Hard-block: those hooks must exist as stubs/types before any of M19-22 start. Add as M10 deliverables.

### Other dep oddities

- **M4 depends on M3** (correct: pty needs tmux conventions and lifecycle). But M4's subagent prompt has the streamer creating its own `pipe-pane` call — doubling the v2 pattern. Spec: in M4, the streamer's `ensure_started` calls back into M3's `Tmux::pipe_pane`. Don't reimplement.
- **M24 depends on M11..M23** — fine, but practically M24 can start as soon as M14 (focus desktop) is up: the user journey "open session → type → see output" is fully testable. Splitting M24 into a "smoke" tranche (after M14) and a "completeness" tranche (after M23) means we catch e2e bugs earlier. Recommend splitting.

## Specific edits to TECH_PLAN.md

| § | Edit | Why |
|---|---|---|
| §0 exec summary | Add line: "WebSocket close code 1013 triggers silent reconnect on next visibility-visible, not 'tap to retry'." | Mobile UX integrity |
| §3.2.5 | Add `archive(name) → 202 + spawned blocking task` semantics; spec `delete` removes from `session_locks` map | Avoid memory leak; avoid blocked handler |
| §3.2.7 | Spec FIFO open as `O_RDONLY \| O_NONBLOCK`, wrap in `tokio::io::unix::AsyncFd`; spec `OnceCell` per session for spawn-once | Avoid worker stalls and double-spawn races |
| §3.2.9 | Capacity 256 → make it `config.ws_broadcast_capacity` with default 256, override via `~/.amux-v3/config.toml` | Tunable without rebuild |
| §3.3 | Add CHECK constraints for `schedules.sched_type`, `schedules.done_action`, `session_runtime.last_status`; add index `idx_steering_session`, `idx_share_tokens_session`; add partial index for `sessions(pinned DESC, last_send DESC) WHERE archived=0` | Defense in depth; query perf |
| §3.3 | Add `0005_delegations.sql` and `0007_audit.sql` schemas inline; decide kbd_groups storage (table vs prefs) and remove the alternative | Subagents don't guess |
| §3.4 | Add: `/api/_internal/hook`, `/api/audit?limit=N`, `/api/health` (#[public]), `/api/sessions/{name}/share` GET/POST/DELETE OR an explicit "deferred in v3.0" line | Endpoint table is the API contract |
| §3.4 | Document HTTP vs SSE envelope difference (`data` vs `payload`) | Stop the inevitable confusion |
| §3.5 | Add: "amux v3 uses `amux3-<name>` tmux prefix; v2's `amux-<name>` is read-only-coexist for migration." | Avoid v2+v3 pipe-pane collision |
| §3.6 | Replace single dashboard bearer token for hooks with per-session hook token in `session_runtime.hook_token`. Spec hook command uses `$AMUX_URL` not literal port. Spec hook `blocking: false` (or equivalent) | Auth scope + restart resilience |
| §3.6 | Spec status detector cold-start: `last_pty_byte_at = Instant::now() - 5min` so first tick doesn't mass-classify Active | Avoid false positives on restart |
| §3.7 | Replace `tokio::sync::Notify` with `tokio::sync::watch::Sender<(Status, u64)>` for status broadcast; wait handler observes version | Fix notify-before-subscribe race |
| §3.8 | Spec missed-tick policy: catch-up window 60s; older schedules logged as `skipped` not fired | Define behavior; avoid storm of overdue tmux jobs |
| §3.8 | Spec `next_run` computation: for cron use `Schedule::upcoming(Utc).next()`; for "every Nm" anchor to last fire | Define vs assume |
| §3.9 | Add `sessions::steering::deliver_loop` (60s, single-flight, transactional dequeue) to the task table | Currently missing from the table |
| §3.9 | Add `db::audit_writer` and `cleanup_locks_map` as named tasks | Operational completeness |
| §4.5 | Remove 1013 from the "permanent close codes" set; instead spec "1013 → silent reconnect on next foreground" | Mobile UX fix |
| §4.5 | Backoff includes ±20% jitter from day 1 (not "later") | Avoid restart stampede |
| §4.6 | Spec: TanStack Query = server cache; Zustand = ephemeral UI only. Forbid: SSE event handlers writing to Zustand. Allowed: SSE handlers call `queryClient.setQueryData` | Make the boundary unambiguous |
| §6.4 | Define exactly which routes write audit_log rows. List them. | Subagents won't add audit calls if not told |
| §7.1 | Add tests: pty_recovery, wait_race, subscriber_overflow_recovery, hook_auth_scope, schedule_missed_tick, status_detector_cold_start | Cover the bugs identified above |
| §7.2 | Add Vitest for useLiveTerm mount/unmount cycle (WS count returns to zero) | Memory leak gate |
| §10 dep graph | Fix M5→M3 implicit dep; M9→M3 implicit dep; M12→M2,M5 implicit deps; M19-22→M10 (use-sse, use-sessions exist as stubs in M10) | Avoid subagent ambiguity |
| §10 M0 | Add: `web/src/lib/api.ts` skeleton with typed method stubs for every endpoint (subagents in M12, M14, M19 fill in implementations) | Avoid 4-way merge conflicts on api.ts |
| §10 M2 | `http.rs` MUST expose `pub fn router_for(state) -> Router` per module; root router is `Router::new().merge(sessions::router(state)).merge(board::router(state)) ...`. Each later milestone adds its own module's router only. | Avoid http.rs merge conflicts |
| §10 M16 | Spec accessory-bar hook points (e.g. `onGestureToggle` prop) so M17 doesn't have to edit M16's file | Parallelism integrity |
| §10 M24 | Split into M24a (smoke after M14) and M24b (full after M23) | Catch e2e bugs earlier |
| §12 risk #9 | Move "exp backoff with jitter ±20%" from "(later)" to v3.0 | Day-1 stability |
| §12 | Add risk #11: "FIFO open ordering + tokio blocking semantics" with mitigation per fix #1 | Documented |
| §12 | Add risk #12: "Tmux spawn rate scales linearly with sessions × tasks/sec; v3.1 should migrate status loop to tmux -C control mode" | Operational debt is real |
| §13 OOS | Restate: "share token HTTP API: defer to v3.1" OR explicitly schedule. Today it's schema-only. | No orphan tables |

## Bottom line

This plan is 80% there. The architecture is correct, the technology choices are boring in the best way, and the milestone breakdown is granular enough that subagents can execute it. The status detector with hook + heartbeat + regex fusion is exactly the right answer to cmux #1027 and is the single best technical decision in the doc.

The 20% gap is the gap between "a plan a senior engineer would write to themselves" and "a plan a senior engineer can give to twenty Opus subagents in parallel and trust." The specific holes are:

1. Schema completeness — three tables referenced in §10 (delegations, audit_log, possibly kbd_groups) need their SQL spec inline in §3.3, not invented by a subagent at M9 or M16.
2. Concurrency contracts — five specific races need to be called out: FIFO open, wait/notify, OnceCell on PtyStream spawn, lock-map leak, settings.json read-modify-write.
3. Mobile WebSocket UX — close 1013 as permanent is a Termius-spec violation; needs silent-recover-on-visibility.
4. Hook auth — sharing the dashboard token via `~/.claude/settings.json` is a real exposure path; per-session hook tokens are five lines of code and the right answer.
5. Dep-graph parallelism — three milestones in §10 will hit merge conflicts unless §3.4 and M2 establish the http.rs registry pattern and M0 establishes the api.ts skeleton.

Fix those before M0 dispatches and the rest of §10 becomes safe to parallelize 8-wide. None of the fixes are large — they're paragraphs in TECH_PLAN, not weeks of work. Block on them, then ship.

One more thing worth saying out loud: §0's claim of "~140 engineering-hours single dev, ~50 wall-clock hours with 4-way parallelism" is optimistic. The critical path M0→M1→M3→M4→M5 alone is 33 hours of estimated work and most of those depend in a strict chain. Add the inevitable 30% slop for subagent re-runs after critic failures (called out in the orchestrator skill §11), and 50 wall-clock hours is more realistically 70-90. Worth honestly stating so expectations are calibrated when the dashboard sits at "Tick 47 of 240" three days in.

STATUS: DONE
