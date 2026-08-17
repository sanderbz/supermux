# A6 T0.3 — the triage gate

Every row of the A6 plan's §0.1 debt table gets **exactly one** of `A6` / `A7-blocker` / `B5` /
`later` / `wontfix`, plus a one-line reason, **re-verified against the code at `a7cc52c`** rather
than transcribed from the ledgers.

That re-verification is the point. Only A5, B1, B2 and B4 carry real *execution* ledgers; A2, A3
and A4 have none, so their "explicitly deferred" sections are authoring-time intentions and nobody
recorded what shipped. **Row #4 is a ticked box that provably did not ship**, and **row #26's
headroom number was stale by a factor of twenty** — both found by this pass, not by the ledgers.

`A7-blocker` items must close in this fase or the fase does not end.

## Corrections this pass made to the plan's own audit

| # | the plan said | the code says |
|---|---|---|
| 26 | app JS 205.46 / 210 KB — **"~4.5 KB of headroom"** | **209.79 / 210.00 KB — 0.21 KB.** Measured on `origin/main` (`a7cc52c`) at the start of A6. The plan was written against a pre-B2-merge build. **A6, B3, B5 and A7 share 0.21 KB, not 4.5 KB** — so every task in this fase must be net-neutral or negative on bytes, and `T5.3` (the `statusline` delta type) is dead on arrival unless paid for by a deletion |
| 6 | `bunx playwright install webkit` fixes the mobile config | webkit **2287 now installs and its binaries resolve**, but it **still cannot launch on this box** — see the T0.4 record below. A no-sudo VPS with no GPU is the blocker, not the version |
| 27 | six pre-existing lint errors | confirmed: **6 errors, 33 warnings** on `origin/main` |
| 36 | `⌘1..9` registered twice with two different slot maps | confirmed, and **sharper than recorded**: `use-keyboard-capture.ts:107` jumps by **0-based split-pane index** (`Number(key) - 1`), `overview.tsx:548-565` jumps by **1-based roster slot** (`jumpIndexBySession`). Two mental models for one chord. They are on different routes so they do not collide at runtime — the defect is the ambiguity, not a double-fire |

## The table

