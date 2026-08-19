// The live "Ns" elapsed clock — the ONE thing on this surface that changes
// because time passed rather than because something happened.
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS ITS OWN MODULE, AND WHY IT IS IMPERATIVE.
//
// The chat's live band sits INSIDE the reader-selectable track
// (`chat-surface.tsx`'s `[data-chat-track]` wraps both the confirmed transcript
// and the live layer), so a drag-select that reaches from a confirmed message
// down into the band ends inside this clock. Before this module the clock was a
// plain string prop: every second a `setInterval` re-rendered its owner, React
// wrote a new value into the elapsed span, and the TEXT NODE THE SELECTION WAS
// ANCHORED IN WAS REPLACED. WebKit (iOS Safari and desktop Safari alike)
// answers a replaced anchor node by COLLAPSING the whole selection; Chromium
// re-clamps it to the surviving text (the offline rig measured that as a
// 142→125 char truncation). Either way the reader's highlight died within a
// second and copy-paste was impossible — the bug commit 71ad8d4 froze the clock
// to work around.
//
// This component removes the cause instead of freezing the symptom, on three
// properties that have to hold together:
//
//   1. `React.memo` + CONSTANT render output. The text this returns is captured
//      once, at first render, and never changes afterwards — so neither a
//      parent re-render (memo bails on stable props) nor a props change (React
//      diffs the same string) ever makes React touch the child. React can not
//      replace what it never rewrites, so no ancestor's render — however often
//      it happens — can move the node a selection is anchored in.
//   2. `text.nodeValue = …`, never `textContent`/`innerHTML`. Assigning
//      `nodeValue` MUTATES the existing Text node in place, so node IDENTITY is
//      preserved: the Range still points at a node that is in the document, and
//      WebKit has no removed node to collapse the selection over. Assigning
//      `textContent` on the ELEMENT would destroy the child and create a new one
//      — exactly the swap this module exists to avoid — which is why the initial
//      child is a non-empty string: `firstChild` must always be a real Text node
//      to mutate.
//   3. THE GUARD IS STILL LOAD-BEARING, and 1+2 are what make it cheap. Node
//      identity is not the whole story: per the DOM spec a `nodeValue` write is
//      `replaceData(0, length, …)`, and a boundary point INSIDE the replaced run
//      is clamped to offset 0 — measured in the offline Chromium rig as a
//      741→738 char selection (the clock's own three digits dropped, once, then
//      stable; before this refactor the same rig lost them and kept re-clamping
//      on every render). So the write stands down while a selection is held in a
//      chat track, and now that is all it costs: ONE skipped `nodeValue`
//      assignment, not a skipped re-render of the whole panel.
//
// The consequence for the rest of the surface is the point: nothing that owns
// this clock has to re-render for it to advance, so the message list is never
// on a cosmetic cadence, and the guard no longer has to be wired into anything
// that renders.
//
// LAYER: this is a DATA-layer module (it reads `latency`/`entries`), which is
// why it does not live in `components/chat/ui/*` — those primitives stay pure
// and take the clock as a `ReactNode` slot.

import * as React from 'react'

import { formatElapsed } from './entries'
import { serverNowMs } from './latency'
import { selectionInChatTrack } from './selection'

/** How long a turn runs before it is worth putting a number on. The P12 ladder
 *  (working-row.tsx) shows no clock under this: a fast turn that prints
 *  1s, 2s, 3s feels slow. One definition, both clocks. */
export const ELAPSED_AFTER_MS = 5_000

/** What the clock says at `ms` elapsed — the empty rung is a SPACE, never '',
 *  so the Text node exists to be mutated later (see the header). */
function elapsedText(ms: number, afterMs: number): string {
  return ms >= afterMs ? formatElapsed(ms) : ' '
}

/**
 * Has this turn run long enough for the clock to be ON SCREEN yet?
 *
 * The P12 ladder's first rung is a LAYOUT fact, not a text fact: under 5s the
 * elapsed slot is not rendered at all, so the row has no `ml-auto` cell and no
 * `gap` reserved for one (a clock that merely printed an empty string would
 * still steal 13px from the label's truncation width, which is not the layout
 * the boards were approved from). So the rung stays where it was — an owner
 * decision about whether to render the slot — and this hook flips it with ONE
 * edge-scheduled `setTimeout` instead of the per-second tick that used to
 * re-evaluate it.
 *
 * One re-render per turn, at the 5s mark, scoped to the row that owns the clock.
 * After that the digits advance inside `LiveElapsed` with no render at all.
 */
export function useElapsedShown(
  turnStartMs: number | null | undefined,
  afterMs: number = ELAPSED_AFTER_MS,
): boolean {
  const [, bump] = React.useReducer((n: number) => n + 1, 0)
  const shown = turnStartMs != null && serverNowMs() - turnStartMs >= afterMs
  React.useEffect(() => {
    if (turnStartMs == null || shown) return
    // Floored so a clock that is somehow still short of the rung when the
    // timeout lands re-arms at 50ms rather than spinning.
    const wait = Math.max(50, turnStartMs + afterMs - serverNowMs())
    const id = window.setTimeout(bump, wait)
    return () => window.clearTimeout(id)
  }, [turnStartMs, afterMs, shown])
  return shown
}

export interface LiveElapsedProps {
  /** Turn anchor in SERVER-clock ms (`latency.ts::serverNowMs`'s domain), so
   *  the number counts from the SEND and not from whenever this mounted. */
  turnStartMs: number
  /** The rung at which the number appears. Defaults to `ELAPSED_AFTER_MS`. */
  afterMs?: number
  className?: string
}

export const LiveElapsed = React.memo(function LiveElapsed({
  turnStartMs,
  afterMs = ELAPSED_AFTER_MS,
  className,
}: LiveElapsedProps) {
  const ref = React.useRef<HTMLTimeElement | null>(null)
  // The ONE string React will ever render here. Computed on the first render so
  // static markup (the unit bench, `renderToStaticMarkup`) and the first painted
  // frame both carry the true elapsed — the effect below owns every value after
  // that, and deliberately renders the SAME string forever so React's child
  // diff is always a no-op.
  const [frozen] = React.useState(() => elapsedText(serverNowMs() - turnStartMs, afterMs))

  React.useEffect(() => {
    const write = () => {
      const text = ref.current?.firstChild
      if (!text) return
      // The held-selection guard (see header §3). A `nodeValue` write clamps a
      // Range boundary that sits inside the digits, so the clock stands down
      // while the reader has something selected in a chat track and resumes at
      // the true server-clock elapsed the moment the selection clears — the same
      // trade the follow-bottom pin already makes, for the few seconds a copy
      // takes. The cost is now one skipped assignment rather than a skipped
      // render, and NOTHING but this line depends on it.
      if (selectionInChatTrack()) return
      text.nodeValue = elapsedText(serverNowMs() - turnStartMs, afterMs)
    }
    write()
    const id = window.setInterval(write, 1000)
    // A backgrounded tab throttles the interval; catching up on the way back is
    // one write, and it costs nothing while hidden.
    const onVisible = () => {
      if (!document.hidden) write()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [turnStartMs, afterMs])

  return (
    <time ref={ref} className={className}>
      {frozen}
    </time>
  )
})

export default LiveElapsed
