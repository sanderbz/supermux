// Detent constants + the rubber-band helper for the mobile focus sheet.
//
// Kept out of mobile-sheet.tsx (a component module) so Fast-Refresh stays happy
// and the bungee math is independently importable/testable.

// Detent snap points as NUMERIC screen fractions: peek (40%) and full (100%).
// Vaul treats numbers 0–1 as fractions of the viewport height and STRINGS as px
// (node_modules/vaul `isPx = typeof snapPoint === 'string'`), so these must stay
// numbers for "40% / 100%" detents to mean what the spec says.
export const PEEK = 0.4
export const FULL = 1
export const SNAP_POINTS = [PEEK, FULL]

// Velocity-dismiss threshold — a downward fling faster than this dismisses the
// sheet regardless of how far it has travelled (Termius #10).
export const VELOCITY_DISMISS = 1200 // px/s

/** Apple's rubber-band ("bungee") resistance — translation asymptotes at the
 *  dimension and never exceeds `c × d` extra (Termius #9):
 *    f(x,d,c) = (x · d · c) / (d + c · x)
 *  Used to cap the over-drag above the full detent so the sheet "bounces" rather
 *  than flying off the top of the screen. */
export function rubberBand(x: number, dimension: number, c = 0.55): number {
  if (x <= 0 || dimension <= 0) return 0
  return (x * dimension * c) / (dimension + c * x)
}
