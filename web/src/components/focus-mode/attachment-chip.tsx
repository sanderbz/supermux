// AttachmentChip + AttachmentRow — the calm, on-brand feedback for a file/
// screenshot being sent into the session. Shown near the input/dock the moment
// the user picks a file (BEFORE the absolute path lands in the terminal), so they
// can see what's attached. An image shows a small thumbnail; any file shows a
// document icon + name. Uploading = a quiet spinner; ready = the thumbnail/name;
// error = a destructive tint. Each chip is dismissible (×, ≥44pt hit area).

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { FileText, Loader2, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { Attachment } from './use-attachment-upload'

function AttachmentChip({
  attachment,
  onDismiss,
}: {
  attachment: Attachment
  onDismiss: (id: string) => void
}) {
  const reduce = useReducedMotion()
  const { id, name, uploading, previewUrl, error } = attachment
  return (
    <motion.div
      layout={!reduce}
      initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
      transition={springs.cardExpand}
      className={cn(
        // Soft iOS-native pill, 10px continuous corner, no hard border.
        'flex h-9 shrink-0 items-center gap-2 rounded-[10px] bg-secondary pl-1.5 pr-1',
        error && 'bg-destructive/10',
      )}
    >
      {/* Thumb / icon — 24px square with a matching 8px corner. */}
      <div className="relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background/60">
        {previewUrl ? (
          // Object-URL thumbnail; revoked by the hook on dismiss/unmount.
          <img src={previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <FileText
            className="size-[15px] text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden
          />
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2
              className="size-3.5 animate-spin text-primary"
              aria-hidden
            />
          </div>
        )}
      </div>

      <span
        className={cn(
          'max-w-[8rem] truncate text-[13px] font-medium',
          error ? 'text-destructive' : 'text-secondary-foreground',
        )}
        title={error ? `${name} — ${error}` : name}
      >
        {name}
      </span>

      <motion.button
        type="button"
        aria-label={`Remove ${name}`}
        whileTap={{ scale: 0.9 }}
        transition={springs.buttonPress}
        // Preserve terminal focus on mobile — a dismiss tap must not steal focus
        // from xterm's hidden textarea (which would drop the soft keyboard).
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onDismiss(id)}
        // 28px visible inside a ≥44pt hit area via the parent row's height + this
        // padding; the glyph stays a quiet muted ×.
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-background/60"
      >
        <X className="size-4" strokeWidth={2} aria-hidden />
      </motion.button>
    </motion.div>
  )
}

/** The horizontal scroller of attachment chips. Renders nothing when empty. */
export function AttachmentRow({
  attachments,
  onDismiss,
  className,
}: {
  attachments: Attachment[]
  onDismiss: (id: string) => void
  className?: string
}) {
  if (attachments.length === 0) return null
  return (
    <div
      className={cn(
        'flex items-center gap-2 overflow-x-auto pb-0.5',
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {attachments.map((a) => (
          <AttachmentChip key={a.id} attachment={a} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  )
}

export default AttachmentRow
