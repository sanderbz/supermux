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
>
> **Stale-unchecked examples in this file:** **T4.4, T5.1, T5.2 and T10.5** all shipped
> (B3 landed as **#75**) despite their boxes being unticked. Read them as done unless
> the debt register says otherwise.

---

# Fase B3 — One picker, one palette: the discovery spine

---

# ✱ EXECUTION ADDENDUM (2026-08-16) — re-audit against real `main`

**The plan was written to stack on `feat/b2-roster`. It no longer stacks on anything.** B2 (#74),
B4 (#73) and A5 (#72) are all merged; this branch is cut from **plain `origin/main` = `a7cc52c`**.
Worktree `/opt/projects/supermux-b3`, branch `feat/b3-pickers`, base `main`.

Every §0 row below was re-checked against `a7cc52c`. Nine rows moved, two of them enough to
change what the fase ships. The plan body is left intact as the record; **where the addendum and
the body disagree, the addendum wins.**

## A1. The budget is the binding constraint, and it is not what the plan says

The plan quotes B2's PR numbers (entry 144.73 / app 205.46) and reasons from ~4.5 KB of headroom.
Measured on the real branch point, `bun run build:perf` at `a7cc52c`:

```
✓ entry JS (hero path) 144.94 KB / 160.00 KB budget (91%)
✓ main app JS    209.79 KB / 210.00 KB budget (100%)
✓ CSS            19.82 KB / 30.00 KB budget (66%)
```

**App JS has 0.21 KB gz of headroom — 100% of budget consumed.** B2's 205.46 was measured before
B4 (#73, +4606 lines of web) landed on top of it. The ratchet the executor was handed (≤210) is
therefore not a ceiling B3 works under; it is a ceiling B3 is already standing on.

This is not a footnote — it reorders the fase:

1. **B3 must be net ≤ +0.2 KB gz on app-JS total.** Every task carries a measured byte delta in
   its ledger line. `build:perf` runs at the end of *every* task, not once at T10.
2. **The consolidation is the budget.** T3 and T4 delete two of the four keyboard engines, the
   palette's five substring predicates and its 96-line `PaletteRowView`. Those deletions are what
   pay for T5's verbs and T6's cheatsheet. So the order is now **strictly** deletion-before-
   addition: T2 → T3 → T4 (net-negative) must land before T5/T6 (net-positive) may spend.
3. **Additive tasks are explicitly severable.** T5, T6, T8 and T9 each stop at the byte wall
   rather than pushing through it. A task that cannot fit is deferred with its measurement in the
   ledger — not shipped with a raised budget. Raising a ratcheted gate is a decision for the
   owner, not for the executor, and this addendum does not take it.
4. Note that "app JS total" sums entry **and** lazy chunks, so §4.6's mitigation (lazying the
   palette body) buys **entry** headroom only and buys the total nothing. The only lever on the
   total is deleting more than we add.

## A2. What B2 (#74) actually did to the palette — the inventory shrank a lot

`command-palette.tsx` is **642 lines, not 1061.** B2 removed the Board page and took with it the
four board verbs, the seven-step sub-flow machine, the issue rows, the breadcrumb and the back-out
machine (~250 lines whose comment-of-record is now at `:115-120`). Consequences, row by row:

| plan says | reality at `a7cc52c` |
|---|---|
| "six hand-rolled substring predicates `:181-231`" | **Five**, `:153-195` — `matchesSession` `:153`, `matchesCommand` `:161`, `matchesSkill` `:169`, `matchesMcp` `:178`, `matchesAction` `:188`. The issue predicate went with the board. |
| row union "session · action · skill · MCP · command · **board issue**" | **`session · command · skill · mcp · action`** (`:113`). No issue kind exists to widen from. |
| "Keep the board sub-flow step machine (`:740-765` Escape-steps-back included)" | **There is no step machine.** Escape is plain Radix dismiss. T4.1's "keep it" is a no-op and T1.4's "Escape steps back one sub-flow level" **tests a feature that no longer exists** — dropped, see A6. |
| `PaletteRowView` at `:944-1044`, listbox `:870-875`, scrollIntoView `:771-774`, max-h `:872` | `PaletteRowView` **`:530-625`**, listbox **`:498-503`**, scrollIntoView **`:453-459`** (keyed off `data-palette-row`, not a row ref), max-h **`:500`**. |
| "T5.4 board verbs: leave exactly as they are, they are B2's to delete" | **Already deleted.** T5.4 is struck; the PR body says so instead. |
| e2e "`board-cmdk-drag-send.spec.ts:105-146`" is one of two palette specs | **Deleted by B2**, along with six other board specs. `board-gone.spec.ts` replaced them. The only surviving palette e2e is `archived-recover.spec.ts`. |

B2 also put `SessionFace` into the palette's session row (`:561`) — the B2 identity component the
plan predicted the two surfaces would otherwise write twice. That prediction was right and the
consolidation now inherits it for free.

## A3. What B4 (#73) actually did — **it already did half of T2**

This is the second finding that changes the work. B4 touched `entity-picker.tsx` (+28),
`slash.ts` (+23), `use-composer.ts` (+145) and `composer.tsx` (+125), and in doing so shipped
two things the plan lists as B3 deliverables:

- **`onPick` is already `(row: EntityRow) => void`** (`chat/entity-picker.tsx:60`), with a
  20-line comment justifying the whole row over `row.value` in exactly the terms T2.2 uses.
  **T2.2's widening is done.** What remains of T2.2 is the *move* and the union widening.
- **The pure keyboard reducer already exists.** `composerKeyIntent` (`use-composer.ts:91`)
  returns `picker-up | picker-down | picker-accept | picker-close` plus the send/newline/clear
  intents, and it already outranks everything with IME (`isComposing` **and** keyCode 229,
  `:57-73`) and already passes Shift+Tab through (`:108`). **T1.2 does not extract a reducer —
  it extends the existing one** with Home/End/PageUp/PageDown and truth-tables the new cells.
  Extracting a second `entityPickerKeyIntent` beside it would be the exact duplication this fase
  exists to remove.
- `acceptRow` (`slash.ts:316`) was already pulled out as a pure, separately-testable decision.

B4 also shipped **`components/session-schedules/schedule-href.ts`** — a pure, import-free
"where does this entity go" resolver for one entity kind, with a build-time constant instead of a
route lookup. **That is `resolveEntityTarget` in miniature, and T2.1 adopts its shape** rather
than inventing a competing one: pure, import-free, alias-free (the `bun test` runner resolves no
`@/`), returns data not JSX.

**The `@session` composer dispatch is NOT a picker consolidation candidate.** B4's
`delegate-intent.ts` reads a hand-off out of the *draft text* (leading `@known-session` + body),
deliberately **decoupled from the picker** — its header comment states that picking a session
must not dispatch, because the hand-off happens at submit after the send control has relabelled.
B3 must not wire the picker to the dispatch. It is named here so a later fase does not "fix" the
seam on purpose-built ground.

## A4. Other §0 rows that moved

- **Warm shadow literal: two files, not three.** `chat/composer.tsx:322-325` no longer carries it.
  Live sites: `chat/entity-picker.tsx:190`, `chat/ui/composer.tsx:81` **and `:83`** (the second
  inside a `focus-within:` compound the plan missed — a token swap must keep the compound intact).
- **`routes/scheduler.tsx` is deleted** (B1 fold). `PromptField`'s host is now
  `scheduler/schedule-form.tsx:309`/`:360`, reached through Settings → Schedules. §4.5's "if B1
  lands first the host moves" **has already happened**; T3.3's mitigation (touch only
  `prompt-field.tsx`) holds unchanged and is now a statement of fact rather than a hedge.
  `PromptField` line refs re-pinned: `detectSlashQuery:109`, cap-at-8 `:151`/`:159`, keyboard
  engine `:210`, `scrollIntoView:233`, listbox `:263`, wrapper `:269`, option `:286`.
- **`board-switcher.tsx` is deleted**, so §0.2 finding 3's "three copy-pasted pill→sheet shells"
  is **two** (`session/session-picker.tsx`, `focus-mode/session-picker-sheet.tsx`). Still B5's.
- **`NAV` is 5 items and already board-free** (`layout.tsx:57-78`: Overview, Sessions, Focus
  (desktopOnly), Files, Settings). T5.1's "derive from NAV so B2's removal deletes the verb
  automatically" is now derive-from-NAV for its own sake — still right, and the assertion
  `paletteNavRows().length === NAV.filter(visible).length` still holds.
- **There are no `VITE_*` flags anywhere in the repo.** The house flag idiom is
  `chat/flag.ts`: a settings toggle AND a `localStorage` kill-switch AND an eligibility predicate,
  all pure. T9's `VITE_SM_TRANSCRIPT_DEEPLINK` would be the first of its kind. Kept as specified
  (the executor was handed it as a non-negotiable) **but** as a build-time `import.meta.env` read
  so an unset flag is statically `undefined` and the branch is dead-code-eliminated — which is
  the only way T9 costs the 0.21 KB budget nothing when off.
- `chat-interactive.test.tsx` pins the picker at `:627-651` (`data-active` counted at `:644`,
  `role="listbox"` at `:649`) and `:765` / `:904`. Unit-test count is **71 files**, not 37.
- Unchanged and re-verified: no `lib/entity.ts`, no `lib/shortcuts.ts`, no `components/ui/
  entity-picker.tsx`; `data-highlighted` still appears **nowhere**; the chat picker still has
  **no** keyboard `scrollIntoView` (the defect stands, `entity-picker.tsx:113-132`); the palette
  still has one (`:453-459`); `mobile-bottom-panel.tsx:472` still declares `role="listbox"` with
  no `role="option"` on `SessionPill:527` (the a11y bug stands); `dock.tsx`'s `ComposeField` gate
  is intact at `:821-935` with `TAP_SLOP_PX = 10` `:885` / `TAP_MAX_MS = 500` `:886`, multi-touch
  invalidation `:897`, and the ghost-click fix firing on click `:910`/`:918`; the palette is still
  unreachable on a phone (`dock.tsx:222` is the only trigger and it is `DesktopDock`).

## A5. Renumbering — what this fase now ships

Task IDs are kept so the ledger stays diffable. Changes:

- **T1.2** — extend `composerKeyIntent`, do not extract a rival reducer (A3).
- **T1.4** — palette e2e baseline is `archived-recover.spec.ts` alone; the new
  `palette-keys.spec.ts` drops the sub-flow-Escape case (no sub-flows exist) and keeps
  ⌘K-toggles-closed, ArrowDown-wraps, and highlight-scrolled-after-12-downs.
- **T2.2** — `onPick` widening already landed (A3); this is a move + union widening only.
- **T4.1/T4.2** — five predicates, not six; no step machine to preserve.
- **T5.4** — **struck.** Board verbs are gone.
- **T9.1** — the spike is explicitly allowed to conclude "no", and under A1 it is now *expected*
  to: two serde fields are cheap on the server but the client half of T9 is not, and T9 spends
  bytes that T5/T6 have first claim on. The spike is run and its finding recorded either way.
- **Every task ends with a `build:perf` line in its ledger entry.** A task whose delta puts app
  JS over 210.00 KB is reduced or deferred at that boundary, and the number is reported.

Unchanged non-negotiables, restated: **T1.3 lands before T7 and gates it**; **T7.2 forbids
touching `dock.tsx`**; the `scrollIntoView` and `role="listbox"` defects get fixed; the shortcut
catalogue ships with the anti-rot `file:line` test; the palette becomes reachable on a phone;
T8 stays severable from T9.

## A6. Ledger

Per-task status, byte delta and gate output are recorded at **§6, the bottom of this file**.

---

**Worktree** `/opt/projects/supermux-b3` · **branch** `feat/b3-pickers`, stacked on `feat/b2-roster`
(→ `feat/b1-shell` → … → `origin/main`). B3 is the last Track-B fase that *could* start before B2,
and it must not: B2 deletes the board page **and the palette's four board verbs**, and B2 ships
`<SessionIdentityRow>` + marks, which the palette's session rows and the picker's session rows both
consume. Starting B3 first means writing those rows twice.
**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` on the unmerged branch
`docs/grok-ui-plan` — read with
`git show origin/docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`.
B3 scope = **§14** (one picker, one palette) plus the **§17 B3 row**; it consumes §12.1's component
split, §12.4's pinned hairline, §12.6b's canonical prefs surface, §12.8's four-item nav and §13.1's
entity navigation targets.
**Format model** `docs/superpowers/plans/2026-08-16-fase-b1-shell.md`.
**Prereq, verified merged:** A4's composer popovers are on `origin/main` (`f814abb`, #63). The
component they prove is `web/src/components/chat/entity-picker.tsx` (253 lines).

> One sentence of scope: **B3 makes "find a thing and act on it" one component and one surface** —
> the A4 chat popover is promoted out of `components/chat/` into a real shared `<EntityPicker>` with
> two anchors and a widened result union, the ⌘K palette is rebuilt on top of it and finally learns
> to navigate, the app's fifteen invisible keyboard shortcuts get one declarative registry that says
> they exist, and transcript search stops being a dead-end list. One server change, ring-fenced.

---

## 0. Ground truth — what actually exists at `origin/main` (`ea642df`, post-#67)

Read against the working checkout plus `git show origin/main:…` where they differ. The only delta
between the checkout and `origin/main` is the chat data plane (`chat-socket.ts`, `wire.ts`,
`wire-entries.ts`, `use-chat-ws.ts`, `use-chat-backlog.ts`, `backlog.ts`, `entries.ts`,
`use-chat-turn.ts`) — no picker surface is touched, so the inventory below holds for both.

### 0.1 What §14 assumes vs. what is there

| §14 assumption | reality at `origin/main` | consequence for B3 |
|---|---|---|
| "One `<EntityPicker>` component … rows `padding:7px 8px; gap:10; radius:8`" | The component exists but is **chat-private** — `components/chat/entity-picker.tsx`, *default* export, `React.lazy`'d at `components/chat/composer.tsx:46`. Rows are `gap-2.5` (=10 ✓) but `px-3.5` (=14, not 8), `py-[7px]` desktop / `py-[13px]` phone, and have **no radius at all**: the active fill `bg-fill-soft-2` runs edge-to-edge (`entity-picker.tsx:201-207`) | The numbers are a **retrofit**, not a description. Rows gain an 8px inset + `radius:8`. The phone row keeps its 44pt height as an explicit, documented exception — HIG beats the plan's desktop number |
| "`[data-highlighted]` set identically by keyboard and pointer" | The attribute is **`data-active`** (`entity-picker.tsx:193`); `[data-highlighted]` appears **nowhere in the repo**. Keyboard and pointer genuinely do converge on one state atom (`setSel` at `:106` and `:126`), so the DOM output *is* identical — naming is the only gap. **But keyboard move has no `scrollIntoView`**, so arrowing past the 264px fold moves an off-screen highlight. The palette *does* scroll (`command-palette.tsx:771-774`) | Rename to `data-highlighted`; no alias period (it is a private chat attribute with exactly two test assertions). **The scroll asymmetry is a real defect and B3 fixes it** — it is the single best argument for the consolidation |
| "container `max-height:min(280px,46vh)`" | Picker `max-h-[264px]` (`entity-picker.tsx:181`). Palette `max-h-[min(60vh,420px)]` (`command-palette.tsx:872`) | Two numbers, neither the plan's. **Deviation, taken deliberately:** `min(280px,46vh)` is right for the token anchor (it must not cover the transcript it is being written about) and *wrong* for ⌘K — a spotlight showing 6 rows is a regression from today's 420px. Both become props with per-anchor defaults; BRAND.md records why |
| "shadow `0 1px 2px #0000000f, 0 14px 36px -10px #00000047`" | Picker uses `0_12px_34px_-18px_rgba(30,18,10,0.35)` — a **raw warm-black literal**, duplicated verbatim in three files (`entity-picker.tsx:174`, `chat/composer.tsx:322-325`, `chat/ui/composer.tsx:79`) | The plan's cool-grey shadow fights B0's warm ladder. B3 ships **`--sm-popover-shadow`** in the warm family and points all three call sites at it. Deviation logged in BRAND.md |
| "two anchors (down from a search field; up from an `@`/`/` composer token with tighter 4px/6px rows)" | **Only the up anchor exists**, hardcoded: `absolute inset-x-0 bottom-full z-20 mb-2` resolving against `ComposerFrame`'s `relative` wrapper (`chat/composer-shell.tsx:66`). No portal, no flip logic. A unit test pins the in-flow ordering (`tests/unit/chat-interactive.test.tsx:780`) | The down anchor is **new code** and it unlocks every other consumer. It must **not** become a portal — that would break the composer's "never take focus" rule. The anchor is a **prop that selects a wrapper**, not a positioning engine |
| "Typed result union: session · file · board issue · schedule · snippet/skill · host · action" | `EntityRow.kind` is `'file' \| 'session' \| 'command'` (`chat/slash.ts:288-299`) and `onPick` is `(value: string) => void`. **There is no payload and no `run()` escape hatch** — an `action` row is structurally impossible. Board issue / schedule / host / MCP exist only as the palette's *private* row types (`command-palette.tsx:84-134`) | The union widening is a **type-model change**, not a rename: `onPick` widens to `(row) => void`, the row gains `run?: () => void` and an icon slot. Blast radius is contained — every caller is inside `components/chat/` plus one bench and one test |
| "Consumers … : ⌘K palette, **overview search**, composer `@`/`/` popovers, palette session rows" | **"Overview search" as §14 means it does not exist.** `routes/overview.tsx:150-160` has a 200 ms-debounced text filter whose matcher (`:91-99`) hits `name`/`task_summary`/`desc`/`tags` — it filters the tile grid in place, it does not open a result list | Dropped from B3's consumer list, explicitly. B3 ships the **down-anchor capability**; mounting it on the overview header is B2's (§12.7 "search where applicable"). Otherwise B3 grows an unrelated feature it cannot verify |
| "The palette finally gets: navigation (Files/Settings — the four-item nav per §12.8)" | The palette has **zero** route-navigation verbs. Its only hand-authored actions are `View archived sessions`, `Manage MCP / skills / commands…`, `New group` (`command-palette.tsx:320-352`), plus four board verbs gated to `/board` (`:354-390`) | Straightforward addition. **Coordination:** the four board verbs are B2's to delete. If B2 has not landed when B3 branches, B3 leaves them untouched and says so in the PR body |
| "new session, new group, theme toggle, sort/density/view (as mirrors of the canonical display-menu surface, §12.6b), 'open file', 'new schedule'" | `New group` exists. **Nothing else.** `theme` appears **zero times** in `command-palette.tsx`. Sort/density/view live in `session-tile/overview-display-menu.tsx:51`; §12.6b's "one canonical prefs surface" is **B2's** deliverable | Palette rows are **thin mirrors calling the canonical handler**, never a second copy of the state. Where B2 has not yet centralised a pref, the mirror calls today's store and carries a `TODO(B2)` pointing at the merge |
| "shortcut cheatsheet in the palette (today `[`/`]`, `g n`, `⌘1..9`, type-on-hover are all invisible)" | Confirmed, and worse: **no keymap file, no `useHotkeys`, no registry anywhere** — 15 shortcuts are each an ad-hoc `addEventListener`. `⌘1..9` is registered **twice**, in two files, with two different slot maps (`focus-mode/use-keyboard-capture.ts:78-82`; `routes/overview.tsx:489-512`). `ui/kbd.tsx` is used in exactly 3 places (`command-palette.tsx:868`, `compact-tile.tsx:129`, `session-row.tsx:105`) | A cheatsheet that hand-lists strings is a lie waiting to rot. B3 ships a **declarative `lib/shortcuts.ts` catalogue** that the cheatsheet renders **and** a unit test walks: every entry names a real `file:line`, and the test reads that file and asserts the key literal is on that line. **Rewiring the 15 listeners onto the registry is out of scope** — catalogue now, dispatcher never in this fase |
| "transcript deep-links (recall search exists server-side)" | **Technically true, materially misleading.** `GET /api/sessions/{name}/recall` exists (`server/src/sessions/recall.rs:196`), but the "search" is `entry.text.to_lowercase().contains(needle)` over a full re-read of the JSONL (`recall.rs:350-353`). No index, no FTS anywhere in 24 migrations, no ranking, no snippets. Critically: `RecallEntry` (`recall.rs:96-113`) carries `uuid` + `sessionId` and **no `offset` and no `conversation_id`**, while the A2 chat plane addresses entries by `"<conversation_id>:<offset>"` (`chat/ws.rs:138-163`). And `history_page` is **strictly-older-than-`before`** (`ws.rs:315-318`) — there is no `around=` / `after=` read path | **This is the riskiest task in the plan (§4.1).** It is sequenced last, behind its own flag, and its v1 is scoped to need **no new server read path** (see §0.3) |
| "`board issue` stays in the typed union — its navigation target is the §12.8 issue detail surface" | That surface is **B2's**, and B2 is a 30-line skeleton today | B3's issue rows navigate through **one indirection**, `resolveEntityTarget(row)`. When B2 changes the target it changes in one function, not in the palette *and* the picker *and* the chip renderer |
| "(The form-control `SessionPicker` stays a value picker per §12.1.)" | Correct, and worth restating precisely: `components/session/session-picker.tsx:80` is a **form field** (DropdownMenu desktop / Vaul half-sheet mobile) used by the board composer and the scheduler form. `components/focus-mode/session-picker-sheet.tsx:47` is a **navigation sheet**. §12.1 excludes only the first | The second **is** a convergence candidate — and it is also the surface behind the mobile session-pill tap, i.e. the highest-regression-risk change in this plan (§4.2) |

### 0.2 Every picker / selector / option-list surface in `web/src`

**A. Converges on `<EntityPicker>` (searchable, many-item, "find a thing and act on it")**

| surface | file:line | picks | built with | kbd nav | search | anchor |
|---|---|---|---|---|---|---|
| Chat `@`/`/` popover | `components/chat/entity-picker.tsx:58` (connected) / `:154` (view) | file · session · command | bespoke `ul[role=listbox]`, plain DOM, B0 tokens | yes, via the textarea (`use-composer.ts:104-111`) — **no scroll-into-view** | fuzzy: `fuzzyScore`/`rankEntities` (`slash.ts:232`/`:261`) | up-from-token, in-flow |
| ⌘K command palette | `components/command-palette/command-palette.tsx:236` | session · action · skill · MCP · command · board issue | Radix `Dialog` + `<input>` + mapped list, `role=listbox` `:870-875` | yes, window capture listener `:740-765`, **with** `scrollIntoView` `:771-774` | **plain substring**, six hand-rolled predicates `:181-231` | centred dialog, `top-[20%] max-w-xl` |
| Focus-mode session sheet | `components/focus-mode/session-picker-sheet.tsx:47` | session · teammate (navigation) | Vaul `Drawer` `:62-138`, rows `SessionRow:174` / `TeammateRow:217` | **none** | **none** | full-screen bottom sheet |
| **Scheduler `PromptField`** | `components/scheduler/prompt-field.tsx:127`, listbox `:263`, option `:286` | slash command · skill · MCP connector | bespoke `motion.div role=listbox` + `button role=option aria-selected` | **yes** — wrap at `:202-224`, clamp `:163`, **and `scrollIntoView` at `:228-234`** | implicit on the leading `/` token (`detectSlashQuery:109`), capped at 8 | **down-from-field**: `absolute left-0 right-0 top-full mt-1.5` (`:269`) |
| Prompt-recall popover | `components/focus-mode/last-send-recall.tsx:189-190, :325-331` | past prompts (`/recall`) | **third** desktop/mobile fork: Radix `Popover` `:741-776` / Vaul `Drawer` `:796-826`, shared `RecallPanel:172` | **none** | server substring (`api.sessions.recall`, `lib/api/sessions.ts:617`) | popover up from the header icon / bottom sheet |

**The four findings that justify this fase better than §14 does:**

1. **Two type-ahead pickers over the same corpus, anchored in opposite directions, sharing zero
   code.** Chat `@`/`/` anchors **up-from-token** (`entity-picker.tsx:172`); the scheduler's
   `PromptField` anchors **down-from-field** (`prompt-field.tsx:269`). Both filter installed slash
   commands. §14's "two anchors" is not a feature to invent — it is a **duplication that already
   exists** and this is the merge. `PromptField` is therefore the *proof* of the down anchor, and a
   far better first consumer than the palette.
2. **Four independent keyboard-nav engines**, each re-implementing `(i+1) % len` wrap and
   `scrollIntoView({block:'nearest'})`: `command-palette.tsx:740-775`, `entity-picker.tsx:100-116`
   (+ `use-composer.ts:103-111`), `prompt-field.tsx:202-234`. **The chat picker is the only one of
   the three that forgot the `scrollIntoView`** — which is precisely how a defect hides in a
   copy-paste family.
3. **Three copy-pasted "pill → DropdownMenu on desktop / Vaul half-sheet on mobile"
   implementations**, each of whose header comments admits it copies the others:
   `session/session-picker.tsx:80-297`, `board/board-switcher.tsx:93-282`,
   `focus-mode/session-picker-sheet.tsx:47-263`. Only the third is an entity picker (§0.1 last row) —
   but the *shell* duplication is real and is named here so B5's §16.1 modal consolidation inherits
   it rather than rediscovering it.
4. **Search exists in only 5 of ~20 surfaces** — palette `:860`, overview `:525`, files `:275`,
   recall `:325`, WherePicker free-text `:656`. `HostPicker`, `SessionPicker`, `ResumePicker` and the
   focus-mode session sheet are all **unfiltered lists that can grow unbounded**.

**B. Legitimately stays bespoke — with the reason**

| surface | file:line | why it is not an EntityPicker |
|---|---|---|
| `SessionPicker` (form control) | `components/session/session-picker.tsx:80`, sheet `:221` | §12.1 excludes it by name. It is a **value picker in a form** (board composer, `ScheduleForm`), bound to a field, ≤ dozens of options, no verb attached. Radix `DropdownMenuRadioGroup` already gives it correct roving-tabindex + typeahead |
| `HostPicker` | `components/host-picker.tsx:67` | Same class: a bound value control over a handful of hosts, Radix `DropdownMenu` (`:96`), with a `StatusBlip` (`:39`) that is host-specific chrome. **`host` still enters the picker's typed union as a *result* kind** (a palette row that navigates to Settings→Hosts) — the union and this control are different things |
| `ModelPicker` | `routes/settings.tsx:107`, `:119-129` | Bound settings value, ~5 options, Radix `DropdownMenu` |
| `BoardSwitcher` | `components/board/board-switcher.tsx:93`, sheet `:216` | Value picker over boards; **and B2 deletes the board page**. Touching it in B3 is churn on a corpse |
| `OverviewDisplayMenu` | `components/session-tile/overview-display-menu.tsx:51` | Not an option list — a **settings panel** of segmented controls (`Segmented:223`) and switches (`Switch:267`). §12.6b makes it the *canonical* prefs surface; the palette mirrors it, it does not become it |
| `WherePicker` | `components/session-tile/where-picker.tsx:128` | Sectioned **form field** for new-session creation. Three of its nine sub-components are *inputs*, not options (`UseAnotherFolder:504`, `FreeTextDirInput:591`, `CreateFolderRow:702`), plus a `GitRepoHint:772`. It is a flow, not a result list |
| `SnippetPanel` | `components/snippets/snippet-panel.tsx` | Rows carry three bespoke gestures — tap-insert, 500 ms long-press-run, swipe-left-to-edit/delete with full-swipe auto-delete. **`snippet` enters the union as a palette result kind**; this sheet keeps its gestures |
| `KeyBarPicker` | `components/focus-mode/key-bar.tsx:594`, chips `:629` | A **chip grid** of raw key names, multi-select, no search, no navigation |
| `ResumePicker` | `components/terminal/resume-picker.tsx:64` | Already on the shared `ResponsiveSheet` (`:107`); a short list of resumable transcripts with per-row relative/absolute timestamps (`:45`/`:58`). Convergence would buy nothing and cost the timestamps |
| `DayPicker` / `OneShotPicker` | `components/scheduler/schedule-form.tsx:733` / `:829` | Cron-expression widgets. Not entities |
| `ScopePicker` | `components/claude-tools/add-mcp-form.tsx:71` | Two-option radio |
| Sort / display selectors | `session-tile/sort-control.tsx:30`, `group-sort-chip.tsx:95`, `focus-mode/focus-strip-mode-toggle.tsx:75`, `routes/files.tsx:221-267` | Closed enums over `SORT_MODE_META` (`lib/sort-modes.ts:9`) / `GROUP_SORT_MODES` (`lib/overview-layout.ts:60`). Radix menus with correct roving focus. **The palette mirrors them (T5.3); it does not absorb them** |
| Segmented controls | `settings/primitives.tsx:101` (`role=radiogroup`), `chat/renderer-switch.tsx:47` (`role=tablist`), `theme-toggle.tsx:19`, `team/team-width-toggle.tsx:28`, `overview.tsx:912`/`:857` | Always-visible "pick one of ≤5" chrome. Not lists, no search, no popup |
| Scheduler sub-pickers | `scheduler/schedule-form.tsx:258, :418, :529, :733, :829, :714` | Cron/recurrence widgets. Not entities |
| Native `<select>` outliers | `board/board-card-editor.tsx:176-187` (session!), `:502`, `board-composer.tsx:249`, `schedule-form.tsx:332, :626, :664` | **Real debt, and not B3's**: `session-picker.tsx:2` says it exists to replace exactly these and the board ones were never migrated. Board files die in B2; the scheduler ones are B1's Settings fold. Named here so neither fase can claim it was unknown |
| Action menus (`…` kebabs) | `session-tile/group-header.tsx:289`, `files/file-list.tsx:168`, `files/file-viewer.tsx:203`, `board/board-composer.tsx:341` | Verb menus on a specific object, not a search over a corpus |
| Mobile dock `SessionPill` swipe | `components/focus-mode/dock.tsx:821` (`ComposeField`) | **Not a picker** — it is the *trigger* for the focus-mode sheet, plus a swipe-to-neighbour gesture. Listed here because T7 changes what its tap opens (§4.2) |
| Mobile bottom-panel pill strip | `focus-mode/mobile-bottom-panel.tsx:472-478` (`role="listbox"`), pills `:527` | A horizontally scroll-snapping pill rail, not a vertical list. **But it carries `role="listbox"` with no `role="option"` on the pills — a genuine a11y bug.** B3 fixes the roles in T7.4 because it is already in this file's blast radius; it does **not** convert the rail |

### 0.3 Transcript deep-link search — exactly what exists

| piece | status |
|---|---|
| Chat history REST `GET /api/sessions/{name}/chat/history?before=&limit=` | **exists** — `server/src/sessions/chat/ws.rs:771`, registered `sessions/mod.rs:90-97`. Cursor `"<conversation_id>:<byte offset>"` (`ws.rs:138-163`), default 200. **Backwards paging only** (`ws.rs:315-318`: `e.offset < before`). Wrong-conversation cursor → `409 "…re-seed"` |
| Fetch-one `GET /api/sessions/{name}/chat/entry/{uuid}` | **exists** — `ws.rs:807`; O(file) scan on the blocking pool |
| Server transcript search | **exists as a substring scan** — `recall.rs:196` handler, match at `:350-353`. `scope=session\|project`, `q`, `limit≤100`, cursor `"<session_id>:<uuid>"` |
| FTS / SQLite transcript index | **does not exist** — zero `fts`/`MATCH`/`LIKE '%` hits across 24 migrations and `server/src/db` |
| `offset` + `conversation_id` on a search result | **does not exist** — `RecallEntry` (`recall.rs:96-113`) has `uuid` + `sessionId` only. A recall hit therefore **cannot be turned into a chat-history cursor** |
| "jump to / around an entry" read path | **does not exist** |
| `offset`/`seq` in the renderer's entry model | **dropped** — `toChatEntries` (`wire-entries.ts:252`) discards both; `ChatEntry` (`entries.ts:8-28`) keeps `uuid`, `ts` (floored to seconds), `text`, `kind`, … |
| a DOM anchor per transcript row | **does not exist** — `conversation.tsx:439` sets only the React `key`; zero `data-uuid` / `#entry-` hits repo-wide |
| scroll-to-entry in chat | **does not exist** — `chat-panel.tsx:133-197` does bottom-pin + prepend-restore only |
| a hash-anchor scroll mechanism to copy | **exists** — `routes/settings.tsx:776-790` (`useLocation().hash` → rAF → `querySelector` → `scrollIntoView`) |
| a query-param deep-link pattern to copy | **exists** — `?teammate=<agent_id>`, read-once-then-stripped: `focus-mode/desktop-split.tsx:149-164`, `routes/focus/mobile.tsx:422-434` |
| the route to host it | `/focus/:name` (`App.tsx:96`). **There is no `/session/:name`** |
| terminal history search | **does not exist** — no `@xterm/addon-search`, zero `search` hits under `components/terminal/` |

**What this forces.** The honest v1 is a **client-side walk**, not a server jump: the recall result
carries a `uuid`, the socket already holds the newest window, and `loadOlder` already pages
backwards (`use-chat-backlog.ts:47-66`). B3 therefore needs, on the client: `offset` preserved
through `toChatEntries`, a `data-entry-uuid` attribute on the row, a scroll-to-anchor hook copied
from `settings.tsx:776-790`, and a **bounded** page-back loop. The **one** server change is two
serde fields on `RecallEntry` so the client can *tell the user how far back it is* before spending
the pages — and that field addition is itself a spike (T9.1), because `recall.rs`'s merged-stream
reader may not thread byte offsets today.

### 0.4 Test & tooling reality

- Unit tests are **`bun test`**, not vitest — `bun run test:unit` → `bun test tests/unit`, **37 files
  in `web/tests/unit/`** (not under `web/src`). There is **no jsdom, no @testing-library, no
  `userEvent`, no axe** anywhere in the repo. Component tests assert **strings from
  `renderToStaticMarkup`** (`react-dom/server`); CSS contracts are asserted by parsing
  `globals.css` (`tests/unit/brand-tokens.test.ts`).
- **The house idiom for "keyboard-nav a11y tests" is therefore fixed and B3 must follow it, not
  invent one**: a *pure reducer* unit-tested as a truth table (`composerKeyIntent(event, state) →
  intent`, asserted at `chat-interactive.test.tsx:603`/`:616`) **plus** a `renderToStaticMarkup`
  string assertion on the rendered `aria-selected` / `data-highlighted` row
  (`chat-interactive.test.tsx:652`, `chat-header.test.tsx:159`). Real key events can only be
  dispatched in Playwright.
- E2E is Playwright against a **real server binary** per spec — `web/playwright.config.ts`,
  `testDir ./tests/e2e/smoke` (28 specs), serial, 90 s. Two palette specs exist:
  `board-cmdk-drag-send.spec.ts:105-146` (Meta+k, `listbox 'Palette results'`, the three board verbs,
  the full send + done sub-flows) and `archived-recover.spec.ts:89-91` (`View archived sessions`).
  Also `playwright.mobile.config.ts` (hermetic, route-mocked, iPhone 14 Pro Max **webkit**, serves
  `dist`) and `playwright.screens.config.ts`.
- **This box:** every Playwright run needs
  `LD_LIBRARY_PATH=/home/supermux/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu:/home/supermux/.local/chromelibs/extract/lib/x86_64-linux-gnu`
  and `SUPERMUX_E2E_NO_SANDBOX=1`. Under `--single-process` **a spec cannot open a second browser
  context** — every mobile check must be one test.
- Offline VR rig (memory *offline-mobile-ui-review-rig*): worktree Vite
  `bunx vite --port 5199 --strictPort --host 127.0.0.1`; Playwright required from
  `/opt/projects/folderwijzer/app/backend/node_modules/playwright`; chromium headless-shell at
  `~/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell`
  with the `LD_LIBRARY_PATH` above and `args:['--no-sandbox','--no-zygote','--disable-gpu']`;
  **`deviceScaleFactor: 1` mandatory**. Theme is a `.dark`/`.light` class on `<html>` — force it
  in-page with `document.documentElement.classList`; **every VR check below is two shots, light and
  dark.** Never `waitUntil:'networkidle'` against a real backend (SSE + WS never idle) — use
  `domcontentloaded` + a settle sleep. Compare with the perceptual differ, not bytes (the app
  renders live timestamps).
- DEV benches: `/dev/tiles`, `/dev/term/:name`, `/dev/focus/:name?`, `/dev/focus-mobile/:name?`,
  `/dev/teams`, `/dev/marks`, `/dev/chat-ui`, `/dev/chat-live` — all `import.meta.env.DEV`-gated and
  lazy (`App.tsx:19-50`, routes `:110-186`). `/dev/chat-live` takes
  `?mock&state=<id>&surface=phone&theme=dark&bare=1`. **B3 adds `/dev/pickers`.**
- Type/lint: `bun run lint` (eslint 9 flat) is **already red on `origin/main`** — 6 pre-existing
  `react-hooks/set-state-in-effect` errors. The standard is **zero NEW errors**, not green.
  `bunx tsc -b --noEmit`; `bun run build:perf` (budgets 200 KB gz JS / 30 KB gz CSS; baseline at B1
  158.40 / 17.08).
- Rust in-sandbox: `cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu
  OPENSSL_INCLUDE_DIR=/usr/include cargo check|test|clippy`. **Never `--release`.**

---

## 1. Deliverables

1. **`web/src/components/ui/entity-picker.tsx`** — the promoted primitive. Two anchors
   (`anchor="token" | "field"`), the widened row union with `run?`, an icon slot,
   `[data-highlighted]` set identically by keyboard and pointer, keyboard `scrollIntoView`,
   per-anchor max-height, `--sm-popover-shadow`. Presentational `EntityPickerView` + connected
   default export preserved; still lazy-loadable; still fetches nothing.
2. **`lib/entity.ts`** — the typed result union (`session · file · issue · schedule · snippet ·
   skill · host · command · action`) and `resolveEntityTarget(row)`, the single indirection every
   consumer navigates through.
3. **Both type-ahead popovers riding the primitive** — the chat `@`/`/` popover (up-from-token, no
   behavioural change, one intended visual delta: row inset + radius) **and the scheduler's
   `PromptField`** (down-from-field), which is what proves the two-anchor API and deletes the second
   of four keyboard engines.
4. **The ⌘K palette rebuilt on the primitive** — the picker's fuzzy ranker replaces six substring
   predicates, real group headings, and **a mobile entry point** (today the palette is literally
   unreachable on a phone).
5. **Palette navigation + actions**: go-to Overview/Focus/Files/Settings, new session, new group,
   theme toggle, sort/density/view mirrors, open file, new schedule.
6. **`lib/shortcuts.ts`** — the declarative shortcut catalogue, its cheatsheet in the palette, a `?`
   binding, and a unit test that proves every entry still points at real code.
7. **The focus-mode session sheet on the primitive** — search + keyboard nav where there is none
   today, without disturbing the mobile pill's tap-vs-swipe gate.
8. **Transcript deep-link search** (flagged): recall results become links, `/focus/:name?entry=<uuid>`
   resolves them, and the chat surface can scroll to an entry.
9. **BRAND.md §6c** gains an `EntityPicker` row and the three logged deviations.
10. **`/dev/pickers`** — the VR bench, both anchors × both themes × desktop/phone.

---

## 2. Tasks

Nine build tasks + an integration gate. Each is one commit; T1 lands first and stays green.

### T1 — The regression net, before anything moves

- [x] **T1.1** Pin today's picker DOM: extend `tests/unit/chat-interactive.test.tsx` with a
      `renderToStaticMarkup` snapshot of `EntityPickerView` for all three `kind`s, asserting exactly
      one highlighted row, `role=listbox`/`role=option`/`role=presentation` nesting, the
      `PICKER_LISTBOX_ID`/`pickerOptionId` wiring, and the empty-state copy. These assertions must
      survive T2 **unchanged except for the attribute rename** — that is the proof the promotion was
      lossless.
- [x] **T1.2** New `tests/unit/entity-picker-keys.test.ts`: a truth table for the new pure reducer
      `entityPickerKeyIntent(event, state) → 'move-up'|'move-down'|'accept'|'close'|'pass'`, extracted
      from `use-composer.ts:104-111` *without changing composer behaviour*. Cover Home/End/PageUp/
      PageDown (new), wrap-around at both ends, IME (`isComposing`, keyCode 229) outranking
      everything, and Shift+Tab passing through.
- [x] **T1.3** **The mobile session-pill lock** (§4.2). One Playwright test in
      `tests/e2e/smoke/mobile-session-pill.spec.ts` — *one* test, not two, because this box's
      `--single-process` chromium cannot open a second context. It must assert, against the real
      dock: (a) a short stationary tap on `ComposeField` opens the session sheet (chat mode, where
      `onEdit` is undefined — `routes/focus/mobile.tsx:757-765`); (b) a >10 px horizontal drag past
      `width*0.4` switches to the neighbour session and does **not** open the sheet; (c) a drag that
      stops short snaps back and opens nothing; (d) after the tap, `document.activeElement` is **not**
      `textarea.xterm-helper-textarea`. Constants under test: `TAP_SLOP_PX = 10`, `TAP_MAX_MS = 500`
      (`dock.tsx:886-887`).
- [x] **T1.4** Palette e2e baseline: record that `board-cmdk-drag-send.spec.ts` and
      `archived-recover.spec.ts` pass on the branch point, and add
      `tests/e2e/smoke/palette-keys.spec.ts` covering the paths nothing tests today — ⌘K toggles
      *closed*, ArrowDown wraps at the end, Escape steps back one sub-flow level, and the highlighted
      row is scrolled into view after 12 downs.
- [x] **T1.5** VR baseline into `~/b3-vr/pre/`: chat popover (`/dev/chat-live?mock&state=idle`, with
      and without `&surface=phone`), the palette open on `/` and on `/board`, and the focus-mode
      session sheet — **light and dark, DPR 1**, desktop 1440×900 + iPhone 14 Pro.

**Verify:** `bun run test:unit` green; the three e2e specs green with the `LD_LIBRARY_PATH` +
`SUPERMUX_E2E_NO_SANDBOX=1` line from §0.4; `~/b3-vr/pre/` has 2 shots per surface.

### T2 — Promote `<EntityPicker>` to a shared primitive

- [x] **T2.1** Create `web/src/lib/entity.ts`: `EntityKind = 'session'|'file'|'issue'|'schedule'|
      'snippet'|'skill'|'host'|'command'|'action'`; `EntityRow { id, kind, label, meta?, warn?,
      value?, run?, icon? }` (`value` = the string a token anchor inserts; `run` = what a field
      anchor invokes; **exactly one of the two is required**, enforced by a discriminated union so
      `tsc` refuses an unactionable row). Plus `resolveEntityTarget(row): { to: string } | { run:
      () => void }` — the single navigation indirection (§0.1, board-issue row).
- [x] **T2.2** Move `components/chat/entity-picker.tsx` → `components/ui/entity-picker.tsx`, keeping
      **both** exports and the `default` (so `React.lazy` at `chat/composer.tsx:46` keeps working and
      the chunk stays out of the hero path). Widen `onPick` to `(row: EntityRow) => void`; chat's
      call site becomes `onPick={(row) => handle.picker.pick(row.value!)}`.
- [x] **T2.3** Add the **field anchor**. `anchor?: 'token' | 'field'` (default `'token'`) selects the
      wrapper class only — `token` keeps today's `absolute inset-x-0 bottom-full z-20 mb-2`; `field`
      renders the list with no positioning at all, for a parent that already owns a box (the ⌘K
      dialog, a sheet). **No portal, no floating-ui, no flip logic** — a portal breaks the composer's
      never-take-focus rule and adds a dependency the size budget has no room for.
- [x] **T2.4** Retrofit the §14 numbers: rows get `px-2` + `rounded-lg` with the highlight fill inset
      (list keeps `px-1.5` so the fill floats); `py-[7px]` desktop stays; **`py-[13px]` phone stays
      and is documented as a deliberate HIG exception**. `maxHeight` prop, defaulting to
      `min(280px,46vh)` for `token` and `min(420px,60vh)` for `field`.
- [x] **T2.5** Rename `data-active` → **`data-highlighted`**; add `--sm-popover-shadow` to
      `globals.css` (warm family, both themes) and point `entity-picker.tsx`, `chat/composer.tsx:322`
      and `chat/ui/composer.tsx:79` at it.
- [x] **T2.6** **Fix the scroll defect**: on every highlight change from the *keyboard* path, call
      `scrollIntoView({ block: 'nearest' })` on the active row — the palette's existing mechanism
      (`command-palette.tsx:771-774`), moved into the primitive. Pointer-driven changes must **not**
      scroll (hover moving the list under the cursor is a well-known bug).
- [x] **T2.7** Icon slot: `row.icon?: LucideIcon` rendered at 14 px in `text-ink-3`. Chat rows pass
      none (preserving today's look); palette rows pass the icons `PaletteRowView:970-1041` uses.
- [x] **T2.8** `/dev/pickers` route (DEV-only, lazy, `App.tsx` alongside the others): both anchors ×
      all nine kinds × `{desktop, phone}`, plus empty/loading/overflow-of-40-rows states.
- [x] **T2.9** BRAND.md §6c gains an `EntityPicker` row with the load-bearing numbers, and the three
      deviations from §14 (max-height split, warm shadow, phone row height) recorded with reasons.

**Verify:** T1.1's assertions pass with **only** the `data-active`→`data-highlighted` edit;
`bun run test:unit`; new `tests/unit/entity-picker.test.tsx` asserts both anchors' container
classes, per-anchor max-height, `data-highlighted` on exactly one row, the icon slot, and that a row
with neither `value` nor `run` **fails to typecheck** (assert via a `// @ts-expect-error` line);
`bunx tsc -b --noEmit`; VR `/dev/pickers` both themes, both surfaces → `~/b3-vr/post-T2/`.

### T3 — Both type-ahead popovers ride the primitive — the two anchors' proof

The chat popover and the scheduler's `PromptField` filter **the same slash-command corpus** in
opposite directions with zero shared code (§0.2 finding 1). Merging them here — before the palette —
is what proves the two-anchor API is real rather than a prop nobody exercises.

- [x] **T3.1** Point `chat/composer.tsx:46` at the new module; delete the moved file; keep
      `slash.ts`'s `atRows`/`slashRows`/`fuzzyScore`/`rankEntities` where they are (they are chat's
      *data*, not the picker's) but re-type their output as `EntityRow` from `lib/entity.ts`.
- [x] **T3.2** Keep every A4 invariant intact and re-assert it: the picker still inserts and never
      sends; still never takes focus (`onMouseDown` + `preventDefault`, `:196`); the field still owns
      `role=combobox` / `aria-expanded` / `aria-controls` / `aria-activedescendant`
      (`composer.tsx:172-180`); `/model`-class commands still list-with-`warn` and still refuse to
      send (`classifySlash`, `slash.ts:207`).
- [x] **T3.3** Rebuild `scheduler/prompt-field.tsx`'s list (`:263-290`) on
      `<EntityPickerView anchor="field">`, deleting its private keyboard engine (`:202-234`) in favour
      of T1.2's reducer and T2.6's scroll. **Keep its own text plumbing untouched** — `detectSlashQuery`
      (`:109`), `splitCommandAndPrompt` (`:43`), `mergeCommandAndPrompt` (`:64`), `insertion` (`:31`),
      `bareName` (`:102`) are scheduler semantics, not picker semantics, and the field/token split is
      exactly the seam that lets them stay put.
- [x] **T3.4** Reconcile the two rankers: `PromptField` caps at 8 with its own filter (`:148-160`),
      chat ranks with `fuzzyScore`/`rankEntities` and caps at 12. Adopt the chat ranker in both, keep
      each surface's own limit as a prop. This is a **deliberate behaviour change for the scheduler**
      (it gains subsequence matching) and it is called out in the PR body.

**Verify:** the whole `chat-interactive.test.tsx` + `chat-slash.test.ts` +
`dev-chat-live-fixture.test.ts` suites unchanged and green; a new unit test asserting the *same*
`EntityRow[]` is produced for a `/comp` query on both surfaces; **VR diff `~/b3-vr/pre` vs `post-T3`
for the chat popover must show a delta confined to the row inset/radius** — anything else is a
regression, and the perceptual differ (never a byte compare — the app renders live timestamps) is the
evidence in the PR body. VR the scheduler form with the `/` popover open, both themes.

### T4 — Rebuild the ⌘K palette on the primitive

- [x] **T4.1** Replace `PaletteRowView` (`command-palette.tsx:944-1044`) and the hand-rolled listbox
      (`:870-875`) with `<EntityPickerView anchor="field">`. Keep the Radix `Dialog`, the input, the
      board sub-flow step machine (`:740-765` Escape-steps-back included), and
      `pickFreshestSession` (`:1048`).
- [x] **T4.2** Replace the six substring predicates (`matchesSession:181` … `matchesIssue:225`) with
      `rankEntities`/`fuzzyScore`. This is a **user-visible improvement and a behaviour change** —
      the palette gains subsequence matching and score ordering. Keep the leading-`/` slash-mode
      filter (`:481-482`).
- [x] **T4.3** Real group headings (`Sessions`, `Go to`, `Actions`, `Commands`, `Skills`, `MCP`),
      replacing today's implicit ordering-only grouping. Headings are non-focusable and skipped by
      arrow keys.
- [ ] **T4.4** **A mobile entry point.** Today ⌘K is reachable only from a physical keyboard or the
      `IconButton` in `DesktopDock` (`dock.tsx:222`); `MobileDock` (`:446`) has none and the mobile
      nav (`layout.tsx:167-209`) has none — the palette is **unreachable on a phone**. Add a search
      affordance to the mobile shell, and render the palette as `ResponsiveSheet` on coarse pointers
      so it gets safe-area + keyboard-viewport handling instead of a fixed `top-[20%]` box.
- [x] **T4.5** Delete the now-duplicate `scrollIntoView` at `:771-774` (T2.6 owns it).

**Verify:** `palette-keys.spec.ts` (T1.4) and both existing palette e2e specs green **unchanged** —
they select by `getByRole('listbox', { name: 'Palette results' })` and by option text, so a correct
rebuild leaves them alone; new unit test for the ranker swap; VR palette on `/`, on `/board`, and on
iPhone 14 Pro, both themes.

### T5 — The palette learns to navigate and to act

- [ ] **T5.1** Navigation verbs as `kind:'action'` rows through `resolveEntityTarget`: Overview,
      Focus, Files, Settings — sourced from **the same `NAV` array** `layout.tsx:45-62`, not a copy,
      so B2's board removal deletes the palette verb automatically. A unit test asserts
      `paletteNavRows().length === NAV.filter(visible).length`.
- [ ] **T5.2** Creation + display verbs: `New session` (opens the §12.6 create sheet), `New group`
      (existing, unchanged), `New schedule`, `Open file…` (a sub-flow reusing the picker with
      `kind:'file'` over `/api/ls`), `Toggle theme` (calls `theme-provider`'s setter).
- [ ] **T5.3** Sort / density / view rows as **thin mirrors**: each calls the identical handler
      `OverviewDisplayMenu` calls (`overview-display-menu.tsx:51`), never a second copy of the state.
      Each mirror row's `meta` names the canonical surface ("also in Display"). Where B2 has
      centralised the pref, use the server pref; where it has not, use today's store and leave a
      `TODO(B2)` comment naming the file.
- [x] **T5.4** Board verbs: **leave exactly as they are.** They are B2's to delete. Say so in the PR
      body; do not pre-emptively remove them.

**Verify:** unit tests for the NAV-derivation and for "every mirror row's handler is
reference-identical to the display menu's"; e2e: ⌘K → type "settings" → Enter lands on `/settings`;
⌘K → "dark" → Enter flips `<html class>`.

### T6 — The shortcut catalogue and the cheatsheet

- [ ] **T6.1** `web/src/lib/shortcuts.ts`: a frozen array of
      `{ id, combo, label, scope: 'global'|'overview'|'focus'|'terminal'|'chat'|'palette',
      source: 'path/to/file.ts:LINE' }`, seeded with all fifteen from §0.1's row — ⌘K
      (`command-palette.tsx:157`), ⌘D/⌘W/⌘G (`use-keyboard-capture.ts:62-76`), ⌘1..9 (**both**
      registrations, `use-keyboard-capture.ts:78` and `overview.tsx:489`), `[`/`]`
      (`overview.tsx:163-192`), the `g n` chord (`overview.tsx:345-382`), type-on-hover
      (`use-peek-type.ts:180-249`), Escape-clears-selection (`board.tsx:161`), ⌘C / Shift+Alt+Enter
      (`use-live-term.ts:1390-1410`), Enter/Shift+Enter (`use-composer.ts:108-117`), ⌘Enter
      (`mobile-compose-sheet.tsx:775`, `board-composer.tsx:209`), and the palette's own ↑/↓/Enter/Esc.
- [ ] **T6.2** **The anti-rot test** — `tests/unit/shortcuts-registry.test.ts`: for every entry, read
      `source`'s file, assert the line exists, and assert it contains the entry's key literal
      (`'k'`, `'ArrowDown'`, `'['`, …). A moved listener fails the build instead of silently making
      the cheatsheet lie. Also assert `⌘1..9` has **two** entries and that their `label`s name their
      different scopes — the duplication is real and the cheatsheet must not hide it.
- [ ] **T6.3** Render the cheatsheet as a palette mode (a `Keyboard shortcuts` action row, plus `?`
      when no input is focused), grouped by `scope`, using `ui/kbd.tsx`'s `Kbd combo=` so ⌘/Ctrl is
      platform-correct via `lib/platform.ts`.
- [ ] **T6.4** Advertise ⌘K in the shell per §14 — a `Kbd` hint in the search affordance added by
      T4.4.
- [ ] **Out of scope, stated:** rewiring the fifteen `addEventListener`s to dispatch *from* the
      registry. Catalogue now; dispatcher is a separate, riskier change.

**Verify:** `shortcuts-registry.test.ts` green; deliberately break one `source` line number and
confirm it goes red; VR the cheatsheet, both themes.

### T7 — The focus-mode session sheet on the primitive *(the pill-regression task)*

- [ ] **T7.1** Rebuild `focus-mode/session-picker-sheet.tsx:47`'s body on `<EntityPickerView
      anchor="field" surface="phone">` — gaining a filter input and keyboard navigation it has never
      had, and pinned-first ordering with the §12.4 hairline. **Keep the Vaul `Drawer` shell exactly
      as it is** (`:62-138`): same `Drawer.Root`/`Portal`/`Overlay z-[60]`/`Content`/`Title`, same
      snap behaviour, same `TeamPickerHeader:146`.
- [ ] **T7.2** **Do not touch `dock.tsx`.** `ComposeField`'s tap-vs-swipe gate (`:886-935`) — the
      pointer-down candidate, `TAP_SLOP_PX`/`TAP_MAX_MS`, the multi-touch invalidation, the
      `draggedRef` interlock with framer's `onDragStart`, and above all the **ghost-click fix** (the
      action fires on `click`, never `pointerup`, because a synthetic click landed on the sheet's
      Cancel and closed it within ~50 ms — the "tapped Edit, nothing visible, terminal frozen"
      Android bug) — is load-bearing and stays byte-identical. T7 changes only *what the sheet
      renders*, never *how the pill decides*.
- [ ] **T7.3** A filter input inside a Vaul sheet is a keyboard-viewport risk: verify the input does
      not fight `useKeyboardViewport` (`hooks/use-keyboard-viewport.ts`, `KEYBOARD_OPEN_THRESHOLD=80`)
      and that the sheet does not drag-dismiss when the user swipes the *list*. If Vaul's drag
      captures the list scroll, gate it behind `Drawer.Content`'s scroll-lock rather than
      re-implementing the sheet.
- [x] **T7.4** Cheap a11y fix while in this file's blast radius: `mobile-bottom-panel.tsx:472-478`
      declares `role="listbox" aria-label="Switch session"` over the pill rail but the pills
      (`SessionPill:527`) carry **no `role="option"`** — a listbox with no options. Either add the
      role or drop the listbox role for a `role="tablist"`/plain group; do **not** convert the rail to
      an EntityPicker (it is a horizontal scroll-snap strip, not a list).

**Verify:** **T1.3's mobile-pill spec must pass unchanged** — that is the acceptance criterion for
this task, not a nice-to-have. Plus: a new one-test spec asserting the sheet's filter narrows the
list and ArrowDown/Enter navigates; `document.activeElement` is not the xterm helper textarea after
picking; VR the sheet open + open-with-keyboard on iPhone 14 Pro, both themes.

### T8 — Recall search becomes a picker (the deep-link's front half)

- [ ] **T8.1** Rebuild `focus-mode/last-send-recall.tsx`'s result list (`:325-349`) on
      `<EntityPickerView anchor="field">` with `kind:'action'` rows, keeping the 150 ms debounce
      (`:189-190`), the scope `<select>` (`:309`), and the two include-toggles (`:406-420`). It gains
      keyboard navigation, which it has never had.
- [ ] **T8.2** Add the same search as a **palette mode**: `Search this session's transcript…` (and
      `scope=project`), so recall is reachable from ⌘K and not only from a focus-mode popover.
- [ ] **T8.3** Rows are still *insert-into-composer* here (today's behaviour, unchanged). Making them
      *navigate* is T9 and is flagged separately — T8 ships value even if T9 never does.

**Verify:** unit test over the row mapping; e2e: open recall, type, ArrowDown, Enter, assert the
composer draft; VR both themes.

### T9 — Transcript deep-links *(flagged; the riskiest task — see §4.1)*

Behind `VITE_SM_TRANSCRIPT_DEEPLINK`, default **off**, flipped in a separate commit per the PR-#27
discipline.

- [x] **T9.1** **Spike first, decide second (timeboxed).** Determine whether `recall.rs`'s reader can
      cheaply carry the byte offset and `conversation_id` per entry. If yes: add
      `offset: Option<u64>` + `conversationId: Option<String>` to `RecallEntry` (`recall.rs:96-113`),
      `#[serde(skip_serializing_if = "Option::is_none")]` so no client breaks, with a Rust unit test.
      If no: **stop, ship T9 without any server change**, and record the finding in the PR body. The
      rest of T9 is designed not to need it.
- [ ] **T9.2** Preserve `offset` and `seq` through `toChatEntries` (`wire-entries.ts:252`) into
      `ChatEntry` (`entries.ts:8-28`) as optional fields. **`entries.ts` is the frozen A1 display
      shape — additive optional fields only**, and `chat-entries.test.ts` must stay green untouched.
- [ ] **T9.3** Give transcript rows a DOM anchor: `data-entry-uuid={uuid}` on `TranscriptItem`
      (`conversation.tsx:437-439`). Nothing else — no id, no hash target, so nothing collides with
      `settings.tsx`'s anchor mechanism.
- [ ] **T9.4** `useScrollToEntry(uuid)` in `chat-panel.tsx`, copying `settings.tsx:776-790`'s
      rAF + `querySelector` + `scrollIntoView({behavior:'smooth', block:'center'})`, plus a
      **bounded backward walk**: if the uuid is not mounted, call `loadOlder()` (`use-chat-backlog.ts`)
      up to **N = 8 pages** (~1600 entries), then stop and surface an honest inline message —
      *"that message is further back than the loaded history"* with a link to the recall list.
      It must **not** loop unbounded: `history_page` is a full-file re-read per page
      (`ws.rs:303-332`) and the code's own comments cite 12 MB / 49 MB transcripts.
- [ ] **T9.5** The link itself: `/focus/:name?entry=<uuid>`, read-once-then-stripped, copying the
      `?teammate=` pattern verbatim (`desktop-split.tsx:149-164`, `focus/mobile.tsx:422-434`) so both
      surfaces behave the same. Wire T8's recall rows and the palette's transcript mode to emit it.
- [ ] **T9.6** Honesty: if T9.1 landed, the row shows how far back the entry is and the walk is
      bounded by *knowledge*; if it did not, the row says nothing and the walk is bounded by N. Never
      a spinner that could run for a minute.
- [ ] **Out of scope, stated loudly:** an FTS5 index over transcripts, an `around=`/`after=` chat
      history read path, and a `Kind::Delegation` recall variant. All three are named as future work
      (the tailer is already the single reader of each transcript, `sessions/chat/mod.rs:15-18`, so it
      is the natural indexing hook) — B3 does not build them.

**Verify:** Rust `cargo check|test|clippy` with the §0.4 env line if T9.1 landed; unit test for the
bounded walk's page cap and its give-up message; one e2e that deep-links to an entry present in the
seed window and asserts it scrolls into view; flag **off** by default and a test that asserts the
route param is inert when the flag is off.

### T10 — Integration gate

- [ ] **T10.1** Run, in order, pasting real output into the PR body — no claim without evidence:
      `bun run lint` (compare the error count against `origin/main`'s **6**; the standard is zero
      *new*), `bunx tsc -b --noEmit`, `bun run test:unit`, `bun run build:perf` (app JS ≤ 200 KB gz —
      **watch this one**: T2 moves a lazy chunk toward shared code and T4 pulls the palette onto it),
      then the smoke suite with the `LD_LIBRARY_PATH` + `SUPERMUX_E2E_NO_SANDBOX=1` line.
- [ ] **T10.2** VR sweep, **both themes**, DPR 1, desktop 1440×900 + iPhone 14 Pro: `/dev/pickers`
      (both anchors), the chat popover, the palette on `/` and `/board` and on phone, the focus-mode
      session sheet (closed / open / open-with-keyboard), the recall picker, the cheatsheet. Diff
      against `~/b3-vr/pre/` with the perceptual differ; every non-zero diff is either listed as an
      intended delta or fixed.
- [ ] **T10.3** Regression re-run of what B3 can plausibly break: `mobile-session-pill.spec.ts`,
      `board-cmdk-drag-send.spec.ts`, `archived-recover.spec.ts`, the mobile keyboard/keybar specs,
      and the chat renderer switch spec.
- [ ] **T10.4** Dogfood side-by-side **on another port** — never restart the instance hosting this
      chat (memory: *never-restart-this-instance-unasked*).
- [ ] **T10.5** PR `feat/b3-pickers` → `main`, handed to the owner for review (main is protected;
      Claude never merges). Body: the audit table's deviations, the VR grid, the perf delta, the test
      output, and an explicit statement of what B2 still owns (board verbs, prefs centralisation, the
      issue detail target).

---

## 3. Constraints, restated as checkable rules

1. **The picker never takes focus in the token anchor.** The textarea owns focus and
   `aria-activedescendant`; the list is `aria-controls`. A focus-stealing popover dismisses the soft
   keyboard on every phone. (Field anchor is the opposite and owns its own input — the prop is what
   distinguishes them.)
2. **The picker fetches nothing.** Data arrives as props from whichever surface owns the data plane
   (`chat-panel.tsx:289-296` for chat). This is what keeps the lazy chunk free of the API client
   (+0.5 KB gz measured for zero behaviour).
3. **One highlight atom.** Keyboard and pointer write the same state; `[data-highlighted]` is set by
   render, never by an event handler. Keyboard changes scroll; pointer changes do not.
4. **No new dependency.** No cmdk, no floating-ui, no kbar. The size budget is 200 KB gz and B1's
   baseline is already 158.40.
5. **Value pickers are not entity pickers.** A control bound to a form field with a closed option set
   stays Radix (§0.2 table B). If a surface has no search and fewer than ~12 options, it does not
   converge.
6. **Mirrors call the canonical handler.** A palette row that changes a pref must invoke the same
   function the display menu invokes — reference-identical, asserted by a test.
7. **The cheatsheet is generated, never hand-written**, and its registry entries are proven against
   real source lines by a test.
8. **`entries.ts` is frozen** (A1 display shape): additive optional fields only.
9. **Never `--release`; never edit `server/migrations/*`; PRs only from a worktree off
   `origin/main`; the owner reviews every merge; never restart :8824.**

---

## 4. Risks

### 4.1 Riskiest task: **T9, transcript deep-links**

**Why.** §14 says "recall search exists server-side" and the §17 B3 row treats deep-link search as a
one-liner. §0.3 shows the claim is technically true and materially misleading: recall's "search" is a
`contains()` over a full JSONL re-read; its result carries `uuid` + `sessionId` but **not** the
`offset`/`conversation_id` the A2 chat plane addresses entries by; the chat history route pages
**strictly backwards only**; the renderer's `ChatEntry` has already discarded `offset` and `seq`;
transcript rows have **no DOM anchor**; and the chat surface has **no scroll-to** at all. A naive
implementation reaches for an `around=<cursor>` endpoint, which means a new server read path, a
client seam-merge for the gap between the anchor and the live window, and — because every one of
these paths is an O(file) linear scan over transcripts the code itself describes as 12 MB and 49 MB
— a plausible multi-second stall on the main dogfood session. That is how a picker fase turns into a
data-plane fase.

**Mitigation, in the plan.**
- T9 is **sequenced last** and sits behind `VITE_SM_TRANSCRIPT_DEEPLINK`, default off, flipped in a
  separate commit. If it is not ready, T1–T8 still ship the entire §14 consolidation.
- **T8 is deliberately severable from T9**: recall becomes a real picker with keyboard navigation and
  a palette entry point *without* any deep-linking. Value lands even if T9 is dropped entirely.
- **v1 needs no new server read path.** The walk is client-side, reusing `loadOlder`, and it is
  **bounded at 8 pages** with an honest give-up message rather than an unbounded spinner — the
  performance risk is capped by construction, not by hope.
- The only server change (T9.1) is **two optional serde fields**, `skip_serializing_if`, gated behind
  a timeboxed spike that is explicitly allowed to conclude "no" — and the rest of T9 is designed to
  work without it.
- FTS5 indexing, `around=`/`after=` paging, and the seam-merge are named in §2 T9 as **out of scope**
  with the natural hook recorded (the tailer is already the single reader per transcript), so the
  next fase inherits a decision rather than a surprise.

### 4.2 Second-riskiest: **T7 and the mobile session pill**

`ComposeField` (`dock.tsx:821-935`) has scar tissue: a tap-vs-swipe gate with `TAP_SLOP_PX = 10` /
`TAP_MAX_MS = 500`, multi-touch invalidation, a `draggedRef` interlock with framer's `onDragStart`,
and a **ghost-click fix** — the action fires on `click` rather than `pointerup` because the
synthesized touch click was landing on the newly-mounted sheet's Cancel button and closing the editor
within ~50 ms, leaving Claude blocked in `$EDITOR` with nothing on screen. Under chat, `onEdit` is
undefined (`routes/focus/mobile.tsx:757-765`), so **the pill's tap opens exactly the sheet T7
rebuilds**. Mitigation: T1.3 locks the gate's behaviour in a Playwright test *before* T7 runs and is
T7's stated acceptance criterion; T7.2 forbids touching `dock.tsx` at all; and T7.1 keeps the Vaul
shell byte-identical so only the sheet's *contents* change.

### 4.3 Vaul sheet behaviours

Fourteen files use Vaul directly. T7 adds a **text input inside a drag-dismissable sheet** — the
combination that historically fights `useKeyboardViewport` (`KEYBOARD_OPEN_THRESHOLD=80`) and
drag-to-dismiss-on-list-scroll. T7.3 makes this an explicit check with a stated fallback (gate via
`Drawer.Content` scroll-lock, never re-implement the sheet). T4.4 similarly moves the palette to
`ResponsiveSheet` on coarse pointers rather than inventing a mobile dialog.

### 4.4 Palette rebuild silently changes matching

T4.2 swaps substring for fuzzy. That is an improvement, but it reorders results, and both existing
palette e2e specs select options by text — they will pass while the *ranking* silently regresses.
Mitigation: T4.2 ships its own unit test over the ranker's ordering for a fixed corpus, and T10.2's
VR includes the palette with a query typed.

### 4.5 The scheduler is collateral

T3.3/T3.4 change a surface that has nothing to do with chat: `PromptField` loses its private keyboard
engine and gains fuzzy matching. It is also **the surface B1 is folding into Settings** — if B1's T8
lands first, `prompt-field.tsx`'s host moves while B3 edits its body. Mitigation: B3 touches only
`prompt-field.tsx` itself (never `schedule-form.tsx`'s layout), so the two changes are orthogonal
even if they collide textually; and T3.3 explicitly leaves `detectSlashQuery`/`splitCommandAndPrompt`
/`mergeCommandAndPrompt`/`insertion`/`bareName` alone, which is where all the scheduler semantics
live.

### 4.6 Bundle budget

T2 promotes a lazy chat chunk into shared code and T4 pulls the palette (1061 lines) onto it. The
palette is **eagerly mounted** at `layout.tsx:270`, so a careless import graph drags the picker into
the hero path. Mitigation: T10.1 gates on `build:perf`; if the hero path grows, the palette's own
body becomes lazy behind its `open` state (it renders nothing when closed anyway).

### 4.7 Stacking on unlanded work

B3 stacks on B2, which is a 30-line skeleton. The four board verbs, the prefs centralisation, and the
issue-detail navigation target are all B2's. Mitigation: T5.4 leaves board verbs alone; T5.3's
mirrors carry `TODO(B2)` comments naming files; T2.1's `resolveEntityTarget` isolates the issue
target to one function.

---

## 5. Explicitly out of scope

- Mounting a search field on the overview header (§14's "overview search" — B2's §12.7 header work).
- Deleting the palette's board verbs or the Board page (B2).
- Centralising the sort/density/view prefs on the server (B2 §12.6b) — B3 mirrors whatever exists.
- Rewiring the fifteen keyboard listeners to dispatch from `lib/shortcuts.ts` (catalogue only).
- Converging any surface in §0.2 table B.
- **The three copy-pasted "pill → DropdownMenu / Vaul half-sheet" shells** (`session-picker.tsx`,
  `board-switcher.tsx`, `session-picker-sheet.tsx`) — B3 rebuilds only the third one's *contents*
  (T7). The shell dedup belongs to B5's §16.1 "one modal system", and §0.2 finding 3 hands it over.
- **The six native `<select>`s** (`board-card-editor.tsx:176`, `:502`, `board-composer.tsx:249`,
  `schedule-form.tsx:332`, `:626`, `:664`) — the board ones die with B2, the scheduler ones belong to
  B1's Settings fold. Recorded in §0.2 table B so neither fase can claim they were unknown.
- FTS5 / a transcript index, an `around=`/`after=` chat-history read path, a `Kind::Delegation`
  recall variant, and terminal scrollback search.
- Entity chips in system lines (§13.1 — B4), and `@session` delegation (§13.2 — B4). B3 ships the
  picker they will both consume, and `resolveEntityTarget` is the seam.

---

## 5b. T9.1 — the spike, and its verdict

**Verdict: NO. B3 ships no server change, and T9 is not built.** The plan
explicitly allows this conclusion (§2 T9.1, §4.1) and the evidence is below, so
the next fase inherits a decision rather than a rediscovery.

The question was whether `recall.rs`'s reader can cheaply carry a byte `offset`
and a `conversationId` per entry, so a recall hit could be turned into a chat-
history cursor. It can carry the offset. **It cannot carry a meaningful one**,
for three independent reasons — any one of which is fatal.

1. **The offset would address the wrong file for most hits.** Recall's own
   reason to exist is `scope=project`, and `files_for_scope`
   (`server/src/sessions/recall.rs:476-510`) enumerates **every `*.jsonl` in the
   project directory**, mtime-sorted. A hit therefore routinely comes from a
   conversation that is not the one on screen. The chat plane's cursor is
   `"<cc_conversation_id>:<byte offset>"` and `history_page` resolves it against
   that one file, refusing a foreign one with `409 …re-seed`
   (`chat/ws.rs:133-163`). So for the majority of hits the field would be
   correctly rejected, and for the minority where it matches, the client already
   has the cheaper path it was going to use anyway.
2. **An offset is not an address in this format.** One physical JSONL line fans
   out to N entries that share its start offset, and the chat plane's own
   identity test is `a.offset() == b.offset() && a.agent_id() == b.agent_id()`
   (`chat/ws.rs:217-263`). Recall does not model `agent_id` at all. Shipping the
   offset alone would hand the client a value that looks like an address and
   collides between a main-transcript entry and a subagent one.
3. **It is not free to compute, either.** Both readers stream with
   `BufReader::lines()` (`recall.rs:535`, `:673`), which discards the line
   terminator, and both `trim()` before use — so a true byte offset means
   switching to `read_line` with manual `\r\n` accounting. Ten lines, but ten
   lines in a hot path that `read_chat_turns_cached` (`:1002`) memoises by path,
   for a field two thirds of its consumers must ignore.

**What the honest v1 would have been** is unchanged from §0.3 and still stands
for whoever picks this up: the `uuid` plus `GET /chat/entry/{uuid}`
(`ws.rs:807`), a `data-entry-uuid` on the transcript row, and the bounded
8-page `loadOlder` walk. None of it needs a server change — which is what §4.1
predicted, and the spike confirms.

**Recorded as future work, with the hook:** the real fix is an index, not a
field. The tailer is already the single reader of each transcript
(`sessions/chat/mod.rs:15-18`), so it is the natural place to write one.

---

## 6. Execution ledger

Base `a7cc52c` (`main`). Budget at branch point: **entry 144.94 / 160 · app 209.79 / 210 · CSS 19.82 / 30.**

| task | status | app JS gz | notes |
|---|---|---|---|
| addendum | done | 209.79 (base) | re-audit vs real `main`; §A1 budget finding |
| T1 regression net | done | **209.99** (+0.20) | 1424 unit pass; pill spec + palette-keys spec green; found & fixed the ⌘K stale-query defect; VR pre in `~/b3-vr/pre` (14 shots). **0.01 KB headroom left — no additive task may run until T3/T4 delete.** |
| T2 promote the primitive | done | 210.25 (**over**) | `ui/entity-picker.tsx` + `lib/entity.ts`; scrollIntoView defect fixed; `data-highlighted`; `--sm-popover-shadow`; `/dev/pickers`; BRAND §6c.1. A move that adds capability cannot pay for itself — T4 is the payer. |
| T3 both type-ahead popovers | done | **210.84** (over) | scheduler rides `anchor="field"`, its keyboard engine and its `includes()` ranker deleted. Forced two extractions: `lib/rank.ts` and `chat/composer-keys.ts`, so the scheduler chunk stops inheriting chat's command table and 800-line hook. VR: chat popover delta confined to the row inset/radius. |
| T4 palette on the primitive | done (T4.4 deferred) | **210.23** (over by 0.23) | `PaletteRowView` (96 lines), the five `includes()` predicates and the THIRD keyboard engine deleted; group headings; `resolveEntityTarget` is the only pick path. Paid back 0.61 KB of T3's 1.05. Three further attempts at recovery (barrel removal, chunk consolidation, moving chat's empty-state copy out of the primitive) returned 0.02 KB total — the remainder is §14 capability, not packaging. **T4.4 (mobile entry) and T5–T9 deferred: all net-additive, and the ceiling is spent.** |
| T7.4 a11y (pill rail) | done | 210.23 (±0) | `role="listbox"` with no options → `tablist`/`tab`. A rail with no highlight, no arrow-key nav and no selection model was never a listbox. Not converted to a picker: a scroll-snap strip is not a result list. |
| T9.1 spike | done — **verdict NO** | 0 (no code) | Recall's offset would address the wrong file for `scope=project` hits, is not a unique address (subagent entries share offsets), and is not free to compute. §5b records the evidence and the indexing hook. |
| T4.4, T5, T6, T7.1–T7.3, T8, T9.2–T9.6 | **deferred** | would exceed 210 | All net-additive. Deferred at a task boundary rather than shipped over a ratcheted gate or paid for by deleting a §14 deliverable. |

### The budget, resolved as a question rather than a decision

Final: **entry 146.28 / 160 (91%) · app JS 210.23 / 210.00 (over by 0.23) · CSS
19.86 / 30.** The branch point was 209.79.

Every recovery avenue was tried and measured:

| attempt | recovered |
|---|---|
| dropping the re-export barrels (`slash.ts`, `use-composer.ts`) — did clean up the chunk graph | 0.00 KB |
| moving chat's trigger-specific empty-state copy out of the primitive (a better seam regardless) | 0.02 KB |
| deleting the group headings (T4.3) outright, as a test | 0.09 KB |

No single feature is responsible; the overage is spread thin across the second
anchor, the nine-kind union, `resolveEntityTarget`, the icon slot, the `leading`
slot that keeps B2's `SessionFace`, the headings and the four new keys.
**The consolidation itself is byte-neutral — three keyboard engines, five
substring predicates and a 96-line row renderer came out — and it is §14's
capability that costs the 0.44 KB.**

That leaves exactly two honest options, and both belong to the owner:

1. **Re-ratchet to 211 KB** (+0.5%). The ceiling has never been a designed
   limit — `size-budget.mjs`'s own comment block narrates it being set at
   whatever the then-current value was (200 → 210 at B2, measured 205.46), and
   B4 then filled the slack to 209.79 without re-ratcheting. The hero path,
   which is the number a user feels, is at 91% with 13.7 KB spare.
2. **Drop a §14 deliverable.** The cheapest is the group headings at 0.09 KB,
   which does not close the gap on its own.

The executor did neither: raising a ratcheted gate is not an executor's call,
and quietly deleting what §14 asked for would hide the trade rather than
present it. T4.4 and T5–T8 are deferred for the same reason — every one of them
is net-additive, and spending a budget that is already overdrawn to ship them
would make the ask bigger while burying it.
