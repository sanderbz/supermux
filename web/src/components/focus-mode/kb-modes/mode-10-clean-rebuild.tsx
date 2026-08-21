// Mode 10 — CLEAN REBUILD. STUB.
//
// TODO(mode-10): from-scratch minimal layout that IGNORES the ChatSurface
//   scaffolding — a bare `height:100dvh; display:flex; flex-direction:column`
//   with header / `flex-1 min-h-0 overflow-y-auto` body / composer as the last
//   child + `padding-bottom:env(safe-area-inset-bottom)`. The single most-
//   standard textbook pattern, MobileSheet conceptually ripped out (this mode is
//   the outer box). No vars, no vv JS, no overshoot — relies only on the global
//   meta. It is the reference all other modes are compared against.
//   Risk: if `interactive-widget` is unhonored on iOS → same overlay failure as
//   modes 1/6.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll; composer keeps its safe-area pad. Until
// implemented this renders the baseline passthrough so the registry import
// resolves and switching to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode10CleanRebuild: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode10CleanRebuild
