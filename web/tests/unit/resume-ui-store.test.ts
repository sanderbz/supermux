/**
 * The `supermux-ui` STORE half of "open where I left off".
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The store is a module singleton whose
 * persist middleware binds to whatever `localStorage` existed when the FIRST
 * test file imported it — bun runs the whole suite in one process, so which file
 * that is changes with the run. Asserting against the live middleware from here
 * would therefore be a coin flip. So this file pins the two things that are
 * deterministic — the shape of persist's default shallow `merge` over an older
 * blob, and the setter's semantics — and the REAL middleware round-trip (an old
 * `supermux-ui` blob in a real browser's localStorage) is proven end-to-end on
 * the headless rig instead (`~/resumefix-shots`, scenario 6).
 */
import { describe, expect, test } from 'bun:test'

import { useUI, persistedUISlice } from '@/stores/ui-store'
import { readConversation, scopeKey } from '@/lib/last-conversation'

/** A v1 blob written BEFORE `lastConversations` existed — the shape every
 *  install on disk right now has. */
const OLD_BLOB_STATE = {
  viewMode: 'list',
  defaultModel: 'opus',
  hoverPreview: 'live',
  overviewPreview: 'live',
  showHidden: false,
  hideStopped: true,
  activeCompany: 7,
  botMode: true,
  defaultRenderer: 'chat',
  rendererOverrides: { 'acme-web': 'terminal' },
} as const

describe('an older persisted blob round-trips', () => {
  // `zustand/persist`'s default `merge` is a shallow spread of the persisted
  // blob over the freshly-created state, run after `migrate`. Reproduced here
  // literally so the claim is about the merge, not about a mocked store.
  const merged = { ...useUI.getState(), ...OLD_BLOB_STATE }

  test('every pre-existing preference survives untouched', () => {
    expect(merged.viewMode).toBe('list')
    expect(merged.defaultModel).toBe('opus')
    expect(merged.hideStopped).toBe(true)
    expect(merged.showHidden).toBe(false)
    expect(merged.activeCompany).toBe(7)
    expect(merged.botMode).toBe(true)
    expect(merged.rendererOverrides).toEqual({ 'acme-web': 'terminal' })
  })

  test('the ABSENT new field keeps its default — an empty memory, not undefined', () => {
    expect(merged.lastConversations).toEqual({})
    expect(readConversation(merged.lastConversations, 'c:7')).toBe(null)
    expect(readConversation(merged.lastConversations, 'hq')).toBe(null)
  })

  test('the fresh store defaults it too (nothing to restore on a first run)', () => {
    expect(useUI.getState().lastConversations).toBeDefined()
  })

  test('it is part of the PERSISTED slice — and the member lock still is not', () => {
    const slice = persistedUISlice(useUI.getState()) as Record<string, unknown>
    expect('lastConversations' in slice).toBe(true)
    expect('memberCompany' in slice).toBe(false)
  })
})

describe('setLastConversation', () => {
  test('remembers, replaces and forgets — per scope, independently', () => {
    const { setLastConversation } = useUI.getState()
    setLastConversation(scopeKey(7), { kind: 'bot', name: 'acme-web' })
    setLastConversation(scopeKey(null), { kind: 'bot', name: 'pa-bot' })
    expect(readConversation(useUI.getState().lastConversations, 'c:7')).toEqual({
      kind: 'bot',
      name: 'acme-web',
    })

    setLastConversation(scopeKey(7), { kind: 'channel' })
    expect(readConversation(useUI.getState().lastConversations, 'c:7')).toEqual({
      kind: 'channel',
    })

    // Closing the pane forgets THAT scope only.
    setLastConversation(scopeKey(7), null)
    expect(readConversation(useUI.getState().lastConversations, 'c:7')).toBe(null)
    expect(readConversation(useUI.getState().lastConversations, 'hq')).toEqual({
      kind: 'bot',
      name: 'pa-bot',
    })
  })

  test('an unchanged write does not swap the map (no needless re-render)', () => {
    const { setLastConversation } = useUI.getState()
    setLastConversation(scopeKey(3), { kind: 'channel' })
    const before = useUI.getState().lastConversations
    setLastConversation(scopeKey(3), { kind: 'channel' })
    expect(useUI.getState().lastConversations).toBe(before)
  })
})
