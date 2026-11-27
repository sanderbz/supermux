// ResponsiveSheet — one modal detail-panel shell that forks on input modality.
// The scheduler detail/edit panel and the board issue
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
  /** Inline action rendered on the SAME row as the description, right-aligned.
   *  Use for a single compact action (h-7/h-8) where bundling it onto the
   *  description line saves a row and reads more efficiently than a full
   *  `headerActions` strip. The description still truncates if long; the
   *  trailing action is `shrink-0` so it always fits. */
  descriptionTrailing?: React.ReactNode
  /** Action row rendered under the title (run-now/delete/toggle etc). */
  headerActions?: React.ReactNode
  /** Hide the visible title bar (border + padding) entirely, keeping `title`/
   *  `description` as sr-only for a11y. For panels that render their OWN rich
   *  identity header in the body (e.g. the bot panel: face + editable name +
   *  status) and must not stack a second generic bar above it. */
  hideHeader?: boolean
  /** Sticky footer (save/delete) — pinned to the bottom in both shells. */
  footer?: React.ReactNode
  /** Scrollable body. */
  children: React.ReactNode
  /** Extra classes for the desktop SheetContent (e.g. `sm:max-w-md`). */
  className?: string
  /** Offline bench only: stamp `data-theme` on the PORTALED content root so the
   *  sheet shell resolves a specific theme instead of the single global `<html>`
   *  theme. The sheet portals to `document.body` (escaping a slab's local theme
   *  wrapper), so a multi-theme review page can otherwise only show the sheet in one
   *  global theme. Undefined in production, where the global theme already matches. */
  contentTheme?: 'light' | 'dark'
  /** Mobile only: `false` refuses drag-away, backdrop-tap and Escape, so the
   *  consumer's own close path is the only one — for a sheet holding an
   *  unsaved edit (the chat's file quick look). Default `true`. */
  dismissible?: boolean
  /** Where focus goes when the sheet closes. Radix returns it to a
   *  `Dialog.Trigger`, and a sheet opened from anything else (a link in chat
   *  prose) has none — so without this, focus falls to `<body>`. Call
   *  `preventDefault()` and focus the opener yourself. */
  onCloseAutoFocus?: (event: Event) => void
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
  descriptionTrailing,
  headerActions,
  hideHeader,
  footer,
  children,
  contentTheme,
  dismissible = true,
  onCloseAutoFocus,
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
      dismissible={dismissible}
    >
      <Drawer.Portal>
        {/* Backdrop — tap to dismiss (Vaul wires the tap handler to the overlay). */}
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          data-testid="responsive-sheet"
          onCloseAutoFocus={onCloseAutoFocus}
          {...(contentTheme ? { 'data-theme': contentTheme } : {})}
          // Unlike the focus-mode composer (which lives inside MobileSheet — a
          // box already sized to visualViewport.height and pinned flush to the
          // keyboard), this Vaul sheet is body-portaled and hangs off the LAYOUT
          // viewport, which iOS does NOT shrink for the soft keyboard. So it needs
          // the SINGLE correct lift: `bottom: var(--kb)` raises the sheet by the
          // keyboard inset, and the height cap keeps the TOP clear of the notch.
          // The cap subtracts `--safe-top` (env(safe-area-inset-top), 0 off-device)
          // from the visible height so the sheet top can never rise above the
          // status-bar / Dynamic Island region: keyboard-closed the top lands at
          // `--safe-top` below the physical top (100dvh − inset); keyboard-open the
          // lift `--kb` + capped height still resolves to that same inset floor.
          // Inline wins over the `bottom-0`/`max-h-…` classes (the keyboard-closed
          // fallback: --kb=0, --vvh=100dvh — same inset subtraction so it agrees).
          style={{
            bottom: 'var(--kb, 0px)',
            maxHeight: 'calc(var(--vvh, 92vh) - var(--safe-top, 0px))',
          }}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex max-h-[calc(92vh_-_var(--safe-top,0px))] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-[var(--kb-safe-bottom)] outline-none',
            contentTheme === 'dark' && 'dark',
          )}
        >
          {/* Drag indicator — 36×5, 2.5px radius, tertiary tint.
              NO `pt-safe` wrapper is needed on the header: the height cap already
              subtracts `--safe-top`, so the whole drawer top sits AT the inset
              floor — the grab-handle and title are below the notch by construction.
              A `pt-safe` here would double-count the inset and re-introduce the
              dead space it used to add above the handle. */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />

          {hideHeader ? (
            // The consumer draws its OWN identity header in the body — keep the
            // Radix a11y title/description but render NO visible bar, so nothing
            // stacks above the body header.
            <>
              <Drawer.Title className="sr-only">{title}</Drawer.Title>
              <Drawer.Description className="sr-only">{description}</Drawer.Description>
            </>
          ) : (
            <div className="border-b border-border px-5 pb-3 pt-2 text-left">
              <Drawer.Title className="truncate text-lg font-semibold text-foreground">
                {title}
              </Drawer.Title>
              {/* Always present so Radix's a11y description requirement is met;
                  renders sr-only when the consumer passes none. Wrapped in a
                  flex row so a `descriptionTrailing` action sits on the SAME
                  line, right-aligned — the bulk-action pattern (no extra row,
                  no extra height). */}
              <div className="flex items-center justify-between gap-3">
                <Drawer.Description
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm text-muted-foreground',
                    !description && 'sr-only',
                  )}
                >
                  {description}
                </Drawer.Description>
                {descriptionTrailing && (
                  <div className="shrink-0">{descriptionTrailing}</div>
                )}
              </div>
              {headerActions && <div className="mt-2">{headerActions}</div>}
            </div>
          )}

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
  descriptionTrailing,
  headerActions,
  footer,
  children,
  className,
  contentTheme,
  onCloseAutoFocus,
}: ResponsiveSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        onCloseAutoFocus={onCloseAutoFocus}
        {...(contentTheme ? { 'data-theme': contentTheme } : {})}
        className={cn('flex w-full flex-col gap-0 p-0 sm:max-w-md', contentTheme === 'dark' && 'dark', className)}
      >
        <SheetHeader className="border-b border-border px-5 py-4 text-left">
          <SheetTitle className="truncate pr-8">{title}</SheetTitle>
          {(description || descriptionTrailing) && (
            <div className="flex items-center justify-between gap-3">
              {description ? (
                <SheetDescription className="min-w-0 flex-1 truncate">
                  {description}
                </SheetDescription>
              ) : (
                <span className="flex-1" />
              )}
              {descriptionTrailing && (
                <div className="shrink-0">{descriptionTrailing}</div>
              )}
            </div>
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
