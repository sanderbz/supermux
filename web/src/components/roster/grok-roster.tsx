/**
 * `<GrokRoster>` — WS5 + WS6, the overview reimagined as an inbox of bots.
 * ─────────────────────────────────────────────────────────────────────────────
 * The headline Grok-mode surface. `routes/overview.tsx` mounts this INSTEAD of
 * today's CI-board-of-terminal-cards when the `grok-mode` flag is on (read once
 * at mount, like every other skin flip); off grok it never loads at all — this
 * whole module is a lazy chunk, so the default hero path is byte-for-byte and
 * byte-for-KB unchanged (the overview IS the entry chunk — see
 * `scripts/size-budget.mjs`).
 *
 * The transform (overview.md §0 thesis): stop rendering a session as a *record*
 * (name + model + trash) and render it as a *colleague you can read at a glance*
 * — a face-led two-line messaging row whose second line IS the live transcript
 * tail, grouped Needs-you → Active → Done → Idle by hairline dividers, with a
 * detail pane that leads on the cost/context glance Grok structurally lacks.
 *
 * It keeps supermux's edges, not Grok's flat list: search over every field, the
 * `smart | alpha` sort, the tag chips, the per-agent context ring + token count
 * on a quiet L3, teams as facepile rows, and the needs-you rollup as a header
 * count + a red section. Density (Comfortable = Row A default / Compact = Row C)
 * is the existing density affordance in Grok's idiom, driven by one
 * `data-density` attribute the CSS forks on.
 *
 * Every visual lives in `styles/grok-mode.css` under `[data-grok]`; this file is
 * structure + data only. The marks, their expressions, the needs-you halo and
 * the working-only breathe all come from `<SessionFace>` (WS4) for free.
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react'

import { useSessions } from '@/hooks/use-sessions'
import { useChatRenderer } from '@/components/chat/use-chat-renderer'
import { restSessionInput } from '@/lib/session-input'
import { useLongPress } from '@/hooks/use-long-press'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useScrollAway } from '@/hooks/use-scroll-away'
import { SessionActionsMenu } from '@/components/session-tile/session-actions-menu'
import { isRowMenuKey, requestRowMenu } from '@/components/session-tile/row-menu-bus'
import type { TileSession } from '@/components/session-tile/types'
import { useTeams } from '@/hooks/use-teams'
import { splitTeamLeads } from '@/components/focus-mode/focus-strip-groups'
import { useAttentionContext } from '@/hooks/use-attention'
import { useArchivedSheet } from '@/stores/archived-sheet-store'
import { useNewSessionAction } from '@/stores/new-session-store'
import { NewSessionSheet } from '@/components/session-tile/new-session-sheet'
import { SessionFace } from '@/components/roster/session-face'
import { TeamCrewChip } from '@/components/team/team-crew-chip'
import { SessionMark } from '@/brand/marks'
import { attentionFor, markStateForSession, subagentsClause } from '@/lib/mark-status'
import { smartSort, nameSort } from '@/lib/overview-layout'
import { useArmedConfirm } from '@/hooks/use-armed-confirm'
import { useToast } from '@/components/ui/use-toast'
import { TEAMS_KEY } from '@/hooks/use-teams'
import { displayLabel, type ApiSession } from '@/lib/api'
import {
  needsYouCount,
  taskProgress,
  teamsApi,
  type Team,
  type TeamMember,
} from '@/lib/api/teams'
import {
  groupSessions,
  groupTeamsByTier,
  rosteredTeams,
  totalBotCount,
  type LeadSignal,
} from '@/lib/team-attention'
import { useUI } from '@/stores/ui-store'
import { useCompanies } from '@/hooks/use-companies'
import {
  resolveActiveCompany,
  inCompanyScope,
  companyFirstOrder,
  companiesNeedingAttention,
} from '@/lib/companies'
import { CompanySwitcher } from '@/components/roster/company-switcher'
import { NavBadgeDot } from '@/components/layout'
import { useUpdateBadge } from '@/hooks/use-update-badge'
import { agentHueVars } from '@/lib/grok-agent-hue'
import { characterFromSeed } from '@/brand/marks'
import { useTheme } from '@/components/theme-provider'

// The per-bot settings page. Lazy — it only mounts once a bot is selected (a
// detail pane on desktop), so its section bodies (issues, schedules, git,
// session-actions) never weigh on the roster's first paint.
const BotPanel = React.lazy(() =>
  import('@/components/roster/bot-panel').then((m) => ({ default: m.BotPanel })),
)

// The live conversation thread — the SAME renderer the focus routes mount, reused
// verbatim in the roster's right pane (desktop grok's "thread-in-pane", approach
// (a)). `ThreadPane` wraps it with the in-pane live terminal + the shared
// Chat⇄Terminal switch (Phase 2), self-wiring from `name` alone (its own chat WS
// + peek + REST plane, and the pty only when the terminal is selected). Lazy so
// the roster's first paint never pays for the chat/xterm chunk — it only arrives
// once a chat-eligible bot is opened.
const ThreadPane = React.lazy(() =>
  import('@/components/chat/thread-pane').then((m) => ({ default: m.ThreadPane })),
)

// The per-TEAM page — the crew half of "talk to the lead". Lazy for the same
// reason BotPanel is: a roster with no team open must not pay for it.
const TeamPanel = React.lazy(() =>
  import('@/components/roster/team-panel').then((m) => ({ default: m.TeamPanel })),
)

// ONE TEAMMATE's own surface (Phase 3) — the read-only live pane of the member's
// tmux split, under a grok header. Lazy for the same reason as the two panels
// above: a roster with no member open must not pay for the terminal stack.
const MemberPane = React.lazy(() =>
  import('@/components/roster/member-pane').then((m) => ({ default: m.MemberPane })),
)

/* ── what the right pane is looking at ──────────────────────────────────────
   A roster row is no longer always a session: a TEAM is a row too, and (Phase 3)
   so is one of its members. So the selection is a discriminated union rather
   than a session name — `null` means "nothing open", and every arm carries the
   identity that arm actually has (a team by its `team_name`, a member by the
   `(team, agent_id)` pair that is already its React key; a teammate has no
   `/api/sessions` row to name).
   The `member` arm is Phase 3's — it is declared NOW so Phase 3 is additive
   (a new pane branch), not another refactor of this file. */
type Sel =
  | { kind: 'bot'; name: string }
  | { kind: 'team'; team: string }
  | { kind: 'member'; team: string; agent: string }
  | null

/** The bot-panel's tab keys — mirrors `BotPanelProps['initialTab']` so a deep-link
 *  from the roster can seat a specific tab. */
type BotTab = 'overview' | 'instructions' | 'tools' | 'memory' | 'activity'

/** The pane's SUBJECT as a stable string — what the "reset the pane to the
 *  thread" guard compares across renders (objects never compare equal).
 *
 *  A member deliberately keys to its TEAM: opening a teammate from the crew list
 *  and pressing ESC must land back on the crew list you came from, not on the
 *  lead's thread. Team → member → team is one subject with three faces, so the
 *  pane-view reset does not fire inside it. */
