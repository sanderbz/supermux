// useLiveTerm — the live terminal hook.
//
// Drives an xterm.js Terminal bound to the WebSocket pty stream:
//   • Renders replay + live pty bytes (binary frames → term.write).
//   • Sends user keystrokes back (term.onData → {type:'input'} text frames).
//   • Resizes via FitAddon + a debounced ResizeObserver, telling the server the
//     new {cols,rows} so the pty geometry tracks the viewport.
//   • Reconnects with exponential backoff + decorrelated jitter, honouring the
//     v2 close-code semantics.
//
// PRINCIPLE: WebSocket-ONLY. There is no polling here — bytes arrive over the WS
// the backend already fans out. The auth token is NEVER put in the URL: we
// connect token-less and send {type:'auth',token} as the first frame, then wait
// for {type:'auth_ok'} before declaring ourselves `live`. The token is read
// from `window._SUPERMUX_AUTH_TOKEN` at runtime (env.ts) — never embedded in
// source.

import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

import { authToken, wsUrl } from '@/env'
import { claim as claimPrewarm } from '@/hooks/peek-prewarm-store'
import { disableXtermMouseTracking } from '@/lib/disable-xterm-mouse'
import { attachAndroidImeBridge, isAndroid } from '@/lib/android-ime'
import { LINK_URL_REGEX, openExternal, findLinkAt } from '@/lib/terminal-links'
import { createKeyboardOpenDetector } from '@/hooks/use-keyboard-viewport'
import { isTermHistoryEnabled } from '@/lib/term-history-flag'

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
  /** Send a named key (Up/Down/Left/Right/PageUp/Enter/…). */
  sendKey(name: string): void
  /** Force a fit + resize round-trip (callers rarely need this — the
   *  ResizeObserver handles it — but the dock/joystick may after a layout flip). */
  resize(cols: number, rows: number): void
  /** Ask the server to re-push a clean full-screen snapshot ("refresh"). The
   *  server replies on the SAME socket with the clear + alt-screen-aware capture
   *  (the attach-seed payload), deterministically wiping any client-side render
   *  garble — an inline-TUI cursor-relative redraw landing on rows xterm has
   *  reflowed (e.g. after a width change) leaves stale, misaligned rows that no
   *  incremental redraw clears. This reaches the same coherent state a full page
   *  reload would, without the reload. The server ALSO triggers this same resync
   *  automatically (debounced) after a resize, so the manual call is only needed
   *  for residual garble from some other desync. No-op until authed. */
  resync(): void
  /** Copy the whole scrollback buffer to the clipboard. */
  copyAll(): void
  /** Copy the CURRENT xterm selection (made with the desktop shift-click-drag
   *  the renderer natively supports) to the clipboard. Returns the copied text
   *  on a confirmed write, `null` when nothing is selected OR the clipboard
   *  write failed. Same path as the desktop ⌘C / Ctrl+Shift+C chord. */
  copySelection(): string | null
  /** Manual retry for the permanent (`offline`) state — "Tap to retry". */
  retry(): void
  /** Programmatically focus xterm's input. The focus route calls this on mount
   *  so keystrokes go to the terminal IMMEDIATELY — no second click required. */
  focus(): void
  /** Blur xterm's input — dismisses the mobile soft keyboard (the "hide
   *  keyboard" affordance / tap-away). No-op on desktop where there is no
   *  on-screen keyboard to dismiss. */
  blur(): void
  /** If the viewport point (client px) sits on a URL, open it (PWA-safely —
   *  the addon's window.open silently fails in the installed iOS PWA) and
   *  return true. Returns false when there's no link there, so the mobile tap
   *  handler can fall back to focusing the terminal instead of summoning the
   *  keyboard. The desktop hover-click path opens the same way via the addon. */
  tryOpenLinkAt(clientX: number, clientY: number): boolean
  /** True when the user has scrolled the viewport up from the live bottom by
   *  more than a few rows — drives the in-terminal "jump to bottom" button.
   *  False while pinned to the bottom (the normal follow-output state). */
  scrolledUp: boolean
  /** Pin the viewport back to the live bottom (resume following output) and
   *  re-focus the input. Wired to the "jump to bottom" button (SD-2). */
  scrollToBottom(): void
  /** True when the tmux-authoritative scrollback layer is active for this
   *  terminal (the `TERM_TMUX_HISTORY` flag was on at mount). False → the
   *  terminal is on the historical (xterm-owned-scrollback) path.
   *
   *  DESIGN (authoritative reseed, single xterm). With the flag on there is
   *  still exactly ONE xterm. On attach we SEED it with tmux's authoritative,
   *  already-reflowed scrollback (walking `history` windows up from the seam)
   *  and PREPEND those rows above the live screen — so native xterm scroll just
   *  works, with no overlay, no wheel interception, no second surface, and no
   *  client-side reflow (tmux owns the reflow). Scrolling near the top fetches
   *  the next older window and grows the seeded block. */
  historyEnabled: boolean
  /** The live term's current column count, updated on every fit/resize. Exposed
   *  for parity with the previous two-term design; harmless when unused. 0 until
   *  the first fit. */
  cols: number
}

// ── Clipboard ────────────────────────────────────────────────────────────────

/**
 * Write `text` to the clipboard from a user gesture.
 *
 * Two parallel paths — whichever lands first wins, and we no longer fire and
 * forget:
 *
 *   1. `document.execCommand('copy')` via a transient off-screen `<textarea>`.
 *      Synchronous, returns a success boolean, works in installed iOS PWAs
 *      and on Android Chrome — the only clipboard API guaranteed under the
 *      strict user-activation gate Safari/WKWebView enforces. Deprecated but
 *      still implemented everywhere we ship.
 *   2. `navigator.clipboard.writeText()` — modern, async, allowed everywhere
 *      it isn't behind permissions. We let it run; if it rejects (iOS PWA's
 *      usual response when called outside the gesture window) the catch is
 *      a no-op because (1) already covered us.
 *
 * Returns the boolean result of (1) — toast handlers use this to decide
 * whether to surface "Copied" honestly. Pre-fix the caller would announce
 * a copy that silently never happened (the user-reported iOS bug).
 *
 * MUST be called synchronously inside a user gesture (click, keydown, …). A
 * trailing `setTimeout(…, 0)` is enough to escape the gesture token on iOS
 * 16+ and rejects both APIs.
 */
