// MobileComposeSheet — the on-demand native EDITOR sheet for the web terminal
// (feat-edit-in-native-editor; was the compose-fresh sheet).
//
// WHY. One-char-at-a-time typing into xterm on a phone is painful, and there is
// no native cursor/selection/multiline. This sheet is the fix — but it is an EDIT
// affordance, not a compose-and-send one. Claude Code's built-in Ctrl+G action
// (`chat:externalEditor`) writes its CURRENT input buffer to a temp file, spawns
// $EDITOR (the supermux bridge), blocks, then reads the file back as the new
// buffer. supermux points $EDITOR at this browser sheet: it opens PRE-FILLED with
// whatever the user has already typed at Claude's `❯` prompt, lets them edit it in
// a real native <textarea> (selection / autocorrect / dictation / paste / multi-
// line), optionally attach files, then Save → the edited text is written back into
// Claude's live input buffer and the sheet morphs back. We DO NOT submit (no
// Enter): the text sits at `❯` and the user presses Enter as usual.
//
// PRE-FILL. Unlike the old compose-fresh sheet, this seeds the textarea from the
// `buffer` prop (Claude's real current input, delivered over SSE). An empty buffer
// (Ctrl+G with nothing typed) opens an empty sheet — effectively compose-fresh,
// which is fine.
//
// MORPH. The trigger is a framer-motion shared-element `layoutId`: the dock's Edit
// field (dock.tsx) and this sheet's surface carry the SAME `layoutId`
// (COMPOSE_LAYOUT_ID), so the field's rounded rect tweens (position + size) into
// the full-width sheet surface, and back on close. We drive the surface with
// framer (NOT Vaul) because a Vaul slide-up transform would fight the layout
// tween. The keyboard-flush positioning reuses `useKeyboardViewport` so the sheet
// rises directly above the soft keyboard with no page slide.
//
// REDUCED MOTION: the layout morph + spring are dropped for a plain crossfade.
//
// VISUAL: iOS-native — 10px radii, sentence-case, springs from springs.ts,
// ≥44pt targets, text-base (≥16px) textarea so iOS never zoom-focuses.

