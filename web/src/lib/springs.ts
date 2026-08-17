// The motion bank — the ONE source of truth for every duration and curve in
// the app.
//
// The springs mirror SwiftUI's recommended values per use case, for an
// iOS-native feel. `tweens` covers the duration-based transitions: dnd-kit
// interactions (whose own motion language is duration-based), the shell
// chrome's popovers and exits, and the same-cell crossfades.
//
// THREE RULES, stated once so they can be pointed at in review:
//
//  1. **Every framer-motion `transition` comes from this file.** No ad-hoc
//     cubic-beziers, no per-file magic constants, no `transition: all`
//     (which has zero occurrences and must keep having zero).
//  2. **Exits are always faster than entries.** An entrance is the interface
//     arriving and can afford to settle; an exit is the user having already
//     decided, and any time spent animating it away is time they are waiting.
//     Overlay 520 in / 300 out; popover 150 in / 100 out.
//  3. **Three speeds, and only three**: `.12s` hover/press, `.26s` in-place
//     morph, `.28s` (`.42s` when `data-fresh`) arrival. The two exceptions are
//     named and justified: the roster row arrives on a *horizontal* axis at
//     `.45s`, and the facepile morphs its *padding* at `.4s`.
//
// **CSS transitions do not come from here** — they cannot, they are in a
// stylesheet. Their counterpart is the `.sm-t-*` speed-class layer in
// `styles/globals.css`, which carries the same three numbers. A6/T6.3's
// `tests/unit/motion-tokens.test.ts` is the scan that keeps the two halves
// honest and keeps arbitrary `duration-[Nms]` literals out of the chat, roster
// and shell surfaces; `tests/unit/shell-chrome-tokens.test.ts` asserts rule 2
// numerically. Before A6 the ownership claim in this header was false for
// three of seven tweens — the tests exist so it cannot rot that way again.
//
// Tokens with a single call site are deliberate: a named token says what the
// motion *is*, and the alternative at the call site is an anonymous literal.

// Extracted so `statusMorph` can be a true alias rather than a copy that
// drifts (they were numerically identical and separately authored).
const snappy = { type: 'spring', stiffness: 500, damping: 32 } as const

export const springs = {
  // Tap-press / release — snappy, low mass (native button feel).
  buttonPress: { type: 'spring', stiffness: 700, damping: 30, mass: 0.5 },
  // Switch/toggle flip.
  toggleSnap: { type: 'spring', stiffness: 320, damping: 24 },
  // Sheet snap to detent — response 0.45, dampingFraction 0.82.
  sheetDetent: { type: 'spring', stiffness: 280, damping: 30 },
  // Card / popover expand — response 0.32, dampingFraction 0.72.
  cardExpand: { type: 'spring', stiffness: 380, damping: 28 },
  // ~0.25s "snappy" feel — page swipes, status morphs.
  snappy,
  // Status pill state change (in-place morph). THE SAME OBJECT as `snappy`:
  // the in-place morph *is* the snappy spring, and the name is kept because
  // `springs.statusMorph` reads better at a status call site than
  // `springs.snappy` does. Aliased rather than duplicated so the two can
  // never silently diverge.
  statusMorph: snappy,
  // ~0.4s smooth — layout morphs, gentle slides.
  smooth: { type: 'spring', stiffness: 200, damping: 28 },
  // Session-tile hover scale.
  tileHover: { type: 'spring', stiffness: 380, damping: 24 },
  // Snippet-panel slide-up (SwiftUI `.spring(response:
  // 0.35, dampingFraction: 0.85)`). Converted to framer-motion: stiffness ≈
  // (2π/0.35)² ≈ 322; damping ≈ 2·0.85·√322 ≈ 30.5.
  snippetSlide: { type: 'spring', stiffness: 322, damping: 30.5 },
  // B1 — the shell overlay's ENTRANCE. A raised surface should look like it
  // came to rest, not like it snapped into place, so this is the softest
  // spring in the bank: response ≈ 0.43s, dampingFraction ≈ 1.03 (just past
  // critical, so it never overshoots a full-bleed frame), settling ≈ 520ms.
  // Its exit is `tweens.overlayExit` at 300ms — see rule 2 in the header.
  settle: { type: 'spring', stiffness: 210, damping: 30 },
} as const

