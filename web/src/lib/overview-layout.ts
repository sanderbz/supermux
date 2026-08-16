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
// PER-GROUP SORT (server-persisted, in THIS blob — fase B2 T9). Each
// user-created group has its own sort mode (Smart, Custom, Name, Status,
// Recent, Age). The default for a fresh user-created group is `custom` (the
// user-positioned order they just dragged into); a "system" group like the
// implicit Ungrouped bucket defaults to `smart`.
//
// THIS WAS localStorage, DELIBERATELY, AND THE REVERSAL IS DELIBERATE TOO.
// The original note here argued that cross-device group sort is low-value and
// said "revisit only if the user explicitly asks". The user asked (master plan
// §12.6b). Leaving the old paragraph in place would make this change read as an
// accident, so it is rewritten rather than deleted.
//
// It rides `overview_layout` — the blob that already exists, is already
// allowlisted server-side, and already has an SSE reconcile path — rather than a
// new pref key. A new key would need FOUR edits (the server allowlist, a key
// constant + parse/serialize, a hook cloned from `use-overview-layout.ts`, and a
// dispatch branch in `use-sessions.ts` so peer tabs reconcile) and would add a
// second write race against the same UI. `server/src/prefs.rs` is UNCHANGED.
//
// Existing `supermux:overview:group-sort:<groupId>` values are FOLDED IN on
// first read and the keys removed (`migrateLegacyGroupSort`) — migrated, never
// dropped, so nobody loses a setting they made yesterday.
//
// GROUP-BY PRESETS (`groupBy`, also on the blob). `none` (the historical
// behaviour) plus four DERIVED groupings: dir, provider, host, status. Derived
// means exactly that: a preset never writes `custom`, so switching to a preset
// and back cannot destroy a hand-dragged order.
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

/** The derived group-by presets. `none` = the historical behaviour (groups
 *  exist only in `custom` mode, from the user's own drag). The other four bucket
 *  sessions by a field they already carry — and NEVER write `custom`. */
export type GroupBy = 'none' | 'dir' | 'provider' | 'host' | 'status'

export const GROUP_BY_MODES: GroupBy[] = ['none', 'dir', 'provider', 'host', 'status']

export const DEFAULT_GROUP_BY: GroupBy = 'none'

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  none: 'No grouping',
  dir: 'Folder',
  provider: 'Provider',
  host: 'Host',
  status: 'Status',
}

export interface OverviewLayout {
  mode: SortMode
  /** Ordered flat list — see module doc. Empty until the user enters custom mode. */
  custom: LayoutItem[]
  /** Per-group sort, keyed by group id (fase B2 T9 — was localStorage). Absent
   *  keys fall back to `defaultGroupSortMode(groupId)`. */
  groupSort: Record<string, GroupSortMode>
  /** The derived grouping preset (fase B2 T9). */
  groupBy: GroupBy
}

