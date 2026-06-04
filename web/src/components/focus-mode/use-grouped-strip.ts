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
  writeGroupSortMode as writeOverviewGroupSortMode,
  readGroupSortMode as readOverviewGroupSortMode,
  type GroupSortMode,
  type LayoutItem,
} from '@/lib/overview-layout'
import {
  readFocusStripHideStopped,
  readFocusStripViewMode,
  readStripGroupCollapsed,
  writeFocusStripHideStopped,
  writeFocusStripViewMode,
  writeStripGroupCollapsed,
  type FocusStripViewMode,
} from '@/lib/focus-strip-layout'
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
  // The OVERVIEW's layout is the GROUP MEMBERSHIP + GROUP ORDER source.
  // We never write to it from the strip; we only read.
  const { layout } = useOverviewLayout()

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

  // ── Hide stopped (global) ──────────────────────────────────────────────
  const [hideStopped, setHideStoppedState] = React.useState<boolean>(
    () => readFocusStripHideStopped(),
  )
  const setHideStopped = React.useCallback((next: boolean) => {
    setHideStoppedState(next)
    writeFocusStripHideStopped(next)
  }, [])

  // ── Per-group sort writes (as-overview only) ───────────────────────────
  // A tick that bumps each time we write a per-group sort row, so the
  // useMemo below re-resolves the affected group's mode from the overview's
  // localStorage on the next render. Cheaper than subscribing to the
  // storage event and works fine for the single-tab case.
  const [resolveTick, setResolveTick] = React.useState(0)
  const setGroupSortMode = React.useCallback(
    (groupId: string, mode: GroupSortMode) => {
      writeOverviewGroupSortMode(groupId, mode)
      setResolveTick((n) => n + 1)
    },
    [],
  )

  // Resolve a group's sort mode straight from the overview's persistence
  // (no strip-side override; the chip writes to the overview's namespace).
  const resolveSortMode = React.useCallback(
    (groupId: string): GroupSortMode => readOverviewGroupSortMode(groupId),
    // resolveTick keeps a stable closure but forces the useMemo below to
    // re-run after a write (this callback otherwise reads ls at call time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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
    // resolveTick is part of the dep set so a per-group chip flip re-runs
    // the build (its kernel inputs don't otherwise change — only ls did).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessions,
      teams,
      reconciledLayout,
      resolveSortMode,
      viewMode,
      hideStopped,
      resolveTick,
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
