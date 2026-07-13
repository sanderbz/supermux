import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import {
  Archive,
  EyeOff,
  FolderPlus,
  LayoutGrid,
  List,
  Minus,
  Plus,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react'

import { springs } from '@/lib/springs'
import { useSessions, SESSIONS_KEY } from '@/hooks/use-sessions'
import { useTeams } from '@/hooks/use-teams'
import { splitTeamLeads } from '@/components/focus-mode/focus-strip-groups'
import { TeamCard } from '@/components/team'
import { useArchivedSessions } from '@/hooks/use-archived-sessions'
import { useArchivedSheet } from '@/stores/archived-sheet-store'
import { useOverviewLayout } from '@/hooks/use-overview-layout'
import { useUI, type ViewMode } from '@/stores/ui-store'
import { type ApiSession } from '@/lib/api'
import { SessionTile } from '@/components/session-tile'
import { SessionRow } from '@/components/session-tile/session-row'
import {
  JumpIndexProvider,
  type JumpIndexMap,
} from '@/components/session-tile/jump-index-context'
import { TileSkeleton } from '@/components/session-tile/tile-skeleton'
import { NewSessionSheet } from '@/components/session-tile/new-session-sheet'
import { SortControl } from '@/components/session-tile/sort-control'
import {
  OverviewDisplayMenu,
  HideStoppedChip,
} from '@/components/session-tile/overview-display-menu'
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
  hasImplicitUngrouped,
  newGroupId,
  reconcileCustomLayout,
  smartSort,
  nameSort,
  type LayoutItem,
  type OverviewLayout,
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
  // Agent Teams. The TEAM CARD owns its lead + teammates and renders
  // pinned above the session grid in EVERY sort mode. The lead IS a normal
  // supermux session, so we must EXCLUDE it from the standalone grid (it renders
  // as the team card's full tile) to avoid double-rendering; teammates are NOT in
  // /api/sessions so they never appear in the grid at all.
  const { teams } = useTeams()
  const sessions = React.useMemo(
    () => splitTeamLeads(allSessions, teams).nonLeadSessions,
    [allSessions, teams],
  )
  const { layout, setMode, setLayout } = useOverviewLayout()
  const viewMode = useUI((s) => s.viewMode)
  const setViewMode = useUI((s) => s.setViewMode)
  const hideStopped = useUI((s) => s.hideStopped)
  const setHideStopped = useUI((s) => s.setHideStopped)
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
    () =>
      sessions.filter(
        (s) => matches(s, query) && (!hideStopped || s.status !== 'stopped'),
      ),
    [sessions, query, hideStopped],
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
      // Convert SECTION-based gap index → LAYOUT index.
      //
      // GroupGrid's `sections` array OPTIONALLY contains an IMPLICIT
      // "Ungrouped" section at index 0 — whenever the layout has any leading
      // non-group items (sessions that don't belong to any real group). That
      // implicit section is VIRTUAL: its header isn't in the layout array.
      // So the gap-index → layout-index mapping must treat the implicit
      // section as "all leading non-group items" and otherwise walk one
      // section at a time (header + its sessions).
      //
      // Gap-index semantics (from GroupGrid's render):
      //   • gap 0 = above section 0 (= implicit Ungrouped if present, else
      //     the first real group).
      //   • gap N (N ≥ 1) = BELOW section N-1, i.e. AFTER that section's
      //     content and BEFORE the next section's header.
      //   • Number.MAX_SAFE_INTEGER = "at the very end" sentinel (used by the
      //     header button, `g n` chord, and command-palette entry); the loop
      //     naturally walks off the layout end and splices at next.length.
      //
      // The OLD algorithm here counted group HEADERS crossed and stopped AT
      // the N-th header — which works ONLY when an implicit Ungrouped
      // exists (because then "1 header crossed" = below-implicit = before
      // the first real group). Without implicit Ungrouped, it was off by
      // one: clicking the gap below group A landed the new group BEFORE A
      // instead of between A and B. This rewrite walks the layout section
      // by section so both shapes are handled correctly.
      let layoutIdx = 0
      let sectionsSkipped = 0
      const hasImplicit = hasImplicitUngrouped(next)
      if (hasImplicit && atIndex >= 1) {
        // Skip the implicit Ungrouped: ALL leading non-group items.
        while (
          layoutIdx < next.length &&
          next[layoutIdx].type !== 'group'
        ) {
          layoutIdx += 1
        }
        sectionsSkipped = 1
      }
      // Skip each subsequent REAL section: one group header + its sessions.
      while (layoutIdx < next.length && sectionsSkipped < atIndex) {
        layoutIdx += 1 // past the group header
        while (
          layoutIdx < next.length &&
          next[layoutIdx].type !== 'group'
        ) {
          layoutIdx += 1
        }
        sectionsSkipped += 1
      }
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

  /** Render-prop for GroupGrid: returns the inline AddGroupInput at a given
   *  gap index. GroupGrid calls this to know what to render at the active gap,
   *  keeping all state/handler ownership here in Overview. */
  const renderInlineAddGroupInput = React.useCallback(
    (at: number) =>
      isCustom ? (
        <div className="mt-1" data-vr="add-group-input">
          <AddGroupInput
            hint={
              at === Number.MAX_SAFE_INTEGER
                ? 'Add a new group at the end'
                : `Add a new group at position ${at + 1}`
            }
            onCommit={(name) => commitNewGroup(name, at)}
            onCancel={() => setAddingGroup(null)}
            reduce={!!reduce}
          />
        </div>
      ) : null,
    [isCustom, commitNewGroup, reduce],
  )

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
        return
      }
      // S7 — Strict CONSECUTIVE chord. Any key other than `g` (the trigger)
      // or `n` (the completion) resets the chord state — so typing "git n"
      // (or any other intervening key within 1.2s) does NOT fire the chord.
      // Without this reset, "g i t <space> n" would open the new-group input
      // in any non-input context.
      if (lastGRef.current !== 0) lastGRef.current = 0
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
  const onCreated = (name: string) => {
    navigate(`/focus/${name}`)
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

  // The body shows a placeholder (skeleton / unreachable / empty / no-match)
  // rather than a real grid in these cases. `showGrid` drives the bottom
  // "New group" affordance so it only appears under an actual grid — never
  // floating beneath an empty or "no matches" state.
  const noMatch =
    (!isCustom && flatSorted.length === 0 && filteredTeams.length === 0) ||
    (isCustom &&
      reconciledCustom.filter(
        (it) => it.type === 'session' && filtered.some((s) => s.name === it.name),
      ).length === 0 &&
      filteredTeams.length === 0)
  const showGrid =
    hasAnyAgent && !showSkeleton && !(isError && !hasAnyAgent) && !noMatch

  // Canonical 1..9 ⌘N slot map for the overview surface. Order:
  //   1. Each team's lead (in `filteredTeams` order) — mirrors the focus
  //      strip's `jumpSessions` so the chip on a team-lead tile reads the
  //      same number on both surfaces.
  //   2. Then ordinary sessions in render order (custom layout uses the
  //      reconciled layout walk; smart/alpha use `flatSorted`).
  // Team-leads that already received a number are skipped in step 2 so the
  // count never doubles up.
  const jumpIndexBySession = React.useMemo<JumpIndexMap>(() => {
    const m = new Map<string, number>()
    let next = 1
    for (const t of filteredTeams) {
      const lead = t.lead_supermux_session
      if (!lead) continue
      m.set(lead, next++)
      if (next > 9) return m
    }
    const sessionOrder: string[] = isCustom
      ? reconciledCustom
          .filter((it): it is Extract<LayoutItem, { type: 'session' }> =>
            it.type === 'session',
          )
          .map((it) => it.name)
          .filter((name) => filtered.some((s) => s.name === name))
      : flatSorted.map((s) => s.name)
    for (const name of sessionOrder) {
      if (m.has(name)) continue
      m.set(name, next++)
      if (next > 9) return m
    }
    return m
  }, [filteredTeams, isCustom, reconciledCustom, filtered, flatSorted])

  // Global ⌘N / Ctrl+N keystroke handler for the overview route. Mirrors the
  // visible chip on each tile: pressing the same number opens that session's
  // focus route. Skips when the user is typing into an input / textarea /
  // contenteditable (so an agent prompt or search query never gets swallowed)
  // and when a non-modifier-combo key would otherwise route through. The
  // /focus route owns its own ⌘N handler (`useKeyboardCapture` in
  // desktop-split.tsx), so this listener only fires from the overview.
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey || e.shiftKey) return
      if (e.key < '1' || e.key > '9') return
      // Don't hijack typing. `closest('[contenteditable="true"]')` covers
      // CodeMirror + xterm + rich-text inputs; the tag check covers plain
      // <input>/<textarea>.
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (t.isContentEditable) return
      }
      const idx = Number(e.key)
      for (const [name, slot] of jumpIndexBySession) {
        if (slot === idx) {
          e.preventDefault()
          navigate(`/focus/${encodeURIComponent(name)}`)
          return
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [jumpIndexBySession, navigate])

  return (
    <JumpIndexProvider value={jumpIndexBySession}>
    <div
      className={`mx-auto flex h-full w-full max-w-6xl ${containerMaxClass[overviewSize]} flex-col px-3 py-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-5 sm:py-6 sm:pt-6`}
    >
      <header className="mb-4 flex flex-wrap items-center gap-2 sm:gap-3">
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

        {/* Display controls. On a coarse pointer the four chips are cramped, so
            they fold into ONE "Display" sheet (view / sort / size / hide-stopped).
            Desktop keeps the separate chips and gains an Eye hide-stopped chip. */}
        {isMobile ? (
          <OverviewDisplayMenu
            viewMode={viewMode}
            onViewMode={setViewMode}
            sortMode={layout.mode}
            onSortMode={setMode}
            size={overviewSize}
            onSize={setOverviewSize}
            hideStopped={hideStopped}
            onHideStopped={setHideStopped}
          />
        ) : (
          <>
            <ViewToggle value={viewMode} onChange={setViewMode} />

            <SortControl value={layout.mode} onChange={setMode} />

            {viewMode === 'tile' && (
              <OverviewSizeControl
                value={overviewSize}
                onChange={setOverviewSize}
                max={sizeMax}
              />
            )}

            <HideStoppedChip value={hideStopped} onChange={setHideStopped} />
          </>
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

        {/* The "+" opens the New-session panel directly (Claude | Codex lives
            inside it). Team creation remains available from its existing
            dedicated entry points. */}
        <Button
          type="button"
          aria-label="New session"
          data-tour="new-session"
          onClick={openSheet}
          className="size-9 rounded-md p-0 ml-auto sm:ml-0"
        >
          <Plus className="size-4" aria-hidden />
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
            />
          </div>
        ) : noMatch ? (
          <div className="flex h-full items-center justify-center">
            {query.trim() ? (
              <EmptyStatePlaceholder
                icon={<Search />}
                message={`No matches for “${query}”.`}
                cta={{ label: 'Clear search', onClick: () => setRawQuery('') }}
              />
            ) : (
              // The only non-search way to empty the grid: every session is
              // stopped and hide-stopped is on. Offer the un-hide, not a useless
              // "clear search" on an empty query.
              <EmptyStatePlaceholder
                icon={<EyeOff />}
                message="Every session is stopped — they’re hidden."
                cta={{ label: 'Show stopped', onClick: () => setHideStopped(false) }}
              />
            )}
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
            addingGroupAt={addingGroup?.at ?? null}
            renderInlineAddGroupInput={renderInlineAddGroupInput}
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
            addingGroupAt={addingGroup?.at ?? null}
            renderInlineAddGroupInput={renderInlineAddGroupInput}
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

        {/* All-modes bottom group affordance (replaces the old "+" menu entry).
            In smart/alpha it flips to custom first so the new section is visible;
            in custom it appends at the end. Group NAMES only ever show in custom
            mode (GroupGrid mounts only there), exactly as before. Touch-friendly
            — the in-grid hover gaps are desktop-only. */}
        {showGrid && (
          <div className="mt-4 flex justify-center px-1 pb-2">
            <button
              type="button"
              onClick={() => {
                if (layout.mode !== 'custom') setMode('custom')
                handleNewGroupAtEnd()
              }}
              className="flex items-center gap-2 rounded-lg border border-dashed border-border/70 px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FolderPlus className="size-4" aria-hidden />
              New group
            </button>
          </div>
        )}

      </div>

      <NewSessionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCreated={onCreated}
      />
    </div>
    </JumpIndexProvider>
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
          // Stop Space / Enter / arrow keys from bubbling to the dnd-kit
          // KeyboardSensor on the parent SortableContext. Otherwise Space
          // inside this input is interpreted as "pick up a drag", which
          // shifts focus away from the input and triggers our onBlur →
          // commit path with whatever the user has typed so far, making
          // it look like the input "crashed". The browser default still
          // inserts the space character into the input value.
          // See: group-grid.tsx KeyboardSensor (~line 509). Product:
          // spaces in group names are allowed (no validator rejects them).
          if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.stopPropagation()
          }
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
}: {
  value: OverviewSize
  onChange: (s: OverviewSize) => void
  max?: OverviewSize
}) {
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
