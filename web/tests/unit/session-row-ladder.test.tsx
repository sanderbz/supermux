/**
 * The list row's fact ladder — two rungs that decided nothing.
 *
 * Both are from the roster/overview polish batch, and both are the same shape
 * of defect: a slot the row reserves and can essentially never fill, and a fact
 * the row states twice.
 *
 *   TIER 2  the preview sourced ONLY `chat_tail`, and a chat store exists only
 *           while a chat client is attached to that session (the SSE producer
 *           deliberately uses the non-creating accessor so it "must not spin up
 *           a store for a session nobody is watching"). A roster is by
 *           definition the list of sessions nobody has open, so on a real
 *           instance `chat_tail` is null for every row: tiers 1 and 2 were
 *           byte-identical and the row reserved 20px for a line it could not
 *           show. `preview_lines` is the roster-wide tail that is already on
 *           the wire for every row — it is what the TILE draws — so it is the
 *           honest fallback.
 *
 *   STATUS  `waiting` was printed twice: once as the ladder's status word and
 *           once as the "Needs input" pill in the trailing cluster. The loudest
 *           state on the roster was also the only duplicated one.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { SessionRow } from '../../src/components/session-tile/session-row'
import type { TileSession } from '../../src/components/session-tile/types'

const base = (over: Partial<TileSession> = {}): TileSession =>
  ({
    name: 'supermux',
    status: 'idle',
    dir: '/tmp',
    provider: 'claude',
    updated_at: new Date().toISOString(),
    preview_lines: [],
    ...over,
  }) as TileSession

const html = (session: TileSession, sizeTier: 1 | 2 | 3 | 4 = 2): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SessionRow session={session} sizeTier={sizeTier} />
    </MemoryRouter>,
  )

describe('the preview line has a source on a real roster', () => {
  test('it falls back to `preview_lines` when there is no chat store', () => {
    const out = html(
      base({ preview_lines: ['npm test', 'one check left. then crates.io.', '', ''] }),
    )
    expect(out).toContain('one check left. then crates.io.')
  })

  test('trailing blank rows do not win — a captured pane is bottom-padded', () => {
    const out = html(base({ preview_lines: ['the real last line', '   ', ''] }))
    expect(out).toContain('the real last line')
  })

  test('`chat_tail` still wins when a store happens to exist', () => {
    const out = html(
      base({
        preview_lines: ['stale tail'],
        chat_tail: { agent: 'the fresher word' } as TileSession['chat_tail'],
      }),
    )
    expect(out).toContain('the fresher word')
    expect(out).not.toContain('stale tail')
  })

  test('tier 1 still shows no preview — the ladder is unchanged', () => {
    const out = html(base({ preview_lines: ['not at this rung'] }), 1)
    expect(out).not.toContain('not at this rung')
  })
})

describe('one status channel per row', () => {
  /** Visible text only — the accessible name legitimately repeats the status
   *  word, and counting the aria-label as a duplicate would be wrong. */
  const visible = (out: string): string => out.replace(/\saria-label="[^"]*"/g, '')

  test('`waiting` is stated once, by the pill', () => {
    const out = visible(html(base({ status: 'waiting' })))
    expect(out.match(/Needs input/g)?.length ?? 0).toBe(1)
  })

  test('every other status keeps its ladder word', () => {
    // The fix is a suppression for ONE state, not the removal of the rung.
    expect(visible(html(base({ status: 'active' })))).toContain('Running')
    expect(visible(html(base({ status: 'stopped' })))).toContain('Stopped')
  })
})
