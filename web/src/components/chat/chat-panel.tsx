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

import { useQuery } from '@tanstack/react-query'
import * as React from 'react'

import type { TileSession } from '@/components/session-tile/types'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useSessions } from '@/hooks/use-sessions'
import { commandsApi, filesApi, sessionsApi } from '@/lib/api'
import { restSessionInput, type SessionInput } from '@/lib/session-input'

import { detailFor, topAttention } from './attention'
import { ChatComposer } from './composer'
import { focusComposer } from './composer-draft'
import { ChatConversation, PHONE_QUERY } from './conversation'
import { useComposer } from './use-composer'
import { useDialogAnswer } from './use-dialog-answer'
import { usePeekLens } from './use-peek-lens'
import { usePendingSends } from './use-pending-sends'
import { displayNames, entryLabels, mentionIndex } from './grouping'
import { useChatTurn } from './use-chat-turn'
import { ProvisionalTail } from './provisional-tail'
import { exposeLatency, latencySummary, serverNowMs } from './latency'

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

  // ── The input plane (fase A4 T3) ───────────────────────────────────────────
  // ONE peek poller for the whole surface (T2): the composer's pre-send draft
  // guard reads it here, and T5/T6/T7's cards will read the same frame. It runs
  // fast while a turn is live, slow otherwise.
  const peek = usePeekLens(name, {
    live: turnStart != null,
    // A stopped session drops its version pin: the next thing to boot under
    // this name may be a different Claude Code (the CLI auto-updates).
    running: session?.status !== 'stopped',
  })
  const fallbackInput = React.useMemo(() => restSessionInput(name), [name])
  const plane = input ?? fallbackInput

  // ── Answering the dialog (fase A4 T7) ──────────────────────────────────────
  // The ONLY place in the app that presses a key into a TUI dialog, and it does
  // so through the same lens frame everything else on this surface reads: the
  // registry decides which options are live, `use-dialog-answer` re-verifies
  // the fingerprint and the caret before every key and checks the dialog is
  // gone afterwards, and any doubt at any step disables the card and raises
  // Attention instead of pressing on.
  //
  // The feedback branch (Escape on a permission, "Tell Claude what to change"
  // on a plan) ends in the REACT composer — there is no in-dialog free-text row
  // on 2.1.2xx (a0 §3), so the dialog is dismissed here and the sentence goes
  // through the normal send.
  const onFeedback = React.useCallback(() => focusComposer(name), [name])
  const dialog = useDialogAnswer({ peek, input: plane, onFeedback })
  // P10 (T4) sits BETWEEN the composer and the input plane: `pending.input` is
  // the same handle with every submit tracked, so the echo cannot get out of
  // step with the POST it is drawn for. `pending.attention` is T5's cause —
  // an undelivered send raises the Attention card there; until it lands the
  // undelivered ROW carries the reason and the way out.
  // The hook-driven dialog signal (≪1s), the SAME one `live-layer.tsx` renders
  // the choice card from. The pre-send gate reads it as a second source: it
  // holds the refusal when the peek is down, and it is what decides whether the
  // refusal may point at a card above the composer or has to name the terminal.
  // A card for a live dialog is on screen — the composer's refusal may point at
  // it ("answer the thing above") instead of naming the terminal. EITHER source
  // counts: the hook fires ≪1s ahead of the poll, and the lens sees dialogs the
  // hook never fires for at all (the plan family).
  const dialogCard = session?.permission_request != null || dialog.card != null
  const pending = usePendingSends({
    name,
    input: plane,
    peek,
    entries,
    active: session?.status === 'active',
    dialogCard,
    // The server's own delivery receipt (`set_last_send`, written by `/send`
    // AFTER the paste + Enter): transport-independent evidence that a send
    // arrived, which is exactly what a dropped response leaves this client
    // without.
    receipt: session?.last_send_text
      ? { text: session.last_send_text, atS: session.last_send_at ?? 0 }
      : null,
  })
  const composer = useComposer({
    name,
    input: pending.input,
    peek,
    active: session?.status === 'active',
    dialogCard,
  })

  // ── What the `@`/`/` popover offers (fase A4 T9) ───────────────────────────
  // Fetched HERE, not in the picker: the panel is the data plane (the A3/A4
  // contract), and a lazily-loaded chunk that imported the API client for
  // itself made the bundler hoist that client into a third chunk for no new
  // behaviour. Both are `enabled` only while the popover is actually open —
  // `tracked-files` is a git walk on the server, not free — and both re-declare
  // the keys their hooks use, so they share those caches instead of doubling
  // them (`use-commands.ts`, and the same 30s staleTime as the sessions list).
  const picker = composer.picker
  const trackedFiles = useQuery<string[]>({
    queryKey: ['tracked-files', name],
    queryFn: () => sessionsApi.trackedFiles(name),
    enabled: picker.open && picker.kind === '@',
    staleTime: 30_000,
    // A session with no repo answers with an error; the honest response is an
    // empty picker, not three retries.
    retry: false,
  })
  const slashCommands = useQuery({
    queryKey: ['slash-commands'],
    queryFn: commandsApi.listSlashCommands,
    enabled: picker.open && picker.kind === '/',
    staleTime: 60_000,
    retry: false,
  })
  const pickerData = React.useMemo(
    () => ({
      files: trackedFiles.data,
      commands: slashCommands.data,
      sessions,
      loading: picker.kind === '@' ? trackedFiles.isLoading : slashCommands.isLoading,
    }),
    [picker.kind, sessions, slashCommands.data, slashCommands.isLoading, trackedFiles.data, trackedFiles.isLoading],
  )

  // ── The Attention card (fase A4 T5) ────────────────────────────────────────
  // ONE card, so the causes are ranked rather than stacked (`topAttention`).
  // Two raisers: a send the watchdog gave up on (T4), and a dialog this surface
  // will not answer — unmapped, unpinned, or a sequence that aborted (T7). The
  // card's evidence is the SAME capture every other consumer reads (one poller,
  // T2), so what it shows is what the refusal was decided on.
  const attention = topAttention([pending.attention, dialog.attention])
  // What the abort actually was. `dialog-unmapped`'s copy reads "no verified
  // mapping", which is true for an unknown dialog and FALSE for a sequence that
  // aborted on a caret somebody else moved — same cause, different fact, and
  // the card has to say which one happened.
  //
  // Scoped to the cause that WON the ranking — `detailFor` is that rule, and it
  // has its own test: the two raisers can fire in the same second and this
  // sentence must not end up inside the other one's card.
  const detail = detailFor(attention, dialog.attention, dialog.attentionDetail)
  const attentionCtx = React.useMemo(
    () => ({
      version: peek.lens.bannerVersion,
      // What the sighted fingerprint WAS captured against, so the version
      // sentence can name both halves rather than "some other versions".
      verifiedVersions: dialog.card?.verifiedVersions,
      detail: detail ?? undefined,
    }),
    [detail, dialog.card?.verifiedVersions, peek.lens.bannerVersion],
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
      dialog={dialog.card}
      dialogBusy={dialog.busy}
      onChooseDialog={dialog.choose}
      dialogResolved={dialog.resolved}
      onRetryPending={pending.retry}
      onDismissPending={pending.dismiss}
      attention={attention}
      attentionCtx={attentionCtx}
      attentionCapture={peek.capture}
      // The capture the card presents as "the session's own screen" must not be
      // a frame from before the tab was backgrounded — the poll pauses while
      // hidden and idles at 4s (A4 review). Expanding the card re-reads it.
      onExpandAttention={peek.refresh}
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
          // The popover's three lists (fase A4 T9) — the sessions among them
          // ride the shared query this component already subscribes to, the
          // same rule as `mentions`/`names`.
          pickerData={pickerData}
          // The dogfood number, readable without devtools (re-renders on the
          // live-layer ticker / tail refetches). It rides the composer's frame
          // now — the read-only shell this replaced is only reached when NO
          // composer slot is passed, and the panel always passes one.
          //
          // One pass over the bounded ring per render, not three array reads
          // plus a sort (#59) — `latency` is read once at the top of the
          // component.
          stat={
            latency.n > 0 ? (
              <>
                hook→UI p50 {latency.p50} ms (n={latency.n})
              </>
            ) : null
          }
        />
      }
    />
  )
}
