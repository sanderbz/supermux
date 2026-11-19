/**
 * `handleOauthReturn` — the hop BACK into supermux (boot-time effect logic).
 * ─────────────────────────────────────────────────────────────────────────────
 *   · `?oauth_pending=1` + a pending key → `complete(id, { state })`, the key is
 *     cleared, "Connected as owner@test" fires, the grid is invalidated;
 *   · a non-ok probe verdict is SAID ("Connected as … — Needs sign-in"), never a
 *     silent green;
 *   · `?connect_error=denied` clears the pending key (no permanent "Connecting…")
 *     and toasts the honest copy;
 *   · `oauth_pending` with NO pending key → "finished outside supermux";
 *   · the return params are stripped for `replaceState`.
 */
import { describe, expect, test } from 'bun:test'

import {
  PENDING_KEY,
  connectErrorCopy,
  handleOauthReturn,
  isOauthReturn,
  stripOauthParams,
  type CompleteResult,
  type PendingStore,
} from '../../src/lib/oauth-pending'

class MemoryStorage implements PendingStore {
  map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

function pendingStore(): MemoryStorage {
  const s = new MemoryStorage()
  s.setItem(PENDING_KEY, JSON.stringify({ id: 'pmcp-inhouseseo', target: 'folderwijzer', returnTo: '/store/pmcp-inhouseseo', state: 'st-1' }))
  return s
}

function deps(store: MemoryStorage, result: CompleteResult | Error) {
  const completes: unknown[] = []
  const toasts: { message: string; tone?: string }[] = []
  const invalidated: (string | undefined)[] = []
  return {
    completes,
    toasts,
    invalidated,
    deps: {
      complete: async (id: string, args: { state: string }) => {
        completes.push([id, args])
        if (result instanceof Error) throw result
        return result
      },
      store,
      toast: (message: string, tone?: 'default' | 'error') => {
        toasts.push({ message, tone })
      },
      invalidate: (t?: string) => {
        invalidated.push(t)
      },
      nameOf: () => 'InhouseSEO',
    },
  }
}

describe('handleOauthReturn', () => {
  test('oauth_pending + pending key → complete with the stored state, key cleared, toast, invalidate', async () => {
    const store = pendingStore()
    const d = deps(store, { account_ref: 'a1', label: 'owner@test', health: { status: 'ok' }, target: 'folderwijzer' })
    const out = await handleOauthReturn('?oauth_pending=1', d.deps)
    expect(out).toEqual({ kind: 'connected', id: 'pmcp-inhouseseo', target: 'folderwijzer', label: 'owner@test', health: 'ok' })
    expect(d.completes).toEqual([['pmcp-inhouseseo', { state: 'st-1' }]])
    expect(store.getItem(PENDING_KEY)).toBeNull()
    expect(d.toasts).toEqual([{ message: 'Connected as owner@test', tone: 'default' }])
    expect(d.invalidated).toEqual(['folderwijzer'])
  })

  test('a green carries the tool count the server actually listed (real tools/list), never a blurb', async () => {
    const d = deps(pendingStore(), { account_ref: 'a1', label: 'owner@test', health: { status: 'ok', message: 'Server answered — 2 tools.', tool_count: 2 }, target: 'folderwijzer' })
    await handleOauthReturn('?oauth_pending=1', d.deps)
    expect(d.toasts).toEqual([{ message: 'Connected as owner@test — 2 tools', tone: 'default' }])
    // One tool is singular; a server that answered but would not list its tools
    // (tool_count null) stays plain — the count is never invented.
    const d1 = deps(pendingStore(), { account_ref: 'a1', label: 'owner@test', health: { status: 'ok', tool_count: 1 }, target: 'folderwijzer' })
    await handleOauthReturn('?oauth_pending=1', d1.deps)
    expect(d1.toasts[0].message).toBe('Connected as owner@test — 1 tool')
    const d0 = deps(pendingStore(), { account_ref: 'a1', label: 'owner@test', health: { status: 'ok', tool_count: null }, target: 'folderwijzer' })
    await handleOauthReturn('?oauth_pending=1', d0.deps)
    expect(d0.toasts[0].message).toBe('Connected as owner@test')
    // A non-ok verdict says why, count or not.
    const dx = deps(pendingStore(), { account_ref: 'a1', label: 'owner@test', health: { status: 'expired', error: 'Needs sign-in', tool_count: null }, target: 'folderwijzer' })
    await handleOauthReturn('?oauth_pending=1', dx.deps)
    expect(dx.toasts[0]).toEqual({ message: 'Connected as owner@test — Needs sign-in', tone: 'error' })
  })

  test('a non-ok probe is said out loud, never a silent green', async () => {
    const store = pendingStore()
    const d = deps(store, { account_ref: 'a1', label: 'owner@test', health: { status: 'expired', error: 'Server refused the new sign-in' }, target: 'folderwijzer' })
    await handleOauthReturn('?oauth_pending=1', d.deps)
    expect(d.toasts[0].message).toBe('Connected as owner@test — Server refused the new sign-in')
    expect(d.toasts[0].tone).toBe('error')
  })

  test('connect_error=denied clears the pending key and toasts the copy', async () => {
    const store = pendingStore()
    const d = deps(store, new Error('must not complete'))
    const out = await handleOauthReturn('?y=1&connect_error=denied', d.deps)
    expect(out).toEqual({ kind: 'error', code: 'denied' })
    expect(store.getItem(PENDING_KEY)).toBeNull()
    expect(d.completes).toEqual([])
    expect(d.toasts).toEqual([{ message: 'Sign-in was cancelled.', tone: 'error' }])
    expect(connectErrorCopy('exchange', 'InhouseSEO')).toBe('InhouseSEO rejected the sign-in — try again.')
    expect(connectErrorCopy('expired', 'X')).toBe('That sign-in link expired — try again.')
    expect(connectErrorCopy('state', 'X')).toBe(connectErrorCopy('issuer', 'X'))
    expect(connectErrorCopy('bogus', 'X')).toBe("Couldn't verify the sign-in — try again.")
  })

  test('oauth_pending with no pending key names the tab AND the way out', async () => {
    const store = new MemoryStorage()
    const d = deps(store, new Error('must not complete'))
    const out = await handleOauthReturn('?oauth_pending=1', d.deps)
    expect(out).toEqual({ kind: 'lost' })
    expect(d.completes).toEqual([])
    // "finished outside supermux — tap Connect again" was true but useless: it
    // named no button the owner could see. Say where it finished and what to tap.
    expect(d.toasts[0].message).toContain('another tab')
    expect(d.toasts[0].message).toContain('Sign in again')
  })

  test('a failed complete reports and still refreshes', async () => {
    const store = pendingStore()
    const d = deps(store, new Error('sign-in not found'))
    const out = await handleOauthReturn('?oauth_pending=1', d.deps)
    expect(out).toEqual({ kind: 'connect_failed', id: 'pmcp-inhouseseo' })
    expect(d.toasts[0].message).toContain("Couldn't finish the sign-in")
    expect(d.invalidated).toEqual(['folderwijzer'])
  })

  test('a plain URL is not a return; the params strip cleanly', async () => {
    const d = deps(new MemoryStorage(), new Error('x'))
    expect(await handleOauthReturn('?tab=installed', d.deps)).toEqual({ kind: 'none' })
    expect(isOauthReturn('?oauth_pending=1')).toBe(true)
    expect(isOauthReturn('?connect_error=state')).toBe(true)
    expect(isOauthReturn('?tab=installed')).toBe(false)
    expect(stripOauthParams('?oauth_pending=1')).toBe('')
    expect(stripOauthParams('?y=1&connect_error=denied')).toBe('?y=1')
  })
})
