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
import type { ReactNode } from 'react'

import { cn } from '../../../lib/utils'

export interface ChoiceOption {
  label: string
  /** The emphasised default (weight 600 + soft fill). At most one. */
  primary?: boolean
  /** The digit the modal registry maps this option to. */
  kbd?: string
}

export interface ChoiceCardProps {
  /** The ask. Pass `<InlineCode>` inside it for the command. */
  question: ReactNode
  /** Where it runs and what it reaches — the line the decision turns on. */
  why?: ReactNode
  options: readonly ChoiceOption[]
  /** Keyboard cursor. `undefined` = nothing selected yet. */
  selectedIndex?: number
  onChoose?: (index: number) => void
  className?: string
}

export function ChoiceCard({
  question,
  why,
  options,
  selectedIndex,
  onChoose,
  className,
}: ChoiceCardProps) {
  return (
    <div
      role="group"
      className={cn(
        'ml-11 mt-3 max-w-[592px] rounded-[16px] px-[17px] py-3.5',
        'border-[0.5px] border-hairline bg-surface backdrop-blur-[30px] backdrop-saturate-[170%]',
        'shadow-[var(--sm-card-shadow)]',
        className,
      )}
    >
      <div className="text-[15px] font-medium leading-[1.4] tracking-[-0.15px] text-ink">
        {question}
      </div>
      {why && <div className="mt-[5px] text-[13.2px] leading-[1.45] text-ink-2">{why}</div>}
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
      onClick={onClick}
      data-selected={selected || undefined}
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
        'text-[13.4px] tracking-[-0.05px] text-ink transition-colors duration-200',
        option.primary ? 'bg-fill-soft-2 font-semibold' : 'bg-transparent font-medium hover:bg-fill-soft',
      )}
    >
      {option.label}
      {option.kbd && (
        <kbd className="ml-0.5 font-sans text-[11px] font-medium tabular-nums text-ink-3">
          {option.kbd}
        </kbd>
      )}
    </button>
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
