// useStartAgent — the ONE source of truth for "start an agent on an issue".
//
// The board exposes the same gesture from several places: the card's primary
// action, the detail sheet's Agent section + picker, drag-to-`doing`, and the
// ⌘K "Start agent on <issue>" verb. Each used to hand-roll the identical
// sequence; that whole flow now lives here, once:
//
//   1. run the unified Start action (`boardApi.start`) — make the issue
//      agent-owned, attach an existing session OR spawn a new one, then deliver,
//   2. on a delivered start, toast "Sent to <session>" with an Undo action that
//      retracts the still-undelivered steer via `boardApi.unsend(session, id)`,
//   3. on a non-delivered outcome, toast a plain-language confirmation,
//   4. surface a failure (incl. the 409 already-working race) as a toast.
//
// Call sites pass the small bits that legitimately differ — HOW to run the start
// (direct `boardApi.start` vs the optimistic `board.startIssue` mutation), the
// exact copy, and how a conflict should surface (a toast vs an in-place form
// error) — and get identical behavior.
//
// Back-compat: `useSendToAgent` is an alias of `useStartAgent`, and the returned
// `sendToAgent(...)` keeps the legacy options (incl. a custom `claim` runner +
// `deliver`) so the not-yet-migrated card/sheet/route keep compiling and working
// until later refactors move them onto `startAgent`. NOTE: "claim" survives only as an
// internal symbol — it never appears in any user-facing string.

import { useCallback } from 'react'

import { boardApi, BoardError, type ClaimResult, type StartSpawn } from '@/lib/api'
import { useToast, type ToastTone } from '@/components/ui/use-toast'

/** How a single "start agent" should run + present. Only `id` is required; pass
 *  `session` to attach an existing agent OR `spawn` to create a new one. */
export interface StartAgentOptions {
  /** The issue to start an agent on. */
  id: string
  /** Attach to an existing live session. */
  session?: string
  /** Spawn a NEW session for the issue (name auto-derived server-side). */
  spawn?: StartSpawn

  /** Run the actual start. Defaults to a direct `boardApi.start` (no optimistic
   *  cache move). Pass the board's optimistic mutation
   *  (`(a) => board.startIssue(a)`) when the caller wants the card to slide to
   *  `doing` immediately + roll back on a conflict. */
  start?: (args: {
    id: string
    session?: string
    spawn?: StartSpawn
  }) => Promise<ClaimResult>

  /** Decide whether an outcome counts as a delivered "send" (the Sent toast) vs
   *  a no-dispatch assignment. Defaults to "delivered AND we have a steer_id to
   *  Undo". The Undo action only attaches when `steer_id != null`. */
  isSent?: (result: ClaimResult) => boolean

  /** Message + tone for a successful delivered send. Defaults to "Sent to
   *  <session>" / `active`. Receives the result so copy can vary. */
  sentMessage?: (result: ClaimResult) => string
  sentTone?: ToastTone
  /** Auto-dismiss for the sent toast (ms). Omit for the toast system default. */
  sentDuration?: number

  /** Message for a start that did NOT deliver. Default "Agent started." */
  assignedMessage?: (result: ClaimResult) => string
  /** Tone for the non-delivered toast. Default `default`. */
  assignedTone?: ToastTone

  /** Outcome of the Undo (unsend). `cleared > 0` ⇒ retracted in time; `0` ⇒ the
   *  agent already picked it up. Default: silent on success, swallow failures. */
  onUndone?: (cleared: number) => void
  onUndoError?: (error: unknown) => void

  /** Called after a successful start (delivered OR not), before the toast. The
   *  detail sheet uses this to close itself. */
  onSuccess?: (result: ClaimResult) => void

  /** Route a failure. Default: toast the message (409-aware) with `error` tone. */
  onError?: (error: unknown) => void
}

/** Legacy options for the back-compat `sendToAgent(...)`. Superset of the start
 *  options that additionally accepts a `deliver` flag, a custom `claim` runner,
 *  and the old copy keys — so the not-yet-migrated call sites keep working.
 *  `session` is required here (the legacy contract always passed one). */
export interface SendToAgentOptions
  extends Omit<StartAgentOptions, 'id' | 'session' | 'spawn' | 'start'> {
  id: string
  session: string
  /** When false, flip the link without dispatching (no Undo). Defaults true. */
  deliver?: boolean
  /** Run the actual claim (legacy: direct `boardApi.claim` or the optimistic
   *  `board.claimIssue`). Defaults to `boardApi.start` for the attach case.
   *  Internal symbol only — never surfaces "claim" to the user. */
  claim?: (args: {
    id: string
    session: string
    deliver: boolean
  }) => Promise<ClaimResult>
  /** @deprecated legacy alias for {@link StartAgentOptions.assignedMessage}.
   *  Kept so the not-yet-migrated card/sheet keep compiling; copy never says
   *  "claim" in any default. */
  claimedMessage?: (result: ClaimResult) => string
  /** @deprecated legacy alias for {@link StartAgentOptions.assignedTone}. */
  claimedTone?: ToastTone
}

