/**
 * The chat surface — props in, pixels out.
 * ─────────────────────────────────────────────────────────────────────────────
 * `chat-panel.tsx` owns the data plane (hooks, the turn machine, the tail); this
 * owns the room those things are rendered in. It fetches nothing, subscribes to
 * nothing and holds no turn state, so it can be rendered from a unit test or the
 * `/dev/chat-live` bench with a literal session object.
 *
 * Its one non-slot responsibility is the ACCENT: the surface root is where the
 * focused session's pigment is written (`session-accent.ts`), because everything
 * that re-skins — the `sm-accent-*` utilities, the composer focus ring, a
 * selected choice — reads it by inheritance from here. Writing it any higher
 * (`:root`) would make the shell chrome wear a session's colour; writing it
 * lower would mean writing it in five places that could disagree.
 *
 * Slots, top to bottom:
 *   · `header` — the session pill (`header-pill.tsx`, A3 T6), passed by the
 *     panel. The DEFAULT occupant is `<SurfaceStatus>`, the honest minimum
 *     (which session, how is it going) for a surface rendered without one.
 *   · `children` — transcript + live layer, inside the scroll region.
 *   · `footer` — the composer shell (its real input plane is A4).
 *
 * TWO IMPORT RULES, both load-bearing:
 *   1. `components/chat/*` imports from `components/chat/ui`, never the reverse
 *      (fase B0 rule — there are two `WorkingRow`s and two provisional tails).
 *   2. **No `@/` alias and no runtime import that uses one.** This module is
 *      rendered by `bun test` (chat-accent, chat-surface), and the unit runner
 *      resolves the root `tsconfig.json`, which carries no `paths` — the same
 *      reason `dev-chat-ui.fixture.ts` lives outside its route. Type-only
 *      imports are fine; they are erased before resolution.
 */
import * as React from 'react'

import type { MarkPin } from '../../brand/marks'
import type { SessionStatus } from '../../lib/api'
import type { TileSession } from '../session-tile/types'
// Type-only (erased before resolution) — keeps this module free of the `@/` alias
// the unit runner's root tsconfig cannot resolve (see this file's header rule 2).
import type { KbLayoutComponent } from '../focus-mode/kb-modes/contract'

import { sessionAccentVarsFor } from './session-accent'

export interface ChatSurfaceProps {
  /** The session's immutable slug — the accent seed and the mark seed. */
  name: string
  /** The session row, or `null` while the sessions query is still resolving. */
  session: TileSession | null
  /**
   * The seed's identity pin, when the caller has one. It is passed to the SAME
   * derivation the marks use, so a pinned session cannot end up with a teal face
   * in an amber room (the wire carries no pins yet — see `session-accent.ts`'s
   * §10 TODO — so today only the bench passes this).
   */
  pin?: MarkPin
  /** Top slot. Omit for the default status line (A3 T6 passes the header pill). */
  header?: React.ReactNode
  /**
   * The header floats over the transcript instead of sitting above it — the
   * phone's composition (`mobile-light.png`), where the track scrolls UNDER the
   * glass card. The scroll region then owes itself the top padding, which is why
   * this is a prop and not a guess: only the caller that sets the padding may
   * ask for the overlay (`conversation.tsx` sets both).
   */
  headerOverlay?: boolean
  /**
   * The phone composition offsets the floating header card DOWN by the iOS
   * safe-area so the card floats clear of the notch (`mobile-light.png`: a 60px
   * card inset 12px under the status bar). The single reservation of that inset
   * lives here as the overlay wrapper's `top` — `calc(var(--safe-top) + 12px)`
   * — NOT as padding inside the card (that painted an empty band above the
   * name, doubling the card's height on a notched device). Off-phone the header
   * pins to the pane top (`top:0`), so this stays unset. See `--safe-top`
   * (globals.css) for why the inset is a named var and not a raw `env()`.
   */
  headerOverlayInsetTop?: string
  /**
   * Bottom slot — the composer. It FLOATS: the approved boards inset the pill
   * from the pane's bottom edge and let the transcript pass behind its blur, so
   * this layer is absolutely positioned and the scroll region reserves the room
   * with its own bottom padding (again, `conversation.tsx` owns both halves).
   */
  footer?: React.ReactNode
  /** Transcript + live layer. */
  children?: React.ReactNode
  /**
   * A layer between the scroll region and the composer — the jump-to-bottom
   * pill (daily-driver QA #17), and nothing else so far.
   *
   * It is NOT part of the `footer` slot, deliberately: the footer's height is
   * measured and paid for in the track's bottom padding (QA #12), so a pill
   * parked in there would push every message up by 44px whenever it appeared
   * and pull it back down when it left. Its own layer, below the composer's
   * z-index, click-through except on the control itself.
   */
  float?: React.ReactNode
  /**
   * A layer over this pane, above the header and the composer (fase A4 T5 — the
   * Attention card's expanded form). Scoped to the SURFACE, not portalled to the
   * document: a refusal belongs to the session it happened in, so the roster and
   * the other pane of a split stay live while it is up. The slot renders
   * nothing of its own — the occupant owns its scrim, its motion and its exit.
   *
   * TODO §11.4: when the shell-scoped overlay layer lands (Track B) it adopts
   * this slot's occupant and this becomes its mount point.
   */
  overlay?: React.ReactNode
  /** The scroll region's element, for the follow-bottom arithmetic (A3 T7). */
  scrollRef?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
  /**
   * Root test id. The surface IS the panel's root element (one flex column, no
   * wrapper), so the panel passes its own long-standing `chat-panel` id — the
   * renderer-switch e2e asserts on it.
   */
  testId?: string
  /**
   * The keyboard-layout handler (`KbLayout`), threaded from the mobile focus
   * route (the mode-9 root-resize layout). It owns how the composer stays flush
   * above the soft keyboard on the owner's device by shrinking the app root to
   * `visualViewport.height` while the keyboard is open.
   *
   * WHEN ABSENT (desktop, unit tests, `/dev/chat-live`) this surface renders its
   * CURRENT DOM byte-for-byte — no regression to any existing test. WHEN PRESENT
   * (mobile focus route) the surface computes its header / body / composer nodes
   * and hands them to the layout INSTEAD of arranging them itself; the layout
   * places them. See `focus-mode/kb-modes/`.
   */
  layout?: KbLayoutComponent
}

