// Mode 5 — STICKY FOOTER. STUB.
//
// TODO(mode-5): the whole view is ONE `height:100dvh; overflow-y:auto` scroll
//   container. Header `position:sticky; top:0`; messages in flow; composer
//   `position:sticky; bottom:0`. Messages scroll under a pinned composer.
//   CSS only; relies on `interactive-widget=resizes-content` (global) to shrink
//   the scroll container.
//   Risk: iOS sticky-bottom + keyboard is unreliable (can jump / sit behind kb).
//
// NOTE: this mode makes the OUTER element the scroller, so `body` should NOT keep
// its own `overflow-y:auto` here — reconcile that when implementing (the body
// node still carries the class today; wrap or restyle as needed).
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; safe-area pad on the composer. Until implemented this renders
// the baseline passthrough so the registry import resolves and switching to this
// mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode5StickyFooter: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode5StickyFooter
