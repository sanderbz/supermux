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
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, MoreHorizontal, Trash2, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SessionMark } from '@/brand/marks'
import { SessionFace } from '@/components/roster/session-face'
import {
  Field,
  InstructionsTab,
  ToolsTab,
  WorkingDirRow,
} from '@/components/roster/bot-panel'
import { IssueList } from '@/components/issues/issue-list'
import { IssueSurface } from '@/components/issues/issue-surface'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { useToast } from '@/components/ui/use-toast'
import { useArmedConfirm } from '@/hooks/use-armed-confirm'
import { useBoards } from '@/hooks/use-board'
import { RovingListProvider, useRovingItem } from '@/hooks/use-roving'
import { useSession } from '@/hooks/use-sessions'
import { TEAMS_KEY } from '@/hooks/use-teams'
import { displayLabel, type ApiSession } from '@/lib/api'
import {
  needsYouCount,
  taskProgress,
  tasksForMember,
  teamsApi,
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

/* ── destructive verbs (Phase 4b) — the ONE armed-confirm idiom ────────────
   Both team management destructives (remove a teammate, dismiss the team) live
   HERE, in grok, so neither needs a trip to the retiring `/focus` board. They
   reuse `useArmedConfirm` (the shared 4 s arm window) rather than inventing a
   dialog, and they call the EXISTING `teamsApi` methods — no new endpoints, and
   no client ever touches `~/.claude/teams/**` (invariant 5: the team model is
   derived; a "removal" is a supermux-side hide). */

/** Remove / kill ONE teammate. Carries `kill-teammate-button.tsx`'s capability
 *  into the grok panel (that component is on the retirement list and must not be
 *  imported from grok code). Live member ⇒ the server kills its pane THEN hides
 *  it; offline member ⇒ it is just hidden. The verb says which. */
function RemoveMemberButton({
  team,
  member,
  tabIndex,
  onResolve,
}: {
  team: Team
  member: TeamMember
  tabIndex?: number
  /** Fired when the action settles (cancelled, or removal finished/failed), so
   *  a touch row that revealed this control can collapse back to its overflow. */
  onResolve?: () => void
}) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [pending, setPending] = React.useState(false)
  // `End pane & remove` for a live teammate (calmer than `Kill & remove`, same
  // two-step confirm) — jury R1 MANAGEMENT note; matches `kill-teammate-button`.
  const verb = member.tmux_pane_id ? 'End pane & remove' : 'Remove'
  const run = React.useCallback(() => {
    setPending(true)
    void teamsApi
      .removeTeammate(team.team_name, member.agent_id)
      .then(() => {
        toast({ message: `Removed ${member.name}` })
        // Re-pull now so the row disappears without waiting for the watcher's
        // next SSE snapshot (which also drops the dismissed member).
        void qc.invalidateQueries({ queryKey: TEAMS_KEY })
      })
      .catch(() => toast({ message: `Couldn't remove ${member.name}`, tone: 'error' }))
      .finally(() => {
        setPending(false)
        onResolve?.()
      })
  }, [qc, toast, team.team_name, member.agent_id, member.name, onResolve])
  const confirming = useArmedConfirm({ onConfirm: run })

  if (confirming.armed) {
    return (
      <span className="flex shrink-0 items-center gap-1" data-vr="member-remove-confirm">
        <button
          type="button"
          onClick={() => {
            confirming.cancel()
            onResolve?.()
          }}
          disabled={pending}
          className="rounded-md px-2 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirming.press}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-2.5 py-1.5 text-[12px] font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
          {verb}
        </button>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={confirming.press}
      disabled={pending}
      tabIndex={tabIndex}
      data-vr="member-remove"
      aria-label={`${verb} ${member.name}`}
      title={verb}
      className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <Trash2 className="size-4" aria-hidden />
    </button>
  )
}

/** Dismiss the whole TEAM — the Overview footer half of the verb (the roster's
 *  TeamRow kebab is the other). Parks the team's on-disk config under
 *  `.archived/` server-side so the watcher stops surfacing it. */
function DismissTeamButton({
  team,
  onDismissed,
}: {
  team: Team
  onDismissed?: () => void
}) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [pending, setPending] = React.useState(false)
  const run = React.useCallback(() => {
    setPending(true)
    void teamsApi
      .dismiss(team.team_name)
      .then(() => {
        // Drop it from the shared cache at once — both reconcilers (the SSE
        // snapshot and a hard-reload GET) already exclude an archived dir.
        qc.setQueryData<Team[]>(TEAMS_KEY, (prev) =>
          (prev ?? []).filter((t) => t.team_name !== team.team_name),
        )
        toast({ message: `Dismissed ${team.team_name}` })
        onDismissed?.()
      })
      .catch(() => toast({ message: `Couldn't dismiss ${team.team_name}`, tone: 'error' }))
      .finally(() => setPending(false))
  }, [qc, toast, team.team_name, onDismissed])
  const confirming = useArmedConfirm({ onConfirm: run })

  return (
    <div className="flex flex-col gap-2">
      {confirming.armed ? (
        <div className="flex items-center gap-2" data-vr="team-dismiss-confirm">
          <button
            type="button"
            onClick={confirming.cancel}
            disabled={pending}
            className="min-h-9 rounded-[10px] px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirming.press}
            disabled={pending}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] bg-destructive px-3 text-[13px] font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Dismiss {team.team_name}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={confirming.press}
          disabled={pending}
          data-vr="team-dismiss"
          className="inline-flex min-h-9 items-center gap-1.5 self-start rounded-[10px] border border-border bg-card px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Dismiss this team
        </button>
      )}
      <p className="text-[12px] text-muted-foreground">
        Stops surfacing the crew in supermux. Claude's own roster on disk is never
        edited — nothing the lead wrote is lost.
      </p>
    </div>
  )
}

