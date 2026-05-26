import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from 'framer-motion'
import {
  Archive,
  FolderPlus,
  LayoutGrid,
  List,
  Minus,
  Plus,
  Rows2,
  Rows3,
  Search,
  TerminalSquare,
  Users,
  X,
} from 'lucide-react'

import { springs } from '@/lib/springs'
import { ONBOARDING } from '@/brand/copy'
import { useSessions, SESSIONS_KEY } from '@/hooks/use-sessions'
import { useTeams } from '@/hooks/use-teams'
import { TeamCard } from '@/components/team'
import { useArchivedSessions } from '@/hooks/use-archived-sessions'
import { useArchivedSheet } from '@/stores/archived-sheet-store'
import { useOverviewLayout } from '@/hooks/use-overview-layout'
import { useUI, type ViewMode } from '@/stores/ui-store'
import { onboardingApi, type ApiSession } from '@/lib/api'
import { SessionTile } from '@/components/session-tile'
import { SessionRow } from '@/components/session-tile/session-row'
import { TileSkeleton } from '@/components/session-tile/tile-skeleton'
import { NewSessionSheet } from '@/components/session-tile/new-session-sheet'
import { StartTeamSheet } from '@/components/session-tile/start-team-sheet'
import { SortControl } from '@/components/session-tile/sort-control'
import { GroupGrid } from '@/components/session-tile/group-grid'
import { useNewGroupAction } from '@/stores/new-group-store'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import {
  getOverviewSizeConfig,
  MAX_OVERVIEW_SIZE,
  MAX_OVERVIEW_SIZE_MOBILE,
  MIN_OVERVIEW_SIZE,
  type OverviewSize,
} from '@/lib/overview-size'
import { useMediaQuery } from '@/hooks/use-media-query'
import {
  newGroupId,
  reconcileCustomLayout,
  smartSort,
  nameSort,
  type LayoutItem,
  type OverviewLayout,
  type SortMode,
} from '@/lib/overview-layout'
import type { TileSession } from '@/components/session-tile'

/** Per-tier grid class — the tile grid keeps `sm:grid-cols-2` (small phones)
 *  and `md:grid-cols-N` (tablet) constant across tiers, then forks at `lg:`
 *  per the density config. The base `grid-cols-1` (true mobile, <sm) never
 *  changes regardless of tier, which is exactly why the mobile density control
 *  is HEIGHT-ONLY: stepping the tier moves `idleLines`/`idleBonusPx` (height)
 *  but the column count is pinned at 1 below `sm`. See <OverviewSizeControl>. */
