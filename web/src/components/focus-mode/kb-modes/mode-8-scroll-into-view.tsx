// Mode 8 — SCROLLINTOVIEW ON FOCUS.
//
// The distinct technique: the composer rides in NORMAL document flow at the
// bottom of a `100dvh` flex column — no `position:fixed`, no imperative height,
// no `visualViewport` measurement of its own — and the ONLY moving part is a
// single `focusin` listener that, the moment the composer's field gains focus,
// calls `composerEl.scrollIntoView({ block: 'end' })`. The browser then scrolls
// whatever ancestor CAN scroll (on the phone that is the shared
// `<main data-shell-content overflow-auto>` the focus shell renders into) so the
// composer's bottom edge lands inside the VISIBLE (visual-viewport) area, above
// the soft keyboard. This is the same reflex iOS applies to a focused native
// control — the one that keeps the terminal `<input>` flush — invoked
// explicitly for a contenteditable, which the platform does not always
// auto-scroll on its own.
//
// TECHNIQUE / why the composer must be un-absoluted
//   ChatSurface hands every mode its three regions PRE-WRAPPED for the default
//   (absolute-overlay) arrangement:
//     · `header`   — `absolute inset-x-0 z-[3]` (a floating card over the
//                    transcript top; the phone always uses the header overlay).
//     · `body`     — a fragment of the `chat-track` scroller
//                    (`min-h-0 flex-1 overflow-y-auto overscroll-contain`) plus
//                    an `absolute` float layer.
//     · `composer` — `absolute inset-x-0 bottom-0 z-[4]` wrapping ComposerFrame.
//   An `absolute` composer is NOT a scroll target — `scrollIntoView` on a fixed/
//   absolute element that is already pinned to the box bottom moves nothing. So
//   the scoped rule `[data-kb-mode="scroll-into-view"] > .kb8-composer > *
//   { position: static }` un-absolutes ChatSurface's wrapper: ComposerFrame then
//   flows as the column's last child, occupies real layout space, and becomes a
//   genuine element the browser can scroll into view. `.kb8-body` is made a
//   `position:relative` flex column so the handed `flex-1 min-h-0` transcript
//   keeps a BOUNDED height (its own scroll, never the page) and the `absolute`
//   float layer still anchors to it. The body scroller also gets
//   `scroll-padding-bottom` (the safe-area pad) so the last message clears the
//   home indicator when the transcript itself scrolls to the bottom.
//
// THE FOCUS REFLEX (the mode's whole point)
//   A `focusin` listener on the root fires when focus enters the composer
//   subtree. `scrollIntoView({ block: 'end' })` aligns the composer's bottom to
//   the scroll container's visible bottom. Because the iOS keyboard animates in
//   over ~250ms and the visual viewport keeps changing during that window, one
//   call fires too early (the "momentary band before the scroll settles"), so we
//   re-issue it on the next frame, after a short settle delay, AND on every
//   `visualViewport` resize/scroll while the composer stays focused — each write
//   is rAF-coalesced. All listeners are torn down on blur and on unmount, and the
//   mode mutates nothing outside its own subtree, so switching modes is clean.
//
// SAFE-AREA: no extra `env(safe-area-inset-bottom)` pad is added on the composer
// itself — its home-indicator pad is owned by `ComposerFrame`
// (`pb-[max(min(--kb-safe-bottom,--safe-bottom),14px)]`); a second env() pad here
// would stack and re-introduce exactly the black band the whole mode system
// exists to kill (same note as modes 1/6/10). `block:'end'` therefore lands the
// composer's real bottom edge flush on the keyboard.
//
// NO global opt-in: no viewport-meta change, no `documentElement` mutation, no
// `virtualKeyboard` flag — only a scroll call on the mode's own element and a
// scoped `<style>` that unmounts with the component. Nothing to revert beyond
// removing the listeners.
//
// RISK (why it is one of eleven A/B candidates, not THE fix): if no ancestor can
// actually scroll (the layout viewport did not shrink and the content already
// fits), `scrollIntoView` has nowhere to move the composer and it can stay partly
// behind the keyboard; and even when it works there can be a brief band before
// the animated scroll settles. The owner keeps it only if his hardware gives
// zero band.
//
// Invariants (contract.ts): default-exports a KbLayoutComponent; renders header,
// body, composer in that visual order; the body keeps its own
// `overflow-y:auto; overscroll-contain; min-h-0`; the composer keeps its
// (ComposerFrame-owned) safe-area pad; and there is no resting transform/filter/
// backdrop-filter/contain on the box, so it never becomes an unintended
// containing block for fixed chrome.

import * as React from 'react'

