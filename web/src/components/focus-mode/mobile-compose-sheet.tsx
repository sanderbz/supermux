// MobileComposeSheet — the on-demand native compose sheet for the mobile web
// terminal (feat/mobile-compose-and-upload).
//
// WHY. One-char-at-a-time typing into xterm on a phone is painful. This is the
// fix: a MODAL, COMPOSE-FRESH sheet you summon from the bottom-left session pill,
// type a full multi-line prompt into a real native <textarea> (selection,
// autocorrect, dictation, paste — everything iOS gives a textarea), optionally
// attach files, then Send → the whole thing streams into the pty as one prompt
// with a trailing Enter, and the sheet morphs back. Live-type + the accessory
// strip remain the default for interactive TUIs (y/n, menus, Ctrl-C); this sheet
// is ADDITIVE, for composing a substantial prompt comfortably.
//
// It does NOT (and cannot) pre-fill "what you're currently typing in the
// terminal" — that needs a fragile xterm buffer read-back, which is forbidden. It
// starts empty (COMPOSE-FRESH).
//
// MORPH. The trigger is a framer-motion shared-element `layoutId`: the pill (in
// dock.tsx) and this sheet's surface carry the SAME `layoutId` (COMPOSE_LAYOUT_ID),
// so when the sheet opens the pill's rounded rect tweens (position + size) into
// the full-width sheet surface, and back on close. Same-width origin: framer
// captures the pill's exact on-screen rect as the morph's starting geometry — no
// hand-fed coordinates. We drive the surface with framer (NOT Vaul) because a
// Vaul slide-up transform would fight the layout tween (the same conflict
// morph.tsx warns about). The keyboard-flush positioning still reuses
// `useKeyboardViewport` — the same primitive the Vaul shells consume — so the
// sheet rises directly above the soft keyboard with no page slide.
//
// REDUCED MOTION: the layout morph + spring are dropped for a plain crossfade
// (opacity), honoring prefers-reduced-motion.
//
// VISUAL: iOS-native — 10px radii, sentence-case, springs from springs.ts,
// ≥44pt targets, text-base (≥16px) textarea so iOS never zoom-focuses.

import * as React from 'react'
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'framer-motion'
import { Paperclip, CornerDownLeft, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { FocusScope } from '@radix-ui/react-focus-scope'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport'
import { buildAttachmentPrompt } from '@/lib/api/files'
import { UploadActionSheet } from './upload-action-sheet'
import { AttachmentRow } from './attachment-chip'
import { useStagedAttachments } from './use-staged-attachments'

/** The shared-element id linking the bottom-left session pill to this sheet's
 *  surface — both render a `<motion.*>` with this `layoutId`, so framer tweens
 *  the pill rect into the sheet surface (and back). Exported so the pill in
 *  dock.tsx can carry the matching id. */
export const COMPOSE_LAYOUT_ID = 'mobile-compose-surface'

export interface MobileComposeSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Send the composed prompt into the pty. Receives the FINAL text (typed body
   *  + the attachment sentence) WITH its trailing Enter already appended — the
   *  caller just forwards it to `termRef.current?.send`. */
  onSend: (text: string) => void
}

