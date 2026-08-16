/**
 * P3 — the receipt group: a turn's tool calls, as a checklist.
 * ─────────────────────────────────────────────────────────────────────────────
 * The approved boards render it as a bubble with wider inner padding, one line
 * per call:
 *
 *   line     flex, gap 9, line-height 1.5; 7px between lines
 *   check    13px monochrome glyph in the leading slot (a spinner while the
 *            call is still running — same slot, so nothing reflows when it lands)
 *   tool     weight 600
 *   arrow    15×12 glyph
 *   outcome  15px, tabular-nums, tracking −0.1px, full-strength ink
 *
 * Built for Claude's volume (30–100 calls/turn, master plan §4.2 P3): repeats
 * coalesce into `Read ×12`, and a `max` caps the list with a "Show all N"
 * affordance. Virtualisation above 200 lines belongs to the renderer slice that
 * owns the data, not to this primitive.
 */
import * as React from 'react'

import { cn } from '../../../lib/utils'

import { ArrowIcon, CheckIcon, SpinnerIcon } from './icons'
import { Bubble } from './bubble'

export interface Receipt {
  /** The tool's name — `cargo check`, `Read`, `tests`. */
  tool: string
  /**
   * The same call, at the length a phone can read — `Read notes.md` for a
   * `Read /home/supermux/spike-qa/notes.md` (daily-driver QA #2,
   * `grouping.ts::condenseReceiptLabel`). Absent when there was nothing to
   * shorten, and never used on the desktop composition, which has the room.
   */
  short?: string
  /** `→ clean · 0 errors`. Absent while the call is still running. */
  outcome?: string
  /** The result the outcome column clamped, for the expanded row. */
  full?: string
  /** `running` puts the spinner in the check slot. Default `done`. */
  state?: 'done' | 'running'
  /**
   * The live status of a `running` line — `8s`, `3 subagents · 8s`.
   *
   * This is what makes the running receipt the turn's ONE live representation
   * (daily-driver QA #7): before it, the elapsed clock lived on a separate
   * working pill under the group, so a single tool call was drawn twice at once
   * — `◌ notes.md` and `••• notes.md 5s`. The clock belongs to the line that is
   * running, and when that line stops running it resolves into a receipt in
   * place, with the outcome landing where the clock was.
   */
  status?: string
}

export interface CoalescedReceipt extends Receipt {
  /** How many identical consecutive calls this line stands for. */
  count: number
}

/**
 * Collapse consecutive repeats of the same tool into one counted line.
 *
 * Two rules that keep the count honest:
 *   · twelve reads of twelve different files have twelve different outcomes, so
 *     the collapsed line drops the outcome rather than showing one file's and
 *     implying the other eleven;
 *   · a still-running line never merges — it is the live row, its label is
 *     rewritten by `PreToolUse`, and folding it into a count would hide the one
 *     thing the user is watching.
 */
export function coalesceReceipts(rows: readonly Receipt[]): CoalescedReceipt[] {
  const out: CoalescedReceipt[] = []
  for (const row of rows) {
    const prev = out[out.length - 1]
    const mergeable =
      prev !== undefined &&
      prev.tool === row.tool &&
      prev.state !== 'running' &&
      row.state !== 'running'
    if (mergeable) {
      prev.count += 1
      if (prev.outcome !== row.outcome) {
        prev.outcome = undefined
        // The expanded read is the outcome's full text; with no outcome to
        // expand, keeping it would offer a tap that shows one call's result on a
        // line that stands for twelve.
        prev.full = undefined
      }
      continue
    }
    out.push({ ...row, count: 1 })
  }
  return out
}

export interface ReceiptGroupProps {
  rows: readonly Receipt[]
  /** Cap the visible lines; the rest hide behind a "Show all N" affordance. */
  max?: number
  /** Wired by the renderer slice. Visual-only here. */
  onShowAll?: () => void
  /** Which bubble ceiling applies — the group IS a bubble (266px on a phone). */
  surface?: 'desktop' | 'phone'
  className?: string
}

/**
 * Apply the cap — WITHOUT ever hiding a line that is still running.
 *
 * The same rule as the coalescer's: the running line is the one the user is
 * actually watching. A 60-call turn caps at `max`, and the live call is always
 * the last one, so a naive `slice(0, max)` hides the spinner exactly when it
 * matters. The cap governs the finished backlog; the live line is pulled
 * forward past it.
 */
