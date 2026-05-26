// useGroupedStrip — the desktop focus session-strip's group-aware state hook.
//
// SINGLE SOURCE OF TRUTH: builds the strip model from the SAME inputs the
// overview reads (the shared `useOverviewLayout` server pref + the live
// `useSessions` + the live `useTeams`). Adds the strip's two LOCAL concerns:
//
//   1. STRIP MODE: 'match-overview' | 'custom'. Persisted to localStorage
//      under `supermux:focus-strip:mode`. Drives where per-group sort modes
//      come from:
//        • match-overview → the overview's `supermux:overview:group-sort:<id>`.
//        • custom         → the strip's own `supermux:focus-strip:group-sort:<id>`,
//                           falling back to the overview's stored mode on
//                           first read so flipping into custom doesn't reset
//                           every group's sort to Smart.
//
//   2. COLLAPSE: each section is independently collapsible. Persisted under
//      `supermux:focus-strip:collapsed:<groupId>`. Collapse is a viewport
//      concern, so it's never inherited from the overview (the overview
//      doesn't have a collapse concept).
//
// EXPORTS a single hook that returns:
//   • The fully-built `GroupedFocusStripModel` (team groups + user groups +
//     jump list, with per-group sort already applied).
//   • Mode + setMode (with side-effect of clearing strip-namespaced sort rows
//     on the match-overview transition, so a stale row never lingers and
//     causes a surprise the next time the user flips back into custom).
//   • setGroupSortMode (writes to the right namespace based on mode; in
//     match-overview mode it writes through to the OVERVIEW's namespace so
//     the change feels like it edits the shared pref — same UX as the
//     overview's chip).
//   • collapsed map + setCollapsed.

import * as React from 'react'

import { useOverviewLayout } from '@/hooks/use-overview-layout'
import {
  reconcileCustomLayout,
  UNGROUPED_GROUP_ID,
  writeGroupSortMode as writeOverviewGroupSortMode,
  type GroupSortMode,
  type LayoutItem,
} from '@/lib/overview-layout'
import {
  clearStripGroupSortModes,
  readFocusStripMode,
  readStripGroupCollapsed,
  readStripGroupSortMode,
  writeFocusStripMode,
  writeStripGroupCollapsed,
  writeStripGroupSortMode,
  type FocusStripMode,
} from '@/lib/focus-strip-layout'
import type { Team } from '@/lib/api/teams'
import type { TileSession } from '@/components/session-tile/types'

import {
  buildGroupedFocusStrip,
  type GroupedFocusStripModel,
} from './focus-strip-groups'

export interface UseGroupedStripResult {
  model: GroupedFocusStripModel
  /** Strip's "match-overview vs custom-for-this-strip" mode. */
  stripMode: FocusStripMode
  setStripMode: (next: FocusStripMode) => void
  /** Per-group sort write. Routes to the right namespace based on `stripMode`. */
  setGroupSortMode: (groupId: string, mode: GroupSortMode) => void
  /** Per-group collapse state. */
  isCollapsed: (groupId: string) => boolean
  setCollapsed: (groupId: string, collapsed: boolean) => void
}

/** Build the grouped strip model + own the strip's local state.
 *
 *  @param sessions  Canonical session list (single source — the same the strip
 *                   already reads via `useFocusSessions`).
 *  @param teams     Detected Agent Teams (the same `useTeams` the focus route
 *                   already passes through). */
