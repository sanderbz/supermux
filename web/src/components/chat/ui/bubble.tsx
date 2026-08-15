/**
 * P1 / P2 — the two bubbles, and the row that positions them.
 * ─────────────────────────────────────────────────────────────────────────────
 * Numbers are the approved mockup's `.msg` / `.bubble`:
 *
 *   row      flex, gap 12, items-start, margin-top 14 (8 when grouped)
 *   gutter   32px wide, centred, padding-top 3 — holds the 28px session mark
 *   bubble   radius 18, padding 11/17, 15px/1.45, tracking −0.1px,
 *            0.5px hairline-soft edge, `--sm-bubble-shadow`
 *   agent    `--sm-bubble-agent` (a FIXED warm neutral — never accent-tinted:
 *            the accent is identity, and identity is carried by the mark),
 *            max-width 648
 *   user     inverted (`--sm-bubble-user` + its ink), no edge, no shadow,
 *            right-aligned, max-width 420 — a human sentence never spans the
 *            column
 *
 * Deliberately NOT here: markdown. Master plan §4.2 P2 gives the chat surface
 * its own `variant="chat"` component map, which is a later slice; this primitive
 * takes `children` so the renderer can hand it whatever it has.
 */
import type { ReactNode } from 'react'

import { cn } from '../../../lib/utils'

import { BUBBLE_MAX } from './metrics'

export interface MessageRowProps {
  children: ReactNode
  /** Right-aligned, gutterless — the human's side. */
  me?: boolean
  /**
   * Part of the same speaker's run: 8px instead of 14px of air, and no repeated
   * mark. Consecutive bubbles stack (§4.2 P2).
   */
  grouped?: boolean
  /** The gutter's content — a 28px `<SessionMark>`. Omitted while grouped. */
  gutter?: ReactNode
  className?: string
}

/**
 * The transcript's one row grammar: gutter + content. Every primitive that sits
 * in the column (bubbles, receipt groups, working rows, captured frames) goes
 * through it, which is what keeps their left edges on one line.
 */
export function MessageRow({ children, me, grouped, gutter, className }: MessageRowProps) {
  return (
    <div
      data-grouped={grouped || undefined}
      data-me={me || undefined}
      className={cn(
        'flex items-start gap-3',
        grouped ? 'mt-2' : 'mt-3.5',
        me && 'justify-end',
        className,
      )}
    >
      {!me && (
        <div className="flex w-8 flex-none justify-center pt-[3px]">{gutter}</div>
      )}
      {children}
    </div>
  )
}

export interface BubbleProps {
  children: ReactNode
  /** `assistant` (default) or `user` — the two P1/P2 reads. */
  variant?: 'assistant' | 'user'
  /** Wider inner padding, for a bubble whose content is a list (receipts). */
  padding?: 'text' | 'list'
  /**
   * Which ceiling applies. The phone is not a narrower desktop: `mobile-*.png`
   * pins its own two maxima (266 / 250) so a bubble still leaves the gutter and
   * the reply-side asymmetry visible on a 390pt screen.
   */
  surface?: 'desktop' | 'phone'
  className?: string
}

export function Bubble({
  children,
  variant = 'assistant',
  padding = 'text',
  surface = 'desktop',
  className,
}: BubbleProps) {
  const user = variant === 'user'
  const phone = surface === 'phone'
  return (
    <div
      data-variant={variant}
      style={{
        maxWidth: phone
          ? user
            ? BUBBLE_MAX.phoneUser
            : BUBBLE_MAX.phoneAssistant
          : user
            ? BUBBLE_MAX.user
            : BUBBLE_MAX.assistant,
      }}
      className={cn(
        'rounded-[18px] text-[15px] leading-[1.45] tracking-[-0.1px]',
        padding === 'list' ? 'px-[18px] py-3.5' : 'px-[17px] py-[11px]',
        user
          ? 'border-[0.5px] border-transparent bg-bubble-user text-bubble-user-ink'
          : 'border-[0.5px] border-hairline-soft bg-bubble-agent text-ink shadow-[var(--sm-bubble-shadow)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * A file path inside prose — weight 500, tighter tracking. The one typographic
 * mark the approved boards give a path, and the hook a later slice hangs the
 * file-viewer deep link on.
 */
export function PathRef({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-medium tracking-[-0.12px]', className)}>{children}</span>
}

/**
 * A fenced block inside a bubble — the diff read of the approved Patch board.
 * JetBrainsMono 12.7/1.62 on `--sm-code-bg`, radius 12, 0.5px hairline-soft.
 * Removed lines are tertiary ink, added lines full-strength: the same
 * "quiet chrome, loud content" rule the rest of the surface follows, and the
 * reason this is not a red/green block (P8's full diff palette is a later
 * slice — this is the inline case).
 */
export function BubbleCode({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'mt-[11px] overflow-hidden whitespace-pre rounded-[12px] border-[0.5px] border-hairline-soft bg-code-bg px-[13px] py-2.5 font-mono text-[12.7px] leading-[1.62] tracking-[-0.1px]',
        className,
      )}
    >
      {children}
    </pre>
  )
}

/** A removed line inside `<BubbleCode>`. */
export function CodeDel({ children }: { children: ReactNode }) {
  return <span className="text-ink-3">{children}</span>
}

/** An added line inside `<BubbleCode>`. */
export function CodeAdd({ children }: { children: ReactNode }) {
  return <span className="text-ink">{children}</span>
}
