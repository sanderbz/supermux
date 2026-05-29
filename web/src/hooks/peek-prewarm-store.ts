// peek-prewarm-store — viewport-aware connection pre-warm for the overview
// hover-zoom live peek.
//
// WHY this exists. The overview tile's hover-zoom opens a fresh WebSocket on
// hover-enter; the first-frame auth handshake + first pty replay frame costs
// ~50-300ms during which the live-zoom is empty. We want INSTANT.
//
// HOW. While a tile is visible in the viewport (IntersectionObserver), open the
// same `/ws/sessions/<name>` WS that the live terminal would, perform the
// first-frame auth, and buffer the most recent pty bytes in a small per-session
// ring (we do NOT allocate an xterm renderer — that's the expensive part). On
// hover-enter the tile component claims the subscription: it mounts xterm,
// `term.write()`s the buffered bytes (effectively instant — a handful of KB),
// and the SAME WS continues streaming live (no second connection, no second
// handshake).
//
// BOUNDED. A global cap of `MAX_CONCURRENT` pre-warms keeps the resource cost
// flat regardless of how many tiles are visible — beyond the cap, the extra
// visible tiles fall through to the existing on-hover-connect path (the
// crossfade — already a graceful fallback). Eviction is LRU on
// the warmed-at timestamp: the most recently visible tiles win.
//
// LIFECYCLE.
//   • viewport-enter        → request a pre-warm (cap-respecting)
//   • viewport-exit         → release; WS closes, ring buffer freed
//   • document hidden       → drop ALL pre-warms (no point streaming offscreen)
//   • document visible      → re-warm whatever's still visible
//   • hover-enter (tile)    → claim() transfers WS+buffer ownership; the
//                             registry forgets it (the live-terminal hook now
//                             owns the lifecycle, and will close on unmount)
//
// This module is the PURE registry + headless WS + ring buffer. The
// IntersectionObserver wiring lives in `use-peek-prewarm.ts` so the tile
// component only needs to call `requestWarm(name)` / `releaseWarm(name)` /
// `claim(name)`. The two halves are intentionally split: the registry is
// app-singleton state (a Zustand store), the observer is per-tile React state.

import { create } from 'zustand'

import { authToken, wsUrl } from '@/env'

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Max number of pre-warmed WebSockets at any moment.
 *  Tiles beyond this cap fall through to on-hover-connect — the existing
 *  crossfade is the graceful fallback, so the user never sees a hard error. */
export const MAX_CONCURRENT_PREWARMS = 12

/** Ring buffer cap in bytes — the headless subscriber keeps AT MOST this many
 *  recent pty bytes per session. 64 KB comfortably holds a full terminal of
 *  ANSI-coloured output (a typical agent's last ~200 lines), which is more than
 *  the ~14 rows the hover-zoom embed actually shows. Memory ceiling per session
 *  ≈ 64 KB; at the 12-concurrent cap that's ≤ 768 KB total — negligible. */
export const RING_BUFFER_BYTES = 64 * 1024

/** Mirror of the live-terminal hook's auth grace. The headless
 *  subscriber uses the same generous window — if `auth_ok` never arrives we
 *  give up on this pre-warm slot and free it for someone else. */
const AUTH_GRACE_MS = 4_000

/** The WS close codes the live-terminal hook reacts to.
 *  Mirrored here so the headless subscriber treats them consistently: a
 *  permanent close (auth reject / pty gone / revocation) frees the slot
 *  immediately rather than spinning. We do NOT reconnect a pre-warm on its own
 *  — if a pre-warm closes it just frees its slot; the next viewport-enter (or
 *  the visibilitychange recovery) will re-warm. Reconnect logic stays in the
 *  rendered-xterm path where the user is actually looking. */
const CLOSE_UNMOUNT = 1000
const CLOSE_AUTH = 1008
const CLOSE_SERVER = 1011
const CLOSE_REVOKED = 4001
const CLOSE_NOT_RUNNING = 4404

// ── Per-session pre-warm record ──────────────────────────────────────────────

/** What the registry hands to the tile on `claim()`. The live-terminal hook
 *  takes ownership of the WS (closes it on its own unmount), and writes the
 *  buffered bytes into xterm to hydrate the view. */
export interface PrewarmSeed {
  /** The already-open, already-authed WebSocket. Caller now owns it. */
  ws: WebSocket
  /** Concatenated recent pty bytes (most recent at the END), ≤ RING_BUFFER_BYTES.
   *  An empty buffer is legitimate (an idle session that hasn't produced output
   *  since the pre-warm opened) — the consumer should still hydrate (it's a
   *  no-op write) and continue streaming. */
  bytes: Uint8Array
}

