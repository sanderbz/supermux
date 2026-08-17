# supermux — Brand, Voice & Microcopy

The single source of truth for what supermux *is called*, how it *sounds*, what it
*looks like*, and the words it puts on screen. The rest of the app consumes the
constants in this folder; this doc explains the why.

> supermux is "BE in tmux, via web" — not a dashboard that *shows you info about*
> tmux. Everything below serves that: the product is a tool for builders, so it
> talks, looks, and sounds like a tool, not a SaaS landing page.

---

## 1. Name & wordmark

- **App name**: `supermux` — always lowercase, even at the start of a sentence.
  Never "Supermux", "SUPERMUX", or "suPermux". It's a tool name like `tmux` / `htmux`.
- **No tagline in chrome.** The product is the pitch. If a one-liner is ever
  needed (store listing, README): *"Run your agents in tmux, from anywhere."*
- **Never** frame supermux as a "control plane", "command center", "mission
  control", "platform", or "orchestration suite". It's an interface to tmux
  sessions.

## 2. Voice & tone

**Builder-to-builder.** The reader runs agents in tmux and reads stack traces.
Respect that.

| Do | Don't |
|---|---|
| "No sessions yet" | "Welcome! 👋 Let's get started!" |
| "tmux session is gone. Reattach, or remove it from supermux." | "Oops! Something went wrong 😬" |
| "Session started" | "Awesome — your session is live! 🎉" |
| "Kill this session?" | "Are you sure you really want to do this??" |
| Sentence case, calm, terse | UPPERCASE LABELS, exclamation marks, hype |

Rules:

1. **Sentence case everywhere.** Never UPPERCASE labels or button text.
2. **No exclamation marks.** State the fact, then the next action.
3. **No cheerleading interjections.** Banned: **Oops, Whoops, Awesome, Oh no,
   Yay, Uh oh, Great! / Great.** Enforced by `scripts/lint-microcopy.sh`.
4. **Errors are useful.** Name what failed and what to do next. Never just
   "Something went wrong."
5. **No marketing verbs** ("supercharge", "unleash", "effortless").
6. **Emoji**: none in product chrome.

All on-screen strings live in [`copy.ts`](./copy.ts) (`EMPTY`, `ERROR`,
`CONFIRM`, `CONNECTION`, `TOAST`, `MISC`). Import from there — don't inline.

## 3. Color

Two distinct stories: the **mark** (logo / icon / favicon) is blue; the **in-app
accent** that pulses on running sessions is amber. Everything else is a
semantic/system token.

### 3.1 The mark — supermux blue

The mark uses a vertical linear gradient, top → bottom:

| Stop | Hex | Role |
|---|---|---|
| top (`0%`) | `#3da0ff` | lighter sky blue — the highlight side |
| bottom (`100%`) | `#007aff` | deeper system blue — the weight |

Both chevron-banner shapes share this single gradient (`url(#g)` in the SVG), so
the two halves of the mark read as one continuous form. The tile sits on
`#0a0a0a` (matches `--background`), so the gradient glows against near-black at
every size.

This blue is the *logo* color only. It is **not** exposed as `--brand` in the
theme — the in-app accent (FAB, focus rings, "active" pulse) stays amber. The
mark and the in-app accent are two separate signals, deliberately.

### 3.2 In-app tokens

| Token | HSL | Hex | Use |
|---|---|---|---|
| `--brand` | `38 92% 58%` | `#f6ae31` | FAB, focus accent stroke, focus rings, "active" pulse |
| `--status-active` | `38 92% 58%` | `#f6ae31` | running (amber pulse) |
| `--status-waiting` | `214 95% 60%` | `#388cfa` | waiting / "needs input" (calm blue) |
| `--status-ready` | `152 60% 45%` | `#2eb877` | idle-but-alive — calm green "your turn" |
| `--status-error` | `24 90% 56%` | `#f47b2a` | error — **calm orange, never alarmist red** |
| `--status-idle` | `0 0% 45%` | `#737373` | stopped / dim (agent is off) |
| `--background` | `0 0% 4%` | `#0a0a0a` | app background + PWA splash, also the mark tile |

- **"Confident-builder amber"** (`#f6ae31`) is the in-app accent — similar to
  Anthropic amber, slightly warmer. It carries the "Active" pulse story inside
  the product. Exposed as `--brand` (shadcn's `--accent` is the distinct
  semantic hover fill).
- Tokens are bare HSL triples so callers can add alpha:
  `hsl(var(--brand) / 0.5)`.
