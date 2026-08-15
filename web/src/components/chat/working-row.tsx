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

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import type { MarkPin } from '../../brand/marks'
import { springs } from '../../lib/springs'

import { formatElapsed, stripEmojiPrefix } from './entries'
import { serverNowMs } from './latency'
import { WorkingRow as WorkingRowUi } from './ui'

/** How long a turn runs before it is worth putting a number on. */
const ELAPSED_AFTER_MS = 5_000

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
  // 1s tick for the elapsed clause only.
  const [, tick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  const reduce = useReducedMotion() ?? false

  const clause = subagents && subagents >= 2 ? ` · ${subagents} subagents` : ''
  // The emoji taxonomy stays terminal/tile-only, so the label is stripped here
  // exactly as the confirmed receipt it will become is (`stripEmojiPrefix`).
  const label = (activity ? stripEmojiPrefix(activity) : 'Thinking…') + clause
  const elapsedMs = serverNowMs() - turnStartMs

  return (
    <motion.div
      data-testid="chat-working-row"
      // Arrival only — the row's own content changes in place after that, and a
      // transform on every hook label would make the surface twitch once a
      // second. Reduced motion drops the 4px rise and keeps the fade.
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.cardExpand}
    >
      <WorkingRowUi
        seed={name}
        pin={pin}
        label={label}
        elapsed={elapsedMs >= ELAPSED_AFTER_MS ? formatElapsed(elapsedMs) : undefined}
      />
    </motion.div>
  )
}
