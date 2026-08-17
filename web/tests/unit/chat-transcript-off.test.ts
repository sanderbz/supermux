/**
 * The blind transcript (states audit).
 *
 * The worst failure mode in the whole state set, and the one nothing detected.
 * With transcript saving off — or with an inherited `CLAUDE_CODE_CHILD_SESSION`
 * marker, which is what a supermux daemon launched from inside a Claude session
 * hands every session it spawns — the transcript plane produces ZERO entries.
 * The chat renderer then draws an empty conversation for a session that is
 * actively talking, under a green dot, with no honesty path: verified live on
 * the rig's own `v-claude`, which had just answered an AskUserQuestion and run
 * `/compact` while `GET /chat/history` returned `{"entries":[]}` and the pty
 * showed the whole exchange.
 *
 * The only signal is a footer warning line, so that is what the lens reads.
 */

import { describe, expect, test } from 'bun:test'

import { readLens, readTranscriptOff } from '../../src/components/chat/peek-lens'

describe('the transcript-off lens', () => {
  test('reads Claude Code’s own footer warning', () => {
    // LIVE capture shape, verify rig `v-claude` 2026-08-17: a session that had
    // just answered a question and run /compact, whose `chat/history` was
    // empty.
    const capture = [
      '  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1',
      '⏵⏵ auto mode on (shift+tab to cycle)',
    ]
    expect(readTranscriptOff(capture)).toBe(true)
    expect(readLens(capture.join('\n')).transcriptOff).toBe(true)
  })

  test('an ordinary screen claims nothing', () => {
    expect(readLens('❯ \n⏵⏵ auto mode on').transcriptOff).toBe(false)
    // An absent capture must never be read as "this session is blind".
    expect(readLens('').transcriptOff).toBe(false)
  })
})
