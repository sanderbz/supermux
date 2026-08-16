// The chat data plane, as a hook (fase A2→A3 wiring).
//
// This replaces `use-chat-tail.ts` — the A1 `/recall?chat=true` poll that
// re-read the whole transcript on every SSE tick. What the surface renders is
// unchanged (`ChatEntry`, newest-first, the frozen A1 shape); where it comes
// from is now the A2 socket: one seed page, then one frame per entry, pushed.
//
// The three layers, deliberately separate:
//   · `wire.ts`          the frames and the pure reducer (no socket, no React)
//   · `chat-socket.ts`   the connection, the backoff, the fetch-full queue
//   · here               mount, unmount, and the adapter to the display shape
//
// Nothing about the socket's behaviour lives in this file, because a hook is
// the one layer `bun test` cannot hold to account without a DOM.
//
// RECEIPTS STAY WHERE THEY ARE. This socket carries no hook receipts: A2's
// frame set is `auth_ok` / `seed` / `seed_done` / `entry` / `state` / `resync`
// (`ws.rs`), and the "overlay" its plan names is the STALENESS overlay (the
// `state`/`resync` frames), not the ≤1s live layer. The live layer keeps
// reading the sessions SSE's `activity_at` — which is what A2's own plan says
// to do ("the chat clock domain is already server-ms; keep it") and what the
// supersede gate is written against. So there is exactly one receipt source,
// `use-receipt-overlay`, and it is untouched by this slice.
//
// The socket is bound with `useSyncExternalStore` rather than an effect + a
// `setState`: a WebSocket IS an external store, the subscription is what owns
// the socket's lifetime, and the store shape makes the double subscribe/
// unsubscribe React does in StrictMode a genuine dispose-and-redial instead of
// a leak (`tests/unit/chat-socket.test.ts` pins that the dispose is total).

import * as React from 'react'

import { useConnection } from '../../stores/connection-store'

import { ChatSocket, EMPTY_SNAPSHOT, type ChatConnState, type ChatSnapshot } from './chat-socket'
import {
  chatPresentation,
  linkStateFor,
  RESUME_STALE_MS,
  VISIBILITY_DEBOUNCE_MS,
  type ChatPresentation,
} from './connection'
import type { WireEntry } from './wire'

export interface ChatWireView {
  /**
   * The socket's window, OLDEST-FIRST, in wire shape.
   *
   * Deliberately NOT adapted here. `use-chat-backlog` merges the pages the
   * reader has scrolled back into under this window and adapts the RESULT
   * (`toChatEntries`) — one adaptation over one list. Adapting here as well
   * would run the fold twice per frame for the same conversation, and worse,
   * would let the window and the block be built by two separate passes that a
   * future change could make disagree.
   */
  wire: readonly WireEntry[]
  /** What the data plane is doing, for a surface that wants to say so. */
  state: ChatConnState
  /** A complete seed page has landed. The backlog reads it to tell "there is
   *  nothing below this" apart from "we do not know yet". */
  seeded: boolean
  /** The seed's `has_more` — is there a backlog below this window at all. */
  hasMore: boolean
  /** The seed's `next_before`; the conversation id the backlog's cursors and
   *  the server's 409 are keyed on. */
  nextBefore: string | null
  /** Bumped by every server-ordered re-seed. A different conversation — the
   *  paged-in block belongs to the old one and must go with it. */
  resyncCount: number
  /** No seed on screen yet. Mirrors the query flag the renderer already
   *  reads: it suppresses "No conversation yet." until we actually know. */
  isLoading: boolean
  /** There is no working data plane — a terminal refusal (this session has no
   *  chat) or a socket that gave up. `reconnecting` is NOT an error: the
   *  transcript on screen stays, it is simply not a claim about now. */
  isError: boolean
  /** Epoch ms of the last authoritative signal, for the staleness ceiling. */
  lastSignalAt: number | null
  /** Clipped entries whose full body is being fetched right now (A6 T4.2). */
  fetching: ReadonlySet<string>
  /** Clipped entries whose fetch failed — retryable, not a dead end. */
  fetchFailed: ReadonlySet<string>
  /** Ask for one clipped entry's full body again. */
  retryFull: (uuid: string) => void
  /** Dial again now, with a fresh attempt budget — what the `offline` chip's
   *  tap does, and what returning to the foreground does automatically. */
  redial: () => void
}

interface SnapshotStore {
  subscribe: (onChange: () => void) => () => void
  get: () => ChatSnapshot
  retryFull: (uuid: string) => void
  redial: () => void
}

