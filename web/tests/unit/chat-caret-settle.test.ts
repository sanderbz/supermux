/**
 * The caret settle — what a navigation step waits for, and what it refuses to.
 *
 * Found live on 2026-08-17 driving the new `question.ask` entry against a real
 * Claude Code 2.1.233 session: the first re-peek after `Down` still showed the
 * caret on the row it had left, and 120 ms later it was where the key had put
 * it. The old read aborted on that frame and told the user "something else is
 * typing into this session" — about a session nothing else was touching. That
 * sentence is the strongest claim this module makes, and spending it on our own
 * impatience teaches people to ignore it.
 *
 * So exactly one reading is tolerated — "the caret has not moved YET" — and the
 * tests below are half proof that it is, half proof that nothing else is. Every
 * abort the safety wave verified has to survive: a caret two rows on, a caret
 * that vanished, a caret that never moves.
 */

import { describe, expect, test } from 'bun:test'

import {
  answerDialog,
  CARET_SETTLE_ATTEMPTS,
  sightingKey,
} from '../../src/components/chat/dialog-answer'
import { readLens, type PeekLens } from '../../src/components/chat/peek-lens'

/** A permission dialog with the caret on `caret` — the family with a static
 *  entry, so this file tests the SEQUENCER and not the registry. */
function capture(caret: number): string {
  const rows = ['Yes', 'Yes, and always allow access to tmp/ from this project', 'No']
  return [
    ' Bash command',
    '',
    '   touch /tmp/spike-test-file',
    '',
    ' Do you want to proceed?',
    ...rows.map((r, i) => `${i === caret ? ' ❯' : '  '} ${i + 1}. ${r}`),
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n')
}

const PIN = '2.1.233'
const START = readLens(capture(0))
const REQ = {
  entryId: 'permission.bash' as const,
  target: 2,
  key: sightingKey(START.dialog!),
}

/** A deps object whose peek returns the scripted caret positions in order,
 *  repeating the last one forever. */
function driver(carets: readonly (number | null)[]) {
  const sent: string[] = []
  let i = 0
  return {
    sent,
    reads: () => i,
    deps: {
      refresh: async (): Promise<PeekLens | null> => {
        // Once the commit has gone, the dialog is gone — that is what the
        // dismissal check looks for, and it is not what this file is about.
        if (sent.includes('Enter')) return readLens('❯ \n  ⏵⏵ auto mode on')
        const c = carets[Math.min(i, carets.length - 1)]
        i += 1
        // `null` = the caret vanished: draw the rows with no caret glyph at all.
        return readLens(c == null ? capture(-1) : capture(c))
      },
      sendKey: async (k: string) => {
        sent.push(k)
      },
      pin: PIN,
      wait: async () => {},
    },
  }
}

describe('a navigation step waits out a repaint, and nothing else', () => {
  test('a caret that has not moved YET is re-read, and the answer lands', async () => {
    // read 1 = the strict look (caret 0). read 2 = the frame the live run hit:
    // the Down went, the repaint had not. read 3 = the caret where the key put
    // it. The sequence must finish, not abort.
    const d = driver([0, 0, 1, 1, 2, 2])
    const out = await answerDialog(d.deps, REQ)
    expect(out.ok).toBe(true)
    expect(d.sent).toEqual(['Down', 'Down', 'Enter'])
  })

  test('a caret that moved to the WRONG row aborts on the first frame it appears', async () => {
    // Two rows in one step is the concurrent-client race, and it must NOT be
    // waited out: the settle only ever forgives "unchanged".
    const d = driver([0, 2])
    const out = await answerDialog(d.deps, REQ)
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('caret-drift')
    expect(out.detail).toContain('something else is typing')
    // One key went and no more.
    expect(d.sent).toEqual(['Down'])
    // And it did not spend the settle budget getting there.
    expect(d.reads()).toBeLessThan(CARET_SETTLE_ATTEMPTS + 2)
  })

  test('a caret that never moves aborts once the budget is out, and says so', async () => {
    const d = driver([0, 0, 0, 0, 0, 0])
    const out = await answerDialog(d.deps, REQ)
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('caret-drift')
    // A DIFFERENT sentence: nothing else is typing, the keypress simply did not
    // take. Blaming a phantom third party for our own dead keystroke is the
    // failure this branch of the copy exists to avoid.
    expect(out.detail).toContain('did not move it')
    expect(out.detail).not.toContain('something else is typing')
    expect(d.sent).toEqual(['Down'])
  })

  test('a caret that vanished mid-step aborts rather than settling', async () => {
    const d = driver([0, null])
    const out = await answerDialog(d.deps, REQ)
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('no-caret')
    expect(d.sent).toEqual(['Down'])
  })
})
