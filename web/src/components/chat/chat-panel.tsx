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
import { useNavigate } from 'react-router-dom'

import type { TileSession } from '@/components/session-tile/types'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useSessions } from '@/hooks/use-sessions'
import { agentsApi, commandsApi, filesApi, sessionsApi } from '@/lib/api'
import { restSessionInput, type SessionInput } from '@/lib/session-input'

import { useRosterMarks } from '@/hooks/use-roster-marks'
import { claimChatSurface } from '@/lib/live-region-owner'

import { detailFor, topAttention } from './attention'
import {
  awaitingInputState,
  blockedComposerNote,
  blockedState,
  lensBlockedAsBlockedState,
} from './blocked'
import { ConnectionNote } from './connection-note'
import { TruncationProvider } from './truncation'
import { CHAT_GONE, isPlaneDown } from './connection'
import { useChatPresentation } from './use-chat-ws'
import {
  FOLLOW_THRESHOLD_PX,
  followsFooterGrowth,
  jumpVisible,
  restoredScrollTop,
  shouldLoadOlder,
  type ScrollMark,
} from './backlog'
import { ChatComposer } from './composer'
import { focusComposer } from './composer-draft'
import { ChatConversation, PHONE_QUERY } from './conversation'
import { useComposer } from './use-composer'
import { useHarnessEvents } from './use-harness-events'
import { useDialogAnswer } from './use-dialog-answer'
import { LoginCard, ProviderAuthCard } from './login-card'
import { loginOwnsScreen as loginOwns } from './login-lens'
import { useLogin } from './use-login'
import { usePeekLens } from './use-peek-lens'
import { usePendingSends } from './use-pending-sends'
import { displayNames, entryLabels, mentionIndex } from './grouping'
import { useChatTurn } from './use-chat-turn'
import { ProvisionalTail } from './provisional-tail'
import type { ScheduleRef } from './transcript-item'
import { exposeLatency, latencySummary, serverNowMs } from './latency'

/**
 * LAZY, and it is budget-load-bearing (fase B4 T8).
 *
 * The sheet pulls in the whole scheduler editor — the form, the recurrence
 * builder, the fire log, the session picker. Imported statically it landed 8 KB
 * gz in the HERO path, for a modal nobody has opened yet. It is only ever
 * mounted while `open`, so the chunk is fetched at the moment of the tap, which
 * is the same trade the `@`/`/` picker makes (`composer.tsx`).
 */
const SessionSchedulesSheet = React.lazy(
  () => import('@/components/session-schedules/session-schedules-sheet'),
)

