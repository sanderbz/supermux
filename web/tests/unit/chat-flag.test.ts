import { describe, expect, test } from 'bun:test'

import {
  chatEligible,
  chatRendererOn,
  CHAT_KILL_SWITCH_KEY,
} from '../../src/components/chat/flag'

describe('chat renderer flag', () => {
  const claude = { provider: 'claude', host_id: null }

  test('eligibility: local claude, not a team lead (master plan Track A v1 guard)', () => {
    expect(chatEligible(claude, false)).toBe(true)
    expect(chatEligible({ provider: 'shell', host_id: null }, false)).toBe(false)
    expect(chatEligible({ provider: 'codex', host_id: null }, false)).toBe(false)
    expect(chatEligible({ provider: 'claude', host_id: 3 }, false)).toBe(false)
    expect(chatEligible(claude, true)).toBe(false)
    // host_id undefined (older payloads) counts as local.
    expect(chatEligible({ provider: 'claude' }, false)).toBe(true)
  })

  test('setting off → off, regardless of eligibility', () => {
    expect(chatRendererOn(false, null, claude, false)).toBe(false)
  })

  test("kill-switch '0' force-disables even with the setting on", () => {
    expect(chatRendererOn(true, '0', claude, false)).toBe(false)
    expect(chatRendererOn(true, null, claude, false)).toBe(true)
    expect(chatRendererOn(true, '1', claude, false)).toBe(true)
  })

  test('null session → off', () => {
    expect(chatRendererOn(true, null, null, false)).toBe(false)
  })

  test('kill-switch key is the documented one', () => {
    expect(CHAT_KILL_SWITCH_KEY).toBe('supermux:chat-renderer')
  })
})
