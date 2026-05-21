# Codex Adversarial Review of TECH_PLAN.md

## Raw codex output

**Codex binary not available** on this machine (`which codex` → not found; no `codex` in `/opt/homebrew/bin`, `/usr/local/bin`, or `~/.local/bin`; not installed via npm globally). Per the skill instructions, I simulated the adversarial review with the same ruthless lens. Output below is my own analysis applying codex's "200-IQ adversarial reviewer" mode — no tool-derived second source available.

---

## Synthesized findings (top 10 weaknesses)

### 1. The "atomic claim" comment is wrong and the test is insufficient (§3.2.10)

The plan says:

> Single statement = atomic; no transaction needed because SQLite serialises writes.

This is **misleading**. SQLite serialises *writes* through the WAL, but the claim path under contention will trigger `SQLITE_BUSY` retries (the pool uses 8 connections; one writer, seven readers). Under the 100-concurrent-claim test (`board_claim.rs`), losers will *not* uniformly return 409 — some will return `Database is locked` (500). The acceptance criterion "100 concurrent claim requests on same id → exactly one 200" passes only because the test is single-process and sqlx serialises through its connection pool. In production with two `axum` workers on the same DB you'll get sporadic 500s under burst load. **Fix**: set `busy_timeout` PRAGMA, retry-on-busy in the handler, or wrap in a real transaction with `BEGIN IMMEDIATE`.

### 2. The pty FIFO design has a guaranteed startup race and a re-open hot loop (§3.2.7)

```rust
let mut reader = tokio::fs::OpenOptions::new().read(true).open(&fifo).await?;
...
Ok(0) => { /* re-open fifo */ }
```

