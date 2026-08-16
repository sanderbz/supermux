/**
 * The facepile — several sessions, as one object.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two forms, one component:
 *
 *   cluster  the approved boards' crew mark: three 18px members in a 1-over-2
 *            arrangement inside a 40px box, each stroked with a page-coloured
 *            keyline. It stands in for a single mark in a roster row, so it must
 *            occupy exactly one mark's footprint — a team is a colleague too.
 *   row      §11.9's inline pile: members overlap by −24% of their size, in a
 *            header or a card title. The active member can expand into a
 *            labelled pill by animating PADDING (0.4s ease) — the width change
 *            comes from the label, so nothing else in the row jumps.
 *
 * The keyline is what makes an overlap readable: without it, two adjacent
 * pigments touch and the pile reads as one lumpy shape. It is painted UNDER the
 * fill by `<SessionMark ring>` and stays 2 CSS px at any size.
 *
 * `<FaceName>` and `<ArrivalDivider>` are the receiving end of a delegation:
 * "Messages from ●Patch and ●Quill" — provenance at the point of arrival, in the
 * sender's own colour (master plan §13.2).
 */
import type { ReactNode } from 'react'

import { SessionMark, type MarkPin } from '../../../brand/marks'
import { cn } from '../../../lib/utils'

import { FACEPILE, MARK_SIZE } from './metrics'

export interface FacepileMember {
  seed: string
  pin?: MarkPin
  name?: string
}

export interface FacepileProps {
  members: readonly FacepileMember[]
  /** `cluster` (a mark-sized crew badge) or `row` (an inline pile). */
  variant?: 'cluster' | 'row'
  /** Member size. The cluster is fixed at 18px by its geometry. */
  size?: number
  /**
   * Keyline colour — the surface the pile sits on (`PAPER[theme].paper`).
   * Omit and the members are drawn without a keyline.
   */
  ring?: string | null
  /**
   * Index of the member that just changed state. In `row`, it expands into a
   * labelled pill; its `name` is the label.
   */
  activeIndex?: number
  className?: string
}

export function Facepile({
  members,
  variant = 'cluster',
  size = MARK_SIZE.facepile,
  ring = null,
  activeIndex,
  className,
}: FacepileProps) {
  if (variant === 'cluster') {
    const { box, offsets } = FACEPILE.cluster
    return (
      <div
        aria-hidden
        style={{ width: box, height: box }}
        className={cn('relative flex-none', className)}
      >
        {members.slice(0, offsets.length).map((m, i) => (
          // The mark owns its own box; the seat is the wrapper's job.
          <span
            key={m.seed}
            className="absolute"
            style={{ left: offsets[i][0], top: offsets[i][1], zIndex: i + 1 }}
          >
            <SessionMark
              seed={m.seed}
              pin={m.pin}
              size={FACEPILE.cluster.size}
              ring={ring}
              animate={i === 0}
              label={null}
            />
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className={cn('flex items-center', className)}>
      {members.map((m, i) => {
        const active = activeIndex === i
        return (
          <span
            key={m.seed}
            style={{
              marginLeft: i === 0 ? 0 : size * FACEPILE.row.overlap,
              zIndex: active ? members.length + 1 : i + 1,
            }}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-full sm-t-pad',
              active && 'bg-fill-soft py-0.5 pl-0.5 pr-2.5',
            )}
          >
            <SessionMark seed={m.seed} pin={m.pin} size={size} ring={ring} label={null} />
            {active && m.name && (
              <span className="whitespace-nowrap text-[12px] font-medium text-ink">{m.name}</span>
            )}
          </span>
        )
      })}
    </div>
  )
}

export interface FaceNameProps {
  seed: string
  pin?: MarkPin
  name?: string
  size?: number
  ring?: string | null
  className?: string
}

/** A mark and a name, on one line — the unit the arrival divider is made of. */
export function FaceName({ seed, pin, name, size = MARK_SIZE.divider, ring = null, className }: FaceNameProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium text-ink', className)}>
      <SessionMark seed={seed} pin={pin} size={size} ring={ring} animate={false} label={null} />
      {name ?? seed}
    </span>
  )
}

/** "Messages from ●Patch and ●Quill" — the arrival end of a delegation. */
export function ArrivalDivider({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'mt-4 flex flex-wrap items-center justify-center gap-[7px] text-[13px] text-ink-2',
        className,
      )}
    >
      {children}
    </div>
  )
}
