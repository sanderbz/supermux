/**
 * The LIVE layer (fase A3 T4) — what is true *right now*, under everything the
 * transcript has already confirmed.
 * ─────────────────────────────────────────────────────────────────────────────
 * A1 established both the layer model and this stack's ORDER, and A3 changes
 * neither — only what each band looks like. Top to bottom:
 *
 *   confirmed content   (the transcript, `transcript-item.tsx`)
 *   attention           what this surface could NOT do (A4 T5) — a slot, and
 *                       empty on every A1/A3 path
 *   permission          the one thing on screen that is asking (`ChoiceCard`)
 *   overlay receipts    hook-driven, last line still running
 *   working row         the P12 state ladder — or a delegation pill when this
 *                       session has a hand-off in flight
 *   provisional text    the P13 pty tail, visibly unconfirmed
 *
 * THE PILL ONLY EVER DRAWS A DELEGATION THAT REALLY HAPPENED (fase B4 T5). It
 * used to be inferred by grepping `session.activity` for a known session name,
 * which drew a hand-off for an agent that merely *mentioned* a colleague. Now
 * its only source is a dispatch this client made, retired by the ledger row
 * that confirms it — see `pendingHandoff`. One consequence is worth stating
 * out loud: a delegation performed from this session's own pty by curl draws
 * NO pill, because the app learns about it after the fact. It gets its durable
 * `Delegated to ●x` line from the ledger like everything else, and that is the
 * honest rendering of "this already happened".
 *
 * Presentational, on purpose: it fetches nothing and owns no turn state, so
 * `renderToStaticMarkup` can pin the order and the wording without react-query,
 * SSE or `/peek`. The panel hands it the turn machine's output and injects the
 * one child that DOES talk to the network (`<ProvisionalTail>`) as a slot.
 *
 * Two rules inherited from the modules above and beside it:
 *   1. No `@/` alias anywhere in this file's runtime imports — the unit runner
 *      resolves the root tsconfig, which carries no `paths` (see
 *      `chat-surface.tsx`'s header). Type-only imports are erased, so they may.
 *   2. `components/chat/*` imports from `components/chat/ui`, never the reverse.
 */
import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { SessionMark, type MarkPin } from '../../brand/marks'
import { eases } from '../../lib/springs'

import type { HarnessEvent } from '../../lib/api/harness'
import type { PermissionRequestInfo, SessionMode } from '../../lib/api/sessions'
import { modeChipLabel } from '../focus-mode/mode-labels'
import type { TileSession } from '../session-tile/types'

import type { DialogCardView } from './dialog-answer'
import { formatElapsed, stripEmojiPrefix } from './entries'
import { toReceiptRows } from './grouping'
import { serverNowMs } from './latency'
import type { OverlayLine } from './use-receipt-overlay'
import { WorkingRow } from './working-row'
import {
  CardCode,
  ChoiceCard,
  DelegationPill,
  FormCard,
  InlineCode,
  MARK_SIZE,
  MessageRow,
  ReceiptGroup,
  RECEIPT_DEFAULT_MAX,
  SystemLine,
  type ChoiceOption,
  type Receipt,
} from './ui'

// `PHASE_SAY` is IMPORTED, not merely re-exported below: `ASK_SAY` reads
// `PHASE_SAY.asking` at module-evaluation time, and `export … from` creates no
// local binding — it threw `PHASE_SAY is not defined` on every module that
// touches this file.
import {
  LiveAnnouncer,
  PHASE_SAY,
  livePhase as computeLivePhase,
  useTurnVoiceClaim,
} from '../a11y/turn-announcer'


/**
 * The three answers the modal registry maps a Claude permission dialog to
 * (master plan §4.3). The digits are part of the design, not decoration: the
 * card and the terminal dialog answer to the same 1-2-3, so a user who learns
 * one has learned the other.
 *
 * A3 renders them and nothing else — `onChoose` stays undefined until A4 can
 * actually send the key, and the line under the card says so.
 */
export const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  { label: 'Allow once', primary: true, kbd: '1' },
  { label: 'Allow while this session runs', kbd: '2' },
  { label: 'Not now', kbd: '3' },
]

/** §11.6's same-cell swap: 260ms of opacity, and nothing else moves. */
const SWAP_S = 0.26

/**
 * The keyline that separates a floating mark from the surface behind it. The
 * bench passes `PAPER[theme].paperRaised` because it draws both themes at once;
 * the real surface has exactly one theme at a time and paints `bg-paper`, so it
 * hands the mark the same token the page is painted with and lets CSS resolve
 * it (`--sm-paper` flips with `[data-theme]`, this file hard-codes no colour).
 */
const PAGE_RING = 'var(--sm-paper)'

/**
 * Dialog families whose `body` is PROSE rather than a command, and may therefore
 * be soft-wrapped in the evidence block (states audit — the phone clipped the
 * paused card's second option out of a sentence that still read as finished).
 *
 * `permission` is deliberately absent: its body is the command being approved.
 * `unknown` too — an unrecognised screen is the one place to assume the strictest
 * reading of what the bytes mean.
 */
