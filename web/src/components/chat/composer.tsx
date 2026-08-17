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

import { ComposerFrame } from './composer-shell'
import type { EntityPickerProps } from './entity-picker'
import { pickerOptionId, PICKER_LISTBOX_ID, type EntityPickerData } from './slash'
import type { ComposerHandle, ComposerNotice } from './use-composer'
import { DRAFT_PREVIEW_CHARS } from './use-composer'
import { Composer, MicIcon, PlusIcon } from './ui'

/** The `@`/`/` popover (fase A4 T9), lazily — it is reached only when somebody
 *  types a trigger, so its list, its filter and its two queries stay out of the
 *  chunk the surface pays for on open (T12's budget rule). */
const EntityPicker = React.lazy(() => import('./entity-picker'))

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
  className,
}: ChatComposerProps) {
  const phone = surface === 'phone'
  const reduce = useReducedMotion() ?? false
  // A draft arms Send. While the POST is in flight the button STAYS (disabled)
  // rather than flipping back to the mic: a control that vanishes mid-tap reads
  // as a bug, and the disabled state is the honest "asked, not yet answered".
  const canSend = handle.draft.trim().length > 0
  // WHICH ROW THE POPOVER IS ON (A4 review). The list lives in the picker, but
  // the only element that ever has focus is the textarea — so the textarea is
  // what has to carry `aria-activedescendant`, and the highlight travels up
  // here to be written onto it. −1 = the list has nothing to point at.
  const [activeOption, setActiveOption] = React.useState(-1)
  const pickerOpen = handle.picker.open
  const pickerProps: EntityPickerProps = {
    name,
    kind: handle.picker.kind,
    query: handle.picker.query,
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
    onPick: (row) => handle.picker.pick(row.value ?? ''),
    bind: handle.picker.bind,
    onActive: setActiveOption,
  }

  return (
    <ComposerFrame surface={surface} stat={stat} className={className}>
      <ComposerBanner
        notice={handle.notice}
        onOpenTerminal={onOpenTerminal}
        onDismiss={handle.dismissNotice}
        reduce={reduce}
      />
      {handle.picker.open &&
        (renderPicker ? (
          renderPicker(pickerProps)
        ) : (
          // No fallback: a spinner for a popover that opens in one frame from a
          // 30s-cached list would be the only thing anyone ever saw of it.
          <React.Suspense fallback={null}>
            <EntityPicker {...pickerProps} />
          </React.Suspense>
        ))}
      <Composer
        size={phone ? 'mobile' : 'desktop'}
        placeholder={`Message ${label}`}
        leading={
          <>
          <button
            type="button"
            data-testid="chat-composer-at"
            aria-label="Mention a file or a session"
            // The boards' `+` was decoration; this is the same 26px cell doing
            // what the boards' caption always said it did (attach / @files /
            // /commands). It types the trigger rather than opening a menu of its
            // own, so there is exactly ONE picker on this surface and the caret
            // ends up where the user would have put it themselves.
            onClick={() => handle.insert('@')}
            className="grid size-[26px] flex-none place-items-center rounded-full text-ink-2"
          >
            <PlusIcon />
          </button>
          {onSchedule && (
            <button
              type="button"
              data-testid="chat-composer-schedule"
              aria-label="Schedule this instead of sending now"
              title="Schedule this instead of sending now"
              // The draft is COPIED, not moved (T9.2): the sheet gets a prompt
              // to start from and the composer keeps every character, so
              // cancelling leaves the box exactly as it was.
              onClick={() => onSchedule(handle.draft)}
              className="grid size-[26px] flex-none place-items-center rounded-full text-ink-2"
            >
              <ClockIcon />
            </button>
          )}
          </>
        }
        field={{
          ref: handle.ref,
          value: handle.draft,
          onChange: handle.onChange,
          onKeyDown: handle.onKeyDown,
          onSelect: handle.onSelect,
          // The composer is a message box, not a code editor: the browser's own
          // spellcheck is the right default, and autocapitalise/autocorrect are
          // what a phone keyboard expects from one.
          spellCheck: true,
          enterKeyHint: 'send',
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
                key={canSend ? 'send' : active ? 'stop' : 'idle'}
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
                {canSend ? (
                  <TrailingButton
                    // THE CONTROL SAYS WHERE THE WORDS ARE GOING (fase B4
                    // T4.4). While the draft reads as a hand-off, Enter goes to
                    // a COLLEAGUE rather than to this session — so the label
                    // changes before the key is pressed, not after. Same
                    // element, same cell, no swap: only the sentence differs.
                    testId="chat-send"
                    label={
                      handle.handoff
                        ? `Hand to ${handle.handoff.label}`
                        : `Send to ${label}`
                    }
                    data-handoff={handle.handoff ? handle.handoff.to : undefined}
                    phone={phone}
                    onClick={handle.submit}
                    disabled={handle.sending}
                  >
                    {/* THE GLYPH CHANGES TOO, not just the label (fase B4
                        T4.4). An `aria-label` alone is not "visible before the
                        key is pressed" for a sighted user — so while the intent
                        holds the arrow becomes the RECIPIENT'S FACE, which is
                        this app's word for "this is going to them" everywhere
                        else. Same cell, same size, no reflow. */}
                    {handle.handoff ? (
                      <SessionMark
                        seed={handle.handoff.to}
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
                    onClick={handle.stop}
                  >
                    <StopIcon />
                  </TrailingButton>
                ) : (
                  /* At rest the boards' mic keeps its cell. It is decoration
                     until dictation lands — so it is `aria-hidden` and not a
                     button, exactly as B0 draws it. */
                  <span
                    aria-hidden
                    className={cn(
                      'sm-mic grid place-items-center rounded-full',
                      phone ? 'size-9' : 'size-10',
                    )}
                  >
                    <MicIcon />
                  </span>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        }
      />
    </ComposerFrame>
  )
}

/** The one inverted control, as a real button. Same disc as `.sm-mic` (the
 *  boards' trailing cell) — the DISC is B0's 36/40px and is not resized here,
 *  so the phone's hit area comes from a 4px `::after` inset instead: 36 + 8 =
 *  44pt of tappable target inside an unchanged pill. */
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
        // presses this button and nothing else — it is inside the pill.
        phone && 'after:absolute after:-inset-1 after:content-[""]',
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
              screen it is about is on the other renderer. */}
          {notice.kind === 'dialog-terminal' && notice.detail && (
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
          {/* The recipient reads as a name, in the sentence, after "Handed to".
              Not a chip: this banner is transient chrome and a face here would
              compete with the durable `Delegated to ●x` line the ledger writes
              into the transcript a moment later. */}
          {notice.kind === 'handoff-sent' && notice.detail && (
            <span className="min-w-0 truncate font-medium text-ink">{notice.detail}</span>
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
  'stop-dialog':
    'Escape would answer that prompt, not stop the turn — so it wasn’t sent.',
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
  'slash-note': 'isn’t a built-in command — the session got it as text.',
  // The receipt for the one action on this surface whose result is somewhere
  // else entirely. It names the recipient and it says "handed", not "sent":
  // what landed is a request in a colleague's context, not a message here.
  'handoff-sent': 'Handed to',
  // The draft is still in the box, and saying so is the point — the user's
  // instinct after a failed send is to check whether they lost the sentence.
  'handoff-failed': 'That hand-off didn’t go through — your message is still here.',
}

/** Schedule — a clock face, matching the `⏱` the transcript's schedule lines
 *  and the scheduler's own chips carry. Monochrome `currentColor` like every
 *  other glyph on this surface; the emoji taxonomy is terminal/tile-only. */
function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="6.4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M9 5.6V9l2.4 1.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
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

/** Stop — a square, because it interrupts rather than cancels. */
function StopIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1.8" fill="currentColor" />
    </svg>
  )
}

export default ChatComposer
