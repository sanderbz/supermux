// team-strip-group.tsx
//
// One detected Agent Team rendered as a GROUPED section in the desktop focus
// session-strip — the focus-view analogue of the overview's TEAM CARD header +
// lead + teammate chips, but in the strip's 320px-wide compact-row language.
//
// STRUCTURE (matches the overview hierarchy so the focus view reads consistently):
//   • Team header: the team name + the SAME attention-first roll-up the overview
//     uses (needs-you blue pill ELSE green "done"; muted `N agents · X/Y tasks`).
//   • Lead: the lead's <CompactTile> (a real session) with a small "Lead" tag,
//     clicking it behaves exactly like any normal strip row (routes to /focus).
//   • Teammates: <TeammateStripRow> rows beneath, each with the member colour
//     rail + <MemberStatusDot>; clicking one selects its read-only terminal in
//     the main pane (NOT a route change — teammates aren't sessions).
//
// Visual language mirrors <CompactTile> + the overview chip so it never reads as a
// bolt-on: same rounded-xl rows, status-dot leading, calm `needs you` treatment
// (never alarmist red), colour rail = member.color.

import { cn } from '@/lib/utils'
import { CompactTile } from './compact-tile'
import { MemberStatusDot, TeamRollupBadges } from '@/components/team'
import { KillTeammateButton } from '@/components/team/kill-teammate-button'
import {
  tasksForMember,
  type Team,
  type TeamMember,
} from '@/lib/api/teams'
import type { TileSession } from '@/components/session-tile/types'

const TASK_DONE = 'completed'

export interface TeamStripGroupProps {
  team: Team
  /** The lead's session row (null when unmapped this tick — header + teammates
   *  still render, with a calm "lead not mapped" placeholder for the lead row). */
  lead: TileSession | null
  members: TeamMember[]
  /** The focused session name (route param) — highlights the lead row. */
  focusedSessionName: string
  /** The selected teammate's agent_id when a teammate is in the main pane (so its
   *  row highlights); null when a session is focused instead. */
  selectedTeammateId: string | null
  /** Jump to a session's focus route (lead / normal rows). */
  onSelectSession: (name: string) => void
  /** Select a teammate → its read-only terminal in the main pane. */
  onSelectTeammate: (team: Team, member: TeamMember) => void
  /** Map of session name → 1-indexed Cmd+N slot (≤9). The lead row reads
   *  its index out of this map so the same ⌘N hint shown in the focus
   *  strip matches the canonical `jumpSessions` order. */
  jumpIndexBySession?: Map<string, number>
}

export function TeamStripGroup({
  team,
  lead,
  members,
  focusedSessionName,
  selectedTeammateId,
  onSelectSession,
  onSelectTeammate,
  jumpIndexBySession,
}: TeamStripGroupProps) {
  return (
    <section
      aria-label={`Team ${team.team_name}`}
      className="rounded-2xl border border-border/60 bg-card/30 p-1.5"
    >
      <TeamStripHeader team={team} hasLead={!!lead} />

      <div className="mt-1 flex flex-col gap-1">
        {/* Lead — a full CompactTile (real session), OR a calm placeholder when
            the lead isn't mapped to a session this tick. The "Lead" label lives
            in the header row (next to the team name) — NOT overlaid on the tile —
            so it can never collide with the tile's own truncated title at any
            strip width (mirrors how the overview TEAM CARD inlines its Lead
            chip). */}
        {lead ? (
          <CompactTile
            session={lead}
            current={lead.name === focusedSessionName}
            onSelect={onSelectSession}
            jumpIndex={jumpIndexBySession?.get(lead.name)}
          />
        ) : (
          <div className="flex h-12 items-center rounded-xl border border-dashed border-border/60 px-3 text-[12px] text-muted-foreground">
            {team.lead_supermux_session
              ? 'Lead session starting…'
              : 'Lead not mapped right now'}
          </div>
        )}

        {/* Teammates — rendered ONLY from the team payload (not sessions). */}
        {members.map((m) => (
          <TeammateStripRow
            key={m.agent_id}
            team={team}
            member={m}
            selected={selectedTeammateId === m.agent_id}
            onSelect={() => onSelectTeammate(team, m)}
          />
        ))}
      </div>
    </section>
  )
}

