/**
 * P5 — the choice card: anything the TUI shows as a numbered list.
 * ─────────────────────────────────────────────────────────────────────────────
 * Permission prompts and plan approvals stop being a terminal dialog and become
 * the one thing on screen that is asking. The approved boards:
 *
 *   card      margin-left 44 (the bubble's left edge), max-width 592, radius 16,
 *             `--sm-surface` + 0.5px hairline + blur(30px) saturate(170%),
 *             padding 14/17, `--sm-card-shadow`
 *   question  15px/500, tracking −0.15px, line-height 1.4; inline `code` in
 *             JetBrainsMono 13.2px on `--sm-fill-soft`, radius 8, padding 2/7
 *   why       13.2px secondary, 5px under the question — WHERE it runs and WHAT
 *             it touches, because that is what the decision actually turns on
 *   actions   hairline pills, height 34, padding 0 15, 13.4px/500, 8px apart,
 *             13px under the why
 *
 * ONE BUTTON GRAMMAR: emphasis is weight plus a soft fill (`btn.primary`), never
 * the identity hue. The accent must not encode an action — it is who is
 * speaking, not what will happen (concept contract C7).
 *
 * Keyboard: the digits are bound 1:1 to the modal registry's option mapping
 * (master plan §4.3), so the kbd hint is part of the design, not a nicety. The
 * selected state uses P5's numbers — accent border 55%, accent fill 8% — which
 * is the one place a *selection* may borrow the accent, because selection is
 * identity-adjacent ("this session's pending question") and never an outcome.
 *
 * VISUAL ONLY: `onChoose` is called with the option index; nothing here sends a
 * key, checks a caret or dismisses a dialog.
 */
import { useId, type ReactNode } from 'react'

import { cn } from '../../../lib/utils'

export interface ChoiceOption {
  label: string
  /** The emphasised default (weight 600 + soft fill). At most one. */
  primary?: boolean
  /** The digit the modal registry maps this option to. */
  kbd?: string
  /**
   * Rendered, readable, INERT (fase A4 T7).
   *
   * The registry ships options this app will not press — Bash's "always allow"
   * (what it persists was never found on disk), anything on a Claude Code build
   * the fingerprints were not captured against — and hiding them would leave the
   * user reading a question with a missing answer. So the option is drawn at
   * reduced emphasis with the reason on it, and the button is genuinely
   * `disabled`: the refusal has to survive a restyle, not depend on one.
   *
   * Nothing else about the card changes when this is unset, which is why every
   * existing call site (and `/dev/chat-ui`) renders byte-identically.
   */
  disabled?: boolean
  /** Why it is inert, or what the grant actually covers — the control's own
   *  tooltip, so the sentence is where the finger is. */
  hint?: string
}

export interface ChoiceCardProps {
  /**
   * A small label ABOVE the ask — the dialog's own name for the decision.
   *
   * Added for AskUserQuestion, which draws one on a reverse-video line of its
   * own (` ☐ Fruit choice `) and is the only source of a two-word summary the
   * card, the roster and the phone push can all share. Absent everywhere else,
   * and the card renders byte-identically without it.
   */
  eyebrow?: ReactNode
  /** The ask. Pass `<InlineCode>` inside it for the command. */
  question: ReactNode
  /**
   * The thing itself, verbatim — the command, the file, the diff (QA #11).
   *
   * The question is a SENTENCE and therefore a paraphrase; this is the evidence
   * under it. A `<CardCode>` block, scrollable in both directions inside its own
   * box so a 200-column command cannot widen the card and a 40-line diff cannot
   * push the buttons off the screen.
   */
  detail?: ReactNode
  /** Where it runs and what it reaches — the line the decision turns on. */
  why?: ReactNode
  options: readonly ChoiceOption[]
  /** Keyboard cursor. `undefined` = nothing selected yet. */
  selectedIndex?: number
  onChoose?: (index: number) => void
  className?: string
}

