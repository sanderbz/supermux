import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'

export interface EmptyStateProps {
  /** Monochrome inline SVG (currentColor) — pass a lucide icon element. */
  icon: React.ReactNode
  /** One short sentence, builder-to-builder voice (no "Oops!", no "Great!"). */
  message: string
  /** Optional single primary call-to-action. */
  cta?: { label: string; onClick?: () => void }
  className?: string
}

/** Shared empty-state surface (§4.11). Springs in via `springs.cardExpand`;
 *  honours Reduce Motion by rendering statically. Every route's empty/no-match
 *  state composes this. */
export function EmptyStatePlaceholder({
  icon,
  message,
  cta,
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
        <Button onClick={cta.onClick} size="sm">
          {cta.label}
        </Button>
      )}
    </motion.div>
  )
}
