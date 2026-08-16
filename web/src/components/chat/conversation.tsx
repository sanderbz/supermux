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
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import type { MarkPin } from '../../brand/marks'
import { eases } from '../../lib/springs'
import { cn } from '../../lib/utils'
import type { TileSession } from '../session-tile/types'

import type { AttentionCause, AttentionContext } from './attention'
import { AttentionOverlay, AttentionRow } from './attention-card'
import type { DialogCardView } from './dialog-answer'
import { ChatSurface } from './chat-surface'
import { ComposerShell } from './composer-shell'
import type { ChatItem } from './entries'
import { buildTranscript } from './grouping'
import { SessionHeaderPill } from './header-pill'
import { LiveLayer } from './live-layer'
import { deliveryLine, type PendingSend } from './pending'
import { TranscriptItem } from './transcript-item'
import { Bubble, MessageRow } from './ui'
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
  /**
   * The LIVE composer (fase A4 T3) — a slot, for the same reason `provisional`
   * is one: it talks to the input plane and the peek lens, and this component
   * may not. Omit it and the footer is A3's read-only `ComposerShell`, which is
   * exactly what `/dev/chat-live`'s static states and `chat-conversation.test`
   * still render. So "can this surface send?" is one prop, not a fork.
   */
  composer?: React.ReactNode
  /**
   * P10 optimistic echoes (fase A4 T4), oldest first — already reconciled and
   * watchdog-evaluated by `use-pending-sends`. Data rather than a slot, unlike
   * the composer: nothing here talks to the network, and the bench state that
   * proves the three states exist should be three objects, not a mounted hook.
   */
  pending?: readonly PendingSend[]
  /**
   * The one thing this surface currently cannot do (fase A4 T5). Data, not a
   * slot: the copy is a pure function of the cause (`attention.ts`), so the
   * bench state that proves each cause reads correctly is one string.
   */
  attention?: AttentionCause | null
  /** What the cause's sentence may quote — the CC version, a POST's error. */
  attentionCtx?: AttentionContext
  /** The raw `/peek?ansi=1` capture the card shows as evidence. Blank → the
   *  card degrades to message-only, which is what a stopped session gets. */
  attentionCapture?: string
  /** Start expanded. The card is inline-first everywhere else; this exists so
   *  `/dev/chat-live` (T10) can screenshot the overlay without a click. */
  attentionExpanded?: boolean
  /** Stop showing this cause — the user has read it. Omit and the card can only
   *  be collapsed, never dismissed. */
  onDismissAttention?: () => void
  /** Re-read the capture as the card opens. The poll idles at 4s and PAUSES
   *  while the tab is hidden, so "here is what the session is showing" could be
   *  describing a frame from before the tab was backgrounded (A4 review). */
  onExpandAttention?: () => void
  /**
   * The dialog the peek lens is seeing, as data (fase A4 T7) — which options
   * exist, which of them this app will actually press, and why not for the
   * rest. Built by `use-dialog-answer` out of the registry; drawn by
   * `live-layer.tsx`. Data rather than a slot, like `pending`: the bench state
   * that proves an answerable card and a hard-disabled one is a fixture, not a
   * mounted hook.
   */
  dialog?: DialogCardView | null
  dialogBusy?: number | 'escape' | null
  onChooseDialog?: (target: number | 'escape') => void
  /** The line the card became once an answer landed. */
  dialogResolved?: string | null
  /** Send it again (the hook re-runs the pre-send gate). */
  onRetryPending?: (id: string) => void
  /** Stop showing this failure — the user has read it. */
  onDismissPending?: (id: string) => void
  /** Switch this pane to the terminal renderer. Every refusal offers it. */
  onOpenTerminal?: () => void
  /** Absolute path → fetchable URL (`filesApi.rawUrl`). */
  rawUrl?: (path: string) => string
  /** Seed → identity pin, when a roster has assigned one (TODO §10). */
  pinFor?: (seed: string) => MarkPin | undefined
  /** Force the composition. Omit and it follows the viewport. */
  surface?: 'desktop' | 'phone'
  /** The tail query's two unhappy states. */
  isError?: boolean
  isLoading?: boolean
  /** The shell's own header affordances — A5's mobile shell fills them with the
   *  back button and the renderer switch (`routes/focus/mobile.tsx`). */
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
  composer,
  pending,
  attention = null,
  attentionCtx,
  attentionCapture,
  attentionExpanded = false,
  onDismissAttention,
  onExpandAttention,
  dialog,
  dialogBusy,
  onChooseDialog,
  dialogResolved,
  onRetryPending,
  onDismissPending,
  onOpenTerminal,
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

  // "No conversation yet." is a statement about the WHOLE track, not about the
  // confirmed layer alone. The layers below this line — the optimistic echo of
  // a message this client just sent, a pending permission dialog, overlay
  // receipts, the working row, provisional text, an attention row — are all
  // conversation, and a session's very first send puts one of them on screen
  // seconds before the transcript confirms anything. Keyed off `items.length`
  // alone, the empty line rendered directly above the user's own just-sent
  // bubble (mobile proof, 05-sent-pending-light.png).
  const isBlank =
    items.length === 0 &&
    (pending?.length ?? 0) === 0 &&
    (overlay?.length ?? 0) === 0 &&
    !provisional &&
    !dialog &&
    !dialogResolved &&
    !attention &&
    !session?.permission_request &&
    !(session?.status === 'active' && turnStart != null)

  // Inline-first (A4 T5): the row is in the band, the evidence is one tap away.
  // The expansion is presentation-local state — nothing above this component
  // needs to know whether the user has opened the card — and it RESETS when the
  // cause changes, so a card opened for a failed send does not silently become
  // an open card about an unmapped dialog.
  const [expanded, setExpanded] = React.useState(attentionExpanded)
  const shownFor = React.useRef(attention)
  if (shownFor.current !== attention) {
    shownFor.current = attention
    if (expanded !== attentionExpanded) setExpanded(attentionExpanded)
  }

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
        composer ?? (
          <ComposerShell label={label} surface={phone ? 'phone' : 'desktop'} stat={stat} />
        )
      }
      // The expanded card, over this pane only (see `attention-card.tsx`).
      overlay={
        attention && (
          <AttentionOverlay
            open={expanded}
            cause={attention}
            ctx={attentionCtx}
            capture={attentionCapture}
            surface={phone ? 'phone' : 'desktop'}
            onClose={() => setExpanded(false)}
            onOpenTerminal={onOpenTerminal}
            onDismiss={onDismissAttention}
          />
        )
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
        //
        // The `stat` read-out floats 42px ABOVE the composer pill
        // (`ComposerFrame`), i.e. outside the room these numbers reserve — so
        // with one on screen it printed straight through the last transcript
        // row, two strings of grey text on the same pixels (mobile proof,
        // 11-permission-card-light.png: "Run cowsay-nonexistent --version"
        // under "hook→UI p50 8 ms"). It is transparent by design, so the track
        // has to reserve its row.
        className={`flex min-h-full flex-col ${
          phone
            ? stat
              ? 'px-[14px] pb-[122px] pt-[86px]'
              : 'px-[14px] pb-[92px] pt-[86px]'
            : stat
              ? 'px-6 pb-[120px] pt-[80px]'
              : 'px-6 pb-[90px] pt-[80px]'
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
          {!isError && !isLoading && isBlank && (
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

          {/* P10 (fase A4 T4) — what this client has SENT but the transcript
              has not confirmed yet. It sits between the confirmed layer and the
              live layer because that is where a just-sent message belongs in
              time: after everything Claude has said, before whatever it is
              saying now. */}
          <PendingEchoes
            pending={pending}
            active={session?.status === 'active'}
            surface={phone ? 'phone' : 'desktop'}
            onRetry={onRetryPending}
            onDismiss={onDismissPending}
            onOpenTerminal={onOpenTerminal}
          />

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
            dialog={dialog}
            dialogBusy={dialogBusy}
            onChooseDialog={onChooseDialog}
            dialogResolved={dialogResolved}
            attention={
              attention && (
                <AttentionRow
                  cause={attention}
                  ctx={attentionCtx}
                  expanded={expanded}
                  onExpand={() => {
                    onExpandAttention?.()
                    setExpanded(true)
                  }}
                />
              )
            }
          />
        </div>
      </div>
    </ChatSurface>
  )
}

/**
 * The echo's ARRIVAL, and only its arrival.
 *
 * There is deliberately no exit counterpart (daily-driver QA #10). The confirmed
 * bubble does not land in this cell — it lands in the transcript directly above
 * — so an exit fade here is not a crossfade at all: it is 260ms during which the
 * user's message is on screen TWICE, one copy fading over the other, followed by
 * the band collapsing under a live layer that then jumps (measured: two bubbles
 * from 1372ms to 1576ms, then an 82px jump).
 *
 * `reconcile` already runs in RENDER (`use-pending-sends.ts`), so the frame that
 * first draws the confirmed bubble is the frame that drops this row: with no
 * exit to hold it mounted, the swap is atomic and there is never a frame with
 * two copies in it. The only motion left is the arrival of something new, which
 * is the one thing motion is for here.
 */
const ECHO_SWAP_S = 0.26

/**
 * The height the delivery line occupies, reserved whether or not it has anything
 * to say.
 *
 * `deliveryLine` swaps one sentence for another as the receipt lands, and a
 * sentence that wraps differently from its predecessor moves everything below
 * it. Fixing the row's height makes every state change inside the band a
 * REPAINT: the working row underneath does not move while the message goes from
 * "Sending…" to "The session has it".
 */
const RECEIPT_ROW = 'mt-[5px] h-[17px] overflow-hidden'

/** One tap target for the undelivered row's three controls. `h-[34px]` is the
 *  height `ChoiceCard`'s pill has off the approved boards — the smallest thing
 *  this surface asks anybody to hit — even though the label reads at 12px. */
const ECHO_ACTION = 'inline-flex h-[34px] items-center rounded-full px-2'

/**
 * P10 — the optimistic echo band (fase A4 T4).
 * ─────────────────────────────────────────────────────────────────────────────
 * A sent message drawn at REDUCED EMPHASIS, with an affordance that says
 * exactly how much this surface currently knows about it:
 *
 *   sending      the POST is in flight. Nothing but the lowered opacity — the
 *                bubble already says "your Enter was received".
 *   unconfirmed  the POST returned 2xx and the transcript has not echoed it
 *                yet. A 12px line, no alarm: this is the normal state for the
 *                seconds between a send and Claude writing it down.
 *   undelivered  the watchdog gave up (`pending.ts`). Calm orange, the reason
 *                when one is known, and the two ways out — send it again, or
 *                go and look at the pty yourself.
 *
 * It RECONCILES as a no-op crossfade, never a second entry-pop: the confirmed
 * bubble lands in the transcript above at the same moment this row fades, so
 * the message never appears to arrive twice. That is the same technique
 * `live-layer.tsx`'s `SwapCell` uses for P13, and the reason `AnimatePresence`
 * wraps the list rather than each row.
 */
export function PendingEchoes({
  pending,
  active = false,
  surface = 'desktop',
  onRetry,
  onDismiss,
  onOpenTerminal,
}: {
  pending?: readonly PendingSend[]
  /** A turn is running — what a delivered-but-unechoed send is waiting behind
   *  (`deliveryLine`). */
  active?: boolean
  surface?: 'desktop' | 'phone'
  onRetry?: (id: string) => void
  onDismiss?: (id: string) => void
  onOpenTerminal?: () => void
}) {
  const reduce = useReducedMotion() ?? false
  return (
    // The live region is the PERSISTENT wrapper (the same rule the composer's
    // refusal banner follows): a role mounted at the same moment as its text is
    // announced inconsistently, and "this message did not land" is the one thing
    // on this surface a user learns by NOT getting what they asked for.
    <div data-testid="chat-pending-band" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {(pending ?? []).map((p) => (
          <motion.div
            key={p.id}
            data-testid="chat-pending"
            data-state={p.state}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            // No `exit`: see `ECHO_SWAP_S`. The row leaves in the same commit
            // the confirmed bubble arrives in, so the two are never both on
            // screen.
            transition={{ duration: reduce ? 0 : ECHO_SWAP_S, ease: eases.inOut }}
          >
            <MessageRow me>
              <div className="flex min-w-0 flex-col items-end">
                <Bubble
                  variant="user"
                  surface={surface}
                  // Reduced emphasis while it is still a claim; full weight once
                  // it is a stated failure, because that row has to be read.
                  className={cn(p.state !== 'undelivered' && 'opacity-[0.62]')}
                >
                  <span className="whitespace-pre-wrap break-words">{p.text}</span>
                </Bubble>

                {/* The RECEIPT, not a spinner: once the server has confirmed
                    it typed the text into the pty, the row says so — and names
                    the running turn the message is queued behind, which is the
                    normal reason a mid-turn send is not in the transcript yet
                    (`deliveryLine`, which also records why CC's own queue
                    receipt cannot reach this client on this branch). */}
                {/* The row is RESERVED from the moment the echo is drawn and
                    filled when there is something to say: the POST coming back
                    must not move the working row under it (QA #10). While the
                    send is in flight it stays empty — the bubble's own reduced
                    weight is the whole claim at that point. */}
                {p.state !== 'undelivered' && (
                  <p
                    data-testid="chat-pending-receipt"
                    data-receipted={p.receipted || undefined}
                    className={cn(
                      RECEIPT_ROW,
                      'text-[12px] leading-[17px] tracking-[-0.05px] text-ink-2',
                    )}
                  >
                    {p.state === 'unconfirmed' ? deliveryLine(p, { active }) : ''}
                  </p>
                )}

                {p.state === 'undelivered' && (
                  <div className="mt-[1px] flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-[12px] tracking-[-0.05px]">
                    {/* Calm orange, never alarmist red — the `--status-error`
                        token the tiles already use for a dead agent. */}
                    <span data-tone="warn" className="mr-1 text-status-error">
                      {p.note ?? 'This didn’t reach the session.'}
                    </span>
                    {/* 34px, the height every actionable control on this surface
                        has (`ChoiceCard`'s pill, off the approved boards) —
                        NOT the 12px the label reads at. Retry is the one control
                        here that writes to the pty, it sits a thumb's width from
                        two others, and a mis-tap on a phone is a duplicate
                        prompt in somebody's agent. */}
                    <button
                      type="button"
                      data-testid="chat-pending-retry"
                      onClick={() => onRetry?.(p.id)}
                      className={cn(ECHO_ACTION, 'font-medium text-ink underline underline-offset-2')}
                    >
                      Retry
                    </button>
                    {onOpenTerminal && (
                      <button
                        type="button"
                        data-testid="chat-pending-open-terminal"
                        onClick={onOpenTerminal}
                        className={cn(ECHO_ACTION, 'text-ink underline underline-offset-2')}
                      >
                        Open terminal
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Dismiss"
                      data-testid="chat-pending-dismiss"
                      onClick={() => onDismiss?.(p.id)}
                      className={cn(ECHO_ACTION, 'text-ink-2')}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            </MessageRow>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export default ChatConversation
