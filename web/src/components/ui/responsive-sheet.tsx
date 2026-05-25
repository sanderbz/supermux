// ResponsiveSheet — one modal detail-panel shell that forks on input modality
// (TECH_PLAN §4.4 / §4.8). The scheduler detail/edit panel and the board issue
// detail panel both used a shadcn `<Sheet side="right">` (a Radix Dialog that
// slides from the edge — no drag, no detents, no drag-to-dismiss). The app's
// nicer mobile pattern is the Vaul drag-detent bottom sheet used by focus mode
// (specials-sheet / session-picker-sheet). This collapses both surfaces onto a
// single primitive:
//   • mobile (`pointer: coarse`) → Vaul `Drawer.Root` modal bottom-sheet — glass
//     material, 36×5 drag indicator, peek/full detents, drag-away + backdrop-tap
//     dismiss, `pb-safe`. Markup lifted from the proven focus-mode sheets.
//   • desktop → the existing shadcn `Sheet` / `SheetContent side="right"`,
//     unchanged feel.
//
// This is the *modal* sibling of focus-mode's `MobileSheet` (which is
// intentionally non-modal and navigates to the overview on dismiss). It shares
// the glass / drag-indicator / detent tokens, NOT the dismiss semantics.
//
// API is a compound of slots so a consumer's existing content (title, an action
// row, a scrollable body, a sticky footer) maps cleanly to both shells:
//   <ResponsiveSheet open onOpenChange title="…" description="…"
//     headerActions={…} footer={…}>{body}</ResponsiveSheet>

import * as React from 'react'
import { Drawer } from 'vaul'

import { cn } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/use-media-query'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

export interface ResponsiveSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Required title (drives `Drawer.Title`/`SheetTitle` for a11y). */
  title: React.ReactNode
  description?: React.ReactNode
  /** Action row rendered under the title (run-now/delete/toggle etc). */
  headerActions?: React.ReactNode
  /** Sticky footer (save/delete) — pinned to the bottom in both shells. */
  footer?: React.ReactNode
  /** Scrollable body. */
  children: React.ReactNode
  /** Extra classes for the desktop SheetContent (e.g. `sm:max-w-md`). */
  className?: string
}

export function ResponsiveSheet(props: ResponsiveSheetProps) {
  // Fork on input modality — the same signal the tile hover/long-press fork uses
  // (use-media-query.ts). Coarse pointers (touch) get the drag-detent bottom
  // sheet; fine pointers (mouse) keep the desktop side panel.
  const isMobile = useMediaQuery('(pointer: coarse)')
  return isMobile ? <MobileBody {...props} /> : <DesktopBody {...props} />
}

// ── mobile: Vaul drag-detent bottom sheet ─────────────────────────────────────

function MobileBody({
  open,
  onOpenChange,
  title,
  description,
  headerActions,
  footer,
  children,
}: ResponsiveSheetProps) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      // Modal detail panel: open at full height, drag straight DOWN to dismiss
      // (no half-collapse detent — a peek detent makes no sense for a form). This
      // matches the modal references (specials-sheet / session-picker-sheet),
      // which deliberately omit snapPoints. backdrop scrim + scroll-lock +
      // drag-away / backdrop-tap dismiss come from the modal Drawer.
      dismissible
    >
      <Drawer.Portal>
        {/* Backdrop — tap to dismiss (Vaul wires the tap handler to the overlay). */}
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          data-testid="responsive-sheet"
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex max-h-[92vh] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          {/* Top region: ONE additive `env(safe-area-inset-top)` (pt-safe) so a
              tall sheet's grab-handle + header always clear the iOS status bar /
              Dynamic Island in standalone PWA (black-translucent + viewport-fit=
              cover). Desktop/web env()=0 → renders as the normal 6px gap. Exactly
              one top inset here — the route shells own their own; the sheet is a
              separate top-level surface, so this never double-insets (ios-pwa). */}
          <div className="shrink-0 pt-safe">
            {/* Drag indicator — 36×5, 2.5px radius, tertiary tint (Termius #11). */}
            <div className="mx-auto mt-1.5 h-[5px] w-9 rounded-[2.5px] bg-muted-foreground/30" />
          </div>

          <div className="border-b border-border px-5 pb-3 pt-2 text-left">
            <Drawer.Title className="truncate text-lg font-semibold text-foreground">
              {title}
            </Drawer.Title>
            {/* Always present so Radix's a11y description requirement is met;
                renders sr-only when the consumer passes none. */}
            <Drawer.Description
              className={cn(
                'truncate text-sm text-muted-foreground',
                !description && 'sr-only',
              )}
            >
              {description}
            </Drawer.Description>
            {headerActions && <div className="mt-2">{headerActions}</div>}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {children}
          </div>

          {footer && (
            <div className="border-t border-border px-5 py-3">{footer}</div>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── desktop: shadcn right-side Sheet (unchanged feel) ─────────────────────────

function DesktopBody({
  open,
  onOpenChange,
  title,
  description,
  headerActions,
  footer,
  children,
  className,
}: ResponsiveSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn('flex w-full flex-col gap-0 p-0 sm:max-w-md', className)}
      >
        <SheetHeader className="border-b border-border px-5 py-4 text-left">
          <SheetTitle className="truncate pr-8">{title}</SheetTitle>
          {description && (
            <SheetDescription className="truncate">
              {description}
            </SheetDescription>
          )}
          {headerActions && <div className="mt-2">{headerActions}</div>}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <div className="border-t border-border px-5 py-3">{footer}</div>
        )}
      </SheetContent>
    </Sheet>
  )
}
