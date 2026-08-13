// P12 working row (REQUIRED fail-branch primitive — master plan §4.2).
// Driven by the SSE status flip (206ms p50) + the live hook label; NEVER the
// transcript. Neutral-minimal: the A3 design addendum owns the real spec
// (states at 0s/5s/30s/>120s, motion, post-hoc collapse).

import * as React from 'react'

import { StatusDot } from '@/components/session-tile/status-dot'

import { formatElapsed, stripEmojiPrefix } from './entries'
import { serverNowMs } from './latency'

export function WorkingRow({
  activity,
  subagents,
  turnStartMs,
}: {
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
  const clause = subagents && subagents >= 2 ? ` · ${subagents} subagents` : ''
  return (
    <div
      data-testid="chat-working-row"
      className="flex items-center gap-2 px-1 py-1.5 text-[13px] text-muted-foreground"
    >
      <StatusDot status="active" />
      <span className="min-w-0 truncate">
        {(activity ? stripEmojiPrefix(activity) : 'Working…') + clause}
      </span>
      <span className="ml-auto shrink-0 tabular-nums">
        {formatElapsed(serverNowMs() - turnStartMs)}
      </span>
    </div>
  )
}