- The `error` status uses **calm orange**, not red — supermux stays composed.
  (A destructive "missing tile" affordance may still use system red for a hard
  delete; that's a different signal from "the agent errored".)
- TS mirror: [`tokens.ts`](./tokens.ts) (`BRAND`, `*_HSL`, `statusColor()`).
- Every hex above is *exactly* what its HSL triple resolves to, and
  [`tests/unit/brand-tokens.test.ts`](../../tests/unit/brand-tokens.test.ts)
  parses `globals.css` to keep it that way. (`--status-ready` was `#2eaa6e`
  here until that test was written; the CSS always said `#2eb877`.)

### 3.3 The warm paper ladder (B0 design system)

The surface language of the new primary interface. Warm off-white paper, warm
near-black ink, translucent hairlines — a room, not a dashboard. Additive: the
iOS/shadcn semantic palette in §3.2 and `globals.css` is untouched and still
drives every screen that has not migrated yet.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--sm-paper` | `#faf7f4` | `#1a1a18` | the page the app sits on (sidebar, shell) |
| `--sm-paper-raised` | `#fdfbf9` | `#201f1d` | conversation pane — one step up |
| `--sm-surface` | `rgba(255,253,251,.86)` | `rgba(58,54,50,.72)` | raised glass: bars, composer (pair with a backdrop blur) |
| `--sm-bubble-agent` | `#f1ece8` | `#2c2926` | agent bubble — a fixed warm neutral, **never** accent-tinted |
| `--sm-bubble-user` / `-ink` | `#1c1917` / `#f7f3ef` | `#f2ede7` / `#1c1917` | the inverted user bubble |
| `--sm-ink` / `-2` / `-3` | `#1c1917` / `#79716b` / `#a8a09a` | `#f5f1ec` / `#a8a29b` / `#7d766f` | primary / secondary / tertiary type |
| `--sm-hairline` / `-soft` | `rgba(28,20,10,.09)` / `.05` | `rgba(255,246,235,.085)` / `.055` | separators, drawn at `--sm-hairline-w` = **0.5px, never 1px** |
| `--sm-fill-soft` / `-2` | `rgba(28,20,10,.045)` / `.07` | `rgba(255,246,235,.06)` / `.10` | hover / pressed washes |
| `--sm-code-bg` | `rgba(28,20,10,.05)` | `rgba(0,0,0,.30)` | inline + fenced code |
| `--sm-bubble/card-shadow`, `--sm-elev` | — | — | the elevation triple (bubble, card, window) |

- **Theme selection.** `.dark` on `<html>` is the app-wide switch (unchanged);
  `[data-theme='light'|'dark']` is the *subtree* switch, so a dark board can be
  rendered inside a light app. A direct declaration beats an inherited one, so
  the subtree always wins over the ancestor `.dark`.
- **Tailwind namespace.** `bg-paper`, `bg-paper-raised`, `bg-surface`,
  `text-ink`, `text-ink-2`, `border-hairline`, `bg-fill-soft`, … The `--sm-*`
  vars stay the source of truth and stay usable raw (e.g. inside `box-shadow`).
- **Per-session accent (concept contract C7).** `--sm-accent` is the *focused
  session's* identity hue, rewritten on the app shell at runtime by the
  character engine; it defaults to the brand amber when nothing is focused. It
  never encodes status, and the `--status-*` family never uses it. Accent
  surfaces are the utilities `sm-accent-row` (9% light / 12% dark),
  `sm-accent-wash` (6%) and `sm-accent-chip` (14%) — utilities rather than
  derived vars because a custom property containing `var()` is substituted
  where it is *declared*, so a derived var on `:root` could never see a
  per-session accent written further down the tree.
- TS mirror: `PAPER`, `HAIRLINE_W`, `AGENT_ACCENT` in
  [`tokens.ts`](./tokens.ts), guarded by the same parse test.

## 4. Icon & splash

- **Single source**: [`web/public/icon.svg`](../../public/icon.svg) — two filled
  **chevron-banner** shapes stacked vertically, both filled with the same blue
  gradient from §3.1, on a full-bleed `#0a0a0a` tile. Each chevron is a
  forward-pointing banner (prompt-arrow silhouette, like `>` with body and
  flag), and the pair reads as "two terminals, one rail" — a quiet nod to
  multiplexed sessions. The tile is full-bleed so it works as a *maskable* PWA
  tile; all content sits inside the inner safe circle so it survives mask
  rounding, and the silhouette stays legible down to ~32px.
- **Favicon**: [`web/public/favicon.svg`](../../public/favicon.svg) — same
  chevron-banner mark with the same blue gradient, on a rounded-square tile
  (`rx="224"` on the 1024² viewBox, ~22% radius) so it reads at ~16px in a
  browser tab.
- **In-repo logo**: [`web/src/brand/logo.svg`](./logo.svg) — same mark as a
  transparent-background SVG for embedding in chrome / docs.
- **Raster export**: `scripts/build-icons.sh` → `icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png` (180×180). Re-run when `icon.svg` changes.
- **Splash / no white flash**: `--background`, manifest `background_color` +
  `theme_color`, and the `index.html` `theme-color` are all `#0a0a0a` — which
  is also the tile color behind the mark. The first-frame paint equals the
  splash color, so there is no flash of white and the icon visually melts into
  the launching app.

## 5. Sound — the "needs input" cue

- [`web/src/lib/sound.ts`](../lib/sound.ts): a 200ms sine tone sliding 440 → 880
  Hz at 0.15 gain with an exponential ramp out. Reads as a polite "your turn",
  not an alarm.
- **Opt-in.** OFF by default (politeness). Persisted in `localStorage`
  (`supermux.sounds.enabled`). Toggle copy: `MISC.soundsToggleLabel`.
- **Wiring** (SSE handler): call `playNeedsInput()` on a status delta into
  `waiting` — it self-gates on the preference. Call `primeAudio()` from the
  first user gesture so iOS Safari unlocks audio. Bind the Settings switch to
  `getSoundsEnabled()` / `setSoundsEnabled()`.

## 6. Toast

- [`web/src/components/ui/toast.tsx`](../components/ui/toast.tsx): glass capsule,
  36px tall, top-center, slides in from the top with `.smooth(0.35)`
  (`TOAST_SPRING`), auto-dismiss 2.5s, stack max 3, reduced-motion aware.
- Self-contained: drop `<ToastProvider>` near the root, call `useToast()`.
- Feed it copy from `copy.ts` (`TOAST.*`). Tone tints the leading status dot.

## 6b. Session marks — the procedural character engine

A session is a colleague, so it has a face. `web/src/brand/marks/` derives that
face from the session's name — nothing is hand-drawn, nothing is stored.

- **Channels.** 9 silhouettes (6 perspective-projected superellipsoid solids —
  `sphere egg capsule blob cube pebble` — plus 3 authored outlines — `cloud
  wedge rhombus`) × 7 OKLCh-trimmed pigments = **63 identity tokens**. Body
  jitter, head pose, eye size/spacing/tilt, asymmetry, gaze and blink phase are
  seeded on top and are *not* deduped: they are what keeps two same-pigment
  sessions two different people.
- **Dedupe.** `assignRoster(namesInCreationOrder)` probes from each name's own
  hash and takes the cheapest free token (`pair·10000 + silhouette·100 + hue`),
  so a roster of ≤ 63 never repeats a silhouette+pigment pair, and a solo
  session is hash-pure. Deterministic — the server can mirror it and freeze it.
- **State lives in the eyes, and only there.** The silhouette never moves and is
  never overpainted, ringed or notched (concept contract C5):
  `idle` open · `working` narrowed 54 % × 78 %, slanted −26° · `waiting` rounded
  and levelled, plus a micro-saccade · `done` squinted to 30 % height ·
  `stopped` shut to an 11-unit lid line, levelled to 45 % tilt · `failed` the
  only state with a **mirrored** tilt (left +42°, right −42°, tops converging)
  on 62 %-wide slots — a knitted brow.
  The first four are transcribed from the approved boards; `stopped` and
  `failed` are additions, because `SessionStatus` is
  `starting | active | idle | waiting | stopped | error` and a face that IS the
  status indicator must be able to say "asleep" and "fell over". Both reuse the
  existing capsule primitive — no new visual language.
- **Every state is separable in a *still* frame.** This is a hard contract, not
  a nicety: `stopped` originally reused the idle geometry and differed only by
  not animating, which made it invisible to a reduced-motion user and to every
  screenshot. `session-mark.test.tsx` renders all six under
  `prefers-reduced-motion` and asserts six distinct eye paths.
- **Ambient life.** A per-seed blink (period 4.6 / 2.6 / 3.1 s for idle /
  working / waiting, detuned per seed so a roster never blinks in unison) and a
  5.4 s breathe with a per-seed phase. One shared rAF loop drives every face;
  offscreen marks unregister and pause. `done`, `stopped` and `failed` are
  stills — nothing is running, so nothing breathes.
- **Reduced motion** renders the identical face, permanently open and still —
  the eye *geometry* alone carries state, so nothing is lost.
- **Usage.** `<SessionMark seed={session.display_name} size={40} state={…}
  pin={assigned.get(name)} />`; pass `label={null}` wherever the row already
  renders the name. `accentInk(hue, dark)` is the text-capable tier of a
  session's pigment for `--sm-accent` consumers (mention chips, provenance).
- **The bench.** `/dev/marks` (DEV-only, `routes/dev-marks.tsx`) renders the
  whole system on one page: the approved reference strip, the cast at 18/28/40,
  all six states × the cast × the ladder, the full 63-token matrix, the pigment
  ladder with its text tier, a deduped 14-session roster, the facepile keyline
  and a live blink/breathe strip — each in **both** themes via the
  `[data-theme]` subtree switch. Every matrix is a still frame so the page is
  deterministic to screenshot; only the live strip animates. Its coverage (all
  9 silhouettes, all 7 pigments, all 6 states, the whole ladder) is asserted in
  `tests/unit/dev-marks-cast.test.tsx`, so the bench cannot quietly shrink.

## 6c. The chat surface — static primitives

`web/src/components/chat/ui/` is the design system's vocabulary for the
conversation. Presentational only: every component takes props and renders
pixels — none of them fetches, subscribes, sends a key or owns state. The
renderer slices in `components/chat/` keep the data plane.

| Primitive | The numbers that matter |
|---|---|
| `RosterRow` | h64 · gap 12 · pad 0/8 · r12; mark 40; name 14/500 −0.15px; time 12 tabular; preview 13 at +3px. Selected = `sm-accent-row`, hover suppressed while selected. Attention dot 7px + 2px page keyline, **seated from the character's own solid** |
| `Bubble` / `MessageRow` | r18 · 11/17 · 15/1.45 −0.1px · 0.5px hairline-soft · `--sm-bubble-shadow`; agent ≤648 on a **fixed** warm neutral, user ≤420 inverted, edgeless, shadowless; rows 14px apart, 8px when grouped; gutter 32px |
| `ReceiptGroup` | bubble at 14/18; line gap 9, 7px apart; check 13 → tool 600 → arrow 15×12 → outcome 15 tabular. Repeats coalesce (`Read ×12`, outcome dropped unless identical); `max` → "Show all N"; running line keeps the slot with a 2.4s spinner |
| `SystemLine` | centred 13 secondary, 22px of air, −0.05px; entity = weight 500 with a **zero-layout** hover pill (`−1/−5/−1/−3` margins cancelling `1/5/1/3` padding); `MentionChip` = the named session's mark + name in **its** pigment, never a filled tag |
| `WorkingRow` | gutter mark 28 · three-dot wave · label 13 secondary · elapsed tabular right. `variant="presence"` = the same signal with no mark, no dots, indented 44px |
| `DelegationPill` | h46 · pad 0/9 · r-full · `--sm-surface` + hairline + blur(24) sat(160); marks 26 keylined; label 14.5/500 in the **recipient's** pigment |
| `ChoiceCard` | ml 44 · ≤592 · r16 · pad 14/17 · glass blur(30) sat(170) + `--sm-card-shadow`; ask 15/500 −0.15px with mono `InlineCode` 13.2; why 13.2 secondary; buttons h34 · r-full · 13.4/500. **Emphasis is weight + fill, never the hue**; selection = accent 55% edge / 8% fill; digits = the modal registry's mapping |
| `Composer` | h58 (52 phone) · r-full · glass blur(60) sat(180) · hairline · shadow `0 12px 34px −18px`; focus ring = accent 22%, 220ms; mic 40 (36) — the one inverted control |
| `CapturedFrameCard` | 340 wide (266 phone) · 16:10 · r14; caption 12.6 secondary at +7px with a 12px glyph. The one object with depth on a flat surface |
| `Facepile` | cluster = three 18px members at `[11,0] [0,15] [22,15]` in a **40px box** (one mark's footprint), page-coloured keylines; row = −24% overlap, the active member morphs open by animating padding, 400ms |

- **No emoji.** Receipts and captions use monochrome `currentColor` glyphs; the
  `activity_label` emoji taxonomy stays terminal/tile-only.
- **Motion.** Everything here is static or an ambient CSS loop (`.sm-dots` 1.25s
  blip, `.sm-spin` 2.4s, the mark's breathe) — no framer-motion, so nothing to
  source from `lib/springs.ts`; hovers are the 120ms speed. Arrival animations
  are `data-fresh`-gated and belong to the renderer, not to a primitive that
  would then animate the whole backlog.
- **Theme picks.** A presentational component cannot know whether it sits under
  `.dark` or a `[data-theme]` subtree, so the two cases that need a per-theme
  literal — a session's text-tier pigment and the composer's mic — publish both
  values and let `.sm-ink-accent` / `.sm-mic` in `globals.css` choose.
- **Bench**: `/dev/chat-ui` (DEV-only, lazy) renders the approved hero board
  rebuilt out of these components, plus every variant it has no room for, in
  both themes. Hold it next to `board-light.png` / `board-dark.png`. Coverage
  and the board's fixture are asserted in `tests/unit/dev-chat-ui-fixture.test.ts`;
  the load-bearing numbers in `tests/unit/chat-ui-primitives.test.tsx`.
- **Open deviation**: the attention dot is `#e5484d`, the approved render's
  literal, deliberately outside the `--status-*` family (it must survive at 7px
  on all seven pigments). Flagged in `metrics.ts` for owner review.

### 6c.1 The EntityPicker — one list of things to find (B3)

`components/ui/entity-picker.tsx`. Every searchable "find a thing and act on
it" list in the app is this component; there is no second one. It was promoted
out of `components/chat/` because by fase B3 the app had **four** hand-rolled
type-ahead lists, each with its own `(i+1) % len` wrap and its own
`scrollIntoView` — and the newest of them had lost the `scrollIntoView` in the
copy, so arrowing past the fold moved a highlight nobody could see.

**The load-bearing numbers.**

| | value | why |
|---|---|---|
| row gap | `10px` (`gap-2.5`) | |
| row padding | `px-2`, `py-[7px]` desktop | The `px-2` is an INSET: the list keeps `px-1.5`, so the highlight fill floats inside the box instead of running edge to edge. Before B3 it ran edge to edge with no radius. |
| row padding, phone | `py-[13px]` | ≈44pt. **Deviation from §14's single number, deliberate** — HIG's touch target beats a design doc's desktop figure, and a pointer is not doing the aiming on a phone. |
| row radius | `8px` (`rounded-lg`) | |
| icon | `14px` (`size-3.5`), `text-ink-3` | Optional. Chat's rows pass none, which is what preserves the A4 look exactly. |
| max-height, `token` | `min(280px, 46vh)` | It must not cover the transcript it is being written about. |
| max-height, `field` | `min(420px, 60vh)` | **Deviation from §14, deliberate** — §14 gave one number for both anchors, and 280px is right for a composer popover and wrong for a ⌘K spotlight, where six rows would be a regression from what the palette already did. |
| shadow | `--sm-popover-shadow` | **Deviation from §14, deliberate** — §14 specified a cool grey (`#0000000f` / `#00000047`), which reads blue against this paper and fights the whole warm ladder. The token is warm-black in light and a deeper, tighter black in dark, where the popover sits on a surface only a few percent lighter than the paper. It replaced a raw literal duplicated across three call sites, one of them inside a `focus-within:` compound. |

**The two anchors, and the one thing that separates them.**

- `token` — up from an `@`/`/` token in a composer. Draws its own glass and
  shadow, because it floats free over a transcript with nothing behind it.
  **It never takes focus**: the textarea keeps it and carries
  `aria-activedescendant`, because a popover that grabbed focus dismisses the
  soft keyboard on every phone, one character into the query.
- `field` — the parent already drew the box (the ⌘K dialog, a Vaul sheet, the
  scheduler's positioned `motion.div`). Renders a bare list: no positioning, no
  border, no shadow. A second box inside the parent's reads as a menu inside a
  menu.

`anchor` selects a **wrapper class and nothing else**. It is not a positioning
engine and must not become one — there is no portal and no floating-ui, both
because a portal breaks the composer's never-take-focus rule and because the
app-JS budget had 0.21 KB of headroom when this landed.

**The three rules a reviewer should check first.**

1. **One highlight atom.** `[data-highlighted]` is set by render, never by an
   event handler, so keyboard and pointer cannot disagree about which row Enter
   takes. Keyboard moves scroll the row into view; **pointer moves must not** —
   a hover that scrolled would move the list out from under the cursor, which
   would then hover a different row.
2. **It fetches nothing.** Rows arrive as props from whichever surface owns the
   data plane. A lazy chunk that imported the API client made the bundler hoist
   that client into a third chunk, +0.5 KB gz for zero behaviour.
3. **A row cannot be unactionable.** `lib/entity.ts`'s union has three arms —
   insert (`value`), run (`run`), navigate (`slug`) — and a row with none of
   them fails to typecheck. A dead row renders and highlights exactly like a
   live one, so the compiler is the only place to catch it.

**Where a row goes** is `resolveEntityTarget`'s decision, in one function, for
every consumer. Three of its answers are not obvious: an **issue** has no route
(B2 put issues inside session detail and the team card, so it navigates to the
session that owns it), and **schedules** and **hosts** are Settings anchors
because B1 folded both routes away.

**Bench**: `/dev/pickers` (DEV-only, lazy) — both anchors × all nine kinds ×
`{desktop, phone}` × empty/loading/40-row-overflow, in both themes. Contracts
asserted in `tests/unit/entity-picker.test.tsx`; the keyboard truth table in
`tests/unit/entity-picker-keys.test.ts`; the lossless-promotion pin in
`tests/unit/chat-interactive.test.tsx`.

### 6c.2 Entity-chip navigation vocabulary (B4)

The transcript is a management log, so the named things in it are places, not
decoration. One rule governs all of them:

> **A chip with no destination is not a chip.** It renders as emphasis — a
> `<span>` or a `<b>` — with the SAME geometry and no hover, no focus ring, no
> tab stop. An affordance that promises a click and does nothing is worse than
> no affordance, and on a long transcript it is also dozens of dead tab stops.

| Entity | Chip form | Navigable today | Destination |
|---|---|---|---|
| **session** | `MentionChip` — the session's mark + its name in **its** pigment | ✅ | the focus route for that session; a no-op when it names the session you are already in |
| **schedule** | `SystemEntity` with the `⏱` glyph | ✅ | the per-session **Schedules sheet**, scrolled to the row when the ledger knows its id, otherwise the list |
| **board issue** | `SystemEntity` | ❌ | B2's issue surface |
| **host** | `SystemEntity` | ❌ | no surface yet |
| **PR** | `SystemEntity` | ❌ | no surface yet |
| **subagent** | `SystemEntity` | ❌ | **deliberately none** — a subagent voice is a new primitive and the vocabulary is closed. The surface SAYS the work shows in the terminal, and fetch-full resolves subagent uuids so the data path is not the blocker. See §6f *Subagents* |

- **The mechanic is unchanged in both states**: `−1/−5/−1/−3` margins cancelling
  `1/5/1/3` padding. That is what makes the sentence hold still when a chip
  gains or loses a destination — asserted in
  `tests/unit/chat-chip-navigation.test.tsx`, both variants, both primitives.
- **What counts as a mention is not a navigation question.** `mentionSegments`
  decides, from the known-sessions index — never a regex over arbitrary words,
  so `patchwork` stays a word and a session never chips its own name inside its
  own bubble. Navigation only decides what a click *does*.
- **Destinations are injected, never routed for.** `onOpenSession` /
  `onOpenSchedule` arrive as props from `chat-panel.tsx`, the one layer allowed
  to reach the router. A primitive that imported `useNavigate` could not be
  screenshot on the bench, and the lazy markdown chunk would grow a router.
- **`⏱` is the one sanctioned glyph in UI copy** (a schedule has no identity
  mark to hang), matching the scheduler's own chips.

## 6d. The shell — chrome, z-ladder, overlay vocabulary (B1)

B0 gave the app a palette; B1 gives it a body. Three vocabularies, all declared
in the fenced `FASE B1` block at the tail of `globals.css` and asserted by
`tests/unit/shell-chrome-tokens.test.ts`.

### Chrome heights — a floor, never a fixed height

Tailwind is border-box, so `h-14 pt-safe` lets the notch inset *eat* the header
instead of growing it. Every top bar is therefore **`min-height` (a floor) plus
an additive `padding-top: env(safe-area-inset-top)`**, packaged as one utility:

| column | floor | token | utility |
|---|---|---|---|
| route headers — overview, files, settings | 56px | `--sm-toolbar-min-h` | `safe-header` |
| in-pane headers — focus, side pane, shell overlay | 44px | `--sm-toolbar-min-h-compact` | `safe-header-compact` |

The guard against regressions is `tests/e2e/smoke/ios-pwa-chrome.spec.ts`.

### The route-header grammar — one shape for every route

Overview, Files and Settings now share it, and any new route inherits it:

- a **sticky `glass safe-header` bar** at the top of the route's own scroller,
  carrying the route title at **17px / 600**, fading IN over 8→44px of scroll;
- the **large title (34px / 700) in the scrolling body**, fading OUT over
  0→52px — so exactly one title is legible at any scroll position;
- the bar **owns the safe-area inset**. A route must not ALSO pad its body with
  `env(safe-area-inset-top)`, or the two stack into a dead band on a notched
  phone;
- **crossfading inners go in `.sm-swap`.** A control that appears in one state
  and not another (the overview's density chip, which is tile-view only) would
  otherwise shunt every control beside it sideways. `.sm-swap` puts both states
  in one grid cell, so the swap is an opacity change that cannot move layout.

A route with a sticky header must be **its own scroller**
(`h-full overflow-y-auto`), not rely on the shell's `<main>`: `position: sticky`
resolves against the nearest scrolling ancestor, and a route root sized `h-full`
gives a sticky child a containing block one viewport tall — the bar unsticks
mid-scroll.

### The z-ladder — names over the shipped numbers

The app already had a stacking order (14 call sites at `z-[60]` alone). B1 does
**not renumber it**; it writes it down, so new code has names to use and B2+ can
converge the literals one file at a time.

| token | z | who lives there |
|---|---|---|
| `--sm-z-content` | 10 | in-flow content, sticky route bodies |
| `--sm-z-pane` | 20 | side panes, split columns |
| `--sm-z-header` | 30 | sticky route headers over their own scroller |
| `--sm-z-overlay` | 50 | Radix popover / dropdown / tooltip / dialog, and `<ShellOverlay>`'s scrim + frame |
| `--sm-z-sheet` | 60 | Vaul sheets, `ResponsiveSheet`, the focus KeyBar, the connection overlay |
| `--sm-z-compose` | 65 | the compose panel |
| `--sm-z-actionsheet` | 70 | action sheets, the A2HS sheet, the snippet editor |
| `--sm-z-tour` | 78 | the onboarding tour's scrim |
| `--sm-z-tip` | 80 | the tour's floating tip — always the top layer |

### The substrate — paint, never blur

The shell is **one painted substrate** (`[data-substrate]` on the shell root),
not six independent page backgrounds: nav rail on `--sm-paper`, content column
on `--sm-paper-raised`, side panes on the 6% `sm-accent-wash`. Columns are
separated by 0.5px absolute `::after` strips (`--sm-hairline` /
`--sm-hairline-w`), never a `border` — a 1px border is a different physical line
at DPR 2.

`.glass` stays the **only** `backdrop-filter` in the app, and only ever on
*floating* chrome (headers, composer, popovers, KeyBar) — never on an ancestor
of a `position: fixed` element, because a backdrop-filter makes its element the
containing block for fixed descendants and silently breaks the mobile focus
sheet's `visualViewport` math. Two tests enforce this: the CSS parse above and
`tests/e2e/smoke/shell-containing-block.spec.ts`.

Kill switch: `localStorage['supermux:shell-substrate'] = '0'`, reload. Without
the attribute every pre-B1 class still applies, so the revert needs no redeploy.

### Motion — exits are always faster than entries

Sourced from `lib/springs.ts` only. The shell adds `springs.settle` (overlay
entrance, ~520ms) against `tweens.overlayExit` (300ms), and
`tweens.popoverIn` (150ms) against `tweens.popoverOut` (100ms).
`.sm-swap` is the one sanctioned CSS transition *of the shell*: a 1×1 grid whose
two children share a cell and crossfade at 0.26s, so a state swap cannot shift
layout. **The full motion contract — both banks, the three speeds, the reduced-
motion doctrine and the offscreen rule — is §6f.**

## 6e. The roster — one row, three densities, one fact ladder (B2)

B0 drew `RosterRow` and mounted it nowhere. B2 makes it the overview's list row,
the focus strip and every picker, because those were three separately-maintained
rows of the same OBJECT and had already drifted into three different products.

| density | geometry | where |
|---|---|---|
| `list` | h64 · mark 40 · preview line · right-pinned ticking time | overview list, session rows |
| `strip` | h48 · mark 28 · meta line (tokens · branch), no preview | desktop focus strip (was a 56px `CompactTile`) |
| `picker` | h40 · mark 24 · **static**: no timestamp, no animation | command palette, session pickers, where-picker |

`picker` is a behaviour switch as well as a size: a row that ticks or blinks
under a keyboard cursor is a row you mis-click (§12.1).

**The fact ladder** (`web/src/lib/fact-ladder.ts`) is the written record of which
facts each surface carries at which overview tier. It exists because the three
rows had three different answers and no table, so no refactor could prove it had
not dropped one. Four rules, all asserted in `tests/unit/fact-ladder.test.ts`:

1. **Monotonic** — a fact at tier *n* is present at every tier above it. Density
   may add, never subtract.
2. **`mark` and `attention` on every row of every surface.** Attention has to
   survive collapse, or the densest surface is the one where you miss the thing
   that needed you.
3. **A picker carries no ticking fact** (`time`, `preview`, `statusLabel`).
4. **`tile` tier 4 equals what the app renders today**, exactly — the ladder is
   descriptive first, so "no tier drops a fact" is an assertion, not a claim.

| surface | tier 1 | adds |
|---|---|---|
| `tile` | taskSummary · statusLabel · tokens · branch · host badge · error badge · ⌘N · archive · preview | nothing — the tiers buy pixels, not facts |
| `list` | name · statusLabel · branch · time · ⌘N · host badge · error badge | t2 preview · t3 tokens · t4 tags |
| `strip` | name · tokens · branch · ⌘N | nothing — the strip's preview is the dwell popover, an interaction, not a fact |
| `picker` | name · taskSummary | nothing |

`contextPct` is deliberately **absent**: it does not exist anywhere in the app
(the A2 statusline tap feeds the chat header only), and a ladder that promises a
fact nobody renders is a ladder that lies.

**Identity is a roster property, not a row property.** `lib/roster-marks.ts`
assigns faces for the whole app once, in **creation order**, and
`hooks/use-roster-marks.ts` publishes them on context (`usePin(name)`). The
assignment is first-fit from each seed's own hash position along the engine's
63-token cycle — *not* `assignRoster`'s count-balanced cost, which spreads a
roster evenly but re-paints later colleagues whenever an earlier session is
deleted. Distinctness is guaranteed either way for n ≤ 63; stability is not, and
a face that moves is not a face.

**Status → face** is one table (`lib/mark-status.ts`): `starting`/`active` →
`working`, `idle` → `idle`, `waiting` → `waiting`, `stopped` → `stopped`,
`error` → `failed`. Written against the **TypeScript** union (which has `error`
and no `unknown`; Rust's `Status` has `Unknown` and no `Error` — errors ride the
separate `error:{type,message}` delta key).

**Attention — the vocabulary, so it cannot drift.** Four words, one precedence:

| tier | means | drawn as |
|---|---|---|
| `needs` | waiting · a live permission dialog · `session.error` | the 7px dot on the mark's shoulder — the ONLY glyph on a silhouette |
| `unread` | it said something after you last looked | a dot, or a NUMBER when (and only when) the chat store's epoch matches the cursor |
| `working` | `active` or `starting` | the eyes (no extra glyph) |
| `quiet` | none of the above | nothing at all |

Two things this vocabulary is careful about:

- **`lib/attention-tiers.ts` is not `components/chat/attention.ts`.** The latter
  (A4) is the renderer's HONESTY copy — what to say when the chat surface cannot
  show a live dialog. The former is the roster's tier model. Two files named
  `attention.ts` in one app is the drift to avoid; they have different names and
  different jobs on purpose.
- **Every row gets a tier**, whatever its provider, host or team-ness. The tier
  is derived from `status` plus seen-cursor arithmetic on a provider-neutral
  stamp ladder (`activity_at` → `last_activity` → `updated_at`, with
  `chat_tail` LAST because it is Claude Code's clock and exists only while
  someone has the chat open). No byte heuristics, ever — that is the
  false-positive class this model was built to avoid, and its unit suite is
  written as a false-positive suite.

**Kill switches** — both are console-flippable, no redeploy, PR-#27 pattern:

| key | `'0'` does what | read by |
|---|---|---|
| `supermux:roster-marks` | every row draws the pre-B2 `StatusDot` in the mark's footprint | `components/roster/session-face.tsx` |
| `supermux:attention` | every row collapses to `quiet` — no dot, no count, no rollup | `hooks/use-attention.ts` |

Everything else in B2 is additive and flag-free.

**Bench**: `/dev/roster` (DEV-only, lazy) — three densities × six states × three
tiers + quiet × both themes, plus the tile at all four overview tiers. Coverage
asserted in `tests/unit/dev-roster-cast.test.tsx`.

## 6f. Motion, reduced motion, and the accessibility contract (A6)

One page, so the next surface does not have to reconstruct it. Everything here
is enforced by `tests/unit/motion-tokens.test.ts` (a source scan) and
`tests/unit/shell-chrome-tokens.test.ts` (a CSS parse) — because the previous
version of this contract was prose in a header comment, and by the time A6
audited it, it was false for three of seven tweens.

### The two banks

Motion has two homes and neither can hold the other's half:

| bank | owns | file |
|---|---|---|
| `springs` / `tweens` / `eases` | every framer-motion `transition` | `lib/springs.ts` |
| `.sm-t-*` speed classes | every CSS transition | `styles/globals.css` (tail) |

They carry the **same numbers**, and the scan asserts they agree. A duration
written anywhere else — a `duration-[220ms]` literal, a private
`const SWAP_S = 0.26`, a bare `0.16` — is a number with no owner, and the scan
fails on it in `components/{chat,session-tile,shell,focus-mode}/`.

### Three speeds, and only three

| speed | what it is | token | CSS twin |
|---|---|---|---|
| **.12s** | hover / press feedback, on **both** `background-color` and `color` | `tweens.hover` (= `tweens.gapReveal`) | `.sm-t-hover` |
| **.26s** | in-place morph, same-cell crossfade, status swap | `tweens.swap`, `springs.statusMorph` (≡ `snappy`) | `.sm-t-morph`, `.sm-swap` |
| **.28s** | arrival — **.42s** when `data-fresh` | *not yet built* — see gaps below | — |

Two exceptions exist, and both are exceptions **on purpose**, which is why the
scan asserts their *property* and not just their duration:

- **.45s** roster-row arrival — on a **horizontal** axis (`translateX(−10px)`),
  a different axis from the transcript's vertical pops. *Not yet built.*
- **.4s** facepile avatar-row morph — on **`padding`**, not transform.
  `.sm-t-pad`.

Plus two whole-surface numbers: **.52s in / .3s out** for the shell overlay, and
**.6s** for the identity recolour (`fill`) — the slowest transition in the
product, and *not yet built*.

### Exits are always faster than entries

An entrance is the interface arriving and can afford to settle. An exit is the
user having already decided, and every millisecond spent animating it away is a
millisecond they are waiting.

| pair | in | out |
|---|---|---|
| shell overlay | `springs.settle` ≈ 520ms | `tweens.overlayExit` 300ms |
| popover / scrim | `tweens.popoverIn` 150ms | `tweens.popoverOut` 100ms |

The popover pair is the worked example, and A6 had to *make it true*: the shell
overlay's scrim declared no `exit` transition at all, so it silently inherited
its 150ms entry on the way out — the rule inverted on the exact surface this
document points at, while `popoverOut` sat in the bank with zero consumers.

### Never animate a backlog

A seeded transcript does **not** stagger in. Two mechanisms hold it and the scan
asserts both: transcript items carry no framer-motion whatsoever, and every
`<AnimatePresence>` in the chat surface sets `initial={false}` so children
present at first mount skip their `initial` state. Only post-`seed_done`
arrivals pop.

### Offscreen surfaces pause

`[data-offscreen]` sets `animation-play-state: paused` on the element and its
subtree. **`paused`, never `animation: none`** — a surface that comes back
resumes where it left instead of restarting every loop in unison.

Consumers: the hidden renderer (both stay mounted across the toggle), and
`<SessionMark>`, which additionally *unregisters from the shared rAF ticker*
when it scrolls out — so a 40-session roster costs zero frames offscreen, not
merely zero pixels.

### Reduced motion — the doctrine

**A CSS blanket for CSS, per-component `useReducedMotion()` branches for
framer-motion.** Deliberately **not** `<MotionConfig reducedMotion="user">` at
the app root, and the reasons are the contract:

1. The gap is overwhelmingly CSS — plain Tailwind `transition-*` classes that
   `MotionConfig` structurally cannot reach. On its own it would be a placebo.
2. A root provider makes every unbranched site pass **silently**. That is
   exactly how the old ownership claim rotted. Per-component branches keep the
   remaining set small, enumerable, and enumerated — by a test that fails when a
   new one appears.
3. It would disable the press-scales as a side effect. That is a real decision
   and it belongs in the open (below), not in a one-line provider.

What the blanket does and does not do:

- **Transitions: all of them, everywhere**, at `0.01ms` rather than `none` — a
  zero-duration transition still fires `transitionend`, so latches waiting on
  one still complete.
- **Animations: by name, never by `*`.** A `*`-scoped animation reset would
  freeze `.sm-status-spinner`, and a frozen spinner reads as *broken*.
- **Functional indicators keep moving.** All 30 `animate-spin` sites are loading
  feedback and are exempt, as are `.sm-status-spinner` and its kin. Decorative
  loops (`.animate-pulse`, `.sm-breathe`, `.sm-blip`, `.sm-spin`) stop.
- **A still must still read as the thing.** The typing dots keep their static
  `.25 / .45 / .7` base opacities under reduce, so the row reads as three dots
  mid-wave rather than as three identical dots — a different component.
- **The one documented exemption: `springs.buttonPress` on `whileTap`.** A
  press-scale is bound to a finger already on the glass; it is direct
  manipulation feedback, not vestibular motion, and it stays. 63 sites.

### Named gaps (so they are not mistaken for coverage)

The `.28/.42s` `data-fresh` arrival, the `.45s` roster-row horizontal arrival
and the `.6s` identity recolour are **extracted reference numbers for
animations that have not been built**. They are recorded above as the target and
deliberately have **no token**, because a token with no consumer is the exact
failure this section exists to prevent. Whoever builds the arrival adds the
token and the scan's assertion in the same commit.

### Accessibility contract (T7/T8)

Written from what ships, not from what was planned. Where a promise is unmet it
is named below under **Carried**, in the same idiom as *Named gaps* above — a
contract that describes an unbuilt surface is worse than no contract, because
the description is what stops the next person building it.

#### One state, one voice

The rule that took three attempts to get right, and the only one here that is a
*policy* rather than an attribute:

> **A state has exactly one live region. Everything else that renders the same
> fact is `aria-live="off"`.**

A screen reader does not see components, it hears the page — so "each component
announces its own state" composes into one sentence said three times. It did:
sampling every `[aria-live]:not(off)` during a real turn found the recall strip,
the pending band and the LiveAnnouncer all changing inside 500 ms, reading the
user's own message back twice before saying anything about the reply.

| state | owner | everyone else |
|---|---|---|
| the turn (working / asking / handing off) | `live-layer.tsx`'s LiveAnnouncer — a `role="status"` whose text is a pure function of the phase | the band itself is `aria-live="off"`; the recall strip is `off`; the pending band is `off` |
| a send that did NOT land | the pending band, and only for `undelivered` | — |
| connection | the chat connection chip while a chat surface is saying something, otherwise the global `ReconnectBanner` | claimed at runtime through `lib/live-region-owner.ts`; the loser stays visible and retryable, just silent |

Two corollaries worth stating, because both were violated in shipped code:

- **A live region is mounted BEFORE it has text.** A region that appears at the
  same moment as its content announces inconsistently across AT. The pending
  band's wrapper is therefore unconditional and its *politeness* is what
  changes.
- **The user's own words are never news.** The recall strip and the optimistic
  echo both render text the user typed one second ago and can still see. They
  carry it as `aria-label`, not as speech.

**Assert it by COUNT, over the assembled page.** `tests/unit/chat-a11y.test.tsx`
counts announcements over a scripted turn; `tests/unit/live-region-ownership.test.tsx`
counts speaking regions across the recall strip + pending band + live layer
*together*, which is the assertion a single-component test structurally cannot
make. "An `aria-live` exists" is not an assertion.

#### The gap list, resolved

| id | what ships |
|---|---|
| G1 | the streaming region announces — one phase sentence per turn (above) |
| G2 | the working row is `aria-busy` while a turn runs, and not otherwise |
| G3 | an authored bubble is `role="article"` + `aria-label` with the author; an UNAUTHORED one (a receipt group) stays a plain div — a receipt is not speech |
| G4 | the choice card is a named `role="group"`; the keyboard cursor is `aria-current`, not a colour; `option.hint` is text, not `title=`; the refusal reason is reachable even though the button is genuinely `disabled` |
| G5 | `CardCode` is a named `role="region"` — a tab stop that announces as something |
| G6 | every `aria-expanded` names what it controls, and only while that thing exists |
| G9 | the chat surface is one `role="region"` labelled by one `<h2>`; the scroller is deliberately NOT `role="log"` (the seed would read the whole backlog aloud) |
| G10 | a real skip link (`layout.tsx`), targeting a `tabIndex={-1}` `<main>` so focus actually lands |
| G11 | one `<h1>` per route; the roster's duplicate sticky title is gone; sections are `aria-labelledby` |
| G13 | the status dot is `aria-hidden` decoration and the WORD is the text — announced once, by one of the two surfaces that used to both claim it |

#### Escape, and who owns it

`Escape` is overloaded on purpose; the resolution is strictly innermost-first,
and every layer refuses to act when an inner one has claimed it:

| what is open | what Escape does |
|---|---|
| an IME composition | belongs to the composition — the composer forwards NOTHING while composing |
| the @-picker / slash popover | closes the PICKER only. It does not clear the draft and does not stop the turn |
| a draft with text in it | clears the draft |
| an empty composer during a turn | interrupts the turn |
| `ShellOverlay` / `ResponsiveSheet` | closes the overlay and restores focus to its opener |

The trap lives with the overlay, never with the composer: `ShellOverlay` and
`ResponsiveSheet` cycle Tab and restore focus on close. The composer is never a
trap — it is a text field on a page.

#### Carried, by name

- **The roster is still not arrow-navigable (G7/G12).** `role="list"` exists on
  the overview, but there is no roving tabindex — `grep -rn roving web/src`
  returns nothing outside this document — so a ten-session roster is still
  thirty-eight tab stops and Arrow keys move nothing. The primitive is ready
  (`chat/ui/roster-row.tsx` is a real button with `aria-label`, `aria-current`
  and an `onKeyDown` prop) and no caller supplies the handler.
- **Focus after send (G8) is wired for the feedback path only.** `focusComposer()`
  exists and is called from `chat-panel.tsx`; the chat↔terminal toggle does not
  arm it, so focus can still land on `<body>` after a surface swap.
- **Colour contrast fails AA in both themes.** The ink ladder's tertiary step is
  3.68:1 on dark and 2.49:1 on light, and the light theme's terminal/ANSI
  palette was never audited. `tests/e2e/smoke/a11y-axe.spec.ts` carries
  `color-contrast` as an enumerated baseline entry on every scanned surface —
  that entry is the todo.
- **`nested-interactive` on the focus surface** — a control inside a control,
  carried in the same baseline, and best fixed with the roving-tabindex work
  that rebuilds that structure.
- **No keyboard-only walkthrough spec (T8.5).** Unchecked in the A6 ledger
  rather than left claimed; it is blocked on the composer-focus defect above,
  which is the thing it would have caught.

### Connection vocabulary (T2.6)

**Four words. No surface may invent a fifth.** They are the type
`ChatPresentation` in `components/chat/connection.ts`, the keys of
`CHAT_CONNECTION` in `brand/copy.ts`, and this table — one vocabulary in three
places, so a drift is a type error rather than a taste argument.

| word | what is true | what the surface shows |
|---|---|---|
| `live` | the tailer is reading the right file and said so inside the ceiling | **nothing.** The healthy state is silence |
| `reconnecting` | the socket or the tailer is between states | the transcript **stays on screen** under a chip that says it is not current |
| `stale` | the socket believes it is live, but nothing authoritative has arrived inside the ceiling | the same presentation as `reconnecting`. A different cause, worth telling apart in a bug report |
| `offline` | terminal — no chat data plane, or the socket gave up | the chip, and it is **tappable to redial** |

Three rules that are easy to get wrong and expensive to get wrong:

1. **The transcript never blanks — and nothing covers it either.** The server's
   contract is explicit (`tailer.rs:153`): *"`Reconnecting` is deliberately not
   an error: the transcript we already showed stays on screen, but the client
   must not present it as a complete, current conversation."* The chrome carries
   the doubt; the content does not move.
   **This includes the app-root `ConnectionOverlay`.** It is a `fixed inset-0`
   full-screen curtain, and during a hard outage on a chat route it eventually
   paints over the whole surface — measured against the embedded binary at ~25 s
   after the socket dies (a reconnect-honesty pass saw 416 ms on its own rig), at
   which point "stays on screen" is false and every honesty affordance the chat
   plane owns is behind it. **Decision: while a chat surface is mounted, the
   curtain stands down** (`lib/live-region-owner.ts::claimChatSurface`). Nothing
   is lost — the honesty chip is tappable to redial, the undelivered row offers
   Retry, and the global `ReconnectBanner` still says its piece above the route —
   and everywhere else (roster, files, settings, a terminal-only focus route) the
   curtain is exactly right and still appears.
   Asserted with `elementFromPoint`, sampled ACROSS the outage window, in
   `tests/e2e/smoke/chat-ws-restart-reseeds.spec.ts`. Playwright's
   `toBeVisible()` ignores occlusion, which is precisely why the spec that tests
   this scenario stayed green while the claim was false.
2. **`live` says nothing.** A chip that reads "Live" on every screen is
   wallpaper within a day, and then the day it says something else, nobody
   reads it.
3. **The ceiling is a measurement, not a taste.** `STALENESS_CEILING_MS` is
   90 s because A0 measured a text-only transcript entry at p50 31.4 s and max
   32.8 s, and a ceiling that fires during a healthy prose turn teaches the
   user that the honesty mechanism lies — strictly worse than no ceiling. The
   A0 numbers are unit-test fixtures (`tests/unit/chat-connection.test.ts`), so
   shortening the ceiling fails a test that says why.

**The global banner sees `reconnecting` and `offline`, and NOT `stale`**
(`linkStateFor`). A quiet session is not an app-wide alarm.

### Subagents (T4.1)

The chat surface **does not render subagent turns**, and that is a decision.
A subagent voice would be a new chat primitive, and the vocabulary is closed at
A4's set plus B4's system lines. The `subagent` row in §5's entity table stays
`❌` deliberately, not for want of anyone getting to it.

What is **not** acceptable, and what A6 fixed:

- A count is not a statement. `· N subagents` with no explanation of where the
  content went reads as a bug. The working row says the work shows in the
  terminal (`copy.ts::SUBAGENTS`).
- Fetch-full was a **structural 404** for subagent uuids —
  `find_full_entry` opened one path while the wire carried entries from
  `<conv>/subagents/`. It now sweeps both (`find_full_entry_anywhere`), so a
  404 from that route means "no such entry" and nothing else, and the day a
  surface does want them the data path already works.
- The client's drop is a named, tested rule (`isSubagent`), not a `continue` in
  two loops. In particular a fan-out must not consume the auto-fetch window, or
  it pushes real clipped messages out of it and makes them unrecoverable.

## 6g. Notifications — tier x policy x category (B5)

Three vocabularies decide whether a phone buzzes, and they are **different sets
that share exactly one word**. That single overlap (`unread`) is what makes them
look unifiable; they are not, because they answer different questions.

| vocabulary | lives in | answers |
|---|---|---|
| `Tier` | `server/src/notify.rs` | what KIND of thing this push is |
| `NotifPolicy` | `sessions.notif` (0028) | does THIS BOT push at all |
| `NotifCategory` | `prefs` k/v | does this EVENT TYPE push, globally |
| `TIERS` | `web/src/lib/attention-tiers.ts` | what this session LOOKS like in the roster |

### The mapping (asserted from both sides)

`Tier::client_tier` in Rust and `attention-tiers.test.ts` in TypeScript both pin
this table, so a rename on either side fails a test instead of drifting.

| server `Tier` | client tier | banner | badge | may re-buzz |
|---|---|---|---|---|
| `attention` | `needs` | yes | yes | yes |
| `error` | `needs` | yes | yes | yes |
| `unread` | `unread` | yes, replaces silently | no | no |
| `schedule` | *(none)* | yes | no | no |

The client's `working` and `quiet` are **unreachable from a push**, deliberately:
they describe a session nobody needs to hear about, which is exactly the set
that must never ring. A future server tier mapping onto either is a product
decision, not a refactor.

### The effective decision

```text
buzz = global_category_pref(category) AND session_policy(session, tier)
```

Applied ONCE, server-side, in `push::send_push_for`. Two layers can silence a
push, so "muted" alone no longer answers "why didn't my phone ring" — every
attempt records WHICH layer (`global:<category>` or `session:<policy>`) in the
ring behind Settings.

The **schedule lane passes no session** on purpose: a schedule's "notify me when
done" is an explicit per-schedule opt-in, and an explicit opt-in outranks a
passive per-bot mute.

### The six categories

`agent_waiting`, `agent_finished`, `agent_error`, `agent_stopped`,
`schedule_error`, `schedule_finished` — **all default ON**. `agent_error` is the
agent still running and telling you the work did not land; `agent_stopped` is the
process going away. Different events, different next actions.

### The four per-bot policies

`inherit` (follow the global toggles — the default and the backfill) · `all`
(this bot adds no mute of its own) · `attention` (only blocking tiers; the calm
finish is muted) · `off` (this bot never pushes — its roster tier still works,
the phone just stays quiet).

### Who raises a push

Pushes are **hook-anchored**: raised at the hook arms in `hooks::apply_payload`,
never as a side effect of the status detector. `codex` / `kimi` / `shell` emit no
hooks, so for those the detector remains the only path and stays live as an
explicit fallback. There is exactly ONE writer of `pending_pushes` per session;
a second is a silent dropped notification.

`Notification` is deliberately NOT a trigger: Claude Code fires it ~60 s after a
turn finishes, so wiring it would buzz a minute after every completed turn.

## 6h. Lifecycle — what each verb preserves (B5)

Every destructive verb is named by **what it preserves**, not by its mechanism.
"Restart" and "Reset" mean nothing to someone deciding under pressure whether
they are about to lose a conversation; "keeps your scrollback" does.

| verb | preserves | destroys |
|---|---|---|
| **Stop** | everything on disk and in the DB | the live terminal |
| **Archive** | everything; fully reversible | the live terminal; the tile leaves the overview |
| **Purge** | working dir, branch, worktree | the session row and its children, permanently |
| **Restart** | conversation, worktree, schedules | live pty + in-memory scrollback |
| **Recover terminal** | scrollback and conversation | nothing else |
| **Reset** | working dir, worktree, schedules, config | conversation, scrollback, activity |
| **Duplicate** | makes a copy in the SAME directory | nothing (the original is untouched) |

### The three sentences that carry the most weight

These live in `brand/copy.ts` and each has MORE THAN ONE call site by design —
§15.5 asks that a blocked or surprising thing state why with the same sentence
everywhere, so a reworded explanation is a diff in every place it appears.

- **`purgeLeavesYourFilesAlone`** — your working directory, git branch and
  worktree are never touched, on archive or on delete. The single most
  surprising fact, and the reason a delete dialog is not a threat to your code.
- **`archivePausesSchedules`** — scheduled jobs on an archived session are
  paused, and run again when you restore it. Before B5 the scheduler was
  archive-blind and a hidden session was silently restarted by its own cron.
- **`archiveIsTheUndo`** — archiving is reversible. It always WAS the undo
  window; it was simply never called one, so users reached past it.

### Rules

- **Ordered by what they preserve**, least-destructive first — in the recovery
  ladder, and in any menu that offers more than one.
- **The `destroys` half is never softened or hidden** behind a disclosure. It is
  the sentence that prevents regret; a verb that only says what it keeps reads
  as a promise.
- **Blocked verbs say why**, with the same sentence in every place they appear.
- **Duplicate is a template, not a daemon.** The copy carries settings, avatar
  and notification policy, and its scheduled jobs arrive **switched off**.

### Which confirm

- *destructive and cheap* → `useArmedConfirm` + `<ArmedButton>`. Two presses,
  4 s window, no modal.
- *destructive and consequential* → `useConfirm()`, a dialog that ENUMERATES the
  consequences. Killing a team lead lists each teammate; switching to Bypass
  names the relaunch and the skipped prompts.
- **Never** `window.confirm` — it blocks the tab, cannot be styled, and can only
  render a string, so it can never enumerate anything. CI-gated by
  `scripts/lint-microcopy.sh`.

## 7. How the rest of the app consumes this

- **Theme**: extend the `:root` brand block in `globals.css`; keep `--brand` /
  `--status-*` / `--background` (the brand amber is `--brand` so it doesn't
  collide with shadcn's semantic `--accent` hover fill).
- **Session tile**: pulse colors use `hsl(var(--brand) / …)` and
  `hsl(var(--status-waiting) / …)`; "Needs input" pill text =
  `MISC.needsInputPill`.
- **SSE**: call `playNeedsInput()` on transitions into `waiting`.
- **Routes**: import `EMPTY` / `ERROR` / `CONFIRM` for every empty, error, and
  destructive-confirm surface.
- **Settings**: Appearance → Sounds toggle wired to `sound.ts`.
- **CI**: run `scripts/lint-microcopy.sh` next to eslint.

## 8. Visual reference

`web/public/brand-preview.html` is a standalone showcase (open it directly or at
`/brand-preview.html` on the dev server): icon at multiple sizes, the color
swatches, a toast replica, microcopy samples, and a button that plays the cue.