// ── Team header roll-up (mirrors the overview TeamCard language) ──────────────
// The attention badges (primary token + muted secondary) are the SHARED
// <TeamRollupBadges> at the `strip` density — the SAME markup the overview
// TeamCard renders — so the focus + overview roll-ups never drift.

function TeamStripHeader({ team, hasLead }: { team: Team; hasLead: boolean }) {
  return (
    <header className="flex items-center gap-1.5 px-1.5 pt-0.5">
      <h3 className="min-w-0 shrink truncate text-[12px] font-semibold tracking-tight">
        {team.team_name}
      </h3>
      {/* "Lead" tag — inline here (not overlaid on the tile below) so it labels
          the hierarchy without ever covering the lead row's truncated title.
          Shown only when a lead is mapped; the unmapped case carries its own
          "Lead not mapped" placeholder row instead. */}
      {hasLead && (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
          Lead
        </span>
      )}
      <TeamRollupBadges team={team} density="strip" />
    </header>
  )
}

// ── A single teammate strip row ───────────────────────────────────────────────
// The compact-tile analogue for a teammate: status dot + colour rail + name +
// model/needs-you, click → its read-only terminal in the main pane. Matches the
// CompactTile geometry (h-12, rounded-xl) but at a slight inset so the hierarchy
// reads "these belong to the lead above."

function TeammateStripRow({
  team,
  member,
  selected,
  onSelect,
}: {
  team: Team
  member: TeamMember
  selected: boolean
  onSelect: () => void
}) {
  const needsYou = member.status === 'needs_you'
  const memberTasks = tasksForMember(team, member)
  const taskTotal = memberTasks.length
  const taskDone = memberTasks.filter((t) => t.status === TASK_DONE).length
  const rail = member.color || 'hsl(var(--status-idle))'

  return (
    // A `div role="button"` (not a real <button>) so the trailing kill-pane
    // trash — itself a <button> — nests as valid HTML (no button-in-button).
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      aria-current={selected ? 'true' : undefined}
      aria-label={`Teammate ${member.name}${needsYou ? ', needs you' : ''} — read-only terminal`}
      className={cn(
        // cursor-pointer + select-none + transition-colors: parity with the
        // reference teammate-chip role=button (a plain <div> is text-selectable
        // and has no native pointer cursor, unlike the <button> this replaced).
        'relative ml-2 flex h-11 cursor-pointer select-none items-center gap-2.5 overflow-hidden rounded-xl border pl-3 pr-2 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary/70 bg-card shadow-sm'
          : 'border-border/60 bg-card/40 hover:bg-card/70',
        // Calm attention tint when needs_you — never alarmist red; the pill is
        // the loud token (same language as the overview chip).
        !selected && needsYou && 'bg-status-waiting/[0.06]',
      )}
    >
      {/* 2px left colour rail = member identity colour. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
        style={{ backgroundColor: rail }}
      />
      <MemberStatusDot status={member.status} className="shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium">{member.name}</span>
        <span className="truncate text-[11px] text-muted-foreground/70">
          {member.model || 'teammate'}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {needsYou ? (
          <span className="rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
            needs you
          </span>
        ) : (
          taskTotal > 0 && (
            <span className="px-1 text-[11px] font-medium tabular-nums text-muted-foreground/70">
              {taskDone}/{taskTotal}
            </span>
          )
        )}
        {/* Kill-pane trash (manual Agent Teams cleanup). Renders nothing when
            there's no live pane / the lead isn't mapped; swallows the click so
            it never selects the teammate row. */}
        <KillTeammateButton team={team} member={member} />
      </span>
    </div>
  )
}

export default TeamStripGroup
