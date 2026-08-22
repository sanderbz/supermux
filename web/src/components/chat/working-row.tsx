// P12 working row — the DATA half (fase A3 T4).
//
// Two files, one name, one job each: `ui/working-row.tsx` decides what this
// looks like, and this one decides what it SAYS. Driven by the SSE status flip
// (206ms p50) + the live hook label; NEVER the transcript.
//
// The §4.2 P12 state ladder, and what each rung is worth:
//   0s    face + dots + the hook label, no number — a turn that has barely
//         started does not need a clock, and showing 1s, 2s, 3s makes a fast
//         turn feel slow.
//   5s    the elapsed clause appears (`ELAPSED_AFTER_MS`), counted from the
//         SEND (`turnStartMs`, server clock) rather than from mount, so a panel
//         opened mid-turn does not restart the number.
//   30s   unchanged — the row is already saying everything it knows.
//   >120s the stranded-turn teardown, which lives in `use-chat-turn.ts` where
//         the turn does; this component just stops being rendered.
//
// Import rule: relative only (the unit runner resolves no `@/` paths) and
// `components/chat/ui` is imported from here, never the reverse.

import { motion, useReducedMotion } from 'framer-motion'

import type { MarkPin } from '../../brand/marks'
import { motionOff, springs } from '../../lib/springs'
import { subagentsClause } from '@/lib/mark-status'

import { stripEmojiPrefix } from './entries'
import { ELAPSED_AFTER_MS, LiveElapsed, useElapsedShown } from './live-elapsed'
import { WorkingRow as WorkingRowUi } from './ui'

export function WorkingRow({
  name,
  pin,
  activity,
  subagents,
  turnStartMs,
}: {
  /** The working session's slug — the seed for the face in the gutter. */
  name?: string
  pin?: MarkPin
  activity?: string
  subagents?: number
  /** Turn anchor in SERVER-clock ms (last_send_at when recent, else the
   *  skew-corrected flip stamp) — so the elapsed clause counts from the SEND,
   *  not from whenever this component happened to mount. */
  turnStartMs: number
}) {
  // NO TICK HERE. The elapsed clause is a `LiveElapsed` leaf that advances by
  // mutating its own text node (`live-elapsed.tsx`), so this row re-renders only
  // when its REAL props change — an SSE status flip, a new hook label, a
  // subagent count — and never because a second went by. That is what keeps a
  // reader's drag-select alive: the row sits at the bottom of the live band a
  // selection naturally reaches into, and nothing here replaces a node under it.
  const reduce = useReducedMotion() ?? false
  // The 5s rung, as ONE scheduled flip rather than five ticks (`useElapsedShown`):
  // under it the elapsed cell is not rendered at all, exactly as before, so the
  // row's `gap`/`ml-auto` geometry is unchanged on the first rung.
  const showElapsed = useElapsedShown(turnStartMs, ELAPSED_AFTER_MS)

  const clause = subagentsClause(subagents)
  // The emoji taxonomy stays terminal/tile-only, so the label is stripped here
  // exactly as the confirmed receipt it will become is (`stripEmojiPrefix`).
  const label = (activity ? stripEmojiPrefix(activity) : 'Thinking…') + clause

  return (
    <motion.div
      data-testid="chat-working-row"
      // Arrival only — the row's own content changes in place after that, and a
      // transform on every hook label would make the surface twitch once a
      // second. Reduced motion drops the 4px rise and keeps the fade.
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? motionOff : springs.cardExpand}
    >
      <WorkingRowUi
        seed={name}
        pin={pin}
        label={label}
        elapsed={
          showElapsed ? <LiveElapsed turnStartMs={turnStartMs} afterMs={ELAPSED_AFTER_MS} /> : undefined
        }
      />
    </motion.div>
  )
}