export function ChoiceCard({
  eyebrow,
  question,
  detail,
  why,
  options,
  selectedIndex,
  onChoose,
  className,
}: ChoiceCardProps) {
  return (
    <DialogShell eyebrow={eyebrow} question={question} detail={detail} why={why} className={className}>
      <div className="mt-[13px] flex flex-wrap gap-2">
        {options.map((option, i) => (
          <ChoiceButton
            key={option.label}
            option={option}
            selected={selectedIndex === i}
            onClick={onChoose ? () => onChoose(i) : undefined}
          />
        ))}
      </div>
    </DialogShell>
  )
}

/**
 * THE CARD CHROME, once (fase B6).
 *
 * Everything above the answers — the glass panel, the eyebrow, the ask, the
 * evidence block, the why line — is identical for every dialog this surface can
 * draw, and it was written for the permission/question card first. The MCP
 * elicitation FORM is the second thing that needs it, and a form card that
 * forked these numbers would drift from the question card the first time either
 * moved 1px. So the shell is the shared thing and the answers are the variable
 * part: `ChoiceCard` fills it with option pills, `FormCard` with controls.
 *
 * `ChoiceCard` renders byte-identically to before the extraction — same
 * classes, same order, same `role="group"` pointing at the same generated id.
 */
export function DialogShell({
  eyebrow,
  question,
  detail,
  why,
  className,
  children,
}: {
  eyebrow?: ReactNode
  question: ReactNode
  detail?: ReactNode
  why?: ReactNode
  className?: string
  /** The answers: pills, controls, whatever this dialog is answered with. */
  children: ReactNode
}) {
  // A `role="group"` with no accessible name is a group of nothing (gap G4):
  // AT announced "group, 3 buttons" and the ask itself — the only sentence that
  // makes the buttons mean anything — was just loose text above it. The
  // question IS the name, so it is pointed at rather than duplicated into an
  // `aria-label` that could drift from the visible words.
  const qid = useId()
  return (
    <div
      role="group"
      aria-labelledby={qid}
      className={cn(
        'ml-11 mt-3 max-w-[592px] rounded-[16px] px-[17px] py-3.5',
        'border-[0.5px] border-hairline bg-surface backdrop-blur-[30px] backdrop-saturate-[170%]',
        'shadow-[var(--sm-card-shadow)]',
        className,
      )}
    >
      {eyebrow && (
        <div
          data-testid="chat-dialog-eyebrow"
          className="mb-[3px] text-[11.5px] font-medium uppercase leading-[1.3] tracking-[0.5px] text-ink-3"
        >
          {eyebrow}
        </div>
      )}
      <div id={qid} className="text-[15px] font-medium leading-[1.4] tracking-[-0.15px] text-ink">
        {question}
      </div>
      {detail}
      {why && <div className="mt-[5px] text-[13.2px] leading-[1.45] text-ink-2">{why}</div>}
      {children}
    </div>
  )
}

function ChoiceButton({
  option,
  selected,
  onClick,
}: {
  option: ChoiceOption
  selected: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={option.disabled ? undefined : onClick}
      disabled={option.disabled}
      // THE KEYBOARD CURSOR, IN ARIA (gap G4). It used to be `data-selected`
      // plus an accent border and nothing else, so the one thing telling a user
      // which answer they were on was a colour. `aria-current` rather than
      // `aria-pressed`/`aria-checked`: nothing is pressed or checked yet — this
      // is a cursor over answers, the same thing `RosterRow` uses it for.
      aria-current={selected || undefined}
      data-selected={selected || undefined}
      data-disabled={option.disabled || undefined}
      style={
        selected
          ? {
              borderColor: 'color-mix(in oklab, var(--sm-accent) 55%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--sm-accent) 8%, transparent)',
            }
          : undefined
      }
      className={cn(
        'inline-flex h-[34px] items-center gap-2 rounded-full border-[0.5px] border-hairline px-[15px]',
        'text-[13.4px] tracking-[-0.05px] text-ink sm-t-morph',
        option.primary ? 'bg-fill-soft-2 font-semibold' : 'bg-transparent font-medium hover:bg-fill-soft',
        // Readable, obviously not pressable, and no hover promise.
        option.disabled && 'cursor-default opacity-45 hover:bg-transparent',
      )}
    >
      {option.label}
      {/* WHY IT IS INERT, REACHABLE (gap G4). It was a `title=`, which is a
          mouse tooltip: never spoken by a keyboard user, never surfaced on a
          phone, and hung on a control that — being genuinely `disabled` — is
          not even a tab stop. As text inside the button it is part of the
          button's accessible name, so a virtual cursor reads the refusal with
          the option it belongs to. Disabled controls stay in the a11y tree;
          they are only removed from the TAB order, which is the whole reason
          the tooltip was unreachable and this is not. */}
      {option.hint && <span className="sr-only"> — {option.hint}</span>}
      {option.kbd && (
        <kbd className="ml-0.5 font-sans text-[11px] font-medium tabular-nums text-ink-3">
          {option.kbd}
        </kbd>
      )}
    </button>
  )
}

