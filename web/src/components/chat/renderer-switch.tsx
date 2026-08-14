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

const OPTIONS = [
  { value: 'chat', label: 'Chat' },
  { value: 'terminal', label: 'Terminal' },
] as const

export function RendererSwitch({
  value,
  onChange,
}: {
  value: 'chat' | 'terminal'
  onChange: (v: 'chat' | 'terminal') => void
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
      className="inline-flex h-[30px] items-center rounded-full border-[0.5px] border-hairline p-[2px]"
    >
      {OPTIONS.map((o) => {
        const selected = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={`renderer-${o.value}`}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative h-full rounded-full px-3 text-[13.4px] font-medium tracking-[-0.05px]',
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
            <span className="relative">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
