// /dev/roster — the visual bench for the roster system (fase B2, T1).
//
// DEV-only + lazy + mounted outside <Layout> (mirrors /dev/marks, /dev/tiles),
// so neither the route nor its fixture can reach a production chunk and the page
// is pure design system: no nav, no header, nothing but the roster on paper.
//
// What it is FOR: this is the surface B2 regresses against, task by task. The
// roster system has four independent channels — density, mark state, attention
// tier, theme — and B2 changes all four, so all four are on ONE page. Every VR
// sweep in this fase diffs against a shot of this route.
//
// Three deliberate rules, inherited from /dev/marks:
//   · every matrix is a STILL frame. A bench you screenshot must be
//     deterministic, and the still frame is exactly what a reduced-motion user
//     and every screenshot keep forever — if a state is not separable here, it
//     is not separable at all.
//   · both themes render on ONE page via the `[data-theme]` subtree switch, so
//     light and dark are compared side by side rather than across two shots.
//   · the coverage is data (`dev-roster.cast.ts`) and it is asserted
//     (`tests/unit/dev-roster-cast.test.tsx`), so the bench cannot quietly
//     shrink when a later task finds a matrix inconvenient.
//
// Sections landed with their tasks: T1 seated densities/states/attention/
// selection and the tile tiers, T6 filled the rollup, T7 the pinned hairline,
// T10 the issue pieces. While a section was unlanded it rendered a loud
// "pending" plate — an empty section and a missing section look identical in a
// screenshot. There are none left, and `dev-roster-cast.test.tsx` asserts that.
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { PAPER } from '@/brand/tokens'
import type { MarkState } from '@/brand/marks'
import { RosterRow } from '@/components/chat/ui'
import { AttentionRollup } from '@/components/roster/attention-rollup'
import { AcceptanceChecklist } from '@/components/issues/acceptance-checklist'
import { ReplyComposer } from '@/components/issues/reply-composer'
import { SessionTile } from '@/components/session-tile'
import { MOCK_TILES } from '@/components/session-tile/mock'
import { getOverviewSizeConfig } from '@/lib/overview-size'

import {
  ATTENTION_TIERS,
  BENCH_THEMES,
  DENSITY_ROLES,
  ISSUE_STATES,
  PINNED_NAMES,
  ROLLUP_COUNTS,
  ROSTER_CAST,
  ROSTER_DENSITIES,
  ROSTER_STATES,
  STATE_MODELS,
  TIER_MODELS,
  TILE_TIERS,
  type AttentionTier,
  type BenchTheme,
  type RosterDensity,
  type RosterMember,
} from './dev-roster.cast'
import { Trash2 } from 'lucide-react'

import { ArmedButton } from '@/components/ui/armed-button'
import type { ArmedConfirm } from '@/hooks/use-armed-confirm'
import {
  AutoHealToggle,
  RecoveryLadder,
} from '@/components/recovery/recovery-ladder'
import { BotPanel } from '@/components/roster/bot-panel'
import { RestartToApply } from '@/components/roster/granted-connectors'
import { GrokRow, TeamRow } from '@/components/roster/grok-roster'
import { MOCK_TEAMS } from './dev-teams.fixture'
import { rosteredTeams } from '@/lib/team-attention'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import type { ApiSession } from '@/lib/api'
import type { NotesResponse } from '@/lib/api/memory'
import { sessionConnectorsKey } from '@/stores/connectors-store'
import type { SessionConnector, ConnectorCard } from '@/lib/api/connectors'

/* ── the bot panel bench (ASK 3) ─────────────────────────────────────────────
   The per-bot settings page needs a live session row, so the bench SEEDS the
   sessions query with one mock bot (rich enough to fill every tab: role/desc,
   tags, model, notes, tokens, a chat tail) and renders `<BotPanel variant="pane">`
   at each of its four tabs, in both themes, wrapped in the `[data-grok]
   .grok-roster` skin context the pane's CSS keys off. Query-backed sub-sections
   (Issues / Schedules / Git) degrade to their empty/offline states here, which is
   the honest still frame for a design review. */