function gridClassFor(tier: OverviewSize): string {
  const cfg = getOverviewSizeConfig(tier)
  // Tailwind needs concrete class names at build time; map per tier.
  const lg =
    cfg.gridColsLg === 4
      ? 'lg:grid-cols-4'
      : cfg.gridColsLg === 3
        ? 'lg:grid-cols-3'
        : cfg.gridColsLg === 2
          ? 'lg:grid-cols-2'
          : 'lg:grid-cols-1'
  const md =
    cfg.gridColsMd === 3
      ? 'md:grid-cols-3'
      : cfg.gridColsMd === 2
        ? 'md:grid-cols-2'
        : 'md:grid-cols-1'
  return `grid grid-cols-1 gap-2 sm:grid-cols-2 ${md} ${lg}`
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
  const { sessions: allSessions, isLoading, isError, refetch } = useSessions()
  // Agent Teams (AT-F-FRONT). The TEAM CARD owns its lead + teammates and renders
  // pinned above the session grid in EVERY sort mode. The lead IS a normal
  // supermux session, so we must EXCLUDE it from the standalone grid (it renders
  // as the team card's full tile) to avoid double-rendering; teammates are NOT in
  // /api/sessions so they never appear in the grid at all.
  const { teams } = useTeams()
  const leadSessionNames = React.useMemo(() => {
    const s = new Set<string>()
    for (const t of teams) {
      if (t.lead_supermux_session) s.add(t.lead_supermux_session)
    }
    return s
  }, [teams])
  const sessions = React.useMemo(
    () => allSessions.filter((s) => !leadSessionNames.has(s.name)),
    [allSessions, leadSessionNames],
  )
  const { layout, setMode, setLayout } = useOverviewLayout()
  const viewMode = useUI((s) => s.viewMode)
  const setViewMode = useUI((s) => s.setViewMode)
  const overviewSizeDesktop = useUI((s) => s.overviewSize)
  const setOverviewSizeDesktop = useUI((s) => s.setOverviewSize)
  const overviewSizeMobile = useUI((s) => s.overviewSizeMobile)
  const setOverviewSizeMobile = useUI((s) => s.setOverviewSizeMobile)
  const navigate = useNavigate()
  const reduce = useReducedMotion()

  // Archived sessions: a cheap count for the overflow item + the shared
  // open-state for the shell-mounted Archived sheet.
  const { archived } = useArchivedSessions()
  const openArchived = useArchivedSheet((s) => s.openSheet)
  const archivedCount = archived.length

  // Fork the density value/setter by viewport so phone and desktop sizes are
  // saved independently.
  const isMobile = useMediaQuery('(max-width: 767px)')
  const overviewSize = isMobile ? overviewSizeMobile : overviewSizeDesktop
  const setOverviewSize = isMobile
    ? setOverviewSizeMobile
    : setOverviewSizeDesktop
  const sizeMax = isMobile ? MAX_OVERVIEW_SIZE_MOBILE : MAX_OVERVIEW_SIZE

  const tileGridClass = React.useMemo(
    () => gridClassFor(overviewSize),
    [overviewSize],
  )

  const [rawQuery, setRawQuery] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [teamSheetOpen, setTeamSheetOpen] = React.useState(false)
  const [bootingDemo, setBootingDemo] = React.useState(false)

  useDevMockSeed()

  // Debounce the search 200ms.
  React.useEffect(() => {
    const id = setTimeout(() => setQuery(rawQuery), 200)
    return () => clearTimeout(id)
  }, [rawQuery])

  // Keyboard shortcuts: `[` / `]` step through the density tiers.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' && e.key !== ']') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          t.isContentEditable
        ) {
          return
        }
      }
      e.preventDefault()
      if (e.key === '[') {
        if (overviewSize > MIN_OVERVIEW_SIZE) {
          setOverviewSize((overviewSize - 1) as OverviewSize)
        }
      } else {
        if (overviewSize < sizeMax) {
          setOverviewSize((overviewSize + 1) as OverviewSize)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overviewSize, setOverviewSize, sizeMax])

  // Filter once.
  const filtered = React.useMemo(
    () => sessions.filter((s) => matches(s, query)),
    [sessions, query],
  )

  // Reconcile the persisted custom order with the LIVE session names.
  const reconciledCustom = React.useMemo(
    () =>
      reconcileCustomLayout(
        layout.custom,
        sessions.map((s) => s.name),
      ),
    [layout.custom, sessions],
  )

  // ── Add-group flow (replaces the lonely bottom button) ─────────────────────
  // `addingGroup.at` is the LayoutItem[] index at which the new group should
  // be inserted. `null` = no add-group input visible; a number = the inline
  // styled input is open and on commit the group lands at that index.
  // - Hover-gap clicks set `at = <gap index>` so the new group lands between
  //   the appropriate sections.
  // - The header "New group" button + `g n` shortcut + Command Palette entry
  //   set `at = reconciledCustom.length` (append to the end), per the spec
  //   "all three create at the END unless invoked from a hover gap."
  const [addingGroup, setAddingGroup] = React.useState<{ at: number } | null>(
    null,
  )

  const writeCustomOrder = React.useCallback(
    (nextOrder: LayoutItem[]) => {
      const next: OverviewLayout = { ...layout, custom: nextOrder }
      setLayout(next)
    },
    [layout, setLayout],
  )

  const commitNewGroup = React.useCallback(
    (rawName: string, atIndex: number) => {
      setAddingGroup(null)
      const name = rawName.trim()
      if (!name) return
      const next = [...reconciledCustom]
      // The hover-gap indexes are SECTION-based (0 = above the first section,
      // 1 = between section 0 and 1, …). Convert that into a LayoutItem index
      // by counting items until we've crossed the requested number of group
      // headers. Section 0 starts at item 0 (the implicit Ungrouped header is
      // virtual, NOT in the layout list, so a gap of 1 puts the new group
      // BEFORE the first real group header).
      let layoutIdx = 0
      let groupsCrossed = 0
      while (layoutIdx < next.length && groupsCrossed < atIndex) {
        if (next[layoutIdx].type === 'group') groupsCrossed += 1
        if (groupsCrossed < atIndex) layoutIdx += 1
      }
      // If we got here at the end without crossing all requested gaps, the
      // insertion is at the tail.
      next.splice(layoutIdx, 0, {
        type: 'group',
        id: newGroupId(),
        name,
      })
      writeCustomOrder(next)
    },
    [reconciledCustom, writeCustomOrder],
  )

  const handleNewGroupAtEnd = React.useCallback(() => {
    setAddingGroup({ at: Number.MAX_SAFE_INTEGER })
  }, [])

  const handleNewGroupAtGap = React.useCallback((gapIndex: number) => {
    setAddingGroup({ at: gapIndex })
  }, [])

  // Custom mode wraps the body in DndContext + SortableContext so any tile or
  // group is draggable. Smart / Alpha modes render the existing tile grid
  // EXACTLY as before — no DnD wrappers, no group rows, no extra DOM.
  const isCustom = layout.mode === 'custom'

  // ── Keyboard: `g n` chord opens the new-group input ────────────────────────
  // Power-user chord: press `g`, then `n` within 1.2s. Ignored while typing in
  // form fields / during modifiers. Custom-mode only (groups don't exist
  // elsewhere); auto-flips the layout into custom when a non-custom mode is
  // active and the user creates a group, so the new group is visible right
  // away (anti-frustration: the gesture works regardless of current mode).
  const lastGRef = React.useRef<number>(0)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          t.isContentEditable
        ) {
          return
        }
      }
      const now = Date.now()
      if (e.key === 'g') {
        lastGRef.current = now
        return
      }
      if (e.key === 'n' && now - lastGRef.current <= 1200) {
        e.preventDefault()
        lastGRef.current = 0
        // If we're not in custom mode, flip there first so the group becomes
        // visible (spec: "all three create at the END unless invoked from a
        // hover gap"; we surface the chord even outside custom mode).
        if (layout.mode !== 'custom') setMode('custom')
        setAddingGroup({ at: Number.MAX_SAFE_INTEGER })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layout.mode, setMode])

  // ── Command-Palette entry "New group" ──────────────────────────────────────
  // Surfaced via a tiny zustand store the palette reads (see
  // `web/src/stores/new-group-store.ts`); set the action handler while the
  // overview is mounted, clear it on unmount so dispatch never targets stale
  // closures.
  const setNewGroupAction = useNewGroupAction((s) => s.setAction)
  React.useEffect(() => {
    setNewGroupAction(() => {
      if (layout.mode !== 'custom') setMode('custom')
      setAddingGroup({ at: Number.MAX_SAFE_INTEGER })
    })
    return () => setNewGroupAction(null)
  }, [setNewGroupAction, layout.mode, setMode])

  // Teams that survive the search box.
  const filteredTeams = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return teams
    return teams.filter(
      (t) =>
        t.team_name.toLowerCase().includes(needle) ||
        t.members.some((m) => m.name.toLowerCase().includes(needle)) ||
        (t.lead_supermux_session ?? '').toLowerCase().includes(needle),
    )
  }, [teams, query])

  const hasSessions = sessions.length > 0
  const hasAnyAgent = hasSessions || teams.length > 0
  const showSkeleton = isLoading && !hasAnyAgent && !isError

  const openSheet = () => setSheetOpen(true)
  const openTeamSheet = () => setTeamSheetOpen(true)
  const onCreated = (name: string) => {
    navigate(`/focus/${name}`)
  }
  const onTeamStarted = (name: string) => {
    navigate(`/focus/${name}`)
  }

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

  const containerMaxClass: Record<OverviewSize, string> = {
    1: 'lg:max-w-[82rem]',
    2: 'lg:max-w-[82rem]',
    3: 'lg:max-w-[86rem]',
    4: 'lg:max-w-[90rem]',
  }

  // The non-custom (smart / alpha) tile list — computed here so the renderer
  // below is pure JSX.
  const flatSorted = React.useMemo(() => {
    if (layout.mode === 'smart') return smartSort(filtered)
    if (layout.mode === 'alpha') return nameSort(filtered)
    return filtered
  }, [filtered, layout.mode])

  return (
    <div
      className={`mx-auto flex h-full w-full max-w-6xl ${containerMaxClass[overviewSize]} flex-col px-3 py-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-5 sm:py-6 sm:pt-6`}
    >
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-1 text-2xl font-semibold tracking-tight">Overview</h1>

        <div className="relative order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search sessions and teams"
            aria-label="Search sessions and teams"
            className="h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-9 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

        <SortControl value={layout.mode} onChange={setMode} />

        {viewMode === 'tile' && (
          <OverviewSizeControl
            value={overviewSize}
            onChange={setOverviewSize}
            max={sizeMax}
            mobile={isMobile}
          />
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={openArchived}
          aria-label={
            archivedCount > 0
              ? `View ${archivedCount} archived session${archivedCount === 1 ? '' : 's'}`
              : 'View archived sessions'
          }
          title="Archived sessions"
          className="text-muted-foreground hover:text-foreground"
        >
          <Archive />
          <span className="hidden sm:inline">
            {archivedCount > 0 ? `Archived (${archivedCount})` : 'Archived'}
          </span>
        </Button>

        {/* Persistent "New group" button — header (top right of the overview).
            Replaces the previous bottom-of-page button per the 2026 spec.
            Visible in EVERY sort mode: clicking from a non-custom mode auto-
            flips the layout into custom + opens the inline AddGroupInput so
            the new group is immediately visible. Custom-mode only chrome
            would be surprising. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (layout.mode !== 'custom') setMode('custom')
            handleNewGroupAtEnd()
          }}
          aria-label="New group"
          title="New group (g n)"
          data-vr="header-new-group"
          className="text-muted-foreground hover:text-foreground"
        >
          <FolderPlus />
          <span className="hidden sm:inline">New group</span>
        </Button>

        <motion.button
          type="button"
          onClick={openTeamSheet}
          aria-label="Start a team"
          title="Start a team"
          data-tour="start-team"
          whileTap={reduce ? undefined : { scale: 0.9 }}
          transition={springs.snappy}
          className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:text-foreground sm:hidden"
        >
          <Users className="size-4" />
        </motion.button>

        <motion.button
          type="button"
          onClick={openSheet}
          aria-label="New session"
          title="New session"
          whileTap={reduce ? undefined : { scale: 0.9 }}
          transition={springs.snappy}
          className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:text-foreground sm:hidden"
        >
          <Plus className="size-4" />
        </motion.button>

        <Button
          variant="outline"
          onClick={openTeamSheet}
          data-tour="start-team"
          className="hidden sm:inline-flex"
        >
          <Users />
          Start a team
        </Button>

        <Button onClick={openSheet} className="hidden sm:inline-flex">
          <Plus />
          New session
        </Button>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1">
        {filteredTeams.length > 0 && !showSkeleton && (
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
            {filteredTeams.map((team) => (
              <TeamCard
                key={team.team_name}
                team={team}
                sizeTier={overviewSize}
                customMode={isCustom}
              />
            ))}
          </div>
        )}

        {showSkeleton ? (
          <div className={tileGridClass}>
            {Array.from({ length: 8 }).map((_, i) => (
              <TileSkeleton key={i} />
            ))}
          </div>
        ) : isError && !hasAnyAgent ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<TerminalSquare />}
              message="Can’t reach supermux-server. Retrying…"
              cta={{ label: 'Retry now', onClick: () => refetch() }}
            />
          </div>
        ) : !hasAnyAgent ? (
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
        ) : (!isCustom && flatSorted.length === 0 && filteredTeams.length === 0) ||
          (isCustom &&
            reconciledCustom.filter(
              (it) =>
                it.type === 'session' &&
                filtered.some((s) => s.name === it.name),
            ).length === 0 &&
            filteredTeams.length === 0) ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<Search />}
              message={`No matches for “${query}”.`}
              cta={{ label: 'Clear search', onClick: () => setRawQuery('') }}
            />
          </div>
        ) : isCustom && viewMode === 'tile' ? (
          <GroupGrid
            layoutItems={reconciledCustom}
            filteredSessions={filtered}
            onLayoutChange={writeCustomOrder}
            sizeTier={overviewSize}
            tileGridClass={tileGridClass}
            viewMode="tile"
            onRequestNewGroupAt={handleNewGroupAtGap}
            tourFirstTileId="tile"
          />
        ) : isCustom && viewMode === 'list' ? (
          <GroupGrid
            layoutItems={reconciledCustom}
            filteredSessions={filtered}
            onLayoutChange={writeCustomOrder}
            sizeTier={overviewSize}
            tileGridClass={tileGridClass}
            viewMode="list"
            onRequestNewGroupAt={handleNewGroupAtGap}
            tourFirstTileId="tile"
          />
        ) : viewMode === 'tile' ? (
          <LayoutGroup>
            <div className={tileGridClass}>
              {flatSorted.map((s, i) => (
                <motion.div
                  key={s.name}
                  data-tour={i === 0 ? 'tile' : undefined}
                  layout={!reduce}
                  layoutId={`session-${s.name}`}
                  transition={springs.smooth}
                >
                  <SessionTile session={toTileSession(s)} sizeTier={overviewSize} />
                </motion.div>
              ))}
            </div>
          </LayoutGroup>
        ) : (
          <LayoutGroup>
            <div className="flex flex-col gap-1.5">
              {flatSorted.map((s, i) => (
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
          </LayoutGroup>
        )}

        {/* The inline AddGroupInput — appears wherever the user invoked it
            (hover gap / header button / `g n` shortcut / palette). Renders
            BELOW the body so the inline input is always visible, regardless
            of where the new group will land. Anti-anti-pattern: NO
            window.prompt (the native dialog ignores the app's tokens / focus
            ring / dark mode and breaks the spring-language consistency of
            every other create flow). */}
        {isCustom && addingGroup && (
          <div className="mt-3" data-vr="add-group-input">
            <AddGroupInput
              hint={
                addingGroup.at === Number.MAX_SAFE_INTEGER
                  ? 'Add a new group at the end'
                  : `Add a new group at position ${addingGroup.at + 1}`
              }
              onCommit={(name) => commitNewGroup(name, addingGroup.at)}
              onCancel={() => setAddingGroup(null)}
              reduce={!!reduce}
            />
          </div>
        )}
      </div>

      <NewSessionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCreated={onCreated}
      />

      <StartTeamSheet
        open={teamSheetOpen}
        onOpenChange={setTeamSheetOpen}
        onStarted={onTeamStarted}
      />
    </div>
  )
}

/** Inline "Add group" input — Enter commits, Esc cancels, blur commits. */
function AddGroupInput({
  hint,
  onCommit,
  onCancel,
  reduce,
}: {
  hint: string
  onCommit: (rawName: string) => void
  onCancel: () => void
  reduce: boolean
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const settledRef = React.useRef(false)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commit = () => {
    if (settledRef.current) return
    settledRef.current = true
    onCommit(inputRef.current?.value ?? '')
  }
  const cancel = () => {
    if (settledRef.current) return
    settledRef.current = true
    onCancel()
  }

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springs.cardExpand}
      className="inline-flex items-center gap-2"
      role="group"
      aria-label={hint}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="e.g. Work"
        aria-label={hint}
        defaultValue=""
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        onBlur={commit}
        className="h-11 min-h-11 w-48 rounded-md border border-input bg-transparent px-3 text-base md:text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault()
          cancel()
        }}
        aria-label="Cancel adding group"
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden />
      </button>
    </motion.div>
  )
}

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

