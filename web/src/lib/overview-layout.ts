// Overview layout — global mode + per-group sort + custom-mode groups
// (feat-group-ux research-spec 2026).
//
// THE DATA MODEL.
//
// GLOBAL MODE (server-persisted, `/api/prefs/overview_layout`):
//
//   mode: 'smart' | 'alpha' | 'custom'
//
//     smart  — pinned / running / status / activity (the historical default).
//              Users who never engage the sort control see ZERO change.
//     alpha  — alphabetical by session name. Stable and predictable.
//     custom — user drag-orders sessions and groups them. Groups are visible
//              ONLY in this mode (anti-noise — no group chrome when not in use).
//
//   custom: an ORDERED flat list of `LayoutItem`s. Two kinds: `group` (a named
//   section header) and `session` (the session's `name`). Sessions appear
//   in the order the user dragged them; a session under a group header belongs
//   to that group until the next group header or end-of-list. Sessions in the
//   current list but missing from `custom` are appended to an implicit
//   "Ungrouped" bucket at the TOP so newly-created agents are immediately
//   discoverable instead of disappearing into a group at the bottom. Sessions
//   in `custom` but missing from the live list are dropped on read.
//
// PER-GROUP SORT (localStorage, NOT server). Each user-created group has its
// own sort mode (Smart, Custom, Name, Status, Recent, Age). The default for a
// fresh user-created group is `custom` (the user-positioned order they just
// dragged into); a "system" group like the implicit Ungrouped bucket defaults
// to `smart`. Persisted in localStorage under
// `supermux:overview:group-sort:<groupId>` so toggling between groups feels
// instant and per-device — revisit only if the user explicitly asks for
// cross-device sync (most M&A research consistently flags cross-device group
// sort as low-value).
//
// The single source of truth for global state is the server pref — the hook
// reads it ONCE via TanStack Query, and the SSE `prefs` event invalidates the
// query so other tabs reconcile within the next event tick.

import type { ApiSession } from './api'

/** Global sort modes — same wire shape as before for back-compat with the
 *  existing server pref ("alpha" stays valid). */
export type SortMode = 'smart' | 'alpha' | 'custom'

export const SORT_MODES: SortMode[] = ['smart', 'alpha', 'custom']

export const DEFAULT_SORT_MODE: SortMode = 'smart'

/** Per-GROUP sort modes (the chip on each group header). The 2026 Linear-style
 *  6-set. `custom` is the per-group user-drag-positioned order; `smart` mirrors
 *  the global Smart sort scoped to the group's sessions. */
export type GroupSortMode =
  | 'smart'
  | 'custom'
  | 'name'
  | 'status'
  | 'recent'
  | 'age'

export const GROUP_SORT_MODES: GroupSortMode[] = [
  'smart',
  'custom',
  'name',
  'status',
  'recent',
  'age',
]

/** One entry in the custom-order flat list. */
export type LayoutItem =
  | { type: 'group'; id: string; name: string }
  | { type: 'session'; name: string }

export interface OverviewLayout {
  mode: SortMode
  /** Ordered flat list — see module doc. Empty until the user enters custom mode. */
  custom: LayoutItem[]
}

export const DEFAULT_LAYOUT: OverviewLayout = {
  mode: DEFAULT_SORT_MODE,
  custom: [],
}

/** Pref key in the server's `prefs` table (allowlisted server-side). */
export const OVERVIEW_LAYOUT_PREF_KEY = 'overview_layout'

/** Reserved id for the implicit "Ungrouped" bucket (sessions floating above the
 *  first user-defined group header in custom mode). It's not a real group on the
 *  wire — but the per-group sort UI keys on a stable id, so we use this one. */
export const UNGROUPED_GROUP_ID = '__ungrouped__'

/** Parse the opaque pref string. Defensive against any malformed value the
 *  user could put there in another release or via direct API editing — the UI
 *  must never crash on bad data; it falls back to the default. */
