// SessionPickerSheet — session pill → open session picker sheet (full list,
// selectable).
//
// A Vaul half-sheet listing every session in the shared pinned-then-active order
// (session-order.ts). Tapping a row switches focus to that session and closes the
// sheet. The current session is marked with an accent rail + check. Glass material
// (regularMaterial), 36×5 drag indicator, ≥44pt rows.
//
// TEAM-AWARE: detected Agent Teams render as GROUPED sections at the top
// (a team header with the same attention-first roll-up the overview TEAM CARD
// uses, then the lead session row, then the teammate rows). Tapping a teammate
// opens its READ-ONLY terminal (via the shared TeammateFocus overlay the mobile
// route hosts) — teammates are not sessions, so they never route. Non-team
// sessions list below as today. No teams → today's flat list (zero regression).

import { Drawer } from 'vaul'
import { motion } from 'framer-motion'
import { Check, Eye } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { displayLabel, type ApiSession } from '@/lib/api'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { MemberStatusDot } from '@/components/team'
import {
  needsYouCount,
  taskProgress,
  type Team,
  type TeamMember,
} from '@/lib/api/teams'
import { groupedPickerLayout } from './session-order'

export interface SessionPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: ApiSession[]
  current: string
  onPick: (name: string) => void
  /** Detected Agent Teams — rendered as grouped sections. Optional →
   *  empty = today's flat session list. */
  teams?: Team[]
  /** Tap a teammate → open its read-only terminal (the mobile route hosts the
   *  shared TeammateFocus overlay). Required for teammate rows to be tappable. */
  onPickTeammate?: (team: Team, member: TeamMember) => void
}

export function SessionPickerSheet({
  open,
  onOpenChange,
  sessions,
  current,
  onPick,
  teams = [],
  onPickTeammate,
}: SessionPickerSheetProps) {
  // Team-grouped layout (single source of truth in session-order.ts): each team's
  // lead + teammates grouped above, the non-team sessions ordered below.
  const { groups, loose } = groupedPickerLayout(sessions, teams)
  const empty = groups.length === 0 && loose.length === 0

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex max-h-[70vh] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
            Sessions
          </Drawer.Title>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
            {empty ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No other sessions.
              </p>
            ) : (
              <>
                {/* Detected teams — grouped header + lead + teammates. */}
                {groups.map(({ team, lead }) => (
                  <section
                    key={team.team_name}
                    aria-label={`Team ${team.team_name}`}
                    className="rounded-xl border border-border/60 bg-card/30 p-1"
                  >
                    <TeamPickerHeader team={team} />
                    {lead ? (
                      <SessionRow
                        session={lead}
                        isCurrent={lead.name === current}
                        lead
                        onPick={() => {
                          onPick(lead.name)
                          onOpenChange(false)
                        }}
                      />
                    ) : (
                      <div className="mx-1 flex h-10 items-center rounded-lg border border-dashed border-border/60 px-3 text-[12px] text-muted-foreground">
                        {team.lead_supermux_session
                          ? 'Lead session starting…'
                          : 'Lead not mapped right now'}
                      </div>
                    )}
                    {team.members.map((m) => (
                      <TeammateRow
                        key={m.agent_id}
                        team={team}
                        member={m}
                        onPick={() => {
                          onPickTeammate?.(team, m)
                          onOpenChange(false)
                        }}
                      />
                    ))}
                  </section>
                ))}

                {/* Non-team sessions — the flat list, as today. */}
                {loose.map((s) => (
                  <SessionRow
                    key={s.name}
                    session={s}
                    isCurrent={s.name === current}
                    onPick={() => {
                      onPick(s.name)
                      onOpenChange(false)
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── Team header roll-up (mirrors the overview TeamCard language) ──────────────

function TeamPickerHeader({ team }: { team: Team }) {
  const needs = needsYouCount(team)
  const { done, total } = taskProgress(team)
  const agentCount = team.members.length
  return (
    <header className="flex items-center gap-1.5 px-2 pb-1 pt-1">
      <h3 className="min-w-0 shrink truncate text-[12px] font-semibold tracking-tight">
        {team.team_name}
      </h3>
      {needs > 0 ? (
        <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
          needs you · {needs}
        </span>
      ) : (
        <span className="shrink-0 rounded-full bg-status-ready/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-ready">
          done
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
        {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        {total > 0 && ` · ${done}/${total}`}
      </span>
    </header>
  )
}

// ── A session row (lead or loose) ─────────────────────────────────────────────

function SessionRow({
  session,
  isCurrent,
  lead,
  onPick,
}: {
  session: ApiSession
  isCurrent: boolean
  lead?: boolean
  onPick: () => void
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      transition={springs.buttonPress}
      onClick={onPick}
      className={cn(
        'flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left',
        isCurrent ? 'bg-secondary' : 'active:bg-secondary/60',
      )}
    >
      <StatusDot status={session.status} />
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
        {displayLabel(session)}
      </span>
      {lead && (
        <span className="shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-muted-foreground">
          Lead
        </span>
      )}
      <span className="shrink-0 text-[12px] text-muted-foreground">
        {STATUS_LABEL[session.status]}
      </span>
      {isCurrent && (
        <Check className="size-4 shrink-0 text-primary" aria-label="Current" />
      )}
    </motion.button>
  )
}

// ── A teammate row (read-only) ────────────────────────────────────────────────

function TeammateRow({
  team,
  member,
  onPick,
}: {
  team: Team
  member: TeamMember
  onPick: () => void
}) {
  void team
  const needsYou = member.status === 'needs_you'
  const rail = member.color || 'hsl(var(--status-idle))'
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      transition={springs.buttonPress}
      onClick={onPick}
      aria-label={`Teammate ${member.name}${needsYou ? ', needs you' : ''} — read-only terminal`}
      className={cn(
        'relative ml-2 flex h-11 w-[calc(100%-0.5rem)] items-center gap-2.5 overflow-hidden rounded-lg pl-3 pr-2 text-left',
        'active:bg-secondary/60',
        needsYou && 'bg-status-waiting/[0.06]',
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
        style={{ backgroundColor: rail }}
      />
      <MemberStatusDot status={member.status} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
        {member.name}
      </span>
      {needsYou ? (
        <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
          needs you
        </span>
      ) : (
        <Eye
          className="size-3.5 shrink-0 text-muted-foreground/50"
          aria-label="Read-only"
        />
      )}
    </motion.button>
  )
}
