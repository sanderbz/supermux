/**
 * The recovery ladder's client half (B5/T8).
 *
 * ── Why a hook and not three call sites ─────────────────────────────────────
 * Before B5 the client composed its own stop+start, twice, and the two
 * compositions differed (`use-session-actions.ts` vs `routes/focus/desktop.tsx`).
 * The rungs are now server-side and atomic; this hook is the one place that
 * knows their names, their order, and what each preserves — so the inline
 * affordance on a dead tile and the canonical list in Settings cannot drift
 * apart in either labelling or behaviour.
 *
 * ── The ordering IS the design ──────────────────────────────────────────────
 * The rungs are ordered by what they PRESERVE, least-destructive first, and
 * every label names that rather than the mechanism. "Restart" and "Reset" mean
 * nothing to someone deciding under pressure whether they are about to lose a
 * conversation; "keeps your scrollback" and "clears the conversation" do.
 */
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { sessionsApi, type ApiSession } from '@/lib/api/sessions'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { useToast } from '@/components/ui/use-toast'
import { RECOVERY } from '@/brand/copy'

/** The three rungs, least-destructive first. */
export const RUNGS = ['recover', 'restart', 'reset'] as const
export type Rung = (typeof RUNGS)[number]

export interface RungSpec {
  key: Rung
  /** The verb, as the button reads. */
  label: string
  /** What survives it — the half users actually decide on. */
  preserves: string
  /** What does not. Never softened: this is the sentence that prevents regret. */
  destroys: string
  /** Why it is unavailable here, when it is. One string, both call sites. */
  blockedReason?: string
}

/**
 * Is this session a candidate for the in-place holder recovery?
 *
 * `recover` is native + local only (`auto_actions::heal_is_supported`). Rather
 * than let the user press a button that can only answer "unsupported", the
 * ladder marks it blocked and says why — with the SAME sentence Settings uses.
 */
export function canRecoverHolder(s: Pick<ApiSession, 'runtime' | 'host_id'> | null): boolean {
  if (!s) return false
  return s.runtime === 'native' && (s.host_id === null || s.host_id === undefined)
}

/** The ladder for a given session: every rung, in order, with its blocks. */
export function rungsFor(
  s: Pick<ApiSession, 'runtime' | 'host_id'> | null,
): RungSpec[] {
  const recoverable = canRecoverHolder(s)
  return [
    {
      key: 'recover',
      label: RECOVERY.recover.label,
      preserves: RECOVERY.recover.preserves,
      destroys: RECOVERY.recover.destroys,
      ...(recoverable ? {} : { blockedReason: RECOVERY.recoverBlocked }),
    },
    {
      key: 'restart',
      label: RECOVERY.restart.label,
      preserves: RECOVERY.restart.preserves,
      destroys: RECOVERY.restart.destroys,
    },
    {
      key: 'reset',
      label: RECOVERY.reset.label,
      preserves: RECOVERY.reset.preserves,
      destroys: RECOVERY.reset.destroys,
    },
  ]
}

/**
 * The LOWEST rung that can help this session — what the inline affordance
 * offers.
 *
 * §15.5 asks for "inline, least-destructive first": one button, not a menu. A
 * menu at the moment of a fault asks the user to compare three destructive
 * options while something is broken; a single button labelled with what it
 * keeps, plus a link to the full list, does not.
 */
export function lowestUsefulRung(
  s: Pick<ApiSession, 'runtime' | 'host_id'> | null,
): RungSpec {
  const ladder = rungsFor(s)
  return ladder.find((r) => !r.blockedReason) ?? ladder[ladder.length - 1]!
}

export interface UseRecoveryResult {
  /** Run a rung. Resolves to the server's own sentence about what happened. */
  run: (name: string, rung: Rung) => Promise<string>
  /** The rung currently in flight, or null. */
  pending: Rung | null
}

export function useRecovery(): UseRecoveryResult {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [pending, setPending] = React.useState<Rung | null>(null)

  const run = React.useCallback(
    async (name: string, rung: Rung): Promise<string> => {
      setPending(rung)
      try {
        let message: string
        if (rung === 'recover') {
          // `recover` answers with an OUTCOME, not a success/failure. "Auto-
          // recovery is off" and "this session type cannot be recovered" are
          // answers, and the server sends the exact sentence to show — so the
          // client never paraphrases a diagnosis it does not own.
          const res = await sessionsApi.recover(name)
          message = res.reason ?? RECOVERY.outcomeFallback
          toast({ message, tone: res.healed ? 'active' : 'waiting' })
        } else if (rung === 'restart') {
          await sessionsApi.restart(name)
          message = RECOVERY.restartDone
          toast({ message, tone: 'active' })
        } else {
          await sessionsApi.reset(name)
          message = RECOVERY.resetDone
          toast({ message, tone: 'active' })
        }
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
        return message
      } catch (e) {
        const message = e instanceof Error ? e.message : RECOVERY.failed
        toast({ message, tone: 'error' })
        throw e
      } finally {
        setPending(null)
      }
    },
    [qc, toast],
  )

  return { run, pending }
}