export function parseLayout(raw: string | null | undefined): OverviewLayout {
  if (!raw) return DEFAULT_LAYOUT
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return DEFAULT_LAYOUT
  }
  if (!obj || typeof obj !== 'object') return DEFAULT_LAYOUT
  const o = obj as Record<string, unknown>
  const mode: SortMode = SORT_MODES.includes(o.mode as SortMode)
    ? (o.mode as SortMode)
    : DEFAULT_SORT_MODE
  const customRaw = Array.isArray(o.custom) ? o.custom : []
  const custom: LayoutItem[] = []
  for (const item of customRaw) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    if (it.type === 'group' && typeof it.id === 'string' && typeof it.name === 'string') {
      custom.push({ type: 'group', id: it.id, name: it.name })
    } else if (it.type === 'session' && typeof it.name === 'string') {
      custom.push({ type: 'session', name: it.name })
    }
  }
  return { mode, custom }
}

export function serializeLayout(layout: OverviewLayout): string {
  return JSON.stringify(layout)
}

/** Generate a unique group id. Short + readable so it survives the JSON eyeball. */
export function newGroupId(): string {
  return `g_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`
}

/** Walk the custom layout, return per-session group assignment so the tile
 *  can render an optional subtle badge later if we want. Currently unused by
 *  the renderer (groups are visual via the section header rows), but handy for
 *  selectors and tests. */
export function sessionGroupMap(layout: OverviewLayout): Map<string, string | null> {
  const out = new Map<string, string | null>()
  if (layout.mode !== 'custom') return out
  let currentGroup: string | null = null
  for (const item of layout.custom) {
    if (item.type === 'group') {
      currentGroup = item.id
    } else {
      out.set(item.name, currentGroup)
    }
  }
  return out
}

/** Reconcile the persisted custom list with the LIVE session names. Sessions
 *  in `liveNames` but missing from `custom` are prepended (under an implicit
 *  "Ungrouped" bucket — see module doc); sessions in `custom` that no longer
 *  exist are dropped. Group order is preserved. Returns the reconciled list.
 *
 *  Pure function; never mutates inputs. */
export function reconcileCustomLayout(
  custom: LayoutItem[],
  liveNames: ReadonlyArray<string>,
): LayoutItem[] {
  const liveSet = new Set(liveNames)
  const seen = new Set<string>()
  const filtered: LayoutItem[] = []
  // Pass 1: drop dead sessions, dedupe, keep groups.
  for (const item of custom) {
    if (item.type === 'group') {
      filtered.push(item)
    } else if (liveSet.has(item.name) && !seen.has(item.name)) {
      seen.add(item.name)
      filtered.push(item)
    }
  }
  // Pass 2: prepend any live sessions not yet placed (newly-created agents).
  // Prepending (vs appending into the last group) keeps a fresh session at the
  // TOP where the user will see it, instead of buried under an arbitrary group.
  const missing: LayoutItem[] = []
  for (const name of liveNames) {
    if (!seen.has(name)) missing.push({ type: 'session', name })
  }
  return [...missing, ...filtered]
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort kernels — all PURE. The Overview consumes them via `sortByMode` to keep
// the call site small and the tests focused.
// ─────────────────────────────────────────────────────────────────────────────

/** Status sort weight: active|waiting|starting first (the user wants action),
 *  idle next, stopped last. Errors rank with idle (they're attention items but
 *  not "in flight"). */
const STATUS_RANK: Record<ApiSession['status'], number> = {
  active: 0,
  starting: 0,
  waiting: 0,
  idle: 1,
  error: 1,
  stopped: 2,
}

function activityFrom(updatedAt?: string): number {
  if (!updatedAt) return 0
  const t = Date.parse(updatedAt)
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000)
}

function ageFrom(createdAt?: string): number {
  if (!createdAt) return 0
  const t = Date.parse(createdAt)
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000)
}

/** Smart sort (system default for system groups, AND the global Smart mode):
 *  pinned-desc, running-desc, (active|waiting before idle), -last_activity. */
