// DesktopComposePanel — desktop UX for "edit prompt" (right-side detail panel).
//
// WHY. On mobile the full-bleed `MobileComposeSheet` is the right answer (small
// screen, one task at a time, IO focus on the keyboard). On desktop a full-
// bleed surface that covers the live terminal is "een tikje lomp" (user
// feedback): wastes screen real estate, hides Claude's last output that the
// user wants to reference while composing, and reads as heavier than the
// single-text-edit task warrants.
//
// SHAPE. A right-edge sliding panel (~`sm:max-w-md`, full-height) over a
// dimmed terminal — the same primitive `SessionInfoPanel`'s desktop fork uses
// (Radix Dialog on the right). The terminal stays visible to the LEFT so the
// user can re-read what Claude printed last while composing; it's frozen by
// Claude's $EDITOR-bridge anyway so non-interactivity is honest, not a loss.
//
// REUSE. The whole sheet INTERIOR — NavBar (Cancel · "Edit prompt" · Send/Done),
// pending skeleton, the seeded textarea + staged-attachments editor, and the
// "Discard changes?" sub-sheet — is shared with the mobile path by importing
// the same components from `mobile-compose-sheet.tsx`. Only the SHELL differs:
// a Radix Dialog right-anchored content node replaces the full-bleed
// `<motion.div>`, and there is no `useKeyboardViewport` integration (desktop
// has no soft keyboard to lift the surface over) and no `COMPOSE_LAYOUT_ID`
// morph (the dock pill that the morph anchors on is mobile-only).
//
// ESCAPE / DIRTY / SEND / SUBMIT semantics are identical to mobile — the same
// `handleCancel` → discard-confirm flow, the same custom-event Done/Send
// dispatch to the textarea, the same single-fire save guards in EditorBody.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { FocusScope } from '@radix-ui/react-focus-scope'

import { cn } from '@/lib/utils'
import { springs, eases } from '@/lib/springs'
import { useToast } from '@/components/ui/use-toast'
import {
  DiscardConfirmSheet,
  EditorBody,
  NavBar,
  PendingBody,
  type MobileComposeSheetProps,
} from './mobile-compose-sheet'