export interface StartAgentApi {
  /** Run one start-agent per {@link StartAgentOptions}. Never throws — every
   *  outcome is routed through the toast / callbacks. */
  startAgent: (opts: StartAgentOptions) => Promise<void>
  /** Back-compat alias of {@link startAgent} for the legacy call sites that pass
   *  `{ id, session, deliver?, claim? }`. Routes through the same flow. */
  sendToAgent: (opts: SendToAgentOptions) => Promise<void>
}

/** Friendly message for a start failure — 409 (already being worked) gets a
 *  specific line; anything else falls back to its own message. The exported name
 *  keeps `claim` for back-compat with the not-yet-migrated call sites, but the
 *  RETURNED copy never says "claim". */
export function claimErrorMessage(error: unknown): string {
  if (error instanceof BoardError && error.status === 409) {
    return error.message || 'Another session is already on this.'
  }
  return error instanceof Error ? error.message : 'Couldn’t start the agent.'
}

/** Shared runner: invoke `run`, then route the outcome through the toast +
 *  callbacks. `targetLabel` is the session name (for default copy) — for a spawn
 *  the server-confirmed `result.issue.session` is preferred once it resolves. */
function makeRunner(toast: ReturnType<typeof useToast>['toast']) {
  return async (
    run: () => Promise<ClaimResult>,
    opts: {
      isSent: (r: ClaimResult) => boolean
      sentMessage: (r: ClaimResult) => string
      sentTone: ToastTone
      sentDuration?: number
      assignedMessage: (r: ClaimResult) => string
      assignedTone?: ToastTone
      delivered: boolean
      onUndone?: (cleared: number) => void
      onUndoError?: (error: unknown) => void
      onSuccess?: (r: ClaimResult) => void
      onError?: (error: unknown) => void
    },
  ) => {
    try {
      const result = await run()
      opts.onSuccess?.(result)

      // The session the work actually went to — prefer the server-confirmed link
      // (handles the spawn case, where the caller didn't know the name up front).
      const target = result.issue.session
      if (opts.delivered && opts.isSent(result)) {
        const steerId = result.steer_id
        toast({
          message: opts.sentMessage(result),
          tone: opts.sentTone,
          duration: opts.sentDuration,
          action:
            steerId != null && target
              ? {
                  label: 'Undo',
                  onClick: () => {
                    void boardApi
                      .unsend(target, steerId)
                      .then((r) => opts.onUndone?.(r.cleared))
                      .catch((e) => opts.onUndoError?.(e))
                  },
                }
              : undefined,
        })
      } else {
        toast({ message: opts.assignedMessage(result), tone: opts.assignedTone })
      }
    } catch (error) {
      if (opts.onError) {
        opts.onError(error)
      } else {
        toast({ message: claimErrorMessage(error), tone: 'error' })
      }
    }
  }
}

/**
 * The shared start-agent flow (start → "Sent to" toast w/ Undo → unsend). One
 * implementation, every call site.
 */
export function useStartAgent(): StartAgentApi {
  const { toast } = useToast()

  const startAgent = useCallback(
    async (opts: StartAgentOptions) => {
      const {
        id,
        session,
        spawn,
        start = (a) => boardApi.start(a.id, { session: a.session, spawn: a.spawn }),
        isSent = (r) => r.delivered && r.steer_id != null,
        sentMessage = (r) => `Sent to ${r.issue.session ?? session ?? 'the agent'}`,
        sentTone = 'active',
        sentDuration,
        assignedMessage = () => 'Agent started.',
        assignedTone,
        onUndone,
        onUndoError,
        onSuccess,
        onError,
      } = opts

      const run = makeRunner(toast)
      await run(() => start({ id, session, spawn }), {
        isSent,
        sentMessage,
        sentTone,
        sentDuration,
        assignedMessage,
        assignedTone,
        delivered: true,
        onUndone,
        onUndoError,
        onSuccess,
        onError,
      })
    },
    [toast],
  )

  const sendToAgent = useCallback(
    async (opts: SendToAgentOptions) => {
      const {
        id,
        session,
        deliver = true,
        // Legacy runner: a custom `claim` (when given) or the unified start.
        claim,
        isSent = (r) => r.delivered && r.steer_id != null,
        sentMessage = () => `Sent to ${session}`,
        sentTone = 'active',
        sentDuration,
        // Honour the legacy `claimedMessage`/`claimedTone` keys (deprecated) and
        // the new `assignedMessage`/`assignedTone`, in that fallback order.
        assignedMessage = opts.claimedMessage ?? (() => `Agent on ${session}.`),
        assignedTone = opts.claimedTone,
        onUndone,
        onUndoError,
        onSuccess,
        onError,
      } = opts

      const runStart = (): Promise<ClaimResult> =>
        claim
          ? claim({ id, session, deliver })
          : boardApi.start(id, { session })

      const run = makeRunner(toast)
      await run(runStart, {
        isSent,
        sentMessage,
        sentTone,
        sentDuration,
        assignedMessage,
        assignedTone,
        delivered: deliver,
        onUndone,
        onUndoError,
        onSuccess,
        onError,
      })
    },
    [toast],
  )

  return { startAgent, sendToAgent }
}

/** Back-compat alias — the canonical hook is now {@link useStartAgent}. The
 *  not-yet-migrated card/sheet/route import `useSendToAgent`; keep it working. */
export const useSendToAgent = useStartAgent
