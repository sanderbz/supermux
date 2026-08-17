/**
 * T12.2 / T12.3 — teammates stop having their own vocabulary.
 *
 * §16.3's open half was that teams had grown a PARALLEL visual language:
 * `MemberStatusDot` re-implemented `<StatusDot>` with its own four-state colour
 * table, and a third team roll-up header hand-rolled markup under a comment
 * saying it "mirrors the overview TeamCard language" — drift, written down and
 * shipped.
 *
 * Both are now adapters over the shipped components. What is asserted here is
 * the MAPPING, because that is the part with a decision in it: a rendering
 * choice must not change what a user is TOLD, and the four teammate states must
 * each land on a session status that means the same thing.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  MemberStatusDot,
  MEMBER_STATUS_LABEL,
  MEMBER_STATUS_TO_SESSION,
} from '../../src/components/team/member-status-dot'
import type { MemberStatus } from '../../src/lib/api/teams'

const ALL: MemberStatus[] = ['working', 'needs_you', 'idle', 'offline']

describe('the teammate vocabulary maps onto the session one', () => {
  test('every teammate status has a mapping', () => {
    for (const s of ALL) {
      expect(MEMBER_STATUS_TO_SESSION[s]).toBeDefined()
    }
  })

  test('the mapping is meaning-preserving, state by state', () => {
    // Each pairing is a claim about what the two vocabularies share, and each
    // is the reason that state can safely borrow the other's rendering.
    expect(MEMBER_STATUS_TO_SESSION.working).toBe('active') // busy, hang on
    expect(MEMBER_STATUS_TO_SESSION.needs_you).toBe('waiting') // blocked on you
    expect(MEMBER_STATUS_TO_SESSION.idle).toBe('idle') // alive, turn ended
    expect(MEMBER_STATUS_TO_SESSION.offline).toBe('stopped') // no live pane
  })

  test('distinct teammate states stay distinct', () => {
    // A mapping that collapsed two states would make them indistinguishable on
    // screen — the exact failure a shared renderer is supposed to avoid, not
    // introduce.
    const targets = ALL.map((s) => MEMBER_STATUS_TO_SESSION[s])
    expect(new Set(targets).size).toBe(ALL.length)
  })
})

describe('the mapping does not leak into what the user is told', () => {
  test('the accessible label stays in the TEAMMATE vocabulary', () => {
    // `needs_you` maps onto `waiting` to reuse the blue disc. A screen-reader
    // user is being told about a teammate, so it must announce "Needs you" —
    // never "Waiting", which is a fact about a session they are not looking at.
    const html = renderToStaticMarkup(<MemberStatusDot status="needs_you" />)
    expect(html).toContain(`aria-label="${MEMBER_STATUS_LABEL.needs_you}"`)
    expect(html).not.toContain('aria-label="Waiting"')
  })

  test('every state announces its own word', () => {
    for (const s of ALL) {
      const html = renderToStaticMarkup(<MemberStatusDot status={s} />)
      expect(html).toContain(`aria-label="${MEMBER_STATUS_LABEL[s]}"`)
    }
  })
})

describe('the rendering is the shipped one, not a copy of it', () => {
  test('working spins — and spins with the SAME keyframe as a busy session', () => {
    // The one moving dot in the app. It rotates even under Reduce Motion,
    // because a loading indicator is functional feedback and freezing it reads
    // as "stuck". Sharing `sm-status-spinner` is what guarantees a working
    // teammate and a working session look identical rather than merely similar.
    const html = renderToStaticMarkup(<MemberStatusDot status="working" />)
    expect(html).toContain('sm-status-spinner')
  })

  test('the calm states are static discs carrying a status token', () => {
    for (const s of ['needs_you', 'idle', 'offline'] as MemberStatus[]) {
      const html = renderToStaticMarkup(<MemberStatusDot status={s} />)
      expect(html).not.toContain('sm-status-spinner')
      // The colour comes from a `bg-status-*` token rather than a hex literal,
      // which is what makes a theme change reach teammates at all — the old
      // parallel table is exactly what stopped that happening.
      expect(html).toContain('bg-status-')
    }
  })

  test('a className still reaches the dot', () => {
    const html = renderToStaticMarkup(
      <MemberStatusDot status="idle" className="ml-2" />,
    )
    expect(html).toContain('ml-2')
  })
})
