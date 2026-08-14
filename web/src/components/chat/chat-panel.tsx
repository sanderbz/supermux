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

import { stripEmojiPrefix } from './entries'
import { useChatTurn } from './use-chat-turn'
import { WorkingRow } from './working-row'
import { ProvisionalTail } from './provisional-tail'
import { exposeLatency, latencySamples, p50 } from './latency'

const FOLLOW_THRESHOLD_PX = 48

export default function ChatPanel({
  name,
  session,
}: {
  name: string
  session: TileSession | null
}) {
  const active = session?.status === 'active'
  // The turn state machine (anchor, supersede gate, teardown, 1s ticker)
  // lives in `use-chat-turn.ts` — this component is presentation only.
  const { items, turnStart, showProvisional, overlay, tail } = useChatTurn(name, session)

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