interface PrewarmEntry {
  name: string
  ws: WebSocket
  /** When the entry was last marked relevant (viewport-visible). LRU key. */
  warmedAt: number
  /** Whether the WS has completed the first-frame auth handshake. Until then
   *  we still hold a slot, but a hover-claim is a no-op (we don't want to hand
   *  an unauthed WS to xterm — it can't render until pty bytes arrive anyway,
   *  and the existing on-hover-connect path is equally fast in that case). */
  authed: boolean
  /** Ring of recent pty byte chunks. Total size ≤ RING_BUFFER_BYTES; new chunks
   *  push to the back, oldest evicted from the front when over budget. */
  chunks: Uint8Array[]
  bytes: number
  /** Pending auth-grace timer; cleared on auth_ok or on release. */
  authTimer: number | null
  /** Set true the moment a tile `claim()`s this entry — we MUST NOT close the
   *  WS on release after a claim (the consumer owns it now). */
  claimed: boolean
}

// ── Module-level registry ────────────────────────────────────────────────────
//
// Plain Map (not React state) so opening/closing a WS never re-renders the
// tree. We expose ONE Zustand selector — the current size — purely as a
// debugging surface and (future) telemetry hook. Tiles do not subscribe to
// registry state: they call the imperative API and either get a seed or don't.

const registry = new Map<string, PrewarmEntry>()

interface PrewarmStoreState {
  /** Number of currently held slots (≤ MAX_CONCURRENT_PREWARMS). Updated by the
   *  imperative API so dev-tools / tests can read it; not a render dependency
   *  for production tiles. */
  size: number
  /** Internal — bumped by the imperative API to publish the size. */
  _bump: () => void
}

export const usePrewarmStore = create<PrewarmStoreState>((set) => ({
  size: 0,
  _bump: () => set({ size: registry.size }),
}))

function publish() {
  usePrewarmStore.getState()._bump()
}

// ── Ring buffer helpers ──────────────────────────────────────────────────────

function pushBytes(entry: PrewarmEntry, chunk: Uint8Array): void {
  if (chunk.byteLength === 0) return
  // A single chunk larger than the ring cap is truncated to the tail — the
  // most recent bytes are the ones a hover-hydrate cares about (xterm renders
  // the bottom of the buffer anyway).
  if (chunk.byteLength >= RING_BUFFER_BYTES) {
    entry.chunks = [chunk.slice(chunk.byteLength - RING_BUFFER_BYTES)]
    entry.bytes = entry.chunks[0]!.byteLength
    return
  }
  entry.chunks.push(chunk)
  entry.bytes += chunk.byteLength
  while (entry.bytes > RING_BUFFER_BYTES && entry.chunks.length > 1) {
    const dropped = entry.chunks.shift()!
    entry.bytes -= dropped.byteLength
  }
  // Edge: the (single remaining) chunk is itself over-budget. Trim its head.
  if (entry.bytes > RING_BUFFER_BYTES && entry.chunks.length === 1) {
    const only = entry.chunks[0]!
    const trimmed = only.slice(only.byteLength - RING_BUFFER_BYTES)
    entry.chunks = [trimmed]
    entry.bytes = trimmed.byteLength
  }
}