Three concrete bugs:
- **`open(fifo, O_RDONLY)` on a FIFO blocks until a writer connects.** If `pipe-pane` hasn't started yet (or tmux died), the reader task hangs forever, holding the session lock by reference. The "ensure_started" sequence — mkfifo, pipe-pane, spawn reader — has no ordering guarantee that pipe-pane succeeded before the reader opens; if pipe-pane fails silently (tmux session vanished, fifo busy), the reader blocks on open.
- **`Ok(0)` (EOF) re-open with no backoff is a hot loop.** When tmux dies, the writer end closes, every reader gets EOF, and the comment "re-open fifo" means another `open()` that blocks again until a writer appears. If the session never restarts, the task either spins (if the next open also returns 0 — happens transiently on Linux when there's a writer mid-close) or blocks forever.
- **`broadcast.send` returns Err when no subscribers.** The `let _ = broadcast.send(chunk)` happily drops the error, but the chunk is silently lost. Replay buffer still gets it; new subscribers get the replay. OK in this design, but worth documenting.

**Fix**: open the FIFO with `O_RDWR` (Linux trick: keeps a writer end alive so reads return 0 only on intentional close), or open it in non-blocking mode with `epoll`. Add a per-session re-open backoff with cap. Add health check that tears down the task when the tmux session is gone.

### 3. `path_safe.rs::canonicalize` blocks Tokio runtime, fails on non-existent paths (§3.2.11)

```rust
let abs = PathBuf::from(p).canonicalize()?;        // defeats ..
```

Two serious bugs:
- `std::fs::canonicalize` requires the path to **exist**. Every `PUT /api/file` to a new file will fail at the safety check before it can be created. Need to canonicalize the *parent* and join the basename.
- `canonicalize` is a blocking syscall called from an async handler. Use `tokio::fs::canonicalize`.
- **TOCTOU**: even with canonicalize, between the safety check and the actual write/read, a symlink could be swapped in. The 200MB upload path is particularly vulnerable. Use `openat`-style relative resolution or `fchdir` + relative paths.

The blocklist is also defeated by **mount tricks** (bind-mount `/etc/shadow` somewhere allowed) and **case sensitivity on macOS HFS+ default** (`/ETC/SHADOW` ≠ `/etc/shadow` for `==` compare).

### 4. SettingsHook design leaks the auth token to every child process and the env (§3.6)

The hook command embeds `$AMUX_TOKEN` directly. This means:
- `AMUX_TOKEN` must be in the *agent's* environment, which means it's in tmux's per-session env, which means it's visible to **every command the user runs in their shell** (`env | grep AMUX`).
- If the agent calls anything that uploads logs (Sentry, telemetry), the token leaks.
- If the user accidentally `set -x`'s, the token appears in the terminal scrollback that is then streamed to all WS subscribers.
- The `curl` runs as a `tee`'d child of the tmux pane, so the full URL with `--max-time 1 -X POST ...` is visible via `ps aux | grep curl` to other users on the box.

**Fix**: use a unix socket at `/tmp/amux-hook-<name>.sock` with peer-cred-check (Linux `SO_PEERCRED`), no token needed because peer must be the same UID. Or use a short-lived hook-only token rotated per session start.

### 5. `tracked_files`, `audit_log`, `delegations`, `share_tokens`, `kbd_groups` migrations are missing or contradictory (§3.3, §6.4, §M9, §M16)

The §3.3 SQL defines `share_tokens` but no part of the plan creates them (M3 lifecycle doesn't, M22 settings doesn't). Dead schema.

`audit_log` is referenced in §6.4 ("writes a row to a NEW `audit_log` table") and rendered in §M22 settings UI — but **the table is never defined in any migration**, and no INSERT happens in any module's spec. Pure hand-wave.

`delegations` is added "in a new `delegations(from, to, prompt, ts)` table (add a migration `0005_delegations.sql`)" inside M9, then never declared. No PRIMARY KEY, no FK, no index.

`kbd_groups` migration appears in §3.3 as `0004_runtime_state.sql` then M16 says "add a small migration `0006_kbd.sql` here OR keep prefs blob-based" — undecided. M22 ACCEPTANCE asserts persistence, so this must be decided, not punted.

### 6. The scheduler tick can drop runs, double-fire on restart, and has no leader election (§3.8, §M8)

- **Drift accumulator**: `tokio::interval` has `MissedTickBehavior::Burst` by default. If the runtime is paused (laptop sleep, GC pause, blocking task), on resume *every* missed tick fires at once. For a `every 1m` cron with 30 minutes of sleep, this dispatches 30 invocations of every schedule in 100ms. Need `MissedTickBehavior::Skip` and a per-schedule "last_run + cron.next > now" guard.
- **No idempotency on restart**: if `next_run <= now` when amux-server starts (the v2 box was off for an hour), every schedule with `enabled=1` fires at startup. Could double-fire if the previous instance also fired before crashing.
- **`every 5m` ≠ cron `*/5 * * * *`** — the free-text parser is supposed to compute `next_run = now + 5m` (drifting from clock alignment), while the cron parser aligns to wall clock. The plan doesn't say which semantics free-text uses. This is the #1 source of "why didn't my schedule fire" tickets.
- **No leader election**: when v3 runs side-by-side with v2 (§8.4), if both define a schedule that does `git pull`, both fire. The plan claims they have separate data dirs, but the user *will* eventually migrate, and during the 2-week dogfooding window described in §8.4, both servers could trigger schedules pointing at the same external resources.

### 7. WS auth via `?_token=` is logged everywhere (§1.4, §3.4)

- `?_token=` lands in axum tracing-subscriber JSON logs (the plan enables tracing in §1.1).
- `?_token=` lands in nginx/Tailscale access logs if any reverse proxy is involved.
- `?_token=` lands in the **browser address bar** if a user shares a screenshot.
- `?_token=` lands in **WS server-side error messages** when origin checks fail (the close frame may echo the URL).

The plan says "browsers don't allow custom headers on WS upgrade" — true, but the standard fix is a **subprotocol token** (`Sec-WebSocket-Protocol: bearer.<token>`) or an opaque **one-shot session cookie** obtained via a prior HTTP POST. Both avoid log leakage.

### 8. View Transitions + xterm.js + xterm-Canvas are mutually incompatible (§4.3, §M11, §M23)

- View Transitions API captures a **DOM snapshot** for the morph. xterm.js with `CanvasAddon` renders into a `<canvas>` element; the snapshot of a canvas is the pixel buffer at that instant, NOT something that animates by "shrinking" — the tile-to-focus morph will look like a stretched still image of the canvas, not a smooth scale. The plan describes the morph as smooth and Apple-grade; in practice this is jank.
- §4.10 (Capacitor-ready) says "DOM addon for mobile, Canvas for desktop" — but the SessionTile uses `<TailPreview>` (static text), so the View Transition only morphs the title row, not the live terminal. This is fine, but the spec ambiguously implies the terminal itself morphs.
- The `viewTransitionName: 'session-' + s.name` collides across overview → focus if multiple tiles share the same `name` after rename. There's no debouncing for the case where the route changes mid-transition.

### 9. The `wait` long-poll holds an HTTP connection for 600s — no concurrency budget (§3.7, §M9)

- Tower's default concurrency limit + Tailscale's idle-connection timeout (typically 300s) means a 600s long-poll will be **killed by Tailscale before the deadline**, returning a confusing client error.
- If 50 agents all `amux wait`, axum holds 50 connections, each blocking a tokio worker on `notify.notified()`. Notify is wakeup-only — fine — but axum's `tower::limit::ConcurrencyLimit` defaults bite at much smaller numbers if configured.
- The handler `tokio::select!`s on `notify.notified()` and `sleep(remaining)` but **re-queries the DB on every notify**, with no early exit on the second pass. If status flaps between active and waiting 100 times in 1 second (which the detector can do under network jitter), the handler runs 100 DB queries.
- No `keep-alive` mechanism for the connection (no chunked pings), so reverse proxies WILL kill it.

**Fix**: emit periodic `\n` keepalives via chunked transfer, cap timeout to 300s, debounce notify with a 50ms window, return SSE instead of long-poll.

### 10. LOC estimates are 30-50% optimistic; total time is wildly low (§0)

- "M5 — Backend: status detector — 600 LOC, 10h." The detector alone is plausible at 200 LOC. The 30 golden fixtures (writing realistic capture-pane samples, classifying them, building the `insta` snapshot suite, debugging the inevitable false-positive regex collisions) is 400+ LOC of test code and easily 12-20h of effort because Claude's UI output is non-deterministic, terminal escapes are gnarly, and you have to capture against multiple Claude versions.
- "M15 — focus-mode mobile, 500 LOC, 8h." Vaul integration with custom rubber-band, velocity dismiss, detents, safe-area-aware dock, AND mobile testing on real iOS Safari is a 1500 LOC effort with 30h+ of debugging because Vaul's docs explicitly note iOS Safari quirks around keyboard focus stealing.
- The plan estimates "~140 engineering-hours total" for ~14,500 LOC. That's ~104 LOC/hour, which **only counts the green path**. Industry reality for a from-scratch full-stack product with custom animations and a multi-signal state detector is 25-40 LOC/hour including debugging, test stabilization, deploy work, and the inevitable "the regex bank broke when Claude shipped emoji status indicators" days.
- "~50 wall-clock hours with 4-way parallelism" assumes 4 sub-agents producing equally and the critic loop passing first try. Realistic estimate based on the dep graph: 80-120 wall-clock hours.

---

## Severity matrix

| # | Issue | Severity | Likelihood | Fix complexity |
|---|---|---|---|---|
| 1 | SQLite contention 500s on claim race | **High** | High (under load) | Low (busy_timeout + retry) |
| 2 | FIFO open-blocks + EOF hot loop | **High** | Medium (after tmux death) | Medium (rewrite reader) |
| 3 | path_safe canonicalize blocks + breaks creation | **Critical** | 100% (any PUT to new file 500s) | Low (canon parent + join) |
| 4 | Hook token leaks via env + ps + logs | **High** | High (user runs `env`/`set -x`) | Medium (peer-cred socket) |
| 5 | 4 phantom tables, undefined migrations | **High** | 100% (acceptance fails) | Low (write the SQL) |
| 6 | Scheduler drift / burst / no idempotency | **High** | High (after laptop sleep) | Medium (MissedTickBehavior + idem keys) |
| 7 | Auth token in WS query → log leakage | **High** | High (logged everywhere) | Medium (subprotocol/cookie) |
| 8 | View Transition + canvas xterm jank | Medium | Medium (Chromium users) | High (custom FLIP morph instead) |
| 9 | 600s long-poll killed by proxies | Medium | High (Tailscale 300s default) | Low (keepalive + cap) |
| 10 | LOC + time estimates 30-50% low | **High** | 100% (will overrun) | N/A (re-budget) |

### Additional medium-severity findings (not in top 10)

| # | Issue | Severity | Likelihood |
|---|---|---|---|
| 11 | `include_dir` (nightly feature in §3.1) — but `rust-version = "1.83"` is stable. Mismatch. | Medium | 100% (build fails) |
| 12 | `cargo build --release` produces ~12MB binary claim — with `axum + sqlx + tokio + tungstenite + rustls + sqlite + chrono + cron + regex + serde + tracing + include_dir` of all web assets, expect 40-80MB stripped. | Low | 100% (cosmetic but misleads users) |
| 13 | "Auth token in HTML body" (§1.4, §6.1) — documented as acceptable. But `view-source:` and the Service Worker's `cache.put('/')` will persist it indefinitely; revoke is then ineffective until SW cache purge. | Medium | High |
| 14 | M17 joystick: `navigator.vibrate` is **unavailable on iOS Safari**. Entire haptic spec is silently no-op on the primary target platform. Need `HapticsImpactFeedback` via Capacitor or accept no-haptic. | Medium | 100% on iOS |
| 15 | Per-session `Mutex<SessionLock>` (§1.3) + DashMap of locks: lock acquired by `send_text` blocks `start`/`stop`/`config_patch`. If a `send_text` is slow (load-buffer + paste of a 1MB blob), `stop` waits. No deadline. Need `try_lock_for`. | Medium | Medium |
| 16 | Frontend Reconnect banner reads from `useConnection()` Zustand store written by both `useLiveTerm` and `useSse` — but there's only one banner and N terminals + N SSE connections. State will race; the banner will flicker between "Connected" and "Reconnecting" as the slowest connection updates. Spec assumes one connection. | Medium | High |
| 17 | M16 "haptics on chip press" via `navigator.vibrate` — same iOS Safari issue as #14. The whole §"haptic spec is enforced" claim is fictional on the target device. | Medium | 100% on iOS |
| 18 | Migration script `migrate-v2.py` uses raw `INSERT OR IGNORE`. Any v2 schema mismatch (column added in v3, missing in v2) will silently insert NULLs and the migration will succeed with broken data. Need explicit column whitelist + type validation. | Medium | High |
| 19 | M5 hooks-write to `~/.claude/settings.json` is a **global side-effect** on the user's machine that other tools (cmux, custom CC setups) also write to. The plan says "writes/merges" but doesn't specify merge strategy. If two amux instances install hooks pointing at different URLs, last-writer wins, the other silently breaks. | Medium | Medium |
| 20 | M23 PWA: `NetworkFirst` for HTML + auth token in HTML = if the user logs out (rotates token), the SW still serves the cached old token. There is no SW invalidation hook on token rotate. | Medium | High |
| 21 | The 20 acceptance criteria → "18/20 must pass" gate is arbitrary. There's no severity weighting. The plan could pass with criteria #1 (spring values) but fail #4 (joystick haptics — which is impossible on iOS anyway). | Low | 100% |
| 22 | Critical path = 12 milestones with serial dependencies, no risk buffer. A single failed critic loop on M5 (status detector, the hardest milestone) pushes everything. | Medium | High |
| 23 | `tmux capture-pane` is shelled-out every 2s per session for status detection. For 50 sessions, that's 25 tmux process spawns per second, hitting fork() and ENOMEM at scale. | Medium | Medium (scale-dependent) |
| 24 | `tracing-subscriber` JSON logs will include `Authorization: Bearer ...` headers in axum's HTTP span. The plan doesn't configure a header-redaction filter. | High | 100% |
| 25 | `bind_tls` + Tailscale + self-signed fallback (§1.5): the plan doesn't specify what happens if `tailscale cert` is rate-limited (Let's Encrypt staging cap). On first deploy + Tailscale cert failure, the binary panics in `main()`. | Medium | Low (but catastrophic) |

