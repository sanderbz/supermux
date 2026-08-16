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
| 18 | chat for codex/kimi/remote/team | feature | later | Excluded by the Global Constraints provider guard; §5 keeps it |
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
