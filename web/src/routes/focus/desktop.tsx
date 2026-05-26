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
import { useQueryClient } from '@tanstack/react-query'

import { focusApi, type ApiSession } from '@/lib/api'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import { CONFIRM, killTeamLeadConfirm } from '@/brand/copy'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { DesktopSplit } from '@/components/focus-mode/desktop-split'
import { useFocusSessions } from '@/components/focus-mode/use-focus-sessions'
import { useTeams } from '@/hooks/use-teams'
import type { Team } from '@/lib/api/teams'
import type { TileSession } from '@/components/session-tile/types'

export interface DesktopFocusProps {
  /** DEV-only mock injection (the /dev/focus verification page). Production omits
   *  it → the real `useSessions` store. */
  mockSessions?: TileSession[]
  /** DEV-only mock teams injection (the /dev/focus verification page). Production
   *  omits it → the real `useTeams` store. */
  mockTeams?: Team[]
}

export function DesktopFocus({ mockSessions, mockTeams }: DesktopFocusProps = {}) {
  const { name = '' } = useParams()
  // View-Transition navigate (§M23a): focus→overview plays the reverse morph,
  // focus→focus cross-fades the main pane. Falls back to a plain navigate where
  // the API is unsupported / reduced-motion is set.
  const navigate = useNavigateMorph()
  const qc = useQueryClient()
  const { sessions, current } = useFocusSessions(name, mockSessions)
  // Detected Agent Teams — the SAME shared `['teams']` cache the overview TEAM
  // CARD reads (GET on mount, then SSE-live). Mock injection bypasses the hook's
  // network so the /dev/focus harness can eyeball team states offline.
  const liveTeams = useTeams()
  const teams = mockTeams ?? liveTeams.teams

  const onSelect = React.useCallback(
    (next: string) => navigate(`/focus/${encodeURIComponent(next)}`),
    [navigate],
  )

  // Detach (⌘D): leave to overview, session kept alive (§4.4).
  const onDetach = React.useCallback(() => navigate('/'), [navigate])

  // Stop (⌘W): confirm + POST /stop + leave (§4.4.3). The stop fetch is
  // best-effort — failures are surfaced via the browser, never crash the route.
  //
  // Team-lead awareness: teammates are split-panes INSIDE the lead's session, so
  // stopping a lead ends the whole team. When `name` IS a team lead we swap in
  // the team-aware confirm copy (which spells out the N teammates that go down
  // with it) so the user isn't surprised. A normal session reads EXACTLY as
  // before — only leads get the extended copy.
  //
  // SUPERMUX-38: flip the cached row to `stopped` OPTIMISTICALLY the instant Stop
  // is pressed, so the overview we navigate back to shows the session stopped
  // immediately — the user never perceives the (now-brief) server-side teardown
  // as "it didn't work". The backend also broadcasts `stopped` over SSE on the
  // real teardown, so this optimistic write is only the head-start; `invalidate`
  // in `.finally` backfills the authoritative row. Mirrors the quick-peek-modal
  // stop path — one shared `['sessions']` cache, no new transport.
  const onStop = React.useCallback(() => {
    if (!name) return
    const team = teams.find((t) => t.lead_supermux_session === name)
    const c = team ? killTeamLeadConfirm(team.members.length) : CONFIRM.killSession
    if (!window.confirm(`${c.title}\n\n${c.body}`)) {
      return
    }
    qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
      (prev ?? []).map((s) =>
        s.name === name ? { ...s, status: 'stopped' as const } : s,
      ),
    )
    void focusApi
      .stopSession(name)
      .catch((e) => console.warn('stopSession failed', e))
      .finally(() => {
        // Reconcile against the server's authoritative state (the SSE `stopped`
        // delta may have already landed; this covers the case it hasn't).
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
        navigate('/')
      })
  }, [name, navigate, qc, teams])

  return (
    <DesktopSplit
      name={name}
      sessions={sessions}
      current={current}
      teams={teams}
      onSelect={onSelect}
      onDetach={onDetach}
      onStop={onStop}
    />
  )
}

export default DesktopFocus
