// MobileComposeSheet — the on-demand native EDITOR sheet for the web terminal
// (feat-edit-in-native-editor; Stage 1 mobile-edit refit).
//
// WHY. One-char-at-a-time typing into xterm on a phone is painful, and there is
// no native cursor/selection/multiline. This sheet is the fix — but it is an EDIT
// affordance, not a compose-and-send one. Claude Code's built-in Ctrl+G action
// (`chat:externalEditor`) writes its CURRENT input buffer to a temp file, spawns
// $EDITOR (the supermux bridge), blocks, then reads the file back as the new
// buffer. supermux points $EDITOR at this browser sheet: it opens PRE-FILLED with
// whatever the user has already typed at Claude's `❯` prompt, lets them edit it in
// a real native <textarea> (selection / autocorrect / dictation / paste / multi-
// line), optionally attach files, then Done → the edited text is written back into
// Claude's live input buffer and the sheet morphs back. We DO NOT submit (no
// Enter): the text sits at `❯` and the user presses Enter as usual.
//
// STAGE 1 — OPTIMISTIC OPEN (the big perceived-latency win):
//   • The sheet opens THE INSTANT the user taps ✎ Edit (no waiting on the
//     bridge round-trip — that used to take ~5s on a phone). Until Claude's
//     buffer arrives over SSE we render a <TextareaSkeleton> (a dim block with
//     a subtle shimmer + "Loading your prompt…" label, `role=status`,
//     `aria-busy=true`).
//   • When the buffer arrives (phase 'pending' → 'ready'), the skeleton
//     crossfades to the real <textarea> over 120ms, and programmatic focus
//     pops the iOS keyboard.
//   • If the bridge reports `cancelled` instead, the sheet closes politely
//     (no error toast).
//
// iOS-NATIVE SURFACE (refit — user-feedback "full-page" pass):
//   • FULL-PAGE edit surface (NOT a peek sheet). Covers `inset-x-0 top-0` down
//     to the keyboard top via `bottom: keyboardInset`. No `max-h-[85vh]` cap —
//     a peek that left 15% of dimmed terminal visible read as "broken/blank".
//     iOS Notes / iA Writer / Drafts / Mail all use a full-page edit surface,
//     not a peek; this matches that model and gives the textarea the entire
//     remaining vertical space (the `flex-1` cap is now the viewport itself).
//   • OPAQUE surface (no glass blur over the dark terminal — bg-card so the
//     sheet's dark surface is iOS systemBackground.dark #1c1c1e; light is
//     #ffffff via the theme tokens). NO top corner radius (a full page has
//     none — matches iOS Notes' edit page), NO top border (the divider isn't
//     visible on a full page), `pt-safe` for the top notch + `pb-safe` for the
//     home indicator when the keyboard is closed.
//   • NO backdrop overlay (`bg-black/40`) — the surface fully covers, so there
//     is nothing visible behind to dim; removing it also removes an extra DOM
//     node + paint.
//   • System font (NOT mono) for the textarea — this is prose for an LLM, not
//     code. font-size 16px (iOS no-zoom floor) presented visually at 17pt via
//     leading-[1.4]. caret + ::selection in systemBlue.
//   • 44pt iOS nav bar at the TOP: [Cancel] · "Edit prompt" · [Done]. Plain text
//     buttons in systemBlue; Done is semibold. ≥44pt hit boxes.
//   • Cancel with unsaved changes → an iOS-style "Discard changes?" confirm
//     sheet (Cancel | Discard) before closing. Unchanged → silent close.
//   • NO grabber. A full-page edit modal isn't drag-to-dismiss — explicit
//     Cancel is the dismissal. The grabber's swipe-dismiss hint would mislead
//     on a full-page surface (and was already non-functional — swipe-dismiss
//     had been disabled to protect unsaved edits).
//   • Placeholder removed — the buffer IS the value; the nav-bar title tells
//     the user this is an edit screen.
//   • Accessory rail pinned ABOVE the keyboard: [📎 Attach] [🎙 Dictate] [⌘↵ Done].
//     Dictate hides when the Web Speech API is absent. ≥44pt.
//   • Spring tuned to SwiftUI default sheet (response 0.35, dampingFraction 0.85)
//     — we reuse `springs.snippetSlide` (already 322/30.5). The layoutId morph
//     from the dock pill stays — that's iOS-correct.
//   • Reduce Motion: replaces the layout morph + spring with a faster eases.out
//     180ms + 4px translateY slide (Apple's Reduce Motion fallback is a faster
//     animation, not no animation).
//
// All landmarks carry `data-vr-*` attributes for the visual-regression battery
// (skeleton-loading / buffer-loaded / dark mode / reduce-motion states).

