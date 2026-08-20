/**
 * The conversation — the surface the app mounts and the bench screenshots.
 * ─────────────────────────────────────────────────────────────────────────────
 * `chat-surface.test.tsx` pins the LIVE LAYER's order; this pins the
 * COMPOSITION, i.e. the handful of numbers and decisions that were measured off
 * the approved boards and that a later refactor could quietly undo:
 *
 *   · the 744px track and its bottom-anchoring (`min-h-full` + `mt-auto`) —
 *     both were wrong once: the column was 52rem, and `min-h-full` sat on a
 *     parent with an `auto` height, where it is a no-op,
 *   · the composer is present, floating, read-only, and names the session,
 *   · the phone is a different COMPOSITION, not a narrower one: phone bubble
 *     ceilings, a floating header card, the 52px composer,
 *   · the arrival divider names a colleague, not a slug.
 *
 * Static rendering only (no DOM, no react-query): the panel injects everything
 * that talks to the network, which is what makes this file possible.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatConversation, trackBottom } from '../../src/components/chat/conversation'
import type { ChatItem } from '../../src/components/chat/entries'
import { BUBBLE_MAX } from '../../src/components/chat/ui/metrics'
import type { TileSession } from '../../src/components/session-tile/types'

const NAME = 'release-train'
const NOW = 1_760_000_000_000

const session = (over: Partial<TileSession> = {}): TileSession => ({
  name: NAME,
  display_name: 'Release Train',
  status: 'idle',
  dir: '/opt/projects/supermux/server',
  provider: 'claude',
  preview_lines: [],
  updated_at: '2026-08-14T10:00:00Z',
  ...over,
})

const items: ChatItem[] = [
  { type: 'assistant', uuid: 'a1', ts: NOW / 1000 - 60, text: 'one check left. then crates.io.' },
  { type: 'user', uuid: 'u1', ts: NOW / 1000 - 30, text: 'ship it once CI is green' },
]

function render(props: Partial<Parameters<typeof ChatConversation>[0]> = {}): string {
  return renderToStaticMarkup(
    <ChatConversation
      name={NAME}
      session={session()}
      items={items}
      nowMs={NOW}
      turnStart={null}
      {...props}
    />,
  )
}

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

describe('the boards’ composition', () => {
  test('the track is a centred 744px column', () => {
    expect(render()).toContain('max-w-[744px]')
  })

  test('the column is bottom-anchored — and the min-height is on the SCROLLING child', () => {
    const html = render()
    // `min-h-full` on a parent whose height is `auto` resolves to nothing; the
    // pairing below is the whole fix, so both halves are asserted together.
    expect(html).toContain('flex min-h-full flex-col')
    expect(html).toContain('mt-auto')
  })

  test('the pane is the raised paper, one step above the roster', () => {
    expect(render()).toContain('bg-paper-raised')
  })

  test('the composer floats, names the session and cannot be typed into', () => {
    const html = render()
    expect(html).toContain('data-testid="chat-composer"')
    expect(html).toContain('absolute inset-x-0 bottom-0')
    expect(html).toContain('Message Release Train')
    expect(html.toLowerCase()).toContain('readonly')
    // The read-only line exists but only shows itself on focus — at rest the
    // surface is the board.
    expect(html).toContain('group-focus-within:opacity-100')
    expect(text(html)).toContain('Read-only preview')
  })

  test('the track reserves the composer’s room rather than sitting under it', () => {
    // The reserve is MEASURED now (QA #12 — the composer grows with the draft to
    // 136px and the constant did not), so what a DOM-less render asserts is the
    // fallback: the boards' own number, unchanged.
    expect(render()).toContain('padding-bottom:90px')
  })
})

describe('the phone is a composition, not a width', () => {
  const phone = render({ surface: 'phone' })

  test('the phone ceilings are PROPORTIONAL — the agent runs the column, the human is indented', () => {
    // Not the artboard's 266 / 250 any more: a px ceiling on a 390pt screen is a
    // second indent stacked on the track's own 14px gutter, and it cost the
    // agent's text 41% of the width. See `BUBBLE_MAX`.
    expect(phone).toContain(`max-width:${BUBBLE_MAX.phoneAssistant}`)
    expect(phone).toContain(`max-width:${BUBBLE_MAX.phoneUser}`)
    expect(BUBBLE_MAX.phoneAssistant).toBe('100%')
    expect(phone).not.toContain('max-width:266px')
    // Desktop is still a px measure — the 744px track is wider than a line
    // wants to be, which is what the number is for.
    expect(render()).toContain(`max-width:${BUBBLE_MAX.assistant}px`)
  })

  test('the phone gutter is the mark, not the mark plus air', () => {
    expect(phone).toContain('w-7')
    expect(phone).not.toContain('flex w-8 flex-none')
  })

  test('the header becomes a floating card the track scrolls under', () => {
    expect(phone).toContain('rounded-[22px]')
    // The track's top clearance is notch-AWARE, not a fixed budget: on a real
    // notch the floating card now sits at `safe-top + 6` (pulled up from +12 so
    // it reads anchored to the top rather than floating low, owner feedback) and
    // is ~62px tall, so a constant would let the first message scroll under the
    // glass. It tracks `--safe-top` (+86px ≈ header bottom `safe-top + 68` plus
    // an ~18px breath).
    expect(phone).toContain('calc(var(--safe-top, 0px) + 86px)')
    expect(phone).not.toContain('pt-[86px]')
  })

  test('the composer takes its 52px rung and the phone gutters', () => {
    expect(phone).toContain('min-h-[52px]')
    expect(phone).toContain('px-[14px]')
  })
})

describe('what the surface says', () => {
  test('an arrival names the colleague, not the slug', () => {
    const html = render({
      items: [
        { type: 'user', uuid: 't1', ts: NOW / 1000 - 20, text: 'here it is', badge: 'teammate' },
      ],
      labels: new Map([['t1', 'patch']]),
      names: new Map([['patch', 'Patch']]),
    })
    expect(text(html)).toContain('Message from Patch')
    expect(text(html)).not.toContain('Message from patch')
  })

  test('a failed tail says so, and says nothing else', () => {
    const html = render({ items: [], isError: true })
    expect(text(html)).toContain('Couldn’t load this conversation.')
    expect(text(html)).not.toContain('No conversation yet')
  })

  test('an empty (but loaded) tail is honest about being empty', () => {
    expect(text(render({ items: [] }))).toContain('No conversation yet.')
  })

  /** The empty line is a statement about the whole TRACK. A session's first
   *  send puts an optimistic echo (and, seconds later, a working row and the
   *  provisional tail) on screen well before the transcript confirms anything,
   *  and the line used to render directly above the user's own just-sent
   *  bubble — the surface calling itself empty while showing a message.
   *  Reproduced on the real app: mobile proof, 05-sent-pending-light.png. */
  describe('“No conversation yet.” speaks for the whole track', () => {
    const blank = (over: Partial<Parameters<typeof ChatConversation>[0]>) =>
      text(render({ items: [], ...over })).includes('No conversation yet.')

    test('a pending echo is conversation', () => {
      expect(
        blank({
          pending: [{ id: 'p1', text: 'ship it', state: 'unconfirmed', at: NOW }],
        }),
      ).toBe(false)
    })

    test('a running turn is conversation', () => {
      expect(blank({ session: session({ status: 'active' }), turnStart: NOW - 4000 })).toBe(false)
    })

    test('a pending permission dialog is conversation', () => {
      expect(
        blank({
          session: session({
            permission_request: { tool: 'Bash', summary: 'rm -rf /', kind: 'bash' },
          }),
        }),
      ).toBe(false)
    })

    test('provisional pty text is conversation', () => {
      expect(blank({ provisional: <div>live</div> })).toBe(false)
    })

    test('an overlay receipt is conversation', () => {
      expect(blank({ overlay: [{ label: 'Read notes.txt', kind: 'tool', at: NOW }] })).toBe(false)
    })

    test('a genuinely empty track still says so', () => {
      expect(blank({})).toBe(true)
    })
  })
})

