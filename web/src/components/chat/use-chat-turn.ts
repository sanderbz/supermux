// The turn state machine, lifted verbatim out of `chat-panel.tsx` (fase A3 T1)
// and re-pointed at the A2 socket. This is BEHAVIOUR, not presentation: the
// turn anchor and its priority rule, the supersede gate, the bounded teardown
// and the turn's time thresholds. Nothing here decides what anything looks
// like — `chat-panel.tsx` / `chat-surface.tsx` own that.
//
// NO TICKER. This hook is called at the TOP of `ChatPanel`, so anything that
// re-renders it re-renders the whole panel — and it used to do exactly that once
// a second, forever, for as long as a turn was live. Every clock on this surface
// is now a `LiveElapsed` leaf that advances by mutating its own text node, so
// nothing DISPLAYED needs the cadence; what is left are four time thresholds,
// each of which flips exactly once, and each of which is now woken by its own
// `setTimeout` at the moment it is crossed (`useWakeAt`).
//
// Data plane: `use-chat-ws` (the A2 chat WebSocket). The A1 `/recall?chat=true`
// poll it replaced also had a zero-debounce refetch on the turn-end edge; a
// pushed transcript has nothing to refetch, so that effect is gone with it.
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

import type { TileSession } from '@/components/session-tile/types'

import { newestAgentTs, toDisplayList, type ChatEntry, type ChatItem } from './entries'
import { useChatBacklog, type ChatBacklog } from './use-chat-backlog'
import { useChatWs, type ChatWireView } from './use-chat-ws'
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
/**
 * The honest ceiling on the confirm bridge, measured from the moment the session
 * LEFT `active` (the turn's real end), NOT from its start.
 *
 * Once the session is idle the turn is over — the pty is at its prompt, the
 * terminal renderer already shows it. The live layer is kept only long enough for
 * a genuine answer's confirming batch to REPLACE the provisional tail instead of
 * blanking it; a healthy turn clears the instant that batch lands
 * (`confirmedCaughtUp`), so this only governs the case where NO batch ever comes
 * — a cancel with no output. There the 120s `TURN_CONFIRM_TIMEOUT_MS` ceiling
 * (anchored to the turn START) left the chat plane "thinking" for up to two
 * minutes after the pty had gone quiet: the exact desync the owner hit. Anchored
 * to the idle edge and cut short, the chat plane settles to idle promptly instead.
 */
const IDLE_SETTLE_MS = 6_000

/**
 * Should the live-turn anchor be torn down?
 *
 * A turn is over once the session has LEFT `active`. The live layer is kept a
 * moment longer than the bare status flip so a genuine answer's confirming batch
 * can REPLACE the provisional pty tail instead of blanking it — that is
 * `confirmedCaughtUp`. It is torn down when any of these hold:
 *   · the confirming batch for THIS turn has landed (`confirmedCaughtUp`), or
 *   · the session reached a TERMINAL rest (`stopped`/`error`) — no batch is ever
 *     coming, so waiting for one strands the live layer on `/peek`; a cancelled
 *     turn that ends `stopped` used to sit "thinking" for a full 120s, or
 *   · the session has been idle past the confirm bridge (`idleSettled`) — the
 *     honest ceiling that reconciles the chat plane with a pty that is already at
 *     its prompt, so a cancel with no confirming batch does not keep "thinking",
 *     or
 *   · the absolute fallback ceiling elapsed (`turnStranded`).
 *
 * While the session is still `active` this NEVER fires: a live turn is not over
 * just because time passed. The one thing that can end a still-`active` turn is
 * the user's Stop, which reconciles imperatively (`endTurn`) rather than here.
 */
export function shouldEndTurn(a: {
  active: boolean
  turnStart: number | null
  confirmedCaughtUp: boolean
  turnStranded: boolean
  terminalRest: boolean
  idleSettled: boolean
}): boolean {
  if (a.turnStart == null) return false
  if (a.active) return false
  return a.confirmedCaughtUp || a.terminalRest || a.idleSettled || a.turnStranded
}

