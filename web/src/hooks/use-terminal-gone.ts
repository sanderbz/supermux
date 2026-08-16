// useTerminalGone — bridge the terminal WebSocket's TERMINAL close (4404) into
// the focus panes, so a session whose pty died under it stops rendering a dead
// terminal.
//
// Two independent things know a session's terminal is gone, and they do not
// arrive together:
//
//   * the WEBSOCKET, immediately — the server refuses the attach with 4404
//     (CLOSE_NOT_RUNNING) and `useLiveTerm` parks in state `'stopped'` without
//     retrying;
//   * the SESSION ROW, a detector tick later — the status flips to `stopped`
//     over SSE.
//
// The focus panes keyed off the row alone, so in the gap (and forever, when the
// server never flipped the row — the holder-death incident) the user was left
// staring at a frozen terminal with no Start affordance and input that 500s.
// This hook closes the gap: the first 4404 renders the stopped surface right
// away and asks the sessions list to refetch, so the row catches up instead of
// being contradicted.
//
// It clears itself on a RESTART — the row entering `starting`, which only a
// Start/Resume produces — so the pane goes straight back to a live terminal.
//
// Deliberately NOT "any status that is not stopped". The row is exactly the
// thing this hook exists because it cannot be trusted: when the backend never
// flipped it, the status sits on `active` while the pty is gone, so clearing on
// "not stopped" un-latches on the very next SSE delta, remounts the terminal,
// takes another 4404, latches again — a flicker loop that renders the stopped
// surface and a doomed terminal in alternation. `starting` is a fact only a
// deliberate (re)start writes, and it is always written before the session can
// be running again.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { LiveTermState } from '@/hooks/use-live-term'
import { SESSIONS_KEY } from '@/hooks/use-sessions'

export interface UseTerminalGoneResult {
  /** The WS proved the pty is gone while the row still said otherwise. */
  gone: boolean
  /** Pass to `<LiveTerminal onStateChange>`. */
  onTermState: (state: LiveTermState) => void
}

export function useTerminalGone(status: string): UseTerminalGoneResult {
  const qc = useQueryClient()
  const [gone, setGone] = React.useState(false)

  const onTermState = React.useCallback(
    (state: LiveTermState) => {
      if (state !== 'stopped') return
      setGone(true)
      // The row is stale by definition here — pull the truth rather than wait
      // for a delta that may already have been missed.
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
    },
    [qc],
  )

  // The restart EDGE — the row entering `starting` from anything else — drops
  // the latch, so the terminal that mounts next is one a real (re)start is
  // standing up. This is a genuine synchronise-with-external-state reset (the
  // row comes from SSE, not from React), and gating it on the transition rather
  // than the value means a row that merely keeps repeating `starting`, or one
  // that lies about being `active`, never clears it.
  const prevStatus = React.useRef(status)
  React.useEffect(() => {
    const restarted = status === 'starting' && prevStatus.current !== 'starting'
    prevStatus.current = status
    if (restarted) setGone(false)
  }, [status])

  return { gone, onTermState }
}
