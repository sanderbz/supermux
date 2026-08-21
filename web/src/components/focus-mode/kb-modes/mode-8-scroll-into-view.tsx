// Mode 8 — ScrollIntoView ON FOCUS. STUB.
//
// TODO(mode-8): composer in NORMAL document flow at the end of a `100dvh` (or
//   `min-height:100dvh`) scroll column; scroller gets `scroll-padding-bottom`.
//   On composer `focusin`, call `composerEl.scrollIntoView({block:'end'})` and
//   let the browser scroll it above the keyboard. One `focusin` listener + CSS
//   `scroll-padding-bottom`; no meta change.
//   Risk: momentary band before the scroll settles; iOS may leave the composer
//   partly covered; scroll jank on re-layout.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll; composer keeps its safe-area pad. Until
// implemented this renders the baseline passthrough so the registry import
// resolves and switching to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode8ScrollIntoView: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode8ScrollIntoView
