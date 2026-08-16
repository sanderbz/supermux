// The pending-send STORE and the delivery watchdog's timer (fase A4 T4).
//
// `pending.ts` decides *whether* an echo has landed and *when* to stop
// believing in it; this module is everything that has to be stateful for it to
// work — the per-session store, the tracked submit, the aliveness ledger, and
// exactly one timer.
//
// WHY MODULE-LEVEL, like the draft store next door: an echo has to survive the
// panel unmounting. Toggling to Terminal and back is a remount, and a send that
// quietly stopped being tracked because the user looked at the pty for a moment
// is precisely the failure P10 exists to make impossible. Per session, because
// a send belongs to the session it was typed into and to no other.
//
// NO NEW INTERVAL (the plan's rule): the evaluation rides the 1s live-layer
// ticker (`use-chat-turn`) while a turn runs, and the ONE timer below is a
// one-shot deadline, armed only while a send is unconfirmed and cleared the
// moment it is not. A session that dies has no ticker — which is exactly the
// case the watchdog exists for — so a re-render at the deadline must be armed
// rather than hoped for.
//
// A2-SEAM: entries come from the chat WS `entry` frame instead of the recall
// poll; `reconcile` is unchanged — it reads a display model, not a transport.

import * as React from 'react'

import type { SessionInput } from '../../lib/session-input'

import type { AttentionCause } from './attention'
import type { ChatEntry } from './entries'
import { serverNowMs } from './latency'
import type { PeekLens } from './peek-lens'
import {
  applyReceipt,
  latchUndelivered,
  reconcile,
  watchdogState,
  WATCHDOG_MS,
  type PendingSend,
  type SendReceipt,
} from './pending'
import { sendGate, type ComposerNotice } from './use-composer'

/* ── the store ───────────────────────────────────────────────────────────── */

const store = new Map<string, readonly PendingSend[]>()
const listeners = new Map<string, Set<() => void>>()
const EMPTY: readonly PendingSend[] = []

function snapshot(name: string): readonly PendingSend[] {
  return store.get(name) ?? EMPTY
}

function subscribe(name: string, fn: () => void): () => void {
  const set = listeners.get(name) ?? new Set<() => void>()
  set.add(fn)
  listeners.set(name, set)
  return () => {
    set.delete(fn)
    if (set.size === 0) listeners.delete(name)
  }
}

/** Write, and tell the subscribers — but only when something actually moved,
 *  so a no-op reconcile pass cannot loop the render it runs in. */
function update(
  name: string,
  fn: (cur: readonly PendingSend[]) => readonly PendingSend[],
): void {
  const cur = snapshot(name)
  const next = fn(cur)
  if (next === cur) return
  if (next.length === 0) store.delete(name)
  else store.set(name, next)
  listeners.get(name)?.forEach((notify) => notify())
}

function patch(name: string, id: string, fields: Partial<PendingSend>): void {
  update(name, (cur) => {
    if (!cur.some((p) => p.id === id)) return cur
    return cur.map((p) => (p.id === id ? { ...p, ...fields } : p))
  })
}

/** Test/bench escape hatch: forget everything this session has pending. */
export function clearPendingSends(name: string): void {
  update(name, (cur) => (cur.length === 0 ? cur : EMPTY))
}

let seq = 0

/* ── the hook ────────────────────────────────────────────────────────────── */

/** The T5 causes this module can raise. Narrowed out of the full union on
 *  purpose: `attention.ts` owns the causes AND the copy — this is the one a send
 *  can produce, and nothing here writes a sentence for it. `Extract` rather than
 *  a re-typed literal so renaming the cause breaks this file at compile time. */
export type PendingAttention = Extract<AttentionCause, 'send-unconfirmed'>

