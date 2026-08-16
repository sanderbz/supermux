/**
 * The system line — the transcript as a management log.
 * ─────────────────────────────────────────────────────────────────────────────
 * A centred one-liner: `Renamed to ●deploy-fix` · `Created schedule · Nightly
 * release watch` · `Context compacted` · `Mode → accept edits`. The approved
 * boards draw it as 13px secondary ink, centred, 22px of air above and below,
 * tracking −0.05px, with the entity in weight 500.
 *
 * The entity is a NAVIGATION affordance, not decoration (master plan §13.1), so
 * it uses the chip mechanic: `margin: -1px -5px -1px -3px` cancelled by
 * `padding: 1px 5px 1px 3px`, which means the hover pill costs exactly zero
 * layout — the sentence does not shift when a chip becomes interactive. Hover is
 * the 120ms speed (§11.11).
 *
 * `<MentionChip>` is the same mechanic in prose, where the entity is another
 * session: its mark plus its name in ITS pigment. Never a filled tag — a filled
 * tag would put a session's colour on a surface, and the accent belongs to
 * identity, not to backgrounds (concept contract C7).
 */
import type { ReactNode } from 'react'

import { SessionMark, type MarkPin } from '../../../brand/marks'
import { cn } from '../../../lib/utils'

import { ACCENT_INK_CLASS, accentInkVarsForSeed } from './accent-ink'
import { MARK_SIZE } from './metrics'

export interface SystemLineProps {
  children: ReactNode
  className?: string
  /** For the lines a test or a screenshot rig has to find by name — today the
   *  start-of-conversation marker (daily-driver QA #3). */
  testId?: string
}

export function SystemLine({ children, className, testId }: SystemLineProps) {
  return (
    <div
      role="note"
      data-testid={testId}
      className={cn(
        'my-[22px] text-center text-[13px] tracking-[-0.05px] text-ink-2',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** The ` · ` the approved boards put between a system verb and its entity. */
export function SystemSep() {
  return <span aria-hidden> · </span>
}

export interface SystemEntityProps {
  children: ReactNode
  /** Wired by a later slice; omit and the entity renders as plain emphasis. */
  onClick?: () => void
  className?: string
}

/**
 * The named thing in a system line — a schedule, a board issue, a PR. Weight
 * 500, and when it can be navigated to, a zero-layout-cost hover pill.
 */
export function SystemEntity({ children, onClick, className }: SystemEntityProps) {
  const shared = 'font-medium text-ink-2'
  if (!onClick) return <b className={cn(shared, className)}>{children}</b>
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        shared,
        // Negative margins cancel the padding: the pill costs zero layout.
        'my-[-1px] ml-[-3px] mr-[-5px] inline-flex items-center rounded-md py-px pl-[3px] pr-[5px]',
        'sm-t-hover hover:bg-fill-soft hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  )
}

export interface MentionChipProps {
  /** The session this chip names. Its face and its pigment come from the seed. */
  seed: string
  pin?: MarkPin
  /** Display name, when it differs from the seed. */
  name?: string
  size?: number
  /** Omit and the chip is a `<span>`: same pixels, no affordance (fase B4 T3). */
  onClick?: () => void
  className?: string
}

/**
 * The chip's own geometry, shared by both variants.
 *
 * ZERO LAYOUT COST is the whole mechanic (§14): the negative margins exactly
 * cancel the padding, so the hover pill occupies no space and a sentence does
 * not reflow when a chip gains a destination. That only holds if the
 * interactive and non-interactive variants carry the SAME pair — hence one
 * constant, and `chat-chip-navigation.test.tsx` asserting the two renders match.
 */
const CHIP_BOX =
  'inline-flex items-center gap-[5px] align-[-3px] font-medium tracking-[-0.1px] whitespace-nowrap' +
  ' my-[-1px] ml-[-3px] mr-[-5px] rounded-md py-px pl-[3px] pr-[5px]'

/**
 * A colleague, named in prose or in a system line.
 *
 * A CHIP WITH NO DESTINATION IS NOT A BUTTON (fase B4 T3.1). Before B4 this
 * always rendered a `<button>`, which promised a click that did nothing and
 * put a tab stop on every mention in a long transcript. Now the affordance
 * follows the capability: `onClick` present → a real button with the 120 ms
 * hover pill; absent → a `<span>` with identical metrics and no hover, which is
 * what a bench render, a static test render, and a surface that has nowhere to
 * navigate to all get.
 */
export function MentionChip({ seed, pin, name, size = MARK_SIZE.chip, onClick, className }: MentionChipProps) {
  const label = name ?? seed
  const inner = (
    <>
      <SessionMark seed={seed} pin={pin} size={size} animate={false} label={null} />
      {label}
    </>
  )
  const style = accentInkVarsForSeed(seed, pin)
  if (!onClick) {
    return (
      <span style={style} className={cn(ACCENT_INK_CLASS, CHIP_BOX, className)}>
        {inner}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      className={cn(
        ACCENT_INK_CLASS,
        CHIP_BOX,
        'sm-t-hover hover:bg-fill-soft',
        className,
      )}
    >
      {inner}
    </button>
  )
}
