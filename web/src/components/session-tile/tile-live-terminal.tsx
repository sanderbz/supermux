import { LiveTerminal } from '@/components/terminal/live-terminal'

// The hover-zoom live terminal — overview tile preview feature, behaviour #2.
//
// On hover, a tile swaps its static tail for a scaled-down LIVE terminal: the
// agent's REAL pty, real ANSI colours, updating live, "the full window but
// smaller — readable at a glance" (the user's exact ask). It REUSES the M13
// <LiveTerminal> verbatim (read-only embed: no keystrokes) — xterm is not
// reimplemented.
//
// HOW THE ZOOM WORKS. xterm sizes to its container, so a tile-sized container
// would give a tiny cropped pane, not "the full window smaller". Instead we
// render the terminal at a FULL-WINDOW geometry (`NATIVE_W × NATIVE_H`, ~96
// cols) inside an off-tile box, then CSS-`transform: scale()` that whole box
// down to the tile width. The result: every row/col of the agent's window,
// shrunk uniformly — crisp on a HiDPI screen, no reflow of xterm itself.
//
// PERFORMANCE. This component only ever mounts for the ONE hovered tile (the
// parent gates it on hover state), so exactly one WebSocket is open at a time;
// unmounting on hover-leave tears the WS down via <LiveTerminal>'s effect
// cleanup (`useLiveTerm` close path). No live terminals for un-hovered tiles.

/** Native render geometry — a comfortable "full window" (~96×30 at fontSize 13
 *  / lineHeight 1.2). The terminal renders at this size, then scales to fit. */
const NATIVE_W = 760
const NATIVE_H = 300

export interface TileLiveTerminalProps {
  /** Session name → the M4 WS route `/ws/sessions/:name`. */
  name: string
  /** Tile content width in px — the scale target. */
  width: number
}

/** A live, read-only terminal rendered at full-window geometry and scaled down
 *  to `width`. Fills its parent (which owns the height + clipping). Mount = open
 *  WS; unmount = close WS (the parent gates it on hover). */
export function TileLiveTerminal({ name, width }: TileLiveTerminalProps) {
  // Uniform scale so the whole window shrinks to the tile width. Clamped so a
  // very wide tile never up-scales past native (which would just blur).
  const scale = width > 0 ? Math.min(width / NATIVE_W, 1) : 0.36

  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden bg-[var(--terminal-bg)]"
    >
      {/* Bottom-anchored: the freshest pty rows (bottom of the window) stay in
          view; older rows scroll off the top behind the tail-fade mask. */}
      <div
        className="absolute bottom-0 left-0"
        style={{
          width: NATIVE_W,
          height: NATIVE_H,
          transform: `scale(${scale})`,
          transformOrigin: 'bottom left',
        }}
      >
        {/* read-only: no keystrokes, and the WS is NOT registered with the
            global connection store (its hover-blips shouldn't drive the
            app-wide reconnect banner). */}
        <LiveTerminal name={name} readOnly className="rounded-none" />
      </div>
    </div>
  )
}
