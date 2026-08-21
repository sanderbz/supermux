// Mode 9 — IMPERATIVE ROOT RESIZE. STUB.
//
// TODO(mode-9): on `visualViewport` resize set `document.documentElement.style
//   .height = visualViewport.height + 'px'` (and/or `#root`) so the WHOLE app
//   equals the visible area; composer `bottom:0` in a normal `height:100%`
//   column. REVERT the height in the cleanup / on keyboard-close (component
//   lifecycle is the activation signal — mode 9 mutates a global). Reuse
//   `createKeyboardOpenDetector` from `use-keyboard-viewport` if helpful.
//   Risk: resizing the root reflows ALL fixed chrome / the shell — risky if not
//   reverted cleanly; `vv.height` may not shrink on the owner device.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll; safe-area pad; revert the global in
// cleanup; no resting transform on a fixed ancestor. Until implemented this
// renders the baseline passthrough so the registry import resolves and switching
// to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode9RootResize: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode9RootResize