import * as React from 'react'
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'framer-motion'
import { Paperclip, Mic, CornerDownLeft } from 'lucide-react'
import { createPortal } from 'react-dom'
import { FocusScope } from '@radix-ui/react-focus-scope'

import { cn } from '@/lib/utils'
import { springs, eases } from '@/lib/springs'
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport'
import { buildAttachmentPrompt } from '@/lib/api/files'
import { UploadActionSheet } from './upload-action-sheet'
import { AttachmentRow } from './attachment-chip'
import { useStagedAttachments } from './use-staged-attachments'
import { useDictation } from './use-dictation'

/** The shared-element id linking the dock's bottom-left Edit field to this sheet's
 *  surface — both render a `<motion.*>` with this `layoutId`, so framer tweens the
 *  field rect into the full-width sheet surface, and back on close. */
export const COMPOSE_LAYOUT_ID = 'mobile-compose-surface'

/** Sheet phase, mirrored from the external-edit machine. `pending` = skeleton,
 *  `ready` = real textarea. Closed sheets are simply not rendered. */
export type EditSheetPhase = 'pending' | 'ready'

export interface MobileComposeSheetProps {
  open: boolean
  /** Controlled open-state. Setting `false` is a DISMISS = cancel the edit (the
   *  parent's `useExternalEdit` leaves Claude's buffer unchanged). */
  onOpenChange: (open: boolean) => void
  /** Stage 1: which body to render. `pending` → skeleton (the bridge round-trip
   *  is in flight). `ready` → the real textarea, seeded from `buffer`. */
  phase: EditSheetPhase
  /** The buffer text to seed the textarea with — Claude's current `❯` input,
   *  delivered over the `external-edit` SSE event. Empty/ignored while pending. */
  buffer: string
  /** The bridge correlation id — the EditorBody is key'd on this so a redundant
   *  `arrived` SSE for the SAME requestId (an SSE reconnect replay, server
   *  re-broadcast) re-renders with the same key and DOES NOT remount → an
   *  in-progress textarea's state survives. Keying on `buffer` instead would let
   *  an identical-buffer re-fire clobber the user's mid-edit text. `null` while
   *  pending (no requestId yet); never null when `phase === 'ready'`. */
  requestId: string | null
  /** Save the edited text back into Claude's input buffer. Receives the FINAL text
   *  (edited body + any attachment path sentence), NO trailing Enter — the text
   *  lands at Claude's `❯` and the user submits with Enter themselves. */
  onSave: (text: string) => void
}