export function smartSort(sessions: ApiSession[]): ApiSession[] {
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

/** Alphabetical by name (A→Z). Locale-aware so non-ASCII names sort predictably. */
export function nameSort(sessions: ApiSession[]): ApiSession[] {
  return [...sessions].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/** Back-compat alias used by the existing global-mode wiring. */
export const alphaSort = nameSort

/** Status-rank only (ties broken by name for stability). */
export function statusSort(sessions: ApiSession[]): ApiSession[] {
  return [...sessions].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rank !== 0) return rank
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** Most recent activity first. */
export function recencySort(sessions: ApiSession[]): ApiSession[] {
  return [...sessions].sort((a, b) => {
    const aAct = a.last_activity ?? activityFrom(a.updated_at)
    const bAct = b.last_activity ?? activityFrom(b.updated_at)
    if (bAct !== aAct) return bAct - aAct
    return a.name.localeCompare(b.name)
  })
}

/** Newest first (by created_at). Older sessions fall to the bottom. Sessions
 *  without a created_at fall back to recency so they don't all clump at the end. */
export function ageSort(sessions: ApiSession[]): ApiSession[] {
  return [...sessions].sort((a, b) => {
    const aAge = ageFrom(a.created_at)
    const bAge = ageFrom(b.created_at)
    if (bAge !== aAge) return bAge - aAge
    return a.name.localeCompare(b.name)
  })
}

/** Apply a per-group sort mode to a list of sessions. The `custom` mode is a
 *  PASS-THROUGH (the caller is responsible for ordering by the user-drag list);
 *  every other mode is a pure function of the session fields. */
export function sortSessionsByMode(
  mode: GroupSortMode,
  sessions: ApiSession[],
): ApiSession[] {
  switch (mode) {
    case 'smart':
      return smartSort(sessions)
    case 'name':
      return nameSort(sessions)
    case 'status':
      return statusSort(sessions)
    case 'recent':
      return recencySort(sessions)
    case 'age':
      return ageSort(sessions)
    case 'custom':
    default:
      return sessions
  }
}

/** localStorage key for a group's per-group sort mode. */
export function groupSortKey(groupId: string): string {
  return `supermux:overview:group-sort:${groupId}`
}

/** Default per-group sort mode. The implicit "Ungrouped" bucket defaults to
 *  `smart` (system-decided, since the user never explicitly positioned it);
 *  every user-created group defaults to `custom` (their drag order). */
export function defaultGroupSortMode(groupId: string): GroupSortMode {
  return groupId === UNGROUPED_GROUP_ID ? 'smart' : 'custom'
}

/** Read the persisted per-group sort mode from localStorage. SSR / no-window
 *  callers get the default. Defensive: any malformed value collapses to the
 *  default rather than throwing. */
export function readGroupSortMode(groupId: string): GroupSortMode {
  if (typeof window === 'undefined') return defaultGroupSortMode(groupId)
  try {
    const raw = window.localStorage.getItem(groupSortKey(groupId))
    if (raw && (GROUP_SORT_MODES as string[]).includes(raw)) {
      return raw as GroupSortMode
    }
  } catch {
    /* localStorage may be unavailable in private mode — fall through */
  }
  return defaultGroupSortMode(groupId)
}

/** Persist a per-group sort mode. Best-effort: writes failures (private mode)
 *  are swallowed so the UI flip still feels instant. */
export function writeGroupSortMode(groupId: string, mode: GroupSortMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(groupSortKey(groupId), mode)
  } catch {
    /* quota / private mode — non-fatal */
  }
}

/** Human-readable label for a per-group sort mode (used by the chip + a11y). */
export const GROUP_SORT_LABEL: Record<GroupSortMode, string> = {
  smart: 'Smart',
  custom: 'Custom',
  name: 'Name',
  status: 'Status',
  recent: 'Recent activity',
  age: 'Age',
}

/** A short verb hint per per-group mode for the dropdown's secondary line. */
export const GROUP_SORT_HINT: Record<GroupSortMode, string> = {
  smart: 'Active and pinned first, then by recent activity',
  custom: 'Free 2-D drag — drop anywhere',
  name: 'A → Z by session name',
  status: 'Running, waiting, idle, stopped',
  recent: 'Most recently active first',
  age: 'Newest first',
}
