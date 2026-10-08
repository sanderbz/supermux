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
  markInlineOwned,
  reconcile,
  settleReceipted,
  settleUndelivered,
  watchdogState,
  WATCHDOG_MS,
  type PendingSend,
  type SendReceipt,
} from './pending'
import { sendGate, type ComposerNotice } from './use-composer'
import { getDraft, setDraft } from './composer-draft'
import { sendFailureNote } from './send-errors'

/* ── the store ───────────────────────────────────────────────────────────── */

const store = new Map<string, readonly PendingSend[]>()
const listeners = new Map<string, Set<() => void>>()
const EMPTY: readonly PendingSend[] = []
const inFlight = new Map<string, Promise<void>>()

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

let seq = 0

/**
 * A stable idempotency key for one send, reused verbatim across its retries.
 *
 * Not `crypto.randomUUID`: supermux is served over plain HTTP on tailnet/LAN
 * origins, where `randomUUID` is undefined (it requires a secure context). A
 * per-page-load random base + the monotonic `seq` is unique enough for the
 * server's per-session dedup, and needs no secure context. The base keeps two
 * page loads (each restarting `seq` at 0) from minting the same id.
 */
const SEND_ID_BASE = Math.random().toString(36).slice(2, 10)
function mintSendId(n: number): string {
  return `${SEND_ID_BASE}-${n}`
}

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
  /** The session's MCP `elicitation` form is up. Same reason, stronger case:
   *  the peek lens cannot see this family at all (see `SendContext.formCard`),
   *  so a retry must refuse on the hook alone. */
  formCard?: boolean
  /** The server's delivery receipt (`last_send_text`/`last_send_at`), or null
   *  when the session has never received a submission. */
  receipt?: SendReceipt | null
  /** The chat socket is known-dead (A6 T2.5). The watchdog measures echo
   *  arrival in the transcript, and the transcript rides that socket — so
   *  while it is down, silence is evidence about the socket and nothing else.
   *  See `pending.ts::watchdogState`. */
  planeDown?: boolean
  /** Clear only the unchanged attachment selection after a successful retry. */
  onRetrySent?: (send: PendingSend) => void
}

export interface PendingSendsHandle {
  /** Oldest-first, reconciled, with the watchdog applied. Display truth. */
  items: readonly PendingSend[]
  /** The input plane WITH tracking — hand this one to `useComposer`. */
  input: SessionInput
  retry: (id: string) => void
  dismiss: (id: string) => void
  /** The T5 Attention cause this hook raises — always null since the inline
   *  row became the single owner of a failed send. Kept in the shape so the
   *  panel's `topAttention([…])` list still reads as "every raiser, ranked",
   *  and so a future connection-level raiser has somewhere to land. */
  attention: PendingAttention | null
}

