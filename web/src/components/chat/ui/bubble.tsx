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
  /**
   * Which composition this row is in. The phone tightens the gutter to the
   * mark's own 28px and the gap to 8px — 36px instead of 44px of left indent.
   * That 8px is not decoration: on a 390pt screen every pixel the row spends on
   * chrome is a pixel the sentence does not get, and the gutter is the only
   * fixed cost in front of the agent's text.
   */
  surface?: 'desktop' | 'phone'
  className?: string
}

/**
 * The transcript's one row grammar: gutter + content. Every primitive that sits
 * in the column (bubbles, receipt groups, working rows, captured frames) goes
 * through it, which is what keeps their left edges on one line.
 */
export function MessageRow({ children, me, grouped, gutter, surface, className }: MessageRowProps) {
  const phone = surface === 'phone'
  return (
    <div
      data-grouped={grouped || undefined}
      data-me={me || undefined}
      className={cn(
        'flex items-start',
        phone ? 'gap-2' : 'gap-3',
        grouped ? 'mt-2' : 'mt-3.5',
        me && 'justify-end',
        className,
      )}
    >
      {!me && (
        <div
          className={cn(
            'flex flex-none justify-center pt-[3px]',
            phone ? 'w-7' : 'w-8',
          )}
        >
          {gutter}
        </div>
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
   * Which ceiling applies. The phone is not a narrower desktop, but it is also
   * not the artboard: it drops the two px maxima for a proportional pair
   * (`100%` / `84%`), so the agent runs the column and the human's own line
   * keeps the right-side asymmetry at any phone width. See `BUBBLE_MAX`.
   */
  surface?: 'desktop' | 'phone'
  /**
   * WHO SAID IT, for assistive tech only (fase A6 T7.2 — gap G3).
   *
   * On screen the speaker is carried by the gutter mark and by the bubble's
   * side of the column; neither survives linearisation, so AT read the surface
   * as an undifferentiated wall of prose. This adds the one word that fixes it,
   * as the bubble's accessible NAME, so it travels with the message when a
   * screen reader navigates by article.
   *
   * Opt-in rather than derived from `variant`, because not every bubble is
   * speech: a receipt group and a captured frame are the same primitive and
   * prefixing them with a name would be a lie. Absent → byte-identical to A5.
   */
  author?: string
  className?: string
}

export function Bubble({
  children,
  variant = 'assistant',
  padding = 'text',
  surface = 'desktop',
  author,
  className,
}: BubbleProps) {
  const user = variant === 'user'
  const phone = surface === 'phone'
  return (
    <div
      data-variant={variant}
      // A message is an ARTICLE, named by its speaker. Two things come out of
      // that one pair: AT gains a navigable unit per turn (what makes "jump to
      // the previous message" possible at all), and entering it announces who
      // is talking. Carried as a NAME rather than as sr-only text inside the
      // bubble, deliberately — the bubble's text content is the message, and
      // three transcript tests read it verbatim to prove a slash command is
      // rendered as exactly its own name.
      role={author ? 'article' : undefined}
      aria-label={author}
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
        // The phone ceiling is a PERCENTAGE now, so nothing else stops a wide
        // child (a fenced block, a frame) from pushing the flex item past the
        // row. `min-w-0` is what lets the bubble shrink to the column instead.
        phone && 'min-w-0',
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

/** A removed line inside `<BubbleCode>`. The `data-code-del` hook lets the grok
 *  skin lift the deletion off tertiary ink (measured 2.99:1 on the code well —
 *  below AA and below Grok's floor) onto an error-accent tint that clears 4.5:1;
 *  the default renderer keeps the tertiary ink and gains only an inert attr. */
export function CodeDel({ children }: { children: ReactNode }) {
  return (
    <span className="text-ink-3" data-code-del>
      {children}
    </span>
  )
}

/** An added line inside `<BubbleCode>`. */
export function CodeAdd({ children }: { children: ReactNode }) {
  return <span className="text-ink">{children}</span>
}
