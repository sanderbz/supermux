/**
 * The touch overflow for a message's actions — the `⋯` on a phone.
 * ─────────────────────────────────────────────────────────────────────────────
 * On a coarse pointer there is no hover and no room for a floating popover, so
 * the "More" menu is the app's shared Vaul half-sheet (`MobileActionSheet` —
 * backdrop, drag-dismiss, safe-area, focus trap) with one 44pt `ActionRow` per
 * export format. Modeled directly on `chat-actions-sheet.tsx`; only the rows
 * differ. Purely presentational — every action is a callback the owner supplies.
 */
import * as React from 'react'
import { Copy, FileCode, FileText, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { MobileActionSheet } from '../focus-mode/mobile-action-sheet'

export interface MessageActionsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Copy the raw markdown to the clipboard. */
  onCopyMarkdown: () => void
  /** Save the raw markdown as a `.md` file. */
  onExportMarkdown: () => void
  /** Save a standalone `.html` render of the message. */
  onExportHtml: () => void
}

export function MessageActionsSheet({
  open,
  onOpenChange,
  onCopyMarkdown,
  onExportMarkdown,
  onExportHtml,
}: MessageActionsSheetProps) {
  // Run the action, then dismiss — the sheet is a launcher, not a home.
  const run = React.useCallback(
    (fn: () => void) => {
      fn()
      onOpenChange(false)
    },
    [onOpenChange],
  )
  return (
    <MobileActionSheet open={open} onOpenChange={onOpenChange} title="Message">
      <div className="flex flex-col px-2 pb-2 pt-1" data-msg-actions-sheet>
        <ActionRow
          icon={Copy}
          label="Copy as Markdown"
          onTap={() => run(onCopyMarkdown)}
        />
        <ActionRow
          icon={FileText}
          label="Export as Markdown (.md)"
          onTap={() => run(onExportMarkdown)}
        />
        <ActionRow
          icon={FileCode}
          label="Export as HTML (.html)"
          onTap={() => run(onExportHtml)}
        />
      </div>
    </MobileActionSheet>
  )
}

/** One folded action — an icon tile + a label, the full row a 44pt target.
 *  Mirrors `chat-actions-sheet.tsx`'s `ActionRow`. */
function ActionRow({
  icon: Icon,
  label,
  onTap,
}: {
  icon: LucideIcon
  label: string
  onTap: () => void
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left',
        'active:bg-muted/60',
      )}
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-muted/60 text-foreground">
        <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="text-[15px] font-medium">{label}</span>
    </button>
  )
}

export default MessageActionsSheet
