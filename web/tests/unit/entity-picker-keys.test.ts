/**
 * The picker's keyboard contract, as a truth table (fase B3 T1.2).
 * ─────────────────────────────────────────────────────────────────────────────
 * B3 merges four independent keyboard engines into one. Before any of them
 * moves, the meaning of every key is written down here — because a merge that
 * silently changes what ArrowDown does at the end of a list, or what Escape
 * does with a popover up, is exactly the kind of regression that ships.
 *
 * WHY THIS EXTENDS `composerKeyIntent` RATHER THAN INTRODUCING A SECOND
 * REDUCER. The plan called for extracting `entityPickerKeyIntent` out of the
 * composer. By the time B3 branched, fase B4 had already done the extraction —
 * `composerKeyIntent` is pure, IME-complete and separately tested. Adding a
 * rival beside it would have been the precise duplication this fase exists to
 * delete, so the existing reducer grew the four new keys and one new context
 * flag instead, and both anchors now read the same table.
 *
 * No DOM. Real key EVENTS can only be dispatched in Playwright (there is no
 * jsdom in this repo); what a key MEANS is a pure function, and that is the
 * half where the bugs live.
 */
import { describe, expect, test } from 'bun:test'

import { composerKeyIntent, type ComposerIntent } from '../../src/components/chat/composer-keys'
import { jumpTarget, PICKER_PAGE } from '../../src/components/chat/composer-keys'

/** The composer with a popover up, on a textarea (the TOKEN anchor). */
const token = { draft: '@ma', active: false, picker: true }
/** A search field with a list under it (the FIELD anchor) — no caret to protect. */
const field = { draft: 'ma', active: false, picker: true, caret: false }
/** No popover: the plain composer.  */
const plain = { draft: '', active: false }

function intent(
  key: string,
  ctx: Parameters<typeof composerKeyIntent>[1],
  mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
): ComposerIntent {
  return composerKeyIntent({ key, ...mods }, ctx)
}

describe('the picker owns its keys while it is open', () => {
  const table: [string, ComposerIntent][] = [
    ['ArrowUp', 'picker-up'],
    ['ArrowDown', 'picker-down'],
    ['Escape', 'picker-close'],
    ['Tab', 'picker-accept'],
    ['Enter', 'picker-accept'],
    ['PageUp', 'picker-page-up'],
    ['PageDown', 'picker-page-down'],
  ]
  for (const [key, want] of table) {
    test(`${key} → ${want}`, () => {
      expect(intent(key, token)).toBe(want)
    })
  }

  test('Escape closes the PICKER, never the draft and never the turn', () => {
    // One escape, one meaning, even when there are two things to escape from.
    // Without this, dismissing a suggestion list would also throw away the
    // sentence it was suggesting into — or interrupt a running agent.
    expect(intent('Escape', { draft: 'a long message', active: true, picker: true })).toBe(
      'picker-close',
    )
    // ...and with no picker, the old meanings are untouched.
    expect(intent('Escape', { draft: 'a long message', active: true })).toBe('clear')
    expect(intent('Escape', { draft: '', active: true })).toBe('stop')
    expect(intent('Escape', plain)).toBe('pass')
  })

  test('Shift+Tab passes through — it is the browser’s, not the list’s', () => {
    // Back-tabbing out of the composer has to keep working with a popover up,
    // or the picker becomes a focus trap on a surface whose whole rule is that
    // it never takes focus.
    expect(intent('Tab', token, { shiftKey: true })).toBe('pass')
  })

  test('Shift+Enter is a newline even with the picker open', () => {
    expect(intent('Enter', token, { shiftKey: true })).toBe('newline')
  })

  test('a MODIFIED Enter belongs to somebody else', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(intent('Enter', token, { [mod]: true })).toBe('pass')
    }
  })

  test('keys the picker has no claim on fall through', () => {
    expect(intent('ArrowLeft', token)).toBe('pass')
    expect(intent('ArrowRight', token)).toBe('pass')
    expect(intent('a', token)).toBe('pass')
    expect(intent('Backspace', token)).toBe('pass')
  })
})

describe('Home and End belong to the caret on a textarea, to the list on a field', () => {
  // The one cell where the two anchors disagree, and the reason the anchor is a
  // PARAMETER of this reducer rather than a second copy of it.
  test('the token anchor leaves them to the textarea', () => {
    // `@foo` is typed inside a sentence. Stealing Home to jump a suggestion
    // list would strand a user who wanted the start of their own line.
    expect(intent('Home', token)).toBe('pass')
    expect(intent('End', token)).toBe('pass')
  })

  test('the field anchor addresses the list with them', () => {
    // A palette input holds a QUERY, not prose — there is no line to go to the
    // start of, so the keys are free.
    expect(intent('Home', field)).toBe('picker-first')
    expect(intent('End', field)).toBe('picker-last')
  })

  test('every other key means the same thing on both anchors', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Escape', 'Tab', 'Enter', 'PageUp', 'PageDown']) {
      expect(intent(key, field)).toBe(intent(key, token))
    }
  })
})

describe('an IME composition outranks everything', () => {
  // Soft keyboards deliver nearly everything as a composition, and some never
  // set `isComposing` on the keydown that commits — hence keyCode 229 too. Get
  // this wrong and the composer sends half a word in Japanese, and every
  // keystroke in Korean, on a device the author never tested.
  const ways = [
    { isComposing: true },
    { nativeEvent: { isComposing: true } },
    { keyCode: 229 },
    { nativeEvent: { keyCode: 229 } },
  ]
  for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Tab', 'PageDown', 'Home']) {
    test(`${key} during composition is the IME's, on all four signals`, () => {
      for (const way of ways) {
        expect(composerKeyIntent({ key, ...way }, token)).toBe('pass')
        expect(composerKeyIntent({ key, ...way }, field)).toBe('pass')
      }
    })
  }
})

describe('the coarse jumps clamp, where the arrows wrap', () => {
  // The asymmetry is deliberate. A short list is a ring the arrows can spin
  // past the end of; but a user who presses End means "the end", and a Home
  // that wrapped to the bottom would move the highlight somewhere the
  // keystroke did not name.
  test('first and last go to the ends regardless of where they start', () => {
    expect(jumpTarget('first', 7, 12)).toBe(0)
    expect(jumpTarget('last', 7, 12)).toBe(11)
    expect(jumpTarget('first', 0, 12)).toBe(0)
    expect(jumpTarget('last', 11, 12)).toBe(11)
  })

  test('a page is a gear, not a synonym for Home/End', () => {
    expect(PICKER_PAGE).toBeLessThan(12)
    expect(jumpTarget('page-down', 0, 12)).toBe(PICKER_PAGE)
    expect(jumpTarget('page-up', 11, 12)).toBe(11 - PICKER_PAGE)
  })

  test('paging past an end stops at the end instead of re-entering at the other', () => {
    expect(jumpTarget('page-up', 1, 12)).toBe(0)
    expect(jumpTarget('page-down', 10, 12)).toBe(11)
  })

  test('a one-row list has nowhere to go and says so', () => {
    for (const to of ['first', 'last', 'page-up', 'page-down'] as const) {
      expect(jumpTarget(to, 0, 1)).toBe(0)
    }
  })

  test('an empty list yields 0, not a negative index', () => {
    // The callers all guard on `rows.length` first; returning -1 here would put
    // the same "is this a real row" decision in two places.
    for (const to of ['first', 'last', 'page-up', 'page-down'] as const) {
      expect(jumpTarget(to, 0, 0)).toBe(0)
    }
  })
})