export interface ChatTurn {
  /** Newest-first wire entries (memoised identity). */
  entries: ChatEntry[]
  /** Oldest-first display items (`toDisplayList`). */
  items: ChatItem[]
  /** SERVER-clock ms anchor for the running turn; null = no live turn. */
  turnStart: number | null
  /** The live layer is mounted (turn running OR awaiting its confirmation). */
  liveLayerUp: boolean
  /** Reconcile the live turn to idle NOW — the honest half of Stop. Drops the
   *  client's turn anchor so the working row, the provisional tail and the Stop
   *  control all clear even when the server's `status` is lagging at `active`
   *  (a stuck last-capture, a cancel not yet re-read). */
  endTurn: () => void
  /** The transcript is far enough behind to show the provisional pty tail. */
  showProvisional: boolean
  /** Hook-driven receipt overlay lines for this turn. */
  overlay: OverlayLine[]
  /** The chat WebSocket's view of the data plane (loading / error / state). */
  tail: ChatWireView
  /** Pages BELOW the socket's window, and the affordance state for them
   *  (daily-driver QA #3). */
  backlog: ChatBacklog
}

/** How far past a threshold to wake, so a `>` comparison is already true when
 *  the re-render reads it (rather than costing a second wake 50ms later). */
const EDGE_SLACK_MS = 50

/**
 * Re-render ONCE when the server clock reaches `atMs`; `null` disarms.
 *
 * The edge-scheduled replacement for a polling tick: the caller passes the
 * instant its threshold flips and stops passing it once it has flipped, so the
 * timeout arms exactly once per crossing and cleans itself up. A floor keeps a
 * deadline that is already in the past (a clock-skew sample landing between
 * render and effect) from spinning.
 */
function useWakeAt(atMs: number | null, wake: () => void): void {
  React.useEffect(() => {
    if (atMs == null) return
    const id = window.setTimeout(wake, Math.max(50, atMs + EDGE_SLACK_MS - serverNowMs()))
    return () => window.clearTimeout(id)
  }, [atMs, wake])
}

