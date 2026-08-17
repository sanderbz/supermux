/**
 * **The pty-state parity contract — TypeScript half.**
 *
 * Twin of `server/tests/pty_state_parity.rs`. Both read the SAME corpus,
 * `server/tests/fixtures/pty/claude-states.jsonl`, and both assert a verdict
 * about the same bytes.
 *
 * Why a shared corpus rather than two suites: there are two independent readers
 * of the live screen in this product — `sessions::status` + `sessions::pty_state`
 * on the server (which the roster, the tiles and push consume) and
 * `components/chat/peek-lens.ts` here (which the chat cards and the composer
 * consume) — and neither can see the other's mistakes. A limit banner taught to
 * one and forgotten on the other compiles clean in Rust *and* in TypeScript, and
 * produces the worst outcome available: a roster row saying "blocked" beside a
 * chat header saying "Idle" with a green dot, or the reverse. The audit caught
 * the version where NEITHER plane knew (verify matrix finding 1).
 *
 * This file additionally pins what only the lens can say — the dialog FAMILY,
 * the question, the header chip, the option rows and their descriptions — because
 * that half is the difference between a card that asks the model's question and
 * the one the audit screenshotted: ``Run `AskUserQuestion` ?`` with five
 * disabled chips whose labels were half description text (findings 4 and 8,
 * `03-chat-askq.png`).
 *
 * If you teach either reader a new screen, add a row to the corpus in the same
 * commit.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readLens } from '../../src/components/chat/peek-lens'
import { dialogCardView } from '../../src/components/chat/dialog-answer'
import { pinFor } from '../../src/components/chat/registry'

const DIR = join(import.meta.dir, '../../../server/tests/fixtures/pty')

interface WebExpect {
  family: string | null
  variant?: string
  header?: string
  question?: string
  options?: string[]
  descriptions?: (string | null)[]
  caretIndex?: number
  freeTextIndex?: number
  bannerVersion?: string | null
  notice: {
    kind: string
    wedge?: string
    paused?: string
    text: string
    detail?: string
  } | null
  /** What the screen has ARMED (catalog `generic.armed_keys`). Absent = the row
   *  makes no claim; `[]` = it claims nothing is armed, which is the assertion
   *  that keeps an over-broad reader from disabling Stop everywhere. */
  armed?: { token: string; key: string | null; action: string }[]
}

interface Row {
  id: string
  capture: string
  live: boolean
  provider?: string
  synthesized?: string
  cc_version?: string
  web: WebExpect
}