/** One crew member — the CLICK TARGET for a teammate (Phase 3, R3). The roster
 *  row above stays ONE button (a nested button is invalid HTML and breaks the
 *  roster's keyboard contract), so the hierarchy is honest: the row opens the
 *  TEAM, and this list opens a MEMBER.
 *
 *  The row is a wrapper `div` holding two siblings — the open button (which owns
 *  the list's roving tab stop) and the destructive remove action — for the same
 *  no-nested-buttons reason. Arrows move between members; Tab steps past the
 *  list. */
function MemberRow({
  team,
  member,
  onOpen,
  active,
}: {
  team: Team
  member: TeamMember
  onOpen?: (m: TeamMember) => void
  /** This member is the one open in the pane. */
  active?: boolean
}) {
  const st = statusWord(member.status)
  const tasks = tasksForMember(team, member)
  const openTasks = tasks.filter((t) => t.status !== 'completed').length
  // The roster's keyboard contract for a list of peers (build spec §Phase 3):
  // ONE tab stop, arrows choose the member. Keyed by `agent_id`, the same stable
  // identity the selection and the API use.
  const roving = useRovingItem(member.agent_id)
  // Reveal-on-demand for the destructive remove action (§1/§6.3). A resting row
  // is clean — mark + name + status + tasks, no trash shouting. On a fine
  // pointer the trash appears on row hover / focus-within (pure CSS, below); on
  // a coarse pointer there is no hover, so a QUIET neutral `⋯` overflow reveals
  // it on tap. `managing` is that touch reveal; it collapses again once the
  // action settles (RemoveMemberButton's `onResolve`).
  const [managing, setManaging] = React.useState(false)
  // Pulled out before the JSX: passing the roving handle straight into `ref=`
  // makes the compiler lint read every sibling property as a ref access.
  const rovingRef = roving.ref
  const setRowRef = React.useCallback(
    (el: HTMLButtonElement | null) => rovingRef(el),
    [rovingRef],
  )
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
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1 rounded-xl border border-border bg-card pr-1.5 transition-colors',
        active && 'border-primary/50 bg-accent/30',
      )}
      data-vr="team-member-row"
    >
      {onOpen ? (
        <button
          type="button"
          ref={setRowRef}
          tabIndex={roving.tabIndex}
          onFocus={roving.onFocus}
          onKeyDown={roving.onKeyDown}
          data-vr="team-member"
          aria-current={active || undefined}
          aria-label={`${member.name} — ${st.word}`}
          onClick={() => onOpen(member)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">{body}</div>
      )}
      {/* Remove / kill this teammate — destructive, armed-confirm, REVEALED on
          demand so the resting row stays calm (§1/§6.3). */}
      <div className="flex shrink-0 items-center" data-vr="team-member-manage">
        {/* Coarse-pointer (touch) overflow: a quiet neutral `⋯` — never a
            persistent trash — that reveals the destructive control on tap.
            Hidden on fine pointers, where hover/focus does the revealing. */}
        {!managing && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Manage ${member.name}`}
            data-vr="team-member-overflow"
            onClick={() => setManaging(true)}
            className="hidden size-9 shrink-0 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:grid"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        )}
        <div
          className={cn(
            'transition-opacity',
            // Engaged (touch tapped the overflow, or an armed confirm is up):
            // pin visible in both pointer worlds.
            managing
              ? 'opacity-100'
              : // Resting: hidden. Fine pointer reveals on row hover / focus;
                // coarse pointer hides it entirely (the overflow stands in).
                'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:hidden',
          )}
        >
          <RemoveMemberButton
            team={team}
            member={member}
            tabIndex={roving.tabIndex}
            onResolve={() => setManaging(false)}
          />
        </div>
      </div>
    </div>
  )
}

/** The Activity tab (Phase 4a) — THE TEAM BOARD. `board_sync.rs` already
 *  registers and mirrors a `kind='team'` board per team, so this is pure
 *  wiring: find the board, list it inline, and open the full `<IssueSurface>`
 *  for the detail. NO board ⇒ one calm line, never an empty surface. */
function ActivityTab({ team }: { team: Team }) {
  const { boards } = useBoards()
  const teamBoardId = React.useMemo(
    () => boards.find((b) => b.kind === 'team' && b.team_name === team.team_name)?.id,
    [boards, team.team_name],
  )
  const [issuesOpen, setIssuesOpen] = React.useState(false)
  const [openIssueId, setOpenIssueId] = React.useState<string | null>(null)

  if (!teamBoardId) {
    return (
      <Field label="Team board" hint="The crew's shared issue board.">
        <p className="text-[13px] text-muted-foreground" data-vr="team-no-board">
          No board yet for {team.team_name}. One appears here as soon as the crew files
          its first task — supermux mirrors the team's own task files, it never
          creates them.
        </p>
      </Field>
    )
  }

  return (
    <Field label="Team board" hint="The crew's shared issue board, mirrored from its task files.">
      <div className="flex flex-col gap-2" data-vr="team-board">
        <IssueList
          boardId={teamBoardId}
          onOpen={(issue) => {
            setOpenIssueId(issue.id)
            setIssuesOpen(true)
          }}
        />
        <button
          type="button"
          onClick={() => {
            setOpenIssueId(null)
            setIssuesOpen(true)
          }}
          className="self-start rounded-md px-1 py-1 text-xs text-primary hover:underline"
        >
          Open the team board →
        </button>
      </div>
      <IssueSurface
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        initialIssueId={openIssueId}
        boardId={teamBoardId}
        title={team.team_name}
      />
    </Field>
  )
}

function OverviewTab({
  team,
  lead,
  leadSession,
  onOpenMember,
  activeMemberId,
  onDismissed,
}: {
  team: Team
  lead: string | null
  leadSession: ApiSession | null
  onOpenMember?: (m: TeamMember) => void
  /** `agent_id` of the member currently open in the pane, if any. */
  activeMemberId?: string | null
  onDismissed?: () => void
}) {
  // ONE tab stop for the crew list, arrows to choose the member — the roster's
  // keyboard contract, keyed by the same stable `agent_id` the selection uses.
  const rovingKeys = React.useMemo(
    () => team.members.map((m) => m.agent_id),
    [team.members],
  )
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
          <RovingListProvider keys={rovingKeys} orientation="vertical">
            <div className="flex flex-col gap-1.5">
              {team.members.map((m) => (
                <MemberRow
                  key={m.agent_id}
                  team={team}
                  member={m}
                  onOpen={onOpenMember}
                  active={activeMemberId === m.agent_id}
                />
              ))}
            </div>
          </RovingListProvider>
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

      {/* The team's own destructive verb, at the Overview's floor (the roster
          row's `⋯` is the same verb one level out). */}
      <Field label="Dismiss">
        <DismissTeamButton team={team} onDismissed={onDismissed} />
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
  activeMemberId,
  onDismissed,
  onNavigate,
  initialTab,
}: {
  team: Team
  variant: 'pane' | 'sheet'
  onOpenThread: () => void
  onOpenMember?: (m: TeamMember) => void
  activeMemberId?: string | null
  onDismissed?: () => void
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
            activeMemberId={activeMemberId}
            onDismissed={onDismissed}
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
        {tab === 'activity' && <ActivityTab team={team} />}

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
  /** Open one crew member's own surface — the roster answers with the
   *  `{kind:'member'}` selection arm and mounts `<MemberPane>` (Phase 3). When
   *  omitted the member list renders as plain rows rather than buttons that go
   *  nowhere. */
  onOpenMember?: (m: TeamMember) => void
  /** `agent_id` of the member the pane is showing, so its row reads as current. */
  activeMemberId?: string | null
  /** The team was dismissed — the roster clears its selection. */
  onDismissed?: () => void
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
  activeMemberId,
  onDismissed,
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
        title="Crew"
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
            activeMemberId={activeMemberId}
            onDismissed={onDismissed}
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
        activeMemberId={activeMemberId}
        onDismissed={onDismissed}
        onNavigate={onNavigate}
        initialTab={initialTab}
      />
    </div>
  )
}

export default TeamPanel
