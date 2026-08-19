/**
 * `<TeamPanel>` — the per-TEAM page (TEAMS-in-Bot-mode, Phase 2c).
 * ─────────────────────────────────────────────────────────────────────────────
 * The crew half of "talk to the lead" (OD-1 = A). Opening a team in the grok
 * roster shows the LEAD's live thread in the right pane — it is a first-class
 * bot now (Phase 1 server + Phase 2a client) — and THIS panel is the other face
 * of that same pane: who the crew is, what each member is doing, what the task
 * ledger says, what the lead costs, how it is instructed and what it can reach.
 *
 * It is a COPY of `<BotPanel>`'s frame, not a generalisation of it (build spec
 * §2c): the tab table, the full WAI-ARIA roving tablist, the scrolling body and
 * the pane/sheet fork are the same shapes, and the section primitives
 * (`Field`, `WorkingDirRow`) plus two whole tabs (`InstructionsTab`,
 * `ToolsTab`) are IMPORTED from bot-panel rather than duplicated. What is NOT
 * shared is the subject: BotPanel is 850 lines of session-shaped code, and a
 * `variant` prop threading a team through it would tangle both.
 *
 *   • variant="pane"  — the desktop roster's right column.
 *   • variant="sheet" — the phone's bottom sheet (Phase 6a mounts it).
 *
 * Tabs: Overview (facepile · crew · task ledger · lead cost/context/dir) ·
 * Instructions (the LEAD's) · Tools (the lead's grants, crew-scoped) ·
 * Activity (the team board — Phase 4).
 *
 * Data: `useTeams()` (SSE-live, via the `team` prop the roster passes down) +
 * `useSession(lead)`. NO new endpoints.
 *
 * Styling matches BotPanel: Tailwind + shadcn tokens (NOT `[data-grok]` CSS) so
 * the one component renders identically in the in-shell pane and in the
 * body-portalled sheet; the pane's chrome reuses the roster's `.gr-pane`.
 */
import * as React from 'react'
import { ArrowRight, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SessionMark } from '@/brand/marks'
import { SessionFace } from '@/components/roster/session-face'
import {
  Field,
  InstructionsTab,
  ToolsTab,
  WorkingDirRow,
} from '@/components/roster/bot-panel'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { useSession } from '@/hooks/use-sessions'
import { displayLabel, type ApiSession } from '@/lib/api'
import {
  needsYouCount,
  taskProgress,
  tasksForMember,
  type Team,
  type TeamMember,
  type MemberStatus,
} from '@/lib/api/teams'

/* ── tiny pure helpers — the same three bot-panel keeps local (and grok-roster
      before it), copied rather than exported so a panel module stays readable
      on its own; they are five lines each and have never drifted. ─────────── */

const CTX_WINDOW = 200_000
function ctxPct(tokens?: number): number | null {
  if (typeof tokens !== 'number' || tokens <= 0) return null
  return Math.min(100, Math.round((tokens / CTX_WINDOW) * 100))
}
// The STATE inks are the roster's own tone tokens (`--sm-tone-*`, declared on
// `[data-grok]` itself — grok-mode.css:48/206 — so they resolve in the pane AND
// in the portalled sheet, which stamps `data-grok` for exactly this reason), so
// a member's word here is the same colour as the row beside it. The shadcn
// fallbacks are wrapped in `hsl()` on purpose: `--status-*-ink` are HSL TRIPLES
// (globals.css:163), and a bare `var(--status-error-ink)` is not a colour at all.
const INK_OK = 'var(--sm-tone-success, hsl(var(--status-active-ink)))'
const INK_WARN = 'var(--sm-tone-warning, hsl(var(--status-waiting-ink)))'
const INK_HOT = 'var(--sm-tone-danger, hsl(var(--status-error-ink)))'
const INK_MUTED = 'hsl(var(--muted-foreground))'
function ringColor(pct: number): string {
  return pct < 50 ? INK_OK : pct < 80 ? INK_WARN : INK_HOT
}
function fmtTokens(n?: number): string | undefined {
  if (typeof n !== 'number' || n <= 0) return undefined
  if (n < 1000) return `${Math.max(0.1, n / 1000).toFixed(1)}k`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}
function modelOf(s: ApiSession | null): string {
  if (!s) return ''
  if (s.model?.trim()) return s.model.trim()
  return s.flags?.match(/--model[= ]+(\S+)/)?.[1] ?? ''
}

/** The member's state as a WORD + its ink — the roster's law 3 (state is a
 *  coloured word, never a recoloured face) carried into the panel. */
