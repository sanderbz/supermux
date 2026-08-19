// Mounts the in-app half of the notification pipeline.
//
// Three jobs, none of which the service worker can do on its own:
//
//   1. Listen for the payloads the SW forwards and toast the BLOCKING ones. The
//      SW has always posted these; before this component nothing was listening,
//      so a suppressed banner meant the user was told nothing at all.
//   2. Keep the home-screen / dock badge honest. The server stamps a count on
//      every push, but a dialog answered WITHOUT any following push would leave
//      it stale — so the app recomputes from the sessions snapshot it already
//      holds, on every foreground and on every delta.
//   3. Tell the SW which banner has gone stale. Opening a bot in the app means
//      its lock-screen card is answered; after a view the two must agree.
//
// Renders nothing.

import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { useToast } from '@/components/ui/use-toast'
import { useSessions } from '@/hooks/use-sessions'
import { useTeams } from '@/hooks/use-teams'
import { useUI } from '@/stores/ui-store'
import { botModeOn, BOT_KILL_SWITCH_KEY } from '@/lib/bot-mode-flag'
import { GROK_KILL_SWITCH_KEY } from '@/lib/grok-mode-flag'
import {
  attentionCount,
  sessionFromPath,
  tagForSession,
  toastForPush,
  type PushPayload,
} from '@/lib/push-bridge'

/** Post a message to the controlling service worker, if there is one. */
function tellServiceWorker(msg: Record<string, unknown>): void {
  try {
    navigator.serviceWorker?.controller?.postMessage(msg)
  } catch {
    /* no controller yet (first load before activation) — nothing to do */
  }
}

/** Set the badge from the window context too: on iOS the page and the SW share
 *  one badge, and the page is the one that knows the user just looked. */
function setBadge(count: number): void {
  try {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    if (count > 0) void nav.setAppBadge?.(count)
    else void nav.clearAppBadge?.()
  } catch {
    /* Badging unsupported — a nicety, never load-bearing */
  }
}

export function PushBridge(): null {
  const { toast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const { sessions } = useSessions()
  // SSE-live already (the shared `['teams']` cache), so this adds no request —
  // it only makes the badge count a crew that needs you, not just bots.
  const { teams } = useTeams()
  // BASE-APP BADGE PARITY (jury R1 finding 5). Crews are a Bot-mode surface: with
  // Bot mode OFF the app never routes to a team, so the icon badge must count
  // exactly what base does — standalone bots, no crew term — byte-for-byte. The
  // setting is reactive (a toggle re-badges); the kill switches are read once,
  // the same reload-level read the skin itself uses (`bot-mode-flag.ts`).
  const botMode = useUI((s) => s.botMode)
  const [kill] = React.useState(() => ({
    master: typeof localStorage === 'undefined' ? null : localStorage.getItem(BOT_KILL_SWITCH_KEY),
    grok: typeof localStorage === 'undefined' ? null : localStorage.getItem(GROK_KILL_SWITCH_KEY),
  }))
  const botOn = botModeOn(botMode, kill.master, kill.grok)

  // ── 1. the SW's forwarded payloads ────────────────────────────────────────
  // Re-subscribing when `toast`/`navigate` change is free (one listener swap)
  // and keeps the handler honest about which values it closes over.
  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; payload?: PushPayload } | undefined
      if (data?.type !== 'push') return
      const t = toastForPush(data.payload)
      if (!t) return
      toast({
        message: t.message,
        tone: t.tone,
        duration: 6000,
        action: { label: 'Open', onClick: () => navigate(t.url) },
      })
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [toast, navigate])

  // ── 2. the badge, recomputed from what the app can see ────────────────────
  // Crew term only under Bot mode (see `botOn` above) — off it, base parity.
  const count = attentionCount(sessions, botOn ? teams : undefined)
  React.useEffect(() => {
    setBadge(count)
    tellServiceWorker({ type: 'badge', badge: count })
  }, [count])

  // Foregrounding is the moment to self-heal: while the app was away a dialog
  // may have been answered in a pane, leaving the server's last stamped count
  // stale on the home screen.
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setBadge(count)
        tellServiceWorker({ type: 'badge', badge: count })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [count])

  // ── 3. viewing a bot answers its banner ───────────────────────────────────
  const viewing = sessionFromPath(location.pathname)
  React.useEffect(() => {
    if (!viewing) return
    tellServiceWorker({
      type: 'notification-seen',
      session: viewing,
      tag: tagForSession(viewing),
      badge: count,
    })
    // `count` is deliberately NOT a dependency: this fires on entering a
    // session, not every time the fleet's attention count moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing])

  return null
}
