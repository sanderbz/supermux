// Mode 6 — CSS GRID ROWS.
//
// The structural cousin of mode 1 (flex) and mode 10 (from-scratch column): the
// same "no JavaScript, let the layout viewport shrink" bet, but expressed as a
// three-row CSS grid instead of a flex column. One `height:100dvh` grid whose
// `grid-template-rows: auto minmax(0,1fr) auto` reserves an explicit row for the
// header, the transcript, and the composer respectively — the composer row is a
// real, reserved track, not an overlay riding the bottom edge, so the messages
// area is sized to exactly the space left over and the composer can never sit
// UNDER the transcript.
//
// The only moving part is the browser honoring the global viewport meta
// (`interactive-widget=resizes-content`, index.html): when the soft keyboard
// opens on a browser that honors it, the *layout* viewport shrinks, `100dvh`
// shrinks with it, the whole grid gets shorter, and the bottom `auto` composer
// row stays flush against the new (keyboard-top) bottom edge. No measurement, no
// `visualViewport` listener, no CSS var, no `translate`.
//
// TECHNIQUE / why the grid needs a scoped style block
//   ChatSurface hands this mode its three regions PRE-WRAPPED for the default
//   (absolute-overlay) arrangement:
//     · `header`   — `absolute inset-x-0 z-[3]` (a floating card over the top of
//                    the transcript; `headerOverlay` is always on for the phone).
//     · `body`     — a fragment of the `chat-track` scroller
//                    (`min-h-0 flex-1 overflow-y-auto overscroll-contain`) plus
//                    an `absolute` float layer.
//     · `composer` — `absolute inset-x-0 bottom-0 z-[4]` wrapping ComposerFrame.
//   The header is MEANT to float (its `auto` row collapses to 0 and it overlays
//   the transcript top — the intended overlay design). The composer, though,
//   must occupy its grid row for the layout to be a genuine grid rather than a
//   flex clone: an `absolute` child contributes nothing to its track's size, so
//   the bottom `auto` row would collapse and the composer would overlay the body
//   exactly like mode 1. The scoped rule `[data-kb-mode="css-grid"] .kb6-composer
//   > * { position: static }` un-absolutes the wrapper so ComposerFrame flows in
//   the track, the `auto` row sizes to the composer's real height, and the
//   `minmax(0,1fr)` transcript row is the leftover — a true grid split.
//   `.kb6-body` is made a `position:relative` flex column so the handed
//   `flex-1 min-h-0` scroller keeps a bounded height (its own scroll, never the
//   page) and the `absolute` float layer still anchors to it.
//
// SAFE-AREA: no `env(safe-area-inset-bottom)` is added here on purpose. The
// composer's home-indicator pad is owned by `ComposerFrame`
// (`pb-[max(min(--kb-safe-bottom,--safe-bottom),14px)]`); a second env() pad in
// this row would stack on top of it and re-introduce exactly the black band the
// whole mode system exists to kill (see mode 1's identical note).
//
// NO imperative opt-in: the viewport meta is already global, so there is nothing
// to flip on mount or revert on unmount — switching away leaves no residue.
//
// RISK (why it is one of eleven A/B candidates, not THE fix): iOS Safari /
// WKWebView have historically ignored `interactive-widget=resizes-content` — the
// keyboard OVERLAYS the layout viewport, `100dvh` stays at full height, the grid
// does not shrink, and the composer row ends up behind the keyboard. Same caveat
// as modes 1/10; distinct from them purely by STRUCTURE (grid rows vs flex
// column). On a browser that honors the meta this is the cleanest reserved-row
// layout. The owner keeps it only if his hardware gives zero band.
//
// Invariants (contract.ts): default-exports a KbLayoutComponent; renders header,
// body, composer in that visual order; body owns its scroll; composer keeps its
// (ComposerFrame-owned) safe-area pad; no resting transform/filter/backdrop-
// filter/contain on the box, so it never becomes an unintended containing block.

import type { KbLayoutComponent } from './contract'

// Scoped to this mode's root via the `data-kb-mode` attribute so nothing leaks to
// the other ten modes (only one is ever mounted, but the selectors stay defensive):
//   · `.kb6-body`     — a relative flex column so the handed `flex-1 min-h-0`
//                       transcript scroller gets a bounded height and the
//                       `absolute` float layer anchors to it.
//   · `.kb6-composer > *` — un-absolute ChatSurface's composer wrapper so it flows
//                       in the bottom `auto` grid track and the track reserves its
//                       height (the whole point of the grid vs a flex/overlay).
const GRID_STYLE = `
[data-kb-mode="css-grid"] > .kb6-body {
  position: relative;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
[data-kb-mode="css-grid"] > .kb6-composer {
  position: relative;
  min-height: 0;
}
[data-kb-mode="css-grid"] > .kb6-composer > * {
  position: static;
}
`

const Mode6CssGrid: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <div
      data-kb-mode="css-grid"
      style={{
        position: 'relative',
        height: '100dvh',
        width: '100%',
        display: 'grid',
        // header (collapses to 0 — it floats) / transcript (leftover, scrolls) /
        // composer (sized to its real height, flush against the bottom edge).
        gridTemplateRows: 'auto minmax(0, 1fr) auto',
        minHeight: 0,
      }}
    >
      <style>{GRID_STYLE}</style>
      <div className="kb6-header">{header}</div>
      <div className="kb6-body">{body}</div>
      <div className="kb6-composer">{composer}</div>
    </div>
  )
}

export default Mode6CssGrid