export interface UsePendingSendsOptions {
  name: string
  /** The RAW input plane. The tracked one comes back out of the hook. */
  input: SessionInput
  /** The shared peek lens (T2). A RETRY re-runs the same pre-send gate the
   *  composer runs — the terminal can have grown a draft in the seconds since
   *  the send failed, and a retry is a send like any other. */
  peek?: { refresh: () => Promise<PeekLens | null> }
  /** Newest-first wire entries — the CONFIRMING layer. */
  entries: readonly ChatEntry[]
  /** `session.status === 'active'` right now, for the aliveness ledger. */
  active: boolean
  /** A choice card is on screen (the session's `permission_request`) — a RETRY
   *  runs the same pre-send gate the composer does, and the gate needs the same
   *  second source. */
  dialogCard?: boolean
  /** The server's delivery receipt (`last_send_text`/`last_send_at`), or null
   *  when the session has never received a submission. */
  receipt?: SendReceipt | null
  /** The chat socket is known-dead (A6 T2.5). The watchdog measures echo
   *  arrival in the transcript, and the transcript rides that socket — so
   *  while it is down, silence is evidence about the socket and nothing else.
   *  See `pending.ts::watchdogState`. */
  planeDown?: boolean
}

export interface PendingSendsHandle {
  /** Oldest-first, reconciled, with the watchdog applied. Display truth. */
  items: readonly PendingSend[]
  /** The input plane WITH tracking — hand this one to `useComposer`. */
  input: SessionInput
  retry: (id: string) => void
  dismiss: (id: string) => void
  /** The T5 Attention cause an undelivered send raises, or null. */
  attention: PendingAttention | null
}