function statusWord(st: MemberStatus): { word: string; ink: string } {
  if (st === 'needs_you') return { word: 'needs you', ink: INK_HOT }
  if (st === 'working') return { word: 'working', ink: INK_WARN }
  if (st === 'idle') return { word: 'idle', ink: INK_OK }
  return { word: 'offline', ink: INK_MUTED }
}

/* ── facepile (the crew, at a glance — the roster row's pile, panel-sized) ─── */

function Facepile({ team, size = 30 }: { team: Team; size?: number }) {
  const shown = team.members.slice(0, 4)
  const rest = team.members.length - shown.length
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((m, i) => (
        <SessionMark
          key={m.agent_id}
          seed={m.name}
          size={size}
          animate={false}
          label={null}
          ring="var(--background)"
          className={i === 0 ? '' : '-ml-2'}
          attention={m.status === 'needs_you' ? 'needs' : null}
        />
      ))}
      {rest > 0 && (
        <span
          className="-ml-2 grid shrink-0 place-items-center rounded-full border border-border bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground"
          style={{ width: size, height: size }}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

/* ── the four tabs ─────────────────────────────────────────────────────────── */

type TabKey = 'overview' | 'instructions' | 'tools' | 'activity'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'tools', label: 'Tools' },
  { key: 'activity', label: 'Activity' },
]

/** One crew member. A plain row in Phase 2; Phase 3 passes `onOpen` and the
 *  same row becomes the button that opens the member's live pane (build spec
 *  §Phase 3 — "TeamPanel Overview's member list is the click target"). */
function MemberRow({
  team,
  member,
  onOpen,
}: {
  team: Team
  member: TeamMember
  onOpen?: (m: TeamMember) => void
}) {
  const st = statusWord(member.status)
  const tasks = tasksForMember(team, member)
  const openTasks = tasks.filter((t) => t.status !== 'completed').length
  const body = (
    <>
      <SessionMark
        seed={member.name}
        size={28}
        animate={false}
        label={null}
        attention={member.status === 'needs_you' ? 'needs' : null}
        className="shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-[13px] font-medium text-foreground">{member.name}</span>
        <span className="truncate text-[12px] text-muted-foreground">
          <span style={{ color: st.ink }}>{st.word}</span>
          {member.model ? ` · ${member.model}` : ''}
          {member.tmux_pane_id ? '' : ' · no live pane'}
        </span>
      </span>
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {tasks.length === 0
          ? 'no tasks'
          : openTasks > 0
            ? `${openTasks} of ${tasks.length} open`
            : `${tasks.length} done`}
      </span>
    </>
  )
  const cls =
    'flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5'
  if (!onOpen) return <div className={cls}>{body}</div>
  return (
    <button
      type="button"
      data-vr="team-member"
      onClick={() => onOpen(member)}
      className={cn(
        cls,
        'text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {body}
    </button>
  )
}

function OverviewTab({
  team,
  lead,
  leadSession,
  onOpenMember,
}: {
  team: Team
  lead: string | null
  leadSession: ApiSession | null
  onOpenMember?: (m: TeamMember) => void
}) {
  const needs = needsYouCount(team)
  const progress = taskProgress(team)
  const working = team.members.filter((m) => m.status === 'working').length
  // COST/CONTEXT is the LEAD's today, stated as such. A teammate's statusline
  // posts with the lead's inherited $SUPERMUX_SESSION, so per-member cost does
  // not exist on the wire yet; S3 (pane-attributed statusline, Phase 5) is what
  // turns this card into a real crew total. An honest label beats a fake sum.
  const pct = ctxPct(leadSession?.tokens)
  const tokens = fmtTokens(leadSession?.tokens)
  const dir = leadSession?.dir?.trim() || ''
  const model = modelOf(leadSession)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Crew
          </span>
          <span className="mt-2 text-[22px] font-semibold tabular-nums text-foreground">
            {team.members.length}
          </span>
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">
            {working ? `${working} working` : 'none working'}
          </span>
        </div>
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Needs you
          </span>
          <span
            className="mt-2 text-[22px] font-semibold tabular-nums"
            style={{ color: needs > 0 ? INK_HOT : undefined }}
          >
            {needs}
          </span>
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">
            {needs > 0 ? 'waiting on you' : 'all calm'}
          </span>
        </div>
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Tasks
          </span>
          <span className="mt-2 font-mono text-[22px] font-semibold tabular-nums text-foreground">
            {progress.done}/{progress.total}
          </span>
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">completed</span>
        </div>
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Context
          </span>
          {pct !== null ? (
            <div
              className="relative mt-2 size-11"
              style={{
                borderRadius: '50%',
                background: `conic-gradient(${ringColor(pct)} ${pct}%, var(--muted, #e5e5e5) 0)`,
              }}
            >
              <span className="absolute inset-[6px] grid place-items-center rounded-full bg-card font-mono text-[12px] font-bold text-foreground">
                {pct}%
              </span>
            </div>
          ) : (
            <span className="mt-2 text-base font-semibold text-foreground">—</span>
          )}
          <span className="mt-1.5 text-[11.5px] text-muted-foreground">
            {tokens ? `${tokens} tokens · lead` : 'lead — no tokens yet'}
          </span>
        </div>
      </div>

      <Field
        label="Crew"
        hint="Every teammate is its own Claude, running in a pane of the lead's window."
      >
        {team.members.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No teammates right now.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {team.members.map((m) => (
              <MemberRow key={m.agent_id} team={team} member={m} onOpen={onOpenMember} />
            ))}
          </div>
        )}
      </Field>

      <Field label="Tasks" hint="The crew's shared task list, as the lead wrote it.">
        {team.tasks.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No tasks yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {team.tasks.map((t) => (
              <li
                key={t.id || t.subject}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2"
              >
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{
                    background:
                      t.status === 'completed'
                        ? INK_OK
                        : t.status === 'in_progress'
                          ? INK_WARN
                          : INK_MUTED,
                  }}
                  aria-hidden
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px]',
                    t.status === 'completed'
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground',
                  )}
                >
                  {t.subject || t.id}
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {t.assigned_to ? t.assigned_to.split('@')[0] : 'unassigned'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Field>

      <Field label="Lead" hint="The colleague you talk to. Its thread IS the team's thread.">
        {lead ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <SessionFace name={lead} status={leadSession?.status} size={28} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                {displayLabel(leadSession ?? { name: lead })}
              </span>
              <span className="shrink-0 text-[12px] capitalize text-muted-foreground">
                {[leadSession?.status, model].filter(Boolean).join(' · ') || '—'}
              </span>
            </div>
            <WorkingDirRow name={lead} dir={dir} />
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            No live lead — this team's lead session isn't mapped right now, so there is no
            thread to open. The crew below is still read from disk.
          </p>
        )}
      </Field>
    </div>
  )
}

