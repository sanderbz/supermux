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
   *  / browser chrome). Published only while an editable field is focused AND the
   *  keyboard overlaps the viewport; `null` otherwise (no editable focus, keyboard
   *  closed, or visualViewport absent) so callers fall back to their CSS height
   *  (`100svh` — the SMALL viewport, so a late null frame can never slam the bar
   *  behind the keyboard the way the larger `100dvh` could). */
  height: number | null
  /** Pixels the soft keyboard (and any bottom OS chrome) overlaps the layout
   *  viewport: `layoutHeight - visualViewport.height` (the pure overlay inset —
   *  the `- offsetTop` term was dropped in the real-device fix; see the detector).
   *  0 when the keyboard is closed. Drive the accessory dock's bottom offset off
   *  this so it rides the keyboard top. */
  keyboardInset: number
  /** `visualViewport.offsetTop` — how far iOS has scrolled the visual viewport
   *  DOWN within the layout viewport to keep the focused field above the
   *  keyboard. 0 when closed / not driving. A TOP-anchored keyboard sheet lands
   *  flush by pinning `top: 0` (static — never animates) and translating DOWN by
   *  this, so it never touches the `bottom`/`top` OFFSET values iOS 26 resolves
   *  unreliably mid-keyboard. Published on the same gate as `height`. */
  keyboardOffsetTop: number
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
    // REAL-DEVICE ROOT FIX. Do NOT subtract `visual.offsetTop`: on a standalone
    // iOS PWA the keyboard overlap is absorbed ENTIRELY into `offsetTop` (owner
    // device: layout 812, vv.height 498, offsetTop 314 → 812−498−314 = 0), so the
    // old `−offsetTop` term drove the inset to 0, `keyboardOpen` never flipped,
    // `height` published `null`, and the sheet fell back to bare `100dvh` while
    // the panel painted `env(safe-area-inset-bottom)` = the 34px black band. The
    // overlay inset is simply `layoutHeight − vv.height`.
    const inset = Math.max(0, layoutHeight - visual.height)
    const layoutShrink = Math.max(0, baselineHeight - layoutHeight)
    const open =
      inset > KEYBOARD_OPEN_THRESHOLD ||
      // Standalone real-device signal: iOS put the whole overlap into offsetTop
      // (see the inset note). A large offsetTop with the layout viewport intact
      // is a keyboard, not a page scroll — the case the inset-only rule missed.
      visual.offsetTop > KEYBOARD_OPEN_THRESHOLD ||
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
    keyboardOffsetTop: 0,
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
      // WHEN TO DRIVE LAYOUT OFF visualViewport (the PWA-black-bar gate, hardened).
      //
      // Original invariant: publish a concrete `height` only when the keyboard is
      // OPEN (inset > 80). When closed, `null` lets callers fall back to their CSS
      // height — needed because on iOS PWA cold launch `visualViewport.height`
      // briefly evaluates to physical-screen-minus-home-indicator, and pinning
      // `style.height` to it there paints a black bar below the app.
      //
      // BUT the `inset > 80` boolean gated the fallback the WRONG way while TYPING:
      // during the keyboard-open animation (and on any detection wobble) `inset`
      // dips under 80, `height` flips to `null`, and the composer's sheet snaps
      // back to its full-height CSS fallback — dropping the `absolute bottom-0`
      // composer BEHIND the keyboard (the reported sliver of input + dark gap).
      // iOS never shrinks `dvh`/the layout viewport for the keyboard, so a
      // full-height fallback is always wrong mid-type.
      //
      // Hardened gate — a strict SUPERSET of the old `keyboardOpen`-only rule, so
      // it cannot regress any case the old gate already handled:
      //   · keyboardOpen (inset > 80)                     → drive (as before), OR
      //   · an EDITABLE field is focused AND the viewport  → drive (NEW: catches
      //     is even slightly overlapped (inset > 1)          the transition frames)
      //
      // The NEW clause is the fix: while the keyboard animates open (and on any
      // detection wobble) `inset` sits between 1 and 80, the old gate published
      // `null`, and the sheet fell back to full height with the composer behind
      // the keyboard. Gating the new clause on `inset > 1` keeps the cold-launch
      // case (xterm auto-focus, keyboard CLOSED → inset ≈ 0) on the `null`→CSS
      // path, so the PWA black-bar fix holds — and the CSS fallback is now `svh`
      // (mobile-sheet.tsx), which is the correct resting position with no keyboard
      // anyway, so there is nothing to publish when the keyboard is closed.
      //
      // BLUR RE-SYNC: the instant the field blurs, the keyboard dismisses — once
      // `inset` drops back under 80 both clauses are false, `driving` is false,
      // and the sheet resets to its CSS height, clearing any residual
      // `offsetTop`/`height` iOS leaves behind (documented: `offsetTop` does not
      // reliably return to 0 after dismiss). The `focusout` listener below re-runs
      // this measure so the reset does not wait for the next resize/scroll frame.
      const driving = keyboardOpen || (hasEditableFocus() && inset > 1)
      const publishedHeight = driving ? measuredHeight : null
      // Published on the SAME gate as `height`: 0 unless we're driving layout, so
      // a closed/blurred sheet never carries a stale offset (iOS leaves a residual
      // `offsetTop` after dismiss — see the blur re-sync note above).
      const publishedOffsetTop = driving ? visual.offsetTop : 0
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
          Math.abs(prev.keyboardOffsetTop - publishedOffsetTop) < 1 &&
          prev.keyboardOpen === keyboardOpen
        ) {
          return prev
        }
        return {
          height: publishedHeight,
          keyboardInset: inset,
          keyboardOffsetTop: publishedOffsetTop,
          keyboardOpen,
        }
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

