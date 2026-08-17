/**
 * Auto ⇄ Chat ⇄ Terminal — the renderer switch (A1 behaviour, A3 T6 clothes,
 * A5 T2 third value).
 * ─────────────────────────────────────────────────────────────────────────────
 * A1 shipped two cells and a tap that lived in `React.useState`. A5 makes the
 * choice a PREFERENCE (`components/chat/renderer-pref.ts`), which needs a third
 * value: `auto` — "follow the global default", a real stored state that must be
 * distinguishable from "happens to equal the default today", because the
 * default moves (Settings now, fase A7 for everyone).
 *
 * The two vocabularies stay separate and both are on screen at once:
 *   · the THUMB and `aria-selected` sit on the **pref** cell — what you chose;
 *   · a 1.5px accent underline marks the **resolved** cell while the pref is
 *     `auto` — what you are therefore looking at. "Auto, currently Chat" is one
 *     glance and one control, not two.
 *
 * A3's clothes are unchanged: the hairline capsule rail, the `bg-fill-soft-2`
 * thumb that SLIDES via a shared `layoutId`, `springs.snappy`, and reduced
 * motion keeping the cell while dropping the travel.
 *
 * #66's width knobs are unchanged and NOT replaced by a `variant` axis — they
 * already solve the same problem the plan's `full`/`compact` split was invented
 * for, and one axis is cheaper than two: `size` ('md' | 'sm') and `labels`
 * ('both' | 'selected'). With three cells the phone header card runs
 * `size="sm" labels="selected"`, which renders as `A · Chat · ⌨` — the leading
 * glyph cell the plan asks for, out of the mechanism that was already there.
 *
 * `data-testid="renderer-chat|terminal"`, `role="tablist"` and `aria-selected`
 * are load-bearing — `tests/e2e/smoke/chat-renderer-switch.spec.ts` clicks them.
 * The new cell is `data-testid="renderer-auto"`.
 */
import { motion, useReducedMotion } from 'framer-motion'
import { useId } from 'react'

// Relative, not `@/`: this module is rendered by `bun test`
// (`tests/unit/chat-header.test.tsx`), whose resolver reads the root
// tsconfig.json — which carries no `paths`. Same reason as `chat-surface.tsx`.
import { motionOff, springs } from '../../lib/springs'
import { cn } from '../../lib/utils'

import type { Renderer, RendererPref } from './renderer-pref'
import { ChatGlyph, TerminalGlyph } from './ui'

/** The `auto` cell's glyph — a bare `A`, the same 13px metrics the word labels
 *  use, so the rail's three cells sit on one baseline. Not an icon: every icon
 *  that means "automatic" (a wand, a sparkle, a circular arrow) reads as an
 *  ACTION on a control whose other two cells are nouns. */
function AutoGlyph() {
  return (
    <span aria-hidden className="block font-medium leading-none">
      A
    </span>
  )
}

const OPTIONS = [
  { value: 'auto', label: 'Auto', Glyph: AutoGlyph },
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
  resolved,
  onChange,
  size = 'md',
  labels = 'both',
}: {
  /** What the USER chose — including `auto`. */
  value: RendererPref
  /** What is actually MOUNTED right now. Only consulted while `value` is
   *  `auto`, to underline the cell the default currently lands on. */
  resolved: Renderer
  onChange: (v: RendererPref) => void
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
      // Spelled out so "Auto, currently Chat" is one announcement rather than
      // a selected tab plus an unexplained underline.
      aria-label={
        value === 'auto'
          ? `Renderer: Auto (currently ${resolved === 'chat' ? 'Chat' : 'Terminal'})`
          : 'Session renderer'
      }
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
        // In the compact rail the `auto` cell is ALWAYS the bare `A`, even when
        // it is the selected one. Measured on the phone header card (390px):
        // with the word it truncated to `A…`, which is the QA #6 regression the
        // third cell would otherwise reintroduce — and "Auto" spelled out buys
        // nothing the underline on the resolved cell does not already say.
        const glyph =
          labels === 'selected' && (!selected || o.value === 'auto')
        // The resolved marker is meaningful only under `auto`: with an explicit
        // pin the thumb already sits on the mounted renderer, and a second
        // marker on the same cell would be noise.
        const marksResolved = value === 'auto' && o.value === resolved
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
            data-resolved={marksResolved ? 'true' : undefined}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative h-full min-w-0 rounded-full font-medium tracking-[-0.05px]',
              glyph ? 'grid flex-none place-items-center px-2' : SIZE[size].cell,
              'sm-t-hover',
              // THE HIT AREA IS NOT THE RAIL. At `sm` the visible cell measures
              // 27–31 × 20 on a phone — a fifth of the 44pt floor by area, and
              // this is the control the whole Chat⇄Terminal toggle runs
              // through. The rail keeps its 26px so the header card's geometry
              // is untouched; an ::after expander lifts the TARGET to 44px tall
              // and ≥40px wide without moving a pixel. Vertical growth only
              // spills into the card's own padding, and the cells stay side by
              // side so adjacent targets cannot overlap into a mis-tap
              // (verified with elementFromPoint at ±20px on /dev/chat-ui).
              'after:absolute after:left-1/2 after:top-1/2 after:h-11 after:min-w-[40px]',
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
            {marksResolved && (
              // 1.5px of the session accent under the cell the default lands on.
              // Inside the button's padding box, so it cannot change the rail's
              // height or the cell's width at any size.
              <span
                aria-hidden
                className="absolute inset-x-2 bottom-[3px] h-[1.5px] rounded-full bg-agent"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
