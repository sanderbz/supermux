/**
 * The per-message export plane (`message-export.ts`) — pure-function net.
 * ─────────────────────────────────────────────────────────────────────────────
 * The DOM/share/clipboard sides are exercised offline in the Playwright rig; the
 * string helpers are pinned here in `bun test` with no DOM: the `.md`/`.html`
 * source is `item.text` verbatim, filenames are deterministic (no `Math.random`,
 * so a message always names the same file), and `canShareText` is a feature
 * probe that never throws.
 */
import { describe, expect, test } from 'bun:test'

import {
  canShareText,
  messageFilename,
  SHARE_TITLE,
  toHtmlDocument,
} from '../../src/components/chat/message-export'

describe('message export — filenames', () => {
  test('deterministic: the same text always names the same file', () => {
    const t = '# Hello\n\nsome **markdown** body'
    expect(messageFilename(t, 'md')).toBe(messageFilename(t, 'md'))
    expect(messageFilename(t, 'html')).toBe(messageFilename(t, 'html'))
  })

  test('shape is message-<id>.<ext>', () => {
    expect(messageFilename('anything', 'md')).toMatch(/^message-[0-9a-z]{6}\.md$/)
    expect(messageFilename('anything', 'html')).toMatch(/^message-[0-9a-z]{6}\.html$/)
  })

  test('different messages get different ids (no collision on the common case)', () => {
    expect(messageFilename('one', 'md')).not.toBe(messageFilename('two', 'md'))
  })
})

describe('message export — html document', () => {
  test('wraps the rendered body in a standalone, openable document', () => {
    const doc = toHtmlDocument('<p>hi there</p>')
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<meta charset="utf-8">')
    expect(doc).toContain('<p>hi there</p>')
    expect(doc).toContain(`<title>${SHARE_TITLE}</title>`)
    expect(doc.trimEnd().endsWith('</html>')).toBe(true)
  })

  test('the title is escaped — a message title can never break out of <title>', () => {
    const doc = toHtmlDocument('<p>x</p>', 'a <script> & "friends"')
    expect(doc).toContain('a &lt;script&gt; &amp; &quot;friends&quot;')
    expect(doc).not.toContain('<title>a <script>')
  })

  test('the body is inserted verbatim — the markdown render is the source, not re-escaped', () => {
    const body = '<h1>Title</h1><pre><code>const x = 1</code></pre>'
    expect(toHtmlDocument(body)).toContain(body)
  })
})

describe('message export — share probe', () => {
  test('canShareText returns a boolean and never throws', () => {
    expect(typeof canShareText()).toBe('boolean')
  })
})