import type { KbLayoutComponent } from './contract'

// Scoped to this mode's root via `data-kb-mode` so nothing leaks to the other ten
// modes (only one is ever mounted, but the selectors stay defensive):
//   · `.kb8-body`         — a relative flex column so the handed `flex-1 min-h-0`
//                           transcript scroller gets a bounded height, the
//                           `absolute` float layer anchors to it, and the scroller
//                           carries a home-indicator `scroll-padding-bottom`.
//   · `.kb8-composer > *` — un-absolute ChatSurface's composer wrapper so
//                           ComposerFrame flows as the column's last child and
//                           becomes a real `scrollIntoView` target.
const SCROLL_INTO_VIEW_STYLE = `
[data-kb-mode="scroll-into-view"] > .kb8-body {
  position: relative;
  min-height: 0;
  flex: 1 1 0%;
  display: flex;
  flex-direction: column;
}
[data-kb-mode="scroll-into-view"] > .kb8-body [data-chat-track] {
  scroll-padding-bottom: var(--kb-safe-bottom, env(safe-area-inset-bottom));
}
[data-kb-mode="scroll-into-view"] > .kb8-composer {
  position: relative;
  min-height: 0;
  /* The scroller whose bottom edge scrollIntoView({block:'end'}) targets: pad it
     so the composer lands above the home indicator, not under it. */
  scroll-padding-bottom: var(--kb-safe-bottom, env(safe-area-inset-bottom));
}
[data-kb-mode="scroll-into-view"] > .kb8-composer > * {
  position: static;
}
`

const Mode8ScrollIntoView: KbLayoutComponent = ({ header, body, composer }) => {
  const composerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = composerRef.current
    if (!el || typeof window === 'undefined') return

    const visual = window.visualViewport ?? undefined
    let raf = 0
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    // Only chase the viewport while the composer actually holds focus — otherwise
    // an unrelated visualViewport resize (rotation, other input) would yank the
    // transcript around.
    let focused = false

    const bringIntoView = () => {
      raf = 0
      // Align the composer's bottom edge to the scroll container's visible bottom
      // (above the keyboard). No smooth behavior: the keyboard is animating and a
      // smooth scroll would fight it — an instant align on each frame reads as the
      // composer simply staying put at the keyboard top.
      el.scrollIntoView({ block: 'end', inline: 'nearest' })
    }

    const schedule = () => {
      if (raf) return
      raf =
        typeof requestAnimationFrame !== 'undefined'
          ? requestAnimationFrame(bringIntoView)
          : (bringIntoView() as unknown as number)
    }

    const onFocusIn = (e: FocusEvent) => {
      // Focus landed somewhere inside the composer subtree (the contenteditable
      // field or a toolbar control).
      if (!(e.target instanceof Node) || !el.contains(e.target)) return
      focused = true
      // Fire now, next frame, and after the keyboard's open animation settles —
      // the single early call otherwise lands during the "momentary band" before
      // the visual viewport finishes shrinking.
      schedule()
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(schedule, 300)
    }

    const onFocusOut = (e: FocusEvent) => {
      // Focus left the composer entirely (not just moved between its children).
      const next = e.relatedTarget
      if (next instanceof Node && el.contains(next)) return
      focused = false
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = undefined
      }
    }

    const onViewportChange = () => {
      if (focused) schedule()
    }

    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    // As the keyboard animates the visual viewport both resizes AND scrolls; keep
    // the composer aligned to the settling bottom on both while it stays focused.
    visual?.addEventListener('resize', onViewportChange)
    visual?.addEventListener('scroll', onViewportChange)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (settleTimer) clearTimeout(settleTimer)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      visual?.removeEventListener('resize', onViewportChange)
      visual?.removeEventListener('scroll', onViewportChange)
    }
  }, [])

  return (
    <div
      data-kb-mode="scroll-into-view"
      // Plain `100dvh` flex column — the composer is NOT lifted by this box; it
      // rides in normal flow at the bottom and the focus reflex scrolls it above
      // the keyboard. `relative` anchors the pre-wrapped absolute header/float
      // layers; `min-height:0` lets the body child shrink so its own scroller
      // engages instead of the column growing past the viewport. No resting
      // transform/filter/contain, so no fixed chrome is trapped by this box.
      style={{
        position: 'relative',
        height: '100dvh',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <style>{SCROLL_INTO_VIEW_STYLE}</style>
      <div className="kb8-header">{header}</div>
      <div className="kb8-body">{body}</div>
      <div ref={composerRef} className="kb8-composer">
        {composer}
      </div>
    </div>
  )
}

export default Mode8ScrollIntoView
