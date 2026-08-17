/**
 * Accessibility, as behaviour rather than as attributes (fase A6 T7/T8).
 * ─────────────────────────────────────────────────────────────────────────────
 * The A6 plan's §0.5 lists fourteen gaps. Most of them are one attribute and are
 * pinned here as such, because an attribute that nobody asserts is an attribute
 * the next refactor deletes. ONE of them is not an attribute at all:
 *
 *   G1 — the streaming region announces. The naive repair (`aria-live` on the
 *   live band) is WORSE than the zero `aria-*` it replaces: the band is the
 *   fastest-changing subtree in the product, so P13 — working row → provisional
 *   tail → the confirmed entry that supersedes it — would be narrated once per
 *   pty flush plus once per band state. So the assertion here is a COUNT over a
 *   scripted turn, not a `toContain('aria-live')`. A naive fix fails it.
 *
 * Rendered through `renderToStaticMarkup` like every other chat unit test: the
 * whole point of the chat modules' no-network, no-`@/` discipline is that the
 * surface can be asserted without a DOM.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { AttentionCard, AttentionRow, attentionCardId } from '../../src/components/chat/attention-card'
import { ChatSurface, SurfaceStatus } from '../../src/components/chat/chat-surface'
import {
  ASK_SAY,
  LiveLayer,
  PHASE_SAY,
  askKind,
  livePhase,
  type LivePhase,
} from '../../src/components/chat/live-layer'
import { Bubble } from '../../src/components/chat/ui/bubble'
import { CardCode, ChoiceCard } from '../../src/components/chat/ui/choice-card'
import type { TileSession } from '../../src/components/session-tile/types'

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

function session(over: Partial<TileSession> = {}): TileSession {
  return {
    name: 'release-train',
    status: 'active',
    updated_at: '',
    ...over,
  } as TileSession
}

/* ── G1: the announcement count over a scripted turn ─────────────────────── */

/**
 * What an unchanged live region does: nothing. Folding the frame-by-frame
 * phases through this is exactly what a screen reader would speak, because the
 * region's text is a pure function of the phase — so a phase that repeats
 * re-renders to the same string and is silent.
 */
function announcementsOver(frames: readonly LivePhase[]): string[] {
  const out: string[] = []
  let prev: LivePhase | null = null
  for (const f of frames) {
    if (f !== prev && PHASE_SAY[f]) out.push(PHASE_SAY[f])
    prev = f
  }
  return out
}

/**
 * ONE TURN, FRAME BY FRAME — the P13 sequence the plan names as the hard case.
 *
 *   0      idle, the user has just typed
 *   1      the working row appears
 *   2-6    the provisional tail streams five pty flushes underneath it
 *   7      the confirmed entry supersedes it and the band empties
 */
const P13_TURN: readonly LivePhase[] = [
  'idle',
  'working',
  'working',
  'working',
  'working',
  'working',
  'working',
  'idle',
]