import * as React from 'react'
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'framer-motion'
import { Paperclip, Check, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { FocusScope } from '@radix-ui/react-focus-scope'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport'
import { buildAttachmentPrompt } from '@/lib/api/files'
import { UploadActionSheet } from './upload-action-sheet'
import { AttachmentRow } from './attachment-chip'
import { useStagedAttachments } from './use-staged-attachments'

/** The shared-element id linking the dock's bottom-left Edit field to this sheet's
 *  surface — both render a `<motion.*>` with this `layoutId`, so framer tweens the
 *  field rect into the sheet surface (and back). Exported so the field in dock.tsx
 *  can carry the matching id. */
export const COMPOSE_LAYOUT_ID = 'mobile-compose-surface'

export interface MobileComposeSheetProps {
  open: boolean
  /** Controlled open-state. Setting `false` is a DISMISS = cancel the edit (the
   *  parent's `useExternalEdit` leaves Claude's buffer unchanged). */
  onOpenChange: (open: boolean) => void
  /** The buffer text to seed the textarea with — Claude's current `❯` input,
   *  delivered over the `external-edit` SSE event. Empty = compose-fresh. */
  buffer: string
  /** Save the edited text back into Claude's input buffer. Receives the FINAL text
   *  (edited body + any attachment path sentence), NO trailing Enter — the text
   *  lands at Claude's `❯` and the user submits with Enter themselves. */
  onSave: (text: string) => void
}

export function MobileComposeSheet({
  open,
  onOpenChange,
  buffer,
  onSave,
}: MobileComposeSheetProps) {
  const reduce = useReducedMotion()
  // The sheet rises flush above the soft keyboard — same mechanism the focus
  // sheet uses (a keyboard-top inset off visualViewport). The inset lifts the
  // bottom-0 surface up so its bottom edge lands at the keyboard TOP.
  const { keyboardInset } = useKeyboardViewport()
  // Lifted to the surface so the FocusScope's onMountAutoFocus can land the caret
  // in the textarea (EditorBody still owns it for change/keydown/Save wiring).
  const textRef = React.useRef<HTMLTextAreaElement | null>(null)

  // SSR / first-paint safety: only portal once a document body exists.
  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — tap-away dismiss (= cancel) + a calm dim over the terminal. */}
          <motion.div
            className="fixed inset-0 z-[64] bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : springs.smooth}
            onClick={() => onOpenChange(false)}
            aria-hidden
          />

          {/* The morphing surface — carries COMPOSE_LAYOUT_ID so framer tweens
              it FROM the dock Edit field's exact rect into this full-width sheet,
              and back on close. `layout` keeps it tweening as the keyboard inset
              changes its bottom. Under reduced motion the layout tween is dropped
              and we crossfade. */}
          <motion.div
            {...(reduce
              ? {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  exit: { opacity: 0 },
                  transition: { duration: 0 },
                }
              : {
                  layoutId: COMPOSE_LAYOUT_ID,
                  layout: true,
                  transition: springs.sheetDetent,
                })}
            style={{ bottom: keyboardInset }}
            className={cn(
              'glass fixed inset-x-0 z-[65] flex max-h-[85vh] flex-col',
              'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
            )}
            role="dialog"
            aria-modal="true"
            aria-label="Edit message"
          >
            {/* FOCUS OWNERSHIP (the "typing lands nowhere" fix). This sheet is
                portaled to document.body — OUTSIDE the dock's Vaul Drawer subtree.
                The dock drawer's focus layer treats this out-of-scope textarea as
                "focus outside" and recaptures focus back into its own content the
                instant the textarea tries to take it. Wrapping the surface in our
                OWN trapped FocusScope makes THIS sheet the active focus owner: on
                mount it pushes onto Radix's focus-scope stack (pausing the dock's
                layer) and its focusin guard keeps focus inside. EditorBody's rAF
                puts the caret in the textarea; `loop` keeps Tab cycling within the
                controls. The scope wraps a PLAIN div (not the layout-animated
                motion.div below) because framer's layout projection toggles styles
                on the element it animates, which during the morph would knock focus
                off the scope container. */}
            <FocusScope
              asChild
              trapped
              loop
              // Don't let FocusScope grab the first tabbable (the close handle) —
              // EditorBody's rAF focuses the textarea instead; the trapped scope
              // then KEEPS focus there.
              onMountAutoFocus={(e) => e.preventDefault()}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <motion.div
                  layout={reduce ? false : 'position'}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {/* Drag indicator — 36×5, 2.5px radius. Doubles as a
                      tap-to-dismiss (= cancel) affordance row. */}
                  <button
                    type="button"
                    aria-label="Cancel edit"
                    onClick={() => onOpenChange(false)}
                    className="mx-auto mt-1.5 flex h-4 w-16 shrink-0 items-center justify-center"
                  >
                    <span className="h-[5px] w-9 rounded-[2.5px] bg-muted-foreground/30" />
                  </button>
                  <EditorBody
                    // Re-seed the body whenever the buffer identity changes (a new
                    // Ctrl+G opens a fresh edit), so the textarea reflects Claude's
                    // current input each time.
                    key={`edit-${buffer}`}
                    reduce={!!reduce}
                    textRef={textRef}
                    buffer={buffer}
                    onSave={onSave}
                    onCancel={() => onOpenChange(false)}
                  />
                </motion.div>
              </div>
            </FocusScope>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/** The seeded editor form — remounted per open (the surface unmounts on close, and
 *  the `key` re-seeds on a new buffer) so the textarea + staged attachments always
 *  start from Claude's current input. */
function EditorBody({
  reduce,
  textRef,
  buffer,
  onSave,
  onCancel,
}: {
  reduce: boolean
  /** Owned by the surface so the FocusScope's onMountAutoFocus can focus it. */
  textRef: React.RefObject<HTMLTextAreaElement | null>
  buffer: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  // Seed from Claude's current buffer (the EDIT affordance, not compose-fresh).
  const [text, setText] = React.useState(buffer)
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const staged = useStagedAttachments()
  // Single-fire guard: a fast double-tap on Save (or ⌘Enter + tap) must submit
  // exactly once. The ref is the SYNCHRONOUS latch; `saved` mirrors it for the
  // render-time disabled/dimmed visual. Latched for the lifetime of this mounted
  // body — Save closes the sheet, which unmounts + re-seeds it, so both reset.
  const savedRef = React.useRef(false)

  // Autofocus the textarea on open so the soft keyboard rises WITH the sheet and
  // the caret is ready. Move the caret to the END of the seeded text so the user
  // continues from where Claude's buffer left off (not at char 0). A rAF lets the
  // morph/open layout settle first; the cleanup cancels the pending rAF so only
  // the final mount's focus call lands (StrictMode-safe).
  React.useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      try {
        el.setSelectionRange(end, end)
      } catch {
        /* setSelectionRange throws on some non-text inputs — harmless here */
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [textRef])

  // An empty save IS allowed (the user may have cleared the prompt — a legitimate
  // edit). Only a still-uploading attachment blocks the save (so its path can be
  // appended once it resolves).
  const canSave = !staged.uploading && !saved

  const handleSave = React.useCallback(() => {
    if (savedRef.current) return // double-submit guard (synchronous)
    if (staged.uploading) return // wait for in-flight uploads to resolve
    savedRef.current = true
    setSaved(true)

    // Compose the final buffer: the edited body, then any quoted attachment
    // path(s) on their own line (so "<my words>" reads before the file ref).
    // NO trailing Enter — the text lands back at Claude's `❯` and the user submits
    // with Enter themselves (this is an EDIT affordance, not compose-and-send).
    const body = text
    const attachmentPaths = buildAttachmentPrompt(staged.readyPaths()).trimEnd()
    const parts = [body, attachmentPaths].filter((p) => p.length > 0)
    onSave(parts.join('\n'))

    // Done — drop the staged chips (revokes previews) and morph back.
    staged.reset()
  }, [text, staged, onSave])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pb-2 pt-1">
      {/* Staged attachment chips — uploading spinner → thumbnail/name, each
          dismissible. Reuses the dock's AttachmentRow. */}
      {staged.attachments.length > 0 && (
        <AttachmentRow
          attachments={staged.attachments}
          onDismiss={staged.dismiss}
        />
      )}

      {/* The native textarea — text-base (≥16px) so iOS never zoom-focuses. Full
          native selection / autocorrect / multi-line. ⌘/Ctrl+Enter SAVES from a
          hardware keyboard; the on-screen return key inserts a newline (multi-line
          edit), and the explicit Save button commits — so a soft-keyboard return
          never fires off the edit prematurely. */}
      <textarea
        ref={textRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleSave()
          }
        }}
        rows={4}
        placeholder="Edit your message…"
        aria-label="Edit message"
        className={cn(
          'min-h-[96px] w-full flex-1 resize-none rounded-[10px] border border-border bg-background',
          'px-3 py-2.5 text-base leading-snug outline-none focus:ring-2 focus:ring-ring',
        )}
      />

      {/* Action row — attach (📎) + cancel on the left, Save on the right. ≥44pt. */}
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <motion.button
          type="button"
          aria-label="Attach a file"
          onClick={() => setUploadOpen(true)}
          whileTap={reduce ? undefined : { scale: 0.94 }}
          transition={springs.buttonPress}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground active:bg-secondary"
        >
          <Paperclip className="size-5" strokeWidth={1.75} aria-hidden />
        </motion.button>

        <motion.button
          type="button"
          aria-label="Cancel"
          onClick={onCancel}
          whileTap={reduce ? undefined : { scale: 0.94 }}
          transition={springs.buttonPress}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground active:bg-secondary"
        >
          <X className="size-5" strokeWidth={1.75} aria-hidden />
        </motion.button>

        <motion.button
          type="button"
          aria-label="Save edit"
          onClick={handleSave}
          disabled={!canSave}
          whileTap={canSave && !reduce ? { scale: 0.96 } : undefined}
          transition={springs.buttonPress}
          className={cn(
            'ml-auto flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-4',
            'bg-primary text-[15px] font-semibold text-primary-foreground',
            !canSave && 'opacity-40',
          )}
        >
          <Check className="size-[18px]" strokeWidth={2} aria-hidden />
          Save
        </motion.button>
      </div>

      {/* 📎 picker — the SAME native action sheet (Camera / Photo library /
          Files). Picked files STAGE here (upload in the background → chips); their
          quoted path is appended to the edited text on Save. */}
      <UploadActionSheet
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onFiles={staged.handleFiles}
      />
    </div>
  )
}

export default MobileComposeSheet
