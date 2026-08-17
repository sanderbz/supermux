/**
 * THE ONE ANNOUNCEMENT PER TURN — for whichever renderer is on screen.
 * ─────────────────────────────────────────────────────────────────────────────
 * A6 T7.1 closed gap G1 ("a screen-reader user was never told a turn had
 * started") inside `chat/live-layer.tsx`. But `useUI.chatRenderer` defaults to
 * false, so the surface a user actually gets today is the TERMINAL one — and
 * measured over a real 75 s turn (send → working → answer → idle) on the
 * shipped default, the announcement timeline was EMPTY. The fix lived in a file
 * the default renderer never mounts.
 *
 * So the mechanism lives here, outside the lazily-loaded chat chunk, and both
 * renderers use it:
 *
 *   · `live-layer.tsx` mounts `<LiveAnnouncer>` and re-exports the vocabulary,
 *     so the chat surface behaves exactly as before (plus the turn-END edge);
 *   · `<TerminalTurnAnnouncer>` gives the terminal focus route the same voice,
 *     derived from the same session status its header already renders.
 *
 * ONE VOICE. Both can be mounted at once (the chat renderer is a toggle inside
 * the focus route, not a different route), and two polite regions saying the
 * same sentence is how a live region stops being trusted. `live-region-owner.ts`
 * arbitrates: the chat announcer CLAIMS the turn voice while mounted, and the
 * terminal one stands down for as long as the claim is held — the same
 * "more specific owner wins" rule the connection banner already follows.
 */
import * as React from 'react'

// Relative, not `@/`: `chat/live-layer.tsx` re-exports this module and the unit
// runner resolves the root tsconfig, which carries no `paths`.
import { claimTurnVoice, useTurnVoiceTaken } from '../../lib/live-region-owner'

/**
 * Ordered by what outranks what on screen, so the sentence and the pixels can
 * never disagree: an ask is the one thing waiting on a human, a hand-off is
 * more specific than "working", and idle is the resting state.
 */
export type LivePhase = 'idle' | 'working' | 'asking' | 'handoff'

export function livePhase(s: { working: boolean; asking: boolean; handoff: boolean }): LivePhase {
  if (s.asking) return 'asking'
  if (s.handoff) return 'handoff'
  if (s.working) return 'working'
  return 'idle'
}

/** The four sentences. `idle` is empty here because arriving at idle from idle
 *  — the resting state, nothing has happened — is nothing to say. Arriving at
 *  idle from a BUSY phase is a different event entirely; see [`sayFor`]. */
export const PHASE_SAY: Record<LivePhase, string> = {
  idle: '',
  working: 'Claude is working.',
  asking: 'Claude is asking for permission.',
  handoff: 'Handing this over.',
}

/** The other half of the turn. */
export const TURN_END_SAY = 'Claude replied.'

/**
 * WHAT TO SAY ON AN EDGE — a pure function of the phase PAIR.
 *
 * The original mapped `idle → ''` on the rationale that "clearing a live region
 * says nothing, which is the correct amount to say when nothing is happening".
 * True of the resting state, false of the END of a turn: measured over a real
 * 75 s turn with the chat renderer on, the whole timeline was ONE sentence,
 * "Claude is working." at t=541 ms, and then silence for 74 s — the user was
 * told the agent started and never told it finished, which is the one state
 * change they cannot see for themselves.
 *
 * Taking the PAIR rather than the phase keeps the no-memory property that makes
 * the whole P13 sequence one announcement per edge: a phase that repeats maps
 * to the same string, and an unchanged live region is silent.
 */
export function sayFor(from: LivePhase, to: LivePhase, askSay?: string): string {
  // `askSay` refines the `asking` phase: one phase, several questions, and they
  // are not the same question — a screen reader was told "Claude is asking for
  // permission." over a fruit-choice card and over a sign-in picker, neither of
  // which grants anything. `chat/live-layer.tsx` owns that vocabulary
  // (`ASK_SAY`), because only the chat surface can see WHICH card is up; the
  // terminal announcer passes nothing and gets the default.
  if (to === 'asking') return askSay || PHASE_SAY.asking
  if (to !== 'idle') return PHASE_SAY[to]
  // busy → idle is the turn ending. idle → idle is the resting state.
  return from === 'idle' ? '' : TURN_END_SAY
}

/**
 * The region itself. Mount it once per surface; `phase` is the only input.
 *
 * `silent` renders the region but never puts text in it — that is how the
 * loser of the ownership arbitration stands down without unmounting a live
 * region mid-turn (a region that appears and disappears is a region some
 * screen readers stop watching).
 */
export function LiveAnnouncer({
  phase,
  askSay,
  silent = false,
}: {
  phase: LivePhase
  /** The sentence for THIS ask, when the surface knows which one is up. */
  askSay?: string
  silent?: boolean
}) {
  // React's sanctioned "adjust state during render" idiom, which is how a pure
  // component gets at the PREVIOUS prop without an effect (this codebase
  // enforces `react-hooks/set-state-in-effect`) and without mutating a ref
  // mid-render (not StrictMode-safe). React discards this render and re-runs it
  // immediately, so what commits always has `said.from === phase`.
  //
  // The mount is seeded as an edge FROM idle, not from itself: mounting onto a
  // turn that is already running has to say "Claude is working." — that is the
  // pre-existing behaviour when this was a plain function of the phase, and it
  // is what a user gets when they open a session mid-turn. Mounting at idle
  // seeds to the empty string, so an ordinary page load stays silent.
  const [said, setSaid] = React.useState<{ from: LivePhase; text: string }>(() => ({
    from: phase,
    text: sayFor('idle', phase, askSay),
  }))
  if (said.from !== phase) setSaid({ from: phase, text: sayFor(said.from, phase, askSay) })
  const text = said.from === phase ? said.text : sayFor(said.from, phase, askSay)
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {silent ? '' : text}
    </p>
  )
}

/** Claim the turn voice for as long as this component is mounted. */
export function useTurnVoiceClaim(): void {
  React.useEffect(() => claimTurnVoice(), [])
}

/** What the terminal route knows about a session, which is all this needs. */
export interface TurnAnnouncerSession {
  status?: string | null
  permission_request?: unknown
  elicitation?: unknown
}

/**
 * The terminal focus route's voice. Same region, same sentences, derived from
 * the session status the focus header already renders — so what is spoken and
 * what is drawn cannot drift.
 *
 * There is no `handoff` here: a delegation hand-off is a chat-transcript
 * concept, and the terminal surface has no view of it. Claiming a phase it
 * cannot observe would be worse than not saying it.
 */
export function TerminalTurnAnnouncer({
  session,
}: {
  session: TurnAnnouncerSession | null | undefined
}) {
  // The chat surface, when mounted, is the more specific owner of this story.
  const taken = useTurnVoiceTaken()
  const phase = livePhase({
    working: session?.status === 'active',
    asking: !!(session?.permission_request || session?.elicitation),
    handoff: false,
  })
  return <LiveAnnouncer phase={phase} silent={taken} />
}
