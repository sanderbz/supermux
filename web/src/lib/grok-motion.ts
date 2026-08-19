// The Grok-mode motion bank — the companion to `lib/springs.ts`, scoped to
// "Grok mode" (the whole-app reskin behind the `[data-grok]` gate, default OFF).
//
// WHY A SEPARATE FILE, NOT NEW KEYS ON `springs`/`tweens`
// ──────────────────────────────────────────────────────────────────────────
// `springs.ts`'s two banks are guarded by `tests/unit/motion-tokens.test.ts`,
// which fails the build the moment a token there has NO consumer ("every token
// in the bank has at least one consumer"). These primitives are FOUNDATION for
// Grok mode (spec §5 WS3): the surfaces that consume them — the roster (WS5),
// the row craft (WS6), the chat re-point (WS8), the state surfaces (WS9) — do
// not exist yet, so they would trip that scan on day one. Living in their own
// module keeps the default bank's "no dead tokens" invariant honest while this
// vocabulary waits for its consumers.
//
// It is also deliberately OUT OF THE DEFAULT ENTRY PATH. Nothing on the default
// hero path imports this file; only Grok-gated components do (and those are
// lazy). So the default bundle never carries a byte of it — the "do not bloat
// the default hero path" gate in the WS3 brief, satisfied structurally rather
// than by hoping the tree-shaker wins.
//
// GROK'S MOTION IS TWEEN-BASED, NOT SPRING-BASED. Grok ships no
// `view-transition-name` and no FLIP; all continuity is *not-unmounting* plus
// opacity/transform on fixed duration+cubic-bezier curves (tokens.md §12,
// mechanics.md §8). So — unlike `springs.ts`, whose SwiftUI-derived springs give
// the default app its iOS feel — this bank is durations + curves + the framer
// `transition` presets built from them. No springs, on purpose.
//
// TWO INVARIANTS (asserted by `tests/unit/grok-motion.test.ts`):
//   1. **Exits are always faster than entries.** overlay .52 in / .30 out;
//      popover .15 in / .10 out. Things arrive with care and leave without
//      ceremony.
//   2. **Axis is identity.** The transcript enters vertically, roster rows slide
//      in horizontally, popovers scale, same-cell state swaps are pure opacity.
//      The axis lives in the CSS keyframes (`styles/grok-mode.css`); the
//      durations/curves that drive them live here. The two halves are kept in
//      agreement by the same test file, exactly as `springs.ts` ↔ `globals.css`
//      are kept in agreement by `motion-tokens.test.ts`.
//
// One very slow transition is reserved for identity: `.60s` on the mascot /
// monogram recolour when the focused session or the theme flips — the slowest
// motion in Grok mode, so a session switch is *felt* as a place settling, not a
// list re-rendering (`grokMotion.identity`; the CSS twin is
// `[data-grok] .grok-identity`).
//
// Reduced motion: the framer half swaps any preset for `motionOff`
// (`lib/springs.ts`, `{ duration: 0 }`) at the call site, exactly like the
// default bank; the CSS half ships colocated `prefers-reduced-motion` twins in
// `grok-mode.css` that also RESTORE the informative static end-state. Offscreen
// loops are paused by the app-wide `[data-offscreen] *` blanket in globals.css —
// Grok's keyframes are ordinary CSS animations under that subtree, so they pause
// for free.

// ── Easing curves — array form (for framer-motion `ease`) ────────────────────
// The five curves Grok drives everything with (tokens.md §12.2). `standard` is
// the default (hover/press, identity); `out` the springy-settle for arrivals and
// overlays; `in` accelerates exits away; `overshoot` gives the transcript entry
// its small pop; `label` staggers the pending label after its avatar.
export const grokEases = {
  standard: [0.4, 0, 0.2, 1],
  out: [0.22, 1, 0.36, 1],
  in: [0.4, 0, 0.6, 1],
  overshoot: [0.2, 0.9, 0.3, 1.15],
  label: [0.2, 0.8, 0.3, 1],
} as const

// ── Easing curves — CSS-string form (for inline styles / `animation`) ────────
// The SAME five curves as `grokEases`, in the shape a stylesheet or an inline
// `style={{ transition }}` needs. Both forms exist so a curve is written once
// and referenced in either medium, never re-typed as a literal that can drift
// (the exact rot `motion-tokens.test.ts` was written to catch on the default
// bank). Kept byte-aligned with `grokEases` by `grok-motion.test.ts`.
export const grokEaseCss = {
  standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  in: 'cubic-bezier(0.4, 0, 0.6, 1)',
  overshoot: 'cubic-bezier(0.2, 0.9, 0.3, 1.15)',
  label: 'cubic-bezier(0.2, 0.8, 0.3, 1)',
} as const

