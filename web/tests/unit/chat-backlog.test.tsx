/**
 * Back-pagination into the transcript (daily-driver QA #3).
 * ─────────────────────────────────────────────────────────────────────────────
 * QA #3: on a large session, scrolling to `scrollTop = 0` six times left
 * `scrollHeight` unchanged at 4928 — the conversation simply stopped mid-air
 * under a bare "Wednesday" divider. Everything above the seed window was
 * unreachable, with no loader and no end-of-history marker, even though the
 * server has paged this shape for two fases (`hasMore`/`nextBefore`).
 *
 * This file pins the ARITHMETIC (which is the part a refactor breaks silently:
 * a wrong restore is a page that visibly teleports) and the RENDERED head of the
 * track, statically. The hook that fetches is wiring over these.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  historyCursor,
  mergeOlder,
  oldestCursor,
  restoredScrollTop,
  shouldLoadOlder,
  NEAR_TOP_PX,
} from '../../src/components/chat/backlog'
import { ChatConversation } from '../../src/components/chat/conversation'
import type { ChatEntry, ChatItem } from '../../src/components/chat/entries'
import type { TileSession } from '../../src/components/session-tile/types'

const NAME = 'release-train'
const NOW = 1_760_000_000_000

const entry = (uuid: string, over: Partial<ChatEntry> = {}): ChatEntry => ({
  uuid,
  ts: NOW / 1000,
  text: uuid,
  kind: 'assistant',
  sessionId: 'conv-a',
  ...over,
})

describe('the history cursor', () => {
  // `encode_cursor` in `server/src/sessions/recall.rs` is `session_id:uuid` —
  // the pair, not the bare uuid, because Project scope can hold the same uuid
  // in two files.
  test('is the server’s own (sessionId, uuid) pair', () => {
    expect(historyCursor(entry('u1', { sessionId: 'conv-a' }))).toBe('conv-a:u1')
  })

  test('an entry with no sessionId still produces the server’s empty-sid form', () => {
    expect(historyCursor({ uuid: 'u1' })).toBe(':u1')
  })

  test('nothing to page from → no cursor, so the hook cannot fetch a garbage page', () => {
    expect(oldestCursor([])).toBeNull()
  })

  // THE anti-gap rule. The tail window slides as new entries land, so the
  // `nextBefore` the seed handed us goes stale within a turn; paging from the
  // OLDEST ENTRY ON SCREEN can never leave a hole between the two windows.
  test('the next page is asked for from the oldest entry currently on screen', () => {
    const newestFirst = [entry('n1'), entry('n2'), entry('o9', { sessionId: 'conv-b' })]
    expect(oldestCursor(newestFirst)).toBe('conv-b:o9')
  })
})

describe('merging an older page into the tail', () => {
  test('older entries land BELOW the tail in the newest-first list', () => {
    const merged = mergeOlder([entry('n1'), entry('n2')], [entry('o1'), entry('o2')])
    expect(merged.map((e) => e.uuid)).toEqual(['n1', 'n2', 'o1', 'o2'])
  })

  // The tail is refetched constantly; an older page fetched a second earlier
  // can overlap it. Two copies of one message is the QA #10 defect in a
  // different costume.
  test('an entry the tail already holds is never drawn twice', () => {
    const merged = mergeOlder([entry('n1'), entry('n2')], [entry('n2'), entry('o1')])
    expect(merged.map((e) => e.uuid)).toEqual(['n1', 'n2', 'o1'])
  })

  test('two pages that overlap each other are deduped as well', () => {
    const merged = mergeOlder([entry('n1')], [entry('o1'), entry('o1'), entry('o2')])
    expect(merged.map((e) => e.uuid)).toEqual(['n1', 'o1', 'o2'])
  })

  // Identity matters: `use-chat-turn` memoises `toDisplayList(entries)` on it,
  // and the live-layer ticker re-renders once a second.
  test('with no older pages the tail array is returned unchanged', () => {
    const tail = [entry('n1')]
    expect(mergeOlder(tail, [])).toBe(tail)
  })
})

describe('restoring the scroll position', () => {
  // The whole point: the user's eye stays on the line it was on. Anything else
  // is a page that jumps by the height of everything just inserted.
  test('the viewport keeps its distance from the top of the OLD content', () => {
    expect(restoredScrollTop({ scrollHeight: 4928, scrollTop: 0 }, 12_400)).toBe(7472)
  })

  test('a page that added nothing leaves the position exactly where it was', () => {
    expect(restoredScrollTop({ scrollHeight: 4928, scrollTop: 310 }, 4928)).toBe(310)
  })

  // A shrink (a superseded provisional block collapsing in the same commit)
  // must not produce a negative scrollTop, which browsers clamp to 0 — i.e. a
  // silent jump to the very top.
  test('never below zero', () => {
    expect(restoredScrollTop({ scrollHeight: 900, scrollTop: 10 }, 400)).toBe(0)
  })
})

describe('when the top of the track asks for more', () => {
  test('near the top, with more to come, and nothing in flight', () => {
    expect(shouldLoadOlder({ scrollTop: 0, hasOlder: true, loading: false })).toBe(true)
    expect(shouldLoadOlder({ scrollTop: NEAR_TOP_PX - 1, hasOlder: true, loading: false })).toBe(
      true,
    )
  })

  test('not while a page is already in flight — one page per scroll to the top', () => {
    expect(shouldLoadOlder({ scrollTop: 0, hasOlder: true, loading: true })).toBe(false)
  })

  test('not when the server has said there is nothing older', () => {
    expect(shouldLoadOlder({ scrollTop: 0, hasOlder: false, loading: false })).toBe(false)
  })

  test('not from the middle of the conversation', () => {
    expect(shouldLoadOlder({ scrollTop: NEAR_TOP_PX + 1, hasOlder: true, loading: false })).toBe(
      false,
    )
  })
})

// ── what the surface draws ──────────────────────────────────────────────────

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

describe('the top of the track (QA #3)', () => {
  test('more to come → an explicit way to get it, not just a scroll gesture', () => {
    const html = render({ hasOlder: true })
    expect(html).toContain('data-testid="chat-load-older"')
    expect(text(html)).toContain('Load earlier')
  })

  test('while the page is in flight the control says so and cannot be pressed again', () => {
    const html = render({ hasOlder: true, loadingOlder: true })
    expect(text(html)).toContain('Loading earlier messages')
    expect(html).toContain('disabled')
  })

  test('a failed page is stated and retryable — never a silently missing history', () => {
    const html = render({ hasOlder: true, olderError: true })
    expect(text(html)).toContain('Couldn’t load earlier messages')
    expect(text(html)).toContain('Try again')
  })

  // The other half of #3: "cut off mid-conversation under a bare Wednesday
  // divider" is indistinguishable from "this is where it started" unless the
  // surface says which one it is.
  test('nothing older → the start of the conversation is MARKED', () => {
    const html = render({ atStart: true })
    expect(html).toContain('data-testid="chat-start-of-conversation"')
    expect(text(html)).toContain('Start of the conversation')
  })

  test('the marker never appears above an empty track', () => {
    expect(render({ atStart: true, items: [] })).not.toContain('chat-start-of-conversation')
  })

  test('and never while there is still a page to fetch', () => {
    expect(render({ hasOlder: true, atStart: true })).not.toContain('chat-start-of-conversation')
  })
})
