// M16 — keyboard-accessory groups client.
//
// `/api/kbd-groups` is the SINGLE canonical storage for the swipeable kbd
// accessory groups (the v1 "prefs blob" alternative was removed). The backing
// table was created by M9 (`0004_runtime_state.sql`) and seeded server-side on
// first GET with the four default groups — Agent / Shell / Tmux / Symbols — so
// the very first request returns a populated list, no client seed write needed.
//
// Envelope + bearer reuse the shared `settingsRequest` helper (token read off
// `window._AMUX_AUTH_TOKEN` at call time — never embedded in source). A 404/501
// (backend not wired on this build) surfaces as `ApiError`; the `useKbdGroups`
// hook degrades that to the local `DEFAULT_KBD_GROUPS` seed so the accessory bar
// always renders.

import { settingsRequest } from './client'
import type { KbdGroup } from './settings'

export type { KbdGroup }

export const kbdApi = {
  /** GET `/api/kbd-groups` — full ordered list (server seeds on first call). */
  listKbdGroups: (): Promise<KbdGroup[]> => settingsRequest('/api/kbd-groups'),

  /** PUT `/api/kbd-groups` — replace the whole ordered list. The manage-sheet
   *  reorder / add / remove all collapse to a single canonical replace so the
   *  table is never left half-written. */
  replaceKbdGroups: (groups: KbdGroup[]): Promise<KbdGroup[]> =>
    settingsRequest('/api/kbd-groups', {
      method: 'PUT',
      body: JSON.stringify({ groups }),
    }),
}
