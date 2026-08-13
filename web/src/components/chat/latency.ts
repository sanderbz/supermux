// Hook→UI latency telemetry for the A1 dogfood week — the ONE unmeasured
// number the fail branch depends on (a0-findings §1 item 3, "expected ≪1s").
// The server stamps `activity_at` (its own clock, ms) on every activity
// delta (Task 3); we record `Date.now() − activity_at` on receipt.
//
// Two hard requirements from review: (1) samples PERSIST per-day in
// localStorage so a week of dogfooding survives reloads/navigation, and the
// number is surfaced in the chat panel footer (no devtools needed); (2) this
// module also owns the CLOCK-SKEW estimate: `noteServerStamp`/`serverNowMs`
// let every supersede/prune comparison run in the server clock domain (the
// owner dogfoods over tailnet from other devices). The raw lag samples still
// include true skew + transport — stated caveat: read absolute values in a
// browser on the same host; the ≪1s question survives modest skew.

const dayKey = () =>
  `supermux:chat-a1-latency:${new Date().toISOString().slice(0, 10)}`

function loadSamples(): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(dayKey())
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'number') : []
  } catch {
    return []
  }
}

const samples: number[] = loadSamples()

function persist(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(dayKey(), JSON.stringify(samples.slice(-500)))
  } catch {
    /* quota/private mode — console + in-memory still work */
  }
}

/** Nearest-rank p50 (matches a0-findings' small-n honesty: no interpolation). */
export function p50(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length / 2) - 1]
}

/** Today's raw samples (read-only view for the panel footer). */
export function latencySamples(): number[] {
  return samples
}

export function recordHookLatency(activityAtMs: number | undefined): void {
  if (typeof activityAtMs !== 'number') return
  const lag = Date.now() - activityAtMs
  // Clock skew / stale replays: discard absurd values instead of polluting p50.
  if (lag < -5_000 || lag > 60_000) return
  samples.push(lag)
  persist()
  console.info(
    `[chat-a1] hook→UI ${lag}ms · p50 ${p50(samples)}ms · n=${samples.length}`,
  )
}

// ---- server clock domain ---------------------------------------------------
// skew = client − server, estimated as the MIN over observed (Date.now() −
// serverStamp) so transport lag biases it as little as possible. null until
// the first server-stamped delta arrives.
let skewMs: number | null = null

/** Feed a server-clock ms stamp (e.g. `activity_at`) into the skew estimate. */
export function noteServerStamp(serverMs: number): void {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return
  const d = Date.now() - serverMs
  skewMs = skewMs == null ? d : Math.min(skewMs, d)
}

/** "Now" on the SERVER's clock (best effort; Date.now() until first sample).
 *  All chat supersede/prune thresholds compare against THIS, never raw
 *  Date.now(), so a skewed browser clock can't kill the overlay or freeze
 *  duplicate receipts on screen. */
export function serverNowMs(): number {
  return Date.now() - (skewMs ?? 0)
}

/** Dogfood console access: `window.__supermuxChatLatency` is the raw array. */
export function exposeLatency(): void {
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__supermuxChatLatency = samples
  }
}
