// usePeekType — type-on-hover for the overview-tile live-zoom peek.
//
// While a hover-peek is OPEN for a tile, this hook installs a single
// document-level `keydown` listener and forwards qualifying keystrokes to the
// peeked session's pty via callbacks the caller wires to the same imperative
// `send`/`sendKey` surface the `useLiveTerm` already exposes (no new WS
// protocol — same wire the focus terminal uses).
//
// PROVENANCE: v2 shipped this exact pattern under the name "type-on-hover" —
// proven UX for quick interjections ("go on", "stop", Enter, Esc) without
// leaving the overview. Click on a tile is unchanged (still navigates to focus
// view); we deliberately do NOT introduce a click-to-engage promote step.
//
// SAFETY (non-negotiable — failure modes here would be catastrophic):
//   1. If `document.activeElement` is an INPUT / TEXTAREA / contenteditable /
//      or any naturally-typing element → DO NOT capture. Pass through.
//   2. Browser/app shortcuts (Cmd+K, Cmd+R, Cmd+L, Cmd+W, Cmd+T, Cmd+S, Cmd+F,
//      Cmd+number, F-keys, devtools) → NEVER sent to the pty. Let the browser
//      handle them.
//   3. Tab and arrow keys are routed to the pty ONLY AFTER engagement
//      (`claimed` — the user has typed at least one printable character).
//      Before engagement they're left to the page (so the user can still tab
//      around without us hijacking it). After engagement, ↑/↓/←/→, Tab, and
//      Shift+Tab all flow to the pty so the user can navigate a claude menu
//      (yes/no, multi-choice list) without leaving the peek for focus view.
//
// STICKINESS: the first captured printable keystroke flips a `claimed` flag
// with a sliding ~4s timer. While claimed, the caller's `onActivity` fires on
// every keystroke (reset the dismiss timer); the caller suppresses
// hover-leave dismissal so mouse drift can't kill a half-typed message. After
// the timer elapses with no keys (and the mouse has left the peek), the caller
// releases + dismisses.
//
// Esc POLICY (a) — Esc CLOSES the peek and does NOT send to the pty. The web
// norm is that Esc dismisses popovers; users keep that mental model. To send a
// literal Esc to an agent the user moves into focus view (the keyboard there
// captures Esc verbatim). This is policy (a) from the task spec — chosen for
// simplicity and predictability over the Esc-Esc-within-300ms alternative.

import * as React from 'react'

/** Sliding stickiness window after the latest captured keystroke, used WHILE
 *  THE POINTER IS STILL IN/AROUND THE TILE. Re-evaluated on every keypress;
 *  while alive, a momentary hover-leave (mouse grazing the card edge) won't
 *  kill a half-typed message — it arms a short grace instead (see
 *  PEEK_LEAVE_GRACE_MS). 4s lands between "too short to finish a word" and
 *  "annoyingly sticky".
 *
 *  IMPORTANT (fix-peek-sticky): this is NOT the post-mouse-leave dismissal
 *  delay. A genuine mouse-leave after typing dismisses after PEEK_LEAVE_GRACE_MS,
 *  not after this full window — decoupling them is the fix for the "~4s linger
 *  after typing + leaving" bug. Do not collapse these two constants back into
 *  one. */
export const PEEK_STICKY_MS = 4000

/** Short grace after a GENUINE mouse-leave while the peek is sticky (the user
 *  just typed). The peek dismisses after this delay UNLESS a fresh keystroke
 *  re-arms it (so continuous typing with the pointer parked elsewhere keeps the
 *  peek open). Long enough to absorb a quick re-entry or an in-flight keystroke,
 *  short enough that the shrink feels prompt — the user explicitly wanted the
 *  peek to shrink "promptly" on mouse-leave, not wait out the silence window. */
export const PEEK_LEAVE_GRACE_MS = 400

export interface UsePeekTypeOptions {
  /** Master enable — the caller passes `peekOpen && desktop` etc. When false,
   *  no listener is installed (zero overhead while no peek is open). */
  enabled: boolean
  /** Send a printable character (or multi-char IME burst) to the pty. Wire to
   *  the `useLiveTerm` imperative `send` (same WS the focus term uses). */
  onText: (text: string) => void
  /** Send a named key (Enter, Tab, Arrow*, Backspace, …) to the pty. Wire to
   *  the `useLiveTerm` imperative `sendKey`. */
  onKey: (name: string) => void
  /** Close the peek — fires on Esc (policy (a): Esc dismisses, never sent). */
  onDismiss: () => void
  /** Fires whenever a keystroke was captured (used by the caller to reset the
   *  stickiness dismiss-timer and to flip the "claimed" visual). The boolean
   *  is the post-claim state: true once the first printable char has fired. */
  onActivity: (claimed: boolean) => void
}

export interface UsePeekTypeResult {
  /** Whether the peek has been engaged (at least one printable char captured).
   *  Caller uses this to (a) render the "Typing → <name>" pill, (b) suppress
   *  hover-leave dismissal, (c) allow Tab/arrow capture going forward. */
  claimed: boolean
}

/** Should the keystroke be ignored entirely because the user is plainly typing
 *  somewhere else (an input, textarea, contenteditable, …)? Pure focus-detection
 *  — does NOT consider modifier shortcuts (handled separately). */
function activeElementWantsKeys(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body || el === document.documentElement) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  // role=textbox/searchbox covers ARIA-flavoured inputs (e.g. some palettes).
  const role = el.getAttribute('role')
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true
  return false
}

