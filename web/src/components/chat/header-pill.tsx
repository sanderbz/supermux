/**
 * The session header pill — who you are talking to, and how it is going.
 * ─────────────────────────────────────────────────────────────────────────────
 * `board-light.png` / `board-dark.png` / `board-patch-focused.png` all open the
 * same way: a 28px face, the session's name, and a hairline under a warm glass
 * bar. This is that bar, wired to a live session row.
 *
 * THE ONE STRUCTURAL PROMISE: a session switch, a status flip and a mode change
 * must cost ZERO layout shift, because everything under this header is
 * bottom-anchored — a header that grows by a pixel drags the whole transcript
 * with it. Two mechanisms, both asserted in `tests/unit/chat-header.test.tsx`:
 *
 *   · the slot is a FLOOR (`min-height`) plus an ADDITIVE inset (`pt-safe`),
 *     never a fixed height. Tailwind is border-box, so `h-16 pt-safe` lets
 *     env(safe-area-inset-top) eat into the bar and squish the name under the
 *     notch; `min-h` + `pt-safe` grows it instead (globals.css says this at
 *     length beside the `safe-header` utility).
 *   · the inner is ABSOLUTE and lives in a single grid cell, so the outgoing
 *     session and the incoming one overlap rather than queue (master plan
 *     §11.6, the same technique `live-layer.tsx`'s `SwapCell` uses for the
 *     provisional→confirmed swap). Nothing inside the cell can size the slot,
 *     so a 40-character display name and a one-character one produce the same
 *     bar height.
 *
 * TWO DEVIATIONS FROM THE PLAN'S PROSE, both because the boards outrank it:
 *   1. §T6.1 says "display name 15/600". The approved board measures a ~12px
 *      cap height at 2×, i.e. 16px/600 at −0.2px tracking, which is exactly
 *      what the B0 bench's own board header (`/dev/chat-ui`) already ships. The
 *      board wins; 15px is the BUBBLE's size, and the header is not a bubble.
 *   2. §T6.2 permits `sm-accent-wash` on the pill. The boards decline it: the
 *      Patch-focused header is the same warm neutral as the amber one to within
 *      three levels, so the accent is CARRIED here (descendants and B1's shared
 *      header read it) but not painted as a wash. Permission, not obligation.
 *
 * The `min-height` is a local constant rather than `--sm-toolbar-min-h`: that
 * token does not exist in B0, and minting one would put a `globals.css` diff in
 * a Track A PR — the same reason T6.4 leaves `desktop-split.tsx` alone.
 */
import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { SessionMark, type MarkPin, type MarkState } from '../../brand/marks'
import type { SessionStatus } from '../../lib/api'
import { eases } from '../../lib/springs'
import { cn } from '../../lib/utils'
import { modeChipLabel } from '../focus-mode/mode-labels'
import { StatusDot } from '../session-tile/status-dot'
import type { TileSession } from '../session-tile/types'

import { sessionAccentVarsFor } from './session-accent'
import { MARK_SIZE, PHONE } from './ui'

/**
 * The bar's floor, in px — `board-light.png`'s header, measured. A floor and
 * not a height: see the file header.
 */
const BAR_MIN_H = 64

/** §11.6's same-cell swap: 260ms of opacity, and nothing else moves. */
const SWAP_S = 0.26

/**
 * Status → the face's presence.
 *
 * The face and the status dot answer the same question at two volumes, so they
 * must never disagree: `starting` and `active` are both "busy, hang on" (the
 * dot spins for exactly that pair), `error` is the mark's `failed` still.
 */
const MARK_STATE: Record<SessionStatus, MarkState> = {
  starting: 'working',
  active: 'working',
  waiting: 'waiting',
  idle: 'idle',
  stopped: 'stopped',
  error: 'failed',
}

export interface SessionHeaderPillProps {
  /** The focused session's immutable slug — the mark seed and the accent seed. */
  name: string
  /** The session row, or `null` while the sessions query is still resolving. */
  session: TileSession | null
  /** Roster-assigned identity channels, when the caller has them (TODO §10). */
  pin?: MarkPin
  /**
   * Desktop bar or phone card.
   *
   * `mobile-light.png` does not draw this bar narrower — it draws a DIFFERENT
   * object: a 60px glass card inset 12px from both edges, radius 22, floating
   * over the track rather than pinned to the top edge. Same cluster inside, same
   * swap, same accent write; only the box changes.
   */
  surface?: 'desktop' | 'phone'
  /**
   * The shell's own affordances, either side of the cluster — the phone board's
   * back chevron and account avatar. They are NAVIGATION, which the surface does
   * not own: A5's mobile shell fills these, and the bench fills them to prove the
   * geometry is the board's.
   */
  leading?: React.ReactNode
  trailing?: React.ReactNode
  className?: string
}

