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

import { ChatSocket, EMPTY_SNAPSHOT, type ChatConnState, type ChatSnapshot } from './chat-socket'
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
}

interface SnapshotStore {
  subscribe: (onChange: () => void) => () => void
  get: () => ChatSnapshot
}

/** One session's socket, wrapped as an external store: the FIRST subscriber
 *  dials, the LAST one to leave disposes. */
function chatStore(name: string, enabled: boolean): SnapshotStore {
  let snapshot: ChatSnapshot = EMPTY_SNAPSHOT
  let socket: ChatSocket | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    subscribe(onChange) {
      listeners.add(onChange)
      if (enabled && socket === null) {
        socket = new ChatSocket({
          name,
          onSnapshot: (s) => {
            snapshot = s
            for (const l of listeners) l()
          },
        })
        socket.start()
      }
      return () => {
        listeners.delete(onChange)
        if (listeners.size > 0) return
        socket?.dispose()
        socket = null
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
  }
}
