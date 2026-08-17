// MemberStatusDot — a teammate's status, expressed in the app's ONE status
// vocabulary (B5/T12.2).
//
// ── What this used to be ────────────────────────────────────────────────────
// A parallel implementation of `<StatusDot>`: its own four-state colour table,
// its own spinner markup, its own sizes. Two components, one visual language,
// and nothing keeping them in step — a token changed in `status-dot.tsx` simply
// did not reach teammates, and a teammate's "idle" green could drift from a
// session's "idle" green while both claimed to mean the same thing.
//
// ── What it is now ──────────────────────────────────────────────────────────
// A thin ADAPTER. `MemberStatus` is a genuinely different domain — it is
// derived from a team roster, not from the status detector — so the type stays.
// What goes is the second renderer: the four states map onto the shipped
// `SessionStatus` vocabulary and `<StatusDot>` draws them.
//
// Kept as a component rather than inlined at its six call sites for exactly the
// reason §16.3 asks for an adapter: the MAPPING is the interesting part, and it
// deserves one place to live and one place to argue with.
//
//   working   → active   the amber spinner. Both mean "busy, hang on", and both
//                        rotate even under Reduce Motion — functional feedback,
//                        not decoration. Same `sm-status-spinner` keyframe as
//                        before, so this state is pixel-identical.
//   needs_you → waiting  the static blue disc. Calm on purpose: the LOUD blue
//                        signal is the `needs you` pill on the chip's trailing
//                        edge, never the dot, so exactly one loud token exists
//                        per row.
//   idle      → idle     the green "ready" disc — turn ended, teammate alive.
//   offline   → stopped  the muted grey reserved for "agent is off". A teammate
//                        with no live pane and a stopped session are the same
//                        fact, and were already drawn the same way by accident;
//                        now they are the same by construction.
//
// Decorative + non-interactive (no 44pt rule). Footprint ≤ 14px, unchanged.

import { StatusDot } from '@/components/session-tile/status-dot'
import type { SessionStatus } from '@/lib/api'
import type { MemberStatus } from '@/lib/api/teams'

const LABEL: Record<MemberStatus, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  idle: 'Idle',
  offline: 'Offline',
}

/** The mapping, as data — the one thing this module still owns. */
export const MEMBER_STATUS_TO_SESSION: Record<MemberStatus, SessionStatus> = {
  working: 'active',
  needs_you: 'waiting',
  idle: 'idle',
  offline: 'stopped',
}

export function MemberStatusDot({
  status,
  className,
}: {
  status: MemberStatus
  className?: string
}) {
  return (
    <StatusDot
      status={MEMBER_STATUS_TO_SESSION[status]}
      className={className}
      // The teammate's OWN word, not the session word it maps to. The mapping
      // is a rendering decision; a screen-reader user is being told about a
      // teammate, so "Needs you" must not become "Waiting".
      label={LABEL[status]}
    />
  )
}

export { LABEL as MEMBER_STATUS_LABEL }
