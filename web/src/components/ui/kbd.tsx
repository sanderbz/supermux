// <Kbd> — the canonical keyboard-shortcut hint primitive.
//
// Replaces ad-hoc `<kbd className="…">` markup scattered across the app
// (command-palette Esc hint, new-action-menu shortcut chip, etc.) and adds
// platform-aware combo formatting so a single source builds "⌘1" on Mac
// and "Ctrl+1" on Windows/Linux.
//
// Two call patterns:
//   • Free-form label:        <Kbd>Esc</Kbd>
//   • Platform-aware combo:   <Kbd combo="mod+1" />
//
// VISUAL: matches the existing ad-hoc style (border, soft bg, mono digits,
// 10–11px). The "muted" variant fits inside a tile/title row where the
// resting cards are already subdued; "default" sits inside dialogs/menus
// where the chip needs to read at a glance.

import * as React from 'react'
import { cn } from '@/lib/utils'
import { formatKbdAria, formatKbdParts } from '@/lib/platform'

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Compact platform-aware combo, e.g. `"mod+1"` / `"mod+shift+k"`. The
   *  `mod` token renders as ⌘ on Mac and Ctrl on Win/Linux. Mutually
   *  exclusive with `children`. */
  combo?: string
  /** Visual density:
   *   • `default` — for dialogs/menus (e.g. command palette Esc hint).
   *   • `muted`   — for in-card hints (e.g. overview tile / focus strip),
   *                  resting tile chrome wins; chip steps back. */
  variant?: 'default' | 'muted'
}

const BASE = 'inline-flex shrink-0 items-center justify-center rounded border font-mono tabular-nums leading-none'

const VARIANT = {
  default:
    'border-border bg-secondary text-muted-foreground px-1.5 py-0.5 text-[11px]',
  muted:
    'border-border/60 bg-background/60 text-muted-foreground/80 px-1 py-0.5 text-[10px]',
} as const

export const Kbd = React.forwardRef<HTMLElement, KbdProps>(function Kbd(
  { combo, variant = 'default', className, children, ...rest },
  ref,
) {
  const parts = combo ? formatKbdParts(combo) : null
  const ariaLabel = combo ? formatKbdAria(combo) : undefined

  return (
    <kbd
      ref={ref}
      aria-label={ariaLabel}
      className={cn(BASE, VARIANT[variant], 'gap-0.5', className)}
      {...rest}
    >
      {parts
        ? parts.map((p, i) => (
            <React.Fragment key={i}>
              {/* Multi-part combos on non-Mac platforms read clearer with a
                  "+" separator (Ctrl+1). Mac glyphs sit flush (⌘1 / ⇧⌘K)
                  the way the system shortcut menu shows them. */}
              {i > 0 && !isMacGlyph(parts[0]) && (
                <span aria-hidden className="opacity-60">+</span>
              )}
              <span aria-hidden>{p}</span>
            </React.Fragment>
          ))
        : children}
    </kbd>
  )
})

/** True when the first rendered part is a Mac glyph (⌘ / ⇧ / ⌥ / ⌃ etc.);
 *  used to suppress the "+" separator so glyphs sit flush. */
function isMacGlyph(part: string): boolean {
  return part === '⌘' || part === '⇧' || part === '⌥' || part === '⌃'
}

export default Kbd
