/**
 * The served-version heartbeat decision (`lib/version-guard.ts`).
 * ─────────────────────────────────────────────────────────────────────────────
 * This guard is the SW-lifecycle-INDEPENDENT path to the reload bar: a PWA
 * wedged on an ancient service worker (one that can never fire `onNeedRefresh`)
 * still surfaces the bar because the running bundle asks the live server "what
 * sha are you?" and compares it to the sha it was built from. These tests pin
 * the load-bearing decision so it can never regress into either a stuck-stale
 * bundle (missed mismatch) or a false-positive bar (offline blip, dev build).
 */
import { describe, expect, test } from 'bun:test'

import { isNewerServedSha, isRealSha } from '../../src/lib/version-guard'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('isRealSha — a comparable git sha, not the dev sentinel', () => {
  test('a 40-char hex sha is real', () => {
    expect(isRealSha(A)).toBe(true)
  })
  test('a short (7-char) sha is real', () => {
    expect(isRealSha('abc1234')).toBe(true)
  })
  test('"dev" is NOT a real sha', () => {
    expect(isRealSha('dev')).toBe(false)
  })
  test('null / undefined / non-hex are not real', () => {
    expect(isRealSha(null)).toBe(false)
    expect(isRealSha(undefined)).toBe(false)
    expect(isRealSha('')).toBe(false)
    expect(isRealSha('v0.5.0')).toBe(false)
    expect(isRealSha(123 as unknown)).toBe(false)
  })
})

describe('isNewerServedSha — surface the bar IFF a genuinely newer build is live', () => {
  test('server on a different real sha than this bundle → surface', () => {
    expect(isNewerServedSha(B, A)).toBe(true)
  })
  test('equal shas → no bar (the page is already current)', () => {
    expect(isNewerServedSha(A, A)).toBe(false)
  })
  test('NO false positive when the server sha is unavailable (offline / 401)', () => {
    expect(isNewerServedSha(null, A)).toBe(false)
  })
  test('a dev build never compares (nothing to adopt)', () => {
    expect(isNewerServedSha(B, 'dev')).toBe(false)
    expect(isNewerServedSha('dev', A)).toBe(false)
  })
})