const PROSE_BODY_FAMILIES: ReadonlySet<string> = new Set(['paused', 'plan', 'startup'])

export interface LiveLayerProps {
  /** The focused session's immutable slug — the seed for every face here. */
  name: string
  session: TileSession | null
  /** SERVER-clock ms anchor for the running turn; null = no live turn. */
  turnStart: number | null
  /** Hook receipts for this turn, oldest first (`useReceiptOverlay`). */
  overlay?: readonly OverlayLine[]
  /**
   * A hand-off this app just dispatched (fase B4 T5), still unconfirmed.
   *
   * `atMs` is the CLIENT clock at dispatch — this is optimism about a POST this
   * client made, not a fact about the world, so it is compared against a client
   * stamp rather than the server's.
   */
  handoff?: { to: string; atMs: number } | null
  /** This session's harness ledger — the thing that RESOLVES the pill. */
  events?: readonly HarnessEvent[]
  /** Slug → display name, so the pill names a colleague and not a row. */
  names?: ReadonlyMap<string, string>
  pinFor?: (seed: string) => MarkPin | undefined
  /** Desktop or phone metrics — the overlay group is a bubble like any other. */
  surface?: 'desktop' | 'phone'
  /**
   * The P13 block. A slot rather than a child component because it polls
   * `/peek`: keeping the network out of this module is what lets the order
   * below be asserted in a hermetic test.
   */
  provisional?: React.ReactNode
  /**
   * The Attention card's inline row (fase A4 T5), TOP of the band — above even
   * the permission card, because it is the one thing here that may be about the
   * band itself: a send that never arrived, or a dialog this surface has just
   * declined to answer. A slot for the same reason `provisional` is one: it is
   * driven by the peek lens and the pending store, and this module fetches
   * nothing.
   */
  attention?: React.ReactNode
  /**
   * The sign-in card (AREA 3), directly under Attention and above the permission
   * card.
   *
   * ABOVE the permission card because it OUTRANKS it: while a login is up,
   * nothing else on this session can proceed — the freeze refuses every other
   * writer — so a permission prompt drawn beside it would be offering an action
   * that cannot be taken. A slot for the same reason `attention` is one: it is
   * driven by the peek lens and one POST, and this module fetches nothing.
   */
  login?: React.ReactNode
  /**
   * Is that sign-in card the thing ASKING right now?
   *
   * The card itself is a slot, so this band cannot look inside it — and while a
   * login owns the screen the panel suppresses the generic dialog card (one
   * sighting, one card), which would otherwise be what tells `livePhase` that
   * something is waiting on a human. Without this flag a screen reader was told
   * nothing at all about the one state that cannot proceed without them.
   */
  signIn?: boolean
  /**
   * The dialog the PEEK LENS is seeing, as data (fase A4 T7).
   *
   * The lens is the authority for *which* dialog and *where the caret is*; the
   * session's hook-driven `permission_request` is the fast trigger (≪1 s) and
   * the fallback below. Data rather than a slot for the same reason `pending`
   * is: `use-dialog-answer` decides what may be pressed, this file draws it,
   * and the bench proves both without a network.
   */
  dialog?: DialogCardView | null
  /** Which control is mid-sequence — the whole card goes inert while one is. */
  dialogBusy?: number | 'escape' | null
  /** Index, or `'escape'` for the feedback affordance. */
  onChooseDialog?: (target: number | 'escape') => void
  /** What the card became once an answer landed. Dialog outcomes write nothing
   *  to the transcript (a0 §3), so this line is the only record. */
  dialogResolved?: string | null
  /**
   * The pty's own STALL line, when the lens sees one (catalog
   * `err.stream_stalled`): `Waiting for API response · will retry in 3s · check
   * your network`.
   *
   * It replaces the working row's label for as long as it is on screen, and
   * that swap is the whole fix. During a stall the request is out, no bytes are
   * coming back, and `session.activity` still holds the last tool that RAN — so
   * the row read `◌ Read parser.rs · 2m 14s` about a call that finished two
   * minutes ago, which is worse than saying nothing: it invites the user to
   * wait for something that is not happening. The elapsed clause is untouched
   * and now says the true thing — how long this turn has been waiting.
   */
  stalled?: string | null
}

