// JumpIndexContext — the canonical 1..9 ⌘N / Ctrl+N slot map for the surface
// that's currently in the foreground (today: overview).
//
// Why context, not a prop chain? The overview's render tree is several layers
// deep (Overview → GroupGrid → SortableTileSlot → SessionTile; and in parallel
// Overview → TeamCard → SessionTile for team-leads). Plumbing a `jumpIndex`
// prop through every container would touch six files and bloat their prop
// surfaces with one feature flag. A read-only context, mounted ONCE at the
// route level, keeps the surface flat: any descendant <SessionTile> reads the
// map; surfaces without a provider get the empty default (no chip).
//
// The provider value is built by the route (overview.tsx) in the same order
// it renders sessions — team-leads first, then ordinary sessions in display
// order — so the chip on a tile always matches what pressing that digit does
// (see `useGlobalSessionShortcuts`).

import * as React from 'react'

/** Map of session name → 1-indexed ⌘N slot (1..9). Sessions absent from the
 *  map have no shortcut on this surface. */
export type JumpIndexMap = ReadonlyMap<string, number>

const EMPTY: JumpIndexMap = new Map()

const JumpIndexContext = React.createContext<JumpIndexMap>(EMPTY)

export const JumpIndexProvider = JumpIndexContext.Provider

/** Read the 1-indexed slot for a session name on the current surface. Returns
 *  `undefined` outside a provider — every render path that calls this is
 *  defensive about the missing-slot case (no chip, no shortcut). */
export function useJumpIndex(name: string): number | undefined {
  return React.useContext(JumpIndexContext).get(name)
}

/** Read the whole map — used by the global ⌘N keydown handler that lives
 *  alongside the provider. */
export function useJumpIndexMap(): JumpIndexMap {
  return React.useContext(JumpIndexContext)
}
