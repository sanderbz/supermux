// IMPERATIVE ROOT RESIZE.
//
// The distinct technique: instead of sizing its OWN box, this
// layout shrinks the WHOLE application's root — `document.documentElement`,
// `document.body` AND `#root` — to exactly the visible viewport height on every
// `visualViewport` resize, so the entire app equals the visible area. The layout
// itself is then a boring, normal-flow `height:100%` flex column: header / body /
// composer, with the composer riding at the column's bottom (bottom:0). Because
// the root has been shrunk to `visualViewport.height`, that column bottom sits
// exactly on top of the soft keyboard — flush, zero band — with no `position:
// fixed`, no translate and no CSS-var indirection anywhere in the tree.
//
// WHY IT MUTATES THREE ELEMENTS (not just `documentElement`). globals.css pins
// `html`, `body` and `#root` to `height:100dvh`, and — crucially — under
// `@media (display-mode: standalone)` it ALSO pins all three to
// `min-height:100vh`. On the owner's iOS standalone PWA that `min-height:100vh`
// would win against any shorter `height` we set (min-height beats height), so the
// root would refuse to shrink and the composer would stay behind the keyboard. So
// it writes BOTH inline `height` and inline `minHeight` (inline beats the
// stylesheet) on all three elements, and restores each element's prior inline
// values on cleanup / keyboard-close so nothing leaks after unmount.
//
// COLD-LAUNCH GUARD (mirrors `useKeyboardViewport`): on an iOS PWA cold
// launch `visualViewport.height` briefly evaluates to physical-screen-minus-home-
// indicator; pinning the root to it there would paint a black bar BELOW the app.
// So we only shrink the root while the keyboard is OPEN (via the shared dual-
// signal `createKeyboardOpenDetector`); when closed we clear the inline heights
// and fall back to the CSS `100dvh` / `min-height:100vh` base. All writes are
// rAF-coalesced; every listener is removed and every inline style restored on
// unmount, so teardown is clean and leaves NO global side-effect.
//
// DOCUMENTED RISK on the OWNER device: iOS 26 standalone PWA absorbs the whole
// keyboard overlap into `visualViewport.offsetTop`, leaving `.height` at full
// height — so the imperative root height may not actually shrink and the composer
// may still float. That is the exact failure this layout probes. (The
// `keyboardOpen` gate still flips — the detector reads
// `offsetTop` — we simply have no shorter height to pin.) The other risk this mode
// deliberately owns is that resizing the root reflows ALL fixed chrome / the
// shell; the strict save-and-restore of inline styles is what keeps that safe.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; render header /
// body / composer in that visual order; the body keeps its own
// `overflow-y:auto; overscroll-contain; min-h-0` (never scroll the page); the
// composer keeps its home-indicator safe-area pad (owned by `ComposerFrame`); the
// box carries no resting transform (so it never becomes a containing block); and
// every imperative global is reverted in cleanup.

import * as React from 'react'

import { createKeyboardOpenDetector } from '@/hooks/use-keyboard-viewport'

import type { KbLayoutComponent } from './contract'

/** One element we imperatively resize, plus the inline values it had before we
 *  touched it — so cleanup restores it byte-for-byte and never clobbers unrelated
 *  inline styles (e.g. the CSS vars `useViewportShellVars` writes to <html>). */
interface RootTarget {
  el: HTMLElement
  prevHeight: string
  prevMinHeight: string
  mutated: boolean
}

const Mode9RootResize: KbLayoutComponent = ({
  header,
  body,
  composer,
  chatActive,
}) => {
  React.useEffect(() => {
    // Only this mode's raison d'être — the root shrink — is chat-scoped. Under
    // the terminal path no KbLayout mounts, so `chatActive` is true in practice;
    // the guard keeps the global mutation from ever running otherwise.
    if (!chatActive) return
    const visual =
      typeof window !== 'undefined' ? window.visualViewport : undefined
    // Desktop / no visualViewport: nothing to observe; the CSS `100dvh` base on
    // html/#root governs and the composer sits flush at the real bottom.
    if (!visual) return

    // The three roots globals.css pins to height:100dvh + (standalone)
    // min-height:100vh. We must override BOTH properties on ALL THREE for the
    // shrink to actually take on the owner's standalone PWA.
    const targets: RootTarget[] = (
      [
        document.documentElement,
        document.body,
        document.getElementById('root'),
      ].filter(Boolean) as HTMLElement[]
    ).map((el) => ({
      el,
      prevHeight: el.style.height,
      prevMinHeight: el.style.minHeight,
      mutated: false,
    }))

    let raf = 0
    // Reused dual-signal detector (iOS visual-viewport shrink / offsetTop, or
    // Android layout-viewport shrink) — carries its own baseline state, one per
    // consumer, so we own an independent instance here.
    const detect = createKeyboardOpenDetector()

    const restore = () => {
      for (const t of targets) {
        if (!t.mutated) continue
        // Restore EXACTLY the prior inline values (usually empty → back to the
        // stylesheet's 100dvh / min-height:100vh), touching only these two props.
        t.el.style.height = t.prevHeight
        t.el.style.minHeight = t.prevMinHeight
        t.mutated = false
      }
    }

    const apply = () => {
      raf = 0
      const { open } = detect(visual)
      if (open) {
        // THE technique: shrink the whole app's root to exactly the visible
        // viewport. Inline height + minHeight beat globals.css (incl. the
        // standalone min-height:100vh), so the normal-flow height:100% column
        // below collapses onto the keyboard top and the composer sits flush.
        const px = `${visual.height}px`
        for (const t of targets) {
          t.el.style.height = px
          t.el.style.minHeight = px
          t.mutated = true
        }
      } else {
        // Keyboard closed → clear our inline heights and fall back to the CSS
        // base (avoids the cold-launch black bar; see header note).
        restore()
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
    // iOS: as the keyboard animates the visual viewport both resizes AND scrolls
    // (offsetTop), and we want the latest `.height`/`open` on both.
    apply()
    visual.addEventListener('resize', schedule)
    visual.addEventListener('scroll', schedule)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      visual.removeEventListener('resize', schedule)
      visual.removeEventListener('scroll', schedule)
      // Leave no residue: restore every root's prior inline height/min-height so
      // the next mode (and the rest of the shell's fixed chrome) starts clean.
      restore()
    }
  }, [chatActive])

  return (
    <div
      data-kb-mode="root-resize"
      // Normal-flow outer column — NO fixed, NO translate. `height:100%` inherits
      // from #root, which the effect above shrinks to the visible viewport when
      // the keyboard is open (and leaves at the CSS 100dvh base otherwise).
      // `relative` so the pre-wrapped `absolute inset-x-0 bottom-0` composer (and
      // the absolute header-overlay card) anchor to THIS box's edges.
      className="flex flex-col overflow-hidden"
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        // Let the flex body child shrink below its content so ITS overflow
        // scroller engages instead of the column growing past the root.
        minHeight: 0,
      }}
    >
      {header}
      {body}
      {composer}
    </div>
  )
}

export default Mode9RootResize
