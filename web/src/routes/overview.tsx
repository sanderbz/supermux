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
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Archive,
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
import { GroupHeader } from '@/components/session-tile/group-header'
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

// Status sort weight: active|waiting rank ahead of idle (feature-extract §1.2).
const STATUS_RANK: Record<ApiSession['status'], number> = {
  active: 0,
  starting: 0,
  waiting: 0,
  idle: 1,
  stopped: 2,
  error: 1,
}

/** Smart sort (the DEFAULT — current behaviour) per feature-extract §1.2:
 *  pinned-desc, running-desc, (active|waiting before idle), -last_activity. */
function smartSort(sessions: ApiSession[]): ApiSession[] {
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

/** Alphabetical by name (`alpha` mode). Locale-aware so non-ASCII names sort
 *  predictably — the user's mental model is "as I'd say it". */
function alphaSort(sessions: ApiSession[]): ApiSession[] {
  return [...sessions].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
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

/** A unit shown by the renderer. `group` items only ever appear in custom
 *  mode; the smart/alpha branches build a single-section "section" list with
 *  one big anonymous group. */
type RenderItem =
  | { type: 'group'; id: string; name: string; count: number }
  | { type: 'session'; session: ApiSession }

/** Build the ordered list of `RenderItem`s for the current sort mode. The
 *  session list is the ALREADY-FILTERED (search-applied) live set, so search
 *  still works in every mode (custom mode just filters within each group). */
function buildRenderItems(
  mode: SortMode,
  customOrder: LayoutItem[],
  filtered: ApiSession[],
): RenderItem[] {
  if (mode === 'smart') {
    return smartSort(filtered).map((s) => ({ type: 'session', session: s }))
  }
  if (mode === 'alpha') {
    return alphaSort(filtered).map((s) => ({ type: 'session', session: s }))
  }
  // Custom: walk the persisted order, skipping sessions filtered out by the
  // search box. Compute each group's count from the FILTERED set so the
  // header reads "Work · 2" when search hides half its tiles, which matches
  // user expectation ("I see what's there"). Sessions not in any group fall
  // before the first group header (the implicit "Ungrouped" bucket).
  const byName = new Map(filtered.map((s) => [s.name, s]))
  const items: RenderItem[] = []
  // Pass 1: compute group counts from the filtered set.
  const counts = new Map<string, number>()
  {
    let current: string | null = null
    for (const item of customOrder) {
      if (item.type === 'group') {
        current = item.id
        counts.set(current, 0)
      } else if (byName.has(item.name) && current !== null) {
        counts.set(current, (counts.get(current) ?? 0) + 1)
      }
    }
  }
  // Pass 2: emit the render list in the user's order.
  for (const item of customOrder) {
    if (item.type === 'group') {
      items.push({
        type: 'group',
        id: item.id,
        name: item.name,
        count: counts.get(item.id) ?? 0,
      })
    } else {
      const s = byName.get(item.name)
      if (s) items.push({ type: 'session', session: s })
    }
  }
  return items
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
  // open-state for the shell-mounted Archived sheet. The list endpoint is
  // light, so reading the count here costs one small request (no permanent
  // panel / always-on estate — the sheet itself is opt-in).
  const { archived } = useArchivedSessions()
  const openArchived = useArchivedSheet((s) => s.openSheet)
  const archivedCount = archived.length

  // Fork the density value/setter by viewport so phone and desktop sizes are
  // saved independently. We track the `md` boundary (the same breakpoint where
  // the grid starts forking column count) so the "mobile = single column =
  // height-only" invariant lines up with the value source. Below `md` the grid
  // is `grid-cols-1`, so the mobile tier can only ever change tile HEIGHT.
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
  // AT-D "Start a team": its own sheet (the ResponsiveSheet pattern), separate
  // from the new-session sheet so each affordance stays focused.
  const [teamSheetOpen, setTeamSheetOpen] = React.useState(false)
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

  // Keyboard shortcuts: `[` / `]` step through the density tiers (power-user
  // nicety). Ignored while typing in inputs/textareas/contentEditable so the
  // search field doesn't fight the shortcut. Guarded by modifiers so OS chord
  // keys (Cmd-[, Ctrl-]) — browser back/forward and tab-cycle bindings — pass
  // through untouched. Mobile silently ignores (the controls are hidden, but
  // we still let the keys through — they're harmless without a physical kbd).
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

  // Filter once, then sort/group per mode. Search runs in every mode.
  const filtered = React.useMemo(
    () => sessions.filter((s) => matches(s, query)),
    [sessions, query],
  )

  // Reconcile the persisted custom order with the LIVE session names — new
  // sessions float to the top of the implicit "Ungrouped" bucket; archived
  // sessions are pruned. We DO NOT auto-persist this reconciled view (the
  // user might be offline / mid-write); writes happen on explicit reorder.
  const reconciledCustom = React.useMemo(
    () =>
      reconcileCustomLayout(
        layout.custom,
        sessions.map((s) => s.name),
      ),
    [layout.custom, sessions],
  )

  const renderItems = React.useMemo(
    () => buildRenderItems(layout.mode, reconciledCustom, filtered),
    [layout.mode, reconciledCustom, filtered],
  )

  // The dnd-kit sortable identity for each item. Groups: `g:<id>`, sessions:
  // `s:<name>` — stable across renders so the drag handle re-binds correctly.
  const itemIds = React.useMemo(
    () => renderItems.map((it) => (it.type === 'group' ? `g:${it.id}` : `s:${it.session.name}`)),
    [renderItems],
  )

  const writeCustomOrder = React.useCallback(
    (nextOrder: LayoutItem[]) => {
      // The reconciled order is what the user sees, so it's the right base
      // for the persisted write — but persisting also implicitly accepts the
      // reconciliation (new sessions get pinned at the top). That is the
      // documented behaviour.
      const next: OverviewLayout = { ...layout, custom: nextOrder }
      setLayout(next)
    },
    [layout, setLayout],
  )

  // Inline create-group affordance. We deliberately AVOID `window.prompt` here:
  // the native dialog ignores the app's tokens (light/dark, radii, focus ring),
  // can't autofocus on iOS, and breaks the spring-language consistency of every
  // other create flow in the app (see <NewSessionSheet>, <GroupHeader> rename).
  // Instead, `addingGroup` toggles an in-place styled input row that mirrors
  // the rename UX on <GroupHeader> — Enter commits, Esc cancels, click-outside
  // commits (the common "I've moved on" gesture is treated as confirmation
  // when the field has text, dismissal when empty).
  const [addingGroup, setAddingGroup] = React.useState(false)

  const commitNewGroup = React.useCallback(
    (rawName: string) => {
      setAddingGroup(false)
      const name = rawName.trim()
      if (!name) return
      const next = [
        ...reconciledCustom,
        { type: 'group', id: newGroupId(), name } as LayoutItem,
      ]
      writeCustomOrder(next)
    },
    [reconciledCustom, writeCustomOrder],
  )

  const handleAddGroup = React.useCallback(() => {
    setAddingGroup(true)
  }, [])

  const handleRenameGroup = React.useCallback(
    (id: string, name: string) => {
      const next = reconciledCustom.map((it) =>
        it.type === 'group' && it.id === id ? { ...it, name } : it,
      )
      writeCustomOrder(next)
    },
    [reconciledCustom, writeCustomOrder],
  )

  const handleDeleteGroup = React.useCallback(
    (id: string) => {
      // Sessions inside the group survive — they flow back to the implicit
      // "Ungrouped" bucket at the top (the reconciler doesn't drop them).
      const ok = window.confirm(
        'Delete this group? Sessions inside it will move to Ungrouped.',
      )
      if (!ok) return
      const next = reconciledCustom.filter(
        (it) => !(it.type === 'group' && it.id === id),
      )
      writeCustomOrder(next)
    },
    [reconciledCustom, writeCustomOrder],
  )

  // dnd-kit sensors — pointer (mouse + trackpad), touch (long-press to avoid
  // hijacking scroll), keyboard for a11y.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      // 5px activation distance so a click doesn't accidentally initiate a
      // drag — important since the tile is itself clickable to focus.
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      // 200ms long-press + 5px tolerance: a quick tap or a vertical scroll
      // never triggers a drag on mobile; an intentional press-and-hold does.
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const [activeId, setActiveId] = React.useState<string | null>(null)
  const activeItem = React.useMemo(
    () => renderItems.find((_, i) => itemIds[i] === activeId) ?? null,
    [renderItems, itemIds, activeId],
  )
  const handleDragStart = React.useCallback((e: DragStartEvent) => {
    setActiveId(String(e.active.id))
  }, [])
  const handleDragCancel = React.useCallback(() => {
    setActiveId(null)
  }, [])
  const handleDragEnd = React.useCallback(
    (e: DragEndEvent) => {
      setActiveId(null)
      const { active, over } = e
      if (!over || active.id === over.id) return
      const oldIndex = itemIds.indexOf(String(active.id))
      const newIndex = itemIds.indexOf(String(over.id))
      if (oldIndex < 0 || newIndex < 0) return
      // arrayMove returns the SAME renderItems in a new order; map them back
      // to LayoutItems and persist.
      const movedRender = arrayMove(renderItems, oldIndex, newIndex)
      const nextLayout: LayoutItem[] = movedRender.map((it) =>
        it.type === 'group'
          ? { type: 'group', id: it.id, name: it.name }
          : { type: 'session', name: it.session.name },
      )
      writeCustomOrder(nextLayout)
    },
    [itemIds, renderItems, writeCustomOrder],
  )

  // Teams that survive the search box (matched by team name or any member name)
  // — TEAM CARDs render in every mode, so search filters them too.
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
  // "Any agent at all" = standalone sessions OR a detected team. Used to gate the
  // first-run empty state so a teams-only workspace doesn't show "No agents yet".
  const hasAnyAgent = hasSessions || teams.length > 0
  // First load (no cached data yet) with no error → show the skeleton grid.
  const showSkeleton = isLoading && !hasAnyAgent && !isError

  const openSheet = () => setSheetOpen(true)
  const openTeamSheet = () => setTeamSheetOpen(true)
  // The sheet owns create + boot (so it can surface a 409 inline); the route
  // just navigates into the new session's focus view (§5.1).
  const onCreated = (name: string) => {
    navigate(`/focus/${name}`)
  }
  // AT-D: the team sheet owns start + boot of the LEAD; the route navigates into
  // the lead's focus view, where the TEAM CARD appears once detection picks it up.
  const onTeamStarted = (name: string) => {
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

  // Desktop container widens at `lg` (polish-pass #3) — mobile/tablet keep
  // the existing max-w-6xl so nothing reflows below the breakpoint. The lg
  // max-width tracks the active density tier so wider cards (tier 3+) get
  // breathing room instead of crashing into the viewport edge. Tiers 1 & 2
  // share the historical baseline (same column count, just more vertical room).
  // All max-widths are concrete Tailwind literals so JIT compiles them.
  const containerMaxClass: Record<OverviewSize, string> = {
    1: 'lg:max-w-[82rem]',
    2: 'lg:max-w-[82rem]',
    3: 'lg:max-w-[86rem]',
    4: 'lg:max-w-[90rem]',
  }

  // Custom mode wraps the body in DndContext + SortableContext so any tile or
  // group is draggable. Smart / Alpha modes render the existing tile grid
  // EXACTLY as before — no DnD wrappers, no group rows, no extra DOM. That is
  // the "zero interference for users who don't opt in" guarantee.
  const isCustom = layout.mode === 'custom'

  return (
    // The hover float-over-slot architecture is preserved across tiers: the
    // grid auto-rows reserve the per-tier idle height (the tile sizes itself
    // from `sizeScale`), the tile floats inside its slot, and hover-growth
    // overflows downward without reflowing peers.
    <div
      // Mobile: the shell's full-width top bar collapsed to a top-right icon
      // (Fix 3), so this route now OWNS the safe-area top inset that the bar's
      // `pt-safe` used to provide — otherwise the grid would slide under the
      // notch / Dynamic Island. We fold the inset INTO the top padding via an
      // arbitrary value (`calc(env(safe-area-inset-top)+1rem)`) so it is robust
      // against utility ordering with `py-4`. From `sm` up the SideNav owns the
      // chrome and the larger `sm:py-6` / `sm:pt-6` applies (inset is mobile).
      className={`mx-auto flex h-full w-full max-w-6xl ${containerMaxClass[overviewSize]} flex-col px-3 py-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-5 sm:py-6 sm:pt-6`}
    >
      {/* ── Header: title + search + view toggle + sort + density + archived + new ──
          MHDR: the shell no longer floats a mobile ThemeToggle over this corner
          (layout.tsx <MobileTopBar> now returns null on mobile too), so the old
          `pr-12 sm:pr-0` right-pad reservation is reclaimed — giving the header
          its full width back so the controls fit without awkward wrapping. */}
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

        {/* Sort mode — a single icon-button popover. Hidden behind one click;
            shows the active mode glyph so the state is legible. ZERO visual
            change for non-engaged users (default = Smart = the existing sort). */}
        <SortControl value={layout.mode} onChange={setMode} />

        {/* Density / size control — surfaced at every breakpoint. On desktop it
            steps the full 4-tier curve (height, then column drops); on mobile
            (single-column grid) it only adjusts tile HEIGHT and is capped at the
            mobile max tier, with the value saved under a separate store field so
            phone and desktop sizes stay independent. Lives next to the view
            toggle so all the overview chrome controls cluster on the right per
            the polish-pass / Visual critic preference. */}
        {viewMode === 'tile' && (
          <OverviewSizeControl
            value={overviewSize}
            onChange={setOverviewSize}
            max={sizeMax}
            mobile={isMobile}
          />
        )}

        {/* Archived overflow item — a small, quiet entry into the recovery
            sheet. Shows the count when there's anything to recover ("Archived
            (N)"), else stays out of the way as a bare "Archived" affordance.
            Opt-in: no always-on panel, just this one cheap control. */}
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

        {/* AT-D "Start a team" trigger — mobile icon-button in the same cluster
            (matches the New-session / density / sort icon-button geometry).
            Quiet/secondary: a ghost outline, not the primary CTA, so it reads as
            the heavier-intent sibling of New session (no-extra-clicks: one tap
            opens the configure sheet). */}
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

        {/* Mobile new-session trigger — replaces the old floating FAB. Sits in
            the toolbar immediately right of Archived and borrows the icon-button
            geometry of the mobile density toggle / sort trigger (size-9 +
            rounded-lg + bg-muted) so the cluster reads as one button group.
            Desktop keeps its dedicated "New session" button below, so this is
            `sm:hidden`. Same `openSheet` handler the FAB used. */}
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

        {/* Desktop: a secondary (outline) "Start a team" beside the primary
            New-session CTA — distinct intent, calmer weight. */}
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
        {/* TEAM CARDs (AT-F-FRONT). Pinned ABOVE the session grid in EVERY sort
            mode (smart/alpha/custom) — server-formed, not draggable, not part of
            the dnd-kit sortable context. The lead's own session is excluded from
            the grid below so it renders only here, as the card's full tile. */}
        {filteredTeams.length > 0 && !showSkeleton && (
          // Mobile (< sm): stack the cards vertically as today — `flex-col`,
          // each card consumes the row regardless of its width tier (the card
          // itself collapses its tier below `sm`). Desktop (sm+): switch to
          // `flex-wrap` so cards with sub-Full widths can sit side-by-side
          // and Full cards still occupy the whole row (their `flex: 1 1 100%`
          // forces a wrap). `items-start` so a narrower card next to a taller
          // one doesn't stretch — each card keeps its natural height.
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
        ) : renderItems.length === 0 && filteredTeams.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<Search />}
              message={`No matches for “${query}”.`}
              cta={{ label: 'Clear search', onClick: () => setRawQuery('') }}
            />
          </div>
        ) : isCustom && viewMode === 'tile' ? (
          // Custom mode, tile view: dnd-kit-wrapped grid where group headers
          // are full-row dividers (col-span-full) and tiles flow normally.
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
              <div className={tileGridClass}>
                {renderItems.map((it, i) => {
                  const id = itemIds[i]
                  if (it.type === 'group') {
                    return (
                      <SortableGroupRow
                        key={id}
                        id={id}
                        name={it.name}
                        count={it.count}
                        onRename={(name) => handleRenameGroup(it.id, name)}
                        onDelete={() => handleDeleteGroup(it.id)}
                      />
                    )
                  }
                  return (
                    <SortableTile
                      key={id}
                      id={id}
                      session={toTileSession(it.session)}
                      sizeTier={overviewSize}
                      reduce={!!reduce}
                      tour={i === 0}
                    />
                  )
                })}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {activeItem && activeItem.type === 'session' ? (
                // The overlay is a faux-tile that follows the cursor; we keep
                // it static (no live-terminal) for performance.
                <div className="pointer-events-none rounded-lg border border-border bg-card/95 px-3 py-2 text-sm shadow-lg">
                  {activeItem.session.task_summary ?? activeItem.session.name}
                </div>
              ) : activeItem && activeItem.type === 'group' ? (
                <div className="pointer-events-none rounded-md border border-border bg-card/95 px-3 py-1.5 text-xs font-medium shadow-lg">
                  {activeItem.name}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : isCustom && viewMode === 'list' ? (
          // Custom mode, list view: same flat dnd-kit context, just rendering
          // SessionRow + group headers stacked vertically.
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1.5">
                {renderItems.map((it, i) => {
                  const id = itemIds[i]
                  if (it.type === 'group') {
                    return (
                      <SortableGroupRow
                        key={id}
                        id={id}
                        name={it.name}
                        count={it.count}
                        listView
                        onRename={(name) => handleRenameGroup(it.id, name)}
                        onDelete={() => handleDeleteGroup(it.id)}
                      />
                    )
                  }
                  return (
                    <SortableRow
                      key={id}
                      id={id}
                      session={toTileSession(it.session)}
                      reduce={!!reduce}
                      tour={i === 0}
                    />
                  )
                })}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {activeItem && activeItem.type === 'session' ? (
                <div className="pointer-events-none rounded-md border border-border bg-card/95 px-3 py-2 text-sm shadow-lg">
                  {activeItem.session.task_summary ?? activeItem.session.name}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : viewMode === 'tile' ? (
          // Smart / Alpha, tile view — renderItems drives ordering (single
          // shared selector across modes) and <LayoutGroup> keeps Framer's
          // layoutId morphs scoped so the tour anchor + focus-route transition
          // continue to animate the way main's pre-merge baseline did. The
          // density prop is `sizeTier` (card-sizes-rework API) — the old
          // numeric `sizeScale` prop was retired in main.
          <LayoutGroup>
            <div className={tileGridClass}>
              {renderItems.map(
                (it, i) =>
                  it.type === 'session' && (
                    <motion.div
                      key={it.session.name}
                      // M27: the first tile is the tour's "peek + focus" anchor.
                      data-tour={i === 0 ? 'tile' : undefined}
                      layout={!reduce}
                      layoutId={`session-${it.session.name}`}
                      transition={springs.smooth}
                    >
                      <SessionTile
                        session={toTileSession(it.session)}
                        sizeTier={overviewSize}
                      />
                    </motion.div>
                  ),
              )}
            </div>
          </LayoutGroup>
        ) : (
          <LayoutGroup>
            <div className="flex flex-col gap-1.5">
              {renderItems.map(
                (it, i) =>
                  it.type === 'session' && (
                    <motion.div
                      key={it.session.name}
                      data-tour={i === 0 ? 'tile' : undefined}
                      layout={!reduce}
                      layoutId={`session-${it.session.name}`}
                      transition={springs.smooth}
                    >
                      <SessionRow session={toTileSession(it.session)} />
                    </motion.div>
                  ),
              )}
            </div>
          </LayoutGroup>
        )}

        {/* "+ Add group" affordance — Custom mode only, at the bottom so it
            doesn't compete with tile content. Click expands into an inline
            styled input row (NO native window.prompt — the dialog ignores app
            tokens, can't be styled, and breaks the spring-language consistency
            of every other create flow in the app). */}
        {isCustom && hasSessions && (
          <div className="mt-4">
            {addingGroup ? (
              <AddGroupInput
                onCommit={commitNewGroup}
                onCancel={() => setAddingGroup(false)}
                reduce={!!reduce}
              />
            ) : (
              <button
                type="button"
                onClick={handleAddGroup}
                className="inline-flex h-11 min-h-11 items-center gap-1.5 rounded-md border border-dashed border-border/60 px-3 text-xs font-medium text-muted-foreground hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Add a new group"
              >
                <Plus className="size-3.5" aria-hidden />
                Add group
              </button>
            )}
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

/** A custom-mode tile wrapper. Uses dnd-kit's `useSortable` for keyboard +
 *  pointer drag; preserves the framer-motion `layoutId` so the focus-route
 *  view-transition morph still works (the tile's identity is its `name`).
 *
 *  We intentionally do NOT spread the dnd `listeners` onto the whole tile —
 *  the tile has clickable inner surfaces (peek, archive). Instead, a tiny
 *  drag handle is overlaid in the top-right corner; it has the listeners.
 *  This is a deliberate UX choice: the user must aim for the handle, so a
 *  stray click on the card body navigates to focus mode as it does today.
 *
 *  Touch: there is no hover on a coarse pointer, so the hover-revealed handle
 *  would be invisible — making grouping/reorder undiscoverable on mobile. We
 *  detect `(pointer: coarse)` and render the handle persistently (a visible
 *  grip) so it's a real, aimable grab target. The TouchSensor's 200ms
 *  long-press + 5px tolerance (see route sensors) means a tap or a vertical
 *  scroll still never starts a drag; only a deliberate press-and-hold on the
 *  grip does, so showing the handle does NOT hijack scroll. */
function SortableTile({
  id,
  session,
  sizeTier,
  reduce,
  tour,
}: {
  id: string
  session: TileSession
  sizeTier: OverviewSize
  reduce: boolean
  tour: boolean
}) {
  const coarse = useMediaQuery('(pointer: coarse)')
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    // The dragged tile floats above its peers + dims its slot so the empty
    // space is visible during the drag — standard dnd-kit pattern.
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      // `group/tile` so the handle's `group-hover/tile:opacity-100` reveal fires
      // from THIS wrapper on mouse hover (SessionTile's own root doesn't expose
      // the named group, so anchoring it here is what makes hover-reveal work).
      className="group/tile relative"
      data-tour={tour ? 'tile' : undefined}
    >
      <SessionTile session={session} sizeTier={sizeTier} />
      {/* Drag handle — top-right grab target. On a fine pointer it reveals on
          hover/focus; on a coarse pointer (touch) it's persistently visible so
          drag-to-group is discoverable. Either way the drag itself is gated by
          the TouchSensor's 200ms long-press, so a tap/scroll never drags. */}
      <button
        type="button"
        aria-label={`Drag ${session.name}`}
        title="Drag to reorder"
        {...attributes}
        {...listeners}
        // size-11 (44px) on coarse pointers so the grab target meets the HIG
        // touch minimum; size-9 (36px) for mouse where it's an aim-assisted
        // hover affordance. Hover-only opacity on fine pointers keeps it quiet
        // in idle; on coarse pointers it's persistently visible (no hover) so
        // dragging-to-group is discoverable on mobile.
        className={`absolute right-1 top-1 z-20 flex items-center justify-center rounded-md bg-card/80 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/tile:opacity-100 touch-none [@media(pointer:coarse)]:opacity-100 ${
          coarse
            ? 'size-11 text-muted-foreground/80'
            : 'size-9 text-muted-foreground/60 opacity-0'
        }`}
        // Stop the tile's onClick (peek/focus) from firing when the user
        // grabs the handle.
        onClick={(e) => e.stopPropagation()}
        // Hint to assistive tech.
        data-dnd-handle
        // Force-visible for reduce-motion users (the transition that would
        // reveal it on hover is suppressed). Coarse pointers are handled by the
        // class above (and `coarse` removes the `opacity-0` base), so no inline
        // override is needed there.
        style={{ opacity: reduce ? 1 : undefined }}
      >
        {/* Tiny chevron / grip glyph; sized to read at the corner without
            crowding the tile's status chip. */}
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="6" cy="4" r="0.75" fill="currentColor" />
          <circle cx="10" cy="4" r="0.75" fill="currentColor" />
          <circle cx="6" cy="8" r="0.75" fill="currentColor" />
          <circle cx="10" cy="8" r="0.75" fill="currentColor" />
          <circle cx="6" cy="12" r="0.75" fill="currentColor" />
          <circle cx="10" cy="12" r="0.75" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}

/** List-view sortable wrapper — same idea as `SortableTile` but the handle
 *  goes inline on the left (matches the file-list / kbd-accessory feel). */
function SortableRow({
  id,
  session,
  reduce,
  tour,
}: {
  id: string
  session: TileSession
  reduce: boolean
  tour: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-stretch gap-1"
      data-tour={tour ? 'tile' : undefined}
    >
      <button
        type="button"
        aria-label={`Drag ${session.name}`}
        {...attributes}
        {...listeners}
        className="flex w-7 items-center justify-center rounded-md text-muted-foreground/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-none"
        style={{ opacity: reduce ? 1 : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="6" cy="4" r="0.75" fill="currentColor" />
          <circle cx="10" cy="4" r="0.75" fill="currentColor" />
          <circle cx="6" cy="8" r="0.75" fill="currentColor" />
          <circle cx="10" cy="8" r="0.75" fill="currentColor" />
          <circle cx="6" cy="12" r="0.75" fill="currentColor" />
          <circle cx="10" cy="12" r="0.75" fill="currentColor" />
        </svg>
      </button>
      <div className="min-w-0 flex-1">
        <SessionRow session={session} />
      </div>
    </div>
  )
}

/** Sortable group divider row — spans the full grid width so it acts as a
 *  section break. `listView` makes it stack vertically in list-mode contexts. */
function SortableGroupRow({
  id,
  name,
  count,
  listView,
  onRename,
  onDelete,
}: {
  id: string
  name: string
  count: number
  listView?: boolean
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      // col-span-full in tile mode so the divider spans the entire grid row.
      // In list mode, the parent is a flex column so col-span has no effect
      // but doesn't hurt.
      className={listView ? '' : 'col-span-full'}
    >
      <GroupHeader
        id={id}
        name={name}
        count={count}
        dragListeners={{ ...attributes, ...listeners }}
        onRename={onRename}
        onDelete={onDelete}
      />
    </div>
  )
}

/** Inline "Add group" input. Replaces `window.prompt('Group name', …)`, which
 *  Visual + Principle critics correctly flagged: a native dialog ignores the
 *  app's tokens (radius / focus-ring / dark mode), can't autofocus reliably on
 *  iOS, and breaks the spring-language consistency of every other create flow
 *  (compare <NewSessionSheet> + <GroupHeader> rename — both styled inputs with
 *  the same h-11 hit-area + token-driven chrome).
 *
 *  UX contract (mirrors <GroupHeader> rename so the two read as one pattern):
 *    Enter   → commit (writes the trimmed name; empty = no-op + close)
 *    Esc     → cancel (close without writing)
 *    Blur    → commit (the "I clicked elsewhere" gesture confirms when the
 *              field has text; if empty the commit is a no-op so the user
 *              naturally backs out without losing what they typed elsewhere)
 *
 *  Spring-on-appear via the parent's reduce-motion check — same gating used by
 *  the FAB and tile transitions elsewhere on this route. */
function AddGroupInput({
  onCommit,
  onCancel,
  reduce,
}: {
  onCommit: (rawName: string) => void
  onCancel: () => void
  reduce: boolean
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // Track whether commit/cancel was triggered by a keyboard action so blur
  // doesn't double-fire onCommit (otherwise Enter → commit → blur → commit).
  const settledRef = React.useRef(false)

  React.useEffect(() => {
    inputRef.current?.focus()
    // No select() — defaultValue is empty so there's nothing to select; this
    // also matches the GroupHeader rename pattern (focus, no auto-select for
    // an empty field, select for a pre-populated one).
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
      // Spring-on-appear so the input arrives with the same motion language as
      // the rest of the chrome. `springs.cardExpand` (used by the FAB) reads
      // as "this surface just appeared" rather than "this is animating in".
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springs.cardExpand}
      className="inline-flex items-center gap-2"
    >
      {/* The input mirrors the border + focus-ring of <Input> primitive but
          stays inline-flex so it sits in the same line as the original button
          slot. min-h-11 keeps the hit-area HIG-grade on touch devices. */}
      <input
        ref={inputRef}
        type="text"
        placeholder="e.g. Work"
        aria-label="New group name"
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
      {/* Tiny escape hatch so mouse-only users have a discoverable cancel —
          Esc is the canonical gesture but not everyone reaches for it. The
          cancel button stops propagation so it doesn't trigger blur-commit
          on its way past the input. */}
      <button
        type="button"
        onMouseDown={(e) => {
          // Prevent the input from firing its blur-commit before our cancel
          // handler can run (mousedown precedes blur).
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

/** Overview density / size control (feat-overview-sizes).
 *
 *  Two forms by viewport (`mobile` prop, fed from `isMobile`):
 *
 *  - DESKTOP: a compact pair of icon buttons (− and +) sitting in the overview
 *    chrome next to the view-mode toggle. Walks the full 4-tier curve (height,
 *    then column drops). Unchanged from feat-overview-sizes — the `[`/`]`
 *    keyboard shortcuts still drive it via `overviewSize` upstream.
 *  - MOBILE (MHDR): a SINGLE size-9 (44pt) icon button that TOGGLES tier 1
 *    (Compact) ↔ 2 (Roomy). On the single-column mobile grid only those two
 *    tiers differ (tile HEIGHT — tiers 3/4 only drop columns, invisible at
 *    grid-cols-1), so a binary toggle is both clearer and smaller than the
 *    3-cell pill. Rows3 ↔ Rows2 communicate density + current state; a
 *    crossfade + spring scale/rotate animates the swap (honoring
 *    `useReducedMotion`), with `whileTap` press feedback and a
 *    `role="switch"` + `aria-pressed` + stateful aria-label.
 *
 *  Visual + Principle notes:
 *  - Matches the segmented-pill geometry of <ViewToggle> (h-9, rounded-lg,
 *    bg-muted) so the two cluster naturally — Visual critic gestalt.
 *  - Icon-only buttons; sentence-case aria-label / title ("Smaller" / "Larger"),
 *    no UPPERCASE per the Principle anti-vision rules.
 *  - Inner buttons are size-7 (28px) to match <ViewToggle>; the outer pill is
 *    h-9 (36px) so the hit-area on every interactive surface around it stays
 *    HIG-grade — the pill itself is the 44pt vertical target and the icon
 *    button extends to its edges via the rounded-md inset.
 *  - At the smallest / largest tier the relevant button is `disabled` —
 *    standard <button disabled> + Tailwind `disabled:opacity-40
 *    disabled:cursor-not-allowed` so the boundary is felt without breaking the
 *    keyboard tab order (the button stays focusable for screen readers).
 *  - No transition:all; the inner background morph uses `springs.snappy`
 *    (matches the <ViewToggle> active indicator) via Framer's layout id, so the
 *    state change shares motion language with the rest of the chrome.
 */
function OverviewSizeControl({
  value,
  onChange,
  max = MAX_OVERVIEW_SIZE,
  mobile = false,
}: {
  value: OverviewSize
  onChange: (s: OverviewSize) => void
  /** Upper tier bound — desktop passes MAX_OVERVIEW_SIZE, mobile passes the
   *  mobile cap so the control never steps onto a tier with no visible effect. */
  max?: OverviewSize
  /** MHDR: when true, render the compact single-icon density TOGGLE instead of
   *  the 4-tier `[ − N + ]` stepper. On mobile the grid is single-column and
   *  only tiers 1 (Compact) ↔ 2 (Roomy) differ (tile HEIGHT), so the stepper is
   *  effectively binary — a single tap target reads cleaner and reclaims header
   *  width. The caller passes `isMobile`. */
  mobile?: boolean
}) {
  const reduceMotion = useReducedMotion()

  // ── Mobile: single-icon toggle between tier 1 (Compact) ↔ tier 2 (Roomy) ──
  // The single-column mobile grid makes the density control binary (only HEIGHT
  // changes, tiers 3/4 are invisible), so one ~44pt tap target both shrinks the
  // footprint vs the 3-cell pill AND reads as native. Rows3 (more, shorter
  // rows = compact) ↔ Rows2 (fewer, taller rows = roomy) communicates tile
  // height and the CURRENT state at a glance.
  if (mobile) {
    const roomy = value >= MAX_OVERVIEW_SIZE_MOBILE
    // Tapping flips to the other tier, clamped to the valid mobile range.
    const next = (roomy ? MIN_OVERVIEW_SIZE : MAX_OVERVIEW_SIZE_MOBILE) as OverviewSize
    const Icon = roomy ? Rows2 : Rows3
    // aria reflects current state + what a tap does, per the spec.
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
          // Crossfade + small spring scale/rotate as the glyph swaps, keyed by
          // the active tier so AnimatePresence sees a new node on each toggle.
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

  // ── Desktop: existing 4-tier [ − N + ] stepper (unchanged) ──────────────────
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
      // Visible at every breakpoint — `flex` (was `hidden md:flex`). On mobile
      // the single-column grid means this only changes tile height; the caller
      // caps `max` so the + button disables at the last height-meaningful tier.
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
        // Per-tier label gives the user a quick confirmation of where they are
        // without bloating the chrome. Tabular nums keep width stable.
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