export function MobileComposeSheet({
  open,
  onOpenChange,
  phase,
  buffer,
  requestId,
  onSave,
}: MobileComposeSheetProps) {
  const reduce = useReducedMotion()
  // The sheet rises flush above the soft keyboard — same mechanism the focus
  // sheet uses (a keyboard-top inset off visualViewport). The inset lifts the
  // bottom-0 surface up so its bottom edge lands at the keyboard TOP.
  const { keyboardInset } = useKeyboardViewport()
  // Lifted to the surface so the FocusScope's onMountAutoFocus can land the caret
  // in the textarea (EditorBody still owns it for change/keydown/Done wiring).
  const textRef = React.useRef<HTMLTextAreaElement | null>(null)
  // Latest edited text — pushed up from EditorBody on every change via a stable
  // ref. Stays a REF (not state) so the surface never re-renders on each keystroke
  // and Cancel can check `dirty` against the original buffer at click time. The
  // body owns the visible state; this is just a peek-at-current-value channel.
  const textRef2 = React.useRef('')
  React.useEffect(() => {
    // Re-seed the dirty-baseline ref whenever a new buffer arrives so a fresh
    // edit is "clean" on open. EditorBody is also key'd by buffer (its internal
    // state remounts), so the local text starts at exactly `buffer` too.
    if (phase === 'ready') textRef2.current = buffer
  }, [phase, buffer])

  // Unsaved-changes confirm — an iOS-style modal sheet ("Discard changes?
  // Cancel | Discard"). Only shown when there IS a delta vs the seeded buffer.
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)

  const handleCancel = React.useCallback(() => {
    // `dirty` is computed at click time off the ref — never stale, no re-render.
    const dirty = phase === 'ready' && textRef2.current !== buffer
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    onOpenChange(false)
  }, [phase, buffer, onOpenChange])

  // Esc dismisses the sheet — matching iOS Notes / Apple Mail and every modal
  // everywhere. Two-level cascade (matches iOS native behaviour):
  //   1. If the discard-confirm sub-sheet is open → Esc closes JUST the confirm
  //      (return to editing). Same as tapping its "Cancel" button.
  //   2. Otherwise → Esc delegates to handleCancel: if the textarea is dirty it
  //      opens the confirm; if clean it closes the whole sheet immediately.
  //
  // Attached at document level so it fires regardless of which element inside the
  // FocusScope (textarea, buttons, …) currently has keyboard focus. The Radix
  // FocusScope does NOT block document-level listeners — they still fire.
  //
  // e.preventDefault() swallows the Esc so it cannot reach other document-level
  // handlers (e.g. route-level Esc / xterm Esc-key delivery).
  // stopPropagation() stops it bubbling further up the DOM.
  //
  // data-vr-esc-handler is the VR battery annotation the spec requires.
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (confirmDiscard) {
        // Level 1: close just the discard-confirm sub-sheet, return to editing.
        setConfirmDiscard(false)
      } else {
        // Level 2: delegate to Cancel — shows discard-confirm if dirty, or
        // closes the whole sheet if clean.
        handleCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    document.documentElement.setAttribute('data-vr-esc-handler', 'edit-sheet')
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      document.documentElement.removeAttribute('data-vr-esc-handler')
    }
  }, [open, confirmDiscard, handleCancel])

  // SSR / first-paint safety: only portal once a document body exists.
  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* NO backdrop overlay. The surface is full-coverage above the
              keyboard (inset-x-0 top-0 bottom: keyboardInset) so there's
              nothing visible behind to dim — a `bg-black/40` layer would be
              redundant paint. Tap-away dismiss is gone with it; the explicit
              [Cancel] nav-bar button is the safe dismissal path. */}

          {/* The morphing surface — carries COMPOSE_LAYOUT_ID so framer tweens
              it FROM the dock Edit field's exact rect into this full-page sheet,
              and back on close. `layout` keeps it tweening as the keyboard inset
              changes its bottom. Under reduced motion the layout morph is
              dropped for a faster 180ms slide (Apple's Reduce-Motion fallback
              pattern: faster animation, NOT no animation).

              Spring = SwiftUI default sheet (response 0.35, dampingFraction
              0.85) via `springs.snippetSlide` — the over-damped sheetDetent
              felt "termiunal-y, not iOS-native" in research. */}
          <motion.div
            {...(reduce
              ? {
                  initial: { opacity: 0, y: 4 },
                  animate: { opacity: 1, y: 0 },
                  exit: { opacity: 0, y: 4 },
                  transition: { duration: 0.18, ease: eases.out },
                }
              : {
                  layoutId: COMPOSE_LAYOUT_ID,
                  layout: true,
                  transition: springs.snippetSlide,
                })}
            style={{ bottom: keyboardInset }}
            className={cn(
              // OPAQUE FULL-PAGE edit surface — no glass blur over the dark
              // terminal. bg-card resolves to #1c1c1e (dark / systemBackground.
              // dark) and #ffffff (light) via the theme tokens. `inset-x-0
              // top-0` + `style.bottom = keyboardInset` covers the viewport
              // from the top safe-area down to the keyboard top — full coverage
              // (no `max-h-[85vh]` cap, no rounded top, no top border): iOS
              // Notes' edit page model, not a peek. `pt-safe` handles the iOS
              // notch; `pb-safe` covers the home indicator when the keyboard
              // is closed. `edit-sheet-surface` is the scoped style hook for
              // caret/selection accent + system font (see globals.css).
              'edit-sheet-surface fixed inset-x-0 top-0 z-[65] flex flex-col',
              'bg-card pt-safe pb-safe outline-none',
            )}
            role="dialog"
            aria-modal="true"
            aria-label="Edit prompt"
            data-vr="edit-sheet-surface"
            data-vr-phase={phase}
            data-vr-reduce-motion={reduce ? 'true' : 'false'}
            data-vr-surface-mode="full-page"
          >
            {/* FOCUS OWNERSHIP (the "typing lands nowhere" fix). This sheet is
                portaled to document.body — OUTSIDE the dock's Vaul Drawer subtree.
                The dock drawer's focus layer treats this out-of-scope textarea as
                "focus outside" and recaptures focus back into its own content the
                instant the textarea tries to take it. Wrapping the surface in our
                OWN trapped FocusScope makes THIS sheet the active focus owner.
                EditorBody focuses the textarea on the pending→ready transition;
                `loop` keeps Tab cycling within the controls. */}
            <FocusScope
              asChild
              trapped
              loop
              onMountAutoFocus={(e) => e.preventDefault()}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <motion.div
                  layout={reduce ? false : 'position'}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {/* NO grabber. A full-page edit modal isn't drag-to-dismiss —
                      the explicit [Cancel] nav-bar button is the dismissal
                      path. A grabber would mislead (and swipe-dismiss had
                      already been disabled here to protect unsaved edits). */}

                  {/* iOS nav bar — [Cancel] · "Edit prompt" · [Done]. 44pt
                      total height (the buttons own the hit target; the visual
                      row is taller via padding). Plain text buttons, systemBlue
                      (text-primary), Done is semibold. */}
                  <NavBar
                    onCancel={handleCancel}
                    onDone={() => {
                      // Phase guard: while pending the textarea isn't mounted —
                      // a programmatic Done would commit an empty edit. The
                      // EditorBody's handleDone is the single submit path; the
                      // nav-bar Done just signals it via a custom event.
                      if (phase !== 'ready') return
                      // Dispatch via a custom event on the textarea so EditorBody
                      // (which owns the staged-attachments + save guard) handles it.
                      const ev = new CustomEvent('edit-sheet-done', {
                        bubbles: true,
                      })
                      textRef.current?.dispatchEvent(ev)
                    }}
                    doneDisabled={phase !== 'ready'}
                  />

                  {phase === 'pending' ? (
                    <PendingBody reduce={!!reduce} />
                  ) : (
                    <EditorBody
                      // Key on the bridge requestId (NOT the buffer): a fresh
                      // Ctrl+G gets a new requestId → the body remounts → the
                      // textarea reflects Claude's new input. A REDUNDANT
                      // `arrived` SSE for the SAME requestId (SSE reconnect
                      // replay, server re-broadcast) re-uses the same key → no
                      // remount → an in-progress textarea's state survives.
                      // Keying on buffer would let an identical-buffer re-fire
                      // clobber the user's mid-edit text. `requestId` is
                      // never-null while phase==='ready' (the reducer sets them
                      // together), but we coalesce defensively for TS.
                      key={`edit-${requestId ?? ''}`}
                      reduce={!!reduce}
                      textRef={textRef}
                      buffer={buffer}
                      onTextSnapshot={(t) => {
                        textRef2.current = t
                      }}
                      onSave={onSave}
                    />
                  )}
                </motion.div>
              </div>
            </FocusScope>
          </motion.div>

          {/* "Discard changes?" confirm — iOS-style modal sheet. Only mounts
              when triggered (the user hit Cancel with unsaved edits). */}
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
      )}
    </AnimatePresence>,
    document.body,
  )
}

