## Status (2026-08-17) — SHIPPED; the checkboxes below are history

> **The whole Grok-UI program shipped.** Track A (A1–A6) and Track B (B0–B5) are on
> `main`, together with the wave-1 follow-ups (#79–#85) and the session-state series
> (#86–#89). Landing PRs: **A1 #57 · A5 #72 · A6 #76 · B1 #69 (+ #70 perf gate) ·
> B2 #74 · B3 #75 · B4 #73 · B5 #78**. (A2–A4 landed earlier in the A-track sequence;
> their PR numbers are deliberately not guessed here.)
>
> **The checkbox state below is historical, not authoritative.** These plans were
> execution documents: boxes were ticked opportunistically while work was in flight,
> so an unticked box does *not* mean unshipped, and a ticked box is not evidence that
> the code exists (see the register's "finding 23 rule"). Nothing below has been
> back-edited to match reality — this note is the only reconciliation.
>
> **The authority on what is actually done and what is still owed** is the debt
> register snapshot committed alongside these plans:
> [`debt-register-2026-08-17.md`](./debt-register-2026-08-17.md), which was verified
> row-by-row against code on `origin/main`. That snapshot was generated at `6caafdf`
> (#87), i.e. just before #88 and #89 merged, and it is the reason this banner exists:
> the ledger and the code had drifted apart.

---

# Fase B1 — The shell: one glass language, route morphs, scheduler fold

**Worktree** `/opt/projects/supermux-b1` · **branch** `feat/b1-shell`, off `origin/main`
(`4cc1fee` — B0 is **merged**; A2/A3/A4 are separate stacks and B1 must not depend on them).
**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` on the unmerged
branch `docs/grok-ui-plan` — read with
`git show origin/docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`.
B1 scope = master plan **§11** (the shell), **§12.7/§12.8** (header grammar, navigation
slimming) and the **§17 B1 row**.
**Format model** `docs/superpowers/plans/2026-08-14-fase-a3-chat-surface.md`.

> One sentence of scope: **B0 gave the app a palette; B1 gives it a body** — one painted
> substrate instead of six independent page backgrounds, one chrome-height contract, one
> overlay component, one navigation transition, and the scheduler folded into Settings so the
> nav can start shrinking. No new server endpoints, no data-plane changes, nothing from Track A.

---

## 0. Ground truth — what actually exists at `origin/main` (post-B0)

Everything below was read in a detached worktree at `4cc1fee`. **The master plan is a design
document written before B0 landed; six of its B1 assumptions are wrong against the real tree.**
Those rows are the reason this plan exists.

### 0.1 What the master plan assumes vs. what is there

| master-plan assumption | reality at `origin/main` | consequence for B1 |
|---|---|---|
| B0 shipped `--sm-toolbar-min-h`, `.sm-swap`, chrome-slot utilities and `springs.ts` curve additions (§17 B0 row) | **None of them exist.** B0 shipped only the paper/ink/hairline ladder + accent utilities (`globals.css:137-289`), marks, chat primitives, `tokens.ts`. `springs.ts` is untouched (67 lines, no `settle`, no exit tweens) | B1 **inherits the whole chrome-token layer** (T2). Budget one extra task. |
| `--sm-toolbar-min-h` is a new token | The contract already exists and is documented and shipped as **`@utility safe-header`** (`globals.css:343-364`: `min-height:3.5rem` + `padding-top:env(safe-area-inset-top)`), with a long comment explaining *exactly* the additive-floor rule the master plan restates | Do **not** invent a parallel mechanism. `--sm-toolbar-min-h` becomes the *value behind* `safe-header`, plus a 44px compact twin. |
| z-ladder is "content 1 → panes/headers 3-5 → overlay 20 → popovers 30 → presence 50" | The shipped ladder is: content `z-10/20/30`, Radix popover/dropdown/tooltip/dialog/sheet **`z-50`**, Vaul sheets + ResponsiveSheet + KeyBar + connection overlay **`z-[60]`**, compose panel `z-[64]/[65]`, action sheets + a2hs + snippet editor `z-[70]/[71]`, tour overlay `z-[78]`, floating tip `z-[80]` — 14 call sites at `z-[60]` alone | The master-plan numbers **cannot be adopted verbatim** without renumbering ~50 call sites. B1 ships the ladder as **named tokens mapped onto the existing numbers** + documents it in `BRAND.md`; renumbering is out of scope. |
| "first consumer [of the shell overlay] is the Attention card" | **The Attention card does not exist.** It is fase **A4** T5 (`docs/superpowers/plans/2026-08-14-fase-a4-interactivity.md:447`) and A4 is not merged | B1 ships `ShellOverlay` + a real, existing first consumer (**`ArchivedSheet`**, already shell-mounted at `layout.tsx:275`) + the exact prop contract A4 T5 will mount, benched at `/dev/shell`. |
| nav slims to "Overview · Focus · Files · Settings" | Board removal is **B2** (gated on the issue read surface). NAV today is 6 items (`layout.tsx:46-61`) | B1 leaves nav at **5** items (Board still there) and says so in the PR body. |
| `morph.tsx` is "promoted from 3 call sites" | `useNavigateMorph()` has **4** consumers (`board.tsx:40`, `focus/desktop.tsx:37`, `focus/mobile.tsx:49`, `group-grid.tsx:82`); `<MorphLink>` (`morph.tsx:103-131`) has **zero**; the reduced-motion-ignoring duplicate is `session-row.tsx:16-33` (16-33, not 19-34) | Unchanged in substance — the duplicate is real and does ignore `prefers-reduced-motion`, so deleting it is a **behaviour fix**, not a refactor. |

### 0.2 Files B1 will touch, and what they currently own

| file | current state | B1 |
|---|---|---|
| `web/src/components/layout.tsx` | shell root `div.flex.h-full.w-full` (`:251-277`); `SideNav` `bg-card border-r` (`:89-91`); `BottomNav` `bg-card border-t` (`:166-170`); active pill via framer `layoutId="nav-active-desktop"` (`:113-119`) and `"nav-active-mobile"` (`:186-192`); `NAV` incl. `{ to:'/scheduler', tour:'scheduler' }` (`:56`); `<CommandPalette/>` + `<ArchivedSheet/>` mounted at `:270/:275` | substrate + tints, MorphNavLink, VT-named pill, NAV −1, overlay host |
| `web/src/styles/globals.css` | 761 lines. B0 ladder `:156-197`; accent `:214-224`; safe utils `:300-312`; `safe-header` `:343-364`; `.glass` (`backdrop-filter: blur(20px) saturate(180%)`) `:382-403` + reduced-transparency/`@supports` fallbacks `:391-403`; VT block `:484-521` | chrome tokens, `.sm-swap`, substrate layers, overlay/scrim, VT nav rule |
| `web/src/lib/springs.ts` | 67 lines; `springs`, `eases`, `tweens`; no overlay curves | + `settle` / overlay + popover enter-exit tweens |
| `web/src/components/view-transitions/morph.tsx` | `withViewTransition`, `vtSessionName`, `useNavigateMorph`, unused `MorphLink` | + `MorphNavLink` |
| `web/src/components/session-tile/session-row.tsx` | local `useNavigateMorph` copy `:16-33`, **no reduced-motion guard** | delete, import the canonical one |
| `web/src/components/ui/responsive-sheet.tsx` | forks on `(pointer: coarse)` `:62`; Vaul `z-[60]` `:91-97`; desktop = shadcn `Sheet side="right"` | becomes `ShellOverlay`'s mobile form (unchanged internals) |
| `web/src/components/focus-mode/mobile-sheet.tsx` | full-screen `fixed inset-x-0 bottom-0 z-50 h-dvh`, height/bottom driven by `useKeyboardViewport` (`hooks/use-keyboard-viewport.ts`, `KEYBOARD_OPEN_THRESHOLD=80`) | **untouched** — it is the regression subject |
| `web/src/components/focus-mode/key-bar.tsx` | `fixed left-1/2 z-[60]`, `top: calc(env(safe-area-inset-top) + 44px + 20px)` (`:293-295`) | **untouched** — regression subject |
| `web/src/routes/settings.tsx` | 934 lines; route-local scroller `:800`; sticky glass bar `min-h-12 … pt-safe sm:pt-0` `:809-816`; `max-w-2xl` column `:824`; large `<h1>` `:825-830`; hash-anchor scroll `:770-789` (drives `/hosts` → `#hosts`); sections: Appearance, Notifications, Updates, Model, Hosts, Claude tools, Onboarding, API keys, Connection, Experimental, Snippets, Audit log | + `<SchedulesSection id="schedules">`, tokenised header floor |
| `web/src/routes/scheduler.tsx` | 284 lines; `max-w-5xl` column `:83`; 2xl `<h1>` `:85`; 5-col grid list `:141-258`; `ScheduleDetailSheet` (already `ResponsiveSheet`) `:88/:143` in `components/scheduler/schedule-detail-sheet.tsx`; `useSchedulerStream()` SSE, `EnableToggle`, `EMPTY.scheduler`, skeleton, error+retry | **deleted**; every capability re-homed |
| `web/src/routes/files.tsx` | header already `glass safe-header … sm:pt-0` `:190-192` | reference implementation; token swap only |
| `web/src/routes/overview.tsx` | body-padding header, `<h1 class="text-2xl">` `:520-521`; tour anchors `data-tour="new-session"` `:601`, `data-tour="tile"` `:697/:713` | adopts the Settings large-title + glass-bar grammar |
| `web/src/components/onboarding/tour-overlay.tsx` | `STEP_TARGETS` `:33-36`; step 3 = `[data-tour="scheduler"]` (the nav item); copy in `brand/copy.ts:202-215`; `floating-tip.tsx` falls back to a screen-centred card when an anchor is missing | retarget + rewrite step 3 + an anchor-existence test |
| `web/src/App.tsx` | routes `:83-102`; `/hosts` → `/settings#hosts` redirect pattern `:97-100`; DEV-only lazy `/dev/*` routes `:19-50,103-172` | `/scheduler` redirect, `/dev/shell` |
| `web/src/components/command-palette/command-palette.tsx` | board verbs only (`:354-390`), gated to `/board`; **no** scheduler verb, **no** route navigation commands | nothing to remove (palette navigation is **B3**) |

### 0.3 Test & tooling reality

- Unit tests are **`bun test`**, not vitest: `bun run test:unit` → `bun test tests/unit` (12 suites).
  Component assertions use `renderToStaticMarkup` from `react-dom/server` (see
  `tests/unit/chat-ui-primitives.test.tsx`); CSS contracts are asserted by **parsing
  `globals.css`** (`tests/unit/brand-tokens.test.ts`) — B1 reuses both idioms.
- E2E is Playwright against a **real server binary** per spec (`tests/e2e/smoke/harness.ts`,
  `playwright.config.ts`, `testDir: ./tests/e2e/smoke`, serial, 90s timeout). Mobile specs use
  `test.use({ ...devices['iPhone 14 Pro'] })` — see `mobile-scroll-button-no-keyboard.spec.ts`,
  `ios-pwa-chrome.spec.ts`. On this box export `SUPERMUX_E2E_NO_SANDBOX=1`.
- Type/lint: `bun run build` (`tsc -b && vite build`), `bun run lint` (eslint 9 flat).
- Perf gate: `bun run build:perf` — baseline after B0 **158.40 KB gz app JS / 17.08 KB gz CSS**
  (budgets 200 / 30).
- Offline VR rig (memory *offline-mobile-ui-review-rig*): worktree Vite
  `bunx vite --port 5201 --strictPort --host 127.0.0.1`, Playwright from
  `/opt/projects/folderwijzer/app/backend/node_modules/playwright`, chromium headless-shell with
  `LD_LIBRARY_PATH=/home/supermux/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu:/home/supermux/.local/chromelibs/extract/lib/x86_64-linux-gnu`
  and `args:['--no-sandbox','--no-zygote','--disable-gpu']`, **`deviceScaleFactor: 1`**.
  Theme is a class on `<html>` — force with `document.documentElement.classList` in-page;
  **every VR check in this plan is two shots, light and dark.**

---

## 1. Deliverables

```
web/src/styles/globals.css          chrome tokens, z-ladder tokens, .sm-swap,
                                    substrate layers, overlay/scrim, VT nav rule
web/src/lib/springs.ts              + overlay/popover enter-exit curves
web/src/lib/shell-substrate-flag.ts NEW — PR-#27-pattern kill switch
web/src/components/layout.tsx       substrate + tints + MorphNavLink + VT pill +
                                    NAV −1 + ShellOverlay host
web/src/components/shell/
  shell-overlay.tsx                 NEW — desktop shell-absolute overlay / mobile ResponsiveSheet
  shell-overlay-frame.ts            NEW (pure) — container-query frame sizing math
  use-shell-overlay.ts              NEW — context + host portal target
web/src/components/view-transitions/morph.tsx   + <MorphNavLink>
web/src/components/session-tile/session-row.tsx  − duplicate morph
web/src/components/settings/schedules-section.tsx NEW — the folded scheduler
web/src/components/archived/archived-sheet.tsx   first ShellOverlay consumer
web/src/components/onboarding/tour-overlay.tsx   step-3 retarget
web/src/brand/copy.ts               step-3 copy
web/src/routes/settings.tsx         + Schedules section, tokenised header
web/src/routes/overview.tsx         header grammar
web/src/routes/files.tsx            token swap only
web/src/routes/scheduler.tsx        DELETED
web/src/routes/dev-shell.tsx        NEW — /dev/shell bench (DEV-only, lazy)
web/src/App.tsx                     /scheduler redirect, /dev/shell route
web/src/brand/BRAND.md              z-ladder + chrome + overlay vocabulary
web/tests/unit/
  shell-chrome-tokens.test.ts       NEW
  shell-overlay-frame.test.ts       NEW
  shell-overlay.test.tsx            NEW
  tour-anchors.test.ts              NEW
  schedules-section.test.tsx        NEW
web/tests/e2e/smoke/
  shell-containing-block.spec.ts    NEW — the mobile-keyboard + keybar guard
  shell-overlay.spec.ts             NEW
  nav-morph-pill.spec.ts            NEW
  scheduler-fold.spec.ts            NEW
```

---

## 2. Tasks

Ten tasks. TDD wherever there is anything to assert: the pure module or the CSS-parsing test
first, then the code that satisfies it. Every task ends green on `bun run test:unit` **and**
`bun run lint`. **T1 lands before T3 — the regression net exists before the thing it guards.**

### T1 — The regression net (before any pixel moves)

- [x] **T1.1** `web/tests/e2e/smoke/shell-containing-block.spec.ts` — the master plan's named
      hazard, made executable. A non-`none` `backdrop-filter`/`filter`/`transform`/`perspective`/
      `contain:paint`/`will-change:transform` on an ancestor turns that element into the
      containing block for every `fixed` descendant, which silently breaks
      `mobile-sheet.tsx`'s `visualViewport` math, the KeyBar, the joystick and the tour overlay.
      Spec (device `iPhone 14 Pro`, real backend via `harness.ts`):
      1. boot a session, navigate to `/focus/<name>`;
      2. `page.evaluate` walks `parentElement` from `[data-testid="focus-sheet"]` **and** from
         the KeyBar (`[role="toolbar"][aria-label="Key bar"]`) up to `<html>`, collecting any
         ancestor whose computed style contains a containing-block trigger;
      3. assert the collected list is **empty**;
      4. assert `getBoundingClientRect()` of `[data-testid="focus-sheet"]` still has
         `bottom === window.innerHeight` and `left === 0` (a broken containing block moves it).
- [x] **T1.2** Same spec, keybar z-order: with the KeyBar rendered, assert it is the
      `elementFromPoint` hit at its own centre (nothing paints over it) and that its computed
      `z-index` is ≥ the focus sheet's. Simulate the keyboard by dispatching a
      `visualViewport` resize through `addInitScript` (Playwright cannot open a soft keyboard) —
      shim `window.visualViewport.height` to `innerHeight - 320`, fire `resize`, and assert the
      sheet's height follows and the KeyBar is still hit-testable.
- [x] **T1.3** `web/tests/unit/shell-chrome-tokens.test.ts` — CSS-parsing guard in the
      `brand-tokens.test.ts` idiom: assert `globals.css` declares `backdrop-filter` **only**
      inside `@utility glass` and its two fallback blocks, and never on `html`, `body`, the
      shell-root selector or any `--sm-substrate*` rule. This is the invariant that must survive
      every future PR, not just B1.
- [x] **Verify:** `bun run test:unit` green; `SUPERMUX_E2E_NO_SANDBOX=1 bunx playwright test
      tests/e2e/smoke/shell-containing-block.spec.ts` green **on today's code** (it must pass
      before T3 so a later failure is unambiguous evidence of a substrate regression).

*DoD:* three tests, all green, zero source files touched.

> **T1 status — DONE** (`bc1959a`). Evidence: `bun run test:unit` 692 pass / 0 fail
> across 32 files; the e2e spec passes on pre-substrate code (4.8s).
> **Deviations:**
> · T1.1 + T1.2 are ONE Playwright test, not two. This box runs chromium with
>   `--single-process` (`SUPERMUX_E2E_NO_SANDBOX=1`), where a second browser context in the
>   same spec file cannot be created (`browserContext.newPage: Target … has been closed`) —
>   every other mobile spec in the suite is a single test for the same reason. Both phases
>   (keyboard closed, simulated keyboard) run in the one test, all assertions intact.
> · The e2e rig needs `LD_LIBRARY_PATH=/home/supermux/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu:/home/supermux/.local/chromelibs/extract/lib/x86_64-linux-gnu`
>   on this host (chrome-headless-shell can't find `libatk-1.0.so.0` otherwise), and a
>   `server/target/release/supermux-server` symlink into the worktree (`harness.ts` resolves
>   the binary relative to the worktree root).
> · **`bun run lint` is ALREADY RED on `origin/main`** — 6 `react-hooks/set-state-in-effect`
>   errors in pre-existing `src/` files (verified by stashing B1's diff). B1's standard is
>   therefore **zero NEW lint errors**, not a green `lint`.

### T2 — The chrome-token layer B0 didn't ship

- [x] **T2.1** `globals.css`, `:root`: `--sm-toolbar-min-h: 3.5rem` (56px, route headers) and
      `--sm-toolbar-min-h-compact: 2.75rem` (44px, in-pane headers — the focus header's proven
      `min-h-11`). Rewrite `@utility safe-header` (`:358-364`) to
      `min-height: var(--sm-toolbar-min-h); padding-top: env(safe-area-inset-top)` — same
      computed value, now tokenised — and add `@utility safe-header-compact` on the 44px floor.
      Keep the existing comment block verbatim; append the **per-column decision**:
      *route headers (overview/files/settings) 56px; in-pane headers (focus, side pane, overlay)
      44px; never a fixed height, always floor + additive `pt-safe`.*
- [x] **T2.2** z-ladder **tokens over the shipped numbers** (see §0.1): `--sm-z-content:10`,
      `--sm-z-pane:20`, `--sm-z-header:30`, `--sm-z-overlay:50`, `--sm-z-sheet:60`,
      `--sm-z-compose:65`, `--sm-z-actionsheet:70`, `--sm-z-tour:78`, `--sm-z-tip:80`. Document
      the full ladder (name → number → who lives there) in `BRAND.md`. **No renumbering of
      existing call sites in B1** — new B1 code uses the tokens, everything else is left alone
      and the ladder is now written down so B2+ can converge.
- [x] **T2.3** `.sm-swap` (§11.6): `display:grid` container, `> *` at `grid-area:1/1`,
      `transition: opacity .26s`, `[data-hidden]{opacity:0;pointer-events:none}` +
      a `prefers-reduced-motion` twin that drops the transition. Zero layout shift is the whole
      point — the unit test asserts the declarations exist and that no `position:absolute` is
      used (that was the old idiom and it re-typesets).
- [x] **T2.4** `springs.ts`: `settle` (overlay enter, ≈520ms — spring `stiffness:210,
      damping:30`) and `tweens.overlayExit {duration:0.30}`, `tweens.popoverIn {duration:0.15}`,
      `tweens.popoverOut {duration:0.10}`. The rule that must appear in the file header:
      **exits are always faster than entries.**
- [x] **T2.5** Extend `shell-chrome-tokens.test.ts`: every token above is declared exactly once;
      `safe-header` resolves through `var(--sm-toolbar-min-h)` (not a literal);
      `tweens.overlayExit.duration < 0.52` and `popoverOut < popoverIn` asserted in TS.
- [x] **Verify:** `bun run test:unit`, `bun run lint`, `bun run build:perf` (CSS ≤ 20 KB gz).
      Visual: `/dev/chat-ui` and `/dev/marks` unchanged in both themes (this task must be a
      pure addition — nothing consumes the tokens yet).

*DoD:* tokens exist and are tested; **zero rendered-pixel diff**.

> **T2 status — DONE** (`3ca8739`). `bun run test:unit` 715 pass / 0 fail (32 files);
> `tsc -b --noEmit` clean; lint unchanged at the 6 pre-existing errors.
> **Deviation — the perf baseline in §0.3 is stale, and the B1 budget with it.**
> Measured on `origin/main` (post A2/A3/A4) by stashing the B1 diff:
> **192.21 KB gz app JS / 19.49 KB gz CSS** — not 158.40 / 17.08. A2–A4 added ~34 KB of
> app JS, so the plan's "app JS ≤ 165 KB" is unreachable and its "CSS ≤ 20 KB" leaves
> B1 only 0.5 KB. The budget is therefore restated as the SAME HEADROOM against the real
> baseline: **app JS ≤ 198.5 KB gz** (+6.3) and **CSS ≤ 22.4 KB gz** (+2.9), both well
> inside the repo's own enforced 200 / 30 gate. After T2: 192.24 KB JS / 19.67 KB CSS.

### T3 — Painted substrate + tinted columns (the riskiest task)

- [x] **T3.1** `web/src/lib/shell-substrate-flag.ts`, modelled byte-for-byte on
      `lib/term-history-flag.ts`: `SUBSTRATE_KEY = 'supermux:shell-substrate'`, **default ON**,
      only an explicit `'0'` disables. Read once in `Layout` and published as
      `data-substrate={on ? '' : undefined}` on the shell root, beside the existing
      `data-standalone` (`layout.tsx:252-255`).
- [x] **T3.2** `globals.css`: the substrate is **paint, never blur**.
      `[data-substrate] { background: var(--sm-paper); }` on the shell root, and per-column
      tints as opaque `color-mix` layers, not alpha over an unknown backdrop:
      nav rail → `--sm-paper`; content column → `--sm-paper-raised`; side panes →
      `color-mix(in oklab, var(--sm-accent) var(--sm-accent-wash-mix), var(--sm-paper))`
      (the existing `sm-accent-wash` utility — reuse, do not fork).
      Column separators are **0.5px absolute `::after` strips** using `--sm-hairline` and
      `--sm-hairline-w`, never `border` (a 1px border is a different physical line at DPR 2).
- [x] **T3.3** `layout.tsx`: `SideNav` `bg-card border-r border-border` → substrate rail +
      `::after` hairline; `BottomNav` `bg-card border-t` → same; `<main>` gets the raised tint.
      Under `[data-substrate]` **only** — without the attribute every current class still
      applies, so the kill switch is a true one-attribute revert with no redeploy.
- [x] **T3.4** `.glass` is untouched and stays the *only* `backdrop-filter` in the app
      (floating chrome: headers, composer, popovers, KeyBar). Re-read the a2hs note
      (`pwa/a2hs-sheet.tsx:95-98`, iOS WebKit dead-taps under backdrop-filter ancestors) before
      touching anything named "glass".
- [x] **Verify:** T1's three tests still green — **this is the gate**. Then VR both themes at
      `/dev/shell`, `/`, `/files`, `/settings`, `/focus/<mock>` desktop **and** iPhone-14-Pro
      viewport, held against the same shots taken before T3. Then flip the kill switch in the
      console (`localStorage['supermux:shell-substrate']='0'`, reload) and confirm the pre-B1
      appearance returns exactly.

*DoD:* one substrate, zero `backdrop-filter` outside `.glass`, kill switch proven both ways.

> **T3 status — DONE** (`c529408`). T1's e2e passes WITH the substrate on (2.7s) — the gate.
> VR rig: `scratchpad/vr.mjs` (worktree Vite + real server binary + seeded sessions,
> chromium headless-shell 1223, DPR 1); shots in `~/b1-vr/{pre-T3,post-T3}`;
> perceptual diff via `scratchpad/imgdiff.py` (byte compare is useless — the app renders
> live timestamps). Kill switch: substrate OFF ≡ pre-T3 on all 36 shots (max 1.3% changed
> pixels, all live-timestamp / hairline-AA noise, crops hand-checked). Substrate ON:
> 90–99% of pixels shift ≥1 level on shelled routes in BOTH themes; `/dev/*` byte-identical
> (also re-proves T2's zero-pixel DoD); mobile focus untouched at 0.05%.
> **Deviations / findings:**
> · Column tints are hooked with `data-shell-rail` / `data-shell-tabs` /
>   `data-shell-content` / `data-shell-pane` attributes rather than by selecting on the
>   existing Tailwind classes — the classes have to STAY for the kill switch to be a real
>   revert, so the substrate needs its own, higher-specificity handle.
> · `[data-shell-pane]` ships with no consumer in the shell (there is no shell-level side
>   pane today); its first user is `<ShellOverlay variant="pane">` in T6.
> · **The "`.glass` is the only backdrop-filter in the app" claim is already false in
>   TSX**: 24 files use Tailwind's `backdrop-blur-*` utility (settings' sticky header
>   among them). B1's invariant is therefore scoped exactly as T1.3 words it — *globals.css*
>   declares backdrop-filter only in `glass` — plus the runtime ancestor-walk on the focus
>   route, which is where the hazard actually bites. Converting those 24 call sites is a
>   separate, much larger change and is NOT in B1.

### T4 — Resolve the `layoutId` ↔ view-transition nav-pill collision

The collision is real and specific: the active pill animates with framer `layoutId`
(`layout.tsx:113-119` desktop, `:186-192` mobile). Once nav clicks route through
`startViewTransition` (T5), the browser snapshots the old DOM **mid-spring** and cross-fades it
against the new one — the pill double-animates (a frozen ghost sliding under a live spring).

- [x] **T4.1** Resolution (primary): **delete both `layoutId` pills** and re-express the active
      pill as a view-transition-named element — the active `<span>` carries
      `style={{ viewTransitionName: 'sm-nav-active' }}` (one per snapshot: only one NavLink is
      active). The browser owns the morph; framer no longer participates. Reduced motion and
      non-VT browsers get a hard cut, which is the documented, already-shipped degradation
      (`globals.css:516-521` disables `::view-transition-*` wholesale).
- [x] **T4.2** `globals.css`: `::view-transition-group(sm-nav-active)` gets the nav's own
      duration/easing (`.26s`, the in-place morph speed) so it is not governed by the root
      cross-fade.
- [x] **T4.3** Documented fallback if the morph reads badly on the mobile 4px bar: keep
      `layoutId` and **exclude the nav from the transition** by giving each nav a stable
      `view-transition-name` with `::view-transition-group(sm-nav){animation:none}`. Write which
      one shipped, and why, in the file header — the master plan asks for the decision, not just
      a fix.
- [x] **T4.4** `web/tests/e2e/smoke/nav-morph-pill.spec.ts`: desktop chromium — navigate
      `/` → `/files` → `/settings`; assert exactly one element in the DOM has
      `viewTransitionName === 'sm-nav-active'` at rest, that it sits under the active link, and
      that `document.querySelectorAll('[data-framer-layout-id]')` finds no nav pill. A second
      run with `test.use({ reducedMotion: 'reduce' })` asserts navigation still completes and no
      transition pseudo-element is created.
- [x] **Verify:** the e2e above + a slow-motion VR pass (`page.emulateMedia` off, capture at
      120ms/260ms into the navigation) in both themes.

*DoD:* one animation per navigation, provably.

> **T4 status — DONE** (`ed0ab37`). The primary resolution (T4.1) shipped; T4.3's exclusion
> fallback was not needed and is written up in `morph.tsx`'s header instead.
> **Deviations:**
> · T4.4's "assert `document.querySelectorAll('[data-framer-layout-id]')` finds no nav pill"
>   is not implementable — **framer-motion emits no such attribute**; `layoutId` is internal
>   state, and it drives the element by writing an inline `transform` each frame. The spec
>   asserts the observable equivalent instead: no inline `transform` on the settled pill.
> · A stronger check replaced the weaker one: the spec wraps `startViewTransition` and
>   asserts every transition's `ready` promise RESOLVED. A duplicate
>   `view-transition-name` among rendered elements rejects `ready` and silently skips the
>   animation — that is the actual failure mode, and it is now caught.
> · Both nav pills are in the DOM at every width (`hidden md:flex` vs `md:hidden`), so the
>   count assertion must filter to RENDERED elements — which is exactly what the View
>   Transitions API itself does with `display: none` subtrees.
> · The reduced-motion pass is a phase of the same test via `page.emulateMedia`, not a
>   second `test.use({reducedMotion})` block (single-process chromium, see T1).

### T5 — `<MorphNavLink>` on the nav + delete the session-row duplicate

- [x] **T5.1** `morph.tsx`: add `<MorphNavLink>` — react-router `NavLink` (keeps `isActive`
      render-prop, `aria-current`, `end`) with the same click-interception as `MorphLink`
      (`:108-123`: bail on `defaultPrevented`, non-primary button, or any modifier, so
      middle-click / ⌘-click / "open in new tab" stay native), routing the plain left-click
      through `useNavigateMorph()`. `MorphLink` stays as-is for plain links.
- [x] **T5.2** `layout.tsx`: both `NavLink`s (`:102-110`, `:174-182`) become `MorphNavLink`.
      Zero other prop changes.
- [x] **T5.3** Delete `session-row.tsx:16-33` and import `useNavigateMorph` from
      `@/components/view-transitions/morph`. **This is a behaviour fix**: the local copy calls
      `startViewTransition` unconditionally and never checks
      `prefers-reduced-motion` (the canonical one does, `morph.tsx:53-59`).
- [x] **T5.4** `web/tests/unit/*`: a `renderToStaticMarkup` assertion that `MorphNavLink`
      renders a real `<a href>` (crawlable, modifier-clickable) and that the active item carries
      `aria-current="page"`. In `nav-morph-pill.spec.ts`, add: ⌘-click on a nav item opens a new
      page context rather than morphing.
- [x] **Verify:** `bun run test:unit`, `bun run lint`, and a manual reduced-motion pass on the
      overview list view (the row that used to ignore the setting).

*DoD:* one morph implementation in the codebase; `grep -rn "startViewTransition" web/src` returns
`morph.tsx` only.

> **T5 status — DONE** (`ed0ab37`, same commit as T4 — the pill rewrite and the link swap
> are the same edit to `layout.tsx` and could not be split without leaving the tree broken
> in between). `grep -rn "startViewTransition" web/src` now returns `morph.tsx` only (plus
> three prose comments). Unit test lives in `tests/unit/shell-nav-link.test.tsx` (a new
> file — the plan said only "web/tests/unit/*").

### T6 — `<ShellOverlay>` — three fidelities, one component

Master plan §11.4 + Grok device 16: *inline card / side pane / overlay-or-sheet are the same
component with a `variant` prop that changes only chrome.*

- [x] **T6.1** `shell-overlay-frame.ts` (pure, tested first):
      `frameSize({cqh, cqw})` → `min(100cqh − 72, 62.5cqw − 45, 512)` in px, plus the CSS string
      the component emits. Unit tests pin all three clamp branches and the 512 ceiling.
- [x] **T6.2** `use-shell-overlay.ts`: a context published by `Layout` exposing the overlay host
      element (the content column, which gets `position:relative` + `container-type:size`), so
      any route can raise an overlay without prop-drilling and without a body-level portal.
- [x] **T6.3** `shell-overlay.tsx`:
      - **desktop (`≥md`, `pointer:fine`)** — `position:absolute; inset:0` **inside the shell**
        so the nav rail and header stay visible; scrim `#00000061` with `cursor:default` and
        click-to-dismiss; frame sized by T6.1 container queries; a 26px `.glass` close button;
        `Esc` closes; focus trapped in the frame; enter with `springs.settle`, exit with
        `tweens.overlayExit`; z = `var(--sm-z-overlay)`.
      - **mobile** — renders `<ResponsiveSheet>` verbatim (`ui/responsive-sheet.tsx`, unchanged).
        The master plan's reason is load-bearing: on mobile the focus route strips the navs and
        lives in a body-level fixed sheet, so a shell-absolute overlay would be occluded.
      - `variant: 'frame' | 'pane'` — `pane` renders the §11.3 side-pane form (3-column grid
        `minmax(0,auto) minmax(0,1fr) minmax(0,auto)`, child `position:absolute; inset:0 0 0
        auto`, so content never re-typesets while the width animates).
- [x] **T6.4** **First consumer: `ArchivedSheet`** (`components/archived/archived-sheet.tsx`,
      already mounted at shell level, `layout.tsx:275`, already `ResponsiveSheet`-based). Swap
      its shell for `<ShellOverlay variant="frame">`: desktop becomes the shell overlay, mobile
      is byte-identical. Chosen because it is shell-mounted, low-traffic, and reversible.
      *(The Attention card — the master plan's intended first consumer — does not exist yet; see
      §0.1. B1 ships the exact prop shape A4 T5 needs and says so in the file header.)*
- [x] **T6.5** `routes/dev-shell.tsx` + a lazy DEV route in `App.tsx` (mirror `/dev/chat-ui`,
      `App.tsx:46-50,163-172`): the shell with mock content, a theme switch, overlay
      open/closed, `variant` frame/pane, an Attention-card-shaped placeholder, and a
      "fake keyboard" toggle that shims `visualViewport` — the bench every VR shot comes from.
- [x] **T6.6** Tests: `shell-overlay-frame.test.ts` (pure); `shell-overlay.test.tsx`
      (`renderToStaticMarkup`: desktop emits an absolutely-positioned frame with no `position:
      fixed`; mobile emits `data-testid="responsive-sheet"`);
      `e2e/smoke/shell-overlay.spec.ts` (desktop: nav rail still visible and clickable behind
      the scrim, scrim click and `Esc` both dismiss, focus returns to the trigger; mobile
      iPhone-14-Pro: the sheet renders and the overlay does **not**).
- [x] **Verify:** the above + VR at `/dev/shell`, both themes, both variants, desktop and mobile.

*DoD:* one overlay component with two device forms and a bench; `ArchivedSheet` proves it.

> **T6 status — DONE** (`70f267d`). unit 738 pass / 0 fail (35 files); both e2e specs green;
> T1's containing-block spec still green WITH the overlay shipped. VR: `~/b1-vr/post-T6`
> (16 shots — closed / frame / pane / fake-keyboard × light+dark × desktop+iPhone).
> **Deviations / findings:**
> · **A4 has landed, and it changes §0.1's row about the first consumer.** The Attention
>   card now exists (`components/chat/attention-card.tsx`) but its overlay form is
>   IN-PANE (`<AttentionOverlay>`, over the chat pane only) — it is NOT a ShellOverlay
>   consumer. `ArchivedSheet` remains the right first consumer, and the prop shape is
>   still the one A4's plan assumed.
> · **T6.2's "content column gets `container-type: size`" is a live containing-block
>   hazard** and could not be shipped as written: `container-type: size` implies LAYOUT
>   containment, which makes the element a containing block for `position: fixed`
>   descendants — and the content column hosts the mobile focus sheet, the KeyBar and the
>   joystick. Shipped gated on `@media (min-width: 768px)` AND an `data-overlay-open`
>   attribute the overlay sets only while open, so it can never be active while any mobile
>   fixed chrome is mounted.
> · T6.6's `renderToStaticMarkup` assertions could not be written against `<ShellOverlay>`:
>   `react-dom/server` executes neither `createPortal` NOR Vaul's `Drawer.Portal`, so BOTH
>   branches render an empty string. The portal-free `<ShellOverlayBody>` is exported and
>   asserted instead, and the device fork is proven in e2e where it is real.
> · The mobile e2e is a separate file (`shell-overlay-mobile.spec.ts`) because it needs a
>   touch-emulating context and this host cannot hold two contexts at once.
> · `web/tsconfig.json` gains the `@/*` path mapping (bun does not follow project
>   references, so alias imports failed in `bun test`). Additive; the build is unaffected.
> · Bug found by the bench and fixed: the substrate's `[data-shell-pane]` rule declared
>   `position: relative`, and because the substrate block is unlayered it silently
>   overrode the pane's own `absolute inset-y-0 right-0`.

### T7 — One header grammar on the remaining routes

- [x] **T7.1** `settings.tsx:809-816`: the sticky bar's hand-rolled `min-h-12 … pt-safe sm:pt-0`
      becomes the tokenised route-header contract. Settings is a **route** header, so the
      default is the 56px floor (`safe-header`); keep 48px only if the VR diff shows the taller
      floor crowds the large title — take the screenshot, decide, and record the decision in a
      comment beside the class. Everything else about this header (scroll-driven opacity,
      large-title behaviour) is the **sanctioned variant** per §12.7 and stays untouched.
- [x] **T7.2** `overview.tsx:520-521`: adopt the Settings grammar — a sticky `glass safe-header`
      bar carrying the title at **17px/600** that fades in on scroll, plus the existing large
      title below it in the scrolling body. The header's crossfading inners (view toggle, search
      state) move into a `.sm-swap` container so no swap shifts layout. **Row content is not
      touched** — the roster rebuild is B2.
- [x] **T7.3** `files.tsx:190-192`: already conformant; only confirm it resolves through the new
      token (no class change expected).
- [x] **T7.4** `BRAND.md`: the header grammar as a rule — *floor + additive `pt-safe`, never a
      fixed height; 56px route / 44px in-pane; title 17/600; crossfading inners in `.sm-swap`.*
- [x] **Verify:** VR both themes × (desktop, iPhone 14 Pro) × (`/`, `/files`, `/settings`),
      **plus the PWA standalone check** — re-run `tests/e2e/smoke/ios-pwa-chrome.spec.ts`, which
      is the existing guard against exactly the notch-clipping failure this contract prevents.

*DoD:* three routes, one grammar, notch-safe on all of them.

> **T7 status — DONE** (`b28da7b`). VR: `~/b1-vr/{T7-settings,T7-overview,T7-overview-scrolled}`.
> **Deviations / decisions:**
> · T7.1's decision, taken from the screenshots: Settings drops its 48px exception and takes
>   the **56px route floor**. The large title lives in the scrolling body with its own
>   padding, so the taller bar does not crowd it; the whole page simply shifts 8px (≈15%
>   changed pixels on the iPhone shot, which is what that number is). Recorded beside the
>   class. The header's material also becomes `glass` instead of a hand-rolled
>   `bg-background/70 backdrop-blur-xl` — one fewer bespoke backdrop-filter, and it gains
>   the reduced-transparency fallback.
> · **T7.2 needed a scroll-architecture change the plan did not anticipate.** Overview's
>   root was `h-full` and it relied on the shell's `<main>` to scroll — under which
>   `position: sticky` is impossible (a sticky child's containing block ends one viewport
>   down, so the bar unsticks mid-scroll). Overview is now its own scroller, exactly as
>   settings.tsx already was. Two consequences, both intentional: the body's
>   `pt-[calc(env(safe-area-inset-top)+1rem)]` is gone (the `safe-header` bar owns that
>   inset now; keeping both would stack a dead band on a notched phone), and the three
>   empty states move from `h-full` to `min-h-[55vh]` (a percentage height that needed the
>   old definite root). Row content untouched — B2's roster rebuild is unaffected.
> · T7.2's "`.sm-swap` for the header's crossfading inners": the view toggle and search are
>   NOT a crossfade (the mobile/desktop control fork is a media query, and the search field
>   is always present). The genuine same-cell swap in that header is the **density chip**,
>   which is tile-view only and shunted every control beside it sideways when it left. That
>   is what went into `.sm-swap`.
> · T7.3: `files.tsx` confirmed conformant, zero changes.
> · **Environment finding:** `overview-mobile-parity` (2 of 3) and `ios-pwa-chrome` (1 of 2)
>   FAIL on this host both before and after T7, identically. Two are the single-process
>   chromium "cannot create a second browser context in one spec file" limitation; one is a
>   touch-drag test. Verified by stashing the diff and re-running. Not a B1 regression.

### T8 — Scheduler → Settings section (a redesign, not a move; nothing dropped)

The current 5-column `max-w-5xl` table cannot be squeezed into a 42rem column — it is respeced.
**The functionality inventory below is the acceptance list; every line must be demonstrably live
in Settings before `routes/scheduler.tsx` is deleted.**

| capability | today | after |
|---|---|---|
| list schedules | `ScheduleList` 5-col grid (`scheduler.tsx:141-258`) | settings `Row`s: label = title, hint = human schedule · next fire · last fired, control = `EnableToggle` |
| create | `+ New schedule` → `ScheduleDetailSheet mode="create"` | `Section` header trailing `+` (the `HostsSection` pattern) → **same sheet, unchanged** |
| edit | row click → `ScheduleDetailSheet mode="edit"` | row tap → same sheet |
| enable / pause | `EnableToggle` inline | same component, in the `Row` control slot |
| test-fire | inside the detail sheet | unchanged |
| fire log + run history + idempotency status pills | `FireLog` in the detail sheet | unchanged |
| delete | detail sheet, inline confirm (`CONFIRM` copy) | unchanged |
| live updates | `useSchedulerStream()` SSE, never polled | moves into the section (mounted with Settings, exactly as it was mounted with the route) |
| session targets + display names | `listSessionNames()` + `displayLabel()` | unchanged, loaded by the section |
| empty state | `EmptyStatePlaceholder` + `EMPTY.scheduler` | same copy, settings-width |
| loading / error+retry | `ListSkeleton` / `ErrorState` | settings-grammar skeleton + the standard error row |

- [x] **T8.1** `components/settings/schedules-section.tsx`, modelled on
      `components/settings/hosts-section.tsx` (which already documents "all functionality from
      the former `/hosts` route is preserved 1:1" — same discipline, same primitives:
      `Section`/`Row` from `components/settings/primitives.tsx` + `ResponsiveSheet`).
      Root carries `id="schedules"` so `settings.tsx:770-789`'s hash-anchor scroll works.
- [x] **T8.2** `ScheduleDetailSheet`, `ScheduleEditor`, `ScheduleForm`, `FireLog`,
      `EnableToggle`, `helpers.ts`, `prompt-field.tsx` are **imported unchanged**. If a change
      proves unavoidable, it is a separate commit with its own justification.
- [x] **T8.3** `settings.tsx`: mount `<SchedulesSection/>` between `HostsSection` and
      `ClaudeToolsSection` (registry-ish config neighbours).
- [x] **T8.4** Delete `web/src/routes/scheduler.tsx` and its `App.tsx` import/route.
- [x] **T8.5** `web/tests/unit/schedules-section.test.tsx`: `renderToStaticMarkup` over a
      three-row fixture asserts every column of the table above is present in the settings row
      (title, human schedule, next, last, toggle) — the anti-drop test — and that the section
      root carries `id="schedules"`.
- [x] **T8.6** `web/tests/e2e/smoke/scheduler-fold.spec.ts` (real backend): create a schedule
      through the Settings section, see it in the list, toggle it off and back, open it, run
      Test-fire, see the run in the fire log, delete it. This is the "nothing dropped" evidence.
- [x] **Verify:** the two tests above + VR both themes, desktop and mobile (the mobile form is
      the Vaul sheet — confirm the drag handle and `pb-safe` still read correctly at
      `max-h-[92vh]`).

*DoD:* every row of the inventory table demonstrated in Settings; the route file is gone.

> **T8 status — DONE** (`dc9ac77`). Every row of the inventory table is demonstrated:
> `tests/e2e/smoke/scheduler-fold.spec.ts` drives redirect → anchor → create → list →
> toggle off → "paused" → toggle on → open → Run now → fire log → delete, green in 5.9s
> against a real backend; `tests/unit/schedules-section.test.tsx` (13 tests) is the
> anti-drop half. VR: `~/b1-vr/T8-schedules` (both themes × desktop + iPhone), and the
> `#schedules` hash anchor lands ON the section.
> **Deviations:**
> · The pure helpers (`SCHEDULES_ANCHOR`, `scheduleHintParts`) live in a sibling
>   `schedules-section.helpers.ts` rather than in the section file: the section then
>   exports components only (react-refresh warning gone) and the anti-drop test imports
>   the SAME function the UI renders from without dragging React + TanStack Query + an SSE
>   hook into a unit test.
> · `tests/e2e/smoke/scheduler-fires.spec.ts` needed one edit — it navigated to
>   `/scheduler`. It still does, which now also exercises the redirect. Green.
> · The old row's TARGET line (tmux session · command / boot dir / shell command) is not
>   in the plan's inventory table but WAS in the old row, so it is preserved and asserted
>   too — a sixth line in the acceptance list rather than a fifth.

### T9 — `/scheduler` redirect, nav slimming, onboarding retarget

- [x] **T9.1** `App.tsx`: `<Route path="/scheduler" element={<Navigate to="/settings#schedules"
      replace />} />` — the exact `/hosts` pattern (`App.tsx:97-100`), comment included.
- [x] **T9.2** `layout.tsx:56`: drop the Scheduler `NavItem`. Nav becomes **Overview · Focus
      (desktop) · Board · Files · Settings** — 5 items; Board leaves in B2 (§0.1).
- [x] **T9.3** `tour-overlay.tsx:35`: step 3 anchor `[data-tour="scheduler"]` →
      `[data-tour="settings"]`; add `tour: 'settings'` to the Settings `NavItem`. Rewrite
      `copy.ts:211-214` step-3 copy so it names the new home ("Schedules live in Settings now —
      boot agents or send commands on a cron expression"). Placement stays `'top'` (mobile tab
      bar); the desktop rail resolves `'right'` through the existing visible-match logic
      (`floating-tip.tsx:57-69`).
- [x] **T9.4** Re-verify step 4's anchor: `data-tour="new-session"` exists at
      `overview.tsx:601` and step 1/2's `data-tour="tile"` at `:697/:713` — unchanged by B1, but
      asserted from now on.
- [x] **T9.5** `web/tests/unit/tour-anchors.test.ts`: every selector in `STEP_TARGETS` appears
      as a literal `data-tour="…"` attribute somewhere in `web/src` (a source scan, in the
      `brand-tokens.test.ts` file-parsing idiom). This is the test that makes "the tour points at
      a page that no longer exists" structurally impossible — the risk the master plan names.
- [x] **T9.6** e2e: `/scheduler` lands on `/settings` with the Schedules section scrolled into
      view; the tour (localStorage flag cleared) reaches step 3 and anchors on a **real** rect,
      not the screen-centre fallback.
- [x] **Verify:** the two tests + a manual pass of the 4-step tour on mobile and desktop.

*DoD:* no dangling route, no dangling anchor, no dead nav item.

> **T9 status — DONE** (`dc9ac77`, same commit as T8 — deleting the route and adding its
> redirect cannot be split without leaving the tree broken in between).
> Nav is at **5** items (Overview · Focus · Board · Files · Settings); confirmed in the
> e2e accessibility snapshot. T9.4's anchors are asserted from now on by
> `tests/unit/tour-anchors.test.ts`, which also pins "exactly one target per tour step".
> **Deviation:** T9.6's tour half is its own spec (`tour-step3-anchor.spec.ts`) rather
> than a second test inside the fold spec — single-process chromium, as with T1/T6. It
> asserts the runtime consequence the unit test cannot: the step-3 tip is positioned
> against the Settings nav item's rect and is provably NOT the screen-centred no-anchor
> fallback.

### T10 — Integration gate

- [x] **T10.1** Run, in order, pasting real output into the PR body (no claim without evidence):
      ```
      cd /opt/projects/supermux-b1/web
      bun run lint
      bunx tsc -b --noEmit          # or `bun run build`, which runs tsc -b first
      bun run test:unit             # B0 + A1 suites + the 5 new ones, all green
      bun run build:perf            # app JS ≤ 200 KB gz, CSS ≤ 30 KB gz
      SUPERMUX_E2E_NO_SANDBOX=1 bunx playwright test tests/e2e/smoke
      ```
      **B1 budget:** app JS ≤ **165 KB** gz (baseline 158.40 — B1 is mostly CSS; a jump means
      the dev bench leaked into the entry chunk). CSS ≤ **20 KB** gz (baseline 17.08).
- [x] **T10.2** VR sweep, **both themes**, from the offline rig (§0.3) at DPR 1:
      `/dev/shell` (overlay open/closed × frame/pane × fake-keyboard on/off), `/`, `/files`,
      `/settings` (incl. `#schedules`), `/focus/<mock>` — desktop 1440×900 and iPhone 14 Pro.
      Every shot taken twice: `data-substrate` on and off (the kill-switch proof).
- [x] **T10.3** Regression re-run of the specs B1 could plausibly break:
      `ios-pwa-chrome.spec.ts`, `mobile-scroll-button-no-keyboard.spec.ts`,
      `focus-no-mobile-flash.spec.ts`, `overview-mobile-parity.spec.ts`,
      `mobile-terminal-scroll.spec.ts`, plus T1's `shell-containing-block.spec.ts`.
- [x] **T10.4** Dogfood side-by-side **on another port** — never restart the instance hosting
      this chat (memory: *Never restart this instance unasked*).
- [x] **T10.5** PR `feat/b1-shell` → `main`. Body: the VR grid, the perf table, the test output,
      the kill-switch instructions (`localStorage['supermux:shell-substrate']='0'`), the
      scheduler capability-inventory table with each row ticked, and the explicit note that nav
      is at 5 items (Board leaves in B2) and that `ShellOverlay`'s intended first consumer (the
      Attention card) arrives with A4. **Hand off — never self-merge** (memory: *User reviews all
      merges*).

*DoD:* green everything, evidence pasted, PR handed to the owner.

> **T10 status — DONE, with the e2e caveat spelled out below.**
>
> **T10.1 — gate output (verbatim):**
> · `bun run lint` → `37 problems (6 errors, 31 warnings)` — **byte-identical to
>   `origin/main`** (verified by stashing the diff). B1 adds ZERO lint problems. Lint is
>   already red on main; that is pre-existing and out of B1's scope.
> · `bunx tsc -b --noEmit` → clean.
> · `bun run test:unit` → **760 pass / 0 fail, 3355 expect() calls, 37 files** (was 692 /
>   32 at branch point; B1 adds 5 suites + 68 tests).
> · `bun run build:perf` → measured twice, before and after the rebase, because `main`
>   moved under the branch:
>     - at branch point (`f814abb`): main **192.21 KB** JS / **19.49 KB** CSS →
>       B1 **193.44 / 19.83**.
>     - after rebasing onto `ea642df` (#67): main **200.30 KB** JS / **19.62 KB** CSS →
>       B1 **201.52 / 19.97**.
>   **B1 costs +1.22 KB gz app JS and +0.35 KB gz CSS**, consistently, for a whole phase
>   of new UI — and the `/dev/shell` bench does NOT reach the production bundle (verified
>   by grepping `dist/assets/*.js` for its strings: absent).
>   **⚠ `bun run build:perf` now FAILS — and it fails on `origin/main` too.** Current
>   main is **200.30 KB against a 200.00 KB budget** (100%), i.e. the gate went red
>   independently of B1, in #67. B1 makes it 201.52. Deliberately NOT "fixed" here:
>   raising the number in `scripts/size-budget.mjs` would be silently weakening a gate,
>   and the real fix (lazy-loading `routes/settings.tsx`, which now pulls hosts- and
>   schedules-section eagerly, or splitting the entry chunk) is a scope call for the
>   owner, not something to smuggle into a shell PR. Flagged in the PR body.
>   (The plan's own ≤165 KB / ≤20 KB numbers were written against a pre-A2 baseline and
>   were already obsolete; see the T2 note.)
>
> **T10.3 / the smoke suite — the honest picture.**
> This host runs chromium with `--single-process` (`SUPERMUX_E2E_NO_SANDBOX=1`, the
> documented setting for a hardened box). Under it, **a spec file that opens a SECOND
> browser context kills the browser**, and every later test in the same playwright
> invocation then burns its full timeout. A whole-suite run is therefore meaningless here:
> `tests/e2e/smoke` gives 37 failed / 19 passed on THIS branch and the same cascade on
> `origin/main`. Per-file runs are the only measurement that means anything.
> Per-file, B1 vs `origin/main` (same host, same binary):
>
> | spec | origin/main | feat/b1-shell |
> |---|---|---|
> | `ios-pwa-chrome` | 1 failed, 1 passed | 1 failed, 1 passed |
> | `mobile-scroll-button-no-keyboard` | 1 failed | 1 failed |
> | `focus-no-mobile-flash` | 1 passed | 1 passed |
> | `overview-mobile-parity` | 2 failed, 1 passed | 2 failed, 1 passed (measured at T7 by stashing) |
>
> Identical in every case — B1 regresses nothing. Every B1-authored spec passes when run
> on its own: `shell-containing-block` (2.8s), `nav-morph-pill` (3.0s), `shell-overlay`
> (3.9s), `shell-overlay-mobile` (2.2s), `scheduler-fold` (5.9s), `tour-step3-anchor`
> (5.1s), plus the modified `scheduler-fires` (10.4s).
>
> **T10.2 — VR sweep.** 96 shots in `~/b1-vr/final`: 12 surfaces (`/dev/shell` ×4 states,
> `/dev/chat-ui`, `/dev/marks`, `/`, `/files`, `/settings`, `/settings#schedules`,
> `/scheduler`→redirect, `/focus/<seeded>`) × light+dark × desktop 1440×900 + iPhone 14
> Pro × substrate on/off, all at DPR 1. Per-task sweeps also kept:
> `~/b1-vr/{pre-T3,post-T3,post-T6,T7-settings,T7-overview,T7-overview-scrolled,T8-schedules}`.
> Kill-switch proof holds at the end of the phase: substrate ON vs OFF differs on every
> shelled surface in both themes (37–99% of pixels at threshold 1) and the mobile focus
> route is untouched (0.05%), which is exactly right — it strips both navs and lives in
> its own body-level fixed sheet.
>
> **T10.5 — PR:** https://github.com/sanderbz/supermux/pull/69 (`feat/b1-shell` → `main`,
> rebased onto `ea642df`, zero file overlap with the commits main gained mid-phase).
> Handed off, NOT self-merged.
>
> **T10.4 — dogfood.** NOT done: this box's supermux instance on 8824 hosts the session
> doing the work, and the memory *Never restart this instance unasked* is explicit. The
> branch is dogfoodable side-by-side on another port by the owner; the kill switch makes
> the risky half revertible without a redeploy either way.

---

## 3. Constraints, restated as checkable rules

| rule | how it is checked |
|---|---|
| no new deps | `git diff web/package.json` is empty |
| no `backdrop-filter` outside `.glass` | T1.3 CSS-parsing test + T1.1 ancestor walk |
| substrate is opaque paint | grep the diff: no `backdrop-filter`, no `filter`, no `opacity < 1` on a shell-column background |
| every separator is 0.5px | new separators use `--sm-hairline-w`; grep the diff for `border-t`/`border-b` on substrate columns |
| motion only from `springs.ts` | grep the diff for `cubic-bezier(` and `transition: all`; the sanctioned exceptions are `.sm-swap`'s `.26s` opacity and the pre-existing `mobile-sheet.tsx` keyboard curve |
| exits faster than entries | T2.5 asserts it numerically |
| reduced-motion twin for every motion | `useReducedMotion()` beside each `motion.*`; `::view-transition-*` already disabled wholesale (`globals.css:516-521`) |
| kill switch is a one-attribute revert | T3 verify step, both directions, no rebuild |
| no z-index renumbering | `git diff` touches no existing `z-[…]` literal; new code uses `var(--sm-z-*)` |
| no colour literals | new CSS/TSX contains no `#rrggbb` — B0 tokens only |
| scheduler loses nothing | T8's inventory table + T8.5 unit test + T8.6 e2e |
| no Track A coupling | the diff touches no file under `components/chat/`, no server code, no migration |
| existing tests are the net | the 12 B0/A1 unit suites and the mobile e2e specs stay untouched and green |

---

## 4. Risks

1. **The substrate breaks fixed-position mobile chrome (the master plan's own named risk).**
   Root cause is the containing-block hazard, not colour. Mitigated structurally: the substrate
   is opaque paint; `.glass` (the only `backdrop-filter`) never moves onto an ancestor of a
   `fixed` element; T1's ancestor-walk spec lands **first** and gates T3; the kill switch reverts
   without a redeploy.
2. **The nav-pill fix looks worse than the bug.** Handing the pill to the browser means it hard-
   cuts on Firefox/older Safari and under reduced motion. Accepted (that is already the app's
   documented VT degradation), with T4.3's exclusion approach written up as the ready fallback.
3. **Scheduler fold silently drops a capability.** The 5-column table → settings rows is where
   things get "simplified away". Mitigated by the inventory table being an acceptance list, a
   unit test asserting every column survives, an e2e that drives create→toggle→test-fire→
   fire-log→delete, and by importing the detail sheet **unchanged**.
4. **Overview's header change collides with B2's roster work.** Contained: B1 changes the header
   *shell* only (floor, glass bar, `.sm-swap`), never a row. Stated in the PR body so B2's
   author knows the shell is already converged.
5. **`ShellOverlay` is designed for a consumer that does not exist.** An overlay shaped around a
   hypothetical Attention card can be wrong in ways only A4 discovers. Mitigated by wiring a
   real consumer (`ArchivedSheet`), by the `/dev/shell` bench carrying an Attention-shaped
   placeholder at the real container-query size, and by keeping the API to the two props A4's
   plan already assumes (`open`, `onOpenChange`, `variant`).
6. **Token layer inflation.** B1 absorbs B0's undelivered chrome tokens on top of its own scope.
   Mitigated by T2 being a pure addition with a zero-pixel-diff DoD — if T2 changes a
   screenshot, something is already wrong.
7. **Branch churn.** A2/A3/A4 are in flight on other branches and touch `App.tsx` and
   `globals.css` too. Rebase on `main` before opening the PR, never merge main into the branch,
   and keep B1's `globals.css` additions in clearly fenced blocks so the conflict resolution is
   mechanical.

---

## 5. Explicitly out of scope

Scroll-edge mask fades (§11.8), the facepile morph (§11.9), the presence layer (§11.10),
same-cell crossfade rolled out app-wide beyond the two headers B1 touches (§11.6 consumers),
the side pane's real consumers (changes rail, session info — §11.3 ships the `pane` variant,
not its users), quick-peek → `ResponsiveSheet` (B5), the z-index renumbering, the roster row and
attention tiers (B2), Board removal and the issue read surface (B2), `<EntityPicker>` and palette
navigation (B3), per-session schedules and conversational creation (B4), and every Track A
surface (chat panel, Attention card, composer).
