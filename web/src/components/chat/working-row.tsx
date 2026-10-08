// P12 working row — the DATA half (fase A3 T4).
//
// Two files, one name, one job each: `ui/working-row.tsx` decides what this
// looks like, and this one decides what it SAYS. Driven by the SSE status flip
// (206ms p50) + the live hook label; NEVER the transcript.
//
// The §4.2 P12 state ladder, and what each rung is worth:
//   0s    face + dots + the hook label, no number — a turn that has barely
//         started does not need a clock, and showing 1s, 2s, 3s makes a fast
//         turn feel slow.
//   5s    the elapsed clause appears (`ELAPSED_AFTER_MS`), counted from the
//         SEND (`turnStartMs`, server clock) rather than from mount, so a panel
//         opened mid-turn does not restart the number.
//   30s   unchanged — the row is already saying everything it knows.
//   >120s the stranded-turn teardown, which lives in `use-chat-turn.ts` where
//         the turn does; this component just stops being rendered.
//
// THE AGENT LIST (subagent visibility). During a fan-out this surface used to
// show a spinner, `· N subagents` and nothing else, while the terminal showed
// the work — and the number itself came from a count a lost `SubagentStop` can
// pin. The clause now counts `session.agents`, rows that exist only because a
// hook carrying that agent's own id arrived, and it is also the control that
// opens them. Three rules it lives by:
//
//   · COLLAPSED BY DEFAULT, and not persisted. A remembered "expanded" is itself
//     a stale affordance next turn, when the children are different ones.
//   · NOTHING RE-RENDERS PER SECOND. Each row's elapsed is a `LiveElapsed` leaf
//     mutating its own text node — the `TICKING_ROSTER` regression class was a
//     per-second repaint pinning a session Active, and no per-agent update may
//     reach the status classifier. The live→quiet dim is the one thing this row
//     re-renders for on its own, and it is an EDGE (one `setTimeout` at the
//     transition), not a tick.
//   · IT IS DISPLAY-ONLY, all the way down. Nothing here is read by
//     `use-chat-turn.ts`; `tests/unit/subagent-display-only.test.ts` pins that.
//
// Import rule: relative only (the unit runner resolves no `@/` paths) and
// `components/chat/ui` is imported from here, never the reverse.

import { motion, useReducedMotion } from 'framer-motion'
import * as React from 'react'

import type { MarkPin } from '../../brand/marks'
import { SUBAGENTS } from '../../brand/copy'
import type { AgentRow } from '../../lib/api/sessions'
import { subagentsClause } from '../../lib/mark-status'
import { motionOff, springs } from '../../lib/springs'
import { cn } from '../../lib/utils'

import { AGENT_ROWS_SHOWN, agentName, isQuiet, nextQuietAtMs, quietLabel } from './agent-rows'
import { stripEmojiPrefix } from './entries'
import { serverNowMs } from './latency'
import { ELAPSED_AFTER_MS, LiveElapsed, useElapsedShown } from './live-elapsed'
import { AgentList, DownIcon, WorkingRow as WorkingRowUi, type AgentListRow } from './ui'

