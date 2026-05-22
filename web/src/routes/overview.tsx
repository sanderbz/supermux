import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { LayoutGrid, List, Plus, Search, TerminalSquare, X } from 'lucide-react'

import { springs } from '@/lib/springs'
import { ONBOARDING } from '@/brand/copy'
import { useSessions, SESSIONS_KEY } from '@/hooks/use-sessions'
import { useUI, type ViewMode } from '@/stores/ui-store'
import { onboardingApi, type ApiSession } from '@/lib/api'
import { SessionTile } from '@/components/session-tile'
import { SessionRow } from '@/components/session-tile/session-row'
import { TileSkeleton } from '@/components/session-tile/tile-skeleton'
import { NewSessionSheet } from '@/components/session-tile/new-session-sheet'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import type { TileSession } from '@/components/session-tile'

const TILE_GRID =
  'grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'

// Status sort weight: active|waiting rank ahead of idle (feature-extract §1.2).
const STATUS_RANK: Record<ApiSession['status'], number> = {
  active: 0,
  starting: 0,
  waiting: 0,
  idle: 1,
  stopped: 2,
  error: 1,
}

/** Sort sessions per feature-extract §1.2:
 *  pinned-desc, running-desc, (active|waiting before idle), -last_activity. */
function sortSessions(sessions: ApiSession[]): ApiSession[] {
  return [...sessions].sort((a, b) => {
    const pin = Number(b.pinned ?? false) - Number(a.pinned ?? false)
    if (pin !== 0) return pin
    const run = Number(b.running ?? false) - Number(a.running ?? false)
    if (run !== 0) return run
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rank !== 0) return rank
    const aAct = a.last_activity ?? activityFrom(a.updated_at)
    const bAct = b.last_activity ?? activityFrom(b.updated_at)
    return bAct - aAct
  })
}

function activityFrom(updatedAt?: string): number {
  if (!updatedAt) return 0
  const t = Date.parse(updatedAt)
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000)
}

/** Filter by name / description / tags (case-insensitive). */
function matches(session: ApiSession, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  if (session.name.toLowerCase().includes(needle)) return true
  if (session.task_summary?.toLowerCase().includes(needle)) return true
  if (session.desc?.toLowerCase().includes(needle)) return true
  if (session.tags?.some((t) => t.toLowerCase().includes(needle))) return true
  return false
}

/** Coerce the wire shape to the tile's `TileSession` (the tile requires a string
 *  `updated_at`; the API leaves it optional for partial deltas). */
function toTileSession(s: ApiSession): TileSession {
  return { ...s, updated_at: s.updated_at ?? '' }
}