describe('G1 — the streaming region announces, once', () => {
  test('the whole P13 sequence is ONE announcement, not one per flush', () => {
    const said = announcementsOver(P13_TURN)
    expect(said).toEqual(['Claude is working.'])
    expect(said.length).toBe(1)
  })

  test('the naive fix — a live region over the band — would have said eight things', () => {
    // What `aria-live` on `chat-live-layer` costs, measured rather than
    // asserted by intuition: the band's own markup changes on every frame of
    // that turn, because the provisional tail is a child of it. This is the
    // number the coalescing above replaces, and the reason the assertion is a
    // count in the first place.
    const frames = P13_TURN.map((_, i) =>
      html(
        <LiveLayer
          name="release-train"
          session={session({ status: i > 0 && i < 7 ? 'active' : 'idle' })}
          turnStart={i > 0 && i < 7 ? 1 : null}
          provisional={i >= 2 && i <= 6 ? <span>{`flush ${i}`}</span> : undefined}
        />,
      ),
    )
    expect(new Set(frames).size).toBeGreaterThanOrEqual(7)
  })

  test('an ask and a hand-off each get their own sentence, and idle gets none', () => {
    expect(announcementsOver(['idle', 'working', 'asking', 'working', 'idle'])).toEqual([
      PHASE_SAY.working,
      PHASE_SAY.asking,
      PHASE_SAY.working,
    ])
    expect(PHASE_SAY.idle).toBe('')
  })

  test('the phase ladder: an ask outranks a hand-off outranks working', () => {
    expect(livePhase({ working: true, asking: true, handoff: true })).toBe('asking')
    expect(livePhase({ working: true, asking: false, handoff: true })).toBe('handoff')
    expect(livePhase({ working: true, asking: false, handoff: false })).toBe('working')
    expect(livePhase({ working: false, asking: false, handoff: false })).toBe('idle')
  })

  test('the visual band is muted and the status region is the only live one', () => {
    const out = html(
      <LiveLayer name="release-train" session={session()} turnStart={1} />,
    )
    // The band itself must never speak — this is the whole G1 mitigation.
    expect(out).toContain('aria-live="off"')
    // …and exactly one polite, atomic region does.
    expect(out.match(/aria-live="polite"/g)?.length).toBe(1)
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-atomic="true"')
  })

  test('G2 — a running band is aria-busy, an idle one is not', () => {
    expect(html(<LiveLayer name="x" session={session()} turnStart={1} />)).toContain(
      'aria-busy="true"',
    )
    expect(
      html(<LiveLayer name="x" session={session({ status: 'idle' })} turnStart={null} />),
    ).not.toContain('aria-busy')
  })
})

/* ── G3: bubbles carry author attribution ────────────────────────────────── */

describe('G3 — a bubble says who is talking', () => {
  test('an authored bubble is a named article', () => {
    const out = html(<Bubble author="You">hi</Bubble>)
    expect(out).toContain('role="article"')
    expect(out).toContain('aria-label="You"')
  })

  test('an UNAUTHORED bubble stays a plain div — a receipt group is not speech', () => {
    const out = html(<Bubble padding="list">rows</Bubble>)
    expect(out).not.toContain('role="article"')
    expect(out).not.toContain('aria-label')
  })

  test('the text content is untouched, so the transcript tests still read the message', () => {
    expect(html(<Bubble author="Claude">short and whole</Bubble>)).toContain('short and whole')
  })
})

/* ── G4/G5: the choice card ──────────────────────────────────────────────── */

describe('G4/G5 — the ask is named, the cursor is real, the reason is reachable', () => {
  const OPTIONS = [
    { label: 'Allow once', primary: true, kbd: '1' },
    { label: 'Always allow', disabled: true, hint: 'chat can’t persist this one' },
  ]

  test('the group is named by the question it asks', () => {
    const out = html(<ChoiceCard question="Run cargo check?" options={OPTIONS} />)
    expect(out).toContain('role="group"')
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(out)?.[1]
    expect(labelledBy).toBeTruthy()
    // The id it points at must actually exist in the markup.
    expect(out).toContain(`id="${labelledBy}"`)
  })

  test('the keyboard cursor is an ARIA state, not only a colour', () => {
    const out = html(<ChoiceCard question="q" options={OPTIONS} selectedIndex={0} />)
    expect(out).toContain('aria-current="true"')
  })

  test('the "why it is inert" reason is text, not a title tooltip', () => {
    const out = html(<ChoiceCard question="q" options={OPTIONS} />)
    expect(out).toContain('chat can’t persist this one')
    expect(out).not.toContain('title=')
    // Still genuinely disabled — the refusal survives a restyle (A4's rule).
    expect(out).toContain('disabled=""')
  })

  test('the evidence box is a named tab stop rather than a silent one', () => {
    const out = html(<CardCode>{'rm -rf /tmp/x'}</CardCode>)
    expect(out).toContain('role="region"')
    expect(out).toContain('aria-label="Details"')
    expect(out).toContain('tabindex="0"')
  })
})

/* ── G6: aria-expanded names what it controls ────────────────────────────── */

