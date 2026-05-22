import { LiveTerminal } from '@/components/terminal/live-terminal'
import type { UseLiveTermResult } from '@/hooks/use-live-term'

// The hover-zoom live terminal — overview tile preview feature, behaviour #2.
//
// On hover, a tile swaps its static tail for a LIVE terminal: the agent's REAL
// pty, real ANSI colours, updating live — "the full window but smaller —
// readable at a glance" (the user's exact ask). It REUSES the M13
// <LiveTerminal> verbatim (read-only embed: no keystrokes) — xterm is not
// reimplemented.
//
// HOW THE ZOOM WORKS — and why the old approach failed.
// The first cut rendered xterm at a fixed 760×300 "full window" geometry then
// CSS-`transform: scale()`'d the whole box down to the ~330px tile width
// (scale ~0.43). For a real agent idle at its prompt — a buffer that is mostly
// empty rows — that produced a large near-black void with the actual text shr:
// 13px glyphs scaled to ~5.6px, an illegible microscopic sliver at the bottom.
// That is NOT "the full window but smaller, readable at a glance".
//
// THE FIX. We do NOT CSS-scale. Instead the terminal renders at its NATIVE
// font size directly inside the tile-sized box: xterm's FitAddon snaps the
// geometry (cols × rows) to whatever fits the small container. A 12px font in
// a ~330×230 box yields roughly a 40×14 grid — a genuine, compact terminal
// window. Glyphs are rendered at native 12px (crisp on every screen, sharp on
// HiDPI — no transform blur), and xterm pins the viewport to the BOTTOM of the
// buffer, so the ~14 rows on screen are always the agent's freshest output —
// the active content region fills the pane. No empty void, no sliver.
//
// PERFORMANCE. This component only ever mounts for the ONE hovered tile (the
// parent gates it on hover state), so exactly one WebSocket is open at a time;
// unmounting on hover-leave tears the WS down via <LiveTerminal>'s effect
// cleanup (`useLiveTerm` close path). No live terminals for un-hovered tiles.

/** Native xterm font size (px) for the hover-zoom embed. Small enough that the
 *  tile-sized box holds ~14 rows of context, large enough to stay crisply
 *  legible at a glance — and rendered at native size (NOT CSS-scaled), so it
 *  never blurs. The FitAddon derives cols × rows from the container. */
const ZOOM_FONT_SIZE = 12

export interface TileLiveTerminalProps {
  /** Session name → the M4 WS route `/ws/sessions/:name`. */
  name: string
  /** Tile content width in px — retained for API stability; the terminal now
   *  fits itself to the container so this is informational only. */
  width?: number
  /** Fires the first time the underlying WS delivers real pty bytes. The tile
   *  uses this to crossfade this surface in OVER the static ANSI preview — the
   *  static preview stays visible until then, so the tile never flashes a
   *  blank-black void during the WS handshake (peek crossfade polish). */
  onFirstFrame?: () => void
  /** Type-on-hover: capture the imperative handle (`send`/`sendKey`) so the
   *  parent's document-level keydown listener can pipe keystrokes through the
   *  existing M13 wire. The terminal stays `readOnly` (no DOM-level stdin, no
   *  global-banner registration, no xterm focus surprises) — the new
   *  `allowProgrammaticInput` flag lets the parent send anyway. */
  onReady?: (term: UseLiveTermResult) => void
}

/** A live terminal rendered at native font size and fitted to the tile preview
 *  box — a small but genuinely legible window onto the agent's pty, latest
 *  output pinned to view. Mount = open WS; unmount = close WS (the parent
 *  gates it on hover).
 *
 *  Stays `readOnly` so xterm's own stdin/tabindex/banner-registration paths
 *  stay disabled. When the parent wires `onReady`, the M13
 *  `allowProgrammaticInput` flag opens the `send`/`sendKey` imperative surface
 *  for the type-on-hover keydown listener WITHOUT changing any of the other
 *  readOnly side-effects (Steve-Jobs bar: change one thing at a time). The
 *  parent ALSO uses the polish-pass `onFirstFrame` callback to crossfade this
 *  surface in over the static ANSI preview — both signals coexist. */
export function TileLiveTerminal({ name, onFirstFrame, onReady }: TileLiveTerminalProps) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden bg-[var(--terminal-bg)]"
    >
      <LiveTerminal
        name={name}
        readOnly
        allowProgrammaticInput
        fontSize={ZOOM_FONT_SIZE}
        className="rounded-none"
        onFirstFrame={onFirstFrame}
        onReady={onReady}
      />
    </div>
  )
}
