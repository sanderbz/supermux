// ReconnectBanner — the global connection-status surface
// (research/termius-ios-native-spec.md §"Reconnect banner / connection status
// surface", §"v3 finish acceptance criteria" #8 / #20).
//
// One glass pill, 8px below the safe-area top, 36px tall, full-pill radius. It
// renders the AGGREGATED `useConnection` verdict — the worst current state
// across the SSE stream + every live terminal — so it never flickers between
// two out-of-phase terminals.
//
// LAYOUT: the banner is an IN-FLOW row at the top of the content column,
// NOT an absolutely-positioned overlay. When visible it reserves its own
// vertical space and pushes the route below it down, so it can never render on
// top of a route's own header chrome (the Overview view-toggle / search /
// "New session" button) at any breakpoint. When there is no banner it occupies
// zero height — `<AnimatePresence>` collapses the row on exit.
//
// Motion (per the Termius motion table):
//   • slide-in        — y:-44 → 0, springs.smooth (~0.35s)
//   • state morph     — amber → green, IN PLACE, springs.statusMorph (~0.25s
//                       snappy); the surface never slides out + back in (#20)
//   • success linger  — green "Connected" holds 1.2s, then slides up + fades
//                       (springs.smooth ~0.4s) and unmounts
//
// VISUAL: glass material (`.glass` utility — backdrop-blur + saturation, falls
// back to the opaque card under prefers-reduced-transparency), tinted by state,
// SF-Pro 13px semibold label, Title-Case copy (never UPPERCASE), ≥44pt retry
// hit target inside the 36px pill via negative-margin padding.
//
// Reduced motion (Termius #13): slide-in/out become a crossfade and the spinner
// shimmer is dropped — `<AnimatePresence>` exits/enters still run but only
// opacity tweens; the state-morph spring becomes an instant cut.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, Loader2, RotateCw, WifiOff } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useConnection } from '@/stores/connection-store'
import { useConnectionReaggregator } from '@/hooks/use-connection-link'

/** How long the green "Connected" all-clear lingers before sliding away. */
const SUCCESS_LINGER_MS = 1_200

interface BannerVisual {
  label: string
  tint: string // tailwind classes — translucent state tint over the glass
  icon: 'spinner' | 'check' | 'offline'
  /** Renders the "Tap to retry" CTA. */
  retryable: boolean
}

/** The states that paint a banner. The initial `connecting` handshake is NOT
 *  one of them — a fresh cold load must open calm, never greeting a new user
 *  with an amber worried pill before any genuine disconnect. The banner
 *  only appears once a REAL disconnect (`reconnecting` / `offline`) occurs, or
 *  for the transient green recovery flash. */
type VisibleState = 'reconnecting' | 'offline' | 'connected'

/** Copy + tint per visible state. Title-Case throughout (never UPPERCASE) —
 *  Termius criterion. Tints are ~0.18 alpha over the glass surface, matching the
 *  spec's `Color.orange/green/red.opacity(0.18)`. */
const VISUALS: Record<VisibleState, BannerVisual> = {
  reconnecting: {
    label: 'Reconnecting…',
    tint: 'bg-[hsl(var(--status-active)/0.16)] text-foreground',
    icon: 'spinner',
    retryable: false,
  },
  connected: {
    label: 'Connected',
    tint: 'bg-[hsl(var(--status-waiting)/0.04)] text-foreground',
    icon: 'check',
    retryable: false,
  },
  offline: {
    label: 'Connection lost',
    tint: 'bg-destructive/15 text-foreground',
    icon: 'offline',
    retryable: true,
  },
}

/** Green-tinted variant for the success flash — kept separate so the amber→green
 *  morph only swaps the tint + icon on ONE surface (in-place, no remount). */
const CONNECTED_TINT = 'bg-[hsl(140_70%_45%/0.18)] text-foreground'

function BannerIcon({
  kind,
  reduce,
}: {
  kind: BannerVisual['icon']
  reduce: boolean
}) {
  if (kind === 'check') {
    return (
      <Check
        className="size-3.5 text-[hsl(140_70%_42%)]"
        strokeWidth={3}
        aria-hidden
      />
    )
  }
  if (kind === 'offline') {
    return <WifiOff className="size-3.5" aria-hidden />
  }
  // spinner — the shimmer is dropped under reduced motion (#13).
  return (
    <Loader2
      className={cn('size-3.5', !reduce && 'animate-spin')}
      aria-hidden
    />
  )
}

/**
 * The global reconnect / connection-status banner. Mount ONCE, app-wide (the
 * Layout shell does this). Subscribes to `useConnection`; renders nothing while
 * the aggregate is `idle` or a steady `connected` past its linger window.
 */
