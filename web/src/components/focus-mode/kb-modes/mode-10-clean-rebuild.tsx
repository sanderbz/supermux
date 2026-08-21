// Mode 10 — CLEAN REBUILD.
//
// The textbook reference every other mode is measured against. It throws away the
// whole ChatSurface keyboard-avoidance apparatus — no `visualViewport` observer,
// no `--vvh`/`--vv-offset-top`/`--kb` CSS vars, no `translate`, no overshoot, no
// `position:fixed` box, no `MobileSheet`. What remains is the single most-standard
// mobile chat layout, expressed in the fewest possible moving parts:
//
//     ┌──────────────────────────── height:100dvh, flex column ─┐
//     │  header      (floating overlay pill, as designed)        │
//     │  body        flex-1 min-h-0 overflow-y-auto  ← scrolls   │
//     │  composer    a REAL last-flow-child, flush at the bottom │
//     └─────────────────────────────────────────────────────────┘
//
// The ONLY moving part is the browser honoring the global
// `interactive-widget=resizes-content` viewport meta (index.html): when the soft
// keyboard opens it shrinks the *layout* viewport — and therefore `100dvh` — so
// the whole column gets shorter and the composer, being the last flow child, is
// carried up to sit flush on top of the keyboard. Zero JavaScript participates.
//
// WHY IT DIFFERS FROM MODE 1 (pure-native)
//   Mode 1 leaves the composer in its pre-wrapped `absolute inset-x-0 bottom-0`
//   overlay, floating over the transcript's tail. This mode instead promotes the
//   composer to a genuine in-FLOW last child (the scoped style below neutralises
//   that `absolute` wrapper to `position:static`), so the `flex-1` body actually
//   shrinks to sit ABOVE it rather than behind it. That is the "clean rebuild":
//   header row / scroll body / footer, the layout you would write on a blank page
//   with no legacy scaffolding — and the honest control for judging whether any of
//   the cleverer modes earns its complexity.
//
// SAFE-AREA PAD — deliberately NOT re-added here.
//   Contract invariant #4 (home-indicator clearance) is already satisfied by the
//   composer node itself: `ComposerFrame` (composer-shell.tsx) carries
//   `pb-[max(min(--kb-safe-bottom,--safe-bottom),env(safe-area-inset-bottom)…),14px)]`,
//   which resolves to the safe-area inset at rest and collapses toward 14px when
//   the keyboard opens. Adding a SECOND `padding-bottom:env(safe-area-inset-bottom)`
//   on the wrapper would stack on top of that at rest and reconstruct precisely the
//   ~68px black band this whole system exists to kill. The clean rebuild therefore
//   trusts the composer's own pad and adds none of its own.
//
// RISK (why it is one of eleven A/B candidates, not THE fix): iOS Safari / WKWebView
// have historically ignored `interactive-widget=resizes-content` — the keyboard
// OVERLAYS the layout viewport, `100dvh` stays at full height, and the composer can
// end up behind the keyboard (the same failure mode as modes 1 and 6). On a browser
// that honors it this is the cleanest possible layout. The owner keeps it only if
// his hardware gives zero band.
//
// Invariants (contract.ts): default-exports a KbLayoutComponent; renders header,
// body, composer in that visual order; body owns its scroll; composer keeps its
// safe-area pad (via ComposerFrame, see above); no resting
// transform/filter/backdrop-filter/contain on the box, so it never becomes an
// unintended containing block for fixed chrome. No global is mutated, so there is
// nothing to revert on unmount — switching away leaves zero residue.

import type { KbLayoutComponent } from './contract'

// Scoped, self-reverting (unmounts with the component) style that turns the
// pre-wrapped `absolute inset-x-0 bottom-0 z-[4]` composer wrapper — always the
// LAST direct child of the box — into a normal in-flow flex item. Specificity
// (0,2,0: attribute + `:last-child` on the element type) beats the utility
// `.absolute` (0,1,0) with no `!important` needed. Under `position:static` the
// wrapper's `inset-x-0`/`bottom-0` become inert and it lays out as the footer of
// the flex column. `flex:0 0 auto` keeps it at its natural height while the body
// takes the rest.
const SCOPED_CSS =
  '[data-kb-mode="clean-rebuild"] > :last-child{position:static;flex:0 0 auto;width:100%;}'

const Mode10CleanRebuild: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <div
      data-kb-mode="clean-rebuild"
      style={{
        // `relative` (not `fixed`): the header-overlay pill (`absolute inset-x-0
        // z-[3]`, first child) anchors to THIS box's top edge. No transform/filter
        // here, so it is a clean containing block and never traps fixed chrome.
        position: 'relative',
        // The whole trick: a column exactly as tall as the visible viewport, which
        // `interactive-widget=resizes-content` shrinks when the keyboard opens.
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        // Let the flex children (the `flex-1` body in particular) shrink below
        // their content height so the body's own overflow scroller engages instead
        // of the column growing past the viewport and pushing the composer off.
        minHeight: 0,
        width: '100%',
      }}
    >
      <style>{SCOPED_CSS}</style>
      {header}
      {body}
      {composer}
    </div>
  )
}

export default Mode10CleanRebuild
