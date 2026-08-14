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

import {
  newestAgentTs,
  stripEmojiPrefix,
  toDisplayList,
  type ChatEntry,
} from './entries'
import { useChatTail } from './use-chat-tail'
import { useReceiptOverlay } from './use-receipt-overlay'
import { WorkingRow } from './working-row'
import { ProvisionalTail } from './provisional-tail'
import { exposeLatency, latencySamples, p50, serverNowMs } from './latency'

const FOLLOW_THRESHOLD_PX = 48
/** Only show the provisional tail when the transcript is clearly BEHIND the
 *  live turn — right after a batch lands the pty text is confirmed content
 *  and showing it again would duplicate (the A1 anti-glitch heuristic). */
const PROVISIONAL_LAG_MS = 5_000
/** How recent `last_send_at` must be at the flip to count as THIS turn's
 *  anchor (terminal-typed sends never stamp it, so it can be stale). */
const SEND_ANCHOR_WINDOW_MS = 30_000
/** Bounded fallback teardown: a turn whose confirming batch never lands (an
 *  interrupt, a compact, an unreadable transcript) must not strand the live
 *  layer polling `/peek` once a second forever. Well past the a0 confirm
 *  latency (text-only p50 31s) so it never fires on a healthy turn. */
const TURN_CONFIRM_TIMEOUT_MS = 120_000

