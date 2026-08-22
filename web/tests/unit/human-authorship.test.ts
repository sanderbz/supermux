/**
 * P3c — per-message human authorship (web half).
 *
 * Two properties the render plane must hold:
 *
 *  1. `classifyPrompt` parses a server-stamped `<supermux-human>` wrapper into a
 *     `kind:'human'` row carrying the immutable author (id → hue, name → chip,
 *     company → scope), and refuses an unattributed one (no name = no
 *     provenance, byte-identical to an unattributed delegation).
 *  2. THE HUE FIREWALL: the circle `<HumanMark>`'s colour is a pure function of
 *     the immutable `author.userId`, NEVER the mutable display name — a rename
 *     must not recolour a colleague. Proven directly on `characterFromSeed`, the
 *     seed → hue hash the mark uses.
 */
import { describe, expect, test } from 'bun:test'

import { characterFromSeed } from '../../src/brand/marks'
import { classifyPrompt } from '../../src/components/chat/wire-entries'

describe('classifyPrompt parses the human-author wrapper', () => {
  test('a named human wrapper becomes a human row with the immutable author', () => {
    const c = classifyPrompt(
      '<supermux-human user="7" name="Sander" company="3">\nplease rebase the stack\n</supermux-human>',
    )
    expect(c.kind).toBe('human')
    expect(c.text).toBe('please rebase the stack')
    // The recall label is the display name (parity with recall.rs).
    expect(c.label).toBe('Sander')
    // The render plane additionally carries the immutable id + company.
    expect(c.author).toEqual({ userId: '7', name: 'Sander', companyId: '3' })
  })

  test('an escaped display name is unescaped, exactly as recall.rs does', () => {
    const c = classifyPrompt(
      '<supermux-human user="7" name="A&quot;&lt;b&gt;&amp;c" company="">\nhi\n</supermux-human>',
    )
    expect(c.kind).toBe('human')
    expect(c.author?.name).toBe('A"<b>&c')
    // An empty company attribute is dropped, not carried as "".
    expect(c.author?.companyId).toBeUndefined()
  })

  test('an unattributed human wrapper never leaks its body as a bare prompt', () => {
    const c = classifyPrompt('<supermux-human user="7" company="3">\nsecret\n</supermux-human>')
    expect(c.kind).toBe('system')
    expect(c.author).toBeUndefined()
  })
})

describe('the human hue firewall — keyed on the immutable id, never the name', () => {
  test('the mark hue is a pure function of the user id, stable across renames', () => {
    // Two transcripts of the SAME person, before and after a display-name change,
    // classify to the same author id — so the mark seed (author.userId) is the
    // same, and the hue does not move.
    const before = classifyPrompt('<supermux-human user="7" name="Sander" company="3">\nx\n</supermux-human>')
    const after = classifyPrompt('<supermux-human user="7" name="Sander Bosma" company="3">\nx\n</supermux-human>')
    expect(before.author?.userId).toBe('7')
    expect(after.author?.userId).toBe('7')
    expect(before.author?.name).not.toBe(after.author?.name)

    const hueBefore = characterFromSeed(before.author!.userId).hue
    const hueAfter = characterFromSeed(after.author!.userId).hue
    expect(hueBefore).toBe(hueAfter)
  })

  test('characterFromSeed(id) is deterministic and distinguishes different people', () => {
    expect(characterFromSeed('7').hue).toBe(characterFromSeed('7').hue)
    // Two different colleagues get their own pigment (the id space is what the
    // hash spreads — not a guarantee for every pair, but these two differ).
    expect(characterFromSeed('7').hue).not.toBe(characterFromSeed('42').hue)
  })
})
