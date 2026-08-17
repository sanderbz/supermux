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
  livePhase,
  sayFor,
} from '../../src/components/a11y/turn-announcer'
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