/**
 * useKeyboardOpen — a TRIMMED keyboard-open boolean for the mobile focus route.
 *
 * The native-column focus layout (mobile-sheet.tsx is a plain `100dvh` flex
 * column; the browser's `interactive-widget=resizes-content` shrinks the
 * viewport when the keyboard opens) needs NO height/offset/inset math — the
 * only signal the route still consumes is a single boolean: the terminal dock's
 * accessory key strip (`dock.tsx:598`) and the ⌨ toggle label (`:668`) render
 * only while the keyboard is up. This hook runs the SAME dual-signal
 * `createKeyboardOpenDetector` (iOS = visual-viewport shrink; Android =
 * layout-viewport shrink with editable focus) as `useKeyboardViewport`, but
 * publishes ONLY `open` — dropping the fragile visualViewport-height sheet-
 * sizing path that floated the composer above the keyboard on iOS.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    const visual =
      typeof window !== 'undefined' ? window.visualViewport : undefined
    if (!visual) return

    let raf = 0
    const detect = createKeyboardOpenDetector()
    const measure = () => {
      raf = 0
      const { open: keyboardOpen } = detect(visual)
      setOpen((prev) => (prev === keyboardOpen ? prev : keyboardOpen))
    }
    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(measure)
    }

    measure()
    visual.addEventListener('resize', schedule)
    visual.addEventListener('scroll', schedule)
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

  return open
}

/**
 * useViewportShellVars — the SINGLE keyboard/safe-area coordinator (layout
 * foundation, Piece 1). Mount it ONCE at the shell (layout.tsx). It REUSES the
 * already-correct `useKeyboardViewport` observer (same rAF-coalesced updates,
 * same hardened drive gate, same dual-signal detector) and, on each change,
 * mirrors its numbers to four CSS custom properties on `document.documentElement`
 * so every bottom-anchored surface can read one source of truth without
 * prop-drilling a React value:
 *
 *   --vvh            visible height   = vv.height px while driving, else 100dvh
 *   --vv-offset-top  iOS page-pin     = vv.offsetTop px while driving, else 0px
 *   --vv-overshoot   Fix-C tuck       = 34px while driving, else 0px
 *   --kb             keyboard inset   = max(0, innerHeight − vv.height) px
 *   --kb-safe-bottom gated home-ind.  = keyboardOpen ? 0px : env(safe-area-inset-bottom)
 *
 * Because the strings are derived from the hook's return (`height` is `null` ⇔
 * not driving and otherwise IS `visualViewport.height`; `keyboardOffsetTop` is 0
 * unless driving; `keyboardInset` is the raw inset formula; `keyboardOpen` is the
 * open flag), the CSS mirror and the React value can never disagree. Additive and
 * — until a surface consumes the vars — a visual no-op. The globals.css `:root`
 * fallbacks cover the pre-JS / desktop / no-visualViewport case.
 */
export function useViewportShellVars(): void {
  const { height, keyboardInset, keyboardOffsetTop, keyboardOpen } =
    useKeyboardViewport()
  React.useEffect(() => {
    const s = document.documentElement.style
    const driving = height !== null
    s.setProperty('--vvh', driving ? `${height}px` : '100dvh')
    s.setProperty('--vv-offset-top', driving ? `${keyboardOffsetTop}px` : '0px')
    // Defense-in-depth overshoot (Fix C): while driving (keyboard open), let the
    // sheet extend ~34px BELOW the visual-viewport bottom so it tucks behind the
    // opaque keyboard instead of ever UNDER-shooting into a visible band (guards
    // the WebKit stale-vv-frame / vv.height under-report). 0 at rest.
    s.setProperty('--vv-overshoot', driving ? '34px' : '0px')
    s.setProperty('--kb', `${keyboardInset}px`)
    s.setProperty(
      '--kb-safe-bottom',
      keyboardOpen ? '0px' : 'env(safe-area-inset-bottom)',
    )
  }, [height, keyboardInset, keyboardOffsetTop, keyboardOpen])
}