export function ReconnectBanner() {
  const reduce = useReducedMotion() ?? false
  const state = useConnection((s) => s.state)
  const retry = useConnection((s) => s.retry)

  // Tick the time-based offline-grace rule (reconnecting → offline after 30s).
  useConnectionReaggregator()

  // The green "Connected" flash is shown only briefly after a REAL recovery
  // (degraded → connected), then auto-dismisses; a steady-state `connected`
  // (nothing was ever wrong) shows no banner at all. We drive this from an
  // imperative store SUBSCRIPTION (not a render-derived effect) so the timer
  // logic lives entirely inside the subscribe callback — no setState-in-effect,
  // and the flash survives even if `state` lands on `connected` and stays.
  const [showSuccess, setShowSuccess] = React.useState(false)

  React.useEffect(() => {
    // Seed `wasUnhealthy` from the mount-time state WITHOUT a setState — only
    // future transitions drive the flash. (`showSuccess` starts false, which is
    // correct: a fresh mount never owes a success flash.)
    //
    // The initial `connecting` handshake does NOT count as "unhealthy" —
    // a cold load reaching `connected` for the first time is not a recovery, so
    // it must not flash green. Only a REAL disconnect (`reconnecting` /
    // `offline`) arms the success flash, so the unboxing opens calm.
    const seed = useConnection.getState().state
    let wasUnhealthy = seed === 'reconnecting' || seed === 'offline'
    let timer: number | null = null
    const unsub = useConnection.subscribe((store) => {
      const s = store.state
      if (s === 'reconnecting' || s === 'offline') {
        wasUnhealthy = true
        if (timer !== null) window.clearTimeout(timer)
        timer = null
        setShowSuccess(false)
        return
      }
      if (s === 'connecting') {
        // The initial / re-handshake connecting state: keep whatever
        // `wasUnhealthy` already holds (a reconnect keeps it armed; a cold
        // load keeps it disarmed) and paint nothing.
        return
      }
      // s === 'connected' (or 'idle'). Flash green ONLY if we were degraded.
      if (s === 'connected' && wasUnhealthy) {
        wasUnhealthy = false
        setShowSuccess(true)
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => setShowSuccess(false), SUCCESS_LINGER_MS)
      }
    })
    return () => {
      unsub()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  // What the banner should render right now: a REAL degraded state
  // (`reconnecting` / `offline`), or the transient success flash, or nothing.
  // The initial `connecting` handshake deliberately paints NOTHING so the
  // first cold-load paint is calm.
  const visibleState: VisibleState | null =
    state === 'reconnecting' || state === 'offline'
      ? state
      : showSuccess
        ? 'connected'
        : null

  const v = visibleState ? VISUALS[visibleState] : null
  const isConnected = visibleState === 'connected'

  return (
    <div
      aria-live="polite"
      // In-flow row at the top of the content column: it reserves its own
      // vertical space when a banner is visible — pushing the route's own header
      // down — and collapses to zero height when there is none. It is NEVER an
      // overlay, so it can never render on top of route header chrome.
      //
      // The `pt-safe` notch inset is applied ONLY when a banner is visible.
      // Every route already owns its own top safe-area inset, so keeping pt-safe
      // on this always-present row added the inset a SECOND time — a doubled empty
      // band at the very top, glaringly visible in the iOS standalone PWA where
      // the notch inset is always non-zero (desktop env()=0, so no change there).
      // Gating it on `v` restores the "zero height when there is none" contract.
      className={cn(
        'pointer-events-none z-30 flex shrink-0 justify-center',
        v && 'pt-safe',
      )}
    >
      <AnimatePresence initial={false}>
        {v && (
          <motion.div
            key="reconnect-banner"
            // Collapse / expand the reserved row height (pill + 8px top + 8px
            // bottom = 52px). Under reduced motion this is an instant cut; the
            // pill itself still crossfades.
            initial={{ height: 0 }}
            animate={{ height: 52 }}
            exit={{ height: 0 }}
            transition={reduce ? { duration: 0 } : springs.smooth}
            className="overflow-hidden"
          >
            <motion.div
              // Slide-in from above; slide-out on dismiss. Under reduced motion
              // the y-offset collapses to a pure crossfade.
              initial={reduce ? { opacity: 0 } : { y: -44, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { y: -44, opacity: 0 }}
              transition={reduce ? { duration: 0.15 } : springs.smooth}
              className="pointer-events-auto mx-auto mt-2 px-4"
              style={{ maxWidth: 'min(100vw - 32px, 28rem)' }}
            >
              {/* The single morphing surface: tint + icon swap in place via
                  the `layout` + statusMorph spring; never a remount, never a
                  slide-out+slide-in for the same surface (Termius #20). */}
              <motion.button
                type="button"
                layout
                transition={reduce ? { duration: 0 } : springs.statusMorph}
                onClick={v.retryable && retry ? retry : undefined}
                disabled={!v.retryable || !retry}
                aria-label={
                  v.retryable ? `${v.label}. Tap to retry.` : v.label
                }
                className={cn(
                  'glass flex h-9 items-center gap-2 rounded-full px-4',
                  'border border-border/60 shadow-sm',
                  'text-[13px] font-semibold leading-none',
                  v.retryable && retry ? 'cursor-pointer' : 'cursor-default',
                  isConnected ? CONNECTED_TINT : v.tint,
                )}
              >
                <BannerIcon kind={v.icon} reduce={reduce} />
                <motion.span layout="position">{v.label}</motion.span>
                {v.retryable && retry && (
                  <span
                    className={cn(
                      // ≥44pt hit target inside the 36px pill via negative-
                      // margin padding (Termius #5) — pill stays 36px tall.
                      '-my-2 -mr-2 ml-1 flex h-11 items-center gap-1',
                      'rounded-full px-3 text-[13px] font-semibold text-primary',
                    )}
                  >
                    <RotateCw className="size-3.5" aria-hidden />
                    Tap to retry
                  </span>
                )}
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ReconnectBanner