export function MobileComposeSheet({
  open,
  onOpenChange,
  onSend,
}: MobileComposeSheetProps) {
  const reduce = useReducedMotion()
  // The sheet rises flush above the soft keyboard — same mechanism the focus
  // sheet uses (a keyboard-top inset off visualViewport). The inset lifts the
  // bottom-0 surface up so its bottom edge lands at the keyboard TOP.
  const { keyboardInset } = useKeyboardViewport()
  // Lifted to the surface so the FocusScope's onMountAutoFocus can land the caret
  // in the textarea (ComposeBody still owns it for change/keydown/Send wiring).
  const textRef = React.useRef<HTMLTextAreaElement | null>(null)

  // SSR / first-paint safety: only portal once a document body exists.
  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — tap-away dismiss + a calm dim over the terminal. */}
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
              it FROM the pill's exact rect (position + size) into this full-width
              sheet, and back on close. `layout` keeps it tweening as the keyboard
              inset changes its bottom. Under reduced motion the layout tween is
              dropped and we crossfade (the opacity initial/exit below handle it,
              and `layout`/`layoutId` are disabled). */}
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
            aria-label="Compose a message"
          >
            {/* FOCUS OWNERSHIP (the "typing lands nowhere" fix). This sheet is
                portaled to document.body — OUTSIDE the dock's Vaul Drawer subtree.
                The dock drawer's focus layer treats this out-of-scope textarea as
                "focus outside" and recaptures focus back into its own content the
                instant the textarea tries to take it (confirmed in-browser: a
                direct el.focus() bounced straight to the drawer's content DIV).
                Wrapping the surface in our OWN trapped FocusScope makes THIS sheet
                the active focus owner: on mount it pushes onto Radix's focus-scope
                stack (pausing the dock's layer) and its focusin guard keeps focus
                inside — so the textarea holds focus, taps don't snap away, and
                typed text lands. ComposeBody's rAF puts the caret in the textarea;
                `loop` keeps Tab cycling within the compose controls.
                The scope wraps a PLAIN div (not the layout-animated motion.div
                below) because framer's layout projection toggles styles on the
                element it animates, which during the morph would knock focus off
                the scope container — so that container must be a static node. */}
            <FocusScope
              asChild
              trapped
              loop
              // Don't let FocusScope grab the first tabbable (the close handle) —
              // ComposeBody's rAF focuses the textarea instead; the trapped scope
              // then KEEPS focus there.
              onMountAutoFocus={(e) => e.preventDefault()}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                {/* The morph cross-fades the pill's content into the sheet's;
                    keeping this inner block as a separate (non-layout) child lets
                    framer scale-correct the surface without distorting controls. */}
                <motion.div
                  layout={reduce ? false : 'position'}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {/* Drag indicator — 36×5, 2.5px radius (Apple Maps / Termius #11).
                      Doubles as a tap-to-dismiss affordance row. */}
                  <button
                    type="button"
                    aria-label="Close compose"
                    onClick={() => onOpenChange(false)}
                    className="mx-auto mt-1.5 flex h-4 w-16 shrink-0 items-center justify-center"
                  >
                    <span className="h-[5px] w-9 rounded-[2.5px] bg-muted-foreground/30" />
                  </button>
                  <ComposeBody
                    key="compose"
                    reduce={!!reduce}
                    textRef={textRef}
                    onSend={onSend}
                    onClose={() => onOpenChange(false)}
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

/** The seeded compose form — remounted per open (the surface unmounts on close)
 *  so the textarea + staged attachments always start fresh (COMPOSE-FRESH). */
