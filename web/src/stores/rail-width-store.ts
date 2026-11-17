// The roster RAIL width — the bot list beside the detail pane (desktop grok).
//
// The rail used to be a fixed 372px. On a tablet that left the detail pane
// ~310px at 768px, too narrow for the chat header and composer, so the page
// itself scrolled sideways. The divider between list and pane is now a drag
// handle (`rail-resize-handle.tsx`), like a mail client's: drag it in until the
// list is one line per bot, or further until only the faces are left, or out to
// give the list more room.
//
// `null` means "never dragged" — the CSS default (372px) applies, so nothing
// changes for anyone who does not touch the handle. Whatever is stored, the CSS
// still clamps the rendered width so the pane keeps `PANE_MIN_W` (see
// `.gr-rail` in grok-mode.css), which is why the handle commits the MEASURED
// width rather than the raw drag position.
//
// Persisted via Zustand + `persist`, the same pattern as `team-width-store.ts`.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** The faces alone: row pad 15 + mark 42 + 15. Below this a row loses its mark. */
export const RAIL_MIN_W = 72
/** Past this the list stops gaining anything and only costs the pane. */
export const RAIL_MAX_W = 560
/** The rail's width when nothing is stored — the former fixed width. */
export const RAIL_DEFAULT_W = 372

export function clampRailWidth(px: number): number {
  return Math.round(Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, px)))
}

interface RailWidthState {
  /** The chosen width in px, or `null` for the default. */
  width: number | null
  setWidth: (px: number | null) => void
}

export const useRailWidthStore = create<RailWidthState>()(
  persist(
    (set) => ({
      width: null,
      setWidth: (px) => set({ width: px === null ? null : clampRailWidth(px) }),
    }),
    { name: 'supermux:rail-width' },
  ),
)
