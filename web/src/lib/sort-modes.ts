import { ArrowDownAZ, GripVertical, Sparkles } from 'lucide-react'

import { type SortMode } from '@/lib/overview-layout'

/** Glyph + short label per global overview sort mode (`smart` | `alpha` |
 *  `custom`). ONE source of truth for the sort vocabulary, shared by the
 *  desktop <SortControl> dropdown and the mobile Display menu so they never
 *  drift. Sentence case (house rule: never UPPERCASE labels). */
export const SORT_MODE_META: Record<
  SortMode,
  { label: string; hint: string; Icon: typeof Sparkles }
> = {
  smart: {
    label: 'Smart',
    hint: 'Active and pinned sessions first',
    Icon: Sparkles,
  },
  alpha: {
    label: 'A–Z',
    hint: 'Alphabetical by name',
    Icon: ArrowDownAZ,
  },
  custom: {
    label: 'Custom',
    hint: 'Drag to reorder, group with section headers',
    Icon: GripVertical,
  },
}