function writeClipboard(text: string): boolean {
  if (!text) return false
  let ok = false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // `readonly` keeps iOS from popping the soft keyboard for our hidden node,
    // and is also the documented hint that this textarea isn't user-editable.
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '0'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    const prevActive = document.activeElement as HTMLElement | null
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(ta)
    // Restore focus so we don't strand it on a removed node — the host page's
    // own focus management owns where it lands; we just shouldn't break it.
    prevActive?.focus?.()
  } catch {
    /* deliberately silent */
  }
  // Belt-and-suspenders modern path. If the gesture is fresh, it succeeds and
  // overwrites the clipboard with the same content. If it rejects (iOS PWA
  // outside-gesture, permission denied, insecure origin), the execCommand
  // result above is still authoritative.
  navigator.clipboard?.writeText(text).catch(() => {})
  return ok
}

// ── Tunables ─────────────────────────────────────────────────────────────────
const BASE_BACKOFF_MS = 300
const MAX_BACKOFF_MS = 30_000
const MAX_ATTEMPTS = 6 // 1011 server-error path then permanent
const RESIZE_DEBOUNCE_MS = 100
const VISIBILITY_DEBOUNCE_MS = 2_000
// Resume staleness ceiling. The server pings every 20s and reaps a client that
// stays silent past a 30s deadline (ws/mod.rs PING_EVERY / PONG_DEADLINE) — a
// page hidden longer than this has likely been reaped server-side even when
// the local socket still CLAIMS to be OPEN (Android freezes the renderer +
// network without closing the socket: the classic resume-zombie). Past this,
// a visible-again page reconnects proactively instead of trusting readyState.
const RESUME_STALE_MS = 15_000
const AUTH_GRACE_MS = 4_000 // server allots 2s for the first frame; we give slack
// Fallback for an OLD server that doesn't emit `{"type":"replay_done"}`: if no
// such control frame arrives within this window AFTER the first pty byte, we
// reveal anyway (scroll-to-bottom first) so the terminal is never stuck hidden.
// Kept short — long enough to swallow the replay-scroll on a healthy server,
// short enough that a legacy server's reveal still feels instant.
const REPLAY_DONE_FALLBACK_MS = 400
// Soft-keyboard detection for the live-render kick reuses the shared
// dual-signal detector from `use-keyboard-viewport` (overlay inset on iOS,
// layout-viewport shrink on Android's resizes-content) so the kick path
// agrees with the route's keyboard-open state on BOTH platforms.
// SD-2: how many ROWS above the live bottom the viewport must sit before the
// "jump to bottom" affordance appears. A small slack so a 1-notch rubber-band
// never flickers the button on; scrolling up "a bit" (a row or two) does.
// Measured in buffer rows via `baseY - viewportY` (xterm 6.0's viewport moved to
// a VS Code scrollable element, so the old `.xterm-viewport.scrollTop` is dead).
const SCROLL_UP_SLACK_ROWS = 1

// ── tmux-authoritative scrollback tunables (gated by TERM_TMUX_HISTORY) ──
// With the flag ON, xterm keeps its FULL scrollback (a single surface) and we
// SEED it with tmux's authoritative, already-reflowed history on attach, then
// fetch-older-and-grow as the user scrolls near the top. With the flag OFF none
// of these are used and the terminal is byte-identical to today.
//
// Rows per history request window. Stays at/under the server's
// HISTORY_WINDOW_MAX (500) so a single capture serves a whole window. Used both
// for the on-attach authoritative probe and each near-top older fetch.
const HISTORY_WINDOW = 500
// How close to the top of the scrollback (in BUFFER ROWS) the viewport must
// come before we prefetch the next older window. Rows, not px: xterm 6.0 moved
// the viewport onto a VS Code scrollable element, so `.xterm-viewport.scrollTop`
// is permanently 0 — the renderer-independent `buffer.active.viewportY` (top
// visible line index; 0 = buffer top) is the reliable near-top signal. Sized to
// give the fetch RTT lead time (esp. SSH sessions) before the user hits the top.
const HISTORY_PREFETCH_SLACK_ROWS = 40

// Close codes with explicit v2 semantics.
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

