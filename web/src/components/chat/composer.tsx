/**
 * The composer, LIVE (fase A4 T3).
 * ─────────────────────────────────────────────────────────────────────────────
 * A3 shipped the pill and told the truth about it: read-only, "switch to
 * Terminal to type". This is the slice where the chat surface starts driving
 * the session, so the honesty line goes and a real input plane takes its place.
 *
 * The split, kept exactly as A3 left it:
 *   · `ui/composer.tsx` (B0) is still the SHELL — the 58/52px pill, the
 *     hairline, the blur, the accent focus ring. Nothing here restyles it; the
 *     field and the trailing control arrive as slots B0 already had (`field`,
 *     `trailing`), which is why `/dev/chat-ui` is pixel-identical after A4.
 *   · `use-composer.ts` is the BEHAVIOUR — draft store, key contract, submit.
 *   · this file is the COMPOSITION: what the boards draw plus the two things a
 *     control surface owes the user — a control that admits what it is about to
 *     do (Stop, while a turn runs), and a refusal that says why.
 *
 * THE TWO REFUSALS (master plan §3, a0-findings §5). Before every send the
 * composer takes one `/peek`:
 *   · a DIALOG is up → send nothing. `POST /send` while a permission dialog is
 *     open was never A0-tested, and the plausible failure is that the text is
 *     read as an answer to the dialog. The card above can answer it (T7).
 *   · the TERMINAL HAS A DRAFT → send nothing. `send_text` pastes at the TUI's
 *     prompt, so it would CONCATENATE onto the half-sentence sitting there and
 *     submit the pair. The banner quotes it back and offers the terminal.
 * A peek that FAILS is not a refusal: the send proceeds and T4's watchdog is
 * the honest layer. An unusable composer is a worse failure than an unverified
 * send.
 */
import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { motionOff, springs, tweens } from '../../lib/springs'
import { SessionMark } from '../../brand/marks'
import { cn } from '../../lib/utils'

import { useDictation } from '../focus-mode/use-dictation'

import { ComposerFrame } from './composer-shell'
import type { EntityPickerProps } from './entity-picker'
import { pickerOptionId, PICKER_LISTBOX_ID, type EntityPickerData } from './slash'
import type { ComposerHandle, ComposerNotice } from './use-composer'
import { DRAFT_PREVIEW_CHARS } from './use-composer'
import { AtIcon, ClockIcon, Composer, MicIcon, PlusIcon } from './ui'
import ChatActionsSheet from './chat-actions-sheet'
import ChatActionsPopover from './chat-actions-menu'
import { AttachmentChips } from './attachment-chips'
import { Popover, PopoverTrigger } from '../ui/popover'
import { useMediaQuery } from '../../hooks/use-media-query'
import type { UseStagedAttachmentsResult } from '../focus-mode/use-staged-attachments'

/** The invisible 44pt touch target every disc on the bar grows on a coarse
 *  pointer: an `::after` inset so pointer-events ride the pseudo-element and a
 *  thumb landing a few px wide of the glyph still presses the button and nothing
 *  else. One const, referenced by the leading `+`, the trailing send/stop, and
 *  the rest-state mic — so the recipe is stated once, not copied three ways. */
const COARSE_TARGET =
  '[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[""]'

/** A stable empty chip list, so an unwired composer never re-renders on a new
 *  array identity (and reads byte-identically to today). */
const EMPTY_ATTACHMENTS: readonly never[] = []

/** The `@`/`/` popover (fase A4 T9), lazily — it is reached only when somebody
 *  types a trigger, so its list, its filter and its two queries stay out of the
 *  chunk the surface pays for on open (T12's budget rule). */
const EntityPicker = React.lazy(() => import('./entity-picker'))

/** The composer's folded-actions sheet rides in the `chat-panel` chunk (imported
 *  at the top of this file). That chunk is itself lazy — loaded only when a chat
 *  pane mounts, never on the hero path — so the sheet stays out of the ENTRY
 *  chunk exactly as the budget rule requires, WITHOUT paying the app-total gzip
 *  penalty a ~0.8 KB standalone `React.lazy` chunk costs (a tiny chunk has no
 *  shared compression window). The `sheetMounted` gate below still defers the
 *  RUNTIME cost — Vaul is not constructed until the first `+` tap. */

/**
 * The route-owned half of the leading `+` menu (mobile chat). The composer owns
 * the sheet and the compose actions it can serve itself — mention, command,
 * schedule — but these four reach OUT of the composer, so the surface that
 * mounts it (`routes/focus/mobile.tsx`) passes them in. Present ⇒ the leading
 * control is the single `+` add-menu; absent ⇒ the desktop minimal pair.
 */
export interface ChatComposerActions {
  /** Open the session switcher; omitted (desktop's persistent list) → no row. */
  onSwitchSession?: () => void
  /** Open the global command palette (⌘K) — search / jump / new session. */
  onCommandPalette: () => void
  /** Open the snippets drawer; omitted → the row is not drawn. */
  onSnippets?: () => void
}

/** The same 260ms opacity crossfade `live-layer.tsx`'s `SwapCell` uses for P13.
 *  Send→Stop is the same kind of event — one cell, two occupants — so it is the
 *  same move, not a new one. */
// A6/T6.2 — see header-pill.tsx: the three SWAP_S copies are now `tweens.swap`.

