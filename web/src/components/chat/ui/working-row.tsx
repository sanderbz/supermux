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
import type * as React from 'react'

import { SessionMark, type MarkPin, type MarkState } from '../../../brand/marks'
import { cn } from '../../../lib/utils'

import { Dots } from './dots'
import { AgentDotIcon } from './icons'
import { MARK_SIZE } from './metrics'

export interface WorkingRowProps {
  /** The session that is working. Omit for the bare presence line. */
  seed?: string
  pin?: MarkPin
  /** What it is doing right now — the hook label, or "Working…". */
  label: string
  /**
   * Right-hand elapsed clause.
   *
   * A NODE rather than a string: the DATA layer hands this slot a live clock
   * (`chat/live-elapsed.tsx`) that advances by mutating its own text node,
   * never by re-rendering anything here — which is what keeps a reader's
   * selection alive while a turn runs. This primitive stays dumb and pure: it
   * decides where the clause sits, not what it says or when it changes, and it
   * imports no clock of its own. A plain string ("12s", "2m 04s") is still a
   * valid occupant — the bench passes one.
   */
  elapsed?: React.ReactNode
  /**
   * The parallelism clause, as a NODE — `· 3 agents`, and on this surface it is
   * also the control that opens the agent list.
   *
   * A node rather than a string for the same reason `elapsed` is one: the DATA
   * layer owns whether the clause is inert text or a `<button aria-expanded>`,
   * and this primitive owns only where it sits — immediately after the label, so
   * the truncating label still loses the squeeze first.
   */
  clause?: React.ReactNode
  /** `working` (default), `waiting`, or `streaming` — the face follows the status,
   *  not the row. `streaming` gives the gutter mark the talking mouth while an
   *  assistant delta lands, echoing the transcript's typing dots. */
  state?: Extract<MarkState, 'working' | 'waiting' | 'streaming'>
  variant?: 'row' | 'presence'
  className?: string
}

export function WorkingRow({
  seed,
  pin,
  label,
  elapsed,
  clause,
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
        {clause}
        {elapsed && (
          <span className="ml-auto flex-none tabular-nums text-ink-3">{elapsed}</span>
        )}
      </div>
    </div>
  )
}

/** One line of the expanded agent list, already decided by the data layer. */
export interface AgentListRow {
  /** The server's `agent_id` — the key, so two rows can never merge. */
  id: string
  /** What this agent is doing, or its kind when it has done nothing yet. */
  label: string
  /** No hook within the quiet window: dim it and say the fact. */
  quiet?: boolean
  /**
   * The right-hand cell. A NODE, because for a live row the data layer hands it
   * a self-mutating clock (`chat/live-elapsed.tsx`): the whole list must be able
   * to count seconds without re-rendering the transcript around it. For a quiet
   * row it is a plain sentence.
   */
  right?: React.ReactNode
}

export interface AgentListProps {
  rows: readonly AgentListRow[]
  /** How many rows the cap hid. Rendered as `+N more`; 0 hides the line. */
  more?: number
  /** The closing sentence — where the work actually shows. */
  note?: string
  /** Wired to the clause button's `aria-controls`. */
  id?: string
  className?: string
}

/**
 * The expanded agent list — what is running under this turn, one line each.
 * VISUAL ONLY.
 *
 * Indented 44px to the `presence` variant's `pl-11`, so it starts on the same
 * left edge as a bubble and reads as belonging to the row above rather than to
 * the transcript. 24px lines at 13px secondary: dense enough that six of them
 * plus the note still fit under the working row on a 390px phone with the
 * composer up, which is the surface this had to survive.
 *
 * It is a list of STATUS, not of voice — no marks, no faces, no bubbles. A face
 * would mean a colleague with a session of their own, and the roster owns that
 * meaning; these are the current turn's children and they leave with it.
 */
export function AgentList({ rows, more = 0, note, id, className }: AgentListProps) {
  return (
    <div id={id} className={cn('pl-11 text-[13px] text-ink-2', className)}>
      {rows.map((row) => (
        <div key={row.id} className="flex h-6 items-center gap-[9px]">
          <AgentDotIcon quiet={row.quiet} className={cn('flex-none', row.quiet && 'text-ink-3')} />
          <span className={cn('min-w-0 truncate', row.quiet && 'text-ink-3')}>{row.label}</span>
          {row.right !== undefined && (
            <span className="ml-auto flex-none whitespace-nowrap tabular-nums text-ink-3">
              {row.right}
            </span>
          )}
        </div>
      ))}
      {more > 0 && <div className="flex h-6 items-center pl-[22px] text-ink-3">+{more} more</div>}
      {note && <div className="flex h-6 items-center pl-[22px] text-ink-3">{note}</div>}
    </div>
  )
}
