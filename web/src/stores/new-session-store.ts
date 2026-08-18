// Ephemeral cross-component channel for the "New bot" create verb.
//
// The roster / overview owns the actual New Session sheet (its open state is
// local React state), but the command palette wants to fire the create verb
// from outside the route. A tiny non-persisted zustand store lets the palette
// read a handler the surface installs while mounted and clears on unmount — so
// the verb only surfaces when a surface that can open the sheet is alive (no
// stale-closure dispatch).
//
// Exact parity with `new-group-store.ts` (same pattern, same reasoning); kept
// out of `useUI` because the action is route-bound, not a persisted UI flag.

import { create } from 'zustand'

type NewSessionAction = (() => void) | null

interface NewSessionStore {
  /** The handler the roster/overview registers; `null` when none is mounted. */
  action: NewSessionAction
  /** Install or clear the handler (surface useEffect mount/unmount). */
  setAction: (action: NewSessionAction) => void
}

export const useNewSessionAction = create<NewSessionStore>((set) => ({
  action: null,
  setAction: (action) => set({ action }),
}))