function OverviewSizeControl({
  value,
  onChange,
  max = MAX_OVERVIEW_SIZE,
  mobile = false,
}: {
  value: OverviewSize
  onChange: (s: OverviewSize) => void
  max?: OverviewSize
  mobile?: boolean
}) {
  const reduceMotion = useReducedMotion()

  if (mobile) {
    const roomy = value >= MAX_OVERVIEW_SIZE_MOBILE
    const next = (roomy ? MIN_OVERVIEW_SIZE : MAX_OVERVIEW_SIZE_MOBILE) as OverviewSize
    const Icon = roomy ? Rows2 : Rows3
    const label = roomy
      ? 'Tile size: Roomy — tap for Compact'
      : 'Tile size: Compact — tap for Roomy'
    return (
      <motion.button
        type="button"
        role="switch"
        aria-label={label}
        aria-pressed={roomy}
        title={label}
        onClick={() => onChange(next)}
        whileTap={reduceMotion ? undefined : { scale: 0.9 }}
        className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:text-foreground"
      >
        {reduceMotion ? (
          <Icon className="size-4" />
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={roomy ? 'roomy' : 'compact'}
              initial={{ opacity: 0, scale: 0.6, rotate: -12 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.6, rotate: 12 }}
              transition={springs.toggleSnap}
              className="flex items-center justify-center"
            >
              <Icon className="size-4" />
            </motion.span>
          </AnimatePresence>
        )}
      </motion.button>
    )
  }

  const cfg = getOverviewSizeConfig(value)
  const atMin = value <= MIN_OVERVIEW_SIZE
  const atMax = value >= max
  const dec = () => {
    if (!atMin) onChange((value - 1) as OverviewSize)
  }
  const inc = () => {
    if (!atMax) onChange((value + 1) as OverviewSize)
  }
  return (
    <div
      role="group"
      aria-label="Overview density"
      className="flex h-9 items-center gap-1 rounded-lg bg-muted p-1"
    >
      <button
        type="button"
        aria-label="Smaller"
        title="Smaller"
        onClick={dec}
        disabled={atMin}
        className="relative flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <Minus className="relative size-4" />
      </button>
      <span
        aria-hidden
        className="select-none px-1 text-[11px] font-medium tabular-nums text-muted-foreground"
        title={`Density: ${cfg.label}`}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label="Larger"
        title="Larger"
        onClick={inc}
        disabled={atMax}
        className="relative flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <Plus className="relative size-4" />
      </button>
    </div>
  )
}

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
