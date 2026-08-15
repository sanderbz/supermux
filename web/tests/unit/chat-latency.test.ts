import { describe, expect, test } from 'bun:test'

import {
  latencySamples,
  latencySummary,
  MAX_LATENCY_SAMPLES,
  noteServerStamp,
  p50,
  recordHookLatency,
  serverNowMs,
} from '../../src/components/chat/latency'

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

describe('sample ring is bounded', () => {
  test('a long dogfood session cannot grow the in-memory array without bound', () => {
    // Only the PERSISTED copy was capped; the module array grew forever, and
    // every delta sorted it for a console line while the 1 Hz panel ticker
    // sorted it again per render.
    const ref = latencySamples()
    const now = Date.now()
    for (let i = 0; i < MAX_LATENCY_SAMPLES * 2 + 37; i++) recordHookLatency(now - 5)
    expect(latencySamples().length).toBe(MAX_LATENCY_SAMPLES)
    expect(latencySamples()).toBe(ref) // identity preserved for window.__supermuxChatLatency
  })

  test('latencySummary agrees with the raw ring', () => {
    const s = latencySummary()
    expect(s.n).toBe(latencySamples().length)
    expect(s.p50).toBe(p50(latencySamples()))
  })
})