const BOT_PANEL_BENCH_NAME = 'web-app'
const MOCK_BOT: ApiSession = {
  name: BOT_PANEL_BENCH_NAME,
  display_name: 'Web app',
  status: 'active',
  provider: 'claude',
  dir: '/opt/projects/web-app',
  branch: 'feat/grok-mode',
  tokens: 96_400,
  model: 'opus',
  desc: 'You implement features end to end. Prefer small, verifiable steps; run the tests before claiming done; keep changes scoped to the task.',
  memory: 'Design system tokens live in web/src/brand. Never edit server/migrations. The build gate is `bun run build:perf`.',
  tags: ['frontend', 'grok'],
  notif: 'attention',
  mcp: '',
  worktree: true,
  runtime: 'native',
  updated_at: new Date(1_800_000_000_000).toISOString(),
  task_summary: 'Wiring the per-bot settings panel into the roster detail pane.',
} as ApiSession

const BOT_PANEL_TABS: {
  tab: 'overview' | 'instructions' | 'tools' | 'memory' | 'activity'
  label: string
}[] = [
  { tab: 'overview', label: 'Overview' },
  { tab: 'instructions', label: 'Instructions' },
  { tab: 'tools', label: 'Tools' },
  { tab: 'memory', label: 'Memory' },
  { tab: 'activity', label: 'Activity' },
]

// The bench runs BotPanel against an ISOLATED, PRE-SEEDED query client so it
// reviews offline with real data and never fires a live fetch (`staleTime:
// Infinity` keeps the seeded rows fresh; `retry:false` keeps a stray board/git
// probe from looping). One client for the whole bench.
const BENCH_QC = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity, gcTime: Infinity },
  },
})
BENCH_QC.setQueryData<ApiSession[]>(SESSIONS_KEY, [MOCK_BOT])
// The Activity tab's schedules list assumes an array; seed an empty one so the
// offline bench shows its real "No schedules" empty state instead of crashing on
// a non-array offline response.
BENCH_QC.setQueryData(['schedules'], [])
// The Memory tab's ARCHIVAL list (`learned-notes.tsx`) reads the bot-memory HTTP
// routes; seed the empty-query (browse) result plus one opened note so the bench
// reviews the POPULATED panel offline — tier chips, type dots, ages, an expanded
// Markdown body — instead of only its empty state. Shapes mirror
// `lib/api/memory.ts` exactly, so a drift in the wire type breaks `tsc`, here.
BENCH_QC.setQueryData<NotesResponse>(['learned-notes', BOT_PANEL_BENCH_NAME, ''], {
  bot_count: 2,
  role_count: 1,
  role: 'implementer',
  notes: [
    {
      slug: 'build-gate-is-build-perf',
      description: 'the build gate is bun run build:perf, never a bare vite build',
      tier: 'bot',
      note_type: 'decision',
      modified: new Date(1_799_900_000_000).toISOString(),
      snippet:
        'Why: the bare build skips the size budgets, so an entry-chunk regression lands unnoticed. How: run bun run build:perf before claiming done.',
    },
    {
      slug: 'never-edit-server-migrations',
      description: 'never edit a file under server/migrations — sqlx checksums them',
      tier: 'bot',
      note_type: 'bugfix',
      modified: new Date(1_799_000_000_000).toISOString(),
      snippet:
        'Why: a VersionMismatch bricks every deployed install, even for a comment-only edit. How: add a new numbered migration instead.',
    },
    {
      slug: 'the-owner-reviews-every-merge',
      description: 'the owner reviews every merge — open a PR, never self-merge',
      tier: 'role',
      note_type: 'feedback',
      modified: new Date(1_796_000_000_000).toISOString(),
      snippet: 'Why: main is protected and the owner reads the diff. How: open the PR and hand off.',
    },
  ],
})
BENCH_QC.setQueryData(['learned-note', BOT_PANEL_BENCH_NAME, 'bot', 'build-gate-is-build-perf'], {
  slug: 'build-gate-is-build-perf',
  description: 'the build gate is bun run build:perf, never a bare vite build',
  tier: 'bot',
  note_type: 'decision',
  modified: new Date(1_799_900_000_000).toISOString(),
  body:
    '**Why:** a bare `vite build` skips `scripts/size-budget.mjs`, so an entry-chunk regression lands unnoticed and only shows up as a slow first paint on a phone.\n\n**How to apply:** run `bun run build:perf` from `web/` before claiming done. If a budget is genuinely forced up, ratchet the ceiling AND say so in the PR body.\n\nSee also [[never-edit-server-migrations]].',
})
// One SEARCH result too, so the bench shows the ranked state (and its score-
// ordered list) offline rather than only the browse list and the empty state.
BENCH_QC.setQueryData<NotesResponse>(['learned-notes', BOT_PANEL_BENCH_NAME, 'migrations'], {
  bot_count: 1,
  role_count: 0,
  role: 'implementer',
  notes: [
    {
      slug: 'never-edit-server-migrations',
      description: 'never edit a file under server/migrations — sqlx checksums them',
      tier: 'bot',
      note_type: 'bugfix',
      modified: new Date(1_799_000_000_000).toISOString(),
      snippet:
        'Why: a VersionMismatch bricks every deployed install, even for a comment-only edit. How: add a new numbered migration instead.',
      score: 2.5,
    },
  ],
})

