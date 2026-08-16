/**
 * Chat ⇄ Terminal — the renderer switch (fase A1 behaviour, A3 T6 clothes).
 * ─────────────────────────────────────────────────────────────────────────────
 * Unchanged from A1: chat is the default when the flag is on, the terminal is
 * ONE tap away, and this control only reports a choice — mounted-but-hidden
 * retention is A5 (§6.2).
 *
 * What A3 changes is the language: the approved segmented control is a hairline
 * capsule rail, 30px tall, with 13.4/500 labels and a `bg-fill-soft-2` cell that
 * SLIDES between them (shared `layoutId`, `springs.snappy`) rather than blinking
 * on and off — the same thumb the new-session kind toggle uses, so the app has
 * one segmented control and not two. Reduced motion keeps the cell and drops the
 * travel: the selection must still be visible, it just arrives instantly.
 *
 * `data-testid="renderer-chat|terminal"`, `role="tablist"` and `aria-selected`
 * are load-bearing — `tests/e2e/smoke/chat-renderer-switch.spec.ts` clicks them.
 */
import { motion, useReducedMotion } from 'framer-motion'
import { useId } from 'react'

// Relative, not `@/`: this module is rendered by `bun test`
// (`tests/unit/chat-header.test.tsx`), whose resolver reads the root
// tsconfig.json — which carries no `paths`. Same reason as `chat-surface.tsx`.
import { springs } from '../../lib/springs'
import { cn } from '../../lib/utils'

import { ChatGlyph, TerminalGlyph } from './ui'

const OPTIONS = [
  { value: 'chat', label: 'Chat', Glyph: ChatGlyph },
  { value: 'terminal', label: 'Terminal', Glyph: TerminalGlyph },
] as const

/**
 * The two sizes, in the numbers that matter. `sm` exists for fase A5's mobile
 * seam: on the phone this control rides the header card's TRAILING slot next to
 * a 34px back button, a 28px face and the session's name — at `md` it eats
 * 145px of a 366px card and the name is left with a dozen characters. Same
 * capsule, same rail, same motion; two labels and eight pixels of padding
 * smaller.
 */
const SIZE = {
  md: { rail: 'h-[30px]', cell: 'px-3 text-[13.4px]' },
  sm: { rail: 'h-[26px]', cell: 'px-2.5 text-[12.5px]' },
} as const

export function RendererSwitch({
  value,
  onChange,
  size = 'md',
  labels = 'both',
}: {
  value: 'chat' | 'terminal'
  onChange: (v: 'chat' | 'terminal') => void
  size?: 'md' | 'sm'
  /**
   * `selected` shows the word only on the chosen side and a glyph on the other
   * (daily-driver QA #6).
   *
   * The phone header card is 366px wide and has to hold a back button, a 28px
   * face, the SESSION'S NAME, a status dot and this control. At `sm` with both
   * words it measured 127px, which left a 13-character name 91px and rendered a
   * three-character one as `i…`. The trailing control is what shrinks first —
   * the name is the reason the header exists — and the word it drops is the one
   * naming the surface you are NOT looking at.
   *
   * Both buttons keep their `data-testid`, their `role="tab"` and (via
   * `aria-label`) their name, so the control is unchanged to a screen reader and
   * to `tests/e2e/smoke/chat-renderer-switch.spec.ts`.
   */
  labels?: 'both' | 'selected'
}) {
  const reduce = useReducedMotion() ?? false
  // PER INSTANCE, not a constant: framer resolves `layoutId` GLOBALLY, so two
  // mounted switches sharing one literal id are treated as one element — framer
  // picks a lead, projects the other onto its box and drives it to opacity 0.
  // The observable failure is that BOTH controls lose their selection capsule
  // (measured: `opacity: 0` on the cell, positioned over the other tab), which
  // is silent — the markup, the classes and the e2e hooks all still pass. A5
  // adds the mobile call site, so "there is only ever one" is not a property to
  // rely on. Scoping it costs nothing: within one switch the id is still shared
  // by both tabs, which is what makes the capsule SLIDE.
  const cellId = `chat-renderer-cell-${useId()}`

  return (
    <div
      role="tablist"
      aria-label="Session renderer"
      // The rail is a hairline and nothing else: filling it would put
      // `bg-fill-soft` under a `bg-fill-soft-2` cell — 4.5% ink under 7% ink —
      // and the selection would have to be read off the label colour instead of
      // the capsule. Bare paper gives the cell its whole contrast budget.
      className={cn(
        // `min-w-0 shrink`, not `flex-none`: in the phone header this control is
        // the member that gives way when the card runs out of room, because the
        // session's name is the reason the card exists (QA #6). At every width
        // that has room it sits at its natural size, so nothing else changes.
        'inline-flex min-w-0 shrink items-center rounded-full border-[0.5px] border-hairline p-[2px]',
        SIZE[size].rail,
      )}
    >
      {OPTIONS.map((o) => {
        const selected = value === o.value
        const glyph = labels === 'selected' && !selected
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            // The word is gone, the NAME is not: the control still announces
            // "Terminal" and still carries it as a tooltip on a pointer device.
            aria-label={glyph ? o.label : undefined}
            title={glyph ? o.label : undefined}
            data-testid={`renderer-${o.value}`}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative h-full min-w-0 rounded-full font-medium tracking-[-0.05px]',
              glyph ? 'grid flex-none place-items-center px-2' : SIZE[size].cell,
              'transition-colors duration-[120ms]',
              selected ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {selected && (
              <motion.span
                aria-hidden
                // One id, one cell: framer moves the capsule from the old button
                // to the new one instead of cross-fading two of them.
                layoutId={cellId}
                transition={reduce ? { duration: 0 } : springs.snappy}
                className="absolute inset-0 rounded-full bg-fill-soft-2"
              />
            )}
            <span className="relative block truncate">{glyph ? <o.Glyph /> : o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