---

## Specific contradictions found

### A. SSE vs WS for status updates

- §1.1 (intro): "WebSocket is the only path for live terminal data, **SSE for metadata**"
- §3.2.9 ws handler: sends `Message::Binary(chunk)` for pty data — consistent.
- §3.6 status detector fusion: status changes emitted via "SSE channel"
- §5.4 status detector cycle diagram: status sent via `sse_tx.send(Event::Status { name, status })` — consistent.
- BUT §3.7 `wait` primitive: "HTTP long-poll, no SSE complication." So a client wanting to know status uses *both* SSE (push) AND long-poll (pull), with different timing semantics. Choose one.

### B. M3 says shell provider; §3.1 schema CHECK forbids it

- M3 subagent prompt: "spawns a session running `bash` (provider=`shell` — add a test-only provider variant)"
- §3.3 `sessions` table: `CHECK (provider IN ('claude', 'codex'))` — adding 'shell' breaks the constraint. The subagent will fail acceptance.

### C. View Transition spec mismatch

- §4.3 SessionTile: `style={{ viewTransitionName: 'session-' + s.name }}` — applies to the entire tile.
- §M23 morph: `document.startViewTransition(() => flushSync(() => navigate(to)))` — wraps a navigation that destroys the old tree.
- §4.4 FocusHeader: nothing mentions `viewTransitionName`. The morph has no destination element, so the View Transition reverts to a crossfade, not a morph. The spec implies morph.