export interface ChatComposerProps {
  /** The session's slug — the draft's key, and the insert seam's address. */
  name: string
  /** What the placeholder says out loud: display name, then slug. */
  label: string
  handle: ComposerHandle
  surface?: 'desktop' | 'phone'
  /** A turn is running: the trailing control is Stop, and a bare Escape stops. */
  active?: boolean
  /** The `hook→UI p50` read-out, when the session has produced samples. */
  stat?: React.ReactNode
  /** Switch this pane to the terminal renderer. Every refusal offers it — the
   *  terminal is the surface that can always do what chat just declined to. */
  onOpenTerminal?: () => void
  /**
   * What draws the `@`/`/` popover. Defaults to the real, lazily-loaded picker
   * over `tracked-files` / the sessions list / `/api/slash-commands`.
   *
   * A SLOT for the same reason `provisional` is one: `/dev/chat-live` has no
   * server behind it, and a bench that could only screenshot an empty popover
   * would be unable to hold the one surface here that a screenshot can catch
   * lying (T10).
   */
  renderPicker?: (props: EntityPickerProps) => React.ReactNode
  /** What the popover offers — the panel's three lists (fase A4 T9). */
  pickerData?: EntityPickerData
  /**
   * Schedule this instead of sending it now (fase B4 T9) — opens the session's
   * Schedules sheet in create mode, with the current draft carried over as the
   * prompt.
   *
   * A SECOND LEADING CONTROL rather than a menu behind the `+`: `+` types a
   * trigger into the draft and this opens a sheet, which are different enough
   * that folding them into one control would make the common one (mention a
   * file) cost a menu. Both live in the composer, which is present on the phone
   * too — §5.2's rule that non-terminal actions belong to the dock, not to a
   * hover.
   *
   * Omit and the control is not drawn at all: the bench and the tests render a
   * composer with no sheet behind it, and an inert clock would be a promise.
   */
  onSchedule?: (draft: string) => void
  /**
   * The route-owned actions behind the leading `+` (mobile chat only). Present ⇒
   * the leading control is ONE `+` that owns the whole add-menu: the composer's
   * own mention/command/schedule PLUS these (switch session, command palette,
   * snippets), all in a snug sheet anchored to the `+`. Dictation is NOT in that
   * menu — the composer's trailing rest-state mic (a real `useDictation` toggle)
   * is the single dictation control, so a menu row would only duplicate it. The
   * old three leading buttons (`⋯` / `@`-as-plus / clock) collapse into the `+`,
   * so the phone has a single, symmetric input bar.
   *
   * Omit (desktop split, bench, tests) ⇒ the leading control is the desktop
   * minimal PAIR: a real `@` mention button and, when `onSchedule` is wired, the
   * clock — each glyph matching its action, no sheet drawn behind them.
   */
  actions?: ChatComposerActions
  /**
   * The staged attachment plane (composer upgrade). Owned by the composition
   * root next to `useComposer` (so the outgoing prefix / reset can be wired into
   * the SAME gated submit), and handed down here to render: the chip row above
   * the pill, the `+` add-menu's Attach group, the desktop attach disc, and
   * paste / drag-drop — all feed `attachments.handleFiles`. `readyPaths()`
   * becomes the `getOutgoingPrefix` the submit folds in.
   *
   * Optional: omitted (the bench, the read-only shell, any surface that does not
   * wire uploads) ⇒ no chips, no attach affordances, byte-identical to today.
   */
  attachments?: UseStagedAttachmentsResult
  /**
   * This session cannot work — a quota bucket, an auth death (`blocked.ts`).
   * The string is the REASON, already naming the limit and, where there is one,
   * when it lifts.
   *
   * A permanent strip and a read-only field, not a disabled button with no
   * explanation: the states audit found the opposite shipping, a fully live
   * composer over a session that was dead for the next five hours, and every
   * character typed into it went nowhere with no sign that it had. A composer
   * that refuses in silence is the same defect one step later.
   */
  blocked?: string
  className?: string
}