/** One session's socket, wrapped as an external store: the FIRST subscriber
 *  dials, the LAST one to leave disposes. */
function chatStore(name: string, enabled: boolean): SnapshotStore {
  let snapshot: ChatSnapshot = EMPTY_SNAPSHOT
  let socket: ChatSocket | null = null
  const listeners = new Set<() => void>()

  // ── the foreground redial (A6 T2.3) ───────────────────────────────────────
  //
  // THE single highest-value fix in the fase, and it lived here rather than in
  // `ChatSocket` because the events are DOM events and the class is
  // deliberately framework- and DOM-free (it is unit-tested with a fake
  // socket and no window).
  //
  // Every other live surface in the app already has this — `use-live-term.ts`,
  // `use-sse.ts`, `use-peek-lens.ts`, `use-peek-prewarm.ts` — and the chat
  // socket did not. The failure it fixes is specific and permanent: a phone
  // backgrounded past the 8-attempt ceiling lands in `offline`, and because
  // the store below only disposes when the LAST subscriber leaves, a
  // backgrounded-but-MOUNTED panel never redials. The user comes back to a
  // dead panel that will never heal until they navigate away.
  let hiddenAt: number | null = null
  let lastVisibleAt = 0
  const onVisibility = () => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    const s = socket
    if (!s) return
    const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt
    hiddenAt = null
    // A socket that is genuinely live and was only away for a blink needs
    // nothing — redialling it would throw away a good seed for a tab switch.
    if (snapshot.state === 'live' && hiddenFor <= RESUME_STALE_MS) return
    const now = Date.now()
    if (now - lastVisibleAt < VISIBILITY_DEBOUNCE_MS) return
    lastVisibleAt = now
    s.redial()
  }
  const bindResume = () => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onVisibility)
    window.addEventListener('online', onVisibility)
  }
  const unbindResume = () => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pageshow', onVisibility)
    window.removeEventListener('online', onVisibility)
  }

  const linkId = `chat:${name}`

  return {
    get: () => snapshot,
    retryFull: (uuid) => socket?.retryFull(uuid),
    redial: () => socket?.redial(),
    subscribe(onChange) {
      listeners.add(onChange)
      if (enabled && socket === null) {
        socket = new ChatSocket({
          name,
          onSnapshot: (s) => {
            snapshot = s
            // A6 T2.4 — the chat socket joins the app-wide link aggregate, so
            // `<ReconnectBanner>` / `<ConnectionOverlay>` stop being blind to
            // a dead chat socket. `stale` reports as CONNECTED on purpose:
            // the socket really is up, and a global red banner for a session
            // that is merely quiet is the false alarm T2 exists to remove.
            useConnection
              .getState()
              .report(
                linkId,
                linkStateFor(
                  chatPresentation({ state: s.state, lastSignalAtMs: null, nowMs: 0 }),
                ),
              )
            for (const l of listeners) l()
          },
        })
        socket.start()
        bindResume()
      }
      return () => {
        listeners.delete(onChange)
        if (listeners.size > 0) return
        unbindResume()
        socket?.dispose()
        socket = null
        useConnection.getState().release(linkId)
        // The next subscriber gets a fresh seed, so it must not start from a
        // dead socket's last frame.
        snapshot = EMPTY_SNAPSHOT
      }
    },
  }
}

export function useChatWs(name: string, enabled: boolean): ChatWireView {
  const store = React.useMemo(() => chatStore(name, enabled), [name, enabled])
  const snap = React.useSyncExternalStore(store.subscribe, store.get)

  return {
    wire: snap.entries,
    state: snap.state,
    seeded: snap.seeded,
    hasMore: snap.hasMore,
    nextBefore: snap.nextBefore,
    resyncCount: snap.resyncCount,
    isLoading: !snap.seeded && snap.state !== 'offline',
    isError: snap.state === 'offline',
    lastSignalAt: snap.lastSignalAt,
    fetching: snap.fetching,
    fetchFailed: snap.fetchFailed,
    retryFull: store.retryFull,
    redial: store.redial,
  }
}

/** The one word a surface says about the data plane, on a clock the caller
 *  already ticks. Kept here so `state` and `lastSignalAt` cannot be read apart
 *  and re-collapsed into two booleans the way they were before A6. */
export function useChatPresentation(view: ChatWireView, nowMs: number): ChatPresentation {
  return chatPresentation({ state: view.state, lastSignalAtMs: view.lastSignalAt, nowMs })
}
