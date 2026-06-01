import { Navigate } from 'react-router-dom'

import { useMediaQuery } from '@/hooks/use-media-query'
import { useSessions } from '@/hooks/use-sessions'
import { useLastActiveSession } from '@/stores/board-create-session-store'
import { DesktopFocus } from '@/routes/focus/desktop'
import { MobileFocus } from '@/routes/focus/mobile'

// The focus route forks by viewport: desktop (≥768px) vs
// mobile (<768px). The DESKTOP branch (focus/desktop.tsx) is the two-column
// split: 320px session-strip + main pane with the LiveTerminal, FocusHeader,
// the DesktopDock, plus document-level keyboard capture. The
// MOBILE branch (focus/mobile.tsx) is the Vaul drag-detent sheet over the
// LiveTerminal, mobile dock, accessory bar, edge gestures. The two branches are
// disjoint files; this is the only fork point they share.
export function Focus() {
  const isDesktop = useMediaQuery('(min-width: 768px)')

  // Desktop (≥768px): split + dock.
  if (isDesktop) return <DesktopFocus />

  // Mobile (<768px): Vaul detent sheet, dock, edge gestures.
  return <MobileFocus />
}

// `/focus` (no `:name`) — the entry the desktop SideNav's Focus button points at.
// Resolves the target session in this order:
//   1. The last-active session (persisted in `useLastActiveSession`; both focus
//      routes already write to it on mount, so it's the session the user was
//      most recently focused in).
//   2. If that session no longer exists (stopped + cleaned up), the first
//      non-archived session in the live list — so the button is never a dead
//      end when there IS a session to focus.
//   3. Otherwise overview, which is the natural empty-state landing.
//
// `<Navigate replace>` so the redirect doesn't add a history entry — clicking
// "Focus" then Back returns to where you came from, not to `/focus`.
export function FocusEntry() {
  const [lastActive] = useLastActiveSession()
  const { sessions } = useSessions()

  const live = sessions.filter((s) => !s.archived)
  const target =
    (lastActive && live.find((s) => s.name === lastActive)?.name) ||
    live[0]?.name ||
    null

  if (!target) return <Navigate to="/" replace />
  return <Navigate to={`/focus/${encodeURIComponent(target)}`} replace />
}