export function ChatComposer({
  name,
  label,
  handle,
  surface = 'desktop',
  active = false,
  stat,
  onOpenTerminal,
  renderPicker,
  pickerData,
  onSchedule,
  actions,
  attachments,
  blocked,
  className,
}: ChatComposerProps) {
  // Destructure the handle up front. `handle` carries `fieldRef` (a RefObject),
  // so reading its members as `x` during render trips react-hooks/refs
  // ("cannot access refs during render") for EVERY field — the rule taints the
  // whole ref-bearing object. Pulling the fields into locals reads the ref only
  // where it's meant to be read (the effect below) and keeps render clean.
  const {
    draft,
    fieldRef,
    picker,
    insert,
    handoff,
    sending,
    submit,
    stop,
    notice,
    dismissNotice,
    onChange,
    onKeyDown,
    onSelect,
  } = handle
  const phone = surface === 'phone'
  const reduce = useReducedMotion() ?? false
  // Fork the add-menu's OPEN SURFACE on input modality, not on the `phone`
  // surface flag: a coarse pointer (any touch device — phone, tablet, a
  // convertible on the desktop split) gets the thumb-reachable Vaul sheet; a
  // fine pointer gets the anchored Radix popover in the composer's own glass.
  // The single leading `+` is identical on both.
  const coarse = useMediaQuery('(pointer: coarse)')
  // THE LEADING `+` MENU. Owned HERE, not by the route, so the surface is
  // literally anchored to the control that opens it — the fix for a menu that
  // read as a floating, disconnected list. `menuOpen` drives BOTH shells and the
  // `+ → ×` morph; `sheetMounted` gates the Vaul lazy chunk on the FIRST coarse
  // open so the sheet's runtime never touches a fine-pointer surface.
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [sheetMounted, setSheetMounted] = React.useState(false)
  const toggleMenu = React.useCallback(() => {
    setMenuOpen((open) => {
      if (!open && coarse) setSheetMounted(true)
      return !open
    })
  }, [coarse])
  // Vaul returns focus to the trigger (`+`) on close; a compose action that
  // stages a trigger needs the caret back in the FIELD instead, so the picker
  // it just opened is what the next keystroke types into. The picker itself is
  // draft-derived (`use-composer.ts`), so it shows regardless — this only keeps
  // the field hot.
  const refocusField = React.useCallback(() => {
    window.requestAnimationFrame(() => fieldRef.current?.focus())
  }, [fieldRef])
  const onMention = React.useCallback(() => {
    setMenuOpen(false)
    insert('@')
    refocusField()
  }, [insert, refocusField])
  const onSlash = React.useCallback(() => {
    setMenuOpen(false)
    insert('/')
    refocusField()
  }, [insert, refocusField])
  // ── the rest-state mic IS dictation ─────────────────────────────────────────
  // Not decoration: at rest the trailing cell is a real mic that toggles Web
  // Speech through `useDictation` — the SAME hook the dock's mic uses, which
  // DOES exist on iOS Safari / WKWebView (`webkitSpeechRecognition`). So the mic
  // is shown on the iPhone, where dictation works, and hidden only where the
  // browser exposes no recognition at all (`dictation.supported`).
  //
  // Transcribed text lands in the DRAFT through the composer's own insert seam
  // (`handle.insert` → `insertIntoComposer`), so a dictated sentence reads
  // exactly like a typed one and is one Enter from the gated send path.
  //
  // onFinal-FIRST FLUSH (iOS discipline, mirrored from the dock). Web Speech's
  // `onend` fires unreliably on iOS / WKWebView, so FINAL segments are inserted
  // the instant they commit (`onFinal`); the cumulative interim is buffered only
  // as a safety tail, flushed on the stop tap. A `sentLen` cursor dedupes the
  // two paths so a segment can never land twice.
  const pendingTranscriptRef = React.useRef('')
  const sentLenRef = React.useRef(0)
  const dictation = useDictation({
    // Cumulative interim — buffered for the safety-tail flush; never inserted here.
    onTranscript: React.useCallback((text: string) => {
      pendingTranscriptRef.current = text
    }, []),
    // Final segment — insert immediately (does not wait for the unreliable onend).
    onFinal: React.useCallback(
      (segment: string) => {
        const seg = segment.trim()
        if (!seg) return
        insert(seg + ' ')
        // Web Speech's cumulative transcript joins finals with spaces; advance the
        // dedupe cursor past what we just inserted so the tail flush won't re-add it.
        sentLenRef.current = pendingTranscriptRef.current.length
      },
      [insert],
    ),
  })
  // Flush only the UNSENT tail — text the user spoke that never finalized before
  // they stopped. Clears state BEFORE inserting so it can never double-insert.
  const flushDictation = React.useCallback(() => {
    const tail = pendingTranscriptRef.current.slice(sentLenRef.current).trim()
    pendingTranscriptRef.current = ''
    sentLenRef.current = 0
    if (tail) insert(tail + ' ')
  }, [insert])
  // Mic tap: STOPPING flushes the unsent tail inside the user gesture (WS still
  // open) THEN stops — independent of whether `onend` ever arrives. STARTING just
  // starts; final segments stream in via `onFinal` while listening. Shared by the
  // rest-state mic AND the add-menu's Dictate row (one instance, no dead second).
  const onMicTap = React.useCallback(() => {
    if (dictation.listening) {
      flushDictation()
      dictation.stop()
    } else {
      dictation.start()
    }
  }, [dictation, flushDictation])
  // ── ATTACHMENTS (composer upgrade) ─────────────────────────────────────────
  // Everything below no-ops when `attachments` is absent, so a composer that
  // does not wire uploads renders exactly as before.
  const stagedFiles = attachments?.attachments ?? EMPTY_ATTACHMENTS
  const handleFiles = attachments?.handleFiles
  const hasReady = (attachments?.readyPaths().length ?? 0) > 0
  const uploading = attachments?.uploading ?? false

  // The desktop attach disc's OS file dialog (one hidden `<input multiple>`).
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const onDesktopPick = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? [])
      e.target.value = '' // re-pick the same file still fires `change`
      if (picked.length) handleFiles?.(picked)
    },
    [handleFiles],
  )

  // PASTE — Cmd/Ctrl+V an image blob becomes a chip (desktop-critical). Scans
  // the clipboard for `kind: 'file'` images; only then `preventDefault` so text
  // and rich-content paste are untouched. On the phone the contenteditable owns
  // its own plain-text paste guard, so this never fires there.
  const onPaste = React.useCallback(
    (e: React.ClipboardEvent<Element>) => {
      if (!handleFiles) return
      const files: File[] = []
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length) {
        e.preventDefault()
        handleFiles(files)
      }
    },
    [handleFiles],
  )

  // DRAG-DROP — files dropped anywhere on the composer frame become chips, with
  // an accent ring while a drag is over it. Desktop in practice; inert on touch.
  const [dropActive, setDropActive] = React.useState(false)
  const dropHandlers = React.useMemo(() => {
    if (!handleFiles) return undefined
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return
        e.preventDefault()
        setDropActive(true)
      },
      onDragLeave: (e: React.DragEvent) => {
        // Only the leave that exits the frame itself, not a child boundary.
        if (e.currentTarget === e.target) setDropActive(false)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        setDropActive(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) handleFiles(files)
      },
    }
  }, [handleFiles])

  // MULTI-LINE / CHIPS → soften the pill's radius (the shell reads `grown`).
  // Measured off the real field height so a SOFT-WRAPPED long line counts too,
  // not just an explicit newline; the threshold is one line's worth of the
  // field's own box (per surface). Re-read on every draft change — the same
  // signal `growTextarea` runs on.
  const [multiline, setMultiline] = React.useState(false)
  React.useEffect(() => {
    const el = fieldRef.current
    setMultiline(!!el && el.scrollHeight > (phone ? 44 : 40))
  }, [draft, fieldRef, phone])
  const grown = multiline || stagedFiles.length > 0

  // A draft arms Send. While the POST is in flight the button STAYS (disabled)
  // rather than flipping back to the mic: a control that vanishes mid-tap reads
  // as a bug, and the disabled state is the honest "asked, not yet answered".
  //
  // An IMAGE ALONE is a valid message (`hasReady`), and Send WAITS for uploads
  // (`!uploading`): while bytes are in flight the disc shows disabled, the same
  // honest "asked, not yet answered" `handle.sending` already uses.
  const canSend = (draft.trim().length > 0 || hasReady) && !uploading && !blocked
  // The Send disc is SHOWN (not swapped for the mic) whenever there is anything
  // to send — including while an upload is still settling — so it can present as
  // disabled rather than vanishing. `canSend` is the enabled gate; this is the
  // visibility gate.
  const showSend =
    (draft.trim().length > 0 || stagedFiles.length > 0) && !blocked
  // WHICH ROW THE POPOVER IS ON (A4 review). The list lives in the picker, but
  // the only element that ever has focus is the textarea — so the textarea is
  // what has to carry `aria-activedescendant`, and the highlight travels up
  // here to be written onto it. −1 = the list has nothing to point at.
  const [activeOption, setActiveOption] = React.useState(-1)
  const pickerOpen = picker.open
  const pickerProps: EntityPickerProps = {
    name,
    kind: picker.kind,
    query: picker.query,
    surface,
    ...pickerData,
    // The picker hands over the ROW; the composer's insert seam wants the text
    // that lands in the draft. Collapsing here rather than in the picker keeps
    // the row's identity available to any future caller (`entity-picker.tsx`).
    //
    // `?? ''` rather than `!`: since fase B3 the row union has three arms —
    // insert, run and navigate — and only the first carries `value`. Chat's
    // `@`/`/` builders produce nothing but insert rows (`slash.ts`), so this
    // is unreachable; making it a no-op rather than an assertion means a future
    // surface that hands chat a verb row inserts nothing instead of putting the
    // string "undefined" into somebody's message.
    onPick: (row) => picker.pick(row.value ?? ''),
    bind: picker.bind,
    onActive: setActiveOption,
  }

  return (
    <ComposerFrame
      surface={surface}
      stat={stat}
      className={className}
      drop={dropHandlers}
      dropActive={dropActive}
    >
      {blocked && (
        <p
          role="status"
          data-testid="chat-composer-blocked"
          className={cn(
            'mb-2 flex items-center gap-1.5 rounded-2xl border-[0.5px] border-status-error/30',
            'bg-status-error/10 px-3.5 py-2 text-[12.6px] tracking-[-0.05px] text-status-error',
          )}
        >
          <span aria-hidden>⚠</span>
          {blocked} — messages sent now won’t be picked up.
        </p>
      )}
      <ComposerBanner
        notice={notice}
        onOpenTerminal={onOpenTerminal}
        onDismiss={dismissNotice}
        reduce={reduce}
      />
      {picker.open &&
        (renderPicker ? (
          renderPicker(pickerProps)
        ) : (
          // No fallback: a spinner for a popover that opens in one frame from a
          // 30s-cached list would be the only thing anyone ever saw of it.
          <React.Suspense fallback={null}>
            <EntityPicker {...pickerProps} />
          </React.Suspense>
        ))}
      {/* THE CHIP ROW — above the pill, in the same above-pill stack as the
          banner and the `@`/`/` picker, so it reads as part of the one composer
          unit and the rounded pill never clips a thumbnail. Renders nothing when
          empty. */}
      {attachments && (
        <AttachmentChips attachments={attachments.attachments} onDismiss={attachments.dismiss} />
      )}
      {/* The one hidden OS file dialog for the fine-pointer attach affordances —
          the desktop pair's paperclip disc AND the `+` popover's Attach row both
          click it. Hoisted here so a single input serves either leading shape.
          (The coarse sheet has its own native Camera/Photo/Files pickers.) */}
      {attachments && (
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onDesktopPick} />
      )}
      <Composer
        size={phone ? 'mobile' : 'desktop'}
        placeholder={`Message ${label}`}
        grown={grown}
        leading={
          // ONE CLEAN LEADING CONTROL, TWO SHAPES.
          //
          // ALIGNMENT (owner feedback #2). Every control on this bar is now the
          // SAME disc — `size-9` on the phone / `size-10` on desktop, a `grid
          // place-items-center` cell with its glyph optically centred and a 44pt
          // touch target grown by a coarse-pointer `::after` (see
          // `LeadingButton`, the exact recipe `TrailingButton` uses on the right).
          // So the row is symmetric: an add disc on the left, the send disc on
          // the right, both on one baseline — not the old cluster of a 26px `⋯`,
          // an overlapped `@`/clock pair on negative margins, and a 40px mic.
          //
          // SEMANTICS (owner feedback #1). Under `actions` the leading control is
          // a single `+` — on BOTH surfaces now — that OPENS THE MENU: `+`
          // genuinely means "add something". It no longer silently types an `@`.
          // Mentions, commands, attach and schedule live inside that menu (and
          // `@`/`/` still work typed directly into the field). The menu's SHELL
          // forks on the pointer: a Vaul sheet on coarse, an anchored Radix
          // popover on fine — same rows, same `+`. Absent `actions` (benches /
          // read-only) the desktop pair keeps DIRECT buttons, each with the glyph
          // of the thing it does: an `@` for mention, a clock for schedule.
          actions ? (
            coarse ? (
              // COARSE — the `+` toggles the Vaul bottom sheet (rendered below).
              <LeadingButton
                testId="chat-composer-add"
                label={menuOpen ? 'Close actions' : 'Add to your message'}
                phone={phone}
                expanded={menuOpen}
                aria-haspopup="menu"
                onClick={toggleMenu}
              >
                <AddGlyph open={menuOpen} reduce={reduce} />
              </LeadingButton>
            ) : (
              // FINE — the `+` is the Radix popover trigger; the menu rises from
              // it in the composer's own glass (focus-trap / Esc / outside-click /
              // return-focus come free from Radix).
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <LeadingButton
                    testId="chat-composer-add"
                    label={menuOpen ? 'Close actions' : 'Add to your message'}
                    phone={phone}
                    expanded={menuOpen}
                    aria-haspopup="menu"
                  >
                    <AddGlyph open={menuOpen} reduce={reduce} />
                  </LeadingButton>
                </PopoverTrigger>
                <ChatActionsPopover
                  // Attach is one OS dialog on a fine pointer (no camera) — the
                  // hoisted hidden `<input>` below. Gated on wired uploads.
                  onAttach={handleFiles ? () => fileInputRef.current?.click() : undefined}
                  onMention={onMention}
                  onSlash={onSlash}
                  onSnippets={actions.onSnippets}
                  // The draft is COPIED, not moved (T9.2): schedule opens a sheet
                  // seeded from the prompt and the composer keeps every character.
                  onSchedule={onSchedule ? () => onSchedule(draft) : undefined}
                  // Omitted on desktop (the persistent session list makes it
                  // redundant) ⇒ the Switch-session row simply won't render.
                  onSwitchSession={actions.onSwitchSession}
                  onCommandPalette={actions.onCommandPalette}
                  onClose={() => setMenuOpen(false)}
                />
              </Popover>
            )
          ) : (
            <div className="flex flex-none items-center gap-2">
              {/* DESKTOP ATTACH — a direct disc, not a menu: there is one OS
                  file dialog and no `+` sheet on desktop, so a button is fewer
                  clicks than inventing one. Paste + drag-drop are the power
                  paths; this is the discoverable fallback. Only when uploads are
                  wired. */}
              {attachments && (
                <LeadingButton
                  testId="chat-composer-attach"
                  label="Attach a file"
                  phone={phone}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon />
                </LeadingButton>
              )}
              <LeadingButton
                testId="chat-composer-at"
                label="Mention a file or a session"
                phone={phone}
                // Types the trigger and opens the ONE picker this surface has —
                // the caret ends up where the user would have put it. Now drawn
                // as an `@`, the glyph of what it does.
                onClick={() => insert('@')}
              >
                {/* `@` is the 18px reference the paperclip and clock are now sized
                    to (they were a small 17 and a 16 beside it). */}
                <AtIcon />
              </LeadingButton>
              {onSchedule && (
                <LeadingButton
                  testId="chat-composer-schedule"
                  label="Schedule this instead of sending now"
                  phone={phone}
                  // The draft is COPIED, not moved (T9.2): the sheet starts from
                  // a prompt and the composer keeps every character.
                  onClick={() => onSchedule(draft)}
                >
                  {/* 18px, matching `@` and the paperclip — was `size-4` (16px),
                      the third of three mismatched sizes. */}
                  <ClockIcon className="size-[18px]" />
                </LeadingButton>
              )}
            </div>
          )
        }
        field={{
          ref: fieldRef,
          value: draft,
          // READ-ONLY rather than `disabled`: the draft stays selectable and
          // copyable, so a message typed just before the limit landed can be
          // rescued into another session instead of being taken away.
          readOnly: blocked ? true : undefined,
          'aria-disabled': blocked ? true : undefined,
          onChange: onChange,
          onKeyDown: onKeyDown,
          onSelect: onSelect,
          // Paste an image → a chip. Only wired when uploads are (so an unwired
          // composer carries no extra handler); the desktop textarea reads it
          // off `rest`, and the phone contenteditable keeps its own plain-text
          // paste guard, so this is a desktop path in practice.
          onPaste: attachments ? onPaste : undefined,
          // The composer is a message box, not a code editor: the browser's own
          // spellcheck is the right default, and autocapitalise/autocorrect are
          // what a phone keyboard expects from one.
          spellCheck: true,
          // A soft keyboard shows a RETURN key, not "Send" — Enter breaks the line
          // and the send DISC sends (BUG: the iOS keyboard showed "Send" and Enter
          // submitted). `enterKeyHint` only reaches VIRTUAL keyboards, which are a
          // touch (coarse-pointer) surface, and there the composer's Enter IS a
          // newline (`use-composer.ts` gates that on the same coarse pointer) — so
          // 'enter' is unconditional: a physical desktop keyboard ignores the hint
          // and still submits on Enter, unchanged.
          enterKeyHint: 'enter',
          // The `@`/`/` popover, as a relationship a screen reader can follow.
          // Without it the popover was invisible to assistive tech: nothing
          // announced that suggestions had appeared, ↑/↓ moved a highlight that
          // was never spoken, and Enter replaced the token with a value the
          // user had not been told (A4 review). The keyboard contract was
          // always there — `use-composer.ts` routes the keys — it just could
          // not be observed.
          role: 'combobox',
          'aria-autocomplete': 'list',
          'aria-expanded': pickerOpen,
          'aria-controls': pickerOpen ? PICKER_LISTBOX_ID : undefined,
          'aria-activedescendant':
            pickerOpen && activeOption >= 0 ? pickerOptionId(activeOption) : undefined,
          'data-testid': 'chat-composer-field',
          'data-session': name,
        }}
        trailing={
          <div className="grid size-10 place-items-center">
            <AnimatePresence initial={false}>
              <motion.div
                key={showSend ? 'send' : active ? 'stop' : 'idle'}
                style={{ gridArea: '1 / 1' }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                // Opacity only, in one cell: nothing reflows when the status
                // flips mid-sentence.
                transition={reduce ? motionOff : tweens.swap}
              >
                {/* THE BUTTON DOES WHAT THE BOX SAYS (A4 review). The plan drew
                    Stop as the trailing control "while Active" full stop; with
                    a draft in the box that made the ONE control a pointer user
                    can reach mid-turn an INTERRUPT — and typing a follow-up
                    mid-turn is a first-class flow here (Claude Code queues it,
                    receipt measured at 158ms). So: text in the box → Send;
                    empty box during a turn → Stop; at rest → the boards' mic.
                    Stop with a draft up is still one Escape away (the key
                    contract) and the dock keeps its own Stop. */}
                {showSend ? (
                  <TrailingButton
                    // THE CONTROL SAYS WHERE THE WORDS ARE GOING (fase B4
                    // T4.4). While the draft reads as a hand-off, Enter goes to
                    // a COLLEAGUE rather than to this session — so the label
                    // changes before the key is pressed, not after. Same
                    // element, same cell, no swap: only the sentence differs.
                    testId="chat-send"
                    label={
                      uploading
                        ? 'Waiting for uploads…'
                        : handoff
                          ? `Hand to ${handoff.label}`
                          : `Send to ${label}`
                    }
                    data-handoff={handoff ? handoff.to : undefined}
                    phone={phone}
                    onClick={submit}
                    // Disabled while a POST is in flight, while an upload is
                    // still settling, or when there is nothing actually sendable
                    // (only errored chips + an empty box) — `!canSend` folds all
                    // three: the disc stays visible, present but not yet armed.
                    disabled={sending || !canSend}
                  >
                    {/* THE GLYPH CHANGES TOO, not just the label (fase B4
                        T4.4). An `aria-label` alone is not "visible before the
                        key is pressed" for a sighted user — so while the intent
                        holds the arrow becomes the RECIPIENT'S FACE, which is
                        this app's word for "this is going to them" everywhere
                        else. Same cell, same size, no reflow. */}
                    {handoff ? (
                      <SessionMark
                        seed={handoff.to}
                        size={phone ? 19 : 21}
                        animate={false}
                        label={null}
                      />
                    ) : (
                      <SendIcon />
                    )}
                  </TrailingButton>
                ) : active ? (
                  <TrailingButton
                    testId="chat-stop"
                    label="Stop"
                    phone={phone}
                    onClick={stop}
                  >
                    <StopIcon />
                  </TrailingButton>
                ) : dictation.supported ? (
                  /* AT REST THE MIC IS DICTATION — a real button, not decoration.
                     Tapping it toggles Web Speech; transcribed text lands in the
                     draft via `insert`. It exists on iOS too
                     (`webkitSpeechRecognition`), so it is NOT hidden there.

                     While listening it shows a recording state: `aria-pressed`
                     and the brand-amber wash in place of the `.sm-mic` disc, so
                     the user can see dictation is live before they speak. */
                  <motion.button
                    type="button"
                    data-testid="chat-mic"
                    aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
                    aria-pressed={dictation.listening}
                    title={dictation.listening ? 'Stop dictation' : 'Dictate'}
                    onClick={onMicTap}
                    whileTap={{ scale: 0.94 }}
                    transition={springs.buttonPress}
                    className={cn(
                      'relative grid place-items-center rounded-full',
                      phone ? 'size-9' : 'size-10',
                      // Recording → brand wash; at rest → the boards' inverted disc.
                      // Swapped (not layered) so there is no `.sm-mic`-vs-utility
                      // specificity fight over the background.
                      dictation.listening ? 'bg-brand/20 text-brand' : 'sm-mic',
                      // The invisible 44pt target on a coarse pointer — same
                      // `::after` inset the Send/Stop control uses, so the disc is
                      // unchanged but a thumb landing 4px wide still presses it.
                      COARSE_TARGET,
                    )}
                  >
                    <MicIcon />
                  </motion.button>
                ) : (
                  /* No Web Speech here — draw nothing rather than a dead mic. The
                     cell keeps its footprint so the field width does not jump
                     between the idle and the armed states. */
                  <span aria-hidden className={phone ? 'size-9' : 'size-10'} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        }
      />
      {/* THE ADD-MENU (COARSE), ANCHORED (owner feedback #3). The sheet is owned
          by the composer and opened by the `+` above it, not floated in by the
          route — so it reads as belonging to this bar. It carries the composer's
          own materials (glass, radius, safe-area) and its rows use the SAME
          authored list the fine-pointer popover draws from (`chat-actions.ts`).
          `sheetMounted` holds it out of the tree until the first coarse tap, so
          Vaul is never constructed on a surface that does not open it; the
          `coarse` gate keeps it off fine-pointer surfaces (they get the popover). */}
      {actions && coarse && sheetMounted && (
        <ChatActionsSheet
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onMention={onMention}
          onSlash={onSlash}
          onSchedule={onSchedule ? () => onSchedule(draft) : undefined}
          onSnippets={actions.onSnippets}
          onSwitchSession={actions.onSwitchSession}
          onCommandPalette={actions.onCommandPalette}
          // The Attach group at the top of the `+` sheet — Camera / Photo
          // library / Files — feeds the same staged plane the chips render.
          onFiles={handleFiles}
        />
      )}
    </ComposerFrame>
  )
}

/** The `+ → ×` morph — a `PlusIcon` rotated 45° IS an `×`, so one glyph carries
 *  its own open/close state with zero new bytes. Shared by the coarse `+` (opens
 *  the sheet) and the fine `+` (the popover trigger). */
function AddGlyph({ open, reduce }: { open: boolean; reduce: boolean }) {
  return (
    <motion.span
      className="grid place-items-center"
      animate={{ rotate: open ? 45 : 0 }}
      transition={reduce ? motionOff : springs.buttonPress}
    >
      <PlusIcon />
    </motion.span>
  )
}

/**
 * A leading disc — the ADD `+`, or a desktop mention/schedule button. The exact
 * counterpart of `TrailingButton` on the right: same `size-9`/`size-10` cell,
 * same `grid place-items-center`, same invisible 44pt target grown by a
 * `::after` inset on a coarse pointer. Ghost, not inverted — the send disc is
 * the one filled control on the bar, and a filled `+` would compete with it.
 *
 * `forwardRef` + a props spread so the fine-pointer `+` can be a Radix
 * `PopoverTrigger asChild`: Radix clones this button and injects its own
 * `onClick` / `aria-expanded` / `aria-controls` / `data-state` / `ref`, which the
 * trailing `{...rest}` forwards onto the real `<button>` (rest wins over the
 * defaults). The coarse `+` and the desktop pair pass an explicit `onClick`
 * instead, with no `rest` to override it.
 */
const LeadingButton = React.forwardRef<
  HTMLButtonElement,
  {
    testId: string
    label: string
    phone: boolean
    onClick?: () => void
    /** The add control announces its menu — `aria-expanded` for a screen reader,
     *  and it is what tells the caller this button owns a disclosure. */
    expanded?: boolean
    children: React.ReactNode
  } & Omit<React.ComponentPropsWithoutRef<'button'>, 'onClick' | 'children' | 'className'>
>(function LeadingButton({ testId, label, phone, onClick, expanded, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        'relative grid flex-none place-items-center rounded-full text-ink-2 transition-colors',
        phone ? 'size-9' : 'size-10',
        'hover:text-ink active:bg-fill-soft',
        // The invisible 44pt target — pointer-events ride the pseudo-element, so
        // a thumb landing a few px wide of the glyph still hits this and nothing
        // else. The pill's `gap-3` leaves clearance to the field.
        COARSE_TARGET,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

/** The one inverted control, as a real button. Same disc as `.sm-mic` (the
 *  boards' trailing cell) — the DISC is B0's 36/40px and is not resized here,
 *  so the touch hit area comes from a 4px `::after` inset instead: 36 + 8 =
 *  44pt of tappable target inside an unchanged pill.
 *
 *  The expander is keyed on `pointer: coarse`, not on the `phone` SURFACE: the
 *  desktop split is reachable from a touchscreen (a tablet, a convertible), and
 *  there the 40px disc was the only send control on screen with no 44pt floor at
 *  all. */
function TrailingButton({
  testId,
  label,
  phone,
  onClick,
  disabled,
  children,
  ...rest
}: {
  testId: string
  label: string
  phone: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  /** Pass-through data attributes (the hand-off marker) — the E2E needs a way
   *  to assert WHO the control is aimed at without reading its copy. */
  'data-handoff'?: string
}) {
  return (
    <motion.button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      {...rest}
      onClick={onClick}
      disabled={disabled}
      aria-busy={disabled || undefined}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={springs.buttonPress}
      className={cn(
        'sm-mic relative grid place-items-center rounded-full',
        phone ? 'size-9' : 'size-10',
        // The invisible 44pt target (see the doc comment). Pointer-events ride
        // the pseudo-element, so a thumb landing 4px wide of the disc still
        // presses this button and nothing else — it is inside the pill, whose
        // `gap-3` leaves 8px of clearance to the field either way.
        COARSE_TARGET,
        disabled && 'opacity-60',
      )}
    >
      {children}
    </motion.button>
  )
}

/**
 * The refusal banner — above the pill, in flow, so it never covers the field it
 * is talking about. It carries the evidence (the terminal's own draft) and the
 * way out (the terminal itself); it does not apologise.
 */
function ComposerBanner({
  notice,
  onOpenTerminal,
  onDismiss,
  reduce,
}: {
  notice: ComposerNotice | null
  onOpenTerminal?: () => void
  onDismiss: () => void
  reduce: boolean
}) {
  return (
    // The live region is the PERSISTENT wrapper, not the banner: a role that is
    // mounted at the same moment as its text is announced inconsistently. The
    // refusal is the one thing on this surface a user learns about by NOT
    // getting what they asked for, so it has to reach a screen reader.
    <div role="status" aria-live="polite" aria-atomic="true">
    <AnimatePresence initial={false}>
      {notice && (
        <motion.div
          data-testid="chat-composer-notice"
          data-notice={notice.kind}
          initial={{ opacity: 0, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : 6 }}
          transition={reduce ? motionOff : springs.cardExpand}
          className={cn(
            'mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border-[0.5px] border-hairline',
            'bg-surface px-3.5 py-2 text-[12.6px] tracking-[-0.05px] text-ink-2',
            'backdrop-blur-[60px] backdrop-saturate-[180%]',
          )}
        >
          {/* The slash refusals name the COMMAND first — it is the subject of
              the sentence, and the user typed it two seconds ago. */}
          {(notice.kind === 'slash-picker' ||
            notice.kind === 'slash-unverified' ||
            notice.kind === 'slash-note') &&
            notice.detail && (
              <code className="font-mono text-[11.5px] text-ink">{notice.detail}</code>
            )}
          <span className="text-ink">{NOTICE_TITLE[notice.kind]}</span>
          {/* The panel's own dismissal footer (`Esc to cancel`), verbatim — the
              evidence for a refusal the user cannot otherwise see, since the
              screen it is about is on the other renderer. ATTRIBUTED, because
              unqualified it reads as this card's own key hint: Escape here
              closes this card (it used to destroy the draft), and the key that
              cancels the widget has to be pressed in the terminal. */}
          {notice.kind === 'dialog-terminal' && notice.detail && (
            <span className="text-ink-2">
              in the terminal:{' '}
              <code className="font-mono text-[11.5px] text-ink-2">{notice.detail}</code>
            </span>
          )}
          {/* The ARMING, in the terminal's own words. Same argument as the line
              above it: the screen this refusal is about is on the other
              renderer, so quoting it is the only evidence a user has that the
              app is not simply ignoring Stop. */}
          {notice.kind === 'stop-armed' && notice.detail && (
            <code className="font-mono text-[11.5px] text-ink-2">{notice.detail}</code>
          )}
          {(notice.kind === 'tui-draft' || notice.kind === 'tui-draft-unverified') &&
            notice.detail && (
              <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-2">
                “{notice.detail.slice(0, DRAFT_PREVIEW_CHARS)}”
              </span>
            )}
          {(notice.kind === 'send-failed' ||
            notice.kind === 'stop-failed' ||
            notice.kind === 'handoff-failed') &&
            notice.detail && (
              <span className="min-w-0 truncate text-ink-2">{notice.detail}</span>
            )}
          {/* The recipient reads as a name, in the sentence, after "Sent to".
              Not a chip: this banner is transient chrome and a face here would
              compete with the durable `Delegated to ●x` line the ledger writes
              into the transcript a moment later.
              The clause after the name is the honest half. A delegation is
              one-way: the server delivered a prompt into a colleague's pane,
              and whatever they answer is written in THEIR transcript. The old
              receipt said "Handed to X" and then never changed again, which
              reads as a completed exchange — a promise this surface cannot keep
              and cannot retract. The durable `Delegated to ●x` line under it
              carries the chip that goes there. */}
          {notice.kind === 'handoff-sent' && notice.detail && (
            <>
              <span className="min-w-0 truncate font-medium text-ink">{notice.detail}</span>
              <span className="text-ink-2">— their reply lands in their pane.</span>
            </>
          )}
          <span className="ml-auto flex items-center gap-2">
            {/* A NOTE is not a refusal: the message went. Offering the terminal
                beside it would imply something still has to be done there.
                Neither hand-off receipt offers it either — a delegation
                succeeds or fails on ANOTHER session's pane, so "open the
                terminal" would point at the one screen that cannot help. The
                draft is still in the box; retrying is the action. */}
            {onOpenTerminal &&
              notice.kind !== 'slash-note' &&
              notice.kind !== 'handoff-sent' &&
              notice.kind !== 'handoff-failed' && (
              <button
                type="button"
                data-testid="chat-composer-open-terminal"
                onClick={onOpenTerminal}
                className="rounded-full px-2 py-1 text-[12.6px] text-ink underline underline-offset-2"
              >
                Open terminal
                </button>
              )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="rounded-full px-2 py-1 text-[12.6px] text-ink-2"
            >
              Dismiss
            </button>
          </span>
        </motion.div>
      )}
    </AnimatePresence>
    </div>
  )
}

/** The copy, in one place. Each line names what is actually true — never an
 *  interjection, never "something went wrong". The banned list lives in
 *  BRAND.md and `scripts/lint-microcopy.sh`; it is not repeated here, because a
 *  third copy of it could only drift out of sync with the gate. */
const NOTICE_TITLE: Record<ComposerNotice['kind'], string> = {
  'tui-draft': 'The terminal has an unsent draft.',
  // Says what happened (it went) AND what could not be established (whose text
  // that is). Naming Claude's suggestion is the part that makes the line
  // actionable: on 2.1.232 that is what it usually is.
  'tui-draft-unverified':
    'Sent — the terminal’s prompt wasn’t empty, and this couldn’t be told from Claude’s own suggestion:',
  dialog: 'Claude is waiting on the request above — answer it first.',
  // The card the sentence above points at is NOT on screen for this one, so it
  // does not point at it. Naming the surface that can actually answer is the
  // whole of the honesty rule here.
  'dialog-terminal':
    'The terminal is showing a prompt chat can’t answer — answer it there.',
  // The one refusal that has to explain a mechanism, because the user's action
  // was reasonable: the dialog above offers a "Type something." row, so typing
  // an answer is what it invites. What chat can't do is TYPE — a send is a
  // paste, and a paste into an open dialog is dropped while the Enter behind it
  // picks the highlighted row.
  'dialog-question':
    'Pick one of the answers above — typed text would be pasted past that question, not into it.',
  // The card above is readable and not yet answerable, so this points at the
  // terminal — and says what a send would actually do, because "it wouldn't
  // work" is not the risk here. Typing into somebody else's form is.
  'dialog-form':
    'An MCP server’s form is open in the terminal — a message here would be typed into it.',
  'stop-dialog':
    'Escape would answer that prompt, not stop the turn — so it wasn’t sent.',
  // The terminal has ARMED the key Stop sends, and its own line (quoted as the
  // notice's detail) says what the second press would do instead. Naming the
  // consequence rather than the mechanism: "your unsent terminal draft" is the
  // thing at risk, and it is the reason a user cares.
  'stop-armed':
    'The terminal has Escape armed for something else right now — it wasn’t sent:',
  'send-failed': 'That message didn’t reach the session.',
  // Not "something went wrong": the turn is still running, and that is the fact
  // the user needs in order to decide what to do next.
  'stop-failed': 'The interrupt didn’t reach the session — the turn is still running.',
  // Not "unsupported": the command works fine, it just needs a surface with a
  // cursor on it. The Open-terminal control beside this line is the answer.
  'slash-picker': 'opens a picker in the terminal — it wasn’t sent.',
  // Not "unsupported" either: the command is real, chat just has no capture of
  // what it does to the pty, and the ones it can't rule out leave a widget open.
  'slash-unverified': 'is a terminal command chat can’t verify — it wasn’t sent.',
  // NOT "isn't a command": ~/.claude/commands and <dir>/.claude/commands are
  // full of real ones — `/commit`, `/supermux-task` — and this receipt used to
  // tell their authors the session had read them as prose. What chat can say
  // honestly is what chat DID: it typed the line into the session. If the
  // command exists there, Claude Code runs it; if it was a typo, the receipt is
  // still the thing that stops it becoming a silent message.
  'slash-note': 'isn’t one of Claude’s built-ins — it was typed into the session as-is.',
  // The receipt for the one action on this surface whose result is somewhere
  // else entirely. It names the recipient and it states the DELIVERY, which is
  // the whole of what this app knows: the prompt reached that session's pane.
  // It deliberately does not read as a completed hand-over — nothing here can
  // learn whether the colleague acted on it, so nothing here may imply it did.
  'handoff-sent': 'Sent to',
  // The draft is still in the box, and saying so is the point — the user's
  // instinct after a failed send is to check whether they lost the sentence.
  'handoff-failed': 'That hand-off didn’t go through — your message is still here.',
}

/** Send — an upward arrow, the one glyph every messenger agrees on. */
function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 14.6V3.6M4.4 8.2L9 3.6l4.6 4.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Attach — a paperclip. The one place a paperclip is the honest glyph: a
 *  direct desktop file-picker button (the mobile add-menu rule is paperclip-
 *  free, but there attach is a labelled ROW, not an icon).
 *
 *  OPTICALLY MATCHED TO ITS NEIGHBOURS (owner: first the paperclip read SMALLER,
 *  then the over-correction made it read LARGER — "visueel te groot tov de
 *  anderen"). The old glyph was a busy double-curl whose ink measured a size UP
 *  against the compact `@`/clock circles (~14.6×15.5 vs their ~13×13). This is the
 *  canonical single-loop paperclip — the inner wire runs straight and parallel to
 *  the outer, no curl — drawn on a 24-viewBox at 18px: its ink WIDTH lands 13.2px,
 *  level with `@` (13) and the clock (13.6) in the rig, stroke 2.0 (≈1.5px at 18px,
 *  the weight `@`'s 1.4 carries). The diagonal reads heavier per unit than a
 *  compact circle, so matching the WIDTH (not the taller diagonal bounding) is
 *  what makes the three read as one size. */
function PaperclipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 11l-9 9a6 6 0 01-8-8l9-9a4 4 0 016 6l-9 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Stop — a square, because it interrupts rather than cancels. */
function StopIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1.8" fill="currentColor" />
    </svg>
  )
}

export default ChatComposer