export default function ChatPanel({
  name,
  session,
  input,
  onOpenTerminal,
  surface,
  headerLeading,
  headerTrailing,
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
  /**
   * FORCE the composition (fase A5). Omit and it follows the viewport, which is
   * what the desktop seam wants. The MOBILE seam passes `'phone'` outright: the
   * route fork that mounts it is the app's 768px one, so a 600px-wide phone in
   * landscape (or a small tablet) is on the mobile route while the 480px
   * `PHONE_QUERY` still reads false — and it would get the desktop board inside
   * the mobile sheet, with a 744px track in a 600px pane and a header bar where
   * the shell expects a floating card.
   */
  surface?: 'desktop' | 'phone'
  /**
   * The shell's own header affordances (fase A5), passed through to the header
   * card. NAVIGATION and RENDERER CHOICE — neither of which this surface owns:
   * the mobile shell fills them with its back button and the renderer switch,
   * because on the phone the chat surface's card IS the route's header (there
   * is no room for the focus header above it).
   */
  headerLeading?: React.ReactNode
  headerTrailing?: React.ReactNode
}) {
  // The turn state machine (anchor, supersede gate, teardown, 1s ticker)
  // lives in `use-chat-turn.ts` — this component is wiring only.
  const { entries, items, turnStart, showProvisional, overlay, tail, backlog } = useChatTurn(
    name,
    session,
  )

  React.useEffect(() => exposeLatency(), [])
  // WHO OWNS THE OUTAGE STORY. While this panel is on screen the chat plane's
  // own chrome — the honesty chip in the header, the undelivered row in the
  // band — carries what is wrong, over a transcript that deliberately STAYS.
  // The app-root `ConnectionOverlay` reads this claim and stands its
  // full-screen curtain down, because a curtain over the transcript makes that
  // documented promise false in exactly the scenario the reconnect specs test.
  React.useEffect(() => claimChatSurface(), [])
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
  // The other half of the transcript: what the HARNESS did — this session's
  // delegations, renames and schedule fires, read from the durable audit ledger
  // (SSE is only its invalidation tick). Rendered as centred system lines in
  // the same ts-ordered stream the messages are in.
  const harness = useHarnessEvents(name, true)
  const events = harness.data
  // A harness chip is a destination (master plan §13.1): tapping the colleague
  // this session delegated to opens that session. Focus is a route, so the
  // panel — the data plane — is where the router is allowed to be reached.
  const navigate = useNavigate()
  const openSession = React.useCallback(
    (slug: string) => {
      // Navigating to where you already are is a route morph that redraws the
      // whole surface and loses the scroll position — for a click whose only
      // honest answer is "you are looking at it" (fase B4 T3.2).
      if (!slug || slug === name) return
      navigate(`/focus/${encodeURIComponent(slug)}`)
    },
    [name, navigate],
  )
  // The `⏱` chip's destination (fase B4 T8.5): this session's own Schedules
  // sheet, scrolled to the schedule when the ledger row knows its id. NOT a
  // route — the sheet exists whether or not B1's scheduler fold landed, and
  // that independence is §0.6's whole rule.
  const [scheduleSheet, setScheduleSheet] = React.useState<{
    scheduleId: string | null
    create: boolean
    draft?: string
  } | null>(null)
  const openSchedule = React.useCallback(
    (ref: ScheduleRef) => setScheduleSheet({ scheduleId: ref.id ?? null, create: false }),
    [],
  )
  const closeScheduleSheet = React.useCallback(() => setScheduleSheet(null), [])
  // The human path (fase B4 T9): the composer's clock opens the SAME sheet in
  // create mode with the draft carried over as the prompt. §13.3 calls this
  // "the trivial human path" and it stays trivial — no new form, no new
  // endpoint, and the draft is COPIED so cancelling costs nothing.
  const scheduleDraft = React.useCallback(
    (draft: string) => setScheduleSheet({ scheduleId: null, create: true, draft: draft.trim() }),
    [],
  )
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

  // ── the data plane, said out loud (fase A6 T2) ─────────────────────────────
  //
  // `tail.state` was read by NOTHING before A6 — the server computed staleness,
  // the socket mapped it, the hook exposed it, and the surface rendered
  // `reconnecting` and `no_hooks` identically to `live`. One clock, the
  // bucketed server clock the rest of this surface already ticks on, so the
  // ceiling costs no timer of its own.
  const connection = useChatPresentation(tail, nowBucketMs)
  const planeDown = isPlaneDown(connection)
  // A SESSION THAT HAS NEVER BEEN SPOKEN TO IS NOT A FAULT (verified finding 7).
  //
  // `classify_pointer` answers a missing pointer FILE with
  // `Reconnecting{reason:"no transcript for the tracked conversation"}`, and
  // that branch — unlike `no_hooks` — has no escalation ceiling, so the word
  // never changed. The client collapsed the distinct reason onto the one word
  // `reconnecting`, whose own four-word vocabulary defines it as "between
  // states", and the first screen of every new chat session showed a header
  // pill, a global toast and the body's "No conversation yet." all at once —
  // three claims about one calm fact, on the surface B4 was about to make the
  // default.
  //
  // So the chip stands down while there is nothing on screen to mis-present.
  // The moment the tail HAS entries the same reason means had-and-lost, and
  // then the chip is exactly right: a stale transcript is being shown as if it
  // were current. `use-chat-ws.ts::isFresh` owns the predicate for both this
  // and the app-wide link aggregate, so the two cannot disagree.
  // …and a TERMINAL close always speaks, fresh or not: "this session no longer
  // exists" is not the calm empty state, it is the end of one.
  const connectionNote =
    tail.fresh && tail.gone === null ? null : (
      <ConnectionNote state={connection} onRetry={tail.redial} gone={tail.gone} />
    )

  // ── one identity per session, across both surfaces (fase A6 T4.3) ──────────
  //
  // `pinFor` has been threaded through the whole renderer since A3 and was
  // supplied ONLY by the dev benches, so a session wore one face on the roster
  // and a different one in chat — the exact seam a user notices the day chat
  // becomes the default. B2 landed the persisted column (`0027_session_mark_pin`)
  // and the provider that dedupes it; this is the missing call.
  const { pinFor } = useRosterMarks()

  // Desktop board or phone board — the boards are two compositions, not one at
  // two widths (see `conversation.tsx`). The viewport decides unless the mount
  // point already knows (the mobile seam does — see `surface` above); the query
  // still runs either way, because a hook may not be conditional.
  const viewportPhone = useMediaQuery(PHONE_QUERY)
  const phone = surface ? surface === 'phone' : viewportPhone

  // Follow-bottom pin: stick to the newest content unless the user scrolled up.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pinnedRef = React.useRef(true)
  // The pill's visibility is STATE, not the pin's ref: it has to re-render.
  // Its threshold is its own (`JUMP_AWAY_PX`) — see `backlog.ts`.
  const [showJump, setShowJump] = React.useState(false)

  // ── back-pagination (QA #3) ────────────────────────────────────────────────
  // Reaching the top fetches the page below what is on screen, and the scroll
  // region is put back where the reader's eye was: the same distance from the
  // top of the OLD content, i.e. the height the prepend added, added on. Without
  // it, "load earlier" reads as the conversation teleporting.
  const restoreRef = React.useRef<ScrollMark | null>(null)
  const loadOlder = backlog.loadOlder
  const requestOlder = React.useCallback(() => {
    const el = scrollRef.current
    // Marked BEFORE the fetch, not in the response handler: by the time the
    // page lands the user may have scrolled on, and the mark has to describe
    // the layout the delta will be measured against.
    if (el) restoreRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    loadOlder()
  }, [loadOlder])

  const pagesLoaded = backlog.pagesLoaded
  const restoredFor = React.useRef(pagesLoaded)
  React.useLayoutEffect(() => {
    // Layout effect, and only on the commit that prepended: the correction has
    // to land before the browser paints, or the page visibly jumps first.
    if (restoredFor.current === pagesLoaded) return
    restoredFor.current = pagesLoaded
    const el = scrollRef.current
    const mark = restoreRef.current
    restoreRef.current = null
    if (!el || !mark) return
    el.scrollTop = restoredScrollTop(mark, el.scrollHeight)
  }, [pagesLoaded])

  const hasOlder = backlog.hasOlder
  const loadingOlder = backlog.loadingOlder
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distance < FOLLOW_THRESHOLD_PX
    setShowJump(jumpVisible(distance))
    if (shouldLoadOlder({ scrollTop: el.scrollTop, hasOlder, loading: loadingOlder })) {
      requestOlder()
    }
  }, [hasOlder, loadingOlder, requestOlder])

  const jumpToBottom = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setShowJump(false)
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  React.useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  })

  // …and the same pin, for the one thing that grows WITHOUT re-rendering this
  // component: the composer (r2 finding 34). The track reserves room for it by
  // MEASURING it, and that measurement is state inside `ChatConversation` — so
  // a refusal banner appearing re-rendered only that subtree, the effect above
  // never ran, and the newly taller glass covered another 76px of the live
  // band. It was found as the composer's own dialog-question refusal landing on
  // top of the dialog card it tells you to answer.
  const onReserveGrew = React.useCallback((grewBy: number) => {
    const el = scrollRef.current
    if (!el || !followsFooterGrowth(el, grewBy)) return
    pinnedRef.current = true
    el.scrollTop = el.scrollHeight
  }, [])

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

  // ── Signing in (AREA 3) ────────────────────────────────────────────────────
  // `/login` is the one needs-input state chat could not answer: it is pty-only
  // (the transcript records the slash command and nothing else), so the READ has
  // to be the same peek capture everything else on this surface reads. The
  // WRITE is one POST per step, and the server freezes supervision for the
  // duration — the PKCE verifier lives only inside the running process, so a
  // heal or a scheduled fire landing mid-flow would invalidate the code the
  // user is copying out of their browser at that moment.
  const login = useLogin(name, peek.capture)
  // ONE SIGHTING, ONE CARD (r2 finding 25).
  //
  // The login lens and the generic dialog lens read the SAME peek frame, and
  // `Select login method:` satisfies both: a SPECIFIC reader that knows the
  // three options and has a verified way to answer them, and a GENERIC one with
  // no fingerprint for that screen, which correctly degrades to "chat can't
  // answer this". Shipped side by side they contradicted each other inside one
  // viewport — the login card's pills answered the dialog while a second card
  // under it drew the same three options disabled, beneath a banner saying
  // nobody could. The more specific reader wins: while it owns the screen the
  // generic card, its resolution line and its attention row all stand down.
  //
  // The composer's gate is deliberately NOT relaxed by this (`dialogCard`
  // below still counts the generic sighting): text typed while a login dialog
  // is open would be pasted into a credential field, which is the one place
  // this surface must keep refusing.
  const loginOwnsScreen = loginOwns(login)
  const dialogAttention = loginOwnsScreen ? null : dialog.attention
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
  // An MCP server's form is up. Kept separate from `dialogCard` because it is a
  // different KIND of blindness: the lens sees the dialogs above and simply has
  // not fingerprinted this one — it cannot see an elicitation at all.
  const formCard = session?.elicitation != null
  const pending = usePendingSends({
    name,
    input: plane,
    peek,
    entries,
    active: session?.status === 'active',
    dialogCard,
    formCard,
    // The server's own delivery receipt (`set_last_send`, written by `/send`
    // AFTER the paste + Enter): transport-independent evidence that a send
    // arrived, which is exactly what a dropped response leaves this client
    // without.
    receipt: session?.last_send_text
      ? { text: session.last_send_text, atS: session.last_send_at ?? 0 }
      : null,
    // A6 T2.5 — do not manufacture "undelivered" out of a silence the dead
    // socket is itself causing.
    planeDown,
  })
  // ── The `@`-hand-off plane (fase B4 T4) ────────────────────────────────────
  // A draft that OPENS with `@colleague` is a hand-off, not a message, and the
  // send control says so before Enter is pressed. Dispatch is a real
  // `POST /api/agents/delegate` — the same endpoint an agent's curl uses — with
  // `actor: 'human'`, so the ledger records the owner rather than attributing
  // their instruction to their own agent (`lib/api/agents.ts` is explicit that
  // this is labelling, not authentication).
  //
  // The index is the one this panel already derives for the chips: a name that
  // is not a live session can never become a recipient.
  const handoff = React.useMemo(
    () => ({
      mentions,
      names,
      send: (to: string, prompt: string) => agentsApi.delegate({ from: name, to, prompt }),
    }),
    [mentions, name, names],
  )
  const composer = useComposer({
    name,
    input: pending.input,
    peek,
    active: session?.status === 'active',
    dialogCard,
    formCard,
    handoff,
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
  // ── THE BLOCKED AGENT (states audit) ───────────────────────────────────────
  // Two planes publish the same fact, and each covers the other's blind spot.
  // The TRANSCRIPT plane (`blocked.ts`): a quota/auth banner outlives its turn,
  // so it cannot be a status — derived from entries, it gates the composer and
  // survives lens gaps. The LENS plane: the peek ticks every 1–4 s and still
  // works when the transcript does not — which is the case that cause exists
  // for. A WARNING never raises a card (`limit-warning` is a header chip and
  // nothing more); a startup wedge draws a dialog card of its own, which is the
  // thing that can actually resolve it.
  const wireBlocked = React.useMemo(() => blockedState(entries), [entries])
  // THE TRANSCRIPT DIALOG PLANE (states audit). A `request_user_dialog` or an
  // MCP `task_* input_required` writes a durable "waiting on a human" row. The
  // live hook/lens (`dialogCard`/`formCard`) is the fast path, but it is blind
  // to the elicitation form family entirely and to everything while the peek is
  // down — exactly the case this durable plane exists to cover. It only gates
  // when NO live card already does: a card above the composer is answered by
  // typing into its own free-text row, so disabling the composer there would
  // take away the way to answer. With no card, nothing else refuses the send.
  const transcriptDialog = React.useMemo(() => awaitingInputState(entries), [entries])
  const uncoveredDialog = transcriptDialog && !dialogCard && !formCard ? transcriptDialog : null
  const lensBlocked =
    peek.lens.notice?.kind === 'limit-blocked' ? peek.lens.notice : null
  // …and the other silence: a live pty with an empty transcript. The lens sees
  // Claude Code's own footer warning; without it the chat surface renders an
  // empty conversation for a session that is actively talking.
  const blind = peek.lens.transcriptOff && entries.length === 0
  // …and the two PTY-07 states nothing on this surface could see. A PAUSED turn
  // is the worst of them: no hook fires (the turn has not ended), no transcript
  // line is written for the dialog, and the session sits waiting on a billing
  // question under a green dot. A REFUSED turn is the other direction — the turn
  // is dead and it looked like a transient API error.
  const lensPaused = peek.lens.notice?.kind === 'session-paused' ? peek.lens.notice : null
  const lensRefused = peek.lens.notice?.kind === 'turn-refused' ? peek.lens.notice : null
  // The composer gate reads BOTH planes. The transcript-plane block
  // (`wireBlocked`) is the richer sentence when present — it carries the
  // labelled bucket and its clock — so it wins; the PTY lens' own
  // `limit-blocked` sighting fills the silence when the transcript shows none
  // (the turn ended on an ordinary Stop, so no banner was ever written). Wiring
  // only `wireBlocked` was the half-fix: the attention card + header read the
  // lens, but the composer stayed live and promised delivery into a spent bucket.
  const composerBlock =
    wireBlocked ?? uncoveredDialog ?? lensBlockedAsBlockedState(lensBlocked)
  const attention = topAttention([
    lensPaused ? ('session-paused' as const) : null,
    wireBlocked ? ('agent-blocked' as const) : null,
    blind ? ('transcript-blind' as const) : null,
    lensBlocked ? ('session-blocked' as const) : null,
    pending.attention,
    dialogAttention,
    // The transcript plane's own dialog, when no live card is covering it — the
    // session says it is waiting and nothing visible here explains it, which is
    // exactly `waiting-unmodelled`. Ranks below the lens-driven dialog causes.
    uncoveredDialog ? ('waiting-unmodelled' as const) : null,
    lensRefused ? ('turn-refused' as const) : null,
  ])
  // What the abort actually was. `dialog-unmapped`'s copy reads "no verified
  // mapping", which is true for an unknown dialog and FALSE for a sequence that
  // aborted on a caret somebody else moved — same cause, different fact, and
  // the card has to say which one happened.
  //
  // Scoped to the cause that WON the ranking — `detailFor` is that rule, and it
  // has its own test: the two raisers can fire in the same second and this
  // sentence must not end up inside the other one's card.
  const detail =
    detailFor(attention, dialogAttention, dialog.attentionDetail) ??
    // The blocked card's evidence is Claude Code's own banner, verbatim — it
    // carries the reset time, and the remediation line when the terminal
    // printed one.
    detailFor(
      attention,
      lensBlocked ? 'session-blocked' : null,
      lensBlocked ? [lensBlocked.text, lensBlocked.detail].filter(Boolean).join(' — ') : null,
    ) ??
    // The paused card's evidence is the dialog's OWN body — which model, which
    // credits, which safeguard. The title is two words and the rows are two
    // verbs, so the body is the only place the question is actually asked.
    detailFor(attention, lensPaused ? 'session-paused' : null, lensPaused?.detail ?? null) ??
    detailFor(
      attention,
      lensRefused ? 'turn-refused' : null,
      lensRefused ? [lensRefused.text, lensRefused.detail].filter(Boolean).join(' ') : null,
    )
  const attentionCtx = React.useMemo(
    () => ({
      blockedLabel: wireBlocked?.label,
      blockedResets: wireBlocked?.resets,
      version: peek.lens.bannerVersion,
      // What the sighted fingerprint WAS captured against, so the version
      // sentence can name both halves rather than "some other versions".
      verifiedVersions: dialog.card?.verifiedVersions,
      detail: detail ?? undefined,
    }),
    [wireBlocked?.label, wireBlocked?.resets, detail, dialog.card?.verifiedVersions, peek.lens.bannerVersion],
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

  // A6 T4.2 — the seam a clipped row uses to ask for the rest of itself.
  // Memoised on the three values it carries so a re-render that changed
  // neither does not invalidate every transcript row.
  const truncation = React.useMemo(
    () => ({ fetching: tail.fetching, failed: tail.fetchFailed, request: tail.retryFull }),
    [tail.fetching, tail.fetchFailed, tail.retryFull],
  )

  return (
    <TruncationProvider value={truncation}>
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
      events={events}
      onOpenSession={openSession}
      onOpenSchedule={openSchedule}
      // The handoff pill's ONLY source (fase B4 T5): a POST this client made
      // and the ledger has not confirmed yet. The activity-string heuristic
      // that used to draw it is gone — see `live-layer.tsx::pendingHandoff`.
      handoff={composer.handoffPending}
      nowMs={nowBucketMs}
      turnStart={turnStart}
      overlay={overlay}
      surface={phone ? 'phone' : 'desktop'}
      headerLeading={headerLeading}
      // The honesty chip rides in the header's own trailing slot rather than
      // over the transcript: nothing is broken, so nothing should move.
      headerTrailing={
        <>
          {connectionNote}
          {headerTrailing}
        </>
      }
      pinFor={pinFor}
      isError={tail.isError}
      isLoading={tail.isLoading}
      gone={tail.gone}
      rawUrl={filesApi.rawUrl}
      scrollRef={scrollRef}
      onScroll={onScroll}
      // QA #3 / #17 — the two ends of the scroll region.
      hasOlder={backlog.hasOlder}
      loadingOlder={backlog.loadingOlder}
      olderError={backlog.olderError}
      atStart={backlog.atStart}
      onLoadOlder={requestOlder}
      showJumpToBottom={showJump}
      onJumpToBottom={jumpToBottom}
      pending={pending.items}
      // Suppressed while the sign-in card owns the screen — see
      // `loginOwnsScreen`. One pty sighting must not produce two cards.
      dialog={loginOwnsScreen ? null : dialog.card}
      dialogBusy={dialog.busy}
      onChooseDialog={dialog.choose}
      dialogResolved={loginOwnsScreen ? null : dialog.resolved}
      // The sign-in card is what is asking on this frame, so it is what the
      // screen reader is told about (`ASK_SAY`).
      signIn={login.sighting != null}
      onReserveGrew={onReserveGrew}
      // The live band's working row says what the session is ACTUALLY doing
      // during a stall — `session.activity` still names the last tool that ran
      // (`live-layer.tsx` `stalled`).
      stalled={peek.lens.notice?.kind === 'stream-stalled' ? peek.lens.notice.text : null}
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
      login={
        (login.providerAuth && (
          <ProviderAuthCard
            auth={login.providerAuth}
            onOpenTerminal={onOpenTerminal}
            surface={phone ? 'phone' : 'desktop'}
          />
        )) ||
        (login.sighting && (
          <LoginCard
            sighting={login.sighting}
            frozen={login.frozen}
            busy={login.busy}
            error={login.error}
            onSubmitCode={login.submitCode}
            onChooseMethod={login.chooseMethod}
            onConfirm={login.confirm}
            onCancel={login.cancel}
            onOpenTerminal={onOpenTerminal}
            surface={phone ? 'phone' : 'desktop'}
          />
        ))
      }
      composer={
        <ChatComposer
          name={name}
          label={session?.display_name?.trim() ? session.display_name : name}
          handle={composer}
          surface={phone ? 'phone' : 'desktop'}
          active={session?.status === 'active'}
          // NOTHING SENT INTO A BLOCKED SESSION ARRIVES. The composer says
          // which limit and when it lifts, rather than accepting a message
          // that Claude Code will never pick up (verify matrix:
          // `limit.hit.*` shipped with the composer live under a green dot).
          // A TERMINAL CLOSE OUTRANKS EVERY OTHER GATE. When the server has
          // said "no such session", there is no session left to be blocked, or
          // active, or anything else — and an enabled composer over a deleted
          // session invites someone to type a paragraph into nothing. This is
          // the same slot, so the surface still says exactly one thing.
          // A TERMINAL CLOSE OUTRANKS EVERY OTHER GATE (there is no session left
          // to block); otherwise the both-planes `composerBlock` decides.
          blocked={
            tail.gone !== null
              ? CHAT_GONE[tail.gone].detail
              : composerBlock
                ? blockedComposerNote(composerBlock)
                : undefined
          }
          onOpenTerminal={onOpenTerminal}
          // The popover's three lists (fase A4 T9) — the sessions among them
          // ride the shared query this component already subscribes to, the
          // same rule as `mentions`/`names`.
          pickerData={pickerData}
          onSchedule={scheduleDraft}
          // The dogfood number — DEV BUILDS ONLY (daily-driver QA #9).
          //
          // It shipped unconditionally and printed `hook→UI p50 9 ms (n=3)`
          // over the last bubble of a real conversation, on the surface that is
          // meant to BE somebody's chat client. A measurement nobody asked for
          // is not a feature, and one that collides with the newest message is a
          // defect twice over.
          //
          // The number itself is not lost: `exposeLatency()` above publishes the
          // same ring on `window.__supermuxChatLatency` in every build, so the
          // dogfood read is one devtools line away — and `import.meta.env.DEV`
          // is the repo's own gate for exactly this (`use-version.ts`,
          // `use-update-badge.ts`), which means the production bundle drops the
          // branch entirely rather than hiding it behind a flag.
          //
          // One pass over the bounded ring per render, not three array reads
          // plus a sort (#59) — `latency` is read once at the top of the
          // component.
          stat={
            import.meta.env.DEV && latency.n > 0 ? (
              <>
                hook→UI p50 {latency.p50} ms (n={latency.n})
              </>
            ) : null
          }
        />
      }
    />
    {/* Mounted only while it is open: the sheet subscribes to the scheduler
        stream and the schedules query, and neither should be running for every
        session anybody happens to be looking at. */}
    {scheduleSheet && (
      // No fallback: the sheet's own shell IS the loading state once it lands,
      // and a spinner for a chunk that arrives in one frame from cache would be
      // the only thing most people ever see of it.
      <React.Suspense fallback={null}>
      <SessionSchedulesSheet
        session={name}
        open
        onClose={closeScheduleSheet}
        scheduleId={scheduleSheet.scheduleId}
        createOnOpen={scheduleSheet.create}
        draftPrompt={scheduleSheet.draft}
      />
      </React.Suspense>
    )}
    </TruncationProvider>
  )
}