export function SessionHeaderPill({
  name,
  session,
  pin,
  surface = 'desktop',
  leading,
  trailing,
  className,
}: SessionHeaderPillProps) {
  const phone = surface === 'phone'
  const reduce = useReducedMotion() ?? false

  // The label rule the whole app shares (`displayLabel`): a set display name
  // wins, the slug is the fallback. Inlined rather than imported because this
  // module is rendered by `bun test`, whose resolver reads the root
  // tsconfig.json and its empty `paths` — the reason every import above is
  // relative (see `chat-surface.tsx`'s header).
  const label = session?.display_name?.trim() ? session.display_name : name
  const status = session?.status
  // `normal` is the absence of a mode rather than a mode; a chip that always
  // reads "Normal" is one more thing to look past.
  const mode = session?.mode && session.mode !== 'normal' ? modeChipLabel(session.mode) : null

  return (
    <header
      data-testid="chat-header-pill"
      // The accent, carried (not painted): the mark, and any B1 consumer that
      // mounts this pill OUTSIDE the chat surface, read it from here. Same
      // derivation as the surface root, from the same seed AND the same pin, so
      // the two writes cannot drift into two different "session colours".
      style={sessionAccentVarsFor({ name }, pin)}
      className={cn(
        'shrink-0 bg-surface pt-safe',
        // The boards' glass: the transcript scrolls UNDER this bar (already on
        // the phone; on the desktop once A5 makes the header an overlay), and
        // the blur is what keeps a captured frame from smearing across it.
        'backdrop-blur-[80px] backdrop-saturate-[180%]',
        phone
          ? 'mx-3 rounded-[22px] border-[0.5px] border-hairline'
          : 'border-b-[0.5px] border-hairline',
        className,
      )}
    >
      <div className="relative" style={{ minHeight: phone ? PHONE.head.height : BAR_MIN_H }}>
        <div className="absolute inset-0 grid">
          <AnimatePresence initial={false}>
            <motion.div
              // Re-keyed on the SLUG: switching sessions crossfades one whole
              // cluster for another (face, name, status, mode) instead of
              // morphing four independent pieces at four different speeds.
              key={name}
              data-pill-session={name}
              style={{ gridArea: '1 / 1' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              // Opacity only, in both branches — reduced motion shortens the
              // swap to nothing rather than swapping it for a different move.
              transition={{ duration: reduce ? 0 : SWAP_S, ease: eases.inOut }}
              className={cn(
                'flex min-w-0 items-center gap-3',
                phone ? 'pl-3 pr-3' : 'px-6',
              )}
            >
              {leading}
              <SessionMark
                seed={name}
                pin={pin}
                size={MARK_SIZE.gutter}
                state={status ? MARK_STATE[status] : 'idle'}
                // The name is right there; a second announcement is noise.
                label={null}
              />
              <span
                className={cn(
                  'min-w-0 truncate text-[16px] font-semibold tracking-[-0.2px] text-ink',
                  // On the phone the name is the elastic member: the trailing
                  // slot has to sit on the card's right edge, not next to the
                  // name (`mobile-light.png`).
                  phone && 'flex-1',
                )}
              >
                {label}
              </span>
              {/* The app's status affordance, not a lookalike — which is how the
                  busy states keep the spinner the boot window needs. It carries
                  the `--status-*` family and never the accent (contract C7). */}
              {status && <StatusDot status={status} />}
              {mode && (
                <span
                  className={cn(
                    'flex-none rounded-full border-[0.5px] border-hairline-soft bg-fill-soft px-2 py-[3px] text-[11.5px] font-medium tracking-[0.1px] text-ink-2',
                    !phone && 'ml-auto',
                  )}
                >
                  {mode}
                </span>
              )}
              {trailing}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </header>
  )
}

export default SessionHeaderPill