/* ── the panel body (shared by both variants) ──────────────────────────────── */

function TeamPanelBody({
  team,
  variant,
  onOpenThread,
  onOpenMember,
  onNavigate,
  initialTab,
}: {
  team: Team
  variant: 'pane' | 'sheet'
  onOpenThread: () => void
  onOpenMember?: (m: TeamMember) => void
  onNavigate: (name: string) => void
  initialTab?: TabKey
}) {
  const lead = team.lead_supermux_session
  const { session: leadSession } = useSession(lead ?? '')
  const [tab, setTab] = React.useState<TabKey>(initialTab ?? 'overview')
  const [restartAdvised, setRestartAdvised] = React.useState(false)
  const onRestartAdvised = React.useCallback(() => setRestartAdvised(true), [])

  const needs = needsYouCount(team)
  const progress = taskProgress(team)
  const sub = [
    `${team.members.length} ${team.members.length === 1 ? 'bot' : 'bots'}`,
    needs > 0 ? `${needs} need you` : null,
    progress.total > 0 ? `${progress.done}/${progress.total} tasks` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'pane' && 'h-full')}>
      {/* sticky header — facepile · team name · crew sub-line · Open thread */}
      <header className="flex items-center gap-3 border-b border-border bg-background/80 px-5 py-3 backdrop-blur-sm">
        {team.members.length > 0 ? (
          <Facepile team={team} />
        ) : (
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border text-muted-foreground">
            <Users className="size-4" aria-hidden />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
            {team.team_name}
          </span>
          <span className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{sub}</span>
        </div>
        {/* HONEST REFUSAL (invariant 6): a team whose lead isn't mapped this tick
            has no thread to open, so there is no button — a sentence instead. */}
        {lead ? (
          <button
            type="button"
            onClick={onOpenThread}
            data-vr="team-open-thread"
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open thread
            <ArrowRight className="size-3.5" aria-hidden />
          </button>
        ) : (
          <span
            data-vr="team-no-lead"
            className="shrink-0 rounded-md bg-muted/60 px-2 py-1 text-[12px] text-muted-foreground"
          >
            No live lead
          </span>
        )}
      </header>

      {/* tab bar — BotPanel's WAI-ARIA tab pattern verbatim: a plain `div` takes
          `role="tablist"`, roving `tabindex`, arrow-key movement, and each tab
          `aria-controls` the one panel it drives. */}
      <div
        role="tablist"
        aria-label="Team"
        className="flex shrink-0 items-center gap-1 border-b border-border px-4"
      >
        {TABS.map((t, ti) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`team-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="team-tabpanel"
            tabIndex={tab === t.key ? 0 : -1}
            data-vr="team-tab"
            data-vr-tab={t.key}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const next =
                e.key === 'ArrowRight'
                  ? (ti + 1) % TABS.length
                  : (ti - 1 + TABS.length) % TABS.length
              setTab(TABS[next].key)
              e.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
                ?.focus()
            }}
            className={cn(
              'relative -mb-px min-h-11 px-3 text-[13px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === t.key
                ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* scrolling tab body */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-5 py-5 [scrollbar-width:thin]',
          variant === 'sheet' && 'max-h-[70vh]',
        )}
        role="tabpanel"
        id="team-tabpanel"
        aria-labelledby={`team-tab-${tab}`}
        tabIndex={0}
      >
        {restartAdvised && (
          <p className="mb-4 inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-[12px] text-muted-foreground">
            <ArrowRight className="size-3 shrink-0" aria-hidden />
            Applies on the lead's next start — the running crew keeps its current model.
          </p>
        )}
        {tab === 'overview' && (
          <OverviewTab
            team={team}
            lead={lead}
            leadSession={leadSession}
            onOpenMember={onOpenMember}
          />
        )}
        {tab === 'instructions' &&
          (lead ? (
            <InstructionsTab
              name={lead}
              session={leadSession}
              onRestartAdvised={onRestartAdvised}
            />
          ) : (
            <NoLead what="instructions" />
          ))}
        {tab === 'tools' &&
          (lead ? (
            <div className="flex flex-col gap-6">
              <p className="rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
                The crew inherits the lead's grants — a teammate pane runs inside the lead's
                window and with its environment, so these are the whole team's tools.
              </p>
              <ToolsTab name={lead} session={leadSession} />
            </div>
          ) : (
            <NoLead what="tools" />
          ))}
        {tab === 'activity' && (
          <Field label="Team board" hint="The crew's shared issue board.">
            <p className="text-[13px] text-muted-foreground">
              Coming in Phase 4 — the team board lands here, mirrored from
              <code className="mx-1 rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">
                ~/.claude/tasks
              </code>
              by the server's board sync.
            </p>
          </Field>
        )}

        {/* the escape hatch, on every tab's scroll floor — the lead's terminal */}
        {lead && (
          <div className="mt-8 border-t border-border pt-5">
            <button
              type="button"
              onClick={() => onNavigate(lead)}
              data-vr="team-open-terminal"
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open the lead's terminal
              <ArrowRight className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The honest in-place refusal for the tabs that are the LEAD's (invariant 6):
 *  say what is missing and why, never a disabled control. */
function NoLead({ what }: { what: string }) {
  return (
    <p className="text-[13px] text-muted-foreground">
      This team's lead isn't mapped to a live session right now, so there are no {what} to
      show. They come back with the lead.
    </p>
  )
}

/* ── the public component ──────────────────────────────────────────────────── */

export interface TeamPanelProps {
  variant: 'pane' | 'sheet'
  team: Team
  /** Flip the roster's right pane back to the LEAD's live thread. */
  onOpenThread: () => void
  /** Open one crew member's own surface. Phase 3 wires it (`MemberPane` +
   *  the `{kind:'member'}` selection arm); until then the member list renders as
   *  plain rows rather than buttons that go nowhere. */
  onOpenMember?: (m: TeamMember) => void
  /** Navigate to a session's focus route (the lead's terminal escape hatch). */
  onNavigate: (name: string) => void
  /** sheet only. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Dev/bench only: seat a specific tab so a still frame can show each one. */
  initialTab?: TabKey
}

export function TeamPanel({
  variant,
  team,
  onOpenThread,
  onOpenMember,
  onNavigate,
  open,
  onOpenChange,
  initialTab,
}: TeamPanelProps) {
  if (variant === 'sheet') {
    return (
      <ResponsiveSheet
        open={open ?? false}
        onOpenChange={onOpenChange ?? (() => {})}
        title="Team"
        description={team.team_name}
        className="max-w-2xl"
      >
        {/* `data-grok` so the portalled sheet still resolves the Grok accent
            tokens — the same reason BotPanel's sheet stamps it. */}
        <div data-grok>
          <TeamPanelBody
            team={team}
            variant="sheet"
            onOpenThread={() => {
              onOpenChange?.(false)
              onOpenThread()
            }}
            onOpenMember={onOpenMember}
            onNavigate={(n) => {
              onOpenChange?.(false)
              onNavigate(n)
            }}
          />
        </div>
      </ResponsiveSheet>
    )
  }

  return (
    <div className="gr-pane gr-teampane" data-shell-pane>
      <TeamPanelBody
        team={team}
        variant="pane"
        onOpenThread={onOpenThread}
        onOpenMember={onOpenMember}
        onNavigate={onNavigate}
        initialTab={initialTab}
      />
    </div>
  )
}

export default TeamPanel
