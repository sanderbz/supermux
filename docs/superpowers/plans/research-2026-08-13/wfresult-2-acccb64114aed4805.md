# supermux rendering/tmux pain — git-archaeology report

Scope: all 917 commits on `main` (2026-05-22 → 2026-07-30), of which ~334 match `render|tmux|scroll|term|grid|vt|resize|flicker|spinner|repaint`. Bodies read in full for the ~45 load-bearing commits plus PRs #24 #25 #26 #27 #33 #40 #41 #43 #44 #45 and every revert/reapply. Cross-checked against memory notes `terminal-scrollback-tmux-authoritative`, `render-bug-harness`, `reverify-subagent-live-claims`, `subagent-status-handling`.

(Note: the Write tool refused to create the requested report file — subagents are blocked from writing report files in this harness. Full report follows inline.)

**One-line thesis, in the project's own words (commit a7a2b9b, PR #45):**
> "The rendering fix at its root: stop stacking three terminal emulators."

The stack was: Claude's Ink TUI → tmux (emulator #1, reflow + own scrollback) → pipe-pane byte stream → WebSocket → xterm.js (emulator #2, own reflow + own scrollback) → browser compositor/WebGL atlas (renderer #3). Every failure class below is a seam between two of those layers. PR #45 already deleted one layer (tmux); replacing the terminal *client* with a structured UI deletes the other two.

---

## 1. Taxonomy of failure classes

Counts are "commits that exist only because of this class", including reverts, reapplies and hardening follow-ups.

