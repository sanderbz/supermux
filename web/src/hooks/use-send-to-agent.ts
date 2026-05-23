// useSendToAgent — the ONE source of truth for "send an issue to its agent".
//
// The board exposes the same gesture from four places: the card's hover Send
// button (U1), the detail sheet's primary action + picker (U2), drag-to-`doing`
// (U3), and the ⌘K "Send issue to session…" verb. Each used to hand-roll the
// identical sequence:
//
//   1. run the ATOMIC claim with deliver:true (§3.2.10 / S3),
//   2. on a delivered send, toast "Sent to <session>" with an Undo action that
//      retracts the still-undelivered steer via `boardApi.unsend(session, id)`,
//   3. on a claim-only / non-delivered outcome, toast "Claimed for <session>",
//   4. surface a failure (incl. the 409 lost-race) as a toast.
//
// That whole flow now lives here, once. Call sites pass the small bits that
// legitimately differ — HOW to run the claim (direct `boardApi.claim` vs the
// optimistic `board.claimIssue` mutation), the exact copy, and how a 409 should
// surface (a toast vs an in-place form error) — and get identical behavior.

import { useCallback } from 'react'

import { boardApi, BoardError, type ClaimResult } from '@/lib/api'
import { useToast, type ToastTone } from '@/components/ui/use-toast'

/** How a single "send to agent" should run + present. Only `id` and `session`
 *  are required; everything else tunes copy / claim mechanics / error routing so
 *  one hook can back all four call sites with no behavior change. */
export interface SendToAgentOptions {
  /** The issue to claim. */
  id: string
  /** The session to claim it for + deliver into. */
  session: string
  /** When false, "Claim only" — flip the link without dispatching (no Undo).
   *  Defaults to true (the user-chosen default). */
  deliver?: boolean

  /** Run the actual claim. Defaults to a direct `boardApi.claim` (no optimistic
   *  cache move). Pass the board's optimistic mutation
   *  (`(a) => board.claimIssue(a)`) when the caller wants the card to slide to
   *  `doing` immediately + roll back on a lost race. */
  claim?: (args: {
    id: string
    session: string
    deliver: boolean
  }) => Promise<ClaimResult>

  /** Decide whether an outcome counts as a delivered "send" (the Sent toast) vs
   *  a claim-only (the Claimed toast). Defaults to "delivered AND we have a
   *  steer_id to Undo" — the strict form used by drag / ⌘K. The card + sheet
   *  pass `(r) => r.delivered` (Sent copy even if there's no steer to retract).
   *  Independently, the Undo action only attaches when `steer_id != null`. */
  isSent?: (result: ClaimResult) => boolean

  /** Message + tone for a successful delivered send. Defaults to "Sent to
   *  <session>" / `active`. Receives the result so copy can vary (e.g. an
   *  asleep session "…it'll pick this up on wake."). */
  sentMessage?: (result: ClaimResult) => string
  sentTone?: ToastTone
  /** Auto-dismiss for the sent toast (ms). Omit to fall back to the toast
   *  system's own default. Card + sheet pass 6000 (long enough to Undo). */
  sentDuration?: number

  /** Message for a claim that did NOT deliver (claim-only, or deliver
   *  suppressed). Default "Claimed for <session>". */
  claimedMessage?: (result: ClaimResult) => string
  /** Tone for the claim-only toast. Default `default`. */
  claimedTone?: ToastTone

  /** Outcome of the Undo (unsend). `cleared > 0` ⇒ retracted in time; `0` ⇒ the
   *  agent already picked it up. Default: silent on success, swallow failures.
   *  Provide to surface a confirmation / "already picked up" toast. */
  onUndone?: (cleared: number) => void
  onUndoError?: (error: unknown) => void

  /** Called after a successful claim (delivered OR claim-only), before the toast.
   *  The detail sheet uses this to close itself. */
  onSuccess?: (result: ClaimResult) => void

  /** Route a failure. Default: toast the message (409-aware) with `error` tone.
   *  Override to surface a 409 in-place (the sheet) or via a different toaster. */
  onError?: (error: unknown) => void
}

export interface SendToAgentApi {
  /** Run one send-to-agent per {@link SendToAgentOptions}. Never throws — all
   *  outcomes are routed through the toast / callbacks. */
  sendToAgent: (opts: SendToAgentOptions) => Promise<void>
}

/** Friendly message for a claim failure — 409 (lost race / not claimable) gets
 *  a specific line; anything else falls back to its own message. */
export function claimErrorMessage(error: unknown): string {
  if (error instanceof BoardError && error.status === 409) {
    return error.message || 'Claim lost — another session took it.'
  }
  return error instanceof Error ? error.message : 'Send failed.'
}

/**
 * The shared send-to-agent flow (claim → "Sent to" toast w/ Undo → unsend).
 * One implementation, four call sites.
 */
export function useSendToAgent(): SendToAgentApi {
  const { toast } = useToast()

  const sendToAgent = useCallback(
    async (opts: SendToAgentOptions) => {
      const {
        id,
        session,
        deliver = true,
        claim = ({ id, session, deliver }) => boardApi.claim(id, session, deliver),
        isSent = (r) => r.delivered && r.steer_id != null,
        sentMessage = () => `Sent to ${session}`,
        sentTone = 'active',
        sentDuration,
        claimedMessage = () => `Claimed for ${session}`,
        claimedTone,
        onUndone,
        onUndoError,
        onSuccess,
        onError,
      } = opts

      try {
        const result = await claim({ id, session, deliver })
        onSuccess?.(result)

        if (deliver && isSent(result)) {
          const steerId = result.steer_id
          toast({
            message: sentMessage(result),
            tone: sentTone,
            duration: sentDuration,
            // The Undo retracts the still-undelivered steer; only meaningful when
            // there's actually a queued steer id to clear.
            action:
              steerId != null
                ? {
                    label: 'Undo',
                    onClick: () => {
                      void boardApi
                        .unsend(session, steerId)
                        .then((r) => onUndone?.(r.cleared))
                        .catch((e) => onUndoError?.(e))
                    },
                  }
                : undefined,
          })
        } else {
          toast({ message: claimedMessage(result), tone: claimedTone })
        }
      } catch (error) {
        if (onError) {
          onError(error)
        } else {
          toast({ message: claimErrorMessage(error), tone: 'error' })
        }
      }
    },
    [toast],
  )

  return { sendToAgent }
}
