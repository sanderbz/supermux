/**
 * Back-pagination and the jump-to-bottom pill (daily-driver QA #3, #17).
 * ─────────────────────────────────────────────────────────────────────────────
 * QA #3: on a large session, scrolling to `scrollTop = 0` six times left
 * `scrollHeight` unchanged at 4928 — the conversation simply stopped mid-air
 * under a bare "Wednesday" divider. Everything above the seed window was
 * unreachable, with no loader and no end-of-history marker, even though the
 * server has paged this shape for two fases (`hasMore`/`nextBefore`).
 *
 * QA #17: after scrolling up mid-turn the only way back to the newest message
 * was to scroll all the way down by hand — the DOM held no such button at all.
 *
 * This file pins the ARITHMETIC (which is the part a refactor breaks silently:
 * a wrong restore is a page that visibly teleports) and the RENDERED
 * affordances, statically. The hook that fetches is wiring over these.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  bridges,
  chatCursor,
  cursorConversation,
  healedBlock,
  jumpVisible,
  mergeOlder,
  oldestCursor,
  restoredScrollTop,
  seamOpen,
  shouldLoadOlder,
  JUMP_AWAY_PX,
  NEAR_TOP_PX,
} from '../../src/components/chat/backlog'
import { ChatConversation } from '../../src/components/chat/conversation'
import type { ChatEntry, ChatItem } from '../../src/components/chat/entries'
import { toChatEntries } from '../../src/components/chat/wire-entries'
import type { WireEntry } from '../../src/components/chat/wire'
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

/** A wire entry as `/chat/history` and the seed frame carry it — the cursor
 *  arithmetic reads `offset` and `agent_id`, and nothing else. */
const at = (offset: number, over: { agent_id?: string } = {}) => ({
  uuid: `u${offset}`,
  offset,
  ...over,
})

describe('the history cursor', () => {
  // `HistoryCursor::format` in `server/src/sessions/chat/ws.rs` is
  // `<conversation_id>:<offset>` — a byte position in the main transcript, and
  // the conversation it is a position IN, because a cursor that outlives a
  // `/clear` must be a 409 rather than bytes from a different conversation.
  test('is the server’s own (conversation, offset) pair', () => {
    expect(chatCursor('conv-a', 4096)).toBe('conv-a:4096')
  })

  test('the conversation id is read back out of a cursor the server stamped', () => {
    expect(cursorConversation('conv-a:4096')).toBe('conv-a')
    // `HistoryCursor::parse` uses `rsplit_once`, so an id containing a colon
    // still round-trips.
    expect(cursorConversation('conv:a:4096')).toBe('conv:a')
  })

  test('a malformed cursor names no conversation, so nothing can be fetched', () => {
    expect(cursorConversation(null)).toBeNull()
    expect(cursorConversation('no-colon')).toBeNull()
    expect(cursorConversation(':4096')).toBeNull()
    expect(cursorConversation('conv-a:')).toBeNull()
  })

  test('nothing to page from → no cursor, so the hook cannot fetch a garbage page', () => {
    expect(oldestCursor('conv-a', [])).toBeNull()
  })

  test('no conversation known yet → no cursor either', () => {
    expect(oldestCursor(null, [at(10)])).toBeNull()
  })

  // THE anti-gap rule, unchanged from the poll: the `nextBefore` the seed handed
  // us describes the boundary as it was when the frame was sent, and paging from
  // the OLDEST ENTRY ON SCREEN can never leave a hole between the two windows.
  test('the next page is asked for from the oldest entry currently on screen', () => {
    const newestFirst = [at(900), at(500), at(120)]
    expect(oldestCursor('conv-a', newestFirst)).toBe('conv-a:120')
  })

  // `seed_page` (ws.rs) skips subagent entries when it picks `next_before` for
  // exactly this reason: `history_page` resolves the cursor against the MAIN
  // transcript, while a subagent entry's offset is a position in its own file.
  // Handing one out pages from an unrelated byte.
  test('a subagent entry is never used as the cursor', () => {
    const newestFirst = [at(900), at(500), at(4, { agent_id: 'sub-1' })]
    expect(oldestCursor('conv-a', newestFirst)).toBe('conv-a:500')
  })

  test('a window of nothing but subagent turns has no position to page from', () => {
    expect(oldestCursor('conv-a', [at(9, { agent_id: 'sub-1' })])).toBeNull()
  })
})

/**
 * THE TWO ORDERS. The socket holds its window OLDEST-first (the order the seed
 * arrives in and live frames extend); every rule in `backlog.ts` is written
 * NEWEST-first; and `toChatEntries` reads oldest-first and answers newest-first.
 * `use-chat-backlog` is where all three meet, so a reversal dropped or applied
 * twice there silently reorders a conversation rather than throwing — which is
 * the failure this describe exists to make loud.
 */