// ── Nav bar (iOS-style top bar) ───────────────────────────────────────────────

function NavBar({
  onCancel,
  onDone,
  doneDisabled,
}: {
  onCancel: () => void
  onDone: () => void
  doneDisabled: boolean
}) {
  return (
    <div
      // 44pt iOS nav bar (h-11 = 44px). Three columns: left button | centered
      // title | right button. The center title uses absolute positioning so the
      // buttons' varying widths don't push it off-center.
      className="relative flex h-11 shrink-0 items-center px-3"
      data-vr="edit-sheet-top-bar"
    >
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel edit"
        className={cn(
          // ≥44pt hit target via h-11 + px-1 (the visible label is text only).
          // systemBlue (text-primary), regular weight — the iOS convention.
          'relative z-10 flex h-11 min-w-11 items-center px-1 text-[17px] font-normal',
          'text-primary active:opacity-60',
        )}
        data-vr="edit-sheet-cancel"
      >
        Cancel
      </button>

      <span
        // Centered title, semibold, NO chevron. iOS large-title color
        // (foreground). Absolute so the buttons can't shift it.
        className="pointer-events-none absolute inset-x-0 text-center text-[17px] font-semibold leading-[44px] text-foreground"
        aria-hidden
        data-vr="edit-sheet-title"
      >
        Edit prompt
      </span>

      <button
        type="button"
        onClick={onDone}
        disabled={doneDisabled}
        aria-label="Done editing"
        aria-disabled={doneDisabled || undefined}
        className={cn(
          'relative z-10 ml-auto flex h-11 min-w-11 items-center justify-end px-1',
          // Semibold per spec — Done is the "primary" of the two text buttons.
          'text-[17px] font-semibold text-primary active:opacity-60',
          doneDisabled && 'opacity-40',
        )}
        data-vr="edit-sheet-done"
      >
        Done
      </button>
    </div>
  )
}

