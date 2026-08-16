/**
 * `<SessionFace>` — the mark, wherever a session is named.
 * ─────────────────────────────────────────────────────────────────────────────
 * One component so that "draw this session's face" has exactly one answer, and
 * so the kill switch has exactly one place to live. Every roster surface — the
 * tile, the list row, the focus strip, the command palette, the session picker,
 * the where-picker — goes through here.
 *
 * Three things it owns:
 *   1. the pin, from the app-wide roster provider (`usePin`), so faces are
 *      deduped across the whole product rather than per surface;
 *   2. the status → eye-state mapping (`markStateFor`), so no surface invents
 *      its own;
 *   3. the kill switch. `localStorage['supermux:roster-marks'] = '0'` falls back
 *      to the pre-B2 `StatusDot` — the same component, the same colours, the
 *      same spinner — with no redeploy.
 *
 * B0 contract C5 holds here: no ring, no notch, no overpainting. The face is
 * drawn and nothing is drawn on top of it. The one exception in the whole app is
 * the 7px attention dot, and it is seated by `RosterRow`, not here.
 */
import * as React from 'react'

import { SessionMark } from '@/brand/marks'
import type { MarkPin, MarkState } from '@/brand/marks'
import type { SessionStatus } from '@/lib/api/sessions'
import { markStateFor } from '@/lib/mark-status'
import { isRosterMarksEnabled } from '@/lib/roster-marks-flag'
import { usePin } from '@/hooks/use-roster-marks'
import { StatusDot } from '@/components/session-tile/status-dot'

export interface SessionFaceProps {
  /** The immutable slug — the seed. Never the display name: renaming a session
   *  must not change its face. */
  name: string
  status?: SessionStatus
  /** Override the derived eye state (a bench, or a surface that knows better —
   *  e.g. a just-finished turn showing `done`). */
  state?: MarkState
  /** 18 facepile · 24 picker · 28 strip/roster · 40 focus header / tile. */
  size?: number
  /** Explicit pin, for surfaces whose roster the provider does not own (team
   *  members, fixtures). Falls back to the app-wide assignment. */
  pin?: MarkPin
  /** Motion. Off in every still matrix and every reduced-motion path — the
   *  engine's shared rAF loop already skips unregistered marks. */
  animate?: boolean
  className?: string
  /** Accessible label. `null` means the face is decorative because the row
   *  already names the session in text — which is the usual case. */
  label?: string | null
}

/**
 * The face for one session.
 *
 * `usePin` is called unconditionally (rules of hooks) and is a single context
 * read — the assignment itself happened once, in the provider.
 */
export function SessionFace({
  name,
  status,
  state,
  size = 28,
  pin,
  animate = true,
  className,
  label = null,
}: SessionFaceProps) {
  const rosterPin = usePin(name)
  // Read once, at mount: the flag is a kill switch, not a preference, and must
  // not re-render the hero path.
  const [marks] = React.useState(isRosterMarksEnabled)

  if (!marks) {
    return <StatusDot status={status ?? 'idle'} className={className} />
  }

  return (
    <SessionMark
      seed={name}
      pin={pin ?? rosterPin}
      size={size}
      state={state ?? markStateFor(status)}
      animate={animate}
      label={label}
      className={className}
    />
  )
}
