// Default keyboard groups for the mobile Specials sheet (M15).
//
// These mirror the backend M9 seed (TECH_PLAN §M16: Agent / Shell / Tmux /
// Symbols) so the offline/first-paint Specials sheet shows the same four groups
// the table will return once `/api/kbd-groups` is wired by M16. M16 replaces this
// constant with the live table-backed list (single canonical storage) — until
// then this is the seed the sheet renders. Each `keys[]` entry is a name the
// LiveTerminal's `sendKey` understands (see hooks/use-live-term.ts keyToBytes).

import type { KbdGroup } from '@/lib/api'

export const DEFAULT_KBD_GROUPS: KbdGroup[] = [
  { id: 'agent', name: 'Agent', keys: ['Esc', 'Tab', 'Ctrl-C', 'Ctrl-U'] },
  { id: 'shell', name: 'Shell', keys: ['~', '/', '|', '&'] },
  { id: 'tmux', name: 'Tmux', keys: ['Ctrl-B', 'p', 'n', 'd'] },
  { id: 'symbols', name: 'Symbols', keys: ['$', '#', '`', '*'] },
]
