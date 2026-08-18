/**
 * The composer's attachment wiring (feat/grok-mode composer upgrade).
 * ─────────────────────────────────────────────────────────────────────────────
 * Two things a unit test can pin without jsdom:
 *
 *   1. ADDITIVE STRUCTURE. `attachments` is optional. Wired ⇒ the desktop attach
 *      disc appears in the leading pair and the chip row renders above the pill.
 *      Absent ⇒ neither does, so a composer that does not wire uploads is
 *      byte-identical to today. (A real pick / paste / drop is Playwright's job —
 *      the same SSR-vs-events split the mic and picker tests call out.)
 *
 *   2. THE OUTGOING PAYLOAD CONTRACT. On Send the wire text is
 *      `attachmentSentence(readyPaths()) + draft` — quoted absolute paths first,
 *      then the prose, and an image ALONE (empty draft) is a valid send. This is
 *      the exact composition `use-composer.ts::submit` folds in; the end-to-end
 *      POST-body assertion lives in the offline Playwright rig against
 *      `/dev/composer-attach`.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatComposer } from '../../src/components/chat/composer'
import { attachmentSentence } from '../../src/components/chat/composer-insert'
import type { ComposerHandle } from '../../src/components/chat/use-composer'
import type {
  StagedAttachment,
  UseStagedAttachmentsResult,
} from '../../src/components/focus-mode/use-staged-attachments'

function handle(over: Partial<ComposerHandle> = {}): ComposerHandle {
  return {
    draft: '',
    setDraft: () => undefined,
    ref: React.createRef<HTMLTextAreaElement>(),
    sending: false,
    notice: null,
    dismissNotice: () => undefined,
    submit: () => undefined,
    stop: () => undefined,
    insert: () => undefined,
    handoff: null,
    handoffPending: null,
    picker: {
      open: false,
      kind: '@',
      query: '',
      pick: () => undefined,
      close: () => undefined,
      bind: () => undefined,
    },
    onChange: () => undefined,
    onKeyDown: () => undefined,
    onSelect: () => undefined,
    ...over,
  }
}

function staged(list: StagedAttachment[] = []): UseStagedAttachmentsResult {
  return {
    attachments: list,
    uploading: list.some((a) => a.uploading),
    handleFiles: () => undefined,
    dismiss: () => undefined,
    readyPaths: () => list.filter((a) => !a.uploading && !a.error && a.path).map((a) => a.path as string),
    reset: () => undefined,
  }
}

const desktop = (over: Partial<ComposerHandle>, atts?: UseStagedAttachmentsResult) =>
  renderToStaticMarkup(
    <ChatComposer
      name="release-train"
      label="Release Train"
      handle={handle(over)}
      surface="desktop"
      attachments={atts}
    />,
  )

describe('ChatComposer — attachments are additive', () => {
  test('no attachments prop ⇒ no attach disc, no chip row (byte-identical)', () => {
    const html = desktop({})
    expect(html).not.toContain('data-testid="chat-composer-attach"')
    expect(html).not.toContain('data-testid="chat-attachment-chips"')
  })

  test('attachments wired ⇒ the desktop attach disc renders in the leading pair', () => {
    const html = desktop({}, staged())
    expect(html).toContain('data-testid="chat-composer-attach"')
    expect(html).toContain('Attach a file')
  })

  test('a staged file renders a chip above the pill', () => {
    const html = desktop(
      {},
      staged([
        { id: 'a', name: 'note.txt', uploading: false, previewUrl: null, path: '/data/uploads/note.txt' },
      ]),
    )
    expect(html).toContain('data-testid="chat-attachment-chips"')
    expect(html).toContain('note.txt')
  })

  test('an image alone (empty draft) shows the armed Send disc', () => {
    const html = desktop(
      { draft: '' },
      staged([
        { id: 'i', name: 'shot.png', uploading: false, previewUrl: 'blob:x', path: '/data/uploads/shot.png' },
      ]),
    )
    // Send is present (not the mic) because a ready image is a sendable message.
    expect(html).toContain('data-testid="chat-send"')
  })

  test('while an upload is settling the Send disc is present but disabled', () => {
    const html = desktop(
      { draft: 'here' },
      staged([{ id: 'u', name: 'x.png', uploading: true, previewUrl: 'blob:x', path: null }]),
    )
    expect(html).toContain('data-testid="chat-send"')
    expect(html).toContain('Waiting for uploads…')
    expect(html).toContain('disabled')
  })
})

describe('the outgoing payload contract (paths-first, quoted)', () => {
  test('paths are quoted, space-separated, and precede the prose', () => {
    const wire = attachmentSentence(['/data/uploads/a.png', '/data/uploads/b.pdf']) + 'look at these'
    expect(wire).toBe('"/data/uploads/a.png" "/data/uploads/b.pdf" look at these')
  })

  test('an image alone is just the quoted path (empty prose)', () => {
    const wire = attachmentSentence(['/data/uploads/a.png']) + ''
    expect(wire).toBe('"/data/uploads/a.png" ')
    expect(wire).toContain('/data/uploads/a.png')
  })

  test('no ready paths ⇒ the prose is unchanged', () => {
    expect(attachmentSentence([]) + 'hello').toBe('hello')
  })
})
