// Ephemeral open-state for the Archived sessions sheet (feat-archive-recover).
//
// The sheet is mounted ONCE at shell level (so it overlays every route) and is
// opened from two cheap entry points: the ⌘K command palette and the overview's
// top-right overflow item. A tiny NON-persisted zustand store lets both toggle
// the same instance without prop-drilling or a context provider. Deliberately
// NOT in `useUI` (which is localStorage-persisted) — a sheet should never be
// "open" on a fresh page load.

import { create } from 'zustand'

interface ArchivedSheetStore {
  open: boolean
  setOpen: (open: boolean) => void
  openSheet: () => void
}

export const useArchivedSheet = create<ArchivedSheetStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  openSheet: () => set({ open: true }),
}))
