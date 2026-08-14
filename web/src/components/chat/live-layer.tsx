/**
 * The LIVE layer (fase A3 T4) — what is true *right now*, under everything the
 * transcript has already confirmed.
 * ─────────────────────────────────────────────────────────────────────────────
 * A1 established both the layer model and this stack's ORDER, and A3 changes
 * neither — only what each band looks like. Top to bottom:
 *
 *   confirmed content   (the transcript, `transcript-item.tsx`)
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

import { stripEmojiPrefix } from './entries'
import { mentionSegments, toReceiptRows } from './grouping'
import type { OverlayLine } from './use-receipt-overlay'
import { WorkingRow } from './working-row'
import {
  ChoiceCard,
  DelegationPill,
  InlineCode,
  MARK_SIZE,
  MessageRow,
  ReceiptGroup,
  RECEIPT_DEFAULT_MAX,
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
}: LiveLayerProps) {
  // The turn is running AND anchored. The anchor is what the elapsed clause
  // counts from, so a row without one would have nothing honest to say.
  const working = session?.status === 'active' && turnStart != null
  const target = delegationTarget(session?.activity, mentions, name)

  // No `gap` here, deliberately: every primitive in this stack carries its own
  // vertical rhythm (`MessageRow` 14/8px, `WorkingRow` 14px, `DelegationPill`
  // 15px), exactly as the confirmed transcript does — and a gap would also
  // reserve air for the always-mounted swap cell below.
  return (
    <div data-testid="chat-live-layer">
      {session?.permission_request && (
        <PermissionCard
          request={session.permission_request}
          dir={session.dir}
          mode={session.permission_request.mode ?? session.mode}
        />
      )}

      {overlay.length > 0 && (
        <OverlayReceipts
          lines={overlay}
          seed={name}
          pin={pinFor?.(name)}
          surface={surface}
        />
      )}

      {working &&
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
            Run <InlineCode>{command}</InlineCode>?
          </>
        }
        why={why || undefined}
        options={PERMISSION_OPTIONS}
      />
      {/* The A1 honesty string, kept verbatim in spirit: A3 still cannot send
          a key, so the card must not imply that clicking it would. */}
      <p className="ml-11 mt-[7px] text-[12.6px] tracking-[-0.05px] text-ink-2">
        Answer in the terminal — chat is read-only for now.
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
}: {
  lines: readonly OverlayLine[]
  seed: string
  pin?: MarkPin
  surface?: 'desktop' | 'phone'
}) {
  const rows = React.useMemo<Receipt[]>(() => {
    const base = toReceiptRows(lines.map((line, i) => ({ uuid: `${line.at}-${i}`, label: line.label })))
    return base.map((row, i) => (i === base.length - 1 ? { ...row, state: 'running' as const } : row))
  }, [lines])
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
