// Overview layout — sort modes + custom-mode groups (feat-sort-and-groups).
//
// THE DATA MODEL — server-persisted via `/api/prefs/overview_layout`.
//
//   mode: 'smart' | 'alpha' | 'custom'
//
//     smart  — the EXISTING behaviour (pinned / running / status / activity).
//              This is the default. Users who never engage the sort control
//              see ZERO change vs the pre-feature state.
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
// The single source of truth is the server pref (one slot, one shape) — the
// hook reads it ONCE via TanStack Query, and the SSE `prefs` event invalidates
// the query so other tabs reconcile within the next event tick. No
// localStorage — the user explicitly wants this to follow them across devices.

/** Sort modes — order matches the popover items in `<SortControl>`. */
export type SortMode = 'smart' | 'alpha' | 'custom'

export const SORT_MODES: SortMode[] = ['smart', 'alpha', 'custom']

export const DEFAULT_SORT_MODE: SortMode = 'smart'

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
