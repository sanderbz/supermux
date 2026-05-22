import { Drawer } from 'vaul'
import { X } from 'lucide-react'

import { StatusDot } from './status-dot'
import { TailPreview } from './tail-preview'
import type { TileSession } from './types'

export interface QuickPeekModalProps {
  session: TileSession
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Mobile long-press quick-peek (§4.3). A Vaul half-sheet over the overview,
 *  current session, no input. Close = X or backdrop tap. Glass material
 *  (`bg-card/85 backdrop-blur-xl`) per Termius `.regularMaterial`.
 *
 *  v1 (M11): renders an expanded static tail of the session. The half-sheet,
 *  header, glass, and teardown wiring are final — when M13 lands, swap the
 *  `<TailPreview fill>` below for a read-only `<LiveTerminal name={session.name} />`
 *  (disable `term.onData`); it establishes a real WS sub and tears down on close
 *  because this subtree only mounts while `open`. */
export function QuickPeekModal({
  session,
  open,
  onOpenChange,
}: QuickPeekModalProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[78vh] flex-col rounded-t-2xl border-t border-border bg-card/85 outline-none backdrop-blur-xl">
          {/* Drag handle — 36×5, 2.5px radius, tertiary tint (§4.4 / Termius #11). */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-full bg-muted-foreground/30" />

          <div className="flex items-center gap-2 px-4 py-3">
            <StatusDot status={session.status} />
            <Drawer.Title className="min-w-0 flex-1 truncate text-sm font-medium">
              {session.task_summary || session.name}
            </Drawer.Title>
            <button
              type="button"
              aria-label="Close peek"
              onClick={() => onOpenChange(false)}
              className="-mr-2 flex size-11 items-center justify-center text-muted-foreground"
            >
              <X className="size-5" />
            </button>
          </div>
          <Drawer.Description className="sr-only">
            Terminal preview of {session.name}
          </Drawer.Description>

          <div
            className="mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl"
            style={{ backgroundColor: 'var(--terminal-bg)' }}
          >
            <TailPreview lines={session.preview_lines} fill className="py-2" />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
