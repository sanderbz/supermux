// /dev/chat-live — the bench for the LIVE chat surface (fase A3).
//
// DEV-only + lazy + mounted outside <Layout> (mirrors /dev/chat-ui, /dev/marks,
// /dev/tiles), so neither the route nor its fixture can reach a production
// chunk.
//
// WHAT THIS IS FOR, and how it differs from `/dev/chat-ui`:
//   · `/dev/chat-ui` is the PRIMITIVE bench — every B0 object, drawn by hand,
//     with the variants a board has no room for.
//   · this is the RENDERER bench — the real `<ChatConversation>` (the component
//     the app mounts), fed the wire shapes the server actually sends, in every
//     state the surface can be in. If the renderer stops matching the boards,
//     this page stops matching them; nothing else in the repo can catch that.
//
// The chrome around the surface is deliberately thin and deliberately REAL: the
// roster is the shipped `RosterRow`, so the elevation step between the paper and
// the conversation pane — half of what the approved boards approve — can be read
// off this page. The phone frame is the same idea: `mobile-light.png` has a
// status bar above the surface, so the bench draws one.
//
// URL:
//   ?mock            seed the shared sessions cache from the mocks (the app's
//                    existing DEV switch; this page needs no backend either way)
//   &conn=<state>    reconnecting · stale · offline — the A6 honesty chip
//   &state=<id>      idle · working · provisional · permission · delegation ·
//                    error · offline · patch
//   &surface=phone   the phone composition at any window width
//   &theme=dark      force the app theme (persists — it is the real switch)
//   &bare=1          hide the picker, for screenshots
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'

import { PAPER } from '@/brand/tokens'
import { ChatComposer } from '@/components/chat/composer'
import { ChatConversation, PHONE_QUERY } from '@/components/chat/conversation'
import { ConnectionNote } from '@/components/chat/connection-note'
import { toDisplayList } from '@/components/chat/entries'
import { EntityPickerView } from '@/components/chat/entity-picker'
import { handoffLabel, readDelegateIntent } from '@/components/chat/delegate-intent'
import { atRows, slashRows } from '@/components/chat/slash'
import type { ComposerHandle } from '@/components/chat/use-composer'
import { entryLabels } from '@/components/chat/grouping'
import { ProvisionalTailView } from '@/components/chat/provisional-tail'
import { RendererSwitch } from '@/components/chat/renderer-switch'
import { sessionAccentVarsFor } from '@/components/chat/session-accent'
import { BackIcon, PHONE, RosterRow } from '@/components/chat/ui'
import { useTheme } from '@/components/theme-provider'
import { useMediaQuery } from '@/hooks/use-media-query'

import {
  BENCH_COMMANDS,
  BENCH_ROSTER,
  liveStates,
  MENTIONABLE,
  pinFor,
  MENTIONS,
  NAMES,
  STATE_IDS,
  TRACKED_FILES,
  type LiveState,
} from './dev-chat-live.fixture'

export default function DevChatLive() {
  const [params, setParams] = useSearchParams()
  const { resolvedTheme, setTheme } = useTheme()

  // `?theme=` drives the REAL theme switch rather than a `[data-theme]` subtree:
  // this page renders the app's own components, and the app reads the theme off
  // <html>. A subtree override here would review a theme the app cannot be in.
  const wanted = params.get('theme')
  React.useEffect(() => {
    if (wanted === 'light' || wanted === 'dark') setTheme(wanted)
  }, [wanted, setTheme])

  // One clock for the whole page: the divider labels and the working row's
  // elapsed clause are both derived from it, so a screenshot is one moment.
  const [nowMs] = React.useState(() => Date.now())
  const states = React.useMemo(() => liveStates(nowMs), [nowMs])

  const wantedState = params.get('state') ?? 'idle'
  const state = states.find((s) => s.id === wantedState) ?? states[0]

  // `?conn=reconnecting|stale|offline` — the data plane's honesty chip (A6 T2).
  //
  // It exists because the VR matrix could not see this work at all: the chip
  // renders NOTHING while `live`, which is the whole design, so a bench with no
  // knob for the other three states produces 148/148 SAME and proves only that
  // nothing regressed. A capture rig that cannot reach a state is not evidence
  // about it.
  const conn = params.get('conn')
  const connState =
    conn === 'reconnecting' || conn === 'stale' || conn === 'offline' ? conn : null

  const viewportPhone = useMediaQuery(PHONE_QUERY)
  const phone = params.get('surface') === 'phone' || viewportPhone
  const bare = params.has('bare')

  return (
    <div className="h-dvh w-full overflow-hidden bg-paper text-ink">
      {phone ? (
        <PhoneFrame state={state} nowMs={nowMs} conn={connState} />
      ) : (
        <BoardFrame state={state} nowMs={nowMs} conn={connState} />
      )}
      {!bare && (
        <Picker
          current={state.id}
          phone={phone}
          theme={resolvedTheme}
          onPick={(next) =>
            setParams(
              (p) => {
                p.set('state', next)
                return p
              },
              { replace: true },
            )
          }
          onTheme={(next) =>
            setParams(
              (p) => {
                p.set('theme', next)
                return p
              },
              { replace: true },
            )
          }
          title={state.title}
          board={state.board}
        />
      )}
    </div>
  )
}

