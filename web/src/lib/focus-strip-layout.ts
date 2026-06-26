// Focus-strip layout — view-mode + global filter for the desktop strip.
//
// REDESIGN (2026-06-04). The previous design used two stacked controls:
// a "match-overview vs custom" meta-toggle in the strip header AND a
// per-group sort chip + per-group hide-stopped toggle inside every section.
// Users couldn't tell why clicks did or didn't do anything — the
// match-overview default meant per-group chips wrote through to the
// overview's namespace and were silently overridden by whatever the
// overview had stored; and the per-group eye buttons were both invisible
// (hidden inside collapsed groups) and unnecessary (one global filter is
// what the user actually wants).
//
// THE NEW MODEL. One control at the top of the strip:
//
//   • `view mode` (5 options): "As overview" / "Smart" / "Recent activity"
//     / "Status" / "Name". Default = "As overview".
//       - "As overview" mirrors the overview's groups + per-group sort.
//         The per-group chip stays inside each section header and writes
//         through to the overview's namespace (single source).
//       - Any other mode flattens all sessions into one list and applies
//         that sort globally. Per-group chips don't render.
//   • `hide stopped` (one global toggle): drops stopped sessions
//     everywhere. Persisted as a single boolean.
//
// LOCALSTORAGE KEYS.
//   • `supermux:focus-strip:view-mode`     → FocusStripViewMode
//   • `supermux:focus-strip:hide-stopped`  → '1' | '0' (global, no group id)
//   • `supermux:focus-strip:collapsed:<id>` → unchanged (per-group)
//
// MIGRATION. The old `supermux:focus-strip:mode` key held 'match-overview'
// or 'custom'; both legacy values map to 'as-overview' on read. The per-
// group sort override rows (`supermux:focus-strip:group-sort:<id>`) and
// per-group hide-stopped rows (`supermux:focus-strip:hide-stopped:<id>`)
// are orphaned by this redesign — they linger harmlessly until cleared.

import type { GroupSortMode } from './overview-layout'

/** The strip's top-level view mode. `'as-overview'` mirrors the overview's
 *  groups + per-group sort exactly; every other value is a global sort that
 *  flattens the session list (no group chrome). */
export type FocusStripViewMode =
  | 'as-overview'
  | 'smart'
  | 'recent'
  | 'status'
  | 'name'

export const FOCUS_STRIP_VIEW_MODES: FocusStripViewMode[] = [
  'as-overview',
  'smart',
  'recent',
  'status',
  'name',
]

export const DEFAULT_FOCUS_STRIP_VIEW_MODE: FocusStripViewMode = 'as-overview'

/** Map a non-'as-overview' view mode to the matching GroupSortMode kernel.
 *  Returns null for 'as-overview' — the caller uses per-group sort instead. */
export function flatSortModeFor(
  view: FocusStripViewMode,
): GroupSortMode | null {
  switch (view) {
    case 'smart':
    case 'recent':
    case 'status':
    case 'name':
      return view
    case 'as-overview':
    default:
      return null
  }
}

// ── localStorage keys ────────────────────────────────────────────────────────

const VIEW_MODE_KEY = 'supermux:focus-strip:view-mode'

export function stripCollapsedKey(groupId: string): string {
  return `supermux:focus-strip:collapsed:${groupId}`
}

// ── View mode (the one strip-header dropdown) ────────────────────────────────

function isViewMode(value: string): value is FocusStripViewMode {
  return (
    value === 'as-overview' ||
    value === 'smart' ||
    value === 'recent' ||
    value === 'status' ||
    value === 'name'
  )
}

/** Read the persisted view mode. SSR-safe. Migrates the two legacy values
 *  ('match-overview' and 'custom') to 'as-overview' silently so users don't
 *  see their strip "reset" after the redesign. */
export function readFocusStripViewMode(): FocusStripViewMode {
  if (typeof window === 'undefined') return DEFAULT_FOCUS_STRIP_VIEW_MODE
  try {
    // New key takes precedence.
    const raw = window.localStorage.getItem(VIEW_MODE_KEY)
    if (raw && isViewMode(raw)) return raw
    // Legacy key migration.
    const legacy = window.localStorage.getItem('supermux:focus-strip:mode')
    if (legacy === 'match-overview' || legacy === 'custom') {
      // Migrate on read: write the new key so subsequent loads skip the
      // legacy lookup. Best-effort.
      try {
        window.localStorage.setItem(VIEW_MODE_KEY, 'as-overview')
      } catch {
        /* quota / private mode — non-fatal */
      }
      return 'as-overview'
    }
  } catch {
    /* private mode / quota — fall through */
  }
  return DEFAULT_FOCUS_STRIP_VIEW_MODE
}

/** Persist the view mode. Best-effort. */
export function writeFocusStripViewMode(mode: FocusStripViewMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    /* private mode / quota — non-fatal */
  }
}

// The global hide-stopped filter now lives in the shared ui-store (one value
// for the focus strip AND the overview) — see stores/ui-store.ts `hideStopped`
// and use-grouped-strip.ts's one-time migration off the legacy localStorage key.

// ── Per-group collapse state (unchanged from previous design) ────────────────

/** Default = expanded. Collapse is opt-in. Only meaningful in 'as-overview'
 *  mode — flat mode has no group headers. */
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
