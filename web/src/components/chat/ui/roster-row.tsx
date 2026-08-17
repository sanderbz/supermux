/**
 * The roster row — a colleague, with their own words.
 * ─────────────────────────────────────────────────────────────────────────────
 * The approved boards' sidebar row, and the single most-repeated object in the
 * product:
 *
 *   row       height 64, gap 12, padding 0 8, radius 12
 *   mark      40px — or a crew cluster in the same footprint (a team is a
 *             colleague too)
 *   name      14px/500, tracking −0.15px, truncating
 *   time      12px secondary, tabular-nums, pinned right, never truncated
 *   preview   13px secondary, 3px under the name, truncating — the session's own
 *             last line, not a status word. THE PREVIEW *IS* THE STATUS LINE
 *             (§12.1): "one check left. then crates.io." tells you more than
 *             "active" ever will, and when the session is composing, the same
 *             slot carries presence ("Typing…").
 *   selected  `sm-accent-row` — the focused session's own pigment mixed into the
 *             paper at 9% (light) / 12% (dark). The only chrome that is tinted.
 *   attention needs-you dot on the silhouette's shoulder, seated from the
 *             character's own solid (see `attentionDotSeat`)
 *
 * ── Densities (fase B2 T3) ──────────────────────────────────────────────────
 * The same component at three sizes, because a roster row is the same OBJECT
 * whether it is the overview's list, the focus strip or a picker — and three
 * components drift into three different products:
 *
 *   list    h64 · mark 40 · preview · ticking time   the geometry above
 *   strip   h48 · mark 28 · no preview               replaces CompactTile's 56
 *   picker  h40 · mark 24 · STATIC                   palette + session pickers
 *
 * `picker` is not merely smaller: it renders no timestamp and never animates.
 * A row that mutates under a keyboard cursor is a row you mis-click (§12.1), so
 * the density is also a *behaviour* switch. Everything else about the component
 * is unchanged at every density.
 *
 * Hover is the 120ms speed (§11.11) and is suppressed while selected — a
 * selected row that lightens under the pointer reads as a click that did nothing.
 * The row-arrival animation (0.45s, translateX(−10px)) is deliberately NOT here:
 * it is `data-fresh`-gated in the master plan, and a static primitive that
 * animates on every mount would animate the whole backlog.
 */
import type * as React from 'react'

import { characterFromSeed, SessionMark, VIEWBOX, type MarkPin, type MarkState } from '../../../brand/marks'
import { cn } from '../../../lib/utils'

import { Facepile, type FacepileMember } from './facepile'
import { ATTENTION_DOT, attentionDotSeat, FACEPILE, MARK_SIZE } from './metrics'

/** How much room the row gets — and, for `picker`, how much it is allowed to
 *  move. See the density table in this file's header. */
export type RosterDensity = 'list' | 'strip' | 'picker'

/** Which dot the row draws. Mirrors `Attention.dotKind` — the roster's two
 *  visible tiers, deliberately not four. */
export type AttentionKind = 'needs' | 'unread'

export interface RosterRowProps {
  /** The session's name — its face, and by default its label. */
  seed: string
  pin?: MarkPin
  /** Display name, when it differs from the slug. */
  name?: string
  /** Relative time, pre-formatted ("1:47 PM", "Yesterday"). */
  timestamp?: string
  /** The session's last line — or its presence ("Typing…"). */
  preview?: string
  state?: MarkState
  selected?: boolean
  /** The attention dot on the mark's shoulder.
   *
   *  `'needs'` (or the legacy `true`) is the red demand — permission, plan
   *  approval, question, inbound delegation. `'unread'` is the calmer, smaller
   *  dot for "it has spoken since you last looked": the model's middle tier,
   *  which existed in `lib/attention-tiers.ts` from the start and was drawn
   *  nowhere, so an unread row looked exactly like a quiet one. */
  attention?: boolean | AttentionKind
  /** A team row: the cluster replaces the single mark, same footprint. */
  crew?: readonly FacepileMember[]
  /** Keyline colour for a crew cluster — the row's own paper. */
  ring?: string | null
  density?: RosterDensity
  /** Replace the drawn mark with something else in the same footprint.
   *  The one seam the kill switch needs: `components/roster/session-face.tsx`
   *  owns `localStorage['supermux:roster-marks']` and hands back a `StatusDot`
   *  when marks are off, so the fallback is a glyph swap rather than a second
   *  copy of every row. The attention dot still seats itself off the seed's own
   *  character, so it lands in the same place either way. */
  leading?: React.ReactNode
  /** The secondary line, when it is not a preview: the strip's `21k tokens ·
   *  ⎇ branch`, a picker's task summary. Rendered in the preview's slot, so a
   *  row never grows a third line. */
  meta?: React.ReactNode
  /** The right cluster, before the timestamp: ⌘N, host badge, needs-input pill.
   *  Interaction chrome the primitive deliberately knows nothing about. */
  trailing?: React.ReactNode
  onClick?: () => void
  onFocus?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  /** Roving-tabindex seam (`hooks/use-roving.ts`): `-1` for every row but the
   *  one the arrow keys have landed on, so a 40-session roster is ONE tab stop
   *  and not forty. Undefined ⇒ the browser default (0) — a row outside a roving
   *  list is an ordinary tab stop, exactly as before. */
  tabIndex?: number
  /** The same seam's handle on the DOM node, so the list owner can move focus. */
  buttonRef?: React.Ref<HTMLButtonElement>
  /** The roving list's key for this row (the session name), published as
   *  `data-roving-item` — the attribute the tile has always carried and the list
   *  row had not, which is why "which row owns the tab stop" was measurable in
   *  one view and not the other. */
  rovingKey?: string
  /** Accessible label — the wrappers know the status word, the primitive does
   *  not. Falls back to the visible name. */
  ariaLabel?: string
  /** Keys the row itself answers, announced to AT (`aria-keyshortcuts`) — the
   *  roster row's secondary action lives on Shift+F10 now that the ⋯ trigger is
   *  not a tab stop. */
  ariaKeyShortcuts?: string
  title?: string
  /** VR hook (`ARCHITECTURE.md:160`). */
  dataVr?: string
  className?: string
}