/* ── the surface, wired ──────────────────────────────────────────────────── */

/**
 * The one thing on this page that is not bench chrome.
 *
 * Every prop below is the panel's own: the items come out of `toDisplayList`,
 * the labels out of `entryLabels`, the turn anchor is a server-clock ms stamp,
 * and the P13 slot holds the same block the poller renders — just without the
 * poll. No `rawUrl` on purpose: there is no server behind this page, so the
 * captured frame renders B0's honest warm placeholder instead of a broken image.
 */
/** A destination that exists but goes nowhere — see the `onOpen*` props below.
 *  Module-level so it is referentially stable and cannot break the transcript's
 *  memo boundary (`transcript-item.tsx`'s doc). */
const NOOP = () => {}

function Surface({
  state,
  nowMs,
  surface,
  headerLeading,
  headerTrailing,
}: {
  state: LiveState
  nowMs: number
  surface: 'desktop' | 'phone'
  headerLeading?: React.ReactNode
  headerTrailing?: React.ReactNode
}) {
  const items = React.useMemo(() => toDisplayList(state.entries), [state.entries])
  const labels = React.useMemo(() => entryLabels(state.entries), [state.entries])
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // Bottom-anchored on arrival, exactly as the panel's follow-bottom pin leaves
  // it — otherwise every screenshot would open on the top of the transcript.
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.id, surface])

  return (
    <ChatConversation
      name={state.session.name}
      session={state.session}
      items={items}
      labels={labels}
      mentions={MENTIONS}
      names={NAMES}
      events={state.events}
      // The chips are LIVE on the bench (fase B4 T3.6): a screenshot of an
      // inert chip proves nothing about the interactive variant, and the two
      // render different elements. The handlers go nowhere — this page has no
      // router — but the affordance is the thing under review.
      onOpenSession={NOOP}
      onOpenSchedule={NOOP}
      nowMs={nowMs}
      turnStart={state.turnAgo != null ? nowMs - state.turnAgo * 1000 : null}
      overlay={state.overlay}
      // The page's ONE clock (`nowMs`), not `Date.now()`: a screenshot is a
      // single moment, and the pill has a give-up window that a per-render
      // clock would make time-dependent.
      handoff={state.handoffTo ? { to: state.handoffTo, atMs: nowMs } : null}
      pinFor={pinFor}
      surface={surface}
      isError={state.isError}
      pending={state.pending}
      dialog={state.dialog ?? null}
      dialogBusy={state.dialogBusy ?? null}
      onChooseDialog={() => {}}
      dialogResolved={state.dialogResolved}
      attention={state.attention ?? null}
      attentionCapture={state.attentionCapture}
      attentionExpanded={state.attentionExpanded}
      // The raiser's own evidence, which for the blocked card is the terminal's
      // banner verbatim — reset time included. Without it the card still reads
      // as a sentence (`attention.ts` drops what it does not have), and a bench
      // that only ever showed the sentence-without-evidence would be reviewing
      // the wrong half.
      attentionCtx={state.attentionDetail ? { detail: state.attentionDetail } : undefined}
      onOpenTerminal={() => {}}
      onRetryPending={() => {}}
      onDismissPending={() => {}}
      onDismissAttention={() => {}}
      scrollRef={scrollRef}
      headerLeading={headerLeading}
      headerTrailing={headerTrailing}
      composer={state.composer ? <BenchComposer state={state} surface={surface} /> : undefined}
      provisional={
        state.provisional ? (
          <ProvisionalTailView
            lines={state.provisional}
            seed={state.session.name}
            pin={pinFor(state.session.name)}
            surface={surface}
          />
        ) : null
      }
    />
  )
}

