/**
 * `<AttentionRollup>` — "needs you: N" in the overview header.
 * ─────────────────────────────────────────────────────────────────────────────
 * The one place in the app that answers "is anything waiting on me?" without
 * making you read a grid. It is a facepile, not a counter, because the answer
 * "three" is useless and the answer "Patch, Quill and the release build" is not.
 *
 * Three rules it keeps:
 *   · N = 0 renders NOTHING. No empty chrome, no "0 waiting" — a header that
 *     always shows an attention cluster is a header where you stop seeing it.
 *   · Ordered OLDEST-WAITING FIRST (`rollup()`): the session you have kept
 *     blocked longest is the one to answer.
 *   · N > 3 collapses to three marks and a "+N". The pile is a glance, not a
 *     list; the list is the PICKER underneath it.
 *
 * ── The tap, corrected ──────────────────────────────────────────────────────
 * The pile used to be N overlapping buttons, each navigating on its own. On a
 * phone the faces are 24px and overlap by −24%, so a thumb landed on WHICHEVER
 * face happened to be under it — and the "+N" was not a target at all. Tapping
 * "needs you" felt like it opened a random session, because it did.
 *
 * So the whole cluster is now ONE control (`aria-haspopup="dialog"`) and its tap
 * opens `<AttentionPickerSheet>` — a proper list of EXACTLY the sessions counted
 * in "needs you: N", each row naming what it needs and routing to THAT session's
 * focus. The pile is the glance; the sheet is the choice. No tap is ever random.
 *
 * Motion is B0's facepile morph (§11.9): the pile is a still cluster now (the
 * per-member hover-expand belonged to a per-member target that no longer
 * exists), which is also the reduced-motion resting state. Nothing animates on
 * its own.
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { Facepile, type FacepileMember } from '@/components/chat/ui'
import { usePin } from '@/hooks/use-roster-marks'
import { displayLabel } from '@/lib/api/sessions'
import { attentionFor, markStateForSession } from '@/lib/mark-status'
import type { AttentionSession } from '@/lib/attention-tiers'
// Lazy: the picker sheet opens only on a tap, so it has no business in the
// overview's entry chunk (the hero path). Splitting it keeps entry JS under its
// hard 160 KB budget.
const AttentionPickerSheet = React.lazy(() =>
  import('./attention-picker-sheet').then((m) => ({ default: m.AttentionPickerSheet })),
)

/** How many faces before the pile collapses to "+N". */
const MAX_FACES = 3

/**
 * Where a rollup member's tap lands. Three DIFFERENT destinations — the plan is
 * explicit that they are not the same thing, so the code names them:
 *
 *   'choice'    the session's chat, scrolled to the pending choice card. The
 *               common case: the agent asked a question and is blocked on it.
 *   'attention' A4's Attention card — the watchdog states (a permission dialog
 *               the renderer cannot show inline, a stalled turn).
 *   'session'   the session route itself. Everything else, including a blocked
 *               agent whose error is best read in the terminal.
 */
export type RollupTargetKind = 'choice' | 'attention' | 'session'

export interface RollupTarget {
  kind: RollupTargetKind
  href: string
}

/**
 * Resolve one member's tap target.
 *
 * A4/A5-SEAM: the chat surface has no deep-link anchor for a pending choice
 * card yet (A4 renders the card; nothing addresses it from outside), and A5
 * owns whether the chat renderer is even the default for this session. So the
 * `choice` and `attention` kinds are decided HERE, honestly, and both currently
 * navigate to the session with a hash the surface can adopt without a second
 * decision being made later. An unknown hash is inert, so this degrades to
 * "opens the session" rather than to a broken link.
 */
export function rollupTarget(s: AttentionSession): RollupTarget {
  const base = `/focus/${encodeURIComponent(s.name)}`
  if (s.permission_request) return { kind: 'attention', href: `${base}#attention` }
  // An MCP server is holding this session open on a typed form.
  if (s.elicitation) return { kind: 'attention', href: `${base}#attention` }
  if (s.status === 'waiting') return { kind: 'choice', href: `${base}#choice` }
  return { kind: 'session', href: base }
}

