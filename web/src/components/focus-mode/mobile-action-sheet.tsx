// MobileActionSheet — the single reusable Vaul shell for mobile focus panels.
//
// Lifted verbatim from the GOOD dots panel (`specials-sheet.tsx`): a Vaul
// `Drawer` half-sheet with a real backdrop (`bg-black/40` → tap-away dismiss for
// free), a glass `Drawer.Content` (`rounded-t-[10px]`, `pb-safe`), the 36×5 drag
// handle, and an accessible `Drawer.Title`. Vaul owns the open/close state
// machine, the swipe-down-to-dismiss gesture, the focus trap, scroll-lock and
// safe-area — so the contents are just ordinary buttons and nothing fights the
// tap.
//
// All three mobile action panels (Specials/Quick-keys, Slash commands, Snippets)
// render their CONTENT inside this one shell, so they share one quirk-free
// primitive — only their bodies differ. This replaces the slash custom popover
// (no backdrop, desktop-hack pick) and the snippet hand-rolled motion slide-up.

import * as React from 'react'
import { Drawer } from 'vaul'

import { cn } from '@/lib/utils'

export interface MobileActionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible sheet title, shown sentence-case in the header (Vaul.Title). */
  title: string
  /** Optional trailing header control (e.g. the Quick-keys "Edit" pill). Sits
   *  on the title row, right-aligned. */
  headerAction?: React.ReactNode
  children: React.ReactNode
}

export function MobileActionSheet({
  open,
  onOpenChange,
  title,
  headerAction,
  children,
}: MobileActionSheetProps) {
  return (
    // z-[70]: above the compose sheet (surface z-[65] / backdrop z-[64]) so the
    // in-sheet 📎 picker, launched from inside compose, paints ON TOP and its
    // Camera/Photo/Files rows are tappable — not occluded. As a modal action
    // sheet (its own backdrop + drag-dismiss) sitting topmost is correct for
    // EVERY caller (Quick-keys, Snippets, Session-picker open it standalone over
    // the focus sheet at z-50, so a higher layer is equally fine there).
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[70] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[70] flex max-h-[85vh] flex-col rounded-t-[10px]',
            'border-t border-border/60 pb-safe outline-none',
          )}
        >
          {/* Drag indicator — 36×5, 2.5px radius, tertiary tint. */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-3">
            <Drawer.Title className="text-[13px] font-semibold text-muted-foreground">
              {title}
            </Drawer.Title>
            {headerAction}
          </div>
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

export default MobileActionSheet