export function usePendingSends({
  name,
  input,
  peek,
  entries,
  active,
  dialogCard = false,
  receipt = null,
  planeDown = false,
}: UsePendingSendsOptions): PendingSendsHandle {
  const raw = React.useSyncExternalStore(
    React.useCallback((fn) => subscribe(name, fn), [name]),
    React.useCallback(() => snapshot(name), [name]),
    React.useCallback(() => snapshot(name), [name]),
  )

  // THE ALIVENESS LEDGER — when this session was last OBSERVED active, on the
  // server clock. Re-stamped for as long as the status reads active, not on the
  // active EDGE: a send made mid-turn has no edge to point at, and "the agent
  // has been working this whole time" is precisely the evidence that defers its
  // escalation (`watchdogState`). The 1s live-layer ticker is what makes "for
  // as long as" mean "once a second" without an interval of this module's own.
  const nowMs = serverNowMs()
  // Quantised to the second so the observation below is at most one write per
  // ticker tick — and so it is a legal dependency rather than a new-every-render
  // one, which is what keeps this effect off the exhaustive-deps escape hatch.
  const nowSec = Math.floor(nowMs / 1_000)
  const [activeAtMs, setActiveAtMs] = React.useState(0)
  React.useEffect(() => {
    if (!active) return
    // An OBSERVATION of an external system (the session's status over time),
    // which is what an effect is for. The updater returns `prev` unchanged when
    // the second has not moved, so it cannot cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveAtMs((prev) => Math.max(prev, nowSec * 1_000))
  }, [active, nowSec])
  const sawActiveSince = React.useCallback(
    (ms: number) => activeAtMs >= ms,
    [activeAtMs],
  )

  const [, tick] = React.useReducer((n: number) => n + 1, 0)

  // THE SERVER'S RECEIPT, folded in before anything else looks at the list: it
  // can un-escalate a row the watchdog gave up on, and that has to be true of
  // the STORE (it survives the renderer toggle) and not only of this render.
  const receiptText = receipt?.text ?? ''
  const receiptAtS = receipt?.atS ?? 0
  const receiptRef = React.useRef<SendReceipt | null>(receipt)
  React.useEffect(() => {
    receiptRef.current = receiptText ? { text: receiptText, atS: receiptAtS } : null
  }, [receiptText, receiptAtS])
  const acked = applyReceipt(raw, receipt)
  React.useEffect(() => {
    if (!receiptText) return
    update(name, (cur) => applyReceipt(cur, { text: receiptText, atS: receiptAtS }))
  }, [name, receiptText, receiptAtS])

  // Reconcile in RENDER (so a confirmed send never survives a frame as an echo)
  // and prune the store in an effect. `reconcile` only ever removes, so the two
  // converge in one pass and the guard in `update` stops the loop.
  const live = reconcile(acked, entries, nowMs)
  React.useEffect(() => {
    update(name, (cur) => {
      const next = reconcile(cur, entries, serverNowMs())
      return next.length === cur.length ? cur : next
    })
  }, [name, entries])

  // What is ALREADY on screen, for the clock-free half of reconciliation. A ref
  // rather than a dependency: it is read at the moment Enter is pressed, and a
  // `submit` identity that changed on every transcript refetch would rebuild the
  // tracked input handle (and therefore the composer's callbacks) once a second.
  const entriesRef = React.useRef(entries)
  React.useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  // The session's status, for the same reason and by the same means: `submit`
  // reads it at the moment Enter is pressed, and a dependency on it would
  // rebuild the tracked input handle (and the composer's callbacks) on every
  // turn boundary.
  const activeRef = React.useRef(active)
  React.useEffect(() => {
    activeRef.current = active
  }, [active])

  const items = live.map((p) => ({
    ...p,
    state: watchdogState(p, { nowMs, sawActiveSince, planeDown }),
  }))

  // LATCH THE ESCALATION. `watchdogState` promises that `undelivered`, once
  // said out loud, stays said — but it can only keep that promise for the state
  // it is HANDED, and until this writes it down the store still reads
  // `unconfirmed`. Unwritten, the row un-escalates the moment the session reads
  // active again for ANY reason — the user going to look at the pty and typing
  // there is enough — so the failure heals itself, Retry appears and disappears
  // under the cursor, and the next real one has already been taught to be
  // ignored. It is also what makes the escalation survive the renderer toggle
  // this whole store exists for.
  const escalated = items
    .filter((p) => p.state === 'undelivered')
    .map((p) => p.id)
    .join('\n')
  React.useEffect(() => {
    if (escalated === '') return
    const ids = new Set(escalated.split('\n'))
    update(name, (cur) => latchUndelivered(cur, ids))
  }, [escalated, name])

  // THE ONE TIMER. The earliest moment any surviving echo could escalate: its
  // own deadline, pushed out by whatever aliveness has been observed since (see
  // `watchdogState`). Recomputed every render, so while a turn runs it keeps
  // moving out and never fires; when the session goes quiet it stands still and
  // fires once, which is the whole mechanism.
  let deadline = 0
  for (const p of items) {
    if (p.state !== 'unconfirmed') continue
    const at = Math.max(p.atMs, activeAtMs) + WATCHDOG_MS
    deadline = deadline === 0 ? at : Math.min(deadline, at)
  }
  React.useEffect(() => {
    if (deadline === 0) return
    const id = window.setTimeout(
      tick,
      // +30ms so the re-render lands just PAST the deadline rather than on it.
      Math.max(0, deadline - serverNowMs()) + 30,
    )
    return () => window.clearTimeout(id)
  }, [deadline])

  const submit = React.useCallback(
    async (text: string) => {
      const id = `send-${++seq}`
      const atMs = serverNowMs()
      // The two BASELINES, captured before the POST leaves: what the transcript
      // already held (so no entry that was on screen can be mistaken for this
      // send's echo), and where the server's own last-send receipt stood (so a
      // newer one is evidence about THIS send).
      const seen: ReadonlySet<string> | null =
        entriesRef.current.length > 0
          ? new Set(entriesRef.current.map((e) => e.uuid))
          : null
      const receiptAt = receiptRef.current?.atS ?? 0
      // WAS A TURN ALREADY RUNNING? Read here and never again: ~200ms from now
      // the status flips because of THIS message, and a row that read the live
      // status would then say it was queued behind itself (`deliveryLine`).
      const wasActive = activeRef.current
      // Drawn BEFORE the POST resolves: the echo is the acknowledgement that
      // the user's Enter was received by this app, and it claims nothing more
      // than that until the state below says otherwise.
      update(name, (cur) => [
        ...cur,
        { id, text, atMs, state: 'sending', seen, receiptAtS: receiptAt, activeAtSend: wasActive },
      ])
      try {
        await input.submit(text)
        // RE-STAMPED on the response, not left at the moment the POST was
        // issued. `POST /send` is not fast by construction: it can AUTO-WAKE a
        // dead pty (`lifecycle.rs` `start()`, seconds) before it takes the
        // session lock and types. With the old stamp an 8s wake meant the send
        // was already past its 5s watchdog window the instant it succeeded —
        // "this didn't reach the session", with a Retry button, over a message
        // that had just landed (A4 review). The retry path always re-stamped;
        // this is the same rule, applied where the clock actually starts.
        patch(name, id, { state: 'unconfirmed', atMs: serverNowMs() })
      } catch (err) {
        patch(name, id, { state: 'undelivered', note: errorNote(err) })
        // Rethrown so the composer's own banner still speaks: the echo says
        // "this one did not land", the banner says "and your text is still in
        // the box". Two different facts, two different places.
        throw err
      }
    },
    [input, name],
  )

  const tracked = React.useMemo<SessionInput>(
    () => ({ ...input, submit }),
    [input, submit],
  )

  const retry = React.useCallback(
    (id: string) => {
      const p = snapshot(name).find((x) => x.id === id)
      // A POST in flight is not retryable — that is the double-send the
      // watchdog's `sending` state exists to prevent. Neither is one the SERVER
      // has already acknowledged typing into the pty: the row is not offering a
      // Retry in that state, and this is the belt to that braces.
      if (!p || p.state === 'sending' || p.receipted) return
      patch(name, id, {
        state: 'sending',
        atMs: serverNowMs(),
        note: undefined,
        // A retry is a new delivery: it needs its own receipt baseline, or the
        // receipt for the FIRST attempt would confirm it instantly — and its own
        // reading of whether a turn was already running, for the same reason.
        receiptAtS: receiptRef.current?.atS ?? 0,
        activeAtSend: activeRef.current,
      })
      void (async () => {
        try {
          const gate = sendGate(peek ? await peek.refresh() : null, { dialogCard })
          if (!gate.send) {
            patch(name, id, { state: 'undelivered', note: refusalNote(gate.notice) })
            return
          }
          await input.submit(p.text)
          // The watchdog clock restarts from the RETRY, not from the original
          // send: it is a new delivery, and it gets its own window.
          //
          // A gate that let the retry THROUGH with a notice still leaves its
          // sentence on the row: the terminal had something at its prompt that
          // this capture could not classify, and the row is the only place this
          // path can say so.
          patch(name, id, {
            state: 'unconfirmed',
            atMs: serverNowMs(),
            note: gate.notice ? refusalNote(gate.notice) : undefined,
          })
        } catch (err) {
          patch(name, id, { state: 'undelivered', note: errorNote(err) })
        }
      })()
    },
    [dialogCard, input, name, peek],
  )

  const dismiss = React.useCallback((id: string) => {
    update(name, (cur) => {
      const next = cur.filter((p) => p.id !== id)
      return next.length === cur.length ? cur : next
    })
  }, [name])

  return {
    items,
    input: tracked,
    retry,
    dismiss,
    attention: items.some((p) => p.state === 'undelivered') ? 'send-unconfirmed' : null,
  }
}

function errorNote(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined
}

/** Why a RETRY was refused, in the row itself — the retry path has no composer
 *  banner to borrow. The same two facts `composer.tsx`'s `NOTICE_TITLE` states
 *  for the send path; T5's `attention.ts` is where this copy consolidates. */
function refusalNote(notice: ComposerNotice): string {
  if (notice.kind === 'dialog') return 'Claude is waiting on the request above — answer it first.'
  if (notice.kind === 'dialog-terminal') {
    return 'The terminal is showing a prompt chat can’t answer — answer it there.'
  }
  if (notice.kind === 'tui-draft-unverified') {
    return 'Sent — the terminal’s prompt wasn’t empty, and chat couldn’t tell that text from Claude’s own suggestion.'
  }
  return 'The terminal has an unsent draft.'
}
