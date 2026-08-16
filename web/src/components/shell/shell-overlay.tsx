// <ShellOverlay> — three fidelities, one component (master plan §11.4, Grok
// device 16: inline card / side pane / overlay-or-sheet are the SAME component
// with a `variant` prop that changes only chrome).
//
// TWO DEVICE FORMS, and the reason is load-bearing:
//
//   • DESKTOP (≥md, pointer:fine) — `position: absolute; inset: 0` INSIDE the
//     shell's content column. The nav rail and the route header stay visible and
//     clickable beside the scrim, so the overlay reads as an object placed on
//     this page rather than as a modal that replaced the app. The frame's size
//     comes from container queries against the column (shell-overlay-frame.ts),
//     so it re-sizes with the split without a resize listener.
//
//   • MOBILE — renders `<ResponsiveSheet>` verbatim. On mobile the focus route
//     strips both navs and lives in a body-level `position: fixed` sheet, so a
//     shell-absolute overlay would simply be occluded by it. The sheet is the
//     correct mobile form and it already exists, drag-detents and all.
//
// PROP CONTRACT: deliberately the two props fase A4's plan assumes (`open`,
// `onOpenChange`) plus `variant`. The master plan's intended first consumer was
// the Attention card; A4 has since landed and its attention surface turned out
// to be IN-PANE (`<AttentionOverlay>` sits over the chat pane only), so it is
// not a consumer of this component. The real first consumer is `ArchivedSheet`
// — shell-mounted, low-traffic and reversible.

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { FocusScope } from '@radix-ui/react-focus-scope'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { motionOff, springs, tweens } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import {
  ResponsiveSheet,
  type ResponsiveSheetProps,
} from '@/components/ui/responsive-sheet'
import { FRAME_SIZE_CSS } from './shell-overlay-frame'
import { OVERLAY_OPEN_ATTR, useShellOverlayHost } from './use-shell-overlay'

export interface ShellOverlayProps extends ResponsiveSheetProps {
  /** `frame` — a raised card centred in the content column (the default).
   *  `pane`  — the §11.3 side-pane form, pinned to the column's right edge. */
  variant?: 'frame' | 'pane'
}

/** The desktop form is only correct where there is a shell to sit inside AND a
 *  precise pointer to hit a 26px close button with. Everything else — phones,
 *  tablets, a narrow desktop window — gets the sheet. Exported so the contract
 *  is assertable without a browser. */
export const SHELL_OVERLAY_DESKTOP_QUERY = '(min-width: 768px) and (pointer: fine)'

function useDesktopForm(): boolean {
  return useMediaQuery(SHELL_OVERLAY_DESKTOP_QUERY)
}

export function ShellOverlay(props: ShellOverlayProps) {
  const desktop = useDesktopForm()
  const { variant: _variant, ...sheetProps } = props
  return desktop ? <DesktopOverlay {...props} /> : <ResponsiveSheet {...sheetProps} />
}

function DesktopOverlay({
  open,
  onOpenChange,
  title,
  description,
  descriptionTrailing,
  headerActions,
  footer,
  children,
  className,
  variant = 'frame',
}: ShellOverlayProps) {
  const host = useShellOverlayHost()
  const reduce = useReducedMotion()

  // `container-type: size` on the host, ONLY while open — see OVERLAY_OPEN_ATTR
  // for why the scoping is a safety property and not tidiness.
  React.useEffect(() => {
    const el = host.element
    if (!el || !open) return
    el.setAttribute(OVERLAY_OPEN_ATTR, '')
    return () => el.removeAttribute(OVERLAY_OPEN_ATTR)
  }, [host.element, open])

  // Esc closes. Captured at the document so it works wherever focus sits inside
  // the trapped frame.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onOpenChange])

  // Focus returns to whatever opened the overlay — captured on open rather than
  // relying on the trigger still existing (the overview's overflow menu that
  // opens the archived sheet, for instance, unmounts behind it).
  const restoreRef = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null
      return
    }
    restoreRef.current?.focus?.()
  }, [open])

  if (!host.element) return null

  return createPortal(
    <ShellOverlayBody
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      descriptionTrailing={descriptionTrailing}
      headerActions={headerActions}
      footer={footer}
      className={className}
      variant={variant}
      reduce={!!reduce}
    >
      {children}
    </ShellOverlayBody>,
    host.element,
  )
}

/**
 * The desktop overlay's markup, WITHOUT the portal.
 *
 * Split out so it can be rendered — and asserted — by
 * `tests/unit/shell-overlay.test.tsx`: `react-dom/server` does not execute
 * `createPortal` (nor Vaul's `Drawer.Portal`), so a test that renders
 * `<ShellOverlay>` gets an empty string from BOTH branches and can prove
 * nothing. This is the piece where the two properties that would silently break
 * the shell actually live: the frame is ABSOLUTE (never `fixed`, or it escapes
 * the column it is meant to be bounded by) and it stacks on the z-ladder token.
 */
