import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'

export interface EmptyStateCta {
  label: string
  onClick?: () => void
  /** Disables the button + shows a busy label (e.g. while a demo boots). */
  busy?: boolean
}

export interface EmptyStateProps {
  /** Monochrome inline SVG (currentColor) — pass a lucide icon element. */
  icon: React.ReactNode
  /** One short sentence, builder-to-builder voice (no "Oops!", no "Great!"). */
  message: string
  /** Optional single primary call-to-action. */
  cta?: EmptyStateCta
  /** Optional secondary action below the primary — used by the first-run
   *  empty state to offer a one-tap demo agent. Rendered as a quiet link-style
   *  button with an optional one-line hint. */
  secondary?: EmptyStateCta & { hint?: string }
  className?: string
}

/** Shared empty-state surface. Springs in via `springs.cardExpand`;
 *  honours Reduce Motion by rendering statically. Every route's empty/no-match
 *  state composes this. */
export function EmptyStatePlaceholder({
  icon,
  message,
  cta,
  secondary,
  className,
}: EmptyStateProps) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springs.cardExpand}
      className={cn(
        'flex flex-col items-center justify-center gap-4 px-6 py-16 text-center',
        className,
      )}
    >
      <div className="flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-7">
        {icon}
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      {cta && (
        <Button onClick={cta.onClick} size="sm" disabled={cta.busy}>
          {cta.label}
        </Button>
      )}
      {secondary && (
        <div className="flex flex-col items-center gap-1.5">
          <Button
            onClick={secondary.onClick}
            size="sm"
            variant="ghost"
            disabled={secondary.busy}
            // A real first-run CTA — kept at the 44pt HIG floor (`h-11`),
            // not the compact `h-9` secondary-button size.
            className="h-11"
          >
            {secondary.label}
          </Button>
          {secondary.hint && (
            <p className="max-w-[15rem] text-xs text-muted-foreground">
              {secondary.hint}
            </p>
          )}
        </div>
      )}
    </motion.div>
  )
}
