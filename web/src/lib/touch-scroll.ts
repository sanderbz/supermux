// Touch-drag scrollback math for the live terminal (mobile).
//
// WHY THIS EXISTS AS ITS OWN MODULE. xterm 6.0 has NO built-in touch-drag
// scroll: its VS Code scrollable element scrolls on WHEEL but ignores one-finger
// drags, and its `.xterm-viewport` is not a native-overflow scroller for the
// buffer (`scrollHeight === clientHeight` no matter how deep the scrollback is).
// The whole of the phone's scrollback therefore hangs off the drag→`scrollLines`
// handler in `use-live-term`, and that handler had no test — which is how the
// daily-driver QA could measure `.xterm-viewport` (the wrong element in 6.0) and
// report "no terminal scrollback on the phone" (#19) with nothing to contradict
// it. The arithmetic lives here so it can be asserted directly.
//
// Units: `dyPx` is the finger delta in CSS px, POSITIVE when the finger moved UP
// (i.e. scroll toward the newest output). `carryPx` is the sub-row remainder
// kept between moves so a slow drag still moves the buffer instead of
// quantising to zero. Velocity is px/ms.

/** Fling threshold (px/ms): below this a release is a tap or a slow let-go. */
export const FLING_MIN_VELOCITY = 0.04

/** Momentum stops once |velocity| falls to this (px/ms). */
export const MOMENTUM_STOP_VELOCITY = 0.02

/** Per-frame velocity retention at 60fps (~6% shed per frame). */
export const MOMENTUM_DECAY_PER_FRAME = 0.94

/**
 * Convert a drag delta into whole buffer rows, carrying the sub-row remainder.
 *
 * A non-finite or non-positive `cellPx` (the renderer has not measured a cell
 * yet — before the first paint, or on a hidden embed) scrolls NOTHING and keeps
 * the carry finite rather than emitting `NaN`/`Infinity` rows into
 * `scrollLines`, which would throw the viewport to an undefined position.
 */
export function dragRows(
  dyPx: number,
  cellPx: number,
  carryPx: number,
): { rows: number; carry: number } {
  const carry = Number.isFinite(carryPx) ? carryPx : 0
  if (!Number.isFinite(dyPx)) return { rows: 0, carry }
  const next = carry + dyPx
  if (!Number.isFinite(cellPx) || cellPx <= 0) return { rows: 0, carry: next }
  // `+ 0` normalises Math.trunc's -0 (a sub-cell backward drag) to 0 so callers
  // can compare against zero without tripping over signed zero.
  const rows = Math.trunc(next / cellPx) + 0
  return { rows, carry: next - rows * cellPx }
}

/** True when a release should hand off to momentum. */
export function isFling(velocityPxPerMs: number): boolean {
  return (
    Number.isFinite(velocityPxPerMs) &&
    Math.abs(velocityPxPerMs) >= FLING_MIN_VELOCITY
  )
}

/** Frame-rate-independent momentum decay over `dtMs`. */
export function decayVelocity(velocityPxPerMs: number, dtMs: number): number {
  return velocityPxPerMs * Math.pow(MOMENTUM_DECAY_PER_FRAME, dtMs / 16)
}

/** True while momentum should keep requesting frames. */
export function momentumAlive(velocityPxPerMs: number): boolean {
  return Math.abs(velocityPxPerMs) > MOMENTUM_STOP_VELOCITY
}