export function Overview() {
  const { sessions, isLoading, isError, refetch } = useSessions()
  const viewMode = useUI((s) => s.viewMode)
  const setViewMode = useUI((s) => s.setViewMode)
  const navigate = useNavigate()
  const reduce = useReducedMotion()

  const [rawQuery, setRawQuery] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [sheetOpen, setSheetOpen] = React.useState(false)
  // M27: one-tap demo agent. `bootingDemo` disables the button + shows a busy
  // label while the `/cso` agent is created so a double-tap can't double-boot.
  const [bootingDemo, setBootingDemo] = React.useState(false)

  // DEV-only: seed the sessions cache from the M11 mocks when the route is
  // opened with `?mock=1`, so the full overview (grid/list morph, search, FAB)
  // can be dogfooded without a backend. Never active in a production build
  // (guarded by `import.meta.env.DEV`, so the dynamic import is tree-shaken).
  useDevMockSeed()

  // Debounce the search 200ms so the grid doesn't re-filter on every keystroke.
  React.useEffect(() => {
    const id = setTimeout(() => setQuery(rawQuery), 200)
    return () => clearTimeout(id)
  }, [rawQuery])

  const sorted = React.useMemo(() => sortSessions(sessions), [sessions])
  const visible = React.useMemo(
    () => sorted.filter((s) => matches(s, query)),
    [sorted, query],
  )

  const hasSessions = sessions.length > 0
  // First load (no cached data yet) with no error → show the skeleton grid.
  const showSkeleton = isLoading && !hasSessions && !isError

  const openSheet = () => setSheetOpen(true)
  // The sheet owns create + boot (so it can surface a 409 inline); the route
  // just navigates into the new session's focus view (§5.1).
  const onCreated = (name: string) => {
    navigate(`/focus/${name}`)
  }

  // M27: secondary first-run CTA — boot a `/cso` demo agent in the server's
  // working directory and drop the user straight into its focus view, so the
  // first 60 seconds end on visible agent output. Failure is non-fatal: the
  // button just re-enables (the empty state stays put).
  const bootDemo = async () => {
    if (bootingDemo) return
    setBootingDemo(true)
    try {
      const created = await onboardingApi.bootDemoAgent('.')
      navigate(`/focus/${created.name}`)
    } catch {
      setBootingDemo(false)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-3 py-4 sm:px-5 sm:py-6">
      {/* ── Header: title + search + view toggle + (desktop) new button ─── */}
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-1 text-2xl font-semibold tracking-tight">Overview</h1>

        <div className="relative order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-9 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {rawQuery && (
            <button
              type="button"
              onClick={() => setRawQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <ViewToggle value={viewMode} onChange={setViewMode} />

        <Button onClick={openSheet} className="hidden sm:inline-flex">
          <Plus />
          New session
        </Button>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1">
        {showSkeleton ? (
          <div className={TILE_GRID}>
            {Array.from({ length: 8 }).map((_, i) => (
              <TileSkeleton key={i} />
            ))}
          </div>
        ) : isError && !hasSessions ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<TerminalSquare />}
              message="Can’t reach supermux-server. Retrying…"
              cta={{ label: 'Retry now', onClick: () => refetch() }}
            />
          </div>
        ) : !hasSessions ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<TerminalSquare />}
              message="No agents yet. Boot your first one."
              cta={{ label: 'Boot first agent', onClick: openSheet }}
              secondary={{
                label: bootingDemo
                  ? ONBOARDING.demoBooting
                  : ONBOARDING.demoCta,
                onClick: bootDemo,
                busy: bootingDemo,
                hint: ONBOARDING.demoHint,
              }}
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<Search />}
              message={`No matches for “${query}”.`}
              cta={{ label: 'Clear search', onClick: () => setRawQuery('') }}
            />
          </div>
        ) : viewMode === 'tile' ? (
          <div className={TILE_GRID}>
            {visible.map((s, i) => (
              <motion.div
                key={s.name}
                // M27: the first tile is the tour's "peek + focus" anchor.
                data-tour={i === 0 ? 'tile' : undefined}
                layout={!reduce}
                layoutId={`session-${s.name}`}
                transition={springs.smooth}
              >
                <SessionTile session={toTileSession(s)} />
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {visible.map((s, i) => (
              <motion.div
                key={s.name}
                data-tour={i === 0 ? 'tile' : undefined}
                layout={!reduce}
                layoutId={`session-${s.name}`}
                transition={springs.smooth}
              >
                <SessionRow session={toTileSession(s)} />
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* ── FAB (mobile only — desktop has the header button) ─────────────── */}
      <AnimatePresence>
        {!sheetOpen && (
          <motion.button
            type="button"
            onClick={openSheet}
            aria-label="New session"
            initial={reduce ? false : { scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={reduce ? undefined : { scale: 0, opacity: 0 }}
            whileTap={reduce ? undefined : { scale: 0.92 }}
            transition={springs.cardExpand}
            className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-4 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg sm:hidden"
          >
            <Plus className="size-6" />
          </motion.button>
        )}
      </AnimatePresence>

      <NewSessionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCreated={onCreated}
      />
    </div>
  )
}

/** DEV-only sessions-cache seed (see call site). No-op in production: the body
 *  is fully guarded by `import.meta.env.DEV`, and the mock module is loaded via a
 *  dynamic import so it's tree-shaken out of the production bundle. */
function useDevMockSeed() {
  const qc = useQueryClient()
  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(window.location.search).has('mock')) return
    let alive = true
    void import('@/components/session-tile/mock').then(({ MOCK_TILES }) => {
      if (alive) qc.setQueryData(SESSIONS_KEY, MOCK_TILES as ApiSession[])
    })
    return () => {
      alive = false
    }
  }, [qc])
}

/** Tile / List segmented control. Reads + writes the persisted `useUI` store
 *  (§4.6), so the choice survives a browser restart. */
function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode
  onChange: (v: ViewMode) => void
}) {
  const items: { mode: ViewMode; icon: typeof LayoutGrid; label: string }[] = [
    { mode: 'tile', icon: LayoutGrid, label: 'Tile view' },
    { mode: 'list', icon: List, label: 'List view' },
  ]
  return (
    <div
      role="group"
      aria-label="View mode"
      className="flex h-9 items-center gap-1 rounded-lg bg-muted p-1"
    >
      {items.map(({ mode, icon: Icon, label }) => {
        const active = value === mode
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => onChange(mode)}
            className="relative flex size-7 items-center justify-center rounded-md text-muted-foreground aria-pressed:text-foreground"
          >
            {active && (
              <motion.span
                layoutId="view-toggle-active"
                transition={springs.snappy}
                className="absolute inset-0 rounded-md bg-card shadow-sm"
              />
            )}
            <Icon className="relative size-4" />
          </button>
        )
      })}
    </div>
  )
}
