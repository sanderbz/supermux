/**
 * The conversation — the whole chat surface, from props (fase A3 T7).
 * ─────────────────────────────────────────────────────────────────────────────
 * `chat-panel.tsx` owns the data plane (the tail query, the turn machine, the
 * session list); this owns everything that is drawn from it. Nothing in here
 * fetches, subscribes or polls — the one networked child (the P13 tail) arrives
 * as a slot, exactly as it does in `live-layer.tsx`.
 *
 * That split is what makes `/dev/chat-live` a REVIEW SURFACE rather than a
 * lookalike: the bench renders THIS component with fixture props, so the pixels
 * a reviewer compares to `board-light.png` are drawn by the same code that draws
 * the app. A bench that re-assembled the surface out of primitives could drift
 * from the panel silently, which is the failure the B0 bench can only catch one
 * primitive at a time.
 *
 * THE BOARDS' COMPOSITION, in the four numbers that matter:
 *   · TRACK — a centred 744px column. Not the pane's width: the assistant
 *     bubble's 648px ceiling plus the 44px gutter is what the column is FOR, and
 *     a wider track would leave the user's right-aligned bubble stranded.
 *   · BOTTOM-ANCHORED — the column sits at the BOTTOM of the scroll region
 *     (`min-h-full` + `mt-auto`), so a three-message session reads like one that
 *     just started rather than a page with a big hole under it. Every board is
 *     drawn this way.
 *   · FLOATING COMPOSER — inset 18px from the pane's bottom edge, with the
 *     track reserving 90px so the last bubble is never under the glass.
 *   · PHONE IS A COMPOSITION, NOT A WIDTH — 14px gutters, both bubble ceilings
 *     drop (`Bubble surface="phone"`), the header becomes a floating card the
 *     track scrolls under, the composer takes its 52px rung. `mobile-light.png`
 *     is a different drawing of the same surface, and the switch is one prop.
 *
 * Import rule, inherited: relative paths only, and `components/chat/ui` is
 * imported from here, never the reverse.
 */
import * as React from 'react'

import type { MarkPin } from '../../brand/marks'
import type { TileSession } from '../session-tile/types'

import { ChatSurface } from './chat-surface'
import { ComposerShell } from './composer-shell'
import type { ChatItem } from './entries'
import { buildTranscript } from './grouping'
import { SessionHeaderPill } from './header-pill'
import { LiveLayer } from './live-layer'
import { TranscriptItem } from './transcript-item'
import type { OverlayLine } from './use-receipt-overlay'

/**
 * Below this the surface is drawn as `mobile-light.png` rather than as a narrow
 * `board-light.png`. 480px, not the app's 768px focus fork: between the two the
 * desktop composition still fits its 744px track (it centres and lets the
 * gutters shrink), and the phone card would look marooned on a 700px window.
 */
