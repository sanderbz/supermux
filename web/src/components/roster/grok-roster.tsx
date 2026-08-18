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
 * count + a red section. Density (Comfortable = Row A default / Compact = Row C /
 * Cards = Row B) is the existing density affordance in Grok's idiom, driven by
 * one `data-density` attribute the CSS forks on.
 *
 * Every visual lives in `styles/grok-mode.css` under `[data-grok]`; this file is
 * structure + data only. The marks, their expressions, the needs-you halo and
 * the working-only breathe all come from `<SessionFace>` (WS4) for free.
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, Plus, Search, Settings, SlidersHorizontal, Sparkles } from 'lucide-react'

import { useSessions } from '@/hooks/use-sessions'
import { useChatRenderer } from '@/components/chat/use-chat-renderer'
import { restSessionInput } from '@/lib/session-input'
import type { TileSession } from '@/components/session-tile/types'
import { useTeams } from '@/hooks/use-teams'
import { splitTeamLeads } from '@/components/focus-mode/focus-strip-groups'
import { useAttentionContext } from '@/hooks/use-attention'
import { useArchivedSheet } from '@/stores/archived-sheet-store'
import { useNewSessionAction } from '@/stores/new-session-store'
import { NewSessionSheet } from '@/components/session-tile/new-session-sheet'
import { SessionFace } from '@/components/roster/session-face'
import { SessionMark } from '@/brand/marks'
import { attentionFor, markStateForSession } from '@/lib/mark-status'
import { smartSort, nameSort } from '@/lib/overview-layout'
import { displayLabel, type ApiSession } from '@/lib/api'
import { needsYouCount, taskProgress, type Team } from '@/lib/api/teams'

// The per-bot settings page. Lazy — it only mounts once a bot is selected (a
// detail pane on desktop), so its section bodies (issues, schedules, git,
// session-actions) never weigh on the roster's first paint.
const BotPanel = React.lazy(() =>
  import('@/components/roster/bot-panel').then((m) => ({ default: m.BotPanel })),
)

// The live conversation thread — the SAME renderer the focus routes mount, reused
// verbatim in the roster's right pane (desktop grok's "thread-in-pane", approach
// (a)). It is self-wiring from `name` alone (its own chat WS + peek + REST plane),
// needs no xterm, and is lazy so the roster's first paint never pays for it — it
// only arrives once a chat-eligible bot is opened.
const ChatPanel = React.lazy(() => import('@/components/chat/chat-panel'))

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
  if (s.status === 'active' || s.status === 'starting') return { word: 'working', cls: 'st-work' }
  if (s.status === 'error') return { word: 'blocked', cls: 'st-block' }
  if (s.status === 'stopped') return { word: 'stopped', cls: 'st-idle' }
  if (group === 'done') return { word: 'done', cls: 'st-done' }
  return { word: 'idle', cls: 'st-idle' }
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/** Bucket the sorted roster into the four attention-ordered sections. A plain
 *  module function so the `Date.now()` default lives OUTSIDE component render
 *  (the same shape `attention-tiers.ts` uses) — a `Date.now()` in a `useMemo`
 *  body reads as an impurity to `react-hooks/purity`, and rightly so. */
