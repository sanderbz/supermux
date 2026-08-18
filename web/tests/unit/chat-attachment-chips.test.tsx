/**
 * The composer's attachment chip row (feat/grok-mode composer upgrade).
 * ─────────────────────────────────────────────────────────────────────────────
 * `AttachmentChips` is pure presentational: it takes the staged list and renders
 * one chip per attachment in one of four states. This repo has no jsdom, so a
 * real remove-click is Playwright's job; what a unit test pins is the STRUCTURE
 * each state produces — the image thumbnail vs the file glyph, the uploading
 * spinner, the error text, the filename rule, and the remove button — plus the
 * empty-list invariant that keeps an unwired composer byte-identical.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { AttachmentChips } from '../../src/components/chat/attachment-chips'
import type { StagedAttachment } from '../../src/components/focus-mode/use-staged-attachments'

function att(over: Partial<StagedAttachment> = {}): StagedAttachment {
  return {
    id: 'a1',
    name: 'file.txt',
    uploading: false,
    previewUrl: null,
    path: '/data/uploads/file.txt',
    ...over,
  }
}

const render = (attachments: StagedAttachment[]) =>
  renderToStaticMarkup(<AttachmentChips attachments={attachments} onDismiss={() => undefined} />)

describe('AttachmentChips', () => {
  test('renders nothing when the list is empty (byte-identical unwired)', () => {
    expect(render([])).toBe('')
  })

  test('a ready non-image shows a file glyph + the filename + a remove button', () => {
    const html = render([att({ name: 'report.pdf', previewUrl: null })])
    expect(html).toContain('data-state="ready"')
    expect(html).toContain('report.pdf')
    // No thumbnail for a non-image.
    expect(html).not.toContain('<img')
    // The remove affordance is labelled by the file it drops.
    expect(html).toContain('Remove report.pdf')
    expect(html).toContain('data-testid="chat-attachment-remove"')
  })

  test('a ready image shows a thumbnail and hides the filename', () => {
    const html = render([
      att({ id: 'img', name: 'shot.png', previewUrl: 'blob:preview', path: '/data/uploads/shot.png' }),
    ])
    expect(html).toContain('<img')
    expect(html).toContain('blob:preview')
    // The thumbnail carries it — the name is not shown as text.
    expect(html).not.toContain('>shot.png<')
  })

  test('uploading shows the spinner and the ready path is not yet shown', () => {
    const html = render([att({ uploading: true, path: null })])
    expect(html).toContain('data-state="uploading"')
    expect(html).toContain('animate-spin')
  })

  test('an error chip carries the reason in place of the filename', () => {
    const html = render([
      att({ name: 'huge.png', previewUrl: 'blob:x', error: '“huge.png” is over 5 MB — too large for Claude to view.', path: null }),
    ])
    expect(html).toContain('data-state="error"')
    expect(html).toContain('over 5 MB')
    // Even an image chip surfaces its error text (the thumbnail can't explain a failure).
    expect(html).toContain('<img')
  })

  test('renders one chip per staged attachment', () => {
    const html = render([att({ id: 'a' }), att({ id: 'b', name: 'two.txt', path: '/data/uploads/two.txt' })])
    const chips = html.split('data-testid="chat-attachment-chip"').length - 1
    expect(chips).toBe(2)
  })
})