function selKey(sel: Sel): string {
  if (!sel) return ''
  if (sel.kind === 'bot') return `bot:${sel.name}`
  return `team:${sel.team}`
}

/** Coerce the wire shape to the tile's `TileSession` (the panel wants a string
 *  `updated_at`; the API leaves it optional for partial deltas). Same shape
 *  `overview.tsx` uses. */
function toTile(s: ApiSession): TileSession {
  return { ...s, updated_at: s.updated_at ?? '' }
}

/* ── small pure helpers (local; the row is the only caller) ─────────────────── */

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 45) return 'now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.round(hrs / 24)
  if (days === 1) return 'Yesterday'
  return `${days}d`
}

/** The last non-blank line of the roster-wide ANSI-stripped tail — the honest
 *  fallback when no chat store is attached (which is most rows). */
function lastPreviewLine(lines?: readonly string[]): string | undefined {
  if (!lines) return undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (line) return line
  }
  return undefined
}

/** The session's own last word for the preview slot: its chat tail if a store is
 *  live, else the captured pane's last line, else the auto-summary. */
function previewOf(s: ApiSession): string | undefined {
  return (
    s.chat_tail?.agent?.trim() ||
    s.chat_tail?.user?.trim() ||
    lastPreviewLine(s.preview_lines) ||
    s.task_summary?.trim() ||
    undefined
  )
}