// ── Pending body (skeleton) ───────────────────────────────────────────────────

function PendingBody({ reduce }: { reduce: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pb-2 pt-1">
      <TextareaSkeleton reduce={reduce} />
    </div>
  )
}

/** A soft dim block matching the textarea geometry with an animated shimmer.
 *  `role="status"` + `aria-busy="true"` exposes the loading state; the visible
 *  label "Loading your prompt…" is in muted system text. Under reduce-motion
 *  the shimmer is dropped (static dim block; same dims). */
function TextareaSkeleton({ reduce }: { reduce: boolean }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      // Same geometry as the real textarea so the swap is geometry-free.
      className={cn(
        'relative min-h-[96px] w-full flex-1 overflow-hidden rounded-[10px]',
        'border border-border bg-muted/40',
      )}
      data-vr="edit-sheet-skeleton"
    >
      {/* Shimmer band — a translucent gradient sweeping left→right. 1.6s loop.
          Under reduce-motion this layer is absent (static dim block only). */}
      {!reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-foreground/8 to-transparent"
          initial={{ x: 0 }}
          animate={{ x: '420%' }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
          data-vr="edit-sheet-skeleton-shimmer"
        />
      )}
      {/* The label — sr-only friendly so screen readers announce the loading
          state, but also visible (muted system text) so sighted users get a
          quiet "we're working on it" cue. Centered. */}
      <div className="absolute inset-0 flex items-center justify-center px-3">
        <span className="text-[14px] text-muted-foreground">
          Loading your prompt…
        </span>
      </div>
    </div>
  )
}

// ── Editor body (the real textarea + staged attachments) ──────────────────────

/** The seeded editor form — remounted per buffer so the textarea + staged
 *  attachments always start from Claude's current input. */
