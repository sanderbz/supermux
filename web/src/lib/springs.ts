// Framer Motion spring preset bank.
//
// These mirror SwiftUI's recommended spring values per use case, for an
// iOS-native motion feel. EVERY motion in the app MUST use one of these
// presets. No `transition: all`, no ad-hoc cubic-beziers — PR review enforces
// this so the whole app shares one motion feel.
//
// `tweens` (below) covers the small number of duration-based, non-spring
// transitions the app needs — drag-and-drop container indication, post-drop
// flash highlights, gap-chip reveals. These are intentionally easings (not
// springs) because dnd-kit's motion language is duration-based; pairing
// the springs with framer-motion `transition` for the rest of the app and
// the tween bank for dnd-kit interactions keeps every visible motion sourced
// from THIS file.

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
  snappy: { type: 'spring', stiffness: 500, damping: 32 },
  // ~0.4s smooth — layout morphs, gentle slides.
  smooth: { type: 'spring', stiffness: 200, damping: 28 },
  // Session-tile hover scale.
  tileHover: { type: 'spring', stiffness: 380, damping: 24 },
  // Status pill state change (in-place morph).
  statusMorph: { type: 'spring', stiffness: 500, damping: 32 },
  // Snippet-panel slide-up (SwiftUI `.spring(response:
  // 0.35, dampingFraction: 0.85)`). Converted to framer-motion: stiffness ≈
  // (2π/0.35)² ≈ 322; damping ≈ 2·0.85·√322 ≈ 30.5.
  snippetSlide: { type: 'spring', stiffness: 322, damping: 30.5 },
} as const

// Easing curves for the few duration-based (non-spring) transitions allowed.
export const eases = {
  out: [0.2, 0, 0, 1], // 100ms button press
  inOut: [0.4, 0, 0.2, 1], // 200ms generic
} as const

// Named duration-based tween presets — used by dnd-kit interactions where
// dnd-kit's own animation language is duration-based. Listed here (alongside
// `springs` and `eases`) so EVERY motion in the app shares one source of
// truth (S10).
//
//   containerIndicate — 350ms ease-out for the group-body outline + bg flip
//                       when a tile is dragged over a group container.
//   dropFlash         — 700ms ease-out for the just-dropped tile's brief
//                       background-color tint (post-drop "landing" hint).
//   gapReveal         — 120ms ease-out for the hover-gap "+ Add group here"
//                       hairline + chip fade.
//   reflow            — 100ms ease-out for dnd-kit's CSS transform reflow
//                       when adjacent tiles shift after a drop (overrides
//                       the dnd-kit default ~200ms; matches the spec).
export const tweens = {
  containerIndicate: { duration: 0.35, ease: 'easeOut' as const },
  dropFlash: { duration: 0.7, ease: 'easeOut' as const },
  gapReveal: { duration: 0.12, ease: 'easeOut' as const },
  reflow: { duration: 0.1, ease: 'easeOut' as const },
} as const

export type SpringName = keyof typeof springs
export type TweenName = keyof typeof tweens