export const DEFAULT_LAYOUT: OverviewLayout = {
  mode: DEFAULT_SORT_MODE,
  custom: [],
  groupSort: {},
  groupBy: DEFAULT_GROUP_BY,
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
  // Per-group sort: an object of known modes only. A key with a junk value is
  // dropped rather than defaulting the whole blob — one bad group must not cost
  // the user their other groups' settings.
  const groupSort: Record<string, GroupSortMode> = {}
  const gs = o.groupSort
  if (gs && typeof gs === 'object' && !Array.isArray(gs)) {
    for (const [id, v] of Object.entries(gs as Record<string, unknown>)) {
      if (typeof v === 'string' && (GROUP_SORT_MODES as string[]).includes(v)) {
        groupSort[id] = v as GroupSortMode
      }
    }
  }
  const groupBy: GroupBy = GROUP_BY_MODES.includes(o.groupBy as GroupBy)
    ? (o.groupBy as GroupBy)
    : DEFAULT_GROUP_BY

  return { mode, custom, groupSort, groupBy }
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

/**
 * The DERIVED groupings (fase B2 T9).
 *
 * `bucketSessionsByPreset` buckets sessions by a field they already carry. It
 * is a pure read: it produces sections, it never touches `custom`, and it has no
 * write path at all — which is the property that makes "switch to a preset and
 * back" safe. A hand-dragged order cannot be destroyed by something that cannot
 * write.
 *
 * Group ids are `preset:<groupBy>:<value>` — stable across renders (so per-group
 * sort and collapse state stick to a preset bucket the way they stick to a real
 * group) and impossible to collide with `newGroupId()`'s `g_…` ids.
 */
export function presetGroupId(groupBy: GroupBy, value: string): string {
  return `preset:${groupBy}:${value}`
}

/** The bucket a session falls in under a preset, plus its display name. */
function presetKeyFor(
  groupBy: GroupBy,
  s: { dir?: string; provider?: string; host_id?: number | null; status?: string },
): { key: string; label: string } {
  switch (groupBy) {
    case 'dir': {
      const dir = (s.dir ?? '').replace(/\/+$/, '')
      // The LAST path segment: a column of absolute paths is unreadable, and the
      // folder name is what the user calls the project.
      const leaf = dir.split('/').filter(Boolean).pop() ?? ''
      return { key: dir || '(no folder)', label: leaf || '(no folder)' }
    }
    case 'provider': {
      const p = (s.provider ?? '').trim()
      return { key: p || 'unknown', label: p || 'Unknown' }
    }
    case 'host': {
      // `null`/absent = LOCAL, the historical default for the whole fleet.
      const id = s.host_id ?? null
      return id === null
        ? { key: 'local', label: 'Local' }
        : { key: `host:${id}`, label: `Host ${id}` }
    }
    case 'status': {
      const st = (s.status ?? '').trim()
      return { key: st || 'unknown', label: st ? st[0].toUpperCase() + st.slice(1) : 'Unknown' }
    }
    default:
      return { key: '', label: '' }
  }
}

export function bucketSessionsByPreset<
  S extends { name: string; dir?: string; provider?: string; host_id?: number | null; status?: string },
>(groupBy: GroupBy, sessions: readonly S[]): SessionBucket<S>[] {
  if (groupBy === 'none') {
    return [{ groupId: '', groupName: '', isImplicit: true, sessions: [...sessions] }]
  }
  const buckets = new Map<string, SessionBucket<S>>()
  for (const s of sessions) {
    const { key, label } = presetKeyFor(groupBy, s)
    const groupId = presetGroupId(groupBy, key)
    let bucket = buckets.get(groupId)
    if (!bucket) {
      bucket = { groupId, groupName: label, isImplicit: false, sessions: [] }
      buckets.set(groupId, bucket)
    }
    bucket.sessions.push(s)
  }
  // Alphabetical by label so the section order is stable between renders and
  // does not jump when a session changes status.
  return [...buckets.values()].sort((a, b) =>
    a.groupName < b.groupName ? -1 : a.groupName > b.groupName ? 1 : 0,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout walk kernels — the shared "LayoutItem[] → sections" primitives the
// overview group-grid AND the focus session-strip both consume. Single source
// of truth so the next group feature only has to be applied here.
// ─────────────────────────────────────────────────────────────────────────────

/** One section produced by the layout walk. The implicit Ungrouped bucket is
 *  ALWAYS the first element of the returned array (its `sessions` may be empty
 *  — callers decide whether to render an empty implicit bucket). Generic over
 *  the session shape so the overview can pass `ApiSession` and the focus strip
 *  can pass its `TileSession` superset; the walk only reads `.name`. */
export interface SessionBucket<S extends { name: string } = ApiSession> {
  /** Empty string for the implicit Ungrouped bucket. */
  groupId: string
  /** Empty string for the implicit Ungrouped bucket. */
  groupName: string
  /** True when this bucket is the implicit Ungrouped (no group header in the layout). */
  isImplicit: boolean
  /** Sessions assigned to this bucket, in layout order. */
  sessions: S[]
}

/**
 * Walk `layoutItems`, bucketing `sessions` into groups. The implicit Ungrouped
 * bucket is ALWAYS returned at position 0 (its `sessions` may be empty — the
 * caller decides whether to render an empty implicit bucket). Sessions whose
 * names are NOT in `sessions` are silently dropped (the layout may reference
 * archived sessions).
 *
 * Single-source of the "LayoutItem[] → buckets" walk used by both
 * `buildSections` (overview group-grid) and `buildGroupedFocusStrip`
 * (focus session-strip). The two surfaces filter/enrich the result
 * differently (overview always renders the implicit bucket if non-empty; strip
 * drops it when empty + adds team-strip groups on top); the WALK itself is one
 * function so the next group feature doesn't have to be applied in two places.
 */
export function bucketSessionsByLayout<S extends { name: string }>(
  layoutItems: readonly LayoutItem[],
  sessions: readonly S[],
): SessionBucket<S>[] {
  const byName = new Map(sessions.map((s) => [s.name, s]))
  const implicit: SessionBucket<S> = {
    groupId: '',
    groupName: '',
    isImplicit: true,
    sessions: [],
  }
  const buckets: SessionBucket<S>[] = [implicit]
  let current = implicit
  for (const item of layoutItems) {
    if (item.type === 'group') {
      current = {
        groupId: item.id,
        groupName: item.name,
        isImplicit: false,
        sessions: [],
      }
      buckets.push(current)
      continue
    }
    const s = byName.get(item.name)
    if (s) current.sessions.push(s)
  }
  return buckets
}

/**
 * True when `layoutItems` has any leading items BEFORE the first group header —
 * i.e. when an "implicit Ungrouped" section is needed to bucket those sessions.
 * Single-source of the detection used by `commitNewGroup`, the `<GroupGrid>`
 * section builder, and `buildGroupedFocusStrip`.
 */
export function hasImplicitUngrouped(
  layoutItems: readonly LayoutItem[],
): boolean {
  return layoutItems.length > 0 && layoutItems[0].type !== 'group'
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

/* ── per-group sort ───────────────────────────────────────────────────────
 *
 * The blob is the source of truth (fase B2 T9). The three localStorage helpers
 * below survive as the LEGACY side of the one-time migration and nothing else:
 * `migrateLegacyGroupSort` reads them once, folds them into the blob, and
 * removes the keys.
 */

/** Read a group's sort mode out of the blob. */
export function groupSortMode(layout: OverviewLayout, groupId: string): GroupSortMode {
  return layout.groupSort[groupId] ?? defaultGroupSortMode(groupId)
}

/** The blob with one group's sort mode set — pure, so the caller owns the write. */
export function withGroupSortMode(
  layout: OverviewLayout,
  groupId: string,
  mode: GroupSortMode,
): OverviewLayout {
  return { ...layout, groupSort: { ...layout.groupSort, [groupId]: mode } }
}

/** The blob with a deleted group's sort mode dropped. Group ids are random per
 *  creation, so without this a heavy user accumulates one dead key per deleted
 *  group — forever, and now on the SERVER rather than in their own browser. */
export function withoutGroupSortMode(
  layout: OverviewLayout,
  groupId: string,
): OverviewLayout {
  if (!(groupId in layout.groupSort)) return layout
  const groupSort = { ...layout.groupSort }
  delete groupSort[groupId]
  return { ...layout, groupSort }
}

/** A minimal storage shape, so the migration is testable without a DOM. */
export interface KeyValueStore {
  length: number
  key(i: number): string | null
  getItem(k: string): string | null
  removeItem(k: string): void
}

/**
 * ONE-TIME migration: fold every `supermux:overview:group-sort:<groupId>` value
 * into the blob and delete the keys.
 *
 * Returns the migrated layout, or `null` when there was nothing to migrate — so
 * the caller writes the pref only when something actually moved, and a user who
 * never set a per-group sort never triggers a PUT.
 *
 * A value already present in the blob WINS: the blob is the newer, shared truth,
 * and a stale localStorage row from another tab must not overwrite it. The keys
 * are removed either way — leaving them would re-run this on every mount.
 */
export function migrateLegacyGroupSort(
  layout: OverviewLayout,
  store: KeyValueStore | undefined = typeof window === 'undefined'
    ? undefined
    : window.localStorage,
): OverviewLayout | null {
  if (!store) return null
  const prefix = groupSortKey('')
  const found: [string, GroupSortMode][] = []
  const keys: string[] = []
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (!key || !key.startsWith(prefix)) continue
      keys.push(key)
      const value = store.getItem(key)
      if (value && (GROUP_SORT_MODES as string[]).includes(value)) {
        found.push([key.slice(prefix.length), value as GroupSortMode])
      }
    }
  } catch {
    return null // private mode / disabled storage — nothing to migrate
  }
  if (keys.length === 0) return null

  const groupSort = { ...layout.groupSort }
  let changed = false
  for (const [groupId, mode] of found) {
    if (groupId in groupSort) continue // the blob already knows better
    groupSort[groupId] = mode
    changed = true
  }
  try {
    for (const key of keys) store.removeItem(key)
  } catch {
    /* best effort — a key left behind only costs one more no-op pass */
  }
  return changed ? { ...layout, groupSort } : null
}

/** localStorage key for a group's per-group sort mode. LEGACY — read once by
 *  `migrateLegacyGroupSort`, then gone. */
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

/** Drop the persisted per-group sort mode for a deleted group.
 *  Group ids are random per-creation — without this, heavy users accumulate
 *  one dead localStorage row per deleted group forever. Best-effort: any
 *  removal failure is swallowed (the key just sits there, harmless). */
export function removeGroupSortMode(groupId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(groupSortKey(groupId))
  } catch {
    /* private mode / quota — non-fatal */
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
