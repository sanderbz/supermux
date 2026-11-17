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
import { attentionFor } from '../../lib/mark-status'
import { motionOff, tweens } from '../../lib/springs'
import { cn } from '../../lib/utils'
import { modeChipLabel } from '../focus-mode/mode-labels'
// A local zustand store (no query layer) — safe to import into this
// bun-test-rendered module: opening the shell's agent-tools sheet is a setState,
// and it is where the permission-mode switcher lives (relocated in 6905fe0).
import { useAgentToolsSheet } from '../../stores/claude-tools-store'
import { usageTitle, worstWindow } from '../../lib/rate-limits'
import { StatusDot } from '../session-tile/status-dot'
import type { TileSession } from '../session-tile/types'

import { errorBadgeLabel, statesSameBlock } from './agent-error'
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
 *
 * SINGLE-ROW REVISION: with the trailing cluster now INLINE (one row, not a
 * stacked column), the name is the member that yields so the row stays one line
 * — a wide reconnecting chip + the renderer toggle beside a hard 112px floor
 * would have overflowed the card, so the floor drops to a small, still-legible
 * stub (a couple of characters + ellipsis) and the name truncates the rest.
 */
const NAME_MIN = 56

/**
 * The one hint that the name is a door (`onTitleClick`) — a 12px chevron in the
 * quiet ink, riding the name's own baseline. Inline SVG rather than an icon
 * package: this module and everything it imports are rendered by `bun test`,
 * which is why it has no `@/` imports and no icon dependency (see the file
 * header). `shrink-0`, so it never eats the name's truncation room.
 */
function TitleChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-ink-2 opacity-70"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/**
 * The permission mode, as a chip. Extracted so the phone can STACK it over the
 * trailing slot and the desktop can keep it in the row without two copies of the
 * class list drifting apart.
 */
function ModeChip({
  children,
  className,
  onOpen,
  label,
}: {
  children: React.ReactNode
  className?: string
  /** When set, the chip is a BUTTON that opens the permission-mode switcher —
   *  the owner taps this to change or reset the mode (bypass restarts the pty; the
   *  other three switch live). Absent → a plain, non-interactive label. */
  onOpen?: () => void
  /** The accessible name for the interactive chip (the visible text is often just
   *  the mode word or a glyph). */
  label?: string
}) {
  const cls = cn(
    'flex-none rounded-full border-[0.5px] border-hairline-soft bg-fill-soft px-2 py-[3px] text-[11.5px] font-medium tracking-[0.1px] text-ink-2',
    onOpen &&
      'inline-flex items-center gap-1 cursor-pointer transition-colors hover:bg-fill-soft-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    className,
  )
  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} aria-label={label} title={label} className={cls}>
        {children}
      </button>
    )
  }
  return <span className={cls}>{children}</span>
}

/** The permission-mode glyph — a small shield. Shown alone in the Normal state
 *  (where there is no mode word to draw) so the switch is still reachable without
 *  cluttering the common header with the word "Normal". */
function ShieldGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-ink-3"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

/**
 * A workflow run in flight, as the header needs to say it.
 *
 * Pure props, deliberately: this module is rendered by `bun test` (empty
 * `paths`), and a chip that fetched its own workflow would drag the whole
 * query layer in with it. The data plane fills this in — see `chat-panel.tsx`.
 */
export interface HeaderWorkflow {
  /** The workflow whose run is occupying this pane. */
  id: string
  /** 1-based, as the SSE frame counts. */
  step: number
  steps: number
  /** The workflow's own page — where the run timeline lives. */
  href: string
  /** SPA navigation; the `href` stays real so the chip survives a middle-click. */
  onOpen?: () => void
  /** `POST /api/workflows/{id}/cancel`, supplied by the data plane. */
  onStop?: () => void
}

/**
 * THE HONESTY TELL.
 *
 * A workflow's steps arrive in this pane as ordinary submissions, and the human
 * can type into the same pane while the chain is mid-flight. v1 does NOT lock
 * the composer — locking a user out of their own agent is worse than the
 * interleaving — so the header discloses instead: what is running, how far it
 * has got, where to read it, and how to stop it.
 *
 * Renders nothing when nothing is running, which is the common case; a chip
 * that is always there is one more thing to look past.
 */
