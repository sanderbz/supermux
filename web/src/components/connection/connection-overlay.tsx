// ConnectionOverlay — branded full-screen PWA UX for hard outages.
//
// Mounts ONCE at the app root (App.tsx). Renders nothing while the
// connection is healthy. Paints a full-bleed branded surface when the state
// machine reports `offline` / `server_unreachable` / `auth_invalid` — the
// three "the app can't function until this clears" states.
//
// MOTION (springs.smooth):
//   • enter — fade + 6px translate-up, ~0.35s spring
//   • exit  — fade + 6px translate-up, ~0.30s spring (covers the "smooth
//             fade-out when the connection restores" requirement)
//   • countdown — pure text update; no chrome motion
//
// BRAND (voice — see brand/copy.ts + brand/BRAND.md):
//   • One short headline, no jargon, sentence case.
//   • One sub-line of what happened + what we'll do.
//   • One primary action ("Try now" / "Reload"). 44pt hit target.
//   • NO em-dashes anywhere (linted in CI).
//
// LAYOUT: identical on mobile + desktop, scales by container width. Centered
// column, max 28rem, generous breathing room, supermux logo at the top.

import * as React from 'react'
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from 'framer-motion'
import { KeyRound, RotateCw, ServerCrash, WifiOff } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import {
  useConnectionStatus,
  type ConnectionStatus,
} from '@/hooks/use-connection-status'
import { isOverlayState } from '@/stores/api-status-store'

interface VisualSpec {
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  headline: string
  body: string
  /** Primary CTA label. */
  ctaLabel: string
  /** Show the auto-retry countdown line. */
  showCountdown: boolean
}

const VISUALS: Record<'offline' | 'server_unreachable' | 'auth_invalid', VisualSpec> = {
  offline: {
    Icon: WifiOff,
    headline: 'You’re offline.',
    body: 'Your network dropped. We’ll reconnect as soon as it’s back.',
    ctaLabel: 'Try now',
    showCountdown: false,
  },
  server_unreachable: {
    Icon: ServerCrash,
    headline: 'Can’t reach the supermux server.',
    body: 'The server isn’t responding. We’ll keep trying.',
    ctaLabel: 'Try now',
    showCountdown: true,
  },
  auth_invalid: {
    Icon: KeyRound,
    headline: 'Sign in again.',
    body: 'Your session expired. Reopen supermux from a trusted link to refresh your token.',
    ctaLabel: 'Reload',
    showCountdown: false,
  },
}

/** Live "Next try in 6s" line. Updates every 250ms while the retry instant
 *  is in the future; renders nothing once the retry actually fires. */
function CountdownLine({ retryAt }: { retryAt: number }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  const remainingS = Math.max(0, Math.ceil((retryAt - now) / 1000))
  if (remainingS <= 0) {
    return (
      <span className="text-xs text-muted-foreground" aria-live="polite">
        Trying now.
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
      Next try in {remainingS}s.
    </span>
  )
}

interface OverlayBodyProps {
  visual: VisualSpec
  status: ConnectionStatus
  onCta: () => void
}

function OverlayBody({ visual, status, onCta }: OverlayBodyProps) {
  const reduce = useReducedMotion() ?? false
  const enter: Transition = reduce
    ? { duration: 0.15 }
    : springs.smooth
  return (
    <motion.div
      key="overlay"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
      transition={enter}
      // Full-bleed branded surface. Top z above every floating UI (sheets are
      // z-50, toast z-50, command palette z-50, banner z-30) so a real outage
      // never sits behind a partially-rendered route. NOT z-max — we want
      // browser-level controls (dev tools, devtools-on-screen) to remain.
      className={cn(
        'fixed inset-0 z-[60] flex flex-col items-center justify-center',
        'bg-background/95 backdrop-blur-xl',
        'px-6 pt-safe pb-safe',
      )}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="connection-overlay-headline"
      aria-describedby="connection-overlay-body"
    >
      {/* Brand wordmark — small, top-anchored. Establishes "this is supermux,
          not the browser's generic 'site can't be reached' page." */}
      <div className="mb-12 flex items-center gap-2 text-foreground/85">
        <Logo className="h-7 w-auto" />
        <span className="text-base font-semibold tracking-tight">supermux</span>
      </div>

      <div className="flex w-full max-w-md flex-col items-center text-center">
        {/* State icon — monochrome, calm, sized to feel deliberate. */}
        <div
          className={cn(
            'mb-6 flex size-16 items-center justify-center rounded-full',
            'bg-muted text-muted-foreground',
            '[&_svg]:size-7',
          )}
        >
          <visual.Icon aria-hidden />
        </div>

        <h2
          id="connection-overlay-headline"
          className="text-xl font-semibold tracking-tight text-foreground"
        >
          {visual.headline}
        </h2>
        <p
          id="connection-overlay-body"
          className="mt-2 text-sm leading-relaxed text-muted-foreground"
        >
          {visual.body}
        </p>

        <div className="mt-8 flex flex-col items-center gap-3">
          <Button
            onClick={onCta}
            // 44pt floor (iOS HIG): h-11 ≥ 44px, generous horizontal padding so
            // the tap target reads as a clear primary action on touch.
            className="h-11 min-w-[10rem] gap-2 px-6"
          >
            <RotateCw aria-hidden />
            {visual.ctaLabel}
          </Button>

          {visual.showCountdown && status.retryAt !== null && (
            <CountdownLine retryAt={status.retryAt} />
          )}
        </div>
      </div>
    </motion.div>
  )
}

/**
 * Mount once at the root of the app tree. Renders nothing during healthy
 * connection; smoothly fades in/out as the state machine transitions.
 */
export function ConnectionOverlay() {
  const status = useConnectionStatus()
  const visible = isOverlayState(status.kind)

  // Pick the visual spec for the current kind. On a healthy transition we want
  // to keep painting the PREVIOUS visual while AnimatePresence runs the exit
  // animation; otherwise the kind reverts to `connected` and the strings would
  // pop. We derive a stable "key" from the kind (a fixed sentinel `last` while
  // not visible) and `useMemo` the visual from that — the previous frame's
  // memoized value remains attached to the exiting motion.div via the `key`
  // prop on `<OverlayBody>` below, so React keeps a coherent unmount tree.
  const visual: VisualSpec | null = visible
    ? VISUALS[status.kind as keyof typeof VISUALS]
    : null

  const onCta = React.useCallback(() => {
    if (status.kind === 'auth_invalid') {
      // Hard reload re-fetches the HTML doc + its injected
      // window._SUPERMUX_AUTH_TOKEN, which is the documented re-auth path
      // (see brand/copy.ts ERROR.unauthorized — "Reopen supermux from a
      // trusted link to refresh it"). Same effect as the user reopening the
      // bookmark, no extra UI.
      window.location.reload()
      return
    }
    status.retryNow()
  }, [status])

  return (
    <AnimatePresence initial={false}>
      {visible && visual && (
        <OverlayBody visual={visual} status={status} onCta={onCta} />
      )}
    </AnimatePresence>
  )
}

export default ConnectionOverlay
