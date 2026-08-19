import { describe, expect, test } from 'bun:test'

import {
  chatEligible,
  chatRendererOn,
  CHAT_KILL_SWITCH_KEY,
} from '../../src/components/chat/flag'

describe('chat renderer flag', () => {
  const claude = { provider: 'claude', host_id: null }

  test('eligibility: local claude only (master plan Track A v1 guard)', () => {
    expect(chatEligible(claude)).toBe(true)
    expect(chatEligible({ provider: 'shell', host_id: null })).toBe(false)
    expect(chatEligible({ provider: 'codex', host_id: null })).toBe(false)
    expect(chatEligible({ provider: 'claude', host_id: 3 })).toBe(false)
    // host_id undefined (older payloads) counts as local.
    expect(chatEligible({ provider: 'claude' })).toBe(true)
  })

  // TEAMS-in-Bot-mode Phase 2a: the lead refusal is GONE, client and server
  // (`ws.rs::chat_eligible` lost the same clause in Phase 1). A lead is a
  // local Claude session, so it is eligible like any other bot — that is the
  // whole "talk to the lead" decision, pinned here so nobody re-adds the gate.
  test('a team lead is eligible — the refusal is lifted (Phase 2a)', () => {
    const lead = { provider: 'claude', host_id: null }
    expect(chatEligible(lead)).toBe(true)
    expect(chatRendererOn(true, null, null, lead)).toBe(true)
  })

  test('bot mode off → off, regardless of eligibility', () => {
    expect(chatRendererOn(false, null, null, claude)).toBe(false)
  })

  test("master kill '0' force-disables even with bot mode on", () => {
    expect(chatRendererOn(true, '0', null, claude)).toBe(false)
    expect(chatRendererOn(true, null, null, claude)).toBe(true)
    expect(chatRendererOn(true, '1', null, claude)).toBe(true)
  })

  test("legacy renderer-scoped kill '0' force-disables the renderer (skin stays)", () => {
    expect(chatRendererOn(true, null, '0', claude)).toBe(false)
    expect(chatRendererOn(true, null, null, claude)).toBe(true)
    expect(chatRendererOn(true, null, '1', claude)).toBe(true)
  })

  test('null session → off', () => {
    expect(chatRendererOn(true, null, null, null)).toBe(false)
  })

  test('kill-switch key is the documented one', () => {
    expect(CHAT_KILL_SWITCH_KEY).toBe('supermux:chat-renderer')
  })
})
