// useLiveTerm — M13. The live terminal hook (TECH_PLAN §4.5, §5.2).
//
// Drives an xterm.js Terminal bound to the M4 WebSocket pty stream:
//   • Renders replay + live pty bytes (binary frames → term.write).
//   • Sends user keystrokes back (term.onData → {type:'input'} text frames).
//   • Resizes via FitAddon + a debounced ResizeObserver, telling the server the
//     new {cols,rows} so the pty geometry tracks the viewport.
//   • Reconnects with exponential backoff + decorrelated jitter, honouring the
//     v2 close-code semantics (§4.5).
//
// PRINCIPLE: WebSocket-ONLY. There is no polling here — bytes arrive over the WS
// the M4 backend already fans out. The auth token is NEVER put in the URL
// (Codex #7): we connect token-less and send {type:'auth',token} as the first
// frame, then wait for {type:'auth_ok'} before declaring ourselves `live`. The
// token is read from `window._SUPERMUX_AUTH_TOKEN` at runtime (env.ts) — never
// embedded in source.

import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

import { authToken, wsUrl } from '@/env'
import { claim as claimPrewarm } from '@/hooks/peek-prewarm-store'

// `stopped` is TERMINAL and distinct from `offline`: the server told us the
// session's pty is gone (not running) — there is nothing to reconnect to, so we
// do NOT retry. `offline` means we exhausted retries / were rejected and a
// manual "Tap to retry" still makes sense.
export type LiveTermState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'stopped'

export interface UseLiveTermResult {
  containerRef: React.RefObject<HTMLDivElement | null>
  state: LiveTermState
  /** True once the FIRST real pty data frame has been written to xterm (auth_ok
   *  alone doesn't count — a `stopped` session can connect + auth + immediately
   *  close with zero bytes). The overview hover-zoom uses this to keep the
   *  static ANSI preview visible UNTIL the live terminal has actual content,
   *  then crossfade — no blank-black-void flicker (peek crossfade polish). */
  hasFirstFrame: boolean
  /** True once the replay snapshot has finished streaming and the viewport has
   *  been pinned to the bottom — i.e. it's safe to REVEAL the terminal already
   *  at the bottom. While false the terminal is covered (opacity-0) so the user
   *  never sees the replay history visibly scroll from top to bottom on open
   *  (the scroll-on-open jank). Flips true on the server's `{"type":"replay_done"}`
   *  control frame, or — for an old server that doesn't send it — a short
   *  fallback timeout after the first frame. Reset to false on reconnect. */
  ready: boolean
  /** Send literal text to the pty (e.g. a pasted snippet, a slash command). */
  send(text: string): void
  /** Send a named key (Up/Down/Left/Right/PageUp/Enter/…) — see §4.4 gestures. */
  sendKey(name: string): void
  /** Force a fit + resize round-trip (callers rarely need this — the
   *  ResizeObserver handles it — but the dock/joystick may after a layout flip). */
  resize(cols: number, rows: number): void
  /** Copy the whole scrollback buffer to the clipboard. */
  copyAll(): void
  /** Manual retry for the permanent (`offline`) state — "Tap to retry" (§4.12). */
  retry(): void
  /** Programmatically focus xterm's input. The focus route calls this on mount
   *  so keystrokes go to the terminal IMMEDIATELY — no second click required. */
  focus(): void
  /** Blur xterm's input — dismisses the mobile soft keyboard (the "hide
   *  keyboard" affordance / tap-away). No-op on desktop where there is no
   *  on-screen keyboard to dismiss. */
  blur(): void
  /** True when the user has scrolled the viewport up from the live bottom by
   *  more than a few rows — drives the in-terminal "jump to bottom" button.
   *  False while pinned to the bottom (the normal follow-output state). */
  scrolledUp: boolean
  /** Pin the viewport back to the live bottom (resume following output) and
   *  re-focus the input. Wired to the "jump to bottom" button (SD-2). */
  scrollToBottom(): void
}

// ── Tunables (TECH_PLAN §4.5) ─────────────────────────────────────────────────
const BASE_BACKOFF_MS = 300
const MAX_BACKOFF_MS = 30_000
const MAX_ATTEMPTS = 6 // 1011 server-error path then permanent
const RESIZE_DEBOUNCE_MS = 100
const VISIBILITY_DEBOUNCE_MS = 2_000
const AUTH_GRACE_MS = 4_000 // server allots 2s for the first frame; we give slack
// Fallback for an OLD server that doesn't emit `{"type":"replay_done"}`: if no
// such control frame arrives within this window AFTER the first pty byte, we
// reveal anyway (scroll-to-bottom first) so the terminal is never stuck hidden.
// Kept short — long enough to swallow the replay-scroll on a healthy server,
// short enough that a legacy server's reveal still feels instant.
const REPLAY_DONE_FALLBACK_MS = 400
// Soft-keyboard detection threshold (px of visualViewport inset). Mirrors
// `useKeyboardViewport`'s 80px floor so the live-render kick agrees with the
// route's keyboard-open state; below this, iOS jitter (URL-bar collapse,
// rubber-band) must not flip us into the kick path.
const KEYBOARD_OPEN_THRESHOLD = 80
// SD-2: how many pixels above the live bottom the viewport must sit before the
// "jump to bottom" affordance appears. A small slack so sub-pixel rounding at the
// bottom (or a 1-notch rubber-band) never flickers the button on; scrolling up
// "a bit" (~a row or two) does. Measured on `.xterm-viewport.scrollTop`.
const SCROLL_TO_BOTTOM_SLACK_PX = 24

// Close codes with explicit v2 semantics (§4.5).
const CLOSE_AUTH = 1008 // auth/origin reject — permanent
const CLOSE_SERVER = 1011 // server error — backoff, then permanent
const CLOSE_TOO_SLOW = 1013 // subscriber overflow — silent reconnect on visible
const CLOSE_REVOKED = 4001 // explicit token revocation — permanent
const CLOSE_NOT_RUNNING = 4404 // session's pty is gone — TERMINAL, do NOT retry
const CLOSE_UNMOUNT = 1000 // normal — our own teardown

/** The supermux 16-colour ANSI palette. Mirrors the static preview palette in
 *  `web/src/lib/ansi.ts` byte-for-byte so the live xterm renders agent output
 *  (zsh prompts, `ls --color`, `git status`) with the SAME colours as the tile
 *  preview — no jarring shift when a session expands from card → live. Tuned
 *  for legibility on the near-black `--terminal-bg` (One Dark-ish family,
 *  iOS-native saturation). */
const ANSI_PALETTE = {
  black: '#1d1d1f',
  red: '#ff6b5e',
  green: '#3fc66b',
  yellow: '#e0c050',
  blue: '#5b9dff',
  magenta: '#c678dd',
  cyan: '#56c8d8',
  white: '#c8c8cd',
  brightBlack: '#6b6b70',
  brightRed: '#ff8a80',
  brightGreen: '#69d98b',
  brightYellow: '#f0d272',
  brightBlue: '#82b6ff',
  brightMagenta: '#d99ae8',
  brightCyan: '#7adfeb',
  brightWhite: '#f5f5f7',
} as const

/** Read the live terminal theme from the CSS custom properties (§4.5). This runs
 *  at mount so the terminal tracks whichever theme `<ThemeProvider>` applied to
 *  <html> before first paint — no hardcoded hex for bg/fg (Termius criterion
 *  #15). The 16-colour ANSI palette IS hardcoded: those bytes ARE the terminal's
 *  colours (an agent's SGR escapes), not app chrome, and must stay constant
 *  across themes. */
function themeFromCss(): import('@xterm/xterm').ITheme {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback
  const bg = read('--terminal-bg', '#000000')
  const fg = read('--terminal-fg', '#e5e5e7')
  return {
    // OLED-true terminal surface matching the design tokens (globals.css).
    background: bg,
    foreground: fg,
    cursor: fg,
    // Block-cursor fg: punch through to the surface so the glyph under the
    // cursor stays legible against the cursor fill.
    cursorAccent: bg,
    // Selection: translucent brand-blue so highlights stay readable on both
    // light + dark surfaces (xterm composites this over cell bg).
    selectionBackground: 'rgba(91, 157, 255, 0.35)',
    selectionInactiveBackground: 'rgba(91, 157, 255, 0.20)',
    ...ANSI_PALETTE,
  }
}

/** Map a named key to the literal control bytes the pty expects. Keeps the
 *  `{type:'input'}` wire shape (§5.2) — the M4 backend forwards input verbatim
 *  via `tmux send-keys -l`, so we resolve the byte sequence client-side. Used by
 *  the dock send-row + the joystick (M14/M15/M17) through `sendKey`. */