| # | item | class | verdict | reason |
|---|---|---|---|---|
| 1 | Subagent turns invisible in chat; `fetch-full` would 404 for them | user-visible | **A7-blocker → A6** | Re-verified: `ws.rs:364` `find_full_entry` opens ONE path; `wire-entries.ts:353,453` drop `agent_id != null`. Closed in T4.1 by making the silence a stated fact rather than an accident |
| 2 | Truncated entries unrecoverable inside chat | user-visible | **A7-blocker → A6** | Re-verified: `chat-socket.ts` never retried a failed fetch, and the only affordance was a non-interactive `title`. Closed in T4.2 with a real retry + loading + failure state |
| 3 | Hook-token delegate endpoint on the bearer router | infra/security | later (own gate) | `b4-security-checklist.md:73-82` already records the follow-up shape; it needs an owner decision about credential scope, not a hardening fase |
| 4 | `model` missing from new-session | user-visible + **ledger integrity** | **A6** | Re-verified: zero occurrences of `model` in `new-session-sheet.tsx`. The B2 ledger's ticked box is corrected in the same commit — a plan that lies about what shipped is worse than a missing field |
| 5 | `ios-pwa-chrome` 1-of-2 red; one context per spec file | infra (rig) | A6 (rig) / later (the spec) | The host constraint is structural (single-process chromium). Recorded, not fought |
| 6 | `playwright.mobile.config.ts` cannot launch (webkit) | infra + invalidated evidence | **A6** | See T0.4 below. Partially closed: the engine is installed and its dependency closure resolved; the launch is blocked by something no-sudo cannot fix |
| 7 | Chat faces ≠ roster identity (`pinFor` unwired) | user-visible | **A7-blocker → A6** | Re-verified: `pinFor=` had exactly three call sites, two internal and one **dev bench**. Closed in T4.3 |
| 8 | Attention card still pane-scoped | polish | B5 | `<ShellOverlay variant="frame">` exists with no consumer; converting it is a lifecycle-surface change, and B5 owns that surface |
| 9 | Changes rail | feature gap | later | Deferred three times already (A4→A5→B1). A hardening fase is not where a deferred feature lands. Captured as a named gap (S27) |
| 10 | Context %/cost in the chat header | user-visible | later | Gated on #20, which is gated on the bundle budget being non-zero |
| 11 | Plan-dialog `Esc` still `actOn:false` | honest degradation | later | Needs a live capture that never landed; it degrades honestly today |
| 12 | Queued-prompt pill + cancel (P9) | feature gap | later | A new primitive. §5 closes the vocabulary at A4's set + B4's system lines |
| 13 | Bash "always allow" `actOn:false` | — | **wontfix** | A closed decision with a 2.1.233-verified rationale. Not re-opened |
| 14 | `KEY_ALLOWLIST` never widened to `0-9` | infra | later | Documented workarounds exist |
| 15 | The `T` renderer hotkey is desktop-only | user-visible | later | Hardware keyboard on a phone; the mobile route has no keydown capture at all, so this is a surface-sized change |
| 16 | Quick-peek has no chat lens | polish | B5 | B5 owns quick-peek → `ResponsiveSheet` |
| 17 | The default flip | — | **A7** | A separate small PR, after the owner's hands-on. A6 changes no default |
| 18 | chat for codex/remote/team | feature | later | Excluded by the Global Constraints provider guard; §5 keeps it |
| 19 | Roster context % | infra→feature | later | Needs a `statuslines` field on the sessions delta |
| 20 | The dark `statusline` delta key | infra | **later** (was "A6 if cheap") | It is not cheap any more: 0.21 KB of headroom, and a type + a consumer does not fit. The measured reason is recorded here, per T5.3's own instruction |
| 21 | No typed Rust struct for the sessions delta | infra | later | Thirteen `json!` sites; too wide for a hardening fase |
| 22 | Cross-device seen-cursors | user-visible | B5 | B5 owns lifecycle + notification state |
| 23 | Tailers never warm for unattached sessions | — | **wontfix** | A recorded architectural decision; re-decide only on evidence |
| 24 | `MemberStatusDot` never merged into the mark vocabulary | polish | B5 | Same surface as B5's roster lifecycle work |
| 25 | Board API not deprecated | infra | later | Needs its own owner gate |
| 26 | **Bundle budget** | infra | **A6 (constraint, not a task)** | Corrected to 0.21 KB. Every A6 commit reports its delta; deletions are preferred to additions throughout |
| 27 | `bun run lint` red on main (6 errors) | infra | **A6 (partial)** | T5.4 fixes the one in a file A6 touches; the bar stays "zero NEW", and improves by one |
| 28 | z-ladder never renumbered | infra | later | ~50 call sites; a refactor, not a hardening |
| 29 | 24 files use `backdrop-blur-*` outside `.glass` | infra / mobile-perf | later, **hazard tested in T9.1** | The refactor is deferred; the `position:fixed`-captured-by-`backdrop-filter` hazard it creates is asserted |
| 30 | B1's T10.4 dogfood never done | verification debt | **A6 (T10)** | T10 is in the showcase group that runs on final main |
| 31 | B1's unshipped §11 items | polish | later | Scroll-edge masks, facepile morph, presence layer, side-pane consumers |
| 32 | `tests/e2e/status-dot-pulse.spec.ts` orphaned | infra | **A6 — ADOPT** | Re-verified: no config's `testDir` covers it (`./tests/e2e/smoke`, `./tests/e2e/mobile`, `./tests/e2e/screens`). B2 was asked to decide and did neither. T1.3 decides |
| 33 | `RosterRow` → `SessionIdentityRow` rename declined | — | **wontfix** | Alias documented. Not re-raised |
| 34 | B4's `harness` SSE frame on the global channel | security, accepted | later | Accepted for that fase with the reasoning written down; no prompt body leaks |
| 35 | B4 out-of-scope chips | feature | later, except board-issue | Subagent chips share their root with #1 |
| 36 | Two B3 defects pullable forward | a11y + UX | **A6** | `role="option"` (T5.2/T7) is a genuine a11y bug and is fixed. The `⌘1..9` divergence is documented (see the correction table) rather than unified: aligning the two slot maps changes what the chord MEANS on the focus route, which is a B3 decision, not a hardening one |

## Counts

