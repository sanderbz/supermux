// Mode 6 — CSS GRID ROWS. STUB.
//
// TODO(mode-6): container `height:100dvh; display:grid; grid-template-rows:
//   auto 1fr auto` (header / messages / composer). Messages row `min-h-0;
//   overflow-y:auto; overscroll-contain`. Composer in the bottom `auto` row +
//   `env(safe-area-inset-bottom)`. CSS structural, no JS.
//   Risk: same iOS overlay caveat as mode 1 (grid height won't shrink on iOS
//   WebKit). Distinct from 1/10 by STRUCTURE (grid vs flex vs fixed).
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll (`min-h-0` in the `1fr` row); safe-area
// pad. Until implemented this renders the baseline passthrough so the registry
// import resolves and switching to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode6CssGrid: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode6CssGrid
