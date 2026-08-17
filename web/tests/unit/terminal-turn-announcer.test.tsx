/**
 * The DEFAULT renderer has to say the turn out loud too.
 * ─────────────────────────────────────────────────────────────────────────────
 * A6 T7.1 gap G1 ("a screen-reader user was never told a turn had started") was
 * closed inside `chat/live-layer.tsx`. `useUI.chatRenderer` defaults to false,
 * so the surface a user actually gets is the TERMINAL one — and instrumenting
 * every `aria-live` / `role=status` region over a real 75 s turn on it
 * (send → working → answer → idle) produced an EMPTY timeline. The repair
 * existed, in a file the shipped default never mounts.
 *
 * Two properties, both asserted here:
 *   1. the terminal route's announcer speaks the same four sentences, derived
 *      from the same session status its header already renders;
 *   2. exactly ONE region does — mounting both renderers at once must not
 *      produce two polite regions saying the same thing, which is how a live
 *      region stops being trusted.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  LiveAnnouncer,
  PHASE_SAY,
  TURN_END_SAY,
  TerminalTurnAnnouncer,
  type Said,
  livePhase,
  nextSaid,
  sayFor,
} from '../../src/components/a11y/turn-announcer'
import { ASK_SAY, askKind } from '../../src/components/chat/live-layer'
import { claimTurnVoice, turnVoiceClaims } from '../../src/lib/live-region-owner'

const html = (n: React.ReactNode) => renderToStaticMarkup(<>{n}</>)

/** Every polite live region that currently has words in it. */
function speaking(markup: string): string[] {
  return [...markup.matchAll(/aria-live="polite"[^>]*>([^<]*)</g)]
    .map((m) => m[1])
    .filter(Boolean)
}

describe('the terminal surface announces the turn', () => {
  test('a running session says so on arrival', () => {
    const markup = html(<TerminalTurnAnnouncer session={{ status: 'active' }} />)
    expect(speaking(markup)).toEqual([PHASE_SAY.working])
  })

  test('an idle session says nothing — and the region is still there', () => {
    const markup = html(<TerminalTurnAnnouncer session={{ status: 'idle' }} />)
    expect(speaking(markup)).toEqual([])
    // A region that appears together with its text announces unreliably, so it
    // is mounted-and-empty rather than absent.
    expect(markup).toContain('role="status"')
  })

  test('a permission prompt outranks working', () => {
    const markup = html(
      <TerminalTurnAnnouncer
        session={{ status: 'active', permission_request: { tool: 'Bash' } }}
      />,
    )
    expect(speaking(markup)).toEqual([PHASE_SAY.asking])
  })

  test('no session at all is silent, not a crash', () => {
    expect(speaking(html(<TerminalTurnAnnouncer session={null} />))).toEqual([])
    expect(speaking(html(<TerminalTurnAnnouncer session={undefined} />))).toEqual([])
  })

  test('it never claims a hand-off, which it cannot observe', () => {
    // The terminal surface has no view of a delegation, so it must not be able
    // to reach that sentence — saying something it cannot check would be worse
    // than saying nothing.
    const sentences = (['active', 'idle', 'waiting', 'stopped'] as const).map((status) =>
      speaking(html(<TerminalTurnAnnouncer session={{ status }} />)).join(''),
    )
    expect(sentences).not.toContain(PHASE_SAY.handoff)
  })
})

describe('the turn has one voice', () => {
  test('the loser of the arbitration renders an EMPTY region, not no region', () => {
    const silent = html(<LiveAnnouncer phase="working" silent />)
    expect(speaking(silent)).toEqual([])
    expect(silent).toContain('aria-live="polite"')
    expect(speaking(html(<LiveAnnouncer phase="working" />))).toEqual([PHASE_SAY.working])
  })

  test('a claim is counted, released exactly once, and idempotent', () => {
    expect(turnVoiceClaims()).toBe(0)
    const release = claimTurnVoice()
    expect(turnVoiceClaims()).toBe(1)
    const release2 = claimTurnVoice()
    expect(turnVoiceClaims()).toBe(2)
    release2()
    release2() // double-release must not underflow the count
    expect(turnVoiceClaims()).toBe(1)
    release()
    expect(turnVoiceClaims()).toBe(0)
  })
})