/** Read the live terminal theme from the CSS custom properties. This runs
 *  at mount so the terminal tracks whichever theme `<ThemeProvider>` applied to
 *  <html> before first paint — no hardcoded hex for bg/fg. The 16-colour ANSI palette IS hardcoded: those bytes ARE the terminal's
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
 *  `{type:'input'}` wire shape — the backend forwards input verbatim via
 *  `tmux send-keys -l`, so we resolve the byte sequence client-side. Used by
 *  the dock send-row + the joystick through `sendKey`. */
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
 *  (avoids the reconnect-storm during a Tailscale server restart).
 *  Formula: delay = base*2^n; jittered = delay/2 + random(delay). */
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
     *  keydown handler can pipe keystrokes through the existing wire while
     *  keeping the xterm DOM stdin disabled (no focus surprises, no global
     *  reconnect-banner subscription). Without this flag `send`/`sendKey` are
     *  silenced for readOnly embeds. */
    allowProgrammaticInput?: boolean
    /** Pre-warm fast-path: when true, the mount effect first attempts to adopt
     *  an already-open, already-authed WS + buffered bytes from the peek-
     *  prewarm registry (`peek-prewarm-store`) — so the overview hover-zoom
     *  hydrates INSTANTLY instead of waiting for a fresh handshake +
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
     *  passes the read-only teammate route
     *  `/ws/teams/{team}/{member}[?pane_id=%id]` here — the handshake / replay /
     *  close-code contract is byte-for-byte identical, so the ENTIRE WS
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
  // terminal and quick-peek omit it and keep the default.
  const fontSize = opts?.fontSize ?? 13
  // When true, the mount effect first attempts to adopt an already-open,
  // already-authed WS + buffered bytes from the peek-prewarm registry — so the
  // overview hover-zoom hydrates INSTANTLY instead of waiting for a fresh
  // handshake + first-frame round-trip. Falls back to normal connect if no
  // pre-warm exists (cap was full, tile only just became visible, etc.). Off
  // by default so the focus terminal + quick-peek modal keep their existing
  // single-WS lifecycle.
  const prewarmSeed = opts?.prewarmSeed ?? false
  // Optional WS path override (teammate route). Read once into the mount
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

  // §5 flag, read once at first render (parity with the mount effect, which
  // reads the SAME localStorage flag independently at mount). `useState` with an
  // initializer keeps it constant across re-renders for the terminal's lifetime.
  const [historyEnabled] = React.useState(isTermHistoryEnabled)
  // Mirrored live-term cols (exposed for parity; harmless when unused).
  const [cols, setCols] = React.useState(0)
  const setColsIfChanged = React.useCallback((next: number) => {
    setCols((prev) => (prev === next ? prev : next))
  }, [])

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

  /** Request a clean full-screen snapshot from the server (manual "refresh").
   *  The server re-pushes the attach-seed payload on this socket; writing it
   *  (it begins with a clear) repaints the terminal coherently — the reload-
   *  equivalent self-heal for residual render garble. No-op until authed. */
  const resync = React.useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && authedRef.current) {
      ws.send(JSON.stringify({ type: 'resync' }))
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
    writeClipboard(text)
  }, [])

  const copySelection = React.useCallback((): string | null => {
    const term = termRef.current
    if (!term || !term.hasSelection()) return null
    const sel = term.getSelection()
    if (!sel) return null
    // Return the text ONLY when the synchronous clipboard write actually
    // succeeded — the caller uses this to decide whether to announce
    // "Copied". Pre-fix the return-on-selection-present path fired the
    // toast even when iOS had silently rejected the write.
    return writeClipboard(sel) ? sel : null
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

  /** Open the URL under a viewport point (PWA-safely) and report whether it hit
   *  a link — see lib/terminal-links. The mobile tap handler uses the boolean to
   *  decide between "open the link" and "focus the terminal" (the latter summons
   *  the soft keyboard, whose reflow used to fight the link open). */
  const tryOpenLinkAt = React.useCallback(
    (clientX: number, clientY: number): boolean => {
      const term = termRef.current
      if (!term) return false
      const uri = findLinkAt(term, clientX, clientY)
      if (!uri) return false
      openExternal(uri)
      return true
    },
    [],
  )

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

    // §5 feature flag: read ONCE at mount. When OFF everything below stays on
    // the historical path (xterm keeps its full 50000 scrollback, no `history`
    // frames are sent, no history state is tracked) — byte-identical to today.
    const historyEnabled = isTermHistoryEnabled()

    // ── tmux-authoritative history state (authoritative-reseed design) ───────────
    // All effect-local (like `pendingWrites`) — the single mount effect owns the
    // whole lifecycle; a re-subscribe (name/wsPath change) starts fresh. Inert
    // while `historyEnabled` is false.
    //
    // DESIGN (authoritative reseed, single xterm, gap-fill prepend).
    //
    // The server's attach SEED already replays tmux's FULL scrollback (`-S -`,
    // joined = tmux's own reflow) as one binary frame — so for the common case
    // xterm's single buffer ALREADY holds tmux's authoritative history top→bottom
    // and native xterm scroll reveals it directly. The old bug was purely that
    // xterm's scrollback was shrunk to a 200-row band, TRUNCATING that replayed
    // history into a void; keeping the full 50000 scrollback (above) fixes that.
    //
    // On top of that we make tmux the authoritative source on scroll-up:
    //   • On near-top scroll we send `history` request frames (windowed
    //     `capture-pane`, absolute-id anchored) — the copy-mode-over-web contract.
    //   • We PREPEND any fetched rows that sit ABOVE what xterm currently holds
    //     (the genuine gap case: a history so large the replay seed was truncated,
    //     or a reconnect where the seed lagged). Prepend = a whole-buffer repaint
    //     [older history] + [existing buffer text], scroll-position preserved.
    //   • When xterm already covers the fetched region (the common replay case),
    //     the fetch is a no-op augmentation — NEVER a destructive reset — so the
    //     clean replayed buffer is untouched and scroll stays perfectly smooth.
    //
    // The seam invariant: while scrolled up the pane keeps producing output, so
    // tmux's `history_size` grows and negative offsets slide. Absolute ids keep
    // fetched rows stable regardless of that slide.
    const histRows = new Map<number, string>() // absLineId → ANSI row (fetched)
    let histOldestAbs = Infinity // smallest absId fetched
    let histSeamAbs = -1 // absId of the row directly above the live screen (seam)
    let histSizeLast = 0 // latest tmux history_size
    let histHitTop = false // reached -history_size → no older rows exist
    let histInflightReq: number | null = null
    let histInflightAt = 0 // epoch ms of the inflight request (stall re-issue)
    let histWidthMismatches = 0 // consecutive width-guard refetches (loop breaker)
    let histReqSeq = 0
    const absId = (histSize: number, offset: number) => histSize + offset
    // A lost `history` response (socket close race, old server that can't parse
    // the frame) must not wedge fetching for the rest of the mount: an inflight
    // older than this is considered stalled and the near-top scroll may re-issue.
    const HISTORY_INFLIGHT_STALL_MS = 5000
    // Width-guard refetch cap. Two viewers at different widths fight over the
    // pane width (last resize wins); without a cap the loser would ping-pong
    // `history` requests at RTT cadence forever. After this many consecutive
    // mismatches fetching pauses until the next local resize or reconnect.
    const HISTORY_WIDTH_MISMATCH_MAX = 3

    // How many rows above the live screen xterm currently holds in its buffer —
    // i.e. how deep the replay seed reached. The topmost buffer absId is
    // `histSeamAbs + 1 - rowsAboveScreen`; anything OLDER than that is a gap tmux
    // must fill on scroll-up. `buffer.baseY` is the number of scrollback rows
    // above the visible screen.
    const rowsAboveScreenInBuffer = (t: Terminal): number => t.buffer.active.baseY

    // Absolute id of the OLDEST row xterm currently holds (top of the buffer).
    const bufferTopAbs = (t: Terminal): number =>
      histSeamAbs + 1 - rowsAboveScreenInBuffer(t)

    // GAP-FILL prepend. Runs ONLY when the fetched authoritative block extends
    // ABOVE what xterm's buffer currently holds — the genuine case where the
    // replay seed was truncated (a very large / evicted history) or a reconnect's
    // seed lagged. It writes [missing older authoritative rows] + [existing buffer
    // text] and re-pins the bottom. This is the one path that repaints; the common
    // full-replay case never reaches it (guarded by the buffer-top check), keeping
    // that scroll smooth and fully colour-correct. Here the prepended older rows
    // ARE coloured (authoritative SGR from tmux); the existing rows below are
    // re-emitted as plain text (xterm exposes no SGR read-back) — an acceptable
    // trade only taken to avoid a black void on an evicted history.
    const fillGapAndRepaint = (t: Terminal) => {
      // Only meaningful when we hold a contiguous authoritative block from
      // `histOldestAbs` down to the seam that extends ABOVE the buffer top.
      if (histOldestAbs === Infinity) return
      if (histOldestAbs >= bufferTopAbs(t)) return // no gap — replay already covers it
      // Pinned to the live bottom? xterm 6.0's DOM viewport scrollTop is dead;
      // use the renderer-independent buffer API — viewportY (top visible line)
      // at/after baseY (the live bottom line) means the user is following output,
      // not scrolled up, so the repaint should re-pin to the bottom.
      const wasPinnedBottom =
        t.buffer.active.viewportY >= t.buffer.active.baseY
      // Everything the authoritative block adds ABOVE the current buffer top.
      const addFrom = histOldestAbs
      const addTo = bufferTopAbs(t) - 1
      const older: string[] = []
      for (let a = addFrom; a <= addTo; a++) older.push(histRows.get(a) ?? '')
      if (older.length === 0) return
      // Snapshot the existing buffer (scrollback + screen) as plain text — SGR is
      // lost for these rows, but this path ONLY runs for very large evicted
      // histories where the alternative is a black void; the older authoritative
      // rows we prepend ARE coloured. The common (non-gap) case never gets here.
      const buf = t.buffer.active
      const existing: string[] = []
      for (let i = 0; i < buf.length; i++) {
        existing.push(buf.getLine(i)?.translateToString(false) ?? '')
      }
      while (existing.length > 1 && existing[existing.length - 1].trim() === '') {
        existing.pop()
      }
      try {
        t.reset()
        t.write(older.join('\r\n') + '\r\n' + existing.join('\r\n'), () => {
          if (wasPinnedBottom) {
            try {
              t.scrollToBottom()
            } catch {
              /* disposed — harmless */
            }
          }
        })
      } catch {
        /* disposed mid-repaint — a later fetch repaints again */
      }
    }

    // Send a `history` request for `count` rows ending at `endOffset` (scrollback
    // coord, ≤ -1) at the CURRENT width. `req_id` correlates async replies (a
    // fling produces many inflight; the newest wins). No-op unless the flag is on,
    // the socket is open, and there are older rows to fetch.
    const requestHistory = (endOffset: number, count: number) => {
      if (!historyEnabled || histHitTop) return
      const t = termRef.current
      const ws = wsRef.current
      // Use the INSTANCE `ws.OPEN` constant (spec-guaranteed === 1), not the
      // static `WebSocket.OPEN`: a wrapped/shadowed global `WebSocket` (test
      // harnesses that monkeypatch the constructor, some polyfills) drops the
      // static class constants, which would make this gate falsely fail. The
      // instance constant lives on the prototype and always survives.
      if (!t || !ws || ws.readyState !== ws.OPEN || !authedRef.current) return
      const reqId = ++histReqSeq
      histInflightReq = reqId
      histInflightAt = Date.now()
      try {
        ws.send(
          JSON.stringify({
            type: 'history',
            req_id: reqId,
            end_offset: endOffset,
            count,
            cols: t.cols,
          }),
        )
      } catch {
        // Socket died between the readyState check and send — surface via onclose.
        histInflightReq = null
      }
    }

    // Fetch the next OLDER window: the `count` rows ending just above the oldest
    // absId we already hold (or, before the first fetch, just above the seam).
    // Converts the absolute bottom id back to a scrollback offset via the LATEST
    // history_size so a sliding buffer still resolves.
    const requestOlder = () => {
      if (!historyEnabled || histHitTop) return
      // One inflight at a time — but a response that never arrives (lost frame)
      // must not block forever: past the stall window a new request may be
      // issued (the old late reply is then discarded by the req_id check).
      if (
        histInflightReq !== null &&
        Date.now() - histInflightAt < HISTORY_INFLIGHT_STALL_MS
      ) {
        return
      }
      const bottomAbs =
        histOldestAbs === Infinity ? histSeamAbs : histOldestAbs - 1
      if (bottomAbs < 0) {
        histHitTop = true
        return
      }
      requestHistory(bottomAbs - histSizeLast, HISTORY_WINDOW)
    }

    // Reset ALL history state — on every (re)connect and on a resync boundary.
    const resetHistory = () => {
      histRows.clear()
      histOldestAbs = Infinity
      histSeamAbs = -1
      histSizeLast = 0
      histHitTop = false
      histInflightReq = null
      histWidthMismatches = 0
    }

    // 1. Terminal + addons. WebGL renderer for perf (DOM fallback on context
    //    loss / no-GL); FitAddon snaps the geometry to the container; WebLinks
    //    makes URLs clickable.
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
      // cursor reads as more native/snappy (the iTerm default-feel).
      cursorBlink: false,
      // Scrollback. With TERM_TMUX_HISTORY OFF (the default): large so the client
      // never truncates the history the server replays on connect (replay ring is
      // ≤512 KB ≈ several thousand lines) or that tmux retains (history-limit =
      // 50000). Kept at/above the tmux limit so scroll-up reaches as far back as
      // the session actually has. xterm.js stores lines compactly; 50k lines is a
      // modest memory cost per terminal.
      //
      // With the flag ON: xterm is STILL a single surface with a full scrollback,
      // but its scrollback is SEEDED from tmux's authoritative, already-reflowed
      // history on attach (and grown older on demand) rather than filled purely by
      // the replay ring. Native xterm scroll then serves the whole tmux history —
      // no overlay, no second term, no client reflow. Same 50000 ceiling as the
      // flag-off path (at/above tmux's history-limit) so scroll-up reaches as far
      // back as the session actually has.
      scrollback: 50000,
      disableStdin: readOnly,
      // ⌥-drag forces a LOCAL text selection even if a program holds the mouse
      // (DECSET ?1000/?1002). supermux neutralizes mouse reporting client-side
      // (lib/disable-xterm-mouse.ts), so a plain drag already selects for Claude
      // sessions — but a raw `shell` session running a mouse-mode TUI (tmux
      // `mouse on`, vim, htop) still holds the mouse, and on macOS xterm has no
      // other modifier to bypass it. This keeps ⌥-drag-to-select working in that
      // case (Linux/Windows get Shift-drag by default; this affects macOS only).
      // Pairs with the ⌘C handler below. Cheap, additive, no downside.
      macOptionClickForcesSelection: true,
    })
    // Refuse to enter mouse-tracking mode no matter what the agent emits — this
    // is what keeps xterm's native one-finger touch-scroll alive (mobile) and a
    // drag selecting text (desktop). MUST run before any pty bytes are written.
    // See lib/disable-xterm-mouse.ts for the full why (Claude 2.1.156 ignores the
    // documented CLAUDE_CODE_DISABLE_MOUSE env — so we never set it server-side —
    // and still streams ?1000h/?1002h/…).
    disableXtermMouseTracking(term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Custom handler (not the default `window.open()`, which an installed iOS
    // PWA silently blocks) + the shared URL regex so this desktop hover-click
    // path and the mobile tap path (`tryOpenLinkAt` → findLinkAt) open the
    // exact same spans the exact same way. See lib/terminal-links.ts.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => openExternal(uri), {
        urlRegex: LINK_URL_REGEX,
      }),
    )
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // ── Touch-drag scrollback (xterm 6.0 has NO built-in touch scroll) ─────────
    // xterm 6.0's scrollable element scrolls on WHEEL but ignores one-finger
    // touch drags (verified: touch events reach the layer but the buffer never
    // scrolls, while `term.scrollLines()` works), so mobile scrollback died after
    // the 6.0 bump. Drive it ourselves: convert a vertical drag to `scrollLines`,
    // with light inertial momentum so it feels native. `touch-action: none`
    // (globals.css) blocks the browser's own gesture and delivers every touch
    // event here. Listeners are passive (touch-action already suppresses the
    // native scroll, so no preventDefault is needed). Cleaned up via AbortSignal.
    const touchAbort = new AbortController()
    {
      const sig = touchAbort.signal
      let dragging = false
      let lastY = 0
      let lastT = 0
      let vel = 0 // px per ms (for momentum)
      let frac = 0 // sub-row px remainder carried between moves
      let momentum = 0 // rAF handle
      const cellPx = () => {
        const d = (
          term as unknown as {
            _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } }
          }
        )._core?._renderService?.dimensions?.css?.cell?.height
        return d && d > 0 ? d : fontSize * 1.2
      }
      // dyPx > 0 means the finger moved UP → scroll toward the bottom (newer).
      const scrollPx = (dyPx: number) => {
        frac += dyPx
        const rows = Math.trunc(frac / cellPx())
        if (rows !== 0) {
          frac -= rows * cellPx()
          term.scrollLines(rows)
        }
      }
      container.addEventListener(
        'touchstart',
        (e) => {
          if (e.touches.length !== 1) return
          if (momentum) {
            cancelAnimationFrame(momentum)
            momentum = 0
          }
          dragging = true
          lastY = e.touches[0].clientY
          lastT = e.timeStamp
          vel = 0
          frac = 0
        },
        { passive: true, signal: sig },
      )
      container.addEventListener(
        'touchmove',
        (e) => {
          if (!dragging || e.touches.length !== 1) return
          const y = e.touches[0].clientY
          const dy = lastY - y
          const dt = Math.max(1, e.timeStamp - lastT)
          vel = dy / dt
          lastY = y
          lastT = e.timeStamp
          scrollPx(dy)
        },
        { passive: true, signal: sig },
      )
      const endDrag = () => {
        if (!dragging) return
        dragging = false
        if (Math.abs(vel) < 0.04) return // a tap / slow release — no fling
        let v = vel
        let last = 0
        const step = (now: number) => {
          if (!last) last = now
          const dt = now - last
          last = now
          scrollPx(v * dt)
          v *= Math.pow(0.94, dt / 16) // ~6%/frame decay at 60fps
          momentum = Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0
        }
        momentum = requestAnimationFrame(step)
      }
      container.addEventListener('touchend', endDrag, { passive: true, signal: sig })
      container.addEventListener('touchcancel', endDrag, { passive: true, signal: sig })
    }

    // SD-2: track whether the viewport is scrolled up so the wrapper can show a
    // "jump to bottom" button. xterm 6.0 rewrote the viewport onto a VS Code
    // scrollable element, so the old `.xterm-viewport.scrollTop` is permanently 0
    // and its `scroll` event never fires. We track off xterm's PUBLIC,
    // renderer-independent buffer API instead: `onScroll` fires whenever the
    // viewport position changes (verified against 6.0 — it DOES fire on user
    // scroll-back, not just output growth), and `buffer.active.viewportY` vs
    // `baseY` is the current top-line vs the live bottom. "Scrolled up" = the
    // viewport sits more than a row or two above the bottom; output that follows
    // the bottom keeps them equal (no button). Start fresh each (re)subscribe so a
    // prior session's state never leaks.
    scrolledUpRef.current = false
    setScrolledUp(false)
    const syncScrolledUp = () => {
      const t = termRef.current
      if (!t) return
      const b = t.buffer.active
      const up = b.baseY - b.viewportY > SCROLL_UP_SLACK_ROWS
      if (up !== scrolledUpRef.current) {
        scrolledUpRef.current = up
        setScrolledUp(up)
      }
      // Near-top prefetch. Scrolling toward the TOP of the buffer means the user
      // is approaching the oldest replayed/fetched row. Fetch the next OLDER
      // window from tmux — the authoritative `history` frame verifies against the
      // replayed rows and, if the replay was truncated (huge/evicted history),
      // PREPENDS the missing older rows so scroll never bottoms out into a void.
      // Nothing steals the wheel (single surface), so this fires on every near-top
      // scroll. In the common (full-replay) case the fetch is a no-op augmentation.
      // (Inflight gating lives INSIDE requestOlder — including the stalled-
      // inflight re-issue after HISTORY_INFLIGHT_STALL_MS — so a lost response
      // can't permanently wedge fetching.)
      if (
        historyEnabled &&
        !histHitTop &&
        b.viewportY < HISTORY_PREFETCH_SLACK_ROWS
      ) {
        requestOlder()
      }
    }
    const scrollSub = term.onScroll(syncScrolledUp)

    // NOTE (mobile one-finger touch-scroll): xterm's OWN touchstart/touchmove
    // listeners early-return while `coreMouseService.areMouseEventsActive` is
    // true, so the scrollback can only be panned while mouse tracking is OFF.
    // `disableXtermMouseTracking(term)` above swallows the mouse-tracking DECSET
    // sequences so that flag never flips — making xterm's native one-finger pan
    // work even though Claude keeps emitting ?1000h/?1002h/?1006h (it ignores the
    // documented CLAUDE_CODE_DISABLE_MOUSE env, which is why we don't set it
    // server-side). We deliberately do NOT layer a
    // custom touch shim on top: a JS `{passive:false}` touchmove handler competes
    // with xterm's native handler and (per the reverted 7723be1/9c7657d/d2810cb
    // attempts) regressed iOS feel. In xterm 6.0 the scroll surface is the VS
    // Code `.xterm-scrollable-element`; globals.css sets `touch-action: none` on
    // it (and `.xterm`/`.xterm-viewport`) so xterm's own scrollable-element
    // handler owns the one-finger pan in the mobile focus route.

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
    // WebGL failed to construct or lost its context. xterm 6.0 REMOVED the Canvas
    // renderer, so the fallback is the built-in DOM renderer — which xterm reverts
    // to automatically the moment the WebGL addon is gone (disposed) or was never
    // loaded. So all we do is force a repaint of the existing buffer: without it an
    // idle pane (no further bytes) stays blank after the swap. Robust everywhere
    // (headless / iOS WKWebView / GPU context loss).
    const loadDomFallback = () => {
      if (disposedRef.current) return
      const t = termRef.current
      if (!t || t.cols <= 0 || t.rows <= 0) return
      repaint()
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
        // addon so xterm reverts to its built-in DOM renderer — never leave a
        // frozen/blank canvas.
        webgl.onContextLoss(() => {
          try {
            webgl.dispose()
          } catch {
            /* already disposed — harmless */
          }
          loadDomFallback()
        })
        term.loadAddon(webgl)
      } catch {
        // WebGL unavailable (no GL context / blocklisted GPU / WKWebView): fall
        // back to xterm's built-in DOM renderer (robust everywhere).
        loadDomFallback()
      }
      // 3. Re-fit so any cell-width delta the renderer swap introduced is applied
      //    in THIS same rAF, before paint — no intermediate-cols frame is ever
      //    shown. No-op when the GPU cell width matches the DOM renderer's.
      safeFit()
      // 4. Repaint so the just-attached renderer draws whatever is already in the
      //    buffer (the replay snapshot may have arrived before this rAF). Without
      //    this an idle pane can mount blank until the next live byte.
      repaint()
      // Publish the first fitted cols so a stacked history term mounts at the
      // matching width (§2.5). No-op while the flag is off.
      if (historyEnabled) setColsIfChanged(term.cols)
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

    // 2. Local echo path: pipe xterm keystrokes back to the pty. The
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
    // Android IME bridge teardown handle (assigned below when attached).
    let disposeAndroidIme: (() => void) | null = null
    if (!readOnly) {
      // ANDROID IME (GBoard et al.): xterm.js doesn't support Android soft-
      // keyboard composition (upstream #3600) — tapping an autocomplete
      // suggestion duplicated text at Claude's prompt. The bridge owns the
      // hidden-textarea → pty translation on Android (proper prefix/suffix
      // diff → DELs + replacement bytes) and blackholes the composition/input
      // events xterm would mis-handle; the keyCode-229 branch in the custom
      // key handler below keeps xterm's own composition path short-circuited.
      // Full design + known limits: lib/android-ime.ts.
      const androidIme = isAndroid()
      if (androidIme) {
        disposeAndroidIme = attachAndroidImeBridge(term, sendRaw)
      }
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
        // ANDROID IME BYPASS (lib/android-ime.ts owns the full why). Soft
        // keyboards deliver composed text under keydown keyCode 229; xterm's
        // CompositionHelper diffs the hidden textarea naively and duplicates
        // text on a suggestion tap / autocorrect. Returning false here
        // short-circuits `_keyDown` BEFORE `CompositionHelper.keydown` (which
        // would schedule its broken `_handleAnyTextareaChanges` sender) —
        // the bridge attached below translates the textarea mutations
        // instead. The browser's default edit still applies (no
        // preventDefault), so the `input` events the bridge needs keep
        // firing. Real keys (Enter 13, Backspace 8, arrows, Ctrl chords)
        // fall through to xterm's keymap untouched.
        if (androidIme && e.type === 'keydown' && e.keyCode === 229) {
          return false
        }
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
            if (sel) writeClipboard(sel)
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

    // 3. WebSocket connect with first-frame auth. No `?_token=` in URL.
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
    // Set by the `replay_done` handler to request a scroll-to-bottom that lands
    // AFTER the queued snapshot bytes are parsed (via the flush's write
    // callback) — NOT before, while they're still in the queue. A mid-stream
    // resync (the server's post-resize auto-heal / the manual refresh) re-pushes
    // the seed and re-sends `replay_done`; without this the viewport stays at the
    // TOP of the freshly-rewritten scrollback instead of the live bottom. Only
    // ever set on a snapshot boundary, so normal live streaming (where the user
    // may have scrolled up) is untouched.
    let pinBottomPending = false
    // Soft cap on the queue: rAF does NOT fire in background tabs, so a
    // backgrounded terminal that's still receiving WS bytes builds up the queue
    // until either the tab is foregrounded (rAF fires + flushes) OR the
    // setTimeout fallback below fires (1s). The cap is a sanity warning so a
    // pathological queue (e.g. a multi-minute background tab on a chatty agent)
    // surfaces in the console before memory pressure shows up elsewhere.
    // xterm.js's own internal queue caps at ~50 MB; 4 MB warns early.
    const QUEUE_WARN_BYTES = 4 * 1024 * 1024
    // Runs once a flush has actually committed bytes (xterm's write callback) —
    // or immediately when there was nothing to flush. Honours a pending
    // snapshot-boundary pin: scroll to the live bottom AFTER the snapshot is in
    // the buffer so a resync lands at the bottom, not the top of the rewritten
    // scrollback. A no-op on every normal flush (flag unset).
    const afterFlush = () => {
      if (!pinBottomPending) return
      pinBottomPending = false
      try {
        termRef.current?.scrollToBottom()
      } catch {
        /* disposed mid-pin — harmless */
      }
    }
    const flushPendingWrites = () => {
      if (writeFlushRaf !== null) {
        window.cancelAnimationFrame(writeFlushRaf)
        writeFlushRaf = null
      }
      if (writeFlushTimeout !== null) {
        window.clearTimeout(writeFlushTimeout)
        writeFlushTimeout = null
      }
      if (pendingWrites.length === 0) {
        // Nothing queued — the buffer is already current; pin now if requested.
        afterFlush()
        return
      }
      const term = termRef.current
      if (!term) {
        pendingWrites = []
        pendingBytes = 0
        afterFlush()
        return
      }
      // Fast path: a single queued frame writes directly (no copy). The write
      // callback fires after xterm has parsed the bytes — the correct moment to
      // pin the viewport to the bottom for a snapshot boundary.
      if (pendingWrites.length === 1) {
        const only = pendingWrites[0]
        pendingWrites = []
        pendingBytes = 0
        try {
          term.write(only, afterFlush)
        } catch {
          /* terminal disposed mid-flush — harmless */
          afterFlush()
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
        term.write(merged, afterFlush)
      } catch {
        /* terminal disposed mid-flush — harmless */
        afterFlush()
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
      // HIDDEN page → DEFER, don't burn attempts. Android freezes background
      // timers, so backoff retries either never run or fail against a frozen
      // network stack — the old behaviour spent all MAX_ATTEMPTS while
      // backgrounded and resumed into a dead-end `offline`. Park the intent
      // and let the visibility health-check reconnect with a fresh budget the
      // moment the page is visible again.
      if (document.visibilityState === 'hidden') {
        visibilityPendingRef.current = true
        setLiveState('reconnecting')
        return
      }
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
          // Control frames (JSON): auth_ok / replay_done / attach_meta / history.
          try {
            const msg = JSON.parse(data) as {
              type?: string
              // `history` + `attach_meta` fields (§2.2 wire shape). Optional so
              // the union covers every control frame; the branches below narrow.
              req_id?: number
              history_size?: number
              start_offset?: number
              end_offset?: number
              hit_top?: boolean
              cols?: number
              at_limit?: boolean
              rows?: string[]
              error?: boolean
            }
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
              // The server has flushed an entire snapshot (the attach seed OR a
              // mid-stream resync) and is about to resume the live fan-out. Pin
              // to the bottom AFTER the snapshot bytes are parsed: the seed is a
              // binary frame still sitting in the rAF write queue right now, so
              // we request the pin and flush — `afterFlush` (xterm's write
              // callback) scrolls once the bytes land. Without this a resync (the
              // server's post-resize auto-heal or the manual refresh) leaves the
              // viewport at the TOP of the freshly-rewritten scrollback. Then
              // REVEAL — the user never saw the replay scroll because the
              // terminal was covered (opacity-0) until now. `markReady` is a
              // one-time reveal (no-op on a resync); the bottom-pin runs every
              // time. Sent even for an empty replay, so a short/no-history
              // session reveals instantly too.
              pinBottomPending = true
              flushPendingWrites()
              markReady()
            } else if (historyEnabled && msg.type === 'attach_meta') {
              // The seam initializer, sent by the server just before `replay_done`.
              // `history_size` is tmux's authoritative scrollback depth at attach;
              // the row directly above the live screen has absolute id
              // `history_size - 1` (the seam). Re-anchor. The replay seed (sent as
              // the binary frame just before this) already carries tmux's full
              // scrollback into xterm's buffer, so we do NOT eagerly reseed here —
              // native xterm scroll already reveals it. We DO fire one
              // authoritative `history` probe so the client verifies against tmux
              // (and, for a truncated/evicted replay, begins filling the gap).
              const n = msg.history_size ?? 0
              histSizeLast = n
              histSeamAbs = n - 1
              histHitTop = n === 0
              histRows.clear()
              histOldestAbs = Infinity
              histInflightReq = null
              if (n > 0) requestOlder()
            } else if (historyEnabled && msg.type === 'history') {
              // A window of authoritative scrollback.
              // Stale reply from an earlier fling request (error or not) — a
              // newer request is live; its reply is the one that counts.
              if (msg.req_id !== histInflightReq) return
              histInflightReq = null
              if (msg.error) {
                // The capture failed server-side (frame omits size/offsets).
                // Inflight is cleared so a later scroll retries; the replayed
                // buffer already covers the near-top meanwhile.
                return
              }
              const t = termRef.current
              // Width changed mid-flight (width-match guard): the rows wrap at the
              // wrong width now. Drop the cache and refetch from the seam at the
              // current width — tmux owns the reflow, xterm never reflows history.
              // CAPPED: two concurrent viewers at different widths never converge
              // (last resize wins); after HISTORY_WIDTH_MISMATCH_MAX consecutive
              // mismatches fetching pauses until the next local resize/reconnect
              // resets the counter, instead of ping-ponging at RTT cadence.
              if (t && msg.cols !== undefined && msg.cols !== t.cols) {
                histRows.clear()
                histOldestAbs = Infinity
                histHitTop = false
                histWidthMismatches += 1
                if (histWidthMismatches < HISTORY_WIDTH_MISMATCH_MAX) {
                  requestOlder()
                }
                return
              }
              histWidthMismatches = 0
              histSizeLast = msg.history_size ?? histSizeLast
              histHitTop = msg.hit_top ?? false
              // tmux at its history-limit TRIMS oldest lines as new ones land
              // while `history_size` stays flat — absolute ids slide under the
              // cache, so cross-fetch anchors are unreliable. Degrade honestly:
              // drop the cache, keep only THIS response (self-consistent thanks
              // to the server's chained capture+re-probe), and skip the
              // gap-walk/repaint below — stitching a sliding buffer would tear.
              // Scroll depth is then bounded by the replay seed, which is still
              // the full ring (~thousands of rows), never corrupted.
              const atLimit = msg.at_limit === true
              if (atLimit) {
                histRows.clear()
                histOldestAbs = Infinity
              }
              const rows = msg.rows ?? []
              const startOffset = msg.start_offset ?? 0
              for (let i = 0; i < rows.length; i++) {
                const abs = absId(histSizeLast, startOffset + i)
                histRows.set(abs, rows[i])
                if (abs < histOldestAbs) histOldestAbs = abs
              }
              // Non-destructive: only PREPEND rows that sit ABOVE what xterm's
              // buffer already holds (the genuine gap: a history so large the
              // replay seed was truncated, or a lagging reconnect). In the common
              // replay case xterm already covers the fetched region, so this is a
              // no-op and the smooth, colour-correct replayed scroll is untouched.
              if (!atLimit && t && histOldestAbs < bufferTopAbs(t) && !histHitTop) {
                // We have a gap AND more older rows may exist — keep fetching
                // contiguously up to the buffer top region before one repaint.
                requestOlder()
              } else if (!atLimit && t) {
                fillGapAndRepaint(t)
              }
            }
          } catch {
            /* ignore non-JSON text frames */
          }
          return
        }
        // Binary frame = pty bytes (replay buffer first, then live stream). The
        // FIRST pty byte is the proof the connection is genuinely useful — only
        // now is it safe to reset the reconnect backoff.
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
        console.warn(`[supermux] ws closed code=${ev.code} reason=${ev.reason || '(none)'}`)

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
            // Permanent: auth/origin reject or explicit revocation.
            setLiveState('offline')
            return
          case CLOSE_TOO_SLOW:
            // 1013 = subscriber overflow. NOT permanent: stay `reconnecting`
            // and silently retry on the NEXT visibilitychange→visible.
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
      // A reconnect re-seeds the live screen and re-sends `attach_meta`, so the
      // seam + history cache must start clean — the fresh `attach_meta`
      // re-anchors `histSeamAbs`/`histSizeLast` and kicks a new seed walk.
      resetHistory()

      const base = wsUrl().replace(/\/$/, '')
      // A `wsPath` override (the read-only teammate route) connects there
      // instead of the session route — handshake/replay/close contract is
      // identical, so everything below is reused verbatim. The override is
      // already query-encoded by the caller.
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
     *  the peek-prewarm registry. Skips the handshake entirely: state goes
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

    // 4. ResizeObserver → debounced fit + resize round-trip.
    //
    // `clearTextureAtlas()` invalidates the WebGL/Canvas glyph cache after the
    // fit so the next paint redraws cells from scratch against the new grid.
    // This fixes the iOS-Safari ghosting where keyboard-close left stale glyphs
    // in the scrollback (the container grew but the GPU atlas + compositor
    // layer kept the pre-close pixels, visible when scrolling up). Rotation
    // never showed the bug — the canvas reallocates on a width-change and the
    // atlas is rebuilt anyway. Adding it here is the single-point fix that
    // covers every viewport shift (keyboard, rotate, iOS URL-bar collapse,
    // sidebar resize, desktop window resize). No-op on the DOM renderer
    // fallback (no atlas to clear).
    let resizeTimer: number | null = null
    // ── Keyboard-stable geometry (scrollback-duplication fix) ────────────────
    //
    // ROOT CAUSE. The soft keyboard shrinks the terminal container (Android
    // resizes-content shrinks the layout viewport; iOS gets the same shrink
    // from the route's vvHeight-driven sheet). The old path refit + resized
    // the PTY on every keyboard open/close — and a pty row-count change makes
    // tmux AND Claude's ink renderer repaint their whole screen. xterm had
    // just folded the now-hidden top rows into its scrollback, so each
    // repaint re-emitted lines that were already there: every keyboard cycle
    // DUPLICATED a screenful of lines near the end of the scrollback (and
    // reflow churn could swallow others).
    //
    // THE FIX. A HEIGHT-ONLY container change while the keyboard is open (or
    // opening) keeps the pty geometry untouched. The xterm element keeps its
    // full-height grid; we bottom-anchor it with a negative top margin so the
    // CURSOR AREA stays visible above the keyboard and the hidden rows are
    // clipped by the wrapper's overflow-hidden — a pure-visual crop, zero pty
    // traffic, zero tmux/ink redraw, zero scrollback damage. On keyboard
    // close the margin clears and the normal fit runs — geometry is identical
    // to before the keyboard, so FitAddon no-ops and nothing redraws.
    //
    // A WIDTH change is never keyboard-driven (rotation, split-screen, font
    // resize) → always takes the full fit + pty-resize path, even mid-
    // keyboard. The pty resize is also SKIPPED when fit() lands on the same
    // cols/rows as last sent — a same-size `refresh-client` still makes tmux
    // schedule a redraw on some configs, which is exactly the churn this fix
    // exists to avoid.
    let lastSentCols = 0
    let lastSentRows = 0
    // Width at the last FULL fit — 0 until then, so the first observer pass
    // always takes the full-fit path regardless of keyboard state.
    let lastFitWidth = 0
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        const f = fitRef.current
        const t = termRef.current
        if (!f || !t) return
        const el = t.element
        const widthChanged =
          Math.abs(container.clientWidth - lastFitWidth) >= 1
        if (keyboardOpenRef.current && el && !widthChanged) {
          // Keyboard-driven height change → bottom-anchor, keep the grid.
          const delta = Math.round(el.offsetHeight - container.clientHeight)
          el.style.marginTop = delta > 0 ? `-${delta}px` : ''
          return
        }
        if (el) el.style.marginTop = ''
        try {
          f.fit()
          t.clearTextureAtlas()
        } catch {
          return
        }
        lastFitWidth = container.clientWidth
        const geometryChanged = t.cols !== lastSentCols || t.rows !== lastSentRows
        if (geometryChanged) {
          lastSentCols = t.cols
          lastSentRows = t.rows
          resize(t.cols, t.rows)
        }
        // Mirror cols out (exposed for parity; harmless when unused).
        if (historyEnabled) setColsIfChanged(t.cols)
        // With the flag on, a WIDTH change invalidates the cached FETCHED history
        // rows (tmux reflowed them at a different width). xterm reflows its own
        // replayed scrollback natively. DROP the fetched cache and re-probe from
        // the seam at the new width so a subsequent scroll-up re-fetches at the
        // correct width — tmux owns the reflow, xterm never reflows fetched rows.
        if (historyEnabled && geometryChanged) {
          histRows.clear()
          histOldestAbs = Infinity
          histHitTop = histSizeLast === 0
          histInflightReq = null
          histWidthMismatches = 0 // a real local resize legitimizes a retry
          if (histSizeLast > 0) requestOlder()
        }
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(container)

    // 5. Resume health-check. Fires on visibilitychange→visible, pageshow
    //    (bfcache restore) and network `online`. Reconnects when:
    //      • a reconnect was parked while hidden (1013 overflow, or any close
    //        deferred by scheduleReconnect's hidden guard), OR
    //      • the socket is missing / not OPEN / never authed (covers the
    //        `offline` dead-end after burned attempts — resume gets a fresh
    //        budget), OR
    //      • the page was hidden past RESUME_STALE_MS — Android suspends the
    //        network without closing sockets, so after a long background the
    //        local WS still CLAIMS readyState OPEN while the server reaped the
    //        subscription long ago (20s ping / 30s deadline). readyState is a
    //        lie there; reconnect proactively. A short blip (≤ the ceiling)
    //        keeps its socket: if the server reaped it anyway, the close now
    //        arrives while VISIBLE and the normal backoff path heals it.
    //    `stopped` stays terminal — the pty is gone; resume can't revive it.
    const hiddenAtRef = { current: null as number | null }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now()
        return
      }
      if (disposedRef.current) return
      if (stateRef.current === 'stopped') return
      const hiddenFor =
        hiddenAtRef.current === null ? 0 : Date.now() - hiddenAtRef.current
      hiddenAtRef.current = null
      const ws = wsRef.current
      const socketLooksDead =
        !ws || ws.readyState !== WebSocket.OPEN || !authedRef.current
      const needsReconnect =
        visibilityPendingRef.current ||
        socketLooksDead ||
        hiddenFor > RESUME_STALE_MS
      if (!needsReconnect) return
      const now = Date.now()
      if (now - lastVisibleAtRef.current < VISIBILITY_DEBOUNCE_MS) return
      lastVisibleAtRef.current = now
      visibilityPendingRef.current = false
      attemptRef.current = 0
      // Retire a zombie that still claims OPEN before dialing a fresh socket —
      // with its handlers dropped first so its eventual close can't schedule a
      // competing reconnect.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close(CLOSE_UNMOUNT, 'stale-resume')
        } catch {
          /* already closing */
        }
        wsRef.current = null
      }
      connect()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onVisibility)
    window.addEventListener('online', onVisibility)

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
    const detectKeyboard = createKeyboardOpenDetector()
    const measureKeyboard = () => {
      kbRaf = 0
      if (!visual) return
      const { open } = detectKeyboard(visual)
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
    //    (100 iterations) returns WS count to zero, no leaks.
    return () => {
      disposedRef.current = true
      window.cancelAnimationFrame(raf)
      touchAbort.abort() // remove the touch-drag scroll listeners + any momentum
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onVisibility)
      window.removeEventListener('online', onVisibility)
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
      scrollSub.dispose()
      disposeAndroidIme?.()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Re-subscribe ONLY when the target session changes (or the embed's font
    // geometry changes). The imperative callbacks are ref-stable so they don't
    // belong in deps. `prewarmSeed` is read once at mount (it's a boolean
    // capability, not a per-render input) so it's omitted from the deps to
    // avoid re-subscribing if a parent toggles it on/off.
    // `wsPath` IS in the deps: changing the target pane (teammate switch)
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
    resync,
    copyAll,
    copySelection,
    retry,
    focus,
    blur,
    tryOpenLinkAt,
    scrolledUp,
    scrollToBottom,
    historyEnabled,
    cols,
  }
}