export function ShellOverlayBody({
  open,
  onOpenChange,
  title,
  description,
  descriptionTrailing,
  headerActions,
  footer,
  children,
  className,
  variant = 'frame',
  reduce = false,
}: ShellOverlayProps & { reduce?: boolean }) {
  return (
    <AnimatePresence>
      {open && (
        <div
          data-testid="shell-overlay"
          data-variant={variant}
          // Absolute INSIDE the shell — never `fixed`. That is what keeps the
          // nav rail visible beside it (and what keeps this component out of
          // the containing-block hazard entirely).
          className="absolute inset-0"
          style={{ zIndex: 'var(--sm-z-overlay)' }}
        >
          {/* Scrim. A fixed-alpha black is right here and nowhere else: it has
              to dim whatever the route happens to be painting underneath. */}
          <motion.div
            data-testid="shell-overlay-scrim"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            // A6/T6.1 — the scrim's exit carries `tweens.popoverOut` (100ms)
            // against its 150ms entry. Before A6 the exit silently inherited
            // the ENTRY transition, which inverted the exits-are-faster rule
            // on the one surface BRAND.md §6f cites as its worked example —
            // and left `popoverOut` a documented token with no consumer.
            exit={{ opacity: 0, transition: reduce ? motionOff : tweens.popoverOut }}
            transition={reduce ? motionOff : tweens.popoverIn}
            onClick={() => onOpenChange(false)}
            className="absolute inset-0 cursor-default"
            style={{ background: 'var(--sm-scrim)' }}
          />

          <FocusScope asChild trapped loop>
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={typeof title === 'string' ? title : undefined}
              data-testid="shell-overlay-frame"
              data-shell-pane={variant === 'pane' ? '' : undefined}
              initial={
                reduce
                  ? { opacity: 0 }
                  : variant === 'pane'
                    ? { opacity: 0, x: 24 }
                    : { opacity: 0, scale: 0.97 }
              }
              animate={{ opacity: 1, scale: 1, x: 0 }}
              // The EXIT carries its own transition, and it is a 300ms tween
              // against the ~520ms entrance spring — exits are always faster
              // than entries (the rule is stated in lib/springs.ts).
              exit={
                reduce
                  ? { opacity: 0, transition: motionOff }
                  : variant === 'pane'
                    ? { opacity: 0, x: 24, transition: tweens.overlayExit }
                    : { opacity: 0, scale: 0.98, transition: tweens.overlayExit }
              }
              transition={reduce ? motionOff : springs.settle}
              className={cn(
                'absolute flex flex-col overflow-hidden bg-paper-raised shadow-[var(--sm-card-shadow)] outline-none',
                variant === 'pane'
                  ? // §11.3 side pane: pinned right, full height. The parent
                    // grid below keeps content from re-typesetting while the
                    // width animates.
                    'inset-y-0 right-0 w-[min(26rem,80%)] border-l border-hairline'
                  : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-hairline',
                className,
              )}
              style={
                variant === 'frame'
                  ? // Container-query sized against the content column —
                    // shell-overlay-frame.ts documents the three constraints.
                    { width: FRAME_SIZE_CSS, maxHeight: 'calc(100cqh - 72px)' }
                  : undefined
              }
            >
              <header className="safe-header-compact flex shrink-0 items-start gap-3 border-b border-hairline px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[17px] font-semibold leading-tight text-ink">
                    {title}
                  </h2>
                  {(description || descriptionTrailing) && (
                    <div className="mt-0.5 flex items-center justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-2">
                        {description}
                      </span>
                      {descriptionTrailing}
                    </div>
                  )}
                </div>
                {/* 26px glass close button — the one piece of floating chrome
                    this component owns, and the only backdrop-filter in it. */}
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => onOpenChange(false)}
                  className="glass flex size-[26px] shrink-0 items-center justify-center rounded-full border border-hairline text-ink-2 transition-colors hover:text-ink"
                >
                  <X className="size-3.5" />
                </button>
              </header>

              {headerActions && (
                <div className="shrink-0 border-b border-hairline px-4 py-2">
                  {headerActions}
                </div>
              )}

              {/* §11.3's three-column body grid, used by BOTH variants so the
                  two forms share one layout: `minmax(0,auto) minmax(0,1fr)
                  minmax(0,auto)` with the content in the middle track. In the
                  `pane` form the pane's width animates, and a grid whose
                  content track is `minmax(0,1fr)` re-flows the box without
                  re-typesetting what is inside it — the reason the pane
                  animates cleanly instead of reflowing text every frame. */}
              <div
                className="grid min-h-0 flex-1 overflow-y-auto"
                style={{
                  gridTemplateColumns:
                    'minmax(0, auto) minmax(0, 1fr) minmax(0, auto)',
                }}
              >
                <div className="col-start-2 px-4 py-3">{children}</div>
              </div>

              {footer && (
                <div className="shrink-0 border-t border-hairline px-4 py-3">
                  {footer}
                </div>
              )}
            </motion.div>
          </FocusScope>
        </div>
      )}
    </AnimatePresence>
  )
}