### D. Capacitor + Service Worker

- §4.10: "Service worker: disabled inside Capacitor"
- §M23: PWA scaffolding lands, manifest defined.
- §4.10: "PWA manifest is unused too" inside Capacitor.
- The plan has no Capacitor target in v3.0 (per §13 out-of-scope, no native shell), but adds Capacitor-readiness constraints (§4.10) that the SW design (§4.9) actively violates by caching the auth token in HTML. Choose one path.

### E. `kbd-groups` storage

- §3.3 schema: defines a full `kbd_groups` table (in `0004_runtime_state.sql`).
- §M9 (agents): adds endpoint `/api/kbd-groups` mentioned in §3.4.
- §M16 subagent prompt: "add a small migration `0006_kbd.sql` here OR keep prefs blob-based: store as `prefs[kbd_groups]` JSON" — proposes a different storage. The two paths require different backend code.

### F. `pre_tool` status

- §3.6 fusion rule: `HookEvent::PreToolUse => Status::Active`
- §3.6 detector code comment: "post_tool" → "Idle-candidate" — but the match arm only handles Notification/PreToolUse/Stop/SubagentStop; `post_tool` falls through to `self.last_status`. Spec says it's an idle-candidate but code never moves to idle from a post-tool event.

### G. M11 hover spec

