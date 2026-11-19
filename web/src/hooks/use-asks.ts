// useOpenAsks / useSessionAsks — the live set of open asks (docs/ASKS.md).
//
// TanStack Query against `GET /api/asks?state=open` for the first paint, kept
// live by the shared SSE stream's `asks` frames — never polled. Every frame
// carries the whole ask (minus its live `input`), so a frame is applied in
// place: an open ask is upserted by id, anything else is removed. A frame for
// an older rev than the cached row is ignored, so an out-of-order delivery
// cannot resurrect a closed ask. On wake (`onResync`) the list is re-pulled, the
// same reconciliation every other SSE-backed query here does.
//
// Owner/admin only on the server: a company-scoped member gets a 404 here, which
// leaves the list empty and every chat card on its older path.

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { askFromFrame, asksApi, type Ask, type AskKind } from '../lib/api/asks'
import { useSse, type SseEventType } from './use-sse'

export const OPEN_ASKS_KEY = ['asks', 'open'] as const

/** Apply one `asks` frame to the cached open list. Pure, for the tests. */
export function applyAskFrame(list: readonly Ask[], payload: unknown): Ask[] | null {
  const frame = askFromFrame(payload)
  if (!frame) return null
  const { ask } = frame
  const i = list.findIndex((a) => a.id === ask.id)
  if (i >= 0 && list[i].rev > ask.rev) return null
  const rest = i >= 0 ? [...list.slice(0, i), ...list.slice(i + 1)] : [...list]
  if (ask.state !== 'open') return i >= 0 ? rest : null
  // Keep the live `input` a GET already fetched for this row — frames never
  // carry it, and the card should not lose the command it is showing.
  const prev = i >= 0 ? list[i] : undefined
  const next: Ask = prev?.input && !ask.input ? { ...ask, input: prev.input } : ask
  if (i >= 0) rest.splice(i, 0, next)
  else rest.push(next)
  return rest
}

export function useOpenAsks(): Ask[] {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: OPEN_ASKS_KEY,
    queryFn: asksApi.open,
    staleTime: 30_000,
    // A 404 (scoped member, or a server without the API) is an empty list, not
    // an error state worth retrying.
    retry: false,
  })
  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (type !== 'asks') return
        qc.setQueryData<Ask[]>(OPEN_ASKS_KEY, (prev) => applyAskFrame(prev ?? [], payload) ?? prev)
      },
      onResync: () => {
        void qc.invalidateQueries({ queryKey: OPEN_ASKS_KEY })
      },
    }),
    [qc],
  )
  useSse(handlers)
  return query.data ?? []
}

/** The open asks of one session, newest first. */
export function useSessionAsks(name: string): Ask[] {
  const all = useOpenAsks()
  return React.useMemo(
    () => all.filter((a) => a.session === name).sort((a, b) => b.created_ms - a.created_ms),
    [all, name],
  )
}

/** The newest open, ANSWERABLE ask of one of `kinds` — the one a chat card can
 *  answer natively right now. */
export function answerableAsk(asks: readonly Ask[], kinds: readonly AskKind[]): Ask | null {
  return asks.find((a) => a.answerable && kinds.includes(a.kind)) ?? null
}
