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

# Fase B2 — Roster evolution + Board removal

## ADDENDUM — execution-time re-audit (2026-08-16, branch `feat/b2-roster` off `origin/main` = `ef19402`)

**The stack is gone.** B1 merged as #69 (`ef19402`); #70 (`d9eca32`, perf gate) landed under it;
A5 is *not* on main (no `feat/a5-toggle-overview` merge; `session_renderer` is absent from
`prefs.rs`). So the worktree is **plain `origin/main`**, no rebase chain, and the plan's
"if B1 has not merged" branches in T3/T6/T10 are **dead** — B1's `ShellOverlay`, `ResponsiveSheet`
and header grammar are real and consumable. The **A5-SEAM** branch is **live**: the tile preview
slot stays as-is and B2's rows leave the preview empty rather than faking it.

| §0 row re-checked | still true at `ef19402`? | drift |
|---|---|---|
| NAV array, board entry deleted **by `to`** | **yes**, and nav is 5 | moved `layout.tsx:54` → **`:61`**; the array is `:53-77`; `SquareKanban` import at `:7`; B1 left a comment at `:68-69` that literally says *"Nav is at FIVE items after B1; Board leaves in B2, gated on the issue read surface"* — delete that comment with the entry |
| overview header forks into 4 desktop chips vs mobile `OverviewDisplayMenu` | **yes** | moved `overview.tsx:548-574` → **`:589-628`**; B1 added an `.sm-swap` wrapper around `OverviewSizeControl` (T9 must preserve it or the density control moves layout again) and a scroll-faded `<h1>Overview</h1>` above the header |
| `RosterRow` unmounted, 148 lines, `attentionDotSeat` present | **yes, byte-identical** | none |
| mark engine (`brand/marks/*`), `assignRoster:494`, `MarkPin:193` | **yes** | none — B1 did not touch `brand/marks` |
| `StatusDot` on tile `:940`, `session-row.tsx:65`, `compact-tile.tsx:109,152` | **yes** | none |
| `overview-layout.ts` localStorage group sort (`:291 smartSort`, `:371/384/399/412`) | **yes** | none |
| `group-grid.tsx:259 useGroupSortModes`, `:1962 TileMoveToKebab` | **yes** | none |
| command palette board verbs `:359/367/375/383`, `IssueRow:128`, `matchesIssue:225` | **yes** | none |
| highest migration `0024_session_runtime.sql` | **yes at branch time** | **verify again at land-time** — a parallel "fabric spine" branch may take 0025/0026. Take the next FREE number; never edit an existing migration |
| perf budgets | **CHANGED by #70** | `size-budget.mjs` now gates **three** numbers: `BUDGET_ENTRY_JS = 160 KB` (new hero-path gate, `:26`), `BUDGET_APP_JS = 232 KB` (**temporary**, `:33`) and `BUDGET_CSS = 30 KB`. #70's own comment requires **B2's board removal to ratchet 232 → 200 in the same PR as T11.** That ratchet is a B2 obligation, not an option |
| B1 shipped `tour-anchors.test.ts` | **yes** (`tests/unit/tour-anchors.test.ts`, source-scan idiom) | T11 does **not** need to write it — only keep it green |
| `ShellOverlay` has a `variant` prop | **yes** — `'frame' \| 'pane'` (`shell/shell-overlay.tsx:42-45`) | T10 hosts the issue surface in `variant="pane"` |
| BRAND.md sections | B1 added **§6d "The shell"** (`:277-362`) | B2's fact-ladder + attention vocabulary append after §6d, not into §6c |
| "~90 board hits in web/src" | **understated**: 1421 raw `board\|Board` hits across 123 files (`keyboard`/`dashboard`/`onboarding` dominate) | the T11 verdict table is per **file**, not per raw hit, or it is unreadable |