// ── Durations (seconds) — the whole Grok vocabulary (tokens.md §12.1) ────────
// Three speeds, exits faster than entries, one slow identity settle. Named so a
// duration says what the motion *is*; the alternative at a call site is an
// anonymous literal.
export const grokDur = {
  hover: 0.12, //  hover / press — animates background-color AND color together
  glass: 0.15, //  glass fade / popover in — the single most common in Grok's CSS
  dock: 0.18, //   dock-style magnification
  morph: 0.26, //  in-place same-cell crossfade (state pills, Chat|Terminal, ctx%)
  arrive: 0.28, //  transcript entry arrival (vertical pop)
  arriveFresh: 0.42, //  the same arrival when the container is `[data-fresh]`
  exit: 0.3, //    overlay / feature dim-out (faster than its .52 entry)
  pendingLabel: 0.35, //  pending label, staggered after the .28 avatar
  facepile: 0.4, //   facepile pill morph (animates padding to name the actor)
  row: 0.45, //    roster row arrival — HORIZONTAL, the slowest arrival
  overlayIn: 0.52, //  scoped shell overlay enter
  popoverOut: 0.1, //  popover out — faster than its .15 (`glass`) entry
  identity: 0.6, //   mascot / monogram recolour — the slowest motion in Grok mode
  spin: 2.4, //    tool spinner (deliberately slow = "working", not "hung")
  typing: 1.3, //   typing-dot cycle
  cursor: 2.6, //   agent ghost-cursor drift
  // WS4b — agent-mark expression (the CSS twins live in grok-mode.css). Named
  // here so the durations are single-sourced, not literals that can drift.
  streamMouth: 0.9, //   streaming mouth scaleY pulse ("talking")
  errorShake: 0.4, //    failed-state one-shot micro-shake on entry
  attentionPulse: 2, //  needs-you halo strength pulse
  mouthPop: 0.28, //     done-state smile pop-in
  markArrive: 0.28, //   a mark/teammate arriving into a pile
  markLeave: 0.2, //     a mark leaving (exits faster than entries — invariant 1)
} as const

// ── Framer-motion `transition` presets ───────────────────────────────────────
// Ready-to-spread transitions built from the durations + curves above, one per
// purpose. A component spreads `transition={grokMotion.entry}` and swaps in
// `motionOff` (from `springs.ts`) under reduced motion, exactly as the default
// bank is used. `swap` is `linear` opacity on purpose — a same-cell crossfade
// has no distance to ease over.
export const grokMotion = {
  hover: { duration: grokDur.hover, ease: grokEases.standard },
  swap: { duration: grokDur.morph, ease: 'linear' },
  entry: { duration: grokDur.arrive, ease: grokEases.overshoot },
  entryFresh: { duration: grokDur.arriveFresh, ease: grokEases.overshoot },
  pendingLabel: { duration: grokDur.pendingLabel, ease: grokEases.label },
  facepile: { duration: grokDur.facepile, ease: grokEases.standard },
  row: { duration: grokDur.row, ease: grokEases.out },
  overlayIn: { duration: grokDur.overlayIn, ease: grokEases.out },
  overlayExit: { duration: grokDur.exit, ease: grokEases.in },
  popoverIn: { duration: grokDur.glass, ease: grokEases.out },
  popoverOut: { duration: grokDur.popoverOut, ease: grokEases.in },
  identity: { duration: grokDur.identity, ease: grokEases.standard },
} as const

// ── Keyframe names — the CSS half's identifiers, referenced without magic ─────
// The `@keyframes` themselves live in `styles/grok-mode.css` (CSS keyframes
// cannot be scoped, so they are defined globally and applied only under
// `[data-grok]`). These constants let a JS `animation` shorthand name one
// without a bare string that could drift from the stylesheet. `spin` reuses the
// existing global `sm-spin` (2.4s) rather than redefining it.
export const grokKeyframes = {
  entryEnter: 'sm-entry-enter',
  rowEnter: 'sm-row-enter',
  receiptCheck: 'sm-receipt-check',
  pendingLabel: 'sm-pending-label',
  mountFade: 'sm-mount-fade',
  typingDot: 'sm-typing-dot',
  spin: 'sm-spin',
  // WS4b — agent-mark expression keyframes (defined in grok-mode.css).
  streamMouth: 'sm-stream-mouth',
  errorShake: 'sm-error-shake',
  attentionPulse: 'sm-attention-pulse',
  mouthPop: 'sm-mouth-pop',
  markArrive: 'sm-mark-arrive',
  markLeave: 'sm-mark-leave',
} as const

export type GrokEaseName = keyof typeof grokEases
export type GrokDurName = keyof typeof grokDur
export type GrokMotionName = keyof typeof grokMotion
export type GrokKeyframeName = keyof typeof grokKeyframes
