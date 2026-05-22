// Framer Motion spring preset bank — TECH_PLAN §4.7.
//
// These mirror the Termius / SwiftUI "Recommended values per use case" from
// research/termius-ios-native-spec.md. EVERY motion in the app MUST use one of
// these presets. No `transition: all`, no ad-hoc cubic-beziers — PR review
// (the PRINCIPLE critic) enforces this so the whole app shares one motion feel.

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
  // Snippet-panel slide-up (M18 — Termius spec #5: SwiftUI `.spring(response:
  // 0.35, dampingFraction: 0.85)`). Converted to framer-motion: stiffness ≈
  // (2π/0.35)² ≈ 322; damping ≈ 2·0.85·√322 ≈ 30.5.
  snippetSlide: { type: 'spring', stiffness: 322, damping: 30.5 },
} as const

// Easing curves for the few duration-based (non-spring) transitions allowed.
export const eases = {
  out: [0.2, 0, 0, 1], // 100ms button press
  inOut: [0.4, 0, 0.2, 1], // 200ms generic
} as const

export type SpringName = keyof typeof springs
