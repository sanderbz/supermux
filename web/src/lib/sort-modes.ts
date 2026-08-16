/**
 * The display option MODEL — one vocabulary, every surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * The overview's display controls existed twice: a mobile `OverviewDisplayMenu`
 * with View / Sort / Size / Hide-stopped, and four separate desktop chips. Two
 * implementations of one idea drift, and they had already started to (the mobile
 * sheet grew the A5 renderer option; the desktop chips did not).
 *
 * Fase B2 T9 makes this file the model both read from: labels, hints and glyphs
 * for the global sort modes, the per-group sort modes and the group-by presets.
 * `components/roster/display-controls.tsx` (desktop popover) and
 * `session-tile/overview-display-menu.tsx` (mobile sheet) are two RENDERINGS of
 * it — Settings → Appearance and the ⌘K palette are documented cross-references,
 * not third sources.
 */
import {
  ArrowDownAZ,
  Clock,
  Folder,
  GripVertical,
  Hourglass,
  Layers,
  Server,
  Signal,
  Sparkles,
  Type,
} from 'lucide-react'

import {
  GROUP_SORT_HINT,
  GROUP_SORT_LABEL,
  GROUP_SORT_MODES,
  type GroupBy,
  type GroupSortMode,
  type SortMode,
} from '@/lib/overview-layout'

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

/** Glyph + label per PER-GROUP sort mode — the chip on a group header, and the
 *  strip's 4-mode subset. The two surfaces pick different SUBSETS of this map;
 *  neither invents an entry. */
export const GROUP_SORT_META: Record<
  GroupSortMode,
  { label: string; hint: string; Icon: typeof Sparkles }
> = {
  // Labels and hints come from `overview-layout.ts`'s shipped maps rather than
  // being retyped here — this file adds the GLYPH, it does not get to reword the
  // vocabulary. (`age` really is "newest first"; the kernel sorts by creation
  // stamp descending. The name is historical; the hint is the truth.)
  smart: { label: GROUP_SORT_LABEL.smart, hint: GROUP_SORT_HINT.smart, Icon: Sparkles },
  custom: { label: GROUP_SORT_LABEL.custom, hint: GROUP_SORT_HINT.custom, Icon: GripVertical },
  name: { label: GROUP_SORT_LABEL.name, hint: GROUP_SORT_HINT.name, Icon: Type },
  status: { label: GROUP_SORT_LABEL.status, hint: GROUP_SORT_HINT.status, Icon: Signal },
  recent: { label: GROUP_SORT_LABEL.recent, hint: GROUP_SORT_HINT.recent, Icon: Clock },
  age: { label: GROUP_SORT_LABEL.age, hint: GROUP_SORT_HINT.age, Icon: Hourglass },
}

/** The subset the 320px focus strip exposes — `custom` (no drag affordance
 *  there) and `age` earn no room. Declared HERE, next to the full set, so the
 *  two can never disagree about what a mode means. */
export const STRIP_GROUP_SORT_MODES: GroupSortMode[] = GROUP_SORT_MODES.filter(
  (m) => m !== 'custom' && m !== 'age',
)

/** Glyph + label per GROUP-BY preset. Presets are derived groupings: they never
 *  write `custom`, so switching to one and back cannot destroy a drag order. */
export const GROUP_BY_META: Record<
  GroupBy,
  { label: string; hint: string; Icon: typeof Sparkles }
> = {
  none: { label: 'No grouping', hint: 'One list — or your own groups in Custom', Icon: Layers },
  dir: { label: 'Folder', hint: 'By working directory', Icon: Folder },
  provider: { label: 'Provider', hint: 'Claude, Codex, Kimi…', Icon: Sparkles },
  host: { label: 'Host', hint: 'Local and each remote host', Icon: Server },
  status: { label: 'Status', hint: 'Needs input, running, stopped…', Icon: Signal },
}
