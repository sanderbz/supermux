# CEO Review of TECH_PLAN.md

## Verdict

**TIGHTEN-FIRST.** Score: **6.5 / 10** on "Steve Jobs would ship this."

The plan is engineering-excellent. It is product-cautious. Within the locked scope (Sessions + Board + Files + Scheduler + agent commands), the daily-driver loop — tile, peek, click, type, switch — is split across 7 milestones with the data-flow that powers the hero moment never drawn. The plan thinks like a backend monorepo build, not like a product whose first 30 seconds either convert or don't.

Ship M0–M10 as written. Revise M11, M12, M14, M15, M21, M23, M24 before letting subagents touch them. Add three new milestones that don't exist today but should. Detail below.

---

## What's brilliant in this plan (credit where due)

1. **§3.6 status detector spec is the crown jewel.** Multi-signal fusion (hook > regex > pty heartbeat > timeout), 30 golden fixtures, `insta` snapshot testing, hook-event priority, separate side-effects task. This is exactly the thing cmux issue #1027 publicly failed at, and v3 takes it dead serious. The fusion priority is right, the test strategy is right, the side-effects-out-of-detector decoupling is right. Don't touch this section.

2. **The auth model is grown-up.** Removing v2's localhost bypass, constant-time compare, public-route allowlist as an explicit attribute, origin allowlist with `*.ts.net`, no `0.0.0.0` bind. This is the difference between an MVP and a thing you can give to other people. Keep it exactly as is.

3. **Single binary + `include_dir!` + sqlite + tmux server already on box.** The distribution moat. One artifact, no Docker, no Node at runtime. This stays opinionated and small. Beautiful.

4. **The `wait` primitive (§3.7) and `boot` schedule kind (§3.8).** These are the two things that turn amux from "task supervisor with dashboard" into something an agent fleet can actually program against. Underrated. They're in the right place in the plan and the right place in the architecture.

5. **The Termius pixel spec is treated as a real spec, not vibes.** §4.4.2 accessory bar dimensions are sourced from the research doc, spring presets match Termius §SwiftUI Recommended values, acceptance criteria are stopwatch-checkable. This is the right way to operationalize "make Jobs proud" — turn the feel into numbers, then verify the numbers.

---

## What worries me as CEO (ranked by impact on user's daily delight)

### 1. The tail-preview data flow is undefined. The hero moment has no plumbing.

**This is the biggest problem in the plan.** The product's wow moment is the dense tile grid where each tile shows the last 6 lines of its agent's terminal, live. User-vision.md is explicit: "the tile preview IS the terminal (sampled)." §4.3 says the tile renders `<TailPreview lines={s.preview_lines} />`. But:

- `preview_lines` does not appear in the `Session` struct, `SessionSummary`, or `session_runtime` table (§3.3).
- It does not appear in the SSE `sessions` event payload (§3.4 only says "delta").
- The WS pty stream (§3.2.7) is per-session, capped at 8 subscribers — having the overview subscribe to every session's WS does not scale and would blow the cap on any non-trivial deployment.
- The status detector already calls `tmux capture-pane` every 2s (§3.6). The data the tile needs is already being captured.

**Fix (concrete):**
- Extend `session_runtime` table with `last_capture TEXT NOT NULL DEFAULT ''` (last 30 lines).
- Status loop writes `last_capture` on every tick (already running 2s/session).
- `SessionSummary` shape gains `preview_lines: Vec<String>` (last 6 lines of `last_capture`).
- SSE `sessions` payload includes `preview_lines` deltas (only when changed, to keep payload small).
- Frontend tile renders directly from the SessionSummary; no per-tile WS, no polling, no second source of truth.

**Why this matters:** without this, M11 ships as a beautiful empty grid of card frames with placeholder text. The whole "BE in tmux, via web" thesis dies on the overview screen.

### 2. There is no "first 60 seconds" milestone.

**Jobs would obsess over this and the plan ignores it.** The user said "make Steve Jobs proud." Jobs gates products on the unboxing moment. The plan covers M26 = data migration from v2, but never covers the demo-able sequence:

> Install PWA → open → see (migrated v2 sessions OR a beautiful empty state with one CTA) → tap one OR tap "create your first agent" → it boots → live tail appears in tile → tap into focus → type → output streams.

There is no milestone that owns this flow as a single artifact. M12 builds the overview, M11 builds the tile, M13/M14/M15 build focus, M26 migrates data — but no one is responsible for the sequence feeling right. **Add M27: "Time to wow."** Spec below in Section §"Milestones to AMPLIFY."

