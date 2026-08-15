/**
 * The Attention card — the surface that admits things (fase A4 T5).
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything A4 adds is allowed to be REFUSED, and every refusal lands here:
 * a send the watchdog gave up on, a dialog the registry has no verified mapping
 * for, a Claude Code version nobody checked the fingerprints against. The card
 * states the fact (`attention.ts` owns the words), shows the session's own
 * screen as evidence, and offers the one surface that can always do what chat
 * just declined to — the terminal.
 *
 * TWO STRUCTURAL DECISIONS, both load-bearing:
 *
 * 1. THE MINI-VIEW IS DOM, NEVER A SECOND TERMINAL. It renders the raw `/peek`
 *    capture through `lib/ansi`'s SGR parser into a `--terminal-fg`-on-
 *    `--terminal-bg` `pre` — the same path `provisional-tail.tsx` already uses.
 *    Mounting `LiveTerminal` here would open a second WS *and resize the pty* to
 *    this box's geometry, which is the one thing the chat renderer promises
 *    never to do (master plan §8, "two views fight over the pty"). A capture
 *    that cannot be rendered faithfully — empty string, session not running —
 *    degrades the card to MESSAGE ONLY rather than drawing an empty black box
 *    that looks like a dead session.
 *
 * 2. INLINE FIRST, EXPANDED ON REQUEST. The card enters the live layer as a
 *    compact row (title + "Show terminal"); the evidence and the actions live in
 *    an overlay you ask for. An unmissable modal on every watchdog blip trains
 *    the user to dismiss the next one unread, and the next one is the real one.
 *
 * WHERE THE OVERLAY LIVES: inside the chat surface root (`ChatSurface`'s
 * `overlay` slot), not in a portal. This surface is one pane of a split — the
 * refusal belongs to the session it happened in, not to the whole shell, and a
 * portal at `document.body` would cover the terminal it is telling you to open.
 * TODO §11.4: when the shell-scoped overlay layer lands (Track B), it adopts
 * this card and the slot below becomes its mount point.
 *
 * DEVIATION FROM THE PLAN, recorded where it happens: T5 specifies the mobile
 * presentation as the app's `ResponsiveSheet`. That component imports through
 * the `@/` alias, which the unit runner cannot resolve (the root `tsconfig.json`
 * carries no `paths` — see `chat-surface.tsx`'s import rules), and it portals to
 * `document.body`, which breaks the surface-scoping decision above. So the phone
 * presentation is the same overlay drawn as a bottom sheet — vaul's material,
 * detent and drag indicator, none of vaul's DOM. It is a sheet in every way the
 * boards can see.
 *
 * Import rules, inherited from `chat-surface.tsx`: relative paths only (this
 * module is rendered by `bun test`), and `components/chat/ui` is imported from
 * here, never the reverse.
 */
import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { parseAnsiLine } from '../../lib/ansi'
import { springs } from '../../lib/springs'
import { cn } from '../../lib/utils'

import { attentionCopy, type AttentionCause, type AttentionContext } from './attention'

/**
 * How much of the capture the card shows. The `/peek` window is 60 lines
 * (`use-peek-lens.ts`) and the last ~28 of them are what is on the screen right
 * now — the dialog with its body, or the composer with whatever is above it.
 * The box scrolls, so this is a starting view rather than a limit.
 */
const MINI_LINES = 28

/** The mini-view's own scroll box (master plan §4.4: "max-height 220px, own
 *  overflow"). The card must stay readable on a phone in landscape, and a
 *  60-line capture is taller than that on every surface. */
const MINI_MAX_H = 220

/* ── the inline row ──────────────────────────────────────────────────────── */

/**
 * The compact form: one line in the live layer that says what is wrong, and one
 * control that offers the evidence.
 *
 * It sits at the TOP of the live band because it is the one thing there that
 * may be about the band itself — a send that never arrived, a dialog the card
 * below it is refusing to answer.
 */