function groupSessions(
  sorted: readonly ApiSession[],
  needNames: ReadonlySet<string>,
  now: number = Date.now(),
): Record<GroupKey, ApiSession[]> {
  const buckets: Record<GroupKey, ApiSession[]> = { needs: [], active: [], done: [], idle: [] }
  for (const s of sorted) {
    if (needNames.has(s.name)) {
      buckets.needs.push(s)
      continue
    }
    if (s.status === 'active' || s.status === 'starting') {
      buckets.active.push(s)
      continue
    }
    const t = s.updated_at ? Date.parse(s.updated_at) : NaN
    if (s.status === 'idle' && !Number.isNaN(t) && isSameDay(t, now)) {
      buckets.done.push(s)
      continue
    }
    buckets.idle.push(s)
  }
  return buckets
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

/* ── persisted, tiny: the density lane (Comfortable | Compact | Cards) ───────── */
type Density = 'comfortable' | 'compact' | 'cards'
const DENSITY_KEY = 'supermux:grok-density'
function readDensity(): Density {
  if (typeof localStorage === 'undefined') return 'comfortable'
  const v = localStorage.getItem(DENSITY_KEY)
  return v === 'compact' || v === 'cards' ? v : 'comfortable'
}

/* ── the row (Row A anatomy; density forks in CSS) ──────────────────────────── */

interface RowProps {
  session: ApiSession
  group: GroupKey
  active: boolean
  onOpen: (s: ApiSession) => void
  index: number
}

const GrokRow = React.memo(function GrokRow({ session, group, active, onOpen, index }: RowProps) {
  const name = displayLabel(session)
  const time = relativeTime(session.updated_at)
  const sw = stateWordFor(session, group)
  const preview = previewOf(session)
  const provider = session.provider || 'shell'
  const tokens = fmtTokens(session.tokens)
  const pct = ctxPct(session.tokens)
  const tags = session.tags?.slice(0, 2) ?? []

  return (
    <button
      type="button"
      className="gr-rowA grok-row-enter"
      data-active={active || undefined}
      style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
      onClick={() => onOpen(session)}
      aria-label={`${name} — ${sw.word}`}
    >
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
                {/* cards mode swaps the ring for a bar (CSS decides visibility) */}
                <span className={`cbar ${rcClass(pct)}`}>
                  <i style={{ width: `${pct}%` }} />
                </span>
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
    </button>
  )
})

/* ── team facepile row (a team is just another row — 3 member marks) ─────────── */

export function TeamRow({
  team,
  onOpen,
  index,
}: {
  team: Team
  onOpen: (t: Team) => void
  index: number
}) {
  const members = team.members.slice(0, 3)
  // Reuse the two team roll-up helpers rather than re-deriving them here, for
  // parity with the bot row's L2 state-word + L3 muted glance (teams.ts owns the
  // definitions; the team card reads the same two).
  const needs = needsYouCount(team)
  const progress = taskProgress(team)
  const last =
    team.members.find((m) => m.status === 'needs_you')?.name ??
    team.members[0]?.name ??
    ''
  return (
    <button
      type="button"
      className="gr-rowA grok-row-enter"
      style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
      onClick={() => onOpen(team)}
      aria-label={`${team.team_name} — ${team.members.length} bots`}
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
              {team.members.length} bots
            </span>
          </span>
        </span>
      </span>
    </button>
  )
}

/* ── the roster ─────────────────────────────────────────────────────────────── */

export default function GrokRoster() {
  const navigate = useNavigate()
  const { sessions: allSessions } = useSessions()
  const { teams } = useTeams()
  const attention = useAttentionContext()
  const openArchived = useArchivedSheet((s) => s.openSheet)
  const setNewSessionAction = useNewSessionAction((s) => s.setAction)

  const sessions = React.useMemo(
    () => splitTeamLeads(allSessions, teams).nonLeadSessions,
    [allSessions, teams],
  )

  const [rawQuery, setRawQuery] = React.useState('')
  const [sort, setSort] = React.useState<'smart' | 'alpha'>('smart')
  const [density, setDensity] = React.useState<Density>(readDensity)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  // Which face the right pane wears for the OPEN bot: the live conversation
  // ('thread', the default) or the per-bot settings page ('settings'). It resets
  // to 'thread' whenever the selection changes (the render-phase guard below) so
  // opening a new colleague always lands on their conversation, never on the last
  // bot's settings tab.
  const [paneView, setPaneView] = React.useState<'thread' | 'settings'>('thread')

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

  const filtered = React.useMemo(
    () => sessions.filter((s) => matches(s, needle)),
    [sessions, needle],
  )
  const filteredTeams = React.useMemo(() => {
    if (!needle) return teams
    return teams.filter(
      (t) =>
        t.team_name.toLowerCase().includes(needle) ||
        t.members.some((m) => m.name.toLowerCase().includes(needle)),
    )
  }, [teams, needle])

  const sorted = React.useMemo(
    () => (sort === 'alpha' ? nameSort(filtered) : smartSort(filtered)),
    [filtered, sort],
  )

  // Group into the four attention-ordered sections (overview.md §6). Teams ride
  // their own leading section (a team is a row; grouping it by a member tier is
  // noise). The `needs` set comes from the app-wide provider's PRECOMPUTED
  // rollup — the same list the header count and the red section read, so they
  // can never disagree — rather than calling `attentionFor` per row in render
  // (which would read `Date.now()` mid-render: an impurity the linter rightly
  // flags, and the reason the rollup is memoised in the provider in the first
  // place).
  const needNames = React.useMemo(
    () => new Set(attention.needs.map((s) => s.name)),
    [attention.needs],
  )
  const groups = React.useMemo(() => groupSessions(sorted, needNames), [sorted, needNames])

  const needCount = groups.needs.length
  // The VISIBLE list is empty when neither a team nor any session survives the
  // current filter — the honest trigger for the empty state (jury d). `totalBots`
  // counts the UNFILTERED roster, so it cannot answer "did this search find
  // nothing".
  const listEmpty = filteredTeams.length === 0 && sorted.length === 0

  // Keep the selection valid by DERIVATION, not by an effect: a session that
  // left the list (archived, deleted, filtered out) resolves to `null` here, so
  // the detail pane closes on its own and the stale name is simply overwritten
  // by the next click — no setState-in-effect, no cascading render.
  const selectedSession = React.useMemo(
    () => (selected ? sessions.find((s) => s.name === selected) ?? null : null),
    [selected, sessions],
  )

  // Reset the pane to the thread whenever the SELECTION changes — React's
  // "adjust state while rendering" pattern (a previous-value in state, not an
  // effect): React re-renders immediately with the corrected value and no
  // cascading commit. Re-clicking the SAME row is handled in `openSession`.
  const [paneSelSeen, setPaneSelSeen] = React.useState(selected)
  if (paneSelSeen !== selected) {
    setPaneSelSeen(selected)
    if (paneView !== 'thread') setPaneView('thread')
  }

  // The one hard constraint on thread-in-pane: chat eligibility. `useChatRenderer`
  // is the SAME three-gate decision the focus seam uses (bot mode on + kill-switch
  // + local-Claude-non-lead). A bot that fails it — Codex, shell, a remote host,
  // a team lead — cannot be a chat surface, so the pane falls back to its settings
  // page with an honest "Open terminal →" escape to /focus (Phase 1).
  const isTeamLead = React.useMemo(
    () => (selected ? teams.some((t) => t.lead_supermux_session === selected) : false),
    [teams, selected],
  )
  const threadEligible = useChatRenderer(selectedSession, isTeamLead)
  // The panel's write plane, memoised by name so a roster re-render (the seconds
  // ticker, a sibling row's delta) doesn't hand the chat hooks a fresh input
  // object every frame. `ChatPanel` opens its own chat WS + peek from `name`; this
  // is only the RAW `/send`·`/paste`·`/keys` plane, exactly what the focus route
  // hands it (desktop-split.tsx).
  const threadInput = React.useMemo(
    () => (selected ? restSessionInput(selected) : null),
    [selected],
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

  const openSession = React.useCallback(
    (s: ApiSession) => {
      attention.markRead(s)
      // Desktop shows the detail pane; phone has none, so tap → thread.
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
        navigate(`/focus/${encodeURIComponent(s.name)}`)
        return
      }
      setSelected(s.name)
      // Re-opening the row you are already ON keeps `selected` unchanged, so the
      // render-phase reset never fires — flip back to the thread here too, so a
      // click always returns to the conversation.
      setPaneView('thread')
    },
    [attention, navigate],
  )
  const openTeam = React.useCallback(
    (t: Team) => {
      if (t.lead_supermux_session) navigate(`/focus/${encodeURIComponent(t.lead_supermux_session)}`)
    },
    [navigate],
  )
  // DESKTOP: the pane swaps in place — no /focus hop, no second shell. The rail
  // keeps its scroll, its selection highlight and its entry animations (the Grok
  // inbox feel). BotPanel's "Open thread" and the thread's own settings toggle
  // both flow through `setPaneView`.
  const openThread = React.useCallback(() => setPaneView('thread'), [])
  const openSettings = React.useCallback(() => setPaneView('settings'), [])
  // The terminal escape hatch + the ineligible-bot fallback: honestly LEAVE the
  // roster for the still-present /focus route, which owns the live terminal (and
  // its keyboard capture). Phase 1 does not reproduce the terminal in the pane.
  const openInFocus = React.useCallback(() => {
    if (selectedSession) navigate(`/focus/${encodeURIComponent(selectedSession.name)}`)
  }, [navigate, selectedSession])

  const totalBots = sessions.length + teams.length
  const hasDetail = !!selectedSession

  const SECTIONS: { key: GroupKey; label: string }[] = [
    { key: 'needs', label: 'Needs you' },
    { key: 'active', label: 'Active' },
    { key: 'done', label: 'Done today' },
    { key: 'idle', label: 'Idle' },
  ]

  let rowIndex = 0

  return (
    <div className="grok-roster" data-detail={hasDetail ? '1' : '0'} data-density={density}>
      <header className="gr-head">
        <span className="gr-brand">
          <span className="gr-spark" aria-hidden />
          supermux
        </span>
        <span className="gr-count">
          {totalBots} {totalBots === 1 ? 'bot' : 'bots'}
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
            onChange={(e) => setRawQuery(e.target.value)}
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
          <button
            type="button"
            aria-pressed={density === 'cards'}
            onClick={() => setDensityPersist('cards')}
            title="Cards — budget watcher"
          >
            Cards
          </button>
        </span>
      </header>

      <div className="gr-two">
        <div className="gr-rail" data-solo={hasDetail ? undefined : ''}>
          <div
            className="gr-list"
            ref={listRef}
            onScroll={onScroll}
            data-fade-top={fade.top ? '' : undefined}
            data-fade-bottom={fade.bottom ? '' : undefined}
          >
            {/* Persistent HIRE affordance — a ghost row pinned above the Teams
                divider. Dashed hairline + placeholder mark, always inviting the
                next hire (not just the zero-bots hint). Hidden while searching
                (it is a create verb, not a result) and, via CSS, in the compact
                feed density. */}
            {!needle && (
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

            {filteredTeams.length > 0 && (
              <>
                <div className="gr-grp">
                  <span className="lbl">Teams</span>
                  <span className="ct">{filteredTeams.length}</span>
                  <span className="ln" />
                </div>
                {filteredTeams.map((t) => (
                  <TeamRow key={t.team_name} team={t} onOpen={openTeam} index={rowIndex++} />
                ))}
              </>
            )}

            {SECTIONS.map(({ key, label }) => {
              const items = groups[key]
              if (items.length === 0) return null
              return (
                <React.Fragment key={key}>
                  <div className="gr-grp" data-need={key === 'needs' ? '' : undefined}>
                    <span className="lbl">{label}</span>
                    <span className="ct">{items.length}</span>
                    <span className="ln" />
                  </div>
                  {items.map((s) => (
                    <GrokRow
                      key={s.name}
                      session={s}
                      group={key}
                      active={selected === s.name}
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

          <footer className="gr-ft">
            <span className="av" aria-hidden>
              SB
            </span>
            <span className="who">Sander</span>
            {/* Two distinct destinations — the gear used to be an archive decoy.
                Archive (box) → the archived sheet; Settings (gear) → /settings. */}
            <button
              type="button"
              className="set"
              aria-label="Archived sessions"
              onClick={openArchived}
              title="Archived sessions"
            >
              <Archive size={18} aria-hidden />
            </button>
            <button
              type="button"
              className="set"
              aria-label="Settings"
              onClick={() => navigate('/settings')}
              title="Settings"
            >
              <Settings size={18} aria-hidden />
            </button>
          </footer>
        </div>

        {hasDetail ? (
          paneView === 'thread' && threadEligible ? (
            // THE LIVE THREAD in the right pane — the reused chat renderer, one
            // shell, one composer, no route change. The settings page is one tap
            // away via the header-pill toggle we inject here; the terminal is an
            // honest /focus escape (Phase 1).
            <React.Suspense
              fallback={<div className="gr-pane gr-threadpane" data-shell-pane aria-hidden />}
            >
              <div className="gr-pane gr-threadpane" data-shell-pane>
                <ChatPanel
                  name={selectedSession.name}
                  session={toTile(selectedSession)}
                  input={threadInput ?? undefined}
                  surface="desktop"
                  onOpenTerminal={openInFocus}
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
              </div>
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
                variant="pane"
                name={selectedSession.name}
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
        onCreated={(name) => navigate(`/focus/${encodeURIComponent(name)}`)}
      />
    </div>
  )
}
