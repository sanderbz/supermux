/**
 * `<TeamDetail>` — the PHONE team surface (Phase 6a, R9).
 * ─────────────────────────────────────────────────────────────────────────────
 * On desktop a team opens in the grok roster's right pane and never changes the
 * URL (§2b). The phone has no pane, so a team gets its own route — the SAME
 * composition as that pane, full-screen:
 *
 *   • `/team/:teamName`            — the LEAD's live thread (`ChatPanel`
 *     surface="phone") with the crew one tap away in a `TeamPanel` sheet.
 *   • `/team/:teamName/:agentId`   — one teammate's read-only pane (`MemberPane`).
 *
 * Bot mode OFF ⇒ this surface never renders: it redirects to `/focus/<lead>`, so
 * the base app's shell is byte-identical and no grok component leaks into it.
 * (`TeamRow` only lives in the grok roster, so the base app never routes here in
 * the first place — the redirect is the belt for a deep link.)
 *
 * Everything heavy (ChatPanel, TeamPanel, MemberPane) is lazy — the route itself
 * is a lazy chunk off `App.tsx`, so the 160 KB entry gate is untouched.
 */
import * as React from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'

import { useUI } from '@/stores/ui-store'
import { botModeOn, BOT_KILL_SWITCH_KEY } from '@/lib/bot-mode-flag'
import { GROK_KILL_SWITCH_KEY } from '@/lib/grok-mode-flag'
import { useTeams } from '@/hooks/use-teams'
import { useSessions } from '@/hooks/use-sessions'
import { useChatRenderer } from '@/components/chat/use-chat-renderer'
import { restSessionInput } from '@/lib/session-input'
import { BackIcon } from '@/components/chat/ui'
import { TeamCrewChip } from '@/components/team/team-crew-chip'
import type { TileSession } from '@/components/session-tile/types'
import type { ApiSession } from '@/lib/api'

// The same three lazy surfaces the desktop roster mounts — reused verbatim, so
// the phone and the pane are one composition, not two.
const ChatPanel = React.lazy(() => import('@/components/chat/chat-panel'))
const TeamPanel = React.lazy(() =>
  import('@/components/roster/team-panel').then((m) => ({ default: m.TeamPanel })),
)
const MemberPane = React.lazy(() =>
  import('@/components/roster/member-pane').then((m) => ({ default: m.MemberPane })),
)

function toTile(s: ApiSession): TileSession {
  return { ...s, updated_at: s.updated_at ?? '' }
}

function ls(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
}

// The two header-card slots share one pill (phone chat header, `mobile-light`).
const HDR_BTN =
  'grid size-[34px] flex-none place-items-center rounded-full bg-fill-soft text-ink-2 active:bg-fill-soft-2'

