// Mode 3 — VV IMPERATIVE HEIGHT. STUB.
//
// TODO(mode-3): own a `visualViewport` resize/scroll listener (reuse
//   `createKeyboardOpenDetector` from `use-keyboard-viewport`); imperatively set
//   the container `style.height = visualViewport.height + 'px'` with
//   `position:fixed; top:0; left:0; right:0` — NO translate, NO overshoot, NO
//   CSS-var indirection (this is what makes it distinct from mode 0). Composer =
//   last flex child, safe-area pad. rAF-coalesce the writes.
//   Risk on the owner device: overlap lands in `offsetTop` not `vv.height`.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll; safe-area pad; no resting transform on a
// fixed ancestor. Until implemented this renders the baseline passthrough so the
// registry import resolves and switching to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode3VvHeight: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode3VvHeight
