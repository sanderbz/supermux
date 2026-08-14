// Fase A1 chat panel — read-only walking skeleton (master plan §7 Fase A1).
//
// Layer model (a0-findings §1): the TRANSCRIPT is the confirming layer
// (batch-flushed, prose p50 31s); the LIVE layer is the status flip + hook
// receipts + the provisional pty tail. Provisional content is discarded and
// replaced on confirmation, never merged. Receipts-first: overlay receipts
// and the working row render BELOW confirmed content, above the provisional
// text block.
//
// Deliberately neutral-minimal (existing tokens, no markdown, no motion):
// the A3 design direction replaces this surface wholesale.

import * as React from 'react'

import type { TileSession } from '@/components/session-tile/types'
import { useSessions } from '@/hooks/use-sessions'
import { filesApi } from '@/lib/api'

import { ChatSurface } from './chat-surface'
import { buildTranscript, entryLabels, mentionIndex } from './grouping'
import { LiveLayer } from './live-layer'
import { TranscriptItem } from './transcript-item'
import { useChatTurn } from './use-chat-turn'
import { ProvisionalTail } from './provisional-tail'
import { exposeLatency, latencySamples, p50, serverNowMs } from './latency'

const FOLLOW_THRESHOLD_PX = 48

export default function ChatPanel({
  name,
  session,
}: {
  name: string
  session: TileSession | null
}) {
  // The turn state machine (anchor, supersede gate, teardown, 1s ticker)
  // lives in `use-chat-turn.ts` — this component is presentation only.
  const { entries, items, turnStart, showProvisional, overlay, tail } = useChatTurn(
    name,
    session,
  )

  React.useEffect(() => exposeLatency(), [])

  // A name in prose becomes a mention chip only when it names a session that
  // actually exists (fase A3 T3 — no regex over arbitrary words). The list comes
  // from the shared sessions query: one cache, already populated by the shell,
  // so this adds a subscriber rather than a fetch.
  const { sessions } = useSessions()
  const mentions = React.useMemo(() => mentionIndex(sessions), [sessions])
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
  const nodes = React.useMemo(
    () => buildTranscript(items, { nowMs: nowBucketMs, labels }),
    [items, labels, nowBucketMs],
  )

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
    <ChatSurface
      testId="chat-panel"
      name={name}
      session={session}
      scrollRef={scrollRef}
      onScroll={onScroll}
      footer={
        <div className="border-t border-hairline px-5 py-2 text-center text-[12px] text-ink-2">
          Read-only preview — switch to Terminal to type.
          {latencySamples().length > 0 && (
            /* The dogfood number, readable without devtools (re-renders on the
               live-layer ticker / tail refetches). */
            <span className="ml-2 tabular-nums">
              · hook→UI p50 {p50(latencySamples())} ms (n={latencySamples().length})
            </span>
          )}
        </div>
      }
    >
      <div className="px-5 pb-6 pt-4">
        <div className="mx-auto w-full max-w-[52rem]">
          {tail.isError && (
            <p className="py-8 text-center text-[13px] text-ink-2">
              Couldn’t load this conversation.
            </p>
          )}
          {!tail.isError && items.length === 0 && !tail.isLoading && (
            <p className="py-8 text-center text-[13px] text-ink-2">No conversation yet.</p>
          )}

          {/* Confirmed content (fase A3 T3). Vertical rhythm belongs to the rows
              themselves — `MessageRow` spends 14px between speakers and 8px
              inside a run — so this column adds no gap of its own. */}
          {nodes.map((node) => (
            <TranscriptItem
              key={node.key}
              node={node}
              name={name}
              labels={labels}
              mentions={mentions}
              rawUrl={filesApi.rawUrl}
            />
          ))}

          {/* Live layer (fase A3 T4) — permission first (nothing silently
              invisible), then overlay receipts, then the working row (or the
              delegation pill), then provisional text. The P13 block is injected
              as a slot: it is the one child that talks to the network, and
              keeping it out of `LiveLayer` is what makes that order testable. */}
          <LiveLayer
            name={name}
            session={session}
            turnStart={turnStart}
            overlay={overlay}
            mentions={mentions}
            provisional={
              showProvisional ? <ProvisionalTail name={name} show={showProvisional} /> : null
            }
          />
        </div>
      </div>
    </ChatSurface>
  )
}
