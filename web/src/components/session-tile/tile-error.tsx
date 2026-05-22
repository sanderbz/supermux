import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { RotateCw, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { eases } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ERROR } from '@/brand/copy'
import type { TileSession } from './types'

export interface TileErrorProps {
  session: TileSession
  onReattach?: (name: string) => void
  onRemove?: (name: string) => void
  className?: string
}

/** Tile for a session whose tmux backing is gone (§4.3 error state). Calm
 *  destructive border + "(missing)" prefix — never an alarmist full-red fill.
 *  Click opens a recovery sheet (Reattach / Remove from amux); the destructive
 *  action is explicit, never auto-fired. */
export function TileError({
  session,
  onReattach,
  onRemove,
  className,
}: TileErrorProps) {
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(false)
  const title = session.task_summary || session.name

  return (
    <>
      <motion.button
        type="button"
        onClick={() => setOpen(true)}
        whileTap={
          reduce
            ? undefined
            : { scale: 0.96, transition: { duration: 0.1, ease: eases.out } }
        }
        className={cn(
          'flex w-full flex-col items-start rounded-xl border border-destructive/60 bg-card p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        style={{ height: 156 }}
      >
        <span className="line-clamp-2 text-sm font-medium leading-tight">
          <span className="text-destructive">(missing)</span> {title}
        </span>
        <span className="mt-auto line-clamp-2 text-xs text-muted-foreground">
          {ERROR.sessionMissing.body}
        </span>
      </motion.button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>{ERROR.sessionMissing.title}</SheetTitle>
            <SheetDescription>{ERROR.sessionMissing.body}</SheetDescription>
          </SheetHeader>
          <div className="mt-6 flex flex-col gap-2">
            <Button
              onClick={() => {
                onReattach?.(session.name)
                setOpen(false)
              }}
            >
              <RotateCw /> Reattach
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                onRemove?.(session.name)
                setOpen(false)
              }}
            >
              <Trash2 /> Remove from amux
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
