// The chat panel — the DATA plane, and nothing else (fase A1 machine, A3 T7
// composition).
//
// Layer model (a0-findings §1): the TRANSCRIPT is the confirming layer
// (batch-flushed, prose p50 31s); the LIVE layer is the status flip + hook
// receipts + the provisional pty tail. Provisional content is discarded and
// replaced on confirmation, never merged. Receipts-first: overlay receipts
// and the working row render BELOW confirmed content, above the provisional
// text block.
//
// Everything this file does is fetch, derive and inject:
//   · the turn machine (`use-chat-turn`) — anchor, supersede gate, teardown,
//   · the two derived indexes (mentions from the shared sessions query, wire
//     labels from the entries),
//   · the follow-bottom pin,
//   · the two capabilities the presentation layer must not import for itself
//     (`filesApi.rawUrl`, the latency read-out).
//
// What it looks like is `conversation.tsx`, which takes all of the above as
// props — that is what `/dev/chat-live` renders, so the bench and the app cannot
// drift apart.

import * as React from 'react'

import type { TileSession } from '@/components/session-tile/types'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useSessions } from '@/hooks/use-sessions'
import { filesApi } from '@/lib/api'

import { ChatConversation, PHONE_QUERY } from './conversation'
import { displayNames, entryLabels, mentionIndex } from './grouping'
import { useChatTurn } from './use-chat-turn'
import { ProvisionalTail } from './provisional-tail'
import { exposeLatency, latencySummary, serverNowMs } from './latency'

const FOLLOW_THRESHOLD_PX = 48

export default function ChatPanel({
  name,
  session,
}: {
  name: string
  session: TileSession | null
}) {
  // The turn state machine (anchor, supersede gate, teardown, 1s ticker)
  // lives in `use-chat-turn.ts` — this component is wiring only.
  const { entries, items, turnStart, showProvisional, overlay, tail } = useChatTurn(
    name,
    session,
  )

  React.useEffect(() => exposeLatency(), [])
  // One pass over the ring per render (the ticker re-renders us every second).
  const latency = latencySummary()

  // A name in prose becomes a mention chip only when it names a session that
  // actually exists (fase A3 T3 — no regex over arbitrary words). The list comes
  // from the shared sessions query: one cache, already populated by the shell,
  // so this adds a subscriber rather than a fetch.
  const { sessions } = useSessions()
  const mentions = React.useMemo(() => mentionIndex(sessions), [sessions])
  // slug → what that session is CALLED. The arrival divider names a colleague,
  // and the wire's teammate envelope carries only the slug.
  const names = React.useMemo(() => displayNames(sessions), [sessions])
  // The wire labels `ChatItem` deliberately does not carry: the slash name of a
  // command, the teammate id of an arrival, the subject of a system event.
  const labels = React.useMemo(() => entryLabels(entries), [entries])
  // Relative divider labels recompute on the existing 1s live-layer ticker
  // (`use-chat-turn`), never on an interval of their own. The clock is bucketed
  // to 30s so a ticking turn does not re-shape the whole transcript once a
  // second for labels that change once a minute — and it is the SERVER's clock,
  // like every other time comparison on this surface, because the timestamps it
  // is subtracted from are server-stamped (`latency.ts`).
  const nowBucketMs = Math.floor(serverNowMs() / 30_000) * 30_000

  // Desktop board or phone board — the boards are two compositions, not one at
  // two widths (see `conversation.tsx`).
  const phone = useMediaQuery(PHONE_QUERY)

  // Follow-bottom pin: stick to the newest content unless the user scrolled up.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pinnedRef = React.useRef(true)
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX
  }, [])
  React.useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  })

  return (
    <ChatConversation
      // The surface IS the panel's root element, so it keeps the panel's
      // long-standing test id — the renderer-switch e2e asserts on it.
      testId="chat-panel"
      name={name}
      session={session}
      items={items}
      labels={labels}
      mentions={mentions}
      names={names}
      nowMs={nowBucketMs}
      turnStart={turnStart}
      overlay={overlay}
      surface={phone ? 'phone' : 'desktop'}
      isError={tail.isError}
      isLoading={tail.isLoading}
      rawUrl={filesApi.rawUrl}
      scrollRef={scrollRef}
      onScroll={onScroll}
      provisional={
        showProvisional ? <ProvisionalTail name={name} show={showProvisional} surface={phone ? 'phone' : 'desktop'} /> : null
      }
      stat={
        latency.n > 0 ? (
          /* The dogfood number, readable without devtools (re-renders on the
             live-layer ticker / tail refetches). One pass over the bounded ring
             per render, not three array reads plus a sort (#59). */
          <>
            hook→UI p50 {latency.p50} ms (n={latency.n})
          </>
        ) : null
      }
    />
  )
}