/**
 * Daily-driver QA #12 — the composer floated OVER the newest content.
 *
 * The reserve was a constant (90 desktop / 92 phone) and the composer is not: it
 * grows with the draft to 136px and again when a refusal banner appears under
 * it, so streaming text and the last bubble slid under the glass exactly while
 * they were being written. The reserve is the measured height plus the boards'
 * own air.
 */
describe('trackBottom (QA #12)', () => {
  test('unmeasured, it is the boards\' constant — nothing about a static render moves', () => {
    expect(trackBottom(null, false, false)).toBe(90)
    expect(trackBottom(null, true, false)).toBe(92)
    // A zero height is a node that has not been laid out, not a composer with no
    // height: same fallback, or the last bubble would sit on the floor.
    expect(trackBottom(0, true, false)).toBe(92)
  })

  test('measured, it tracks the composer — at rest it lands on the same numbers', () => {
    // The boards' resting composer, measured on the bench at both surfaces.
    expect(trackBottom(76, false, false)).toBe(90)
    expect(trackBottom(66, true, false)).toBe(92)
  })

  test('a composer that grew is followed, not ignored', () => {
    // 136px is `use-composer`'s cap — the state measured in `33-long-draft.png`.
    expect(trackBottom(150, true, false)).toBe(176)
    expect(trackBottom(150, true, false)).toBeGreaterThan(trackBottom(66, true, false))
  })

  test('the stat read-out still gets its own row above the pill', () => {
    expect(trackBottom(66, true, true) - trackBottom(66, true, false)).toBe(30)
  })
})
