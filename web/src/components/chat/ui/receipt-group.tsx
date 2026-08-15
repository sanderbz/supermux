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
import type { ReactNode } from 'react'

import { cn } from '../../../lib/utils'

import { ArrowIcon, CheckIcon, SpinnerIcon } from './icons'
import { Bubble } from './bubble'

export interface Receipt {
  /** The tool's name — `cargo check`, `Read`, `tests`. */
  tool: string
  /** `→ clean · 0 errors`. Absent while the call is still running. */
  outcome?: string
  /** `running` puts the spinner in the check slot. Default `done`. */
  state?: 'done' | 'running'
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
      if (prev.outcome !== row.outcome) prev.outcome = undefined
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
        <ReceiptLine key={`${line.tool}-${i}`} line={line} />
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

function ReceiptLine({ line }: { line: CoalescedReceipt }) {
  const running = line.state === 'running'
  return (
    <div
      data-state={line.state ?? 'done'}
      // A receipt is ONE line — that is the whole of P3's read, and it is what
      // makes a 30-call turn scannable. `min-w-0` + the two truncating cells
      // below are what enforce it: a `Read <120-char path>` label used to wrap
      // to three lines and shove its outcome to the far edge of the bubble.
      className="flex min-w-0 items-center gap-[9px] leading-[1.5]"
    >
      <span className="flex flex-none text-ink-2">
        {running ? <SpinnerIcon className="sm-spin" /> : <CheckIcon />}
      </span>
      {/* Who ran, then what happened — and when the line will not hold both, the
          OUTCOME gives way ENTIRELY before the tool gives up a glyph (its shrink
          factor, below, is three orders of magnitude larger). The tool is the
          noun the reader scans for.
          Two mistakes are already paid for here, both caught on the bench:
            · a `max-w-%` cap resolves against a width this shrink-to-fit bubble
              is still deciding, so it truncated lines that had room to spare;
            · a FRACTIONAL shrink factor on the tool (0.25) is worse than useless
              — per the flexbox spec, when the sum of the shrink factors is below
              one only that FRACTION of the overflow is distributed, so a long
              `Read <path>` label simply overflowed the bubble on the phone. */}
      <span className="min-w-[6ch] shrink truncate whitespace-nowrap font-semibold">
        {line.tool}
      </span>
      {line.count > 1 && (
        <span className="tabular-nums text-ink-2">×{line.count}</span>
      )}
      {line.outcome !== undefined && (
        <>
          <span className="flex flex-none text-ink-2">
            <ArrowIcon />
          </span>
          <Outcome>{line.outcome}</Outcome>
        </>
      )}
    </div>
  )
}

/**
 * The outcome column. It yields first (see the tool cell above) but never all
 * the way to nothing: a `min-w` of 4 glyphs is what stops a very long tool label
 * from leaving a dangling arrow pointing at empty space.
 */
function Outcome({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-[4ch] shrink-[999] truncate whitespace-nowrap text-[15px] tabular-nums tracking-[-0.1px] text-ink">
      {children}
    </span>
  )
}