/**
 * The short reason a session is in the "needs you" list — the picker row's
 * subline. One fragment, sentence-case, states the demand.
 *
 * Precedence matches `needsYou` in `lib/attention-tiers.ts` but reads TOP-DOWN
 * by urgency of the human action: an unanswered permission/form is the sharpest,
 * a blocked bucket is a decision, an error is a look, a bare `waiting` is the
 * question. A row that says "needs you" and nothing else is the failure this
 * exists to avoid — the picker's whole point is to say WHAT.
 */
export function rollupReason(s: AttentionSession): string {
  if (s.permission_request) return 'Permission request'
  if (s.elicitation) return 'Waiting on a form'
  if (s.status === 'waiting') return 'Waiting for your answer'
  if (s.blocked) {
    if (s.blocked.kind === 'limit') return 'Usage limit reached'
    if (s.blocked.kind === 'startup' || s.blocked.wedge) return 'Needs setup to start'
    return 'Blocked'
  }
  if (s.error) return 'Stopped with an error'
  return 'Needs you'
}

export interface AttentionRollupProps {
  /** The ordered needs-you list — `rollup()` from `lib/attention-tiers.ts`. */
  sessions: readonly AttentionSession[]
  className?: string
}

export function AttentionRollup({ sessions, className }: AttentionRollupProps) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)

  const shown = sessions.slice(0, MAX_FACES)
  const overflow = sessions.length - shown.length

  // Hooks may not be called in a loop, so the pins are read through a tiny
  // component per member instead. `MAX_FACES` is 3, so this is three components.
  const members: FacepileMember[] = shown.map((s) => ({
    seed: s.name,
    name: displayLabel(s as never),
  }))

  if (sessions.length === 0) return null

  const label =
    sessions.length === 1
      ? 'One session needs you — open the list'
      : `${sessions.length} sessions need you — open the list`

  return (
    <>
      <button
        type="button"
        data-vr="attention-rollup"
        data-count={sessions.length}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
        // ONE 44px control, not N overlapping faces. The whole cluster is the
        // tap target and it opens the picker — the faces inside are a glance,
        // deliberately `pointer-events-none` so nothing about which face is
        // under the thumb changes where the tap goes.
        className={cn(
          'flex min-h-[44px] items-center gap-2 rounded-full px-1.5 -mx-1.5',
          'transition-colors hover:bg-fill-soft',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        <span className="shrink-0 text-[12px] font-medium text-ink-2">
          needs you: {sessions.length}
        </span>
        <span className="pointer-events-none flex items-center">
          {shown.map((s, i) => (
            <RollupFace key={s.name} session={s} member={members[i]} index={i} />
          ))}
        </span>
        {overflow > 0 && (
          <span
            data-vr="attention-rollup-overflow"
            className="shrink-0 text-[12px] tabular-nums text-ink-3"
          >
            +{overflow}
          </span>
        )}
      </button>

      <React.Suspense fallback={null}>
        <AttentionPickerSheet
          open={open}
          onOpenChange={setOpen}
          sessions={sessions}
          onPick={(s) => {
            setOpen(false)
            navigate(rollupTarget(s).href)
          }}
        />
      </React.Suspense>
    </>
  )
}

/** One face in the glance pile. Its own component so `usePin` is a hook call per
 *  member rather than a loop. Decorative — the parent button owns the tap. */
function RollupFace({
  session,
  member,
  index,
}: {
  session: AttentionSession
  member: FacepileMember
  index: number
}) {
  const pin = usePin(session.name)
  return (
    <span
      data-vr="attention-rollup-face"
      data-session={session.name}
      // The pile overlaps by −24%: `-ml` on everything but the first reproduces
      // it without the parent having to know the geometry.
      className={cn('relative', index > 0 && '-ml-1.5')}
      style={{ zIndex: index + 1 }}
    >
      {/* Every face in this pile is by definition a needs-you session, so it
          carries the SAME status→expression + attention halo the roster faces do
          (`mark-status.ts`, one engine): needs/blocked eyes and the red halo,
          not an idle placeholder. Grok-only channels — inert in the base pile. */}
      <Facepile
        members={[
          { ...member, pin, state: markStateForSession(session), attention: attentionFor(session) },
        ]}
        variant="row"
        size={24}
      />
    </span>
  )
}