**MID-EXECUTION (after T7): `origin/main` moved again.** #71 (`c1e7053`, the
fabric/delegation spine — it took migration **`0026_audit_target_idx`**, leaving
`0025` unused on main) and **#72 (`c854937`, fase A5)** landed. The branch was
rebased onto `c854937` at the T7/T8 boundary; three conflicts, all mechanical
(`tile.tsx`'s new `isTeamLead` prop next to B2's `attention`; `group-grid.tsx`'s
A5 renderer-pin block and lucide imports next to B2's kebab items). Consequences:
**A5 is merged**, so the A5-SEAM is closed — the list row now renders the
session's own `chat_tail` line at the ladder's tier 2 instead of leaving the slot
empty. And the **migration number is `0027_session_mark_pin.sql`, not 0025**:
0025 is unused on main but claimed by two different unmerged branches
(`feat/grok-ui-integration`'s `0025_session_notif`,
`feat/schedule-archive-on-stop`'s `0025_archive_on_stop`), and filling a gap
BELOW an already-applied version is exactly the shape that makes a deployed
install's migration state ambiguous. `db/mod.rs`'s applied-count assertion goes
24 → 25.

**Program obligations added on top of the plan (from the dispatch):** the migration number is
verified at land-time (not assumed 0025); `BUDGET_APP_JS` ratchets in the T11 commit; T11's
three-leg gate is executable and B2 ships without T11 if a leg fails; the keeplist test is
non-negotiable; kill switches are `supermux:attention` and `supermux:roster-marks`.

---

**Worktree** `/opt/projects/supermux-b2` · **branch** `feat/b2-roster`, stacked on `feat/b1-shell`
(→ `feat/a5-toggle-overview` → `feat/a4-interactivity` → `feat/a3-chat-surface` →
`feat/b0-design-system`). If the owner has merged any of those into `main` by execution time,
rebase and drop the corresponding parent.
**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` §10 (identity system),
§12 (overview → roster), §12.6b (sort/grouping debt), §12.8 (navigation slimming / board removal),
§17 (the B2 row), §18 rows *"Board removal orphans live writers"* / *"Roster attention tiers
false-positive"*. It lives on the unmerged branch `docs/grok-ui-plan`; read it with
`git show docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`.
**Predecessor plans** `2026-08-16-fase-a5-toggle-overview.md` (owns the tile *preview slot* and the
renderer preference — B2 re-decides neither) and `2026-08-16-fase-b1-shell.md` (owns `ShellOverlay`,
the header grammar, the `NAV` array and the onboarding-tour retarget).

> One sentence of scope: **B2 makes the overview a roster of identified colleagues and closes the
> Board page** — one presentational row at three densities, marks on every session surface, a
> three-tier attention model that works for *every* provider, the phantom `pinned`/`tags`/`desc`
> fields finally reachable, the per-group sort debt paid to the server, and `/board` deleted in the
> same PR that gives its issues a home inside session detail.

---

## 0. Ground truth — what actually exists at `origin/main` (`ea642df`: A2–A4 + #66/#67/#68 + B0)

> **Read this first: `git fetch && git rebase` before you audit anything.** The main checkout at
> `/opt/projects/supermux` was **two commits behind** when this plan was written (`e10c2f2` = #66;
> `origin/main` = `ea642df` = #67 on top of `22f5d1b` = #68). Line numbers below are against
> `origin/main` where the two revisions differ, and the differences are load-bearing: #67 deleted
> `components/chat/use-chat-tail.ts` and added `chat-socket.ts` / `wire.ts` / `wire-entries.ts` /
> `use-chat-ws.ts`; #68 changed the server-side eligibility guard to
> `provider=="claude" && host_id.is_none() && !team_name.is_some_and(teams::scan::real_team)`
> because CC ≥ 2.1.178 writes an implicit solo team for every plain session (memory:
> *native-runtime-default-state* — `team_name` is polluted).

Everything below was read from the tree, not from the master plan. Of the twenty assumptions checked,
**nineteen are wrong or materially incomplete** (only the `pinned`/`tags`/`desc` row confirms), and
**five change the task list**: T2 exists at all (marks are derived and nothing dedupes), T3 is a first
mount rather than a swap (and there is no fact ladder to extend), T5 inverts its data source
(`chat_tail` is not roster-wide), T9 must *build* the desktop prefs surface, and T10's real work is a
component extraction.

### 0.1 Audit table — master plan vs. reality

| B2 entry / §10 / §12 assumes | reality at `origin/main` | consequence for B2 |
|---|---|---|
| B2 creates a new presentational **`<SessionIdentityRow>`** | **It already exists**, shipped by B0 as `web/src/components/chat/ui/roster-row.tsx` (`RosterRow`): h64 · gap 12 · pad 0/8 · r12 · mark 40 · name 14/500 −0.15px · right-pinned tabular time · 13px preview at +3px · `sm-accent-row` selection · **an `attention` dot already seated on the silhouette's shoulder** (`attentionDotSeat`) · a `crew` facepile variant for teams. Documented in `web/src/brand/BRAND.md` §6c | B2 **does not create a component**. T3 adds a `density` prop + thin interaction wrappers and re-points `session-row.tsx` / `compact-tile.tsx` at it. **Do not rename it** — the alias is recorded here and in the PR body so the master plan's name resolves |
| marks are **persisted** — `mark_shape`/`mark_hue`/`mark_detail` columns, migration `0025`, "assigned at create, deduped once, then frozen" | **Nothing is stored.** Zero hits for `mark_shape\|mark_hue\|mark_detail` in `server/`, `web/` or `migrations/`; the highest migration is `0024_session_runtime.sql`. B0 shipped a *derived* engine: `characterFromSeed()` (9 silhouettes × 7 pigments = 63 tokens) and `assignRoster(seeds)` (`web/src/brand/marks/character.ts:494`) which probes each name's own hash for the cheapest free token. `MarkPin` = `{silhouette?, hue?, gaze?, tilt?}` (`character.ts:193`). BRAND.md §6b states the intent: *"nothing is stored … Deterministic — the server can mirror it and freeze it"* | **T2 is a task the B2 entry does not name.** `assignRoster` is consumed **only** by `routes/dev-marks.cast.ts:157` and its unit tests — *no real surface dedupes*, and **no roster surface renders a mark at all** (every live `SessionMark` consumer is in `components/chat/`). T2 introduces one roster-wide pin provider; persistence shrinks to **one nullable override column** written only by the reroll affordance (T8) |
| unread rides **`entry_count` on the `chat_tail` SSE delta** | `chat_tail` shipped (A2): `ChatTail {user, agent, ts}` (`server/src/sessions/chat/store.rs:67`), gated by `ChatTailGate` (change + 1 s debounce, `sessions/auto_actions.rs:76`, `:858-908`). **But the store's lifetime is "while a chat client is attached, plus the tailer's grace period"** (`state.rs:368-382`, `drop_chat_store`), and the SSE consumer deliberately uses the **non-creating** `chat_store()` accessor so it *"must not spin up a store for a session nobody is watching"*. `ApiSession.chat_tail` says so on the wire (`web/src/lib/api/sessions.ts:126-131`). No `entry_count`, no `last_entry_ts` | **The single biggest correction.** A roster shows the sessions nobody has open — exactly the ones with no store and therefore no `chat_tail`. Unread **cannot** be built on it. T5 inverts the master plan's priority: the *provider-neutral* signal is **primary** (`activity_at`, server-clock ms on every activity delta, `hooks.rs:477`; then `last_activity`, then `updated_at`), and `entry_count`/`last_entry_ts` are an *opportunistic refinement* that turns a dot into a number when a store happens to exist |
| `seq` / `high_water` can serve as the unread counter | `ChatStore::next_seq` starts at 0 on **every** store creation, and stores are created and dropped many times a day per session | a seq cursor silently under-counts after each drop. T5's counter is `{epoch, count}`; a changed epoch or a *decreasing* count degrades the row to dot-only rather than showing a wrong number |
| tiles get "**mark + status ring** replaces the bare status dot" (§12.5) | **Contradicts a B0 contract.** BRAND.md §6b contract **C5**: *"The silhouette never moves and is never overpainted, ringed or notched"* — state lives in the eyes only, and `session-mark.test.tsx` asserts six distinct eye paths under `prefers-reduced-motion` | T4 resolves it in B0's favour: **the eye-state *is* the status channel**; the only glyph on top is the existing 7px attention dot. `status-dot.tsx` survives for mark-less surfaces; the decision is recorded in the fact ladder + BRAND.md |
| the roster row's fact set is a density question | **there is no fact ladder at all.** `web/src/lib/overview-size.ts` tiers 1–4 are **purely spatial** (`idleLines`, `livePreviewPx`, `gridColsLg/Md`, `tileMinPx`, `containerMaxRem`); every tile shows the same facts at every tier, gated by *content* conditions instead (`tile.tsx:812-980`). `SessionRow` shows a strictly smaller hand-picked set (dot, title, status label, branch, ⌘N, host badge, needs-input pill, relative time — **no** tokens, **no** preview, **no** archive). **Context % does not exist anywhere in the app** | T3's `fact-ladder.ts` is genuinely new information architecture, not a refactor. It must reconcile *two* divergent sets, and it must not silently promise `contextPct` — the statusline tap (A2) feeds the chat header only; roster context% is listed as deferred |
| `pinned` / `tags` / `desc` are "wired end-to-end server-side with zero controls" | **Confirmed, precisely.** `SessionView.desc/pinned/tags` (`server/src/sessions/mod.rs:179-183`), `ConfigInput.toggle_pin/tags/desc` (`:828`), `PATCH /api/sessions/{name}/config` (`:76`). Client: `ApiSession.desc/tags/pinned` (`sessions.ts:154-158`), `SessionConfigPatch` (`:337`). **No component writes any of them**; `pinned` is read only by `smartSort` (`overview-layout.ts:293`) and `focus-mode/session-order.ts:27-34`; `desc`/`tags` only by the overview's `matches()` (`overview.tsx:96-97`). The only `config` writer in the UI is rename | T7 stands as written, and gets a rename affordance for free |
| per-group sort "moves from localStorage to the server pref" | localStorage is **deliberate and documented**: `overview-layout.ts:25-33` records a research finding (*"most M&A research consistently flags cross-device group sort as low-value … revisit only if the user explicitly asks"*), key `supermux:overview:group-sort:<groupId>` (`:370`), read/write/remove at `:384/:399/:412`. The focus strip has its own **4-mode** subset (`focus-strip-section.tsx:46 STRIP_PER_GROUP_SORT_MODES`) | T9 still moves it — the owner *is* the user asking — but **into the existing `overview_layout` blob**, not a new pref key, and the module doc gets rewritten so the reversal is legible. The strip's 4-mode subset must keep working against the same store |
| the prefs allowlist is "`prefs.rs:60-64`" | it is `is_known_pref_key` (`server/src/prefs.rs:60-72`), matching exactly `"overview_layout" \| "quick_keys" \| db::prefs::AUTO_HEAL_PREF_KEY` (+ `"session_renderer"` once A5 lands). Adding a key needs **four** edits (server allowlist, a key constant + parse/serialize, a hook cloned from `use-overview-layout.ts`, and a dispatch branch in `hooks/use-sessions.ts:200-212` so peer tabs reconcile) | T9 adds **no key** — the group sort rides `overview_layout`, so none of those four edits happen |
| there is "one canonical prefs surface (the display menu)" to consolidate into | `OverviewDisplayMenu` (`session-tile/overview-display-menu.tsx:51`) is **mobile-only** (forked at `overview.tsx:548` on `useMediaQuery('(max-width:767px)')`) and carries View / Sort / Size / Hide-stopped. Desktop uses four *separate* chips in `overview.tsx:560-574` (`ViewToggle`, `SortControl`, `OverviewSizeControl`, `HideStoppedChip`) | T9's "one surface" means **building** the desktop half, not just adding options to an existing menu. Budget accordingly |
| nav slims to four items in B2 | B1 removes `/scheduler` and leaves nav at **5** (`layout.tsx:46-61`; `{ to:'/board', label:'Board', icon: SquareKanban }` at `:54`). The array feeds **both** the desktop rail (`SideNav`, `:86-97`) and the mobile tab bar (`BottomNav`, `:164-171`) — one deletion, two surfaces | B2's removal takes nav to **4**. T11 deletes by `to === '/board'`, never by index |
| the onboarding tour has board steps to retarget | **It does not.** `STEP_TARGETS` (`onboarding/tour-overlay.tsx:32-37`) is `[data-tour="tile"]`, `[data-tour="tile"]`, `[data-tour="scheduler"]`, `[data-tour="new-session"]`; copy at `brand/copy.ts:202-218`. No board anchor anywhere in `onboarding/` | **Nothing to retarget in B2.** T11 still runs the anchor-existence assertion (B1's `tour-anchors.test.ts`) because `floating-tip.tsx` silently falls back to a centred card when an anchor is missing — a missing anchor is invisible, so the test is the only guard |
| the issue read surface "reuses the existing `BoardDetailPane` machinery" | `components/board/board-detail-pane.tsx` (380 lines) is real, but it imports `AcceptanceChecklist` from `board-card-editor.tsx:12` and `ReplyComposer` from `board-card.tsx:13` — both of which are otherwise page-only 600–780-line files, and it uses `useLiveSession` from `hooks/use-board.ts:208` | T10 keeps `board-detail-pane.tsx` **plus the two extracted sub-components**, moving `AcceptanceChecklist` and `ReplyComposer` into `components/issues/` rather than dragging their 1400-line hosts along. That extraction is the real work in T10 |
| the session detail view shows issue information | **Zero.** `SessionInfoPanel` (`focus-mode/session-info-panel.tsx:85`, desktop popover / mobile `ResponsiveSheet`; sections Name, Working dir, Settings, Schedules, Git) has two board mentions and both are style comments (`:13`, `:629`). No `BoardIssue`/`useBoard`/`boardApi` anywhere in `focus-mode/`, `routes/focus*`, `components/chat/`, `components/session-tile/` or `overview.tsx` | **A user in focus mode today cannot tell that a card is linked to their session.** T10 is therefore net-new capability, not a port — and it is the honest justification for the removal gate |
| `RosterRow` is in service and only needs a density | **It is mounted nowhere in the product.** Its only references are `chat/ui/index.ts:74`, the two dev benches (`dev-chat-ui.fixture.ts:48`, `dev-chat-live.fixture.ts:887`) and `BRAND.md:246`. Likewise `chat_tail` is **shipped, merged into the TanStack cache by `mergeRow`, and read by nothing** — `tail-preview.tsx` still renders `preview_ansi`/`preview_lines` | T3 is the primitive's **first production mount**, not a swap. Budget for the interaction wrappers being genuinely new code, and for the row's props needing a meta slot the benches never exercised (tokens + branch chip at `strip` density). A5 wires `chat_tail` into the preview slot; if A5 has not merged, B2's rows show the ladder's other facts and the preview stays empty rather than fake |
| adding fields to the sessions delta is a struct edit | **There is no typed Rust struct for the sessions delta.** `sse.rs` is a dumb pipe over `SseEvent { event: String, payload: Value }`; every `sessions` delta is a hand-built `serde_json::json!` — thirteen separate sites (`auto_actions.rs:867-911,992,1033,1038,1487`, `hooks.rs:444,461-479`, `chat/statusline.rs:593`, `lifecycle.rs:590,604-614,920,1358,1490-1500,1741`). The precedent for drift already exists: `statusline` is broadcast (`statusline.rs:593`) with **no TS type and no consumer** | T5's three new fields are a hand edit at **one** `json!` site (`auto_actions.rs:901-910`) plus `web/src/lib/api/sessions.ts` plus `session-tile/types.ts`. Do **not** introduce a typed delta struct in B2 — it is a cross-cutting refactor with thirteen call sites and no bearing on the roster; note it as a follow-up instead |
| an entry counter is unambiguous | `ChatStore::reset()` (`store.rs:192`) clears the ring but **deliberately keeps `next_seq` monotonic** across `/clear` and `--resume`; `RING_CAP = 500`, so a ring-length count is a *window*, not a conversation total; `ChatTail.ts` is the max of only the newest prompt + newest assistant, on **CC's clock** (up to 27 s from arrival, per A0) | **Decide once, in T5, and write it down**: `entry_count` is **seq-domain** (survives resync, which is what a seen-cursor wants), `last_entry_ts` is `ring.back().ts_ms` (CC clock, for display only), and the **unread comparison uses the server clock** (`activity_at`) — never CC's. The `epoch` field is what makes the seq-domain choice safe across store drops |
| a new chat-adjacent module can import via `@/…` | `bun test` resolves the **root tsconfig with no `paths`**, which is why every module under `components/chat/**` uses **relative imports only** (stated in `chat-surface.tsx`, `live-layer.tsx:23-26`, `attention-card.tsx:44-46`) | B2's new modules live in `lib/`, `hooks/`, `components/roster/`, `components/issues/` and may use `@/`; the one file it edits under `components/chat/` (`ui/roster-row.tsx`) keeps relative imports or its unit test stops resolving |
| `attention.ts` is a free filename | **`web/src/components/chat/attention.ts` already exists** (A4, 202 lines: `AttentionCause`, `ATTENTION_ORDER`, `topAttention`, `detailFor`, `attentionCopy`) and is renderer-honesty copy, **not** a roster tier model | B2's module is **`web/src/lib/attention-tiers.ts`** — the name the harness plan already reserves (`2026-08-16-harness-features-plan.md:67`). Two files named `attention.ts` in one app is the drift §18 warns about |
| "board issue" in `web/src` means the Kanban page | **~90 hits are false positives.** The entire chat surface says "the boards" for the *approved design mockups* (`board-light.png` / `board-dark.png`): all of `components/chat/**` including `ui/roster-row.tsx:4`, `routes/dev-chat-ui.tsx` (which contains `function Board()` at `:128` and `data-board=""` at `:135`), `dev-chat-live*`, `brand/tokens.ts:37`, `brand/marks/character.ts:14,179,181,254`. Plus `dashboard`/`keyboard`/`onboarding` noise and `session-tile/mock.ts:203-208` fake demo strings | T11's grep sweep ships with a **per-hit keep/delete verdict** in the PR body. A blind `grep -l board \| xargs` would delete the design system |

### 0.2 The keep-list — what the board removal must NOT touch

Deleting the page while the writers keep running is the exact risk §18 names. These survive, and T11
ships a test that says so.

**Server — nothing under `server/src/board/`, `server/src/db/board*.rs` or `server/migrations/` is
deleted or edited.**

| survivor | why |
|---|---|
| `server/src/board/mod.rs` (2335 lines) — all 20 bearer routes registered at `:35-86`, plus the **public** `GET /api/calendar.ics` (`:99`) merged at `http.rs:44` | the T10 read surface consumes them; API end-state is master-plan open question #4 |
| `server/src/board/hook.rs` — `/api/hook/board/{comment,status,check,link,needs-input}` (`:44-53`), hook-token auth, merged outside the bearer layer at `http.rs:55-58`; `needs_input_handler` fires push (`:230-232`) | the agent→board reverse edge — what `supermux-task` actually calls |
| `server/src/agents/supermux-task.md` + its installer `server/src/agents/skills.rs:101-127` (`SUPERMUX_TASK_SKILL = include_str!`), booted from `main.rs:107-108` | the shipped skill, installed to `~/.claude/commands/supermux-task.md`. **Not edited in B2** |
| `server/src/board/{boards.rs,claim.rs,dispatch.rs,prefix.rs}` | multi-board rows, the atomic `BEGIN IMMEDIATE` claim, steering-injection payloads, per-board id prefixes |
| `server/src/teams/board_sync.rs` (642 lines) + `teams/watcher.rs:114,568` | the read-through mirror of `~/.claude/tasks/{team}/NN.json` into `kind='team'` boards (`0015`/`0016`), registered by `POST /api/boards/register-team` server-side. Teams are outside Track A's guard — transcript lines can never replace this |
| `sessions/auto_actions.rs:1494-1587` (idle → `NeedsReview`, waiting → `AwaitingInput`, `emit_board`), `sessions/lifecycle.rs:675-676`, `sessions/mod.rs:734-737,793` (issue re-publish around delete), `db/sessions.rs:379` (`UPDATE issues SET session=?` on rename) | live writers, all of them |
| `scheduler/runner.rs:208,258-259` (sends the literal `/supermux-task` line) | scheduled runs report onto issues |
| the `board` (`board/mod.rs:333`) and `boards` (`boards.rs:294`) SSE events, and their consumers | the read surface is live-updating |
| `server/migrations/0002,0010,0011,0013,0015,0016` | memory *sqlx-migrations-are-checksummed* — never edit or drop a migration |
| `server/tests/board.rs` (595) and `server/tests/board_claim.rs` (163) | **these test the API, not the page.** They stay green, unedited. Deleting them would delete the proof that the keep-list works |

**Web — the data layer the new surface needs:**

| survivor | why |
|---|---|
| `web/src/lib/api/board.ts`, `web/src/lib/api/boards.ts`, `web/src/hooks/use-board.ts` (incl. `useLiveSession:208`, `synthesizeSessionBoards:712`) | T10's list/detail read through them; the per-session filter is already a client-side synthesis |
| `web/src/hooks/use-sse.ts` — the `'board'` / `'boards'` `SseEventType` members (`:52-55`) and their refetch entries (`:244-245`) | the issue surface updates live |
| **`web/src/stores/board-create-session-store.ts`** | **filename trap.** It is the app-wide `useLastActiveSession` cell, read/written by `routes/focus.tsx:5`, `focus/desktop.tsx:44,68`, `focus/mobile.tsx:99,180`, `routes/files.tsx:49,68`. Its own header documents that the localStorage key `supermux:board-create-last-session` must not change. **Only the board-composer/switcher writer paths go away** |
| `components/session/session-picker.tsx` | also used by the scheduler and `routes/files.tsx`; only its comments mention the board |
| `web/tests/e2e/smoke/harness.ts:238,280,287` (`api` helper creates issues via `POST /api/board`, claims via `…/{id}/claim`) | T10's e2e needs exactly these helpers |

### 0.3 Frozen — the regression net

| file | owns | rule |
|---|---|---|
| `web/src/brand/marks/{character,geometry,ticker,session-mark}.*` | the 63-token engine, six eye-states, the shared rAF loop, `assignRoster` | **B2 does not edit the engine**; it becomes a consumer. A diff here beyond re-exporting an existing symbol is a bug |
| `web/src/components/chat/ui/*` except `roster-row.tsx` | B0's primitives | untouched; `roster-row.tsx` gains one optional prop and changes shape in no other way |
| `session-tile/tail-preview.tsx`, `chat-tail-preview.tsx` (A5) | the tile preview slot | **A5 owns which preview renders.** A non-eligible tile must stay byte-identical |
| `hooks/use-live-term.ts` | the pty WS | untouched |
| `server/src/sessions/chat/store.rs`'s `attach`/`publish` critical section and its no-gap/no-overlap proof tests | the A2 invariant | T5 adds fields to `ChatTail` and reads a counter; it does not touch the critical section, and the proof tests stay green unedited |
| `server/tests/board.rs`, `server/tests/board_claim.rs` | the API contract that outlives the page | green and unedited |
| `web/tests/unit/*`, `web/tests/e2e/smoke/*` | the net | green at every task boundary except the specs each task names |

### 0.4 Test & tooling reality

- Unit: **`bun test`** (`bun run test:unit` → `bun test tests/unit`, 40 files). Component assertions
  use `renderToStaticMarkup` (`tests/unit/chat-ui-primitives.test.tsx`); CSS contracts by parsing
  `globals.css` (`tests/unit/brand-tokens.test.ts`). **There is no unit test for
  `overview-layout.ts`, `overview-size.ts` or any sort kernel** — T9 writes the first.
- E2E: three configs. `playwright.config.ts` (`testDir tests/e2e/smoke`, real server binary via
  `harness.ts`, serial, 90 s; `SUPERMUX_E2E_NO_SANDBOX=1` on this box);
  `playwright.mobile.config.ts` (`tests/e2e/mobile`, `vite preview` on 4317, **all backend traffic
  route-mocked**, iPhone 14 Pro Max / WebKit — the cheapest mobile surface to assert against);
  `playwright.screens.config.ts` (`tests/e2e/screens`). `tests/e2e/status-dot-pulse.spec.ts` is
  **orphaned** (no config's `testDir` covers it; it targets `DEV_BASE_URL/dev/tiles`) — B2 either
  adopts it into the roster VR script or leaves it and says so.
- Rust: `cargo check` / `cargo test` **debug only** (CLAUDE.md); in-sandbox needs
  `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu` (memory
  *server-no-compile-in-sandbox*).
- Perf: `bun run build:perf` (`web/scripts/size-budget.mjs`); post-B0 baseline **158.40 KB gz app JS
  / 17.08 KB gz CSS** (budgets 200 / 30). `vite.config.ts:144-163` `manualChunks` splits vendors
  only — **`routes/board.tsx` is a static import in `App.tsx:14`, so the whole board lives in the
  entry chunk**. Everything B2 adds is hero-path too; T11 is the offsetting removal (~3.5 k lines of
  page + components + hooks + api clients).
- Offline VR rig (memory *offline-mobile-ui-review-rig*, recipe restated in the B1 plan §0.3):
  worktree Vite `bunx vite --port 5202 --strictPort --host 127.0.0.1`; Playwright from
  `/opt/projects/folderwijzer/app/backend/node_modules/playwright`; chromium headless-shell with
  `LD_LIBRARY_PATH=/home/supermux/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu:/home/supermux/.local/chromelibs/extract/lib/x86_64-linux-gnu`,
  `args:['--no-sandbox','--no-zygote','--disable-gpu']`, **`deviceScaleFactor: 1`**. Theme is a class
  on `<html>`; force it in-page. **Every VR check below is two shots, light and dark.**
- `data-vr="…"` is the repo's VR-hook convention (`ARCHITECTURE.md:160`; 61 attributes today, incl.
  `group-grid`, `group-header`, `group-sort-chip`, `focus-strip`, `strip-sort-chip`). Every new
  surface in B2 gets one.
- Public screenshots only from `/?mock` or `/dev/*` (memory *readme-screenshots-must-use-mock*).

---

## 1. Deliverables

```
web/src/lib/
  roster-marks.ts             NEW (pure) roster-wide mark-pin assignment + override merge
  attention-tiers.ts          NEW (pure) three-tier model, seen-cursor arithmetic, rollup
                              (NOT `attention.ts` — components/chat/attention.ts is A4's)
  fact-ladder.ts              NEW (pure) which facts render on which surface at which tier
  overview-layout.ts          EDIT groupSort + groupBy into the blob; localStorage migration
web/src/hooks/
  use-roster-marks.ts         NEW context provider over roster-marks.ts
  use-attention.ts            NEW seen-cursors (localStorage) + tier derivation + rollup
web/src/components/chat/ui/
  roster-row.tsx              EDIT + `density` prop ('list' | 'strip' | 'picker'); nothing else
web/src/components/session-tile/
  tile.tsx                    EDIT mark replaces StatusDot; attention dot; ladder-gated facts
  session-row.tsx             EDIT thin wrapper over RosterRow(density='list')
  status-dot.tsx              EDIT doc + scope note (mark-less surfaces only)
  overview-display-menu.tsx   EDIT the canonical surface: view, sort, group-by, size, tags, hide
  group-header.tsx            EDIT pinned-first hairline + group sort from the blob
  group-sort-chip.tsx         EDIT reads/writes the blob, not localStorage
  new-session-sheet.tsx       EDIT mark preview + reroll, desc, tags, model, initial prompt
  group-grid.tsx              EDIT TileMoveToKebab += Pin / Tags / Rename / Mark unread
web/src/components/focus-mode/
  compact-tile.tsx            EDIT thin wrapper over RosterRow(density='strip')
  session-info-panel.tsx      EDIT + Issues section (per-session), + desc/tags editors
web/src/components/roster/
  attention-rollup.tsx        NEW "needs you: N" facepile for the overview header
  display-controls.tsx        NEW the desktop half of the canonical prefs surface
web/src/components/issues/
  issue-list.tsx              NEW per-session + per-team list
  issue-detail.tsx            MOVED from components/board/board-detail-pane.tsx
  acceptance-checklist.tsx    EXTRACTED from board-card-editor.tsx
  reply-composer.tsx          EXTRACTED from board-card.tsx
  issue-surface.tsx           NEW ShellOverlay / ResponsiveSheet host (B1 §11.4 variant prop)
web/src/components/team/
  team-card.tsx               EDIT + team issue entry point (crew facepile mark)
web/src/routes/
  overview.tsx                EDIT rollup in header, canonical display controls, group-by
  dev-roster.tsx              NEW (DEV-only, lazy) the bench
  board.tsx                   DELETED
web/src/App.tsx               EDIT −/board route (+redirect), +/dev/roster
web/src/components/layout.tsx EDIT NAV −1
web/src/components/command-palette/command-palette.tsx  EDIT −4 verbs, −7 sub-modes, −issue rows
web/src/components/board/      DELETED (6 files; 2 sub-components extracted first)
web/src/hooks/use-send-to-agent.ts    DELETED (board-page-only despite the name)
web/src/brand/copy.ts          EDIT EMPTY.board → EMPTY.issues (currently dead code); keep
                               CONFIRM.deleteIssue / TOAST.issueStarted for the new surface
web/src/brand/BRAND.md         EDIT fact-ladder table + attention-tier vocabulary
server/src/sessions/chat/store.rs   EDIT ChatTail += entry_count, last_entry_ts, epoch
server/src/sessions/auto_actions.rs EDIT ChatTailGate publishes them
server/src/sessions/mod.rs          EDIT SessionView += mark_pin; ConfigInput += mark_pin
server/migrations/0025_session_mark_pin.sql  NEW (append-only, one nullable column)
server/src/prefs.rs                 UNCHANGED (deliberately — see T9)
server/tests/static_assets.rs       EDIT the `/board` SPA-fallthrough assertion
web/tests/e2e/smoke/ios-pwa-chrome.spec.ts  EDIT repoint off `/board`
web/tests/unit/
  roster-marks.test.ts  attention-tiers.test.ts  fact-ladder.test.ts
  roster-row-density.test.tsx  attention-rollup.test.tsx  issue-list.test.tsx
  overview-layout-sort.test.ts  new-session-identity.test.tsx
  dev-roster-cast.test.tsx  board-removal-keeplist.test.ts
web/tests/e2e/smoke/
  roster-attention.spec.ts  issue-surface.spec.ts  board-gone.spec.ts
  board-*.spec.ts (8 files)   DELETED with the page
```

Nothing outside these paths changes. **No new web deps.** The only schema change is the new
append-only migration `0025`.

---

## 2. Tasks

Twelve tasks. TDD wherever there is anything to assert: the pure module + `bun test` first, then the
hook, then the surface. Every task ends green on `bun run test:unit` **and** `bun run lint`, and
records its entry-chunk delta. **T1 lands before anything moves; T11 lands last and is gated.**

---

### T1 — The bench and the regression net, before a pixel moves

- [x] `web/src/routes/dev-roster.tsx` (DEV-only, lazy, registered beside the existing `/dev/*` routes
      at `App.tsx:22-59,103-172`): the roster system on one deterministic page — `RosterRow` at all
      three densities × six mark states × three attention tiers × selected/unselected; the tile at
      tiers 1–4; the pinned hairline; the rollup at N=0/1/3/9; issue list empty/loading/error/
      populated — each in **both** themes via the `[data-theme]` subtree switch (the `/dev/marks`
      idiom, `routes/dev-marks.tsx`). Every matrix is a **still** frame; only an explicit strip
      animates. `data-vr` hooks on every block.
- [x] `web/tests/unit/dev-roster-cast.test.tsx` asserts the bench's coverage (3 densities × 6 states ×
      3 tiers × both themes) so it cannot quietly shrink — the `dev-marks-cast.test.tsx` precedent.
- [x] VR baselines **before** any change: `/dev/tiles`, `/dev/marks`, `/?mock` overview at tiers 1–4,
      the focus strip, light + dark, DPR 1 → `<scratchpad>/b2-baseline/`.
- [x] Record the pre-change `bun run build:perf` numbers in the PR body.
- [x] **Drive-by, one line**: `server/src/teams/scan.rs:850-851` carries a **duplicated `#[test]`**
      attribute on `a_solo_implicit_team_is_not_a_real_team`, which cost
      `missing_teams_dir_yields_no_teams` (`:875`) its own `#[test]` — that function is silently no
      longer a test. B2 touches team surfaces (T4's crew facepile, T10's per-team issues), so fix it
      here and note it in the PR body rather than letting a disabled test ride along.

**Verify**: `bun run test:unit` green; `cargo test` shows `missing_teams_dir_yields_no_teams` running;
`/dev/roster` renders both themes; baselines exist.

---

### T2 — One roster, one set of faces (the dedupe nobody wired)

The engine exists, no roster surface uses it, and nothing dedupes.

- [x] `web/src/lib/roster-marks.ts` (pure): `rosterPins(sessions, overrides) → Map<name, MarkPin>`.
      Order is **creation order** (`created_at`, tie-broken by `name`) so a pin never moves when a
      session earlier in the list is deleted; `overrides` (T8's `mark_pin`) are seated **first**, then
      `assignRoster` fills around them. Re-export — never re-implement — `assignRoster` /
      `characterFromSeed` from `brand/marks`.
- [x] `web/tests/unit/roster-marks.test.ts`: (a) 14 sessions → 14 distinct silhouette+pigment pairs;
      (b) deleting the first session leaves every surviving pin unchanged; (c) an override is honoured
      and the rest dedupe around it; (d) >63 sessions degrades to repeats, never throws; (e) pure
      determinism.
- [x] `web/src/hooks/use-roster-marks.ts`: one context provider mounted in `layout.tsx`, fed by the
      sessions query, memoized on `(names, created_at, overrides)`; consumers call `usePin(name)`.
      **One computation per roster change, never per row.**
- [x] Render marks on the roster surfaces for the first time, each with `pin={usePin(name)}`:
      `tile.tsx`, `session-row.tsx`, `focus-mode/compact-tile.tsx`, `command-palette` session rows,
      `session/session-picker.tsx`, `session-tile/where-picker.tsx`, `team/*` facepiles.

**Verify**: unit suite; VR of a 14-session fixture at `/dev/roster` + `/?mock` showing no duplicate
face, both themes; **perf/battery**: extend `session-mark.test.tsx`'s existing registration
assertions to roster scale — 40 marks must share **one** rAF loop and offscreen marks must
unregister (`brand/marks/ticker.ts`, `use-on-screen.ts`).

---

### T3 — `RosterRow` grows a density, and the fact ladder becomes real

- [x] `roster-row.tsx`: add `density?: 'list' | 'strip' | 'picker'` (default `'list'`). `list` = today
      (h64 / mark 40 / preview / ticking time). `strip` = h48 / mark 28 / no preview (the
      `compact-tile.tsx` geometry it replaces: 320×56 → 320×48, tokens + branch chip preserved via the
      meta slot). `picker` = h40 / mark 24 / **static** — no ticking timestamp, no mutating status
      under the keyboard cursor (§12.1). Nothing else about the component changes.
- [x] `web/src/lib/fact-ladder.ts` (pure): `facts(surface, tier)` → the set drawn from
      `{ mark, name, taskSummary, time, preview, statusLabel, tokens, branch, hostBadge, errorBadge,
      jumpChip, tags, archiveAction, attention }` for `surface ∈ {tile, list, strip, picker}` ×
      `tier ∈ 1..4`. **This is the reconciliation of two divergent sets** (`tile.tsx:812-980` vs
      `session-row.tsx`), so each row of the table carries a one-line rationale comment.
      `contextPct` is **explicitly absent** — it does not exist in the app today (the A2 statusline
      tap feeds the chat header only); it is listed in §5 as deferred rather than silently promised.
- [x] `web/tests/unit/fact-ladder.test.ts`: monotonicity (a fact at tier *n* is present at every
      tier > *n* on the same surface); `mark` and `attention` present on **every** row of **every**
      surface (§12.4: attention must survive collapse); `picker` contains no ticking fact; the union
      of `tile` tier 4 equals today's rendered set (a snapshot of the status quo, so the ladder can be
      proven not to drop a fact).
- [x] `session-row.tsx` and `compact-tile.tsx` become thin interaction wrappers: they keep click,
      context menu, drag handles, dwell-popover and `Kbd` behaviour and delegate rendering to
      `RosterRow`. Palette + picker rows adopt `density='picker'`.
- [x] The ladder table is mirrored into `BRAND.md` next to §6c so future surfaces cannot drift.

**Verify**: unit suites; VR of the three densities × both themes against T1's shots; existing
`overview-loads.spec.ts` and `overview-mobile-parity.spec.ts` green unedited; the focus strip's
`data-vr="focus-strip"` shot is unchanged in geometry beyond the intended 56→48 row height.

---

### T4 — The eye is the status channel

- [x] `tile.tsx`: the mark (via `usePin`) replaces the bare `StatusDot` at `:940`. **No ring, no
      notch** — B0 contract C5. The 7px attention dot is the only glyph seated on the silhouette.
- [x] One exported total mapping `SessionStatus → MarkState`
      (`starting|active|idle|waiting|stopped|error` → `working|working|idle|waiting|stopped|failed`),
      next to the fact ladder, with a unit test that it is **total** — `starting` and `error`
      explicitly named (§10 asks for this mapping table; B0 shipped the eye geometry but never the
      status mapping). **Mind the enum drift**: Rust's `Status` (`server/src/sessions/status.rs:158`)
      is `Active|Waiting|Idle|Stopped|Starting|Unknown` — it has **no `Error`** (errors ride the
      separate `error:{type,message}` delta field) — while TS's `SessionStatus`
      (`web/src/lib/api/sessions.ts:18-24`) has **`error` and no `unknown`**. The mapping is written
      against the **TS** union, and the `needs` tier reads `session.error` (the field), not a status.
- [x] `status-dot.tsx` is **not** deleted (`STATUS_LABEL` / `STATUS_COLOR` are consumed widely via the
      barrel). It gains a doc note + a unit assertion that `tile.tsx` / `session-row.tsx` /
      `compact-tile.tsx` no longer import `StatusDot`, so the two channels cannot silently re-diverge.
      `team/member-status-dot.tsx` merges into the mark vocabulary in **B5** (§16.3), not here.
- [x] Team tiles/rows use the `crew` facepile cluster (B0's `Facepile variant="cluster"`).
- [x] Tags render as chips at the ladder's designated tier only.

**Verify**: unit (mapping totality; no `StatusDot` import); VR both themes of a fixture with all six
statuses at every tile tier; a **reduced-motion** shot proving each state is separable in a still
frame at tile size (B0's hard contract, re-asserted at the new size).

---

### T5 — The three-tier attention model, provider-neutral by construction

The audit's biggest correction lives here. **Do not build unread on `chat_tail`'s presence.**

- [x] `web/src/lib/attention-tiers.ts` (pure — no React, no storage. **Not `attention.ts`** —
      `components/chat/attention.ts` is A4's renderer-honesty copy module):
      - `tierFor(session, cursor, now) → 'needs' | 'unread' | 'working' | 'quiet'`, in that precedence.
      - **needs**: `status === 'waiting'` · an A4 pending-choice signal · an inbound-delegation marker
        · **`status === 'error'`** (§12.2 promotes error alongside — it already has three affordances
        and must not vanish) · `session.permission_request` (already on the wire, `sessions.ts:176-199`).
      - **unread**: the row's activity stamp is newer than the seen cursor. The stamp resolves down a
        documented ladder — `chat_tail.last_entry_ts` (only when a store exists) → `activity_at`
        (server-clock ms, `hooks.rs:477`) → `last_activity` → `updated_at`. **Every row gets a tier**,
        whatever its provider, host or team-ness.
      - **working**: `status === 'active' | 'starting'`.
      - `unreadCount(session, cursor) → number | null` — a number **only** when the delta carried
        `entry_count` and the store `epoch` matches the cursor's; otherwise `null` → dot, never a
        wrong number.
      - `rollup(sessions, cursors)` → the ordered needs-attention list for the header cluster.
- [x] `web/tests/unit/attention-tiers.test.ts`, written as a **false-positive suite** (the #41/#43 class is
      the named risk): a codex/kimi session with no chat store still gets a tier; a remote-host session
      gets a tier; a stopped session is never `working`; a decreasing `entry_count` (store dropped and
      recreated) yields `null`, never a negative; a session opened and closed with no new activity
      returns to `quiet`; precedence is stable when two tiers apply; `error` outranks `unread`;
      an archived session is excluded entirely.
- [x] `web/src/hooks/use-attention.ts`: seen cursors in **localStorage** (`supermux:seen:<name>` →
      `{ts, count, epoch}`), pruned on rehydrate for names that no longer exist (the A5 prune
      precedent, `ui-store.ts:122-135`). Opening a session marks read; **Mark unread** joins the row
      kebab (`group-grid.tsx:1962 TileMoveToKebab`). **Not the prefs blob** (§12.2 — one 50 KB
      whole-value PUT would clobber read state across devices); `PATCH /api/sessions/{name}/seen` is
      deferred to B5.
- [x] Server, small and additive. **Decide the counter's domain once and write it in the struct's
      doc comment**: `entry_count` is **seq-domain** (`Inner.next_seq`, which `ChatStore::reset()`
      deliberately keeps monotonic across `/clear` and `--resume`) — a seen-cursor wants exactly that.
      It is **not** `ring.len()` (that saturates at `RING_CAP = 500` and is a window, not a total).
      `ChatTail` gains `entry_count: u64`, `last_entry_ts: i64` (`ring.back().ts_ms`, **CC's clock —
      display only, never the unread comparison**) and `epoch: i64` (the store's creation stamp,
      which is what makes the seq domain safe across store drops). All three are computed inside
      `ChatStore::tail_summary()` (`store.rs:203`), which already holds the lock and walks the ring.
- [x] Wire it: the fields ride the existing `ChatTailGate` (`auto_actions.rs:1788-1836`) — its
      change-detection and 1 s debounce (`CHAT_TAIL_MIN_INTERVAL`) unchanged, and the delta's
      **absent = unchanged** semantics preserved. Exactly **three** files change:
      `sessions/chat/store.rs` (the struct + `tail_summary`), `web/src/lib/api/sessions.ts`
      (`interface ChatTail`) and `web/src/components/session-tile/types.ts`. The `json!` site at
      `auto_actions.rs:901-910` serializes the struct and needs no edit. **Do not** introduce a typed
      delta struct here (thirteen `json!` sites, unrelated refactor — note it as a follow-up).
      `store.rs`'s `attach`/`publish` critical section and its no-gap/no-overlap proof tests are not
      touched.
- [x] Rust test (extend `server/tests/status_detector_cold_start.rs`, which already drives
      `ChatTailGate` at `:102,:151,:237` and asserts the delta wiring at `:205`): the counter is
      monotone within an epoch; a dropped-and-recreated store yields a new epoch with a reset count;
      `reset()` does **not** rewind the count; `chat_tail` is still absent for a session with no store.
- [x] Wire the tier into `RosterRow.attention` (already a prop) and the tile.

**Verify**: `bun run test:unit`; `cargo test` (debug); `roster-attention.spec.ts` — a fresh unrelated
session never lights up while another session works (the false-positive gate); VR of the three tiers
at all three densities, both themes.

---

### T6 — The attention rollup in the overview header

- [x] `web/src/components/roster/attention-rollup.tsx`: the compact **"needs you: N"** cluster on B0's
      `Facepile` (`variant="row"`, −24 % overlap, the active member morphing open by animating padding,
      400 ms — §11.9). N=0 renders nothing (no empty chrome).
- [x] Tap target, in this order: (1) the session's **chat, scrolled to the pending P5 choice card**
      (A4's choice-card anchor) — the common case; (2) A4's **Attention card** for watchdog states;
      (3) the session route. The code names which is which — they are different things (§12.3).
- [x] Placement: inside B1's overview header grammar. If B1 has not merged, mount it in the existing
      header block (`overview.tsx:520-607`) behind a `// B1-SEAM` comment.
- [x] `attention-rollup.test.tsx`: ordering (oldest-waiting first); N=0 renders nothing; N>3 collapses
      to three marks + "+N"; under `prefers-reduced-motion` the morph is static and still legible.

**Verify**: unit; e2e that clicking a member lands on that session with the choice card in view; VR at
N=0/1/3/9, both themes; mobile shot via `playwright.mobile.config.ts`.

---

### T7 — The phantom features get controls (pin, tags, desc) + the pinned hairline

- [x] **Pinned-first hairline** in list / strip / pickers: a 0.5px separator after the pinned block,
      **no "Pinned" text header** (§12.4). `smartSort` already orders by `pinned`
      (`overview-layout.ts:293`); this only makes the boundary visible, and renders nothing when
      there are no pins or no unpinned rows.
- [x] **Pin**: `TileMoveToKebab` (`group-grid.tsx:1962`) + the row context menu + `QuickPeekModal`'s
      action list → `PATCH /api/sessions/{name}/config { toggle_pin: true }`, optimistic with the
      existing rollback idiom.
- [x] **Tags**: chips per the fact ladder; an editor in `SessionInfoPanel`; **filter by tag** in the
      canonical display surface (T9). Search already matches tags (`overview.tsx:96-97`) — this
      surfaces it.
- [x] **Desc → "standing instructions"**: shown and edited in `SessionInfoPanel` with the §10 framing
      ("durable rules live on the agent, tasks live in the message"), and in T8's create sheet.
- [x] **Rename reachable everywhere the name shows** (§10): the kebab gains Rename, reusing
      `use-rename-session.ts` + `NameEditor` (`session-info-panel.tsx:332`) rather than a second path.

**Verify**: unit (hairline present iff ≥1 pinned **and** ≥1 unpinned); e2e pin → row moves and
survives reload; VR of 2 pinned + 6 unpinned, both themes.

---

### T8 — New-session identity fields

- [ ] `new-session-sheet.tsx` (`AgentForm:151`) keeps every functional field (Name, Folder,
      Run-on/host, Isolated worktree, Bypass permissions) and gains: **mark preview + reroll**,
      **desc**, **tags**, ~~**model**~~, **initial prompt**. The provider `KindToggle` (`:104`) gets marks
      instead of text-only labels.
      **CORRECTION (A6 T5.1, 2026-08-17): `model` did NOT ship** — this box was ticked while
      `new-session-sheet.tsx` contained zero occurrences of `model`. Everything else on the line did
      ship; the box is un-ticked because one unshipped item makes the whole claim false. A6 T5.1 did
      **not** land the field either, and deliberately so: **there is no per-session model on the
      create path to wire it to.** `NewSession` has no `model`
      (`web/src/lib/api/sessions.ts:410-425`) and says so explicitly at `:156-157` ("the model lives
      [in `flags`] — there is no separate `model` field"); server `CreateInput` has only
      `flags: Option<String>` (`server/src/sessions/mod.rs:662`), which `create()` documents the web
      must never send ("`flags` is interpolated unquoted into the launch line",
      `mod.rs:775-777` — the reason `bypass_permissions` is a typed boolean); and the sessions router
      exposes no `/model` route at all (`mode`, `config`, `start`, … — no model). The only model
      control that exists is **global**: `PATCH /api/settings/default-model` → `CC_DEFAULT_FLAGS`
      (`web/src/lib/api/settings.ts:81-89`), which is what `ModelPicker` (`settings.tsx:108`) drives.
      Reusing that picker in the create sheet would silently rewrite the default for *every future
      session* — a worse lie than the missing field. Landing this needs a typed `model` on
      `CreateInput` with the server building the flag (the `bypass_permissions` precedent); that is a
      server change and is out of A6's scope. See `a6-triage.md` §"T5.1 — the STOP".
- [x] **Reroll needs persistence — the one schema change.** `server/migrations/0025_session_mark_pin.sql`:
      one nullable `TEXT mark_pin` on `sessions` (a compact `"<silhouette>:<hue>"` encoding of
      `MarkPin`). Assignment stays *derived* (T2); the column is written **only** on reroll.
      `SessionView.mark_pin` + `ConfigInput.mark_pin` (`server/src/sessions/mod.rs:170,828`) and
      `ApiSession.mark_pin` + `SessionConfigPatch.mark_pin`; written through the existing
      `PATCH /config`. **Append-only migration — never edit an existing one** (memory
      *sqlx-migrations-are-checksummed*).
- [x] Reroll cycles only tokens currently **free** in the roster (reuse `rosterPins`), so a reroll can
      never hand out a duplicate.
- [x] **Initial prompt** replaces the board's "Add & start" (§12.6) — the create flow's answer to the
      one capability the removed page had. It rides the existing `create` → `start` → send path
      (`new-session-sheet.tsx:206,223`).

**Verify**: unit (reroll never collides; a session with no override renders byte-identically to
today); `cargo check` + a Rust test that `mark_pin` round-trips through `PATCH /config` and that a
`NULL` column changes nothing; e2e create-with-initial-prompt reaches the session; VR of the sheet in
both themes at desktop + mobile widths.

---

### T9 — The sort/grouping debt, paid (§12.6b)

- [x] **Per-group sort moves into the `overview_layout` blob**, not a new pref key: `OverviewLayout`
      gains `groupSort: Record<groupId, GroupSortMode>`. `server/src/prefs.rs` is **unchanged**, and so
      is `hooks/use-sessions.ts`'s dispatch. One-time migration on read: existing
      `supermux:overview:group-sort:<groupId>` values fold in and the keys are removed (the
      `ui-store.ts:122-135` legacy-carry precedent). `useGroupSortModes` (`group-grid.tsx:259`),
      `readGroupSortMode`/`writeGroupSortMode`/`removeGroupSortMode` (`overview-layout.ts:384-415`)
      and the strip's 4-mode subset (`focus-strip-section.tsx:46`) all re-point at the blob.
      **Rewrite the module doc at `overview-layout.ts:25-33`** — it currently argues the opposite, and
      leaving it makes the change read as an accident.
- [x] **Group-by presets** join manual drag groups: `groupBy: 'none' | 'dir' | 'provider' | 'host' |
      'status'` on the blob. Presets are **derived** groupings — they never write `custom`, so
      switching to a preset and back cannot destroy a hand-dragged order. Unit-tested explicitly.
- [x] **One canonical prefs surface.** `OverviewDisplayMenu` is mobile-only today, so this task
      *builds the desktop half*: `components/roster/display-controls.tsx` renders the same option
      model (view · sort · group-by · size · tag filter · hide-stopped · A5's default renderer) as a
      popover, and `overview.tsx:548-574` stops forking into four separate chips. `SortControl`,
      `OverviewSizeControl`, `HideStoppedChip`, `ViewToggle` and `GroupSortChip` become thin mirrors
      over one option model in `lib/sort-modes.ts`; Settings→Appearance and the palette are documented
      cross-references, not second sources.
- [x] `web/tests/unit/overview-layout-sort.test.ts` — **the first unit test this module has ever
      had**: the six sort kernels (`smartSort`, `nameSort`, `statusSort`, `recencySort`, `ageSort`,
      `sortSessionsByMode`), the localStorage→blob migration (folds and clears), preset↔custom
      round-trip preserving drag order, unknown `groupBy` → `none`, and `reconcileCustomLayout`
      unchanged.

**Verify**: the new unit suite; e2e that a group sort set with a fresh localStorage (same server) is
honoured after reload — the cross-device property §13.4 asks for; VR of the display surface, both
themes, desktop popover + mobile sheet.

---

### T10 — The issue read surface (net-new capability, and the removal's precondition)

Today the focus panel shows **zero** issue information. This is the task that makes the removal
honest.

- [x] **Extract, then move.** `components/issues/acceptance-checklist.tsx` ← `AcceptanceChecklist`
      (`board/board-card-editor.tsx:12`); `components/issues/reply-composer.tsx` ← `ReplyComposer`
      (`board/board-card.tsx:13`); `components/issues/issue-detail.tsx` ← `board/board-detail-pane.tsx`
      (380 lines, behaviour unchanged, imports re-pointed). Their 600–780-line hosts stay behind and
      die in T11. Keep `useLiveSession` (`hooks/use-board.ts:208`) — the detail pane uses it.
- [x] `components/issues/issue-list.tsx`: the compact list for **one session** (Main-board cards
      filtered by `session`, the `synthesizeSessionBoards` logic at `use-board.ts:712` reused rather
      than re-derived) and for **one team** (`GET /api/boards/{id}/cards` on the team's `kind='team'`
      board, `db::boards::get_by_team`). Rows show status, acceptance progress, due, PR/commit links,
      `team:` assignee.
- [x] `components/issues/issue-surface.tsx`: hosts list + detail in B1's **`ShellOverlay`** — desktop
      shell-absolute overlay, mobile `ResponsiveSheet`, *one component with a `variant` prop*
      (§11.4's "three fidelities, one component"). If B1 has not merged, mount `ResponsiveSheet`
      directly behind a single `// B1-SEAM`.
- [x] Reachable from: **`SessionInfoPanel`** (a new `Issues` section beside `Schedules`, per-session),
      **`TeamCard`** (per-team), and as a navigation *target* for the palette's `board issue` result
      kind and §13.1 entity chips. B2 guarantees the target exists; B3 owns the picker.
- [x] **Reply to a dead session** — the capability chat structurally cannot hold: the durable-comment
      path (`POST /api/board/{id}/comment`) stays reachable from the detail. §12.8 names this as the
      reason the API is not deprecated with the page.
- [x] Live updates over the existing `board` / `boards` SSE events; empty/loading/error via
      `EmptyStatePlaceholder` + `brand/copy.ts` (`EMPTY.board` → `EMPTY.issues`; `CONFIRM.deleteIssue`
      and `TOAST.issueStarted` are dead code today and are adopted here rather than deleted).

**Verify**: `issue-list.test.tsx` (per-session filter, per-team filter, acceptance progress, empty
state); `issue-surface.spec.ts` — open a session with a linked issue (created via `harness.ts`'s
`api` helper), see it, comment, see the comment live; VR list + detail, both themes, desktop overlay
+ mobile sheet.

---

### T11 — Remove the Board page (gated; last; one commit)

**The gate — prove all three before deleting anything.** `web/tests/e2e/smoke/board-gone.spec.ts`
asserts the replacements *first*, the removal second:

1. the attention rollup renders and navigates (T6),
2. the chat reply loop works — a choice card answered from chat (A4/A5),
3. the issue surface is reachable **per-session and per-team**, and a comment posts (T10).

If any leg fails, T11 does not land and B2 ships without it — the roster half is independently
valuable. Say so in the PR body rather than shipping a half-gate.

**Delete-list — every surface, named:**

- [x] `web/src/routes/board.tsx` (1035 lines).
- [x] `web/src/App.tsx`: `import { Board }` (`:14`) and `<Route path="/board" …>` (`:97`). Add a
      redirect `/board` → `/` (the `/hosts` → `/settings#hosts` pattern) so bookmarks land somewhere
      honest instead of on a blank router match.
- [x] `web/src/components/layout.tsx:54` — the `{ to:'/board', label:'Board', icon: SquareKanban }`
      entry (deleted **by `to`, not by index**) and the now-unused `SquareKanban` import (`:8`). One
      deletion removes it from **both** `SideNav` (`:86-97`) and `BottomNav` (`:164-171`). Nav goes
      5 → **4**. Update the route-list comment at `:266`.
- [x] `web/src/components/command-palette/command-palette.tsx` — the deepest cut, and the one to do
      surgically: the four verbs `action:board-start` (`:359`), `action:board-send` (`:367`),
      `action:board-comment` (`:375`), `action:board-done` (`:383`) and their `onBoard` gate (`:266`,
      `:354`); `IssueRow` (`:126-132`) and its member of `PaletteRow` (`:134`); the seven
      `PaletteMode` steps (`:136-148`); `matchesIssue` (`:225`); `useBoard`/`useSendToAgent`/
      `useStartAgent`/`boardApi` imports (`:62-69`); `enterMode` (`:299-318`); the issue memos
      (`:392-420`); the row-building branches (`:446-466`); the verb effects (`:529-600`); pick
      routing (`:632-703`); the back-out machine (`:710-724`); the comment placeholder (`:835`); the
      "No issues here yet." string (`:881`); breadcrumb/placeholder helpers (`:906-934`); the issue
      row renderer (`:982-995`). **Keep** the palette, session rows, slash commands, skills, MCP rows,
      `newGroupAction`, `openArchived`, `openClaudeTools` and `useGlobalCommandKey` (`:156-176`).
- [x] `web/src/components/board/` — `board-card.tsx` (782), `board-card-editor.tsx` (602),
      `board-composer.tsx` (415), `board-switcher.tsx` (284), `board-skeleton.tsx` (24), `pos.ts` (25).
      `board-detail-pane.tsx` and the two extracted sub-components already moved in T10; the directory
      disappears.
- [x] `web/src/hooks/use-send-to-agent.ts` (280) — **board-only despite the generic name**; every path
      calls `boardApi.start/claim/unsend` and its only consumers are `board.tsx:38` and the palette.
- [x] `web/src/brand/copy.ts` — `EMPTY.board` renamed in T10; remove nothing else (`CONFIRM.deleteIssue`,
      `TOAST.issueStarted` are adopted by the new surface). Run `scripts/lint-microcopy.sh`.
- [x] Web e2e specs that drive the page: `board-claim-picker`, `board-claim-race-no-500s`,
      `board-cmdk-drag-send`, `board-composer-agent-picker`, `board-detail-sheet`, `board-live-card`,
      `desktop-board-pane`, `mobile-board-no-pane`. **The API-level Rust equivalents
      (`server/tests/board.rs`, `board_claim.rs`) stay** — they are the proof the keep-list holds.
- [x] `web/tests/e2e/smoke/ios-pwa-chrome.spec.ts:32,66` — repoint off `/board`; rename the
      `sd-6-board-top.png` shot.
- [x] `server/tests/static_assets.rs:85-89` — the assertion that `/board` falls through to the SPA
      shell is now asserting the redirect target instead.
- [x] Docs: `ARCHITECTURE.md` (`:22,43,60,65,67,77-80,91,110,119,133,134`) and `README.md`
      (`:69,104-107,138,213,261` + `docs/screenshots/board.png`) describe a page that no longer
      exists. Update the prose to "issues live in session detail; the API and the `supermux-task`
      skill are unchanged", and replace or drop the screenshot (re-shoot only from `/?mock`).
      `design/ACCEPTANCE.md:134,153` gets the same treatment.
- [x] **Onboarding**: nothing to retarget (audited — no board anchor). Still run B1's
      `tour-anchors.test.ts` (extend it if B1 has not merged): `floating-tip.tsx` silently falls back
      to a centred card when an anchor is missing, so a broken tour is invisible without the test.
- [x] The final `grep -rn "board\|Board" web/src server/src docs` sweep goes in the PR body **with a
      keep/delete verdict per hit**. ~90 web hits are the chat surface's *design mockups*
      (`board-light.png`, `dev-chat-ui.tsx`'s own `function Board()`, `brand/marks/character.ts`),
      plus `dashboard`/`keyboard`/`onboarding` noise and `session-tile/mock.ts:203-208` demo strings.
      A blind delete here removes the design system.

**Keep-list — asserted, not assumed:**

- [x] `web/tests/unit/board-removal-keeplist.test.ts` (or a Rust equivalent, whichever is cheaper):
      parse `server/src/board/mod.rs` + `boards.rs` + `hook.rs` and assert **every** route from §0.2 is
      still registered, including the public `/api/calendar.ics`; assert
      `server/src/agents/supermux-task.md` matches its pre-B2 hash; assert `teams/board_sync.rs`,
      `board/dispatch.rs`, `board/claim.rs`, `board/prefix.rs` still exist; assert
      `stores/board-create-session-store.ts` still exports `useLastActiveSession` and still uses the
      key `supermux:board-create-last-session`. **"The API stays" is a test, not a sentence.**
- [x] Zero `server/src` deletions. Zero migration edits. `server/tests/board*.rs` green, unedited.

**Verify**: the gate spec passes; `bun run build` + `bun run lint` clean; `cargo check` + `cargo test`
clean; `bun run build:perf` shows the entry chunk **down**; manual pass: `/board` redirects, nav shows
four items, ⌘K has no board verbs, a linked issue is reachable from its session and from its team, and
all five `/api/hook/board/*` endpoints still answer (curl them with a real hook token).

---

### T12 — Integration gate, VR sweep, perf, PR

- [x] Full VR sweep on the offline rig, **both themes**, DPR 1: `/dev/roster`, `/dev/marks`,
      `/dev/tiles`, `/?mock` at tiers 1–4, the focus strip, the display surface, the issue surface,
      plus the mobile pass via `playwright.mobile.config.ts`. Diff against T1's baselines; every
      intentional diff is annotated in the PR body, every unintentional one is a bug.
- [x] Reduced-motion sweep: rollup, facepile morph, row arrival, all six mark states — each legible as
      a still.
- [x] `bun run test:unit` · `bun run lint` · `bun run build` · `bun run build:perf` (report the net:
      T2–T10 add, T11 removes ~3.5 k lines from the entry chunk) · `cargo check` · `cargo test`
      (debug) · all three Playwright configs' relevant specs.
- [x] `BRAND.md` carries the fact-ladder table and the attention-tier vocabulary (§18's
      "vocabulary drift" mitigation), and `ARCHITECTURE.md` describes the new issue surface.
- [x] Kill-switches on the two risky visuals, PR-#27 pattern:
      `localStorage['supermux:roster-marks'] === '0'` → tiles/rows fall back to `StatusDot`;
      `localStorage['supermux:attention'] === '0'` → tiers collapse to today's behaviour. Documented
      in the PR body and `BRAND.md`. Everything else is **flag-free** (additive).
- [x] PR from the worktree; **never auto-merge** (memory *user-reviews-all-merges*). Body carries: the
      four task-changing audit rows, the delete/keep lists, the gate evidence, the grep verdict table,
      the perf delta, and the kill-switch names.

---

## 3. Constraints, restated as checkable rules

1. **The mark engine is a dependency, not a canvas.** `brand/marks/*` is not edited. C5 holds: no
   rings, no notches, no overpainting — the eyes carry state.
2. **Every row has a tier, whatever its provider, host or team-ness.** `attention.ts` has no
   `undefined` return path.
3. **No wrong numbers.** An unread *count* renders only when the epoch matches; otherwise a dot.
4. **`chat_tail` absent ≠ empty**, and its presence is never a liveness signal.
5. **Nothing is removed without its replacement in the same PR** (§18). T11's gate is executable.
6. **The board API, its public iCal route, its hook edge, `supermux-task` and `board_sync` are
   untouched** — and a test says so.
7. **No `server/migrations/*` edit.** One new append-only migration (`0025`), for `mark_pin` only.
8. **Seen-cursors never go in the prefs blob**; the group sort rides the blob that already exists.
9. **A5 owns the preview slot; B1 owns the shell, header grammar and NAV.** B2 consumes them and
   leaves a `// A5-SEAM` / `// B1-SEAM` comment wherever it anticipates an unmerged parent.
10. **Every new surface gets a `data-vr` hook** (`ARCHITECTURE.md:160`).
11. **Anything edited under `components/chat/**` uses relative imports only** — `bun test` resolves
    the root tsconfig with no `paths`, so an `@/…` import there makes the module untestable.
12. **Eligibility has one owner.** `chat/flag.ts::chatEligible` (client) and
    `chat/ws.rs::chat_eligible` (server, `#68`: `!team_name.is_some_and(teams::scan::real_team)`)
    stay the only gates. The attention tiers layer **on top** and never add a fourth gate — an
    ineligible session still gets a tier, from the provider-neutral ladder.
13. Public screenshots from `/?mock` or `/dev/*` only.
14. Repo rules: no release builds; PRs only from a worktree off `origin/main`'s stack; never restart
    `:8824` unasked — dogfood side-by-side on another port.

---

## 4. Risks

| risk | mitigation |
|---|---|
| **Board removal orphans a live capability** (the §18 row) | T11 is gated on an executable three-leg spec; the keep-list is a test including the skill's hash; the API, its public iCal route, the hook edge, `board_sync` and both Rust test files are untouched; `/board` redirects instead of 404-ing; one commit, trivially revertable |
| **A blind board grep deletes the design system** | ~90 `board` hits in `web/src` are the approved *design mockups* (all of `components/chat/**`, `dev-chat-*`, `brand/marks`); `stores/board-create-session-store.ts` is the app-wide last-active-session cell; `use-send-to-agent.ts` is board-only despite its generic name. The grep sweep ships with a per-hit verdict table, and the keep-list test pins the two traps |
| Attention tiers false-positive (the #41/#43 class) | tiers come from `status` + seen-cursor arithmetic on provider-neutral stamps — **no byte heuristics**; the unit suite is written as a false-positive suite; a kill-switch collapses to today |
| Unread built on a signal that isn't there | found in the audit: `chat_tail` exists only while a chat client is attached. The ladder makes `activity_at` primary and `entry_count` opportunistic; a Rust test pins the epoch semantics |
| 40 animated faces arrive on the hero path | B0's one shared rAF + offscreen unregister; T2 asserts loop count and unregistration at roster scale; stills under reduced motion; kill-switch to `StatusDot` |
| Mark duplicates at real session counts | `rosterPins` dedupes app-wide (the thing that was missing); 63 tokens, creation-order stability, and a reroll that only picks free tokens |
| §12.5's "status ring" vs B0's C5 contract | resolved in B0's favour, recorded in the audit table, the fact ladder and BRAND.md |
| The fact ladder silently drops a fact | the ladder's unit test snapshots today's tile-tier-4 set as the union floor; two divergent sets (tile vs row) are reconciled with a per-row rationale; `contextPct` is explicitly deferred, never half-promised |
| Per-group sort move contradicts a documented research finding | the owner asked (§12.6b); it rides the existing `overview_layout` blob (no new key, no new race, no `use-sessions.ts` dispatch edit), localStorage values are migrated not dropped, and the module doc is rewritten so the reversal is legible |
| Group-by presets destroy hand-dragged orders | presets are derived and never write `custom`; the round-trip is unit-tested |
| "One canonical prefs surface" is bigger than it sounds | `OverviewDisplayMenu` is mobile-only; T9 must *build* the desktop half. Budgeted as its own bullet, and the mirrors are thin by construction (one option model in `lib/sort-modes.ts`) |
| T10 is a port that turns into a rewrite | the extraction of `AcceptanceChecklist` + `ReplyComposer` is named as the real work; `board-detail-pane.tsx` moves behaviour-unchanged; the data layer (`use-board.ts`, `lib/api/board*.ts`) is kept whole |
| Scope creep — B2 is the widest fase in Track B | twelve independently verifiable tasks; T11 can be dropped without losing the roster half; T5's server change is three fields on an existing struct |
| Two `attention.ts` files / vocabulary drift | B2's module is `lib/attention-tiers.ts`; A4's `components/chat/attention.ts` keeps its renderer-honesty meaning; both are named in BRAND.md's vocabulary section |
| The delta grows another untyped, unconsumed key | `statusline` is already exactly that (broadcast since A2, no TS type, no consumer). T5's three fields land on the **existing serialized `ChatTail` struct**, get TS types in the same task, and are consumed by `use-attention.ts` in the same PR — or they don't ship |
| Unmerged parents (A5/B1) shift under the branch, and the checkout is stale | **fetch/rebase first** (§0 header: the working tree was 2 commits behind and `use-chat-tail.ts` no longer exists); seam comments; the "if B1/A5 has not merged" branch in T3/T6/T10; the nav deletion keys on `to === '/board'` |

---

## 5. Explicitly out of scope (and where it goes)

- **Roster context %** — the statusline tap (A2) feeds the chat header only; there is no context% on
  any list surface today. §12.1 wants it at high density; it needs a `statuslines` field on the
  sessions delta first. → a follow-up, named in the fact ladder as a deliberate hole.
- `<EntityPicker>` consolidation, palette navigation commands, the shortcut cheatsheet, transcript
  deep-link search → **B3**. B2 only guarantees the `board issue` navigation target exists.
- System-line entity chips, the delegate `actor` + first-class `delegation` event, `@session`
  composer delegation → **B4**. B2's `needs` tier reads an inbound-delegation marker if one exists and
  simply does not fire otherwise.
- Cross-device seen-cursors (`PATCH /api/sessions/{name}/seen`) → **B5**.
- `MemberStatusDot` merging into the mark vocabulary, duplicate-session, delete-honesty + undo,
  per-session notifications, quick-peek → `ResponsiveSheet` → **B5** (§16).
- Board **API** deprecation → master-plan open question #4, after transcript-based reporting has
  replaced `supermux-task` in practice. B2 deliberately does not touch it.
- Renaming `RosterRow` → `SessionIdentityRow` → not worth the churn; the alias is documented.
- Adopting the orphaned `tests/e2e/status-dot-pulse.spec.ts` into a config → optional; if T4 changes
  what it asserts, delete it and say so.
- **A typed Rust struct for the sessions delta** (thirteen hand-built `json!` sites across
  `auto_actions.rs`, `hooks.rs`, `lifecycle.rs`, `chat/statusline.rs`) → a standalone follow-up. B2
  adds no new `json!` site, so it neither helps nor worsens the situation.
- **The dark `statusline` delta key** (broadcast since A2, no TS type, no consumer) → whoever adds
  roster context% picks it up; B2 records it as the precedent to avoid, not as work.
- **Keeping tailers warm for unattached sessions** so `chat_tail` is roster-wide → explicitly *not*
  done. It would put a notify watcher and a 500-entry ring behind every session on the overview; the
  provider-neutral ladder exists precisely so we don't have to.