export function WorkflowChip({ workflow }: { workflow: HeaderWorkflow | null | undefined }) {
  if (!workflow) return null
  const { step, steps, href, onOpen, onStop } = workflow
  return (
    <span className="flex flex-none items-center gap-1 rounded-full border-[0.5px] border-hairline-soft bg-fill-soft py-[3px] pl-2 pr-1 text-[11.5px] font-medium tracking-[0.1px] text-ink-2">
      <a
        href={href}
        data-testid="chat-header-workflow"
        onClick={(e) => {
          // A real href (middle-click, long-press, "open in new tab" all work),
          // but a plain left click stays in the SPA.
          if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          onOpen()
        }}
        className="rounded-full px-0.5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Workflow · step {step}/{steps}
      </a>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          data-testid="chat-header-workflow-stop"
          aria-label="Stop this workflow run"
          className="rounded-full px-1.5 py-[1px] text-ink-2 transition-colors hover:bg-fill hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Stop
        </button>
      )}
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
  /**
   * A blocking prompt is on screen (a pty dialog, a permission request, or an
   * AskUserQuestion). Switching mode converges by pressing Shift+Tab, and that
   * keystroke would ANSWER the prompt (BTab accepts a permission dialog — a0 §3,
   * live-verified), so while one is up the mode chip is an INERT label, never a
   * control. Gated here by construction — the gate that cannot be forgotten.
   */
  modeLocked?: boolean
  /**
   * The quiet status bits — the data-plane chip (`<ConnectionNote>`: "Not up to
   * date", "Offline", …). Separated from `trailing` (the renderer toggle) so the
   * phone header can GROUP the status bits together and give the toggle its own
   * clear place, instead of stacking chip-over-chip-over-toggle into one tall
   * tower jammed against the card's edge (mobile polish #1). Rendered inline on
   * the desktop, exactly where the bundled node used to sit.
   */
  connection?: React.ReactNode
  /**
   * The chat data plane has GIVEN UP (`ChatPresentation === 'offline'`, A6) —
   * the socket is terminal or exhausted its redials. The status we hold is now
   * a stale claim, so the presence dot must stop reading as a live green
   * "ready": it goes to the neutral "unknown" grey and names itself Offline.
   * The `<ConnectionNote>` chip in `trailing` says the same thing in words; the
   * dot must not contradict it (showcase honesty: green dot beside "Offline").
   */
  offline?: boolean
  /**
   * The transcript itself could not be READ (`isError`) — a distinct failure
   * from `offline` (the socket giving up): the session may be alive, but the
   * status we hold is a stale claim we cannot vouch for. Under the GROK SKIN the
   * presence dot is greyed to the neutral "unknown" tone so it stops reading as a
   * live green "ready" beside a "Couldn't load this conversation." body (the
   * jury's worst honesty break). Off grok the dot is UNCHANGED — the wrapper this
   * adds is an inert `data-tail-error-dot` hook with no pixels of its own, so the
   * base app stays byte-identical.
   */
  tailError?: boolean
  /**
   * A workflow run is occupying this pane right now. Null/absent — the common
   * case — renders nothing. See [`WorkflowChip`].
   */
  workflow?: HeaderWorkflow | null
  /**
   * A live turn is streaming right now (the chat plane's `turnStart != null`).
   * Accepted-but-inert: the header face maps from `status` alone. Retained so the
   * chat surface can keep feeding the signal without a type break.
   */
  streaming?: boolean
  /**
   * Open this bot's details (the `<BotPanel variant="sheet">` the mobile focus
   * route already owns). When set, the NAME becomes the button that opens them —
   * the same title-click contract `<FocusHeader onTitleClick>` gives the terminal
   * chrome, which is the only way into the panel while chat holds the pane.
   * Omitted (desktop seam, benches) → the name stays the inert span it was.
   */
  onTitleClick?: () => void
  className?: string
}

