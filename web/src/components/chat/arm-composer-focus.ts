// The CHAT direction of the focus arming — the mirror of the terminal's
// `wantFocusRef` effect in `focus-mode/desktop-split.tsx` / `routes/focus/mobile.tsx`.
//
// WHY THIS EXISTS. Only one half of the toggle ever armed focus. Revealing the
// terminal calls `term.focus()` on the next frame, so a toggle to Terminal ends
// with the caret in the pty. Revealing CHAT armed nothing: `document.activeElement`
// was `<body>`, so the surface the user had just asked for could not be typed
// into at all. Every leading character went to the document — where the global
// renderer hotkey lives, so the first `t` flipped the surface back to Terminal
// and the rest of the sentence was typed into the agent's pty. (The two guards
// that close that injection path are in `renderer-shell.tsx` and
// `use-live-term.ts`; this one is what makes the chat surface usable.)
//
// TWO RULES.
//
//  · COARSE POINTERS ARE EXEMPT. Focusing a textarea on a phone summons the
//    soft keyboard, which eats half the viewport. Nobody asked for that by
//    tapping a renderer switch, so on `pointer: coarse` the toggle leaves the
//    caret alone and the keyboard appears when the user taps the composer.
//  · NEVER STEAL A CARET. The retry loop aborts the moment anything else owns
//    focus — a Tab into the dock input, a click on the header. It arms focus
//    that is nowhere; it does not move focus that is somewhere.
//
// The retry loop is there because the chat panel is a LAZY chunk: at the moment
// `chatActive` flips there is usually no composer in the DOM yet, so a single
// rAF would land on nothing. `focusComposer` reports whether it found a field,
// and we try again next frame until it does or the window closes.

import * as React from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'

import { focusComposer } from './composer-draft'

/** How long the arm keeps retrying while the lazy chat chunk loads. Generous
 *  enough for a cold chunk fetch on a slow link, short enough that it can never
 *  be mistaken for a focus grab seconds after the user moved on. */
export const ARM_WINDOW_MS = 3_000

/** The renderer switch's own cells (`chat/renderer-switch.tsx`). A click leaves
 *  focus on the tab that was pressed, and that tab is precisely the control
 *  asking for the chat surface — so it HANDS the caret on rather than keeping
 *  it. (The terminal direction has always done the same, less politely: it
 *  calls `term.focus()` unconditionally.) */
const SWITCH_CELLS = new Set(['renderer-chat', 'renderer-terminal', 'renderer-auto'])

/** Is `el` a real focus owner — something whose caret would be rude to take? */
function ownsFocus(el: Element | null): boolean {
  if (el == null || el === document.body || el === document.documentElement) return false
  const id = el.getAttribute('data-testid')
  return id == null || !SWITCH_CELLS.has(id)
}

/**
 * Arm composer focus for the chat direction of the renderer toggle.
 *
 * Keyed on `[name, chatActive]` exactly like the terminal's effect, so entering
 * a session under chat arms it once, revealing chat later arms it again, and an
 * unrelated re-render arms nothing.
 */
export function useArmComposerFocus(name: string, chatActive: boolean): void {
  const coarse = useMediaQuery('(pointer: coarse)')
  React.useEffect(() => {
    if (!chatActive || coarse) return
    let raf = 0
    const deadline = Date.now() + ARM_WINDOW_MS
    const tick = () => {
      if (ownsFocus(document.activeElement)) return
      if (focusComposer(name)) return
      if (Date.now() > deadline) return
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [name, chatActive, coarse])
}
