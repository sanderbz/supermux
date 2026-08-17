/**
 * **The MCP-elicitation parity contract — TypeScript half.**
 *
 * Twin of `server/tests/elicitation_parity.rs`. Both read the SAME corpus,
 * `server/tests/fixtures/hooks/elicitation.jsonl`: `Elicitation` hook payloads
 * in Claude Code 2.1.227's documented shape, the typed form each becomes, and
 * the exact complaint each value set must raise.
 *
 * Why the validator is asserted in BOTH languages rather than trusted from the
 * server: the form is validated twice, and the two are answering different
 * questions at different moments. This one runs on every keystroke — a required
 * field that only fails on submit is a form nobody finishes — and the Rust one
 * runs before an answer could ever be delivered to a third-party MCP server.
 * Nothing but this corpus holds the two sets of sentences together, and a
 * "Must be a valid email address" that one plane enforces and the other does
 * not is a card that says the answer went through when it did not.
 *
 * The FIELDS come from the corpus (which the Rust half proves the real parser
 * emits for the same payload), never from a local re-parse — so this file
 * cannot make the corpus pass by agreeing with itself.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  buildAnswer,
  initialValues,
  validateAll,
  validateField,
  type ElicitationField,
  type FormValue,
} from '../../src/components/chat/elicitation'

interface Row {
  name: string
  source: string
  payload: Record<string, unknown>
  expect: {
    server?: string
    message?: string
    id?: string
    fields?: ElicitationField[]
    dropped_fields?: number
  } | null
  cases?: { why: string; content: Record<string, FormValue>; problems: [string, string][] }[]
}

const CORPUS: Row[] = readFileSync(
  new URL('../../../server/tests/fixtures/hooks/elicitation.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row & { _?: string })
  .filter((r) => (r as { _?: string })._ === undefined)

const byName = (needle: string): Row => {
  const row = CORPUS.find((r) => r.name.includes(needle))
  if (!row) throw new Error(`corpus row missing: ${needle}`)
  return row
}

describe('the shared elicitation corpus', () => {
  test('is present and has not shrunk', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(7)
  })

  test('still carries the row that must be REFUSED outright', () => {
    // An ask with no `mcp_server_name` has no attribution, and an unattributed
    // third-party prompt in this app's own voice is the one card this feature
    // must never draw. The server never sends one; this row is the proof.
    expect(CORPUS.some((r) => r.expect === null)).toBe(true)
  })
})

describe('elicitation.ts agrees with elicitation.rs on every value set', () => {
  for (const row of CORPUS) {
    const fields = row.expect?.fields
    if (!fields || !row.cases?.length) continue
    for (const c of row.cases) {
      test(`${row.name} — ${c.why}`, () => {
        const got = validateAll(fields, c.content).map((p) => [p.field, p.message])
        expect(got).toEqual(c.problems)
      })
    }
  }
})

describe('every field is validated the same way one at a time as in bulk', () => {
  // `validateField` is what a control calls on blur; `validateAll` is what the
  // submit button reads. A card whose per-field message disagrees with its
  // submit gate is a card that goes red on a field it will then accept.
  for (const row of CORPUS) {
    const fields = row.expect?.fields
    if (!fields || !row.cases?.length) continue
    test(row.name, () => {
      for (const c of row.cases!) {
        const bulk = new Map(validateAll(fields, c.content).map((p) => [p.field, p.message]))
        for (const f of fields) {
          expect(validateField(f, c.content[f.name])).toBe(bulk.get(f.name))
        }
      }
    })
  }
})

describe('the answer is shaped exactly like an MCP elicitation response', () => {
  const headline = byName('the headline form')
  const fields = headline.expect!.fields!

  test('accept carries the typed content, coerced out of the controls', () => {
    // Number controls hold STRINGS while they are being typed; what leaves must
    // be a number, because the MCP server validates against its own schema.
    const answer = buildAnswer('accept', fields, {
      approver: 'a@b.co',
      builds: '3',
      env: 'staging',
      notify: true,
    })
    expect(answer).toEqual({
      action: 'accept',
      content: { approver: 'a@b.co', builds: 3, env: 'staging', notify: true },
    })
  })

  test('a blank optional field is OMITTED, not sent as an empty string', () => {
    // An empty number box and an unfilled one are the same thing, and both are
    // different from `0` — a third-party server validates the difference.
    const answer = buildAnswer('accept', fields, { approver: 'a@b.co', builds: '', env: 'prod' })
    expect(answer.content).toEqual({ approver: 'a@b.co', env: 'prod' })
    expect('builds' in answer.content!).toBe(false)
    // …and a boolean the form never mounted is absent rather than guessed as
    // `false`, which would answer a question nobody asked.
    expect('notify' in answer.content!).toBe(false)
  })

  test('false is an answer and survives the trip', () => {
    const answer = buildAnswer('accept', fields, { approver: 'a@b.co', env: 'prod', notify: false })
    expect(answer.content!.notify).toBe(false)
  })

  test('decline and cancel carry NO content — the refusal has to be real', () => {
    for (const action of ['decline', 'cancel'] as const) {
      const answer = buildAnswer(action, fields, { approver: 'secret@corp.example', env: 'prod' })
      expect(answer).toEqual({ action })
      expect(answer.content).toBeUndefined()
    }
  })

  test('a property no control could render is never invented into the answer', () => {
    const odd = byName('a property neither renderer can type')
    const answer = buildAnswer('accept', odd.expect!.fields!, { shards: 'whatever' })
    expect(answer.content).toEqual({})
  })
})

describe('a form opens on the values the schema asked for', () => {
  test('defaults pre-fill, booleans start false, everything else starts empty', () => {
    const fields = byName('the headline form').expect!.fields!
    expect(initialValues(fields)).toEqual({
      approver: '',
      builds: '',
      env: '',
      // `default: true` on the schema — the one field that does not start blank.
      notify: true,
    })
  })

  test('the opening state of a required form is not yet submittable', () => {
    const fields = byName('the headline form').expect!.fields!
    const problems = validateAll(fields, initialValues(fields))
    expect(problems.map((p) => p.field)).toEqual(['approver', 'env'])
  })
})