describe('G6 — aria-expanded points at something', () => {
  test('the row names the overlay it opens, and only while it exists', () => {
    const open = html(<AttentionRow cause="send-unconfirmed" expanded onExpand={() => {}} />)
    expect(open).toContain(`aria-controls="${attentionCardId('send-unconfirmed')}"`)
    const shut = html(<AttentionRow cause="send-unconfirmed" onExpand={() => {}} />)
    expect(shut).toContain('aria-expanded="false"')
    expect(shut).not.toContain('aria-controls')
  })

  test('only the MODAL card claims the id — the inline one would collide', () => {
    const inline = html(<AttentionCard cause="send-unconfirmed" />)
    expect(inline).not.toContain(`id="${attentionCardId('send-unconfirmed')}"`)
  })
})

/* ── G9/G13: the surface has a heading, a region, and one status voice ───── */

describe('G9/G13 — structure and a single status voice', () => {
  test('the surface has one heading and a region that points at it', () => {
    const out = html(<ChatSurface name="release-train" session={session()} />)
    expect(out).toContain('<h2 id="chat-title-release-train"')
    expect(out).toContain('role="region"')
    expect(out).toContain('aria-labelledby="chat-title-release-train"')
  })

  test('the scroll region is NOT a live region — the seed would read the backlog', () => {
    const out = html(<ChatSurface name="x" session={session()} />)
    expect(out).not.toContain('role="log"')
    expect(out).not.toContain('aria-live')
  })

  test('the status dot is decoration and the word is text — announced once', () => {
    const out = html(<SurfaceStatus session={session({ status: 'waiting' })} />)
    expect(out).toContain('aria-hidden="true"')
    expect(out).toContain('Needs input')
    // The invented `role="img"` on an empty span is gone (G13).
    expect(out).not.toContain('role="img"')
    expect(out).not.toContain('title=')
  })
})

/* ── G1b: an ask is not always a permission request (r2 finding 33) ──────── */

describe('G1b — the ask is announced as the KIND of ask it is', () => {
  test('a content question is not announced as a permission request', () => {
    // What shipped: `[role="status"]` read "Claude is asking for permission."
    // over a card reading `FRUIT CHOICE / Which fruit do you want? / Apple /
    // Banana / Cherry`. Nothing on that screen grants anything — the registry's
    // own comment for `question.ask` says so ("Answering a question grants
    // nothing and changes no mode") — and "permission" is the one word that
    // would make somebody answer it differently.
    expect(ASK_SAY.question).toBe('Claude is asking a question.')
    expect(ASK_SAY.question).not.toContain('permission')
    expect(ASK_SAY['sign-in']).not.toContain('permission')
    // The permission sentence itself is unchanged, and is still the phase's
    // default — the split adds branches, it does not reword the mapped case.
    expect(ASK_SAY.permission).toBe(PHASE_SAY.asking)
  })

  test('the kind is derived in the same order the cards are drawn', () => {
    const K = { form: false, permission: false, signIn: false } as const
    expect(askKind({ ...K, form: true, dialog: 'question', permission: true })).toBe('form')
    expect(askKind({ ...K, dialog: 'question', permission: true })).toBe('question')
    expect(askKind({ ...K, dialog: 'paused' })).toBe('paused')
    expect(askKind({ ...K, permission: true })).toBe('permission')
    // The sign-in card is a SLOT, so it is the only ask this band cannot see
    // for itself — and while a login owns the screen the panel suppresses the
    // generic dialog card, so without the flag the region said nothing at all
    // about the one state that cannot proceed without a human.
    expect(askKind({ ...K, signIn: true })).toBe('sign-in')
    expect(askKind(K)).toBe('unknown')
  })

  test('a sign-in card alone still puts the band in the asking phase', () => {
    const out = html(
      <LiveLayer
        name="release-train"
        session={session({ status: 'idle' })}
        turnStart={null}
        login={<div>sign in</div>}
        signIn
      />,
    )
    expect(out).toContain(ASK_SAY['sign-in'])
    expect(out).not.toContain(PHASE_SAY.asking)
  })
})