const CORPUS: Row[] = readFileSync(join(DIR, 'claude-states.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row & { _?: string })
  // The first object is the file's own documentation, not a case.
  .filter((r) => r._ === undefined)

const captureOf = (row: Row) => readFileSync(join(DIR, row.capture), 'utf8')
const rowFor = (id: string) => CORPUS.find((r) => r.id === id)!

describe('the shared pty corpus', () => {
  test('is present and still covers the families the audit named', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(10)
    const ids = CORPUS.map((r) => r.id)
    // A corpus rots by losing its adversarial rows while still passing, so the
    // ones that carry the findings are named.
    for (const want of [
      'ask_user_question',
      'trust_folder',
      'apikey_approval',
      'first_run_onboarding',
      'codex_hooks_review',
      'limit_weekly',
      'limit_used_pct',
      'idle_control',
      // The PTY-07 must-families: the two paused consent modals, the stall that
      // reads as Idle, the refusal that reads as an ordinary API error, and the
      // two armed screens that must land before any automated keypress.
      'session_paused_overage',
      'session_paused_refusal',
      'stream_stalled',
      'safeguards_refusal',
      'armed_esc_clear',
      'armed_ctrl_c',
    ]) {
      expect(ids).toContain(want)
    }
  })

  test('no screen in the corpus arms a key it did not say it arms', () => {
    // The over-broad reader this pins against refused Stop on every permission
    // dialog, because `ctrl+e to explain` is the same SHAPE as an arming. Rows
    // that make no claim are skipped; rows that claim `[]` are the control.
    for (const row of CORPUS) {
      if (row.web.armed === undefined) continue
      const lens = readLens(captureOf(row))
      expect(lens.armed.length).toBe(row.web.armed.length)
    }
  })

  test('every row that is not a live capture says so, and says where it came from', () => {
    // The registry's rule — no option is act-on-able without a fixture — only
    // means anything if a synthesized fixture cannot quietly pass for a captured
    // one. So a row without `live` must carry its provenance in prose.
    for (const row of CORPUS) {
      if (row.live) expect(typeof row.cc_version).toBe('string')
      else expect((row.synthesized ?? '').length).toBeGreaterThan(40)
    }
  })
})

describe('the lens reads every corpus screen the way the corpus records', () => {
  for (const row of CORPUS) {
    test(`${row.id}`, () => {
      const lens = readLens(captureOf(row))
      const want = row.web

      if (want.family === null) {
        expect(lens.dialog).toBeNull()
      } else {
        expect(lens.dialog?.family).toBe(want.family)
        if (want.variant !== undefined) expect(lens.dialog?.variant).toBe(want.variant)
        if (want.header !== undefined) expect(lens.dialog?.header).toBe(want.header)
        if (want.question !== undefined) expect(lens.dialog?.question).toBe(want.question)
        if (want.options !== undefined) expect(lens.dialog?.options).toEqual(want.options)
        if (want.caretIndex !== undefined) expect(lens.dialog?.caretIndex).toBe(want.caretIndex)
        if (want.freeTextIndex !== undefined) {
          expect(lens.dialog?.freeTextIndex).toBe(want.freeTextIndex)
        }
        if (want.descriptions !== undefined) {
          // JSON has no `undefined`; the corpus writes `null` for "this option
          // has no description".
          expect(lens.dialog?.descriptions?.map((d) => d ?? null)).toEqual(want.descriptions)
        }
      }
      if (want.bannerVersion !== undefined) expect(lens.bannerVersion).toBe(want.bannerVersion)

      if (want.notice === null) {
        expect(lens.notice).toBeNull()
      } else {
        expect(lens.notice?.kind).toBe(want.notice.kind)
        expect(lens.notice?.text).toBe(want.notice.text)
        expect(lens.notice?.wedge ?? undefined).toBe(want.notice.wedge)
        expect(lens.notice?.paused ?? undefined).toBe(want.notice.paused)
        expect(lens.notice?.detail ?? undefined).toBe(want.notice.detail)
      }

      if (want.armed !== undefined) {
        expect(
          lens.armed.map((a) => ({ token: a.token, key: a.key, action: a.action })),
        ).toEqual(want.armed)
      }
    })
  }
})

/**
 * The AskUserQuestion card, end to end — the state the owner asked about first.
 *
 * Before: `readLens` returned `family:'unknown'`, the registry matched nothing,
 * and the card was headed ``Run `AskUserQuestion` ?`` with the question text and
 * the header chip on no surface at all. Each assertion below is one half of that
 * failure, so the card cannot regress to it silently.
 */
describe('AskUserQuestion — the card the audit found headless', () => {
  const lens = readLens(captureOf(rowFor('ask_user_question')))

  test('the question and its header chip reach the card', () => {
    const card = dialogCardView(lens, pinFor(lens))!
    expect(card.id).toBe('question.ask')
    expect(card.question).toBe('Which fruit do you want?')
    expect(card.header).toBe('Fruit choice')
  })

  test('the options are the model’s labels — not label-plus-description', () => {
    const card = dialogCardView(lens, pinFor(lens))!
    expect(card.options.map((o) => o.label)).toEqual([
      'Apple',
      'Banana',
      'Cherry',
      'Type something.',
    ])
    // The exact strings the audit screenshotted as chips.
    for (const o of card.options) expect(o.label).not.toContain('A crisp and refreshing')
  })

  test('the out-of-box row below the dialog’s rule is not offered as an answer', () => {
    // `5. Chat about this` takes the conversation somewhere else instead of
    // answering, and it is numbered in sequence — which is exactly why the naive
    // scan absorbed it.
    expect(lens.dialog!.options).not.toContain('Chat about this')
  })

  test('the three real answers are act-on-able and the free-text row is not', () => {
    const card = dialogCardView(lens, pinFor(lens))!
    expect(card.options.slice(0, 3).every((o) => o.actOn)).toBe(true)
    expect(card.options[3].actOn).toBe(false)
    expect((card.options[3].reason ?? '').length).toBeGreaterThan(20)
    expect(card.disabled).toBe(false)
  })
})

/**
 * The startup wedges. `trust` is answerable, `apikey` is fingerprinted and inert,
 * and both must be reported as a wedge whatever the registry decides — the
 * roster's blocked row is not allowed to depend on whether chat can press a key.
 */
describe('the startup gates', () => {
  test('the trust gate is answerable even though no boot banner exists yet', () => {
    const lens = readLens(captureOf(rowFor('trust_folder')))
    // The dialog draws ABOVE the welcome box, so there is no version to pin
    // against — the exemption is what keeps this card from being permanently
    // unanswerable, which would be the wedge rather than a fix for it.
    expect(pinFor(lens)).toBeNull()
    const card = dialogCardView(lens, pinFor(lens))!
    expect(card.id).toBe('startup.trust')
    expect(card.disabled).toBe(false)
    expect(card.options.map((o) => o.label)).toEqual(['Yes, I trust this folder', 'No, exit'])
    expect(card.options.every((o) => o.actOn)).toBe(true)
    // Esc is how this dialog is known to wedge a session — a second one exits
    // Claude Code outright — so it is drawn and never sent.
    expect(card.escape?.actOn).toBe(false)
  })

  test('the API-key gate is named and readable but presses nothing', () => {
    const lens = readLens(captureOf(rowFor('apikey_approval')))
    const card = dialogCardView(lens, pinFor(lens))!
    expect(card.id).toBe('startup.apikey')
    expect(card.options.every((o) => !o.actOn)).toBe(true)
    // The inverted default is the fact a user has to be told: pressing Enter in
    // the terminal DECLINES the key.
    expect(card.options[0].reason).toContain('No (recommended)')
  })

  test('a wedge with no captured rows still says the session is stuck', () => {
    for (const id of ['first_run_onboarding', 'codex_hooks_review']) {
      const lens = readLens(captureOf(rowFor(id)))
      expect(lens.notice?.kind).toBe('startup-wedge')
    }
  })
})
