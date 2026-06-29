// Ephemeral open-state for the Snippets manager sheet.
//
// Mirrors `claude-tools-store`: a tiny NON-persisted zustand store so every entry
// point (Settings → Manage snippets, and any future ⌘K / focus opener) toggles
// the SAME shell-level <SnippetsManagerSheet> instance without prop-drilling or a
// context provider. Snippets are global (no per-session scope), so — unlike the
// Claude-tools store — there is no `sessionName` to carry.
//
// Deliberately NOT in `useUI` (which is localStorage-persisted): a sheet must
// never be "open" on a fresh page load.

import { create } from 'zustand'

interface SnippetsManagerStore {
  open: boolean
  setOpen: (open: boolean) => void
  openSheet: () => void
}

export const useSnippetsManager = create<SnippetsManagerStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  openSheet: () => set({ open: true }),
}))
