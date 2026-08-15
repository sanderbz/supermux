/**
 * `frames.ts` — which tool receipts earn a captured-frame card.
 * ─────────────────────────────────────────────────────────────────────────────
 * The card is 340×~250 of warm, shadowed object in the middle of a turn, so the
 * detector is CONSERVATIVE by construction: a false negative costs a filename in
 * a receipt line (which is still there, and still readable), a false positive
 * costs a screenful. Everything below is therefore written as a pair — the case
 * that must render, and the near-miss that must not.
 *
 * The receipt label the server produces is `<Tool> <most salient input>`
 * (`server/src/sessions/recall.rs::tool_line`), which is why the tool gate reads
 * the FIRST token and the path scan reads the rest.
 */
import { describe, expect, test } from 'bun:test'

import type { ReceiptLine } from '../../src/components/chat/entries'
import { framesIn, frameFor, FRAMES_PER_GROUP } from '../../src/components/chat/frames'

const line = (over: Partial<ReceiptLine> & { label: string }): ReceiptLine => ({
  uuid: 'u1',
  ...over,
})

describe('frameFor — what earns a card', () => {
  test('a Read of an image names it', () => {
    expect(frameFor(line({ label: 'Read /opt/projects/supermux/shots/release-run.png' }))).toEqual({
      caption: 'release-run.png',
      path: '/opt/projects/supermux/shots/release-run.png',
    })
  })

  test('a Write of an image too — the session made it', () => {
    expect(frameFor(line({ label: 'Write /tmp/board-light.jpeg' }))).toEqual({
      caption: 'board-light.jpeg',
      path: '/tmp/board-light.jpeg',
    })
  })

  test('every image extension the design ships', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      expect(frameFor(line({ label: `Read /a/b/shot.${ext}` }))?.caption).toBe(`shot.${ext}`)
    }
  })

  test('a screenshot-shaped label, whatever tool ran it', () => {
    const f = frameFor(
      line({ label: 'Bash screenshot --out /tmp/mobile-light.png', result: 'saved' }),
    )
    expect(f).toEqual({ caption: 'mobile-light.png', path: '/tmp/mobile-light.png' })
  })

  test('the path can arrive in the RESULT rather than the label', () => {
    const f = frameFor(line({ label: 'Bash screenshot', result: 'wrote /tmp/out/frame.webp' }))
    expect(f?.path).toBe('/tmp/out/frame.webp')
  })

  test('the emoji taxonomy never reaches the label', () => {
    expect(frameFor(line({ label: '📸 Read /a/hero.png' }))?.caption).toBe('hero.png')
  })

  test('a relative path still captions, but carries no path to fetch', () => {
    // B0's documented behaviour: no `src` ⇒ the honest warm placeholder.
    expect(frameFor(line({ label: 'Read shots/hero.png' }))).toEqual({ caption: 'hero.png' })
  })
})

describe('frameFor — the near misses', () => {
  const rejects = [
    ['a bare Read with no path', line({ label: 'Read' })],
    ['a non-image file', line({ label: 'Read /opt/projects/supermux/notes.md' })],
    ['an image extension that is not the last one', line({ label: 'Read /tmp/chart.png.bak' })],
    ['a glob that merely mentions images', line({ label: 'Bash ls *.png' })],
    ['a grep whose pattern looks like a file', line({ label: 'Grep hero.png' })],
    ['an extension with no name in front of it', line({ label: 'Read /tmp/.png' })],
    ['a failed call — it produced nothing to show', line({ label: 'Read /a/hero.png', ok: false })],
  ] as const

  for (const [why, l] of rejects) {
    test(why, () => expect(frameFor(l)).toBeNull())
  }
})

describe('framesIn — a group of receipts', () => {
  const reads = (n: number) =>
    Array.from({ length: n }, (_, i) => line({ uuid: `u${i}`, label: `Read /a/shot-${i}.png` }))

  test('collects every frame in order', () => {
    expect(framesIn(reads(3)).map((f) => f.caption)).toEqual([
      'shot-0.png',
      'shot-1.png',
      'shot-2.png',
    ])
  })

  test('caps the previews — the receipt lines still name every file', () => {
    // A twelve-image read run would be ~3000px of card. The cap is a PREVIEW
    // cap, not a data cap: all twelve are still listed as receipt lines.
    expect(framesIn(reads(12))).toHaveLength(FRAMES_PER_GROUP)
  })

  test('skips the lines that earn nothing', () => {
    expect(
      framesIn([line({ label: 'cargo check' }), line({ label: 'Read /a/x.png' })]),
    ).toHaveLength(1)
  })
})