export function LiveLayer({
  name,
  session,
  turnStart,
  overlay = [],
  handoff = null,
  events,
  names,
  pinFor,
  surface,
  provisional,
  attention,
  login,
  signIn = false,
  dialog,
  dialogBusy = null,
  onChooseDialog,
  dialogResolved,
  stalled = null,
}: LiveLayerProps) {
  // The turn is running AND anchored. The anchor is what the elapsed clause
  // counts from, so a row without one would have nothing honest to say.
  const working = session?.status === 'active' && turnStart != null
  const target = pendingHandoff(handoff, events, name)
  // A STALL OWNS THE LABEL (see `stalled`). One expression, used by both the
  // overlay group's live line and the working row below it, so the two cannot
  // disagree about what the session is doing.
  const activity = stalled ?? session?.activity

  // THE ONE LIVE ROW (daily-driver QA #7).
  //
  // The overlay group and the working row were fed by the SAME signal — the
  // session's `activity` — so a single tool call was drawn twice at the same
  // time: `••• notes.md 5s` in the group and `◌ notes.md` on the pill under it.
  // (During a permission turn it was three: the card, the pill and the row.)
  //
  // The fix is not to hide one of them, it is to notice they were always one
  // thing: the group's last line is the call that is running, so it takes the
  // clock and the subagent count, and the pill is not drawn at all. When the
  // call finishes, that same line grows its outcome — one element resolving,
  // which is what the transcript will confirm one batch later.
  //
  // The label comes from `activity` rather than from the last overlay line so a
  // delta that has not been appended yet cannot leave the row a beat behind;
  // they are the same string on every frame where both exist.
  const liveRow =
    working && !target && overlay.length > 0
      ? {
          label: activity ? stripEmojiPrefix(activity) : overlay[overlay.length - 1].label,
          status: liveStatus(turnStart, session?.subagents, surface),
        }
      : undefined

  const phase = computeLivePhase({
    working,
    asking: !!(dialog || session?.permission_request || session?.elicitation || signIn),
    handoff: !!target,
  })
  // WHAT KIND of ask, for the one sentence that is spoken aloud. Same ordering
  // as the cards below, so the announcement and the pixels cannot disagree.
  const ask = askKind({
    form: !!session?.elicitation,
    dialog: dialog?.family,
    permission: !!session?.permission_request,
    signIn,
  })

  // ONE VOICE. The focus route also mounts a `TerminalTurnAnnouncer` (the
  // terminal renderer is still the default and needs the same sentence); this
  // layer is the MORE SPECIFIC owner — it can see an ask and a hand-off, which
  // the terminal surface cannot — so it claims the turn story while mounted and
  // the other region stands down. Same rule the connection banner follows.
  useTurnVoiceClaim()

  // No `gap` here, deliberately: every primitive in this stack carries its own
  // vertical rhythm (`MessageRow` 14/8px, `WorkingRow` 14px, `DelegationPill`
  // 15px), exactly as the confirmed transcript does — and a gap would also
  // reserve air for the always-mounted swap cell below.
  return (
    <div
      data-testid="chat-live-layer"
      // THE VISUAL BAND IS MUTE (fase A6 T7.1, gap G1). Every pixel in here
      // re-renders on a cadence a screen reader must not be subjected to: the
      // provisional tail rewrites itself on every pty flush, the elapsed clause
      // ticks, the receipt group grows a row per tool call. A live region over
      // this subtree would narrate all of it. The one thing that IS said out
      // loud is the coalesced phase below.
      aria-live="off"
      // The band's honest machine state, for AT that queries rather than
      // listens — `working-row.tsx` is the motion pass's file this fase, so the
      // busy flag is carried by the band that owns the row instead (G2).
      aria-busy={phase === 'working' || phase === 'handoff' || undefined}
    >
      <LiveAnnouncer phase={phase} askSay={ASK_SAY[ask]} />
      {attention}
      {login}

      {/* The lens' sighting outranks the hook: it is the one that knows which
          variant is on screen and where the caret is, which is what the answer
          sequence is checked against. A hook WITHOUT a sighting still draws a
          card — the trigger is ~1 s ahead of the poll — it just cannot be
          answered yet, and it says so. */}
      {/* AN MCP FORM OUTRANKS EVERYTHING (`mcp.elicitation_form`). It is the
          most specific ask there is — a named third party demanding typed input
          mid-tool-call — and it is the one that structurally hangs the session:
          the turn does not end, no banner is drawn, and every other signal on
          this surface reads Idle. The peek lens cannot help here (the form is
          not a numbered dialog), so the hook IS the authority. */}
      {session?.elicitation ? (
        <FormCard
          // A NEW ASK IS A NEW FORM. The card holds the half-typed values in
          // local state, and a session can be asked twice in a row by the same
          // server — without this key the second form would open pre-filled
          // with the first one's answers, which is how somebody accepts a
          // question they never read.
          key={session.elicitation.id ?? `${session.elicitation.server}/${session.elicitation.message}`}
          ask={session.elicitation}
          // No delivery lane yet, and the card says so rather than offering a
          // button that quietly does nothing. Answering FOR the user means a
          // hook that writes `hookSpecificOutput.action` — a decider, and one
          // that has never run against a live MCP server. Detection, attribution
          // and a validated draft ship first (PR body: the write lane's two
          // candidate designs).
          inertReason="Answer in the terminal — supermux can read this form but not submit it yet."
        />
      ) : dialog ? (
        <DialogCard
          view={dialog}
          request={session?.permission_request ?? undefined}
          dir={session?.dir}
          mode={session?.permission_request?.mode ?? session?.mode}
          busy={dialogBusy}
          onChoose={onChooseDialog}
        />
      ) : session?.permission_request ? (
        <PermissionCard
          request={session.permission_request}
          dir={session.dir}
          mode={session.permission_request.mode ?? session.mode}
        />
      ) : (
        dialogResolved && <SystemLine>{dialogResolved}</SystemLine>
      )}

      {overlay.length > 0 && (
        <OverlayReceipts
          lines={overlay}
          seed={name}
          pin={pinFor?.(name)}
          surface={surface}
          // ONE LIVE REPRESENTATION PER TOOL CALL (daily-driver QA #7). While
          // this group is on screen its last line IS the running call — same
          // label, same source (`session.activity`) — so the working row below
          // stands down and hands over the two things it was carrying: the
          // elapsed clock and the subagent count.
          live={
            liveRow
              ? { label: liveRow.label, status: liveRow.status }
              : undefined
          }
        />
      )}

      {/* THE PILL IS NOT PART OF THE TURN (fase B4 T5). It used to be — it was
          derived from `activity`, which only exists while one is running — but
          a hand-off dispatched from an idle session is just as in-flight, and
          drawing it only during a turn would have hidden the commonest case:
          typing `@colleague …` into a session that is sitting still. It still
          outranks the working row when both apply, because it is the more
          specific thing this session is doing. */}
      {target ? (
        <DelegationPill
          from={name}
          fromPin={pinFor?.(name)}
          to={target}
          toPin={pinFor?.(target)}
          toName={names?.get(target) ?? target}
          ring={PAGE_RING}
        />
      ) : (
        working &&
        !liveRow && (
          <WorkingRow
            // The run grammar, applied to the live band: the overlay receipts
            // directly above are the SAME speaker, so their mark is already
            // hanging in the gutter — repeating it one row later would draw the
            // session's face twice in 40px. The row keeps its 44px indent
            // either way, so nothing moves when the receipts arrive.
            name={overlay.length > 0 ? undefined : name}
            pin={pinFor?.(name)}
            activity={activity}
            subagents={session?.subagents}
            turnStartMs={turnStart}
          />
        )
      )}

      <SwapCell>{provisional}</SwapCell>
    </div>
  )
}