### 3. Empty states are not in the plan, anywhere.

Search the doc: no mention of empty overview, empty board, empty files, empty scheduler. Jobs would never ship a product where the first-launch experience is a blank grid. The plan treats empty states as a frontend afterthought. This is exactly how products feel cheap on first contact.

**Fix:** add a section §4.X "Empty states" with one paragraph per route describing the message, the illustration approach (SVG, no images), the single CTA, and the spring used to animate the empty-state in/out. Make it part of M11/M12/M19/M20/M21/M22 acceptance — "empty state designed and implemented."

### 4. The desktop dock is hand-waved.

§4.4 mobile dock has §4.4.1 + §4.4.2 with pixel detail. The desktop dock (M14, 6h) is one sentence: "DesktopDock... bottom, 56px, just shows current keyboard hints and a one-line input for special send." That's not a spec, that's a TODO disguised as one. The user-vision explicitly mentions a "fallback overlay panel" for desktop touch/slash invocations. Today the desktop power user has a tmux tile via xterm and... what? A hint bar?

**Fix:** §4.4 needs a desktop dock subsection that mirrors §4.4.1 mobile dock with: command palette ⌘K trigger, slash menu launcher, snippet drawer toggle, send-keys row (Esc/Tab/Ctrl-C/Ctrl-U at minimum), detach button. M14 LOC budget bumps from 400 → 550.

### 5. M11 hero tile is 6h. M23 cross-cutting polish is 5h. Both are under-budgeted for what they own.

M11 is the entire product's first impression. 6 hours to build the tile, the tail preview, the status dot, the hover spring, the long-press peek, the View Transition setup, the active/waiting pulse animations, the mobile haptic, the dev page. This is a Jobs surface. Budget it like one. Bump to 10h, and split off the long-press quick-peek into its own milestone (it deserves a real LiveTerminal embed, not a shortcut).