/**
 * The card's evidence row: what the pty is showing, verbatim (QA #11).
 *
 * A `<pre>` in its own scroll box, and both axes are deliberate:
 *   · X — a shell command is arbitrarily wide and MUST NOT wrap here. This is
 *     the one block on the surface where a soft break could change what a reader
 *     believes they are approving (`… && rm -rf /tmp/x` reading as two lines),
 *     and unlike a transcript fence (QA #18) it comes with a decision attached.
 *     So it scrolls, and the fade below says there is more.
 *   · Y — a 40-line diff would push the buttons off a 390px screen. 132px is
 *     about seven lines, which holds every capture the fixtures carry whole.
 *
 * The fade is a static overlay rather than a measured hint: it costs nothing,
 * it is honest at rest (a short command's fade sits over blank card), and the
 * alternative is a ResizeObserver inside a primitive.
 */
export function CardCode({
  children,
  label = 'Details',
  wrap,
}: {
  children: ReactNode
  label?: string
  /**
   * The body is PROSE, not a command — soft-wrap it (states audit).
   *
   * The no-wrap rule above is about commands, and it stays the default. But the
   * paused/consent card's body is Claude Code's own sentence, hard-wrapped at 80
   * columns, and this is the one card the build deliberately refuses to act on —
   * its verbatim body is its entire evidence base. At 390px the fixed columns cut
   * "Continue with Fable 5 on usage credits, or switch models for the rest of
   * this session." down to "Continue with Fable 5 on usage credits, / session." —
   * a complete-looking sentence that hides the second option's existence. A
   * clipped sentence that still reads as finished is worse than a wrapped one.
   */
  wrap?: boolean
}) {
  return (
    <div className="relative mt-[9px]">
      <pre
        data-testid="chat-dialog-body"
        // A NAMED TAB STOP (gap G5). `tabIndex={0}` is required — a scroll box
        // a mouse can pan must be pannable by a keyboard too — but a `<pre>`
        // has no implicit role, so the stop announced as nothing at all: a
        // keyboard user landed somewhere silent between the question and the
        // answers. `region` because it is a NAMED SCROLL BOX — the one role for
        // which "focusable but not interactive" is the documented shape (see
        // `eslint.config.js`'s `no-noninteractive-tabindex` allowlist).
        role="region"
        aria-label={label}
        tabIndex={0}
        data-wrap={wrap ? 'prose' : undefined}
        className={cn(
          'max-h-[132px] overflow-auto overscroll-contain rounded-[10px] border-[0.5px] border-hairline-soft bg-code-bg px-[11px] py-2 font-mono text-[12.4px] leading-[1.55] tracking-[-0.1px] text-ink',
          wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
        )}
      >
        {children}
      </pre>
      {/* The horizontal-scroll hint, and only where there is one to give: a
          wrapped body never scrolls sideways, so the fade would sit over the
          last characters of every line for nothing. */}
      {!wrap && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-px right-px w-6 rounded-r-[10px] bg-gradient-to-l from-code-bg to-transparent"
        />
      )}
    </div>
  )
}

/** The command inside a question — JetBrainsMono on the soft wash. */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="mx-px rounded-[8px] bg-fill-soft px-[7px] py-0.5 font-mono text-[13.2px] font-normal tracking-[-0.2px]">
      {children}
    </code>
  )
}
