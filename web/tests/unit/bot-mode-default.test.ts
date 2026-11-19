/**
 * Fase A7: Bot mode is the default. Pins the default, the one-time v2
 * migration that turns it on for stored blobs (which cannot tell a stored
 * `false` that was never chosen from one that was), and that the member lock
 * still owns the flag.
 */
import { describe, expect, test } from 'bun:test'

import { migrateUIBlob as migrate, UI_STORE_VERSION, useUI } from '../../src/stores/ui-store'

describe('Bot mode default (fase A7)', () => {
  test('a fresh store starts in Bot mode', () => {
    expect(useUI.getInitialState().botMode).toBe(true)
  })

  test('the persisted blob is version 2', () => {
    expect(UI_STORE_VERSION).toBe(2)
  })

  test('a v1 blob with Bot mode off is turned on once', () => {
    expect(migrate({ botMode: false, density: 3 }, 1)).toMatchObject({ botMode: true, density: 3 })
  })

  test('a v1 blob with Bot mode on stays on', () => {
    expect(migrate({ botMode: true }, 1)).toMatchObject({ botMode: true })
  })

  test('a v0 blob folds the legacy flags and ends in Bot mode', () => {
    const out = (migrate({ chatRenderer: false, grokMode: false }, 0)) as Record<string, unknown>
    expect(out.botMode).toBe(true)
    expect(out).not.toHaveProperty('chatRenderer')
    expect(out).not.toHaveProperty('grokMode')
  })

  test('a v2 blob keeps the user choice: turning Bot mode off sticks', () => {
    expect(migrate({ botMode: false }, 2)).toMatchObject({ botMode: false })
  })

  test('the member lock still owns the flag', () => {
    const before = useUI.getState()
    useUI.getState().lockToCompany(7)
    useUI.getState().setBotMode(false)
    expect(useUI.getState().botMode).toBe(true)
    useUI.setState({ memberCompany: before.memberCompany, activeCompany: before.activeCompany, botMode: before.botMode })
  })
})
