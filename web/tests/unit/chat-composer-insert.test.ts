/**
 * The composer's text arithmetic (fase A4 T3).
 * ─────────────────────────────────────────────────────────────────────────────
 * Four surfaces drop text into the composer — the attachment injector, the
 * snippet panel, the dock's slash row and the T9 `@`/`/` pickers — and before
 * A4 each of them spaced its own way into a pty prompt that forgave it. A React
 * composer does not forgive it: one missing space glues a path onto a word, one
 * extra is visible. So the rule is one function, and this is what it promises.
 */
import { describe, expect, test } from 'bun:test'

import {
  attachmentSentence,
  insertAtCaret,
} from '../../src/components/chat/composer-insert'
import { buildAttachmentPrompt } from '../../src/lib/api/files'

describe('insertAtCaret', () => {
  test('spaces exactly once — never zero, never twice', () => {
    expect(insertAtCaret('fix', 3, '@src/main.rs').draft).toBe('fix @src/main.rs')
    expect(insertAtCaret('fix ', 4, '@src/main.rs').draft).toBe('fix @src/main.rs')
    expect(insertAtCaret('', 0, '/compact').draft).toBe('/compact')
  })

  test('the caret lands after the inserted token, not at the end of the draft', () => {
    const out = insertAtCaret('fix and ship', 3, '@src/main.rs')
    expect(out.draft).toBe('fix @src/main.rs and ship')
    // …directly after the token: the user carries on writing the sentence they
    // were writing, which is the whole reason the caret is returned at all.
    expect(out.draft.slice(0, out.caret)).toBe('fix @src/main.rs')
  })

  test('a token dropped mid-sentence does not glue onto what follows', () => {
    expect(insertAtCaret('look at the tests', 11, '@a.ts').draft).toBe(
      'look at the @a.ts tests',
    )
  })

  test('a selection is replaced, not pushed aside', () => {
    const out = insertAtCaret('read foo.ts now', { start: 5, end: 11 }, '@bar.ts')
    expect(out.draft).toBe('read @bar.ts now')
    expect(out.caret).toBe('read @bar.ts'.length)
  })

  test('an out-of-range or unknown caret appends rather than corrupting', () => {
    // `selectionStart` is null on a detached field and a stale caret can outlive
    // a programmatic draft change by one render — both must append, never slice
    // the draft in half.
    expect(insertAtCaret('fix', 99, '@a.ts').draft).toBe('fix @a.ts')
    expect(insertAtCaret('fix', -1, '@a.ts').draft).toBe('fix @a.ts')
  })

  test('inserting nothing changes nothing', () => {
    expect(insertAtCaret('fix', 1, '')).toEqual({ draft: 'fix', caret: 1 })
  })

  test('a token that brings its own whitespace is not padded twice', () => {
    // `attachmentSentence` ships a trailing space (below); a second attachment
    // must not land two spaces deep.
    const first = insertAtCaret('look at', 7, attachmentSentence(['/tmp/a.png']))
    expect(first.draft).toBe('look at "/tmp/a.png" ')
    const second = insertAtCaret(first.draft, first.caret, attachmentSentence(['/tmp/b.png']))
    expect(second.draft).toBe('look at "/tmp/a.png" "/tmp/b.png" ')
  })
})

describe('attachmentSentence', () => {
  test('quoted absolute paths, space-separated, one trailing space', () => {
    expect(attachmentSentence(['/data/uploads/shot.png'])).toBe('"/data/uploads/shot.png" ')
    expect(attachmentSentence(['/a b/c.png', '/d.png'])).toBe('"/a b/c.png" "/d.png" ')
  })

  test('byte-for-byte what the TERMINAL has always injected', () => {
    // The rule is re-derived (composer-insert.ts stays import-free) but it is
    // NOT re-invented: `buildAttachmentPrompt` is what the dock, the dropzone
    // and clipboard-paste have written into the pty since before the chat
    // renderer existed. Prose cannot hold two copies of one rule together, so
    // this test does — the same attachment must read identically whichever
    // renderer happens to be mounted.
    for (const paths of [
      [],
      ['/data/uploads/shot.png'],
      ['/a b/c.png', '/d.png'],
      ['/tmp/one.png', '/tmp/two.png', '/tmp/three.png'],
    ]) {
      expect(attachmentSentence(paths)).toBe(buildAttachmentPrompt(paths))
    }
  })

  test('no files, no sentence', () => {
    expect(attachmentSentence([])).toBe('')
  })
})
