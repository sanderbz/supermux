import * as React from 'react'
import { motion, type Variants } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'

// iOS-native "grouped inset list" building blocks for the Settings route.
// Sentence-case section headers (never UPPERCASE), opaque grouped cards (the
// correct iOS material for a settings list — glass is reserved for the floating
// nav bar), 44pt+ hit targets, spring physics from the shared preset bank.

/** Stagger container — sections spring in top-to-bottom on mount. */
export const listContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.03 } },
}

/** Per-section spring-in. Pairs with `springs.cardExpand` (Apple Music feel). */
const sectionItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: springs.cardExpand },
}

/** A grouped settings section: sentence-case header, inset card, divided rows. */
export function Section({
  title,
  footnote,
  children,
}: {
  title: string
  footnote?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <motion.section variants={sectionItem} className="flex flex-col">
      <h2 className="px-4 pb-2 text-[13px] font-medium leading-none text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {children}
      </div>
      {footnote ? (
        <p className="px-4 pt-2 text-[12px] leading-snug text-muted-foreground">
          {footnote}
        </p>
      ) : null}
    </motion.section>
  )
}

/** A single row inside a [`Section`]. `control` sits trailing on the same line;
 *  pass `stacked` to drop full-width content (an input, a token field) below. */
export function Row({
  label,
  hint,
  control,
  stacked,
  children,
  className,
}: {
  label?: React.ReactNode
  hint?: React.ReactNode
  control?: React.ReactNode
  stacked?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  const hasTopLine = label !== undefined || control !== undefined
  return (
    <div className={cn('px-4 py-2.5', className)}>
      {hasTopLine ? (
        <div className="flex min-h-[2.75rem] items-center justify-between gap-3">
          {label !== undefined ? (
            <div className="min-w-0">
              <div className="text-[15px] leading-tight text-foreground">
                {label}
              </div>
              {hint ? (
                <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
                  {hint}
                </div>
              ) : null}
            </div>
          ) : null}
          {control ? <div className="shrink-0">{control}</div> : null}
        </div>
      ) : null}
      {stacked ? <div className={hasTopLine ? 'pt-2' : undefined}>{stacked}</div> : null}
      {children}
    </div>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: React.ReactNode
}

/** iOS segmented control. The selected pill morphs between segments with a
 *  shared-layout spring (`toggleSnap` ≈ response 0.35 / damping 0.75). */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentOption<T>[]
  ariaLabel: string
}) {
  const groupId = React.useId()
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex h-11 items-stretch gap-0.5 rounded-xl bg-secondary p-1"
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative inline-flex min-w-[3.25rem] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium transition-colors',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${groupId}`}
                transition={springs.toggleSnap}
                // Elevated lighter pill on both themes (iOS): solid white in
                // light, a translucent light fill in dark so it reads as raised
                // above the darker track rather than recessed.
                className="absolute inset-0 -z-0 rounded-lg bg-white shadow-sm dark:bg-white/15 dark:shadow-none"
              />
            ) : null}
            <span className="relative z-10">{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** iOS toggle switch. 51×31pt track inside a 44pt hit area; knob slides with the
 *  same toggle spring. On = systemBlue (`--primary`), matching the app accent. */
export function Switch({
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
      className="flex h-11 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
    >
      <span
        className={cn(
          'flex h-[31px] w-[51px] items-center rounded-full px-[2px] transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/35',
        )}
      >
        <motion.span
          className="size-[27px] rounded-full bg-white shadow-sm"
          animate={{ x: checked ? 20 : 0 }}
          transition={springs.toggleSnap}
        />
      </span>
    </button>
  )
}
