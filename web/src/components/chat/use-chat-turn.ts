// The A1 turn state machine, lifted verbatim out of `chat-panel.tsx`
// (fase A3 T1). This is BEHAVIOUR, not presentation: the turn anchor and its
// priority rule, the supersede gate, the bounded teardown, the zero-debounce
// turn-end refetch and the 1s live-layer ticker. Nothing here decides what
// anything looks like — `chat-panel.tsx` / `chat-surface.tsx` own that.
//
// Layer model (a0-findings §1): the TRANSCRIPT is the confirming layer
// (batch-flushed, prose p50 31s); the LIVE layer is the status flip + hook
// receipts + the provisional pty tail. Provisional content is discarded and
// replaced on confirmation, never merged.
//
// Import direction: this module may import the pure A1 layer (`entries`,
// `latency`) and the A1 data hooks; nothing in `components/chat/ui/*` may
// import it.

import * as React from 'react'

import type { UseQueryResult } from '@tanstack/react-query'

import type { RecallResponse } from '@/lib/api'
import type { TileSession } from '@/components/session-tile/types'

import { newestAgentTs, toDisplayList, type ChatEntry, type ChatItem } from './entries'
import { useChatTail } from './use-chat-tail'
import { useReceiptOverlay, type OverlayLine } from './use-receipt-overlay'
import { serverNowMs } from './latency'

/** Only show the provisional tail when the transcript is clearly BEHIND the
 *  live turn — right after a batch lands the pty text is confirmed content
 *  and showing it again would duplicate (the A1 anti-glitch heuristic). */
const PROVISIONAL_LAG_MS = 5_000
/** How recent `last_send_at` must be at the flip to count as THIS turn's
 *  anchor (terminal-typed sends never stamp it, so it can be stale). */
const SEND_ANCHOR_WINDOW_MS = 30_000
/** Bounded fallback teardown: a turn whose confirming batch never lands (an
 *  interrupt, a compact, an unreadable transcript) must not strand the live
 *  layer polling `/peek` once a second forever. Well past the a0 confirm
 *  latency (text-only p50 31s) so it never fires on a healthy turn. */
const TURN_CONFIRM_TIMEOUT_MS = 120_000

export interface ChatTurn {
  /** Newest-first wire entries (memoised identity). */
  entries: ChatEntry[]
  /** Oldest-first display items (`toDisplayList`). */
  items: ChatItem[]
  /** SERVER-clock ms anchor for the running turn; null = no live turn. */
  turnStart: number | null
  /** The live layer is mounted (turn running OR awaiting its confirmation). */
  liveLayerUp: boolean
  /** The transcript is far enough behind to show the provisional pty tail. */
  showProvisional: boolean
  /** Hook-driven receipt overlay lines for this turn. */
  overlay: OverlayLine[]
  /** The `/recall?chat=true` query itself (loading/error/refetch). */
  tail: UseQueryResult<RecallResponse>
}

export function useChatTurn(name: string, session: TileSession | null): ChatTurn {
  const active = session?.status === 'active'
  const tail = useChatTail(name, true)
  // Memoised so the `?? []` fallback doesn't hand `toDisplayList` a fresh
  // array identity on every render (it would recompute the whole list each
  // 1s live-layer tick).
  const entries = React.useMemo(
    () => (tail.data?.entries ?? []) as unknown as ChatEntry[],
    [tail.data],
  )
  const items = React.useMemo(() => toDisplayList(entries), [entries])
  const lastConfirmedTs = entries.length > 0 ? entries[0].ts : 0
  const lastConfirmedMs = lastConfirmedTs * 1000

  // Turn tracking, SERVER clock domain. Anchor priority: the server's
  // last_send_at stamp (the dock/API send that started the turn — makes the
  // elapsed clause count from the SEND even when this panel mounts mid-turn),
  // else skew-corrected server-now at the flip. Never raw Date.now().
  const [turnStart, setTurnStart] = React.useState<number | null>(null)
  const lastSendAt = session?.last_send_at
  React.useEffect(() => {
    if (!active) return
    // The turn anchor is stamped from the SERVER-clock edge of an external
    // event (the SSE status flip), not derived from render state; the updater
    // returns `prev` unchanged once an anchor exists, so it cannot cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTurnStart((prev) => {
      if (prev != null) return prev
      const now = serverNowMs()
      const sendMs = (lastSendAt ?? 0) * 1000
      return sendMs > 0 && now - sendMs < SEND_ANCHOR_WINDOW_MS ? sendMs : now
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Supersede gate (checkpoint (c)): the live layer tears down only once the
  // AGENT's confirming batch for THIS turn is in hand — never on the bare
  // status flip, which would leave a blank gap while the batch is still in
  // flight. The gate deliberately ignores USER-authored entries: Claude writes
  // the user turn to the JSONL within ~1s of the send, and with the
  // `last_send_at` anchor (every dock/REST/WS send stamps it — i.e. the whole
  // dogfood path) that echo's second-truncated `ts` is always ≥ turnStart, so
  // an any-entry gate is satisfied by the user's own message and degrades to
  // exactly the bare-flip teardown it exists to prevent.
  const lastAgentMs = React.useMemo(() => newestAgentTs(entries) * 1000, [entries])
  const confirmedCaughtUp = turnStart != null && lastAgentMs >= turnStart
  const turnStranded =
    turnStart != null && serverNowMs() - turnStart > TURN_CONFIRM_TIMEOUT_MS
  React.useEffect(() => {
    // Turn teardown on the (status flip + confirmed batch) edge — both are
    // external events; the guard makes it fire at most once per turn.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!active && (confirmedCaughtUp || turnStranded)) setTurnStart(null)
  }, [active, confirmedCaughtUp, turnStranded])

  // Turn end → confirm NOW (zero debounce; the mid-turn debounce only exists
  // to coalesce delta bursts).
  const refetch = tail.refetch
  React.useEffect(() => {
    if (!active && turnStart != null) void refetch()
  }, [active, turnStart, refetch])

  // 1s live-layer ticker: a prose-only turn produces NO deltas and NO
  // refetches, so every time-gated piece below (showProvisional, elapsed,
  // footer stats) must re-render on its own clock or it never appears.
  const liveLayerUp = active || turnStart != null
  const [, tick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (!liveLayerUp) return
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [liveLayerUp])

  const overlay = useReceiptOverlay(session, turnStart, lastConfirmedTs)

  // Shown while the transcript is behind the live turn; liveLayerUp keeps it
  // (and the overlay) mounted through the post-Stop confirmation window, so
  // the answer never blanks out before its confirmed form arrives.
  const showProvisional =
    liveLayerUp &&
    turnStart != null &&
    serverNowMs() - lastConfirmedMs > PROVISIONAL_LAG_MS

  return { entries, items, turnStart, liveLayerUp, showProvisional, overlay, tail }
}