M23 packs View Transitions + Reconnect Banner + PWA manifest + service worker + iOS splash + apple-touch-icon + install prompt + Lighthouse pass into 5h. Each one of these is its own polish concern, and PWA on iOS is famously fiddly (status bar style, viewport-fit cover, safe-area, standalone-mode detection, the install instructions for users who can't see an A2HS button). Split.

### 6. The 8-subscriber WS cap reads like a defensive number that will bite us.

§3.2.7 caps WS subscribers at 8 per session (close 1013). For one user, one phone, one laptop, two browser tabs, that's already 4. Add a Capacitor wrap, a TV dashboard, a friend collaborating, and you blow the cap. The plan doesn't reconcile this with the multi-device PWA story or the future Capacitor wrap. **Fix:** raise the cap to 32, document the reasoning (subscribers are cheap; broadcast back-pressure is the real concern, and `broadcast::channel(256)` handles that separately).

### 7. Scheduler is one of five locked pillars but gets 6h of frontend love.

User-vision.md emphasizes Scheduler as a real pillar: "boot agents en agents een command/prompt/skill laten starten, of bestaande agents iets sturen hierin." Two job types (boot + send), schedulable via cron OR free-text. The backend (M8) is solid. The frontend (M21, 6h) is a list + dialog + history. Where's:

- The expression builder that previews the next 5 runs as you type?
- The "send to which session?" picker that respects active session state?
- The dry-run/test-fire-now button that proves your schedule works before it's live?
- The "boot a /cso agent" template flow — does the user have to type out the boot config every time, or is there a "save as preset" path?

**Fix:** M21 LOC 500 → 650, time 6h → 9h. Add "preset boot recipes" + "next-5-runs preview" + "test fire" as acceptance.

### 8. M5 ships status reliability before any frontend can show it.

Critical-path-wise: M0 → M1 → M3 → M4 → M5 → M13 → M14 → M15 = 8 sequential milestones before a user can see the status dot pulse. That's ~60 hours of work with zero demoable wow. This is engineering ordering, not product ordering.

**Fix:** consider an inversion of the critical path. After M3 (tmux + send/receive works), ship a "thin frontend slice" that proves the loop: M11-lite + M12-lite + M13 against M3 directly. WS isn't strictly required for the hero demo — capture-pane polling at 500ms is fine for the first walking-skeleton. Then M4 + M5 backfill the production-quality stream + status. This trades 5h of throwaway work for 40h earlier demo-ability. Massive CEO leverage.

### 9. There is no milestone for "icons, brand, microcopy, sound."

The plan has 27 milestones for boxes-and-arrows and zero for the product feeling like a thing someone designed. App icon? Splash screen color? Brand tint (the plan says "Termius-style brand teal or Anthropic-style amber" — pick one)? Toast microcopy? Empty-state illustrations? Pulse sound for "needs input"? These are not optional polish — they're what separates "competent" from "Steve Jobs proud."

**Fix:** add M28 "Brand + microcopy + sound" (~4h). Spec below.

### 10. Acceptance criteria treats Jobs as a checklist, not a feel.

M24 makes the 20 Termius criteria into checkboxes. Good. But "Jobs proud" isn't "18/20 pass." It's "a stranger picks up this phone, uses it for 30 seconds, and says 'wait, what is this?'" The plan has no provision for that test. **Fix:** M24 acceptance gains a section: "5 strangers (not on the team) try the iPhone PWA cold for 60 seconds each. Record their faces. If any face shows confusion in the first 10 seconds, fix and re-run."

---

## Milestones to KILL (within scope)

None. All 27 milestones are within the locked scope and earn their keep. The plan is well-pruned at the milestone level. The problem is under-specification, not over-scope.

(The one near-miss: M22 Settings 4h budget for theme + tokens + audit log is fine; don't expand it. But move the API-key fields out of M22 and into M1 — they're config-shaped, not UI-shaped, and lumping them in Settings turns Settings into a kitchen-drawer.)

---

## Milestones to AMPLIFY (within scope)

### AMPLIFY M11 — SessionTile hero (6h → 10h)

**What's missing:** the tail-preview data binding (see Worry #1), skeleton loader during initial load, error state when tmux session is missing, the long-press quick-peek modal currently lumped here should use a real LiveTerminal embed (not a screenshot), pulse animation interaction with status changes mid-render (no jank when status flips while user hovers), respect Reduce Motion accessibility setting end-to-end.

**Add to acceptance:**
- Hover-peek expands tail from 6 → 14 lines within one spring frame (16ms).
- Long-press on mobile opens a real live-streaming embed, not a static peek.
- Skeleton loader shows for the 200ms before SSE delivers initial sessions.
- Tile re-renders cleanly when `preview_lines` updates mid-hover (no flicker, no scroll jump).
- Reduce Motion disables hover-scale and pulse, replaces with crossfade.

### AMPLIFY M12 — Overview (5h → 7h)

**What's missing:** empty state (no sessions), error state (backend unreachable), search empty-result state, view-toggle animation (tile↔list should morph, not cut), the FAB-to-NewSessionSheet animation, the "+ New Session" sheet UX needs more love than "name/dir/desc/provider/worktree checkbox" — at minimum a "based on" template picker so the modal doesn't feel like a database form.

**Add to acceptance:**
- Empty state with single CTA "Boot your first agent" that opens NewSessionSheet pre-filled with a sensible default.
- View-toggle morphs tiles ↔ rows via layout animation (Framer Motion `layout` prop).
- Search yields "No matches" state with secondary CTA "Clear search."
- NewSessionSheet has a "Quick start" tab with 3 preset boot configs and an "Advanced" tab with all fields.

### AMPLIFY M14 — Desktop focus (6h → 9h)

**What's missing:** the entire desktop dock (see Worry #4). Also: the session-strip on the left needs to itself feel like the tile grid — compact tiles with status dots, current-session highlight via a spring not a class flip, hover-peek behavior inherited (a quick-peek tail expansion while hovering a non-current tile in the strip). Today it reads as "list of names." That's not what cmux users expect after seeing the sidebar density spec in `cmux-amux-landscape.md`.

**Add to acceptance:**
- Session strip compact tiles show status dot + name + token count + branch (matches cmux sidebar density).
- Hovering a non-current compact tile expands a 14-line tail preview in a popover (left-anchored, 380×220).
- Desktop dock includes: ⌘K command palette button, slash-menu trigger, snippet drawer toggle, 4-key send-row (Esc/Tab/Ctrl-C/Ctrl-U editable), detach + stop.

### AMPLIFY M15 — Mobile focus (8h → 11h)

**What's missing:** the bottom-sheet dismiss-to-overview semantic (currently the sheet just shrinks to peek detent; what gets the user back to overview?), the session-pill horizontal swipe (specified, but no spec for what the user sees mid-swipe — is there a preview of the next session? is there a haptic at the boundary? does it spring back if dropped under threshold?), the edge-swipe-left/right gestures from user-vision.md ("edge swipe right = back to overview, edge swipe left = next session") not specified at all.

**Add to acceptance:**
- Edge-swipe-right from any focus mode = back to overview (matches user-vision.md).
- Edge-swipe-left = next session in pinned-then-active order.
- Session-pill horizontal swipe shows a preview of the next session's title + status dot during the drag, springs back if released before 40% threshold, snaps with `.sheetDetent` spring if past threshold.
- Sheet drag-down past peek detent dismisses to overview (current spec only goes to peek).

### AMPLIFY M21 — Scheduler (6h → 9h)

(See Worry #7.)

### AMPLIFY M23 — Cross-cutting polish (5h → 8h, or split into M23a + M23b)

**What's missing:** see Worry #5. PWA on iOS is its own beast. Split View Transitions + Reconnect Banner (M23a, 4h) from PWA-on-iOS (M23b, 4h). PWA-on-iOS acceptance must include: A2HS instructions sheet for first-time iOS users (Apple gives no install button), splash screen for every iPhone screen size (or one cleverly designed mask icon), status-bar-style verified on iPhone 14/15/16 notch + dynamic-island, viewport-fit cover behavior in safe-area, standalone-mode detection (different chrome when launched from home screen vs Safari).

### AMPLIFY M24 — Acceptance (8h → 11h)

(See Worry #10.) Add the "5 strangers, 60 seconds" test. Record observations. Re-iterate.

---

## NEW milestones to ADD (within scope — they fill genuine gaps, not new features)

### M27 — Time to Wow (4h)

**Depends on:** M11, M12, M13, M14, M15, M23, M26.

**Scope (~150 LOC + design):**
- First-launch detection (`localStorage['amux-v3-first-launch']` absent).
- If v2 data migrated (M26), first-launch state shows: "Welcome back. Your N sessions are here." with a one-tap tour overlay highlighting the tile-peek, the focus mode, the scheduler.
- If no v2 data, first-launch shows the empty-state CTA flow built in M12 plus a one-tap "Boot a code-reviewer agent in this directory" demo button that uses a built-in skill.
- A "Run the 30-second demo" link in Settings that resets and replays this flow.

**Acceptance:**
- Cold install on iPhone, A2HS, open: within 5 seconds the user knows what amux is and what to tap next.
- 5 strangers test (see M24).

**Why this isn't scope creep:** every locked pillar is already in scope. This milestone is *integration of existing scope into a coherent first impression*. It's the difference between "the parts work" and "the product works."

### M28 — Brand + microcopy + sound (4h)

**Depends on:** nothing (can run in parallel with anything).

**Scope (~80 LOC + assets):**
- Pick the brand color. The plan currently says "Termius-style brand teal or Anthropic-style amber" — pick one and commit. Recommendation: a single brand tint registered as `--accent` in `globals.css`, used for status-active pulses, the FAB, the focus accent stroke.
- App icon: one SVG, exported to 192/512/maskable/apple-touch sizes. The icon should read at 32px.
- Splash screen color matches `theme_color` and `background_color` in manifest.
- "Needs input" subtle audio cue (200ms, one-shot, generated via Web Audio API — no asset file). User-controllable in Settings.
- Microcopy pass: every empty state, every error state, every confirm dialog. Keep voice consistent — direct, builder-to-builder, no "Oops!" no "Great!"
- Toast component: glass capsule, 36pt tall, slides in from top with `.smooth(0.35)` per Termius spec.

**Acceptance:**
- App icon visible on iPhone home screen, recognizable at small size.
- Splash screen color matches first-frame paint (no flash of wrong color).
- "Needs input" plays the cue on transition (debounced).
- Settings has a "Sounds" toggle.

### M29 — Performance budget pass (3h)

**Depends on:** M11, M12, M13.

**Scope (~50 LOC + measurement):**
- Overview with 20 tiles, each receiving live `preview_lines` deltas every 2s: must hit 60fps on iPhone 14, 30fps on iPhone SE.
- Focus mode terminal: keystroke-to-display latency must stay under 50ms on LAN, under 100ms over Tailscale (the plan claims this; M29 verifies it).
- Hover-peek expand animation: no dropped frames during the 6→14 line transition.

**Acceptance:**
- Lighthouse perf score ≥85 on the overview route.
- Chrome DevTools Performance trace shows no long tasks >50ms during steady-state SSE updates.
- iPhone Safari Web Inspector shows no jank during hover-peek on 20-tile grid.

---

## Specific edits to TECH_PLAN.md (line-precise diffs)

1. **§0 Executive summary, line 15:** add to the "Key architecture decisions" paragraph: "Overview tile tail-preview is delivered via SSE `sessions` event payload's new `preview_lines: string[]` field, derived from the status detector's `tmux capture-pane` output that already runs every 2s. No per-tile WS, no polling." Why: closes the hero-data-flow gap (Worry #1).

2. **§3.3 schema, line 723 (`session_runtime` table):** add column `last_capture TEXT NOT NULL DEFAULT ''`. Why: persists the capture-pane output the tile preview reads from.

3. **§3.4 HTTP API table, around line 874:** add a row: `GET | /api/sessions | Returns SessionSummary[] including preview_lines (last 6 lines of last_capture)`. Document that the SSE `sessions` event payload uses the same shape, deltas only.

4. **§3.2.7 PtyStream, line 491 area:** add a `tail(n: usize) -> Vec<String>` method on PtyStream that returns the last N lines of the replay buffer. Why: gives the SessionSummary builder a fast path that doesn't need to re-`tmux capture-pane`.

5. **§3.2.7 line 485, broadcast capacity:** change `broadcast::Sender<Bytes>` cap from 256 to 1024, and raise WS subscribers-per-session from 8 to 32 (Worry #6). The plan's defensive numbers are too tight for multi-device PWA.

6. **§4.3 SessionTile spec, line 1074:** under "Default state," change "rendered as static text via `<TailPreview lines={s.preview_lines} />`" to: "rendered from `s.preview_lines` which is delivered via the SSE `sessions` event payload (deltas only). Updates morph in via `<motion.div layout>` so new lines slide up; no scroll jump."

7. **§4.4 Focus mode mobile, line 1132:** add bullets for the missing edge-swipe gestures: "Edge-swipe-right from any focus state = navigate('/'). Edge-swipe-left = next session in pinned+active order." Match user-vision.md "Gestures" section verbatim.

8. **§4.4 Focus mode desktop, line 1119:** add a full §4.4.3 "Desktop dock" subsection (parallel to §4.4.1 mobile dock) with: ⌘K palette trigger, slash-menu launcher, snippet drawer toggle, 4-chip send-row, detach button, stop button. ~30 lines of spec mirroring §4.4.1's density.

9. **§4 add new subsection §4.11 "Empty states":** one paragraph per route describing message, illustration (SVG inline), CTA, spring used. Make this part of M11/M12/M19/M20/M21/M22 acceptance.

10. **§4 add new subsection §4.12 "Loading and error states":** skeleton loader patterns (tile skeleton, list skeleton), error state (backend unreachable, session missing), retry CTAs.

11. **§10 milestone list, M11 line 1668-1676:** time budget 6h → 10h, scope LOC 350 → 500, add the acceptance bullets listed under "AMPLIFY M11" above.

12. **§10 milestone list, M12 line 1678-1687:** time budget 5h → 7h, add empty-state + view-toggle-morph + NewSessionSheet template tabs to acceptance.

13. **§10 milestone list, M14 line 1698-1707:** time budget 6h → 9h, LOC 400 → 550, add desktop dock + compact-tile peek-popover acceptance.

14. **§10 milestone list, M15 line 1708-1717:** time budget 8h → 11h, add edge-swipe + session-pill swipe-preview + drag-down-to-overview acceptance.

15. **§10 milestone list, M21 line 1768-1777:** time budget 6h → 9h, LOC 500 → 650, add next-5-runs preview + test-fire + preset boot recipes.

16. **§10 milestone list, M23 line 1788-1797:** split into M23a (View Transitions + Reconnect Banner, 4h) and M23b (PWA on iOS, 4h). Acceptance for M23b: A2HS instructions sheet, splash screens, status-bar-style verified on notched + Dynamic Island devices.

17. **§10 milestone list, M24 line 1798-1807:** time budget 8h → 11h, add the "5 strangers, 60 seconds" qualitative test as required acceptance.

18. **§10 add M27 "Time to wow"** per the spec above. Depends on M11, M12, M13, M14, M15, M23, M26. 4h.

19. **§10 add M28 "Brand + microcopy + sound"** per the spec above. No deps. 4h. Can run in parallel with anything.

20. **§10 add M29 "Performance budget pass"** per the spec above. Depends on M11, M12, M13. 3h.

21. **§0 Executive summary, milestone count + time budget (line 13):** update "27 milestones (M0–M26)" → "30 milestones (M0–M29)", update "~140 engineering-hours" → "~165 engineering-hours" (add 25h for the AMPLIFY budget bumps and 11h for M27+M28+M29).

22. **§10 dependency graph (line 1830-1850):** add M27, M28, M29 nodes. Note that M28 is parallel-anywhere.

23. **§10 critical path (line 1858):** update to "M0 → M1 → M3 → M4 → M5 → M13 → M14 → M15 → M23a → M24 → M25 → M26 → M27 (13 milestones, ~85h serial)."

24. **§12 Risks + mitigations (around line 1910):** add: "**Risk:** the tile-tail-preview hero moment depends on data flow not in the original spec. **Mitigation:** §3.3 + §3.4 edits land in M1, verified in M2 acceptance, exercised in M11."

---

## What we should re-test against user-vision.md after these revisions

After applying the edits above, walk back through user-vision.md and confirm:

- **Line 5 ("dense tile grid... small gap, ~4-8pt")** — the M11 amplification makes this real, but the precise gap value needs to be in §4.3. Currently §4.3 doesn't say. Add: `gap-2` (8px) for the CSS grid.

- **Lines 10-12 ("Title at top = the Claude Code chat description... NOT the tmux session name. Falls back to session name")** — the Session struct has `task_summary` and `cc_session_name` but no field obviously named for "the chat description." Confirm `task_summary` is the right source, or add `chat_title` explicitly. The plan doesn't specify how this is extracted from Claude Code.

- **Line 13 ("Bottom portion of the terminal: a small live preview")** — covered by edits 1-6 above. Re-verify after M11 ships that this is actually live, not stale.

- **Line 15 ("Status indicator: subtle dot or border")** — §4.3 says dot AND animated border on active/waiting. User-vision.md says "subtle." The pulse-border-on-every-active-tile might be visually noisy at scale (20 tiles, several active). Re-test on a real grid.

- **Line 27 ("Real tmux feel: keyboard is fully captured")** — M14 covers this for desktop but the IME bullet point is buried. Re-verify Japanese/CJK input still works end-to-end (xterm + IME composition is famously fiddly).

- **Lines 33-50 ("Focus mode — Mobile (iOS)")** — most of the Termius-grade interactions are M15/M16/M17/M18. After amplification, run all 20 acceptance criteria from termius-ios-native-spec.md against real hardware before declaring done.

- **Line 53 ("All must feel just as native as the focus mode")** — Board, Files, Scheduler all currently get 1-2 milestones with minimal spec for native feel. Add to M19/M20/M21 acceptance: "renders with the same spring presets, glass materials, and haptics as M15."

- **Line 75 ("Reliable status indicators — multi-signal")** — covered by M5, the crown jewel. Already excellent.

- **Lines 83-86 (Anti-vision)** — re-check the plan never adds a "we'll just show a list of sessions" fallback that betrays "BE in tmux, via web."

- **Line 89 ("Either fix or remove")** — this is the Jobs ratchet. Make it explicit policy in M24: if any acceptance criterion fails on real hardware and can't be fixed in <1 day, the feature ships disabled with a "coming soon" message rather than degraded.

---

## Bottom line

This plan is engineering-strong and product-cautious. The Rust backend is the most rigorous part — ship M0-M9 close to as written, with the schema/SSE edits in #1-6 above. The frontend is where the plan reads like a checklist of components rather than a sequence designed to make first contact feel inevitable.

**Don't ship as-is.** Make these revisions first:

1. Define the tile-tail data flow (edits #1-6) — this is the single biggest hole.
2. Amplify M11, M12, M14, M15, M21, M23, M24 with the bumps above (~25 extra hours).
3. Add M27 (Time to Wow), M28 (Brand+microcopy+sound), M29 (Perf budget) (~11 extra hours).
4. Add §4.11 (Empty states) and §4.12 (Loading/error) — without these the product feels cheap on day one.
5. Total: 27 milestones → 30 milestones, 140h → 165h. An 18% time bump for the difference between "competent ground-up rebuild" and "Steve Jobs proud."

Then dispatch subagents. The plan is a 9/10 build spec masquerading as a 6/10 product spec. The fixes above lift the product spec to match the build. After that, ship.