/* ── what a screen reader is told (fase A6 T7.1 — gap G1) ────────────────── */

/**
 * THE ONE ANNOUNCEMENT PER TURN.
 *
 * Before A6 this layer carried zero `aria-*`: a screen-reader user was never
 * told a turn had started, and the naive repair — `aria-live` on the band —
 * is worse than nothing. The band is the fastest-changing subtree in the
 * product: the provisional tail rewrites on every pty flush, the elapsed clause
 * ticks, the receipt group grows a row per tool call. P13 alone (working row →
 * provisional tail → the confirmed entry that supersedes it) would narrate
 * three different things about ONE reply, plus one per flush in between.
 *
 * So the band is `aria-live="off"` and the only thing that speaks is a phase
 * EDGE, derived with no memory beyond the previous phase: a phase that does not
 * change re-renders to the same string, and an unchanged live region is silent
 * — which is what makes the whole P13 sequence exactly ONE announcement rather
 * than N+3. That property is asserted by count in
 * `tests/unit/chat-a11y.test.tsx`, so a later "just add aria-live" fix fails
 * the suite instead of shipping.
 *
 * The vocabulary and the region itself now live in
 * `components/a11y/turn-announcer.tsx` — OUTSIDE this lazily-loaded chunk —
 * because the terminal renderer (still the shipped default) needs the exact
 * same voice and cannot import chat code. Re-exported here so this file stays
 * the name every existing caller, test and BRAND.md entry already knows.
 */
export { PHASE_SAY }
export {
  livePhase,
  TURN_END_SAY,
  sayFor,
  type LivePhase,
} from '../a11y/turn-announcer'

/**
 * WHICH ask is on screen. One phase, several questions — and they are not the
 * same question.
 *
 * A screen reader was told "Claude is asking for permission." over an
 * AskUserQuestion card reading `FRUIT CHOICE / Which fruit do you want?`, and
 * over the sign-in method picker. Nothing on either screen grants anything: the
 * registry's own comment for `question.ask` says it out loud ("Answering a
 * question grants nothing and changes no mode"), and a login picker is a choice
 * of account. Announcing a permission request is not a rounding error there —
 * it is the one word that would make somebody answer differently.
 */
export type AskKind =
  | 'permission'
  | 'question'
  | 'plan'
  | 'startup'
  | 'paused'
  | 'sign-in'
  | 'form'
  | 'unknown'

export const ASK_SAY: Record<AskKind, string> = {
  permission: PHASE_SAY.asking,
  question: 'Claude is asking a question.',
  plan: 'Claude is asking you to approve a plan.',
  startup: 'Claude Code is asking something before it starts.',
  paused: 'Claude paused this turn and is waiting for an answer.',
  'sign-in': 'Claude is asking how to sign in.',
  form: 'A tool is asking you to fill in a form.',
  // Something IS waiting — the lens saw numbered rows it has no fingerprint
  // for — so the region still speaks. It just does not name a kind it does not
  // know. Same refusal-first rule the unmapped card follows.
  unknown: 'Claude is asking something in the terminal.',
}

