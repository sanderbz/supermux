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
 *     list; the list is the roster underneath it.
 *
 * Motion is B0's facepile morph (§11.9): the active member expands by animating
 * PADDING, 400 ms, which is a layout change with no transform — under
 * `prefers-reduced-motion` the expanded state is simply the resting state and
 * the label is still there. Nothing here animates on its own.
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { Facepile, type FacepileMember } from '@/components/chat/ui'
import { usePin } from '@/hooks/use-roster-marks'
import { displayLabel } from '@/lib/api/sessions'
import type { AttentionSession } from '@/lib/attention-tiers'

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
  if (s.status === 'waiting') return { kind: 'choice', href: `${base}#choice` }
  return { kind: 'session', href: base }
}

export interface AttentionRollupProps {
  /** The ordered needs-you list — `rollup()` from `lib/attention-tiers.ts`. */
  sessions: readonly AttentionSession[]
  className?: string
}

export function AttentionRollup({ sessions, className }: AttentionRollupProps) {
  const navigate = useNavigate()
  // The member the pointer/keyboard is on — B0's facepile expands it into a
  // labelled pill. Not "the first one": a pile that permanently expands its
  // first member is just a wide button.
  const [active, setActive] = React.useState<number | null>(null)

  const shown = sessions.slice(0, MAX_FACES)
  const overflow = sessions.length - shown.length

  // Hooks may not be called in a loop, so the pins are read through a tiny
  // component per member instead. `MAX_FACES` is 3, so this is three components.
  const members: FacepileMember[] = shown.map((s) => ({
    seed: s.name,
    name: displayLabel(s as never),
  }))

  if (sessions.length === 0) return null

  return (
    <div
      data-vr="attention-rollup"
      data-count={sessions.length}
      className={cn('flex items-center gap-2', className)}
      onMouseLeave={() => setActive(null)}
    >
      <span className="shrink-0 text-[12px] font-medium text-ink-2">
        needs you: {sessions.length}
      </span>
      <div className="flex items-center">
        {shown.map((s, i) => (
          <RollupMember
            key={s.name}
            session={s}
            member={members[i]}
            index={i}
            active={active === i}
            onHover={() => setActive(i)}
            onPick={() => navigate(rollupTarget(s).href)}
          />
        ))}
      </div>
      {overflow > 0 && (
        <span
          data-vr="attention-rollup-overflow"
          className="shrink-0 text-[12px] tabular-nums text-ink-3"
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

/** One face in the pile. Its own component so `usePin` is a hook call per
 *  member rather than a loop, and so the whole member is one 44pt tap target. */
function RollupMember({
  session,
  member,
  index,
  active,
  onHover,
  onPick,
}: {
  session: AttentionSession
  member: FacepileMember
  index: number
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  const pin = usePin(session.name)
  const target = rollupTarget(session)
  return (
    <button
      type="button"
      data-vr="attention-rollup-member"
      data-session={session.name}
      data-target={target.kind}
      aria-label={`${member.name ?? session.name} needs you`}
      title={`${member.name ?? session.name} — needs you`}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onPick}
      // The pile overlaps; the button is the hit target and the Facepile draws
      // the face. `-ml` on everything but the first reproduces the −24% overlap
      // without the parent having to know it.
      className={cn('relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', index > 0 && '-ml-1.5')}
      style={{ zIndex: active ? 10 : index + 1 }}
    >
      <Facepile
        members={[{ ...member, pin }]}
        variant="row"
        size={24}
        activeIndex={active ? 0 : undefined}
      />
    </button>
  )
}
