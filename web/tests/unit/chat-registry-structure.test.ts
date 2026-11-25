/**
 * The structural match (Max's design A, 2026-11-25): a Claude Code version NEWER
 * than every capture may be answered only when its dialog is EXACTLY the newest
 * captured one, and then only on rows that grant nothing beyond this one call.
 * Anything else stays as before: every button off.
 *
 * The screens are the 2.1.331 corpus (`cc321/v331/`) read under a version that
 * does not exist yet — the situation the morning after Claude Code updates.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { answerDialog, sightingKey, type AnswerDeps } from '../../src/components/chat/dialog-answer'
import { continuityOf, readLens, type DialogContinuity } from '../../src/components/chat/peek-lens'
import { entryFor, isNewer, STRUCTURE_BASE, type RegistryId } from '../../src/components/chat/registry'
import type { KeyName } from '../../src/lib/session-input/types'

const TUI = join(import.meta.dir, '../fixtures/tui')
const V331 = join(TUI, 'cc321/v331')
const NEXT = '2.1.332'

const raw = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8')
const lens = (dir: string, f: string, c?: DialogContinuity | null) => readLens(raw(dir, f), c)
const bits = (m: ReturnType<typeof entryFor>) => m.entry?.options.map((o) => (o.actOn ? '1' : '0')).join('')

describe('structure — what a newer version gets when the screen is exact', () => {
  test('the base is the newest captured version', () => {
    expect(STRUCTURE_BASE).toBe('2.1.331')
    expect(isNewer(NEXT, STRUCTURE_BASE)).toBe(true)
    expect(isNewer('2.1.330', STRUCTURE_BASE)).toBe(false)
    expect(isNewer('2.2.0', STRUCTURE_BASE)).toBe(true)
    expect(isNewer('2.1.331', STRUCTURE_BASE)).toBe(false)
  })

  test('Bash, four rows: Yes and No pressable, the grant and auto mode off', () => {
    for (const f of ['01-bash-access-caret1.txt', '05-bash-read-caret1.txt', '06-bash-cmdrule-caret1.txt']) {
      const m = entryFor(lens(V331, f), NEXT)
      expect(m.degraded).toBe(false)
      expect(m.basis).toBe('structure')
      expect(bits(m)).toBe('1001')
      expect(m.entry!.escape.actOn).toBe(true)
    }
  })

  test('Write and Edit: Yes and No pressable, accept-edits OFF (it switches the session)', () => {
    for (const f of ['20-write-caret1.txt', '30-edit-caret1.txt']) {
      const m = entryFor(lens(V331, f), NEXT)
      expect(m.basis).toBe('structure')
      expect(bits(m)).toBe('101')
      expect(m.entry!.options[1].disabledReason).toContain(NEXT)
    }
  })

  test('Plan: manual approval and feedback pressable, "use auto mode" OFF', () => {
    const m = entryFor(lens(V331, '40-plan-caret1.txt'), NEXT)
    expect(m.basis).toBe('structure')
    expect(bits(m)).toBe('011')
  })

  test('the outside-project Write form is still exact (its grant is the slot)', () => {
    const m = entryFor(lens(join(TUI, 'cc321/v325/noauto'), '20-write-caret1.txt'), NEXT)
    expect(m.basis).toBe('structure')
    expect(bits(m)).toBe('101')
  })

  test('a captured version is still answered by its pin, with nothing switched off', () => {
    const m = entryFor(lens(V331, '20-write-caret1.txt'), '2.1.331')
    expect(m.basis).toBe('pin')
    expect(bits(m)).toBe('111')
  })
})

describe('structure — anything not exact gets no buttons', () => {
  const refused = (text: string, version = NEXT) => {
    const m = entryFor(readLens(text), version)
    expect(m.degraded).toBe(true)
    expect(m.basis).toBeUndefined()
    expect(m.entry!.options.every((o) => !o.actOn)).toBe(true)
    expect(m.entry!.escape.actOn).toBe(false)
  }
  const bash = raw(V331, '01-bash-access-caret1.txt')

  test('an unknown version OLDER than the base is refused even on an exact screen', () => {
    refused(bash, '2.1.330')
    refused(bash, '2.1.300')
  })

  test('a reworded fixed row', () => refused(bash.replace(/ {3}4\. No/, '   4. No thanks')))

  test('a reworded auto-mode row', () =>
    refused(bash.replace('3. Yes, and switch to auto mode · auto mode handles these prompts for you', '3. Yes, and switch to auto mode · auto mode decides for you')))

  test('a grant row in a form nobody captured', () =>
    refused(bash.replace('Yes, and always allow access to', 'Yes, and allow everything in')))

  test('a changed question line', () => refused(bash.replace('Do you want to proceed?', 'Do you want to proceed now?')))

  test('a list that gained a row', () =>
    refused(bash.replace(/( {3}4\. No)/, '   4. Yes, for every project\n   5. No')))

  test('a plan whose first row changed', () =>
    refused(raw(V331, '40-plan-caret1.txt').replace('Yes, and use auto mode', 'Yes, and use auto mode always')))

  test('the old 2.1.233 Write shape is not the current structure', () => {
    // A newer version that went BACK to the 2.1.233 row 2 is a change, not a match.
    refused(raw(join(TUI, 'cc233'), '20-write-caret1.txt').replace('Claude Code v2.1.233', `Claude Code v${NEXT}`))
  })
})

describe('structure — the sequencer under a structural match', () => {
  const live = join(V331, 'live')
  const run = async (name: string, entryId: RegistryId, target: number | 'escape') => {
    const log = JSON.parse(raw(live, `${name}-sequence.json`)) as { looks: { tag: string }[] }
    const tags = log.looks.map((l) => l.tag)
    const own = tags.slice(1)
    let i = 0
    const sent: KeyName[] = []
    const deps: AnswerDeps = {
      refresh: async (c) => lens(live, `${own[Math.min(i++, own.length - 1)]}.txt`, c),
      sendKey: async (k) => {
        sent.push(k)
      },
      pin: NEXT,
      wait: async () => {},
    }
    const out = await answerDialog(deps, { entryId, target, key: sightingKey(lens(live, `${tags[0]}.txt`).dialog!) })
    return { out, sent }
  }

  test('No on the four-row Bash card: the same keys as the pinned run', async () => {
    const { out, sent } = await run('case1-bash-deny', 'permission.bash', 3)
    expect(out.ok).toBe(true)
    expect(sent).toEqual(['Down', 'Down', 'Down', 'Enter'])
  })

  test('Esc on Edit still works', async () => {
    const { out, sent } = await run('case5-edit-escape', 'permission.edit', 'escape')
    expect(out.ok).toBe(true)
    expect(sent).toEqual(['Escape'])
  })

  test('accept-edits is refused before a single key is sent', async () => {
    const { out, sent } = await run('case3-write-option2', 'permission.write', 1)
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('not-actionable')
    expect(sent).toEqual([])
  })

  test('mid-sequence frames are re-checked against the exact structure', () => {
    // The anchored read of an off-row-1 frame must still be EXACT, or the next key is refused.
    const first = lens(V331, '01-bash-access-caret1.txt').dialog!
    const m = entryFor(lens(V331, '01-bash-access-caret2.txt', continuityOf(first)), NEXT)
    expect(m.basis).toBe('structure')
  })
})
