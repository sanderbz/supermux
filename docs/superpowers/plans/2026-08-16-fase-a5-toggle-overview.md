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

# Fase A5 — Toggle everywhere + overview (the escape hatch becomes structural)

---

## ⓐ RE-AUDIT ADDENDUM — 2026-08-16, against real `origin/main` @ `ea642df`

> The body of this plan was written against the **A4 branch tip**. Between then and execution,
> `origin/main` absorbed **everything in the stack plus four more PRs**. This addendum is the
> correction layer: it is authoritative wherever it contradicts §0–§5 below.

### ⓐ.0 The base — the §0.4 question is moot

`origin/main` @ `ea642df` already contains **B0 (#60) · A2 (#61) · A3 (#62) · A4 (#63)** and then
**#59, #64, #65, #66, #67, #68**. The worktree is therefore cut from **plain `origin/main`**, not
stacked:

```
git worktree add /opt/projects/supermux-a5 -b feat/a5-toggle-overview origin/main
```

- **§0.4 (the A2 merge at the branch point) is DROPPED** — `chat_tail` is on main
  (`server/src/sessions/chat/store.rs::tail_summary`, `auto_actions.rs::ChatTailGate`,
  `lib/api/sessions.ts:91 ChatTail`, `session-tile/types.ts:48`). No merge SHA to record.
- **§4 Risk 4 (the A2 base) is CLOSED.** T5's source-agnostic property is kept anyway (it is free and
  it is the unit test), but there is no longer a base on which the tiles are quiet.
- **§10 / §4 Risk 9 (stacked-branch churn) is CLOSED.** The PR bases on **`main`**, not on
  `feat/a4-interactivity` (§T10 corrected).

### ⓐ.1 What #66 (daily-driver QA) already delivered — **T4 is ~70 % done**

#66 landed a real **FASE-A5 SLICE at the mobile focus seam**. Verified in the tree, not inferred:

| plan says (T4) | ground truth on `main` | left for A5 |
|---|---|---|
| T4.1 "the mobile `LiveTerminal` block becomes `RendererShell`" | `routes/focus/mobile.tsx:207-233` **already has the full renderer seam**: `isTeamLead` + `useChatRenderer` + `pickRenderer` + `chatPaneActive` + `terminalPaneMounts` + `mobileChrome`, and `:655-720` mounts `<ChatPanel surface="phone">` opposite `<LiveTerminal>` | **only** the swap-components→`RendererShell` change (retention). The decision plumbing is done |
| T4.2 "the mobile trio: back chevron · header pill · renderer switch" | **done** — `ChatPanel` takes `headerLeading` (a `data-testid="chat-back"` chevron) and `headerTrailing` (`<RendererSwitch size="sm" labels="selected">`), and a `switchRow` rail (`SWITCH_ROW_H`) carries the switch while the terminal is up. `mobileChrome()` guarantees **exactly one** switch on screen | make the switch tri-valued (T2) and point it at the pref (T1) |
| T4.3 "dock repack: `useTerminalInput` → `composerSessionInput` while chat is visible" | **done** — `mobile.tsx:248-267`, `const input = chatActive ? chatInput : termInput`; `chrome.keyBar`/`chrome.joystick`/`chrome.dockChat` hide the raw-key surfaces | nothing |
| T4.4 "keyboard ownership: the hidden xterm must not steal focus" | **partially** — the tap-to-focus gate is already off under chat (`onPointerDown={chatActive ? undefined : …}`), but there is no hidden xterm yet, so the retained-focus hazard is **created by A5** | the `inert`/`aria-hidden`/`blur()` work (T3 inv. 4) and the `activeElement` assertion |
| **NEW, not in the plan** | **`components/chat/seam.ts`** — the pure decision module (`pickRenderer`, `chatPaneActive`, `terminalPaneMounts`, `mobileChrome`), shared by both focus seams, unit-tested in `tests/unit/chat-seam.test.ts` | **`renderer-pref.ts` must not duplicate it.** `resolveRenderer` layers the 3-value pref *underneath* `pickRenderer`'s `chatOn`; `chatPaneActive`/`terminalPaneMounts`/`mobileChrome` stay as-is and keep both seams honest |

