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
import { motionOff, tweens } from '../../lib/springs'
import { cn } from '../../lib/utils'
import { modeChipLabel } from '../focus-mode/mode-labels'
import { usageTitle, worstWindow } from '../../lib/rate-limits'
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
// A6/T6.2 — was a per-file `const SWAP_S = 0.26`, one of three identical
// copies (composer.tsx, live-layer.tsx). The same-cell crossfade is now one
// token: `tweens.swap`, which also carries the `.sm-swap` CSS twin's number.

/**
 * The floor under the session's name on the phone (daily-driver QA #6).
 *
 * The header truncated the name to unusable stubs: `spike-qa-daily` rendered as
 * `spike-qa…` (95px shown against 124px needed) and a THREE-character name,
 * `ipc`, rendered as `i…` (23px against 26px) — because the mode chip and the
 * Chat/Terminal switch were served first and the name got the remainder. The
 * approved board shows "Release Train" in full.
 *
 * The fix is mostly NOT this number. It is the two things that made the residual
 * big enough to hold a name: the trailing controls STACK (the mode chip over the
 * switch, so the pair costs the wider of the two rather than their sum) and the
 * switch drops the word for the surface you are not looking at
 * (`renderer-switch.tsx`, `labels="selected"`). Measured at 390: the name's
 * share went 91px → 139px, i.e. ~15 characters at this type's ~9.1px, and
 * "Release Train" (118px) now renders whole.
 *
 * This floor is the guard BELOW that: on a 320px screen the residual is 69px, so
 * the name takes 112px off the top and the trailing controls shrink into what is
 * left (they can — the rail and its cells all shrink). Px and not `ch`: `ch` is
 * the width of `0`, which in this face is 11px against an average glyph's 9.1px,
 * so a `14ch` floor reserves ~17 characters' worth and pushes the switch off the
 * card at 390 — measured, not assumed.
 */
const NAME_MIN = 112

/**
 * The permission mode, as a chip. Extracted so the phone can STACK it over the
 * trailing slot and the desktop can keep it in the row without two copies of the
 * class list drifting apart.
 */
function ModeChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'flex-none rounded-full border-[0.5px] border-hairline-soft bg-fill-soft px-2 py-[3px] text-[11.5px] font-medium tracking-[0.1px] text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  )
}

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
   * not own: A5's mobile shell fills them (the back button, and the renderer
   * switch at its compact size — `routes/focus/mobile.tsx`), and the bench fills
   * them with the same two so the geometry it approves is the shipped one.
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
      {/* THE SLOT. `min-height` is a FLOOR, and the swap cell is IN FLOW inside
          it (one grid cell, both clusters at `grid-area: 1 / 1`, §11.6): the
          outgoing session and the incoming one still overlap and still cost one
          opacity change, but the card now CONTAINS its content.
          It did not. The cell used to be `absolute inset-0`, out of flow, so
          nothing inside could size the slot — which held while the phone's
          trailing stack was the two members it was designed for (mode chip over
          the switch) and broke the moment `chat-panel.tsx` added the connection
          chip as a third: 72px of stack in a 60px card, measured at 390×844 as
          the Bypass pill jammed against the card's top edge and the A · ⌘ · >_
          capsule hanging BELOW the card, over the transcript. A box that cannot
          grow does not clip its overflow — it spills it onto whatever is
          underneath. */}
      <div
        className="relative grid"
        style={{ minHeight: phone ? PHONE.head.height : BAR_MIN_H }}
      >
        <div className="grid">
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
              transition={reduce ? motionOff : tweens.swap}
              className={cn(
                'flex min-w-0 items-center',
                // 10px on the phone, not 12: four gaps at this width are 8px of
                // the name (QA #6 — every pixel in this row is the name's).
                // `py-1.5` is what keeps the trailing stack off the card's
                // rounded edge now that the slot can grow: with the two-member
                // stack it is free (19 + 3 + 26 + 12 = 60, exactly the floor),
                // and with three it buys the chips their margin instead of
                // letting them touch the border.
                phone ? 'gap-2.5 py-1.5 pl-3 pr-3' : 'gap-3 px-6',
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
                  // name (`mobile-light.png`). It is also the member with a
                  // FLOOR — see `NAME_MIN` (QA #6).
                  phone && 'flex-1',
                )}
                style={phone ? { minWidth: `${NAME_MIN}px` } : undefined}
              >
                {label}
              </span>
              {/* The app's status affordance, not a lookalike — which is how the
                  busy states keep the spinner the boot window needs. It carries
                  the `--status-*` family and never the accent (contract C7). */}
              {status && <StatusDot status={status} />}
              {/* THE CONDITION, BESIDE THE STATUS — and never instead of it.
                  A limit-hit session's status IS `idle`: the turn ended
                  normally, Claude Code just cannot start another one. The dot
                  keeps telling the truth about the turn; this chip tells the
                  truth about the session, which is the half the header was
                  missing entirely (verify matrix finding 1, 05-chat-limits.png).
                  It also covers the transcript-less case the wire plane cannot:
                  a startup wedge has no transcript to read at all. */}
              {session?.blocked && <BlockedChip blocked={session.blocked} />}
              {!session?.blocked && session?.limit_warning && (
                <WarningChip text={session.limit_warning} />
              )}
              {!session?.blocked && <UsageChip session={session} />}
              {/* THE TRAILING CLUSTER, and on the phone it STACKS.
                  The mode chip used to sit beside the renderer switch, and the
                  two together took 187px of a 342px row: `ipc` in bypass mode
                  rendered as `i…` (QA #6). Stacked, the pair costs the width of
                  the WIDER of the two instead of their sum plus a gap, and the
                  60px card has the height for both (26 + 3 + ~20). On the
                  desktop nothing moves: the chip keeps its `ml-auto` and the row
                  keeps its order. */}
              {phone ? (
                (mode || trailing) && (
                  // `shrink`, not `flex-none`: below ~370px the name has hit its
                  // floor and something must give — and it is this, by design.
                  <div className="flex min-w-0 shrink flex-col items-end gap-[3px]">
                    {/* Tighter than the desktop chip: stacked, the pair has 60px
                        of card to live in, and the chip is a label rather than a
                        control — it does not owe anybody a 34px tap target. */}
                    {mode && (
                      <ModeChip className="px-[7px] py-0 text-[11px] leading-[17px]">
                        {mode}
                      </ModeChip>
                    )}
                    {trailing}
                  </div>
                )
              ) : (
                <>
                  {mode && <ModeChip className="ml-auto">{mode}</ModeChip>}
                  {trailing}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </header>
  )
}

