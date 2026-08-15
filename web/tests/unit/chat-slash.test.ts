/**
 * `@`-files and `/`-commands — the arithmetic (fase A4 T9).
 * ─────────────────────────────────────────────────────────────────────────────
 * Three failures are pinned here, and each one is invisible to the user until
 * it has already happened:
 *
 *   1. A TRIGGER THAT FIRES ON PROSE. An e-mail address in a pasted paragraph,
 *      or a path typed mid-sentence, must not open a popover that then eats the
 *      next Enter.
 *   2. A PICKER-OPENING COMMAND SENT ANYWAY. `/model` leaves a widget on a pty
 *      nobody is looking at, and the session answers the NEXT message into it.
 *      The classification is the only thing standing between the user and that.
 *   3. A FILTER THAT BURIES THE OBVIOUS MATCH. `main` has to find
 *      `server/src/main.rs`, not the first path that happens to contain the
 *      letters m-a-i-n.
 */
import { describe, expect, test } from 'bun:test'

import {
  classifySlash,
  fuzzyScore,
  PASS_THROUGH,
  PICKER_OPENING,
  rankEntities,
  readTrigger,
  slashName,
} from '../../src/components/chat/slash'
import { insertAtCaret } from '../../src/components/chat/composer-insert'

// ── 1. The trigger ──────────────────────────────────────────────────────────

describe('readTrigger — where the caret actually is', () => {
  test('`@` opens at the start of the draft and after a space', () => {
    expect(readTrigger('@', 1)).toEqual({ kind: '@', query: '', start: 0, end: 1 })
    expect(readTrigger('fix @mai', 8)).toEqual({
      kind: '@',
      query: 'mai',
      start: 4,
      end: 8,
    })
  })

  test('`@` inside a word is an e-mail address, not a picker', () => {
    expect(readTrigger('sander@example.com', 18)).toBeNull()
  })

  test('a space after the token closes it — the user has moved on', () => {
    expect(readTrigger('@src/main.rs and ', 17)).toBeNull()
  })

  test('the token is read at the CARET, not at the end of the draft', () => {
    // Caret parked back inside the first token; the trailing words are ignored.
    expect(readTrigger('@mai rest of the sentence', 4)).toEqual({
      kind: '@',
      query: 'mai',
      start: 0,
      end: 4,
    })
  })

  test('`/` triggers only as the draft’s first token (the TUI’s own rule)', () => {
    expect(readTrigger('/comp', 5)?.kind).toBe('/')
    // Otherwise every path opens the command menu on its second character.
    expect(readTrigger('open server/src', 15)).toBeNull()
    expect(readTrigger('  /comp', 7)?.kind).toBe('/')
  })

  test('the nearest trigger wins, and prose past 64 chars is prose', () => {
    expect(readTrigger('@a @b', 5)).toEqual({ kind: '@', query: 'b', start: 3, end: 5 })
    // …and a second `@` glued INSIDE the first token is still one word.
    expect(readTrigger('@a@b', 4)).toBeNull()
    expect(readTrigger(`@${'x'.repeat(65)}`, 66)).toBeNull()
  })

  test('an out-of-range caret is clamped, never thrown', () => {
    expect(readTrigger('@mai', 999)?.query).toBe('mai')
    expect(readTrigger('@mai', -3)).toBeNull()
  })
})

describe('accepting a pick replaces the token (T3’s spacing rule, reused)', () => {
  test('`fix @mai` + src/main.rs → `fix @src/main.rs`, caret after it', () => {
    const draft = 'fix @mai'
    const t = readTrigger(draft, draft.length)!
    const out = insertAtCaret(draft, { start: t.start, end: t.end }, '@src/main.rs')
    expect(out.draft).toBe('fix @src/main.rs')
    expect(out.caret).toBe(out.draft.length)
  })

  test('a pick in the MIDDLE of a sentence keeps the words after it spaced', () => {
    const draft = 'diff @mai please'
    const t = readTrigger(draft, 9)!
    const out = insertAtCaret(draft, { start: t.start, end: t.end }, '@server/src/main.rs')
    expect(out.draft).toBe('diff @server/src/main.rs please')
    expect(out.caret).toBe('diff @server/src/main.rs'.length)
  })

  test('a slash pick lands with no leading space', () => {
    const draft = '/comp'
    const t = readTrigger(draft, draft.length)!
    expect(insertAtCaret(draft, { start: t.start, end: t.end }, '/compact').draft).toBe(
      '/compact',
    )
  })
})

// ── 2. The classification ───────────────────────────────────────────────────

describe('classifySlash — what may be sent', () => {
  test('text-safe commands pass through, arguments and case included', () => {
    for (const cmd of PASS_THROUGH) expect(classifySlash(cmd)).toBe('pass')
    expect(classifySlash('/compact focus on the money parser')).toBe('pass')
    expect(classifySlash('/COMPACT')).toBe('pass')
  })

  test('every picker-opening command is refused', () => {
    for (const cmd of PICKER_OPENING) expect(classifySlash(cmd)).toBe('picker')
    expect(classifySlash('/model opus')).toBe('picker')
  })

  test('a project or skill command is unknown — pass-through WITH a note', () => {
    expect(classifySlash('/deploy-self')).toBe('unknown')
    expect(classifySlash('/superpowers:brainstorm an idea')).toBe('unknown')
  })

  test('prose is not a command, and a bare slash is not either', () => {
    expect(classifySlash('ship it once CI is green')).toBe('pass')
    expect(classifySlash('/')).toBe('pass')
    expect(slashName('/')).toBeNull()
    expect(slashName('ship it')).toBeNull()
    expect(slashName('  /clear ')).toBe('/clear')
  })

  test('the two lists never overlap — one command, one verdict', () => {
    for (const cmd of PICKER_OPENING) {
      expect((PASS_THROUGH as readonly string[]).includes(cmd)).toBe(false)
    }
  })
})

// ── 3. The filter ───────────────────────────────────────────────────────────

describe('the client-side filter', () => {
  const FILES = [
    'web/src/lib/domain.ts',
    'server/src/main.rs',
    'server/src/sessions/mod.rs',
    'docs/README.md',
  ]

  test('a basename match outranks a mid-word one', () => {
    expect(rankEntities(FILES, 'main', (f) => f)[0]).toBe('server/src/main.rs')
  })

  test('an empty query keeps the server’s own order', () => {
    expect(rankEntities(FILES, '', (f) => f)).toEqual(FILES)
  })

  test('subsequence still finds it — `ssmod` → sessions/mod.rs', () => {
    expect(rankEntities(FILES, 'ssmod', (f) => f)[0]).toBe('server/src/sessions/mod.rs')
  })

  test('a miss is dropped, not ranked last', () => {
    expect(rankEntities(FILES, 'zzzz', (f) => f)).toEqual([])
    expect(fuzzyScore('server/src/main.rs', 'zzzz')).toBe(-1)
  })

  test('the limit is honoured', () => {
    expect(rankEntities(FILES, '', (f) => f, 2).length).toBe(2)
  })

  test('matching is case-insensitive in both directions', () => {
    expect(fuzzyScore('docs/README.md', 'readme')).toBeGreaterThan(0)
    expect(fuzzyScore('docs/readme.md', 'README')).toBeGreaterThan(0)
  })
})