export function useChatTurn(name: string, session: TileSession | null): ChatTurn {
  const active = session?.status === 'active'
  // The A2 socket: seeded once, then pushed. It replaces the A1 poll — there
  // is nothing left to refetch on the turn-end edge, because the confirming
  // batch arrives as `entry` frames the moment the tailer reads it (the
  // zero-debounce turn-end refetch that used to close that gap is gone with
  // the poll it was compensating for).
  const tail = useChatWs(name, true)
  // The socket's window is a WINDOW; this is that window plus whatever the user
  // has paged in above it, newest-first and deduped (QA #3), adapted once.
  // Every rule below reads the NEWEST end of the list, which back-pagination
  // never touches — an older page cannot change the turn anchor, the supersede
  // gate or the confirmed clock. Memoised inside the hook, so `toDisplayList`
  // is not recomputed on the 1s live-layer tick.
  const backlog = useChatBacklog(name, tail)
  const entries = backlog.entries
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
  // A TERMINAL rest can never produce a confirming batch, so the caught-up gate
  // would never satisfy and the live layer would strand until the 120s ceiling.
  const terminalRest = session?.status === 'stopped' || session?.status === 'error'

  // WHEN THE SESSION LEFT `active` — the turn's real end, stamped on the SSE
  // status edge (external event), server clock. The confirm bridge is measured
  // from here, not from the turn start: an idle session's turn is over, and the
  // chat plane must not keep "thinking" past a short settle just because the
  // start was recent (or, worse, until the 120s start-anchored ceiling). Cleared
  // to null while active, so a live turn has no idle edge.
  const [leftActiveAt, setLeftActiveAt] = React.useState<number | null>(null)
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLeftActiveAt(active ? null : serverNowMs())
  }, [active])
  const idleSettled =
    turnStart != null &&
    !active &&
    leftActiveAt != null &&
    serverNowMs() - leftActiveAt > IDLE_SETTLE_MS

  const endsTurn = shouldEndTurn({
    active,
    turnStart,
    confirmedCaughtUp,
    turnStranded,
    terminalRest,
    idleSettled,
  })
  React.useEffect(() => {
    // Turn teardown on the (confirmed batch / terminal rest / idle settle /
    // ceiling) edge — all external events; the guard fires it at most once per
    // turn (the anchor is null after, and only an idle→active edge re-arms it).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (endsTurn) setTurnStart(null)
  }, [endsTurn])

  // THE STOP RECONCILE — the honest half of the interrupt. When the user presses
  // Stop the turn is over from their side, but the server's `status` can lag at
  // `active` (a stuck last-capture, a cancel the supervisor has not re-read), and
  // while it does every live-turn signal reads `active` and the surface stays
  // "thinking" over a Stop that fires an Escape into a pty with nothing to
  // interrupt — a silent no-op. `endTurn` drops the anchor at once so the working
  // row, the provisional tail and the Stop control all clear. It cannot re-arm
  // from the same stale `active`: the anchor SET effect above is gated on an
  // `active` EDGE (idle→active), so a genuinely new turn re-anchors while a
  // stuck-`active` one stays cleared.
  const endTurn = React.useCallback(() => setTurnStart(null), [])

  const liveLayerUp = active || turnStart != null
  const [, wake] = React.useReducer((n: number) => n + 1, 0)

  const overlay = useReceiptOverlay(session, turnStart, lastConfirmedTs)

  // Shown while the transcript is behind the live turn; liveLayerUp keeps it
  // (and the overlay) mounted through the post-Stop confirmation window, so
  // the answer never blanks out before its confirmed form arrives.
  const showProvisional =
    liveLayerUp &&
    turnStart != null &&
    serverNowMs() - lastConfirmedMs > PROVISIONAL_LAG_MS

  // ── the four edges that used to be a per-second poll ──────────────────────
  //
  // Each of these is a one-way flip at a known instant, so it is scheduled for
  // that instant instead of re-checked 1× per second until it happens. A turn
  // that runs two minutes cost ~120 whole-panel renders and now costs at most
  // four (plus one per 30s label bucket). All of them are ALSO re-evaluated on
  // every real event — an SSE frame, a socket entry, a status flip — exactly as
  // they were before; the timeout is only what covers a prose-only turn that
  // produces no events at all.
  useWakeAt(
    // The provisional tail appears once the transcript is PROVISIONAL_LAG_MS
    // behind the live turn.
    liveLayerUp && turnStart != null && !showProvisional ? lastConfirmedMs + PROVISIONAL_LAG_MS : null,
    wake,
  )
  useWakeAt(
    // The confirm bridge closes IDLE_SETTLE_MS after the session left `active`.
    turnStart != null && !active && leftActiveAt != null && !idleSettled
      ? leftActiveAt + IDLE_SETTLE_MS
      : null,
    wake,
  )
  useWakeAt(
    // The absolute stranded-turn ceiling.
    turnStart != null && !turnStranded ? turnStart + TURN_CONFIRM_TIMEOUT_MS : null,
    wake,
  )
  useWakeAt(
    // THE 30s LABEL BUCKET. `chat-panel.tsx` derives `nowBucketMs` (relative
    // divider labels, and the connection chip's staleness ceiling) from the
    // server clock rounded to 30s — deliberately coarse, so a running turn does
    // not re-shape the transcript for labels that change once a minute. It was
    // the 1s ticker that carried it over each boundary; this is the same
    // boundary, woken directly. One render per 30s while a turn is live, which
    // is the granularity those readings already had.
    liveLayerUp ? (Math.floor(serverNowMs() / 30_000) + 1) * 30_000 : null,
    wake,
  )

  return { entries, items, turnStart, liveLayerUp, endTurn, showProvisional, overlay, tail, backlog }
}