export default SessionHeaderPill

/**
 * The header's blocked chip — one word, and the terminal's own sentence on hover.
 *
 * Deliberately NOT the roster's `<BlockedBadge>`: this bar's whole structural
 * promise is that nothing in it can change the header's height (see the file
 * header), and the roster badge carries its own padding and line-height for a
 * denser row. Same token, same orange, same honesty; different metrics.
 */
function BlockedChip({
  blocked,
}: {
  blocked: { kind: string; text: string; detail?: string; wedge?: string }
}) {
  return (
    <span
      data-testid="chat-header-blocked"
      role="status"
      title={[blocked.text, blocked.detail].filter(Boolean).join(' — ')}
      className="shrink-0 whitespace-nowrap rounded-full bg-status-error/15 px-2 py-[3px] text-[11.5px] font-semibold leading-[16px] text-status-error"
    >
      {blocked.kind === 'limit' ? 'Limit reached' : 'Blocked'}
    </span>
  )
}

/**
 * The usage gauge — the one signal that arrives BEFORE the block.
 *
 * Drawn here rather than imported from the roster's `<UsageChip>` on purpose,
 * and it is not a style preference: `session-tile/activity-status` pulls the
 * recovery ladder and its motion with it, and importing it from this file put
 * those modules on the boundary between the entry chunk and the lazy chat chunk
 * — +2.5 KB gz of re-chunking for a nine-line span. The arithmetic is shared
 * (`lib/rate-limits`), which is the part that has to agree; the pixels are this
 * bar's, whose whole structural promise is that nothing in it changes the
 * header's height.
 */
function UsageChip({ session }: { session: TileSession | null }) {
  const worst = worstWindow(session?.rate_limits ?? undefined)
  if (!worst) return null
  return (
    <span
      data-testid="chat-header-usage"
      role="status"
      title={usageTitle(session?.rate_limits ?? undefined)}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full px-2 py-[3px] text-[11.5px] font-semibold leading-[16px] tabular-nums',
        worst.hot ? 'bg-status-error/15 text-status-error' : 'bg-fill-soft text-ink-2',
      )}
    >
      {worst.label} {Math.round(worst.pct)}%
    </span>
  )
}

/** The quiet half: Claude Code's own ≥70 % footer line, which exists on NO other
 *  plane (it is never written to the transcript). A chip, not a block — the
 *  session still works, and saying otherwise would be the opposite error. */
function WarningChip({ text }: { text: string }) {
  return (
    <span
      data-testid="chat-header-limit-warning"
      role="status"
      title={text}
      className="shrink-0 whitespace-nowrap rounded-full bg-status-waiting/12 px-2 py-[3px] text-[11.5px] font-medium leading-[16px] text-status-waiting"
    >
      Nearing limit
    </span>
  )
}
