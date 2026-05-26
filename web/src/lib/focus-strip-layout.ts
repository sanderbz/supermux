// Focus-strip layout — group-aware, sort-aware desktop strip state.
//
// THE PROBLEM. The overview gained per-group sort + custom user groups + a
// 6-mode sort chip on each group header. The desktop focus session-strip (the
// 320px left rail on /focus/<name>) stayed flat — it had team-strip grouping
// for detected Agent Teams but otherwise rendered every session as one big
// list, with no sort options. Users had two different mental models for the
// SAME set of sessions depending on which surface they were looking at.
//
// THE SOLUTION. The strip now MIRRORS the overview's groups + sort by default,
// with an opt-in "Custom for this strip" override so a user who wants a
// different sort in the strip than the overview can have it.
//
//   • GROUP MEMBERSHIP + GROUP ORDER — always inherited from the overview
//     (`useOverviewLayout`). The strip never invents a group, never reorders
//     groups, never renames a group. Group CRUD is overview-only by product
//     decree (the user's words: "not creating new groups etc, that is for the
//     overview").
//
//   • PER-GROUP SORT — defaults to the overview's chosen sort for that group.
//     Toggling the strip into "Custom for this strip" mode reads + writes a
//     SEPARATE localStorage namespace so the strip can carry a different sort
//     per group from the overview WITHOUT clobbering the overview's prefs.
//
//   • COLLAPSE — each group in the strip is independently collapsible. This
//     is a VIEWPORT concern (not a layout concern — the overview doesn't
//     collapse), so collapse state lives in the strip's own namespace.
//
// LOCALSTORAGE NAMESPACING. The overview uses
// `supermux:overview:group-sort:<groupId>`. The strip uses:
//   • `supermux:focus-strip:mode`                       → 'match-overview' | 'custom'
//   • `supermux:focus-strip:group-sort:<groupId>`       → GroupSortMode  (custom mode only)
//   • `supermux:focus-strip:collapsed:<groupId>`        → '1' | '0'
//
// Never collide with `supermux:overview:*`. When the user is in 'match-overview'
// mode the per-group sort key is NOT read — we ask `readGroupSortMode` from
// `overview-layout.ts` directly so the strip and the overview share state.

import {
  defaultGroupSortMode,
  readGroupSortMode as readOverviewGroupSortMode,
  type GroupSortMode,
} from './overview-layout'

/** The strip's relationship with the overview. */
export type FocusStripMode = 'match-overview' | 'custom'

export const FOCUS_STRIP_MODES: FocusStripMode[] = ['match-overview', 'custom']

export const DEFAULT_FOCUS_STRIP_MODE: FocusStripMode = 'match-overview'

// ── localStorage keys ────────────────────────────────────────────────────────

const STRIP_MODE_KEY = 'supermux:focus-strip:mode'

export function stripGroupSortKey(groupId: string): string {
  return `supermux:focus-strip:group-sort:${groupId}`
}

export function stripCollapsedKey(groupId: string): string {
  return `supermux:focus-strip:collapsed:${groupId}`
}

// ── Strip mode (match-overview vs custom) ────────────────────────────────────

/** Read the persisted strip mode. SSR-safe. Defensive against bad values. */
export function readFocusStripMode(): FocusStripMode {
  if (typeof window === 'undefined') return DEFAULT_FOCUS_STRIP_MODE
  try {
    const raw = window.localStorage.getItem(STRIP_MODE_KEY)
    if (raw && (FOCUS_STRIP_MODES as string[]).includes(raw)) {
      return raw as FocusStripMode
    }
  } catch {
    /* private mode / quota — fall through */
  }
  return DEFAULT_FOCUS_STRIP_MODE
}

/** Persist the strip mode. Best-effort. */
export function writeFocusStripMode(mode: FocusStripMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STRIP_MODE_KEY, mode)
  } catch {
    /* private mode / quota — non-fatal */
  }
}

// ── Per-group sort: route by mode to the right namespace ─────────────────────

/** Resolve the per-group sort mode the strip should use for `groupId`.
 *
 *  In 'match-overview' the strip reads the overview's persisted mode (the
 *  SAME `supermux:overview:group-sort:<id>` row the overview reads). In
 *  'custom' it reads the strip's separate namespace
 *  (`supermux:focus-strip:group-sort:<id>`); if the strip has never set a
 *  mode for this group, we INHERIT from the overview as a sensible default,
 *  so flipping into 'custom' for the first time doesn't snap every group to
 *  Smart out of nowhere. */
export function readStripGroupSortMode(
  stripMode: FocusStripMode,
  groupId: string,
): GroupSortMode {
  if (stripMode === 'match-overview') {
    return readOverviewGroupSortMode(groupId)
  }
  // Custom mode — look up the strip's own row first; fall back to whatever the
  // overview has so the first toggle into Custom doesn't reset every group.
  if (typeof window === 'undefined') return defaultGroupSortMode(groupId)
  try {
    const raw = window.localStorage.getItem(stripGroupSortKey(groupId))
    if (raw && isGroupSortMode(raw)) return raw
  } catch {
    /* fall through */
  }
  return readOverviewGroupSortMode(groupId)
}

/** Persist a per-group sort mode WHEN the strip is in 'custom' mode. In
 *  'match-overview' the caller is expected NOT to invoke this (UI should
 *  flip-to-Custom first, then write) — but we defensively swallow the write
 *  in match-overview so a bug elsewhere can't silently corrupt the overview's
 *  persisted sort. */
export function writeStripGroupSortMode(
  stripMode: FocusStripMode,
  groupId: string,
  mode: GroupSortMode,
): void {
  if (stripMode !== 'custom') return
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(stripGroupSortKey(groupId), mode)
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** Drop ALL per-group sort overrides the strip has accumulated. Called when
 *  the user toggles BACK to 'match-overview' — the strip should then exactly
 *  mirror the overview again, with no stale rows hanging around. Best-effort:
 *  any individual removal failure is swallowed. */
export function clearStripGroupSortModes(groupIds: ReadonlyArray<string>): void {
  if (typeof window === 'undefined') return
  for (const id of groupIds) {
    try {
      window.localStorage.removeItem(stripGroupSortKey(id))
    } catch {
      /* private mode / quota — non-fatal */
    }
  }
}

function isGroupSortMode(value: string): value is GroupSortMode {
  return (
    value === 'smart' ||
    value === 'custom' ||
    value === 'name' ||
    value === 'status' ||
    value === 'recent' ||
    value === 'age'
  )
}

// ── Per-group collapse state ─────────────────────────────────────────────────

/** Default = expanded. Collapse is opt-in. */
export function readStripGroupCollapsed(groupId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(stripCollapsedKey(groupId))
    return raw === '1'
  } catch {
    return false
  }
}

export function writeStripGroupCollapsed(
  groupId: string,
  collapsed: boolean,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(stripCollapsedKey(groupId), collapsed ? '1' : '0')
  } catch {
    /* private mode / quota — non-fatal */
  }
}