/** Pure, and ordered exactly like the cards below: the form outranks the
 *  dialog, the dialog outranks the bare hook, and the sign-in card is what is
 *  asking when it is the one on screen. */
export function askKind(s: {
  form: boolean
  dialog?: DialogCardView['family']
  permission: boolean
  signIn: boolean
}): AskKind {
  if (s.form) return 'form'
  if (s.dialog) return s.dialog
  if (s.permission) return 'permission'
  if (s.signIn) return 'sign-in'
  return 'unknown'
}


/* ── the ask, answerable ─────────────────────────────────────────────────── */

/**
 * The choice card with live controls (fase A4 T7).
 *
 * Everything about WHICH controls are live was decided upstream by the registry
 * and `dialog-answer.ts`; this file only draws it. Three rules it does enforce,
 * because they are visual:
 *
 *   · an option the registry will not act on is DRAWN, disabled, carrying its
 *     reason — the user must be able to read the question chat is declining;
 *   · while a sequence runs the WHOLE card is inert (one slow pty must not be
 *     able to take two answers), and the card says what it is doing;
 *   · Escape is one more pill in the same grammar rather than a second control
 *     shape — it answers the same question, in the same place, with the digit
 *     hint the TUI itself prints.
 *
 * The digits are hints. No digit is ever sent to the pty (`KEY_ALLOWLIST` has
 * none); the sequence is `Down`/`Up` + `Enter`, verified between every key.
 */
export function DialogCard({
  view,
  request,
  dir,
  mode,
  busy = null,
  onChoose,
}: {
  view: DialogCardView
  request?: PermissionRequestInfo
  dir?: string
  mode?: string
  busy?: number | 'escape' | null
  onChoose?: (target: number | 'escape') => void
}) {
  const answering = busy !== null
  const options: ChoiceOption[] = [
    ...view.options.map((o) => ({
      label: o.label,
      primary: o.primary,
      kbd: o.kbd,
      disabled: !o.actOn || answering || view.disabled,
      hint: o.reason,
    })),
    ...(view.escape
      ? [
          {
            label: view.escape.label,
            kbd: 'esc',
            disabled: !view.escape.actOn || answering || view.disabled,
            hint: view.escape.reason,
          },
        ]
      : []),
  ]
  const summary = stripEmojiPrefix(request?.summary ?? '').trim()
  const why =
    view.family === 'plan'
      ? view.planPath
      : view.family === 'question' || view.family === 'startup'
        ? // Neither is about a tool, a directory or a mode. A question is about
          // the sentence above it — naming the tool here would put
          // `AskUserQuestion` back on the card, one line lower — and a startup
          // gate is about the folder IN ITS OWN BODY, so `in supermux/server`
          // (the session's dir) would name a different path than the one being
          // trusted, which is worse than naming none.
          undefined
        : [summary && request?.tool ? request.tool : '', dir ? `in ${shortDir(dir)}` : '', modeClause(mode)]
            .filter(Boolean)
            .join(' · ')
  return (
    <div
      data-testid="chat-dialog-card"
      data-family={view.family}
      data-state={answering ? 'answering' : view.disabled ? 'degraded' : 'idle'}
    >
      <ChoiceCard
        eyebrow={view.header}
        question={dialogQuestion(view, summary || request?.tool)}
        // What is actually being approved, verbatim off the pty (QA #11). The
        // question is a sentence — a truncated description, at worst — and this
        // is the evidence under it. A question dialog's evidence is its OPTIONS'
        // descriptions, which are prose rather than code, so they get the prose
        // block instead of the mono one.
        detail={
          view.family === 'question' ? (
            <OptionMeanings view={view} />
          ) : view.body?.length ? (
            // WHICH BODIES MAY WRAP. A permission body is a shell command and a
            // soft break there could change what a reader believes they are
            // approving, so it keeps the pty's columns and scrolls (see
            // `CardCode`). The paused/plan/startup bodies are prose Claude Code
            // already hard-wrapped at 80 columns — on a 390px phone those clipped
            // mid-sentence with no ellipsis and no scroll affordance, which reads
            // as a different, complete sentence.
            <CardCode wrap={PROSE_BODY_FAMILIES.has(view.family)}>{view.body.join('\n')}</CardCode>
          ) : undefined
        }
        why={why || undefined}
        options={options}
        onChoose={
          onChoose && !answering && !view.disabled
            ? (i) => onChoose(i < view.options.length ? i : 'escape')
            : undefined
        }
      />
      {(answering || view.note) && (
        <p className="ml-11 mt-[7px] text-[12.6px] tracking-[-0.05px] text-ink-2">
          {answering
            ? // Named as a SEQUENCE, not as a spinner: it re-reads the terminal
              // between every key, and if the screen has moved it will stop and
              // say so rather than finish.
              'Checking the terminal between each key…'
            : view.note}
        </p>
      )}
    </div>
  )
}

