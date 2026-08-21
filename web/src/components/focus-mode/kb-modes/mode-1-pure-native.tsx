// Mode 1 — PURE NATIVE (dvh).
//
// The single most-standard mobile layout, expressed with zero JavaScript: one
// `height:100dvh` flex column, a `flex-1 min-h-0` scroll body, and the composer
// riding at the column's bottom. Nothing here reads or writes a `visualViewport`
// value, sets a `translate`, or touches a CSS var — the ONLY moving part is the
// browser honoring the global `interactive-widget=resizes-content` viewport meta
// (index.html), which shrinks the *layout* viewport (and therefore `100dvh`)
// when the soft keyboard opens, floating the composer up to the keyboard top.
//
// This is the native-control cousin of the flush terminal `<input>`: no
// measurement, no imperative sizing, just the platform's own keyboard-avoidance.
//
// TECHNIQUE
//   · Outer box: `position:relative; height:100dvh; display:flex;
//     flex-direction:column`. `relative` so the pre-wrapped `absolute` composer
//     (`chat-surface.tsx` wraps `footer` in `absolute inset-x-0 bottom-0 z-[4]`)
//     and an `absolute` header-overlay card anchor to THIS box's edges.
//   · Body: rendered as handed — it already carries
//     `min-h-0 flex-1 overflow-y-auto overscroll-contain`, so it takes the
//     remaining height and owns its own scroll (never the page).
//   · Composer: the last child, pinned flush to the box bottom. Its
//     home-indicator safe-area pad is owned by `ComposerFrame`
//     (`pb-[max(min(--kb-safe-bottom,--safe-bottom),14px)]`), so this mode adds
//     NO extra bottom padding — a second `env(safe-area-inset-bottom)` here would
//     re-introduce exactly the black band the whole system exists to kill.
//
// NO imperative opt-in: `interactive-widget=resizes-content` is already on the
// global meta, so there is nothing to flip on mount / revert on unmount — the
// mode is pure declarative CSS and switching away from it leaves no residue.
//
// RISK (why it is one of eleven A/B candidates, not THE fix): iOS Safari /
// WKWebView have historically ignored `interactive-widget=resizes-content` — the
// keyboard OVERLAYS the layout viewport and `100dvh` stays at its full height, so
// the composer can end up behind the keyboard. On a browser that DOES honor it
// (Android Chrome, and any future iOS that ships support) this is the cleanest
// possible layout. The owner keeps it only if his hardware gives zero band.
//
// Invariants (contract.ts): default-exports a KbLayoutComponent; renders header,
// body, composer in that visual order; body owns its scroll; composer keeps its
// safe-area pad; no resting transform/filter/backdrop-filter/contain on the box,
// so it never becomes an unintended containing block for fixed chrome.

import type { KbLayoutComponent } from './contract'

const Mode1PureNative: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <div
      data-kb-mode="pure-native"
      style={{
        position: 'relative',
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        // A flex column whose body child must be allowed to shrink below its
        // content height so its own overflow scroller engages instead of the box
        // growing past the viewport.
        minHeight: 0,
        width: '100%',
      }}
    >
      {header}
      {body}
      {composer}
    </div>
  )
}

export default Mode1PureNative
