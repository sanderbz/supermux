// Mode 4 — FIXED COMPOSER + LIFT. STUB.
//
// TODO(mode-4): body = plain `100dvh` column. Composer `position:fixed;
//   left/right:0; bottom:0; transform:translateY(calc(-1 * var(--kb)))` (or
//   `bottom:var(--kb)`), consuming the existing `--kb` shell var. Body gets
//   `padding-bottom: calc(composerHeight + var(--kb))` so the last message
//   clears the lifted composer.
//   Risk on the owner device: `--kb` resolves to 0 (overlap in offsetTop) → no
//   lift; works on true vv-shrink devices.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll; safe-area pad; no resting transform on a
// fixed ancestor (this mode uses position:fixed for the composer). Until
// implemented this renders the baseline passthrough so the registry import
// resolves and switching to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode4FixedLift: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode4FixedLift
