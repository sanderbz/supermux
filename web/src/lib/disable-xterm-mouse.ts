import type { Terminal } from '@xterm/xterm'

/** xterm DECSET/DECRST private modes that turn on mouse tracking. Enabling ANY of
 *  these flips `coreMouseService.areMouseEventsActive = true`, which (a) gates
 *  xterm's OWN one-finger touch-scroll — its touchstart/touchmove listeners
 *  early-return while mouse events are active — and (b) turns a desktop drag into
 *  a mouse report sent to the pty instead of a browser text selection. */
const MOUSE_TRACKING_MODES = new Set([1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016])

/**
 * Stop an xterm Terminal from EVER entering mouse-tracking mode, regardless of
 * what the attached program emits.
 *
 * supermux is driven entirely through the web terminal — taps and drags ARE how
 * you scroll and select — so an app holding the mouse is worthless here and
 * actively breaks the two primary interactions. We tried disabling it at the
 * source (`CLAUDE_CODE_DISABLE_MOUSE=1`, server sessions/lifecycle.rs), but
 * Claude Code 2.1.156 IGNORES that env var and still emits ?1000h/?1002h/?1003h/
 * ?1006h continuously (verified in the live pty stream). So we neutralize it on
 * the CLIENT: a parser CSI handler swallows the mouse-tracking set/reset
 * sequences before xterm's coreMouseService can act on them. Returning `true`
 * marks the sequence handled so xterm's built-in mode handler never runs; every
 * OTHER private mode (focus reporting ?1004, bracketed paste ?2004, alt-screen,
 * synchronized output ?2026, …) falls through untouched (`false`).
 *
 * Must be called once, right after `new Terminal()`, before any pty bytes are
 * written — registering after a `?1000h` has already been parsed would be too
 * late for that sequence.
 */
export function disableXtermMouseTracking(term: Terminal): void {
  const swallowIfMouseMode = (params: (number | number[])[]): boolean => {
    // Claude — and every TUI we've observed — emits these ONE mode per CSI, so a
    // single numeric param is the only shape we swallow. A batched DECSET that
    // mixes a mouse mode with anything else falls through to xterm untouched, so
    // we can never eat a non-mouse mode by accident.
    if (params.length !== 1) return false
    const mode = params[0]
    return typeof mode === 'number' && MOUSE_TRACKING_MODES.has(mode)
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, swallowIfMouseMode)
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, swallowIfMouseMode)
}
