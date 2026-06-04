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
  groupSortKey as overviewGroupSortKey,
  type GroupSortMode,
} from './overview-layout'

/** The curated set of sort modes the STRIP's per-group chip offers. Smaller
 *  than the overview's six because two of those modes don't pay off on a
 *  320 px sidebar:
 *   - `custom` was the per-group drag order — there is no drag in the strip,
 *     so the chip option just meant "render whatever order the overview
 *     happened to have", which read as "the chip does nothing" to users.
 *   - `age` (newest-by-created-at) overlaps with `recent` for almost every
 *     real workflow and added cognitive load without paying it back.
 *  The four that survive each produce VISIBLY different orderings against a
 *  mixed fleet (some active, some idle, some stopped), so picking one in the
 *  chip menu always gives the user immediate visual confirmation. */
export const STRIP_SORT_MODES: GroupSortMode[] = [
  'smart',
  'recent',
  'status',
  'name',
]

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

export function stripHideStoppedKey(groupId: string): string {
  return `supermux:focus-strip:hide-stopped:${groupId}`
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
 *  Lookup order is identical in both stripModes — the only difference is
 *  which row we consult first:
 *
 *    custom         : strip's own row → overview's row → 'smart' default
 *    match-overview : overview's row → 'smart' default
 *
 *  Crucially, when nothing is set we ALWAYS fall back to `'smart'` (not the
 *  overview's per-group default which is `'custom'` for user groups). On the
 *  strip, `'custom'` reads as "the chip does nothing" because there is no
 *  drag here — every other mode would be visibly preferable to the user.
 *  We import `groupSortKey` (not `readGroupSortMode`) so the overview's
 *  fallback-to-`'custom'` for user groups doesn't leak in. */
export function readStripGroupSortMode(
  stripMode: FocusStripMode,
  groupId: string,
): GroupSortMode {
  if (typeof window === 'undefined') return 'smart'
  try {
    if (stripMode === 'custom') {
      const stripRaw = window.localStorage.getItem(stripGroupSortKey(groupId))
      if (stripRaw && isGroupSortMode(stripRaw)) return stripRaw
    }
    const overviewRaw = window.localStorage.getItem(
      overviewGroupSortKey(groupId),
    )
    if (overviewRaw && isGroupSortMode(overviewRaw)) return overviewRaw
  } catch {
    /* fall through to default */
  }
  return 'smart'
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

// ── Per-group hide-stopped filter ────────────────────────────────────────────
//
// A real filter (not a sort): when on, stopped sessions in that group simply
// don't render. Lives in the strip's namespace, persisted per group, default
// OFF (we show everything until the user opts in). Pairs with the sort chip
// on the section header: the sort decides the order, hide-stopped decides
// what gets rendered at all — together they cover "what should I look at".

/** Default = show everything. */
export function readStripHideStopped(groupId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(stripHideStoppedKey(groupId))
    return raw === '1'
  } catch {
    return false
  }
}

export function writeStripHideStopped(
  groupId: string,
  hidden: boolean,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      stripHideStoppedKey(groupId),
      hidden ? '1' : '0',
    )
  } catch {
    /* private mode / quota — non-fatal */
  }
}
