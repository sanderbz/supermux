import { describe, expect, test } from 'bun:test'

import { noteServerStamp, p50, serverNowMs } from '../../src/components/chat/latency'

describe('p50 (nearest-rank, matching a0-findings small-n honesty)', () => {
  test('empty → 0', () => {
    expect(p50([])).toBe(0)
  })
  test('odd + even sample counts', () => {
    expect(p50([300, 100, 200])).toBe(200)
    expect(p50([100, 400, 200, 300])).toBe(200)
  })
  test('single sample', () => {
    expect(p50([142])).toBe(142)
  })
})

describe('server clock domain', () => {
  test('serverNowMs tracks a sampled skew (server ahead of the browser)', () => {
    noteServerStamp(Date.now() + 3_000)
    expect(serverNowMs()).toBeGreaterThan(Date.now() + 2_000)
  })
})
