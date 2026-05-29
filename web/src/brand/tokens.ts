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
    ready: '#2eaa6e',
    error: '#f47b2a',
    idle: '#737373',
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
 * Toast / banner slide-in. Termius spec calls this `.smooth(0.35)` (§termius
 * "reconnect banner slide-in"). In Framer Motion terms: a critically-damped
 * spring with no bounce, ~0.35s. Use for the <Toast/> entrance.
 */
export const TOAST_SPRING = {
  type: 'spring',
  duration: 0.35,
  bounce: 0,
} as const

/** Slightly longer settle for the toast/banner exit (Termius `.smooth(0.4)`). */
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
