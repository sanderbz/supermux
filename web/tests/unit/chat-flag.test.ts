import { describe, expect, test } from 'bun:test'

import {
  chatEligible,
  chatRendererOn,
  CHAT_KILL_SWITCH_KEY,
} from '../../src/components/chat/flag'

describe('chat renderer flag', () => {
  const claude = { provider: 'claude', host_id: null }

  test('eligibility: local claude or codex, never remote', () => {
    expect(chatEligible(claude)).toBe(true)
    // Codex is served in its own rollout dialect (server: chat/codex.rs), so it
    // is eligible too — pragmatically rendered, with an explicit "open the
    // terminal" row for anything the mapping does not cover.
    expect(chatEligible({ provider: 'codex', host_id: null })).toBe(true)
    // A provider with no transcript at all stays out.
    expect(chatEligible({ provider: 'shell', host_id: null })).toBe(false)
    // A remote session's transcript is on the remote box — refused for EVERY
    // provider, which is the half of this guard that never moved.
    expect(chatEligible({ provider: 'claude', host_id: 3 })).toBe(false)
    expect(chatEligible({ provider: 'codex', host_id: 3 })).toBe(false)
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