export function usePendingSends({
  name,
  input,
  peek,
  entries,
  active,
  dialogCard = false,
  formCard = false,
  receipt = null,
  planeDown = false,
  onRetrySent,
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

  // SETTLE the rows the transcript has moved past — a queued mid-turn send whose
  // promoted echo fell out of the recall window before `reconcile` could match it
  // (`settleReceipted`, #45), AND a LOST-RESPONSE `undelivered` row whose echo was
  // likewise evicted on a long turn but whose delivery the answer + aliveness
  // prove (`settleUndelivered`, IMG_2451) — THEN reconcile the in-window echoes
  // away. All three only ever REMOVE, so they compose in one pass; the settles
  // read `active`/`sawActiveSince` so a genuinely-still-queued or genuinely-lost
  // send keeps its indicator until the transcript actually proves otherwise. Done
  // in RENDER (so a confirmed send never survives a frame as an echo) and pruned
  // into the store in an effect — the guard in `update` stops the loop.
  const live = reconcile(
    settleUndelivered(settleReceipted(acked, entries, { active }), entries, {
      active,
      sawActiveSince,
    }),
    entries,
    nowMs,
  )
  React.useEffect(() => {
    update(name, (cur) => {
      const settled = settleUndelivered(
        settleReceipted(cur, entries, { active }),
        entries,
        { active, sawActiveSince },
      )
      const next = reconcile(settled, entries, serverNowMs())
      return next.length === cur.length ? cur : next
    })
  }, [name, entries, active, sawActiveSince])

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

  const retryContext = React.useRef({ dialogCard, formCard, onRetrySent })
  React.useLayoutEffect(() => { retryContext.current = { dialogCard, formCard, onRetrySent } }, [dialogCard, formCard, onRetrySent])

  const deliver = React.useCallback((p: PendingSend, verify: boolean): Promise<void> => {
    const key = `${name}:${p.id}`
    const running = inFlight.get(key)
    if (running) return running
    const sendId = p.sendId ?? mintSendId(++seq)
    patch(name, p.id, {
      state: 'sending', atMs: serverNowMs(), note: undefined, transportError: false, sendId,
      receiptAtS: receiptRef.current?.atS ?? 0, activeAtSend: activeRef.current,
      seen: entriesRef.current.length ? new Set(entriesRef.current.map(e => e.uuid)) : null,
    })
    const attempt: Promise<void> = (async () => {
      try {
        const lens = verify && peek ? await peek.refresh() : null
        const gate = verify ? sendGate(lens, retryContext.current) : { send: true as const }
        if (!gate.send) throw Object.assign(new Error(refusalNote(gate.notice)), { status: 409 })
        await input.submit(p.text, { sendId })
        patch(name, p.id, {
          // Stamp receipt arrival: a slow POST must not consume the echo deadline.
          state: 'unconfirmed', atMs: serverNowMs(), receipted: true,
          note: 'notice' in gate && gate.notice ? refusalNote(gate.notice) : undefined,
        })
        if (verify) {
          // Retry sends the saved message, never the currently edited draft.
          // Clear only the original text; a new or edited draft remains intact.
          const original = p.composerDraft ?? p.text
          if (getDraft(name) === original) setDraft(name, '')
          retryContext.current.onRetrySent?.(p)
        }
      } catch (err) {
        patch(name, p.id, { state: 'undelivered', note: sendFailureNote(err), transportError: isTransportError(err) })
        throw markInlineOwned(err)
      }
    })().finally(() => { if (inFlight.get(key) === attempt) inFlight.delete(key) })
    inFlight.set(key, attempt)
    return attempt
  }, [input, name, peek])

  const submit = React.useCallback((text: string, opts?: Parameters<SessionInput['submit']>[1]): Promise<void> => {
    // Enter on an unchanged failed draft is the same logical send as Retry.
    // Keep its row/key, including ambiguous lost responses. An edited message
    // gets its own identity; an acknowledged prior message is not a retry.
    const existing = snapshot(name).findLast(p => p.text === text && !p.receipted &&
      (p.state === 'undelivered' || inFlight.has(`${name}:${p.id}`)))
    if (existing) return deliver(existing, false)
    const n = ++seq
    const p: PendingSend = {
      id: `send-${n}`, text, atMs: serverNowMs(), state: 'sending', sendId: mintSendId(n),
      composerDraft: opts?.composer?.draft, attachmentPrefix: opts?.composer?.attachmentPrefix,
      seen: entriesRef.current.length ? new Set(entriesRef.current.map(e => e.uuid)) : null,
      receiptAtS: receiptRef.current?.atS ?? 0, activeAtSend: activeRef.current,
    }
    update(name, cur => [...cur, p])
    return deliver(p, false)
  }, [deliver, name])

  const tracked = React.useMemo<SessionInput>(() => ({ ...input, submit }), [input, submit])
  const retry = React.useCallback((id: string) => {
    const p = snapshot(name).find(send => send.id === id)
    if (!p || p.state === 'sending' || p.receipted) return
    void deliver(p, true).catch(() => { /* The retained row owns this failure. */ })
  }, [deliver, name])

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
    // NO CARD FROM HERE. Every undelivered send has a bubble, and the row under
    // that bubble already states the failure and offers the Retry — so a card
    // saying the same sentence a third of a screen higher is the second of
    // three sayings of one fact (the third was the composer banner, now
    // suppressed by `markInlineOwned`). The cause and its copy stay in
    // `attention.ts` for a failure that has NO bubble to attach to; this hook
    // is not that raiser.
    attention: null as PendingAttention | null,
  }
}

/**
 * Was this a TRANSPORT failure — the POST left but no response came back — as
 * opposed to a server REFUSAL with a definite verdict?
 *
 * `sessions.ts` throws `SessionError('Can’t reach supermux-server.', 0)` when
 * `fetch` itself rejects (network down, server restarting, the reply lost on a
 * flaky link): status 0 is exactly the ambiguous "may have been delivered" case
 * `settleUndelivered` is allowed to clear on later transcript proof. A refusal
 * (409 and friends) carries its real HTTP status and is NEVER treated as one:
 * the server answered, and the answer was "no". A rejection with no numeric
 * `status` (a bare `fetch` `TypeError`, a thrown string) is likewise a transport
 * failure — it never reached a server that could refuse it.
 */
function isTransportError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status
    return typeof status === 'number' && status === 0
  }
  return true
}

/** Why a RETRY was refused, in the row itself — the retry path has no composer
 *  banner to borrow. The same two facts `composer.tsx`'s `NOTICE_TITLE` states
 *  for the send path; T5's `attention.ts` is where this copy consolidates. */
function refusalNote(notice: ComposerNotice): string {
  if (notice.kind === 'dialog' || notice.kind === 'dialog-form') return 'Answer the request above before retrying.'
  if (notice.kind === 'dialog-terminal') {
    return 'The terminal is showing a prompt chat can’t answer — answer it there.'
  }
  if (notice.kind === 'tui-draft-unverified') {
    return 'Sent — the terminal’s prompt wasn’t empty, and chat couldn’t tell that text from Claude’s own suggestion.'
  }
  return 'Finish or clear the draft in Terminal, then retry.'
}
