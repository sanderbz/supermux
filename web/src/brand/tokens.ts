// Brand tokens — the typed mirror of the CSS custom properties defined in
// web/src/styles/globals.css. Import these in TS/TSX where you need a literal
// value (Framer Motion keyframes, canvas, inline styles) instead of a CSS var.
//
// Single brand tint = "confident-builder amber". It is the ONLY brand hex in the
// app; everything else should be a semantic token. Status colors tell
// the running / waiting / error / idle story from user-vision.md.
//
// See web/src/brand/BRAND.md for the full rationale.

/** HSL triples — compose with an alpha as `hsl(${ACCENT_HSL} / 0.5)`. */
export const ACCENT_HSL = '38 92% 58%'
export const STATUS_ACTIVE_HSL = '38 92% 58%' // amber pulse (matches accent)
export const STATUS_WAITING_HSL = '214 95% 60%' // calm blue "needs input"
export const STATUS_READY_HSL = '152 60% 45%' // calm green "idle but alive"
export const STATUS_ERROR_HSL = '24 90% 56%' // calm orange, never alarmist
export const STATUS_IDLE_HSL = '0 0% 45%' // dim neutral — stopped / unknown
export const BACKGROUND_HSL = '0 0% 4%' // #0a0a0a splash / first-frame

/** Resolved hex equivalents (for canvas / non-CSS contexts). */
export const BRAND = {
  /** The one brand tint. */
  accent: '#f6ae31',
  /** Splash + app background; matches manifest background_color. */
  background: '#0a0a0a',
  status: {
    active: '#f6ae31',
    waiting: '#388cfa',
    ready: '#2eb877',
    error: '#f47b2a',
    idle: '#737373',
  },
} as const

/* ── B0 — warm paper / ink / hairline ladder ───────────────────────────────
   Typed mirror of the `--sm-*` block in globals.css. Values are byte-identical
   to the approved hero mockup (board-light.png / board-dark.png). The mirror is
   guarded by tests/unit/brand-tokens.test.ts, which parses globals.css and
   fails if either side drifts.

   Prefer the CSS var (`var(--sm-paper)` / `bg-paper`) in components; these
   literals exist for the non-CSS contexts — canvas, SVG attribute fills, and
   Framer Motion keyframes, which cannot read a custom property. */

/** One theme's rung of the ladder. */
export interface PaperLadder {
  /** The page the whole app sits on. */
  paper: string
  /** Conversation pane — one step above the paper. */
  paperRaised: string
  /** Raised glass (bars, composer) — translucent, pair with a backdrop blur. */
  surface: string
  /** Agent bubble — a fixed warm neutral, never accent-tinted. */
  bubbleAgent: string
  /** User bubble fill … */
  bubbleUser: string
  /** … and the ink on it. */
  bubbleUserInk: string
  /** Primary type. */
  ink: string
  /** Secondary type (preview lines, timestamps, system lines). */
  ink2: string
  /** Tertiary type (placeholders, disabled). */
  ink3: string
  /** Separator — drawn at --sm-hairline-w (0.5px), never 1px. */
  hairline: string
  /** Quieter separator (inside a card). */
  hairlineSoft: string
  /** Hover / pressed wash. */
  fillSoft: string
  /** The heavier of the two washes (selected chips, mic button). */
  fillSoft2: string
  /** Inline + fenced code background. */
  codeBg: string
  /** Bubble elevation ('none' in dark — the bubble is lifted by value alone). */
  bubbleShadow: string
  /** Card elevation. */
  cardShadow: string
  /** The lift every floating list wears — the `@`/`/` popover, the composer
   *  pill, the ⌘K results (fase B3 T2.5). Warm-black rather than §14's cool
   *  grey, which reads blue against this paper. */
  popoverShadow: string
  /** The window itself: shadow + hairline ring + inner top highlight. */
  elev: string
  /** Accent share of the selected-row mix, as a CSS percentage. */
  accentRowMix: string
}

