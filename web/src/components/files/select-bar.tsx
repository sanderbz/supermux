// The multi-select BOTTOM ACTION BAR.
//
// A fixed-bottom surface in Files (the upload tray is the other, parked above
// the phone tab bar), and it carries the safe-area pad
// itself (`pb-safe`) — the home-indicator lesson every bottom-anchored surface
// in this app has already learned. The list above gets `pb-24` while select
// mode is on so the last row is never trapped underneath it, and the
// destination sheet opens OVER this bar rather than beside it.
//
// At 390px: four icon+label actions plus Cancel fit one row at 44px each; the
// count line sits above them so nothing has to truncate.

import { Copy, Download, FolderInput, Trash2, X } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface SelectBarProps {
  count: number
  onMove: () => void
  onCopy: () => void
  onDownload: () => void
  onDelete: () => void
  onCancel: () => void
  /** True while a fan-out is in flight — every action is disabled so a second
   *  batch can't be started on top of a running one. */
  busy?: boolean
  /** Copy is a SINGLE-FILE verb server-side; a selection containing a folder
   *  cannot be copied, and the bar says so rather than failing N times. */
  canCopy: boolean
}

export function SelectBar({
  count,
  onMove,
  onCopy,
  onDownload,
  onDelete,
  onCancel,
  busy,
  canCopy,
}: SelectBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="glass fixed inset-x-0 bottom-0 z-40 border-t border-hairline pb-safe"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {count} selected
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-11 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
          Cancel
        </button>
      </div>
      <div className="flex items-stretch justify-around gap-1 px-2 pb-2">
        <BarAction
          label="Move"
          icon={<FolderInput className="size-5" />}
          onClick={onMove}
          disabled={busy || count === 0}
        />
        <BarAction
          label="Copy"
          icon={<Copy className="size-5" />}
          onClick={onCopy}
          disabled={busy || count === 0 || !canCopy}
          title={
            canCopy ? undefined : 'Copying a folder isn’t supported yet.'
          }
        />
        <BarAction
          label="Download"
          icon={<Download className="size-5" />}
          onClick={onDownload}
          disabled={busy || count === 0}
        />
        <BarAction
          label="Delete"
          icon={<Trash2 className="size-5" />}
          onClick={onDelete}
          disabled={busy || count === 0}
          destructive
        />
      </div>
    </div>
  )
}

function BarAction({
  label,
  icon,
  onClick,
  disabled,
  destructive,
  title,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex min-h-11 min-w-[4rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] font-medium transition-colors',
        disabled
          ? 'text-muted-foreground/40'
          : destructive
            ? 'text-destructive hover:bg-destructive/10'
            : 'text-foreground hover:bg-accent',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
