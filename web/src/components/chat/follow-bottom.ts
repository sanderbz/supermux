// Follow-bottom, DEFERRED while the reader holds a selection in the transcript.
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. The chat panel keeps the view pinned to the newest message by
// writing `el.scrollTop` on the transcript scroller — and it does so on EVERY
// render: a new confirmed row, the live layer redrawing, the composer's reserve
// growing, and the ~1s peek-poll tick (`use-peek-lens.ts`) while the agent is
// idle. WebKit (iOS AND desktop Safari) treats a programmatic `scrollTop=` on the
// scroller a selection lives in as the END of the selection gesture: the native
// Copy/Look-Up/Share callout is dismissed and the highlight collapses. So a
// reader who long-presses a message to copy it loses the selection a beat later —
// "as if some JS keeps deselecting", which is exactly what it was.
//
// `selection.ts` documents the other half of this (`selectionInChatTrack`): the
// scroll-follow effect already STANDS DOWN while a selection is held, so the
// highlight survives the tick. What was missing is the RESUME: once the effect
// declines to scroll, nothing re-ran it when the selection finally cleared, so
// after copying, a reader who had drifted below the live bottom stayed stuck
// scrolled up until the next unrelated render happened to move the view. With the
// idle peek poller now holding byte-identical frames, that render may not come
// for a while.
//
// THE TRADE (the same one `LiveElapsed` and the provisional tail already make):
// while a selection is held in a `[data-chat-track]`, DEFER the programmatic
// scroll — the transcript CONTENT still arrives and renders, only the SCROLL is
// held — and RESUME it the instant the selection clears, so the reader snaps back
// to the live bottom the moment the copy is done and is never left stuck
// scrolled up. An EXPLICIT jump-to-bottom tap is a user gesture that must land
// immediately and collapses no selection worth keeping; it does NOT route here.

import * as React from 'react'

import { selectionInChatTrack } from './selection'

/** Perform an auto-follow scroll now, or defer it until the selection clears.
 *  Returns true if it ran synchronously, false if it was deferred. */
export type FollowFn = (write: () => void) => boolean

/**
 * A follow-bottom gate that defers the programmatic scroll while a reader holds
 * a selection in the chat transcript, and flushes the LATEST deferred scroll the
 * moment that selection clears.
 *
 * The write is a THUNK, not a value: it is re-invoked at resume time so it reads
 * the transcript's CURRENT height — messages that arrived during the copy are
 * already in the DOM, so the resumed scroll lands at the true live bottom, not a
 * stale one. Only the most recent deferred follow is kept (an older pending
 * bottom is always superseded by a newer one).
 */
export function useDeferredFollow(): FollowFn {
  // The most recent auto-follow deferred because a selection was held. Replaced
  // each time it is superseded; run and cleared when the selection clears.
  const pendingRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => {
    const onSelectionChange = () => {
      const run = pendingRef.current
      if (!run) return
      // Still selecting inside a track → keep deferring (guards the loop: our own
      // scroll write never lands here, and a selection that merely MOVED inside a
      // track leaves the pending follow parked, not flushed).
      if (selectionInChatTrack()) return
      pendingRef.current = null
      run()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  return React.useCallback((write: () => void): boolean => {
    if (selectionInChatTrack()) {
      pendingRef.current = write
      return false
    }
    // A follow that runs un-deferred supersedes any stale pending one.
    pendingRef.current = null
    write()
    return true
  }, [])
}