function flattenBytes(entry: PrewarmEntry): Uint8Array {
  if (entry.chunks.length === 0) return new Uint8Array(0)
  if (entry.chunks.length === 1) return entry.chunks[0]!
  const out = new Uint8Array(entry.bytes)
  let off = 0
  for (const c of entry.chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

// ── Slot management ──────────────────────────────────────────────────────────

/** LRU eviction by `warmedAt` (oldest first). Returns true if an entry was
 *  evicted (i.e. a slot is now free), false if the registry was already empty
 *  or every entry was just created (same `warmedAt`). */
function evictOldest(): boolean {
  let oldest: PrewarmEntry | null = null
  for (const e of registry.values()) {
    if (oldest === null || e.warmedAt < oldest.warmedAt) oldest = e
  }
  if (!oldest) return false
  releaseInternal(oldest.name, /*reason*/ 'lru')
  return true
}

function releaseInternal(name: string, reason: 'lru' | 'exit' | 'hidden' | 'claim'): void {
  const entry = registry.get(name)
  if (!entry) return
  registry.delete(name)
  if (entry.authTimer !== null) {
    window.clearTimeout(entry.authTimer)
    entry.authTimer = null
  }
  // On `claim`, the consumer now owns the WS — DON'T close it (we want the
  // live terminal hook to keep streaming on this same connection).
  if (reason !== 'claim') {
    const ws = entry.ws
    // Drop our handlers first so a late onclose can't touch a freed entry.
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
    try {
      ws.close(CLOSE_UNMOUNT, 'prewarm-release')
    } catch {
      /* already closing */
    }
  }
  entry.chunks = []
  entry.bytes = 0
  publish()
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Ask the registry to pre-warm `name`. Returns true if a slot was granted (or
 *  an existing entry was refreshed) and false if the cap is full and eviction
 *  couldn't free a slot — in which case the caller should fall through to the
 *  existing on-hover-connect path. Idempotent: re-calling for an already-warm
 *  entry only refreshes its LRU timestamp. */
export function requestWarm(name: string): boolean {
  const existing = registry.get(name)
  if (existing) {
    existing.warmedAt = Date.now()
    return true
  }
  // Make room if we're at the cap.
  if (registry.size >= MAX_CONCURRENT_PREWARMS) {
    if (!evictOldest()) return false
    if (registry.size >= MAX_CONCURRENT_PREWARMS) return false
  }

  // Open the WS. Mirror the live-terminal hook's first-frame auth:
  // connect token-less, send {type:'auth',token} on open, wait for
  // {type:'auth_ok'} before declaring ourselves usefully warm. We do NOT
  // attach reconnect logic — a pre-warm that drops just frees its slot.
  const base = wsUrl().replace(/\/$/, '')
  const url = `${base}/ws/sessions/${encodeURIComponent(name)}`
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    return false
  }
  ws.binaryType = 'arraybuffer'

  const entry: PrewarmEntry = {
    name,
    ws,
    warmedAt: Date.now(),
    authed: false,
    chunks: [],
    bytes: 0,
    authTimer: null,
    claimed: false,
  }
  registry.set(name, entry)

  entry.authTimer = window.setTimeout(() => {
    if (!entry.authed) releaseInternal(name, 'exit')
  }, AUTH_GRACE_MS)

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: 'auth', token: authToken() }))
    } catch {
      releaseInternal(name, 'exit')
    }
  }

  ws.onmessage = async (ev: MessageEvent) => {
    const data = ev.data
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data) as { type?: string }
        if (msg.type === 'auth_ok') {
          entry.authed = true
          if (entry.authTimer !== null) {
            window.clearTimeout(entry.authTimer)
            entry.authTimer = null
          }
          // We intentionally do NOT send a `resize` here. The pre-warm doesn't
          // know the eventual xterm geometry (the hover-zoom's FitAddon will
          // compute it once mounted). The pty's last reported geometry is fine
          // for buffering — xterm reflows on hydrate.
        }
      } catch {
        /* ignore non-JSON text frames */
      }
      return
    }
    // Binary frame = pty bytes. Buffer to the ring.
    if (data instanceof ArrayBuffer) {
      pushBytes(entry, new Uint8Array(data))
    } else if (data instanceof Blob) {
      pushBytes(entry, new Uint8Array(await data.arrayBuffer()))
    }
  }

  ws.onerror = () => {
    /* surfaced via onclose */
  }

  ws.onclose = (ev: CloseEvent) => {
    // If we're already gone (claim/release raced the close), nothing to do.
    if (!registry.has(name)) return
    // Any close (including 1006 / 1011 / 4404 / 4001 / 1008) just frees the
    // slot — the rendered path is the one that gets to retry. The user is not
    // looking at this connection's contents yet, so silent release is correct.
    switch (ev.code) {
      case CLOSE_UNMOUNT:
      case CLOSE_NOT_RUNNING:
      case CLOSE_AUTH:
      case CLOSE_REVOKED:
      case CLOSE_SERVER:
      default:
        releaseInternal(name, 'exit')
    }
  }

  publish()
  return true
}

/** Release a pre-warm explicitly (viewport-exit). Idempotent; no-op if not
 *  warmed. After this call the slot is free and the WS is closed. */
export function releaseWarm(name: string): void {
  releaseInternal(name, 'exit')
}

/** Drop EVERY pre-warm. Called on `document.visibilitychange → hidden` so we
 *  don't keep streams open against an offscreen tab. The observer-driven
 *  re-warm fires on visible-again. */
export function releaseAllWarm(): void {
  for (const name of Array.from(registry.keys())) {
    releaseInternal(name, 'hidden')
  }
}

/** Hover-hydrate path: hand the open WS + buffered bytes to the caller. The
 *  caller (the live-terminal hook) now owns the WS — the registry forgets the
 *  entry and will NOT close it. Returns null if no usable pre-warm exists
 *  (either nothing warmed, or warming but not yet authed): the caller should
 *  fall through to its normal connect path. In the not-yet-authed case we
 *  ALSO release the entry — the rendered xterm will open its own fresh WS,
 *  and freeing the slot lets another visible tile pre-warm in its place
 *  (otherwise we'd hold a slot for a connection nobody is using any more). */
export function claim(name: string): PrewarmSeed | null {
  const entry = registry.get(name)
  if (!entry) return null
  if (!entry.authed) {
    // Slot is held by a not-yet-useful WS; let it go so another tile can warm.
    releaseInternal(name, 'exit')
    return null
  }
  // The WS must still be open. If it's not, we have nothing useful to hand off.
  if (entry.ws.readyState !== WebSocket.OPEN) {
    releaseInternal(name, 'exit')
    return null
  }
  const seed: PrewarmSeed = {
    ws: entry.ws,
    bytes: flattenBytes(entry),
  }
  entry.claimed = true
  releaseInternal(name, 'claim')
  return seed
}

/** Read-only test/debug accessor — current registry size. */
export function prewarmSize(): number {
  return registry.size
}

/** Read-only test/debug accessor — whether `name` is currently pre-warmed (and
 *  whether it's authed). */
export function prewarmStatus(name: string): { warmed: boolean; authed: boolean } {
  const e = registry.get(name)
  return { warmed: !!e, authed: !!e?.authed }
}
