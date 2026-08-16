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
}

export function SystemLine({ children, className }: SystemLineProps) {
  return (
    <div
      role="note"
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
        'transition-[background-color,color] duration-[120ms] hover:bg-fill-soft hover:text-ink',
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
  onClick?: () => void
  className?: string
}

export function MentionChip({ seed, pin, name, size = MARK_SIZE.chip, onClick, className }: MentionChipProps) {
  const label = name ?? seed
  return (
    <button
      type="button"
      onClick={onClick}
      style={accentInkVarsForSeed(seed, pin)}
      className={cn(
        ACCENT_INK_CLASS,
        'inline-flex items-center gap-[5px] align-[-3px] font-medium tracking-[-0.1px] whitespace-nowrap',
        'my-[-1px] ml-[-3px] mr-[-5px] rounded-md py-px pl-[3px] pr-[5px]',
        'transition-[background-color] duration-[120ms] hover:bg-fill-soft',
        className,
      )}
    >
      <SessionMark seed={seed} pin={pin} size={size} animate={false} label={null} />
      {label}
    </button>
  )
}