export function AttentionRow({
  cause,
  ctx,
  expanded,
  onExpand,
}: {
  cause: AttentionCause
  ctx?: AttentionContext
  /** The overlay is already open — the control is redundant, not gone. */
  expanded?: boolean
  onExpand?: () => void
}) {
  const copy = attentionCopy(cause, ctx)
  return (
    <div
      data-testid="chat-attention-row"
      data-cause={cause}
      className={cn(
        'ml-11 mt-3 flex max-w-[592px] flex-wrap items-center gap-x-3 gap-y-1',
        'rounded-[16px] border-[0.5px] border-hairline bg-surface px-[17px] py-2.5',
        'backdrop-blur-[30px] backdrop-saturate-[170%]',
      )}
    >
      {/* Calm orange — `--status-error`, the token the tiles already use for a
          session that needs a human. Never a red alert bar: this is the app
          being honest, not the app being broken. */}
      <span data-tone="warn" aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-error" />
      {/* `min-w-[190px]` is what keeps this a ROW and not a column of two-word
          lines: without a floor the flex-1 title shrinks to whatever the pill
          leaves it, and on a 390 px phone the version-mismatch sentence came out
          six lines tall in a ~150 px column (measured). With the floor, the pill
          wraps to its own line instead — `flex-wrap` on the parent was always
          the intended relief valve. */}
      <span className="min-w-[190px] flex-1 text-[13.4px] leading-[1.45] tracking-[-0.05px] text-ink">
        {copy.title}
      </span>
      {onExpand && (
        <button
          type="button"
          data-testid="chat-attention-show"
          aria-expanded={!!expanded}
          onClick={onExpand}
          className={cn(
            'inline-flex h-[34px] shrink-0 items-center rounded-full border-[0.5px] border-hairline px-[15px]',
            'text-[13.4px] font-medium tracking-[-0.05px] text-ink hover:bg-fill-soft',
          )}
        >
          Show terminal
        </button>
      )}
    </div>
  )
}

/* ── the expanded card ───────────────────────────────────────────────────── */

export interface AttentionCardProps {
  cause: AttentionCause
  ctx?: AttentionContext
  /** The RAW `/peek?ansi=1` capture, escapes intact (`usePeekLens().capture`).
   *  Empty or blank → the card degrades to message-only. */
  capture?: string
  /** Close the overlay and go back to the inline row. */
  onClose?: () => void
  /** Switch this pane to the terminal renderer. Always offered. */
  onOpenTerminal?: () => void
  /** Stop showing this cause at all — the user has read it. */
  onDismiss?: () => void
  surface?: 'desktop' | 'phone'
  /** Set by `AttentionOverlay` only. Its presence is what makes this card a
   *  real modal: focus moves into it on open, Tab is cycled inside it, and the
   *  focus that was there before is restored on close. The INLINE row renders
   *  the same component without it and is not modal at all. */
  cardRef?: React.RefObject<HTMLDivElement | null>
}

/**
 * Title, body, evidence, way out — in that order, because that is the order the
 * reader needs them in: what happened, why nothing was sent, what the session
 * itself is showing, and which button ends the situation.
 */