// The Tools tab's CONNECTOR list reads `GET /api/sessions/{name}/connectors`
// (own + all-agents). Seed a rich set so the offline bench shows the promoted
// surface's real states — an enabled own-grant with its at-a-glance toggle, a
// disabled own-grant, an actionable "Needs sign-in" row, and a shared "via all
// agents" row — instead of only the loading spinner. Shapes mirror
// `SessionConnector` exactly, so a wire-type drift breaks `tsc`, here.
function card(over: Partial<ConnectorCard> & { id: string; display_name: string }): ConnectorCard {
  return {
    kind: 'mcp_catalog',
    icon: '',
    description: '',
    tools: [],
    credentials: [],
    source: 'local',
    ...over,
  }
}
const BENCH_CONNECTORS: SessionConnector[] = [
  {
    connector_id: 'github',
    has_secret: true,
    enabled: true,
    card: card({ id: 'github', display_name: 'GitHub', lucide: 'github', tool_count: 14 }),
  },
  {
    connector_id: 'linear',
    has_secret: true,
    enabled: false,
    card: card({ id: 'linear', display_name: 'Linear', lucide: 'square-kanban', tool_count: 8 }),
  },
  {
    connector_id: 'notion',
    has_secret: false,
    enabled: true,
    card: card({
      id: 'notion',
      display_name: 'Notion',
      lucide: 'notebook',
      tool_count: 6,
      credentials: [{ key: 'token', title: 'API token', sensitive: true, required: true }],
    }),
  },
  {
    connector_id: 'slack',
    has_secret: true,
    enabled: true,
    card: card({ id: 'slack', display_name: 'Slack', lucide: 'slack', tool_count: 11 }),
  },
]
BENCH_QC.setQueryData<SessionConnector[]>(sessionConnectorsKey(BOT_PANEL_BENCH_NAME), BENCH_CONNECTORS)
// The all-agents set: `slack` is shared via `*`, so its row reads "via all agents"
// and is read-only in the panel (revoke it from the store, globally).
BENCH_QC.setQueryData<SessionConnector[]>(sessionConnectorsKey('*'), [
  { connector_id: 'slack', has_secret: true, enabled: true, card: card({ id: 'slack', display_name: 'Slack', lucide: 'slack', tool_count: 11 }) },
])

/** Backstop so an offline query hiccup in one tab degrades to a message rather
 *  than taking down the shared /dev/roster route. */
class BenchBoundary extends React.Component<
  { label: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-dashed border-ink-3/40 p-4 text-[12px] text-ink-3">
          {this.props.label} tab could not render offline ({this.state.error.message.slice(0, 80)}).
        </div>
      )
    }
    return this.props.children
  }
}

function BotPanelBench({ theme }: { theme: BenchTheme }) {
  return (
    <QueryClientProvider client={BENCH_QC}>
      <div className="grid gap-6 lg:grid-cols-2">
        {BOT_PANEL_TABS.map(({ tab, label }) => (
          <div key={tab} data-bench-bot-tab={tab} className="flex flex-col gap-2">
            <span className="text-[11px] text-ink-3">{label} tab</span>
            {/* the pane's CSS is `[data-grok] .grok-roster .gr-…`; recreate that
                ancestry, and give the flex pane a bounded height to scroll in. */}
            <div data-grok data-vr={`bot-panel-${theme}-${tab}`}>
              <div
                className="grok-roster overflow-hidden rounded-2xl"
                style={{ display: 'flex', height: 560, border: '0.5px solid var(--gr-line)' }}
              >
                <BenchBoundary label={label}>
                  <BotPanel
                    variant="pane"
                    name={BOT_PANEL_BENCH_NAME}
                    initialTab={tab}
                    onOpenThread={() => {}}
                    onNavigate={() => {}}
                  />
                </BenchBoundary>
              </div>
            </div>
          </div>
        ))}
      </div>
    </QueryClientProvider>
  )
}