export default function ChatPanel({
  name,
  session,
}: {
  name: string
  session: TileSession | null
}) {
  const active = session?.status === 'active'
  const tail = useChatTail(name, true)
  // Memoised so the `?? []` fallback doesn't hand `toDisplayList` a fresh
  // array identity on every render (it would recompute the whole list each
  // 1s live-layer tick).
  const entries = React.useMemo(
    () => (tail.data?.entries ?? []) as unknown as ChatEntry[],
    [tail.data],
  )
  const items = React.useMemo(() => toDisplayList(entries), [entries])
  const lastConfirmedTs = entries.length > 0 ? entries[0].ts : 0
  const lastConfirmedMs = lastConfirmedTs * 1000

  // Turn tracking, SERVER clock domain. Anchor priority: the server's
  // last_send_at stamp (the dock/API send that started the turn — makes the
  // elapsed clause count from the SEND even when this panel mounts mid-turn),
  // else skew-corrected server-now at the flip. Never raw Date.now().
  const [turnStart, setTurnStart] = React.useState<number | null>(null)
  const lastSendAt = session?.last_send_at
  React.useEffect(() => {
    if (!active) return
    // The turn anchor is stamped from the SERVER-clock edge of an external
    // event (the SSE status flip), not derived from render state; the updater
    // returns `prev` unchanged once an anchor exists, so it cannot cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTurnStart((prev) => {
      if (prev != null) return prev
      const now = serverNowMs()
      const sendMs = (lastSendAt ?? 0) * 1000
      return sendMs > 0 && now - sendMs < SEND_ANCHOR_WINDOW_MS ? sendMs : now
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Supersede gate (checkpoint (c)): the live layer tears down only once the
  // AGENT's confirming batch for THIS turn is in hand — never on the bare
  // status flip, which would leave a blank gap while the batch is still in
  // flight. The gate deliberately ignores USER-authored entries: Claude writes
  // the user turn to the JSONL within ~1s of the send, and with the
  // `last_send_at` anchor (every dock/REST/WS send stamps it — i.e. the whole
  // dogfood path) that echo's second-truncated `ts` is always ≥ turnStart, so
  // an any-entry gate is satisfied by the user's own message and degrades to
  // exactly the bare-flip teardown it exists to prevent.
  const lastAgentMs = React.useMemo(() => newestAgentTs(entries) * 1000, [entries])
  const confirmedCaughtUp = turnStart != null && lastAgentMs >= turnStart
  const turnStranded =
    turnStart != null && serverNowMs() - turnStart > TURN_CONFIRM_TIMEOUT_MS
  React.useEffect(() => {
    // Turn teardown on the (status flip + confirmed batch) edge — both are
    // external events; the guard makes it fire at most once per turn.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!active && (confirmedCaughtUp || turnStranded)) setTurnStart(null)
  }, [active, confirmedCaughtUp, turnStranded])

  // Turn end → confirm NOW (zero debounce; the mid-turn debounce only exists
  // to coalesce delta bursts).
  const refetch = tail.refetch
  React.useEffect(() => {
    if (!active && turnStart != null) void refetch()
  }, [active, turnStart, refetch])

  // 1s live-layer ticker: a prose-only turn produces NO deltas and NO
  // refetches, so every time-gated piece below (showProvisional, elapsed,
  // footer stats) must re-render on its own clock or it never appears.
  const liveLayerUp = active || turnStart != null
  const [, tick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (!liveLayerUp) return
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [liveLayerUp])

  const overlay = useReceiptOverlay(session, turnStart, lastConfirmedTs)
  React.useEffect(() => exposeLatency(), [])

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

  // Shown while the transcript is behind the live turn; liveLayerUp keeps it
  // (and the overlay) mounted through the post-Stop confirmation window, so
  // the answer never blanks out before its confirmed form arrives.
  const showProvisional =
    liveLayerUp &&
    turnStart != null &&
    serverNowMs() - lastConfirmedMs > PROVISIONAL_LAG_MS

  return (
    <div
      data-testid="chat-panel"
      className="flex h-full w-full flex-col bg-card"
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4"
      >
        <div className="mx-auto flex max-w-[52rem] flex-col gap-3">
          {tail.isError && (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              Couldn’t load this conversation.
            </p>
          )}
          {!tail.isError && items.length === 0 && !tail.isLoading && (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              No conversation yet.
            </p>
          )}

          {items.map((item) => {
            if (item.type === 'user') {
              return (
                <div key={item.uuid} className="flex justify-end">
                  <div className="max-w-[72%] rounded-2xl bg-muted px-3 py-2 text-[14px] leading-5">
                    {item.badge && (
                      <span className="mr-1.5 rounded bg-background px-1 py-0.5 text-[11px] text-muted-foreground">
                        {item.badge}
                      </span>
                    )}
                    <span className="whitespace-pre-wrap break-words">{item.text}</span>
                  </div>
                </div>
              )
            }
            if (item.type === 'assistant') {
              return (
                <div
                  key={item.uuid}
                  className="whitespace-pre-wrap break-words text-[14px] leading-5"
                >
                  {item.text}
                </div>
              )
            }
            // receipts
            return (
              <div
                key={item.uuid}
                className="flex flex-col gap-0.5 rounded-lg border border-border/60 px-3 py-2"
              >
                {item.lines.map((l) => (
                  <div
                    key={l.uuid}
                    className="flex items-baseline gap-2 text-[13px]"
                    title={l.result}
                  >
                    <span
                      className={
                        l.ok === false ? 'text-status-error' : 'text-muted-foreground'
                      }
                      aria-hidden
                    >
                      {l.ok === false ? '✗' : '✓'}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[12.5px]">
                      {l.label}
                    </span>
                  </div>
                ))}
                {item.overflow > 0 && (
                  <div className="pt-0.5 text-[12px] text-muted-foreground">
                    +{item.overflow} more
                  </div>
                )}
              </div>
            )
          })}

          {/* Live layer — permission first (nothing silently invisible), then
              overlay receipts, then the working row, then provisional text. */}
          {session?.permission_request && (
            /* permission_request is the wire OBJECT {tool, summary, kind,
               mode?} — never render the object itself. */
            <div
              data-testid="chat-permission-row"
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px]"
            >
              <span aria-hidden>⏸</span>
              <span className="min-w-0 truncate">
                Waiting for permission:{' '}
                <span className="font-medium">{session.permission_request.tool}</span>
                {session.permission_request.summary && (
                  <span className="text-muted-foreground">
                    {' — '}
                    {stripEmojiPrefix(session.permission_request.summary)}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-muted-foreground">
                · answer in the terminal
              </span>
            </div>
          )}

          {overlay.length > 0 && (
            <div className="flex flex-col gap-0.5 px-1">
              {overlay.map((l, i) => (
                <div
                  key={`${l.at}-${i}`}
                  className="flex items-baseline gap-2 text-[13px] text-muted-foreground"
                >
                  <span aria-hidden>·</span>
                  <span className="min-w-0 truncate font-mono text-[12.5px]">
                    {l.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {active && turnStart != null && (
            <WorkingRow
              activity={session?.activity}
              subagents={session?.subagents}
              turnStartMs={turnStart}
            />
          )}

          <ProvisionalTail name={name} show={showProvisional} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border/60 px-5 py-2 text-center text-[12px] text-muted-foreground">
        Read-only preview — switch to Terminal to type.
        {latencySamples().length > 0 && (
          /* The dogfood number, readable without devtools (re-renders on the
             live-layer ticker / tail refetches). */
          <span className="ml-2 tabular-nums">
            · hook→UI p50 {p50(latencySamples())} ms (n={latencySamples().length})
          </span>
        )}
      </div>
    </div>
  )
}
