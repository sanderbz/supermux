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
| `--status-ready` | `152 60% 45%` | `#2eaa6e` | idle-but-alive — calm green "your turn" |
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
