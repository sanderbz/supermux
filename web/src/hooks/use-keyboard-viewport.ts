// useKeyboardViewport — mobile live-type
// "page slides weirdly" root-cause fix.
//
// Observes `window.visualViewport` so the focus layout can lay itself out AROUND
// the soft keyboard instead of letting the browser scroll the whole page up.
//
// The mechanism (per the plan): without `interactive-widget=resizes-content`
// (which iOS Safari/WKWebView only partially honor), the LAYOUT viewport keeps
// its full height when the keyboard opens, so a `fixed bottom-0 h-full` sheet
// stays full-height with its bottom edge BEHIND the keyboard — the browser's
// only recourse is to scroll the page. By driving the focus container's height
// off `visualViewport.height` and pinning the accessory dock up by the keyboard
// inset, the terminal shrinks to sit DIRECTLY above the keyboard and the page
// never slides.
//
// Reads are coalesced into a rAF so a rapid resize+scroll burst (the keyboard
// animation fires many of each) does one layout write per frame. All listeners
// are cleaned up on unmount. No-ops gracefully when `visualViewport` is absent
// (desktop / older engines) — callers fall back to the CSS `100dvh` layout.

import * as React from 'react'

export interface KeyboardViewport {
  /** Current visual-viewport height in px (the area NOT covered by the keyboard
   *  / browser chrome). `null` until measured / when visualViewport is absent —
   *  callers then fall back to a CSS height (100dvh). */
  height: number | null
  /** Pixels the soft keyboard (and any bottom OS chrome) overlaps the layout
   *  viewport: `layoutHeight - visualViewport.height - visualViewport.offsetTop`.
   *  0 when the keyboard is closed. Drive the accessory dock's bottom offset off
   *  this so it rides the keyboard top. */
  keyboardInset: number
  /** True once the inset crosses a small threshold — i.e. the keyboard is open.
   *  Lets callers gate keyboard-only chrome (the accessory key bar). */
  keyboardOpen: boolean
}

// Below this many px of inset we treat the keyboard as closed: iOS reports a
// few px of jitter (URL bar collapse, rubber-band) that must not flip the bar.
// Android browser-tab URL-bar show/hide moves innerHeight by ~56px — also
// safely below this floor. Real soft keyboards are 250px+.
export const KEYBOARD_OPEN_THRESHOLD = 80

/** True when the focused element is one the soft keyboard serves. The layout-
 *  shrink heuristic below only counts as "keyboard" while something editable
 *  holds focus — a split-screen / window resize without focus is not a
 *  keyboard. (xterm's hidden helper textarea is the focus owner on the
 *  terminal routes, so live-type qualifies.) */
function hasEditableFocus(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'TEXTAREA' ||
    tag === 'INPUT' ||
    (el as HTMLElement).isContentEditable === true
  )
}

/**
 * Platform-bridging keyboard-open detector. Returns a closure (one per
 * consumer; it carries baseline state) that maps the current viewport to
 * `{ inset, open }`.
 *
 * TWO signals, because `interactive-widget=resizes-content` (index.html)
 * splits the platforms:
 *
 *   • iOS Safari/WKWebView IGNORE it → the keyboard OVERLAYS the layout
 *     viewport: `innerHeight` keeps its full height, `visualViewport.height`
 *     shrinks. `inset = innerHeight − vv.height − vv.offsetTop` is the
 *     keyboard overlap — the original detection, and the value consumers use
 *     to lift `fixed bottom-0` chrome above the keyboard.
 *
 *   • Android Chrome HONORS it → the keyboard RESIZES the layout viewport:
 *     `innerHeight` and `visualViewport.height` shrink TOGETHER, so the
 *     overlay inset stays ≈0 forever and `keyboardOpen` never flipped — the
 *     dock's ⌨ toggle was stuck on "Show keyboard" and the accessory key
 *     strip never appeared on Android. The signal there is the LAYOUT
 *     viewport shrinking against its recent baseline (largest `innerHeight`
 *     seen at the current width; a width change = rotation / split-screen →
 *     baseline resets). Gated on a coarse pointer (desktop window resizes
 *     must not read as keyboards) AND an editable element holding focus.
 *
 * `inset` stays OVERLAY-ONLY by design: on Android the layout itself already
 * shrank, so bottom-anchored chrome is above the keyboard at `bottom: 0` —
 * folding the shrink into `inset` would double-lift it.
 */
