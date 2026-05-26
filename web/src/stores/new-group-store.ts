// Ephemeral cross-component channel for the "New group" verb.
//
// The Overview owns the actual mutation (it has the `layout` + setters), but
// the command palette wants to fire the verb from outside the route. A tiny
// non-persisted zustand store lets the palette read a handler that the
// Overview installs while mounted and clears on unmount — so the verb only
// surfaces when the Overview is alive (no stale-closure dispatch).
//
// Parity with `archived-sheet-store.ts` (same pattern, same reasoning); kept
// out of `useUI` because the action is route-bound, not a persisted UI flag.

import { create } from 'zustand'

type NewGroupAction = (() => void) | null

interface NewGroupStore {
  /** The handler the Overview registers; `null` when no overview is mounted. */
  action: NewGroupAction
  /** Install or clear the handler (Overview useEffect mount/unmount). */
  setAction: (action: NewGroupAction) => void
}

export const useNewGroupAction = create<NewGroupStore>((set) => ({
  action: null,
  setAction: (action) => set({ action }),
}))