export function SessionHeaderPill({
  name,
  session,
  pin,
  surface = 'desktop',
  leading,
  trailing,
  modeLocked,
  connection,
  offline = false,
  tailError = false,
  workflow,
  onTitleClick,
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
  // Tapping the mode chip opens the permission-mode switcher (the working control
  // in the shell's agent-tools sheet). Scoped to this session so bypass relaunches
  // the right pty.
  const openTools = useAgentToolsSheet((s) => s.openSheet)

  // The presence dot — green "ready" / the busy spinner / the grey offline disc.
  // It doubles as the ACTIVITY spinner (busy states spin it), so there is one
  // indicator, not two. On the desktop it rides the name row; on the phone it
  // joins the grouped status cluster on the right (mobile polish #1), so it stops
  // floating alone in the middle of the bar.
  const dot = status ? offline ? <OfflineDot /> : <StatusDot status={status} /> : null
  // When the tail could not be read (and the socket is not already flagged
  // offline), wrap the dot in an inert `data-tail-error-dot` hook so the grok
  // skin can grey it to the "unknown" tone. Off grok the wrapper is a bare inline
  // span with no pixels — the dot renders exactly as before (byte-identical).
  const presence = dot && tailError && !offline ? <span data-tail-error-dot="">{dot}</span> : dot

  return (
    <header
      data-testid="chat-header-pill"
      // The accent, carried (not painted): the mark, and any B1 consumer that
      // mounts this pill OUTSIDE the chat surface, read it from here. Same
      // derivation as the surface root, from the same seed AND the same pin, so
      // the two writes cannot drift into two different "session colours".
      style={sessionAccentVarsFor({ name }, pin)}
      className={cn(
        // A size container: the desktop bar condenses on its OWN width (a 440px
        // pane beside the roster rail), not the viewport's — see the row below.
        'shrink-0 bg-surface @container/pill',
        // The boards' glass: the transcript scrolls UNDER this bar (already on
        // the phone; on the desktop once A5 makes the header an overlay), and
        // the blur is what keeps a captured frame from smearing across it.
        'backdrop-blur-[80px] backdrop-saturate-[180%]',
        phone
          // The phone header is a FLOATING glass card (`mobile-light.png`: a
          // 60px card inset 12px UNDER the status bar). The safe-area inset is
          // therefore NOT this card's padding — a `pt-safe` here reserved the
          // notch INSIDE the card, painting ~47px of empty glass above the name
          // and doubling the card's height to ~115px on a notched device (the
          // env=0 review rig never showed it). The reservation now lives ONCE,
          // as the overlay wrapper's `top` offset in `chat-surface.tsx`
          // (`calc(var(--safe-top) + 12px)`), so the card keeps its 60px floor
          // and floats clear of the notch.
          ? 'mx-3 rounded-[22px] border-[0.5px] border-hairline'
          // Desktop is not notched (`env()`=0); the bar pins to the pane top and
          // keeps `pt-safe` for the harmless-at-env=0 additive reservation.
          : 'border-b-[0.5px] border-hairline pt-safe',
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
                // A narrow desktop bar (a tablet's pane beside the roster) gives
                // its gutters to the name. It condenses rather than wraps: the
                // transcript reserves one bar's height above the first message.
                phone ? 'gap-2.5 py-1.5 pl-3 pr-3' : 'gap-3 px-6 @max-[36rem]/pill:gap-2 @max-[36rem]/pill:px-3',
              )}
            >
              {leading}
              <SessionMark
                seed={name}
                pin={pin}
                size={MARK_SIZE.gutter}
                state={status ? MARK_STATE[status] : 'idle'}
                // The decoupled attention halo: the header mark raises the red
                // ring when this session needs you (Grok skin only).
                attention={attentionFor({ status })}
                // The name is right there; a second announcement is noise.
                label={null}
              />
              {onTitleClick ? (
                // The name is the way into the bot's details on the phone (the
                // terminal chrome has had it since feat-session-info; chat had
                // an inert span and no other door). A real button: the row's
                // 44px hit target, taken back out of the layout with a matching
                // negative margin so the card's geometry — the one structural
                // promise at the top of this file — does not move by a pixel.
                <button
                  type="button"
                  onClick={onTitleClick}
                  data-testid="chat-header-title"
                  title={label}
                  // The visible name LEADS, so voice control ("click <name>") and
                  // a screen reader's list both key on what is on screen.
                  aria-label={`${label} — bot details`}
                  aria-haspopup="dialog"
                  className={cn(
                    '-my-2.5 flex min-h-11 min-w-0 items-center gap-1 rounded-lg py-2.5 text-left',
                    'text-[16px] font-semibold tracking-[-0.2px] text-ink outline-none',
                    'transition-opacity active:opacity-60 focus-visible:ring-2 focus-visible:ring-ring',
                    phone && 'flex-1',
                  )}
                  style={phone ? { minWidth: `${NAME_MIN}px` } : undefined}
                >
                  <span className="min-w-0 truncate">{label}</span>
                  <TitleChevron />
                </button>
              ) : (
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
              )}
              {/* The app's status affordance, not a lookalike — which is how the
                  busy states keep the spinner the boot window needs. It carries
                  the `--status-*` family and never the accent (contract C7).
                  When the data plane is OFFLINE the status is a stale claim, so
                  the live dot stands down for the neutral offline dot: a green
                  "ready" disc beside an "Offline" chip is the exact contradiction
                  the honesty pass is closing. */}
              {/* On the phone the presence dot moves into the grouped status
                  cluster below; on the desktop it stays on the name row. */}
              {!phone && presence}
              {/* THE UNRECOVERED AGENT ERROR, AS A LEGIBLE CHIP — not a bare dot.
                  `session.error` is the durable `StopFailure` field the roster,
                  the list row and the focus header all render as an amber badge;
                  the chat header showed only the orange StatusDot, which reads as
                  metadata and let an errored session pass for idle. A word beside
                  the name is the persistent affordance. Suppressed when the block
                  chip already names the same limit (`statesSameBlock`), so one
                  condition is never stated twice. */}
              {session?.error && !statesSameBlock(session.blocked, session.error) && (
                <ErrorChip error={session.error} />
              )}
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
              {/* THE WORKFLOW TELL — beside the conditions, for the same reason
                  they are there: it is a fact about the SESSION, not about the
                  turn. See [`WorkflowChip`]. */}
              <WorkflowChip workflow={workflow} />
              {/* THE TRAILING CLUSTER — ONE ROW on the phone (single-row header).
                  It used to be a flex-COLUMN: the grouped status bits (presence,
                  mode, connection) on tier 1 and the renderer TOGGLE on tier 2.
                  Two tiers make the card two rows tall the moment a connection
                  chip appears (the reconnecting money-shot: a 60px card grew to
                  ~80px, the name floating in a half-empty top). A phone header is
                  a single iOS-style bar, so the status bits and the toggle now sit
                  INLINE on the one row, right-aligned; the name (flex-1) is the
                  member that yields and truncates when the row is tight. `flex-none`
                  so the cluster keeps its intrinsic width and the name gives first.
                  On the desktop nothing moves: the chip keeps its `ml-auto`, then
                  the connection chip, then the toggle. */}
              {phone ? (
                // THE MOBILE CHAT HEADER SHOWS NO STATUS DOTS (owner's call).
                // The trailing cluster used to carry three condensed dots — the
                // glyph-only mode dot, the compact connection dot and the
                // presence dot — beside the renderer toggle. The owner wants the
                // header stripped to its essentials: back · avatar · name · the
                // binary Chat/Console pill, and NO dots. So the phone cluster now
                // renders only the renderer switch (`trailing`); mode, connection
                // and presence are dropped from this render path (the presence
                // dot and connection chip still live on other surfaces — the
                // desktop name row below, and the overview tile — untouched).
                // `flex-none` keeps the toggle's intrinsic width; the name
                // (flex-1) is what yields when the row is tight.
                trailing && (
                  <div className="flex flex-none items-center justify-end gap-1.5">
                    {trailing}
                  </div>
                )
              ) : (
                <>
                  {/* The permission-mode switch — reachable on desktop so you can
                      enter a mode (bypass, plan…) from Normal too, and reset out of
                      it. Labeled when in a mode; a subtle shield in Normal (no
                      "Normal" clutter). Tap → the mode switcher. While a prompt is
                      up (`modeLocked`) it is an inert LABEL: the switch presses
                      Shift+Tab, which would answer the prompt. In Normal it then
                      has nothing to say, so it drops out entirely (as before). */}
                  {(mode || !modeLocked) && (
                    <ModeChip
                      className="ml-auto"
                      onOpen={modeLocked ? undefined : () => openTools(name)}
                      label={
                        mode ? `Permission mode: ${mode} — tap to change` : 'Set permission mode'
                      }
                    >
                      {mode ?? <ShieldGlyph />}
                    </ModeChip>
                  )}
                  {connection}
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
 * The unrecovered agent error, as a word beside the name.
 *
 * `session.error` (a `StopFailure` hook) drives the amber badge on every OTHER
 * session surface — the tile, the list row, the focus header — but the chat
 * header carried nothing for it, so an errored session read as healthy/idle
 * under a plain orange StatusDot. The label is the same `errorBadgeLabel` those
 * surfaces use, falling back to the honest generic when the pair carries nothing
 * more specific (a bare `StopFailure` classifies to no bucket). Same calm orange,
 * same header metrics as `<BlockedChip>` — this is the same rung of bad news.
 */
function ErrorChip({ error }: { error: { type: string; message: string } }) {
  const label = errorBadgeLabel(error.type, error.message) ?? 'Error'
  return (
    <span
      data-testid="chat-header-error"
      role="status"
      title={error.message}
      className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-status-error/15 px-2 py-[3px] text-[11.5px] font-semibold leading-[16px] text-status-error"
    >
      <span aria-hidden>⚠</span>
      {label}
    </span>
  )
}

/**
 * The presence dot when the data plane has GIVEN UP.
 *
 * A neutral "unknown" disc (`--status-idle`, the same dim grey a stopped session
 * gets) rather than the live green "ready" — because an offline socket can no
 * longer vouch that the session is idle-and-alive. Named Offline for assistive
 * tech, so the dot and the `<ConnectionNote>` chip say one thing, not two.
 */
function OfflineDot() {
  return (
    <span
      role="img"
      aria-label="Offline"
      data-testid="chat-header-offline-dot"
      className="size-2 shrink-0 rounded-full bg-status-idle"
    />
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