/**
 * Status → its token in the `--status-*` family, and its sentence-case word.
 *
 * A local mirror of `session-tile/status-dot.tsx` rather than an import, for the
 * resolution reason in this file's header (that module reaches `@/lib/utils`).
 * Same five colours, same five words, same semantics — `starting` is neutral so
 * a boot window never masquerades as "running", `idle` is the calm green
 * "ready". ONE deliberate omission: `StatusDot` swaps the disc for a CSS
 * spinner on the two loading states (`starting`/`active`); this fallback does
 * not, because it is a fallback — the panel fills this slot with
 * `header-pill.tsx`, which mounts the real `StatusDot` (plan §T6.1) and has the
 * spinner. Values are Tailwind tokens that
 * resolve to `hsl(var(--status-*))`, which is the point of the guard below: the
 * status channel is `--status-*` and NEVER `--sm-accent`, so "which session" and
 * "how is it going" stay two readable channels instead of one.
 */
const STATUS_TOKEN: Record<SessionStatus, string> = {
  starting: 'bg-status-idle',
  active: 'bg-status-active',
  waiting: 'bg-status-waiting',
  idle: 'bg-status-ready',
  stopped: 'bg-status-idle',
  error: 'bg-status-error',
}

const STATUS_WORD: Record<SessionStatus, string> = {
  starting: 'Booting',
  active: 'Running',
  waiting: 'Needs input',
  idle: 'Idle',
  stopped: 'Stopped',
  error: 'Error',
}

/**
 * Which session, and how is it going — the top slot's default occupant, and the
 * surface's only status affordance. It carries no accent, deliberately: that is
 * concept contract C7, asserted in `tests/unit/chat-accent.test.ts`.
 */