describe('paging in the wire domain', () => {
  const wire = (offset: number, text: string): WireEntry => ({
    seq: offset,
    uuid: `u${offset}`,
    kind: 'assistant',
    ts_ms: NOW,
    offset,
    oversize: false,
    truncated: false,
    body: { text },
  })

  // The hook's exact pipeline: reverse the window, merge the block under it,
  // reverse back, adapt.
  const paged = (socketWindow: WireEntry[], older: WireEntry[]): string[] =>
    toChatEntries(mergeOlder(socketWindow.slice().reverse(), older).slice().reverse()).map(
      (e) => e.text,
    )

  test('the window alone comes out newest-first', () => {
    // oldest-first, as the socket holds it
    expect(paged([wire(10, 'old'), wire(20, 'mid'), wire(30, 'new')], [])).toEqual([
      'new',
      'mid',
      'old',
    ])
  })

  // A page fetched below the window belongs UNDER it — i.e. later in the
  // newest-first list the renderer draws top to bottom.
  test('an older page lands below the window, and the run stays contiguous', () => {
    const socketWindow = [wire(30, 'c'), wire(40, 'd')]
    // `/chat/history` answers oldest-first; the hook reverses it to newest-first
    const page = [wire(20, 'b'), wire(10, 'a')].slice() // already newest-first here
    expect(paged(socketWindow, page)).toEqual(['d', 'c', 'b', 'a'])
  })

  // Two pages, the second older than the first — appended to the block in fetch
  // order, which is what keeps the whole run in transcript order.
  test('a second, older page extends the run downward', () => {
    const socketWindow = [wire(50, 'e')]
    const block = [wire(40, 'd'), wire(30, 'c'), wire(20, 'b'), wire(10, 'a')]
    expect(paged(socketWindow, block)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  test('a page that overlaps the window never doubles a message', () => {
    const socketWindow = [wire(20, 'b'), wire(30, 'c')]
    const page = [wire(20, 'b'), wire(10, 'a')]
    expect(paged(socketWindow, page)).toEqual(['c', 'b', 'a'])
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

/**
 * THE SEAM. The tail is the newest 30 entries and it SLIDES; the accumulated
 * block below it does not. One entry landing after the user has paged back
 * therefore drops one entry out of BOTH lists — measured against the live
 * server on `ipc` (600 entries): slide 1 → 1 message gone from the middle of
 * the transcript, slide 20 → 20 gone, with the surface showing no hole at all.
 * Silently losing messages out of the middle is the same defect QA #3 is
 * about, one window further down.
 */
describe('the seam between the tail and the block below it', () => {
  const block = (anchor: string | null, count: number) => ({ anchor, count })

  test('intact while the tail still holds the entry the block hangs under', () => {
    const tail = [entry('n1'), entry('n2'), entry('a')]
    expect(seamOpen(tail, block('a', 60))).toBe(false)
  })

  // The case that loses messages: the anchor has slid out of the 30-entry
  // window, so everything between the window's new bottom and the block's top
  // belongs to neither list.
  test('open once the window has slid past that entry', () => {
    const tail = [entry('n0'), entry('n1'), entry('n2')]
    expect(seamOpen(tail, block('a', 60))).toBe(true)
  })

  test('nothing paged in → there is no seam to keep', () => {
    expect(seamOpen([entry('n0')], block(null, 0))).toBe(false)
    expect(seamOpen([entry('n0')], block('a', 0))).toBe(false)
  })

  // The heal fetches downward from the window's new bottom until it reaches
  // the anchor; only then do the two halves join without a hole.
  test('a fill page that reaches the anchor bridges the seam', () => {
    expect(bridges([entry('x'), entry('a')], 'a')).toBe(true)
  })

  test('a fill page that does not reach it must keep fetching', () => {
    expect(bridges([entry('x'), entry('y')], 'a')).toBe(false)
    expect(bridges([entry('x')], null)).toBe(false)
  })

  // What the healed state must look like: the fill goes ON TOP of the block,
  // the overlap is deduped, and the result is one contiguous newest-first run.
  test('fill + block is contiguous, deduped, and in transcript order', () => {
    const tailNow = [entry('n0'), entry('n1'), entry('n2')]
    const fill = [entry('n3'), entry('a'), entry('o1')] // reaches the anchor
    const paged = [entry('o1'), entry('o2')]
    const healed = mergeOlder(tailNow, healedBlock(fill, paged, true)!)
    expect(healed.map((e) => e.uuid)).toEqual(['n0', 'n1', 'n2', 'n3', 'a', 'o1', 'o2'])
  })

  // A fill that never reached the anchor cannot be joined to what the reader
  // paged in; the shorter honest run wins over a longer one with a hole.
  test('a fill that never bridged replaces the block instead of holing it', () => {
    const fill = [entry('n3'), entry('n4')]
    expect(healedBlock(fill, [entry('o1')], false)!.map((e) => e.uuid)).toEqual(['n3', 'n4'])
  })

  // …but an empty answer must never be mistaken for "there was nothing there":
  // that would delete history the reader has already paged in.
  test('an empty fill changes nothing at all', () => {
    expect(healedBlock([], [entry('o1')], false)).toBeNull()
    expect(healedBlock([], [entry('o1')], true)).toBeNull()
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

describe('the jump-to-bottom pill’s visibility', () => {
  // Deliberately far past the 48px follow-bottom threshold: a pill that
  // appeared the moment the pin let go would flicker on every rubber-band.
  test('hidden at the bottom and just above it', () => {
    expect(jumpVisible(0)).toBe(false)
    expect(jumpVisible(JUMP_AWAY_PX)).toBe(false)
  })

  test('shown once the newest message is properly off screen', () => {
    expect(jumpVisible(JUMP_AWAY_PX + 1)).toBe(true)
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

describe('the jump-to-bottom pill (QA #17)', () => {
  test('absent while the newest message is on screen', () => {
    expect(render({ onJumpToBottom: () => {} })).not.toContain('chat-jump-bottom')
  })

  test('present, named, and a 44px target once scrolled away', () => {
    const html = render({ showJumpToBottom: true, onJumpToBottom: () => {} })
    expect(html).toContain('data-testid="chat-jump-bottom"')
    expect(html).toContain('size-11')
    expect(html).toContain('aria-label="Jump to the newest message"')
  })

  test('no handler, no pill — the bench renders the same component', () => {
    expect(render({ showJumpToBottom: true })).not.toContain('chat-jump-bottom')
  })
})
