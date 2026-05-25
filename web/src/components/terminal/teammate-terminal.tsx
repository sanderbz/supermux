// TeammateTerminal — a READ-ONLY live terminal for an Agent Teams teammate pane
// (AT-F-FRONT / F2). Reuses the ENTIRE existing terminal stack: it renders
// <LiveTerminal> with a `wsPath` override pointing at the read-only teammate WS
// route `/ws/teams/{team}/{member}` (AT-E). The handshake / replay / close-code
// contract is byte-for-byte identical to the session terminal, so the shared
// <LiveTerminal> + useLiveTerm machinery (auth-first, replay_done reveal, backoff,
// 4404→stopped, 1013→backoff) works verbatim — nothing reinvented here.
//
// READ-ONLY: the backend IGNORES all client input for this route (AT-E), so we
// always pass `readOnly` and never wire xterm onData→ws.send (write/steer is a
// later slice). The pane can legitimately vanish (a teammate panes' %id flips to
// null across ticks); a vanished pane closes the WS with 4404 → useLiveTerm flips
// to `stopped` and STOPS reconnecting (no retry storm on a gone pane).
//
// Used by both the teammate peek (a half-sheet) and the full-screen teammate
// focus. The optional `paneId` is the AT-E `?pane_id=%id` fast-path: when the
// team SSE model already holds a validated %id we pass it so the server can skip
// a config.json parse (it still re-validates). When absent the server reads the
// member's %id from config.json itself — so this works with or without it.

import * as React from 'react'

import { LiveTerminal } from '@/components/terminal/live-terminal'

export interface TeammateTerminalProps {
  /** Team name (the AT-B `Team.team_name`). */
  team: string
  /** Teammate name (the AT-B `TeamMember.name`). */
  member: string
  /** Optional validated tmux pane id ("%17") from the team SSE model — sent as
   *  the AT-E `?pane_id=` fast-path so the server skips a config parse. Pass the
   *  member's `tmux_pane_id` when non-null; omit otherwise (server reads config). */
  paneId?: string | null
  className?: string
  /** xterm base font size (px). Omit for the LiveTerminal default (13). */
  fontSize?: number
  /** SGR-coloured cached tail to show INSTANTLY on open (no blank-black flash)
   *  before the live stream pins to the bottom, then crossfades. Teammates have
   *  no cached tail in the sessions cache, so the caller may supply one if it has
   *  captured it elsewhere; usually omitted (the terminal reveals on replay_done). */
  previewAnsi?: string[]
  /** Plain-text twin of `previewAnsi`. */
  previewLines?: string[]
}

/** Build the read-only teammate WS path (AT-E): `/ws/teams/{team}/{member}` with
 *  an optional `?pane_id=%id` fast-path. Every segment is encoded; the leading
 *  slash is added by <LiveTerminal> if missing. */
function teammateWsPath(
  team: string,
  member: string,
  paneId?: string | null,
): string {
  const path = `/ws/teams/${encodeURIComponent(team)}/${encodeURIComponent(member)}`
  if (paneId) return `${path}?pane_id=${encodeURIComponent(paneId)}`
  return path
}

export function TeammateTerminal({
  team,
  member,
  paneId,
  className,
  fontSize,
  previewAnsi,
  previewLines,
}: TeammateTerminalProps) {
  const wsPath = React.useMemo(
    () => teammateWsPath(team, member, paneId),
    [team, member, paneId],
  )
  return (
    <LiveTerminal
      // `name` is only used for the aria-label + (skipped) cached-tail fallback —
      // the real target is `wsPath`. A team/member-qualified name keeps the
      // a11y label meaningful.
      name={`${member} · ${team}`}
      wsPath={wsPath}
      // The teammate route is read-only on the server; keep stdin disabled.
      readOnly
      className={className}
      fontSize={fontSize}
      previewAnsi={previewAnsi}
      previewLines={previewLines}
    />
  )
}

export default TeammateTerminal
