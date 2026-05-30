// focus-mode/mode-labels.ts — shared mode label helpers.
//
// Kept in a non-component module so consumers (the Claude tools sheet's mode
// section, any future read-only chip) can import `modeChipLabel` without
// tripping the react-refresh/only-export-components rule (a component file
// must export only components for Fast Refresh to work).

import type { SessionMode } from '@/lib/api'

/** Short glanceable label for a permission mode (toast copy + any read-only chip). */
export function modeChipLabel(mode: SessionMode): string {
  switch (mode) {
    case 'accept_edits':
      return 'Accept edits'
    case 'plan':
      return 'Plan'
    case 'bypass':
      return 'Bypass'
    default:
      return 'Normal'
  }
}
