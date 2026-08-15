/**
 * P7 / P12 — the working row. VISUAL ONLY.
 * ─────────────────────────────────────────────────────────────────────────────
 * The live turn indicator: the session's face at 28px on the transcript gutter,
 * the three-dot wave, the current hook label at 13px secondary, and — once a
 * turn is long enough to be worth counting — an elapsed clause on the right.
 *
 * This is the DESIGN-SYSTEM primitive, deliberately dumb: it takes strings. The
 * wiring (status flip at 206ms p50, the `PreToolUse` label, the server-clock
 * elapsed anchor, the post-hoc collapse into "worked for 42s") lives in
 * `components/chat/working-row.tsx`, which owns the data and which this primitive
 * is intended to re-skin in a later slice. Two files, one name, one job each:
 * this one decides what it looks like, that one decides what it says.
 *
 * `variant="presence"` is the mockup's `.presence` line — "Typing…" under the
 * last bubble, with no mark and no dots, indented 44px so it starts on the
 * bubble's left edge (32px gutter + 12px gap). The same signal, one notch
 * quieter, for when the session is composing rather than working.
 */
import { SessionMark, type MarkPin, type MarkState } from '../../../brand/marks'
import { cn } from '../../../lib/utils'

import { Dots } from './dots'
import { MARK_SIZE } from './metrics'

export interface WorkingRowProps {
  /** The session that is working. Omit for the bare presence line. */
  seed?: string
  pin?: MarkPin
  /** What it is doing right now — the hook label, or "Thinking…". */
  label: string
  /** Right-hand elapsed clause, pre-formatted ("12s", "2m 04s"). */
  elapsed?: string
  /** `working` (default) or `waiting` — the face follows the status, not the row. */
  state?: Extract<MarkState, 'working' | 'waiting'>
  variant?: 'row' | 'presence'
  className?: string
}

export function WorkingRow({
  seed,
  pin,
  label,
  elapsed,
  state = 'working',
  variant = 'row',
  className,
}: WorkingRowProps) {
  if (variant === 'presence') {
    return (
      <div
        data-variant="presence"
        className={cn('mt-[9px] flex items-center gap-[7px] pl-11 text-[13px] text-ink-2', className)}
      >
        <span>{label}</span>
      </div>
    )
  }

  return (
    <div data-variant="row" className={cn('mt-3.5 flex items-start gap-3', className)}>
      <div className="flex w-8 flex-none justify-center pt-[3px]">
        {seed && <SessionMark seed={seed} pin={pin} size={MARK_SIZE.gutter} state={state} label={null} />}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-[9px] pt-[5px] text-[13px] text-ink-2">
        <Dots />
        <span className="min-w-0 truncate">{label}</span>
        {elapsed && (
          <span className="ml-auto flex-none tabular-nums text-ink-3">{elapsed}</span>
        )}
      </div>
    </div>
  )
}