describe('the sentences themselves', () => {
  test('the phase ladder is unchanged', () => {
    expect(livePhase({ working: true, asking: true, handoff: true })).toBe('asking')
    expect(livePhase({ working: true, asking: false, handoff: true })).toBe('handoff')
    expect(livePhase({ working: true, asking: false, handoff: false })).toBe('working')
    expect(livePhase({ working: false, asking: false, handoff: false })).toBe('idle')
  })

  test('every busy phase ends out loud, and rest is silent', () => {
    expect(sayFor('working', 'idle')).toBe(TURN_END_SAY)
    expect(sayFor('asking', 'idle')).toBe(TURN_END_SAY)
    expect(sayFor('handoff', 'idle')).toBe(TURN_END_SAY)
    expect(sayFor('idle', 'idle')).toBe('')
  })
})

describe('the ask sentence refines within the asking phase (finding #33)', () => {
  // `AskUserQuestion` always fires a permission_request hook that reaches the
  // client ~1 s BEFORE the peek lens classifies the dialog. So the idle→asking
  // edge commits with only permission_request present (dialog view still null →
  // askKind='permission'), and the lens' true 'question' sighting lands one
  // poll LATER — inside the SAME asking phase. The bug: LiveAnnouncer latched
  // its text on the phase edge alone and never re-derived, leaving a screen
  // reader told "Claude is asking for permission." over a fruit-choice card.
  // `nextSaid` is the pure transition the component runs; folding the real poll
  // sequence through it is the regression this file exists to hold.

  /** The (phase, askSay) pair the live layer would feed the announcer for a
   *  given set of asking signals — mirrors live-layer.tsx's `askKind` +
   *  `ASK_SAY[ask]`. */
  function feed(sig: {
    permission?: boolean
    dialog?: 'question' | 'plan' | undefined
  }): { phase: 'idle' | 'asking'; askSay: string } {
    const kind = askKind({
      form: false,
      dialog: sig.dialog,
      permission: !!sig.permission,
      signIn: false,
    })
    const asking = !!sig.permission || !!sig.dialog
    return { phase: asking ? 'asking' : 'idle', askSay: ASK_SAY[kind] }
  }

  /** Fold a scripted poll timeline through the announcer's pure transition,
   *  seeded exactly as the component seeds on mount. */
  function speakThrough(
    steps: ReadonlyArray<{ phase: 'idle' | 'asking'; askSay: string }>,
  ): string {
    let said: Said = {
      from: steps[0].phase,
      say: steps[0].askSay,
      text: sayFor('idle', steps[0].phase, steps[0].askSay),
    }
    for (const s of steps.slice(1)) said = nextSaid(said, s.phase, s.askSay)
    return said.text
  }

  test('the permission hook lands first, then the lens says it is a question', () => {
    const timeline = [
      feed({}), // idle page load
      feed({ permission: true }), // hook arrives ~1s ahead of the lens
      feed({ permission: true, dialog: 'question' }), // lens classifies the card
    ]
    // The mid-timeline value IS the wrong thing the bug latched forever.
    expect(speakThrough(timeline.slice(0, 2))).toBe(ASK_SAY.permission)
    // Once the question card resolves, the announcer must correct itself —
    // still inside the asking phase, no idle bounce required.
    expect(speakThrough(timeline)).toBe(ASK_SAY.question)
    expect(ASK_SAY.question).toContain('question')
  })

  test('a genuine permission prompt is left saying permission', () => {
    // The refine must not invent a question: a plain Bash-permission turn has no
    // later dialog sighting, so the sentence stays 'permission'.
    expect(speakThrough([feed({}), feed({ permission: true })])).toBe(
      ASK_SAY.permission,
    )
  })

  test('a bare phase edge with no ask change is unchanged (returns prev)', () => {
    const said: Said = { from: 'asking', say: ASK_SAY.question, text: ASK_SAY.question }
    expect(nextSaid(said, 'asking', ASK_SAY.question)).toBe(said)
  })
})
