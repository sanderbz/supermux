/**
 * Every channel the server emits is a channel this client listens on.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS FOR (found by fase B4's T11, on a real two-session
 * hand-off): `harness` was added to `SseEventType`, its hook was written
 * (`use-harness-events.ts`), and its server frame shipped — but the
 * `addEventListener('harness', …)` was never registered, because the list of
 * channels to subscribe to was a SECOND array inside `connect()`.
 *
 * An `EventSource` silently ignores a named event nobody is listening for. So
 * the transcript's whole management log updated only on a reload, no request
 * failed, no console line appeared, and TypeScript was perfectly happy — the
 * union said `harness` was a known type, and it was.
 *
 * Two guards, and neither can be satisfied by a comment:
 *
 *   1. the client's type is DERIVED from the subscription array, so a channel
 *      you can name is a channel you receive (that half is structural now);
 *   2. every `SseEvent { event: "…" }` in the SERVER's source is in that array.
 *      Read from disk, like `chat-slash.test.ts` reads `BUILTIN_SLASH_COMMANDS`
 *      — a mirror that is not read from the original is a copy waiting to rot.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { SSE_NAMED_EVENTS } from '../../src/hooks/use-sse'

const SERVER_SRC = fileURLToPath(new URL('../../../server/src', import.meta.url))

function rustFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...rustFiles(p))
    else if (name.endsWith('.rs')) out.push(p)
  }
  return out
}

/**
 * Every literal event name the server publishes on the SHARED bus.
 *
 * Scoped to the `SseEvent { event: "…" }` struct literal — that is the shared
 * `/api/events` broadcast channel, which is the one this hook connects to.
 * `/api/updates/stream` is a separate endpoint with its own `update` event and
 * its own consumer (`use-update-badge.ts`), so it is deliberately out of scope;
 * the keep-alive, built with the axum `Event` builder rather than the struct,
 * is picked up from `sse.rs` alone for the same reason.
 */
const EMITTED: string[] = (() => {
  const found = new Set<string>()
  for (const file of rustFiles(SERVER_SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/event:\s*"([a-z-]+)"/g)) found.add(m[1]!)
    if (file.endsWith('/sse.rs')) {
      for (const m of src.matchAll(/Event::default\(\)\.event\("([a-z-]+)"\)/g)) {
        found.add(m[1]!)
      }
    }
  }
  return [...found].sort()
})()

describe('the SSE channel list', () => {
  test('the server emits at least the handful this app is built on', () => {
    // A sanity floor: if the scrape stops finding anything, the assertions
    // below would pass vacuously.
    expect(EMITTED.length).toBeGreaterThan(5)
    for (const core of ['sessions', 'status', 'harness', 'alerts']) {
      expect(EMITTED).toContain(core)
    }
  })

  test('EVERY channel the server emits is subscribed by the client', () => {
    // The exact failure that shipped: `harness` emitted, never listened for.
    const missing = EMITTED.filter((e) => !(SSE_NAMED_EVENTS as readonly string[]).includes(e))
    expect(missing).toEqual([])
  })

  test('the client subscribes to nothing that does not exist', () => {
    // The other direction is a warning rather than a bug, but a channel nobody
    // emits is either a rename that half-landed or dead weight.
    const orphans = (SSE_NAMED_EVENTS as readonly string[]).filter(
      // `schedules` is emitted by the scheduler through the `alerts` channel
      // today; the name is kept because `use-scheduler.ts` still routes on it.
      (e) => !EMITTED.includes(e) && e !== 'schedules',
    )
    expect(orphans).toEqual([])
  })

  test('the list has no duplicates — a double subscription fires twice', () => {
    expect(new Set(SSE_NAMED_EVENTS).size).toBe(SSE_NAMED_EVENTS.length)
  })
})
