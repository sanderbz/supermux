// Answering an ask from chat — the STATE (docs/ASKS.md).
//
// Picks the ask a chat card answers natively — the OLDEST open, answerable
// permission / question / form of this session, which is the dialog the
// terminal is drawing (Claude Code queues them in the order they were asked) —
// fetches its live `input` (the real command, Claude's "always allow" offers),
// and POSTs the answer.
//
// What it keeps from the key-pressing hooks it replaces is the part about
// CORRECTNESS: a ref so two taps cannot answer twice, and a short-lived
// `delivered` line so the ~half second between the answer and the ask's closing
// frame (or the session's hook state clearing) reads as done rather than
// flashing the older, key-pressing card back up. What it drops is everything
// about SIGHTING: no peek, no caret, no Claude Code version pin.

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { applyAskFrame, OPEN_ASKS_KEY } from '../../hooks/use-asks'
import { asksApi, askQuestions, HOOK_KINDS, type Ask, type AskAnswer, type AskQuestion } from '../../lib/api/asks'

import { answerFailure, deliveredLine } from './ask-answer'

/** How long a delivered answer holds the band before the older paths may draw
 *  again — long enough for the PostToolUse that clears `permission_request`,
 *  short enough that a terminal which ignored the answer is visible soon. */
export const DELIVERED_HOLD_MS = 6_000

export interface AskAnswerHandle {
  /** The ask a card answers natively right now, with live `input` once fetched. */
  ask: Ask | null
  /** Its questions, for a `question` ask. */
  questions: AskQuestion[]
  /** Further answerable asks queued behind this one. */
  queued: number
  busy: boolean
  /** Why the last answer did not land — the card says it under its buttons. */
  error: string | null
  /** The line a delivered answer leaves, while it holds the band. */
  delivered: string | null
  answer: (body: AskAnswer) => Promise<boolean>
}

/** The ask a chat card answers: oldest first, hook kinds only, answerable only. */
export function nativeAsk(asks: readonly Ask[]): { ask: Ask | null; queued: number } {
  const live = asks
    .filter((a) => a.state === 'open' && a.answerable && HOOK_KINDS.includes(a.kind))
    .sort((a, b) => a.created_ms - b.created_ms)
  return { ask: live[0] ?? null, queued: Math.max(0, live.length - 1) }
}

export function useAskAnswer(asks: readonly Ask[]): AskAnswerHandle {
  const { ask: base, queued } = nativeAsk(asks)
  const id = base?.id ?? null

  // The live input is fetched per REVISION of the ask: it is the command a
  // human approves, held in memory by the waiting hook and never sent over SSE,
  // and a revision is what tells this client the hook (re)connected. The last
  // answer stays on screen while the next one loads.
  const live = useQuery({
    queryKey: ['asks', 'live', id, base?.rev],
    queryFn: () => asksApi.get(id as string),
    enabled: id != null && base?.kind === 'permission',
    staleTime: Infinity,
    placeholderData: (prev) => prev,
    retry: 1,
  })
  const qc = useQueryClient()
  const ask = React.useMemo<Ask | null>(() => {
    if (!base) return null
    const input = live.data?.id === base.id ? live.data.input : undefined
    return input && !base.input ? { ...base, input } : base
  }, [base, live.data])

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [delivered, setDelivered] = React.useState<{ line: string; at: number } | null>(null)
  const running = React.useRef(false)

  // A different ask is a different question: its error and busy state are not
  // this one's. (`running` clears itself in `finally`.)
  const [prevId, setPrevId] = React.useState(id)
  if (id !== prevId) {
    setPrevId(id)
    setError(null)
    setBusy(false)
  }

  React.useEffect(() => {
    if (!delivered) return
    const t = window.setTimeout(() => setDelivered(null), Math.max(0, delivered.at + DELIVERED_HOLD_MS - Date.now()))
    return () => window.clearTimeout(t)
  }, [delivered])

  const answer = React.useCallback(
    async (body: AskAnswer): Promise<boolean> => {
      if (!ask || running.current) return false
      running.current = true
      setBusy(true)
      setError(null)
      try {
        const closed = await asksApi.answer(ask.id, body)
        // The response IS the closed ask: drop it now rather than waiting on
        // the SSE frame that says the same thing.
        qc.setQueryData<Ask[]>(OPEN_ASKS_KEY, (prev) =>
          prev ? (applyAskFrame(prev, { op: 'closed', rev: closed?.rev, ask: closed }) ?? prev) : prev,
        )
        setDelivered({ line: deliveredLine(ask, body), at: Date.now() })
        return true
      } catch (err) {
        setError(answerFailure(err))
        return false
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [ask, qc],
  )

  const questions = React.useMemo(() => (ask?.kind === 'question' ? askQuestions(ask) : []), [ask])

  return {
    ask,
    questions,
    queued,
    busy,
    error,
    // A NEW ask outranks the line about the last one.
    delivered: delivered && !ask ? delivered.line : null,
    answer,
  }
}
