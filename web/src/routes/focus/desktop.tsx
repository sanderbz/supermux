// routes/focus/desktop.tsx — M14.
//
// The desktop focus-mode route: resolves the session list (single source via
// useFocusSessions) + the current session from the route `:name`, then renders
// the two-column <DesktopSplit> (320px session-strip + main pane with the M13
// LiveTerminal, FocusHeader, and the full §4.4.3 DesktopDock).
//
// Navigation semantics (§4.4):
//   • Detach (⌘D / button) → navigate('/') — session kept alive.
//   • Stop  (⌘W / button)  → confirm, POST /stop, then navigate('/').
//   • Cmd+1..9 / compact-tile click → jump to the N-th session's focus route.
//
// The command palette (⌘K) is mounted globally in <Layout>; the slash menu is
// owned by <DesktopDock> itself (anchored popover above the "/" button) — this
// route no longer needs to pass stub callbacks for either.
//
// CACHED-TAIL CROSSFADE (scroll-on-open). The <LiveTerminal> that shows this
// session's pty is rendered deep inside <DesktopSplit>, not here — so rather
// than thread the cached last-screen capture (`preview_ansi`/`preview_lines`)
// through that component, <LiveTerminal> falls back to the SHARED `useSessions`
// cache by name when no preview props are supplied. That is the same SSE-merged
// source `useFocusSessions` (below) reads, so the desktop focus terminal shows
// the CURRENT screen instantly on open (no blank, no replay scroll) and then
// crossfades to live — identical UX to the mobile route, which passes the row
// explicitly. Empty/new sessions reveal the xterm directly (nothing to scroll).

import * as React from 'react'
import { useParams } from 'react-router-dom'

import { focusApi } from '@/lib/api'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import { CONFIRM } from '@/brand/copy'
import { DesktopSplit } from '@/components/focus-mode/desktop-split'
import { useFocusSessions } from '@/components/focus-mode/use-focus-sessions'
import type { TileSession } from '@/components/session-tile/types'

export interface DesktopFocusProps {
  /** DEV-only mock injection (the /dev/focus verification page). Production omits
   *  it → the real `useSessions` store. */
  mockSessions?: TileSession[]
}

export function DesktopFocus({ mockSessions }: DesktopFocusProps = {}) {
  const { name = '' } = useParams()
  // View-Transition navigate (§M23a): focus→overview plays the reverse morph,
  // focus→focus cross-fades the main pane. Falls back to a plain navigate where
  // the API is unsupported / reduced-motion is set.
  const navigate = useNavigateMorph()
  const { sessions, current } = useFocusSessions(name, mockSessions)

  const onSelect = React.useCallback(
    (next: string) => navigate(`/focus/${encodeURIComponent(next)}`),
    [navigate],
  )

  // Detach (⌘D): leave to overview, session kept alive (§4.4).
  const onDetach = React.useCallback(() => navigate('/'), [navigate])

  // Stop (⌘W): confirm + POST /stop + leave (§4.4.3). The stop fetch is
  // best-effort before M12 wires the full sessions client — failures are
  // surfaced via the browser, never crash the route.
  const onStop = React.useCallback(() => {
    if (!name) return
    if (
      !window.confirm(`${CONFIRM.killSession.title}\n\n${CONFIRM.killSession.body}`)
    ) {
      return
    }
    void focusApi
      .stopSession(name)
      .catch((e) => console.warn('stopSession failed', e))
      .finally(() => navigate('/'))
  }, [name, navigate])

  return (
    <DesktopSplit
      name={name}
      sessions={sessions}
      current={current}
      onSelect={onSelect}
      onDetach={onDetach}
      onStop={onStop}
    />
  )
}

export default DesktopFocus
