/**
 * Daily-driver QA #18 — a fenced block that clips with no way to know.
 *
 * Measured on the live instance at 390px: `clientWidth 228` against a
 * `scrollWidth` of up to 540, `overflow-x: auto`, and no visible scrollbar —
 * touch platforms draw overlay scrollbars, which only appear once you are
 * already scrolling. `wget -c https://example.com,` and `find / -type f -size
 * +500M :` just stopped (`29-back-from-background.png`).
 *
 * On the phone the fence WRAPS, which is the version of the fix with nothing
 * left to hint at. The desktop keeps the scroll — a 648px bubble holds most
 * lines, a pointer draws a real scrollbar, and column-aligned output is worth
 * keeping aligned.
 */
import { describe, expect, test } from 'bun:test'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { chatComponents } from '../../src/components/chat/markdown/chat-components'

const LONG = 'wget -c https://example.com/a/very/long/path/that/does/not/fit-in-a-bubble.tar.gz'

function fence(surface: 'desktop' | 'phone', children: string = LONG): string {
  const Pre = chatComponents({ surface }).pre as ComponentType<{
    className?: string
    children?: unknown
  }>
  return renderToStaticMarkup(<Pre className="language-bash">{children}</Pre>)
}

describe('the fenced block on the phone', () => {
  test('wraps instead of clipping into an invisible scroll', () => {
    const out = fence('phone')
    expect(out).toContain('whitespace-pre-wrap')
    // `overflow-wrap` is the half that matters for the offender: a URL has no
    // space in it to break at, so a plain wrap would still overflow.
    expect(out).toContain('overflow-wrap:anywhere')
    // And with nothing off screen, there is nothing to scroll.
    expect(out).not.toContain('overflow-x-auto')
  })

  test('the whole command is in the markup — the wrap hides nothing', () => {
    expect(fence('phone')).toContain('fit-in-a-bubble.tar.gz')
  })
})

describe('the fenced block on the desktop', () => {
  test('keeps its scroll and its column alignment', () => {
    const out = fence('desktop')
    expect(out).toContain('overflow-x-auto')
    expect(out).not.toContain('whitespace-pre-wrap')
  })
})

describe('a diff is still a diff, on either surface', () => {
  const DIFF = '-old line\n+new line'
  test('the two inks survive the wrap', () => {
    for (const surface of ['phone', 'desktop'] as const) {
      const out = fence(surface, DIFF)
      expect(out).toContain('text-ink-3')
      expect(out).toContain('old line')
      expect(out).toContain('new line')
    }
  })
})
