// TeamWidthToggle — the per-team TEAM CARD width segmented control (FEAT-RESIZE).
//
// Lives in the TEAM CARD header next to the existing Chips↔Cards density toggle
// and matches that toggle's geometry EXACTLY (h-8, rounded-lg, bg-muted, p-0.5
// outer pill with size-7 / rounded-md inner buttons) so the two read as one
// chrome cluster. Hidden on mobile (< sm) — the viewport is too narrow for any
// width other than Full to make sense; the card stays full-width there.
//
// Per-team, persisted via `useTeamWidth(team_name)`. Tooltip + aria-label on
// each segment. Sentence-case labels per the app's anti-vision rules.

import { cn } from '@/lib/utils'
import {
  TEAM_WIDTH_LABEL,
  TEAM_WIDTH_ORDER,
  type TeamWidth,
} from '@/stores/team-width-store'

export interface TeamWidthToggleProps {
  value: TeamWidth
  onChange: (w: TeamWidth) => void
  /** Optional className passthrough — the TEAM CARD header uses `ml-2` to keep
   *  the width toggle separated from the density toggle without that spacing
   *  being baked into this component. */
  className?: string
}

export function TeamWidthToggle({
  value,
  onChange,
  className,
}: TeamWidthToggleProps) {
  return (
    <div
      role="group"
      aria-label="Team card width"
      // Hidden on mobile — narrow viewport, every tier other than Full looks
      // squashed. Same `sm:flex` gate the rest of the desktop-only chrome uses.
      className={cn(
        'hidden h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5 sm:flex',
        className,
      )}
    >
      {TEAM_WIDTH_ORDER.map((mode) => {
        const active = value === mode
        const label = TEAM_WIDTH_LABEL[mode]
        return (
          <button
            key={mode}
            type="button"
            aria-label={`${label} width`}
            aria-pressed={active}
            title={`${label} width`}
            onClick={() => onChange(mode)}
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors',
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <WidthGlyph mode={mode} />
          </button>
        )
      })}
    </div>
  )
}

// ── Glyphs ───────────────────────────────────────────────────────────────────
// Each glyph is a 16×16 rectangle whose WIDTH visually communicates the tier.
// Narrowest (Compact) to widest (Full). Centred inside the box so the four
// glyphs read as one progression rather than four unrelated icons.

function WidthGlyph({ mode }: { mode: TeamWidth }) {
  // Pick rect width per tier — keeps the four icons visually proportional to
  // the actual size choice they represent.
  const w =
    mode === 'compact' ? 5 : mode === 'standard' ? 8 : mode === 'wide' ? 11 : 14
  const x = (16 - w) / 2
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x={x} y="3.5" width={w} height="9" rx="1.5" />
    </svg>
  )
}