function fmtTokens(n?: number): string | undefined {
  if (typeof n !== 'number' || n <= 0) return undefined
  // MEASURED-GAP FIX (format consistency): one column must not mix "21k" with a
  // raw "800". Everything renders in k-notation; sub-1k values become "0.8k"
  // (floored at 0.1k so a live-but-tiny count never reads "0.0k").
  if (n < 1000) return `${Math.max(0.1, n / 1000).toFixed(1)}k`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

/** Context-window occupancy (a 200k reference — the supermux edge Grok lacks).
 *  `tokens` is cumulative, so this is an honest *fill* indicator, not a promise
 *  of exact residency; the ring reads green<50 amber<80 red≥80. */
const CTX_WINDOW = 200_000
function ctxPct(tokens?: number): number | null {
  if (typeof tokens !== 'number' || tokens <= 0) return null
  return Math.min(100, Math.round((tokens / CTX_WINDOW) * 100))
}
function rcClass(pct: number): string {
  return pct < 50 ? 'rc-ok' : pct < 80 ? 'rc-mid' : 'rc-hot'
}

type GroupKey = 'needs' | 'active' | 'done' | 'idle'

interface StateWord {
  word: string
  cls: string
}

/** The coloured state WORD — the firewall's status half, never the agent hue
 *  (overview.md §3 law 3: state is a coloured word + the mark's face). */
function stateWordFor(s: ApiSession, group: GroupKey): StateWord {
  if (group === 'needs') {
    if (s.status === 'error' || s.blocked) return { word: 'blocked', cls: 'st-block' }
    return { word: 'needs you', cls: 'st-need' }
  }
  if (s.status === 'active' || s.status === 'starting') return { word: 'working' + subagentsClause(s.subagents), cls: 'st-work' }
  if (s.status === 'error') return { word: 'blocked', cls: 'st-block' }
  if (s.status === 'stopped') return { word: 'stopped', cls: 'st-idle' }
  // A background workflow still running after the main turn settled: the row is
  // bucketed active by `groupSessions`, so say WORKING (with the parallelism
  // clause when it is available) rather than done/idle.
  if (s.subagents_live) return { word: 'working' + subagentsClause(s.subagents), cls: 'st-work' }
  if (group === 'done') return { word: 'done', cls: 'st-done' }
  return { word: 'idle', cls: 'st-idle' }
}

function matches(s: ApiSession, needle: string): boolean {
  if (!needle) return true
  if (s.name.toLowerCase().includes(needle)) return true
  if (s.display_name?.toLowerCase().includes(needle)) return true
  if (s.task_summary?.toLowerCase().includes(needle)) return true
  if (s.desc?.toLowerCase().includes(needle)) return true
  if (previewOf(s)?.toLowerCase().includes(needle)) return true
  return s.tags?.some((t) => t.toLowerCase().includes(needle)) ?? false
}

/* ── persisted, tiny: the density lane (Comfortable | Compact) ───────────────── */
type Density = 'comfortable' | 'compact'
const DENSITY_KEY = 'supermux:grok-density'
function readDensity(): Density {
  if (typeof localStorage === 'undefined') return 'comfortable'
  const v = localStorage.getItem(DENSITY_KEY)
  // A persisted 'cards' (the retired third option) falls back to 'comfortable'
  // so anyone who had it selected is not left in a stuck, unreachable state.
  return v === 'compact' ? v : 'comfortable'
}

/* ── the row (Row A anatomy; density forks in CSS) ──────────────────────────── */

interface RowProps {
  session: ApiSession
  group: GroupKey
  active: boolean
  onOpen: (s: ApiSession) => void
  index: number
}

export const GrokRow = React.memo(function GrokRow({ session, group, active, onOpen, index }: RowProps) {
  const name = displayLabel(session)
  const time = relativeTime(session.updated_at)
  const sw = stateWordFor(session, group)
  const preview = previewOf(session)
  const provider = session.provider || 'shell'
  const tokens = fmtTokens(session.tokens)
  const pct = ctxPct(session.tokens)
  const tags = session.tags?.slice(0, 2) ?? []

  // PRESS-AND-HOLD → the restored session actions (restart / stop / archive / …).
  // On a coarse pointer a ~480ms hold opens the anchored <SessionActionsMenu>
  // (via the row-menu bus the menu subscribes to by name); a short tap still
  // opens the thread, and a finger drift past the tolerance cancels the hold so
  // a scroll never fires it. On a fine pointer the hold gesture is off (a mouse
  // uses right-click / the hover kebab), so `onClick` opens the thread directly.
  const coarse = useMediaQuery('(pointer: coarse)')
  const longPress = useLongPress({
    onLongPress: () => requestRowMenu(session.name),
    onClick: () => onOpen(session),
    ms: 480,
  })

  return (
    // Split hit target (§2.1): the row is a POSITIONING context, not itself a
    // button — a full-bleed base button opens the thread (the fast, default
    // path), and the NAME is its own button opening the settings panel. Two real
    // sibling buttons (never nested), so the keyboard contract holds: the base
    // button and the name are each a tab stop. `.gr-top`/`.col` are made
    // pointer-transparent in CSS so every non-name click falls through to the
    // base button.
    <div
      className="gr-rowA grok-row-enter"
      data-active={active || undefined}
      style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
      // DESKTOP PARITY: right-click anywhere on the row (name included) opens the
      // same actions menu the touch long-press does. The menu owns the dismiss.
      onContextMenu={(e) => {
        if (requestRowMenu(session.name)) e.preventDefault()
      }}
    >
      <button
        type="button"
        className="gr-row-open"
        // Coarse pointers route the tap through the long-press detector's
        // `onClick` (so a hold opens the menu instead); fine pointers keep the
        // plain click. Never both, or a touch tap would double-fire.
        onClick={coarse ? undefined : () => onOpen(session)}
        {...(coarse ? longPress : null)}
        onKeyDown={(e) => {
          // Shift+F10 / the Menu key — the platform's own "secondary action on
          // the focused row", parity with the classic overview tile.
          if (isRowMenuKey(e) && requestRowMenu(session.name)) {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
        aria-keyshortcuts="Shift+F10"
        aria-label={`Open ${name} — ${sw.word}`}
      />
      {/* The anchored actions menu (restored). Its hover kebab is the desktop
          affordance; on touch it is opened by the long-press above and by
          right-click on desktop, both through the name-keyed row-menu bus. The
          `backdrop` gives it the iOS-context-menu dim; `gr-tile-kebab` positions
          the ⋯ trigger for the grok row (see grok-mode.css). */}
      <SessionActionsMenu
        session={session}
        variant="tile"
        backdrop
        className="gr-tile-kebab"
      />
      <span className="gr-top">
        <SessionFace
          name={session.name}
          status={session.status}
          size={42}
          state={markStateForSession(session, { done: group === 'done' })}
          attention={attentionFor(session)}
          className="gr-mark"
        />
        <span className="col">
          <span className="l1">
            {/* Inert text: the name is NOT its own click target. A tap on it
                falls through the pointer-transparent `.col` to the full-bleed
                `gr-row-open` base button and opens the thread. Settings stay
                reachable via the ⋯ actions menu / long-press / right-click. */}
            <span className="nm">{name}</span>
            {/* compact-only inline preview (Row C) */}
            <span className="cprev">{preview}</span>
            {time && <span className="tm">{time}</span>}
          </span>
          <span className="l2">
            <span className="pv">
              <span className={`st ${sw.cls}`}>{sw.word}</span>
              {preview ? <> · {preview}</> : null}
            </span>
            {tokens && <span className="cost">{tokens}</span>}
          </span>
          <span className="l3">
            <span className="prov">
              <span className="pd" />
              {provider}
            </span>
            {pct !== null && (
              <>
                <span
                  className={`ring ${rcClass(pct)}`}
                  style={{ '--p': pct } as React.CSSProperties}
                />
                <span className="ctx">{pct}% ctx</span>
              </>
            )}
            {tags.map((t) => (
              <span key={t} className="tag">
                #{t}
              </span>
            ))}
          </span>
        </span>
      </span>
    </div>
  )
})

/* ── the TEAM ROW's overflow menu (Phase 4b) ──────────────────────────────────
   The management verbs a team owns, reachable WITHOUT leaving grok: dismiss the
   team (destructive, armed-confirm) and the honest terminal escape hatch.
   The ROW STAYS ONE BUTTON — a nested button is invalid HTML and breaks the
   roster's keyboard contract — so the kebab is an absolutely-positioned SIBLING
   inside `.gr-rowwrap`, revealed on hover/focus. */
function TeamRowMenu({
  team,
  onOpenTerminal,
}: {
  team: Team
  onOpenTerminal?: (lead: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef<HTMLSpanElement>(null)
  const qc = useQueryClient()
  const { toast } = useToast()
  const [pending, setPending] = React.useState(false)

  const dismiss = React.useCallback(() => {
    setPending(true)
    void teamsApi
      .dismiss(team.team_name)
      .then(() => {
        // Drop it from the shared cache at once; both reconcilers (the SSE
        // snapshot and a reload GET) already exclude an archived dir.
        qc.setQueryData<Team[]>(TEAMS_KEY, (prev) =>
          (prev ?? []).filter((t) => t.team_name !== team.team_name),
        )
        toast({ message: `Dismissed ${team.team_name}` })
      })
      .catch(() => toast({ message: `Couldn't dismiss ${team.team_name}`, tone: 'error' }))
      .finally(() => {
        setPending(false)
        setOpen(false)
      })
  }, [qc, toast, team.team_name])
  const confirming = useArmedConfirm({ onConfirm: dismiss })

  // Close on an outside press or ESC — a menu that outlives its context is a
  // menu that fires on the wrong row.
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false)
        confirming.cancel()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        confirming.cancel()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, confirming])

  const lead = team.lead_supermux_session

  // Every visual below is the SHARED Tailwind/shadcn vocabulary the panels
  // already use — deliberately not a new `[data-grok]` rule, because the CSS
  // budget (31 KB gz) has ~0.2 KB of headroom and a menu is not worth it.
  const item =
    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

  return (
    <span ref={wrapRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${team.team_name}`}
        title="Team actions"
        data-vr="team-row-more"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className={`absolute right-3 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100${
          open ? ' opacity-100' : ''
        }`}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          data-vr="team-row-menu"
          className="absolute right-3 top-full z-30 -mt-2 flex min-w-48 flex-col gap-0.5 rounded-xl border border-border bg-popover p-1.5 shadow-lg"
        >
          {lead && onOpenTerminal && (
            <button
              type="button"
              role="menuitem"
              className={`${item} text-foreground`}
              onClick={() => {
                setOpen(false)
                onOpenTerminal(lead)
              }}
            >
              <Terminal size={15} aria-hidden />
              Open the lead's terminal
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            data-vr="team-row-dismiss"
            className={`${item} text-destructive`}
            onClick={() => confirming.press()}
          >
            <Trash2 size={15} aria-hidden />
            {confirming.armed ? `Confirm — dismiss ${team.team_name}` : 'Dismiss team'}
          </button>
          {confirming.armed && (
            <p className="px-3 pb-1.5 pt-1 text-[11.5px] leading-snug text-muted-foreground">
              Stops surfacing this crew. Claude's own roster on disk is untouched.
            </p>
          )}
        </div>
      )}
    </span>
  )
}

/* ── team facepile row (a team is just another row — 3 member marks) ─────────── */

export function TeamRow({
  team,
  onOpen,
  index,
  active,
  onOpenTerminal,
  withMenu,
}: {
  team: Team
  onOpen: (t: Team) => void
  index: number
  /** This team is the one open in the right pane — the same `data-active`
   *  highlight a selected bot row wears (a team is just another row). */
  active?: boolean
  /** The kebab's terminal escape hatch (→ `/focus/<lead>`). */
  onOpenTerminal?: (lead: string) => void
  /** Render the `⋯` overflow menu beside the row (Phase 4b). Off by default so
   *  the `/dev/roster` bench keeps rendering a bare row. */
  withMenu?: boolean
}) {
  // NEVER render a rosterless row (6b) — belt-and-braces with the server's own
  // `drop_rosterless` (watcher.rs). A team with no crew has no facepile to make
  // it legible and nothing to open a member from, and `team-attention.ts` keeps
  // it out of the counts too, so the header can't count a row nobody sees.
  if (team.members.length === 0) return null

  const members = team.members.slice(0, 3)
  // The count of crew NOT shown in the pile — the "+N" fourth slot (6b).
  const overflow = team.members.length - members.length
  const memberWord = team.members.length === 1 ? 'bot' : 'bots'
  // Reuse the two team roll-up helpers rather than re-deriving them here, for
  // parity with the bot row's L2 state-word + L3 muted glance (teams.ts owns the
  // definitions; the team card reads the same two).
  const needs = needsYouCount(team)
  const progress = taskProgress(team)
  const last =
    team.members.find((m) => m.status === 'needs_you')?.name ??
    team.members[0]?.name ??
    ''
  const row = (
    <button
      type="button"
      className="gr-rowA grok-row-enter"
      data-active={active || undefined}
      style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
      onClick={() => onOpen(team)}
      aria-label={`${team.team_name} — ${team.members.length} ${memberWord}`}
    >
      <span className="gr-top">
        <span className="gr-pile gr-mark" aria-hidden>
          {members.map((m, i) => (
            <SessionMark
              key={m.agent_id}
              seed={m.name}
              size={24}
              animate={false}
              className={`p${i}`}
              ring="var(--gr-bg)"
              label={null}
              // The pile shows the crew's live attention, not idle placeholders
              // (audit #4): a member that needs you wears the red halo here too.
              attention={m.status === 'needs_you' ? 'needs' : null}
            />
          ))}
          {/* The fourth pile slot: "+N" for a crew bigger than the pile (6b),
              positioned off the same `.p3` token the marks sit on. */}
          {overflow > 0 && <span className="p3 gr-pile-more">+{overflow}</span>}
        </span>
        <span className="col">
          <span className="l1">
            <span className="nm">{team.team_name}</span>
          </span>
          <span className="l2">
            <span className="pv">
              <span className={`st ${needs > 0 ? 'st-need' : 'st-work'}`}>
                {needs > 0 ? `${needs} need you` : 'active'}
              </span>
              {last ? <> · {last}</> : null}
            </span>
            {/* Tasks done/total on the right, where a bot row shows its token
                cost — the team's own glanceable metric (`taskProgress`). */}
            {progress.total > 0 && (
              <span className="cost">
                {progress.done}/{progress.total} tasks
              </span>
            )}
          </span>
          <span className="l3">
            <span className="prov">
              <span className="pd" />
              {team.members.length} {memberWord}
            </span>
          </span>
        </span>
      </span>
    </button>
  )
  if (!withMenu) return row
  // A positioning + hover context ONLY (`group` drives the kebab's reveal) — the
  // row keeps its own hover, selection and focus visuals, and the kebab sits
  // over it as a SIBLING, never nested inside the row button.
  return (
    <div className="group relative">
      {row}
      <TeamRowMenu team={team} onOpenTerminal={onOpenTerminal} />
    </div>
  )
}

/* ── the roster ─────────────────────────────────────────────────────────────── */

export default function GrokRoster() {
  const navigate = useNavigate()
  // The update-available tell, re-homed onto the top-right avatar (the grok
  // Settings doorway) now that the Settings nav item — its former host — is
  // hidden under grok.
  const { state: updateBadge } = useUpdateBadge()
  const { sessions: allSessions } = useSessions()
  const { teams } = useTeams()
  const attention = useAttentionContext()
  const openArchived = useArchivedSheet((s) => s.openSheet)
  const setNewSessionAction = useNewSessionAction((s) => s.setAction)

  const sessions = React.useMemo(
    () => splitTeamLeads(allSessions, teams).nonLeadSessions,
    [allSessions, teams],
  )

  // ── Companies (Bot Mode) — the active company scope the whole rail reads ──────
  const { resolvedTheme } = useTheme()
  const { companies } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const setActiveCompany = useUI((s) => s.setActiveCompany)
  // Reconcile a stale persisted `activeCompany` against the live set: an id that
  // no longer maps to a company (deleted/archived, or a localStorage value from
  // another install) falls back to HQ. Runs as an effect off the live ids, never
  // in render (pure guard is `resolveActiveCompany`, unit-tested).
  React.useEffect(() => {
    if (activeCompany === null) return
    const resolved = resolveActiveCompany(
      activeCompany,
      companies.map((c) => c.id),
    )
    if (resolved !== activeCompany) setActiveCompany(resolved)
  }, [activeCompany, companies, setActiveCompany])
  // The active company's slug → its identity hue → the `--sm-agent-*` write on
  // the RAIL only (so it never overrides the chat pane's per-session hue). HQ
  // writes nothing → a byte-identically neutral rail (the firewall's tell).
  const activeCompanyRow = companies.find((c) => c.id === activeCompany) ?? null
  const railHueStyle = React.useMemo<React.CSSProperties>(
    () =>
      activeCompanyRow
        ? agentHueVars(
            characterFromSeed(activeCompanyRow.slug).hue,
            resolvedTheme === 'dark',
          )
        : {},
    [activeCompanyRow, resolvedTheme],
  )

  const [rawQuery, setRawQuery] = React.useState('')
  const [sort, setSort] = React.useState<'smart' | 'alpha'>('smart')
  const [density, setDensity] = React.useState<Density>(readDensity)
  const [selected, setSelected] = React.useState<Sel>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  // Which face the right pane wears for the OPEN bot: the live conversation
  // ('thread', the default) or the per-bot settings page ('settings'). It resets
  // to 'thread' whenever the selection changes (the render-phase guard below) so
  // opening a new colleague always lands on their conversation, never on the last
  // bot's settings tab.
  const [paneView, setPaneView] = React.useState<'thread' | 'settings'>('thread')
  // Which tab the settings pane opens on — Overview by default; a deep-link
  // (e.g. a "manage tools" entry) seats 'tools' before flipping the view (§2.1).
  const [paneTab, setPaneTab] = React.useState<BotTab>('overview')

  // Install the "New bot" verb for the command palette while this roster is
  // mounted; clear on unmount (parity with the New-group channel). The palette
  // fires it from outside the route to open the same New Session sheet.
  React.useEffect(() => {
    setNewSessionAction(() => setSheetOpen(true))
    return () => setNewSessionAction(null)
  }, [setNewSessionAction])

  const setDensityPersist = React.useCallback((d: Density) => {
    setDensity(d)
    try {
      localStorage.setItem(DENSITY_KEY, d)
    } catch {
      /* private mode — the lane just won't persist */
    }
  }, [])

  const needle = rawQuery.trim().toLowerCase()
  // A non-empty search LIFTS the company browse-scope: search stays GLOBAL (you
  // can always find a bot in another company), and `companyFirstOrder` floats the
  // active-space matches to the top instead of hiding the rest.
  const hasQuery = needle.length > 0

  const filtered = React.useMemo(
    () =>
      sessions.filter(
        (s) =>
          matches(s, needle) &&
          (hasQuery || inCompanyScope(s.company_id, activeCompany)),
      ),
    [sessions, needle, hasQuery, activeCompany],
  )
  // Team scope follows the LEAD's company (a team is its lead's crew). Build a
  // name→company_id map off the UNSPLIT roster (the lead is pulled out of
  // `sessions`), then keep a team only if its lead is in scope — mirroring the
  // session predicate. Search lifts it exactly as it lifts the session scope.
  const companyByName = React.useMemo(() => {
    const m = new Map<string, number | null>()
    for (const s of allSessions) m.set(s.name, s.company_id ?? null)
    return m
  }, [allSessions])
  const filteredTeams = React.useMemo(() => {
    const bySearch = !needle
      ? teams
      : teams.filter(
          (t) =>
            t.team_name.toLowerCase().includes(needle) ||
            t.members.some((m) => m.name.toLowerCase().includes(needle)),
        )
    if (hasQuery) return bySearch
    return bySearch.filter((t) =>
      inCompanyScope(
        companyByName.get(t.lead_supermux_session ?? '') ?? null,
        activeCompany,
      ),
    )
  }, [teams, needle, hasQuery, activeCompany, companyByName])

  const sorted = React.useMemo(() => {
    const base = sort === 'alpha' ? nameSort(filtered) : smartSort(filtered)
    // GLOBAL search: keep every match visible but float the active-space rows to
    // the top (space-first ranking). No search: the list is already scoped.
    return hasQuery ? companyFirstOrder(base, activeCompany) : base
  }, [filtered, sort, hasQuery, activeCompany])

  // Group into the four attention-ordered sections (overview.md §6). The `needs`
  // set comes from the app-wide provider's PRECOMPUTED rollup — the same list the
  // header count and the red section read, so they can never disagree — rather
  // than calling `attentionFor` per row in render (which would read `Date.now()`
  // mid-render: an impurity the linter rightly flags, and the reason the rollup
  // is memoised in the provider in the first place).
  const needNames = React.useMemo(
    () => new Set(attention.needs.map((s) => s.name)),
    [attention.needs],
  )
  const groups = React.useMemo(() => groupSessions(sorted, needNames), [sorted, needNames])

  // Per-company attention for the switcher's need-you dots — the cross-company
  // awareness the scoped census (above) intentionally drops. Computed from the
  // FULL, UNFILTERED roster (`allSessions`, so scope/search never hide a signal)
  // and REUSING the roster's own needs-you predicate (`needNames` — the same
  // app-wide rollup the NEEDS YOU section and header count read), so there is
  // exactly ONE definition of "needs you". `null` in the set = HQ needs you.
  const companyAttention = React.useMemo(
    () => companiesNeedingAttention(allSessions, (name) => needNames.has(name)),
    [allSessions, needNames],
  )

  // OD-2 = FOLD: a team is no longer a leading divider — it sorts into the SAME
  // four sections as a bot, by its own derived attention (`team-attention.ts`).
  // Each team's lead contributes two bits (does the lead itself need you / is it
  // active), read off the unsplit roster + the same `needNames` rollup.
  const teamGroups = React.useMemo(
    () =>
      groupTeamsByTier(filteredTeams, (t): LeadSignal | null => {
        const leadName = t.lead_supermux_session
        if (!leadName) return null
        const lead = allSessions.find((s) => s.name === leadName)
        if (!lead) return null
        return {
          needs: needNames.has(lead.name),
          active: lead.status === 'active' || lead.status === 'starting',
        }
      }),
    [filteredTeams, allSessions, needNames],
  )

  // The header's need count is the SUM over the rendered rows — bots in the needs
  // section PLUS teams in the needs section — so the header can never disagree
  // with what the sections show (the property the old two-ordering split
  // violated: R7/R8).
  const needCount = groups.needs.length + teamGroups.needs.length
  // The VISIBLE list is empty when neither a (rostered) team nor any session
  // survives the current filter — the honest trigger for the empty state (jury
  // d). `totalBots` counts the UNFILTERED roster, so it cannot answer "did this
  // search find nothing".
  const listEmpty =
    sorted.length === 0 && !filteredTeams.some((t) => t.members.length > 0)

  // Keep the selection valid by DERIVATION, not by an effect: a session that
  // left the list (archived, deleted, filtered out) resolves to `null` here, so
  // the detail pane closes on its own and the stale name is simply overwritten
  // by the next click — no setState-in-effect, no cascading render.
  const selectedSession = React.useMemo(
    () =>
      selected?.kind === 'bot' ? sessions.find((s) => s.name === selected.name) ?? null : null,
    [selected, sessions],
  )
  // A team resolves the same way — by derivation, so a team that vanished from
  // the SSE snapshot closes its own pane instead of stranding it.
  const selectedTeam = React.useMemo(
    () =>
      selected && selected.kind !== 'bot'
        ? teams.find((t) => t.team_name === selected.team) ?? null
        : null,
    [selected, teams],
  )
  // The lead's own row is NOT in `sessions` — `splitTeamLeads` pulls leads out
  // so a lead never renders twice — so resolve it against the unsplit roster.
  const leadName = selectedTeam?.lead_supermux_session ?? null
  const leadRow = React.useMemo(
    () => (leadName ? allSessions.find((s) => s.name === leadName) ?? null : null),
    [allSessions, leadName],
  )
  // A MEMBER resolves by derivation too, off the SAME live team object — a
  // teammate that left the roster (removed, or its team vanished) closes its own
  // pane instead of stranding it. `(team_name, agent_id)` is the pair a teammate
  // actually has: there is no `/api/sessions` row to name it by.
  const selectedMember = React.useMemo<TeamMember | null>(
    () =>
      selected?.kind === 'member' && selectedTeam
        ? selectedTeam.members.find((m) => m.agent_id === selected.agent) ?? null
        : null,
    [selected, selectedTeam],
  )

  // Reset the pane to the thread whenever the SELECTION changes — React's
  // "adjust state while rendering" pattern (a previous-value in state, not an
  // effect): React re-renders immediately with the corrected value and no
  // cascading commit. Re-clicking the SAME row is handled in `openSession`.
  const selectionKey = selKey(selected)
  const [paneSelSeen, setPaneSelSeen] = React.useState(selectionKey)
  if (paneSelSeen !== selectionKey) {
    setPaneSelSeen(selectionKey)
    if (paneView !== 'thread') setPaneView('thread')
  }

  // ONE thread target for the pane: the selected bot, or — for a team — its
  // LEAD (OD-1 = A, "talk to the lead": the lead's conversation IS the team's
  // thread, and its crew is legible in the panel beside it).
  const threadRow = selectedTeam ? leadRow : selectedSession
  const threadName = threadRow?.name ?? null
  // The one hard constraint on thread-in-pane: chat eligibility. `useChatRenderer`
  // is the SAME three-gate decision the focus seam uses (bot mode on + kill-switch
  // + local Claude). A bot that fails it — Codex, shell, a remote host — cannot be
  // a chat surface, so the pane falls back to its settings page with an honest
  // "Open terminal →" escape to /focus (Phase 1). A TEAM LEAD is no longer among
  // the refusals (Phase 2a): it is a first-class bot.
  const threadEligible = useChatRenderer(threadRow)
  // The panel's write plane, memoised by name so a roster re-render (the seconds
  // ticker, a sibling row's delta) doesn't hand the chat hooks a fresh input
  // object every frame. `ChatPanel` opens its own chat WS + peek from `name`; this
  // is only the RAW `/send`·`/paste`·`/keys` plane, exactly what the focus route
  // hands it (desktop-split.tsx).
  const threadInput = React.useMemo(
    () => (threadName ? restSessionInput(threadName) : null),
    [threadName],
  )

  // Mask-fade the list edges by whether it is scrolled (no shadows on glass).
  const listRef = React.useRef<HTMLDivElement>(null)
  const [fade, setFade] = React.useState({ top: false, bottom: false })
  const onScroll = React.useCallback(() => {
    const el = listRef.current
    if (!el) return
    const top = el.scrollTop > 4
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4
    setFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
  }, [])
  React.useEffect(() => {
    onScroll()
  }, [onScroll, sorted, density])

  // ── Scroll-away header (the iOS "chrome that slides out of the way") ─────────
  // The header overlays the top of the list (absolute in CSS); the list content
  // carries the clearance so hiding leaves NO gap — the rows fill straight to the
  // top once the header slides off. We measure the header's live height into
  // `--gr-head-h` (it wraps to ~3 bands on a phone, one bar on desktop) so both
  // the clearance and the "always shown near the top" anchor track it exactly.
  const headRef = React.useRef<HTMLElement>(null)
  const [headH, setHeadH] = React.useState(0)
  React.useEffect(() => {
    const el = headRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setHeadH(el.offsetHeight))
    ro.observe(el)
    setHeadH(el.offsetHeight)
    return () => ro.disconnect()
  }, [])
  // Phone-only affordance: the desktop two-pane keeps its static header (a
  // scroll-away over the rail would strand the fixed detail pane), matching the
  // CSS, which scopes the overlay + transform to `(max-width: 767px)`.
  const isPhone = useMediaQuery('(max-width: 767px)')
  const {
    hidden: headHiddenRaw,
    onScroll: onScrollAway,
    reveal: revealHead,
  } = useScrollAway(listRef, {
    downThreshold: 10,
    upThreshold: 6,
    topReveal: Math.max(56, headH),
    disabled: !isPhone,
  })
  // Focusing or typing in the search field pins the chrome shown — the header
  // must never slide away from under an input the user is using.
  const [searchFocused, setSearchFocused] = React.useState(false)
  const headHidden = headHiddenRaw && !searchFocused
  // ONE scroll signal drives both the edge-fade mask and the scroll-away.
  const handleListScroll = React.useCallback(() => {
    onScroll()
    onScrollAway()
  }, [onScroll, onScrollAway])

  const openSession = React.useCallback(
    (s: ApiSession) => {
      attention.markRead(s)
      // Desktop shows the detail pane; phone has none, so tap → thread.
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
        navigate(`/focus/${encodeURIComponent(s.name)}`)
        return
      }
      setSelected({ kind: 'bot', name: s.name })
      // Re-opening the row you are already ON keeps `selected` unchanged, so the
      // render-phase reset never fires — flip back to the thread here too, so a
      // click always returns to the conversation.
      setPaneView('thread')
    },
    [attention, navigate],
  )
  // A TEAM STAYS IN THE ROSTER on desktop (build spec §2b): selecting it swaps the
  // right pane in place — the lead's live thread, with the crew one toggle away —
  // so opening a team never changes the URL. PHONE has no pane, so it routes to
  // the dedicated `/team/<team>` detail surface (Phase 6a) — the same composition
  // as this pane, full-screen — instead of the old /focus hop to the lead.
  const openTeam = React.useCallback(
    (t: Team) => {
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
        navigate(`/team/${encodeURIComponent(t.team_name)}`)
        return
      }
      setSelected({ kind: 'team', team: t.team_name })
      setPaneView('thread')
    },
    [navigate],
  )
  // A TEAMMATE IS A FIRST-CLASS ENTITY (Phase 3, R3). It is addressed by the
  // `(team_name, agent_id)` pair — its React key — and opening it swaps the same
  // right pane, so team → member is two clicks and never leaves grok. The click
  // target is TeamPanel Overview's crew list (the row above stays ONE button).
  const openMember = React.useCallback(
    (t: Team, m: TeamMember) => {
      setSelected({ kind: 'member', team: t.team_name, agent: m.agent_id })
    },
    [],
  )
  // ESC / the pane's back chevron — return to the team the member belongs to.
  // `paneView` is untouched on purpose: a member keys to its team (see `selKey`),
  // so the pane comes back to the crew list the member was opened from.
  const backToTeam = React.useCallback(() => {
    setSelected((prev) =>
      prev?.kind === 'member' ? { kind: 'team', team: prev.team } : prev,
    )
  }, [])
  // A dismissed team has no pane left to show.
  const clearSelection = React.useCallback(() => setSelected(null), [])
  // DESKTOP: the pane swaps in place — no /focus hop, no second shell. The rail
  // keeps its scroll, its selection highlight and its entry animations (the Grok
  // inbox feel). BotPanel's "Open thread" and the thread's own settings toggle
  // both flow through `setPaneView`.
  const openThread = React.useCallback(() => setPaneView('thread'), [])
  // In-pane settings toggle (the thread header's SlidersHorizontal + the crew
  // chip). Always lands on Overview — the deep-link tab is a separate entry.
  const openSettings = React.useCallback(() => {
    setPaneTab('overview')
    setPaneView('settings')
  }, [])
  // The terminal escape hatch + the ineligible-bot fallback: honestly LEAVE the
  // roster for the still-present /focus route, which owns the live terminal (and
  // its keyboard capture). Phase 1 does not reproduce the terminal in the pane.
  const openInFocus = React.useCallback(() => {
    if (threadName) navigate(`/focus/${encodeURIComponent(threadName)}`)
  }, [navigate, threadName])

  // "N bots" counts every standalone session PLUS each rostered team's members
  // and its (mapped) lead — the honest fleet HEADCOUNT (a crew of 3 is one row
  // but three bots), not a row count. A rosterless team contributes nothing (it
  // renders nowhere).
  //
  // SCOPED to the active company: it counts the SAME sets that feed the visible
  // sections — `filtered` (scoped standalone bots) + `filteredTeams` (teams whose
  // lead is in scope) — so the census can never disagree with the NEEDS YOU /
  // ACTIVE / DONE headers below. HQ (`activeCompany === null`) counts only
  // null-company bots; a company counts only its own. A non-empty search LIFTS
  // the scope exactly as it does for the sections (`filtered`/`filteredTeams` are
  // search-aware), so the two stay in lockstep while searching too. All-HQ (no
  // companies) ⇒ `filtered` is every session and `filteredTeams` every team, so
  // this is byte-identical to the old unfiltered census — behaviour-neutral.
  const totalBots = totalBotCount(filtered.length, filteredTeams)
  // The crew census the folded roster no longer says with a divider (OD-2) —
  // scoped to the crews whose lead is in the active company.
  const crewCount = rosteredTeams(filteredTeams).length
  const hasDetail = !!selectedSession || !!selectedTeam

  const SECTIONS: { key: GroupKey; label: string }[] = [
    { key: 'needs', label: 'Needs you' },
    { key: 'active', label: 'Active' },
    { key: 'done', label: 'Done today' },
    { key: 'idle', label: 'Idle' },
  ]

  let rowIndex = 0

  return (
    <div
      className="grok-roster"
      data-detail={hasDetail ? '1' : '0'}
      data-density={density}
      data-head-hidden={headHidden ? '' : undefined}
      style={headH ? ({ '--gr-head-h': `${headH}px` } as React.CSSProperties) : undefined}
    >
      <header className="gr-head" ref={headRef}>
        {/* The HQ/company scope chip is the overview TITLE — the leftmost
            identity. The old `.gr-brand` wordmark (a rainbow spark tile + the
            literal "supermux") was dropped: the switcher already renders the
            active scope's name (`active.display_name` or "HQ") next to its mark,
            so the active TEAM name leads instead of a static wordmark. HQ now
            shows the real blue-S brand `<Logo>` (via `<HqMark>`), not the
            invented spark. */}
        <CompanySwitcher attention={companyAttention} />
        <span className="gr-count">
          {totalBots} {totalBots === 1 ? 'bot' : 'bots'}
          {crewCount > 0 && ` · ${crewCount} ${crewCount === 1 ? 'crew' : 'crews'}`}
          {needCount > 0 && (
            <>
              {' · '}
              <b>{needCount} need you</b>
            </>
          )}
        </span>

        {/* The create verb — a LABELLED accent-filled primary pill, left-anchored
            next to the count so the next action reads as an action, not a lone
            glyph. The label folds away below `sm` (the 44×44 phone hitbox rule in
            CSS keeps the tap target). */}
        <button
          type="button"
          className="gr-newbot"
          aria-label="New bot"
          data-tour="new-session"
          onClick={() => setSheetOpen(true)}
        >
          <Plus size={16} aria-hidden />
          <span className="gr-newbot-lbl">New bot</span>
        </button>

        <span className="gr-head-sp" />

        <span className="gr-search">
          <Search aria-hidden />
          <input
            type="search"
            value={rawQuery}
            onChange={(e) => {
              setRawQuery(e.target.value)
              revealHead()
            }}
            onFocus={() => {
              setSearchFocused(true)
              revealHead()
            }}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search bots, tags, last lines…"
            aria-label="Search bots, tags and last lines"
          />
        </span>

        <span className="gr-seg" role="group" aria-label="Sort">
          <button
            type="button"
            aria-pressed={sort === 'smart'}
            onClick={() => setSort('smart')}
          >
            Smart
          </button>
          <button
            type="button"
            aria-pressed={sort === 'alpha'}
            onClick={() => setSort('alpha')}
          >
            A–Z
          </button>
        </span>

        <span className="gr-seg" role="group" aria-label="Density">
          <button
            type="button"
            aria-pressed={density === 'comfortable'}
            onClick={() => setDensityPersist('comfortable')}
            title="Comfortable — inbox rows"
          >
            Comfortable
          </button>
          <button
            type="button"
            aria-pressed={density === 'compact'}
            onClick={() => setDensityPersist('compact')}
            title="Compact — dense feed"
          >
            Compact
          </button>
        </span>

        {/* Trailing utility cluster — the overview's footer strip is gone (owner
            feedback: redundant), so the two things it carried that still have a
            home live HERE, in the title bar. ARCHIVE moved up as a clean ghost
            icon button (its duplicate settings gear was dropped — Settings already
            lives in the floating nav). The SB avatar is the account affordance,
            top-right per the modern app-bar pattern: a tap opens Settings. */}
        <span className="gr-head-actions">
          <button
            type="button"
            className="gr-icon-btn"
            aria-label="Archived sessions"
            onClick={openArchived}
            title="Archived sessions"
          >
            <Archive size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="gr-me"
            aria-label={
              updateBadge !== 'none'
                ? 'Sander — settings (update available)'
                : 'Sander — settings'
            }
            title="Settings"
            onClick={() => navigate('/settings')}
          >
            <span className="av" aria-hidden>
              SB
            </span>
            {/* Re-homed update-available dot. It used to hang off the Settings
                nav item, which grok drops (`grokHidden`); the avatar is the grok
                Settings doorway, so the "update available" tell rides here now.
                Absolutely pinned to the avatar's top-right corner. */}
            <span className="pointer-events-none absolute -right-0.5 -top-0.5">
              <NavBadgeDot state={updateBadge} />
            </span>
          </button>
        </span>
      </header>

      <div className="gr-two">
        <div
          className="gr-rail"
          data-solo={hasDetail ? undefined : ''}
          data-company={activeCompanyRow ? '' : undefined}
          style={railHueStyle}
        >
          <div
            className="gr-list"
            ref={listRef}
            onScroll={handleListScroll}
            data-fade-top={fade.top ? '' : undefined}
            data-fade-bottom={fade.bottom ? '' : undefined}
          >
            {/* Persistent HIRE affordance — a ghost row pinned above the first
                section. Dashed hairline + placeholder mark, always inviting the
                next hire (not just the zero-bots hint). Hidden while searching
                (it is a create verb, not a result) and, via CSS, in the compact
                feed density. ALSO hidden when the list is EMPTY: the zero-bots
                empty state below already carries its own primary "New bot" CTA,
                and showing both left TWO create CTAs competing on one screen
                (sweep 4a). One primary — the centred empty-state verb when there
                are no bots, this persistent ghost once bots exist. */}
            {!needle && !listEmpty && (
              <button
                type="button"
                className="gr-ghost grok-row-enter"
                aria-label="Hire a new bot"
                onClick={() => setSheetOpen(true)}
              >
                <span className="gr-ghost-mark" aria-hidden>
                  <Plus size={18} aria-hidden />
                </span>
                <span className="gr-ghost-col">
                  <span className="gr-ghost-t">Hire a new bot</span>
                  <span className="gr-ghost-s">Give it a name and a job.</span>
                </span>
              </button>
            )}

            {/* No "Hire a crew" create verb: Claude starts a team itself when a
                job needs one — teams are not created from the interface. An
                auto-created team still renders as a row here and is dismissable;
                only the create-a-team affordance is gone. */}

            {/* OD-2 = FOLD: no leading `Teams` divider. Each section renders its
                team rows first (a crew is the heavier row) and then its bot rows,
                and its count is the SUM of both — so a needs-you crew sits in the
                red `Needs you` section like any other needs-you row, and the
                header's count matches what the sections show. */}
            {SECTIONS.map(({ key, label }) => {
              const items = groups[key]
              const teamItems = teamGroups[key]
              if (items.length === 0 && teamItems.length === 0) return null
              return (
                <React.Fragment key={key}>
                  <div className="gr-grp" data-need={key === 'needs' ? '' : undefined}>
                    <span className="lbl">{label}</span>
                    <span className="ct">{items.length + teamItems.length}</span>
                    <span className="ln" />
                  </div>
                  {teamItems.map((t) => (
                    <TeamRow
                      key={t.team_name}
                      team={t}
                      onOpen={openTeam}
                      index={rowIndex++}
                      active={selectedTeam?.team_name === t.team_name}
                      withMenu
                      onOpenTerminal={(lead) => navigate(`/focus/${encodeURIComponent(lead)}`)}
                    />
                  ))}
                  {items.map((s) => (
                    <GrokRow
                      key={s.name}
                      session={s}
                      group={key}
                      active={selected?.kind === 'bot' && selected.name === s.name}
                      onOpen={openSession}
                      index={rowIndex++}
                    />
                  ))}
                </React.Fragment>
              )
            })}

            {/* MEASURED-GAP FIX (jury d): the empty message was gated on
                `totalBots === 0`, so a search that matched NOTHING left the rail
                blank (13 bots exist, 0 shown → the message never rendered). Gate
                on the VISIBLE list being empty instead, so "No bots match …"
                actually appears. The message is the primary thing on screen, so
                it reads at primary weight/colour (not the muted floor) and — for
                the zero-bots case — pairs with the inline create verb, all
                vertically centred to match the right pane's hint. */}
            {listEmpty && (
              <div className="gr-list-empty">
                {needle ? (
                  <p className="gr-empty-msg">
                    No bots match “{rawQuery.trim()}”.
                  </p>
                ) : (
                  <>
                    <p className="gr-empty-msg">No bots yet — hire your first one.</p>
                    <button
                      type="button"
                      className="gr-newbot"
                      aria-label="New bot"
                      onClick={() => setSheetOpen(true)}
                    >
                      <Plus size={16} aria-hidden />
                      <span className="gr-newbot-lbl">New bot</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {selectedTeam && selectedMember ? (
          // A TEAMMATE, IN THE SAME PANE (Phase 3). Read-only by construction —
          // the teammate WS drops input — and the pane says so with a pill, not
          // with a composer that cannot be typed into.
          <React.Suspense
            fallback={<div className="gr-pane" data-shell-pane aria-hidden />}
          >
            <MemberPane team={selectedTeam} member={selectedMember} onBack={backToTeam} />
          </React.Suspense>
        ) : selectedTeam ? (
          // A TEAM, IN PLACE. Same contract as a bot, one level up: the pane's
          // 'thread' face is the LEAD's real conversation (OD-1 = A) and its
          // other face is the crew. A team whose lead isn't mapped this tick has
          // no thread at all, so it opens straight on TeamPanel, which says so.
          paneView === 'thread' && threadEligible && threadRow ? (
            <React.Suspense
              fallback={<div className="gr-pane gr-threadpane" data-shell-pane aria-hidden />}
            >
              <ThreadPane
                name={threadRow.name}
                session={toTile(threadRow)}
                chatOn={threadEligible}
                input={threadInput ?? undefined}
                // THE CREW SIGNAL (jury R1 TEAM_THREAD fix). The bare people
                // icon read as "one bot"; the crew chip carries the teammates'
                // faces with their live status, an `N bots` count and a
                // needs/working glance, so the lead's thread and its crew read
                // as ONE surface. Same tap target as before — it opens
                // TeamPanel (the `pane-team-toggle` VR the roster e2e drives).
                headerTrailing={
                  <TeamCrewChip team={selectedTeam} onOpen={openSettings} vr="pane-team-toggle" />
                }
              />
            </React.Suspense>
          ) : (
            <React.Suspense fallback={<div className="gr-pane" data-shell-pane aria-hidden />}>
              <TeamPanel
                variant="pane"
                team={selectedTeam}
                onOpenThread={openThread}
                onOpenMember={(m) => openMember(selectedTeam, m)}
                onDismissed={clearSelection}
                onNavigate={(n) => navigate(`/focus/${encodeURIComponent(n)}`)}
              />
            </React.Suspense>
          )
        ) : selectedSession ? (
          paneView === 'thread' && threadEligible ? (
            // THE LIVE THREAD in the right pane — the reused chat renderer, one
            // shell, one composer, no route change. The settings page is one tap
            // away via the header-pill toggle we inject here; the terminal is now
            // an IN-PANE renderer (Phase 2, `ThreadPane`) reached by the same
            // Chat⇄Terminal switch the mobile seam uses — no /focus escape.
            <React.Suspense
              fallback={<div className="gr-pane gr-threadpane" data-shell-pane aria-hidden />}
            >
              <ThreadPane
                name={selectedSession.name}
                session={toTile(selectedSession)}
                chatOn={threadEligible}
                input={threadInput ?? undefined}
                headerTrailing={
                  <button
                    type="button"
                    onClick={openSettings}
                    data-vr="pane-settings-toggle"
                    aria-label="Bot settings"
                    title="Bot settings"
                    className="grid size-8 shrink-0 place-items-center rounded-full border-[0.5px] border-hairline text-ink-3 transition-colors hover:bg-fill-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <SlidersHorizontal className="size-4" aria-hidden />
                  </button>
                }
              />
            </React.Suspense>
          ) : (
            // SETTINGS (the toggle's other face) — or the only face for a bot that
            // cannot be chat (Codex/shell/remote/team-lead). Eligible → "Open
            // thread" flips back to the conversation; ineligible → "Open terminal
            // →" leaves for /focus, where the live terminal actually lives.
            <React.Suspense
              fallback={<div className="gr-pane" data-shell-pane aria-hidden />}
            >
              <BotPanel
                // Key on the bot so switching colleagues while in settings
                // remounts the panel — the deep-link `initialTab` (initial state)
                // applies fresh instead of inheriting the last bot's open tab.
                key={selectedSession.name}
                variant="pane"
                name={selectedSession.name}
                initialTab={paneTab}
                onOpenThread={openThread}
                onOpenTerminal={threadEligible ? undefined : openInFocus}
                onNavigate={(n) => navigate(`/focus/${encodeURIComponent(n)}`)}
              />
            </React.Suspense>
          )
        ) : (
          <div className="gr-pane" aria-hidden>
            <div className="gr-pane-empty">
              <div>
                <Sparkles size={22} style={{ opacity: 0.5, marginBottom: 10 }} aria-hidden />
                <div>Select a colleague to see cost, context and their latest.</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <NewSessionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        botVoiced
        // A new bot defaults into the ACTIVE company (HQ = null = a main bot).
        companyId={activeCompany}
        onCreated={(name) => navigate(`/focus/${encodeURIComponent(name)}`)}
      />

    </div>
  )
}
