import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Upload } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'

export interface DropzoneProps {
  onFiles: (files: File[]) => void
  /** Disable the drop affordance (e.g. while the listing failed to load). */
  disabled?: boolean
  className?: string
  children: React.ReactNode
}

/** Wraps a region so dragging files over it reveals an upload overlay; on drop
 *  it hands the files to `onFiles` (§M20 — POSTs multipart to /api/fs/upload). */
export function Dropzone({
  onFiles,
  disabled,
  className,
  children,
}: DropzoneProps) {
  const [over, setOver] = React.useState(false)
  const depth = React.useRef(0)
  const reduce = useReducedMotion()

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(e) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        if (disabled) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (disabled) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (files.length) onFiles(files)
      }}
    >
      {children}
      <AnimatePresence>
        {over && (
          <motion.div
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            transition={springs.cardExpand}
            className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary bg-background/80 backdrop-blur-sm"
          >
            <div className="flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Upload className="size-6" />
            </div>
            <p className="text-sm font-medium">Drop to upload here</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