- §4.3: hover spring `{ type: 'spring', stiffness: 380, damping: 24 }`
- §4.7 springs preset: `tileHover = { stiffness: 380, damping: 24 }` — consistent.
- §M11 subagent prompt: "WhileHover (desktop): `scale: 1.06, zIndex: 10`, spring per `lib/springs.ts::tileHover`" — but Termius §SwiftUI recommended values for card-expand is `(response: 0.32, damping: 0.72)` which converts to roughly `{stiffness: 380, damping: 28}`, NOT 24. Off by 4 — visible "snappier" feel than spec.

---

## Recommended hardening (in priority order)

1. **Fix path_safe.canonicalize for non-existent paths immediately (§3.2.11).** Every PUT to a new file currently 500s. Canonicalize parent + join basename. Switch to `tokio::fs::canonicalize`. Add explicit `tokio::fs::symlink_metadata` check before write.

2. **Move WS auth out of the query string.** Use `Sec-WebSocket-Protocol: amux.bearer.<token>` subprotocol header. Frontend reads token from injected HTML, attaches via `new WebSocket(url, ['amux.bearer.' + token])`. Backend reads `sec-websocket-protocol`, validates, echoes one back in 101 response.

3. **Add header redaction to tracing-subscriber.** Document a custom layer that scrubs `Authorization`, `Cookie`, and query keys matching `_token`, `token`, `key`. Without this, the JSON logs are a credential dump.