const PHONE_MAX_W = 480
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_W}px)`

export interface ChatConversationProps {
  /** The focused session's immutable slug — every seed on this surface. */
  name: string
  session: TileSession | null
  /** Oldest-first display items (`toDisplayList`). */
  items: readonly ChatItem[]
  /** uuid → wire label (slash name, teammate id, event subject). */
  labels?: ReadonlyMap<string, string>
  /** Lowercased name → slug, for mention chips and the delegation guard. */
  mentions?: ReadonlyMap<string, string>
  /** Slug → display name, for the arrival divider (see `transcript-item.tsx`). */
  names?: ReadonlyMap<string, string>
  /** SERVER-clock ms, bucketed by the caller — the dividers' relative clock. */
  nowMs: number
  /** SERVER-clock ms anchor for the running turn; null = no live turn. */
  turnStart: number | null
  overlay?: readonly OverlayLine[]
  /** The P13 block — a slot, because it is the one child that talks to `/peek`. */
  provisional?: React.ReactNode
  /** Absolute path → fetchable URL (`filesApi.rawUrl`). */
  rawUrl?: (path: string) => string
  /** Seed → identity pin, when a roster has assigned one (TODO §10). */
  pinFor?: (seed: string) => MarkPin | undefined
  /** Force the composition. Omit and it follows the viewport. */
  surface?: 'desktop' | 'phone'
  /** The tail query's two unhappy states. */
  isError?: boolean
  isLoading?: boolean
  /** The shell's own header affordances (A5's back chevron / avatar). */
  headerLeading?: React.ReactNode
  headerTrailing?: React.ReactNode
  /** The `hook→UI p50` read-out, when the session has produced samples. */
  stat?: React.ReactNode
  scrollRef?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
  testId?: string
}

export function ChatConversation({
  name,
  session,
  items,
  labels,
  mentions,
  names,
  nowMs,
  turnStart,
  overlay,
  provisional,
  rawUrl,
  pinFor,
  surface,
  isError,
  isLoading,
  headerLeading,
  headerTrailing,
  stat,
  scrollRef,
  onScroll,
  testId = 'chat-surface',
}: ChatConversationProps) {
  const phone = surface === 'phone'
  const nodes = React.useMemo(
    () => buildTranscript(items, { nowMs, labels }),
    [items, labels, nowMs],
  )
  const label = session?.display_name?.trim() ? session.display_name : name
  const pin = pinFor?.(name)

  return (
    <ChatSurface
      testId={testId}
      name={name}
      session={session}
      pin={pin}
      scrollRef={scrollRef}
      onScroll={onScroll}
      // The header FLOATS, on both compositions. That is what the boards draw:
      // a captured frame passing under the bar and taking its 80px blur with it
      // (sample `board-light.png` at the top of the pane — the bar is warmer
      // than bare glass because there is a sunset behind it). The track below
      // pays for it in top padding, and the header is chat-only, so nothing
      // outside this surface moves.
      headerOverlay
      header={
        <SessionHeaderPill
          name={name}
          session={session}
          pin={pin}
          surface={phone ? 'phone' : 'desktop'}
          leading={headerLeading}
          trailing={headerTrailing}
        />
      }
      footer={
        <ComposerShell label={label} surface={phone ? 'phone' : 'desktop'} stat={stat} />
      }
    >
      <div
        // The room the floating composer needs, plus (on the phone) the room the
        // floating header card needs. Both are the boards' own numbers.
        //
        // `min-h-full` belongs HERE, on the scroll region's direct child — a
        // percentage height resolved against a parent that is `auto` is a no-op,
        // which is exactly what made a three-message session hang from the top
        // of the pane with 600px of paper under it.
        className={`flex min-h-full flex-col ${
          phone ? 'px-[14px] pb-[92px] pt-[86px]' : 'px-6 pb-[90px] pt-[80px]'
        }`}
      >
        {/* Bottom-anchored, like every board: the column sits on the floor of
            the pane and grows upward. */}
        <div className="mx-auto mt-auto w-full max-w-[744px]">
          {isError && (
            <p className="py-8 text-center text-[13px] text-ink-2">
              Couldn’t load this conversation.
            </p>
          )}
          {!isError && items.length === 0 && !isLoading && (
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
              surface={phone ? 'phone' : 'desktop'}
              labels={labels}
              mentions={mentions}
              names={names}
              rawUrl={rawUrl}
              pinFor={pinFor}
            />
          ))}

          {/* Live layer (fase A3 T4) — permission first (nothing silently
              invisible), then overlay receipts, then the working row (or the
              delegation pill), then provisional text. */}
          <LiveLayer
            name={name}
            session={session}
            turnStart={turnStart}
            overlay={overlay}
            mentions={mentions}
            pinFor={pinFor}
            surface={phone ? 'phone' : 'desktop'}
            provisional={provisional}
          />
        </div>
      </div>
    </ChatSurface>
  )
}

export default ChatConversation