### A. Mouse-reporting vs. touch-scroll — "the scroll saga"
**~17 commits, 3 reverts, 4 competing root-cause diagnoses, ~2 weeks (2026-05-23 → 2026-07-09).**
Claude Code ≥ v2.1.150 force-enables DECSET ?1000/?1002/?1003/?1006. xterm.js's own touch handlers begin with `if (coreMouseService.areMouseEventsActive) return`, so one-finger scrollback died on every phone the moment users updated Claude Code — nothing in supermux changed.
Chain of wrong roots: Vaul `touch-action:none` ancestor (b14efae → reverted 2d23d6c "didn't fix scroll, hurt rendering") → a raw-scrollTop touch shim (7723be1 → reverted 9c7657d "regressed iOS scrolling") → a `scrollLines()` shim (d2810cb, then c7052ca for iOS's first-touchmove `cancelable` window, then 3021083/ab52562/cb4a636 *correcting the shim's own written rationale*) → Vaul's unconditional `setPointerCapture` (a6d0f75) → server env `CLAUDE_CODE_DISABLE_MOUSE=1` (079e525, **verified a no-op** in 2.1.156) → client-side DECSET swallowing in the xterm parser (868e2fb) → the actual root: Claude runs in the **alternate screen**, which has no scrollback at all, and xterm turns an alt-buffer wheel event into cursor Up/Down — so "scrolling" cycled Claude's prompt history (3cd5ad3, fixed with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`). Also cc59f74 (joystick overlay blanketing touches) and 183dade (pointer-up focus made scrolling summon the iOS keyboard).
It **regressed again** a month later: xterm 6.0 has no touch-drag scroll at all, so #26 killed mobile scrollback and #33 (e86edfb) had to hand-roll a 1:1 drag + inertial momentum. Verified only with real CDP touch events — the earlier wheel-based harness missed it entirely.

### B. Attach-seed / alt-screen framing — splash duplication + typing on the wrong row
**~9 commits.** tmux's `capture-pane` emits **no `\x1b[?1049h` marker** between primary scrollback and alt-screen contents, so a full capture dumped cells into whichever xterm buffer happened to be active. Symptoms: Claude splash banner stacked 2–3×; typed echo painted 2–3 rows above the `❯` prompt. Arc: 2ec0142 (seed from full scrollback — *introduced* the bug) → 2d3d5b7 (retreat to visible-only + a read-only "earlier output" sheet workaround, which had its own portal-mount race and rendered black) → 6119752 (alt-screen-aware seed framing, net +192/−475: "the fix is mostly deletion") → c0bec3e (the *primary*-screen path still never restored the cursor — every prior fix had touched only the alt path; needs padding the visible capture to `pane_height` because CUP is viewport-relative) → 080ecd3 (seed used **pre-resize** 80×24 geometry: 16–36 blank rows below content; fixed with a 150ms resize-then-seed handshake plus a client `[auth, resize]` batched onopen) → e7fca30 (subscribe happens before capture so overlap bytes were delivered **twice** — "double lines / missing text, fixed by reload") → ef00d0f / c9cacf4 (visible replay-scroll on open → `replay_done` boundary frame + cached-tail crossfade) → 9098dcb (FIFO under `PrivateTmp` → every session black after a restart).

### C. Resize garble — stale rows never cleared
**~9 commits.** Ink repaints with **cursor-relative** moves; after xterm reflows on a width change those moves land on shifted rows and stale rows above are never erased. Nothing reseeds the client short of a full page reload — "weird content, only a full reload fixes it" (114bc2b: server `resync` push debounced 300ms after resize + a manual Refresh button; the button was later deleted in #26 as "never-working"). Team leads were worse: `window-size manual` froze the lead pane at e.g. 52 cols while the browser was wide (6089a28), and `resize-window` on a multi-pane window gave the lead `cols/N` — ~32 cols on mobile, below Claude's 40-col floor (7d2e0de). A drag-resize fired 10+ Resize frames in <100ms, each forking `tmux resize-window` under the per-session lock, starving queued keystrokes ("verdwijnen al mn letters") and at one point killing the server process (8888d0a). Also d2c333c: the DOM and WebGL renderers measure *different* cell widths (133 vs 138 cols at 1056px), so the terminal visibly reflowed on open.

### D. Partial-frame echo race — duplicate lines + cursor one row off
**~8 commits including a full revert+reapply cycle.** A Claude redraw split across multiple WS Binary frames produced an observable intermediate cursor state; the keystroke echo painted on the *old* row. Fixed twice, at two layers: server-side `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` + tmux `terminal-features xterm*:sync` so DEC 2026 frames arrive whole (2c4bd0f — Claude only auto-emits DEC 2026 for TERMs on a hardcoded list, and `xterm-256color` is not on it), and client-side rAF-coalescing of WS frames into one `term.write()` (d0f9656 + background-tab fallback e68c801). Both were **reverted (d4d4876, 44b0163) and reapplied (97016ac, cd4598e) the same day.** Upstream refs collected in-commit: claude-code #37283/#49086/#51828/#40555/#57145/#55613.

### E. GPU texture-atlas ghosting / renderer choice
**~5 commits, 1 revert, 1 unfixable-on-CI residue.** Keyboard-close grows the container in height only; the WebGL glyph atlas keeps cached tiles and iOS Safari's compositor keeps the pre-close pixel snapshot → doubled/overlapping rows when scrolling up; rotating the phone made it vanish (6b37e78 → `clearTextureAtlas()` after every fit). #26 shipped a WebGL⇄DOM renderer toggle so iOS users could dodge the atlas — then **reverted it inside the same PR (a34008b)** because the DOM renderer in xterm 6.0's VS Code scrollable element does not pick up touch-pan on iOS at all. Per `render-bug-harness`: atlas ghosting is **not reproducible in headless Chromium** (different GL pipeline) — it needs a real iPhone, and `clearTextureAtlas()` remains device-untested. Most likely cause of the residual "scroll-up history looks corrupted" on iOS.

### F. Input-path fidelity — IME duplication, phantom keys, paste-vs-submit
**~8 commits.** xterm.js has no Android IME support (upstream #3600/#2403): GBoard commits via composition and xterm's naive textarea diff re-sent whole words — an autocomplete tap duplicated text at Claude's prompt. Fix (249f0eb) takes xterm *out* of the IME loop: swallow keyCode 229, blackhole `composition*`/`input` at capture phase, hand-roll a surrogate-pair-safe prefix/suffix diff. 12ac8f8: `term.onData` is one chokepoint for both user keystrokes and xterm-*synthesized* replies (focus events from ?1004, DSR/CPR), so an auto-`focus()` sent phantom Enters into the pty. 4a9442e: Shift+Enter had to be intercepted to emit LF. 20e3da3 (#24): a trailing `;` never reached the pty. Paste-detection class: Kimi's TUI treats text+Enter within ~150ms as a paste (200ms gap needed, #44); the native runtime hit the identical bug because tmux's two `send-keys` forks had provided an *accidental* gap — `SessionRuntime::submit_gap()` of 50ms now exists at six call sites (#45).

### G. Mobile keyboard / viewport geometry
**~10 commits.** `interactive-widget=resizes-content` is honoured by Android (layout viewport shrinks) and ignored by iOS (keyboard overlays), so one inset computation was wrong on one platform — keyboard-open detection stuck false on Android, hiding the accessory strip and disabling the render kick (6870583, dual-signal detector). Worse: every keyboard open/close resized the **pty**, and a pty row change makes tmux *and* Ink repaint the whole screen, re-emitting rows xterm had just folded into scrollback — one duplicated screenful per keyboard cycle (5fd6afa: height-only changes now keep pty geometry fixed and bottom-anchor the grid with a negative top margin). 4a9442e: while the keyboard is up the engine throttles xterm's debounced rAF, so pty bytes landed in the buffer but never painted until the keyboard closed. Plus 0d5897d / 4791928 (iOS auto-zoom under 16px), a0057e1 (iOS PWA cold-launch dvh black bar), 6e6d90e (Vaul + Android keyboard collapsed the terminal), 6d0c312.

### H. Text selection / copy on touch — shipped, then deleted
**~7 commits, ending in total revert (1fea05e).** xterm renders to canvas: no selectable DOM text, and `SelectionService` starts only on a `mousedown` with `detail===1` (3c06633 — the first implementation shipped `detail:0`, so the toggle was a dead button). Select-mode built touch→synthesized-mouse→SelectionService→off-screen textarea→`execCommand('copy')` inside iOS's user-activation window; 1c4fc43 fixed the keyboard popping open, 21dec2b fixed a toast that lied while the clipboard stayed empty (`setTimeout(...,0)` escapes the gesture token), and it still didn't land on a real iOS PWA. Verdict in the revert: *"Every iteration fixed one rejection mode and exposed the next. Better no feature than one that lies."* The suggested right shape, never built: **"tap → open a sheet showing the last N lines as native text, let iOS's normal long-press selection do the work."** That is exactly a structured UI.

### I. Scrollback truth — who owns history
**~8 commits + PR #27 (4 commits) + PR #45.** Three competing scrollbacks (tmux's, the 512KB replay ring, xterm's 50k lines) diverging on resize. 6fe72c4 tried to align the numbers (ring 64KB→512KB, tmux history-limit 50000, xterm scrollback 50000). PR #27 (8dd1e23) made tmux **authoritative**: scroll-up fetches windowed `capture-pane -e -p -S/-E` (no `-J`, physical rows) stitched by absolute line id, with a probe↔capture race fix, an `at_limit` saturation flag, a width-mismatch loop breaker capped at 3, a 5s stalled-inflight re-issue, and a real error path (previously the client's retry branch was unreachable and an empty capture fabricated phantom blank rows). Shipped default-on in v0.4.30 with `localStorage['supermux:term-tmux-history']='0'` as a hidden kill-switch. **Residual, proven inherent:** when the pane *width shrinks* with content present, Claude/Ink re-emits its on-screen text into tmux's own scrollback — reproduced identically by a real native pty client at 80→47, so unfixable while a reflowing terminal is in the path. Also recorded: **do not re-attempt the two-xterm overlay** (no continuous scroll surface, wheel stolen).

### J. Status detection by regexing TUI output
**~15 commits, the single most-recurring bug family.** Active/Idle/Waiting is scraped from `capture-pane` bytes plus hooks. Failures:
- 3e87b0a — four compounding causes at once, incl. the IDLE bank matching Claude's *always-present* status bar (⏵⏵ / bypass permissions), so a busy session read "done"; ACTIVE bank anchored on a single spinner glyph while Claude cycles glyphs.
- b8daf73 — the hook endpoint used the `Json` extractor and silently 415'd every `curl -d` hook, severing the authoritative signal for weeks; typing echo read as "busy".
- 4791928 — `agent_ui_visible` keyed on `❯`, the same glyph the trust dialog and resume picker draw: a fast boot was declared ready with the modal up, dispatched prompts vanished into the modal, and the card flipped to "needs your input".
- 39a2847 / 78bf804 / 89a20fc / 444a58c / 5acbfd2 / 32dce35 — the subagent saga (`SubagentStop` folded into `turn_end` → false "finished" mid-turn; stale TurnState pinning restarted sessions Active until a 15-min safety bound).
- 43f41e5 (#41) — Codex's auto-reviewer prints "✔ Auto-reviewer approved …"; the Claude WAITING bank's `approve` token matched that passive scrollback → near-permanent false "needs input".
- d7174a3 (#43) — Codex's *idle* TUI emits invisible periodic repaint bytes, so the PTY heartbeat flapped the tile spinner on↔off while nothing happened.
- c70be00 (#44 follow-up) — same shape for Kimi: focus-open/keyboard-pop resizes the pane, Kimi answers with a ~40KB full repaint, the fresh-bytes heuristic read the echo as work ("shows loading while it wasn't doing anything"). Fixed with a moon-spinner turn *latch*.
- Meta-lesson (`reverify-subagent-live-claims`): the Kimi moon regex was anchored to `<moon> ·` and claimed "verified live" — live 0.26.0 draws the glyph alone on its own line, so the bank **never matched a single real frame**; detection silently rode the byte heartbeat.

### K. Connection / reconnect / lifecycle correctness
**~7 commits.** 8fb15af (auth_ok reset the backoff → connect→auth_ok→close storm ~5/sec; added terminal close code 4404). 4d73667 (stop→start recreates the same tmux session name, so `has-session` stayed true, the cached PtyStream stayed bound to the dead pane and every new WS replayed a stale frame). 9098dcb (FIFO in `PrivateTmp` → black terminals after every deploy). 5fd6afa (backgrounded Android burned all reconnect attempts into a dead-end `offline`; a long background left a **zombie socket** reporting OPEN after the server reaped the subscription — needed a 15s staleness ceiling + proactive redial). 9e303ca (WS storm on stopped sessions).

### L. Where it ended up (PR #45, a7a2b9b, 2026-07-30)
The native runtime removes tmux from the render path: a `pty-holder` subprocess owns the pty and spools raw bytes (64 MiB, rotate at 32 MiB, survives crashes — tmux history does not); the daemon runs `alacritty_terminal` as the server-side grid and serves seed/captures/windowed history from it. Frame protocol kept byte-identical so the client can't tell runtimes apart. Its own adversarial-review wave still had to fix: attach-generation re-seed after holder reconnect (silently-lost output spans), a ready-watch gate so seed/history don't read a half-rebuilt grid, pid-based liveness (dialling the socket evicted the live connection), resizes made while detached re-asserted on attach, input waiting out a 500ms reconnect gap instead of dropping, and the alt-screen marker carry across arbitrarily small chunks. Native is now default; teams, remote hosts and schedules remain tmux-only.

---

## 2. What dies vs. what survives a structured Claude UI

Assumption: Claude Code sessions render from **structured events** (hook payloads + the on-disk conversation JSONL that `recall` already parses — c31518e, `server/src/recall/`), painted as DOM. The pty still runs underneath; the raw terminal stays behind a toggle.

### Disappears entirely (no terminal emulator in the default path)
| Class | Why it dies |
|---|---|
| **B. Alt-screen seed framing** | No `?1049h` marker problem, no CUP restore, no pane_height padding, no "which buffer did these cells go into". Attach becomes a query, not a byte replay. |
| **C. Resize garble** | Cursor-relative repaints don't exist. DOM reflows text; a width change is CSS, not a grid reflow stranding stale rows. No resync push, no 300ms debounce, no `resize_lead_pane`, no cols/N team math, no Resize-frame coalescing under a session lock. |
| **D. Partial-frame echo race** | No shared cursor → no observable intermediate state. DEC 2026 / `CLAUDE_CODE_FORCE_SYNC_OUTPUT` / rAF-coalescing become unnecessary for the Claude view. |
| **E. Texture-atlas ghosting** | No canvas, no WebGL glyph atlas, no `clearTextureAtlas()`, no renderer toggle. The one class we could never reproduce or verify stops being ours. |
| **A. Mouse-reporting vs touch-scroll** | DOM scroll containers. No DECSET gate, no touch shim, no hand-rolled momentum, no `touch-action` archaeology, no dependence on `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`. #33 proves this regresses on every xterm major bump — killing it removes a permanent upgrade tax. |
| **H. Selection / copy on touch** | Native selection, native long-press, native copy. The revert note literally prescribes the structured-UI shape. |
| **F (partial). IME duplication** | If input is a normal `<textarea>` submitted as a whole prompt, GBoard composition is the browser's problem. The 229-keycode blackhole and hand-rolled diff go away. |
| **I (partial). Scrollback ownership** | One store (the conversation), not three. No absolute-line stitching, no `at_limit`, no width-mismatch loop breaker, no history-limit saturation — and the inherent width-shrink Ink re-emission disappears because Ink output is no longer the thing being re-read. |
| **G (partial). Keyboard-cycle duplication** | The keyboard no longer resizes a pty; a repaint no longer duplicates a screenful. |

### Survives (the pty is still there)
- **J. Status detection.** The biggest one. Claude has hooks (authoritative), so a structured UI can be event-driven and honest for Claude — but **Codex and Kimi have no hooks**, and if they keep the terminal path, capture-regex fragility survives untouched. Even for Claude, "which option is the TUI showing" is TUI state unless it comes from a hook or the JSONL.
- **F. Interactive-prompt input fidelity.** Any moment Claude draws a *TUI-native* modal — trust dialog, resume picker, permission selector, `/`-menu, arrow-key list — the structured UI must model it as a first-class state or fall back to the terminal. The submit-gap / paste-detection class (50ms native, 200ms Kimi) survives verbatim: a prompt is still bytes into a TUI composer.
- **K. Connection / reconnect / lifecycle.** Attach generations, re-seed on reconnect, zombie sockets after background, backoff, terminal 4404, session-restart invalidation, resizes asserted while detached — transport, not rendering. #45 shows these bite hardest exactly when you *change* the runtime.
- **G. Mobile viewport chrome.** iOS overlay vs Android resizes-content, 16px zoom floor, safe areas, PWA dvh, keyboard-open detection for the composer — still ours.
- **Pty geometry still matters.** Claude wraps output to `COLUMNS`; the new UI must pick and hold a sane pty width (and the 40-col Claude floor) rather than tracking the browser.
- **The raw-terminal toggle re-imports every class above** for whoever opens it. Keep it, but as the second-class path: no new invariant may depend on it.

---

## 3. Lessons / regressions the new UI must respect

**Diagnosis discipline**
1. **Four wrong root causes shipped before the right one** in the scroll saga alone — one commit (3021083) exists *solely to correct a previous commit's stated rationale*. Require a falsifying experiment, not a plausible mechanism.
2. **"Verified live" from a subagent is not evidence** (`reverify-subagent-live-claims`): green tests prove the code matches invented fixtures. Any string/shape scraped from a real program must be re-derived from a fresh live capture in each state.
3. **The harness must match the input modality.** #33's bug survived because the harness used wheel events; only CDP `Input.dispatchTouchEvent` reproduced it. Likewise `render-bug-harness` is emphatic: **always DPR=1** — DPR=2 in headless_shell produces *false* garble.
4. **Some things need a real iPhone.** iOS WebKit compositor/atlas behaviour is not emulable. If the new UI has any GPU-ish surface (virtualized list, transforms, `will-change`), the headless verdict is silent, not clean.

**iOS / mobile quirks that are UI-agnostic and will bite again**
5. iOS fixes a gesture's nature on the **first `touchmove`** — `preventDefault` after that is ignored (`e.cancelable === false`).
6. Clipboard writes must be **synchronous inside the user-activation window**; a `setTimeout(...,0)` already loses the token in a PWA. Never toast success on intent — gate the toast on the actual boolean (21dec2b: "the toast lied").
7. Inputs below 16px auto-zoom on iOS. Drawer libraries (Vaul) call `setPointerCapture` unconditionally and set `touch-action:none` on ancestors — either kills a nested scroller.
8. `interactive-widget=resizes-content` splits platforms: iOS overlays (inset > 0), Android resizes (inset ≈ 0). Keep the dual-signal detector; never lift bottom chrome twice on Android.
9. Never let a scroll gesture end in a `focus()` — that summons the keyboard (183dade). Tap-vs-swipe gating (<10px, <500ms, single pointer) is the shape that worked.

**Reconnect / replay correctness (carries over 1:1)**
10. **Seed and live stream must not overlap or gap.** e7fca30 (double-delivery) and #45's attach-generation re-seed are the same bug from opposite sides. Define an explicit boundary frame (the `replay_done` pattern) and test a mid-stream attach under a firehose for *strictly consecutive* tokens — #45 already has that test.
11. **A restart reuses the session name.** Liveness by name lies (4d73667); probe the real process.
12. **Zombie sockets** survive backgrounding while the server has reaped the subscription; a staleness ceiling + proactive redial on `visibilitychange`/`pageshow`/`online` is required.
13. **State must live outside the process that can die.** `PrivateTmp` blackened every terminal after a deploy (9098dcb); tmux history dies with the pane, the #45 spool does not. The structured UI should read from the durable conversation file, not an in-memory ring.
14. **Don't wipe client history to fix a render bug.** Per `render-bug-harness`, the idle-resync seed's `\x1b[3J` fixes a transient double-paint and regresses scroll-up-to-see-history. Any "re-render everything" heal must be additive.

**Status detection (the class that will not die)**
15. **Hooks are authoritative; content banks are a safety net; the byte heartbeat is a last resort — and it lies whenever a TUI repaints at rest.** Codex flapped (d7174a3), Kimi latched (c70be00). The generalizable fix is a per-provider **turn latch** with a positive rest signal, never "bytes ⇒ active".
16. **A repaint is not work.** Focus-open and keyboard-pop *resize the pane*; static-at-rest TUIs answer with ~40KB repaints. Test idle **across resizes**, not just at rest.
17. **Never gate `turn_end` on `SubagentStop`** (39a2847) and reset TurnState on SessionStart/SessionEnd (78bf804) — locked by tests; do not regress via a new UI's state model.
18. **Beware glyph collisions.** `❯` means prompt, trust dialog *and* resume picker (4791928); "approved" appears in passive Codex scrollback (#41); Claude's status bar is always present so it must never be an idle signal (3e87b0a). If the new UI shows "waiting for you", derive it from a hook/JSONL event, not a glyph.

**Product / process**
19. **Ship behind a flag with a hidden kill-switch, and flip the default in a separate commit** — #27's `TERM_TMUX_HISTORY` (default-on, `localStorage='0'` reverts with no redeploy) is the pattern that let a risky renderer change land safely. Do the same for the structured UI.
20. **Keep the runtime seam.** #45's `SessionRuntime` trait made a full runtime swap a zero-behavior-change delegation for the old path. The structured UI should be a *view* seam of the same character: the terminal view keeps working byte-identically while the new view is proven.
21. **Migration guards are where the bugs are.** #45 needed four follow-up commits to detect the real "fresh start" shape (stop leaves a live bash under a dead agent) and to stop using `team_name` as a team signal (Claude writes implicit solo teams for every session). Any "which sessions get the new UI" gate deserves the same paranoia — physical probes over inferred flags.
22. **A feature that can't be made honest should be deleted, not layered** (1fea05e, a34008b, 2d23d6c, 9c7657d). Four reverts in this history, all of them correct calls.