export function SurfaceStatus({ session }: { session: TileSession | null }) {
  if (!session) return null
  const label = session.display_name?.trim() ? session.display_name : session.name
  return (
    <div
      data-testid="chat-surface-status"
      data-status={session.status}
      className="flex min-w-0 items-center gap-2"
    >
      {/* The board's header cluster: the name at 15/600, left-aligned, and the
          state as a quiet disc rather than a word — the boards keep status
          subtle, so it is carried by colour + accessible name, the way every
          other status dot in the app does it. */}
      <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{label}</span>
      {/* ONE STATUS VOICE (gap G13). This used to be `role="img"` on an EMPTY
          span carrying both a `title` and an `aria-label` — a widget invented
          out of a coloured dot, announced twice by some AT and not at all by
          others, and duplicated again whenever `header-pill.tsx` filled this
          slot with the real `StatusDot`. The dot is now decoration (which is
          what it is), and the word rides in this row's own text, where it reads
          as "release-train, Running" — one name, one state, once. */}
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATUS_TOKEN[session.status]}`} />
      <span className="sr-only">{STATUS_WORD[session.status]}</span>
    </div>
  )
}

export function ChatSurface({
  name,
  session,
  pin,
  header,
  headerOverlay,
  headerOverlayInsetTop,
  footer,
  children,
  float,
  overlay,
  scrollRef,
  onScroll,
  testId = 'chat-surface',
  layout: Layout,
}: ChatSurfaceProps) {
  const top = header ?? (
    <div className="flex items-center gap-2 px-5 py-2">
      <SurfaceStatus session={session} />
    </div>
  )
  // THE SURFACE'S ONE HEADING, AND ITS LANDMARK (gap G9). This pane was divs
  // all the way down: no heading to jump to, no named region, and the only
  // visible title (`header-pill.tsx`) is a `<header>` with neither. A screen
  // reader's heading list showed nothing for the busiest surface in the app.
  // The heading is sr-only because the pill already draws it — this names the
  // room for AT without drawing a second title over the boards' composition.
  // Id derived from the slug rather than `useId()`: the slug is already unique
  // per surface (a split pane renders two, with two different names) and it costs
  // a template literal instead of a hook.
  const hid = `chat-title-${name}`
  const title = session?.display_name?.trim() ? session.display_name : name

  // The three semantic regions, computed ONCE so both the default arrangement
  // and a delegated `KbLayout` render the identical subtrees. When no `layout`
  // is passed they are dropped straight into the accent root in this order —
  // byte-identical to the pre-KbLayout DOM (a React fragment creates no box, so
  // `bodyNode`'s children stay direct flex children of the root and the track's
  // `flex-1` still sizes against it).
  //
  // The top slot owns its own box: the A3 T6 header pill has a safe-area inset
  // and a height floor of its own, and a padded wrapper here would inset it
  // twice. The DEFAULT occupant keeps the padding it always had, so a surface
  // rendered without a header looks exactly as it did.
  const headerNode = headerOverlay ? (
    <div
      className="absolute inset-x-0 z-[3]"
      // The notch reserved ONCE: on the phone the wrapper drops the card below
      // the safe area (`calc(var(--safe-top) + 12px)`); off-phone it sits flush
      // at the pane top. `top` (not padding) so the card keeps its own 60px
      // height instead of growing to swallow the inset.
      style={{ top: headerOverlayInsetTop ?? 0 }}
    >
      {top}
    </div>
  ) : (
    <div className="shrink-0">{top}</div>
  )

  // The scroll region + its float layer — the `body` the mode is handed. Kept as
  // a fragment so, in the default arrangement, track and float remain the same
  // two siblings of the root they always were.
  const bodyNode = (
    <>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // A named region, NOT a live one: the transcript's arrivals are spoken
        // by the live layer's single coalesced status (see `live-layer.tsx`'s
        // `LiveAnnouncer`). Making this a `log`/`aria-live` container is the
        // naive repair the A6 plan warns about — the WS seed inserts the whole
        // backlog into it after mount, and every one of those entries would be
        // read out loud before the user reached the message they asked for.
        role="region"
        aria-labelledby={hid}
        // The TRACK, addressable. Two behaviours need to name this exact
        // element rather than guess at it from a ref they were handed:
        //   · `chat-track` (globals.css) states out loud that everything the
        //     agent said is selectable text with the native iOS callout — the
        //     one thing a reader on a phone can do with a message is copy it;
        //   · the phone's tap-to-dismiss (`use-tap-to-dismiss.ts`) listens here,
        //     so "tapped above the keyboard" means "tapped the transcript" and
        //     nothing wider.
        data-chat-track=""
        // `overscroll-contain` (bug C): the transcript is an INNER scroller inside
        // the shared `<main data-shell-content overflow-auto>` (layout.tsx). Without
        // this, a wheel delta past the transcript's top/bottom CHAINS up to `<main>`
        // (and the root), dragging the whole focus shell — rail + roster + header —
        // out of view and exposing the app's dark ground below. `contain` stops the
        // chain at this boundary while keeping the local bounce; it is the
        // standardized fix (Safari 16+, macOS+iOS) and a no-op where unsupported.
        // `body { overscroll-behavior: none }` (globals.css) is NOT sufficient — it
        // stops the body rubber-banding the browser, not an inner list chaining into it.
        className="chat-track min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {children}
      </div>

      {float != null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[3]">{float}</div>
      )}
    </>
  )

  const composerNode =
    footer != null ? <div className="absolute inset-x-0 bottom-0 z-[4]">{footer}</div> : null

  return (
    <div
      data-testid={testId}
      data-surface="chat"
      data-session={name}
      // The ONE accent write on this subtree. Seeded by the slug, never the
      // display name — a rename must not change a session's colour.
      style={sessionAccentVarsFor({ name }, pin)}
      // `paper-raised`, not `paper`: the boards' conversation pane sits ONE step
      // above the roster's paper (globals.css names the token "conversation pane
      // — above the paper"), and that step is the whole elevation ladder the
      // bubbles and the glass bars are read against. `relative` is what lets the
      // header and the composer float (see the props above).
      className="relative flex h-full w-full flex-col bg-paper-raised text-ink"
    >
      <h2 id={hid} className="sr-only">
        Conversation with {title}
      </h2>
      {Layout ? (
        // Delegated: the active keyboard-layout MODE arranges the three regions
        // and owns keyboard-avoidance. `chatActive` is always true here — the
        // terminal path does not mount a KbLayout (only the chat surface does).
        <Layout header={headerNode} body={bodyNode} composer={composerNode} chatActive />
      ) : (
        // Default arrangement — the pre-KbLayout DOM, byte-for-byte.
        <>
          {headerNode}
          {bodyNode}
          {composerNode}
        </>
      )}

      {/* Above both floating layers (header z-3, composer z-4): the card is
          telling the user that one of them just refused to do something. */}
      {overlay}
    </div>
  )
}

export default ChatSurface