export function createKeyboardOpenDetector(): (
  visual: VisualViewport,
) => { inset: number; open: boolean } {
  let baselineWidth = -1
  let baselineHeight = 0
  const coarsePointer =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(pointer: coarse)').matches
  return (visual) => {
    const layoutHeight = window.innerHeight
    const layoutWidth = window.innerWidth
    if (layoutWidth !== baselineWidth) {
      // Rotation / split-screen / first run → new baseline.
      baselineWidth = layoutWidth
      baselineHeight = layoutHeight
    } else if (layoutHeight > baselineHeight) {
      baselineHeight = layoutHeight
    }
    const inset = Math.max(0, layoutHeight - visual.height - visual.offsetTop)
    const layoutShrink = Math.max(0, baselineHeight - layoutHeight)
    const open =
      inset > KEYBOARD_OPEN_THRESHOLD ||
      (coarsePointer &&
        layoutShrink > KEYBOARD_OPEN_THRESHOLD &&
        hasEditableFocus())
    return { inset, open }
  }
}

export function useKeyboardViewport(): KeyboardViewport {
  const [vp, setVp] = React.useState<KeyboardViewport>(() => ({
    height: null,
    keyboardInset: 0,
    keyboardOpen: false,
  }))

  React.useEffect(() => {
    const visual =
      typeof window !== 'undefined' ? window.visualViewport : undefined
    // Desktop / no API: leave the initial null-height state so the caller's CSS
    // (100dvh) governs. Nothing to observe.
    if (!visual) return

    let raf = 0
    // Dual-signal detection (see createKeyboardOpenDetector): iOS = the visual
    // viewport shrinks under a stable layout viewport (overlay inset); Android
    // (resizes-content honored) = the LAYOUT viewport itself shrinks while an
    // editable element holds focus.
    const detect = createKeyboardOpenDetector()
    const measure = () => {
      raf = 0
      const measuredHeight = visual.height
      const { inset, open: keyboardOpen } = detect(visual)
      // KEY INVARIANT (PWA-black-bar fix): only publish a concrete `height` when
      // the keyboard is actually OPEN. When the keyboard is closed, `null` lets
      // callers fall back to the CSS `100dvh` layout — which on iOS PWA cold
      // launch already over-paints into the home-indicator region via the
      // `min-height: 100vh` belt-and-suspenders in globals.css. Without this
      // gate, every consumer (MobileSheet, focus route…) would pin `style.height
      // = visualViewport.height` immediately on mount, and on iOS PWA cold
      // launch `visualViewport.height` evaluates to physical-screen-minus-home-
      // indicator → a black bar appears below the app. Once the keyboard
      // actually opens we DO want to drive layout off visualViewport (that's
      // the whole reason the hook exists), so the gate flips off then.
      const publishedHeight = keyboardOpen ? measuredHeight : null
      setVp((prev) => {
        // Skip a state write if nothing meaningfully changed (rAF can still fire
        // on a no-op scroll) — sub-pixel churn shouldn't re-render the tree.
        const heightChanged =
          (prev.height === null) !== (publishedHeight === null) ||
          (publishedHeight !== null &&
            prev.height !== null &&
            Math.abs(prev.height - publishedHeight) >= 1)
        if (
          !heightChanged &&
          Math.abs(prev.keyboardInset - inset) < 1 &&
          prev.keyboardOpen === keyboardOpen
        ) {
          return prev
        }
        return { height: publishedHeight, keyboardInset: inset, keyboardOpen }
      })
    }

    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(measure)
    }

    // Measure once synchronously so the first paint already accounts for any
    // keyboard that is already up (e.g. fast route change with focus retained).
    measure()
    visual.addEventListener('resize', schedule)
    visual.addEventListener('scroll', schedule)
    // Android resizes-content: the layout viewport resize is the keyboard
    // signal — and the editable-focus gate means focus moves must re-evaluate
    // too. Both rAF-coalesced into the same measure; no-ops on iOS/desktop.
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', schedule)
    document.addEventListener('focusout', schedule)
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      visual.removeEventListener('resize', schedule)
      visual.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', schedule)
      document.removeEventListener('focusout', schedule)
    }
  }, [])

  return vp
}