function keyToBytes(name: string): string {
  switch (name) {
    case 'Up':
      return '\x1b[A'
    case 'Down':
      return '\x1b[B'
    case 'Right':
      return '\x1b[C'
    case 'Left':
      return '\x1b[D'
    case 'Enter':
    case 'Return':
      return '\r'
    case 'Tab':
      return '\t'
    case 'BackTab':
    case 'ShiftTab':
      // CSI Z — terminfo `kcbt`. The standard back-tab sequence agents (claude,
      // gum, fzf, …) recognise for menu navigation in the reverse direction.
      return '\x1b[Z'
    case 'Esc':
    case 'Escape':
      return '\x1b'
    case 'EscEsc':
      // Two Escapes back-to-back — Claude Code's "rewind / edit previous"
      // power move. Double-tapping Esc precisely is awful on a touch keyboard,
      // so the quick-keys chip emits both bytes in one send (kept as a named
      // key so it routes through the SAME `sendKey` → `keyToBytes` wire).
      return '\x1b\x1b'
    case 'Newline':
      // A literal newline (LF, Ctrl+J) — inserts a line break in Claude Code's
      // prompt WITHOUT submitting (Enter = `\r` submits; LF = `\x0a` does not).
      // Verified against Claude Code v2.1.150 via `tmux send-keys C-j`: the
      // prompt grew a second line and held the buffer. There is no Shift+Enter
      // byte over a pty — Shift is a modifier the terminal can't encode for
      // Enter — so the soft keyboard literally cannot produce this; the chip is
      // the only way to compose a multi-line prompt on mobile.
      return '\x0a'
    case 'Backspace':
      return '\x7f'
    case 'PageUp':
      return '\x1b[5~'
    case 'PageDown':
      return '\x1b[6~'
    case 'Home':
      return '\x1b[H'
    case 'End':
      return '\x1b[F'
    case 'Ctrl-C':
      return '\x03'
    case 'Ctrl-U':
      return '\x15'
    case 'Ctrl-D':
      return '\x04'
    case 'Ctrl-Z':
      return '\x1a'
    case 'Ctrl-L':
      return '\x0c'
    case 'Ctrl-A':
      return '\x01'
    case 'Ctrl-E':
      return '\x05'
    case 'Ctrl-R':
      return '\x12'
    case 'Ctrl-G':
      // BEL (0x07) — the byte Ctrl+G sends. Claude Code binds its built-in
      // `chat:externalEditor` action to Ctrl+G: it writes the current input
      // buffer to a temp file, spawns $EDITOR (the supermux bridge), and reads
      // the result back. The "Edit in native editor" affordance taps this.
      return '\x07'
    default:
      // Single-char or already-literal text falls through unchanged.
      return name
  }
}

/** Exponential backoff with ±20% decorrelated jitter, from the FIRST retry
 *  (Eng P1 #5 — avoids the reconnect-storm during a Tailscale server restart).
 *  Formula per §4.5: delay = base*2^n; jittered = delay/2 + random(delay). */
function backoffDelay(attempt: number): number {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return delay / 2 + Math.random() * delay
}