/** Per-density geometry. One table, so a density is a number change and never a
 *  second component. */
const DENSITY = {
  list: { row: 'h-16', mark: MARK_SIZE.roster, name: 'text-[14px]', gap: 'gap-3' },
  strip: { row: 'h-12', mark: 28, name: 'text-[13px]', gap: 'gap-2.5' },
  picker: { row: 'h-10', mark: 24, name: 'text-[13px]', gap: 'gap-2.5' },
} as const satisfies Record<RosterDensity, { row: string; mark: number; name: string; gap: string }>

export function RosterRow({
  seed,
  pin,
  name,
  timestamp,
  preview,
  state = 'idle',
  selected,
  attention,
  crew,
  ring = null,
  density = 'list',
  leading,
  meta,
  trailing,
  onClick,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  onContextMenu,
  onKeyDown,
  tabIndex,
  buttonRef,
  rovingKey,
  ariaLabel,
  ariaKeyShortcuts,
  title,
  dataVr,
  className,
}: RosterRowProps) {
  const d = DENSITY[density]
  const dotKind: AttentionKind | null =
    attention === true ? 'needs' : attention === false || !attention ? null : attention
  // A picker row is arrowed through: no ticking timestamp, and the face holds
  // still. Both halves of that decision live here so no caller can forget one.
  const still = density === 'picker'
  const secondary = preview ?? meta
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      onFocus={onFocus}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      title={title}
      aria-label={ariaLabel}
      aria-keyshortcuts={ariaKeyShortcuts}
      data-selected={selected || undefined}
      data-density={density}
      data-roving-item={rovingKey}
      data-vr={dataVr}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        // radius 12 — the mockup's literal. NOT `rounded-xl`: this repo remaps
        // the named scale off `--radius` (sm 8 · md 10 · lg 12 · xl 16), so the
        // named rungs do not mean what stock Tailwind's do.
        'flex w-full items-center rounded-[12px] px-2 text-left',
        d.row,
        d.gap,
        'sm-t-hover',
        selected ? 'sm-accent-row' : 'hover:bg-fill-soft',
        className,
      )}
    >
      <span className="relative flex-none">
        {leading ?? null}
        {leading ? null : crew ? (
          <Facepile members={crew} variant="cluster" ring={ring} />
        ) : (
          <SessionMark
            seed={seed}
            pin={pin}
            size={d.mark}
            state={state}
            animate={!still}
            label={null}
          />
        )}
        {dotKind && (
          <AttentionDot
            seed={seed}
            pin={pin}
            crew={Boolean(crew)}
            ring={ring}
            size={d.mark}
            kind={dotKind}
          />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 truncate font-medium tracking-[-0.15px] text-ink',
              d.name,
            )}
          >
            {name ?? seed}
          </span>
          {timestamp && !still && (
            <span className="ml-auto flex-none text-[12px] tabular-nums text-ink-2">
              {timestamp}
            </span>
          )}
        </span>
        {secondary && (
          <span className="mt-[3px] block truncate text-[13px] text-ink-2">{secondary}</span>
        )}
      </span>

      {trailing && <span className="flex flex-none items-center gap-1.5">{trailing}</span>}
    </button>
  )
}

/**
 * The needs-you dot. On a single mark it sits on the silhouette's own upper-right
 * shoulder — a wedge and a sphere have very different shoulders, so the seat is
 * derived, not hard-coded. A crew cluster has no single silhouette, so the dot
 * takes the box's top-right corner.
 */
function AttentionDot({
  seed,
  pin,
  crew,
  ring,
  size = MARK_SIZE.roster,
  kind = 'needs',
}: {
  seed: string
  pin?: MarkPin
  crew: boolean
  ring: string | null
  /** The mark's box, which the seat is derived in — a 24px picker face has its
   *  shoulder somewhere very different from a 40px list face. */
  size?: number
  kind?: AttentionKind
}) {
  // Same SEAT for both kinds — the shoulder is a property of the silhouette, not
  // of the news. Only the diameter and the pigment change, so the two tiers read
  // as one channel at two volumes. The unread dot is centred on the needs dot's
  // seat rather than seated on its own smaller box, or the two would visibly
  // jump when a row escalated from unread to needs.
  const unread = kind === 'unread'
  const dot = unread ? ATTENTION_DOT.unreadSize : ATTENTION_DOT.size
  const inset = (ATTENTION_DOT.size - dot) / 2
  const seat = crew
    ? { left: FACEPILE.cluster.box - ATTENTION_DOT.size, top: 0 }
    : attentionDotSeat(characterFromSeed(seed, pin), size, VIEWBOX)
  return (
    <span
      aria-hidden
      data-vr="attention-dot"
      data-attention-kind={kind}
      className="absolute rounded-full"
      style={{
        left: seat.left + inset,
        top: seat.top + inset,
        width: dot,
        height: dot,
        background: unread ? ATTENTION_DOT.unreadColor : ATTENTION_DOT.color,
        boxShadow: `0 0 0 ${ATTENTION_DOT.ringWidth}px ${ring ?? 'var(--sm-paper)'}`,
      }}
    />
  )
}
