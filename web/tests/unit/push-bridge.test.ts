// The in-app notification rules.
//
// One question decided in one place: should this push interrupt the user
// in-app? A blocking tier earns a toast; a calm one does not, because the
// roster's own tier dot already carries it and a toast for "a turn finished" is
// precisely the noise the redesign removes.

import { describe, expect, test } from 'bun:test'

import {
  attentionCount,
  sessionFromPath,
  tagForSession,
  toastForPush,
  type PushPayload,
} from '../../src/lib/push-bridge'

function payload(over: Partial<PushPayload> = {}): PushPayload {
  return {
    title: 'deploy-fix',
    body: 'Needs permission — ⚡ cargo check (Bash)',
    url: '/focus/deploy-fix#pending',
    tier: 'attention',
    session: 'deploy-fix',
    ...over,
  }
}

describe('toastForPush', () => {
  test('a blocking tier interrupts, carrying the bot name and the agent words', () => {
    const t = toastForPush(payload())
    expect(t).not.toBeNull()
    expect(t!.message).toBe('deploy-fix: Needs permission — ⚡ cargo check (Bash)')
    expect(t!.tone).toBe('waiting')
    expect(t!.url).toBe('/focus/deploy-fix#pending')
  })

  test('an error tier interrupts in the error tone', () => {
    const t = toastForPush(
      payload({ tier: 'error', body: 'rate_limit: You reached your usage limit' }),
    )
    expect(t!.tone).toBe('error')
    expect(t!.message).toBe('deploy-fix: rate_limit: You reached your usage limit')
  })

  test('the calm tiers show nothing in-app', () => {
    // A finished turn and a schedule are already on the roster / scheduler.
    expect(toastForPush(payload({ tier: 'unread', body: 'Turn finished.' }))).toBeNull()
    expect(toastForPush(payload({ tier: 'schedule', body: "'nightly' finished." }))).toBeNull()
  })

  test('a bodyless or missing payload never produces an empty toast', () => {
    expect(toastForPush(payload({ body: '' }))).toBeNull()
    expect(toastForPush(undefined)).toBeNull()
    expect(toastForPush(null)).toBeNull()
  })

  test('a payload with no title falls back to just the words', () => {
    const t = toastForPush(payload({ title: '  ' }))
    expect(t!.message).toBe('Needs permission — ⚡ cargo check (Bash)')
  })
})

describe('attentionCount', () => {
  test('counts the bots that need the human, once each', () => {
    // The SAME predicate the server stamps on the payload: a live dialog, an
    // unanswered notice, or an uncleared error.
    expect(
      attentionCount([
        { permission_request: { tool: 'Bash' } },
        { notice: 'Claude is waiting for your input' },
        { error: { type: 'rate_limit', message: 'x' } },
        // Two reasons is still one bot.
        { permission_request: { tool: 'Read' }, error: { type: 'e', message: 'm' } },
        // Working away, nothing wanted.
        {},
        { permission_request: null, notice: null },
      ]),
    ).toBe(4)
  })

  test('an empty or missing fleet is zero, not a crash', () => {
    expect(attentionCount([])).toBe(0)
    expect(attentionCount(undefined)).toBe(0)
  })
})

describe('routing helpers', () => {
  test('the coalescing slot matches the server tag', () => {
    // If these two ever disagree the app closes a banner that is not there and
    // leaves the real one on the lock screen.
    expect(tagForSession('deploy-fix')).toBe('session:deploy-fix')
  })

  test('a focus path names the bot being viewed, anything else names none', () => {
    expect(sessionFromPath('/focus/deploy-fix')).toBe('deploy-fix')
    expect(sessionFromPath('/focus/deploy-fix/anything')).toBe('deploy-fix')
    expect(sessionFromPath('/focus/with%20space')).toBe('with space')
    expect(sessionFromPath('/')).toBeNull()
    expect(sessionFromPath('/board')).toBeNull()
    expect(sessionFromPath('/focus')).toBeNull()
    expect(sessionFromPath(undefined)).toBeNull()
  })
})
