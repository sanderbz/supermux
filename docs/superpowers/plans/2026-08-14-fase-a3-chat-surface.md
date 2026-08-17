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

# Fase A3 — The chat surface (rebuild ChatPanel on the B0 design system)

**Worktree** `/opt/projects/supermux-a3` · **branch** `feat/a3-chat-surface`, stacked on
`feat/b0-design-system` (both currently at `f742baa`; nothing of A3 is written yet).
**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` (lives on the
unmerged branch `docs/grok-ui-plan` — read it with
`git show docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`).
**Visual contract** the approved boards: `board-light.png`, `board-dark.png`,
`board-patch-focused.png`, `mobile-light.png`, `mobile-dark.png`.

> One sentence of scope: **A1 shipped the behaviour, B0 shipped the pixels, A3 is the wiring
> between them.** Every A1 module that decides *what is true* (`entries.ts`, `provisional.ts`,
> `latency.ts`, `use-chat-tail.ts`, `use-receipt-overlay.ts`, `flag.ts`) is frozen; every A1
> component that decides *what it looks like* is replaced by a composition of
> `components/chat/ui/*`. Still read-only — no sending, no dialog answering (that is A4).

---

## 0. What already exists (the building material — read before writing code)

### 0.1 Frozen behavioural layer (A1) — change only if a test forces it

| file | owns | do not touch |
|---|---|---|
| `web/src/components/chat/entries.ts` | wire→display model, receipt collapsing, `RECEIPT_CAP=30`, `formatElapsed`, `stripEmojiPrefix`, `newestAgentTs` | pure, tested by `chat-entries.test.ts` |
| `web/src/components/chat/provisional.ts` | pty capture → provisional lines heuristic | `chat-provisional.test.ts` |
| `web/src/components/chat/latency.ts` | server-clock skew, `serverNowMs()`, hook→UI p50 | `chat-latency.test.ts` |
| `web/src/components/chat/use-chat-tail.ts` | `/recall?chat=true` poll + SSE debounce | — |
| `web/src/components/chat/use-receipt-overlay.ts` | live hook receipts, discard-and-replace prune | — |
| `web/src/components/chat/flag.ts` + `use-chat-renderer.ts` | eligibility + kill switch | `chat-flag.test.ts` |

The turn state machine currently inside `chat-panel.tsx` (turn anchor priority, supersede gate,
`TURN_CONFIRM_TIMEOUT_MS`, the 1s live ticker, `PROVISIONAL_LAG_MS`) is **behaviour, not
presentation** — it moves verbatim into `use-chat-turn.ts` (T1) with its comments intact. No
constant changes value in A3.

### 0.2 B0 primitives (`web/src/components/chat/ui/`, all presentational, all benched at `/dev/chat-ui`)

`MessageRow` (gutter+content row grammar, `me`/`grouped`), `Bubble` (`assistant|user`,
`padding text|list`, `surface desktop|phone`), `BubbleCode`/`CodeAdd`/`CodeDel`, `PathRef`,
`ReceiptGroup` (+ pure `coalesceReceipts`, `capReceipts`), `ChoiceCard`/`InlineCode`,
`CapturedFrameCard`, `DelegationPill`, `Facepile`/`FaceName`/`ArrivalDivider`,
`SystemLine`/`SystemSep`/`SystemEntity`/`MentionChip`, `WorkingRow` (`row|presence`),
`Composer`, `RosterRow`, `Dots`, icons, `metrics.ts` (`BUBBLE_MAX`, `MARK_SIZE`, `PHONE`,
`CAPTURED_FRAME`, `RECEIPT_DEFAULT_MAX`), `accent-ink.ts`.

Two facts that shape the whole rebuild:

1. **`ui/working-row.tsx` and `chat/working-row.tsx` are two files with one name and one job
   each** — the B0 one decides what it looks like, the A1 one decides what it says. A3 makes the
   second render the first. Same pattern for the provisional tail.
2. **`Bubble` takes `children`, on purpose** — markdown is explicitly *not* in B0 (see its header
   comment). A3 owns the `variant="chat"` component map.

### 0.3 Design tokens already landed

`web/src/styles/globals.css`: warm paper/ink/hairline ladder mapped into the Tailwind namespace
(`bg-paper`, `bg-bubble-agent`, `text-ink-2`, `border-hairline`, `bg-code-bg`, …), the
`sm-accent-row|wash|chip` utilities, `--sm-accent` (default = brand amber) and the C7 note
explaining why the derived surfaces are utilities and not `:root` variables.
`web/src/brand/tokens.ts` holds `PAPER[theme]` and the accent contract; `@/brand/marks` exports
`SessionMark`, `characterFromSeed`, `bodyColor`, `accentInk`, `VIEWBOX`, `MarkPin`.

### 0.4 Boards → primitive map (what the screenshots actually contain)

Reading `board-light.png` top to bottom: captured frame + caption inside an assistant bubble →
receipt bubble (`✓ cargo check → clean · 0 errors`) → centred delegation pill
(`[●] ••• asking Patch… [●]`) → arrival divider (`Messages from ●Patch and ●Quill`) → assistant
bubble with two inline mention chips → right-aligned user bubble → system line
(`Created schedule · Nightly release watch`) → assistant bubble → choice card → composer.
`board-patch-focused.png` adds: bubble containing `BubbleCode` with a `−/+` diff, a `PathRef`
inside prose, the presence variant of the working row (`Typing…`, indented 44px, no mark), and
proves the accent mechanism — the same screen re-skinned to Patch's teal (roster row wash,
composer focus ring, choice selection), while every status affordance stays in the status family.
`mobile-*.png` uses `PHONE` metrics: no roster, floating 60px glass header inset 12px, both
bubble ceilings narrowed (266/250), composer at `size="mobile"`.

**Dark boards are not inverted light boards**: same layout, `PAPER.dark` ladder, user bubble goes
*light-on-dark* (`--sm-bubble-user` flips), agent bubble stays a warm neutral, no shadow
(`--sm-bubble-shadow: none` in dark). All of that is already in the tokens — A3 must simply not
hard-code a single colour.

---

## 1. Deliverables

```
web/src/components/chat/
  chat-panel.tsx            REWRITTEN — container: hooks + state, renders <ChatSurface>
  chat-surface.tsx          NEW — presentational surface (props in, pixels out)
  transcript-item.tsx       NEW — one display item → primitives
  use-chat-turn.ts          NEW — the A1 turn machine, lifted verbatim out of chat-panel
  grouping.ts               NEW (pure) — speaker runs, receipts-first ordering, dividers
  frames.ts                 NEW (pure) — which tool results deserve a CapturedFrameCard
  scroll-anchor.ts          NEW (pure) — follow-bottom + prepend-restore arithmetic
  use-follow-bottom.ts      NEW — the DOM half of the above (ResizeObserver re-anchor)
  session-accent.ts         NEW — seed → { --sm-accent, --sm-session-tint } style object
  header-pill.tsx           NEW — fixed-height slot + crossfading inner
  markdown/chat-markdown.tsx     NEW (lazy chunk) — react-markdown + chat component map
  markdown/chat-components.tsx   NEW — the compact map (headings/lists/code chips)
  working-row.tsx           RESKINNED — same data, renders ui/WorkingRow
  provisional-tail.tsx      RESKINNED — same poll, renders the P13 unconfirmed block
  renderer-switch.tsx       RESKINNED — approved segmented control
web/src/routes/
  dev-chat-live.tsx         NEW — /dev/chat-live?mock, renders the REAL ChatPanel
  dev-chat-live.fixture.ts  NEW — six scenarios × desktop/phone × light/dark
  dev-chat-live.transport.ts NEW — dev-only fetch/EventSource shim feeding the fixtures
web/src/App.tsx             +1 lazy dev route (mirrors /dev/chat-ui)
web/tests/unit/
  chat-grouping.test.ts  chat-frames.test.ts  chat-scroll-anchor.test.ts
  chat-surface.test.tsx  chat-accent.test.ts  dev-chat-live-fixture.test.ts
```

Nothing outside `components/chat/**`, `routes/dev-chat-live*`, `App.tsx` and `tests/unit/**`
changes. `desktop-split.tsx` keeps its existing `<ChatPanel name session />` call site — the props
do not change, so A5's 3-way switch work is unaffected.

---

## 2. Tasks

Each task is TDD where there is anything to assert: pure module + `bun test` first, then the
component that consumes it. Every task ends green on `bun run test:unit` and `bun run lint`.

### T1 — Lift the turn machine out of the panel (no visual change)

**Why first:** it makes the rest of A3 a pure-presentation diff, and it is the change most likely
to break the A1 regression net — so it lands alone, verifiable.

1. `use-chat-turn.ts` exports `useChatTurn(name, session)` returning
   `{ entries, items, turnStart, liveLayerUp, showProvisional, overlay, tail }`. Move the anchor
   effect, the supersede gate, the teardown, the zero-debounce turn-end refetch, the 1s ticker and
   the three constants **with their comments verbatim**. The eslint disable comments move too —
   they document why each `setState`-in-effect is an external-system edge.
2. `chat-panel.tsx` temporarily becomes `const t = useChatTurn(...)` + the existing markup.
3. **Verify:** `bun run test:unit` green, `bun run lint` clean, and a manual side-by-side on the
   dogfood instance shows an identical panel.

*DoD:* zero behavioural diff; `git diff` shows moves, not edits.

### T2 — Per-session accent wiring (`session-accent.ts`)

The mechanism the Patch board proves: one property write re-skins the surface.

1. `sessionAccentVars(seed, pin?)` → `{ '--sm-accent': bodyColor(characterFromSeed(seed, pin)),
   '--sm-session-tint': <same> }` as `CSSProperties`.
   *Naming reconciliation:* B0 shipped `--sm-accent` and the master plan §11.3 calls the side-pane
   variable `--sm-session-tint`. A3 writes **both, from one derivation**, so the `--sm-session-*`
   family is real for §11.3/B1 without forking the existing `sm-accent-*` utilities. Documented in
   the file header.
2. Applied on the **chat surface root** (`<ChatSurface>`'s outermost div) and on the header pill —
   never on `:root`, never on a status affordance.
3. Marks/mention chips keep publishing their *own* pigment via `accentInkVarsForSeed` (a chip that
   names another session must not inherit the focused one) — that is why accent-ink exists.
4. Pins: the wire has no `mark_*` columns today, so `seed = session.name` (the immutable slug,
   never `display_name` — a rename must not change a face) and `pin = undefined`. One TODO comment
   pointing at §10 for when the columns land.

**Tests** (`chat-accent.test.ts`): two different names yield two different `--sm-accent`; the same
name is stable; `display_name` does not participate; rendering `<ChatSurface>` with a session whose
status is `error` emits no `var(--sm-accent)` inside any status element (the C7 guard — assert on
`renderToStaticMarkup` output that the status badge markup contains `--status-` and not
`--sm-accent`).

*DoD:* switching sessions in the real app re-skins composer focus ring + selected choice + wash,
and the status dot is unmoved.

### T3 — Transcript: confirmed entries as primitives

`grouping.ts` (pure) first:

- `groupItems(items: ChatItem[]): GroupedItem[]` — annotates each display item with
  `{ grouped: boolean, showGutter: boolean }` per §4.2 P2 (consecutive same-speaker runs stack at
  8px, only the first carries the 28px mark).
- `receiptsFirst(items)` — within one confirming batch (items sharing a `ts` second, or contiguous
  agent items with no user item between), a `receipts` item sorts **before** the trailing
  `assistant` prose. The master plan's explicit ordering rule: closing text is never the first
  thing to appear.
- `dayDividers(items)` — a `SystemLine` divider at session-block starts (§5.3). Relative-time
  labels recomputed on the existing 1s ticker; no new interval.

`frames.ts` (pure):

- `frameFor(line: ReceiptLine): { caption: string; path?: string } | null` — a tool receipt earns a
  `CapturedFrameCard` only when it names an image artefact: `Read`/`Write`/`screenshot`-shaped
  labels ending `.png|.jpg|.jpeg|.webp|.gif`, or a `result` containing such a path. Conservative by
  construction — a false positive costs a 340px card in the middle of a turn.
- The card's `src` uses `filesApi.rawUrl(path)` when the path is absolute; otherwise no `src` and
  the honest warm placeholder renders (B0's documented behaviour). `onOpen` is left undefined in
  A3 (the file-viewer deep link is A4).

`transcript-item.tsx` renders one grouped item:

| item | rendering |
|---|---|
| `user` | `<MessageRow me><Bubble variant="user">` — `badge` becomes a leading `SystemEntity`-weight chip, never an emoji |
| `assistant` | `<MessageRow gutter={<SessionMark size={MARK_SIZE.gutter} …/>}><Bubble>` + markdown (T5) |
| `receipts` | `<MessageRow gutter=…><ReceiptGroup rows max={RECEIPT_DEFAULT_MAX}/>` — `ChatItem.lines → Receipt{tool,outcome}` via `stripEmojiPrefix(label)` for the tool and `result` for the outcome; `ok === false` renders through the existing `state`/glyph slot, **not** a red bubble; `overflow > 0` feeds the "Show all N" affordance (local `useState` expand, no refetch) |
| receipts containing a frame | the `ReceiptGroup` followed by `<CapturedFrameCard>` inside the same row, `width={CAPTURED_FRAME.width}` desktop / `266` phone |
| delegation arrival | `<ArrivalDivider>` + `FaceName`s, when an entry's kind marks a teammate handoff (`kind === 'teammate'` / badge) — the receiving end; the sending end (`DelegationPill`) renders from the live layer in T4 |
| system-ish entries | `<SystemLine>` with `SystemEntity` for the named thing |

Mention chips: prose that contains a known session name renders `<MentionChip>` **only for names
present in the sessions list** (pass a `Set<string>` down from the panel; no regex over arbitrary
words), applied post-markdown at the text-node level in the component map (T5).

**Tests** (`chat-grouping.test.ts`, `chat-frames.test.ts`): run grammar, receipts-first ordering,
divider placement, image detection incl. the negatives (`notes.md`, `chart.png.bak`, a bare
`Read` with no path).

*DoD:* `/dev/chat-ui`'s board half and the new `/dev/chat-live` idle scenario are visually
interchangeable at the same width.

### T4 — The live layer (P12 working row, hook receipts, P13 tail, choice card)

Order on screen, top to bottom, is the A1 order and does not change: **confirmed content →
permission → overlay receipts → working row → provisional text**.

1. `working-row.tsx`: same props (`activity`, `subagents`, `turnStartMs`), same 1s tick and
   `serverNowMs()` elapsed; renders `ui/WorkingRow` with `seed`, `label =
   stripEmojiPrefix(activity) ?? 'Thinking…'`, the `· N subagents` clause preserved, and
   `elapsed = formatElapsed(...)` shown only past 5s (§4.2 P12 state ladder: 0s bare, 5s elapsed,
   30s unchanged, >120s is the stranded-turn timeout that already exists).
2. Overlay receipts (`useReceiptOverlay`) render as a `ReceiptGroup` whose **last line is
   `state: 'running'`** — the spinner sits in the same slot the check will occupy, so the confirmed
   batch replacing it costs zero reflow. This is what makes the supersede invisible.
3. `provisional-tail.tsx`: same 1s `peekAnsi` poll and `extractProvisionalTail`; the block becomes
   an assistant `Bubble` at reduced emphasis — hairline-soft dashed edge, `text-ink-2`, a 12.6px
   `SystemLine`-weight caption `Live terminal · unconfirmed`, ANSI spans preserved via
   `parseAnsiLine`. It sits in the gutter grammar (`MessageRow` with the session mark) so the
   confirmed bubble that replaces it lands on the same left edge.
4. Delegation *out*: when `session.activity_kind === 'task'` or the activity names another known
   session, render `<DelegationPill from={name} to={target}/>` instead of the plain working row.
   Guard on the known-sessions set; fall back to the working row.
5. Permission → `<ChoiceCard>` (visual only, A4 wires answers):
   `question = Run <InlineCode>{tool}</InlineCode>?` built from `permission_request.tool` +
   `stripEmojiPrefix(summary)`, `why` = the session's `dir` + mode, options = the registry's three
   (`Allow once` primary / `Allow while this session runs` / `Not now`) with `kbd` 1-3,
   `selectedIndex` undefined, `onChoose` undefined and a single quiet line under the card:
   *answer in the terminal* — the A1 honesty string, kept because A3 still cannot send keys.
   **Never render `permission_request` as an object** (the A1 comment stays).
6. Motion (all from `lib/springs.ts`, all with reduced-motion twins via `useReducedMotion`):
   working row arrival `springs.cardExpand`; provisional→confirmed swap = the §11.6 same-cell
   crossfade (`display:grid`, both children in `1/1`, 260ms opacity) so there is no height jump;
   receipt line running→done uses the existing CSS spinner→check swap (no framer). Reduced motion:
   opacity-only, no transform, no `layout` prop.

**Tests** (`chat-surface.test.tsx`, `renderToStaticMarkup`): the five live-layer permutations
render in the documented order; the permission card never stringifies the wire object; the working
row shows no elapsed clause under 5s and one after; overlay's last line carries `data-state=running`.

*DoD:* checkpoint (b) of the A1 dogfood ("mid-turn the user can tell what the agent is doing") is
served by the design, not by a monospace line.

### T5 — Markdown for assistant prose (lazy, chat-tuned)

No new deps: `react-markdown`, `remark-gfm`, `rehype-highlight`, `lowlight` are already
dependencies and already split into the `vendor-markdown` chunk by `vite.config.ts` (the
`manualChunks` regex covers the whole unified/remark/rehype stack).

1. `markdown/chat-components.tsx` — the `variant="chat"` map required by §4.2 P2, deliberately
   *not* `markdown-viewer.tsx`'s document styles: `h1-h3` → 15px/600 with 10px top margin (a chat
   heading is a sentence, not a chapter), `p` → the bubble's own 15/1.45 with 8px between
   paragraphs, `ul/ol` → 18px indent + 3px between items, `li` markers in `text-ink-3`,
   `code` inline → the `InlineCode` chip (JetBrainsMono 13.2 on `--sm-fill-soft`, radius 8),
   `pre` → `BubbleCode`, `a` → accent-ink underline-on-hover, `table` → hairline grid that scrolls
   in its own `overflow-x:auto` box, `img` → `CapturedFrameCard` at bubble width, `hr` → hairline.
   Text nodes pass through the mention-chip pass from T3.
2. `markdown/chat-markdown.tsx` is the only module importing `react-markdown`; it is reached
   exclusively through `React.lazy(() => import('./markdown/chat-markdown'))` inside
   `transcript-item.tsx`.
3. **The fallback is load-bearing**: while the chunk is in flight the bubble renders the raw text
   with `whitespace-pre-wrap` at the *same* type metrics, so the swap changes glyph styling and
   never the block height → no scroll jump. `Suspense` boundary is per-bubble.
4. `rehype-highlight` is opt-in per fence (only when a language is declared) — the whole point of
   the lazy split is that a text-only turn never pays for lowlight.

**Tests:** `chat-surface.test.tsx` asserts the static (fallback) render contains the prose and no
`react-markdown` import escapes into the entry graph; the perf gate below is the real assertion.

*DoD:* `bun run build:perf` shows the app JS delta and `dist/assets` still contains a separate
`vendor-markdown-*.js` that no entry chunk imports statically.

### T6 — Session header pill + renderer switch

1. `header-pill.tsx`: a `relative` slot with `min-h-[--sm-toolbar-min-h]` + `pt-safe`
   (**a floor plus additive inset, never a fixed height** — the documented safe-area contract in
   `globals.css`), containing an `inset-0` absolutely-positioned inner: `SessionMark` 28px ·
   display name 15/600 · status via the existing `StatusDot`/status family · mode chip. The inner
   is keyed on `name` and crossfades with the §11.6 `.sm-swap` grid technique — session switches
   and status morphs cost zero layout shift.
2. Accent: the pill carries `sessionAccentVars` and may use `sm-accent-wash`; the status badge may
   not (C7 test in T2).
3. `renderer-switch.tsx` restyled to the approved language: hairline pill, `h-[30px]`, 13.4/500
   labels, the selected cell a `bg-fill-soft-2` capsule that morphs with `springs.snappy` +
   reduced-motion twin, `role="tablist"` and the `data-testid="renderer-chat|terminal"` hooks kept
   (existing e2e depends on them).
4. `desktop-split.tsx` is **not** restructured in A3 — the pill mounts inside `ChatSurface`'s own
   top slot, so the terminal renderer keeps today's `DesktopFocusHeader` untouched. Unifying the
   two headers is Track B / B1, and doing it here would put a Track B diff in a Track A PR.

*DoD:* switching sessions with `Chat` active shows no vertical shift anywhere (record the bench,
compare first and last frame).

### T7 — Scroll behaviour

`scroll-anchor.ts` (pure, testable without a DOM):

- `isPinned({scrollHeight, scrollTop, clientHeight}, threshold = 48)` — the A1 rule, extracted.
- `restoreScrollTop(prevHeight, nextHeight, prevTop)` — backlog prepend keeps the viewport still by
  adding the `scrollHeight` delta.
- `shouldAutoScroll(pinned, reason)` where reason ∈ `append | grow | prepend` — `prepend` never
  auto-scrolls, `grow` scrolls only while pinned (that is "no jump while a bubble grows").

`use-follow-bottom.ts` wires it: a `ResizeObserver` on the content wrapper (so a growing bubble or
a markdown chunk landing re-anchors instead of jumping), the `onScroll` pin update, and a
`useLayoutEffect` prepend restore keyed on the first item's `uuid`. Adds the master plan's
**scroll-to-bottom pill** (44pt hit target, bottom-centre above the composer slot, appears when
unpinned, `springs.snappy`).

**Tests** (`chat-scroll-anchor.test.ts`): threshold boundary at exactly 48, prepend restore
arithmetic, `shouldAutoScroll` truth table.

*DoD:* on the bench, scrolling up during a live turn leaves the viewport still while the working
row ticks; the pill appears; tapping it returns to bottom.

### T8 — `/dev/chat-live?mock` (the bench the screenshots come from)

**Constraint that shapes the design:** the bench must render the *real* `ChatPanel`, and
`ChatPanel` talks to react-query, SSE and `/peek`. So the fixtures are installed at the **network
boundary**, not injected as props — the wiring gets benched too, and zero mock code reaches a
production chunk (dev-only lazy route, same gating as `/dev/chat-ui` and `/dev/marks`).

1. `dev-chat-live.transport.ts` (dev-only): installs a `window.fetch` shim answering
   `GET /api/sessions/:name/recall?chat=true` (fixture entries), `GET …/peek?ansi=1` (fixture pty
   capture) and `/api/file/raw` (a 1×1 data URI), plus a no-op `EventSource` stub so `useSse`
   neither reconnects nor spams. It is installed **before** the panel mounts and torn down on
   unmount.
2. `dev-chat-live.fixture.ts`: six scenarios, each `{ session: TileSession, entries: RecallEntry[],
   capture?: string }`, reusing `dev-chat-ui.fixture.ts`'s cast (same seven names, same pins — one
   cast for the whole design system, per that file's own rule):
   - **idle** — the board's finished conversation (frame + receipts + arrival + mentions + system
     line + user bubble), status `idle`.
   - **mid-turn** — status `active`, `last_send_at` 12s ago, `activity`/`activity_at` set,
     `subagents: 3` → working row with elapsed + overlay receipts with a running line.
   - **provisional** — status `active`, last confirmed entry 40s old + a pty capture → P13 block
     visible under the working row.
   - **permission** — `permission_request: { tool: 'Bash', summary: 'cargo publish --dry-run',
     kind: 'bash' }` → choice card.
   - **delegation** — arrival divider + mention chips confirmed, plus an in-flight
     `activity_kind: 'task'` naming Patch → delegation pill.
   - **error** — `error: { type: 'StopFailure', … }` + a failed receipt line + the tail request
     failing → the "Couldn't load this conversation" state, in the approved language.
3. Page shell: query params `?scenario=&surface=desktop|phone&theme=light|dark` (default: all
   scenarios stacked, both themes, desktop + phone side by side), each cell a `[data-theme]`
   subtree exactly as `/dev/chat-ui` does it, phone cells sized with `PHONE` metrics.
   `data-bench="<scenario>-<surface>-<theme>"` on every cell — that is what the screenshot rig
   crops on.
4. Route registered in `App.tsx` next to `/dev/chat-ui`, behind the same `import.meta.env.DEV`
   guard.

**Tests** (`dev-chat-live-fixture.test.ts`): every scenario's entries parse through `toDisplayList`
without throwing; the mid-turn fixture's `activity_at` is inside the anchor window (else the bench
lies about the working row); the cast agrees with `dev-chat-ui.fixture.ts`.

*DoD:* `bun run dev` → `/dev/chat-live?mock` shows 24 cells; the offline mobile screenshot rig
(memory: *Offline mobile UI review rig*) can shoot them without a server.

### T9 — Verification, budget and the regression net

Run, in this order, and paste real output into the PR body (no claim without evidence):

```
cd /opt/projects/supermux-a3/web
bun run lint
bun run test:unit          # A1 + B0 + the six new files, all green
bun run build:perf         # budget gate: app JS ≤ 200 KB gz (baseline 158.40)
```

Budget rule for A3: **app JS must stay under 170 KB gz** (≈ +11.6 KB of headroom against the
158.40 baseline). If T5's map or the bench leaks into the entry chunk the number will jump by
~40 KB — that is the tripwire, and the fix is the lazy boundary, never raising the budget.
`vendor-markdown` growing is fine; it is a separate chunk on a lazy path.

Then the visual pass: `/dev/chat-ui` (B0 parity, must be unchanged — A3 touches no primitive) and
`/dev/chat-live` in both themes at both surfaces, held next to the five board PNGs.

Finally, dogfood side-by-side on **another port** (never restart the instance hosting the chat —
see memory *Never restart this instance unasked*): flag on, one real Claude session, watch one full
turn from send → working row → receipts → supersede → confirmed bubbles.

### T10 — PR

One PR, `feat/a3-chat-surface` → `feat/b0-design-system` (keep the stack; the owner merges B0
first). Body: the six scenario screenshots × 2 themes, the perf table, the test output, and an
explicit list of *behavioural* diffs (should be exactly: none, plus the scroll-to-bottom pill and
the choice-card presentation of a permission that A1 showed as a text row). Hand off — never
self-merge (memory: *User reviews all merges*).

---

## 3. Constraints, restated as checkable rules

| rule | how it is checked |
|---|---|
| no new deps | `git diff web/package.json` is empty |
| perf budget | `bun run build:perf` ≤ 170 KB gz app JS |
| markdown out of the hero chunk | `dist/assets` has `vendor-markdown-*`; no entry chunk references it statically |
| motion only from `springs.ts` | grep the diff for `cubic-bezier(` and `transition: all` — the only allowed literals are the ones B0 already ships inside `ui/` |
| reduced-motion twin for every motion | `useReducedMotion()` guard beside each `motion.*` |
| A1 tests are the net | `chat-entries`, `chat-provisional`, `chat-latency`, `chat-flag` untouched and green |
| accent never on status | the C7 test in T2 |
| no colour literals | new files contain no `#rrggbb` (B0 tokens only); the one sanctioned exception already lives in `metrics.ts` (`ATTENTION_DOT`) |
| read-only still | no `sessionsApi.send`, no key sending, no `POST /mode` anywhere in the diff |

---

## 4. Risks

1. **Supersede flicker becomes visible now that content is styled.** A1's neutral text hid it. The
   mitigation is structural: the provisional block and the confirmed bubble use the same row
   grammar, the same bubble metrics and the same-cell crossfade, so the swap is an opacity change
   inside a stable box. If it still jumps, the fallback is to hold the provisional block's measured
   height for one frame after the batch lands (`useLayoutEffect` + explicit `min-height`), which is
   presentation-only and does not touch `provisional.ts`.
2. **Markdown re-layout jump.** Mitigated by the same-metrics fallback (T5.3). Watch it on the
   `provisional` bench cell, which is the worst case (long prose, lazy chunk, live ticker).
3. **`toDisplayList` collapses tool runs that the boards show as separate groups.** A1 collapses
   *all* contiguous `tool_use` entries into one receipts item with `RECEIPT_CAP=30` + overflow;
   the boards show 3-line groups. That is fine (fixtures are short), but do not "fix" it by editing
   `entries.ts` — the cap and the overflow are tested behaviour. Presentation splits at
   `RECEIPT_DEFAULT_MAX` via `capReceipts`.
4. **Bench transport drift.** A fetch shim can pass while the real wire shape changed. Guard: the
   fixture test types every fixture as the real `RecallResponse`/`TileSession`, so a wire change
   breaks the build.
5. **Two `WorkingRow`s / two `ProvisionalTail`s.** Import confusion is the likeliest silent bug.
   Rule: `components/chat/*` imports from `components/chat/ui` and never the reverse; the file
   headers already say so.
6. **Stacked branch churn.** B0 may take review edits. Rebase `feat/a3-chat-surface` on
   `feat/b0-design-system` before opening the PR, never merge main into it.

---

## 5. Explicitly out of scope (A4+)

Sending, the composer's real input plane (Enter/Shift+Enter, `@files`, `/commands`, Stop-replaces-
Send), answering choice cards, the P10 optimistic echo + delivery watchdog, the Attention card and
its ANSI mini-view, the changes rail, context%/cost in the header, mounted-but-hidden renderer
retention and the mobile focus call site (A5), the tile chat tail, the default flip (A7). The
composer in A3 renders as B0's visual shell with the honest read-only affordance underneath —
exactly what A1 promised, wearing the approved clothes.