function ComposeBody({
  reduce,
  textRef,
  onSend,
  onClose,
}: {
  reduce: boolean
  /** Owned by the surface so the FocusScope's onMountAutoFocus can focus it. */
  textRef: React.RefObject<HTMLTextAreaElement | null>
  onSend: (text: string) => void
  onClose: () => void
}) {
  const [text, setText] = React.useState('')
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [sent, setSent] = React.useState(false)
  const staged = useStagedAttachments()
  // Single-fire guard: a fast double-tap on Send (or ⌘Enter + tap) must submit
  // exactly once. The ref is the SYNCHRONOUS latch (read/written only inside the
  // event handler — state updates are async and would let a double-tap slip
  // through); the `sent` state mirrors it for the render-time disabled/dimmed
  // visual. Latched for the lifetime of this mounted body — Send closes the
  // sheet, which unmounts + re-seeds it, so both reset per open.
  const sentRef = React.useRef(false)

  // Autofocus the textarea on open so the soft keyboard rises WITH the sheet and
  // the caret is ready. The surface's trapped <FocusScope> KEEPS focus here once
  // it lands (the dock drawer's focus layer used to recapture it); this effect is
  // what actually puts the caret IN the textarea. A rAF lets the morph/open
  // layout settle first (iOS honours focus inside the open gesture), and it is
  // robust to React's StrictMode double-mount: the cleanup cancels the pending
  // rAF so only the final mount's focus call lands.
  React.useEffect(() => {
    const raf = window.requestAnimationFrame(() => textRef.current?.focus())
    return () => window.cancelAnimationFrame(raf)
  }, [textRef])

  // Empty send (no text, no ready attachments) is a no-op. Still-uploading
  // attachments don't count toward "can send" until they resolve.
  const trimmed = text.trim()
  const hasContent = trimmed.length > 0 || staged.readyPaths().length > 0
  const canSend = hasContent && !staged.uploading && !sent

  const handleSend = React.useCallback(() => {
    if (sentRef.current) return // double-submit guard (synchronous)
    const body = text.trim()
    const paths = staged.readyPaths()
    if (body.length === 0 && paths.length === 0) return // empty no-op
    sentRef.current = true
    setSent(true)

    // Compose the final prompt: typed body FIRST, then the attachment sentence
    // (so "fix this <my words>" reads naturally before the file reference), then
    // a single trailing Enter (`\r`) to submit it as ONE prompt. Multi-line
    // textarea content keeps its embedded `\n`s — the pty receives them verbatim
    // (Claude Code treats a bare LF inside a prompt as a soft newline; only the
    // final CR submits).
    const attachmentSentence = buildAttachmentPrompt(paths).trimEnd()
    const parts = [body, attachmentSentence].filter((p) => p.length > 0)
    onSend(parts.join('\n') + '\r')

    // Done — drop the staged chips (revokes previews) and morph back. The live
    // terminal now shows the echo.
    staged.reset()
    onClose()
  }, [text, staged, onSend, onClose])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pb-2 pt-1">
      {/* Staged attachment chips — uploading spinner → thumbnail/name, each
          dismissible. Reuses the dock's AttachmentRow; the StagedAttachment
          shape is a superset of Attachment so it renders unchanged. */}
      {staged.attachments.length > 0 && (
        <AttachmentRow
          attachments={staged.attachments}
          onDismiss={staged.dismiss}
        />
      )}

      {/* The native textarea — text-base (≥16px) so iOS never zoom-focuses (the
          SnippetEditor precedent). Full native selection / autocorrect / multi-
          line. ⌘/Ctrl+Enter sends from a hardware keyboard; the on-screen return
          key inserts a newline (multi-line compose), and the explicit Send button
          submits — so a soft-keyboard return never fires off a half-written
          prompt. */}
      <textarea
        ref={textRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleSend()
          }
        }}
        rows={4}
        placeholder="Type a message…"
        aria-label="Compose a message"
        className={cn(
          'min-h-[96px] w-full flex-1 resize-none rounded-[10px] border border-border bg-background',
          'px-3 py-2.5 text-base leading-snug outline-none focus:ring-2 focus:ring-ring',
        )}
      />

      {/* Action row — attach (📎) + cancel on the left, Send on the right. ≥44pt. */}
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
          onClick={onClose}
          whileTap={reduce ? undefined : { scale: 0.94 }}
          transition={springs.buttonPress}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground active:bg-secondary"
        >
          <X className="size-5" strokeWidth={1.75} aria-hidden />
        </motion.button>

        <motion.button
          type="button"
          aria-label="Send message"
          onClick={handleSend}
          disabled={!canSend}
          whileTap={canSend && !reduce ? { scale: 0.96 } : undefined}
          transition={springs.buttonPress}
          className={cn(
            'ml-auto flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-4',
            'bg-primary text-[15px] font-semibold text-primary-foreground',
            !canSend && 'opacity-40',
          )}
        >
          <CornerDownLeft className="size-[18px]" strokeWidth={2} aria-hidden />
          Send
        </motion.button>
      </div>

      {/* 📎 picker — the SAME native action sheet the dock used (Camera / Photo
          library / Files). Picked files STAGE here (upload in the background →
          chips) instead of injecting straight into the terminal. */}
      <UploadActionSheet
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onFiles={staged.handleFiles}
      />
    </div>
  )
}

export default MobileComposeSheet
