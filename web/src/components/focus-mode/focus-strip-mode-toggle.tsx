// FocusStripModeToggle — the strip header's 5-option view-mode dropdown.
//
// One control at the top of the strip with five options:
//
//   • As overview     (default) — mirror the overview's groups + per-group sort
//   • Smart                       — flat, smart sort (pinned/active/recent)
//   • Recent activity             — flat, most recent first
//   • Status                      — flat, active first → stopped last
//   • Name                        — flat, alphabetical
//
// "As overview" keeps the strip's group sections + per-group sort chips
// intact. The other modes flatten the strip into a single sorted list with
// no group chrome. The redesign exists because the previous "match-overview
// vs custom" toggle was invisible and the per-group sort chips were silently
// overridden by the overview's persisted prefs.
//
// VR HOOKS. `data-vr="strip-mode-toggle"` + `data-vr-view-mode` so a visual
// regression battery can assert state from a single selector.

import {
  ArrowDownAZ,
  ArrowUpDown,
  Check,
  Layers,
  Sparkles,
} from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  FOCUS_STRIP_VIEW_MODES,
  type FocusStripViewMode,
} from '@/lib/focus-strip-layout'

export interface FocusStripModeToggleProps {
  mode: FocusStripViewMode
  onChange: (next: FocusStripViewMode) => void
}

const MODE_META: Record<
  FocusStripViewMode,
  { label: string; hint: string; Icon: typeof Layers }
> = {
  'as-overview': {
    label: 'As overview',
    hint: 'Mirror the overview — same groups, same per-group sort',
    Icon: Layers,
  },
  smart: {
    label: 'Smart',
    hint: 'Active and pinned first, then by recent activity',
    Icon: Sparkles,
  },
  recent: {
    label: 'Recent activity',
    hint: 'Most recently active first',
    Icon: ArrowUpDown,
  },
  status: {
    label: 'Status',
    hint: 'Running, waiting, idle, stopped',
    Icon: ArrowUpDown,
  },
  name: {
    label: 'Name',
    hint: 'A → Z by session name',
    Icon: ArrowDownAZ,
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
          aria-label={`Strip view: ${MODE_META[mode].label}. Change`}
          title={MODE_META[mode].label}
          data-vr="strip-mode-toggle"
          data-vr-view-mode={mode}
          // Compact chip — fits the strip's 44 px "Sessions" header without
          // crowding the title. Muted until hover.
          className="flex h-6 min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ActiveIcon className="size-3.5" aria-hidden />
          <span>{MODE_META[mode].label}</span>
          <span aria-hidden className="opacity-60">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-60">
        {FOCUS_STRIP_VIEW_MODES.map((m) => {
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
                <span className="flex items-center gap-1 text-foreground">
                  {label}
                  {active && (
                    <Check
                      className="size-3.5 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                </span>
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
