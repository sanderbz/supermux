/**
 * **The /login classification parity contract — TypeScript half.**
 *
 * Twin of `server/tests/login_parity.rs`. Both read the SAME corpus —
 * `server/tests/fixtures/login/cases.jsonl` plus the capture files beside it —
 * and assert the same reading for every case.
 *
 * `/login` is detected twice in this codebase, once server-side (which is what
 * makes the roster dot honest and what the supervision freeze hangs off) and
 * once here (which draws the card, off the capture the chat surface is already
 * polling). Neither switch is exhaustive: both fall through to "no login here",
 * so that a Claude Code release which reworded a line degrades to the ordinary
 * terminal rather than to a card answering the wrong prompt. The cost of that
 * design is that a shape taught to one plane and forgotten on the other compiles
 * clean in Rust AND in TypeScript, and is invisible until somebody is stuck at a
 * sign-in screen on a phone with no keyboard.
 *
 * The three `negative-*` cases carry as much weight as the positives: a login in
 * the SCROLLBACK, a login the assistant is talking ABOUT, and an ordinary idle
 * composer must all read as no login at all.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  loginCodeProblem,
  maskCode,
  readLogin,
  readProviderAuth,
  reassembleUrl,
  type LoginStage,
  type ProviderAuthKind,
} from '../../src/components/chat/login-lens'

interface CorpusRow {
  name: string
  file: string
  width: number
  stage: LoginStage | null
  flow?: 'account' | 'design'
  url?: string
  options?: string[]
  message?: string
  email?: string
  waiting?: boolean
  provider_auth?: { kind: ProviderAuthKind; url?: string; code?: string }
}

const DIR = new URL('../../../server/tests/fixtures/login/', import.meta.url)

const CORPUS: CorpusRow[] = readFileSync(new URL('cases.jsonl', DIR), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as CorpusRow & { _?: string })
  .filter((r) => (r as { _?: string })._ === undefined)

const capture = (row: CorpusRow) => readFileSync(new URL(row.file, DIR), 'utf8')

describe('the shared /login corpus', () => {
  test('is present and has not shrunk', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(18)
  })

  test('still covers every stage, both flows, several wrap widths and the negatives', () => {
    // A corpus can rot by losing its adversarial cases while still passing.
    const stages = new Set(CORPUS.map((r) => r.stage))
    for (const s of ['method_select', 'paste_prompt', 'invalid', 'success', 'error', null]) {
      expect(stages).toContain(s as LoginStage | null)
    }
    expect(new Set(CORPUS.map((r) => r.flow))).toContain('design')
    expect(new Set(CORPUS.filter((r) => r.url).map((r) => r.width)).size).toBeGreaterThanOrEqual(4)
    expect(CORPUS.filter((r) => r.stage === null).length).toBeGreaterThanOrEqual(3)
  })
})

describe('readLogin', () => {
  for (const row of CORPUS) {
    test(`${row.name} classifies exactly as the corpus says`, () => {
      const got = readLogin(capture(row))
      if (row.stage === null || row.stage === undefined) {
        expect(got).toBeNull()
        return
      }
      expect(got).not.toBeNull()
      expect(got!.stage).toBe(row.stage)
      if (row.flow) expect(got!.flow).toBe(row.flow)
      expect(got!.url).toBe(row.url)
      if (row.options) expect(got!.options).toEqual(row.options)
      if (row.message) expect(got!.message).toBe(row.message)
      if (row.email) expect(got!.email).toBe(row.email)
    })
  }
})

describe('the URL', () => {
  test('survives every wrap width in the corpus, byte for byte', () => {
    const withUrl = CORPUS.filter((r) => r.url)
    expect(withUrl.length).toBeGreaterThanOrEqual(5)
    for (const row of withUrl) {
      // Through the real path, not the raw helper: one of these captures is the
      // colour-true channel, and stripping is part of the contract.
      expect(readLogin(capture(row))?.url).toBe(row.url!)
    }
  })

  test('stops at every row a wrap could not have produced', () => {
    const width = 40
    const url = 'https://claude.com/cai/oauth/authorize?a=1'
    const rows: string[] = []
    for (let i = 0; i < url.length; i += width) rows.push(url.slice(i, i + width))
    // Pad the last row to the margin: that is what makes the NEXT row a
    // candidate continuation at all.
    const pad = width - rows[rows.length - 1].length
    rows[rows.length - 1] += 'x'.repeat(pad)
    const full = url + 'x'.repeat(pad)
    // (A bare unindented word of URL characters is deliberately NOT in this
    // list — nothing in the grid can tell it from a wrap. See `reassembleUrl`.)
    for (const stopper of ['', '  indented continuation', 'two words', '❯ ']) {
      expect(reassembleUrl([...rows, stopper])).toBe(full)
    }
  })

  test('is not read off the old claude.ai host', () => {
    // The flow moved to claude.com/cai/oauth/authorize. A lens still
    // allowlisting claude.ai renders a card with no link on it.
    expect(reassembleUrl(['https://claude.ai/oauth/authorize?x=1'])).toBeUndefined()
    expect(reassembleUrl(['https://claude.com/cai/oauth/authorize?x=1'])).toBeDefined()
  })
})

describe('the other providers', () => {
  // supermux does not drive codex's or kimi's device flows — their lifecycles
  // are their own. But a session sitting on one IS blocked, and the card has to
  // be able to name it, show the link and show the one-time code.
  for (const row of CORPUS.filter((r) => r.provider_auth)) {
    test(`${row.name} is detected and readable`, () => {
      const got = readProviderAuth(capture(row))
      expect(got).not.toBeNull()
      expect(got!.kind).toBe(row.provider_auth!.kind)
      if (row.provider_auth!.url) expect(got!.url).toBe(row.provider_auth!.url)
      if (row.provider_auth!.code) expect(got!.code).toBe(row.provider_auth!.code)
      // And it must never be read as a Claude login, or the wrong card is drawn
      // on the one flow this app CAN complete.
      expect(readLogin(capture(row))).toBeNull()
    })
  }
})

describe('the code field', () => {
  test('names the half-paste rather than spending a pty round trip on it', () => {
    expect(loginCodeProblem('')).toContain('Paste the code')
    expect(loginCodeProblem('justthecodehalf')).toContain('#')
    expect(loginCodeProblem('abc def#state')).toContain('line break')
    expect(loginCodeProblem('abc#state')).toBeNull()
    // Hyphens are ordinary inside an authorization code.
    expect(loginCodeProblem('abc-def-ghi#state-nonce')).toBeNull()
  })

  test('never echoes the credential back', () => {
    const code = 'cQfTy2QK9nZ8vLpR3sWx7mBd4gHj1kAe#hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa'
    const masked = maskCode(code)
    expect(masked).not.toContain('#')
    expect(masked).not.toContain('cQfTy')
    expect(masked).toMatch(/^•+$/)
  })
})