/** The ladder, per theme. Keys match `[data-theme='…']` in globals.css. */
export const PAPER: { readonly light: PaperLadder; readonly dark: PaperLadder } = {
  light: {
    paper: '#faf7f4',
    paperRaised: '#fdfbf9',
    surface: 'rgba(255, 253, 251, 0.86)',
    bubbleAgent: '#f1ece8',
    bubbleUser: '#1c1917',
    bubbleUserInk: '#f7f3ef',
    ink: '#1c1917',
    ink2: '#79716b',
    ink3: '#a8a09a',
    hairline: 'rgba(28, 20, 10, 0.09)',
    hairlineSoft: 'rgba(28, 20, 10, 0.05)',
    fillSoft: 'rgba(28, 20, 10, 0.045)',
    fillSoft2: 'rgba(28, 20, 10, 0.07)',
    codeBg: 'rgba(28, 20, 10, 0.05)',
    bubbleShadow: '0 1px 2px rgba(60, 40, 20, 0.05)',
    cardShadow:
      '0 10px 30px -14px rgba(60, 40, 20, 0.22), 0 1px 2px rgba(60, 40, 20, 0.05)',
    popoverShadow: '0 12px 34px -18px rgba(30, 18, 10, 0.35)',
    elev: '0 46px 90px -34px rgba(52, 34, 20, 0.3), 0 6px 18px -6px rgba(52, 34, 20, 0.07), 0 0 0 0.5px rgba(35, 25, 15, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.55)',
    accentRowMix: '9%',
  },
  dark: {
    paper: '#1a1a18',
    paperRaised: '#201f1d',
    surface: 'rgba(58, 54, 50, 0.72)',
    bubbleAgent: '#2c2926',
    bubbleUser: '#f2ede7',
    bubbleUserInk: '#1c1917',
    ink: '#f5f1ec',
    ink2: '#a8a29b',
    ink3: '#7d766f',
    hairline: 'rgba(255, 246, 235, 0.085)',
    hairlineSoft: 'rgba(255, 246, 235, 0.055)',
    fillSoft: 'rgba(255, 246, 235, 0.06)',
    fillSoft2: 'rgba(255, 246, 235, 0.1)',
    codeBg: 'rgba(0, 0, 0, 0.3)',
    bubbleShadow: 'none',
    cardShadow: '0 14px 34px -16px rgba(0, 0, 0, 0.6)',
    popoverShadow: '0 14px 38px -18px rgba(0, 0, 0, 0.66)',
    elev: '0 46px 100px -30px rgba(0, 0, 0, 0.62), 0 8px 24px -10px rgba(0, 0, 0, 0.4), 0 0 0 0.5px rgba(255, 246, 235, 0.07), inset 0 1px 0 rgba(255, 246, 235, 0.06)',
    accentRowMix: '12%',
  },
} as const

/** Every separator in the design system. 0.5px — never 1px. */
export const HAIRLINE_W = '0.5px'

/**
 * Per-session accent contract (concept contract C7).
 *
 * `--sm-accent` is the FOCUSED session's identity hue, written on the app shell
 * at runtime by the character engine. `DEFAULT` is the no-session fallback (the
 * brand amber) — it is never a session colour.
 *
 * The mixes are applied at the USE site by the `sm-accent-{row,wash,chip}`
 * utilities, not stored as derived vars: a custom property containing var() is
 * substituted where it is declared, so a derived var on :root could never see a
 * per-session write further down the tree.
 */
export const AGENT_ACCENT = {
  /** The CSS custom property the character engine writes. */
  cssVar: '--sm-accent',
  /** Fallback when nothing is focused — the brand amber. */
  DEFAULT: '#f6ae31',
  /** Accent share when mixed into the current theme's paper. */
  mix: {
    /** Selected roster row — theme-dependent (see PAPER[theme].accentRowMix). */
    row: { light: '9%', dark: '12%' },
    /** Side-pane / header wash. */
    wash: '6%',
    /** Mention + provenance chips (mixed over transparent). */
    chip: '14%',
  },
} as const

/** Map a session status to its brand color (hex). Falls back to idle. */
export function statusColor(status: string): string {
  switch (status) {
    case 'active':
    case 'starting':
      return BRAND.status.active
    case 'waiting':
      return BRAND.status.waiting
    case 'idle':
      return BRAND.status.ready
    case 'error':
      return BRAND.status.error
    default:
      return BRAND.status.idle
  }
}

/**
 * Toast / banner slide-in — SwiftUI's `.smooth(0.35)`. In Framer Motion terms: a critically-damped
 * spring with no bounce, ~0.35s. Use for the <Toast/> entrance.
 */
export const TOAST_SPRING = {
  type: 'spring',
  duration: 0.35,
  bounce: 0,
} as const

/** Slightly longer settle for the toast/banner exit (`.smooth(0.4)`). */
export const TOAST_SPRING_OUT = {
  type: 'spring',
  duration: 0.4,
  bounce: 0,
} as const

/** Web Audio "needs input" cue parameters (see web/src/lib/sound.ts). */
export const SOUND = {
  /** Pitch slide start → end (Hz). One octave up reads as "ready / your turn". */
  freqStart: 440,
  freqEnd: 880,
  /** Peak gain — deliberately gentle. */
  gain: 0.15,
  /** Total duration (seconds). */
  durationS: 0.2,
} as const
