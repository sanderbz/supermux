// Mode 3 — VV IMPERATIVE HEIGHT.
//
// The distinct technique: this layout is its OWN outer keyboard-avoiding box —
// `position:fixed; top:0; left:0; right:0` — and a `visualViewport` listener
// imperatively pins its `style.height` to `visualViewport.height` (in px) on
// every resize/scroll. There is NO translate, NO overshoot, and NO CSS-var
// indirection (`--vvh` / `--vv-offset-top` are never read). That is precisely
// what separates it from mode 0 (baseline): mode 0 sizes off the `--vvh` var and
// translates the box DOWN by `--vv-offset-top`; mode 3 pins `top:0` and sizes the
// box straight off `visualViewport.height`.
//
// Because the box is fixed and shrunk to exactly the visible viewport, its
// bottom edge sits on top of the soft keyboard. The composer (handed to us as an
// `absolute inset-x-0 bottom-0` node) then pins to that bottom edge — flush,
// zero band — while the body fills the remaining space and owns its own scroll.
//
// Cold-launch guard (mirrors `useKeyboardViewport`): on an iOS PWA cold launch
// `visualViewport.height` briefly evaluates to physical-screen-minus-home-
// indicator; pinning `style.height` to it there would paint a black bar BELOW
// the app. So we only pin the imperative px height while the keyboard is OPEN
// (via the shared dual-signal `createKeyboardOpenDetector`); when closed we
// clear the inline height and fall back to the CSS `100dvh` base. All writes are
// rAF-coalesced and every listener is removed on unmount, so switching modes is
// clean and leaves no global side-effect (this mode mutates nothing outside its
// own element).
//
// Documented risk on the OWNER device: iOS 26 standalone PWA absorbs the whole
// keyboard overlap into `visualViewport.offsetTop`, leaving `.height` at full
// height — so the imperative height may not actually shrink and the box may
// still float. That is the exact failure this mode probes; it is A/B-tested
// against the other ten. The `keyboardOpen` gate still flips (the detector reads
// `offsetTop`), we just have no shorter height to pin.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; render header /
// body / composer in that visual order; the body keeps its own
// `overflow-y:auto; overscroll-contain; min-h-0`; the composer keeps its
// home-indicator safe-area pad (owned by `ComposerFrame`); and there is no
// resting transform on a fixed ancestor (the edge-swipe wrapper only transforms
// while dragging — see mobile.tsx).

import * as React from 'react'

import { createKeyboardOpenDetector } from '@/hooks/use-keyboard-viewport'

import type { KbLayoutComponent } from './contract'

const Mode3VvHeight: KbLayoutComponent = ({ header, body, composer }) => {
  const boxRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = boxRef.current
    const visual =
      typeof window !== 'undefined' ? window.visualViewport : undefined
    // Desktop / no visualViewport: nothing to observe; the CSS `100dvh` base on
    // the box governs and the composer sits flush at the real bottom.
    if (!el || !visual) return

    let raf = 0
    // Reused dual-signal detector (iOS visual-viewport shrink / offsetTop, or
    // Android layout-viewport shrink) — carries its own baseline state, one per
    // consumer, so we own an independent instance here.
    const detect = createKeyboardOpenDetector()

    const apply = () => {
      raf = 0
      const { open } = detect(visual)
      if (open) {
        // THE technique: pin the fixed box to exactly the visible viewport
        // height. `top:0` (set in the inline style below) keeps its top edge at
        // the top of the layout viewport; the shrunk height drops its bottom
        // edge onto the keyboard. No translate, no vars.
        el.style.height = `${visual.height}px`
      } else {
        // Keyboard closed → clear the imperative height and fall back to the CSS
        // `100dvh` base (avoids the cold-launch black bar; see header note).
        el.style.height = ''
      }
    }

    const schedule = () => {
      if (raf) return
      raf =
        typeof requestAnimationFrame !== 'undefined'
          ? requestAnimationFrame(apply)
          : (apply() as unknown as number)
    }

    // Measure once on mount, then on every viewport change. `scroll` matters on
    // iOS: as the keyboard animates, the visual viewport both resizes AND scrolls
    // (offsetTop), and we want the latest `.height`/`open` on both.
    apply()
    visual.addEventListener('resize', schedule)
    visual.addEventListener('scroll', schedule)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      visual.removeEventListener('resize', schedule)
      visual.removeEventListener('scroll', schedule)
      // Leave no residue: drop the inline height so the next mode starts clean.
      el.style.height = ''
    }
  }, [])

  return (
    <div
      ref={boxRef}
      data-kb-mode="vv-height"
      // Own outer box: fixed to the layout viewport, pinned at the TOP (no
      // translate — the imperative px height, set on keyboard-open, is what drops
      // the bottom edge onto the keyboard). `100dvh` is the closed-state / no-JS
      // fallback the effect clears back to. `overflow-hidden` keeps the box itself
      // from scrolling — the body owns the only scroll region.
      className="flex flex-col overflow-hidden"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '100dvh',
      }}
    >
      {header}
      {body}
      {composer}
    </div>
  )
}

export default Mode3VvHeight
