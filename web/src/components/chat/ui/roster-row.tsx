/**
 * The roster row — a colleague, with their own words.
 * ─────────────────────────────────────────────────────────────────────────────
 * The approved boards' sidebar row, and the single most-repeated object in the
 * product:
 *
 *   row       height 64, gap 12, padding 0 8, radius 12
 *   mark      40px — or a crew cluster in the same footprint (a team is a
 *             colleague too)
 *   name      14px/500, tracking −0.15px, truncating
 *   time      12px secondary, tabular-nums, pinned right, never truncated
 *   preview   13px secondary, 3px under the name, truncating — the session's own
 *             last line, not a status word. THE PREVIEW *IS* THE STATUS LINE
 *             (§12.1): "one check left. then crates.io." tells you more than
 *             "active" ever will, and when the session is composing, the same
 *             slot carries presence ("Typing…").
 *   selected  `sm-accent-row` — the focused session's own pigment mixed into the
 *             paper at 9% (light) / 12% (dark). The only chrome that is tinted.
 *   attention needs-you dot on the silhouette's shoulder, seated from the
 *             character's own solid (see `attentionDotSeat`)
 *
 * Hover is the 120ms speed (§11.11) and is suppressed while selected — a
 * selected row that lightens under the pointer reads as a click that did nothing.
 * The row-arrival animation (0.45s, translateX(−10px)) is deliberately NOT here:
 * it is `data-fresh`-gated in the master plan, and a static primitive that
 * animates on every mount would animate the whole backlog.
 */
import { characterFromSeed, SessionMark, VIEWBOX, type MarkPin, type MarkState } from '../../../brand/marks'
import { cn } from '../../../lib/utils'

import { Facepile, type FacepileMember } from './facepile'
import { ATTENTION_DOT, attentionDotSeat, FACEPILE, MARK_SIZE } from './metrics'

export interface RosterRowProps {
  /** The session's name — its face, and by default its label. */
  seed: string
  pin?: MarkPin
  /** Display name, when it differs from the slug. */
  name?: string
  /** Relative time, pre-formatted ("1:47 PM", "Yesterday"). */
  timestamp?: string
  /** The session's last line — or its presence ("Typing…"). */
  preview?: string
  state?: MarkState
  selected?: boolean
  /** Needs you: permission, plan approval, question, inbound delegation. */
  attention?: boolean
  /** A team row: the cluster replaces the single mark, same footprint. */
  crew?: readonly FacepileMember[]
  /** Keyline colour for a crew cluster — the row's own paper. */
  ring?: string | null
  onClick?: () => void
  className?: string
}

export function RosterRow({
  seed,
  pin,
  name,
  timestamp,
  preview,
  state = 'idle',
  selected,
  attention,
  crew,
  ring = null,
  onClick,
  className,
}: RosterRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-selected={selected || undefined}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        // radius 12 — the mockup's literal. NOT `rounded-xl`: this repo remaps
        // the named scale off `--radius` (sm 8 · md 10 · lg 12 · xl 16), so the
        // named rungs do not mean what stock Tailwind's do.
        'flex h-16 w-full items-center gap-3 rounded-[12px] px-2 text-left',
        'transition-colors duration-[120ms]',
        selected ? 'sm-accent-row' : 'hover:bg-fill-soft',
        className,
      )}
    >
      <span className="relative flex-none">
        {crew ? (
          <Facepile members={crew} variant="cluster" ring={ring} />
        ) : (
          <SessionMark seed={seed} pin={pin} size={MARK_SIZE.roster} state={state} label={null} />
        )}
        {attention && <AttentionDot seed={seed} pin={pin} crew={Boolean(crew)} ring={ring} />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.15px] text-ink">
            {name ?? seed}
          </span>
          {timestamp && (
            <span className="ml-auto flex-none text-[12px] tabular-nums text-ink-2">
              {timestamp}
            </span>
          )}
        </span>
        {preview && (
          <span className="mt-[3px] block truncate text-[13px] text-ink-2">{preview}</span>
        )}
      </span>
    </button>
  )
}

/**
 * The needs-you dot. On a single mark it sits on the silhouette's own upper-right
 * shoulder — a wedge and a sphere have very different shoulders, so the seat is
 * derived, not hard-coded. A crew cluster has no single silhouette, so the dot
 * takes the box's top-right corner.
 */
function AttentionDot({
  seed,
  pin,
  crew,
  ring,
}: {
  seed: string
  pin?: MarkPin
  crew: boolean
  ring: string | null
}) {
  const seat = crew
    ? { left: FACEPILE.cluster.box - ATTENTION_DOT.size, top: 0 }
    : attentionDotSeat(characterFromSeed(seed, pin), MARK_SIZE.roster, VIEWBOX)
  return (
    <span
      aria-hidden
      className="absolute rounded-full"
      style={{
        left: seat.left,
        top: seat.top,
        width: ATTENTION_DOT.size,
        height: ATTENTION_DOT.size,
        background: ATTENTION_DOT.color,
        boxShadow: `0 0 0 ${ATTENTION_DOT.ringWidth}px ${ring ?? 'var(--sm-paper)'}`,
      }}
    />
  )
}