/**
 * What the card asks.
 *
 * The COMMAND is what the decision turns on, so the hook's summary is used
 * whenever it is there. Without it — a sighting that arrived before the hook, or
 * a plan dialog, for which no `PermissionRequest` hook is verified at all — the
 * question names the KIND of thing being asked and lets the options (which are
 * the dialog's own words) carry the rest. It never invents a command.
 */
function dialogQuestion(view: DialogCardView, command?: string): React.ReactNode {
  if (view.family === 'plan') return 'Claude has a plan. Ready to go ahead?'
  // THE MODEL'S OWN SENTENCE, when it wrote one. AskUserQuestion's question is
  // the entire content of the ask, and until this branch existed it reached no
  // surface a human reads: the hook's `tool` won the frame below and the card
  // was headed ``Run `AskUserQuestion` ?`` (verify matrix finding 4).
  if (view.family === 'question') {
    return view.question ?? 'Claude is asking you to choose.'
  }
  // THE PAUSED MODALS (catalog `limit.overage_consent_dialog` /
  // `err.refusal_fallback_dialog`). The heading has one job the generic line
  // cannot do: say that the turn is STOPPED and waiting, rather than that
  // something is being asked. Each variant names what the answer costs, because
  // that is the fact the reader needs before they walk to the terminal — one of
  // them spends credits, the other decides which model finishes the work.
  if (view.family === 'paused') {
    if (view.variant === 'overage-consent') {
      return 'Claude paused this turn — continuing costs usage credits.'
    }
    if (view.variant === 'refusal-fallback') {
      return 'Claude paused this turn — its safeguards flagged the prompt.'
    }
    return 'Claude paused this turn and is waiting for an answer.'
  }
  if (view.family === 'startup') {
    if (view.variant === 'trust') return 'Claude Code needs your OK to work in this folder.'
    if (view.variant === 'apikey') {
      return 'Claude Code found an API key in this session’s environment.'
    }
    return 'Claude Code is asking something before it starts.'
  }
  // THE `Run …?` FRAME IS FOR A MAPPED PERMISSION DIALOG, and for nothing else.
  //
  // It used to be reached by any card that had a hook to quote, including the
  // UNMAPPED one — and the hook fires for AskUserQuestion too, so a question
  // dialog rendered as ``Run `AskUserQuestion` ?`` with the question itself
  // nowhere on the card. A card this app has already admitted it cannot map must
  // not then assert what the terminal is about to run: the hook says which tool
  // ASKED, and the screen (which this app failed to read) says what it is
  // asking. Those are not the same claim.
  if (view.id && command) {
    return (
      <>
        Run <InlineCode>{commandChip(command)}</InlineCode>?
      </>
    )
  }
  if (view.variant === 'edit') return 'Claude wants to edit a file.'
  if (view.variant === 'write') return 'Claude wants to create a file.'
  if (view.variant === 'bash') return 'Claude wants to run a command.'
  return 'Claude is asking something in the terminal.'
}

/**
 * What each option MEANS — AskUserQuestion's per-option description line.
 *
 * The model writes one under each label, and the lens splits it off the label
 * rather than folding it in (`peek-lens.ts` `descriptions`), because a chip
 * reading `Apple A crisp and refreshing fruit` is neither the label nor the
 * description. Drawn as prose under the question so the pills stay one line and
 * the meaning is still on the card — a `title` tooltip would be neither
 * keyboard- nor phone-reachable.
 *
 * Renders nothing when no option has a description, which is the common case for
 * a short question.
 */