function EditorBody({
  reduce,
  textRef,
  buffer,
  onTextSnapshot,
  onSave,
}: {
  reduce: boolean
  /** Owned by the surface so the FocusScope can target it for the keyboard
   *  pop, and the nav-bar Done can dispatch a custom event to this body. */
  textRef: React.RefObject<HTMLTextAreaElement | null>
  buffer: string
  /** Called on every change with the current text. The surface stores it in a
   *  ref (not state) so it can compute `dirty` on Cancel without re-rendering
   *  on every keystroke. */
  onTextSnapshot: (text: string) => void
  onSave: (text: string) => void
}) {
  // Seed from Claude's current buffer. Component is key'd by `buffer` upstream,
  // so a new edit remounts → state starts at the new buffer.
  const [text, setText] = React.useState(buffer)
  // Keep the surface's dirty-baseline ref synced on every change. Pushed
  // through a stable callback so the surface never re-renders mid-typing.
  const setTextAndPush = React.useCallback(
    (next: string) => {
      setText(next)
      onTextSnapshot(next)
    },
    [onTextSnapshot],
  )

  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const staged = useStagedAttachments()
  // Single-fire guard: a fast double-tap on Done (or ⌘Enter + tap) must submit
  // exactly once.
  const savedRef = React.useRef(false)

  // Real-textarea-arrived → fade in (120ms) and pop the iOS keyboard via focus.
  // A rAF lets the layout settle (the morph + the skeleton→real swap) so the
  // focus call lands on a measured element. Cursor at the END of the buffer so
  // the user continues where Claude's `❯` left off. Under reduce-motion the
  // textarea renders solid immediately (initial=1 below); no effect needed.
  const [textareaIn, setTextareaIn] = React.useState(false)
  React.useEffect(() => {
    if (reduce) return // initial=1 covers it (no setState in effect)
    const raf = window.requestAnimationFrame(() => setTextareaIn(true))
    return () => window.cancelAnimationFrame(raf)
  }, [reduce])

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

  const handleDone = React.useCallback(() => {
    if (savedRef.current) return // double-submit guard (synchronous)
    if (staged.uploading) return // wait for in-flight uploads to resolve
    savedRef.current = true
    setSaved(true)

    // Compose the final buffer: the edited body, then any quoted attachment
    // path(s) on their own line. NO trailing Enter — the text lands back at
    // Claude's `❯` and the user submits with Enter themselves.
    const body = text
    const attachmentPaths = buildAttachmentPrompt(staged.readyPaths()).trimEnd()
    const parts = [body, attachmentPaths].filter((p) => p.length > 0)
    onSave(parts.join('\n'))
    staged.reset()
  }, [text, staged, onSave])

  // Bridge: the nav-bar Done button fires a 'edit-sheet-done' DOM event on the
  // textarea; we listen for it here so the body owns the single submit path
  // (uploads + double-submit guard live here).
  React.useEffect(() => {
    const el = textRef.current
    if (!el) return
    const onDone = () => handleDone()
    el.addEventListener('edit-sheet-done', onDone as EventListener)
    return () => el.removeEventListener('edit-sheet-done', onDone as EventListener)
  }, [handleDone, textRef])

  // ── Dictate (Web Speech), feature-detected ───────────────────────────────────
  // The accessory rail's mic appends the FINAL transcript segments to the
  // textarea value (separated by spaces) — does NOT auto-commit. The user still
  // reviews + hits Done. We don't need the safety-tail flush trick the dock has
  // (the mic icon's tap is the controlled stop here).
  const dictation = useDictation({
    onFinal: (segment: string) => {
      const seg = segment.trim()
      if (!seg) return
      const sep = text.endsWith(' ') || text === '' ? '' : ' '
      setTextAndPush(text + sep + seg + ' ')
    },
  })

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

      {/* The native textarea. Crossfades in over 120ms once mounted (unless
          reduce-motion — then it's solid immediately). 16px font-size keeps iOS
          from zoom-focusing; line-height 1.4 presents at the iOS body 17pt
          visual rhythm without violating the no-zoom floor. System font (NOT
          mono) — this is prose for an LLM, not code. Sentence-case capitalize
          + autocorrect + spellcheck on. `enterkeyhint=enter` so the keyboard
          return key says "return" (a NEWLINE, NOT submit). */}
      <motion.textarea
        ref={textRef}
        value={text}
        onChange={(e) => setTextAndPush(e.target.value)}
        onKeyDown={(e) => {
          // Hardware-keyboard ⌘/Ctrl+Enter still SAVES — convenient for the iPad
          // smart keyboard path. The soft-keyboard Return is a newline.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleDone()
          }
        }}
        rows={4}
        aria-label="Edit prompt"
        // No placeholder — the nav-bar title is the screen affordance.
        inputMode="text"
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
        enterKeyHint="enter"
        initial={{ opacity: reduce ? 1 : 0 }}
        animate={{ opacity: textareaIn ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.12, ease: eases.out }}
        className={cn(
          // System (sans) font — the editor is prose, not code. font-size 16px
          // (iOS no-zoom floor); leading 1.4 = ~22.4px visual line-height = the
          // iOS body 17pt rhythm without breaking the zoom-trigger threshold.
          'min-h-[96px] w-full flex-1 resize-none rounded-[10px] border border-border bg-background',
          'font-sans text-[16px] leading-[1.4]',
          'px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring',
        )}
        data-vr="edit-sheet-textarea"
        data-vr-visible={textareaIn ? 'true' : 'false'}
      />

      {/* Accessory rail — pinned just ABOVE the keyboard (the sheet already
          lifts via keyboardInset). 44pt buttons. Left = Attach, Center =
          Dictate (hidden if unsupported), Right = ⌘↵ Done mirror. The Done
          mirror calls handleDone directly. */}
      <div
        className="flex shrink-0 items-center gap-2 pt-0.5"
        data-vr="edit-sheet-accessory"
      >
        <motion.button
          type="button"
          aria-label="Attach a file"
          onClick={() => setUploadOpen(true)}
          whileTap={reduce ? undefined : { scale: 0.94 }}
          transition={springs.buttonPress}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground active:bg-secondary"
          data-vr="edit-sheet-accessory-attach"
        >
          <Paperclip className="size-5" strokeWidth={1.75} aria-hidden />
        </motion.button>

        {dictation.supported && (
          <motion.button
            type="button"
            aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.listening || undefined}
            onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
            whileTap={reduce ? undefined : { scale: 0.94 }}
            transition={springs.buttonPress}
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-xl',
              dictation.listening
                ? 'bg-primary/15 text-primary active:bg-primary/25'
                : 'text-muted-foreground active:bg-secondary',
            )}
            data-vr="edit-sheet-accessory-dictate"
          >
            <Mic className="size-5" strokeWidth={1.75} aria-hidden />
          </motion.button>
        )}

        <motion.button
          type="button"
          aria-label="Done editing (Cmd+Return)"
          onClick={handleDone}
          disabled={!canSave}
          whileTap={canSave && !reduce ? { scale: 0.96 } : undefined}
          transition={springs.buttonPress}
          className={cn(
            'ml-auto flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-4',
            'bg-primary/15 text-[15px] font-semibold text-primary active:bg-primary/25',
            !canSave && 'opacity-40',
          )}
          data-vr="edit-sheet-accessory-done"
        >
          <CornerDownLeft className="size-[18px]" strokeWidth={2} aria-hidden />
          Done
        </motion.button>
      </div>

      {/* 📎 picker — the SAME native action sheet (Camera / Photo library /
          Files). Picked files STAGE here (upload in the background → chips). */}
      <UploadActionSheet
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onFiles={staged.handleFiles}
      />
    </div>
  )
}

