// Mode 2 — VirtualKeyboard API. STUB.
//
// TODO(mode-2): on mount set `navigator.virtualKeyboard.overlaysContent = true`
//   (revert to `false` in the cleanup). Composer `position:fixed; left/right:0;
//   bottom:0; padding-bottom:env(keyboard-inset-bottom)`; body reserves the
//   space. Optionally listen to `geometrychange`. Guard `navigator.
//   virtualKeyboard` — it is Chromium/Android only (undefined on iOS WebKit),
//   so no-op there. Set the global in a mount effect and REVERT in cleanup
//   (component lifecycle is the activation signal).
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll; safe-area pad; no resting transform on a
// fixed ancestor (this mode uses position:fixed). Until implemented this renders
// the baseline passthrough so the registry import resolves and switching to this
// mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode2VirtualKeyboard: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode2VirtualKeyboard