export function capReceipts(
  lines: readonly CoalescedReceipt[],
  max: number | undefined,
): { shown: CoalescedReceipt[]; hidden: number } {
  if (max === undefined || lines.length <= max) return { shown: [...lines], hidden: 0 }
  const head = lines.slice(0, max)
  const live = lines.slice(max).filter((l) => l.state === 'running')
  return { shown: [...head, ...live], hidden: lines.length - head.length - live.length }
}

export function ReceiptGroup({ rows, max, onShowAll, surface, className }: ReceiptGroupProps) {
  const lines = coalesceReceipts(rows)
  const { shown, hidden } = capReceipts(lines, max)

  return (
    <Bubble padding="list" surface={surface} className={cn('flex flex-col gap-[7px]', className)}>
      {shown.map((line, i) => (
        <ReceiptLine key={`${line.tool}-${i}`} line={line} phone={surface === 'phone'} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="mt-0.5 self-start text-[13px] font-medium text-ink-2 transition-colors duration-[120ms] hover:text-ink"
        >
          Show all {lines.length}
        </button>
      )}
    </Bubble>
  )
}

/**
 * One call — condensed, WRAPPING, and expandable (daily-driver QA #2).
 *
 * It used to be one line, always: two cells that both truncated, the tool with
 * `min-w-[6ch]` and the outcome with `min-w-[4ch]`. On a 390px phone that
 * arithmetic produced `✓ Read /home/s… → 1 …` — a 135px cell holding a
 * 37-character target, and four glyphs of result. Receipts are the majority of a
 * working turn, so the majority of the conversation said nothing.
 *
 * Three changes, in the order they matter:
 *   · the label is CONDENSED rather than ellipsed (`condenseReceiptLabel`):
 *     the basename of a path, the head of a command. `Read notes.md` is what a
 *     reader was trying to get out of `Read /home/s…` in the first place.
 *   · what still does not fit WRAPS to a second line instead of ellipsing both
 *     columns. The row is a grid — glyph column, content column — so the wrap
 *     hangs under the text rather than under the check.
 *   · the row EXPANDS on tap: the full label, and the full result the outcome
 *     column clamped. Tapping a receipt did nothing before, which is the first
 *     thing anybody tries when a line is unreadable.
 *
 * A row with nothing more to show is a plain `div`, not a dead button: an
 * affordance that answers a tap with nothing is worse than no affordance.
 */
function ReceiptLine({ line, phone }: { line: CoalescedReceipt; phone?: boolean }) {
  const [expanded, setExpanded] = React.useState(false)
  const running = line.state === 'running'
  const condensed = phone && line.short !== undefined && !expanded
  const label = condensed ? line.short! : line.tool
  const outcome = expanded && line.full !== undefined ? line.full : line.outcome
  const more = (phone && line.short !== undefined) || line.full !== undefined

  const body = (
    <>
      <span className="flex flex-none pt-[3px] text-ink-2">
        {running ? <SpinnerIcon className="sm-spin" /> : <CheckIcon />}
      </span>
      {/* ONE inline flow, deliberately: the outcome follows the label the way a
          clause follows a sentence, so a long pair wraps at a word boundary
          instead of being cut in two places. `[overflow-wrap:anywhere]` is for
          the case no word boundary exists — a 60-character path with no spaces
          in it must still stay inside the bubble. */}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-semibold">{label}</span>
        {line.count > 1 && <span className="tabular-nums text-ink-2"> ×{line.count}</span>}
        {outcome !== undefined && (
          <>
            <span className="mx-[7px] inline-flex translate-y-[1px] text-ink-2">
              <ArrowIcon />
            </span>
            <span className="tabular-nums tracking-[-0.1px] text-ink">{outcome}</span>
          </>
        )}
      </span>
      {/* The running line's own clock, in the slot the outcome will take. It
          never competes with an outcome — a line that has one has finished. */}
      {running && line.status && line.outcome === undefined && (
        <span
          data-testid="chat-receipt-status"
          // `ml-auto` as it always was: the clock sits on the bubble's right
          // edge, so a turn's running line reads as one column of elapsed times
          // rather than a number that moves with the label's length.
          className="ml-auto flex-none whitespace-nowrap pt-[1px] tabular-nums text-[13px] text-ink-2"
        >
          {line.status}
        </span>
      )}
    </>
  )

  const className = 'flex w-full min-w-0 items-start gap-[9px] text-left leading-[1.5]'
  if (!more) {
    return (
      <div data-testid="chat-receipt" data-state={line.state ?? 'done'} className={className}>
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="chat-receipt"
      data-state={line.state ?? 'done'}
      data-expanded={expanded || undefined}
      aria-expanded={expanded}
      onClick={() => setExpanded((e) => !e)}
      className={className}
    >
      {body}
    </button>
  )
}
