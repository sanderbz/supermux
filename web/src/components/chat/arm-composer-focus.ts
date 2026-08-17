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

/**
 * Is `el` a real KEYBOARD owner — something whose caret would be rude to take?
 *
 * The predicate used to be "anything that is not `<body>`", and that is what let
 * the blocker through: a click on the transcript background parks focus on the
 * route's `<main>` (a `tabindex="-1"` landing pad for the skip link), which is
 * not `<body>`, so the arm aborted and the surface was left with a caret that
 * goes NOWHERE. Keys typed into a container like that reach the DOCUMENT — which
 * is exactly where the global `t` renderer hotkey listens.
 *
 * So the question is not "is something focused" but "would a keystroke land
 * somewhere". Fields, contenteditables and the interactive roles say yes; a
 * `tabindex="-1"` container says no.
 */
export function ownsKeyboard(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el === document.body || el === document.documentElement) return false
  // The renderer switch HANDS the caret on: the cell that was clicked is the
  // control asking for the chat surface, so keeping the focus would be the
  // toggle refusing its own request.
  const id = el.getAttribute('data-testid')
  if (id != null && SWITCH_CELLS.has(id)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'BUTTON' || (tag === 'A' && el.hasAttribute('href'))) return true
  const role = el.getAttribute('role')
  if (
    role === 'textbox' ||
    role === 'searchbox' ||
    role === 'combobox' ||
    role === 'button' ||
    role === 'link' ||
    role === 'tab' ||
    role === 'menuitem' ||
    role === 'option' ||
    role === 'checkbox' ||
    role === 'switch'
  ) {
    return true
  }
  const tabindex = el.getAttribute('tabindex')
  return tabindex != null && tabindex !== '-1'
}

/** Did this event happen inside THIS session's chat surface? `data-surface` +
 *  `data-session` are `chat-surface.tsx`'s own root attributes, so a desktop
 *  split with two chat panes arms each pane from its own clicks only. */
function inChatSurface(target: EventTarget | null, name: string): boolean {
  if (!(target instanceof Element)) return false
  const surface = target.closest('[data-surface="chat"]')
  return surface != null && surface.getAttribute('data-session') === name
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
    // SYNCHRONOUS FIRST ATTEMPT, then the retry loop. The first attempt used to
    // be deferred a frame as well, which is a race the user wins: a click that
    // drops the caret is immediately followed by typing, and a character that
    // arrives before the rAF is a character at the DOCUMENT — where the hotkey
    // lives. Once the panel is mounted the composer is already in the DOM, so
    // the synchronous attempt succeeds and the loop never runs.
    const arm = () => {
      window.cancelAnimationFrame(raf)
      const deadline = Date.now() + ARM_WINDOW_MS
      const tick = () => {
        if (ownsKeyboard(document.activeElement)) return
        if (focusComposer(name)) return
        if (Date.now() > deadline) return
        raf = window.requestAnimationFrame(tick)
      }
      tick()
    }
    arm()

    // THE EDGE IS NOT ENOUGH — this is the second half of the blocker.
    //
    // Arming only on `[name, chatActive]` meant the caret was placed once and
    // never taken back. Every later way to lose it — a click on the transcript
    // background, Escape out of a popover, closing a sheet — left the chat
    // surface on screen with focus parked on a non-focusable container, and the
    // next sentence went to the document: the first `t` flipped the renderer and
    // the rest was typed at the agent's `❯`.
    //
    // So the arm re-runs on any focus change or click INSIDE this session's chat
    // surface. `ownsKeyboard` above is what keeps that from being a focus grab:
    // clicking a button, a link or another field inside the panel leaves that
    // control alone; only focus that would swallow keystrokes is replaced.
    const rearm = (e: Event) => {
      if (!inChatSurface(e.target, name)) return
      // A drag-select in the transcript ends in a `click`, and focusing a
      // textarea collapses the document selection — so a user reading and
      // copying output would lose the selection they just made.
      const sel = window.getSelection?.()
      if (sel && !sel.isCollapsed) return
      if (ownsKeyboard(document.activeElement)) return
      arm()
    }
    document.addEventListener('focusin', rearm, true)
    document.addEventListener('click', rearm, true)
    return () => {
      window.cancelAnimationFrame(raf)
      document.removeEventListener('focusin', rearm, true)
      document.removeEventListener('click', rearm, true)
    }
  }, [name, chatActive, coarse])
}
