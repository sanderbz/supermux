// routes/focus/desktop.tsx
//
// The desktop focus-mode route: resolves the session list (single source via
// useFocusSessions) + the current session from the route `:name`, then renders
// the two-column <DesktopSplit> (320px session-strip + main pane with the
// LiveTerminal, FocusHeader, and the full DesktopDock).
//
// Navigation semantics:
//   • Detach (⌘D / button) → navigate('/') — session kept alive.
//   • Stop  (⌘W / button)  → confirm + POST /stop, then STAY on the focus route.
//                            The status flips to `stopped` (SSE + optimistic
//                            cache update) and <LiveTerminal> swaps to
//                            <StoppedSession>, giving the user a calm "this is
//                            stopped" screen with a restart affordance instead
//                            of yanking them away to the overview.
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
import { StartTeamSheet } from '@/components/session-tile/start-team-sheet'
import { useFocusSessions } from '@/components/focus-mode/use-focus-sessions'
import { useTeams } from '@/hooks/use-teams'
import { useLastActiveSession } from '@/stores/board-create-session-store'
import { useToast } from '@/components/ui/use-toast'
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
  // View-Transition navigate: focus→overview plays the reverse morph,
  // focus→focus cross-fades the main pane. Falls back to a plain navigate where
  // the API is unsupported / reduced-motion is set.
  const navigate = useNavigateMorph()
  const qc = useQueryClient()
  const { sessions, current } = useFocusSessions(name, mockSessions)
  // Remember the focused session as the app-wide "last-active" pick so /files
  // (no `:name`) lands in this session's dir on the next visit. See
  // stores/board-create-session-store.ts.
  const [, setLastActiveSession] = useLastActiveSession()
  React.useEffect(() => {
    if (name) setLastActiveSession(name)
  }, [name, setLastActiveSession])
  // Detected Agent Teams — the SAME shared `['teams']` cache the overview TEAM
  // CARD reads (GET on mount, then SSE-live). Mock injection bypasses the hook's
  // network so the /dev/focus harness can eyeball team states offline.
  const liveTeams = useTeams()
  const teams = mockTeams ?? liveTeams.teams

  const onSelect = React.useCallback(
    (next: string) => navigate(`/focus/${encodeURIComponent(next)}`),
    [navigate],
  )

  // Detach (⌘D): leave to overview, session kept alive.
  const onDetach = React.useCallback(() => navigate('/'), [navigate])

  // Stop (⌘W): confirm + POST /stop, then STAY on the focus route. The user
  // explicitly chose to stop THIS session — they didn't ask to leave it. The
  // status flip to `stopped` (optimistic cache write below + SSE delta) causes
  // <LiveTerminal> to swap to <StoppedSession>, which already provides the
  // calm "session is stopped" surface with a restart affordance. Yanking the
  // user back to the overview was unwanted context loss.
  //
  // The stop fetch is best-effort — failures are surfaced via the browser
  // console, never crash the route.
  //
  // Team-lead awareness: teammates are split-panes INSIDE the lead's session,
  // so stopping a lead ends the whole team. When `name` IS a team lead we
  // swap in the team-aware confirm copy (which spells out the N teammates that
  // go down with it) so the user isn't surprised. A normal session reads
  // EXACTLY as before — only leads get the extended copy.
  //
  // Flip the cached row to `stopped` OPTIMISTICALLY the instant Stop is
  // pressed, so the in-page state (header status dot, strip row, dock) reads
  // stopped immediately — the user never perceives the (now-brief) server-side
  // teardown as "it didn't work". The backend also broadcasts `stopped` over
  // SSE on the real teardown, so this optimistic write is only the head-start;
  // `invalidate` in `.finally` backfills the authoritative row. Mirrors the
  // quick-peek-modal stop path — one shared `['sessions']` cache, no new
  // transport.
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
        // delta may have already landed; this covers the case it hasn't). We
        // intentionally DO NOT navigate away — the user stays on the focus
        // route to see the calm `StoppedSession` surface that LiveTerminal
        // swaps in when status === 'stopped'.
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      })
  }, [name, qc, teams])

  // Gate the "Make it a team" affordance on a session that
  // is eligible to be converted — must exist, not be archived, and not already
  // be a team lead. When ineligible we omit the callback so
  // the header doesn't render the button at all (calmer than a disabled one).
  const isTeamLead = React.useMemo(
    () => teams.some((t) => t.lead_supermux_session === name),
    [teams, name],
  )
  const { toast } = useToast()
  const [convertOpen, setConvertOpen] = React.useState(false)
  const eligibleForTeamConversion =
    !!current && current.provider === 'claude' && !isTeamLead
  const onMakeTeam = React.useMemo(
    () =>
      eligibleForTeamConversion ? () => setConvertOpen(true) : undefined,
    [eligibleForTeamConversion],
  )

  return (
    <>
      <DesktopSplit
        name={name}
        sessions={sessions}
        current={current}
        teams={teams}
        onSelect={onSelect}
        onDetach={onDetach}
        onStop={onStop}
        onMakeTeam={onMakeTeam}
      />
      {current && (
        <StartTeamSheet
          sessionName={name}
          sessionDir={current.dir}
          open={convertOpen}
          onOpenChange={setConvertOpen}
          onStarted={(leadName) => {
            // Conversion REUSES the existing row, so the name is unchanged —
            // we stay on this focus route. Refresh the cache so the (now-team)
            // session's tags/desc reflect server state, and confirm with a
            // calm toast (the TEAM CARD itself will appear once detection finds
            // the on-disk team files within a tick or two).
            void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
            toast({ message: 'Team starting', tone: 'active' })
            if (leadName !== name) {
              // Defensive — shouldn't happen for convert, but if the server
              // ever returns a different lead name we still route correctly.
              navigate(`/focus/${encodeURIComponent(leadName)}`)
            }
          }}
        />
      )}
    </>
  )
}

export default DesktopFocus