export function AttentionCard({
  cause,
  ctx,
  capture,
  onClose,
  onOpenTerminal,
  onDismiss,
  surface = 'desktop',
  cardRef,
}: AttentionCardProps) {
  const copy = attentionCopy(cause, ctx)
  const titleId = `attention-title-${cause}`
  return (
    <div
      ref={cardRef}
      // Focus lands HERE when the overlay opens, so the title is what gets read
      // first; `-1` because it is a target, not a tab stop (A4 review).
      tabIndex={cardRef ? -1 : undefined}
      data-testid="chat-attention-card"
      data-cause={cause}
      // `aria-modal` only when the overlay above is actually cycling Tab inside
      // this card — the inline row renders the same component with no trap, and
      // claiming a modality the DOM does not enforce is the same class of lie as
      // an option that says it will send a key and doesn't.
      role="dialog"
      aria-modal={cardRef ? true : undefined}
      aria-labelledby={titleId}
      className={cn(
        'flex max-h-full min-h-0 w-full flex-col gap-3 border-hairline bg-surface p-4',
        'shadow-[var(--sm-card-shadow)] backdrop-blur-[30px] backdrop-saturate-[170%]',
        surface === 'phone'
          ? 'rounded-t-[20px] border-t-[0.5px] pb-safe'
          : 'max-w-[560px] rounded-[18px] border-[0.5px]',
      )}
    >
      {surface === 'phone' && (
        /* The drag indicator the app's sheets all carry (36×5 on the glass).
           This one is a HANDLE THE EYE KNOWS, not a drag target: the sheet
           dismisses by its own controls and by the scrim. */
        <span aria-hidden className="mx-auto -mt-1 h-[5px] w-9 rounded-full bg-fill-soft-2" />
      )}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="text-[15px] font-medium leading-[1.35] tracking-[-0.15px] text-ink"
          >
            {copy.title}
          </h2>
          <p className="mt-[5px] text-[13.2px] leading-[1.5] text-ink-2">{copy.body}</p>
        </div>
        {onClose && (
          <button
            type="button"
            data-testid="chat-attention-close"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 -mt-1 grid size-11 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-fill-soft"
          >
            <CloseIcon />
          </button>
        )}
      </div>

      <AttentionMiniView capture={capture} />

      <div className="flex flex-wrap items-center gap-2">
        {onOpenTerminal && (
          /* 44pt, the plan's number and the app's floor for a control a thumb
             has to find on a phone — this is the button that ends the
             situation, so it is the biggest thing on the card. */
          <button
            type="button"
            data-testid="chat-attention-open-terminal"
            onClick={onOpenTerminal}
            className={cn(
              'inline-flex h-11 items-center rounded-full border-[0.5px] border-hairline bg-fill-soft-2 px-[17px]',
              'text-[13.4px] font-semibold tracking-[-0.05px] text-ink',
            )}
          >
            Open terminal
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            data-testid="chat-attention-dismiss"
            onClick={onDismiss}
            className="inline-flex h-11 items-center rounded-full px-3 text-[13.4px] tracking-[-0.05px] text-ink-2 hover:bg-fill-soft"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

/* ── the evidence ────────────────────────────────────────────────────────── */

/**
 * The session's own screen, read-only, in DOM.
 *
 * `parseAnsiLine` is the app's existing SGR subset (colour + weight, the xterm
 * 16/256/truecolour spaces); the capture keeps its own columns and the box
 * scrolls in both axes rather than reflowing, because a re-wrapped TUI frame is
 * a different frame. Nothing here is interactive: no cursor, no keys, no resize
 * — the pty is not told this box exists.
 *
 * A capture with no printable content renders NOTHING (message-only degrade).
 */
export function AttentionMiniView({ capture }: { capture?: string }) {
  const lines = React.useMemo(() => miniLines(capture), [capture])
  if (lines.length === 0) return null
  return (
    <pre
      data-testid="chat-attention-mini"
      // Read-only evidence, announced as a figure rather than as prose: a screen
      // reader walking a 28-line box-drawn TUI frame is not being helped.
      role="img"
      aria-label="The session’s terminal, as captured"
      style={{
        maxHeight: MINI_MAX_H,
        backgroundColor: 'var(--terminal-bg)',
        color: 'var(--terminal-fg)',
      }}
      className={cn(
        'overflow-auto rounded-[12px] border-[0.5px] border-hairline p-3',
        'whitespace-pre font-mono text-[11.8px] leading-[1.5] tracking-[-0.1px]',
      )}
    >
      {lines.map((line, i) => (
        <div key={i}>
          {parseAnsiLine(line).map((seg, j) => (
            <span key={j} style={seg.style}>
              {seg.text}
            </span>
          ))}
          {/* A blank captured row is still a row of the frame — without this the
              TUI's own spacing collapses and the box lies about the layout. */}
          {line === '' && ' '}
        </div>
      ))}
    </pre>
  )
}

/**
 * Capture → the lines worth drawing.
 *
 * Trailing blank rows are dropped (a `tmux capture-pane` of a 60-line window on
 * a half-full screen is mostly padding, and padding at the bottom of a scroll
 * box reads as "the session printed nothing"), then the LAST `MINI_LINES` are
 * kept — the bottom of a TUI screen is the live part.
 */
export function miniLines(capture?: string, max: number = MINI_LINES): string[] {
  if (!capture) return []
  const all = capture.replace(/\r\n?/g, '\n').split('\n')
  let end = all.length
  while (end > 0 && isBlank(all[end - 1])) end -= 1
  let start = 0
  while (start < end && isBlank(all[start])) start += 1
  if (start >= end) return []
  const kept = all.slice(start, end)
  return kept.length > max ? kept.slice(kept.length - max) : kept
}

/** Blank means "no printable glyph" — an ANSI-only line (a colour reset on its
 *  own row, which `tmux capture-pane -e` emits) is blank for this purpose. */
function isBlank(line: string): boolean {
  return parseAnsiLine(line).every((seg) => seg.text.trim() === '')
}

/* ── the presentation ────────────────────────────────────────────────────── */

/**
 * The expanded card, scoped to the chat surface root (`ChatSurface`'s `overlay`
 * slot). Desktop = a centred card over a scrim; phone = the same card as a
 * bottom sheet. The scrim is the pane's, not the window's: the roster, the
 * header and the other pane of a split stay live and clickable, because a
 * refusal in one session must not freeze the app.
 */
export function AttentionOverlay({
  open,
  surface = 'desktop',
  onClose,
  ...card
}: AttentionCardProps & { open: boolean }) {
  const reduce = useReducedMotion() ?? false
  const phone = surface === 'phone'

  const surfaceRef = React.useRef<HTMLDivElement | null>(null)

  // Escape closes the card, and the keystroke goes NO FURTHER. Without this the
  // composer's own Escape wins (`use-composer.ts`: clear the draft, else
  // `sendKey('Escape')` — an interrupt into the pty), which is the wrong meaning
  // by a wide margin: a user reaching for Escape with a card over the pane is
  // reaching for the card, not for the session behind it. Capture-phase on
  // `document` runs before React's root delegation, so the key is SPENT here
  // rather than handled twice — the same "one Escape, one meaning" rule the
  // composer states for itself.
  //
  // BUT NOT FOR LAYERS ABOVE THIS ONE (A4 review). A document-wide capture that
  // swallowed every Escape closed the card UNDERNEATH the command palette while
  // leaving the palette open, and left every other portalled layer (the snippet
  // sheet, a dialog in the other pane of a split) with no keyboard exit for as
  // long as this card was up. So the key is taken only when it is not addressed
  // to some other open layer: a target inside a dialog/menu/listbox that is not
  // this overlay belongs to that thing.
  React.useEffect(() => {
    if (!open || !onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target instanceof Element ? e.target : null
      const root = surfaceRef.current
      if (
        target &&
        !(root && root.contains(target)) &&
        target.closest(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]',
        )
      ) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // FOCUS FOLLOWS THE CARD, and comes back when it leaves (A4 review). The card
  // announces itself as a dialog and covers the pane with a scrim; without this
  // a keyboard user's focus stayed on the row button now hidden behind that
  // scrim, the next Tab walked into the composer and the transcript's links —
  // all invisible, all still activatable — and a screen reader was never told
  // anything had opened. Focus is moved to the card itself (not to a control:
  // the title is what should be read first), and Tab is cycled inside it.
  const cardRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!open) return
    const restore = document.activeElement
    cardRef.current?.focus()
    return () => {
      if (restore instanceof HTMLElement && document.contains(restore)) restore.focus()
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const root = cardRef.current
      if (!root) return
      const stops = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), a[href], [tabindex]:not([tabindex="-1"])',
      )
      // Nothing focusable inside (message-only degrade): keep the key here
      // rather than letting it walk into the pane the scrim is covering.
      if (stops.length === 0) return e.preventDefault()
      const first = stops[0]
      const last = stops[stops.length - 1]
      const active = document.activeElement
      if (!root.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onTab, true)
    return () => document.removeEventListener('keydown', onTab, true)
  }, [open])

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          ref={surfaceRef}
          data-testid="chat-attention-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? { duration: 0 } : springs.cardExpand}
          className={cn(
            'absolute inset-0 z-[6] flex justify-center',
            phone ? 'items-end' : 'items-center p-6',
          )}
        >
          {/* The scrim closes it — the gesture every sheet in this app answers
              to. It is DECORATIVE to assistive tech: a full-pane second control
              called "Close" would be announced beside the real one and reachable
              by neither Tab nor a screen reader's button list. The keyboard's
              exits are the ✕, Dismiss and Escape, all above. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={onClose}
            // Lighter than the app's modal scrim (`bg-black/60`, sheet.tsx) on
            // purpose: this one dims ONE pane, and the surface behind it is the
            // evidence the card is talking about.
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          />
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: phone ? 24 : 10, scale: phone ? 1 : 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: phone ? 24 : 6, scale: phone ? 1 : 0.99 }}
            transition={reduce ? { duration: 0 } : phone ? springs.sheetDetent : springs.cardExpand}
            className={cn('relative z-[1] flex max-h-full min-h-0', phone ? 'w-full' : 'w-full max-w-[560px]')}
          >
            <AttentionCard {...card} surface={surface} onClose={onClose} cardRef={cardRef} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default AttentionCard
