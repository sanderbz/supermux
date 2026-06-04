// Detent constants + the rubber-band helper for the mobile focus sheet.
//
// Kept out of mobile-sheet.tsx (a component module) so Fast-Refresh stays happy
// and the bungee math is independently importable/testable.

// Detent snap points as NUMERIC screen fractions of the layout viewport:
//   PEEK = 0.4 (sheet visible bottom 40%) and FULL = 1.0 (full screen).
// MobileSheet converts these to a pixel `peekOffset = vh * (1 - PEEK)` for its
// translate-Y math; the constants stay unitless so the spec ("40% / 100%
// detents") reads at a glance and downstream consumers can derive their own
// offsets without re-encoding the fractions.
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
