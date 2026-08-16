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
 *   working row         the P12 state ladder, or a delegation pill when the
 *                       turn is asking a colleague
 *   provisional text    the P13 pty tail, visibly unconfirmed
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

import type { PermissionRequestInfo, SessionMode } from '../../lib/api/sessions'
import { modeChipLabel } from '../focus-mode/mode-labels'
import type { TileSession } from '../session-tile/types'

import type { DialogCardView } from './dialog-answer'
import { formatElapsed, stripEmojiPrefix } from './entries'
import { mentionSegments, toReceiptRows } from './grouping'
import { serverNowMs } from './latency'
import type { OverlayLine } from './use-receipt-overlay'
import { WorkingRow } from './working-row'
import {
  CardCode,
  ChoiceCard,
  DelegationPill,
  InlineCode,
  MARK_SIZE,
  MessageRow,
  ReceiptGroup,
  RECEIPT_DEFAULT_MAX,
  SystemLine,
  type ChoiceOption,
  type Receipt,
} from './ui'

const EMPTY_INDEX: ReadonlyMap<string, string> = new Map()

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

export interface LiveLayerProps {
  /** The focused session's immutable slug — the seed for every face here. */
  name: string
  session: TileSession | null
  /** SERVER-clock ms anchor for the running turn; null = no live turn. */
  turnStart: number | null
  /** Hook receipts for this turn, oldest first (`useReceiptOverlay`). */
  overlay?: readonly OverlayLine[]
  /** Lowercased name → slug, for spotting a delegation target in the activity. */
  mentions?: ReadonlyMap<string, string>
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
}

export function LiveLayer({
  name,
  session,
  turnStart,
  overlay = [],
  mentions = EMPTY_INDEX,
  pinFor,
  surface,
  provisional,
  attention,
  dialog,
  dialogBusy = null,
  onChooseDialog,
  dialogResolved,
}: LiveLayerProps) {
  // The turn is running AND anchored. The anchor is what the elapsed clause
  // counts from, so a row without one would have nothing honest to say.
  const working = session?.status === 'active' && turnStart != null
  const target = delegationTarget(session?.activity, mentions, name)

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
          label: session?.activity ? stripEmojiPrefix(session.activity) : overlay[overlay.length - 1].label,
          status: liveStatus(turnStart, session?.subagents, surface),
        }
      : undefined

  // No `gap` here, deliberately: every primitive in this stack carries its own
  // vertical rhythm (`MessageRow` 14/8px, `WorkingRow` 14px, `DelegationPill`
  // 15px), exactly as the confirmed transcript does — and a gap would also
  // reserve air for the always-mounted swap cell below.
  return (
    <div data-testid="chat-live-layer">
      {attention}

      {/* The lens' sighting outranks the hook: it is the one that knows which
          variant is on screen and where the caret is, which is what the answer
          sequence is checked against. A hook WITHOUT a sighting still draws a
          card — the trigger is ~1 s ahead of the poll — it just cannot be
          answered yet, and it says so. */}
      {dialog ? (
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

      {working &&
        !liveRow &&
        (target ? (
          <DelegationPill
            from={name}
            fromPin={pinFor?.(name)}
            to={target.seed}
            toPin={pinFor?.(target.seed)}
            toName={target.label}
            ring={PAGE_RING}
          />
        ) : (
          <WorkingRow
            // The run grammar, applied to the live band: the overlay receipts
            // directly above are the SAME speaker, so their mark is already
            // hanging in the gutter — repeating it one row later would draw the
            // session's face twice in 40px. The row keeps its 44px indent
            // either way, so nothing moves when the receipts arrive.
            name={overlay.length > 0 ? undefined : name}
            pin={pinFor?.(name)}
            activity={session?.activity}
            subagents={session?.subagents}
            turnStartMs={turnStart}
          />
        ))}

      <SwapCell>{provisional}</SwapCell>
    </div>
  )
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
        question={dialogQuestion(view, summary || request?.tool)}
        // What is actually being approved, verbatim off the pty (QA #11). The
        // question is a sentence — a truncated description, at worst — and this
        // is the evidence under it.
        detail={view.body?.length ? <CardCode>{view.body.join('\n')}</CardCode> : undefined}
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
  if (command) {
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
 * Who this turn is asking, if anyone.
 *
 * ONE signal, one guard (fase A3 T4.4): the activity must NAME a session that
 * is in the known-sessions index, or there is no pill and the working row
 * stands. `activity_kind === 'task'` is deliberately not a second trigger —
 * the pill draws a recipient, and a task that names nobody known has none, so
 * reading the kind would only ever agree with the name or invent a colleague.
 * The matcher is `mentionSegments`, the same one the transcript's chips use, so
 * "no regex over arbitrary words" holds here too and `patchwork` is a word
 * rather than a colleague.
 */
export function delegationTarget(
  activity: string | undefined,
  mentions: ReadonlyMap<string, string>,
  self: string,
): { seed: string; label: string } | undefined {
  if (!activity) return undefined
  for (const segment of mentionSegments(stripEmojiPrefix(activity), mentions, self)) {
    // The seed is the slug (one pigment per session, always); the LABEL is the
    // name as the agent wrote it, which is what the pill says out loud.
    if ('seed' in segment) return segment
  }
  return undefined
}

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