#66 also shipped, and A5 must not regress: `RendererSwitch` gained `size: 'md'|'sm'` and
`labels: 'both'|'selected'` (the phone header-card width rule, QA #6) — **T2 extends these, never
replaces them**; terminal scrollback/seed fixes; conversation scroll/touch fixes
(`tests/unit/touch-scroll.test.ts`).

### ⓐ.2 What #67 changed in the data hooks — retention now costs **two** sockets

The renderer no longer polls. `use-chat-tail.ts` (the A1 `/recall?chat=true` poll) is **DELETED**;
the surface rides the A2 chat WebSocket:

- `components/chat/use-chat-ws.ts` — `ChatSocket` bound through `useSyncExternalStore` (a socket *is*
  an external store; StrictMode's double subscribe is a real dispose-and-redial).
- `components/chat/use-chat-backlog.ts` — merges the socket window with fetched history pages.
- `chat-socket.ts` / `wire.ts` — connection + pure reducer.

**Consequence for T3 invariant 7 (cost accounting), which the plan gets wrong:** a *retained chat
pane* now holds a **chat WS** open, exactly as a retained terminal holds a **pty WS**. Both are
capped by the same value (`state.config.ws.subscribers_per_session`, default 32) but through
**separate slot pools** — `ws/mod.rs:209,467` for the pty, `sessions/chat/ws.rs:645 take_slot` for
chat — so they do not contend with each other. Retention therefore costs **+1 pty subscriber** *and*
**+1 chat subscriber per focused session, and only after the user has toggled at least once**.
Restated: retention stays **focus-only**; T6's WS-count assertion is written **per URL class**
(pty vs chat), not as one number.

Also from #68: eligibility keys off the **teams roster**
(`teams.some(t => t.lead_supermux_session === name)`), not the polluted `team_name` column. Both
focus seams already compute `isTeamLead` that way; T5's tile-side eligibility must do the same.

### ⓐ.3 Corrections to §0.1's fourteen rows (only the ones that moved)

| §0.1 row | still true? | correction |
|---|---|---|
| the switch is 2-way | **yes** — `renderer-switch.tsx` is still `'chat' \| 'terminal'` | T2 stands, and must preserve `size` + `labels` (#66) |
| the choice is ephemeral `useState` | **yes**, and now in **two** places — `desktop-split.tsx:337` *and* `routes/focus/mobile.tsx:219`, both `RendererOverride` keyed by name | T1 replaces **both**; `seam.ts`'s `RendererOverride` becomes a store read |
| the prefs allowlist matches exactly `overview_layout \| quick_keys` | **no** — it is now `"overview_layout" \| "quick_keys" \| db::prefs::AUTO_HEAL_PREF_KEY` (`server/src/prefs.rs:68-71`) | T1's one-arm change is unchanged in shape; the arm list is three, not two |
| the terminal is swapped, not retained | **yes** — `desktop-split.tsx:740-778` and `mobile.tsx:645-720` both still ternary-swap | **T3 is still the whole fase** |
| tile/row/quick-peek are the three overview surfaces | **partly** — `session-row.tsx` (129 lines) has **no preview slot at all**: its second line is `STATUS_LABEL + branch`. There is nothing to swap | **T5.2's `session-row.tsx` arm is dropped.** Adding a preview line there is row IA = **B2** (§5). Recorded as a deferral, not an oversight |
| "the tile/row context menu" lives in `tile.tsx` | **no** — the per-tile kebab is `TileMoveToKebab` in **`session-tile/group-grid.tsx:1966+`** (Info / Stop / Archive / Move to ▸). `tile.tsx` has only the hover archive affordance | T5.4's Renderer submenu goes in `group-grid.tsx`; §1's file list gains it (still inside `session-tile/`) |
| `chat-renderer-switch.spec.ts`'s three cases stay unedited (§0.2) | **impossible** — case 1 asserts `expect(getByTestId('chat-panel')).toHaveCount(0)` after tapping Terminal. Retention **deliberately inverts** that: the panel stays mounted, hidden | **exactly one assertion changes**, `toHaveCount(0)` → `toBeHidden()`. It is the assertion that encodes "the toggle unmounts", which is the thing A5 exists to stop. Called out in the PR body |

### ⓐ.4 The budget — main was over the cap, then #70 fixed it under us

`bun run build:perf` on the ORIGINAL branch point (`ea642df`) FAILED:

```
app JS total   200.30 KB
✗ main app JS  200.30 KB / 200.00 KB budget (100%)
```

The plan's "A4 ceiling 186 / A5 target 190 / hard cap 200" was stale by 14 KB,
and CI never noticed because `.github/workflows/*` do not call
`size-budget.mjs`. **#70 has since landed** (`perf(web): hero-path entry gate +
documented temporary total ceiling; lazy settings route`), splitting the gate in
two — a 160 KB HERO-PATH entry budget and a 232 KB total ceiling — and lazying
the settings route. A5 was rebased onto it. Final numbers:

| gate | base (`origin/main`) | A5 | delta | budget |
|---|---|---|---|---|
| entry JS (hero path) | 144.42 KB | **147.35 KB** | **+2.93 KB** | 160 KB ✓ |
| app JS total | 204.99 KB | **207.92 KB** | **+2.93 KB** | 232 KB ✓ |
| CSS | 19.97 KB | 20.00 KB | +0.03 KB | 30 KB ✓ |

The plan's per-task estimates summed to +3.7 KB; the fase landed at +2.93 KB,
all of it hero path (`desktop-split`, `tile`, `group-grid`, `ui-store` are all
entry) — which is why every A5 module is arithmetic and text, and why
`RendererShell` takes both panes as `ReactNode` props instead of importing them.

### ⓐ.4b Execution deviations, recorded as they were made

| plan | shipped | why |
|---|---|---|
| T2 `variant: 'full' \| 'compact'` | **dropped**; #66's `size` + `labels` carry it | The two axes already solve the same phone-width problem (QA #6). `size="sm" labels="selected"` renders `A · Chat · ⌨` — the leading-glyph compact rail the plan describes, out of the mechanism that was already there. One axis, less bundle |
| T5.2 `session-row.tsx` | **dropped** | The row has no preview slot at all (ⓐ.3). Adding one is row IA, which is **B2** |
| T5.2 `quick-peek-modal.tsx` → the chat lens | **deferred to B5** | The peek's value is the LIVE coloured screen. The only faithful chat equivalent is the transcript, which needs the `ResponsiveSheet` re-architecture §5 already sends to **B5**; a two-line stand-in would be a downgrade dressed as a feature. The peek keeps its `LiveTerminal`/`TailPreview` path, byte-identical |
| T5.4 "the tile context menu" in `tile.tsx` | shipped in **`group-grid.tsx`**'s `TileMoveToKebab` | That IS the overview's context menu (ⓐ.3). `tile.tsx` gained only the preview choice and an `isTeamLead` prop |
| tile eligibility via `useTeams()` | `isTeamLead` is a **prop**, `false` by default, passed `true` only from `team-card.tsx` | The overview renders dozens of tiles; a query + SSE subscription per tile is a lot of listeners for one boolean that exactly one caller knows. Everywhere else `splitTeamLeads` has already excluded leads |
| T3 retention held in a `useRef` | React's **"adjust state during render"** | `react-hooks` forbids reading or writing a ref during render (it fails `bun run lint` as an error). An effect would leave the retained pane a frame behind — the toggle would flash empty. `retain()` preserves object identity on unchanged frames so the fold terminates |
| §0.2 "`chat-renderer-switch.spec.ts`'s three cases unedited" | **one assertion changed** | `toHaveCount(0)` → `toBeHidden()` after tapping Terminal. That assertion encodes "the toggle unmounts", which is the exact thing A5 exists to stop |
| T7 wiring at the mobile seam | **desktop only** | `routes/focus/mobile.tsx` has no `useKeyboardCapture` at all — adding a document-level `keydown` listener to the phone route for a hardware-keyboard case, in the fase that also introduces a retained hidden xterm, is how the sixth refusal gets tested by a user instead of a test. The switch is one tap there, in two places already |
| §0.2 "`chat-header.test.tsx` untouched" | **re-pointed at the third cell** | It holds A3's switch assertions (`text() === 'Chat Terminal'`, and the props). The metrics and the e2e testids are still pinned; only the cell count moved |

### ⓐ.5 Ledger

- [x] **Re-audit** — worktree off `origin/main` @ `ea642df`; this addendum
- [x] **T1** — renderer preference (3 values, two scopes, one resolver) + `prefs.rs` arm
- [x] **T2** — the switch grows a third value
- [x] **T3** — `RendererShell` (mounted-but-hidden retention), desktop call site
- [x] **T4** — mobile focus call site (see ⓐ.1: mostly pre-delivered by #66)
- [x] **T5** — overview chat-tail tiles + the override entry points
- [x] **T6** — the toggle-thrash harness
- [x] **T7** — the `T` hotkey + the six-refusal matrix
- [x] **T8** — bench states + the VR pass (both themes, offline rig)
- [x] **T9** — verification, budget, regression net
- [x] **T10** — PR (base `main`) → https://github.com/sanderbz/supermux/pull/72

---

**Worktree** `/opt/projects/supermux-a5` · **branch** `feat/a5-toggle-overview`, stacked on
`feat/a4-interactivity` (→ `feat/a3-chat-surface` → `feat/b0-design-system`), **with
`feat/a2-chat-dataplane` merged into the branch point** (§0.4 — the tile work reads a field only A2
publishes).
**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` §6 (toggle &
persistence), §2.5 (overview tail — zero new requests), §4.1 (three call sites), §5.2 (toggle
placement), §11.6/§11.7 (same-cell crossfade, fixed chrome slots), §12.5 (tile evolution), risk row
*"Terminal escape hatch rots"*. It lives on the unmerged branch `docs/grok-ui-plan`; read it with
`git show docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`.
**Predecessor plans** `2026-08-14-fase-a3-chat-surface.md`, `2026-08-14-fase-a4-interactivity.md`
(this plan copies A4's shape deliberately: pure module → test → hook → surface).

> One sentence of scope: **A4 made chat a control surface; A5 makes the terminal a *retained*
> surface** — one 3-valued renderer preference that persists per session and across devices, both
> renderers alive in one grid cell so switching costs a crossfade instead of a handshake, the same
> decision honoured on the overview as a chat-style preview tile, and a thrash test that proves the
> escape hatch cannot rot.

---

## 0. What already exists (read before writing a line)

### 0.1 Ground-truth audit — what §6 assumes vs what A1/A3/A4 actually ship

Every row was read from the branches, not from the master plan. **Six of fourteen assumptions are
already false**, and two of those change the task list.

| §6 / §2.5 assumes | ground truth (file, branch) | consequence for A5 |
|---|---|---|
| a 3-way switch `Chat\|Terminal\|Auto` exists to extend | `components/chat/renderer-switch.tsx` (A3) is **2-way** (`'chat' \| 'terminal'`), a 30px hairline capsule with a `layoutId` thumb — and its own comment already says *"A5 adds the mobile call site"*, which is why the `layoutId` is **per-instance** (`useId()`), not a literal | T2 extends it to tri + a `compact` variant; the per-instance id is why two mounted switches (desktop + mobile, tile menu) will not fight |
| the choice is persisted | `desktop-split.tsx:317-334` keeps it in `React.useState<{name, value}>` — **deliberately ephemeral** (its comment: "resets on navigation and can never be stomped by a late flag resolve"). `ui-store.ts` has only the boolean `chatRenderer` | T1 introduces the real 3-valued model; the derived-not-effect pattern is kept verbatim, only its *source* changes |
| `ui-store.ts` gains `defaultRenderer` + `rendererOverrides` | neither exists; the store is `zustand + persist` under key `supermux-ui`, with a working `onRehydrateStorage` migration precedent | T1 adds both there, plus a prune on rehydrate (an unbounded `Record<name,…>` outlives deleted sessions) |
| `session_renderer` joins "the prefs allowlist (`prefs.rs:60-64`)" | the allowlist is `is_known_pref_key`, `server/src/prefs.rs`, and matches **exactly** `"overview_layout" \| "quick_keys"`. No migration involved (prefs is a kv table; `MAX_PREF_VALUE_BYTES` 50 KB). Client precedent: `hooks/use-overview-layout.ts` (one query + one mutation + SSE `prefs` reconcile, 404-as-unset) | T1: one-line server change + a hook cloned from `use-overview-layout.ts`. **Not** the same blob as `overview_layout` — a whole-value PUT race across devices is exactly the failure §12.2 calls out for seen-cursors |
| "the three call sites" = `tile.tsx`, `desktop-split.tsx`, `focus/mobile.tsx` (§4.1) | correct, and A4 T1 converted exactly those three to `SessionInput`. **But `LiveTerminal` has a fourth mount the master plan never lists**: `session-tile/quick-peek-modal.tsx:210` (mobile long-press, `readOnly`), plus `session-row.tsx` as a fifth *preview* surface with no terminal at all | A5 treats **two focus call sites as switch sites** (desktop + mobile) and **three overview surfaces as followers** (tile, row, quick-peek). A peek is not a renderer choice — it *follows* the session's resolved renderer, read-only. Stated as an invariant in T5 so nobody adds a switch to a Vaul sheet |
| the terminal is "mounted-but-hidden after first use" | today `desktop-split.tsx:683-706` **swaps components** (`chatActive ? <ChatPanel/> : <LiveTerminal/>`), so every toggle is a full unmount → `useLiveTerm` dispose → new WS → auth → resize → seed. The A1 code comment says so and points here: *"mounted-but-hidden retention is A5 §6.2"* | T3 is the whole fase's centre of gravity |
| chat "keeps composer draft" | **already true** — `components/chat/composer-draft.ts` (A4) holds drafts in module-level `Map`s precisely so "toggling to Terminal and back is a remount" cannot eat a message | nothing to do; retention makes it belt-and-braces |
| chat "keeps scroll" | **false** — the follow-bottom pin lives in refs inside `chat-panel.tsx`, which unmounts on toggle | fixed by retention (T3), asserted in T7 |
| "unread clears on either view" | there is no unread model yet — the three-tier attention model is **B2** | out of scope; T5 says so explicitly rather than half-building it |
| `chat_tail` rides the sessions SSE delta | **already shipped**, on the *sibling* branch: `server/src/sessions/auto_actions.rs` (`ChatTailGate`, change-gate + 1 s debounce), `ApiSession.chat_tail` / `TileSession.chat_tail`, shape `{user: string; agent: string; ts: number}` (≤200 chars each, CC's clock). Delta semantics: **absent = unchanged, never empty** | §0.4 — the base question; the renderer must honour absent≠empty |
| the toggle costs "+1 against the 32-subscriber cap" | the cap is real and configurable: `state.config.ws.subscribers_per_session`, enforced at `ws/mod.rs:197` and `:445`, 33rd connection closes `1013` | retention is **focus-only**; tiles/peeks never retain (T3 invariant 9) |
| the header pill carries the switch in its fixed slot (§5.2/§11.7) | `header-pill.tsx` (A3) exists but the switch sits in a separate `h-8` bar above the pane (A1, `desktop-split.tsx:660-665`) | A5 keeps the bar and does **not** restyle chrome — the header-grammar/fixed-slot work is B1. Recorded as a deferral, not an oversight |
| toggling mid-dialog: "the check completes; outcome lands on return" | A4's `use-dialog-answer.ts` verify→navigate→commit→dismissal sequence lives **inside the chat panel**; today a toggle unmounts it mid-sequence | retention is a *correctness* requirement, not only a latency one. T3 test |

### 0.2 Frozen — the regression net

| file | owns | rule |
|---|---|---|
| `hooks/use-live-term.ts` | the pty WS, FitAddon, the debounced `ResizeObserver` (`:2131`), the keyboard-stable geometry fix, the visibility resume health-check | **A5 does not edit it and adds no props to it.** A `git diff` here is a bug. Retention is achieved by *not unmounting*, never by teaching the hook about hiding |
| `components/chat/composer-draft.ts`, `pending.ts`, `use-dialog-answer.ts`, `registry/*`, `peek-lens.ts` | A4's write plane | A5 changes none of them; it only stops tearing them down |
| `components/chat/entries.ts`, `use-chat-turn.ts`, `provisional.ts`, `latency.ts`, `grouping.ts`, `frames.ts` | A1/A3 pure core | untouched |
| `tests/unit/chat-*.test.*`, `tests/e2e/smoke/*.spec.ts` | the net | green, unedited, at every task boundary — except `chat-renderer-switch.spec.ts`, which T8 **extends** (never rewrites: its three existing cases are the A1 acceptance) |
| `components/session-tile/tail-preview.tsx` | the ANSI terminal preview | A5 adds a sibling; a non-chat tile must render byte-identically to today |

### 0.3 `flag.ts` is the eligibility spine and stays that way

`chatEligible(s, isTeamLead)` = `provider === 'claude' && host_id == null && !isTeamLead`;
`chatRendererOn(settingOn, killSwitch, s, isTeamLead)` adds the Settings toggle and the
`localStorage['supermux:chat-renderer'] === '0'` kill-switch. **A5 adds no fourth gate.** The 3-way
preference is a *layer on top*: eligibility decides whether chat is even possible, the preference
decides what to show when it is. An ineligible session has exactly one renderer and therefore no
switch, no hotkey, no chat tile — enforced by one function, `resolveRenderer` (T1).

### 0.4 The base question (decide once, at branch creation, and record it in the PR)

A4 codes against the A1 wire and marks every A2 seam. A5's tile work (T5) is the first thing in
Track A that reads a field **only A2 publishes**. Options, and the decision:

- **Chosen:** create the worktree from `feat/a4-interactivity`, then `git merge
  feat/a2-chat-dataplane` **once, at the branch point**, and record the merge SHA in the PR body.
  Rationale: `chat_tail` is server-side + two type declarations; the merge conflict surface is
  `web/src/lib/api/sessions.ts` and `web/src/components/session-tile/types.ts` (both additive) plus
  A2's `recall.rs` vs A4's `queue-operation` arm (one match block, both additive). The alternative —
  copying A2's two interfaces into A5 with an `// A2-SEAM` — ships a field nothing ever sets, which
  is a feature that looks built and is not.
- **Either way, T5 is written source-agnostic**: the tile renders the chat preview *iff*
  `session.chat_tail` is present, and the terminal preview otherwise. On a base without A2 the tiles
  are quiet, never broken; on a base with A2 they are live. That property is unit-tested (T5), so
  the merge decision cannot silently change behaviour.
- If the owner has already merged A2 into `main` by execution time, rebase and drop the merge.

---

## 1. Deliverables

```
web/src/components/chat/
  renderer-pref.ts          NEW (pure) RendererPref, resolveRenderer, pin/unpin, prune
  use-renderer-pref.ts      NEW  store binding + /api/prefs/session_renderer sync
  retention.ts              NEW (pure) the mount-set reducer (sticky, name-keyed)
  renderer-shell.tsx        NEW  the two-cell .sm-swap shell + crossfade + inert/aria
  renderer-hotkey.ts        NEW (pure) shouldToggleRenderer(eventLike) — the focus-safety matrix
  renderer-switch.tsx       EDIT tri (`auto|chat|terminal`) + `compact` variant
web/src/components/session-tile/
  chat-tail-preview.tsx     NEW  the two-line chat preview (P1/P2 voice, tile type scale)
  tile.tsx                  EDIT preview slot chooses tail-vs-chat; context action sets the pref
  session-row.tsx           EDIT same preview choice at list density
  quick-peek-modal.tsx      EDIT chat-eligible + resolved-chat → chat lens, else LiveTerminal
  overview-display-menu.tsx EDIT global default renderer (Auto/Chat/Terminal)
web/src/components/focus-mode/
  desktop-split.tsx         EDIT call site #1 → RendererShell + pref + `T`
web/src/routes/focus/mobile.tsx  EDIT call site #2 → RendererShell + pref + `T` (the A1/A4 deferral)
web/src/components/focus-mode/use-keyboard-capture.ts  EDIT one plain-key branch, guarded
web/src/stores/ui-store.ts   EDIT +defaultRenderer, +rendererOverrides, +prune on rehydrate
web/src/hooks/use-renderer-prefs-sync.ts  NEW (cloned from use-overview-layout.ts)
web/src/routes/dev-renderer-thrash.tsx    NEW (DEV-only) the thrash bench
web/src/App.tsx              EDIT register the DEV route (existing import.meta.env.DEV pattern)
server/src/prefs.rs          EDIT is_known_pref_key += "session_renderer"
web/tests/unit/
  chat-renderer-pref.test.ts   chat-retention.test.ts   chat-renderer-hotkey.test.ts
  chat-tail-preview.test.tsx   chat-renderer-switch.test.tsx
web/tests/e2e/smoke/
  chat-toggle-thrash.spec.ts   NEW
  chat-renderer-switch.spec.ts EDIT (+retention, +persistence, +mobile viewport)
```

Nothing outside these paths changes. `web/package.json` is not touched (**no new deps**). No
`server/migrations/*` change — prefs is a kv table (memory: *sqlx migrations are checksummed*).

---

## 2. Tasks

TDD throughout: pure module + `bun test` first, then the hook, then the surface. Every task ends
green on `bun run test:unit` + `bun run lint` and states its **entry-chunk** perf delta against the
A4 ceiling of **186 KB gz** — note that unlike A4, most of A5 lands in the *entry* chunk
(`desktop-split`, `tile`, `session-row`, `ui-store` are all hero path), so "make it lazy" is not
available as an escape and the modules are sized accordingly.

---

### T1 — The renderer preference: 3 values, two scopes, one resolver

**Why first:** every other task reads it, and it is the only task that touches the server.

1. `renderer-pref.ts` (pure, no React, no imports beyond `./flag`):

```ts
/** What the USER chose. `auto` is a real, stored value — it must be
 *  distinguishable from "happens to equal the current default", because the
 *  default moves (Settings today, fase A7 for everyone). */
export type RendererPref = 'auto' | 'chat' | 'terminal'
/** What is actually MOUNTED. There is no `auto` here — a surface renders one
 *  thing. Keeping the two types distinct is what stops `auto` leaking into a
 *  `<RendererShell>` prop. */
export type Renderer = 'chat' | 'terminal'

export interface RendererState {
  /** Global default; only ever `chat` or `terminal` (never `auto` — the buck
   *  stops here). Default `chat`: with the experiment ON, chat is the primary
   *  interface (Global Constraints). */
  defaultRenderer: Renderer
  /** Per-session pins. A session at `auto` is ABSENT from the map, never
   *  stored as `'auto'` — so the map stays small and `auto` is the fixpoint. */
  overrides: Record<string, Renderer>
}

/** The ONE decision function. `null` = undecided: eligibility is not yet known
 *  (the sessions query has not resolved). Callers must render neither renderer
 *  for that frame — the focus-no-mobile-flash rule A1 established. */
export function resolveRenderer(
  st: RendererState,
  name: string,
  chatOn: boolean,          // flag.ts chatRendererOn(): setting AND kill-switch AND eligibility
  sessionKnown: boolean,
): Renderer | null

/** The pref a switch should render as selected (`auto` when unpinned). */
export function prefFor(st: RendererState, name: string): RendererPref
export function setPref(st: RendererState, name: string, p: RendererPref): RendererState
/** Drop pins for sessions that no longer exist, and hard-cap the map.
 *  Called on rehydrate and whenever the sessions list settles. */
export const MAX_PINS = 200
export function prune(st: RendererState, liveNames: readonly string[]): RendererState
```

Rules, each with its evidence in a comment:
- **`chatOn === false` ⇒ `'terminal'`, whatever the pin says.** A pin is a preference, not an
  override of eligibility; a codex session with a stale `chat` pin must not render a chat surface
  (`flag.ts` §0.3). The pin is *kept*, not deleted — flipping the Settings toggle back on restores
  the user's choice.
- **`sessionKnown === false` ⇒ `null`.** Byte-identical to A1's `current == null` branch; the
  terminal must never mount→attach→unmount on a focus load.
- `prune` runs against the **full** sessions list only (never a filtered/`hideStopped` view) — an
  archived-but-alive session must keep its pin.

2. `ui-store.ts`: `defaultRenderer: Renderer` (`'chat'`) and `rendererOverrides: Record<string,
   Renderer>` (`{}`), with `setDefaultRenderer` / `setRendererPref(name, pref)` /
   `pruneRendererOverrides(names)`. The existing `onRehydrateStorage` gains one line: a
   `MAX_PINS` cap so a rehydrated blob from a heavy user cannot be unbounded (the sessions-list
   prune runs later, once the query resolves).

3. **Cross-device**: `server/src/prefs.rs` — `is_known_pref_key` gains `"session_renderer"` (one
   arm; a Rust test asserts the key is accepted and an unknown key still 404s).
   `hooks/use-renderer-prefs-sync.ts` is cloned from `hooks/use-overview-layout.ts`: one query, one
   debounced mutation (**500 ms trailing** — a thrashing toggle must not become a PUT storm), the
   existing `prefs` SSE reconcile, 404-as-unset. The stored value is its own key, deliberately not
   folded into `overview_layout`: that blob is a whole-value PUT and last-write-wins across devices
   would clobber a renderer choice made on the phone (the §12.2 seen-cursor argument, applied here).
   Local wins on conflict for the session you are *looking at*; the SSE value wins otherwise —
   encoded as: the mutation is fire-and-forget, the SSE handler skips a name with an in-flight
   mutation.

**Tests** (`chat-renderer-pref.test.ts`, pure):

```ts
test('ineligible session resolves to terminal even when pinned to chat', () => {
  const st = setPref(EMPTY, 'codex-1', 'chat')
  expect(resolveRenderer(st, 'codex-1', /* chatOn */ false, true)).toBe('terminal')
  expect(prefFor(st, 'codex-1')).toBe('chat')     // the pin SURVIVES
})
test('unknown session resolves to null (no flash)', () =>
  expect(resolveRenderer(EMPTY, 'x', true, false)).toBeNull())
test('auto follows the global default, both ways', () => {
  expect(resolveRenderer({ defaultRenderer: 'terminal', overrides: {} }, 'a', true, true)).toBe('terminal')
  expect(resolveRenderer({ defaultRenderer: 'chat', overrides: {} }, 'a', true, true)).toBe('chat')
})
test('setting auto REMOVES the key rather than storing "auto"', () => {
  const st = setPref(setPref(EMPTY, 'a', 'chat'), 'a', 'auto')
  expect(Object.keys(st.overrides)).toEqual([])
})
test('prune drops dead sessions and caps at MAX_PINS', …)
test('prune never runs on a filtered list — a stopped session keeps its pin', …)
```

*DoD:* `cargo check` clean; a pin made in one tab appears in another within one SSE tick; the
decision table is a pure function with no React import.
**Perf: +0.7 KB gz entry.**

---

### T2 — The switch grows a third value

`renderer-switch.tsx` keeps everything A3 shipped — the 30px hairline capsule, the `bg-fill-soft-2`
thumb with the **per-instance `layoutId`** (A3's comment already anticipated this fase adding a
second mount; with T5 there can now be three on screen at once), `role="tablist"`,
`aria-selected`, `data-testid="renderer-chat|terminal"` (**load-bearing** — the A1 e2e clicks them;
the new cell is `data-testid="renderer-auto"`).

1. Props become `{ value: RendererPref; resolved: Renderer; onChange: (p: RendererPref) => void;
   variant?: 'full' | 'compact' }`.
2. **`full`** (desktop focus bar, overview display menu, tile context action): three cells
   `Auto · Chat · Terminal`.
3. **`compact`** (mobile floating chrome — the Grok trio has no room for three word-labels): two
   word cells plus a leading 30px **`A` cell**; the thumb rests on the *resolved* cell with a 1.5px
   accent underline when `value === 'auto'`, so "Auto, currently Chat" is one glance and not two
   controls. `aria-label` spells it out (`"Renderer: Auto (currently Chat)"`).
4. Reduced motion keeps the thumb and drops the travel — unchanged from A3.

**Tests** (`chat-renderer-switch.test.tsx`, `renderToStaticMarkup`): three cells in `full`, three in
`compact` with the `A` glyph; `aria-selected` is on the *pref* cell, not the resolved one; the
resolved-cell underline appears **only** at `auto`; the two A1 testids still exist (a grep-level
guard against renaming them).

*DoD:* `/dev/chat-ui` shows the tri control in both variants × both themes; the A1 e2e still passes
unedited.
**Perf: +0.4 KB gz entry.**

---

### T3 — `RendererShell`: mounted-but-hidden retention (the fase)

This is where the master plan's *"Terminal escape hatch rots"* risk is actually mitigated: the
hatch is exercised on **every toggle** because it never leaves the tree.

1. `retention.ts` (pure):

```ts
export interface Retention { name: string; chat: boolean; terminal: boolean }
/** Sticky-once-mounted, keyed by session. A renderer that has been shown once
 *  stays MOUNTED for the life of this session on this surface; a session change
 *  resets to nothing (a retained terminal points at the WRONG pty); `stopped`
 *  resets both (the pty is gone — <StoppedSession> owns the cell). */
export function retain(prev: Retention | null, next: {
  name: string; renderer: Renderer | null; stopped: boolean
}): Retention
```

2. `renderer-shell.tsx` — the two-cell shell. **The nine invariants, each of which is a test or a
   grep-checkable rule:**

   1. **One grid cell, two children.** `display:grid`; both panes `grid-area: 1 / 1` (the §11.6
      `.sm-swap` idiom `live-layer.tsx`'s `SwapCell` already uses). The hidden pane therefore keeps
      its **exact box size** — which is the whole mechanism: `use-live-term.ts:2131`'s
      `ResizeObserver` observes the container, and a container whose size never changes never fires,
      so a toggle emits **zero** `fit()` and **zero** `resize` frames.
   2. **Hidden means `visibility:hidden; opacity:0; pointer-events:none` — never `display:none`,
      never `hidden`, never unmount.** `display:none` collapses the box to 0×0, which fires the RO,
      which calls `f.fit()` on a zero-size container (`d2c333c`'s class of bug: FitAddon measuring
      against the wrong metrics and the grid reflowing on reveal). Grep rule: `renderer-shell.tsx`
      contains no `display:none`/`hidden` on the terminal pane.
   3. **`useLiveTerm` is not told anything.** No new prop, no `paused` flag, no manual
      `resize`/`resync` on toggle. The hook's WS, backoff, visibility resume health-check and
      keyboard-stable geometry all keep running exactly as they do in a visible terminal — which is
      the *point*: the hidden path is byte-identical to the visible one, so it cannot rot
      differently.
   4. **Focus never leaks into an invisible pty.** The hidden pane carries `inert` **and**
      `aria-hidden="true"`. On toggle → chat, the shell calls `blur()` on the terminal handle
      *before* revealing chat (an invisible xterm holding DOM focus is a silent keystroke sink — and
      on iOS a soft keyboard that will not go away). On toggle → terminal, the existing
      `wantFocusRef` one-shot focuses xterm exactly once. `desktop-split.tsx`'s auto-focus effect is
      gated on `resolved === 'terminal'` (today it fires unconditionally on mount).
   5. **First open still handshakes behind the crossfade.** A renderer mounts the first time it is
      selected, not before. First-ever Terminal tap therefore pays the auth→resize→seed handshake
      once, under the fade; every later toggle is free. (This is also the honest fix for the A1
      geometry cost documented at `desktop-split.tsx:686-697`: the first terminal attach sets real
      pty geometry, and retention means it is never undone.)
   6. **The crossfade is ≤180 ms, same-cell, zero layout shift**, from `lib/springs.ts` only
      (`eases`/`tweens` — no literal `cubic-bezier(` anywhere in the diff), with a
      `useReducedMotion()` twin that swaps instantly. Both panes are opacity-animated in the same
      cell; nothing is measured, nothing reflows.
   7. **Retention is focus-only.** Tiles, the hover peek and the quick-peek never retain — they are
      transient surfaces and the cap is real (`config.ws.subscribers_per_session`, enforced
      `ws/mod.rs:197,445`, 33rd closes 1013). Cost accounting: at most **+1** pty subscriber per
      *focused* session, and only after the user has toggled at least once.
   8. **Session change tears both down.** `<RendererShell key={name}>` — a retained terminal from
      session A must never be revealed under session B.
   9. **`stopped` beats everything.** `<StoppedSession>` owns the cell; both retained panes unmount
      (the pty is gone; a retained WS would reconnect-loop against a dead pane).

3. **Call site #1 — `desktop-split.tsx`.** The `chatActive ? <ChatPanel/> : <LiveTerminal/>` ternary
   becomes `<RendererShell chat={…} terminal={…} resolved={resolved} />`. `chatActive` stays as the
   name for "chat is the *visible* renderer" and keeps driving the dock/input-plane choice A4 built
   (`chatInput` vs `termInput`) — **the input plane follows what is visible, never what is
   mounted**, or a hidden terminal would start receiving snippets. `onOpenTerminal` (A4's refusal
   affordance, already wired to `setRenderer('terminal')`) now writes a *pin*, not a `useState` —
   which is the correct semantic: "I had to escape to the terminal" is a preference.

**Tests**

`chat-retention.test.ts` (pure): sticky within a session; reset on name change; reset on stopped;
`retain(null, {renderer: null})` mounts nothing (the undecided frame).

`chat-interactive.test.tsx` (extend, static render): both panes present in the DOM once both have
been selected; the hidden one carries `inert` + `aria-hidden`; the visible one carries neither;
no `display:none` in the rendered markup.

The behavioural proof is T6 — a static render cannot prove a WS did not reconnect.

*DoD:* on the dogfood instance, Terminal → Chat → Terminal shows the terminal's scrollback
**instantly**, with no "Connecting…" pill and no reflow; a permission answer started in chat and
toggled away from still completes its dismissal check.
**Perf: +1.1 KB gz entry.**

---

### T4 — Call site #2: mobile focus (the deferral A1 and A4 both wrote down)

A1's comment: *"desktop seam only (mobile follows in A5; the mobile seam is
routes/focus/mobile.tsx:490-515)"*. A4's §5: *"the mobile focus seam … → A5 with the 3-way switch
and mounted-but-hidden retention. A4 does convert that call site to `SessionInput` (T1), so A5 is a
prop change."* It very nearly is.

1. The `status === 'stopped' ? <StoppedSession/> : <LiveTerminal …/>` block inside `<MobileSheet>`
   becomes the same `<RendererShell>`. `MobileSheet`'s `visualViewport` keyboard math is untouched —
   the shell adds one `display:grid` box **inside** the existing flex child, so the sheet's height
   chain is unchanged (this is the `backdrop-filter`-containing-block class of hazard from §11.1, so
   T4 also asserts the shell sets **no** `backdrop-filter`, no `transform`, no `filter`, and no
   `contain` — anything that would make it a containing block for the `fixed` KeyBar/joystick).
2. **The mobile trio** (§5.2): back chevron · header pill · renderer switch (`compact`). The switch
   goes in the existing floating chrome row, not the dock.
3. **Dock repack.** A4 already routes the mobile text surfaces through `SessionInput`
   (`sendToTerm → input.insert`, snippets `onRun → input.submit`, keybar text chips). A5 flips
   `input` from `useTerminalInput(termRef)` to `composerSessionInput(name, restInput)` while chat is
   visible — the exact swap A4 made on desktop, six lines. **Hidden under chat: the raw-key
   joystick, the KeyBar's key chips, and Ctrl+G** (`keyToBytes` names with no `KEY_ALLOWLIST`
   equivalent — terminal-only by definition). **Kept under chat:** snippets, attach, dictation,
   mode, and the compose sheet, all of which are text and now land in the React composer.
4. **Keyboard ownership.** Today xterm is the single keyboard owner on mobile (`LIVE-TYPE`). Under
   chat the composer textarea is, and the hidden xterm must not steal it back — invariant 4 of T3
   plus one mobile-specific assertion borrowed from the memory rig: after a toggle to chat,
   `document.activeElement` is **not** `textarea.xterm-helper-textarea`.

**Tests:** `chat-renderer-switch.spec.ts` gains a mobile-viewport case (390×844) asserting the
compact switch renders, the chat panel mounts, the joystick/keybar key chips are gone and the
snippet button is not; a unit assertion that the shell's class list contains no
`backdrop-filter`/`transform`/`contain` utility.

*DoD:* on a phone (or the offline rig), a chat-eligible session opens in chat, one tap reaches the
terminal with its scrollback intact, the soft keyboard behaves on both sides, and no fixed chrome
has moved.
**Perf: +0.3 KB gz entry.**

---

### T5 — Overview: chat-tail tiles that honour the guard, and the per-tile override

Two things, both governed by **§2.5's zero-new-requests rule**: the only data source is the
`chat_tail` field already riding the `sessions` SSE delta. **No tile may open a chat subscription,
ever** — grep rule: `session-tile/**` contains no `useChatTail`, no `peekAnsi`, no `/chat` fetch.

1. `chat-tail-preview.tsx` — two lines in the tile's own type scale: the last prompt (P1 voice:
   ink-2, one line, ellipsis) over the last assistant/receipt line (P2 voice: ink-3), plus the
   relative time already ticking on the row. Renders inside the **same geometry slot**
   `geometryForTier(sizeTier)` gives `TailPreview`, so tile heights are untouched at every density.
   Empty-string fields are a real state (`ChatTail.user`/`agent` are `''` when the ring has not seen
   one yet) and render as a single line, never as a blank box.
2. **The choice, per surface** — `chatPreview = chat_tail != null && resolveRenderer(...) === 'chat'`:
   - `tile.tsx` **at-rest** preview → chat preview or `TailPreview`;
   - `session-row.tsx` (list density) → same;
   - `quick-peek-modal.tsx` → the chat lens when chat-resolved and the session is running, else the
     existing `LiveTerminal`/`TailPreview` path, byte-identical;
   - **the desktop hover/live peek (`LivePeekLayer` → `TileLiveTerminal`) stays the terminal,
     always.** A hover peek is an explicitly-terminal affordance (it is also the type-on-hover
     surface, A4 T1), and turning it into chat would cost a chat subscription per hovered tile. This
     is a decision, written here so it is not re-litigated as an oversight.
   - Ineligible sessions (codex, kimi, remote, team) keep the terminal preview at every density —
     the same one function, `resolveRenderer`, decides.
3. **Absent ≠ empty.** The SSE delta's `chat_tail` is merged key-by-key by `applyDelta`
   (`hooks/use-sessions.ts:51`), so a delta without the key leaves the previous value in place. The
   renderer must therefore treat `undefined` as "keep showing the terminal preview" and never as
   "the conversation is empty".
4. **The override entry points** (§5.2 *"overview display menu (global default) + per-tile context
   action (override)"*): `overview-display-menu.tsx` gains a **Default renderer** row
   (`Chat | Terminal`, writing `defaultRenderer`); the tile/row context menu gains a **Renderer**
   submenu (`Auto | Chat | Terminal`, writing the pin). Both are hidden entirely for ineligible
   sessions, and the whole block is hidden while the experiment flag is off — no dead controls.
5. **Not in A5:** unread dots, attention tiers, the rollup facepile, marks-on-tiles, the fact-ladder
   (all **B2**, §12.2). A5 changes *what the preview says*, not the row's information architecture.

**Tests** (`chat-tail-preview.test.tsx`, static):

```ts
test('no chat_tail → the terminal preview renders, unchanged', …)
test('chat_tail + chat-resolved → two lines, no ANSI spans', …)
test('chat_tail present but session pinned to terminal → terminal preview', …)
test('chat_tail present but session ineligible (codex) → terminal preview', …)
test('empty agent line renders one line, never a blank slot', …)
test('the preview never grows the tile: rendered height at every tier equals TailPreview\'s', …)
```

*DoD:* on the dogfood instance the overview shows conversation one-liners for Claude sessions and
raw ANSI for everything else, with **no new network requests** (proved by an empty DevTools filter
for `/chat` while the overview is open).
**Perf: +0.9 KB gz entry** (tile + row are hero path; the component is text and two `<p>`s).

---

### T6 — The toggle-thrash harness (the test §6.2 asks for, spelled out)

Four properties, two harnesses, because they need different things:

**(A) `web/tests/e2e/smoke/chat-toggle-thrash.spec.ts` — byte-exactness, on a `shell` session.**
The renderer under test is the *terminal*; the chat side only has to occupy the other cell. A shell
session gives a **deterministic firehose** that a real Claude pty cannot, and it does not depend on
the `claude` CLI being on the runner (so this spec never skips).

- A DEV-only route `web/src/routes/dev-renderer-thrash.tsx` (`import.meta.env.DEV`, the existing
  `App.tsx` lazy pattern used by `/dev/focus`, `/dev/term`) mounts the **real `RendererShell`** with
  the **real `LiveTerminal`** in one cell and a cheap `<div>` stand-in in the other, and exposes
  `window.__thrash = { toggle(), renderer, serializeBuffer(), wsStats }`. It is not a product
  surface and never ships (asserted in T8: `dist/assets` contains no `dev-renderer-thrash`).
- `page.addInitScript` patches `window.WebSocket` **before app boot**: counts constructions and
  closes per URL, and records every frame whose body contains `"type":"resize"`.
- The spec: boot the real binary (`harness.ts`), create + start a `shell` session, navigate,
  `POST /api/sessions/{n}/send` a monotonic firehose
  (`for i in $(seq 1 20000); do echo "SMX$i"; done`), and while it runs call
  `window.__thrash.toggle()` **100 times**, each awaited across a `requestAnimationFrame` so React
  actually commits the hide/reveal.
- Assertions, one per §6.2 clause:
  1. **No byte gap / overlap** — serialize the xterm buffer and extract every `SMX<n>`; the sequence
     is strictly consecutive with no repeats. (Gaps = bytes lost while hidden; repeats = a re-seed,
     i.e. a reconnect.)
  2. **No WS leak** — pty-URL constructions ≤ 2 for the whole run (initial + at most one
     reconnect), and `opened - closed <= 1` at the end. Crucially: **constructions do not grow with
     the toggle count** — the assertion is a constant, not a ratio.
  3. **No resize storm** — **zero** `resize` frames sent during the thrash window (the container
      never changes size; invariant T3.1). A container resize *outside* the window may send one, so
      the window is bounded explicitly.
  4. **No fit churn** — `t.cols`/`t.rows` read via the exposed handle are identical before and after
     the 100 toggles.

**(B) `chat-renderer-switch.spec.ts` (extended) — the real focus surface, on a `claude` session**
(skipped without the CLI, exactly as its three existing cases are):
  5. **Chat state survives** — scroll the transcript up, toggle away and back 20×, assert
     `scrollTop` is preserved and the panel mounted **once** (a `data-mount-id` stamped with a
     module counter at mount; unchanged across toggles). This is the assertion that fails today.
  6. **Persistence** — pin Terminal, reload the page, land on Terminal; pin Auto, reload, land on
     the default; navigate away and back within the SPA, the pin holds (it is no longer
     `React.useState`).
  7. **Ineligibility still wins** — a `shell` session with a stale `chat` pin in `localStorage`
     renders the terminal and shows no switch.

**Tests:** the two specs above; plus `chat-renderer-hotkey.test.ts` and `chat-retention.test.ts`
from T3/T7 as the unit-level net.

*DoD:* `bun run test:e2e:smoke` green with the two new/extended specs, output pasted in the PR body.
The thrash spec must **fail** if invariant T3.2 is violated — prove it by flipping
`visibility:hidden` to `display:none` locally once and pasting the failure.
**Perf: 0 KB** (DEV-gated route + tests).

---

### T7 — The `T` hotkey, with the focus-safety matrix

`use-keyboard-capture.ts` today returns early unless Cmd/Ctrl is held — *"EVERY other key flows
through to xterm"*. A5 adds exactly **one** plain-key branch, and it is a refusal ladder:

1. `renderer-hotkey.ts` (pure, no DOM import — takes an event-like):

```ts
export interface HotkeyCtx {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean
  isComposing: boolean; keyCode: number
  /** tagName / contentEditable / role of the event target. */
  target: { tag: string; editable: boolean; role: string | null }
  /** Is the active element inside an open [role=dialog] / sheet / popover? */
  inOverlay: boolean
  /** Does xterm's helper textarea currently hold focus? */
  terminalFocused: boolean
  /** Is the chat renderer even possible here? (flag.ts) */
  eligible: boolean
}
export function shouldToggleRenderer(c: HotkeyCtx): boolean
```

Refusals, in order — **the first six all mean "do not `preventDefault`", so the key reaches whoever
wanted it**:
- any modifier (`⌘T`/`Ctrl+T` is *new browser tab* — capturing it would be hostile; `Alt`/`Shift`
  combos belong to the terminal);
- `isComposing || keyCode === 229` — the IME path the repo already handles in `lib/android-ime.ts`;
- the target is editable: `INPUT`, `TEXTAREA`, `[contenteditable]`, or `role="textbox"` — **this is
  the composer rule**: a `T` typed into the chat composer is the letter T and nothing else;
- the active element is inside an overlay (`[role=dialog]`, sheet, popover) — a `T` in the entity
  picker's filter is a filter keystroke;
- **xterm holds focus** — a `T` at a pty is a byte for the pty. Consequence, stated honestly in the
  UI: from a focused terminal you leave with the switch or by clicking out first; the existing
  *"Capturing input"* pill (`TerminalCaptureIndicator`) is already the signal that keys are going to
  the pty, so the rule is legible rather than mysterious;
- `!eligible` — no toggle exists, so no key is swallowed.

Only when all six pass: `preventDefault()` and toggle **between the two concrete renderers**
(`chat ↔ terminal`), writing a pin. `T` never selects `auto` — a hotkey should do one obvious
thing; `auto` is reachable from the switch and the menus.

2. Wiring: `useKeyboardCapture` gains an optional `onToggleRenderer` handler and the guard;
   `desktop-split.tsx` and `focus/mobile.tsx` (hardware-keyboard case) pass it.

**Tests** (`chat-renderer-hotkey.test.ts`, pure — a matrix, one row per refusal):

```ts
test('plain t on the pane toggles', …)
test('⌘T / Ctrl+T never toggles (new tab must survive)', …)
test('t in the composer never toggles', () =>
  expect(shouldToggleRenderer(ctx({ target: { tag: 'TEXTAREA', editable: true, role: null } }))).toBe(false))
test('t while composing (IME / keyCode 229) never toggles', …)
test('t while xterm has focus never toggles', …)
test('t inside an open dialog never toggles', …)
test('t on an ineligible session never toggles', …)
test('shift+T does not toggle', …)
```

*DoD:* typing `the terminal is faster` into the composer does not flip the renderer nine times.
**Perf: +0.3 KB gz entry.**

---

### T8 — Bench states + the VR pass (offline rig, both themes)

The bench is how the boards are held to account (A3/A4 rule), and A5's surfaces are exactly the ones
a screenshot catches lying: a crossfade with a layout shift, a tile whose height moved, a compact
switch that clips.

1. `/dev/chat-live` gains **`toggle-mid`** — the shell at 50 % crossfade (both panes at opacity .5
   in one cell) — the state that proves zero layout shift, plus **`switch-tri`** (the control in all
   three values × both variants). `/dev/tiles` gains a `chat-tail` cast (a chat-eligible tile with a
   tail, an eligible tile *without* one, a codex tile, a terminal-pinned tile) so the guard is
   visible in one frame. `dev-chat-live-fixture.test.ts` / `dev-tiles` fixture tests grow one
   assertion per new id.
2. **The rig** (memory: *Offline mobile UI review rig*): worktree Vite on `--port 5199`, Playwright
   headless chromium with
   `LD_LIBRARY_PATH=/home/supermux/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu:/home/supermux/.local/chromelibs/extract/lib/x86_64-linux-gnu`
   and `args:['--no-sandbox','--no-zygote','--disable-gpu']`, **DPR = 1**, theme forced by toggling
   `document.documentElement.classList` (the app reads `.dark`/`.light` off `<html>`, not
   `prefers-color-scheme`).
3. **The matrix**: `{desktop-focus-chat, desktop-focus-terminal, toggle-mid, mobile-focus-chat,
   mobile-focus-terminal, switch-tri, overview-tiles, overview-list, quick-peek-chat}` ×
   `{light, dark}` × `{desktop 1280×800, phone 390×844}` — screenshots into the session scratchpad,
   reviewed by subagents against the A3 boards. **Diff gate:** the desktop-focus-terminal shot at
   both themes must be pixel-identical to the same shot taken with the A5 branch's parent (the
   terminal surface is not allowed to change appearance in this fase).
4. Touch-safety check from the same memory: after tapping the compact switch,
   `document.activeElement` is **not** `textarea.xterm-helper-textarea`.

*DoD:* the matrix exists as PNGs, the parent-vs-A5 terminal diff is empty, and the crossfade frame
shows no bounding-box change between the two panes.
**Perf: 0 KB.**

---

### T9 — Verification, budget, regression net

In this order, real output pasted into the PR body (no claim without evidence — memory:
*verification-before-completion*):

```
cd /opt/projects/supermux-a5/web
bun run lint
bun run test:unit          # B0 + A1 + A2 + A3 + A4 + the five new files, all green
bun run build:perf         # entry budget
cd /opt/projects/supermux-a5 && cargo check          # prefs.rs (debug only — never --release)
cargo test prefs                                     # the allowlist test
cd server && cargo build && cd ../web && bun run test:e2e:smoke   # incl. chat-toggle-thrash
```

**Budget rule for A5: app JS ≤ 190 KB gz** (hard cap 200; A4 ceiling 186). The per-task deltas sum
to **+3.7 KB**, and — unlike A4 — nearly all of it is **entry**, because `desktop-split.tsx`,
`tile.tsx`, `session-row.tsx` and `ui-store.ts` are hero path. "Make it lazy" is therefore not
available as an escape hatch, which is why every A5 module is pure arithmetic + text:
`renderer-pref`, `retention` and `renderer-hotkey` have no React import at all, and
`renderer-shell.tsx` is a `div` with a grid. `chat-panel` stays behind the existing
`React.lazy` boundary — **`RendererShell` must not statically import it** (grep rule: the shell
takes both panes as `ReactNode` props and imports neither renderer).

Then the dogfood pass on a **side-by-side instance on another port** (memory: *Never restart this
instance unasked*): one real session driven for a working session with `T` as the primary
navigation between the two views; deliberately toggle mid-turn, mid-permission-dialog and
mid-firehose; leave the overview open for an hour and confirm the tiles read as conversations.

---

### T10 — PR

One PR, `feat/a5-toggle-overview` → `feat/a4-interactivity` (keep the stack; the owner merges
B0 → A3 → A4 first — memory: *User reviews all merges*, main is branch-protected). Body: the A2
merge SHA and why (§0.4), the VR matrix (both themes × both surfaces), the perf table with
before/after gz, full test output including the thrash spec's counters, the **deliberately-failed**
`display:none` run proving the thrash test bites, and an explicit **"what persists where"** table
(localStorage `supermux-ui` vs `/api/prefs/session_renderer` vs nothing). Hand off; never
self-merge.

---

## 3. Constraints, restated as checkable rules

| rule | how it is checked |
|---|---|
| no new deps | `git diff web/package.json` is empty |
| perf budget | `bun run build:perf` ≤ 190 KB gz app JS; every task states its delta |
| `use-live-term.ts` is untouched | it does not appear in `git diff --stat` |
| the hidden pane is never `display:none` | `grep -n "display:none\|hidden=" renderer-shell.tsx` is empty; the T6 spec fails if it is violated |
| the shell creates no containing block | `grep -nE "backdrop-filter|transform|filter:|contain:" renderer-shell.tsx` is empty (§11.1 mobile-chrome hazard) |
| retention is focus-only | `grep -rn "RendererShell" web/src` shows exactly two call sites |
| no per-tile chat subscription | `grep -rn "useChatTail\|peekAnsi\|/chat" web/src/components/session-tile` is empty |
| the shell stays lazy-boundary-safe | `RendererShell` imports neither `chat-panel` nor `live-terminal`; `dist/assets` still shows a separate chat chunk |
| one decision function | `grep -rn "chatEligible(\|chatRendererOn(" web/src` shows call sites only inside `flag.ts`/`use-chat-renderer.ts`/`renderer-pref.ts` |
| `auto` is never stored | `setPref(…, 'auto')` deletes the key (unit test); no `'auto'` string in a persisted blob |
| the pref map is bounded | `MAX_PINS` cap + prune, unit-tested |
| the hotkey never eats a keystroke it does not use | the T7 matrix + `preventDefault` called only on the toggle branch |
| motion only from `springs.ts` | grep the diff for `cubic-bezier(` / `transition: all` |
| reduced-motion twin per motion | `useReducedMotion()` beside each `motion.*` |
| no colour literals | new files contain no `#rrggbb` (B0 tokens only) |
| A1 e2e testids survive | `renderer-chat` / `renderer-terminal` still present; `chat-renderer-switch.spec.ts`'s three original cases unedited |
| prior tests are the net | every `chat-*.test.*` from A1/A3/A4 untouched and green |
| server change is additive | `prefs.rs` diff is one match arm + one test; `server/migrations/*` untouched |

---

## 4. Risks

1. **The retained terminal is a silent keystroke sink.** The single worst failure mode: an invisible
   xterm holding DOM focus swallows what the user typed for the chat composer — and on iOS keeps the
   soft keyboard up. Mitigation is layered: `inert` + `aria-hidden` on the hidden pane, an explicit
   `blur()` on toggle-to-chat, the auto-focus effect gated on the resolved renderer, and the rig's
   `activeElement !== textarea.xterm-helper-textarea` assertion on both surfaces. **This is the
   riskiest thing in the fase** — see the summary.
2. **A hidden container fools FitAddon.** If anything ever collapses the hidden pane's box (a parent
   flex rule, a future `display:none` "optimisation"), the RO fires at 0×0 and the terminal reflows
   on reveal — the `d2c333c` class. Mitigation: one grid cell for both panes, a grep rule, and a
   thrash assertion that `cols`/`rows` are unchanged after 100 toggles.
3. **Subscriber-cap pressure.** Retention adds at most +1 pty subscriber per focused session, but a
   user with many tabs open on the same session now doubles faster against
   `config.ws.subscribers_per_session` (33rd → close 1013). Mitigation: focus-only retention,
   the count asserted in T6, and the existing 1013 path already degrades visibly rather than
   silently.
4. **The A2 base.** Merging a sibling branch at the branch point is the plan's one structural bet
   (§0.4). Mitigation: the tile renderer is written to be correct on **both** bases (chat tail iff
   the field is present), unit-tested that way, so a merge that has to be dropped costs a quiet
   feature, not a broken build.
5. **Prefs sync fights itself across devices.** Two devices toggling the same session produce
   competing PUTs. Mitigation: its own key (never the `overview_layout` blob), a 500 ms trailing
   debounce, and last-write-wins scoped to a single session's pin — the blast radius of losing that
   race is one wrong renderer on one session, recoverable with one tap.
6. **`T` collides with muscle memory.** Some users type in the terminal constantly; a stolen `T`
   would be intolerable. Mitigation: the six-refusal ladder, with "xterm has focus" as an absolute —
   and the honest consequence written into the plan rather than discovered.
7. **Tile churn / render cost on the overview.** `chat_tail` rides a change-gated, 1 s-debounced
   delta (`ChatTailGate`) into a key-by-key merge, so a chatty session cannot re-render the grid
   faster than the terminal preview already does. Watch it in the dogfood hour; if it bites, the fix
   is in the gate (server), not in the tile.
8. **Scope leak into B2.** The overview is B2's territory (marks, attention tiers, `<SessionIdentityRow>`,
   the fact ladder). A5 touches exactly one thing there — *what the preview line says* — and the
   plan lists the rest as out of scope so a reviewer can hold the diff to it.
9. **Stacked-branch churn.** B0/A3/A4 may take review edits. Rebase `feat/a5-toggle-overview` on
   `feat/a4-interactivity`; never merge `main` into it. Others build in this repo on rotating
   branches (memory: *Concurrent agents in repo*) — stay in the worktree, do not commit on `main`.

---

## 5. Explicitly deferred (and to where)

- **The switch moving into the header pill's fixed 44px slot** (§5.2/§11.7) → **B1**, with the
  header grammar and the `--sm-toolbar-min-h` floors. A5 keeps A1's `h-8` bar; a chrome
  re-architecture inside a retention fase would make the thrash test's failures ambiguous.
- **Unread / attention tiers / the roster rollup / marks on tiles / the fact-ladder** → **B2**
  (§12.2), which explicitly *"shares the `chat_tail` delta"* with A5.
- **The changes rail** (§5.6.1, side pane) → deferred *to* A5 by A4 §5, and deferred *out* again
  here: it needs the §11.3 side-pane component, which is **B1**. A5 is the toggle fase; adding a
  third pane to a two-pane retention shell is how retention bugs get hidden.
- **Quick-peek → `ResponsiveSheet`** (§16.1) → **B5**. A5 changes what the peek *shows*, not what
  it *is*.
- **Cross-device seen-cursors / `PATCH /sessions/{name}/seen`** → B5; A5 syncs only the renderer
  pref.
- **The default flip** (chat for everyone, flag removal) → **A7**, a separate small PR. A5 ships
  with `chatRenderer` still default-OFF; `defaultRenderer: 'chat'` only takes effect once the
  experiment is on, which is exactly the two-commit discipline the PR #27 pattern requires.
- **A `chat_tail` for non-Claude providers** (codex/kimi transcript parsers exist; the status
  overlay is the gap) → out of Track A v1 by the Global Constraints guard.