function OptionMeanings({ view }: { view: DialogCardView }) {
  const rows = view.options
    .map((o, i) => ({ label: o.label, text: view.descriptions?.[i] }))
    .filter((r): r is { label: string; text: string } => !!r.text)
  if (!rows.length) return null
  return (
    <dl data-testid="chat-dialog-meanings" className="mt-[9px] space-y-[3px]">
      {rows.map((r) => (
        <div key={r.label} className="text-[13.2px] leading-[1.45]">
          <dt className="inline font-medium text-ink-2">{r.label}</dt>
          <dd className="inline text-ink-3"> — {r.text}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The command as it goes INSIDE the question's `Run …?` frame.
 *
 * For a Bash tool the server's summary prefers Claude's own `description`
 * (`activity.rs`: human, secret-free, preferred over the raw command) — and
 * Claude writes those as imperative English, which for a shell command is
 * almost always "Run <the command>". Framed by a question that already says
 * "Run", the card asked **Run `Run cowsay-nonexistent --version`?** on the real
 * app (mobile proof, 11-permission-card-light.png).
 *
 * So the frame wins and the duplicate goes: strictly a leading `Run `, nothing
 * cleverer. Every other description keeps its own verb ("Check the git status")
 * — reading a little loose inside `Run …?` is far better than a card that
 * invents or drops words from a command a user is about to approve.
 */
export function commandChip(command: string): string {
  const stripped = command.replace(/^\s*run\s+/i, '').trim()
  return stripped || command
}

/* ── the ask ─────────────────────────────────────────────────────────────── */

/**
 * A pending permission dialog, as the one thing on screen that is asking.
 *
 * `permission_request` is the wire OBJECT (`{tool, summary, kind, mode?}`) —
 * the A1 comment stays because the failure mode is silent: interpolating it
 * renders `[object Object]` and nobody notices until a screenshot. Every field
 * below is read by name.
 *
 * The board's question is `Run <code>cargo publish --dry-run</code>?` — the
 * COMMAND is what the decision turns on, so the summary (emoji stripped: the
 * glyph taxonomy is terminal/tile-only) is what goes in the chip, and the tool
 * that will run it joins the `why` line with where it runs and under which
 * mode. A summary-less request falls back to naming the tool itself.
 */
export function PermissionCard({
  request,
  dir,
  mode,
}: {
  request: PermissionRequestInfo
  dir?: string
  mode?: string
}) {
  const summary = stripEmojiPrefix(request.summary ?? '').trim()
  const command = summary || request.tool
  const why = [
    summary && request.tool ? request.tool : '',
    dir ? `in ${shortDir(dir)}` : '',
    modeClause(mode),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div data-testid="chat-permission-card">
      <ChoiceCard
        question={
          <>
            Run <InlineCode>{commandChip(command)}</InlineCode>?
          </>
        }
        why={why || undefined}
        options={PERMISSION_OPTIONS}
      />
      {/* The A1 honesty string, kept in spirit and corrected in fact (A4
          review): the composer below is live now, so "chat is read-only" is no
          longer true of this surface — and a line that is wrong about the
          obvious half is not trusted about the half that matters. What IS still
          true is that no key may be pressed into this dialog until T7 lands, so
          that is what it says. Same sentence the composer's own refusal uses
          when there is nothing above it to point at. */}
      <p className="ml-11 mt-[7px] text-[12.6px] tracking-[-0.05px] text-ink-2">
        Answer in the terminal — chat can’t answer this one yet.
      </p>
    </div>
  )
}

/**
 * The permission mode, in words rather than in wire.
 *
 * `mode` arrives as the backend's snake_case `Mode` (`accept_edits`), and the
 * card is the same failure mode as stringifying the request object: printing it
 * verbatim puts `accept_edits mode` on the approved surface. `modeChipLabel` is
 * already the one place that names a mode for a reader (the tools sheet's toast
 * and, per its own header, "any future read-only chip") — this is that chip.
 * Lower-cased because the why line is a sentence fragment, not a label.
 *
 * A mode the UI does not know is dropped rather than guessed: `modeChipLabel`
 * defaults to "Normal", and a card claiming the wrong mode is worse than a card
 * that only says where the command runs.
 */
const MODES: readonly string[] = ['normal', 'accept_edits', 'plan', 'bypass']

function modeClause(mode?: string): string {
  if (!mode || !MODES.includes(mode)) return ''
  return `${modeChipLabel(mode as SessionMode).toLowerCase()} mode`
}

/** `/opt/projects/supermux/server` → `supermux/server`. */
function shortDir(dir: string): string {
  const parts = dir.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || dir
}

/* ── the hook receipts ───────────────────────────────────────────────────── */

/** The elapsed clause the working row used to carry, on the same two rules: it
 *  counts from the SEND (server clock, not from mount) and it stays off screen
 *  for the first 5s, because a fast turn that prints 1s, 2s, 3s feels slow. */
const ELAPSED_AFTER_MS = 5_000

function liveStatus(
  turnStartMs: number | null,
  subagents?: number,
  surface?: 'desktop' | 'phone',
): string | undefined {
  // The clock shares the line with the tool label now, and on the phone that
  // line has a 266px bubble to live in. `3 subagents` costs a third of it, and
  // WHAT is running matters more than how many helpers it has — so the count is
  // a desktop clause and the clock is everywhere.
  const clause = surface !== 'phone' && subagents && subagents >= 2 ? `${subagents} subagents` : ''
  const elapsedMs = turnStartMs == null ? 0 : serverNowMs() - turnStartMs
  const elapsed = elapsedMs >= ELAPSED_AFTER_MS ? formatElapsed(elapsedMs) : ''
  return [clause, elapsed].filter(Boolean).join(' · ') || undefined
}

/**
 * The ≤1s live layer, wearing the confirmed layer's clothes.
 *
 * Two things make the supersede invisible, and both are structural: the group
 * sits in the SAME row grammar the confirmed batch will land in (gutter mark +
 * `ReceiptGroup`), and the LAST line is `running` — so the spinner occupies the
 * slot the check will occupy and the replacement costs zero reflow.
 *
 * Rows go through `toReceiptRows` rather than being built here, so a hook label
 * is clamped and stripped exactly like the confirmed line it will become.
 */
export function OverlayReceipts({
  lines,
  seed,
  pin,
  surface,
  live,
}: {
  lines: readonly OverlayLine[]
  seed: string
  pin?: MarkPin
  surface?: 'desktop' | 'phone'
  /** What the last (running) line is doing right now — the label as of this
   *  frame, and the clock the working row used to carry (QA #7). Absent on a
   *  group whose turn has ended, where nothing is running any more. */
  live?: { label: string; status?: string }
}) {
  const rows = React.useMemo<Receipt[]>(() => {
    const labelled = lines.map((line, i) => ({
      uuid: `${line.at}-${i}`,
      label: live && i === lines.length - 1 ? live.label : line.label,
    }))
    const base = toReceiptRows(labelled)
    return base.map((row, i) =>
      i === base.length - 1
        ? { ...row, state: 'running' as const, status: live?.status }
        : row,
    )
  }, [lines, live])
  return (
    <MessageRow
      gutter={<SessionMark seed={seed} pin={pin} size={MARK_SIZE.gutter} state="working" label={null} />}
    >
      <ReceiptGroup rows={rows} max={RECEIPT_DEFAULT_MAX} surface={surface} />
    </MessageRow>
  )
}

/* ── delegation, outbound ────────────────────────────────────────────────── */

/**
 * Who this session is handing work to RIGHT NOW, if anyone.
 *
 * WHAT THIS USED TO BE, and why it is gone: `delegationTarget(activity,
 * mentions, self)` grepped the session's *activity string* for a known session
 * name. An agent that merely wrote "I'll ask deploy-fix about this" drew a
 * handoff pill for a delegation that never happened — the #41/#43 false-positive
 * class, and un-tunable, because prose about a colleague and a message to one
 * are the same bytes. So it is deleted rather than tightened.
 *
 * TWO REAL SOURCES REPLACE IT, and the pill is the gap between them:
 *
 *   · the OPTIMISTIC one — a `POST /api/agents/delegate` this client just made
 *     (`use-composer.ts`' hand-off branch). It is the only thing that knows a
 *     delegation is in flight, because the ledger cannot know until it lands.
 *   · the LEDGER — a `session.delegate` row whose `detail.from` is this session.
 *     Durable, replayable, and the thing the transcript's own
 *     `Delegated to ●x` line is drawn from.
 *
 * The pill therefore RESOLVES INTO the durable line rather than sitting beside
 * it: the moment a matching ledger row appears, this returns `null` and the
 * `HarnessLine` above is already on screen. One delegation, one representation,
 * at every instant — the same "one live row" discipline the overlay group
 * keeps.
 *
 * THE AGENT-INITIATED CASE has no pill by design (T5.4): a delegation performed
 * from this session's own pty by curl produces no optimistic state, because the
 * app learns about it after the fact, from the ledger. Inventing a pill from a
 * debounced feed would draw "handing over…" for something already handed over.
 */
export function pendingHandoff(
  handoff: { to: string; atMs: number } | null | undefined,
  events: readonly HarnessEvent[] | undefined,
  self: string,
): string | null {
  if (!handoff?.to) return null
  // Give up rather than hang. The ledger is the only thing that resolves this
  // pill, so a feed that is erroring, disabled, or simply never going to
  // mention it would otherwise leave "handing over…" on screen forever.
  if (Date.now() - handoff.atMs > HANDOFF_MAX_MS) return null
  const landed = (events ?? []).some(
    (e) =>
      e.action === 'session.delegate' &&
      e.target === handoff.to &&
      e.detail.from === self &&
      // Seconds on the wire, and a whole second of slack: the row is stamped
      // server-side while `atMs` is this client's clock, and a pill that
      // flickered back on because of 200 ms of skew would be worse than one
      // that resolved 200 ms early.
      e.ts * 1000 >= handoff.atMs - 1_000,
  )
  return landed ? null : handoff.to
}

/** How long an unconfirmed hand-off may draw a pill. Long enough for a slow
 *  pty wake plus the feed's 1200 ms debounce, short enough that a stuck one is
 *  a blip rather than furniture. */
export const HANDOFF_MAX_MS = 30_000

/* ── the provisional slot ────────────────────────────────────────────────── */

/**
 * One grid cell, one occupant at a time (master plan §11.6).
 *
 * Both children share `grid-area: 1 / 1`, so the leaving provisional block and
 * anything replacing it overlap instead of queueing — the swap is an opacity
 * change inside a box whose height is the taller of the two, never a reflow.
 * The cell itself is always mounted, which is what lets the exit run at all.
 *
 * What it does NOT do: the confirmed bubble that supersedes this block lands in
 * the transcript above, not in this cell, so the crossfade covers the block's
 * own departure. That is the mitigation the plan's Risk 1 describes (same row
 * grammar, same bubble metrics, opacity-only swap); the measured-height hold is
 * the fallback if a real turn still shows a step.
 */
function SwapCell({ children }: { children?: React.ReactNode }) {
  const reduce = useReducedMotion() ?? false
  return (
    <div className="grid">
      <AnimatePresence initial={false}>
        {children ? (
          <motion.div
            key="live-tail"
            style={{ gridArea: '1 / 1' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            // Opacity only, in both branches — reduced motion shortens it to
            // nothing rather than swapping it for a different move.
            transition={{ duration: reduce ? 0 : SWAP_S, ease: eases.inOut }}
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default LiveLayer
