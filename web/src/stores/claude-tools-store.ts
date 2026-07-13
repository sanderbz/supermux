// Ephemeral open-state for the provider-aware agent tools sheet.
//
// The manager sheet is mounted ONCE at shell level (inside <CommandPalette>,
// which <Layout> already mounts on every route) so all three entry points open
// the SAME instance: (1) the focus title-bar icon, (2) the ⌘K command, and
// (3) the Settings section. A tiny NON-persisted zustand store lets each opener
// toggle the one instance without prop-drilling or a context provider.
//
// `sessionName` carries the focused session whose project scope to resolve. The
// sheet looks up the session provider + cwd: Claude receives its editable
// registry manager, Codex receives native slash-panel actions. `null` keeps the
// Settings / ⌘K entry point on Claude's global registry.
//
// Deliberately NOT in `useUI` (which is localStorage-persisted) — a sheet should
// never be "open" on a fresh page load.

import { create } from 'zustand'

interface AgentToolsStore {
  open: boolean
  /** Focused session name to scope the project reads to (null = global only). */
  sessionName: string | null
  setOpen: (open: boolean) => void
  /** Open the manager, optionally scoped to a session's project. */
  openSheet: (sessionName?: string | null) => void
}

export const useAgentToolsSheet = create<AgentToolsStore>((set) => ({
  open: false,
  sessionName: null,
  setOpen: (open) => set({ open }),
  openSheet: (sessionName = null) => set({ open: true, sessionName }),
}))