/* ── the live composer, frozen (fase A4 T9) ──────────────────────────────── */

/**
 * The real `<ChatComposer>` with a STATIC handle.
 *
 * The bench's rule is one moment, no network — so instead of `useComposer` (a
 * draft store, a peek poller and two queries) the fixture hands over a
 * `ComposerHandle` literal. Everything a screenshot can catch is still the
 * shipped component: the pill, the Send/Stop swap, the refusal banner and the
 * popover, all rendered by the code the app mounts.
 *
 * The popover arrives through `renderPicker` — the same slot contract the rest
 * of this surface uses — fed by the picker's OWN row builders over the fixture
 * lists, so what is screenshotted here is what `tracked-files` and
 * `/api/slash-commands` will produce in the app.
 */
function BenchComposer({
  state,
  surface,
}: {
  state: LiveState
  surface: 'desktop' | 'phone'
}) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null)
  const spec = state.composer
  const noop = React.useCallback(() => {}, [])
  if (!spec) return null

  const name = state.session.name
  const handle: ComposerHandle = {
    draft: spec.draft,
    setDraft: noop,
    ref,
    sending: false,
    notice: spec.notice ?? null,
    dismissNotice: noop,
    submit: noop,
    stop: noop,
    insert: noop,
    // The send control's hand-off relabel (fase B4 T4.4) — derived from the
    // fixture's own draft through the SHIPPED rule, so a bench that says
    // "Hand to ●Patch" is one the composer would also say it on.
    handoff: (() => {
      const intent = readDelegateIntent(spec.draft, MENTIONS, name)
      return intent ? { to: intent.to, label: handoffLabel(intent.to, NAMES) } : null
    })(),
    handoffPending: null,
    picker: {
      open: spec.picker != null,
      kind: spec.picker?.kind ?? '@',
      query: spec.picker?.query ?? '',
      pick: noop,
      close: noop,
      bind: noop,
    },
    onChange: noop,
    onKeyDown: noop,
    onSelect: noop,
  }

  return (
    <ChatComposer
      name={name}
      label={state.session.display_name?.trim() ? state.session.display_name : name}
      handle={handle}
      surface={surface}
      active={state.session.status === 'active'}
      onOpenTerminal={noop}
      onSchedule={spec.schedulable ? noop : undefined}
      pickerData={{
        files: TRACKED_FILES,
        commands: BENCH_COMMANDS,
        sessions: MENTIONABLE,
      }}
      renderPicker={(p) => (
        <EntityPickerView
          rows={
            p.kind === '@'
              ? atRows(p.files, p.sessions ?? [], name, p.query)
              : slashRows(p.commands, p.query)
          }
          activeIndex={0}
          surface={surface}
          onHover={noop}
          onPick={noop}
        />
      )}
    />
  )
}

/* ── desktop: the surface, in the boards' window ─────────────────────────── */

