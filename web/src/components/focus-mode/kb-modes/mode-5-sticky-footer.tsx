// Mode 5 — STICKY FOOTER.
//
// Mechanism. The whole chat view is ONE scroll container — `height:100dvh;
// overflow-y:auto` — and NOTHING inside it is `position:fixed`. The header and
// the composer are pinned with `position:sticky` (top and bottom); the
// transcript flows between them as ordinary in-flow content. As you scroll, the
// messages slide UNDER a header that stays glued to the top and a composer that
// stays glued to the bottom. There is no measurement, no `visualViewport`
// listener, no CSS var, no `translate` — the only moving part is the browser
// honoring the global `interactive-widget=resizes-content` viewport meta
// (index.html): when the soft keyboard opens it shrinks the *layout* viewport
// (and therefore `100dvh`), the scroll container gets shorter, and the
// sticky-bottom composer rides up to sit flush on the keyboard top.
//
// WHY A SINGLE SCROLLER (and not the app's usual inner-track scroller). Sticky
// positioning is resolved against the nearest scrollport. For the composer to
// stick to the bottom of the *view*, the view itself has to be the scroller and
// the composer has to be a direct in-flow child of it — so this mode collapses
// the two-box "fixed shell + inner overflow track" arrangement into one. The
// incoming `body` node still carries `min-h-0 flex-1 overflow-y-auto` on its
// track, but because THIS outer box is a plain block (not a flex column), the
// `flex-1` is inert and the track's `overflow-y:auto` with an auto height never
// reaches an overflow threshold — it grows to its content and lets the OUTER box
// do the scrolling. One scrollport, exactly as the technique needs.
//
// HOW THE PRE-WRAPPED SLOTS ARE PINNED. `chat-surface.tsx` hands the header and
// composer already wrapped in `position:absolute` boxes (the header overlay card
// `absolute inset-x-0` under the notch; the composer `absolute inset-x-0
// bottom-0 z-[4]`). An absolute box needs a positioned ancestor to anchor to, so
// each is wrapped here in a zero-height `position:sticky` shim:
//   · HEADER  — `sticky; top:0` shim → the absolute card anchors to it and the
//     shim glues to the scrollport top, so the floating header stays put while
//     the transcript scrolls under it (exactly what `headerOverlay` intends).
//   · COMPOSER — `sticky; bottom:0` shim → the absolute composer anchors to it
//     and the shim glues to the scrollport bottom, so the bar rests flush at the
//     bottom of the visible view (→ flush on the keyboard once `100dvh` shrinks).
// The shims are zero-height on purpose: they reserve no flow space of their own,
// so they cannot introduce a band. The room the last message needs to clear the
// composer is already baked into the transcript's own bottom reserve
// (`conversation.tsx` pads the message list by the measured composer height, QA
// #12), which travels with `body` — so this mode adds NO reserve and NO extra
// bottom padding. The composer's home-indicator safe-area pad is likewise owned
// by `ComposerFrame` (`pb-[max(min(--kb-safe-bottom,--safe-bottom),14px)]`); a
// second `env(safe-area-inset-bottom)` here would re-introduce the very band the
// system exists to kill.
//
// NO imperative opt-in: `interactive-widget=resizes-content` is already on the
// global meta, so there is nothing to flip on mount / revert on unmount. The
// mode is pure declarative CSS and switching away leaves no residue.
//
// RISK (why it is one of eleven A/B candidates, not THE fix): on iOS Safari /
// WKWebView `interactive-widget=resizes-content` is historically ignored — the
// keyboard OVERLAYS the layout viewport, `100dvh` stays full, and a `sticky;
// bottom:0` element resolves against the *un-shrunk* scrollport bottom, which now
// sits BEHIND the keyboard — so the composer can end up hidden or jumpy under the
// keyboard (WebKit's sticky-bottom + keyboard behaviour is the documented weak
// point). On a browser that honors the meta (Android Chrome, any future iOS that
// ships support) this is the cleanest possible layout. The owner keeps it only
// if his hardware gives zero band.
//
// KNOWN COSMETIC CAVEAT: the transcript's jump-to-bottom pill (`body`'s `float`
// layer, `absolute inset-x-0 bottom-0`) anchors to this scroll container's
// content box rather than the viewport, so in this single-scroller mode it rides
// with the content bottom instead of hovering above the composer. That is a
// non-blocking presentation detail of the technique, not a layout break — the
// composer and the transcript scroll are fully functional.
//
// Invariants (contract.ts): default-exports a KbLayoutComponent; renders header,
// body, composer in that visual order; the body owns its own scroll semantics
// (it is simply promoted to the single outer scrollport here); the composer
// keeps its safe-area pad (owned by ComposerFrame, untouched); and there is NO
// resting transform/filter/backdrop-filter/contain on this box — it uses no
// `position:fixed` at all, so the transform-ancestor guard does not even apply.

import type { KbLayoutComponent } from './contract'

const Mode5StickyFooter: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    // THE single scroll container. `100dvh` so the browser (where it honors
    // `interactive-widget=resizes-content`) shrinks it on keyboard-open and the
    // sticky footer rides up. `position:relative` gives the absolute layers a
    // sane anchor; `overscroll-behavior:contain` keeps a bounce at the transcript
    // edge from chaining into the shell (same reason the track carries it). No
    // transform / filter / backdrop-filter here.
    <div
      data-kb-mode="sticky-footer"
      style={{
        position: 'relative',
        height: '100dvh',
        width: '100%',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        // iOS momentum scrolling for the promoted scrollport.
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {/* HEADER shim — zero-height `sticky; top:0`. The incoming header card is
          `absolute`, so it anchors to this positioned shim and stays glued to the
          top of the view while the transcript scrolls under it. z above the
          composer's own layer so the card is never occluded at the top. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, height: 0 }}>{header}</div>

      {/* The transcript, in normal flow. Its track's `overflow-y:auto` is inert
          under this block parent (auto height never overflows), so the content
          flows and THIS outer box scrolls it — one scrollport. */}
      {body}

      {/* COMPOSER shim — zero-height `sticky; bottom:0`. The incoming composer is
          `absolute inset-x-0 bottom-0`, so it anchors to this positioned shim and
          the shim glues to the scrollport bottom: the bar rests flush at the
          bottom of the visible view (flush on the keyboard once `100dvh`
          shrinks). Zero-height so it reserves no band; the transcript already
          reserves the composer's footprint at its own bottom (QA #12). */}
      <div style={{ position: 'sticky', bottom: 0, zIndex: 4, height: 0 }}>{composer}</div>
    </div>
  )
}

export default Mode5StickyFooter