4. **Replace the hook callback's bearer-in-env with a peer-cred unix socket.** `/tmp/amux-hook-<name>.sock`. Linux `SO_PEERCRED`, macOS `LOCAL_PEERCRED`. No token, no env exposure.

5. **Audit + define every missing table.** Add migrations: `0005_audit_log.sql`, `0006_delegations.sql`, settle the `kbd_groups` storage (recommend keeping the table from §3.3 and deleting the M16 "OR prefs blob-based" alternative). Add explicit FKs and indices.

6. **Fix the pty FIFO reader.** Open with `O_RDWR` on Linux to avoid blocking opens. Detect tmux session death via `Tmux::exists()` poll, tear down reader. Add 250ms backoff on EOF.

7. **Add `busy_timeout = 5000` PRAGMA, `BEGIN IMMEDIATE` for claim path, retry-on-busy in board::claim.** Keep the "single statement is atomic" comment but qualify it: "atomic *given exclusive write access*."

8. **Re-budget the milestones.** Apply 1.7x multiplier to time. Add risk buffer to critical path. Specifically:
   - M5 (status detector): 10h → 18h
   - M15 (Vaul mobile): 8h → 16h
   - M17 (joystick + 2-finger): 6h → 12h (and document iOS Safari haptic limitation)
   - Total: 140h → 240h, 50h wall → 90h wall.

9. **Replace long-poll `/wait` with SSE-status filtering or websocket subscription.** Keep the same `Notify` plumbing but emit through the existing SSE channel filtered by session name and target state.

10. **Pick one storage for kbd_groups, snippets, etc., and delete the alternative from the plan.** The contradiction between "table in 0004" and "blob in prefs" will cost a real day of debate in M16.

11. **Decide and document the scheduler MissedTickBehavior.** Skip is almost always correct. Add idempotency keys (`schedule_id + scheduled_run_ts`) to `schedule_runs` to prevent double-fire on restart.

12. **Drop the `provider='shell'` test variant or add it to the CHECK.** Currently incompatible with the schema constraint.

13. **Add an "auth token rotation" path that invalidates the SW cache.** `regenerate auth token` button in M22 settings must also call `caches.delete('amux-html')` and reload.

14. **Add a `tmux pipe-pane` death-detector.** Poll the FIFO writer-count (Linux: `/proc/<pid>/fd`) to detect when pipe-pane drops. Otherwise stale FIFOs accumulate.

15. **Capture-pane every 2s × N sessions doesn't scale.** Coalesce status detection: when no pty bytes have flowed in the last N seconds and last status was `idle`, skip capture-pane entirely. Status changes only happen on byte activity OR explicit hook events anyway.

---

## Verdict

**REVISE-MAJOR**

This plan is impressively detailed and architecturally sound at a high level — the right choice of stack (Rust+axum+sqlx+tokio, React 19+xterm+TanStack+Vaul), a sensible coexistence strategy with v2, and an unusually disciplined animations spec. The author clearly knows the domain. However, multiple concrete implementation choices in §3 are wrong-as-spec'd and **will not compile or will fail acceptance tests on first run**: `canonicalize()` on a not-yet-existent file (#3), the `include_dir` nightly-feature on a stable rust-version (#11), the `provider='shell'` test variant violating the CHECK constraint (contradiction B), and four phantom tables (#5). The security posture has **two High-severity leaks** (auth token in WS query string logged everywhere, auth token in hook callback env), and the status detector — explicitly called out as "THE crown jewel" — depends on a hook architecture that broadcasts the auth token to every shell child. Time/LOC estimates are systematically 1.5-2x optimistic, which means the orchestrator skill's critic-loop budget (§11) will exhaust mid-build. None of this is fatal; all of it is fixable in a focused half-day of plan-revisions before M0 starts. **Do not start the build until the §3.2.11 path_safe bug, the four missing migrations, the WS auth-token-in-query, and the schema CHECK contradiction are resolved.** Once those are fixed, this is a SHIPpable plan with realistic 90h wall-clock to v3.0.
