// The in-app notification rules.
//
// One question decided in one place: should this push interrupt the user
// in-app? A blocking tier earns a toast; a calm one does not, because the
// roster's own tier dot already carries it and a toast for "a turn finished" is
// precisely the noise the redesign removes.

import { describe, expect, test } from 'bun:test'

import {
  attentionCount,
  needsAttention,
  notificationsSyncMessage,
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
    // The SAME predicate the server stamps on the payload: a live dialog or an
    // uncleared error, on a session that is not stopped.
    expect(
      attentionCount([
        { status: 'waiting', permission_request: { tool: 'Bash' } },
        { status: 'error', error: { type: 'rate_limit', message: 'x' } },
        // Two reasons is still one bot.
        {
          status: 'idle',
          permission_request: { tool: 'Read' },
          error: { type: 'e', message: 'm' },
        },
        // A status the app has not learnt yet still counts — the rule only ever
        // subtracts on positive evidence of death.
        { error: { type: 'billing_error', message: 'card' } },
        // Working away, nothing wanted.
        { status: 'active' },
        { status: 'idle', permission_request: null },
      ]),
    ).toBe(4)
  })

  test('a STOPPED bot never lights the home screen — the live sticky-badge bug', () => {
    // Live evidence: the owner's iOS icon carried a permanent "1" from
    // `persoonlijk-assistant` — status `stopped`, error `holder_died`. An
    // in-memory error is only cleared by a SessionStart on that same name, so
    // the count never came down for something no tap could act on.
    const fleet = [
      { name: 'persoonlijk-assistant', status: 'stopped', error: { type: 'holder_died', message: 'terminal died: holder exited' } },
    ]
    expect(attentionCount(fleet)).toBe(0)

    // The SAME error on a live bot is still a real ask.
    expect(attentionCount([{ ...fleet[0], status: 'idle' }])).toBe(1)
  })

  test('a dialog on a stopped bot is gated too — it died with the pty', () => {
    // A clean SessionEnd clears the dialog BEFORE forcing `stopped`, so this
    // pair only exists after an UNCLEAN death (`holder_died`), where the dialog
    // is as un-answerable as the error beside it. One uniform rule.
    expect(
      attentionCount([{ status: 'stopped', permission_request: { tool: 'Bash' } }]),
    ).toBe(0)
    expect(
      attentionCount([{ status: 'waiting', permission_request: { tool: 'Bash' } }]),
    ).toBe(1)
  })

  test('the per-session rule is the one the count is built from', () => {
    expect(needsAttention({ status: 'stopped', error: { type: 'holder_died', message: 'x' } })).toBe(false)
    expect(needsAttention({ status: 'idle', error: { type: 'holder_died', message: 'x' } })).toBe(true)
    expect(needsAttention({ status: 'stopped' })).toBe(false)
    expect(needsAttention({ status: 'active' })).toBe(false)
    expect(needsAttention(undefined)).toBe(false)
    expect(needsAttention(null)).toBe(false)
  })

  test('an empty or missing fleet is zero, not a crash', () => {
    expect(attentionCount([])).toBe(0)
    expect(attentionCount(undefined)).toBe(0)
  })
})

describe('notificationsSyncMessage', () => {
  test('names exactly the slots that still need the human', () => {
    const msg = notificationsSyncMessage([
      { name: 'deploy-fix', status: 'waiting', permission_request: { tool: 'Bash' } },
      { name: 'persoonlijk-assistant', status: 'stopped', error: { type: 'holder_died', message: 'x' } },
      { name: 'quiet-bot', status: 'active' },
    ])
    expect(msg.type).toBe('notifications-sync')
    // The dead bot is in neither half: no count, and no card kept alive.
    expect(msg.badge).toBe(1)
    expect(msg.tags).toEqual(['session:deploy-fix'])
  })

  test('the tags it emits are the tags the server coalesces on', () => {
    const msg = notificationsSyncMessage([
      { name: 'with space', status: 'waiting', error: { type: 'e', message: 'm' } },
    ])
    expect(msg.tags).toEqual([tagForSession('with space')])
  })

  test('a nameless or empty fleet yields an empty, harmless sync', () => {
    expect(notificationsSyncMessage(undefined)).toEqual({
      type: 'notifications-sync',
      badge: 0,
      tags: [],
    })
    // A row with no `name` cannot address a slot — counted, never tagged.
    const msg = notificationsSyncMessage([{ status: 'idle', error: { type: 'e', message: 'm' } }])
    expect(msg.badge).toBe(1)
    expect(msg.tags).toEqual([])
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

  test('the AGENT path names the bot too — it is where a tap now lands', () => {
    // `/agent/<name>` is the thread's address (`lib/agent-href.ts`) and is what
    // a notification opens. Reading the thread is as much "I have seen it" as
    // reading the terminal, so a card matched here must go stale as well.
    expect(sessionFromPath('/agent/deploy-fix')).toBe('deploy-fix')
    expect(sessionFromPath('/agent/with%20space')).toBe('with space')
    expect(sessionFromPath('/agent')).toBeNull()
    expect(sessionFromPath('/agents/deploy-fix')).toBeNull()
    // A half-typed escape is not a name — and must not throw inside the
    // visibility handler that calls this.
    expect(sessionFromPath('/agent/100%')).toBeNull()
  })
})
