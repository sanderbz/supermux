# supermux — Brand, Voice & Microcopy (M28)

The single source of truth for what supermux *is called*, how it *sounds*, what it
*looks like*, and the words it puts on screen. Later milestones consume the
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
  sessions. (Anti-vision, user-vision.md §"Anti-vision".)

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
   (user-vision.md cross-cutting principle #3: "no UPPERCASE".)
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

One brand tint. Everything else is a semantic/system token (full theme: M10).

| Token | HSL | Hex | Use |
|---|---|---|---|
| `--brand` | `38 92% 58%` | `#f6ae31` | FAB, focus accent stroke, focus rings, "active" pulse |
| `--status-active` | `38 92% 58%` | `#f6ae31` | running (amber pulse) |
| `--status-waiting` | `214 95% 60%` | `#388cfa` | waiting / "needs input" (calm blue, §4.3) |
| `--status-error` | `24 90% 56%` | `#f47b2a` | error — **calm orange, never alarmist red** (user-vision.md) |
| `--status-idle` | `0 0% 45%` | `#737373` | idle / dim |
| `--background` | `0 0% 4%` | `#0a0a0a` | app background + PWA splash |

- **"Confident-builder amber"** (`#f6ae31`) is the one brand hex — similar to
  Anthropic amber, slightly warmer. It carries the "Active" pulse story.
  Exposed as `--brand` (shadcn's `--accent` is the distinct semantic hover fill).
- Tokens are bare HSL triples so callers can add alpha:
  `hsl(var(--brand) / 0.5)` (matches §4.3 keyframes).
- The `error` status uses **calm orange**, not red — supermux stays composed.
  (The destructive "missing tile" affordance in §4.3 may still use system red
  for a hard delete; that's a different signal from "the agent errored".)
- TS mirror: [`tokens.ts`](./tokens.ts) (`BRAND`, `*_HSL`, `statusColor()`).

## 4. Icon & splash

- **Single source**: [`web/public/icon.svg`](../../public/icon.svg) — the amber
  prompt chevron `❯` + cursor block (a "terminal block"), monochrome amber on
  near-black, full-bleed so it works as a *maskable* PWA tile. All content sits
  in the inner safe circle; it reads at 32px.
- **Favicon**: `web/public/favicon.svg` — same mark, tighter framing for a tab.
- **Raster export**: `scripts/build-icons.sh` → `icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png` (180×180). Re-run when `icon.svg` changes.
- **Splash / no white flash**: `--background`, manifest `background_color` +
  `theme_color`, and the `index.html` `theme-color` are all `#0a0a0a`. The
  first-frame paint equals the splash color, so there is no flash of white.

## 5. Sound — the "needs input" cue

- [`web/src/lib/sound.ts`](../lib/sound.ts): a 200ms sine tone sliding 440 → 880
  Hz at 0.15 gain with an exponential ramp out. Reads as a polite "your turn",
  not an alarm.
- **Opt-in.** OFF by default (politeness). Persisted in `localStorage`
  (`supermux.sounds.enabled`). Toggle copy: `MISC.soundsToggleLabel`.
- **Wiring** (M12/M14 SSE handler): call `playNeedsInput()` on a status delta
  into `waiting` — it self-gates on the preference. Call `primeAudio()` from the
  first user gesture so iOS Safari unlocks audio. Bind the Settings switch to
  `getSoundsEnabled()` / `setSoundsEnabled()`.

## 6. Toast

- [`web/src/components/ui/toast.tsx`](../components/ui/toast.tsx): glass capsule,
  36px tall, top-center, slides in from the top with `.smooth(0.35)`
  (`TOAST_SPRING`), auto-dismiss 2.5s, stack max 3, reduced-motion aware.
- Self-contained: drop `<ToastProvider>` near the root, call `useToast()`.
- Feed it copy from `copy.ts` (`TOAST.*`). Tone tints the leading status dot.

## 7. How later milestones consume this

- **M10** (theme): extend the `:root` brand block in `globals.css`; keep
  `--brand` / `--status-*` / `--background` (the brand amber is `--brand` so it
  doesn't collide with shadcn's semantic `--accent` hover fill).
- **M11/§4.3** (tile): pulse colors use `hsl(var(--brand) / …)` and
  `hsl(var(--status-waiting) / …)`; "Needs input" pill text = `MISC.needsInputPill`.
- **M12/M14** (SSE): call `playNeedsInput()` on transitions into `waiting`.
- **M19–M22** (routes): import `EMPTY` / `ERROR` / `CONFIRM` for every empty,
  error, and destructive-confirm surface.
- **M22** (settings): Appearance → Sounds toggle wired to `sound.ts`.
- **CI**: run `scripts/lint-microcopy.sh` next to eslint.

## 8. Visual reference

`web/public/brand-preview.html` is a standalone showcase (open it directly or at
`/brand-preview.html` on the dev server): icon at multiple sizes, the color
swatches, a toast replica, microcopy samples, and a button that plays the cue.