// ── Discard-changes confirm sheet (iOS-style) ─────────────────────────────────

function DiscardConfirmSheet({
  open,
  onCancel,
  onDiscard,
  reduce,
}: {
  open: boolean
  onCancel: () => void
  onDiscard: () => void
  reduce: boolean
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[70] bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.18, ease: eases.out }}
            onClick={onCancel}
            aria-hidden
          />
          <motion.div
            initial={{ opacity: 0, y: reduce ? 0 : 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : 24 }}
            transition={reduce ? { duration: 0.12 } : springs.snippetSlide}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="edit-discard-title"
            aria-describedby="edit-discard-body"
            className={cn(
              'fixed inset-x-3 bottom-3 z-[71] rounded-[14px] bg-card',
              'border border-border/60 shadow-2xl',
            )}
            data-vr="edit-sheet-discard-confirm"
          >
            <div className="px-4 pb-2 pt-4 text-center">
              <div
                id="edit-discard-title"
                className="text-[17px] font-semibold text-foreground"
              >
                Discard changes?
              </div>
              <div
                id="edit-discard-body"
                className="mt-1 text-[13px] text-muted-foreground"
              >
                Your edits will be lost.
              </div>
            </div>
            <div className="flex items-stretch border-t border-border/60">
              <button
                type="button"
                onClick={onCancel}
                aria-label="Keep editing"
                className="flex h-11 flex-1 items-center justify-center text-[17px] font-normal text-primary active:bg-secondary"
                data-vr="edit-sheet-discard-cancel"
              >
                Cancel
              </button>
              <span aria-hidden className="w-px bg-border/60" />
              <button
                type="button"
                onClick={onDiscard}
                aria-label="Discard edits"
                className="flex h-11 flex-1 items-center justify-center text-[17px] font-semibold text-destructive active:bg-secondary"
                data-vr="edit-sheet-discard-confirm-action"
              >
                Discard
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

export default MobileComposeSheet
