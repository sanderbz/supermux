// The message-preview toggle's wire contract.
//
// The Settings → Notifications "Message preview" switch is optimistic UI over
// one call: `pushApi.putPrefs({ message_preview })` → `PUT /api/push/prefs`.
// The body is a privacy control (agent words on the lock screen, or not), so
// the exact request it sends — and the exact key it reads back — are pinned
// here rather than left to a click test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { pushApi, type PushPrefs } from '../../src/lib/api/push'

interface Captured {
  url: string
  method: string
  body: unknown
}

let captured: Captured[] = []
let nextData: unknown = {}

const realFetch = globalThis.fetch

beforeEach(() => {
  captured = []
  ;(globalThis as unknown as { window: unknown }).window = {
    _SUPERMUX_AUTH_TOKEN: 'test-token',
    _SUPERMUX_BASE_URL: '',
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify({ ok: true, data: nextData }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('the message-preview toggle', () => {
  test('GET /api/push/prefs surfaces message_preview alongside the categories', async () => {
    nextData = {
      agent_waiting: true,
      agent_finished: true,
      agent_error: true,
      agent_stopped: true,
      schedule_error: true,
      schedule_finished: true,
      message_preview: false,
    }
    const prefs: PushPrefs = await pushApi.getPrefs()
    expect(prefs.message_preview).toBe(false)
    // The category toggles are untouched by this key.
    expect(prefs.agent_finished).toBe(true)
  })

  test('turning it OFF PUTs exactly { message_preview: false } to the prefs endpoint', async () => {
    await pushApi.putPrefs({ message_preview: false })
    expect(captured).toHaveLength(1)
    const req = captured[0]
    expect(req.method).toBe('PUT')
    expect(req.url).toContain('/api/push/prefs')
    expect(req.body).toEqual({ message_preview: false })
  })

  test('turning it back ON sends the boolean true, not a string', async () => {
    await pushApi.putPrefs({ message_preview: true })
    expect(captured[0].body).toEqual({ message_preview: true })
  })
})
