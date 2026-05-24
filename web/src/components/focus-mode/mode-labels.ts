// focus-mode/mode-labels.ts — shared mode label helpers (mode-shift).
//
// Kept in its own (non-component) module so <ModeMenu> and the <ModeChip> in
// focus-header can both import `modeChipLabel` without tripping the
// react-refresh/only-export-components rule (a component file must export only
// components for Fast Refresh to work).

import type { SessionMode } from '@/lib/api'

/** Short glanceable label for a permission mode (the menu trigger aria-label +
 *  the title chip). */
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