// Easing curves for the few duration-based (non-spring) transitions allowed.
export const eases = {
  out: [0.2, 0, 0, 1], // 100ms button press
  inOut: [0.4, 0, 0.2, 1], // 200ms generic
} as const

// The `.12s` speed of rule 3, extracted so the gap-chip reveal and every other
// hover-weight fade are provably the same number rather than the same literal.
const hover = { duration: 0.12, ease: 'easeOut' as const }

// Named duration-based tween presets.
//
//   hover             — 0.12s, rule 3's first speed: hover/press feedback.
//   gapReveal         — the same object, named for the hover-gap
//                       "+ Add group here" hairline + chip fade.
//   swap              — 0.26s, rule 3's second speed: the same-cell crossfade
//                       (`.sm-swap` in globals.css carries the CSS twin), the
//                       header/composer/echo swaps and the renderer crossfade.
//   containerIndicate — 0.35s ease-out for the group-body outline + bg flip
//                       when a tile is dragged over a group container. Read as
//                       a value by `group-grid.tsx`, never re-typed.
//   dropFlash         — 0.7s ease-out for the just-dropped tile's brief
//                       background-color tint (post-drop "landing" hint).
//   reflow            — 0.1s ease-out for dnd-kit's CSS transform reflow
//                       when adjacent tiles shift after a drop (overrides
//                       the dnd-kit default ~200ms; matches the spec).
//   (shimmer)         — RETIRED in B5/T11.1. It was the loading sheet's 1.6s
//                       linear sweep and the bank's only `linear`. The sweep
//                       still exists, as the `.sm-skeleton-shimmer` keyframe
//                       behind `<Skeleton variant="shimmer">`: a CSS animation
//                       costs nothing per element, where a framer transition
//                       mounts a motion component per bar — which is exactly
//                       why the shimmer was affordable in one place and every
//                       list of rows had to settle for `animate-pulse`. Same
//                       retirement `popoverOut`'s predecessor got: a token with
//                       no consumer is a suggestion, not a system.
//   overlayExit       — 0.3s ease-in for the shell overlay's dismissal. Paired
//                       with `springs.settle` (~0.52s) on the way in.
//   popoverIn         — 0.15s ease-out. Popovers are small and attached to
//                       their trigger; a spring on something this size reads
//                       as jitter. Also the scrim fade and the jump-to-bottom
//                       button, which are popover-shaped by every measure.
//   popoverOut        — 0.1s ease-in. Faster than its entry, per rule 2. Used
//                       by the shell overlay's scrim — see `shell-overlay.tsx`.
export const tweens = {
  hover,
  gapReveal: hover,
  swap: { duration: 0.26, ease: eases.inOut },
  containerIndicate: { duration: 0.35, ease: 'easeOut' as const },
  dropFlash: { duration: 0.7, ease: 'easeOut' as const },
  reflow: { duration: 0.1, ease: 'easeOut' as const },
  overlayExit: { duration: 0.3, ease: 'easeIn' as const },
  popoverIn: { duration: 0.15, ease: 'easeOut' as const },
  popoverOut: { duration: 0.1, ease: 'easeIn' as const },
} as const

/** The one shared "reduced motion is on" transition. `duration: 0` rather than
 *  a removed animation so the END state is still adopted in one commit and
 *  `AnimatePresence` still unmounts its children. Repeated inline at ~30 call
 *  sites before A6. */
export const motionOff = { duration: 0 } as const

export type SpringName = keyof typeof springs
export type TweenName = keyof typeof tweens
