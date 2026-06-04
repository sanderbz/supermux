// useKeyboardCapture — desktop keyboard capture.
//
// REAL keyboard capture: a single document-level `keydown` listener, registered
// in a useEffect on mount and removed on unmount. It intercepts the focus-
// route-only global shortcut bank:
//
//   ⌘/Ctrl+D  → Detach (navigate to overview, session kept alive)
//   ⌘/Ctrl+W  → Stop session, then leave
//   ⌘/Ctrl+G  → Show last prompt (feat-last-prompt)
//   ⌘/Ctrl+1..9 → jump to the N-th session in the strip
//
// ⌘/Ctrl+K is intentionally NOT handled here — the global <CommandPalette> in
// <Layout> owns that shortcut so it works on every route, not just /focus.
//
// EVERY other key flows through to xterm: we do NOT preventDefault, so xterm's
// own `onData` hook carries Ctrl-C, arrows, Tab, Shift+Tab/BTab, Esc,
// printable text, IME composition — all of it — straight to the pty. Capturing
// Ctrl-C/Tab here would break the terminal, which is the whole point.

import * as React from 'react'

export interface KeyboardCaptureHandlers {
  /** ⌘/Ctrl+D — detach. */
  onDetach: () => void
  /** ⌘/Ctrl+W — stop + leave. */
  onStop: () => void
  /** ⌘/Ctrl+1..9 — jump to the N-th (1-indexed) session row. */
  onJump: (index: number) => void
  /** ⌘/Ctrl+G — toggle the last-prompt recall popover (feat-last-prompt).
   *  Optional: when omitted (or when the current session has no last send),
   *  the shortcut is a no-op so we never preventDefault on a key we can't
   *  service. */
  onShowLastSend?: () => void
}

/** Register the global-shortcut keydown capture for the lifetime of the focus
 *  route. Handlers are read through a ref so the listener is installed exactly
 *  ONCE per mount (no re-add churn on every render). */
export function useKeyboardCapture(handlers: KeyboardCaptureHandlers): void {
  const ref = React.useRef(handlers)
  // Keep the handler ref current without mutating during render (so the listener
  // is installed exactly once per mount, yet always calls the latest closures).
  React.useEffect(() => {
    ref.current = handlers
  })

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Only the Cmd (macOS) / Ctrl (others) modifier bank is global. Plain keys
      // — Ctrl-C, arrows, Tab, Shift+Tab, Esc, text — are NOT touched here so
      // they reach xterm verbatim.
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      // Let other modifier combos (Shift/Alt with Cmd) pass to the terminal.
      if (e.altKey) return

      const key = e.key.toLowerCase()

      // ⌘/Ctrl+K is owned by the global <CommandPalette> (Layout). We do NOT
      // touch it here — let the shell handler fire so it works identically on
      // every route, not only inside the focus split.
      if (key === 'd') {
        e.preventDefault()
        ref.current.onDetach()
        return
      }
      if (key === 'w') {
        e.preventDefault()
        ref.current.onStop()
        return
      }
      if (key === 'g' && ref.current.onShowLastSend) {
        e.preventDefault()
        ref.current.onShowLastSend()
        return
      }
      // Cmd/Ctrl+1..9 → jump to that session row.
      if (key >= '1' && key <= '9') {
        e.preventDefault()
        ref.current.onJump(Number(key) - 1)
        return
      }
      // Any other Cmd/Ctrl combo (copy/paste/reload/devtools…) is left to the
      // browser / xterm — we never blanket-swallow modifier keys.
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}
