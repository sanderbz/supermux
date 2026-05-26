// FocusStripModeToggle — the strip header's "Match overview ⇄ Custom" chip.
//
// SHAPE. A tiny dropdown menu chip that sits in the strip's "Sessions" header
// row, RIGHT-aligned. Two options: "Match overview" (default — the strip
// reads the overview's group order + per-group sort) and "Custom for this
// strip" (the strip keeps its own per-group sort overrides in a separate
// localStorage namespace; group order is STILL inherited from the overview
// per product decree).
//
// VR HOOK. `data-vr="strip-mode-toggle"` + `data-vr-strip-mode` (match-overview
// | custom) so the visual-regression battery can assert the toggle's state
// from a single selector.

import { Layers, Settings2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FocusStripMode } from '@/lib/focus-strip-layout'

export interface FocusStripModeToggleProps {
  mode: FocusStripMode
  onChange: (next: FocusStripMode) => void
}

const MODE_META: Record<
  FocusStripMode,
  { label: string; hint: string; Icon: typeof Layers }
> = {
  'match-overview': {
    label: 'Match overview',
    hint: 'Same groups and per-group sort as the overview',
    Icon: Layers,
  },
  custom: {
    label: 'Custom for this strip',
    hint: 'Override per-group sort just here (groups stay from the overview)',
    Icon: Settings2,
  },
}

export function FocusStripModeToggle({
  mode,
  onChange,
}: FocusStripModeToggleProps) {
  const ActiveIcon = MODE_META[mode].Icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={`Strip mode: ${MODE_META[mode].label}. Change`}
          title={MODE_META[mode].label}
          data-vr="strip-mode-toggle"
          data-vr-strip-mode={mode}
          // Compact chip — fits the strip's 44px "Sessions" header without
          // crowding the title. Muted until hover; same affordance pattern
          // as the per-group sort chip so the strip's chrome reads as one
          // calm cluster.
          className="flex h-6 min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ActiveIcon className="size-3.5" aria-hidden />
          {/* The short label keeps the chip narrow on the 320px strip. The
              full mode name lives in the menu + aria-label. */}
          <span>{mode === 'match-overview' ? 'Overview' : 'Custom'}</span>
          <span aria-hidden className="opacity-60">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-60">
        {(Object.keys(MODE_META) as FocusStripMode[]).map((m) => {
          const { label, hint, Icon } = MODE_META[m]
          const active = m === mode
          return (
            <DropdownMenuItem
              key={m}
              onSelect={() => onChange(m)}
              aria-current={active ? 'true' : undefined}
              className="flex items-start gap-2"
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="text-foreground">{label}</span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {hint}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default FocusStripModeToggle
