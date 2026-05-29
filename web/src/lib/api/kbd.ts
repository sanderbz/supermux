// Keyboard-accessory groups client.
//
// `/api/kbd-groups` is the SINGLE canonical storage for the swipeable kbd
// accessory groups (the v1 "prefs blob" alternative was removed). The backing
// table was created by `0004_runtime_state.sql` and seeded server-side on
// first GET with the four default groups — Agent / Shell / Tmux / Symbols — so
// the very first request returns a populated list, no client seed write needed.
//
// Envelope + bearer reuse the shared `settingsRequest` helper (token read off
// `window._SUPERMUX_AUTH_TOKEN` at call time — never embedded in source). A 404/501
// (backend not wired on this build) surfaces as `ApiError`; the `useKbdGroups`
// hook degrades that to the local `DEFAULT_KBD_GROUPS` seed so the accessory bar
// always renders.
//
// ── Wire shape normalization ─────────────────────────────────────────────────
// The backend stores a group row as `{ id:number, name:string,
// keys:string, position:number }` where `keys` is a JSON-ENCODED string of
// `[{label,key}, …]` objects. The frontend `KbdGroup` model (and the
// `<Group/>` component + the `DEFAULT_KBD_GROUPS` seed) expect `keys: string[]`
// — a flat array of key NAMES that double as the chip label AND the value
// `keyToBytes`/`sendKey` consume. Feeding the raw backend row to `<Group/>`
// crashes it (`group.keys.slice(...).map is not a function`) and blacks out the
// whole mobile focus route. This client is the integration seam, so it
// normalizes both directions here — the backend and the React tree stay
// untouched.

import { settingsRequest } from './client'
import type { KbdGroup } from './settings'

export type { KbdGroup }

/** One key entry as the backend table stores it: a `{label,key}` pair. `label` is
 *  the on-chip name; `key` is the tmux/`keyToBytes` token. */
interface WireKey {
  label?: unknown
  key?: unknown
}

/** A group row exactly as `GET /api/kbd-groups` returns it (pre-normalization).
 *  `keys` is a JSON string; `id` is a numeric row id. */
interface WireGroup {
  id?: unknown
  name?: unknown
  keys?: unknown
}

/** Parse the backend's JSON-string `keys` column into the frontend's flat
 *  `string[]` of key names. Each `{label,key}` collapses to its `label` — the
 *  backend seed's labels (`Esc`, `Tab`, `Ctrl-C`, `~`, `|`, …) are exactly the
 *  strings `keyToBytes` + `displayLabel` + `DEFAULT_KBD_GROUPS` already use, so
 *  the chip renders and sends the right token. Falls back to a raw string entry
 *  if a row is already flat (defensive — never throws). */
function parseKeys(raw: unknown): string[] {
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map((entry): string => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object') {
        const k = entry as WireKey
        if (typeof k.label === 'string') return k.label
        if (typeof k.key === 'string') return k.key
      }
      return ''
    })
    .filter((s) => s.length > 0)
}

/** Normalize one raw backend row into the frontend `KbdGroup` shape. */
function normalizeGroup(row: WireGroup): KbdGroup {
  return {
    id: String(row.id ?? ''),
    name: typeof row.name === 'string' ? row.name : '',
    keys: parseKeys(row.keys),
  }
}

/** Serialize the frontend `string[]` keys back into the `[{label,key}, …]`
 *  shape the backend `kbd_create` / `kbd_patch` / replace handlers expect. The key
 *  name doubles as both fields — the table never loses information the flat
 *  frontend model didn't carry in the first place. */
function toWireKeys(keys: string[]): WireKey[] {
  return keys.map((k) => ({ label: k, key: k }))
}

export const kbdApi = {
  /** GET `/api/kbd-groups` — full ordered list (server seeds on first call).
   *  Normalizes the wire shape (string `keys` JSON → `string[]`). */
  listKbdGroups: async (): Promise<KbdGroup[]> => {
    const rows = await settingsRequest<WireGroup[]>('/api/kbd-groups')
    return Array.isArray(rows) ? rows.map(normalizeGroup) : []
  },

  /** PUT `/api/kbd-groups` — replace the whole ordered list. The manage-sheet
   *  reorder / add / remove all collapse to a single canonical replace so the
   *  table is never left half-written. Groups are sent with the `[{label,key}]`
   *  wire shape; the response is normalized back to the frontend model. */
  replaceKbdGroups: async (groups: KbdGroup[]): Promise<KbdGroup[]> => {
    const wire = groups.map((g) => ({
      name: g.name,
      keys: toWireKeys(g.keys),
    }))
    const rows = await settingsRequest<WireGroup[]>('/api/kbd-groups', {
      method: 'PUT',
      body: JSON.stringify({ groups: wire }),
    })
    return Array.isArray(rows) ? rows.map(normalizeGroup) : groups
  },
}
