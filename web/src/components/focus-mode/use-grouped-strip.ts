// useGroupedStrip — the desktop focus session-strip's state hook.
//
// REDESIGN (2026-06-04). Replaces the old "match-overview vs custom" toggle
// + per-group sort + per-group hide-stopped triad with a single
// `view mode` (5 options) + a single global `hide-stopped` filter.
// Per-group sort chips stay inside section headers but ONLY when the strip
// is in 'as-overview' mode — they write through to the OVERVIEW's namespace
// directly (single source). Per-group hide-stopped is gone.
//
// Hook responsibilities:
//   1. View mode (FocusStripViewMode) — persisted in localStorage.
//   2. Hide-stopped (global boolean) — persisted in localStorage.
//   3. Per-group collapse (Map<groupId, boolean>) — persisted per id.
//   4. Per-group sort chip writes (only meaningful in 'as-overview') —
//      delegated straight to the overview's persistence helper so the chip
//      and the overview's own chip on the same group stay in lockstep.
//   5. The fully-built strip model (group view OR flat list, depending
//      on view mode).

import * as React from 'react'

import { useOverviewLayout } from '@/hooks/use-overview-layout'
import {
  reconcileCustomLayout,
  groupSortMode,
  type GroupSortMode,
  type LayoutItem,
} from '@/lib/overview-layout'
import {
  readFocusStripViewMode,
  readStripGroupCollapsed,
  writeFocusStripViewMode,
  writeStripGroupCollapsed,
  type FocusStripViewMode,
} from '@/lib/focus-strip-layout'
import { useUI } from '@/stores/ui-store'
import type { Team } from '@/lib/api/teams'
import type { TileSession } from '@/components/session-tile/types'

import {
  buildGroupedFocusStrip,
  type GroupedFocusStripModel,
} from './focus-strip-groups'

export interface UseGroupedStripResult {
  model: GroupedFocusStripModel
  /** The strip's top-level view mode (one of 5). */
  viewMode: FocusStripViewMode
  setViewMode: (next: FocusStripViewMode) => void
  /** Global hide-stopped filter. */
  hideStopped: boolean
  setHideStopped: (next: boolean) => void
  /** Per-group sort write — meaningful only in 'as-overview' view mode.
   *  Goes straight through to the overview's persistence helper so the
   *  chip and the overview's chip on the same group always agree. */
  setGroupSortMode: (groupId: string, mode: GroupSortMode) => void
  /** Per-group collapse state. */
  isCollapsed: (groupId: string) => boolean
  setCollapsed: (groupId: string, collapsed: boolean) => void
}

export function useGroupedStrip(
  sessions: ReadonlyArray<TileSession>,
  teams: ReadonlyArray<Team>,
): UseGroupedStripResult {
  // The OVERVIEW's layout is the GROUP MEMBERSHIP + GROUP ORDER source — and,
  // since fase B2 T9, the per-group SORT source too (it moved off localStorage
  // into this blob). The strip still owns no persistence of its own.
  const { layout, setGroupSort } = useOverviewLayout()

  const reconciledLayout = React.useMemo<ReadonlyArray<LayoutItem>>(
    () =>
      reconcileCustomLayout(
        layout.custom,
        sessions.map((s) => s.name),
      ),
    [layout.custom, sessions],
  )

  // ── View mode ──────────────────────────────────────────────────────────
  const [viewMode, setViewModeState] = React.useState<FocusStripViewMode>(
    () => readFocusStripViewMode(),
  )
  const setViewMode = React.useCallback((next: FocusStripViewMode) => {
    setViewModeState(next)
    writeFocusStripViewMode(next)
  }, [])

  // ── Hide stopped (global, shared with the overview) ─────────────────────
  // ONE value in the ui-store backs the focus strip's Eye toggle AND the
  // overview's hide-stopped — toggle it on either surface, it applies to both.
  // (The pre-redesign per-strip localStorage flag is migrated once at boot in
  // the ui-store's onRehydrateStorage, so there's nothing to do here.)
  const hideStopped = useUI((s) => s.hideStopped)
  const setHideStopped = useUI((s) => s.setHideStopped)

  // ── Per-group sort — the OVERVIEW's store, which is now the server blob ──
  // (fase B2 T9). The strip has never had its own persistence: its 4-mode chip
  // writes into the overview's namespace so a group sorted here is sorted there.
  // That namespace moved from localStorage to `overview_layout.groupSort`, so
  // this hook moved with it — and the write/read tick that existed only to
  // force a re-read of localStorage is gone: the blob is TanStack state, so a
  // write re-renders every consumer by itself.
  const setGroupSortMode = setGroupSort

  const resolveSortMode = React.useCallback(
    (groupId: string): GroupSortMode => groupSortMode(layout, groupId),
    [layout],
  )

  // ── Per-group collapse ─────────────────────────────────────────────────
  const [collapsedMap, setCollapsedMap] = React.useState<Map<string, boolean>>(
    () => new Map(),
  )

  const isCollapsed = React.useCallback(
    (groupId: string): boolean => {
      const fromState = collapsedMap.get(groupId)
      if (fromState !== undefined) return fromState
      const fromLs = readStripGroupCollapsed(groupId)
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
        viewMode,
        hideStopped,
      }),
    // The tick this dep set used to carry is gone (fase B2 T9): the per-group
    // sort lives in the pref blob now, so `resolveSortMode` changes identity
    // when the blob does and the memo re-runs on its own.
    [
      sessions,
      teams,
      reconciledLayout,
      resolveSortMode,
      viewMode,
      hideStopped,
    ],
  )

  return {
    model,
    viewMode,
    setViewMode,
    hideStopped,
    setHideStopped,
    setGroupSortMode,
    isCollapsed,
    setCollapsed,
  }
}