export function useGroupedStrip(
  sessions: ReadonlyArray<TileSession>,
  teams: ReadonlyArray<Team>,
): UseGroupedStripResult {
  // The OVERVIEW's layout is the GROUP MEMBERSHIP + GROUP ORDER source. We
  // never write to it from the strip — the user said: "not creating new
  // groups etc, that is for the overview." We only READ.
  const { layout } = useOverviewLayout()

  // Reconcile the persisted custom list against the live session names — same
  // function the overview calls, so the strip's groups never claim a dead
  // session and newly-created sessions surface in the implicit Ungrouped
  // bucket (where the overview also surfaces them).
  const reconciledLayout = React.useMemo<ReadonlyArray<LayoutItem>>(
    () =>
      reconcileCustomLayout(
        layout.custom,
        sessions.map((s) => s.name),
      ),
    [layout.custom, sessions],
  )

  // ── Strip mode (match-overview vs custom) ──────────────────────────────
  // Read once on mount (SSR-safe). We don't subscribe to the storage event —
  // the strip is single-tab in practice, and storing the mode per-tab would
  // be surprising. If the user flips the toggle in another tab, this tab
  // picks it up on next mount.
  const [stripMode, setStripModeState] = React.useState<FocusStripMode>(
    () => readFocusStripMode(),
  )

  // Track the set of group ids known to the strip — used by setStripMode's
  // side-effect to clear strip-namespaced rows on match-overview transition.
  const knownGroupIdsRef = React.useRef<string[]>([])

  const setStripMode = React.useCallback(
    (next: FocusStripMode) => {
      setStripModeState(next)
      writeFocusStripMode(next)
      // On the custom → match-overview transition, the strip is now exactly
      // the overview again — wipe any per-group rows the user wrote during
      // their custom session so we don't carry them over invisibly when they
      // toggle back into custom later (the fallback would then surface a
      // mode they thought they discarded). The Ungrouped id is included
      // alongside the user-defined ids.
      if (next === 'match-overview') {
        const ids = [...knownGroupIdsRef.current]
        if (!ids.includes(UNGROUPED_GROUP_ID)) ids.push(UNGROUPED_GROUP_ID)
        clearStripGroupSortModes(ids)
      }
    },
    [],
  )

  // ── Per-group sort overrides (custom mode only) ────────────────────────
  // Held in component state so the model rebuilds when the user flips a chip
  // without waiting for storage to round-trip + something to re-read.
  // Lazy init: empty — `resolveSortMode` reads localStorage on demand the
  // first time the model is built for each group id.
  const [stripSortOverrides, setStripSortOverrides] = React.useState<
    Map<string, GroupSortMode>
  >(() => new Map())

  // A tiny resolution-tick so the model rebuilds when match-overview chips
  // are flipped (the underlying localStorage row changed but no React state
  // moved). Bumping state with a counter is the simplest re-resolution path
  // without subscribing to storage events. Declared BEFORE `setGroupSortMode`
  // so the callback can reference it directly without a temporal-dead-zone
  // lint flag.
  const [resolveTick, setResolveTick] = React.useState(0)
  const bumpResolveTick = React.useCallback(
    () => setResolveTick((n) => n + 1),
    [],
  )

  // Resolve a group's sort mode by routing through the layout's localStorage
  // helpers. In 'match-overview' we read the overview's persisted mode
  // (single source); in 'custom' we read the strip's override if present,
  // else fall back to the overview's mode (so flipping into custom doesn't
  // snap groups to Smart).
  const resolveSortMode = React.useCallback(
    (groupId: string): GroupSortMode => {
      if (stripMode === 'custom') {
        // Component state first (instant feedback after a chip flip), then
        // localStorage, then overview fallback. Centralised in
        // readStripGroupSortMode which already covers ls → overview fallback.
        const fromState = stripSortOverrides.get(groupId)
        if (fromState) return fromState
        return readStripGroupSortMode('custom', groupId)
      }
      return readStripGroupSortMode('match-overview', groupId)
    },
    [stripMode, stripSortOverrides],
  )

  const setGroupSortMode = React.useCallback(
    (groupId: string, mode: GroupSortMode) => {
      if (stripMode === 'custom') {
        // Write to the strip's own namespace; also reflect in component
        // state so the model rebuilds immediately.
        writeStripGroupSortMode('custom', groupId, mode)
        setStripSortOverrides((prev) => {
          const next = new Map(prev)
          next.set(groupId, mode)
          return next
        })
        return
      }
      // match-overview mode — the user expects this chip to edit the shared
      // overview pref (same UX as the overview's chip). Write through to the
      // OVERVIEW's namespace. The overview's own chip on the same group will
      // update on next read (or instantly if both surfaces are mounted, via
      // the resolveTick re-render). Cross-tab sync via the `storage` event
      // is intentionally not wired here — revisit if users ask for live
      // cross-surface chip sync (currently single-tab in practice).
      writeOverviewGroupSortMode(groupId, mode)
      bumpResolveTick()
    },
    [stripMode, bumpResolveTick],
  )

  // ── Per-group collapse map ─────────────────────────────────────────────
  // Lazy init for ALL ids the layout currently knows about — newly seen ids
  // hydrate on demand inside `isCollapsed` (cheap localStorage read; cached
  // in state so subsequent rebuilds are O(1)).
  const [collapsedMap, setCollapsedMap] = React.useState<Map<string, boolean>>(
    () => new Map(),
  )

  const isCollapsed = React.useCallback(
    (groupId: string): boolean => {
      const fromState = collapsedMap.get(groupId)
      if (fromState !== undefined) return fromState
      // First time we ask about this id — hydrate from localStorage.
      const fromLs = readStripGroupCollapsed(groupId)
      // Don't synchronously setState during render — defer via microtask so
      // a re-render picks up the hydrated value cleanly without breaking
      // the React 19 "no state writes during render" rule.
      if (fromLs) {
        queueMicrotask(() => {
          setCollapsedMap((prev) => {
            if (prev.has(groupId)) return prev
            const next = new Map(prev)
            next.set(groupId, fromLs)
            return next
          })
        })
      }
      return fromLs
    },
    [collapsedMap],
  )

  const setCollapsed = React.useCallback(
    (groupId: string, collapsed: boolean) => {
      setCollapsedMap((prev) => {
        const next = new Map(prev)
        next.set(groupId, collapsed)
        return next
      })
      writeStripGroupCollapsed(groupId, collapsed)
    },
    [],
  )

  // ── Build the model ────────────────────────────────────────────────────
  const model = React.useMemo(
    () =>
      buildGroupedFocusStrip({
        sessions,
        teams,
        layoutItems: reconciledLayout,
        resolveSortMode,
      }),
    // resolveTick is part of the dep set so a match-overview chip flip
    // re-runs the build (its inputs don't otherwise change — only ls did).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, teams, reconciledLayout, resolveSortMode, resolveTick],
  )

  // Track the set of group ids the model currently shows so setStripMode's
  // "wipe my custom rows" cleanup knows what to remove. Written from an
  // effect (NOT during render — that would trip the React 19 "no ref writes
  // during render" rule). One Map per render is fine: the effect runs only
  // when the model's group ids actually change.
  React.useEffect(() => {
    knownGroupIdsRef.current = model.userGroups.map((g) => g.groupId)
  }, [model.userGroups])

  return {
    model,
    stripMode,
    setStripMode,
    setGroupSortMode,
    isCollapsed,
    setCollapsed,
  }
}