export function DesktopComposePanel({
  open,
  onOpenChange,
  phase,
  buffer,
  requestId,
  onSave,
  onSaveAndSubmit,
  onSendEnter,
}: MobileComposeSheetProps) {
  const reduce = useReducedMotion()
  const { toast } = useToast()

  // Surface-level refs — mirror MobileComposeSheet so EditorBody's callback
  // shape stays identical. The dirty baseline is a ref (not state) so a Cancel
  // tap can read the live textarea text without forcing re-renders on every
  // keystroke.
  const textRef = React.useRef<HTMLTextAreaElement | null>(null)
  const textSnapshotRef = React.useRef('')
  React.useEffect(() => {
    if (phase === 'ready') textSnapshotRef.current = buffer
  }, [phase, buffer])

  const [confirmDiscard, setConfirmDiscard] = React.useState(false)

  const handleCancel = React.useCallback(() => {
    const dirty = phase === 'ready' && textSnapshotRef.current !== buffer
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    onOpenChange(false)
  }, [phase, buffer, onOpenChange])

  // Esc cascade — identical to mobile:
  //   level 1: discard-confirm open → close just that, return to editing
  //   level 2: delegate to handleCancel (opens confirm if dirty, closes if clean)
  // Captured at document level so xterm / route handlers can't intercept it.
  // We rely on this rather than Radix Dialog's built-in Escape because Radix
  // would jump straight to onOpenChange(false) — bypassing the dirty check.
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (confirmDiscard) setConfirmDiscard(false)
      else handleCancel()
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () =>
      document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open, confirmDiscard, handleCancel])

  if (typeof document === 'undefined') return null

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal>
        <AnimatePresence>
          {open && (
            <DialogPrimitive.Portal forceMount>
              {/* Dimmed overlay — terminal stays VISIBLE behind it (not hidden),
                  honors the "terminal is frozen but useful as context" reality.
                  Lower opacity than a true modal (40%) so the user can still
                  read the last few lines of output while composing. */}
              <DialogPrimitive.Overlay asChild>
                <motion.div
                  className="fixed inset-0 z-[60] bg-black/40"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={
                    reduce
                      ? { duration: 0.12, ease: eases.out }
                      : { duration: 0.18, ease: eases.out }
                  }
                />
              </DialogPrimitive.Overlay>
              <DialogPrimitive.Content
                aria-label="Edit prompt"
                // Intercept Radix's defaults — we own Escape (the cascade above)
                // and we don't want pointer-down outside to dismiss with unsaved
                // changes. handleCancel routes to the discard-confirm when dirty.
                onEscapeKeyDown={(e) => e.preventDefault()}
                onPointerDownOutside={(e) => {
                  e.preventDefault()
                  handleCancel()
                }}
                onInteractOutside={(e) => e.preventDefault()}
                asChild
              >
                <motion.div
                  initial={reduce ? { opacity: 0 } : { x: '100%' }}
                  animate={reduce ? { opacity: 1 } : { x: 0 }}
                  exit={reduce ? { opacity: 0 } : { x: '100%' }}
                  transition={reduce ? { duration: 0.18, ease: eases.out } : springs.snippetSlide}
                  className={cn(
                    // Right-edge full-height panel. `sm:max-w-md` (28rem) gives
                    // ample room for a multi-line prompt without eating more
                    // terminal width than necessary. `bg-card` matches the
                    // mobile surface so the two paths feel identical in tone.
                    'fixed inset-y-0 right-0 z-[65] flex w-full max-w-md flex-col',
                    'border-l border-border bg-card outline-none shadow-xl',
                  )}
                  data-vr="edit-sheet-surface"
                  data-vr-phase={phase}
                  data-vr-surface-mode="desktop-panel"
                >
                  {/* FocusScope keeps Tab + autofocus contained in the panel —
                      same contract as mobile so EditorBody can focus the
                      textarea on the pending→ready transition without the
                      route / terminal stealing focus back. */}
                  <FocusScope
                    asChild
                    trapped
                    loop
                    onMountAutoFocus={(e) => e.preventDefault()}
                  >
                    <div className="flex min-h-0 flex-1 flex-col">
                      <NavBar
                        onCancel={handleCancel}
                        onDone={() => {
                          if (phase !== 'ready') return
                          const ev = new CustomEvent('edit-sheet-done', {
                            bubbles: true,
                          })
                          textRef.current?.dispatchEvent(ev)
                        }}
                        doneDisabled={phase !== 'ready'}
                        onSend={
                          onSaveAndSubmit && onSendEnter
                            ? () => {
                                if (phase !== 'ready') return
                                const ev = new CustomEvent('edit-sheet-send', {
                                  bubbles: true,
                                })
                                textRef.current?.dispatchEvent(ev)
                              }
                            : undefined
                        }
                        sendDisabled={phase !== 'ready'}
                      />

                      {phase === 'pending' ? (
                        <PendingBody reduce={!!reduce} />
                      ) : (
                        <EditorBody
                          key={`edit-${requestId ?? ''}`}
                          reduce={!!reduce}
                          textRef={textRef}
                          buffer={buffer}
                          onTextSnapshot={(t) => {
                            textSnapshotRef.current = t
                          }}
                          onSave={onSave}
                          onSaveAndSubmit={onSaveAndSubmit}
                          onSendEnter={onSendEnter}
                          onSendError={(message) =>
                            toast({ message, tone: 'error' })
                          }
                        />
                      )}
                    </div>
                  </FocusScope>
                </motion.div>
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          )}
        </AnimatePresence>
      </DialogPrimitive.Root>

      {/* Same discard-confirm sheet the mobile path uses — small centered
          modal works fine on desktop too. Only mounts when the user hit Cancel
          with unsaved edits. */}
      <DiscardConfirmSheet
        open={confirmDiscard}
        onCancel={() => setConfirmDiscard(false)}
        onDiscard={() => {
          setConfirmDiscard(false)
          onOpenChange(false)
        }}
        reduce={!!reduce}
      />
    </>
  )
}