export function TeamDetail() {
  const { teamName = '', agentId } = useParams()
  const decodedTeam = decodeURIComponent(teamName)
  const decodedAgent = agentId ? decodeURIComponent(agentId) : null
  const navigate = useNavigate()

  // Read the skin ONCE (a skin flip is a reload-level change — same as every
  // other `botModeOn` read).
  const [grok] = React.useState(() =>
    botModeOn(useUI.getState().botMode, ls(BOT_KILL_SWITCH_KEY), ls(GROK_KILL_SWITCH_KEY)),
  )

  const { teams, isLoading } = useTeams()
  const { sessions } = useSessions()

  const team = React.useMemo(
    () => teams.find((t) => t.team_name === decodedTeam) ?? null,
    [teams, decodedTeam],
  )
  const leadName = team?.lead_supermux_session ?? null
  const leadRow = React.useMemo(
    () => (leadName ? sessions.find((s) => s.name === leadName) ?? null : null),
    [sessions, leadName],
  )
  // The SAME chat-eligibility gate the desktop pane uses (bot mode on + kill
  // switch + local Claude); a team lead is a first-class bot (Phase 1/2a).
  const threadEligible = useChatRenderer(leadRow)

  // The crew sheet's open state. `forcedOpen` keeps it open when there is no live
  // lead thread to sit behind it (an unmapped or ineligible lead), so the phone
  // still lands on the crew rather than a blank page — the honest analog of the
  // desktop pane opening straight to TeamPanel.
  const [sheetOpen, setSheetOpen] = React.useState(false)

  const goHome = React.useCallback(() => navigate('/'), [navigate])
  const teamPath = `/team/${encodeURIComponent(decodedTeam)}`

  // ── Bot mode OFF: the base app is untouched — hop to the lead's focus route
  //    (or home when there's no live lead). No grok surface renders here at all.
  if (!grok) {
    return (
      <Navigate to={leadName ? `/focus/${encodeURIComponent(leadName)}` : '/'} replace />
    )
  }

  // The team hasn't arrived yet — hold a beat rather than bounce, so a cold deep
  // link doesn't flash home before the `['teams']` GET resolves.
  if (!team) {
    if (isLoading) return <div className="h-full w-full" />
    return <Navigate to="/" replace />
  }

  // ── The MEMBER arm — one teammate's read-only pane, full-screen. ────────────
  if (decodedAgent) {
    const member = team.members.find((m) => m.agent_id === decodedAgent) ?? null
    if (!member) {
      // The teammate is gone (removed, or its team churned) — fall back to the
      // team, never a dead pane.
      return <Navigate to={teamPath} replace />
    }
    return (
      <div className="h-full w-full">
        <React.Suspense fallback={<div className="h-full w-full" />}>
          <MemberPane team={team} member={member} onBack={() => navigate(teamPath)} />
        </React.Suspense>
      </div>
    )
  }

  // ── The TEAM arm — the lead's thread, with the crew a tap away. ─────────────
  const leadTile = leadRow ? toTile(leadRow) : null
  const hasThread = threadEligible && !!leadTile
  const forcedOpen = !hasThread

  return (
    <div className="h-full w-full">
      {/* No live-lead thread ⇒ nothing behind the forced-open crew sheet, which
          carries its own backdrop (the honest analog of the desktop pane opening
          straight to TeamPanel). */}
      {hasThread && (
        <React.Suspense fallback={<div className="h-full w-full" />}>
          <ChatPanel
            name={leadTile!.name}
            session={leadTile}
            input={leadName ? restSessionInput(leadName) : undefined}
            surface="phone"
            headerLeading={
              <button type="button" aria-label="Back to bots" onClick={goHome} className={HDR_BTN}>
                <BackIcon />
              </button>
            }
            // THE CREW SIGNAL (jury R1 TEAM_THREAD fix) — the crew's faces +
            // live status + `N bots`, one tap to the crew sheet, so the phone
            // lead thread reads as a crew and not a lone bot.
            headerTrailing={
              <TeamCrewChip team={team} onOpen={() => setSheetOpen(true)} />
            }
          />
        </React.Suspense>
      )}

      <React.Suspense fallback={null}>
        <TeamPanel
          variant="sheet"
          team={team}
          open={forcedOpen || sheetOpen}
          onOpenChange={(open) => {
            if (open) {
              setSheetOpen(true)
              return
            }
            // Dismissing the sheet: when it is the whole surface (no thread), the
            // only place back is the roster; otherwise it just closes over the
            // thread.
            if (forcedOpen) goHome()
            else setSheetOpen(false)
          }}
          // Flip back to the lead's live thread by closing the sheet (a no-op
          // when there is no thread and the sheet is forced open — the terminal
          // stays reachable via the sheet's own "Open the lead's terminal").
          onOpenThread={() => setSheetOpen(false)}
          onOpenMember={(m) => navigate(`${teamPath}/${encodeURIComponent(m.agent_id)}`)}
          onDismissed={goHome}
          onNavigate={(n) => navigate(`/focus/${encodeURIComponent(n)}`)}
        />
      </React.Suspense>
    </div>
  )
}

export default TeamDetail
