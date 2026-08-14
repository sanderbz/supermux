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

import { ChatConversation } from '../../src/components/chat/conversation'
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
    expect(render()).toContain('pb-[90px]')
  })
})

describe('the phone is a composition, not a width', () => {
  const phone = render({ surface: 'phone' })

  test('both bubble ceilings drop', () => {
    expect(phone).toContain(`max-width:${BUBBLE_MAX.phoneAssistant}px`)
    expect(phone).toContain(`max-width:${BUBBLE_MAX.phoneUser}px`)
    expect(render()).toContain(`max-width:${BUBBLE_MAX.assistant}px`)
  })

  test('the header becomes a floating card the track scrolls under', () => {
    expect(phone).toContain('rounded-[22px]')
    expect(phone).toContain('pt-[86px]')
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
})