export function WorkingRow({
  name,
  pin,
  activity,
  agents,
  turnStartMs,
}: {
  /** The working session's slug — the seed for the face in the gutter. */
  name?: string
  pin?: MarkPin
  activity?: string
  /** The children the server has first-hand evidence of. */
  agents?: AgentRow[]
  /** Turn anchor in SERVER-clock ms (last_send_at when recent, else the
   *  skew-corrected flip stamp) — so the elapsed clause counts from the SEND,
   *  not from whenever this component happened to mount. */
  turnStartMs: number
}) {
  // NO TICK HERE. The elapsed clause is a `LiveElapsed` leaf that advances by
  // mutating its own text node (`live-elapsed.tsx`), so this row re-renders only
  // when its REAL props change — an SSE status flip, a new hook label, a
  // changed agent list — and never because a second went by. That is what keeps
  // a reader's drag-select alive: the row sits at the bottom of the live band a
  // selection naturally reaches into, and nothing here replaces a node under it.
  const reduce = useReducedMotion() ?? false
  // The 5s rung, as ONE scheduled flip rather than five ticks (`useElapsedShown`):
  // under it the elapsed cell is not rendered at all, exactly as before, so the
  // row's `gap`/`ml-auto` geometry is unchanged on the first rung.
  const showElapsed = useElapsedShown(turnStartMs, ELAPSED_AFTER_MS)
  // Collapsed default. The caller keys this component by session, so switching
  // sessions remounts it and the expansion resets — there is no stored "open"
  // to go stale against a different turn's children.
  const [expanded, setExpanded] = React.useState(false)
  const listId = React.useId()
  const listRef = React.useRef<HTMLDivElement | null>(null)

  // The gesture brings its own result into view.
  //
  // Measured on the 390px bench: without this, tapping the clause draws the rows
  // and leaves the last two of them BEHIND the composer's glass. The band sits
  // just above that glass because the track reserves room for it — so the rows
  // are inside the scrollport and merely occluded, which is why
  // `scrollIntoView` cannot fix it (it thinks they are already visible). Only
  // returning to the true bottom, where the reserve is, clears them.
  //
  // The panel's follow-bottom pin would have done it, but it runs on renders of
  // the PANEL and never sees this subtree grow — the same shape as the r2
  // finding the composer's reserve had to fix with `onReserveGrew`
  // (`conversation.tsx`). Rather than thread a callback through four layers for
  // one control, the row scrolls its own owner, and only on the tap: an
  // explicit jump-to-bottom gesture is precisely the scroll `follow-bottom.ts`
  // exempts from its selection guard, and a reader has to be looking at the
  // live band to have tapped this at all.
  React.useLayoutEffect(() => {
    if (expanded) scrollOwnerToBottom(listRef.current)
  }, [expanded])

  const rows = agents ?? []
  // The ladder's own clock. One scheduled flip per transition, exactly like the
  // 5s rung above it — never a tick (see the header rule).
  const nowMs = useAgentQuietEdge(rows)
  // The one clause site that counts its OWN rows instead of the server's
  // pre-derived `agents_live` — the control and the list it opens must come from
  // the same array, or it says `3 agents` and opens two.
  const clauseText = subagentsClause(rows.length)
  // The emoji taxonomy stays terminal/tile-only, so the label is stripped here
  // exactly as the confirmed receipt it will become is (`stripEmojiPrefix`).
  const label = activity ? stripEmojiPrefix(activity) : 'Working…'

  return (
    <motion.div
      data-testid="chat-working-row"
      // Arrival only — the row's own content changes in place after that, and a
      // transform on every hook label would make the surface twitch once a
      // second. Reduced motion drops the 4px rise and keeps the fade.
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? motionOff : springs.cardExpand}
    >
      <WorkingRowUi
        seed={name}
        pin={pin}
        label={label}
        clause={
          clauseText ? (
            <button
              type="button"
              data-testid="chat-agents-toggle"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((v) => !v)}
              // The 44px tap target is bought with padding and given back with
              // the matching negative margin, so the control is thumb-sized on a
              // phone and the row's height is exactly what it was.
              className="-mx-2 -my-[12.25px] flex flex-none items-center gap-1 whitespace-nowrap px-2 py-[12.25px] sm-t-hover hover:text-ink"
            >
              {clauseText}
              <DownIcon className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
            </button>
          ) : undefined
        }
        elapsed={
          showElapsed ? <LiveElapsed turnStartMs={turnStartMs} afterMs={ELAPSED_AFTER_MS} /> : undefined
        }
      />
      {expanded && clauseText && (
        <div ref={listRef}>
          <AgentList
            id={listId}
            className="mt-1"
            rows={rows.slice(0, AGENT_ROWS_SHOWN).map((row) => toListRow(row, nowMs))}
            more={Math.max(0, rows.length - AGENT_ROWS_SHOWN)}
            // The one honesty line this surface owed and never said: the chat
            // does not render subagent turns (a deliberate A6 decision, not an
            // oversight), so it has to name where the content actually is.
            note={SUBAGENTS.elsewhere}
          />
        </div>
      )}
    </motion.div>
  )
}

/** Pin the nearest scrolling ancestor to its bottom — where the track's own
 *  composer reserve lives, and therefore the only position at which the newly
 *  drawn rows are clear of the floating glass. A no-op when nothing above is
 *  scrollable (the unit bench, a desktop pane that fits). */
function scrollOwnerToBottom(el: HTMLElement | null) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY
    if (p.scrollHeight > p.clientHeight + 1 && (overflow === 'auto' || overflow === 'scroll')) {
      p.scrollTop = p.scrollHeight
      return
    }
  }
}

/**
 * "Now" for the agent ladder, plus ONE scheduled re-render at the instant the
 * next row goes quiet.
 *
 * The rows carry absolute server-clock stamps, so live→quiet is a judgement this
 * component makes rather than a fact the server pushes — which is the only way
 * the transition can happen at all in the case it exists for: a fan-out where
 * every child is inside a long `Bash` produces no hooks, therefore no deltas,
 * therefore nothing to re-render on. `nextQuietAtMs` is stable while the clock
 * sits inside one interval, so the effect arms the timer once per transition and
 * not once per render.
 */
function useAgentQuietEdge(rows: readonly AgentRow[]): number {
  const [, bump] = React.useReducer((n: number) => n + 1, 0)
  const nowMs = serverNowMs()
  const quietAt = nextQuietAtMs(rows, nowMs)
  React.useEffect(() => {
    if (quietAt == null) return
    // Floored so an edge that is somehow already past when the timeout lands
    // re-arms rather than spinning — same guard as `useElapsedShown`.
    const id = window.setTimeout(bump, Math.max(50, quietAt - serverNowMs()))
    return () => window.clearTimeout(id)
  }, [quietAt])
  return nowMs
}

/** One wire row → one list line. Kept out of the component (and exported) so the
 *  JSX stays a layout statement and the decisions stay testable
 *  (`agent-rows.ts`), the anchor below among them. */
export function toListRow(row: AgentRow, nowMs: number): AgentListRow {
  const quiet = isQuiet(row, nowMs)
  return {
    id: row.id,
    label: agentName(row, stripEmojiPrefix),
    quiet,
    // A quiet row states the FACT and stops. A live one gets a clock counting
    // from its own first sighting — `started_ms` is already in the server-clock
    // domain `LiveElapsed` reads, so it is passed straight through. That it is a
    // STAMP is what keeps the clock honest: the anchor is identical on every
    // render, so the leaf's interval is never torn down and the digits never
    // snap back to what they were at the last delta. `afterMs: 0` means it shows
    // from the first frame — unlike the turn's own clock, a child that has been
    // up 3s is worth saying.
    right: quiet ? quietLabel(nowMs - row.last_evidence_ms) : <LiveElapsed turnStartMs={row.started_ms} afterMs={0} />,
  }
}
