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
import { restSessionInput, type SessionInput } from '@/lib/session-input'

import { topAttention } from './attention'
import { ChatComposer } from './composer'
import { ChatConversation, PHONE_QUERY } from './conversation'
import { useComposer } from './use-composer'
import { usePeekLens } from './use-peek-lens'
import { usePendingSends } from './use-pending-sends'
import { displayNames, entryLabels, mentionIndex } from './grouping'
import { useChatTurn } from './use-chat-turn'
import { ProvisionalTail } from './provisional-tail'
import { exposeLatency, latencySamples, p50, serverNowMs } from './latency'

const FOLLOW_THRESHOLD_PX = 48

export default function ChatPanel({
  name,
  session,
  input,
  onOpenTerminal,
}: {
  name: string
  session: TileSession | null
  /**
   * The write plane (fase A4 T1/T3). The parent surface owns it because the
   * parent is what knows which renderer is mounted — and because every OTHER
   * insert surface in that parent (snippets, attachments, the dock) holds the
   * same handle, so a snippet inserted from the dock and a `@`-pick made in the
   * composer land in the same draft. Omitted (bench, tests) → the panel builds
   * the REST plane for itself.
   */
  input?: SessionInput
  /** Switch this pane to the terminal renderer — every refusal offers it. */
  onOpenTerminal?: () => void
}) {
  // The turn state machine (anchor, supersede gate, teardown, 1s ticker)
  // lives in `use-chat-turn.ts` — this component is wiring only.
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

  const samples = latencySamples()

  // ── The input plane (fase A4 T3) ───────────────────────────────────────────
  // ONE peek poller for the whole surface (T2): the composer's pre-send draft
  // guard reads it here, and T5/T6/T7's cards will read the same frame. It runs
  // fast while a turn is live, slow otherwise.
  const peek = usePeekLens(name, { live: turnStart != null })
  const fallbackInput = React.useMemo(() => restSessionInput(name), [name])
  // P10 (T4) sits BETWEEN the composer and the input plane: `pending.input` is
  // the same handle with every submit tracked, so the echo cannot get out of
  // step with the POST it is drawn for. `pending.attention` is T5's cause —
  // an undelivered send raises the Attention card there; until it lands the
  // undelivered ROW carries the reason and the way out.
  const pending = usePendingSends({
    name,
    input: input ?? fallbackInput,
    peek,
    entries,
    active: session?.status === 'active',
  })
  const composer = useComposer({
    name,
    input: pending.input,
    peek,
    active: session?.status === 'active',
  })

  // ── The Attention card (fase A4 T5) ────────────────────────────────────────
  // ONE card, so the causes are ranked rather than stacked (`topAttention`).
  // Today exactly one raiser is wired — a send the watchdog gave up on; T6/T7
  // add the dialog causes and pass their own context. The card's evidence is
  // the SAME capture every other consumer reads (one poller, T2), so what it
  // shows is what the refusal was decided on.
  const attention = topAttention([pending.attention])
  const attentionCtx = React.useMemo(
    () => ({ version: peek.lens.bannerVersion }),
    [peek.lens.bannerVersion],
  )
  // Dismissing the card dismisses what raised it: the undelivered echoes are
  // the failure, and a card that could be closed while its rows stayed on
  // screen would just be a second thing to close.
  const pendingItems = pending.items
  const dismissPending = pending.dismiss
  const dismissAttention = React.useCallback(() => {
    for (const p of pendingItems) {
      if (p.state === 'undelivered') dismissPending(p.id)
    }
  }, [pendingItems, dismissPending])

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
      pending={pending.items}
      onRetryPending={pending.retry}
      onDismissPending={pending.dismiss}
      attention={attention}
      attentionCtx={attentionCtx}
      attentionCapture={peek.capture}
      onDismissAttention={dismissAttention}
      onOpenTerminal={onOpenTerminal}
      provisional={
        showProvisional ? <ProvisionalTail name={name} show={showProvisional} surface={phone ? 'phone' : 'desktop'} /> : null
      }
      composer={
        <ChatComposer
          name={name}
          label={session?.display_name?.trim() ? session.display_name : name}
          handle={composer}
          surface={phone ? 'phone' : 'desktop'}
          active={session?.status === 'active'}
          onOpenTerminal={onOpenTerminal}
          // The dogfood number, readable without devtools (re-renders on the
          // live-layer ticker / tail refetches). It rides the composer's frame
          // now — the read-only shell this replaced is only reached when NO
          // composer slot is passed, and the panel always passes one.
          stat={
            samples.length > 0 ? (
              <>
                hook→UI p50 {p50(samples)} ms (n={samples.length})
              </>
            ) : null
          }
        />
      }
    />
  )
}