/** Is this a browser/OS/app-level shortcut we MUST NOT swallow? We let it
 *  through (don't preventDefault, don't send to pty). Covers Cmd+K palette,
 *  Cmd+R reload, Cmd+L locationbar, Cmd+W close-tab, Cmd+T new-tab, Cmd+S
 *  save, Cmd+F find, Cmd+digit tab-switch, every F-key (devtools/macOS
 *  system), and any Meta/Ctrl + alphanumeric combo that the browser or app
 *  likely owns. A user pressing Cmd+K while hovering should still open the
 *  palette, not type "k" into the agent. */
function isBrowserOrAppShortcut(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey) return true
  // F1…F19 are reserved for devtools / OS / app accelerators.
  if (/^F\d+$/.test(e.key)) return true
  return false
}

/** Should Tab / arrow keys be sent to the pty? Only AFTER engagement — before
 *  the user has typed anything, leave page navigation alone (so a hovered tile
 *  doesn't steal arrow keys the user meant for browser/page focus traversal).
 *  Post-engagement these flow to the pty so claude-style menus are navigable
 *  from the peek without bouncing into focus view. */
const NAV_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

const KEY_TO_NAMED: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
}

export function usePeekType(opts: UsePeekTypeOptions): UsePeekTypeResult {
  const [claimed, setClaimed] = React.useState(false)
  // Keep all callbacks in a ref so the document listener is installed exactly
  // ONCE per `enabled` cycle (no re-add churn on every render / callback id).
  const optsRef = React.useRef(opts)
  React.useEffect(() => {
    optsRef.current = opts
  })

  // `claimed` lives in state (for re-render) AND in a ref (for synchronous
  // reads inside the listener, which doesn't re-bind on each render). The ref
  // is also our reset surface — the listener-install effect clears it
  // synchronously when a fresh peek opens, and the state catches up the next
  // time the listener mutates it. We never call `setClaimed` from inside an
  // effect body (cascading-renders lint rule); state only changes in response
  // to a real keystroke or the deferred reset rAF below.
  const claimedRef = React.useRef(false)
  React.useEffect(() => {
    claimedRef.current = claimed
  }, [claimed])

  React.useEffect(() => {
    if (!opts.enabled) {
      // Defer state reset to the next frame so we don't synchronously enqueue
      // a render from inside an effect body. Safe because no listener is
      // attached while disabled — nothing reads `claimed` until re-enable.
      claimedRef.current = false
      const id = window.requestAnimationFrame(() => setClaimed(false))
      return () => window.cancelAnimationFrame(id)
    }

    // Fresh peek opening: ensure the ref starts clean (state catches up on
    // first keystroke or the rAF in the disable branch above).
    claimedRef.current = false

    function onKeyDown(e: KeyboardEvent) {
      // ── Safety filter 1: focus pass-through ─────────────────────────────
      // If the user is in any input-shaped element, leave them entirely alone.
      // This is the catastrophic failure mode we MUST prevent — the search box,
      // a settings sheet input, the command palette MUST keep their keystrokes.
      if (activeElementWantsKeys()) return

      // ── Safety filter 2: browser / app shortcuts ────────────────────────
      // Esc is its own thing (handled below) so check shortcut FIRST and let
      // Esc fall through to the dismiss branch.
      if (e.key !== 'Escape' && isBrowserOrAppShortcut(e)) return

      // ── Esc → dismiss the peek (policy a: NOT sent to pty) ──────────────
      if (e.key === 'Escape') {
        // Pre-engagement Esc still closes — the user pressed Esc clearly
        // intending to dismiss. Post-engagement same: predictable web norm.
        e.preventDefault()
        optsRef.current.onDismiss()
        return
      }

      // ── Safety filter 3: Tab / arrows gated on engagement ───────────────
      if (NAV_KEYS.has(e.key) && !claimedRef.current) return

      // ── Decode the key ──────────────────────────────────────────────────
      // Shift+Tab → BackTab (CSI Z, terminfo `kcbt`). Claude/gum/fzf menus use
      // this for "move selection up" in the reverse direction; the user's
      // muscle memory comes straight from focus mode where xterm encodes this
      // same way. We only translate post-claim (the NAV_KEYS gate above
      // already enforces that for Tab itself, so we're inside the post-claim
      // branch by the time we reach this lookup).
      let named = KEY_TO_NAMED[e.key]
      if (named === 'Tab' && e.shiftKey) named = 'BackTab'
      const isPrintable =
        !named && e.key.length === 1 && !e.altKey
      const isSendableNamed = named !== undefined

      if (!isPrintable && !isSendableNamed) return

      // Once we're sending to the pty we own the event — prevent the browser
      // from also acting (Space scroll, Backspace history-back, Tab focus
      // shift, Enter form-submit, arrow scrolling, …).
      e.preventDefault()

      if (isPrintable) {
        optsRef.current.onText(e.key)
        if (!claimedRef.current) {
          claimedRef.current = true
          setClaimed(true)
        }
        optsRef.current.onActivity(true)
        return
      }

      if (isSendableNamed) {
        // Post-claim: arrows / Tab / Shift+Tab / Enter / Backspace / Page* /
        // Home / End all flow through `sendKey` → `keyToBytes` → the SAME
        // WS the focus terminal uses. So ↓/↑ on a claude option menu (or
        // ←/→ on a yes/no prompt) navigates exactly as it would in focus view.
        optsRef.current.onKey(named)
        // Named keys also count as activity — they're not "engagement" on
        // their own, but they DO reset the stickiness window so a slow editor
        // doesn't dismiss mid-edit.
        optsRef.current.onActivity(claimedRef.current)
      }
    }

    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [opts.enabled])

  return { claimed }
}