function BoardFrame({ state, nowMs, conn }: { state: LiveState; nowMs: number; conn: 'reconnecting' | 'stale' | 'offline' | null }) {
  const { resolvedTheme } = useTheme()
  const ring = PAPER[resolvedTheme].paper
  return (
    <div className="flex h-full w-full">
      {/* Bench chrome — the roster the pane is read against (Track B owns the
          real one). Shipped primitive, boards' rows, so the elevation step and
          the selected row's accent wash are the real ones. */}
      <aside
        // The shell carries the FOCUSED session's tint too (master plan §11.3 —
        // `--sm-session-tint`), which is what paints the selected row's wash.
        // Track B owns the real sidebar; the bench models the write so the C7
        // contract can be reviewed end to end: one property, two panes.
        style={sessionAccentVarsFor(state.session, pinFor(state.session.name))}
        className="relative z-[2] flex w-[280px] flex-none flex-col bg-paper pt-3"
      >
        <div className="flex flex-col gap-0.5 overflow-hidden px-2">
          {BENCH_ROSTER.map((row) => (
            <RosterRow
              key={row.seed}
              seed={row.seed}
              pin={pinFor(row.seed)}
              name={row.label}
              timestamp={row.timestamp}
              preview={row.preview}
              state={row.state}
              attention={row.attention}
              selected={row.seed === state.session.name}
              ring={ring}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-hairline" />
      </aside>

      <main className="relative min-w-0 flex-1">
        <Surface
          state={state}
          nowMs={nowMs}
          surface="desktop"
          headerTrailing={conn ? <ConnectionNote state={conn} onRetry={NOOP} /> : undefined}
        />
      </main>
    </div>
  )
}

/* ── phone: the surface, under the status bar ────────────────────────────── */

function PhoneFrame({ state, nowMs, conn }: { state: LiveState; nowMs: number; conn: 'reconnecting' | 'stale' | 'offline' | null }) {
  return (
    <div className="relative mx-auto flex h-full w-full max-w-[390px] flex-col bg-paper-raised">
      {/* Device chrome, not ours: the status bar and the notch `mobile-*.png`
          draws above the surface. Held at the phone's own 54px so the floating
          header card lands exactly where the board puts it. */}
      <div style={{ height: PHONE.topbar }} className="relative z-[5] flex-none bg-paper-raised">
        <div className="absolute left-1/2 top-3 h-[30px] w-[110px] -translate-x-1/2 rounded-full bg-[#0d0c0b] shadow-[0_0_0_0.5px_var(--sm-hairline)]" />
        <div className="absolute inset-x-[26px] top-5 flex h-4 items-center justify-between text-[13px] font-semibold tracking-[-0.1px] text-ink">
          <span className="tabular-nums">2:06</span>
          <span aria-hidden className="flex h-[9px] items-end gap-[2.5px]">
            {[4, 6, 8, 9].map((h) => (
              <i key={h} style={{ height: h }} className="block w-[3px] rounded-sm bg-ink" />
            ))}
          </span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <Surface
          state={state}
          nowMs={nowMs}
          surface="phone"
          // What A5's mobile shell ACTUALLY puts in these two slots
          // (`routes/focus/mobile.tsx`), so the card's geometry is reviewable
          // as shipped rather than as sketched: the back button, and the
          // renderer switch at its compact size. The board's account avatar is
          // Track B's affordance and has no shell to come from yet — drawing it
          // here would approve a 28px trailing slot the app fills with a 124px
          // segmented control, which is the one measurement on this card that
          // decides how much of the session's name survives.
          headerLeading={
            <span
              aria-hidden
              className="grid size-[34px] flex-none place-items-center rounded-full bg-fill-soft text-ink-2"
            >
              <BackIcon />
            </span>
          }
          headerTrailing={
            <>
              {conn ? <ConnectionNote state={conn} onRetry={NOOP} /> : null}
              <RendererSwitch size="sm" labels="selected" value="auto" resolved="chat" onChange={() => {}} />
            </>
          }
        />
      </div>
    </div>
  )
}

/* ── the picker (hidden with ?bare=1) ────────────────────────────────────── */

function Picker({
  current,
  phone,
  theme,
  title,
  board,
  onPick,
  onTheme,
}: {
  current: string
  phone: boolean
  theme: 'light' | 'dark'
  title: string
  board: string
  onPick: (id: string) => void
  onTheme: (theme: 'light' | 'dark') => void
}) {
  return (
    <div
      className={`fixed z-50 flex max-w-[calc(100vw-24px)] flex-col gap-2 rounded-2xl border-[0.5px] border-hairline bg-surface p-3 shadow-[var(--sm-card-shadow)] backdrop-blur-[30px] ${
        phone ? 'inset-x-3 bottom-3' : 'right-4 top-4 w-[280px]'
      }`}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-semibold text-ink">{title}</span>
        <span className="text-[11.5px] text-ink-3">held against {board}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {STATE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            data-testid={`bench-state-${id}`}
            className={`rounded-full border-[0.5px] border-hairline px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
              id === current ? 'bg-fill-soft-2 text-ink' : 'text-ink-2 hover:bg-fill-soft'
            }`}
          >
            {id}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
        className="self-start rounded-full border-[0.5px] border-hairline px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-fill-soft"
      >
        {theme === 'dark' ? 'to light' : 'to dark'}
      </button>
    </div>
  )
}
