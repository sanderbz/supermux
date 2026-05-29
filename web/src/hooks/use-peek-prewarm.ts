// use-peek-prewarm — per-tile React glue for the viewport-aware peek pre-warm
// ("instant hover-zoom").
//
// One call per tile: `usePeekPrewarm(name, ref)` registers an
// IntersectionObserver on the element pointed to by `ref`. While the element
// is visible the registry holds a pre-warmed headless WebSocket for `name`
// (capped to MAX_CONCURRENT_PREWARMS — see peek-prewarm-store). On exit /
// unmount / document-hidden the pre-warm is released.
//
// PRINCIPLE — kept SEPARATE from the tile component. The tile asks for two
// things and nothing more:
//   1. "Watch this element; pre-warm me when I'm visible." → `usePeekPrewarm`
//   2. "I'm being hovered — give me the seed if one exists." → `claim()` from
//      the store (called inline at hover time).
// The actual WebSocket lifecycle / cap / LRU / buffer all live in the store —
// so future agents can swap the wiring (e.g. trade IntersectionObserver for
// react-virtual visibility events) without touching the network layer.
//
// FALLBACK. If the cap is full or the browser lacks IntersectionObserver, the
// tile silently degrades to the existing on-hover-connect path (the polish-
// pass crossfade is the visual cover). The hook never throws.

import * as React from 'react'

import {
  releaseAllWarm,
  releaseWarm,
  requestWarm,
} from '@/hooks/peek-prewarm-store'

// ── Tunables ─────────────────────────────────────────────────────────────────

/** A tile must remain visible for this long before we open a pre-warm WS.
 *  This kills two birds:
 *   • A user scrolling rapidly through a long grid never causes a storm of
 *     open/close WSes that would just compete with the cap (and waste
 *     server-side fan-out churn).
 *   • By the time the user has settled their pointer enough to hover, the
 *     pre-warm has had its 1s + the auth round-trip — almost always already
 *     authed and buffering by the time the mouse arrives. */
const VISIBLE_SETTLE_MS = 600

/** Visibility threshold for the IntersectionObserver. We want "any meaningful
 *  portion" — a row of tiles half-scrolled into view counts. */
const VISIBLE_THRESHOLD = 0.25

// ── Global document-visibility wiring ────────────────────────────────────────
//
// Mount-once, app-wide: hidden → drop all pre-warms; visible → the existing
// per-tile IntersectionObservers naturally re-fire on next intersection
// (modern browsers re-deliver observer entries when the tab becomes visible
// again, and the threshold gating means we re-warm only the still-visible
// tiles). We don't need a global "re-warm everything" handler — the per-tile
// observers ARE the source of truth for visibility.
//
// Reference-counted: the first hook to mount installs the listener; the last
// to unmount removes it. This keeps an idle Overview page (no tiles, e.g.
// while the search returns zero matches) cost-free.

let visibilityRefcount = 0
let visibilityHandler: (() => void) | null = null

function ensureVisibilityHandler(): void {
  if (visibilityRefcount > 0) {
    visibilityRefcount += 1
    return
  }
  visibilityRefcount = 1
  const onChange = () => {
    if (document.visibilityState === 'hidden') {
      releaseAllWarm()
    }
    // No visible-handler here: per-tile observers fire naturally on visible-
    // again; they re-call `requestWarm` and the registry re-establishes.
  }
  visibilityHandler = onChange
  document.addEventListener('visibilitychange', onChange)
}

function releaseVisibilityHandler(): void {
  if (visibilityRefcount === 0) return
  visibilityRefcount -= 1
  if (visibilityRefcount === 0 && visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UsePeekPrewarmOptions {
  /** Set false to opt-out (e.g. when `hoverPreview !== 'live'` or the session
   *  is not live-capable — there's no point pre-warming a stopped pty). The
   *  hook is still called unconditionally so the Rules of Hooks hold. */
  enabled?: boolean
}

/** Wire one tile's element into the viewport-aware pre-warm. Returns nothing;
 *  the side-effect is the registry membership while the element is visible.
 *  Hover-time hydration is the tile's own concern — call `claim(name)` from
 *  the store at hover-enter and pass the seed into the live-terminal hook. */
export function usePeekPrewarm(
  name: string,
  ref: React.RefObject<HTMLElement | null>,
  opts?: UsePeekPrewarmOptions,
): void {
  const enabled = opts?.enabled ?? true

  React.useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return

    // Graceful fallback: very old browsers without IntersectionObserver fall
    // through to on-hover-connect (the existing path) — no pre-warm, no error.
    if (typeof IntersectionObserver === 'undefined') return

    ensureVisibilityHandler()

    let settleTimer: number | null = null
    let warmed = false

    const clearSettleTimer = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer)
        settleTimer = null
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // Re-arm settle. If the user scrolls past quickly we never actually
            // open a WS — only stable visibility qualifies for a pre-warm slot.
            clearSettleTimer()
            settleTimer = window.setTimeout(() => {
              settleTimer = null
              // Cap-respecting: `requestWarm` returns false if the cap is full
              // and no eviction freed a slot. We don't retry — when another
              // pre-warm releases (its tile scrolls away, or the user hovers
              // and claims one) the NEXT visibility change naturally retries.
              warmed = requestWarm(name)
            }, VISIBLE_SETTLE_MS)
          } else {
            clearSettleTimer()
            if (warmed) {
              releaseWarm(name)
              warmed = false
            }
          }
        }
      },
      { threshold: VISIBLE_THRESHOLD },
    )

    observer.observe(el)

    return () => {
      observer.disconnect()
      clearSettleTimer()
      if (warmed) {
        releaseWarm(name)
        warmed = false
      }
      releaseVisibilityHandler()
    }
  }, [enabled, name, ref])
}
