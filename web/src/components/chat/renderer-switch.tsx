/**
 * Chat ⇄ Terminal — the renderer switch (A1 behaviour, A3 T6 clothes).
 * ─────────────────────────────────────────────────────────────────────────────
 * A binary toggle over the ACTIVE renderer: `value` is the mounted surface and
 * a tap pins the other one. (The `auto` cell was retired — an unpinned session
 * resolves to the `chat` default and the toggle simply shows/drives whatever is
 * mounted; the first tap writes a concrete pin.)
 *
 * A3's clothes are unchanged: the hairline capsule rail, the `bg-fill-soft-2`
 * thumb that SLIDES via a shared `layoutId`, `springs.snappy`, and reduced
 * motion keeping the cell while dropping the travel.
 *
 * #66's width knobs are unchanged: `size` ('md' | 'sm') and `labels`
 * ('both' | 'selected'). On the phone header card it runs `size="sm"
 * labels="selected"`, which renders as `Chat · ⌨`.
 *
 * `data-testid="renderer-chat|terminal"`, `role="tablist"` and `aria-selected`
 * are load-bearing — `tests/e2e/smoke/chat-renderer-switch.spec.ts` clicks them.
 */
import { motion, useReducedMotion } from 'framer-motion'
import { useId } from 'react'

// Relative, not `@/`: this module is rendered by `bun test`
// (`tests/unit/chat-header.test.tsx`), whose resolver reads the root
// tsconfig.json — which carries no `paths`. Same reason as `chat-surface.tsx`.
import { motionOff, springs } from '../../lib/springs'
import { cn } from '../../lib/utils'

import type { Renderer } from './renderer-pref'
import { ChatGlyph, TerminalGlyph } from './ui'

const OPTIONS = [
  { value: 'chat', label: 'Chat', Glyph: ChatGlyph },
  { value: 'terminal', label: 'Terminal', Glyph: TerminalGlyph },
] as const

/**
 * The two sizes, in the numbers that matter. `sm` exists for the mobile seam:
 * on the phone this control rides the header card's TRAILING slot next to a
 * 34px back button, a 28px face and the session's name — at `md` it eats 145px
 * of a 366px card and the name is left with a dozen characters. Same capsule,
 * same rail, same motion; two labels and eight pixels of padding smaller.
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
  /** The renderer that is actually MOUNTED — the switch shows and drives the
   *  active surface. A binary Chat ⇄ Terminal control (Auto retired). */
  value: Renderer
  onChange: (v: Renderer) => void
  size?: 'md' | 'sm'
  /**
   * `selected` shows the word only on the chosen side and a glyph on the others
   * (daily-driver QA #6).
   *
   * The phone header card is 366px wide and has to hold a back button, a 28px
   * face, the SESSION'S NAME, a status dot and this control. At `sm` with all
   * words it does not fit at all now that there are three cells. The trailing
   * control is what shrinks first — the name is the reason the header exists —
   * and the words it drops are the ones naming the surfaces you are NOT looking
   * at.
   *
   * Every button keeps its `data-testid`, its `role="tab"` and (via
   * `aria-label`) its name, so the control is unchanged to a screen reader and
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
  // puts the switch on the desktop bar, the phone header AND the tile menu, so
  // "there is only ever one" is not a property to rely on. Scoping it costs
  // nothing: within one switch the id is still shared by every tab, which is
  // what makes the capsule SLIDE.
  const cellId = `chat-renderer-cell-${useId()}`

  return (
    <div
      role="tablist"
      // The `T` hotkey's marker (`renderer-hotkey.ts`, refusal 5c). A tap on a
      // cell leaves the caret ON the cell — on a coarse pointer nothing takes it
      // back, because focusing the composer there would summon the soft
      // keyboard — so the next character typed arrived at a focused tab with the
      // global renderer hotkey armed. It flipped the surface, the reveal focused
      // xterm, and the rest of the sentence was executed in the pty. A `t` while
      // your finger is literally on this control is a stray keystroke, not a
      // shortcut.
      data-renderer-switch=""
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
            // On the PREF cell, not the resolved one: this control reports a
            // choice, and `auto` is a choice.
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
              'sm-t-hover',
              // THE HIT AREA IS NOT THE RAIL. At `sm` the visible cell measures
              // 27–31 × 20 on a phone — a fifth of the 44pt floor by area, and
              // this is the control the whole Chat⇄Terminal toggle runs
              // through. The ::after expander lifts the TARGET to 44px tall
              // without moving a pixel; vertical growth only spills into the
              // card's own padding.
              //
              // THE HORIZONTAL AXIS USED TO BE A LIE. It read
              // `after:min-w-[40px]`, and the claim next to it ("adjacent
              // targets cannot overlap into a mis-tap") was verified by probing
              // ±20px VERTICALLY — which is the one direction that could not
              // catch it. At a 27–31px cell pitch a 40px expander spills ~10px
              // into each neighbour, `elementFromPoint` resolves the overlap to
              // the LATER sibling, and the exclusive own-hit spans measured 28 /
              // 30 / 40px: tapping the middle of "Chat" could land on Terminal.
              //
              // So the pitch is what grows now, and only where it matters:
              // `min-w-11` under `pointer: coarse` makes the CELL itself ≥44px,
              // and the expander is capped at `w-full` so the targets TILE
              // instead of overlapping. A mouse keeps the compact rail.
              '[@media(pointer:coarse)]:min-w-11',
              'after:absolute after:left-1/2 after:top-1/2 after:h-11',
              "after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
              selected ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {selected && (
              <motion.span
                aria-hidden
                // One id, one cell: framer moves the capsule from the old button
                // to the new one instead of cross-fading three of them.
                layoutId={cellId}
                transition={reduce ? motionOff : springs.snappy}
                className="absolute inset-0 rounded-full bg-fill-soft-2"
              />
            )}
            <span className="relative block truncate">
              {glyph ? <o.Glyph /> : o.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
