// Mode 4 — FIXED COMPOSER + LIFT.
//
// Technique. The composer is taken OUT of the layout flow and pinned with
// `position:fixed` as an OVERLAY at the bottom of the visible viewport; the
// transcript is a plain flex column that reserves the composer's footprint as
// bottom padding so its last message always clears the pinned bar. That "fixed
// composer + the body reserves space for it" shape is what distinguishes this
// mode from the baseline (whose composer is an in-flow last child) — the same
// pattern a native app uses for an input accessory bar.
//
// WHY THE LIFT IS `--vv-overshoot`, NOT `--kb`. The plan's original sketch fixed
// the composer to the WHOLE layout viewport and lifted it by the keyboard inset
// (`--kb`) — that assumed each `KbLayout` REPLACED `MobileSheet`. In the shipped
// integration it does not: the chat surface still renders INSIDE `MobileSheet`
// (`focus-mode/mobile-sheet.tsx`), a `position:fixed` box whose `transform:
// translateY(var(--vv-offset-top))` is a resting transform even at 0px — so it
// is the containing block for every `position:fixed` descendant, AND it is
// already sized to the VISUAL viewport (`height: var(--vvh) + var(--vv-overshoot)`,
// pinned to the keyboard on iOS). Inside that box a `bottom:var(--kb)` composer
// double-counts the avoidance and floats to mid-screen (measured: bar at y≈190
// with a 344px keyboard). The visible-viewport bottom — the keyboard line — sits
// exactly `--vv-overshoot` ABOVE the sheet's own box bottom (the sheet
// deliberately overshoots ~34px behind the keyboard while driving, 0px at rest).
// So `bottom: var(--vv-overshoot, 0px)` is the correct in-sheet lift: it parks
// the composer flush on the keyboard when open and at the screen bottom at rest,
// with no band — the mode's actual goal.
//
// Risk (why this is one of eleven A/B modes): the whole approach still rides on
// `MobileSheet` sizing itself correctly off `visualViewport`. On the owner's
// device the overlap is absorbed into `visualViewport.offsetTop` rather than
// `.height`, which is exactly the measurement the sheet can misread — if the
// sheet mis-sizes, this fixed overlay mis-sits with it. On true vv-shrink
// devices the sheet is correct and the bar lands flush. That is the hypothesis
// this mode lets the owner test in isolation.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; render header /
// body / composer in that visual order; the body owns its own
// `overflow-y:auto; overscroll-contain; min-h-0` scroll (`body` supplies those on
// its track); the composer keeps a home-indicator safe-area pad (its own
// `pb-[max(--kb-safe-bottom,…)]`, which is `env(safe-area-inset-bottom)` at rest
// and 0 while typing); and this file introduces NO resting transform/filter/
// contain of its own on any ancestor of the fixed composer.

import type { KbLayoutComponent } from './contract'

// Generous estimate of the composer bar's own (non-safe-area) height — a
// one-line pill plus its frame padding. It only feeds the transcript's bottom
// reserve, so a little slack is invisible; the bar's real height is whatever it
// renders. A CSS constant (not a measured value) keeps this a pure zero-runtime
// layout — no hooks, no observer — so mode 4's lazy chunk stays tiny.
const COMPOSER_H = '5.25rem'

const Mode4FixedLift: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    // Fills MobileSheet (the visible-viewport box). `position:relative` gives the
    // body's floating header/float layers their containing block; it carries NO
    // transform/filter of its own. `data-kb-mode` tags the active mode for the
    // offline rig / tests.
    <div data-kb-mode="fixed-lift" className="relative flex h-full w-full flex-col">
      {header}

      {/* The scroll region. `min-h-0 flex-1` hands it the remaining height; the
          bottom padding reserves the fixed composer's footprint — its own height
          plus the safe-area pad it wears at rest plus the sheet's keyboard-open
          overshoot — so the last message always clears the pinned bar. `body`
          itself owns overflow / overscroll on its track. */}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        style={{
          paddingBottom: `calc(${COMPOSER_H} + var(--kb-safe-bottom, 0px) + var(--vv-overshoot, 0px))`,
        }}
      >
        {body}
      </div>

      {/* The fixed overlay. Pinned to the sheet's containing block; `bottom`
          equals the sheet's own overshoot so the bar's bottom edge lands on the
          visible-viewport bottom (the keyboard line) when open and at the screen
          bottom at rest — flush, no black band. The incoming composer node is
          `absolute inset-x-0 bottom-0`, so it fills this fixed, full-width
          wrapper; the composer's own `pb-[max(--kb-safe-bottom,…)]` supplies the
          home-indicator pad. */}
      <div
        className="z-[4]"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 'var(--vv-overshoot, 0px)',
        }}
      >
        {composer}
      </div>
    </div>
  )
}

export default Mode4FixedLift
