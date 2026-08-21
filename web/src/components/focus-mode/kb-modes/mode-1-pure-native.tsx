// Mode 1 — PURE NATIVE (dvh). STUB.
//
// TODO(mode-1): implement `height:100dvh; display:flex; flex-direction:column`.
//   Body = `flex-1 min-h-0 overflow-y-auto overscroll-contain`; composer = the
//   LAST flex child with `padding-bottom:env(safe-area-inset-bottom)`. NO JS, no
//   translate, no CSS vars — rely on the global `interactive-widget=
//   resizes-content` meta (index.html) to shrink the layout on keyboard-open.
//   Risk: iOS WebKit ignores `interactive-widget` → keyboard OVERLAYS.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; render header,
// body, composer in that visual order; give body its own scroll; keep a
// home-indicator safe-area pad on the composer; no resting transform on a fixed
// ancestor. Until implemented this renders the baseline passthrough so the
// registry import resolves and switching to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode1PureNative: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode1PureNative