| verdict | count |
|---|---|
| **A7-blocker, closed in A6** | **3** (#1, #2, #7) |
| A6 (other) | 6 (#4, #6, #26, #27, #32, #36) |
| B5 | 4 (#8, #16, #22, #24) |
| A7 | 1 (#17) |
| later | 18 |
| wontfix | 3 (#13, #23, #33) |
| **closed or actioned in A6** | **9** |
| **re-filed with a named owner** | **27** |

## T0.4 — the webkit record, in full

**A mobile screenshot taken with a mismatched or absent engine is not evidence**, and three prior
plans' mobile verification claims rest on exactly that. Here is what is true now.

| step | result |
|---|---|
| `bunx playwright install webkit` | **webkit-2287 downloaded and installed** (`~/.cache/ms-playwright/webkit-2287`). The version mismatch the plan names is fixed |
| its system dependency closure | **resolved without sudo.** 268 Ubuntu `.deb` packages fetched with `apt-get download` (which needs no root) and extracted into `~/.local/webkitlibs/extract`, then symlinked into the bundle's own `sys/lib` so Playwright's constructed `LD_LIBRARY_PATH` finds them. This mirrors the existing `~/.local/chromelibs` recipe. `ldd` on all four webkit binaries: **0 unresolved** |
| launching it | **FAILS.** `MiniBrowser` starts, then: `Could not create WPE EGL display: EGL_SUCCESS. Aborting...`. Headless WPE needs an EGL display; software mesa (`EGL_PLATFORM=surfaceless`, `LIBGL_ALWAYS_SOFTWARE=1`, `GALLIUM_DRIVER=llvmpipe`, `__EGL_VENDOR_LIBRARY_DIRS`) did not satisfy it on this GPU-less VPS |
| the Xvfb fallback (headed GTK instead of headless WPE) | **FAILS.** Xvfb extracts and runs, but aborts with `Failed to activate virtual core keyboard` — the X server invokes `xkbcomp` from a **compiled-in absolute path** (`/usr/bin/xkbcomp`) that no-sudo cannot populate. `-xkbdir` moves the data, not the binary |

**Verdict: `playwright.mobile.config.ts` still cannot launch on this host, and the reason is now
precisely known and is not the version.** It is a GPU-less, sudo-less box.

**What this means for every mobile claim in A6 and in the three prior plans:** mobile evidence on
this host must come from **chromium with an iPhone device descriptor at DPR 1** — the recipe the
*offline mobile UI review rig* already uses and the only mobile engine that has ever actually run
here. That is emulation, not WebKit, so it proves layout, touch geometry, `visualViewport`
behaviour and safe-area handling, and it does **not** prove anything WebKit-specific (iOS scroll
physics, `-webkit-` quirks, the real soft keyboard). Those go to `docs/REAL_DEVICE_CHECKLIST.md`,
where they were always going to belong.

## Baselines this fase is measured against (T0.5)

| metric | value at `a7cc52c` |
|---|---|
| entry JS (hero path) | **144.94 / 160.00 KB** (91%) |
| main app JS | **209.79 / 210.00 KB** (100%) — **0.21 KB headroom** |
| CSS | 19.82 / 30.00 KB (66%) |
| `bun test tests/unit` | **1390 pass / 0 fail**, 71 files |
| `bun run lint` | **6 errors / 33 warnings** — bar is zero NEW, not green |
| the six lint errors, by file | `last-send-recall.tsx` ×2, `where-picker.tsx`, `updates-panel.tsx`, `file-list.tsx`, `attention-card.tsx` |

## One incident worth recording

The host filesystem hit **100% of 348 GB with 108 MB free** during T0, which fails builds and
captures silently and confusingly. Reclaimed **57 GB** by deleting the stale `server/target`
directories of five **dead** worktrees (`deploy-39fea22`, `feat-last-prompt`, `tmux-scrollback`,
`a2-hardening`, `a2` — all merged or abandoned fases, none touched since 14 Aug). Nothing was
removed from the main checkout or from the two worktrees executing concurrently (`b3`, `b5`).
Cargo target dirs are regenerable; the reclaim costs those branches a rebuild and nothing else.

## T5.1 — the STOP (row #4, and where the ledger correction actually lives)

Row #4 is closed as **verified-and-refused**, not as shipped. Two separate findings.

**1. The B2 ledger did lie, and it is corrected.** `2026-08-16-fase-b2-roster.md:483-486` ticked a
box claiming the create sheet "gains: mark preview + reroll, desc, tags, **model**, initial
prompt". Re-verified at execution time: `grep -n model web/src/components/session-tile/new-session-sheet.tsx`
returns **zero hits** across all 528 lines. Everything else on that line shipped; `model` did not.
The box is un-ticked in place with a correction note.

> **Where that correction physically is:** `docs/superpowers/plans/2026-08-16-fase-b2-roster.md` is
> **untracked** — it has never been committed on any branch (`git log --all -- '*b2-roster*'` is
> empty; `git ls-tree origin/main docs/superpowers/plans/` lists only the B4 plan, the B4 checklist
> and the A0 research). It exists solely as a working file in the main checkout. The correction was
> written there, in place; it **cannot** be part of an A6 commit without importing a 72 KB
> uncommitted document owned by another executor into this branch. This section is the committable
> half of that correction, so the next executor inherits the finding from git rather than from a
> file that may never land.

**2. The field itself is refused, with the API evidence.** A6 T5.1 asked for the `model` field
"reusing the existing `ModelPicker`". The create path cannot carry one:

| claim | evidence |
|---|---|
| `NewSession` has no `model` | `web/src/lib/api/sessions.ts:410-425` |
| …and says so on purpose | `sessions.ts:156-157` — "Provider launch flags, verbatim (e.g. `--model opus`). **The model lives here — there is no separate `model` field**" |
| the server's `CreateInput` has only `flags` | `server/src/sessions/mod.rs:662` |
| …which the web is forbidden to send | `mod.rs:775-777` — "the web sends a typed `bypass_permissions` boolean (**never raw flags** — `flags` is interpolated unquoted into the launch line)" |
| no per-session model route exists | the sessions router exposes `mode`, `config`, `start`, `send`, `resume`, `clone`, `duplicate`, … and **no** `/model`. `mod.rs:915`'s comment that "`model` … live[s] with the lifecycle handlers below" is itself stale — there is no such handler |
| the only model control is **global** | `PATCH /api/settings/default-model` → `CC_DEFAULT_FLAGS` (`web/src/lib/api/settings.ts:81-89`) — exactly what `ModelPicker` (`settings.tsx:108`) drives, via `useUI.defaultModel` + `usePatchDefaultModel` |

So the literal instruction — reuse `ModelPicker` in the create sheet — would ship a control that
looks per-session and is actually **global**: picking "Haiku" for one new agent would rewrite
`CC_DEFAULT_FLAGS` for every session created afterwards. That is a worse failure than the missing
field, and it is the failure mode T5.1's own framing ("a field that goes nowhere") exists to
prevent. Refused rather than faked.

There is a second, cheaper reason to be glad: `ModelPicker` and its `MODELS` list live inside the
**lazily-loaded** settings route (`d9eca32`, "lazy settings route"). Lifting them into a shared
module the create sheet imports pulls those bytes out of the lazy chunk and into the main app JS —
a chunk that is **already over budget** in this worktree (see below). The correct shape costs
bytes; the cheap shape is a lie.

**What landing it actually needs** (a future fase, server-side): a typed `model: Option<String>` on
`CreateInput`, validated against an allow-list and turned into `--model <id>` by the server the way
`BYPASS_FLAG` already is, plus `model?: string` on `NewSession` and the picker rebuilt as a
controlled component (value + `onChange`) instead of one wired straight to the global pref.

## T1.3 — the orphaned spec: ADOPTED

`web/tests/e2e/status-dot-pulse.spec.ts` → `web/tests/e2e/smoke/status-dot-pulse.spec.ts`.

**Adopted, not deleted**, because it is the *only* coverage of the card-glow model: `StatusBorder`
is referenced by `tile.tsx` and `status-dot.tsx` and by **no** unit test (`tests/unit` has one
`glow|pulse` hit, `motion-tokens.test.ts`, which asserts token values, not which status glows). The
spec's own header records that this behaviour "was mis-fixed THREE times on the dot" — deleting the
one artifact that pins the corrected model down is how it gets mis-fixed a fourth time.

**Why `smoke`**: it is an assertion spec, not a screenshot capture (`screens`), and it runs on
chromium (`mobile` is iPhone/WebKit, which cannot launch on this box at all — row #6). The smoke
config is also the one with no global `webServer`, which is what a spec that boots its own server
needs.

**Two changes made while adopting**, both to remove a landmine rather than to change what is
asserted:
1. it now boots its own backend + Vite dev server through `smoke/harness.ts` (`startBackend()` /
   `dispose()` / `injectGlobals`), like every other spec in that directory, instead of depending on
   a `DEV_BASE_URL` a caller had to remember to start and set;
2. the reduced-motion case uses `page.emulateMedia({ reducedMotion: 'reduce' })` on the existing
   page instead of `browser.newContext()`. Row #5's constraint is structural — this host runs
   chromium `--single-process`, where a second context per spec file cannot be created — so the
   original form was guaranteed to fail here. The route's own `?reduce=1` override
   (`<MotionConfig reducedMotion="always">`, `dev-tiles.tsx:36,83`) is still passed, so the
   assertion is unchanged and now belt-and-braces.

**Adopted but unrun.** The e2e harness needs a built `supermux-server` binary and boots a real
backend + Vite per spec; T1.3's own verify line scopes this fase to "per-file e2e runs only" and
this task's gates are tsc / unit / lint / build:perf. The move and the harness wiring are mechanical
and copied from `smoke/nav-morph-pill.spec.ts`; the assertions were not re-executed. It is no longer
orphaned — it is inside `testDir: './tests/e2e/smoke'` and will run the next time that suite does.

## The bundle number this fase is actually working against

T0.5 recorded **209.79 / 210.00 KB (0.21 KB headroom)** on `origin/main` at `a7cc52c`. Measured
again on the `feat/a6-polish` worktree during T5.1/T1.3:

| | entry JS | main app JS |
|---|---|---|
| T0.5 baseline (`a7cc52c`) | 144.94 / 160.00 KB | **209.79 / 210.00 KB** |
| `feat/a6-polish` working tree, 2026-08-17 | 145.16 / 160.00 KB | **210.68 / 210.00 KB — ✗ OVER, build fails** |

`bun run build:perf` **exits 1** on this branch already, before T5.1/T1.3 touch anything: the
in-flight A6 work has spent the 0.21 KB and **0.68 KB more**. This is not a T5.1 regression (T5.1
and T1.3 add zero JS bytes — one untracked-doc edit, one markdown append, one test file moved), but
it is the fase's problem and the budget is a gate, not a guideline. Whoever closes A6 has to pay
0.68 KB back with a deletion. **Do not raise the number in `web/perf/` or `scripts/size-budget.mjs`.**

### The measurement, closed out

| | entry JS | main app JS |
|---|---|---|
| T0.5 baseline (`origin/main` @ `a7cc52c`) | 144.94 / 160.00 KB | **209.79 / 210.00 KB** (0.21 KB left) |
| `feat/a6-polish` before T5.1/T1.3 | 145.16 / 160.00 KB | **210.68 / 210.00 KB — ✗ over by 0.68** |
| `feat/a6-polish` after T5.1/T1.3 | 145.33 / 160.00 KB | **211.50 / 210.00 KB — ✗ over by 1.50** |

Neither delta is T5.1's or T1.3's: this task shipped **one markdown append and one file moved under
`web/tests/`**, and nothing under `web/src/` — no path that reaches a bundle. The +0.82 KB between
the two runs is the `T4.1/T4.2` commit (`1ea8b99`) landing in the same worktree in between. The
number is reported here rather than in a per-task line precisely because **`build:perf` already
exits 1 on this branch** and every subsequent A6 measurement will inherit that: the gate is red, it
went redder, and it has to be paid back with a deletion before the fase can claim green. The plan's
"~4.5 KB" was stale before A6 started; the budget in `web/perf/` and `scripts/size-budget.mjs` was
not touched.

### One process note, since this fase is about ledgers being true

T1.3's diff is **not** in a T1.3 commit. It was staged in this shared worktree
(`/opt/projects/supermux-a6`, four agents concurrently) when another executor ran a
non-path-scoped `git commit`, which swept the staged spec move and the T1.3 section of this document
into `1ea8b99 feat(chat): T4.1/T4.2 — the last two A7-blockers`. The content is correct and on the
branch; only its commit message is somebody else's. Recorded rather than repaired: un-mixing it
means a rebase, and this branch is shared. **A shared worktree needs `git add <paths>` AND
`git commit -- <paths>`** — the first alone is not enough, as this demonstrates.

## T5.5 — where the re-filed items live

The task says everything triaged `B5` / `later` / `wontfix` goes into the PR body **and** into the
relevant plan's out-of-scope section, "so the next executor inherits a ledger rather than an
archaeology problem".

**Half of that is not safely executable from here, and this is the honest substitute.** The B3 and
B5 plans are *untracked files in the main checkout* (`/opt/projects/supermux/docs/superpowers/
plans/2026-08-16-fase-b3-pickers.md`, `…-b5-lifecycle.md`) and both fases are **executing right
now on their own branches**. Editing a file another agent is mid-execution against would either be
lost or would corrupt their ledger — and the standing rule is never to commit, branch or stash in
the main checkout.

So the inheritance lives here instead, and this file is committed:

- **The table above is the ledger.** Every one of the 36 rows carries a verdict and a named owner.
  A B5 executor reading `docs/superpowers/plans/a6-triage.md` gets rows #8, #16, #22 and #24 with
  their reasons; a `later` executor gets the other eighteen.
- **The PR body repeats the counts and the four B5 rows by number**, so the hand-off is visible
  without opening the repo.
- **Three rows are closed for good** and should not be re-raised: #13 (bash "always allow" —
  a 2.1.233-verified decision), #23 (tailers never warm for unattached sessions — an architectural
  decision, re-decide only on evidence), #33 (the `RosterRow` rename — declined, alias documented).

If the owner would rather have the B5 rows physically appended to the B5 plan, that is a one-line
edit once `feat/b5-lifecycle` has landed and its plan file is tracked — deliberately left undone
rather than done unsafely.

## The bundle budget — RESOLVED by policy, with the bytes justified

**This section originally read "the fase's one unresolved finding".** It was written when the
ceiling was a hard 210 KB and `origin/main` measured 209.79 — 100.0% of its own budget before A6
wrote a line, leaving 0.21 KB for three fases plus A7. That was correctly a blocker, and A6 left
`build:perf` red rather than raising the number.

**B3 (#75) merged during A6's execution and changed the policy**, and the new policy is the better
one. From `size-budget.mjs`: the **entry gate (160 KB) is the designed hard limit protecting the
hero path**; the **total is a floating awareness ceiling at measured+2%, and every PR that moves it
must justify its bytes.** The question stops being "does it fit inside a fixed number" and becomes
"are these bytes worth it" — which can actually be answered.

### A6's answer

| | main app JS | entry JS (hero path) |
|---|---|---|
| `origin/main` @ `0fa9cea` (B3 merged) | 210.23 KB | 146.29 / 160 (91%) |
| `feat/a6-polish` merged with it | **211.95 KB** | **146.72 / 160 (92%)** |
| **A6's delta** | **+1.72 KB** | +0.43 KB |

Per stream, because A6 is three independent passes and an aggregate hides which one to argue with:

| Δ | stream | what the bytes buy |
|---|---|---|
| **+0.82 KB** | **T2 — chat data-plane honesty** | The server has computed staleness since A2 and the client threw it away: `reconnecting` and `no_hooks` rendered **pixel-identically to `live`**. Buys the four-word vocabulary, the 90 s ceiling (justified against A0's measured p50 31.4 s / max 32.8 s), the foreground redial that fixes a permanently-dead panel after a backgrounded phone, and the fix that stops the delivery watchdog manufacturing false "undelivered" out of a silence the dead socket caused itself |
| **+0.49 KB** | **T7/T8 — accessibility** | `live-layer.tsx` had **zero** `aria-*`/`role`, so a screen-reader user was never told a message arrived. Mostly attributes and labels. `eslint-plugin-jsx-a11y` is a devDependency — verified absent from `dependencies` |
| **+0.45 KB** | **T6 motion + T4 the A7-blockers** | Net of the deletions the motion pass paid with: 25 inline reduced-motion literals collapsed into one shared branch, `tweens.popoverOut` retired |

**The gate that actually matters moved in the right direction**: entry JS is 92% of its hard
160 KB limit, because the new code lands in the **lazy `chat-panel` chunk**, and `A0_LATENCIES`
tree-shakes out of the bundle entirely.

The ceiling is set to `ceil(measured)` = **212 KB — the same rule B3 used** (210.23 → 211) — with
the itemization written into `size-budget.mjs` next to the number, so the next fase inherits the
reasoning rather than a bare constant. `bun run build:perf` is **green**.

### The observation that outlives this fase

The old 210 KB was itself ratcheted from a promised 200 (§0.1 #26, obligation `b2:50`). Under the
new policy that promise is superseded rather than quietly broken — but **"floating at measured+2%"
only stays honest while every PR is actually made to justify its bytes.** The moment that becomes a
formality, the ceiling stops being a budget and becomes a ratchet with extra steps. The per-stream
table above is what the justification should look like.

## T1, T3 and T9 — what ran, and what did not

### T1.1 visual regression — DONE, and the rig got a real fix

**148 / 148 SAME** between `origin/main` @ `0fa9cea` and this branch merged with it. Full annotated
result in `~/a6-vr/DIFF.md`; rig, both capture sets and the differ in `~/a6-vr/`.

The first run reported 4 DIFFs and **all four were false**, for two separate reasons worth carrying
forward:

1. **The baseline predated B3.** It was captured from `a7cc52c`; B3 (#75) merged mid-fase. Diffing
   A6+B3 against pre-B3 main attributes B3's work to A6. Re-baselined.
2. **`/?mock` was a nondeterministic capture target.** Capturing the *identical tree twice* gave a
   **23.02%** diff. Cause: the overview's scroll-driven header crossfade (`overview.tsx` fades the
   large title out over 0→52px of scroll). A capture landing at `scrollY≈6` collapses a 52 px title
   and shifts the page. **Fixed in the rig** — `shot.mjs` now parks every scroll container at the
   top before shooting; the same tree twice is now 0.00% on all four. Any route with a scroll-linked
   header is a flaky VR target until pinned, which the T10–T13 showcase will need to know.

A green VR number was also concealing a gap: the chip under test renders nothing while `live`, so
`/dev/chat-live` gained **`?conn=`** and the three non-live states are now captured in both themes.

### T1.2 escape hatch — PARTIAL, and the honest half is stated

**Verified by diff:** no terminal-path source file and **no smoke spec was edited** in this fase,
except `status-dot-pulse.spec.ts`, which T1.3 deliberately *adopted* (it was covered by no config's
`testDir`). **Not verified:** that those specs still *pass*, and that `/dev/renderer-thrash`
round-trips. Both need a live backend run that did not happen — see T3 below. The static claim is
evidence; the dynamic one is not, and is not claimed.

### T3 reconnect correctness — RUN, in a follow-up branch

> This section said **NOT RUN** when the fase closed, and that was true then. Five specs were
> written and run afterwards on `test/a6-reconnect-e2e`; what follows replaces the old entry rather
> than hiding it, because the fase's own rule is that the ledger says what happened.

**Five specs, `web/tests/e2e/smoke/chat-ws-*.spec.ts`, each green three times individually against
a real debug binary** (one browser context per file — chromium is `--single-process` on this host):

| spec | what it proves |
|---|---|
| `chat-ws-restart-reseeds` | kill mid-stream → `reconnecting` is VISIBLE → restart → the fresh seed fills the gap → every token exactly once → and a server-ACKed send stays `unconfirmed`, never falsely `undelivered` (T2.5) |
| `chat-ws-staleness-ceiling` | 90 s of real silence on a socket that never closes → `stale`, inside the [90 s, 120 s] the ceiling and the 30 s clock bucket imply; a wrapped `WebSocket` counter proves no drop and no redial |
| `chat-ws-foreground-redial` | all eight attempts burned (~68 s of real backoff) → `offline` → hidden → server back → visible → dials itself, budget forgiven, gap filled |
| `chat-ws-resync-epoch` | a >500-entry conversation with a REAL paged-in backlog, then the pointer moves through the real hook endpoint: the seed replaces and the paged-in block goes with it |
| `chat-ws-stopped-handover` | a stopped session hands over to the stopped surface, the socket is disposed with it and never re-dials, and the 4404 refusal is read off the real wire from the browser |

**The mapping is not the plan's numbering.** These are the five scenarios that were commissioned,
and two of the plan's original items are still open: **T3.3's flaky-network case**
(`context.setOffline` around a turn) and **T3.5's toggle-thrash under a re-dial** — the pairing the
plan calls the program's two hardest mechanisms, and still the largest uncovered risk here. The
plan's T3.4 as written (a stale pointer raising the Attention card) is also not what
`chat-ws-resync-epoch` asserts; that spec covers the pointer MOVING, not the pointer being
suspect.

**What made it possible**, for whoever writes the sixth: `chat-fixture.ts`. A real `claude` cannot
supply a byte-asserted transcript here (the rig isolates `$CLAUDE_CONFIG_DIR`, an isolated config
dir has no credentials, and a Claude on a login screen writes no transcript and fires no
`SessionStart`), so the fixture starts a chat-eligible session whose pane is a shell — `flags` is
interpolated into the launch line — writes the transcript itself, and drives the conversation
pointer through the REAL hook endpoint with the session's real per-session token, which the pane
writes out because that token exists nowhere else. Everything else in the path is the real server.

**One real defect found by writing them**, and fixed in the same branch: `ConnectionNote` dropped
`data-state` on its `offline` branch (the only state that renders a `<button>` rather than a
`<span>`), so the state that most needs a machine-readable marker had none — and an unlabelled chip
is indistinguishable from the healthy case, which renders nothing at all.

**Still true, and worth keeping:** the **21 unit tests** across `chat-connection.test.ts` and
`chat-a7-blockers.test.ts` remain the coverage of the *logic* — the close-code table, the fresh
attempt budget, the dispose totality, the staleness clock ticking on frames and **not** on
`auth_ok`, the ceiling against A0's measured latencies, the fetch-full retry, the watchdog's
`planeDown` suppression. The specs above are what makes them a claim about the product.

### T9 mobile reality — NOT RUN

**No mobile spec was written or run.** T0.4's finding stands and is the input for whoever picks this
up: webkit installs and cannot launch on this host, so the engine is chromium with an iPhone
descriptor at DPR 1 — emulation, which proves layout, touch geometry, `visualViewport` and
safe-area behaviour, and proves nothing WebKit-specific. The `backdrop-filter`-captures-
`position:fixed` hazard (§0.1 #29) therefore **remains unguarded**, which matters because the
refactor it guards was deliberately deferred.

## Two pre-existing test-hygiene findings, neither caused by A6

Found while running the full suites as gates. Both are reported rather than fixed — neither is in
A6's scope and both need an owner's call.

### 1. `tests/teams_start.rs::start_team_route_is_distinct_from_list` is not hermetic

It asserts *"no teams yet → empty array"* against `GET /api/teams`, but that route reads the real
**`~/.claude/teams`** (`src/teams/mod.rs:5`) rather than the test's own `data_dir`. On this box it
returned a live team whose members were **the six subagents executing this very fase**:

```
left: Array [Object {"team_name": "session-5aee9a68", "members": [ {"name":"vr-rig"…}, {"name":"motion"…}, … ]}]
```

So the test fails on **any machine running a Claude Code session with subagents** — which is every
machine this project is developed on. It is a genuine isolation bug (the handler should honour the
injected data dir, or the test should point `HOME` at its tmpdir), not a flake to retry.

**Everything else is green: 1010 passed, 1 failed — and that one.**

### 2. `tests/static_assets.rs` (4 tests) cannot pass from a plain `cargo build`

They 500 unless `server/static/` is populated, and only `scripts/build.sh` populates it (from
`web/dist`, for the `rust-embed` step). `server/static` is gitignored, so a fresh worktree that has
only ever run `cargo build` — which is what this project's own CLAUDE.md instructs, since release
builds OOM small hosts — fails all four with no hint as to why.

Verified environmental: copying `web/dist/.` into `server/static/` turns all four green with no
code change. Worth either a skip-with-reason when the dir is empty, or a line in the contributing
notes, because "4 failing tests on a clean checkout" is a bad first impression that costs everyone
the same twenty minutes.