/* ── the grok team-row bench (team polish) ───────────────────────────────────
   The grok roster renders a TEAM as its own face-led row (a 3-member cluster +
   an enriched L2/L3 glance: `needsYouCount` state word + `taskProgress`). It only
   ever appears inside the live overview, so it was unreviewable offline. Seed it
   from the SAME `MOCK_TEAMS` `/dev/teams` uses (needs_you / working / idle /
   offline members, a full task ledger, a 0-task solo, an unmapped lead) inside
   the `[data-grok] .grok-roster` skin context its CSS keys off. Still frame,
   onOpen is a no-op — this is a design bench, not a router. */
function TeamRowBench() {
  let i = 0
  // Count and render from the SAME `rosteredTeams` filter the live header and
  // sections pass through: a 0-member team (`solo`) is never a row (TeamRow
  // returns null) and must never be counted, or the bench header reads `3` over
  // 2 rendered rows — the exact count drift the design jury flagged (R1 POLISH).
  // The noun is `Crew`, matching `N crews` / `Hire a crew` / the panel's `Crew`
  // section — one primary word for the object across every surface.
  const crews = rosteredTeams(MOCK_TEAMS)
  return (
    <div data-grok data-vr="grok-team-rows">
      <div className="grok-roster">
        <div className="gr-list" data-density="comfortable">
          <div className="gr-grp">
            <span className="lbl">Crew</span>
            <span className="ct">{crews.length}</span>
            <span className="ln" />
          </div>
          {crews.map((t) => (
            <TeamRow key={t.team_name} team={t} onOpen={() => {}} index={i++} />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── the grok BOT-row bench (inert title, §2.1) ──────────────────────────────
   The inbox row is ONE hit target: a tap anywhere — the avatar, the body, the
   name — opens the thread. The NAME is inert text (a plain `<span className="nm">`,
   not its own button): a tap on it falls through the pointer-transparent `.col`
   to the full-bleed `gr-row-open` base button (f5f0a97). Settings stay reachable
   via the ⋯ actions menu / long-press / right-click. Rendered here as a still
   frame in the `[data-grok] .grok-roster` skin its CSS keys off, so the single
   open target, the ⋯ kebab reveal and the row hover can be reviewed offline. */
const GROK_ROW_BOTS: { session: ApiSession; group: 'needs' | 'active' | 'done' | 'idle' }[] = [
  {
    group: 'needs',
    session: {
      ...MOCK_BOT,
      name: 'pr-reviewer',
      display_name: 'PR reviewer',
      status: 'waiting',
      tokens: 42_000,
      tags: ['reviews'],
      task_summary: 'Waiting on your call about the migration rename.',
    } as ApiSession,
  },
  {
    group: 'active',
    session: {
      ...MOCK_BOT,
      name: 'web-app',
      display_name: 'Web app',
      status: 'active',
      tokens: 96_400,
      task_summary: 'Wiring the per-bot connector panel into the roster.',
    } as ApiSession,
  },
  {
    group: 'idle',
    session: {
      ...MOCK_BOT,
      name: 'night-watch',
      display_name: 'Night watch',
      status: 'idle',
      tokens: 12_800,
      tags: ['ops'],
      task_summary: 'Idle — watching prod logs.',
    } as ApiSession,
  },
]

function GrokRowBench() {
  let i = 0
  return (
    <QueryClientProvider client={BENCH_QC}>
      <div data-grok data-vr="grok-bot-rows">
        <div className="grok-roster">
          <div className="gr-list" data-density="comfortable">
            <div className="gr-grp">
              <span className="lbl">Bots</span>
              <span className="ct">{GROK_ROW_BOTS.length}</span>
              <span className="ln" />
            </div>
            {GROK_ROW_BOTS.map(({ session, group }, idx) => (
              <GrokRow
                key={session.name}
                session={session}
                group={group}
                active={idx === 1}
                onOpen={() => {}}
                index={i++}
              />
            ))}
          </div>
        </div>
      </div>
    </QueryClientProvider>
  )
}

/* ── the one-tap restart action (§2.3) ───────────────────────────────────────
   The "Restart to apply" the hint never had — reuses the `restart` recovery rung
   (the SAME lifecycle the header actions menu drives). The seeded bot is `active`
   (mid-turn), so this bench shows the arm-confirm variant: the first press asks,
   the second fires. Rendered against `BENCH_QC` so `useSession` resolves offline. */
function RestartActionBench() {
  return (
    <QueryClientProvider client={BENCH_QC}>
      <div data-grok data-vr="restart-action" className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] text-ink-3">the hint, with its one-tap action</span>
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5">
            <span className="text-[12px] text-muted-foreground">
              Applies on next start — the running agent keeps its current setup.
            </span>
            <RestartToApply name={BOT_PANEL_BENCH_NAME} />
          </div>
        </div>
      </div>
    </QueryClientProvider>
  )
}

/* ── page furniture ──────────────────────────────────────────────────────── */

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string
  title: string
  note: string
  children: React.ReactNode
}) {
  return (
    <section data-bench={id} data-vr={`roster-${id}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        <p className="max-w-3xl text-xs leading-relaxed text-ink-2">{note}</p>
      </header>
      {children}
    </section>
  )
}

/** A titled plate — the paper a strip of rows sits on, so row chrome (hover,
 *  selection tint, hairline) is judged against the surface it ships on. */
function Plate({
  label,
  children,
  className,
}: {
  label?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      {label && <span className="text-[11px] text-ink-3">{label}</span>}
      <div
        className={
          'rounded-2xl bg-paper-raised px-2 py-2 shadow-[var(--sm-bubble-shadow)] ' +
          (className ?? '')
        }
      >
        {children}
      </div>
    </div>
  )
}

/* ── the row adapter ─────────────────────────────────────────────────────── */

/** The bench's single row unit — a thin forwarder onto the primitive, so the
 *  bench cannot accidentally become its own implementation of a row. */
function BenchRow({
  member,
  density,
  state = 'idle',
  attention,
  selected,
  preview = true,
}: {
  member: RosterMember
  density: RosterDensity
  state?: MarkState
  attention?: boolean
  selected?: boolean
  preview?: boolean
}) {
  return (
    <div data-bench-density={density} data-bench-state={state}>
      <RosterRow
        seed={member.name}
        pin={member.pin}
        density={density}
        timestamp={member.timestamp}
        preview={preview && density === 'list' ? member.preview : undefined}
        meta={
          density === 'strip' ? <span>21k tokens · ⎇ feat/exec-backoff</span> : undefined
        }
        state={state}
        attention={attention}
        selected={selected}
      />
    </div>
  )
}

const byName = (name: string): RosterMember =>
  ROSTER_CAST.find((m) => m.name === name) ?? ROSTER_CAST[0]

/* ── panels ──────────────────────────────────────────────────────────────── */

/** Three densities, same four colleagues — the geometry ladder. */
function DensityMatrix() {
  const sample = ROSTER_CAST.slice(0, 4)
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={`${density} — ${DENSITY_ROLES[density]}`}>
          {sample.map((m, i) => (
            <BenchRow key={m.name} member={m} density={density} selected={i === 1} />
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** Six mark states × three densities. Still frames, one model per state so a
 *  state is never judged through a single silhouette. */
function StateMatrix() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={density}>
          {ROSTER_STATES.map((state) => (
            <BenchRow
              key={state}
              member={byName(STATE_MODELS[state])}
              density={density}
              state={state}
            />
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** The three tiers plus quiet, at every density. `quiet` draws no glyph — it is
 *  here so the difference between "quiet" and "unread" is lookable-at. */
function AttentionMatrix() {
  const stateFor = (tier: AttentionTier): MarkState =>
    tier === 'needs' ? 'waiting' : tier === 'working' ? 'working' : 'idle'
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={density}>
          {ATTENTION_TIERS.map((tier) => (
            <div key={tier} data-bench-tier={tier}>
              <BenchRow
                member={byName(TIER_MODELS[tier])}
                density={density}
                state={stateFor(tier)}
                attention={tier === 'needs'}
              />
            </div>
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** Selected vs unselected, per density — `sm-accent-row` is the only tinted
 *  chrome in the app and it is tinted with the session's OWN pigment, so it has
 *  to be checked against more than one face. */
function SelectionMatrix() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={density}>
          {ROSTER_CAST.slice(0, 3).map((m, i) => (
            <BenchRow key={m.name} member={m} density={density} selected={i === 0} />
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** The tile at all four overview tiers, in the real grid geometry. */
function TileTiers() {
  return (
    <div className="flex flex-col gap-8">
      {TILE_TIERS.map((tier) => {
        const cfg = getOverviewSizeConfig(tier)
        return (
          <div key={tier} data-bench-tier={tier} className="flex flex-col gap-2">
            <span className="text-[11px] text-ink-3">
              tier {tier} — {cfg.label} · {cfg.gridColsLg} cols · {cfg.idleLines} preview lines
            </span>
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.min(cfg.gridColsLg, 3)}, minmax(0, 1fr))` }}
            >
              {MOCK_TILES.slice(0, 3).map((t) => (
                <SessionTile key={`${tier}-${t.name}`} session={t} sizeTier={tier} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── one theme's worth of bench ──────────────────────────────────────────── */

function BenchPanel({ theme }: { theme: BenchTheme }) {
  const ring = PAPER[theme].paper
  return (
    <div
      data-theme={theme}
      data-bench-theme={theme}
      style={{ ['--sm-bench-ring' as string]: ring }}
      // `[data-theme]` flips the B0 paper ladder, but the app's own shadcn
      // tokens (`bg-card`, `--border`, …) hang off the `.dark` CLASS — and this
      // bench renders BOTH kinds of surface: paper-ladder rows and the shipped
      // SessionTile. Without the class the dark panel draws white tiles on dark
      // paper, which is a bench bug that reads as a design bug.
      className={theme === 'dark' ? 'dark bg-paper text-ink' : 'bg-paper text-ink'}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-6 py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            The roster — {theme}
          </h1>
          <p className="max-w-3xl text-xs leading-relaxed text-ink-2">
            One presentational row at three densities, six mark states, three attention tiers, and
            the tile at four overview tiers — the whole of what fase B2 moves. Both themes are on
            this page; this half is the{' '}
            <strong className="font-medium text-ink">{theme}</strong> subtree. Every matrix is a
            still frame.
          </p>
        </header>

        <Section
          id="densities"
          title="Three densities, one component"
          note="RosterRow is the single most-repeated object in the product, and B2 makes it the only one: the overview list row, the focus strip's compact tile and every picker row become the same component at a different density. list h64/mark 40 with the preview line · strip h48/mark 28 · picker h40/mark 24 and deliberately STATIC — a timestamp that ticks under the keyboard cursor is a bug, not a feature."
        >
          <DensityMatrix />
        </Section>

        <Section
          id="states"
          title="Six states × three densities"
          note="B0's contract C5: the silhouette is never ringed, notched or overpainted — state lives in the eyes and only in the eyes. That contract was proved at 40px on /dev/marks; here it has to survive at 24px in a picker row. Read each column top to bottom: idle open · working narrowed and slanted · waiting rounded · done squinted · stopped shut to a lid line · failed the one mirrored tilt."
        >
          <StateMatrix />
        </Section>

        <Section
          id="attention"
          title="Attention tiers"
          note="needs · unread · working · quiet, in that precedence. The needs-you dot is the ONLY glyph seated on the silhouette (7px, on the character's own shoulder). quiet renders no glyph at all and is on the bench precisely so the difference between quiet and unread is something you can look at."
        >
          <AttentionMatrix />
        </Section>

        <Section
          id="selection"
          title="Selection"
          note="sm-accent-row — the focused session's own pigment mixed into the paper at 9% (light) / 12% (dark). The only tinted chrome in the app, so it is checked against three different pigments, and hover is suppressed while selected."
        >
          <SelectionMatrix />
        </Section>

        <Section
          id="pinned-hairline"
          title="The pinned block"
          note={`A 0.5px separator after the pinned rows and no "Pinned" text header — the boundary is visible, the label is not needed. Renders nothing when there are no pins and nothing when everything is pinned. Benched with ${PINNED_NAMES.length} pinned of ${ROSTER_CAST.length}.`}
        >
          <Plate label={`${PINNED_NAMES.length} pinned of ${ROSTER_CAST.length}`}>
            {ROSTER_CAST.slice(0, 6).map((m, i) => {
              const pinned = PINNED_NAMES.includes(m.name)
              const boundary =
                !pinned && PINNED_NAMES.includes(ROSTER_CAST[i - 1]?.name ?? '')
              return (
                <React.Fragment key={m.name}>
                  {boundary && (
                    <div
                      aria-hidden
                      data-vr="pinned-hairline"
                      className="my-0.5 h-px bg-hairline"
                    />
                  )}
                  <BenchRow member={m} density="list" />
                </React.Fragment>
              )
            })}
          </Plate>
        </Section>

        <Section
          id="tiles"
          title="The tile at four density tiers"
          note="The overview's other surface. B2 replaces the bare status dot with the session's mark (no ring — C5) and gates the tile's facts on the fact ladder, so all four tiers are here to prove no tier drops a fact it used to show."
        >
          <TileTiers />
        </Section>

        <Section
          id="rollup"
          title="The attention rollup"
          note={`"needs you: N" on B0's facepile, in the overview header. N=${ROLLUP_COUNTS.join(' · N=')} — 0 must render NOTHING (no empty chrome) and 9 must collapse to three marks and a +6.`}
        >
          <div className="flex flex-col gap-4">
            {ROLLUP_COUNTS.map((n) => (
              <div key={n} data-bench-rollup={n} className="flex items-center gap-3">
                <span className="w-10 shrink-0 text-[11px] tabular-nums text-ink-3">N={n}</span>
                <div className="min-h-6">
                  <AttentionRollup
                    sessions={ROSTER_CAST.slice(0, n).map((m, i) => ({
                      name: m.name,
                      status: 'waiting' as const,
                      activity_at: 1_800_000_000_000 - (n - i) * 60_000,
                    }))}
                  />
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="restart-action"
          title="One-tap restart to apply (§2.3)"
          note="The restart hint gained the button it never had: it reuses the atomic restart recovery rung — the same lifecycle the header actions menu drives — closing the add-grant → restart → live loop. A bot mid-turn (the seeded bot is active) arm-confirms: the first press asks, the second fires."
        >
          <RestartActionBench />
        </Section>

        <Section
          id="grok-bot-rows"
          title="The grok bot row — name-as-click (§2.1)"
          note="The inbox row splits its hit target: the avatar and body open the thread (the fast default), while the NAME text is its own button that opens the settings panel. Two real sibling buttons — never nested — so each is a keyboard tab stop, and the name carries a hover underline + focus ring to advertise it is clickable. The middle row is shown selected."
        >
          <GrokRowBench />
        </Section>

        <Section
          id="grok-team-rows"
          title="The grok team row"
          note="A team is a colleague too: the grok roster renders it as a face-led row with a 3-member cluster and an enriched glance — the L2 state word counts needs-you members (needsYouCount) and the right rail shows the task ledger (taskProgress), for parity with a bot row's cost. Seeded from the same MOCK_TEAMS as /dev/teams: a full 5-teammate team with a task ledger, a 0-teammate solo, and an unmapped lead."
        >
          <TeamRowBench />
        </Section>

        <Section
          id="issues"
          title="The issue surface"
          note={`Per-session and per-team issue lists in ${ISSUE_STATES.join(' / ')} — the capability that has to exist before the Board page can be deleted.`}
        >
          {/* The LIST is server-backed (`useBoard`), so the bench shows the two
              pure pieces it is made of instead of faking a query: the acceptance
              checklist the agent ticks over SSE, and the composer that turns
              into a durable comment when the session is gone. The list's own
              states are covered by `issue-surface.spec.ts` against a real
              server. */}
          <Plate label="acceptance — the agent ticks these live">
            <div className="px-2 pb-2">
              <AcceptanceChecklist
                issueId="T-42"
                items={[
                  { id: 1, issue_id: 'T-42', body: 'unit suite green', done: 1, pos: 0 },
                  { id: 2, issue_id: 'T-42', body: 'VR in both themes', done: 1, pos: 1 },
                  {
                    id: 3,
                    issue_id: 'T-42',
                    body: 'perf budget under the ratchet',
                    done: 0,
                    pos: 2,
                  },
                ]}
              />
            </div>
          </Plate>
          <Plate label="reply — a comment when the session is gone">
            <div className="px-2 pb-2">
              <ReplyComposer
                issue={{ id: 'T-42', session: null } as never}
                expanded
                emphasized={false}
                onRequestOpen={() => {}}
                onReply={async () => {}}
                placeholder="Leave a comment for the record…"
              />
            </div>
          </Plate>
        </Section>

        {/* ── B5/T13.3 ─────────────────────────────────────────────────────
            Bench states for the two mechanisms B5 introduces that have a
            LOOK: the armed confirm (T9) and the recovery ladder (T8). Both
            are states you otherwise have to break something to reach — a
            terminal has to die before the ladder renders, and the armed
            state disarms itself after 4 s — so without a bench they can only
            be reviewed live, in the one situation where nobody wants to be
            fiddling with CSS. */}
        <Section
          id="armed-confirm"
          title="The armed confirm — both halves"
          note="One idiom replacing three (B5/T9). Resting reads as the action; armed reads as the CONSEQUENCE, with Cancel first so a mis-click has somewhere safe to land. The armed half is the whole point of benching this: it lives for four seconds, so it is otherwise near-impossible to look at properly."
        >
          <ArmedConfirmMatrix />
        </Section>

        <Section
          id="recovery-ladder"
          title="The recovery ladder"
          note="Ordered by what each rung PRESERVES, least-destructive first — never by how drastic the verb sounds. Every row states both halves; the destroys sentence is never softened, because it is the one that prevents regret. The blocked row shows a rung that cannot help this session type, saying why rather than offering a button whose only answer is 'unsupported'."
        >
          <RecoveryLadderMatrix />
        </Section>

        <Section
          id="bot-panel"
          title="The bot panel — per-bot settings (ASK 3)"
          note="The roster detail pane stopped GLANCING and became an editable, tabbed bot page: Overview (context ring HERO · tokens · provider · status · editable tags · working dir) · Instructions (role presets + desc, the model picker, notes, notifications — all launch-injected) · Tools (skills / connectors placeholders + MCP) · Activity (Schedules · Issues · Git). One component, three fidelities (pane here, sheet on mobile, and the popover it grew from). Section bodies are REUSED from session-info-panel, not reimplemented. Query-backed sub-sections show their offline empty states here."
        >
          <BotPanelBench theme={theme} />
        </Section>
      </div>
    </div>
  )
}

/** Resting and armed, side by side — the armed half cannot otherwise be held
 *  still long enough to review. */
function ArmedConfirmMatrix() {
  const resting: ArmedConfirm = {
    armed: false,
    press: () => {},
    cancel: () => {},
  }
  const armed: ArmedConfirm = { armed: true, press: () => {}, cancel: () => {} }
  return (
    <div className="flex flex-wrap items-start gap-8">
      <Plate label="resting — the action">
        <div className="p-3">
          <ArmedButton
            confirm={resting}
            label="Delete host"
            confirmLabel="Delete"
            icon={<Trash2 className="size-3.5" aria-hidden />}
          />
        </div>
      </Plate>
      <Plate label="armed — the consequence, 4s">
        <div className="p-3">
          <ArmedButton
            confirm={armed}
            label="Delete host"
            confirmLabel="Delete host"
          />
        </div>
      </Plate>
      <Plate label="armed — bulk verb">
        <div className="p-3">
          <ArmedButton
            confirm={armed}
            label="Delete all"
            confirmLabel="Delete 12"
          />
        </div>
      </Plate>
    </div>
  )
}

/** The canonical ladder, in both of its shapes: a session that CAN be
 *  recovered in place, and one that cannot (so the first rung is blocked). */
function RecoveryLadderMatrix() {
  return (
    <div className="flex flex-col gap-6">
      <Plate label="native + local — every rung available">
        <div className="p-3">
          <RecoveryLadder session={{ runtime: 'native', host_id: null }} />
        </div>
      </Plate>
      <Plate label="tmux — recover blocked, and says why">
        <div className="p-3">
          <RecoveryLadder session={{ runtime: 'tmux', host_id: null }} />
        </div>
      </Plate>
      <Plate label="auto-recovery toggle — the pref that had no UI">
        <div className="p-3">
          <AutoHealToggle enabled onChange={() => {}} />
        </div>
      </Plate>
    </div>
  )
}

export default function DevRoster() {
  return (
    <div className="min-h-dvh bg-paper" data-vr="dev-roster">
      {BENCH_THEMES.map((theme) => (
        <BenchPanel key={theme} theme={theme} />
      ))}
    </div>
  )
}
