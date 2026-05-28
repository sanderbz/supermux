// usePasteToTerminal — read the OS clipboard and stream it into the focused pty.
//
// Pasting a token/secret on a phone is awkward (no Cmd/Ctrl+V on a soft
// keyboard), so the dock's Paste control + the quick-keys "Paste" entry both call
// this. It reuses the EXISTING terminal text path (`send(text)` → the {type:
// 'input'} WS frame keystrokes use) — no new wire. The text is sent WITHOUT a
// trailing '\r' so a pasted value lands at the prompt without auto-submitting.
//
// The Clipboard API rejects on denied permission / no transient activation /
// (on some platforms) an empty buffer. Every failure mode is swallowed into a
// small toast — the dock never throws.

import * as React from 'react'

import { useToast } from '@/components/ui/use-toast'

/** Returns a stable `paste()` callback: read the clipboard, send it to the
 *  terminal via `send`, and surface a toast on empty/denied. `send` is the SAME
 *  imperative `useLiveTerm.send` the dock/dictation/snippets funnel through. */
export function usePasteToTerminal(
  send: (text: string) => void,
): () => void {
  const { toast } = useToast()
  return React.useCallback(() => {
    // Must run synchronously inside the tap gesture: iOS only grants clipboard
    // read while the page has transient activation from a real user action.
    const clipboard = navigator.clipboard
    if (!clipboard?.readText) {
      toast({ message: 'Clipboard not available', tone: 'error' })
      return
    }
    void clipboard
      .readText()
      .then((text) => {
        if (!text) {
          toast({ message: 'Clipboard empty' })
          return
        }
        send(text)
      })
      .catch(() => {
        toast({ message: 'Clipboard permission needed', tone: 'error' })
      })
  }, [send, toast])
}