export function useLiveTerm(
  name: string,
  opts?: {
    readOnly?: boolean
    fontSize?: number
    /** Allow imperative `send` / `sendKey` even when `readOnly` is true. The
     *  type-on-hover peek (overview live-zoom) sets this so its document-level
     *  keydown handler can pipe keystrokes through the existing M13 wire while
     *  keeping the xterm DOM stdin disabled (no focus surprises, no global
     *  reconnect-banner subscription). Without this flag `send`/`sendKey` are
     *  silenced for readOnly embeds — the original M11 contract. */
    allowProgrammaticInput?: boolean
    /** Pre-warm fast-path: when true, the mount effect first attempts to adopt
     *  an already-open, already-authed WS + buffered bytes from the peek-
     *  prewarm registry (`peek-prewarm-store`) — so the overview hover-zoom
     *  hydrates INSTANTLY instead of waiting for a fresh M4 handshake +
     *  first-frame round-trip. Falls back to normal connect if no pre-warm
     *  exists (cap was full, tile only just became visible, etc.). Off by
     *  default so the focus terminal + quick-peek modal keep their existing
     *  single-WS lifecycle. */
    prewarmSeed?: boolean
    /** Fires ONCE per (re)connection the moment the replay has SETTLED — i.e.
     *  the snapshot finished streaming AND the viewport was pinned to the bottom
     *  (the same instant `ready` flips true: `replay_done`, the short fallback,
     *  or the prewarm-adopt hydrate). Distinct from `onFirstFrame` (the FIRST
     *  raw pty byte, mid-fill). The overview hover-peek gates its static→live
     *  crossfade on THIS so the live content is coherent when it fades in (no
     *  fill-in flicker). Kept separate from the imperative-handle `onReady` so
     *  callers can subscribe to "settled" without re-receiving the whole handle.
     *  No delay: it fires as soon as the replay is in — same tick as `ready`. */
    onSettled?: () => void
    /** Override the WebSocket path the terminal connects to. Defaults to the
     *  session route `/ws/sessions/{name}`. The Agent Teams teammate terminal
     *  (AT-F2) passes the read-only teammate route
     *  `/ws/teams/{team}/{member}[?pane_id=%id]` here — the handshake / replay /
     *  close-code contract is byte-for-byte identical (AT-E), so the ENTIRE WS
     *  client machinery (auth-first, replay_done reveal, backoff, 4404 stop,
     *  1013 backoff) is reused verbatim; only the URL changes. The path must
     *  already be query-encoded by the caller. When omitted the historical
     *  session path is used unchanged. */
    wsPath?: string
  },
): UseLiveTermResult {
  const readOnly = opts?.readOnly ?? false
  const allowProgrammaticInput = opts?.allowProgrammaticInput ?? false
  // The overview hover-zoom embed renders fewer, larger rows so the shrunk pane
  // stays legible at a glance (it passes an explicit fontSize). The focus
  // terminal and quick-peek omit it and keep the M13 default.
  const fontSize = opts?.fontSize ?? 13
  // When true, the mount effect first attempts to adopt an already-open,
  // already-authed WS + buffered bytes from the peek-prewarm registry — so the
  // overview hover-zoom hydrates INSTANTLY instead of waiting for a fresh M4
  // handshake + first-frame round-trip. Falls back to normal connect if no
  // pre-warm exists (cap was full, tile only just became visible, etc.). Off
  // by default so the focus terminal + quick-peek modal keep their existing
  // single-WS lifecycle.
  const prewarmSeed = opts?.prewarmSeed ?? false
  // Optional WS path override (AT-F2 teammate route). Read once into the mount
  // effect's deps so changing it (e.g. switching teammate inside a strip)
  // re-subscribes to the new pane, exactly like changing `name`.
  const wsPath = opts?.wsPath

  // Keep the latest `onSettled` in a ref so the single mount effect (which owns
  // the whole WS lifecycle and must NOT re-subscribe on every render) always
  // calls the current callback without it living in the effect deps. Written in
  // an effect (not during render) per the react-hooks/refs rule.
  const onSettled = opts?.onSettled
  const onSettledRef = React.useRef(onSettled)
  React.useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const wsRef = React.useRef<WebSocket | null>(null)

  const [state, setState] = React.useState<LiveTermState>('connecting')
  const stateRef = React.useRef<LiveTermState>('connecting')
  const setLiveState = React.useCallback((s: LiveTermState) => {
    stateRef.current = s
    setState(s)
  }, [])

  // SD-2: whether the viewport is scrolled up from the live bottom. The ref is
  // the hot-path latch the per-scroll handler compares against (no setState on
  // an unchanged value); the state drives the React render of the button.
  const [scrolledUp, setScrolledUp] = React.useState(false)
  const scrolledUpRef = React.useRef(false)

  // Flips true the first time the WS delivers REAL pty bytes — distinct from
  // `state==='live'` (which only proves auth_ok arrived). A `stopped` session
  // can auth-ok then immediately close with zero bytes, so the overview
  // hover-zoom uses THIS signal to gate its crossfade (no blank-black flicker).
  const [hasFirstFrame, setHasFirstFrame] = React.useState(false)
  const hasFirstFrameRef = React.useRef(false)

  // `ready` gates the cover-until-bottom reveal: while false the terminal is
  // visually hidden (opacity-0) so the user never sees the replay snapshot
  // scroll from top → bottom on open. Flips true on the server's `replay_done`
  // control frame (or a short fallback timeout for an old server), AFTER a
  // `scrollToBottom()` so the reveal lands already pinned to the bottom. Reset
  // to false on every (re)connect so a reconnect re-covers + re-pins.
  const [ready, setReady] = React.useState(false)
  const readyRef = React.useRef(false)
  // Fallback timer armed on the first pty byte; cleared once `ready` flips.
  const readyFallbackTimerRef = React.useRef<number | null>(null)

  // Mutable connection bookkeeping kept in refs so the single mount effect owns
  // the whole lifecycle (no re-subscribe churn on re-render).
  const attemptRef = React.useRef(0)
  const authedRef = React.useRef(false)
  const reconnectTimerRef = React.useRef<number | null>(null)
  const visibilityPendingRef = React.useRef(false) // 1013 → wait for visible
  const lastVisibleAtRef = React.useRef(0)
  const disposedRef = React.useRef(false)
  // True while the mobile soft keyboard is open (visualViewport shrunk past the
  // threshold). Drives the live-render kick below: see the binary-frame branch.
  const keyboardOpenRef = React.useRef(false)
  // `connectRef` lets the close handler call the latest `connect` without
  // recreating the effect; assigned once below.
  const connectRef = React.useRef<() => void>(() => {})

  // ── Imperative API (stable refs; the dock/joystick call these) ──────────────
  const sendRaw = React.useCallback((data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && authedRef.current) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  }, [])

  const send = React.useCallback(
    (text: string) => {
      if (readOnly && !allowProgrammaticInput) return
      sendRaw(text)
    },
    [readOnly, allowProgrammaticInput, sendRaw],
  )

  const sendKey = React.useCallback(
    (key: string) => {
      if (readOnly && !allowProgrammaticInput) return
      sendRaw(keyToBytes(key))
    },
    [readOnly, allowProgrammaticInput, sendRaw],
  )

  const resize = React.useCallback((cols: number, rows: number) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && authedRef.current) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  const copyAll = React.useCallback(() => {
    const term = termRef.current
    if (!term) return
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    const text = lines.join('\n').replace(/\n+$/, '\n')
    void navigator.clipboard?.writeText(text)
  }, [])

  const retry = React.useCallback(() => {
    if (disposedRef.current) return
    attemptRef.current = 0
    visibilityPendingRef.current = false
    setLiveState('connecting')
    connectRef.current()
  }, [setLiveState])

  /** Programmatically focus xterm's input. Called from the focus route on mount
   *  so keystrokes flow to the terminal IMMEDIATELY — no second click. Safe to
   *  call before the terminal is mounted (no-op until then). */
  const focus = React.useCallback(() => {
    termRef.current?.focus()
  }, [])

  /** Blur xterm's hidden helper textarea so the iOS soft keyboard dismisses.
   *  `term.blur()` is the public xterm API; we also blur the active element as a
   *  belt-and-suspenders for engines where the helper textarea kept focus. */
  const blur = React.useCallback(() => {
    termRef.current?.blur()
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  }, [])

  /** SD-2: pin the viewport back to the live bottom and resume following output.
   *  The button's onClick. We flip `scrolledUp` off eagerly (the `onScroll` the
   *  scroll triggers would do it too, but eagerly hides the button on the same
   *  frame as the tap) and re-focus the input so typing resumes for a read-write
   *  terminal. */
  const scrollToBottom = React.useCallback(() => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    scrolledUpRef.current = false
    setScrolledUp(false)
    // Re-focus the input so typing resumes — but ONLY on a fine pointer
    // (desktop). On touch, focusing xterm's hidden textarea pops the on-screen
    // keyboard, which is jarring when the user merely tapped "jump to bottom" to
    // follow output (and made the tap feel like it did the wrong thing). A button
    // should never steal text-input focus on touch.
    const finePointer =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(pointer: fine)').matches
    if (!readOnly && finePointer) {
      try {
        term.focus()
      } catch {
        /* disposed mid-tap — harmless */
      }
    }
  }, [readOnly])

  // ── Single mount effect: owns the terminal + WS lifecycle ───────────────────
  React.useEffect(() => {
    disposedRef.current = false
    const container = containerRef.current
    if (!container) return

    // 1. Terminal + addons (§4.5). Canvas renderer for desktop perf; FitAddon
    //    snaps the geometry to the container; WebLinks makes URLs clickable.
    const term = new Terminal({
      // Lead with the self-hosted Nerd Font (see globals.css @font-face +
      // /fonts/NOTICE.md): shell prompts and TUIs ship Powerline / Nerd
      // Font icons that render as missing-glyph squares without it. SF Mono
      // / Menlo remain as the first-paint and worst-case fallback chain.
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize,
      lineHeight: 1.2,
      theme: themeFromCss(),
      allowTransparency: false,
      // Steady (non-blinking) block cursor: a blink forces a periodic renderer
      // wake even when idle (mobile battery + needless idle repaints). A solid
      // cursor reads as more native/snappy (Termius / iTerm default-feel).
      cursorBlink: false,
      // Large scrollback so the client never truncates the history the server
      // replays on connect (replay ring is ≤512 KB ≈ several thousand lines) or
      // that tmux retains (history-limit = 50000). Kept at/above the tmux limit
      // so scroll-up reaches as far back as the session actually has. xterm.js
      // stores lines compactly; 50k lines is a modest memory cost per terminal.
      scrollback: 50000,
      disableStdin: readOnly,
      // ⌥-drag forces a LOCAL text selection even while the program holds the
      // mouse (DECSET ?1000/?1002 — Claude Code's TUI, and tmux `mouse on`,
      // almost always do). Without this, macOS xterm has NO modifier to bypass
      // mouse reporting, so a plain drag is forwarded to the pty (tmux grabs it →
      // "copied … to tmux buffer") and the user can't select+copy in the browser.
      // With it, ⌥-drag selects locally (xterm does NOT forward those events), so
      // the ⌘C handler below copies it. Plain drag is unchanged → the agent still
      // gets its mouse events. (Linux/Windows already get Shift-drag by default;
      // this option only affects macOS.)
      macOptionClickForcesSelection: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // SD-2: track whether the viewport is scrolled up so the wrapper can show a
    // "jump to bottom" button. We read the REAL scroll position off the
    // `.xterm-viewport` element's native scroll event — xterm's public `onScroll`
    // only reports buffer GROWTH (output advancing ybase), not the user navigating
    // back through existing scrollback, which is exactly the gesture we must catch.
    // "At the bottom" = within a row or two of the max scroll; output that follows
    // the bottom keeps scrollTop pinned there (no button), scrolling up opens the
    // gap. Start fresh each (re)subscribe so a prior session's state never leaks.
    scrolledUpRef.current = false
    setScrolledUp(false)
    const viewportEl = container.querySelector<HTMLElement>('.xterm-viewport')
    const syncScrolledUp = () => {
      if (!viewportEl) return
      const distFromBottom =
        viewportEl.scrollHeight - viewportEl.clientHeight - viewportEl.scrollTop
      const up = distFromBottom > SCROLL_TO_BOTTOM_SLACK_PX
      if (up !== scrolledUpRef.current) {
        scrolledUpRef.current = up
        setScrolledUp(up)
      }
    }
    viewportEl?.addEventListener('scroll', syncScrolledUp, { passive: true })

    // ── Single-finger touch scroll-back while the agent holds the mouse ──────────
    // xterm's OWN touch listeners (registered in Terminal.ts, NOT in
    // Viewport.handleTouchMove) early-return whenever the program has mouse
    // reporting ON (`coreMouseService.areMouseEventsActive` — Claude Code's TUI
    // almost always does), DROPPING the touch (a bare `return`; it is NOT
    // translated into a mouse report) instead of panning the scrollback. So on
    // mobile a one-finger drag can't reach
    // history while an agent is attached (wheel + 2-finger use other paths, hence
    // they still work — the exact reported symptom). We restore it: while mouse
    // reporting is ON and we're in the NORMAL buffer (the only one with scrollback),
    // a one-finger vertical drag scrolls via `term.scrollLines()` — xterm's public
    // scroll API. We deliberately use it instead of a raw `viewport.scrollTop +=
    // dy` for three reasons: (1) it's line-granular via the accumulator below, so
    // it never leaves a fractional-line scrollTop that xterm's `syncScrollArea`
    // immediately snaps back — the jitter a raw per-pixel scrollTop produced; (2)
    // it drives the renderer repaint directly through xterm's scroll pipeline
    // (BufferService.scrollLines → onScroll → renderRows) instead of leaning on
    // xterm's internal viewport 'scroll'-event bounce; (3) it's public API, so it
    // survives xterm 6.x's viewport rewrite. (The earlier reverted attempt 7723be1
    // was backed out for janky iOS *feel* — overriding the native pan, see 9c7657d
    // — NOT a repaint failure; both scrollLines and raw scrollTop repaint. This
    // path is still line-granular with no momentum, so the on-device feel is the
    // thing to keep watching.) A pixel accumulator gives whole-line
    // granularity. We claim the gesture (preventDefault + stopPropagation) ONLY once
    // we actually scroll, so a tap still reaches the agent as a click and a STILL
    // hold still arms the long-press joystick. When mouse reporting is OFF, this is
    // inert and xterm's own native touch-scroll handles it (unchanged).
    const screenEl = container.querySelector<HTMLElement>('.xterm-screen')
    let touchLastY: number | null = null
    let touchAccumPx = 0
    const cellHeightPx = () => {
      const rows = term.rows || 24
      return (viewportEl?.clientHeight ?? rows * 16) / rows
    }
    const wantsTouchScroll = () =>
      term.modes.mouseTrackingMode !== 'none' &&
      term.buffer.active.type === 'normal'
    const onScreenTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1 && wantsTouchScroll()) {
        touchLastY = e.touches[0].clientY
        touchAccumPx = 0
      } else {
        touchLastY = null
      }
    }
    const onScreenTouchMove = (e: TouchEvent) => {
      if (touchLastY === null || e.touches.length !== 1 || !wantsTouchScroll()) return
      // CLAIM THE GESTURE ON THE FIRST MOVE — not only once we've crossed a full
      // cell. On iOS WebKit a touch gesture's nature (scroll vs. handled) is decided
      // on the FIRST touchmove: if we don't preventDefault now, the event turns
      // non-cancelable and our later preventDefault is silently ignored, so the
      // scroll dies and the finger does nothing (the real-device bug). We pair this
      // with `touch-action: pan-y` on `.xterm-screen` (globals.css) so iOS routes a
      // vertical one-finger pan to THIS handler instead of committing it elsewhere
      // (the Vaul sheet / nothing) on frame one. The cell accumulator below now
      // only governs HOW MANY lines to scroll, not whether we own the gesture.
      if (e.cancelable) e.preventDefault()
      e.stopPropagation()
      const y = e.touches[0].clientY
      // Finger UP (y decreases) → scroll DOWN (positive lines); finger DOWN → up.
      touchAccumPx += touchLastY - y
      touchLastY = y
      const h = cellHeightPx()
      if (h > 0 && Math.abs(touchAccumPx) >= h) {
        const lines = Math.trunc(touchAccumPx / h)
        term.scrollLines(lines)
        touchAccumPx -= lines * h
      }
    }
    const onScreenTouchEnd = () => {
      touchLastY = null
      touchAccumPx = 0
    }
    screenEl?.addEventListener('touchstart', onScreenTouchStart, { passive: true })
    screenEl?.addEventListener('touchmove', onScreenTouchMove, { passive: false })
    screenEl?.addEventListener('touchend', onScreenTouchEnd, { passive: true })
    screenEl?.addEventListener('touchcancel', onScreenTouchEnd, { passive: true })

    // De-decorate xterm's hidden capture textarea so iOS Safari / WKWebView does
    // NOT draw its autofill / suggestion / "Done" accessory strip above the
    // keyboard (which read as a SECOND toolbar stacked over our dock). xterm owns
    // this `.xterm-helper-textarea` (it creates exactly one real <textarea> for
    // keystroke/IME capture), so we set the iOS-neutralizing attributes on it
    // here, once, right after `term.open()` has materialized it in the container.
    // The "< >" field-nav arrows are OS-drawn for ANY focused field and cannot be
    // removed via attributes — see the mobile-toolbars investigation (residual).
    const helper = container.querySelector<HTMLTextAreaElement>(
      '.xterm-helper-textarea',
    )
    if (helper) {
      helper.setAttribute('autocapitalize', 'off')
      helper.setAttribute('autocorrect', 'off')
      helper.setAttribute('autocomplete', 'off')
      helper.spellcheck = false
      helper.setAttribute('enterkeyhint', 'send')
    }

    // A GPU/canvas renderer needs the renderer's char dimensions to exist, which
    // only happens once the container has a real layout box. Loading eagerly on a
    // zero-size container (or one that resizes before first paint) throws
    // "Cannot read properties of undefined (reading 'dimensions')". So we defer:
    // wait a frame (now the box is laid out), perform the first fit, attach the
    // GPU renderer, then re-fit. xterm's DOM renderer covers the gap before this.
    //
    // DESKTOP-OPEN FIX (no mobile-width flash). The fit + the GPU-renderer attach
    // happen in ONE rAF, so the terminal's FINAL geometry is committed before the
    // browser paints the frame — there is no intermediate paint at the wrong cols.
    //
    //   ROOT CAUSE (measured via chrome-devtools on open — proposeDimensions()
    //   logged at each fit). FitAddon derives cols from
    //   `floor(containerWidth / cellWidth)`, and the built-in DOM renderer and the
    //   WebGL renderer measure DIFFERENT cell widths for the SAME font/container
    //   (measured: DOM → 133 cols, WebGL → 138 cols at a 1056px pane). The previous
    //   flow fit ONCE here against the DOM renderer's metrics (→ 133 cols) and
    //   attached the GPU renderer AFTER — so the WebGL renderer then rendered the
    //   133-col grid with its own (narrower) cells, and the LATER async refits (the
    //   font-load re-measure below + the debounced ResizeObserver pass, ~300ms out)
    //   eventually re-fit to the WebGL metrics (→ 138 cols). The terminal therefore
    //   visibly snapped width on open — the desktop-open jank. The container width
    //   itself was correct and constant the whole time (1056px); only the cols/grid
    //   reflowed.
    //
    //   THE FIX. Fit FIRST (the DOM renderer always has valid cell metrics the
    //   instant `term.open()` returns, so this fit lands the correct cols), THEN
    //   attach the GPU renderer, THEN fit AGAIN — all synchronously in this same
    //   rAF, before paint. The second fit absorbs any cell-width delta the
    //   renderer swap introduces in the SAME frame (FitAddon's `fit()` is a no-op
    //   when cols/rows are unchanged, so it costs nothing on the common path where
    //   the GPU cell width matches). Fitting the GPU renderer alone (without the
    //   prior DOM-renderer fit) is NOT enough: right after `loadAddon`, the GPU
    //   renderer's `dimensions.css.cell.width` can still be 0 (it measures on its
    //   first render), and FitAddon bails on a 0 cell — leaving the 80-col default
    //   (≈624px) visible until the ResizeObserver finally fires. The prior fit is
    //   what guarantees a correct first paint.
    //
    // RENDERER STRATEGY (typing-speed win #3). Try the WebGL renderer FIRST —
    // it gives materially faster glyph render / lower paint latency and smoother
    // scroll on desktop + modern mobile. WebGL can fail to construct (no GL
    // context: iOS WKWebView quirks, headless, blocklisted GPUs) OR lose its
    // context later (backgrounded mobile tab, GPU reset). In EITHER case we fall
    // back to the Canvas renderer, which is itself robust and was the previous
    // default. The DOM renderer (xterm built-in) is the final safety net if even
    // Canvas can't construct.
    // Force the ACTIVE renderer to repaint the whole viewport from the buffer.
    // A renderer that is attached (or swapped in) AFTER content already exists
    // does NOT paint that content on its own — it only draws on the next write.
    // For an idle session (no further bytes) that leaves a blank canvas. xterm
    // used to get an incidental repaint from the font-load `clearTextureAtlas()`
    // refit; that refit is now skipped on the warm-font path, so we repaint
    // explicitly here instead. Cheap (one frame) and a no-op on an empty buffer.
    const repaint = () => {
      const t = termRef.current
      if (!t || disposedRef.current || t.rows <= 0) return
      try {
        t.refresh(0, t.rows - 1)
      } catch {
        /* renderer not ready — the next write repaints anyway */
      }
    }
    const loadCanvasFallback = () => {
      if (disposedRef.current) return
      const t = termRef.current
      if (!t || t.cols <= 0 || t.rows <= 0) return
      try {
        t.loadAddon(new CanvasAddon())
        // The freshly-swapped Canvas renderer must repaint the existing buffer;
        // without this an idle pane (no further bytes) stays blank after the
        // WebGL→Canvas swap (e.g. GPU context loss, or WebGL unavailable).
        repaint()
      } catch {
        // Canvas may be unavailable in some headless/WKWebView contexts; the DOM
        // renderer (xterm default) is a safe fallback. Non-fatal.
      }
    }
    const safeFit = () => {
      try {
        fit.fit()
      } catch {
        /* container still 0-size — the ResizeObserver fit covers it */
      }
    }
    const raf = window.requestAnimationFrame(() => {
      if (disposedRef.current) return
      // 1. Fit against the built-in DOM renderer (its cell metrics are valid
      //    immediately) so the correct desktop cols are committed up front.
      safeFit()
      if (term.cols <= 0 || term.rows <= 0) return
      // 2. Attach the GPU renderer.
      try {
        const webgl = new WebglAddon()
        // Context loss (backgrounded tab, GPU reset): dispose the dead WebGL
        // addon and swap to Canvas so we never leave a frozen/blank canvas.
        webgl.onContextLoss(() => {
          try {
            webgl.dispose()
          } catch {
            /* already disposed — harmless */
          }
          loadCanvasFallback()
        })
        term.loadAddon(webgl)
      } catch {
        // WebGL unavailable (no GL context / blocklisted GPU / WKWebView): fall
        // back to the Canvas renderer (the previous default — robust).
        loadCanvasFallback()
      }
      // 3. Re-fit so any cell-width delta the renderer swap introduced is applied
      //    in THIS same rAF, before paint — no intermediate-cols frame is ever
      //    shown. No-op when the GPU cell width matches the DOM renderer's.
      safeFit()
      // 4. Repaint so the just-attached renderer draws whatever is already in the
      //    buffer (the replay snapshot may have arrived before this rAF). Without
      //    this an idle pane can mount blank until the next live byte.
      repaint()
    })

    // Font-ready refit: xterm caches the renderer's character metrics on
    // construction. If the embedded Nerd Font woff2 hasn't finished decoding
    // by then, xterm measures the system fallback (Menlo) — once the Nerd
    // Font swaps in, the real glyphs render at the fallback's cell width,
    // which misaligns the grid. document.fonts.load() resolves as soon as
    // the requested face is ready (or immediately if the browser lacks the
    // CSS Font Loading API); we then call .clearTextureAtlas() so the
    // canvas renderer reflows with the now-loaded metrics + a refit.
    //
    // DESKTOP-OPEN FIX (no mobile-width flash). Only refit when the font was
    // NOT already available at mount. On the common path the Nerd Font is
    // already cached (warm load / second open), so the initial fit above ALREADY
    // measured the correct cell width — re-running `clearTextureAtlas()` + a
    // second `fit()` here would just reflow the grid a SECOND time on first
    // paint (measured as the transient narrow-then-wide snap), for zero metric
    // change. `document.fonts.check()` is synchronous, so we read it once now to
    // decide; if the face is already present we skip the redundant refit and let
    // the single initial fit stand. Only a genuinely-late font (cold first load)
    // takes the re-measure path, where the reflow is correcting real misalignment.
    try {
      const fonts = (document as Document & {
        fonts?: FontFaceSet
      }).fonts
      const faceSpec = `${fontSize}px "JetBrainsMono Nerd Font Mono"`
      const alreadyLoaded = (() => {
        try {
          return fonts?.check?.(faceSpec) ?? false
        } catch {
          return false
        }
      })()
      if (fonts?.load && !alreadyLoaded) {
        void fonts
          .load(faceSpec)
          .then(() => {
            if (disposedRef.current) return
            try {
              // Force xterm to re-measure: clear the renderer's char atlas
              // and refit so cell width tracks the now-loaded font.
              ;(
                term as Terminal & { clearTextureAtlas?: () => void }
              ).clearTextureAtlas?.()
              fit.fit()
            } catch {
              /* non-fatal — first-paint already used the fallback chain */
            }
          })
          .catch(() => {
            /* font not reachable (offline first-paint, blocked) — the
               fallback chain in fontFamily still renders text legibly. */
          })
      }
    } catch {
      /* CSS Font Loading API unsupported — fallback chain handles it. */
    }

    // 2. Local echo path: pipe xterm keystrokes back to the pty (§5.2). The
    //    server echoes them via the broadcast stream, so we do NOT write locally.
    //
    //    PHANTOM-ENTER GUARD (root-cause fix). `term.onData` fires for two very
    //    different kinds of data:
    //      (a) real user input — a keystroke / paste / mouse selection / IME burst,
    //      (b) xterm-synthesized control-sequence responses — focus events
    //          (`\x1b[I`/`\x1b[O` from DECSET ?1004), DSR/CPR cursor reports,
    //          device attribute replies, window-option reports, etc. — fired by
    //          xterm itself in response to PROGRAMMATIC events (e.g. our own
    //          `term.focus()` call from the auto-focus polish, or the parser
    //          seeing a DSR request in the replay stream).
    //
    //    Forwarding (b) to the pty is the source of the "phantom Enter on panel
    //    switch" bug: programmatic focus / mount / route-change causes xterm to
    //    emit a focus/CSI response, which lands at the bash prompt as an unknown
    //    escape sequence that shells variously interpret (or print) — at small
    //    geometries (the prewarm/hover-zoom buffer is ~45 cols) the partial
    //    sequence even gets split mid-byte by the renderer, producing the empty
    //    `~ ❯` accumulation visible in saved sessions like livezoom-test / prewarm-live-1.
    //
    //    xterm's internal `coreService.triggerDataEvent(data, wasUserInput)` is
    //    the single chokepoint that distinguishes the two: keystroke / paste
    //    paths pass `true`; every synthesized response defaults to `false`. The
    //    public `onData` event drops that flag, but `coreService.onUserInput`
    //    fires (with no payload) IMMEDIATELY before `onData` on the user-input
    //    path — same synchronous tick — so a flag-then-forward gate gives us
    //    exactly user-initiated bytes without touching xterm's parser or
    //    duplicating its keymap.
    //
    //    We send ONLY (a). The agent (claude, etc.) re-enables and uses focus
    //    events / DSR-CPR via the server→client direction; nothing of value
    //    flows back through client→server other than what the user typed.
    if (!readOnly) {
      // `coreService` is documented as `public readonly` on CoreTerminal — stable
      // since xterm 5.x. We reach it via `_core` (private on the public Terminal
      // wrapper) with a typed local cast; if a future xterm rev drops the
      // accessor the runtime guard falls back to the legacy "forward everything"
      // behaviour so we never silently break the pty.
      const coreService = (term as unknown as { _core?: { coreService?: { onUserInput?: (cb: () => void) => unknown } } })
        ._core?.coreService
      if (coreService?.onUserInput) {
        let wasUserInput = false
        coreService.onUserInput(() => {
          wasUserInput = true
        })
        term.onData((s) => {
          if (!wasUserInput) return
          wasUserInput = false
          sendRaw(s)
        })
      } else {
        // Fallback: xterm internals moved — preserve the v1 behaviour so we
        // never silently break the pty. The known phantom-Enter symptoms still
        // hit, but the terminal at least functions.
        term.onData((s) => sendRaw(s))
      }

      // SHIFT+ENTER = NEWLINE (desktop). A bare Enter (`\r`) submits Claude
      // Code's prompt; Shift+Enter (and Alt/Option+Enter as an alias) should
      // instead insert a literal newline WITHOUT submitting. There is no
      // distinct byte a terminal can encode for "Shift+Enter" over a pty, so
      // the soft keyboard / xterm's default keymap collapses it to a plain
      // `\r` — which submits. We intercept the keydown BEFORE xterm's keymap
      // runs and send LF (`\x0a`, Ctrl+J) ourselves down the SAME input wire
      // every keystroke uses (`sendRaw` → {type:'input'} → pty), then return
      // false to swallow the event so xterm does NOT also emit its `\r`.
      //
      // Scope is deliberately narrow: ONLY a keydown whose key is exactly
      // "Enter" with shiftKey (or altKey) and no other primary modifiers
      // (ctrl/meta) is handled — so Ctrl-C, ⌘-anything, plain Enter (=submit),
      // paste, and the phantom-Enter guard are all untouched. We also bail
      // during IME composition (`isComposing` / keyCode 229) so a CJK
      // candidate-commit Enter still reaches the composer normally.
      term.attachCustomKeyEventHandler((e) => {
        // ⌘C (macOS) / Ctrl+Shift+C (Linux/Windows) copies the CURRENT selection
        // to the system clipboard. With the GPU renderer there is no DOM text for
        // the browser's native copy to grab, so we copy via xterm's selection API.
        // We act ONLY on the copy chord AND only when something is selected, and we
        // NEVER touch a plain Ctrl+C — so SIGINT still interrupts the agent. Pairs
        // with `macOptionClickForcesSelection` (⌥-drag to select while the agent
        // holds the mouse). Swallow the matching keypress too so no stray "c"
        // reaches the pty after we've copied.
        const isCopyChord =
          (e.key === 'c' || e.key === 'C') &&
          (e.metaKey || (e.ctrlKey && e.shiftKey)) &&
          !e.altKey
        if (isCopyChord && term.hasSelection()) {
          if (e.type === 'keydown') {
            const sel = term.getSelection()
            if (sel) void navigator.clipboard?.writeText(sel)
            e.preventDefault()
          }
          return false
        }
        const isNewlineEnter =
          e.key === 'Enter' &&
          (e.shiftKey || e.altKey) &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.isComposing &&
          e.keyCode !== 229
        if (isNewlineEnter) {
          // Send LF ONCE (Claude Code's `chat:newline`) on the keydown, and
          // swallow the event so xterm doesn't ALSO emit its `\r`. Critically we
          // must swallow BOTH the keydown AND the matching keypress: the browser
          // still fires a `keypress` for Enter (charCode 13) after a swallowed
          // keydown, and xterm's keypress path turns that into `\r` — which
          // submits. That stray `\r` (LF then CR) is exactly why desktop
          // Shift+Enter was submitting instead of inserting a newline (the mobile
          // "Newline" chip is a button, has no keypress, and so was unaffected).
          // preventDefault on the keydown stops the keypress from being generated
          // at all; returning false + the keypress guard are belt-and-suspenders.
          if (e.type === 'keydown') {
            sendRaw('\x0a')
            e.preventDefault()
          }
          return false
        }
        return true
      })
    }

    // 3. WebSocket connect with first-frame auth (§4.5). No `?_token=` in URL.
    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    // ── Cover-until-bottom reveal (scroll-on-open fix) ──────────────────────────
    const clearReadyFallback = () => {
      if (readyFallbackTimerRef.current !== null) {
        window.clearTimeout(readyFallbackTimerRef.current)
        readyFallbackTimerRef.current = null
      }
    }

    /** Pin the viewport to the bottom and reveal the terminal (set `ready`). Runs
     *  once per connection: on the server's `replay_done` control frame, or the
     *  short fallback timeout, or — on the prewarm-adopt path — right after the
     *  buffered hydrate. Idempotent: a second call (e.g. fallback firing after
     *  replay_done already revealed) is a cheap no-op. */
    const markReady = () => {
      clearReadyFallback()
      if (readyRef.current) return
      readyRef.current = true
      // Pin to the bottom BEFORE the reveal so the first painted frame is the
      // freshest output — never an intermediate mid-replay scroll position.
      try {
        termRef.current?.scrollToBottom()
      } catch {
        /* terminal disposed mid-connect — the reveal is harmless either way */
      }
      setReady(true)
      // The replay has SETTLED (snapshot in, viewport pinned). Notify subscribers
      // SYNCHRONOUSLY in the same tick `ready` flips — the overview hover-peek
      // gates its static→live crossfade on this coherent frame (no fill-in
      // flicker), with NO added delay. Fired exactly once per connection (guarded
      // by `readyRef`); reset on every (re)connect via `resetReady`.
      onSettledRef.current?.()
    }

    /** Re-cover the terminal for a fresh (re)connect: a reconnect replays the
     *  snapshot again, so we hide + re-pin until the next `replay_done`. */
    const resetReady = () => {
      clearReadyFallback()
      readyRef.current = false
      setReady(false)
    }

    // ── Live-render kick while the soft keyboard is open (mobile) ────────────────
    //
    // ROOT CAUSE. xterm's renderer batches every paint — including the canvas
    // repaint that `term.write(ptyBytes)` triggers — into ONE requestAnimationFrame
    // via its internal RenderDebouncer. On mobile, while the soft keyboard is up
    // the visual viewport shrinks and the engine (iOS Safari / WKWebView)
    // composites our terminal layer behind the keyboard overlay; the debounced rAF
    // that flushes the canvas is throttled/coalesced and effectively does not paint
    // until the next layout change. So incoming pty bytes (Esc/Tab/arrow → Claude
    // redraw) land in xterm's buffer but the CANVAS doesn't repaint — the user sees
    // a frozen pane. Closing the keyboard fired a ResizeObserver → fit() →
    // handleResize() → full refresh, which is what *accidentally* forced the paint
    // before the accessory buttons stopped blurring xterm.
    //
    // THE FIX (minimal, no polling). When pty bytes arrive AND the keyboard is
    // open AND the terminal is focused (i.e. we are exactly in the frozen-canvas
    // condition), schedule one explicit `refresh()` on the next animation frame.
    // `term.refresh(0, rows-1)` re-queues a full repaint through the same renderer;
    // issuing it from a fresh rAF (rather than relying on the write's own debounced
    // frame) lands the paint in the compositor's live animation pipeline so the
    // canvas actually updates. A single rAF is coalesced across a burst of writes
    // (we clear+reschedule), so a redraw storm still paints exactly once per frame
    // — no busy loop, no per-byte work. On desktop / keyboard-closed this is a
    // no-op (the guard is false), so the normal live-stream paint path is untouched.
    // ── Live-stream `term.write()` rAF coalescer (residual row-mismatch fix) ──
    //
    // ROOT-CAUSE for the residual "typed text lands one row above the actual
    // `>` prompt" symptom. The server side is now correct (Resize coalesce
    // 8888d0a, DECSET 2026 force b60b440, peek_initial_resize 080ecd3 all
    // shipped), so the bytes claude emits ARE coherent frames most of the
    // time. The remaining race is on the CLIENT: when claude streams a redraw
    // that spans multiple WS Binary frames (long mid-stream output, or any
    // case where tmux's DEC 2026 buffer flushes mid-frame — tmux's sync gate
    // has a 1s timeout), each frame fires its OWN onmessage handler and each
    // calls `term.write(...)` separately. Xterm's parser commits each call's
    // bytes to the buffer synchronously and schedules ONE paint per microtask,
    // but two writes in the same tick can produce a transient state where the
    // earlier write's cursor-move + erase-line have committed but the later
    // write's repaint hasn't — and if the user's keystroke echo from claude is
    // split across those frames, the echo paints at the OLD cursor row (one
    // above the new `>` row that the later frame would have moved to). This is
    // the textbook "partial-frame race" the GitHub Copilot CLI team identified
    // as Layer 2 of their "4-Layer Rocket Scroll Fix" (copilot-cli#1805).
    //
    // THE FIX. Queue every WS Binary frame into a small Uint8Array list and
    // flush them ALL inside one requestAnimationFrame as a single concatenated
    // `term.write()`. Xterm's parser then sees the frame as one atomic unit;
    // no intermediate cursor state is ever observable, no echo can land on a
    // mid-write row. Order is preserved (FIFO queue, single flush). Cost: at
    // most one frame (~16 ms) added to first-byte latency per burst — well
    // below the perception threshold and identical to xterm's own
    // RenderDebouncer cadence. On a quiet stream (one frame per tick) it
    // behaves identically to today: enqueue → rAF → single write → paint.
    //
    // SAFETY. Independent of the prewarm-adopt path (which writes inside its
    // OWN rAF at line ~1162 BEFORE installHandlers wires onmessage, so its
    // bytes always land first by scheduling order). Cleared on teardown
    // alongside `renderKickRaf` so a late frame can't write into a disposed
    // terminal. NEVER drops bytes: if the rAF is already pending, we just
    // append to the queue.
    let pendingWrites: Uint8Array[] = []
    let pendingBytes = 0
    let writeFlushRaf: number | null = null
    let writeFlushTimeout: number | null = null
    let capWarned = false
    // Soft cap on the queue: rAF does NOT fire in background tabs, so a
    // backgrounded terminal that's still receiving WS bytes builds up the queue
    // until either the tab is foregrounded (rAF fires + flushes) OR the
    // setTimeout fallback below fires (1s). The cap is a sanity warning so a
    // pathological queue (e.g. a multi-minute background tab on a chatty agent)
    // surfaces in the console before memory pressure shows up elsewhere.
    // xterm.js's own internal queue caps at ~50 MB; 4 MB warns early.
    const QUEUE_WARN_BYTES = 4 * 1024 * 1024
    const flushPendingWrites = () => {
      if (writeFlushRaf !== null) {
        window.cancelAnimationFrame(writeFlushRaf)
        writeFlushRaf = null
      }
      if (writeFlushTimeout !== null) {
        window.clearTimeout(writeFlushTimeout)
        writeFlushTimeout = null
      }
      if (pendingWrites.length === 0) return
      const term = termRef.current
      if (!term) {
        pendingWrites = []
        pendingBytes = 0
        return
      }
      // Fast path: a single queued frame writes directly (no copy).
      if (pendingWrites.length === 1) {
        const only = pendingWrites[0]
        pendingWrites = []
        pendingBytes = 0
        try {
          term.write(only)
        } catch {
          /* terminal disposed mid-flush — harmless */
        }
        return
      }
      // Concat path: 2+ queued frames merge into ONE write so xterm's parser
      // sees the whole multi-frame redraw atomically.
      const merged = new Uint8Array(pendingBytes)
      let offset = 0
      for (const chunk of pendingWrites) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      pendingWrites = []
      pendingBytes = 0
      try {
        term.write(merged)
      } catch {
        /* terminal disposed mid-flush — harmless */
      }
    }
    const enqueueWrite = (bytes: Uint8Array) => {
      pendingWrites.push(bytes)
      pendingBytes += bytes.byteLength
      if (pendingBytes > QUEUE_WARN_BYTES && !capWarned) {
        capWarned = true
        console.warn(
          `[supermux] WS write queue past ${(QUEUE_WARN_BYTES / 1024 / 1024).toFixed(0)} MB — ` +
            `tab likely backgrounded (rAF paused). Foreground the tab to flush.`,
        )
      }
      if (writeFlushRaf !== null) return
      writeFlushRaf = window.requestAnimationFrame(flushPendingWrites)
      // Background-tab fallback: rAF callbacks pause when the tab is hidden.
      // Without this, queued bytes would sit until the user foregrounds the
      // tab (could be minutes). The 1s wakeup keeps the buffer fresh enough
      // that a foreground-then-Cmd-Tab-back cycle reveals a current view.
      // Cleared inside flushPendingWrites so a normal foreground rAF flush
      // doesn't trigger a duplicate setTimeout flush.
      if (writeFlushTimeout === null) {
        writeFlushTimeout = window.setTimeout(flushPendingWrites, 1000)
      }
    }

    let renderKickRaf: number | null = null
    const kickRenderWhileKeyboardOpen = () => {
      if (!keyboardOpenRef.current) return
      const t = termRef.current
      if (!t) return
      // Only when xterm actually owns focus — that's the precise "keyboard is up
      // FOR this terminal" condition; avoids forcing paints for an off-screen or
      // backgrounded terminal.
      const active = document.activeElement
      const focused =
        active instanceof HTMLElement &&
        container.contains(active) &&
        active.classList.contains('xterm-helper-textarea')
      if (!focused) return
      if (renderKickRaf !== null) return
      renderKickRaf = window.requestAnimationFrame(() => {
        renderKickRaf = null
        const term2 = termRef.current
        if (!term2) return
        try {
          term2.refresh(0, Math.max(0, term2.rows - 1))
        } catch {
          /* terminal disposed mid-frame — harmless */
        }
      })
    }

    const scheduleReconnect = () => {
      if (disposedRef.current) return
      const attempt = attemptRef.current
      if (attempt >= MAX_ATTEMPTS) {
        setLiveState('offline')
        return
      }
      attemptRef.current = attempt + 1
      setLiveState('reconnecting')
      clearReconnectTimer()
      reconnectTimerRef.current = window.setTimeout(
        () => connect(),
        backoffDelay(attempt),
      )
    }

    /** Install the message/error/close handlers on a WebSocket — used for both
     *  freshly-opened connections and adopted pre-warm seeds. Returns a small
     *  control object so the caller can clear the auth grace timer. */
    const installHandlers = (
      ws: WebSocket,
      opts: { skipAuth?: boolean } = {},
    ) => {
      // Guard: if `auth_ok` never arrives, treat as a failed connection. When
      // adopting a pre-warm seed the WS is already authed — no grace needed.
      let authTimer: number | null = opts.skipAuth
        ? null
        : window.setTimeout(() => {
            if (!authedRef.current) ws.close()
          }, AUTH_GRACE_MS)
      const clearAuthTimer = () => {
        if (authTimer !== null) {
          window.clearTimeout(authTimer)
          authTimer = null
        }
      }

      ws.onmessage = async (ev: MessageEvent) => {
        const data = ev.data
        if (typeof data === 'string') {
          // Control frames (JSON): auth_ok / error / pong.
          try {
            const msg = JSON.parse(data) as { type?: string }
            if (msg.type === 'auth_ok') {
              clearAuthTimer()
              authedRef.current = true
              setLiveState('live')
              // NOTE: we do NOT reset the reconnect backoff here. A WS that
              // 101-upgrades and auth-acks but then immediately closes (e.g. a
              // `stopped` session whose pty is gone) is NOT a genuinely useful
              // connection — resetting here would let a connect→auth_ok→close
              // cycle storm with zero backoff. The backoff is reset only once a
              // real pty data frame arrives (see the binary branch below).
              // Push our geometry so the pty matches the viewport immediately.
              const t = termRef.current
              if (t) resize(t.cols, t.rows)
            } else if (msg.type === 'replay_done') {
              // The server has flushed the entire replay snapshot and is about
              // to start the live fan-out. Pin to the bottom and REVEAL — the
              // user never saw the replay scroll because the terminal was
              // covered (opacity-0) until exactly now. Sent even for an empty
              // replay, so a short/no-history session reveals instantly too.
              markReady()
            }
          } catch {
            /* ignore non-JSON text frames */
          }
          return
        }
        // Binary frame = pty bytes (replay buffer first, then live stream). The
        // FIRST pty byte is the proof the connection is genuinely useful — only
        // now is it safe to reset the reconnect backoff (Eng P1 #5).
        attemptRef.current = 0
        const term = termRef.current
        if (!term) return
        if (data instanceof ArrayBuffer) {
          enqueueWrite(new Uint8Array(data))
        } else if (data instanceof Blob) {
          enqueueWrite(new Uint8Array(await data.arrayBuffer()))
        }
        kickRenderWhileKeyboardOpen()
        // Mark the first real pty frame so the overview hover-zoom can swap the
        // static ANSI preview out (peek crossfade polish). Cheap idempotent
        // ref-then-state flip — re-renders happen ONCE per mount.
        if (!hasFirstFrameRef.current) {
          hasFirstFrameRef.current = true
          setHasFirstFrame(true)
          // Arm the reveal fallback: if `replay_done` never arrives (an old
          // server that predates the control frame), reveal anyway a short
          // moment after the first byte so the terminal is never stuck covered.
          // A healthy server's `replay_done` fires first and clears this.
          if (!readyRef.current && readyFallbackTimerRef.current === null) {
            readyFallbackTimerRef.current = window.setTimeout(() => {
              readyFallbackTimerRef.current = null
              markReady()
            }, REPLAY_DONE_FALLBACK_MS)
          }
        }
      }

      ws.onerror = () => {
        // Surfaced via onclose; nothing actionable here.
      }

      ws.onclose = (ev: CloseEvent) => {
        clearAuthTimer()
        authedRef.current = false
        if (disposedRef.current || ev.code === CLOSE_UNMOUNT) return

        switch (ev.code) {
          case CLOSE_NOT_RUNNING:
            // TERMINAL: the server says this session's pty is gone (a `stopped`
            // session). There is nothing to reconnect to — STOP entirely and
            // surface the distinct `stopped` state. A genuine network drop uses
            // a different code (1006/1011) and still backs off + retries below.
            setLiveState('stopped')
            return
          case CLOSE_AUTH:
          case CLOSE_REVOKED:
            // Permanent: auth/origin reject or explicit revocation (§4.5).
            setLiveState('offline')
            return
          case CLOSE_TOO_SLOW:
            // 1013 = subscriber overflow. NOT permanent: stay `reconnecting`
            // and silently retry on the NEXT visibilitychange→visible (§4.5).
            visibilityPendingRef.current = true
            setLiveState('reconnecting')
            return
          case CLOSE_SERVER:
          default:
            // 1011 server error + all network closes (1006/…): backoff retry.
            scheduleReconnect()
            return
        }
      }
    }

    const connect = () => {
      if (disposedRef.current) return
      clearReconnectTimer()
      authedRef.current = false
      // A fresh connection replays the snapshot again — re-cover + re-pin until
      // the next replay_done so a reconnect never shows the scroll-on-open jank.
      resetReady()

      const base = wsUrl().replace(/\/$/, '')
      // AT-F2: a `wsPath` override (the read-only teammate route) connects there
      // instead of the session route — handshake/replay/close contract identical
      // (AT-E), so everything below is reused verbatim. The override is already
      // query-encoded by the caller.
      const url = wsPath
        ? `${base}${wsPath.startsWith('/') ? '' : '/'}${wsPath}`
        : `${base}/ws/sessions/${encodeURIComponent(name)}`
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      // Set onopen FIRST so installHandlers' message/close wiring sees a
      // consistent WebSocket. The first frame is the in-band auth (token from
      // window, never the URL).
      //
      // Cursor-row-mismatch fix (Option B — client-side suspenders). We BATCH
      // the auth frame with an initial `resize` carrying our current xterm
      // geometry, BEFORE waiting for `auth_ok`. The server's `peek_initial_resize`
      // (ws/mod.rs) reads this resize between `auth_ok` and the seed capture,
      // so `capture-pane visible` covers OUR rows instead of tmux's default
      // 80×24 — eliminating the "seed has 24 rows, xterm has 40" geometry
      // mismatch that left the bottom of the viewport blank and put the CUP
      // at a row that mapped to mid-grid empty space. Paired with the server's
      // Option A; together the happy path becomes resize-then-seed in one
      // round-trip. If the terminal hasn't laid out yet (cols/rows == 0), we
      // skip the resize and fall back to the post-`auth_ok` resize below; the
      // server's peek will time out and the seed will use tmux's current size
      // — same shape as pre-fix, no regression.
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: 'auth', token: authToken() }))
          const t = termRef.current
          if (t && t.cols > 0 && t.rows > 0) {
            ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }))
          }
        } catch {
          /* will surface via onclose */
        }
      }
      installHandlers(ws)
    }

    /** Adopt an already-open, already-authed WebSocket + buffered bytes from
     *  the peek-prewarm registry. Skips the M4 handshake entirely: state goes
     *  straight to `live`, the buffer is written into xterm on the next
     *  microtask (after the first FitAddon `fit()` runs — see the rAF above —
     *  so the cols/rows reflow the buffered ANSI correctly), and the SAME WS
     *  continues streaming. Returns true on success. */
    const adopt = (seed: { ws: WebSocket; bytes: Uint8Array }): boolean => {
      if (disposedRef.current) {
        try {
          seed.ws.close(CLOSE_UNMOUNT, 'unmount-before-adopt')
        } catch {
          /* nothing */
        }
        return false
      }
      const ws = seed.ws
      // Re-set binaryType defensively in case a future contributor flips it on
      // the prewarm side.
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      authedRef.current = true
      // Skip the auth grace timer — we've already received auth_ok upstream.
      installHandlers(ws, { skipAuth: true })
      setLiveState('live')

      // Hydrate the terminal with the buffered bytes. Two timing constraints:
      //  • xterm must have a real layout box (cols/rows > 0) or `write` is
      //    a no-op on the renderer. The rAF above performs the first `fit()`;
      //    we schedule the hydrate AFTER that rAF so the box exists.
      //  • The buffer must land BEFORE any further live bytes arrive, so the
      //    on-screen output preserves chronological order. We're inside the
      //    same synchronous tick as installHandlers — no async gap yet — so
      //    the next message can only fire after this microtask completes; we
      //    queue the hydrate via rAF so it runs strictly after the first fit.
      if (seed.bytes.byteLength > 0) {
        const bytes = seed.bytes
        window.requestAnimationFrame(() => {
          if (disposedRef.current) return
          const t = termRef.current
          if (!t) return
          try {
            t.write(bytes)
          } catch {
            /* xterm rejected the write — non-fatal; live stream still flows */
          }
          // The buffered bytes landed in one synchronous write (no visible
          // replay scroll on the adopt path); pin to the bottom and reveal.
          markReady()
        })
      } else {
        // Empty pre-warm buffer (an idle session): nothing to hydrate — reveal
        // immediately so the adopted terminal isn't stuck covered.
        markReady()
      }
      // Push our current geometry to the server so the pty matches what xterm
      // just laid out (the pre-warm never sent a resize — it didn't know the
      // viewport size yet).
      window.requestAnimationFrame(() => {
        if (disposedRef.current) return
        const t = termRef.current
        if (!t) return
        try {
          resize(t.cols, t.rows)
        } catch {
          /* not yet authed in our view — onmessage path will catch up */
        }
      })
      return true
    }

    connectRef.current = connect
    // Pre-warm fast-path: try to adopt a buffered WS for `name` if the caller
    // opted in. If no seed is available (cap was full, prewarm not authed
    // yet, the WS closed in the meantime), fall through to the normal connect.
    if (prewarmSeed) {
      const seed = claimPrewarm(name)
      if (seed && adopt(seed)) {
        // Adopted — skip the fresh connect.
      } else {
        connect()
      }
    } else {
      connect()
    }

    // 4. ResizeObserver → debounced fit + resize round-trip (§4.5).
    let resizeTimer: number | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        const f = fitRef.current
        const t = termRef.current
        if (!f || !t) return
        try {
          f.fit()
        } catch {
          return
        }
        resize(t.cols, t.rows)
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(container)

    // 5. 1013 silent-reconnect: on visibilitychange→visible (debounced ≥2s),
    //    re-establish the subscription without a banner state flip (§4.5).
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (!visibilityPendingRef.current || disposedRef.current) return
      const now = Date.now()
      if (now - lastVisibleAtRef.current < VISIBILITY_DEBOUNCE_MS) return
      lastVisibleAtRef.current = now
      visibilityPendingRef.current = false
      attemptRef.current = 0
      connect()
    }
    document.addEventListener('visibilitychange', onVisibility)

    // 5b. Track soft-keyboard open/close off `visualViewport` so the live-render
    //     kick (above) knows when xterm's canvas is in the frozen-while-keyboard-up
    //     condition. Mirrors `useKeyboardViewport`'s detection (inset vs the layout
    //     viewport, same 80px threshold) but kept LOCAL to the hook so the fix is
    //     self-contained — no new prop threaded through the route → split → terminal
    //     chain. When the keyboard CLOSES we also kick one final refresh so the last
    //     bytes that arrived while it was up are painted immediately (belt-and-
    //     suspenders; the close-induced resize usually covers this). No-op when
    //     `visualViewport` is absent (desktop) — `keyboardOpenRef` stays false.
    const visual =
      typeof window !== 'undefined' ? window.visualViewport : undefined
    let kbRaf = 0
    const measureKeyboard = () => {
      kbRaf = 0
      if (!visual) return
      const inset = Math.max(
        0,
        window.innerHeight - visual.height - visual.offsetTop,
      )
      const open = inset > KEYBOARD_OPEN_THRESHOLD
      const was = keyboardOpenRef.current
      keyboardOpenRef.current = open
      // On the open→closed edge, force one repaint so anything written while the
      // canvas was frozen lands now (covers engines whose close doesn't fire a
      // ResizeObserver pass before our kick guard goes false).
      if (was && !open) {
        const t = termRef.current
        if (t) {
          try {
            t.refresh(0, Math.max(0, t.rows - 1))
          } catch {
            /* disposed mid-frame — harmless */
          }
        }
      }
    }
    const scheduleKeyboard = () => {
      if (kbRaf) return
      kbRaf = window.requestAnimationFrame(measureKeyboard)
    }
    if (visual) {
      measureKeyboard()
      visual.addEventListener('resize', scheduleKeyboard)
      visual.addEventListener('scroll', scheduleKeyboard)
    }

    // 6. Teardown — dispose terminal + close WS so the mount/unmount cycle test
    //    (100 iterations, §4.5 / §11) returns WS count to zero, no leaks.
    return () => {
      disposedRef.current = true
      window.cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      if (visual) {
        visual.removeEventListener('resize', scheduleKeyboard)
        visual.removeEventListener('scroll', scheduleKeyboard)
      }
      if (kbRaf) window.cancelAnimationFrame(kbRaf)
      if (renderKickRaf !== null) window.cancelAnimationFrame(renderKickRaf)
      if (writeFlushRaf !== null) window.cancelAnimationFrame(writeFlushRaf)
      if (writeFlushTimeout !== null) window.clearTimeout(writeFlushTimeout)
      pendingWrites = []
      pendingBytes = 0
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      clearReconnectTimer()
      clearReadyFallback()
      const ws = wsRef.current
      if (ws) {
        // Drop handlers before closing so a late onclose can't re-arm a retry.
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close(CLOSE_UNMOUNT, 'unmount')
        } catch {
          /* already closing */
        }
        wsRef.current = null
      }
      viewportEl?.removeEventListener('scroll', syncScrolledUp)
      screenEl?.removeEventListener('touchstart', onScreenTouchStart)
      screenEl?.removeEventListener('touchmove', onScreenTouchMove)
      screenEl?.removeEventListener('touchend', onScreenTouchEnd)
      screenEl?.removeEventListener('touchcancel', onScreenTouchEnd)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Re-subscribe ONLY when the target session changes (or the embed's font
    // geometry changes). The imperative callbacks are ref-stable so they don't
    // belong in deps. `prewarmSeed` is read once at mount (it's a boolean
    // capability, not a per-render input) so it's omitted from the deps to
    // avoid re-subscribing if a parent toggles it on/off.
    // `wsPath` IS in the deps: changing the target pane (AT-F2 teammate switch)
    // must re-subscribe just like changing `name`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, readOnly, fontSize, wsPath])

  return {
    containerRef,
    state,
    hasFirstFrame,
    ready,
    send,
    sendKey,
    resize,
    copyAll,
    retry,
    focus,
    blur,
    scrolledUp,
    scrollToBottom,
  }
}
