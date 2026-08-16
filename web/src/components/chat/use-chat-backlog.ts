// Back-pagination for the chat tail (daily-driver QA #3).
// ─────────────────────────────────────────────────────────────────────────────
// The tail (`use-chat-tail.ts`) is a WINDOW: the newest 30 entries, refetched on
// the session's own SSE ticks. Everything above it was unreachable — the QA
// scrolled to `scrollTop = 0` six times on a large session and `scrollHeight`
// never moved. This hook is the rest of that conversation: an append-only
// accumulator of older pages, merged under the window into one newest-first
// list.
//
// WHY NOT `useInfiniteQuery`. Its page chain is keyed on the cursor it was
// fetched with, and this cursor cannot be remembered — the window it is measured
// from slides under it while a turn runs (see `backlog.ts` for the hole that
// creates). What is cached here is not "page 2 of a stable list", it is "the
// entries below whatever is currently on screen": an accumulator, not a query.
//
// The ONE fetch: `sessionsApi.recall(name, { chat: true, before, limit })` — the
// same route, the same wire shape and the same display model as the tail.

import * as React from 'react'

import { sessionsApi, type RecallResponse } from '@/lib/api'

import { mergeOlder, oldestCursor, OLDER_PAGE_LIMIT } from './backlog'
import type { ChatEntry } from './entries'

export interface ChatBacklog {
  /** The tail plus every older page loaded so far, newest-first, deduped. */
  entries: ChatEntry[]
  /** There is a page below what is on screen. */
  hasOlder: boolean
  /** A page is in flight. */
  loadingOlder: boolean
  /** The last attempt failed — the head states it and offers the retry. */
  olderError: boolean
  /** Everything this conversation holds is on screen. */
  atStart: boolean
  /** Fetch the page below the OLDEST entry currently on screen. Idempotent
   *  while one is in flight, so the scroll handler may call it every frame. */
  loadOlder: () => void
  /** Bumped once per landed page — the scroll restorer's edge (it must run in
   *  the commit that prepends, and only in that one). */
  pagesLoaded: number
}

/**
 * The accumulator, WITH the session it belongs to.
 *
 * Carrying the name inside the state is what makes switching sessions safe
 * without a reset effect: a state that names another conversation is simply not
 * this one's state, read as empty in the same render (an effect would paint one
 * frame of the previous session's history under this one's window). It also
 * makes every writer's guard trivial — a functional update whose `prev` names a
 * different session drops itself, which is exactly what an in-flight page for
 * the session the user just left should do.
 */
interface Backlog {
  name: string
  older: ChatEntry[]
  loading: boolean
  error: boolean
  /** A page has come back with `hasMore: false` — the transcript is fully in. */
  exhausted: boolean
  pages: number
}

/** Stable identity so an untouched backlog does not churn the merge memo. */
const NO_OLDER: ChatEntry[] = []

const emptyFor = (name: string): Backlog => ({
  name,
  older: NO_OLDER,
  loading: false,
  error: false,
  exhausted: false,
  pages: 0,
})

export function useChatBacklog(
  name: string,
  tail: RecallResponse | undefined,
): ChatBacklog {
  const [stored, setStored] = React.useState<Backlog>(() => emptyFor(name))
  const state = stored.name === name ? stored : emptyFor(name)

  const tailEntries = React.useMemo(
    () => (tail?.entries ?? []) as unknown as ChatEntry[],
    [tail],
  )
  const entries = React.useMemo(
    () => mergeOlder(tailEntries, state.older),
    [tailEntries, state.older],
  )

  // `hasMore` on the tail answers "is there anything below this window"; once a
  // page comes back with `hasMore: false` the conversation is fully loaded, and
  // the tail's own (still true) flag must not undo that.
  const hasOlder = (tail?.hasMore ?? false) && !state.exhausted

  // Read from the list as it is NOW, every render — never a remembered cursor
  // (`backlog.ts`: the window slides, and a stale cursor leaves a hole).
  const before = oldestCursor(entries)

  // Not the `loading` flag: two scroll events dispatched before the next render
  // both read the state from before the first `setStored`, and the second would
  // fire a duplicate page. This flips synchronously, inside the callback.
  const inFlight = React.useRef(false)

  const loadOlder = React.useCallback(() => {
    if (inFlight.current || !hasOlder || !before) return
    inFlight.current = true
    setStored((prev) =>
      prev.name === name
        ? { ...prev, loading: true, error: false }
        : { ...emptyFor(name), loading: true },
    )
    sessionsApi
      .recall(name, { chat: true, limit: OLDER_PAGE_LIMIT, before })
      .then((page) => {
        const got = (page.entries ?? []) as unknown as ChatEntry[]
        setStored((prev) => {
          // The session changed while this was in flight: its transcript is
          // not this page's, and splicing it in is the one thing a chat data
          // plane may never do.
          if (prev.name !== name) return prev
          return {
            ...prev,
            // Appended raw; `mergeOlder` owns the dedupe, so an overlap with
            // the window (which slid while this was in flight) cannot double a
            // message.
            older: got.length > 0 ? [...prev.older, ...got] : prev.older,
            // No entries can only mean the cursor sits at the bottom of the
            // file (or points into a conversation that has since been
            // cleared) — either way there is nothing more to fetch, and
            // retrying would loop.
            exhausted: prev.exhausted || !page.hasMore || got.length === 0,
            loading: false,
            error: false,
            pages: prev.pages + 1,
          }
        })
      })
      .catch(() => {
        // Retryable on purpose: `exhausted` stays false, so the head keeps the
        // control and says what happened. A silently dropped page is the defect.
        setStored((prev) =>
          prev.name === name ? { ...prev, loading: false, error: true } : prev,
        )
      })
      .finally(() => {
        inFlight.current = false
      })
  }, [before, hasOlder, name])

  return {
    entries,
    hasOlder,
    loadingOlder: state.loading,
    olderError: state.error,
    // `tail == null` is "the first page has not arrived yet", which is not the
    // same statement as "this is where the conversation begins".
    atStart: tail != null && !hasOlder,
    loadOlder,
    pagesLoaded: state.pages,
  }
}
