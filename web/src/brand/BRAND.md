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
| **subagent** | `SystemEntity` | ❌ | no surface yet |

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
`.sm-swap` is the one sanctioned CSS transition: a 1×1 grid whose two children
share a cell and crossfade at 0.26s, so a state swap cannot shift layout.

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
